import { createHash, randomBytes } from "node:crypto";
import { signDigest, verifyDigest, assertFingerprint } from "../crypto/keys.js";

const VERSION = "agent-relay/v2";
export const CURRENT_VERSION = VERSION;

function bodyHashOf(env) {
  return createHash("sha256").update(env.body ?? "", "utf8").digest("hex");
}

// 签名域刻意不含 done：封帧不再靠翻位，而靠 .part → .json 改名
function digestV2(env) {
  return [
    VERSION,
    `seq=${env.seq}`,
    `from=${env.from}`,
    `to=${env.to}`,
    `type=${env.type}`,
    `done=${env.done}`,
    `nonce=${env.nonce}`,
    `body-sha256=${bodyHashOf(env)}`,
  ].join("\n");
}

// v1 域，**只用于诊断归因，永不用于接受消息**。
// 留着它的唯一目的：把"协议版本旧"与"签名被伪造"区分开，见 docs/specs/06。
function digestV1(env) {
  return [
    "agent-relay/v1",
    `seq=${env.seq}`,
    `from=${env.from}`,
    `to=${env.to}`,
    `type=${env.type}`,
    `nonce=${env.nonce}`,
    `body-sha256=${bodyHashOf(env)}`,
  ].join("\n");
}

const KNOWN_DOMAINS = { "agent-relay/v1": digestV1, "agent-relay/v2": digestV2 };
export const digestOf = digestV2;
export const KNOWN_VERSIONS = Object.keys(KNOWN_DOMAINS);
export function digestForDiagnosis(version, env) {
  if (!KNOWN_DOMAINS[version]) throw new Error(`未知版本 ${version}`);
  return KNOWN_DOMAINS[version](env);
}
const TYPES = ["offer", "deliverable", "reject", "heartbeat"];
const HANDLE = /^[a-z0-9-]{1,32}$/;
const SIG_B64URL = /^[A-Za-z0-9_-]{86}$/;

export function msgFileName(seq) {
  return `msg-${String(seq).padStart(5, "0")}.json`;
}

export function newNonce() {
  return randomBytes(16).toString("base64url");
}

// digestOf 即 v2 域，见上方 digestV2 —— 它是本端唯一接受的域。

function assertShape(env) {
  if (!Number.isInteger(env.seq) || env.seq < 1) throw new Error(`seq 非法：${env.seq}`);
  if (!HANDLE.test(env.from)) throw new Error(`from 非法：${env.from}`);
  if (env.to !== "*" && !HANDLE.test(env.to)) throw new Error(`to 非法：${env.to}`);
  if (!TYPES.includes(env.type)) throw new Error(`type 非法：${env.type}`);
  if (typeof env.done !== "boolean") throw new Error("done 必须是布尔");
  if (!env.nonce || !/^[A-Za-z0-9_-]{16,64}$/.test(env.nonce)) throw new Error("nonce 非法");
  if (typeof env.body !== "string") throw new Error("body 必须是字符串");
}

export function seal({ seq, from, to, type, body, nonce = newNonce(), done = true }, privatePem) {
  const env = { seq, from, to, type, done, nonce, body };
  assertShape(env);
  if (done !== true) throw new Error("done 必须为 true：封帧由 .part → .json 改名完成，不靠翻位");
  return { ...env, sig: signDigest(privatePem, digestOf(env)) };
}

// 返回 {ok:true, env} 或 {ok:false, code, reason}
// reason 只描述信封层问题，绝不回显 body —— 验签不过的消息不得进入任何上下文
//
// code 是给诊断输出与日志用的，取值：
//   BAD_ENVELOPE / UNKNOWN_HANDLE / MISSING_SIGNATURE / BAD_SIGNATURE / UNSUPPORTED_VERSION
// UNSUPPORTED_VERSION 与 BAD_SIGNATURE 的区分**只影响诊断**：两者同样被拒，
// 本端接受的签名域始终只有 v2 一个，没有"先试旧域再试新域"的静默回退。
export function verifyEnvelope(env, rosterKeys) {
  if (typeof env !== "object" || env === null)
    return { ok: false, code: "BAD_ENVELOPE", reason: "不是对象" };
  if (!SIG_B64URL.test(env.sig ?? ""))
    return { ok: false, code: "MISSING_SIGNATURE", reason: "缺签名或签名格式非法" };

  const shape = { ...env };
  delete shape.sig;
  try {
    assertShape(shape);
  } catch (e) {
    return { ok: false, code: "BAD_ENVELOPE", reason: e.message };
  }

  const fingerprint = rosterKeys[shape.from];
  if (!fingerprint)
    return { ok: false, code: "UNKNOWN_HANDLE", reason: `名册里没有 ${shape.from}` };

  try {
    assertFingerprint(fingerprint);
  } catch (e) {
    return { ok: false, code: "BAD_ENVELOPE", reason: e.message };
  }

  let valid = false;
  try {
    valid = verifyDigest(fingerprint, digestOf(shape), env.sig);
  } catch {
    return { ok: false, code: "BAD_SIGNATURE", reason: "签名解析失败" };
  }
  if (valid) return { ok: true, env: shape };

  // 拒收已成定局，下面只回答一个问题：它是伪造的，还是仅仅版本旧。
  // 不区分的话，一次协议升级会制造一批"看着像攻击"的失败，
  // 而 A1（伪造 from）的检测信号就靠这个判断，噪声一多人就学会忽略它。
  for (const v of KNOWN_VERSIONS) {
    if (v === CURRENT_VERSION) continue;
    try {
      if (verifyDigest(fingerprint, digestForDiagnosis(v, shape), env.sig))
        return {
          ok: false,
          code: "UNSUPPORTED_VERSION",
          reason: `版本不支持：该消息按 ${v} 签名，本端只接受 ${CURRENT_VERSION}`,
        };
    } catch {
      /* 该域算不出来就跳过，不影响结论 */
    }
  }
  return { ok: false, code: "BAD_SIGNATURE", reason: "验签失败" };
}

import { createHash, randomBytes } from "node:crypto";
import { signDigest, verifyDigest, assertFingerprint } from "../crypto/keys.js";

const VERSION = "agent-relay/v2";
const TYPES = ["offer", "deliverable", "reject", "heartbeat"];
const HANDLE = /^[a-z0-9-]{1,32}$/;
const SIG_B64URL = /^[A-Za-z0-9_-]{86}$/;

export function msgFileName(seq) {
  return `msg-${String(seq).padStart(5, "0")}.json`;
}

export function newNonce() {
  return randomBytes(16).toString("base64url");
}

// 签名域含 done。封帧不再靠翻位，而靠 .part → .json 改名（见 seal），
// 所以 done 可以留在域内——翻动它即验签失败。
export function digestOf(env) {
  const bodyHash = createHash("sha256").update(env.body ?? "", "utf8").digest("hex");
  return [
    VERSION,
    `seq=${env.seq}`,
    `from=${env.from}`,
    `to=${env.to}`,
    `type=${env.type}`,
    `done=${env.done}`,
    `nonce=${env.nonce}`,
    `body-sha256=${bodyHash}`,
  ].join("\n");
}

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

// 返回 {ok:true, env} 或 {ok:false, reason}
// reason 只描述信封层问题，绝不回显 body —— 验签不过的消息不得进入任何上下文
export function verifyEnvelope(env, rosterKeys) {
  if (typeof env !== "object" || env === null) return { ok: false, reason: "不是对象" };
  if (!SIG_B64URL.test(env.sig ?? "")) return { ok: false, reason: "缺签名或签名格式非法" };

  const shape = { ...env };
  delete shape.sig;
  try {
    assertShape(shape);
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  const fingerprint = rosterKeys[shape.from];
  if (!fingerprint) return { ok: false, reason: `名册里没有 ${shape.from}` };

  try {
    assertFingerprint(fingerprint);
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  let valid = false;
  try {
    valid = verifyDigest(fingerprint, digestOf(shape), env.sig);
  } catch {
    return { ok: false, reason: "签名解析失败" };
  }
  if (!valid) return { ok: false, reason: "验签失败" };

  return { ok: true, env: shape };
}

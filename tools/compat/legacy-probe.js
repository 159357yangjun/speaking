// 一次性兼容性探针：拿 legacy-v1 里的真消息过一遍新验签路径。
// 只读，不写任何文件。
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { loadRoster, keyringOf } from "../../src/proto/roster.js";
import { verifyEnvelope, digestOf } from "../../src/proto/envelope.js";

const CH = process.argv[2];
const roster = loadRoster(fs.readFileSync(path.join(CH, "roster.json"), "utf8"));
const keys = keyringOf(roster);

// 复刻 v1 的签名域：七行、无 done
function digestV1(env) {
  return [
    "agent-relay/v1",
    `seq=${env.seq}`,
    `from=${env.from}`,
    `to=${env.to}`,
    `type=${env.type}`,
    `nonce=${env.nonce}`,
    `body-sha256=${createHash("sha256").update(env.body ?? "", "utf8").digest("hex")}`,
  ].join("\n");
}
function tryVerify(pubB64url, str, sig) {
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubB64url, "base64url")]);
  const pub = createPublicKey({ key: der, format: "der", type: "spki" });
  return verify(null, Buffer.from(str, "utf8"), pub, Buffer.from(sig, "base64url"));
}

console.log("=== 0. 新代码的扫描范围里有没有 legacy 消息 ===");
const agentsDir = path.join(CH, "agents");
const scanned = [];
for (const d of fs.readdirSync(agentsDir)) {
  const base = path.join(agentsDir, d);
  if (!fs.statSync(base).isDirectory()) continue;
  for (const f of fs.readdirSync(base).filter((n) => /^msg-\d+\.json$/.test(n))) scanned.push(`${d}/${f}`);
}
console.log("  agents/*/msg-*.json 命中：", scanned.length ? scanned.join(", ") : "（无）");
console.log("  legacy-v1/ 是否在扫描路径内：", agentsDir.includes("legacy") ? "是" : "否 —— legacy 在 agents/ 之外，读者根本看不到它");

console.log("\n=== 1. legacy-v1 目录现状（有没有被动过）===");
for (const f of fs.readdirSync(path.join(CH, "legacy-v1"))) {
  const st = fs.statSync(path.join(CH, "legacy-v1", f));
  const env = JSON.parse(fs.readFileSync(path.join(CH, "legacy-v1", f), "utf8"));
  console.log(`  ${f}  size=${st.size}  mtime=${st.mtime.toISOString()}  from=${env.from} seq=${env.seq} done=${env.done}`);
}

console.log("\n=== 2. 拿 legacy msg-00002.json 过新验签路径 ===");
const legacy = JSON.parse(fs.readFileSync(path.join(CH, "legacy-v1", "msg-00002.json"), "utf8"));
const r = verifyEnvelope(legacy, keys);
console.log("  verifyEnvelope 结果：", JSON.stringify(r));
console.log("  → 拒收。但 reason 只说「验签失败」，看不出是版本旧还是被人篡改。");

console.log("\n=== 3. 用 v1 域重算，证明它其实是完好的旧版本消息 ===");
const fp = keys[legacy.from];
console.log("  roster 里", legacy.from, "的指纹存在：", !!fp);
console.log("  按 v2 域验：", tryVerify(fp, digestOf(legacy), legacy.sig));
console.log("  按 v1 域验：", tryVerify(fp, digestV1(legacy), legacy.sig));
console.log("  → v1 域验过 = 内容与签名从未被改，纯粹是协议版本不同。");

console.log("\n=== 4. 信封里有没有版本字段可供判别 ===");
console.log("  legacy 消息的字段：", Object.keys(legacy).join(", "));
console.log("  含 ver/version 吗：", /(^|,)\s*(ver|version)\s*(,|$)/.test(Object.keys(legacy).join(",")));
console.log("  → 版本号只活在签名字符串的第一行里，明文不可见。");
console.log("     所以读者遇到验签失败时，只能逐个版本试域才能区分「旧」与「被篡改」。");

console.log("\n=== 5. 新代码自己签一条，legacy 与新消息字段差异 ===");
const v2Fields = Object.keys(digestOf({ seq: 1, from: "a", to: "b", type: "offer", done: true, nonce: "x", body: "y" }).split("\n").reduce((m, l) => (m[l.split("=")[0]] = 1, m), {}));
console.log("  v2 域字段：", v2Fields.join(", "));
console.log("  v1 域字段：", ["agent-relay/v1", "seq", "from", "to", "type", "nonce", "body-sha256"].join(", "));

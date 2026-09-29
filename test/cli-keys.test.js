// 私钥来源解析的测试。本轮新代码（--keys-dir + 拒绝频道树内私钥），没有测试就是未交付。
// 测的是真实 CLI 进程，不是内部函数——"用了哪条路径"只有在进程边界上才作数。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeypair } from "../src/crypto/keys.js";
import { verifyEnvelope } from "../src/proto/envelope.js";
import { loadRoster, keyringOf } from "../src/proto/roster.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.js");
const HANDLE = "node-a";

// 夹具：频道目录与私有目录必须是**兄弟**，不能嵌套。
// 代码的守卫拒绝整个频道树内的任何私钥（不只 keys/）——共享区内不该有私钥。
// 上一版把私有目录建在频道里面，四条测试一起假红，暴露的是夹具错、不是守卫错。
function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-keys-"));
  const dir = path.join(root, "channel");
  const keysDir = path.join(root, "private-keys");
  const kp = generateKeypair();
  fs.mkdirSync(path.join(dir, "agents", HANDLE), { recursive: true });
  fs.mkdirSync(keysDir, { recursive: true });
  fs.writeFileSync(path.join(keysDir, `${HANDLE}.pem`), kp.privatePem);
  fs.writeFileSync(path.join(dir, "roster.json"), JSON.stringify({
    channel: "keys-test", created_by: HANDLE, goal: "t", max_members: 2, closed: true,
    members: [
      { handle: HANDLE, client: "c", fingerprint: kp.fingerprint, joined_at: "2026-09-29T00:00:00Z", role: "initiator" },
      { handle: "node-b", client: "c", fingerprint: generateKeypair().fingerprint, joined_at: "2026-09-29T00:00:00Z", role: "member" },
    ],
  }));
  return { dir, keysDir, kp };
}

// CLI 的参数解析只认 --key=value，传成 "--key value" 会被解析成值为 true
function seal(dir, extraArgs, env = {}) {
  return spawnSync(process.execPath,
    [CLI, "seal", `--channel=${dir}`, `--me=${HANDLE}`, "--to=node-b", "--type=offer", "--body=x", ...extraArgs],
    { encoding: "utf8", env: { ...process.env, ...env } });
}
function readRoster(dir) {
  return loadRoster(fs.readFileSync(path.join(dir, "roster.json"), "utf8"));
}
function signedByRealKey(dir, keysDir) {
  const f = path.join(dir, "agents", HANDLE, "msg-00001.json");
  assert.ok(fs.existsSync(f), "没写出消息文件");
  const env = JSON.parse(fs.readFileSync(f, "utf8"));
  return verifyEnvelope(env, keyringOf(readRoster(dir))).ok === true;
}

test("显式 --keys-dir 时用它，并把来源打出来", () => {
  const { dir, keysDir } = mkFixture();
  const r = seal(dir, ["--keys-dir=" + keysDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /密钥来源\] --keys-dir/);
  assert.ok(signedByRealKey(dir, keysDir), "签出的消息必须能用 roster 公钥验通");
});

test("环境变量 AGENT_RELAY_KEYS_DIR 是第二档", () => {
  const { dir, keysDir } = mkFixture();
  const r = seal(dir, [], { AGENT_RELAY_KEYS_DIR: keysDir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /密钥来源\] AGENT_RELAY_KEYS_DIR/);
});

test("--keys-dir 优先于环境变量", () => {
  const { dir, keysDir, kp } = mkFixture();
  // 环境变量指向另一对密钥；若它赢了，签出的消息用 roster 公钥验不过
  const envDir = path.join(dir, "..", "env-keys");
  fs.mkdirSync(envDir, { recursive: true });
  const other = generateKeypair();
  fs.writeFileSync(path.join(envDir, `${HANDLE}.pem`), other.privatePem);
  assert.notEqual(other.fingerprint, kp.fingerprint, "夹具要保证两把确实不同");

  const r = seal(dir, ["--keys-dir=" + keysDir], { AGENT_RELAY_KEYS_DIR: envDir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp("密钥来源\\] --keys-dir"), "必须自报用的是 --keys-dir");
  assert.ok(signedByRealKey(dir, keysDir),
    "验不通说明用了环境变量那把——优先级反了");
});

test("两档都没给时必须拒绝，即使频道里有一把可用私钥", () => {
  const { dir, kp } = mkFixture();
  fs.mkdirSync(path.join(dir, "keys"));
  fs.writeFileSync(path.join(dir, "keys", `${HANDLE}.pem`), kp.privatePem); // 诱饵在频道内
  const r = seal(dir, []);
  assert.notEqual(r.status, 0, "没有显式来源就不能签名");
  assert.match(r.stderr, /不再回退到 <频道>\/keys/);
});

test("频道内的诱饵私钥永远不会被命中", () => {
  const { dir, keysDir, kp } = mkFixture();
  const decoy = generateKeypair();
  fs.mkdirSync(path.join(dir, "keys"));
  fs.writeFileSync(path.join(dir, "keys", `${HANDLE}.pem`), decoy.privatePem); // 另一对密钥
  const r = seal(dir, ["--keys-dir=" + keysDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(signedByRealKey(dir, keysDir),
    "验不通就说明命中了诱饵——真私钥在 keysDir，诱饵在频道内");
  assert.notEqual(decoy.fingerprint, kp.fingerprint, "夹具本身要保证两把不同");
});

test("显式把 --keys-dir 指进频道目录也要被拒", () => {
  const { dir, kp } = mkFixture();
  fs.mkdirSync(path.join(dir, "keys"));
  fs.writeFileSync(path.join(dir, "keys", `${HANDLE}.pem`), kp.privatePem);
  const r = seal(dir, ["--keys-dir=" + path.join(dir, "keys")]);
  assert.notEqual(r.status, 0, "频道内的私钥即使被显式指认也不许用");
  assert.match(r.stderr, /拒绝使用频道目录内的私钥/);
});

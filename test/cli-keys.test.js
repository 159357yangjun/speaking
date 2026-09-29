// 私钥来源解析的测试。这是本轮新代码（--keys-dir），没有测试就是未交付。
// 测的是真实 CLI 进程，不是内部函数——因为"用了哪条路径"这件事只有在进程边界上才作数。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeypair } from "../src/crypto/keys.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.js");
const HANDLE = "node-a";

function mkChannel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-keys-"));
  const kp = generateKeypair();
  fs.mkdirSync(path.join(dir, "keys"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agents", HANDLE), { recursive: true });
  fs.writeFileSync(path.join(dir, "keys", `${HANDLE}.pem`), kp.privatePem);
  fs.writeFileSync(path.join(dir, "keys", `${HANDLE}.pub`), kp.fingerprint);
  fs.writeFileSync(
    path.join(dir, "roster.json"),
    JSON.stringify({
      channel: "keys-test", created_by: HANDLE, goal: "t", max_members: 2, closed: true,
      members: [
        { handle: HANDLE, client: "c", fingerprint: kp.fingerprint, joined_at: "2026-09-29T00:00:00Z", role: "initiator" },
        { handle: "node-b", client: "c", fingerprint: generateKeypair().fingerprint, joined_at: "2026-09-29T00:00:00Z", role: "member" },
      ],
    })
  );
  return { dir, kp };
}

// CLI 的参数解析只认 --key=value（见 src/cli.js 的 /^--([^=]+)(?:=(.*))?$/），
// 传成 "--key value" 两个 arg 会被解析成值为 true。这里必须用等号形式。
function seal(dir, extraArgs, env = {}) {
  return spawnSync(process.execPath, [CLI, "seal", `--channel=${dir}`, `--me=${HANDLE}`,
    "--to=node-b", "--type=offer", "--body=x", ...extraArgs],
    { encoding: "utf8", env: { ...process.env, ...env } });
}

test("显式 --keys-dir 时用它，并把来源打出来", () => {
  const { dir } = mkChannel();
  const elsewhere = path.join(dir, "private");
  fs.mkdirSync(elsewhere);
  fs.copyFileSync(path.join(dir, "keys", `${HANDLE}.pem`), path.join(elsewhere, `${HANDLE}.pem`));
  const r = seal(dir, ["--keys-dir=" + elsewhere]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /密钥来源\] --keys-dir/);
});

test("环境变量 AGENT_RELAY_KEYS_DIR 是第二档", () => {
  const { dir } = mkChannel();
  const elsewhere = path.join(dir, "private");
  fs.mkdirSync(elsewhere);
  fs.copyFileSync(path.join(dir, "keys", `${HANDLE}.pem`), path.join(elsewhere, `${HANDLE}.pem`));
  const r = seal(dir, [], { AGENT_RELAY_KEYS_DIR: elsewhere });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /密钥来源\] AGENT_RELAY_KEYS_DIR/);
});

test("--keys-dir 优先于环境变量", () => {
  const { dir } = mkChannel();
  const a = path.join(dir, "a"), b = path.join(dir, "b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.copyFileSync(path.join(dir, "keys", `${HANDLE}.pem`), path.join(b, `${HANDLE}.pem`)); // 只放 b
  const ok = seal(dir, ["--keys-dir=" + b], { AGENT_RELAY_KEYS_DIR: a });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = seal(dir, ["--keys-dir=" + a], { AGENT_RELAY_KEYS_DIR: b }); // a 里没钥匙
  assert.notEqual(bad.status, 0, "--keys-dir 必须压过环境变量，否则回退档会静默生效");
});

test("两档都没给时回退到 <频道>/keys，且必须自报这是在共享区", () => {
  const { dir } = mkChannel();
  const r = seal(dir, []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /回退：.*私钥仍在共享区/, "回退必须说出来，不能静默");
});

test("共享区里私钥已不存在时，回退档必须响亮失败而非静默成功", () => {
  const { dir } = mkChannel();
  fs.renameSync(path.join(dir, "keys", `${HANDLE}.pem`), path.join(dir, "keys", `${HANDLE}.pem.superseded`));
  const r = seal(dir, []);
  assert.notEqual(r.status, 0, "私钥搬走后仍要能失败——否则等于搬家没搬成");
  assert.match(r.stderr, /找不到私钥/);
  assert.match(r.stderr, /来源：回退/, "错误信息要指出它找的是哪一档");
});

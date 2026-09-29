// 把 tools/relay-sim 的四个场景固定成可重跑用例。
// 目的是：以后任何人改协议或改协作机制，跑一次 npm test 就知道并发保证有没有退化。
// 断言刻意不比"几轮撞上"这种抖动数字 —— 只断言"旧机制存在谎报"与"新机制零谎报"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIM = new URL("../tools/relay-sim/sim.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function runSim() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sim-"));
  try {
    const r = spawnSync(process.execPath, [SIM, dir, "--json"], { encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, `推演器退出码应为 0，实际 ${r.status}\n${r.stderr}`);
    const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT_JSON "));
    assert.ok(line, "推演器没输出 RESULT_JSON，说明父进程未执行或被当成子模式提前退出");
    return { out: JSON.parse(line.slice("RESULT_JSON ".length)), stdout: r.stdout };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const { out, stdout } = runSim();

test("S1 正常串行：后开工的一方能在板上留下唯一占用行", () => {
  assert.equal(out.s1.ok, true, stdout);
});

test("S2 旧机制（markdown read-modify-write）存在谎报成功", () => {
  assert.ok(out.s2.lieOld >= 1,
    `期望旧机制至少一轮出现谎报，实际 ${out.s2.lieOld}/${out.s2.rounds}。` +
    `若这条红了，说明并发窗口没打开，测试本身失效了，不是机制变好了`);
});

test("S2 新机制（独占锁 + 强制 TTL）零谎报", () => {
  assert.equal(out.s2.lieNew, 0, `新机制出现 ${out.s2.lieNew} 轮谎报`);
  assert.equal(out.s2.cleanNew, out.s2.rounds,
    "每轮必须恰好 1 人领取 + 1 人明确受阻；出现两个领取或两个受阻都是机制退化");
});

test("S3a 拒绝无过期时间的锁（ttl=0 与非数字）", () => {
  assert.equal(out.s3a.refusedZeroTtl, true, "ttl=0 必须被拒绝，否则脏声明会永久阻塞");
});

test("S3b 脏声明在 TTL 老化后可被回收", () => {
  assert.equal(out.s3b.stolen, true, "锁老化过 TTL 后必须能被抢占，否则退化成永久阻塞");
  assert.equal(out.s3b.holder, "bob");
});

test("S4 抢占后原持有者提交被拒，且板上不多出提交记录", () => {
  assert.equal(out.s4.rejected, true, "持有者校验必须拒绝非持有者的提交");
  assert.equal(out.s4.committedRows, 0);
});

test("S5 新版读者遇到旧版消息：拒收但能归因，且不抛异常", () => {
  assert.equal(out.s5.threw, null, `旧消息不该让读者崩掉：${out.s5.threw}`);
  assert.equal(out.s5.ok, false, "版本旧不等于放行");
  assert.equal(out.s5.code, "UNSUPPORTED_VERSION",
    "必须归因成版本差，否则会被当成 A1 伪造，污染攻击信号");
});

test("S6 旧版读者遇到新版消息：只能拒，且没有归因能力（不对等要写明）", () => {
  assert.equal(out.s6.oldRejectsV2, true, "旧读者必须拒收新消息");
  assert.equal(out.s6.oldAcceptsV1, true, "旧读者必须还能读旧消息，否则它不是'旧'而是坏了");
  assert.equal(out.s6.attributable, false,
    "归因是单向能力。若哪天旧读者也能归因，说明对端已同步，应同时更新 adapters 的升级顺序说明");
});

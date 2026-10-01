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

// 抢占这一类偶发红过两次（`S2b` 与 claims 里那条 20 路），而旧断言只报一个数字差
// （`18 !== 19`）——读的人分不清"有一家静默消失"与"有两家都自称赢"，那两种处置完全不同。
// 生成器本来就把 20 家的退码存在 `codes` 里，只是断言没打。现在每条 S2b 断言都自带普查：
// 分布 + 逐家退码（20 个数，一行装得下，不落盘、不产生新文件）。
function census(o) {
  const codes = Array.isArray(o.codes) ? o.codes : [];
  const h = {};
  for (const c of codes) h[c] = (h[c] || 0) + 1;
  return `退码分布 ${JSON.stringify(h)}｜rounds=${o.rounds} winners=${o.winners} blocked=${o.blocked} ` +
    `rows=${o.racerRows} holder=${o.finalHolder}｜逐家 [${codes.join(",")}]`;
}

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

test("S2b 过期锁的 20 路真并发抢占：恰好 1 家赢，且只有赢家写板", () => {
  // 这条盯的是**抢占路径**，和上面那条盯的"未过期并发"不是同一段代码。
  // 上一版抢占用"先删再建"，20 家里会有多家自称赢（实测 6/7/12 家），
  // 而在未过期场景里量不出来——只测后者就是一半覆盖冒充全覆盖。
  // 每条断言都带普查（`census`）：本类偶发红过两次，而旧断言只报 `18 !== 19` 这种数字差，
  // 分不清"有一家静默消失"与"有两家自称赢"——那两种的处置完全不同。
  assert.equal(out.s2b.winners, 1,
    `${out.s2b.rounds} 家并发抢过期锁，自称赢 ${out.s2b.winners} 家。双主 = 锁失效｜${census(out.s2b)}`);
  assert.equal(out.s2b.racerRows, 1,
    `写板的 racer 应有 1 行，实际 ${out.s2b.racerRows} 行——持锁的和写板的不是同一家｜${census(out.s2b)}`);
  assert.equal(out.s2b.blocked, out.s2b.rounds - 1,
    `其余必须全部明确受阻，不许静默消失｜${census(out.s2b)}`);
  assert.match(out.s2b.finalHolder, /^racer-/, `最终持有者必须是 20 家抢占者之一｜${census(out.s2b)}`);
});

test("S2b-G 闸口放行：先证明窗口开过（20 家到齐），再证明开过之后仍只许 1 家赢、1 行落板", () => {
  // 这条是证据廿八的直接后果：低载下 57/60 轮赢家都是第一家 ⇒ `winners==1` 有 95% 在量派发顺序。
  // 顺序不能反：先断"到齐 20/20"，否则"放行后还是 1 家赢"可能只是又一次顺序派发。
  const g = out.s2bGated;
  assert.ok(g && Array.isArray(g.per) && g.per.length > 0,
    "RESULT_JSON 里没有 s2bGated.per：闸口臂从没跑过，这条断言没有对象");
  const notFull = g.per.map((p, i) => [i + 1, p.arrivals]).filter(([, a]) => a !== g.needed);
  assert.deepEqual(notFull, [],
    `${g.rounds} 轮里有 ${notFull.length} 轮没等齐 ${g.needed} 家（轮次.实到：${notFull.map(([n, a]) => `${n}.${a}`).join(", ")}）` +
    `⇒ 那不是并发放行，是又一次顺序派发，下面的判据随之失去对象`);
  const detailOf = (p) => `winners=${p.winners} racerRows=${p.racerRows} blocked=${p.blocked} holder=${p.holder} ` +
    `板面=[${p.boardRacerLines}] claims=${p.sceneListing ? `[${p.sceneListing.join(" ｜ ")}]` : "〈未抄，因为那轮没异常〉"} codes=${JSON.stringify(p.codes)}`;
  const bad = g.per.filter((p) => p.winners !== 1 || p.racerRows !== 1);
  assert.deepEqual(bad.map(detailOf), [],
    `闸口放行后仍有 ${bad.length}/${g.rounds} 轮不是"恰 1 家赢、1 行落板"（双主 = 抢占的 rename 仲裁失效）｜` +
    `放行跨度最大 ${g.maxSpreadMs}ms，赢家序列 ${g.holders.join(",")}｜逐轮现场：\n${bad.map(detailOf).join("\n")}`);
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

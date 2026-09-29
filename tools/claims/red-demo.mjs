// 变异演示：逐处把实现改坏，跑对应测试，确认它**真的红**。
// 一次调用做完全部四处，不接 <mode> 参数——上一版把命令行顺序写反，变异根本没发生，
// 测试却报绿，那是假绿灯里最难发现的一种。用法：node tools/claims/red-demo.mjs <仓库绝对路径>
import { readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.argv[2];
if (!ROOT) { console.error("用法：node tools/claims/red-demo.mjs <仓库绝对路径>（参数只有一个，别再写反顺序）"); process.exit(9); }
const LOCK = join(ROOT, "src/claims/lock.js");
const CLI = join(ROOT, "src/cli.js");
const README = join(ROOT, "README.md");

const MUT = [
  {
    name: "M1 TTL 必填被去掉（允许 ttl=0 的永久脏锁存在）",
    file: LOCK,
    pairs: [["if (!Number.isInteger(n) || n <= 0)", "if (!Number.isInteger(n) || false)"]],
    test: "TTL 缺失",
  },
  {
    name: "M2 非持有者也能 release（被抢占后原方可解，归属形同虚设）",
    file: LOCK,
    pairs: [['if (cur.who !== who) return { status: "not-holder"', 'if (false) return { status: "not-holder"']],
    test: "非持有者 release",
  },
  {
    name: "M3 抢占改成「先删再建」，并强制拉开竞态窗口",
    file: LOCK,
    // 只换 rm 不换出红：窗口是微秒级，20 个并发也撞不上，那条绿灯是假的。
    // 注入 300ms 睡眠把「读到过期」和「动手抢占」隔开，让 20 家全部读到同一份过期锁。
    pairs: [
      ["    fs.renameSync(p, tmp);", "    fs.rmSync(p, { force: true });"],
      ["function stealExpired(p) {", "function stealExpired(p) {\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);"],
    ],
    test: "恰好 1 家拿到",
  },
  {
    name: "M4 受阻不写 waiters.log（旁观者分不清「在等」和「没干活」）",
    file: CLI,
    pairs: [["    const line = noteWait({ claimsDir: CLAIMS, file, who, holder: r.holder, ageS: r.ageS, ttl: r.ttl });", "    const line = `（变异：不落日志）`;"]],
    test: "exit 3，且往板上写一行 WAIT",
  },
  {
    name: "M5 代码把退码 3 改成 8，README 那张表立刻该红",
    file: LOCK,
    suite: "test/docs-drift.test.js",
    pairs: [["  BLOCKED: 3,", "  BLOCKED: 8,"]],
    test: "退码表与代码 EXIT",
  },
  {
    name: "M6 README 退码 3 那行删掉留痕文件名，语义断言该红",
    file: README,
    suite: "test/docs-drift.test.js",
    pairs: [["**追加一行 `WAIT` 到 `claims/waiters.log`**", "**追加一行 `WAIT` 到板上**"]],
    test: "三条关键语义",
  },
  {
    name: "M7 代码不再返回退码 4，「每个值都能实跑」那条该红",
    file: LOCK,
    suite: "test/docs-drift.test.js",
    pairs: [['if (!cur) return { status: "no-lock", code: EXIT.NO_LOCK,', 'if (!cur) return { status: "no-lock", code: EXIT.BLOCKED,']],
    test: "每个值都能被 CLI 真跑到",
  },
  {
    name: "M8 抢占仲裁失效，推演器 S2b 那条该红（证据文档引的是它的数字）",
    file: LOCK,
    suite: "test/sim.test.js",
    pairs: [
      ["    fs.renameSync(p, tmp);", "    fs.rmSync(p, { force: true });"],
      ["function stealExpired(p) {", "function stealExpired(p) {\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);"],
    ],
    test: "S2b",
  },
];

function runTest(pattern, suite) {
  const r = spawnSync(process.execPath, ["--test", "--test-name-pattern", pattern, suite || "test/claims.test.js"], {
    cwd: ROOT, encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  return {
    red: r.status !== 0,
    pass: /\nℹ pass (\d+)/.exec(out)?.[1],
    fail: /\nℹ fail (\d+)/.exec(out)?.[1],
    ran: /\nℹ tests (\d+)/.exec(out)?.[1],
    // 把断言消息原文抓出来：只报"红了"不够，要看得见红在哪条判据上
    msg: (out.match(/AssertionError[^\n]*/) || [])[0] || (out.match(/^\s*AssertionError[^\n]*/m) || [])[0] || "",
    detail: (out.match(/(并发抢占出现[^\n]*|自称赢[^\n]*|TTL 必须是[^\n]*|被拒的 release[^\n]*|被挡住必须留痕[^\n]*|退码表与代码不符[^\n]*|这些退码在[^\n]*|那一行没[^\n]*)/) || [])[1] || "",
  };
}

let allRed = true;
for (const m of MUT) {
  const bak = m.file + ".bak-red";
  copyFileSync(m.file, bak);
  const src = readFileSync(m.file, "utf8");
  let patched = src;
  let missed = null;
  for (const [from, to] of m.pairs) {
    if (!patched.includes(from)) { missed = from; break; }
    patched = patched.replace(from, to);
  }
  if (missed) {
    console.log(`!! ${m.name}\n   变异锚点没命中：${missed}\n   跳过——锚点没命中的话，报绿不算证据\n`);
    allRed = false;
    rmSync(bak);
    continue;
  }
  writeFileSync(m.file, patched);
  const res = runTest(m.test, m.suite);
  rmSync(m.file);
  copyFileSync(bak, m.file);
  rmSync(bak);
  // 模式名匹配不到任何测试时，node --test 退出码是 0：那是一条**空跑的绿灯**。
  // 上一轮就吃过这个亏，所以这里把"跑到几条"一起判掉。
  const empty = res.ran === "0" || res.ran === undefined;
  console.log(`${res.red && !empty ? "红 ✓" : "绿 ✗ 假绿灯！"}  ${m.name}`);
  console.log(`   套件 ${m.suite || "test/claims.test.js"} 匹配「${m.test}」：跑到 ${res.ran} 条，pass=${res.pass} fail=${res.fail}`);
  console.log(`   断言原文：${(res.detail || res.msg || "（未匹配到）").slice(0, 200)}\n`);
  if (!res.red || empty) allRed = false;
  if (readFileSync(m.file, "utf8") !== src) { console.log("!! 还原失败，停下"); process.exit(9); }
}
console.log(allRed ? `=== ${MUT.length} 处变异全部把测试打红 ===` : "=== 有变异没打红、空跑或没命中，结论不成立 ===");
process.exit(allRed ? 0 : 8);

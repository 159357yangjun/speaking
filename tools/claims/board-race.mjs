#!/usr/bin/env node
// 并发写板探针：两个**各自合法持锁**的进程（不同文件、同一张板）同时 board。
// 要回答的问题不是"锁会不会双主"（不会，锁按文件分），而是：
//   board 把"复验"和"写"装进了同一次调用，可它读的是**整张板**、写回的也是整张板。
//   两个进程各自复验通过 → 各自 read → 各自 append 自己那一行 → 各自 rename。
//   于是后写的把前一个人的行**整块抹掉**。丢的是别人的声明行，不是自己的。
//
// 用法：node tools/claims/board-race.mjs <仓库绝对路径> [轮数=20] [--inject=毫秒] [--unlocked]
//
// --inject    把 src/ 整棵树拷到临时目录，在 writeBoard 的"读板"与"落盘"之间插入忙等。
//             不注入时窗口只有 ~2ms，12 轮也可能一次都没撞上——**"没复现"不等于"没这个洞"**，
//             这条纪律是本项目用两条假绿灯换来的。注入只改变命中概率，不改变可能性。
//             注入打的是副本，不动在库文件。
// --unlocked  在**同一份临时副本**里把板级锁队列拆掉（`if (true) break`），用来重跑"加板锁之前"那一列。
//             README 里那对 0/6 ↔ 6/6 必须两个方向都能从这条命令跑出来；
//             只有"现行代码"一列可重跑的话，另一列就成了叙述。
//
// 退出码：0 = 抓到丢行（缺陷在场）· 3 = 每轮两行都在（干净）· 9 = 用法错 / 注入锚点没命中。
//         方向要读对：**0 是坏消息**。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printSummary, crossCheck, HARNESS_EXIT } from "../../src/claims/summary.js";

// 本工具的退码表——**打印与判读共用这一处定义**。
// 为什么不让判读方（docs-drift）去正则扫 `process.exit(...)`：上一轮它就因为收尾写成
// `process.exit(lost.length > 0 ? 0 : 3)` 而漏读了 0 和 3，把"实际退码集合"读成 [9]。
// 那次的正确处置是改判据而不是放宽断言；而更稳的判据是**声明表**：
// 这里声明了什么，README 就必须解释什么，且每个都真被某条出口用到。
const EXIT_CODES = { foundLoss: 0, clean: 3, badUsage: 9, harness: HARNESS_EXIT };

const ROOT = process.argv[2];
const ROUNDS = parseInt(process.argv[3] ?? "20", 10);
const INJECT = parseInt((process.argv.find((a) => a.startsWith("--inject=")) ?? "").split("=")[1], 10);
const UNLOCKED = process.argv.includes("--unlocked");
if (!ROOT) { console.error("用法：node tools/claims/board-race.mjs <仓库绝对路径> [轮数] [--inject=毫秒] [--unlocked]"); process.exit(EXIT_CODES.badUsage); }
if (UNLOCKED && !(Number.isInteger(INJECT) && INJECT > 0)) {
  // --unlocked 而不注入：窗口只有 ~2ms，很可能一轮都撞不上，于是"改前也干净"——
  // 那是一条会被读成"板级锁其实没必要"的假绿灯，比不跑更糟。
  console.error("!! --unlocked 必须配 --inject=<毫秒>：不注入的对照跑不出缺陷，只能跑出'看起来没问题'。");
  process.exit(EXIT_CODES.badUsage);
}
const CLI = path.join(ROOT, "src/cli.js");
const BOARD = "PROGRESS.md";

let tmpCopy = null;
let cliPath = CLI;
if (Number.isInteger(INJECT) && INJECT > 0) {
  tmpCopy = fs.mkdtempSync(path.join(os.tmpdir(), "relay-board-src-"));
  fs.cpSync(path.join(ROOT, "src"), path.join(tmpCopy, "src"), { recursive: true });
  cliPath = path.join(tmpCopy, "src", "cli.js");
  const lock = path.join(tmpCopy, "src", "claims", "lock.js");
  const src = fs.readFileSync(lock, "utf8").replace(/\r\n/g, "\n");
  const ANCHOR = "  const part = `${boardPath}.part-${process.pid}`;";
  if (!src.includes(ANCHOR)) {
    console.error("!! 注入锚点没命中（writeBoard 的落盘段被改了）。停下——静默没注入就是一场空跑。");
    process.exit(EXIT_CODES.badUsage);
  }
  const busy = `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${INJECT});\n`;
  let patched = src.replace(ANCHOR, busy + ANCHOR);
  if (patched === src) { console.error("!! replace() 没改任何字节，注入静默失效。"); process.exit(EXIT_CODES.badUsage); }
  if (UNLOCKED) {
    // 与变异 M21 同一个锚点：拿到"假装的板锁"就走，不排队——这就是加板级锁之前的形状。
    const QUEUE = '    if (b.status === "acquired" || b.status === "stolen") break;';
    if (!patched.includes(QUEUE)) { console.error("!! 板级锁队列锚点没命中，--unlocked 静默失效。"); process.exit(EXIT_CODES.badUsage); }
    patched = patched.replace(QUEUE, '    if (true) break;   // --unlocked：不排队，直接读整张板再写回去');
  }
  fs.writeFileSync(lock, patched);
  if (!fs.readFileSync(lock, "utf8").includes("Atomics.wait")) { console.error("!! 回读没看到注入。"); process.exit(EXIT_CODES.badUsage); }
  if (UNLOCKED && !fs.readFileSync(lock, "utf8").includes("--unlocked：不排队")) {
    console.error("!! 回读没看到 --unlocked 的改动。"); process.exit(EXIT_CODES.badUsage);
  }
}

function runCli(args) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function runCliAsync(args) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res({ code, out }));
  });
}
function tokenOf(text) {
  return /--at=(\d+)/.exec(text)?.[1] ?? /化身 (\d+)/.exec(text)?.[1];
}

// 判据必须与令牌无关：board 会把行改写成 `| src/one.js | qoder | now <at=..> |`，
// 逐字匹配行尾的正则会**静默失配**，把"两行都在"读成"两行都丢"——我自己刚踩过。
// 反过来它也绝不能恒真：所以计数函数先过一份**对照夹具**再允许它去数现场。
// 没这一步，"6/6 两行都在"可能只是检测器什么都没数到。
function countRow(board, f, w) {
  return board.split(/\r?\n/).filter((l) => l.includes(`| ${f} |`) && l.includes(`| ${w} |`)).length;
}

// 第二把尺子：按**令牌**数，而不是按"文件名 + 人"这两个格子数。
// 为什么必须换一把：`reported` 与现场重算的 `raw` 若是同一个函数算出来的，它们一致只证明
// "没人手滑改数"，证明不了"数得对"——countRow 的锚点一变（本项目真踩过：行尾被盖上
// `<at=…>` 之后逐字匹配静默失配），两把同源尺子会一起错、一起报"干净"。
// 令牌这一把的值来自 claim 的 stdout（不是从板子上读出来的），所以来源是独立的。
function countToken(board, token) {
  return board.split(/\r?\n/).filter((l) => l.includes(`<at=${token}>`)).length;
}

function detectorSelfTest() {
  const cases = [
    { name: "两行都在（带令牌）",
      board: "| src/one.js | qoder | now <at=111> |\n| src/two.js | workbuddy | now <at=222> |\n", want1: 1, want2: 1 },
    { name: "别人的行被抹掉了", board: "| src/two.js | workbuddy | now <at=222> |\n", want1: 0, want2: 1 },
    { name: "我的行被抹掉了", board: "| src/one.js | qoder | now <at=111> |\n", want1: 1, want2: 0 },
    { name: "整张板空了", board: "# 进度板\n", want1: 0, want2: 0 },
    { name: "同一行写了两遍（幂等破了要看得见）",
      board: "| src/one.js | qoder | now |\n| src/one.js | qoder | now |\n", want1: 2, want2: 0 },
  ];
  const bad = [];
  for (const c of cases) {
    const g1 = countRow(c.board, "src/one.js", "qoder"), g2 = countRow(c.board, "src/two.js", "workbuddy");
    if (g1 !== c.want1 || g2 !== c.want2) bad.push(`${c.name}：数到 (${g1},${g2})，应为 (${c.want1},${c.want2})`);
  }
  return bad;
}

const selfBad = detectorSelfTest();
if (selfBad.length) {
  console.error(`!! 计数函数过不了自己的对照夹具，停下不出数字：\n   ${selfBad.join("\n   ")}`);
  console.error("   检测器没有判别力时，\"两行都在 6/6\"与\"什么都没数到\"是同一句话。");
  process.exit(EXIT_CODES.badUsage);
}
if (process.argv.includes("--detector-selftest-only")) { console.log("ok 计数函数对照夹具 5/5 通过"); process.exit(0); }

const rows = [];
console.log(`配置：轮数=${ROUNDS} 注入=${Number.isInteger(INJECT) && INJECT > 0 ? INJECT + "ms" : "无"} 板级锁=${UNLOCKED ? "**已拆掉（--unlocked，改前形状）**" : "在"}`);
for (let r = 1; r <= ROUNDS; r++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-board-race-"));
  fs.writeFileSync(path.join(dir, BOARD), "# 进度板\n");
  const a = runCli(["claim", `--channel=${dir}`, "--file=src/one.js", "--who=qoder", "--ttl=600"]);
  const b = runCli(["claim", `--channel=${dir}`, "--file=src/two.js", "--who=workbuddy", "--ttl=600"]);
  const ta = tokenOf(a.out), tb = tokenOf(b.out);
  if (!ta || !tb) { console.error(`第${r}轮：没拿到令牌，夹具失效\n${a.out}${b.out}`); process.exit(EXIT_CODES.badUsage); }

  // 同一瞬间：两个都放行，参数只差文件/人/行——不存在"谁先谁后"的安排
  const [r1, r2] = await Promise.all([
    runCliAsync(["board", `--channel=${dir}`, "--file=src/one.js", "--who=qoder", "--at=" + ta,
      `--board=${path.join(dir, BOARD)}`, "--row=| src/one.js | qoder | now |"]),
    runCliAsync(["board", `--channel=${dir}`, "--file=src/two.js", "--who=workbuddy", "--at=" + tb,
      `--board=${path.join(dir, BOARD)}`, "--row=| src/two.js | workbuddy | now |"]),
  ]);
  const board = fs.readFileSync(path.join(dir, BOARD), "utf8");
  const n1 = countRow(board, "src/one.js", "qoder");
  const n2 = countRow(board, "src/two.js", "workbuddy");
  const has1 = n1 === 1, has2 = n2 === 1;
  // 两把尺子必须同向；不同向就是测具在骗人，不是缺陷"没撞上"
  if (ta === tb) { console.error(`第${r}轮：两家令牌相同（${ta}），第二把尺子失去独立性，停下`); process.exit(9); }
  const t1 = countToken(board, ta), t2 = countToken(board, tb);
  const agree = (t1 === 1 && t2 === 1) === (has1 && has2);
  rows.push({ round: r, c1: r1.code, c2: r2.code, has1, has2, both: has1 && has2, n1, n2, agree });
  console.log(`  第${String(r).padStart(2)}轮：退码 qoder=${r1.code} workbuddy=${r2.code}  one行数=${n1} two行数=${n2}  令牌尺=(${t1},${t2})  ${has1 && has2 ? "两行都在" : "★ 有一行整块丢了"}${agree ? "" : "  ✗两把尺子不同向"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

const lost = rows.filter((x) => !x.both);
if (tmpCopy) fs.rmSync(tmpCopy, { recursive: true, force: true });
const bothZero = rows.filter((x) => x.c1 === 0 && x.c2 === 0);
console.log(`\n判据：两个进程都各自持有一把合法的锁（不同文件），board 都复验通过时，`);
console.log(`      最终板子必须同时含两行——少任何一行都是"别人的声明被抹掉"。`);
console.log(`  ${ROUNDS} 轮里两行都在：${rows.length - lost.length}/${ROUNDS}`);
console.log(`  两个进程都退 0 的轮数：${bothZero.length}/${ROUNDS}`);
console.log(`  **两家都自称写成功、板子上却只剩一行**的轮数：${rows.filter((x) => x.c1 === 0 && x.c2 === 0 && !x.both).length}/${ROUNDS}`);

// 机读汇总行 + 三向印证。为什么要有这一段：这一族的失败不是"数字难看"，是
// **读不到计数与计数为 0 长得一样**——打印方改了字段名，判读方正则失配，
// 于是 "NOT REPORTED" 被当成 "PASSED"（隔壁仓刚实出来一次）。
// 形状要求：退码由**现场重算的 raw** 推；对外报的数从**打印出去的那份对象**里读回来。
// 于是"临时把计数打印错但不改退码"这种改动必定被 crossCheck 抓到，两个方向都是。
const raw = rows.filter((x) => !x.both).length;
// 第二把尺子不同向 ⇒ 这份数不可信（不管它偏向"丢了"还是"没丢"）
const mismatch = rows.filter((x) => !x.agree).length;
const code = raw > 0 ? EXIT_CODES.foundLoss : EXIT_CODES.clean;
const summary = {
  kind: "board-race", rounds: ROUNDS, measured: rows.length,
  lost: lost.length,
  bothZero: bothZero.length,
  inject: Number.isInteger(INJECT) ? INJECT : 0, unlocked: UNLOCKED ? 1 : 0,
  rulerMismatch: mismatch,
  code, codes: [...new Set(Object.values(EXIT_CODES))],
};
printSummary(summary);
const why = crossCheck(code, { reported: summary.lost, raw, expect: ROUNDS, measured: summary.measured, badIsSuccess: true });
if (mismatch > 0) {
  // 这一条与 crossCheck 是两件事：crossCheck 只能发现"报出去的和现场重算的不一样"，
  // 两边同源时它一定通过。第二把尺子不同向说明**两个同源数一起错**，那种数最难看穿。
  console.error(`\n!! 两把尺子不同向：${mismatch}/${ROUNDS} 轮上"按格子数"与"按令牌数"结论不一致。`);
  console.error("   停下不出表：检测器失去判别力时，\"两行都在 N/N\"与\"什么都没数到\"是同一句话。");
  process.exit(EXIT_CODES.harness);
}
if (why) {
  console.error(`\n!! 测具不可信：${why}\n   这份表不进 README——它可能只是"没量到"，不是"没撞上"。`);
  process.exit(EXIT_CODES.harness);
}
process.exit(code);

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
//             这条纪律是本项目用两条假绿灯换来的。
//             **注入有上限**：一旦 `--inject ≥ BOARD_WAIT_MS`（板级锁排队预算，现 2000ms），
//             第二家等满就退 12，"两家都自称写成功"这个前提一次都不成立 ⇒ 本探针退 4（不是退 0）。
//             上一轮我把 3000ms 那一档读成"改后也丢行 6/6"，那其实是"没跑成竞争"——指控错了对象。
// 退出码：0 = 抓到丢行（缺陷在场）· 3 = 跑成的轮里两行都在（干净）·
//         4 = 前提不成立（没有任何一轮两家都退 0，判据没被走到，不许当结论）·
//         9 = 用法错 / 注入或 --unlocked 锚点没命中 / 计数与状态不互相印证。注入只改变命中概率，不改变可能性。
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
// 只是把"排队预算"这个数从被测实现里取过来写进诊断话术，免得话术里手抄一个会过期的常量。
import { BOARD_WAIT_MS } from "../../src/claims/lock.js";

// 本工具的退码表——**打印与判读共用这一处定义**。
// 为什么不让判读方（docs-drift）去正则扫 `process.exit(...)`：上一轮它就因为收尾写成
// `process.exit(lost.length > 0 ? 0 : 3)` 而漏读了 0 和 3，把"实际退码集合"读成 [9]。
// 那次的正确处置是改判据而不是放宽断言；而更稳的判据是**声明表**：
// 这里声明了什么，README 就必须解释什么，且每个都真被某条出口用到。
const EXIT_CODES = { foundLoss: 0, clean: 3, precondition: 4, badUsage: 9, harness: HARNESS_EXIT };

// 注意偏移：process.argv = [node, 脚本, 参数...]，必须 slice(2)。
// 上一版这里写成 slice(3)，把仓库路径整个吞掉——`ROOT` 变成轮数，探针在 cpSync 里炸 ENOENT。
const argv = process.argv.slice(2);
const ROOT = argv[0];
const ROUNDS = parseInt(argv[1] ?? "20", 10);
const INJECT = parseInt((argv.find((a) => a.startsWith("--inject=")) ?? "").split("=")[1], 10);
const UNLOCKED = argv.includes("--unlocked");
// 参数必须逐个认得。上一版我把注入写成裸数字（`… 6 600 --unlocked`），
// 探针一声不吭地按"不注入"跑了 12 轮 —— 那是最容易读成"改前也干净"的一种错法：
// 命令看起来跑了、跑完了还退了非 0、只是量的根本不是同一件事。
//
// 判据只放**带前缀的开关**：位置 2 之后不认裸数字。
// 曾经写成 `|| /^\d+$/.test(a)`，理由是"轮数也是数字"——但轮数在位置 1，位置 2 之后的数字
// 只可能是"忘了写 --inject= 的那个注入值"，放它过去等于把本条注释描述的错法原样放行
// （实测：`… 2 600` 退 3 报"干净"，注入根本没生效）。裸数字现在必撞 stray。
const known = (a) => a.startsWith("--inject=") || a === "--unlocked" || a === "--detector-selftest-only";
const stray = argv.slice(2).filter((a) => !known(a));
if (stray.length) {
  console.error(`!! 不认识的参数：${stray.join(" ")}（注入必须写成 --inject=<毫秒>）`);
  console.error("   停下：被静默忽略的参数会让『跑过了』与『跑的是我以为的那件事』分不开。");
  process.exit(EXIT_CODES.badUsage);
}
if (!ROOT) { console.error("用法：node tools/claims/board-race.mjs <仓库绝对路径> [轮数] [--inject=毫秒] [--unlocked]"); process.exit(EXIT_CODES.badUsage); }
// ROOT 必须认得出是仓库。参数写反（`6 <路径>`）时旧版会在 cpSync 里炸一串 ENOENT 栈：
// 那至少是响的，但"响得看不懂"与"静默跑错"对读的人是一样的下场，所以在入口就报清。
if (!fs.existsSync(path.join(ROOT, "src", "cli.js"))) {
  console.error(`!! ROOT 不像仓库：找不到 ${path.join(ROOT, "src", "cli.js")}`);
  console.error("   参数顺序是 <仓库绝对路径> [轮数]，别把轮数写在第一位。");
  process.exit(EXIT_CODES.badUsage);
}
// 轮数要么不写（默认 20），要么写成正整数；`parseInt` 会把 "6a" 读成 6、把 "--x" 读成 NaN，
// 而 NaN 会让 crossCheck 的"样本数不齐"那道自洽校验**整条跳过**（Number.isFinite(expect) 为假）：
// 那正好是"宽容解析把猎物抹掉"的形状，所以在校验入口就堵掉，不靠下游兜。
if (argv[1] !== undefined && !/^[1-9]\d*$/.test(argv[1])) {
  console.error(`!! 轮数必须是正整数（或整段不写走默认 20），收到 ${JSON.stringify(argv[1])}`);
  process.exit(EXIT_CODES.badUsage);
}
// --inject= 要么不写，要么写成正整数毫秒。两种写坏在旧版里都会**静默降级**：
//   `--inject=abc` → parseInt 得 NaN → 走"不注入"分支，而汇总行照样打印 `inject: 0`，
//                   于是"没注入"和"注入值写坏了"共用同一个数，跑完退 3 报"干净"；
//   `--inject=6o0` → parseInt 得 6 → 真的只注入 6ms（窗口 ~2ms，基本撞不上），报的却是 6。
// 命令与现场对不上而对外看不出来，就是本轮通令要杀的形状。
const injectRaw = (argv.find((a) => a.startsWith("--inject=")) ?? "").slice("--inject=".length);
if (injectRaw && !/^[1-9]\d*$/.test(injectRaw)) {
  console.error(`!! --inject= 必须是正整数毫秒，收到 ${JSON.stringify(injectRaw)}（不注入就整个开关别写）`);
  process.exit(EXIT_CODES.badUsage);
}
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

// 第二把尺子：拿**每个进程自己打印的那行"落的那一行：…"**去板子上按整行找。
// 为什么不用令牌数：claim 是先后两次独占创建，同一毫秒里两家的 `at` 可以完全相同
// （本轮实测 `--unlocked` 就撞上过），那一刻令牌尺失去判别力；而且令牌仍是"从板子上读出来的东西"，
// 与第一把尺子同源。claim 行是子进程 stdout，来源独立，且整行相等比对与格子切分无关。
function claimOf(out) {
  const m = /落的那一行：(.*)/.exec(String(out));
  return m ? m[1].trim() : null;
}

function rowPresent(board, row) {
  if (!row) return false;
  return board.split(/\r?\n/).some((l) => l.trim() === row);
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
  const c1 = claimOf(r1.out), c2 = claimOf(r2.out);
  const applicable = r1.code === 0 && r2.code === 0;   // 两家都自称写成功，第二把尺子才有话说
  // "第二把尺子读不出 claim 行" 绝不能和 "板上没有那一行" 长成一样。
  // 上一版这里是静默的：claimOf 失配返 null ⇒ rowPresent 返 false ⇒ 尺子说"不在"，
  // 而那一刻若格子尺也说"不在"（行真的被覆盖了），两把尺子"同向"、agree=true、一切照常退 0——
  // 也就是说：把 claim 的输出格式改掉，测具不会变红，只会**少一把尺子**继续跑。
  // 所以凡是"两家都退 0（尺子本该有话说）却读不到 claim 行"的轮，当场停下并打原文。
  if (applicable && (!c1 || !c2)) {
    console.error(`第${r}轮：两家都退 0 但读不到"落的那一行"（c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)}）。`);
    console.error("  停下：这是『读不出』冒充『不存在』，第二把尺子已经不在场，本表的结论不成立。");
    console.error(`  qoder 原文：\n${String(r1.out).split(/\r?\n/).slice(0, 12).map((l) => "    " + l).join("\n")}`);
    console.error(`  workbuddy 原文：\n${String(r2.out).split(/\r?\n/).slice(0, 12).map((l) => "    " + l).join("\n")}`);
    process.exit(EXIT_CODES.harness);
  }
  const p1 = rowPresent(board, c1), p2 = rowPresent(board, c2);
  const agree = applicable ? ((p1 && p2) === (has1 && has2) && (p1 ? 1 : 0) + (p2 ? 1 : 0) === n1 + n2) : null;
  rows.push({ round: r, c1: r1.code, c2: r2.code, has1, has2, both: has1 && has2, n1, n2, agree, applicable });
  console.log(`  第${String(r).padStart(2)}轮：退码 qoder=${r1.code} workbuddy=${r2.code}  one行数=${n1} two行数=${n2}  claim尺=(${p1 ? "在" : "不在"},${p2 ? "在" : "不在"})  ` +
    (applicable ? (has1 && has2 ? "两行都在" : "★ 有一行整块丢了") : `○ 有一家没退 0（${r1.code === 0 ? "workbuddy" : "qoder"} 被拒），本轮没跑成竞争`) +
    (agree === false ? "  ✗两把尺子不同向" : ""));
  fs.rmSync(dir, { recursive: true, force: true });
}

const lost = rows.filter((x) => x.applicable && !x.both);
// 有一家在板上被拒（没轮到写）的轮：这些轮**没有跑成这场竞争**，不是"缺陷没撞上"更不是"丢了行"。
const refused = rows.filter((x) => !x.applicable);
if (tmpCopy) fs.rmSync(tmpCopy, { recursive: true, force: true });
const bothZero = rows.filter((x) => x.c1 === 0 && x.c2 === 0);
console.log(`\n判据：两个进程都各自持有一把合法的锁（不同文件），board 都复验通过时，`);
console.log(`      最终板子必须同时含两行——少任何一行都是"别人的声明被抹掉"。`);
console.log(`  ${ROUNDS} 轮里两行都在：${rows.filter((x) => x.both).length}/${ROUNDS}`);
console.log(`  两个进程都退 0 的轮数：${bothZero.length}/${ROUNDS}`);
console.log(`  **两家都自称写成功、板子上却只剩一行**的轮数：${lost.length}/${ROUNDS}   ← 判据看的就是这个数`);
console.log(`  有一家被拒/没退 0（这一轮没跑成竞争，不计入上面那个数）：${refused.length}/${ROUNDS}`);

// 机读汇总行 + 三向印证。为什么要有这一段：这一族的失败不是"数字难看"，是
// **读不到计数与计数为 0 长得一样**——打印方改了字段名，判读方正则失配，
// 于是 "NOT REPORTED" 被当成 "PASSED"（隔壁仓刚实出来一次）。
// 形状要求：退码由**现场重算的 raw** 推；对外报的数从**打印出去的那份对象**里读回来。
// 于是"临时把计数打印错但不改退码"这种改动必定被 crossCheck 抓到，两个方向都是。
const raw = rows.filter((x) => x.applicable && (x.n1 !== 1 || x.n2 !== 1)).length;
// 第二把尺子不同向 ⇒ 这份数不可信（不管它偏向"丢了"还是"没丢"）
const mismatch = rows.filter((x) => x.agree === false).length;
const applicable = rows.filter((x) => x.applicable).length;
// 退码 4（与 renew-race 同一个约定）：**一家都没写成 ⇒ 这场竞争一次都没发生**，
// 那种现场既不能读成"抓到丢行"，也不能读成"没丢行"，只能读成"没量到"。
// 上一轮我就差点把 renew-race 的一次空跑当成"没有双主"，这次是同一个坑的另一半：
// 实测 `--inject=3000`（超过板级锁排队预算 BOARD_WAIT_MS）时第二家一律退 12，
// 板子上自然只有一行——旧判据把这份"没跑成"报成 lost=6/6 并退 0，等于**凭空指控了一次缺陷**。
const code = applicable === 0 ? EXIT_CODES.precondition : (raw > 0 ? EXIT_CODES.foundLoss : EXIT_CODES.clean);
const summary = {
  kind: "board-race", rounds: ROUNDS, measured: rows.length,
  lost: lost.length,
  bothZero: bothZero.length,
  refused: refused.length, applicable,
  inject: Number.isInteger(INJECT) ? INJECT : 0, unlocked: UNLOCKED ? 1 : 0,
  rulerMismatch: mismatch, rulerApplicable: applicable,
  code, codes: [...new Set(Object.values(EXIT_CODES))],
};
printSummary(summary);
const why = crossCheck(code, { reported: summary.lost, raw, expect: ROUNDS, measured: summary.measured, badIsSuccess: true });
if (why) {
  console.error(`\n!! 测具不可信：${why}\n   这份表不进 README——它可能只是"没量到"，不是"没撞上"。`);
  process.exit(EXIT_CODES.harness);
}
if (mismatch > 0) {
  // 这一条与 crossCheck 是两件事：crossCheck 只能发现"报出去的和现场重算的不一样"，
  // 两边同源时它一定通过。第二把尺子不同向说明**两个同源数一起错**，那种数最难看穿。
  console.error(`\n!! 两把尺子不同向：${mismatch}/${ROUNDS} 轮上"按格子数"与"按 claim 整行"结论不一致。`);
  console.error("   停下不出表：检测器失去判别力时，\"两行都在 N/N\"与\"什么都没数到\"是同一句话。");
  process.exit(EXIT_CODES.harness);
}
if (applicable === 0) {
  const byCode = {};
  for (const x of rows) for (const c of [x.c1, x.c2]) byCode[c] = (byCode[c] || 0) + 1;
  console.error(`\n!! 前提不成立：${ROUNDS} 轮里没有一轮是"两家都退 0"（单次退码分布 ${JSON.stringify(byCode)}）。`);
  console.error(`   注入 ${INJECT}ms ≥ 板级锁排队预算 BOARD_WAIT_MS=${BOARD_WAIT_MS}ms：第二家等满就退 12，`);
  console.error(`   "两个都自称写成功"这个前提一次都没成立，所以本表既不说"丢了行"也不说"没丢"。`);
  console.error("   要么把注入调小到 BOARD_WAIT_MS 以内，要么给 board 传 --wait=<更大值>（那是另一件事：改的是被测实现）。");
  process.exit(EXIT_CODES.precondition);
}
process.exit(code);

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

const ROOT = process.argv[2];
const ROUNDS = parseInt(process.argv[3] ?? "20", 10);
const INJECT = parseInt((process.argv.find((a) => a.startsWith("--inject=")) ?? "").split("=")[1], 10);
const UNLOCKED = process.argv.includes("--unlocked");
if (!ROOT) { console.error("用法：node tools/claims/board-race.mjs <仓库绝对路径> [轮数] [--inject=毫秒] [--unlocked]"); process.exit(9); }
if (UNLOCKED && !(Number.isInteger(INJECT) && INJECT > 0)) {
  // --unlocked 而不注入：窗口只有 ~2ms，很可能一轮都撞不上，于是"改前也干净"——
  // 那是一条会被读成"板级锁其实没必要"的假绿灯，比不跑更糟。
  console.error("!! --unlocked 必须配 --inject=<毫秒>：不注入的对照跑不出缺陷，只能跑出'看起来没问题'。");
  process.exit(9);
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
    process.exit(9);
  }
  const busy = `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${INJECT});\n`;
  let patched = src.replace(ANCHOR, busy + ANCHOR);
  if (patched === src) { console.error("!! replace() 没改任何字节，注入静默失效。"); process.exit(9); }
  if (UNLOCKED) {
    // 与变异 M21 同一个锚点：拿到"假装的板锁"就走，不排队——这就是加板级锁之前的形状。
    const QUEUE = '    if (b.status === "acquired" || b.status === "stolen") break;';
    if (!patched.includes(QUEUE)) { console.error("!! 板级锁队列锚点没命中，--unlocked 静默失效。"); process.exit(9); }
    patched = patched.replace(QUEUE, '    if (true) break;   // --unlocked：不排队，直接读整张板再写回去');
  }
  fs.writeFileSync(lock, patched);
  if (!fs.readFileSync(lock, "utf8").includes("Atomics.wait")) { console.error("!! 回读没看到注入。"); process.exit(9); }
  if (UNLOCKED && !fs.readFileSync(lock, "utf8").includes("--unlocked：不排队")) {
    console.error("!! 回读没看到 --unlocked 的改动。"); process.exit(9);
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

const rows = [];
console.log(`配置：轮数=${ROUNDS} 注入=${Number.isInteger(INJECT) && INJECT > 0 ? INJECT + "ms" : "无"} 板级锁=${UNLOCKED ? "**已拆掉（--unlocked，改前形状）**" : "在"}`);
for (let r = 1; r <= ROUNDS; r++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-board-race-"));
  fs.writeFileSync(path.join(dir, BOARD), "# 进度板\n");
  const a = runCli(["claim", `--channel=${dir}`, "--file=src/one.js", "--who=qoder", "--ttl=600"]);
  const b = runCli(["claim", `--channel=${dir}`, "--file=src/two.js", "--who=workbuddy", "--ttl=600"]);
  const ta = tokenOf(a.out), tb = tokenOf(b.out);
  if (!ta || !tb) { console.error(`第${r}轮：没拿到令牌，夹具失效\n${a.out}${b.out}`); process.exit(9); }

  // 同一瞬间：两个都放行，参数只差文件/人/行——不存在"谁先谁后"的安排
  const [r1, r2] = await Promise.all([
    runCliAsync(["board", `--channel=${dir}`, "--file=src/one.js", "--who=qoder", "--at=" + ta,
      `--board=${path.join(dir, BOARD)}`, "--row=| src/one.js | qoder | now |"]),
    runCliAsync(["board", `--channel=${dir}`, "--file=src/two.js", "--who=workbuddy", "--at=" + tb,
      `--board=${path.join(dir, BOARD)}`, "--row=| src/two.js | workbuddy | now |"]),
  ]);
  const board = fs.readFileSync(path.join(dir, BOARD), "utf8");
  // 判据必须与令牌无关：board 会把行改写成 `| src/one.js | qoder | now <at=..> |`，
  // 逐字匹配行尾的正则会**静默失配**，把"两行都在"读成"两行都丢"——我自己刚踩到。
  const countRow = (f, w) => board.split("\n")
    .filter((l) => l.includes(`| ${f} |`) && l.includes(`| ${w} |`)).length;
  const n1 = countRow("src/one.js", "qoder");
  const n2 = countRow("src/two.js", "workbuddy");
  const has1 = n1 === 1, has2 = n2 === 1;
  rows.push({ round: r, c1: r1.code, c2: r2.code, has1, has2, both: has1 && has2, n1, n2 });
  console.log(`  第${String(r).padStart(2)}轮：退码 qoder=${r1.code} workbuddy=${r2.code}  one行数=${n1} two行数=${n2}  ${has1 && has2 ? "两行都在" : "★ 有一行整块丢了"}`);
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
process.exit(lost.length > 0 ? 0 : 3);

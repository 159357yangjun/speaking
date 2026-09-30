#!/usr/bin/env node
// 续期路径的竞态探针：一把**恰好在临界点过期**的锁，同时被两拨进程动手——
// 一拨是持有者自己（走续期分支），一拨是外人（走抢占分支）。
//
// 判据不是"谁赢了"，而是：退出码 0 的那些进程里，**自称的持有者名字必须只有一个**。
// 出现两个名字，就是两个进程各自认为文件归自己 —— 双主。
//
// 用法：
//   node tools/claims/renew-race.mjs <仓库绝对路径> [轮数=20] [LEAD_MS=70]
//        [--inject=毫秒] [--lockref=<git rev>] [--debug] [--label=文本]
//
// --lockref  从 git 取那一版的 lock.js 放进临时副本，用来量"改前 vs 改后"。
//            同一把尺子、两个实现；不靠"把仓库改坏再改回来"，中途崩掉就是脏现场。
// --inject   在临时副本的续期分支里插入忙等。**不改在库文件**。
//            为什么需要它：续期的"读"和"写"是相邻两条语句，窗口是微秒级，
//            40 个并发进程也撞不上（实测 0/4 轮）。窗口窄不等于缺陷不存在——
//            注入延迟只改变命中概率，不改变可能性。
// 两个开关都不给时，测的是当前工作区的真实实现。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printSummary, crossCheck, HARNESS_EXIT } from "../../src/claims/summary.js";

// 退码声明表（与 README 逐值核对，判读方不再正则扫 process.exit —— 见 board-race.mjs 同名表的注释）
const EXIT_CODES = { doubleOwner: 0, singleWinner: 3, precondition: 4, badUsage: 9, harness: HARNESS_EXIT };

const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const ROOT = process.argv[2];
const ROUNDS = parseInt(process.argv[3] ?? "20", 10);
const LEAD = parseInt(process.argv[4] ?? "70", 10);
const LABEL = flag("label") ?? "";
// 必须走 flag()：上一版写的是 `find(...) ?? [""])[1]`，find 返回**字符串**，
// 下标 [1] 取到的是第二个字符 "-"，parseInt 得 NaN —— 于是"注入已生效"是假的，
// 整场跑的是未注入的实现，报出"0 轮双主"。判据自己骗了自己。
const INJECT = parseInt(flag("inject") ?? "", 10);
const REF = flag("lockref");
const REVERTCAS = process.argv.includes("--revertcas");
const DEBUG = process.argv.includes("--debug");
const TRACE = process.argv.includes("--trace-putback");
if (!ROOT) {
  console.error("用法：node tools/claims/renew-race.mjs <仓库绝对路径> [轮数] [LEAD_MS] [--inject=MS] [--lockref=REV] [--debug] [--label=文本]");
  process.exit(EXIT_CODES.badUsage);
}

const FILE = "src/a.js";
const HOLDER = "owner";
// 数量可调：追因时要的是**读得懂的日志**，不是压力。40 家的时候 13 行打点交错成一坨，
// 什么都看不出来；3+2 才看得见"谁删了谁"。
const N_RENEW = parseInt(flag("renew") ?? "", 10) || 20;
const N_STEAL = parseInt(flag("steal") ?? "", 10) || 20;
const LOCK_NAME = `${FILE.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "-")}.lock`;

// 三代续期写法各认各的注入点，认不出来就停——不猜。
// 判据失效时报"0 轮双主"是一条空跑绿灯，比不跑更坏（上一版就是这么静默失配、退出码 9 报出来的）。
//
// **注入点必须落在同一逻辑位置**："续期方做出了它认为会赢的那个动作"与"确认归属"之间。
// 三代分别是：裸覆盖写之前 / 搬走别人锁之前 / 落完续期标记之后的复查之前。
// put 里的 @BUSY@ 是忙等语句的占位。
function anchorFor(src) {
  const GENS = [
    { find: "    fs.writeFileSync(p, payloadOf(who, t.value));",
      put: "@BUSY@\n    fs.writeFileSync(p, payloadOf(who, t.value));",
      gen: "旧一：裸覆盖写" },
    { find: "    const tmp = arbiterMove(p);\n    if (!tmp) {",
      put: "@BUSY@\n    const tmp = arbiterMove(p);\n    if (!tmp) {",
      gen: "旧二：搬走—验货—放回" },
    { find: "    const m = markerOf(p, cur.at);",
      put: "@BUSY@\n    const m = markerOf(p, cur.at);",
      gen: "现行：只增不改的续期标记 CAS" },
  ];
  return GENS.find((g) => src.includes(g.find)) ?? null;
}

function gitShow(rev, file) {
  const r = spawnSync("git", ["show", `${rev}:${file}`], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) { console.error(`!! git show ${rev}:${file} 失败：${(r.stderr || "").trim()}`); process.exit(EXIT_CODES.badUsage); }
  return r.stdout;
}

let CLI, tmpCopy = null, INJECTED = false, GEN = "工作区当前实现";
if (REF || REVERTCAS || (Number.isInteger(INJECT) && INJECT > 0)) {
  tmpCopy = fs.mkdtempSync(path.join(os.tmpdir(), "relay-race-src-"));
  fs.cpSync(path.join(ROOT, "src"), path.join(tmpCopy, "src"), { recursive: true });
  CLI = path.join(tmpCopy, "src", "cli.js");
  const lock = path.join(tmpCopy, "src", "claims", "lock.js");
  if (REF) {
    fs.writeFileSync(lock, gitShow(REF, "src/claims/lock.js"));
    // 只换 lock.js 会造出**混合代**：现在的 cli.js 导入 auditBoard / writeBoard，
    // 而 0414ffa 那版 lock.js 根本没这些导出 ⇒ 每个子进程在 import 阶段就崩，
    // 40 家全崩、续期分支一次没走到，探针退 4 报"前提不成立"。
    // 数字本身没错，错的是"这一代长这样"的假设。取旧代必须连入口一起取。
    fs.writeFileSync(path.join(tmpCopy, "src", "cli.js"), gitShow(REF, "src/cli.js"));
    GEN = `git ${REF}`;
    // 冒烟一次：副本里的 cli 与 lock 必须能装起来。装不起来就直接退 9，
    // 不要拿一份"全部崩溃"的轮表去解释成"没有双主"。
    const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-race-smoke-"));
    fs.mkdirSync(path.join(smokeDir, "claims"), { recursive: true });
    const smoke = spawnSync(process.execPath, [CLI, "locks", `--channel=${smokeDir}`], { encoding: "utf8" });
    fs.rmSync(smokeDir, { recursive: true, force: true });
    if (smoke.status !== 0) {
      console.error(`!! 混合代：git ${REF} 的 lock.js 装不进当前入口（退出 ${smoke.status}）：`);
      console.error(String(smoke.stderr || smoke.stdout).split("\n").slice(0, 6).map((l) => "   " + l).join("\n"));
      console.error("   停下，不出数字。");
      process.exit(EXIT_CODES.badUsage);
    }
  }
  const src = fs.readFileSync(lock, "utf8").replace(/\r\n/g, "\n");
  // 先把副本的行尾统一成 LF：在库的 lock.js 全文是 CRLF，多行锚点若按 \n 比对会**静默不命中**，
  // 于是"0 轮双主"是探针根本没改到代码的结果。上一版就是这么骗过自己的。
  const a = anchorFor(src);
  if (!a) {
    console.error("!! 续期分支的注入点判据没命中（三代写法都不匹配）。");
    console.error("   停下来，不出数字——静默失配会被读成「0 轮双主」，那是空跑的绿灯。");
    process.exit(EXIT_CODES.badUsage);
  }
  GEN += ` / ${a.gen}`;
  if (Number.isInteger(INJECT) && INJECT > 0) {
    const busy = `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${INJECT});`;
    const patched = src.replace(a.find, a.put.replace("@BUSY@", busy));
    if (patched === src) { console.error("!! replace() 没改动任何字节——注入静默失效，停下。"); process.exit(EXIT_CODES.badUsage); }
    fs.writeFileSync(lock, patched);
    // 回读确认：这条自检就是用来抓"探针说注入了、其实没有"的假绿灯
    if (!fs.readFileSync(lock, "utf8").includes(busy)) {
      console.error("!! 回读看不到注入语句，停下。");
      process.exit(EXIT_CODES.badUsage);
    }
    INJECTED = true;
  }
  if (REVERTCAS) {
    // 把续期改回"洞 1"的形状：裸覆盖写 + 只比名字不比化身。
    // 为什么要有这个开关：README 那对 `2/2 轮双主 → 0/2` 的"改前"一列之前只能靠
    // `--lockref` 取整代旧代码，而旧那代跑不出双主（抢占方一家都没赢，探针退 4 拒收）——
    // 于是一列可重跑、一列不可。和 board-race 的 `--unlocked` 同一个道理：
    // **对照列必须也能用一条命令跑出来**，否则它就是叙述。
    // 两处都要改：只把 createMarker 换成覆盖写，后面那句"比化身"的复查仍会判输（退 9），
    // 量到的是现行 CAS 的失败路径而不是旧代的成功路径——红的方向会骗人。
    const cur = fs.readFileSync(lock, "utf8").replace(/\r\n/g, "\n");
    const ops = [
      ["    const m = markerOf(p, cur.at);\n    const wrote = createMarker(m, cur.at, t.value);   // EEXIST 也算握过：同化身已有标记\n    const now = readLock(p);",
       "    fs.writeFileSync(p, JSON.stringify({ who, at: Date.now(), ttl: t.value }));   // --revertcas：裸覆盖写\n    const m = markerOf(p, cur.at);\n    const wrote = false;\n    const now = readLock(p);"],
      ["    if (now.who === who && now.at === cur.at) {",
       "    if (now.who === who) {   // --revertcas：旧代没有化身复查"],
    ];
    let patched = cur;
    for (const [from, to] of ops) {
      if (!patched.includes(from)) {
        console.error(`!! --revertcas 锚点没命中：${from.slice(0, 46)}…`);
        console.error("   停下，不出数字：锚点失配的对照跑出来会被读成\"旧代也没双主\"。");
        process.exit(EXIT_CODES.badUsage);
      }
      patched = patched.replace(from, to);
    }
    fs.writeFileSync(lock, patched);
    const back = fs.readFileSync(lock, "utf8");
    if (!back.includes("--revertcas：裸覆盖写") || !back.includes("--revertcas：旧代没有化身复查")) {
      console.error("!! 回读看不到 --revertcas 的两处改动，停下。"); process.exit(EXIT_CODES.badUsage);
    }
    GEN += " / --revertcas：续期改回裸覆盖写";
  }
  if (TRACE) {
    // 一次性诊断开关：把"谁在什么时候动了哪个文件"整条打出来。
    // 留着它是因为这条路径只有并发时才走到，不打点就只能靠猜——我已经猜错过两次。
    const cur = fs.readFileSync(lock, "utf8").replace(/\r\n/g, "\n");
    const ops = [
      // rename 刚成功那一刻就查一次：区分"根本没搬成"与"搬成之后被人删了"
      ["  return tmp;\n}\n\n// 搬错了人必须原样放回",
        "  trace(`MOVED rename后 tmp=${path.basename(tmp)} 存在=${fs.existsSync(tmp)} 目录内容=[${(() => { try { return fs.readdirSync(path.dirname(tmp)).join(\",\"); } catch (e) { return \"读目录失败:\" + e.code; } })()}]`);\n  return tmp;\n}\n\n// 搬错了人必须原样放回"],
      ["function arbiterPutBack(tmp, p) {\n  try {\n    fs.linkSync(tmp, p);",
        "function arbiterPutBack(tmp, p) {\n  trace(`PUTBACK前 tmp=${path.basename(tmp)} 存在=${fs.existsSync(tmp)} p存在=${fs.existsSync(p)}`);\n  try {\n    fs.linkSync(tmp, p);"],
      ["function arbiterSweep(tmp) {\n  try { fs.unlinkSync(tmp); }",
        "function arbiterSweep(tmp) {\n  trace(`SWEEP 删 tmp=${path.basename(tmp)} 存在=${fs.existsSync(tmp)}`);\n  try { fs.unlinkSync(tmp); }"],
      ["  fs.mkdirSync(claimsDir, { recursive: true });",
        "  trace(`ACQUIRE who=${who}`);\n  fs.mkdirSync(claimsDir, { recursive: true });"],
      ["  fs.unlinkSync(p);\n  return { status: \"released\"",
        "  trace(`RELEASE 删 p=${path.basename(p)}`);\n  fs.unlinkSync(p);\n  return { status: \"released\""],
    ];
    let patched = "const trace = (m) => process.stderr.write(`[T ${process.pid}] ${m}\\n`);\n" + cur;
    for (const [from, to] of ops) {
      const f = from.split("\n").join("\n");
      if (!patched.includes(f)) { console.error(`!! TRACE 锚点没命中：${from.slice(0, 40)}…`); process.exit(EXIT_CODES.badUsage); }
      patched = patched.replace(f, to);
    }
    fs.writeFileSync(lock, patched);
  }
} else {
  CLI = path.join(ROOT, "src", "cli.js");
  const a = anchorFor(fs.readFileSync(path.join(ROOT, "src", "claims", "lock.js"), "utf8"));
  GEN = `工作区当前实现 / ${a ? a.gen : "锚点未知"}`;
}

function claim(dir, who, ttl) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, "claim", `--channel=${dir}`, `--file=${FILE}`, `--who=${who}`, `--ttl=${ttl}`],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res({ who, code, out }));
  });
}

function claimLater(dir, who, ttl, delayMs) {
  if (!delayMs) return claim(dir, who, ttl);
  return new Promise((res) => {
    setTimeout(() => claim(dir, who, ttl).then(res), delayMs);
  });
}

// 两拨进程**同时**起跑时，抢占方永远抢不到：边界还没到，续期方就把 TTL 推后了。
// 缺陷的时序是三段式的（A 读到"还是我的"→ B 合法抢占 → A 覆盖写），
// 所以这里把 B 的起跑安排到过期之后，把 A 的落笔用 --inject 推到 B 建完锁之后。
// 说清楚：这是**排出来的**交错，不是撞出来的。它证明的是"可达"，不是"常见"。
const STEAL_DELAY = parseInt(flag("stealdelay") ?? "", 10) || (LEAD + 30);

console.log(`  被测实现：${GEN}｜轮数 ${ROUNDS}｜LEAD ${LEAD}ms｜续期方 ${N_RENEW} 家即刻起跑 / 抢占方 ${N_STEAL} 家延后 ${STEAL_DELAY}ms 起跑` +
  `${Number.isInteger(INJECT) && INJECT > 0 ? `｜注入 ${INJECT}ms` : "｜未注入"}`);

const rows = [];
for (let r = 1; r <= ROUNDS; r++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-renew-"));
  const claims = path.join(dir, "claims");
  fs.mkdirSync(claims, { recursive: true });
  const lockFile = path.join(claims, LOCK_NAME);
  // ttl=1s，此刻已走过 (1000-LEAD) ms —— 再过 LEAD 毫秒正好过期
  fs.writeFileSync(lockFile, JSON.stringify({ who: HOLDER, at: Date.now() - 1000 + LEAD, ttl: 1 }));

  const res = await Promise.all([
    ...Array.from({ length: N_RENEW }, () => claim(dir, HOLDER, 60)),
    ...Array.from({ length: N_STEAL }, (_, i) => claimLater(dir, `stealer-${i}`, 60, STEAL_DELAY)),
  ]);
  const zero = res.filter((x) => x.code === 0);
  const names = [...new Set(zero.map((x) => x.who))];
  const renewOk = res.filter((x) => /✓ 续期/.test(x.out)).length;
  const renewRefused = res.filter((x) => /续期(被拒|失败)/.test(x.out)).length;
  // 上面这个正则本来只写"续期被拒"，而 CLI 的原文是"续期失败"——12 家明明被 CAS 拒了，
  // 计数却是 0，探针差点把一次成功的证伪报成"判据没执行到"。计数串必须照抄 CLI 原文。
  const crashed = res.filter((x) => x.code === 1);
  // 续期分支到底有没有被走到，必须单独数出来。
  // 上一版就是栽在这上面：LEAD 比 40 个进程的冷启动还短，持有者自己读到的是"已过期"，
  // 于是全部走抢占分支，注入的忙等一次也没执行——"0 轮双主"是空跑出来的绿灯。
  let final = "(读不到)";
  try { final = JSON.parse(fs.readFileSync(lockFile, "utf8")).who; } catch { }
  rows.push({ round: r, exit0: zero.length, winners: names.length, names, final, renewOk, renewRefused, crashed: crashed.length });
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`  第${String(r).padStart(2)}轮：exit0=${String(zero.length).padStart(3)}/${N_RENEW + N_STEAL}  续期成功=${renewOk}  续期被拒=${renewRefused}  自称赢的名字数=${names.length}  最终锁内容=${final}  ${names.length > 1 ? `← 双主：${names.join(" + ")}` : ""}${crashed.length ? `  ⚠ 崩溃 ${crashed.length} 家` : ""}\n`);
  if (crashed.length) {
    // 崩溃进程自己的打点看不出"谁删的"——把**所有**进程的 trace 行按到达顺序倒出来。
    // 只打一个进程的日志，等于把案发现场只留一把嫌疑人的口供。
    const all = res.flatMap((x) => String(x.out).split("\n").filter((l) => l.startsWith("[T ")).map((l) => `${x.who} exit=${x.code} ${l}`));
    console.log("     全部 trace 行（按进程聚合后到达顺序）：");
    for (const l of all) console.log("       " + l.slice(0, 150));
    console.log("     崩溃进程原文：\n" + crashed[0].out.split("\n").slice(0, 10).map((l) => "       " + l).join("\n"));
  }
  if (DEBUG) {
    // 不先看这份分布，"0 轮双主"会被误读成"续期安全"——它也可能只是抢占方一家都没赢，
    // 那这条判据根本没被执行到。
    const byCode = {};
    for (const x of res) byCode[x.code] = (byCode[x.code] || 0) + 1;
    const stealWin = res.filter((x) => x.who.startsWith("stealer") && x.code === 0).map((x) => x.who);
    console.log(`     退出码分布 ${JSON.stringify(byCode)}｜抢占方赢的是 ${stealWin.join(",") || "（无）"}`);
    const s = res.find((x) => x.who.startsWith("stealer"));
    console.log(`     抢占方原话 exit=${s?.code}：${String(s?.out).trim().replace(/\r?\n/g, " ⏎ ").slice(0, 160)}`);
    const o = res.find((x) => x.who === HOLDER && x.code !== 0);
    if (o) console.log(`     续期方非零原话 exit=${o.code}：${String(o.out).trim().replace(/\r?\n/g, " ⏎ ").slice(0, 160)}`);
  }
}

if (tmpCopy) fs.rmSync(tmpCopy, { recursive: true, force: true });

const bad = rows.filter((x) => x.winners > 1);
const stealersWon = rows.some((x) => x.names.some((n) => n.startsWith("stealer-")));
console.log(`\n${LABEL ? `【${LABEL}】` : ""}判据：exit 0 的进程自称的持有者名字只能有 1 个，出现 2 个即为双主。`);
console.log(`  ${ROUNDS} 轮里双主轮数：${bad.length}/${ROUNDS}` +
  (bad.length ? `（${bad.map((b) => b.names.join("+")).join(" | ")}）` : ""));
console.log(`  每轮自称赢的进程数：[${rows.map((x) => x.exit0).join(", ")}]`);
console.log(`  逐轮续期成功/被拒：[${rows.map((x) => `${x.renewOk}/${x.renewRefused}`).join(", ")}]`);
const renewOkAll = rows.reduce((s, x) => s + x.renewOk, 0);
const renewRefusedAll = rows.reduce((s, x) => s + x.renewRefused, 0);
// 前置条件：续期分支要真的被走到（成功或被拒都算走到），且抢占方要赢过一轮。
// 任一不满足，"0 轮双主"只是判据空跑，不能当证据。
if (renewOkAll + renewRefusedAll === 0) {
  console.log(`  ✗ 续期分支一次都没被走到（LEAD ${LEAD}ms 比 40 个进程的冷启动还短，持有者读到的是"已过期"）。`);
  console.log(`    这份数字不作数——把 LEAD 调到大于进程启动时间再跑。`);
  printSummary({ kind: "renew-race", rounds: ROUNDS, measured: rows.length, lost: bad.length,
    precondition: 1, inject: Number.isInteger(INJECT) ? INJECT : 0, code: EXIT_CODES.precondition,
    codes: [...new Set(Object.values(EXIT_CODES))] });
  process.exit(EXIT_CODES.precondition);
}
if (!stealersWon) {
  console.log(`  ✗ 抢占方一家都没赢，双主判据没被执行到。加大 --inject 或 LEAD 再跑。`);
  printSummary({ kind: "renew-race", rounds: ROUNDS, measured: rows.length, lost: bad.length,
    precondition: 1, inject: Number.isInteger(INJECT) ? INJECT : 0, code: EXIT_CODES.precondition,
    codes: [...new Set(Object.values(EXIT_CODES))] });
  process.exit(EXIT_CODES.precondition);
}
console.log(`  前置条件满足：续期成功 ${renewOkAll} 次 / 续期被拒 ${renewRefusedAll} 次，且抢占方至少赢过一轮`);

// 机读汇总 + 三向印证（详见 tools/claims/summary.mjs 的注释）：
// 退码必须由**对外报出的那个数**推出，并且那个数要等于现场重算的值。
// 退码由现场重算的 raw 推；对外报的数从打印出去的那份对象里读回来（详见 board-race 同段注释）
const raw = rows.filter((x) => x.winners > 1).length;
const code = raw > 0 ? EXIT_CODES.doubleOwner : EXIT_CODES.singleWinner;
const summary = {
  kind: "renew-race", rounds: ROUNDS, measured: rows.length, lost: bad.length,
  renewOk: renewOkAll, renewRefused: renewRefusedAll, precondition: 0,
  inject: Number.isInteger(INJECT) ? INJECT : 0, revertcas: REVERTCAS ? 1 : 0,
  code, codes: [...new Set(Object.values(EXIT_CODES))],
};
printSummary(summary);
const why = crossCheck(code, { reported: summary.lost, raw, expect: ROUNDS, measured: summary.measured, badIsSuccess: true });
if (why) {
  console.error(`\n!! 测具不可信：${why}\n   这份"几轮双主"不进 README。`);
  process.exit(EXIT_CODES.harness);
}
process.exit(code);

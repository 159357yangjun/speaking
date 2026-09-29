#!/usr/bin/env node
// 协作机制推演器：证明"markdown 表 read-modify-write"接不住并发，
// 而"独占锁 + 强制 TTL + 领取才写板"能接住。
//
//   node tools/relay-sim/sim.js <空的工作目录>          人读输出
//   node tools/relay-sim/sim.js <空的工作目录> --json   末尾追加一行机器可读结果
//
// 不联网、不装依赖、不碰真实频道目录。工作目录必须为空或由本脚本独占。
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

const SELF = import.meta.filename;
const ROOT = process.argv[2];
const AS_JSON = process.argv.includes("--json");
const BOARD = path.join(ROOT, "board.md");
const CLAIMS = path.join(ROOT, "claims");
const OUT = path.join(ROOT, "out");
const EMPTY_BOARD = "# 进度板\n\n## 正在改\n\n| 文件 | 谁 | 声明时间 |\n|---|---|---|\n\n## 已提交\n";
const FILE = "src/cli.js";

const log = (...a) => console.log(...a);
const head = (t) => log("\n" + "=".repeat(64) + "\n" + t + "\n" + "=".repeat(64));
const sleepMs = (ms) =>
  spawnSync(process.execPath, ["-e", `const t=Date.now();while(Date.now()-t<${ms}){}`]);

function mark(who, verdict) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${who}.txt`), verdict);
}
function verdicts() {
  if (!fs.existsSync(OUT)) return { claimed: 0, blocked: 0, refused: 0 };
  const v = fs.readdirSync(OUT).map((f) => fs.readFileSync(path.join(OUT, f), "utf8").trim());
  return {
    claimed: v.filter((x) => x === "claimed").length,
    blocked: v.filter((x) => x === "blocked").length,
    refused: v.filter((x) => x === "refused").length,
  };
}
// 句柄允许连字符（协议里是 ^[a-z0-9-]{1,32}$），所以这里不能用 \w+
function boardRows() {
  return [...fs.readFileSync(BOARD, "utf8").matchAll(/\|\s*([\w./-]+)\s*\|\s*([a-z0-9-]+)\s*\|\s*now/g)]
    .map((m) => `${m[1]}←${m[2]}`);
}
function lockCount() {
  return fs.existsSync(CLAIMS) ? fs.readdirSync(CLAIMS).length : 0;
}
function resetRun() {
  fs.writeFileSync(BOARD, EMPTY_BOARD);
  fs.rmSync(CLAIMS, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
}
function lockPath(f) {
  return path.join(CLAIMS, f.replace(/[^\w]/g, "_") + ".lock");
}

// ============================ 子进程模式 ============================
const CHILD_MODES = ["--rmw", "--claimrmw", "--commit"];
const mode = CHILD_MODES.includes(process.argv[3]) ? process.argv[3] : null;

// 旧机制：读整块 → 判断 → 写回整块。无原子性。
if (mode === "--rmw") {
  const who = process.argv[4];
  const b = fs.readFileSync(BOARD, "utf8");
  const hit = new RegExp("\\|\\s*" + FILE + "\\s*\\|\\s*([a-z0-9-]+)").exec(b);
  if (hit && hit[1] !== who) {
    log(`  CHILD ${who}: 看到 ${FILE} 已被 ${hit[1]} 占用，放弃`);
    mark(who, "blocked");
    process.exit(3);
  }
  // 这个间隔就是两个 AI 各自"读完还没写完"之间那段真实窗口
  sleepMs(300);
  const rows = b.split("\n");
  rows.splice(rows.findIndex((r) => r.startsWith("|---")) + 1, 0, `| ${FILE} | ${who} | now |`);
  fs.writeFileSync(BOARD, rows.join("\n"));
  log(`  CHILD ${who}: 已把 ${FILE} 写进板上（自称成功）`);
  mark(who, "claimed");
  process.exit(0);
}

// 新机制：独占创建锁 → 拿到锁才写板。TTL 必须为正整数。
if (mode === "--claimrmw") {
  const who = process.argv[4];
  const ttl = parseInt(process.argv[5], 10);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    log(`  CHILD ${who}: 拒绝领取 —— TTL 必须是正整数（收到 "${process.argv[5]}"）。无过期时间的锁不允许存在。`);
    mark(who, "refused");
    process.exit(6);
  }
  fs.mkdirSync(CLAIMS, { recursive: true });
  const lock = lockPath(FILE);
  const claim = () => {
    fs.writeFileSync(lock, JSON.stringify({ who, at: Date.now(), ttl }));
    const b = fs.readFileSync(BOARD, "utf8");
    const rows = b.split("\n");
    rows.splice(rows.findIndex((r) => r.startsWith("|---")) + 1, 0, `| ${FILE} | ${who} | now |`);
    fs.writeFileSync(BOARD, rows.join("\n"));
    mark(who, "claimed");
  };
  try {
    fs.writeFileSync(lock, "", { flag: "wx" }); // 已存在即 EEXIST
    claim();
    log(`  CHILD ${who}: 领取 ${FILE} 成功（TTL=${ttl}s），已写板`);
    process.exit(0);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const cur = JSON.parse(fs.readFileSync(lock, "utf8") || "{}");
    const ageS = (Date.now() - (cur.at || 0)) / 1000;
    if (cur.ttl && ageS > cur.ttl) {
      claim();
      log(`  CHILD ${who}: 持有者 ${cur.who} 已超时 ${ageS.toFixed(1)}s > ${cur.ttl}s → 抢占并写板`);
      process.exit(0);
    }
    log(`  CHILD ${who}: ${FILE} 被 ${cur.who} 持有（${ageS.toFixed(1)}s 前，TTL=${cur.ttl}s）→ 未写板`);
    mark(who, "blocked");
    process.exit(3);
  }
}

// 提交：持有者必须等于提交者。
if (mode === "--commit") {
  const who = process.argv[4];
  const lock = lockPath(FILE);
  if (!fs.existsSync(lock)) {
    log(`  CHILD ${who}: ${FILE} 无锁可提交`);
    process.exit(4);
  }
  const cur = JSON.parse(fs.readFileSync(lock, "utf8"));
  if (cur.who !== who) {
    log(`  CHILD ${who}: 当前持有者是 ${cur.who}，不是提交者 → 拒绝`);
    process.exit(5);
  }
  fs.unlinkSync(lock);
  fs.writeFileSync(BOARD, fs.readFileSync(BOARD, "utf8") + `| ${FILE} | ${who} | committed |\n`);
  log(`  CHILD ${who}: 提交 ${FILE}，锁已释放`);
  process.exit(0);
}

// ============================ 父进程编排 ============================
const child = (args) => spawnSync(process.execPath, [SELF, ROOT, ...args], { encoding: "utf8" });
// 真并发：全部 spawn 出去，再用一个等待子进程同步轮询 pid。
// 不能用 spawnSync —— 那是顺序执行，演示不出竞态。
function runConcurrent(specs) {
  const pids = specs.map((s) => spawn(process.execPath, [SELF, ROOT, ...s], { stdio: "inherit" }).pid);
  spawnSync(process.execPath, ["-e",
    `const pids=${JSON.stringify(pids)};` +
    `const alive=p=>{try{process.kill(p,0);return true}catch(e){return false}};` +
    `const t=Date.now();while(pids.some(alive)&&Date.now()-t<60000){}`]);
}

if (mode) process.exit(2); // 未知子模式

fs.mkdirSync(ROOT, { recursive: true });
const R = {};

head("S1 · 正常串行（A 干完收工，B 再开工）");
resetRun();
child(["--rmw", "alice"]);
fs.writeFileSync(BOARD, fs.readFileSync(BOARD, "utf8").replace(new RegExp(`\\| ${FILE} \\| alice \\| now \\|\\n`), ""));
log("  A 收工，划掉自己的声明行");
child(["--rmw", "bob"]);
R.s1 = { rows: boardRows().length, ok: boardRows().length === 1 && boardRows()[0].endsWith("bob") };
log(`  板上占用行：${boardRows().join(" , ")} → 串行场景两种机制都成立`);

head("S2 · 并发抢同一文件：谎报成功数 = 自称领到人数 − 实际持有者数");
let lieOld = 0;
for (let i = 1; i <= 5; i++) {
  resetRun();
  runConcurrent([["--rmw", "alice"], ["--rmw", "bob"]]);
  const v = verdicts(), rows = boardRows().length, lie = v.claimed - rows;
  if (lie > 0) lieOld++;
  log(`  旧机制 第${i}轮：自称领取 ${v.claimed}，板上 ${rows} 行 → 谎报 ${lie}${lie ? "  ← 有人以为锁是自己的" : ""}`);
}
let lieNew = 0, cleanNew = 0;
log("");
for (let i = 1; i <= 5; i++) {
  resetRun();
  runConcurrent([["--claimrmw", "alice", "5"], ["--claimrmw", "bob", "5"]]);
  const v = verdicts(), locks = lockCount(), lie = v.claimed - locks;
  if (lie > 0) lieNew++;
  if (v.claimed === 1 && v.blocked === 1 && locks === 1) cleanNew++;
  log(`  新机制 第${i}轮：领取成功 ${v.claimed}，明确受阻 ${v.blocked}，锁 ${locks} 把 → 谎报 ${lie}`);
}
R.s2 = { rounds: 5, lieOld, lieNew, cleanNew };
log(`\n  旧机制 ${lieOld}/${5} 轮谎报；新机制 ${lieNew}/${5} 轮谎报，且 ${cleanNew}/5 轮恰好"1 领取 + 1 受阻"`);

head("S3 · 脏声明：领了锁就崩，不收尾");
resetRun();
log("  3a) 允许 ttl=0（旧默认）时，后来者无权回收：");
child(["--claimrmw", "alice", "0"]);
R.s3a = { refusedZeroTtl: verdicts().refused === 1 };
log("  3b) 声明 ttl=1 后崩溃，锁老化再抢：");
resetRun();
child(["--claimrmw", "alice", "1"]);
log(`  ${child(["--claimrmw", "bob", "1"]).stdout.trim()}   ← TTL 未到，正确受阻`);
sleepMs(1600);
const steal = child(["--claimrmw", "bob", "1"]);
const holder = JSON.parse(fs.readFileSync(lockPath(FILE), "utf8")).who;
log(`  ${steal.stdout.trim()}`);
R.s3b = { stolen: steal.status === 0 && holder === "bob", holder };
log(`  锁现在在 ${holder} 手上 → 脏锁被回收。代价：TTL 是猜的，慢而非崩的一方会被误伤`);

head("S4 · 抢占发生后，慢的那方（alice）回来提交");
log(`  ${child(["--commit", "alice"]).stdout.trim()}`);
const r4 = child(["--commit", "alice"]);
const committed = [...fs.readFileSync(BOARD, "utf8").matchAll(/\|\s*committed\s*\|/g)].length;
log(`  退出码 ${r4.status}（5=持有者不是提交者 → 拒绝），板上提交记录 ${committed} 条`);
R.s4 = { rejected: r4.status === 5, committedRows: committed };
log("  板子与锁都保住了。但 alice 在被拒之前已经改过 " + FILE + " —— 拒提交不等于回滚内容。");

head("汇总");
log(JSON.stringify(R, null, 2));
if (AS_JSON) console.log("RESULT_JSON " + JSON.stringify(R));

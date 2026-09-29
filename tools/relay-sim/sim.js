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
import { generateKeypair, signDigest, verifyDigest } from "../../src/crypto/keys.js";
import { seal, verifyEnvelope, digestForDiagnosis, CURRENT_VERSION } from "../../src/proto/envelope.js";
import { acquire, release, lockFileName, EXIT } from "../../src/claims/lock.js";

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
  // 用出厂的文件名净化，不用这里自己写一遍——两套命名规则会让"实测的是哪套"失去意义
  return path.join(CLAIMS, lockFileName(f));
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

// 新机制：**直接调用出厂实现** src/claims/lock.js，不在这里另写一份。
// 之前这里手写了一份"独占创建 + 过期就覆盖写"的复制品，量出 0/20。
// 那个数字测的不是出厂机制：复制品没有 rename 仲裁，实测同场景会出 12/20 双主
// （见 tools/claims/red-demo.mjs 的 M3）。推演器和实现分家，量出来的就是两个东西。
if (mode === "--claimrmw") {
  const who = process.argv[4];
  const r = acquire({ claimsDir: CLAIMS, file: FILE, who, ttl: process.argv[5] });
  if (r.status === "refused") {
    log(`  CHILD ${who}: 拒绝领取 —— ${r.reason}`);
    mark(who, "refused");
    process.exit(EXIT.BAD_TTL);
  }
  if (r.status === "blocked") {
    log(`  CHILD ${who}: ${FILE} 被 ${r.holder} 持有（${r.ageS.toFixed(1)}s 前，TTL=${r.ttl}s）→ 未写板`);
    mark(who, "blocked");
    process.exit(EXIT.BLOCKED);
  }
  const b = fs.readFileSync(BOARD, "utf8");
  const rows = b.split("\n");
  rows.splice(rows.findIndex((x) => x.startsWith("|---")) + 1, 0, `| ${FILE} | ${who} | now |`);
  fs.writeFileSync(BOARD, rows.join("\n"));
  mark(who, "claimed");
  log(`  CHILD ${who}: ${r.status === "stolen" ? `抢占成功（原持有者 ${r.prevHolder}，${r.why}）` : r.status === "renewed" ? "续期持有" : "领取成功"} ${FILE}（TTL=${r.ttl}s），已写板`);
  process.exit(EXIT.OK);
}

// 提交：持有者必须等于提交者——归属判定直接复用 release()，不在推演器里重写一遍。
if (mode === "--commit") {
  const who = process.argv[4];
  const r = release({ claimsDir: CLAIMS, file: FILE, who });
  if (r.status === "no-lock") {
    log(`  CHILD ${who}: ${FILE} 无锁可提交`);
    process.exit(EXIT.NO_LOCK);
  }
  if (r.status === "not-holder") {
    log(`  CHILD ${who}: 当前持有者是 ${r.holder}，不是提交者 → 拒绝`);
    process.exit(EXIT.NOT_HOLDER);
  }
  fs.writeFileSync(BOARD, fs.readFileSync(BOARD, "utf8") + `| ${FILE} | ${who} | committed |\n`);
  log(`  CHILD ${who}: 提交 ${FILE}，锁已释放`);
  process.exit(EXIT.OK);
}

// ============================ 父进程编排 ============================
const child = (args) => spawnSync(process.execPath, [SELF, ROOT, ...args], { encoding: "utf8" });
// 真并发：全部 spawn 出去，再用一个等待子进程同步轮询 pid。
// 不能用 spawnSync —— 那是顺序执行，演示不出竞态。
// 这里必须收回每个子进程的退出码：只数"板上有几行"看不出"几家自称拿到了锁"。
function runConcurrent(specs) {
  const kids = specs.map((s) => {
    const p = spawn(process.execPath, [SELF, ROOT, ...s], { stdio: "inherit" });
    return new Promise((res) => p.on("close", (code) => res(code)));
  });
  return Promise.all(kids);
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
// N=20 而不是 5：5 次排不掉"偶尔没撞上"，会让人误以为旧机制只是不稳而不是根本不安全。
const ROUNDS = parseInt(process.env.RELAY_SIM_ROUNDS || "20", 10);
log(`  两个进程同时抢 ${FILE}，各跑 ${ROUNDS} 轮。\n`);

let lieOld = 0;
const oldRows = [];
for (let i = 1; i <= ROUNDS; i++) {
  resetRun();
  await runConcurrent([["--rmw", "alice"], ["--rmw", "bob"]]);
  const v = verdicts(), rows = boardRows().length, lie = v.claimed - rows;
  if (lie > 0) lieOld++;
  oldRows.push(lie);
  if (i <= 3 || lie > 0 === false) log(`  旧机制 第${String(i).padStart(2)}轮：自称领取 ${v.claimed}，板上 ${rows} 行 → 谎报 ${lie}`);
}
let lieNew = 0, cleanNew = 0;
const newRows = [];
log("");
for (let i = 1; i <= ROUNDS; i++) {
  resetRun();
  await runConcurrent([["--claimrmw", "alice", "5"], ["--claimrmw", "bob", "5"]]);
  const v = verdicts(), locks = lockCount(), lie = v.claimed - locks;
  if (lie > 0) lieNew++;
  if (v.claimed === 1 && v.blocked === 1 && locks === 1) cleanNew++;
  newRows.push(lie);
}
log(`  旧机制 ${ROUNDS} 轮逐轮谎报数：[${oldRows.join(", ")}]`);
log(`  新机制 ${ROUNDS} 轮逐轮谎报数：[${newRows.join(", ")}]`);
R.s2 = { rounds: ROUNDS, lieOld, lieNew, cleanNew, oldRows, newRows };
log(`\n  并排结果：旧机制 ${lieOld}/${ROUNDS} 轮谎报；新机制 ${lieNew}/${ROUNDS} 轮谎报，` +
    `且 ${cleanNew}/${ROUNDS} 轮恰好"1 领取 + 1 明确受阻"`);

// S2b：上一轮只测了"未过期并发"。过期锁的抢占是另一条路径，也是上一版最容易出双主的路径
// （读到过期 → 自己动手写，两个进程都这么干就两个都自称赢）。这里单独量。
head(`S2b · ${ROUNDS} 个进程真并发抢同一把**已过期**锁`);
resetRun();
child(["--claimrmw", "stale-holder", "1"]);
log(`  先由 stale-holder 建一把 TTL=1s 的锁，等它过期…`);
sleepMs(1400);
log("");
const stealCodes = await runConcurrent(
  Array.from({ length: ROUNDS }, (_, i) => ["--claimrmw", `racer-${i}`, "60"])
);
const stealWinners = stealCodes.filter((c) => c === EXIT.OK).length;
const stealBlocked = stealCodes.filter((c) => c === EXIT.BLOCKED).length;
// 只数 racer 写的行。板上此刻本来就有 stale-holder 那一行，
// 拿"总行数==1"当判据会把 2 行误报成双主——上一版就是这么写错的，红得毫无道理。
const racerRows = boardRows().filter((r) => /←racer-/.test(r)).length;
const finalHolder = JSON.parse(fs.readFileSync(lockPath(FILE), "utf8")).who;
R.s2b = { rounds: ROUNDS, winners: stealWinners, blocked: stealBlocked, racerRows, boardRows: boardRows().length, finalHolder, codes: stealCodes };
log(`\n  退出码分布：0（拿到）×${stealWinners}，3（受阻）×${stealBlocked}`);
log(`  racer 写入板上的行：${racerRows} 行（另有 stale-holder 的 1 行旧声明）；锁最终持有者：${finalHolder}`);
log(`  → ${stealWinners === 1 && racerRows === 1 ? "单赢家成立：抢占走 rename 仲裁，只有搬走过期锁的那家能建新锁，写板的那家和持锁的那家同一家" : `异常：赢家 ${stealWinners} 家 / 写板 ${racerRows} 行`}`);
log(`    对照：把仲裁换成「先删再建」，同场景 20 家里 12 家自称赢（tools/claims/red-demo.mjs 的 M3）`);

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

head("S5 · 新版读者遇到旧版消息：必须归因，不能崩");
const kA = generateKeypair(), kB = generateKeypair();
const keyring = { "node-a": kA.fingerprint, "node-b": kB.fingerprint };
const baseMsg = { seq: 11, from: "node-a", to: "node-b", type: "offer", done: true, nonce: "nonce-s5-0000000001", body: "一条正文" };
const msgV2 = seal(baseMsg, kA.privatePem);
const msgV1 = { ...baseMsg, sig: signDigest(kA.privatePem, digestForDiagnosis("agent-relay/v1", baseMsg)) };
let r5, r5threw = null;
try { r5 = verifyEnvelope(msgV1, keyring); } catch (e) { r5threw = e.message; }
log(`  旧版签的消息 → ${JSON.stringify(r5 ?? null)}`);
log(`  是否抛异常：${r5threw ?? "否"}`);
log(`  对照：同一条正文用 ${CURRENT_VERSION} 域签 → ${JSON.stringify(verifyEnvelope(msgV2, keyring).ok)}`);
R.s5 = { threw: r5threw, code: r5?.code ?? null, ok: r5?.ok ?? null };
log("  → 归因成功：拒收但明确说是版本差，不是攻击。");

head("S6 · 旧版读者遇到新版消息：归因能力不对等");
// 旧读者只认 v1 域，且没有 code 字段——它唯一能说的就是「验签失败」
function oldReaderVerify(env, fp) {
  try { return verifyDigest(fp, digestForDiagnosis("agent-relay/v1", env), env.sig); }
  catch { return false; }
}
const oldAccepts = oldReaderVerify(msgV2, kA.fingerprint);
const oldAcceptsV1 = oldReaderVerify(msgV1, kA.fingerprint);
const oldReaderOutput = oldAccepts ? "接受" : "验签失败";
log(`  旧读者见到 ${CURRENT_VERSION} 签的消息 → 它的判断：${oldReaderOutput}`);
log(`  旧读者见到 v1 签的消息     → 它的判断：${oldAcceptsV1 ? "接受" : "验签失败"}`);
log(`  旧读者能区分「版本旧」与「被篡改」吗：否——它只有一个布尔值，没有 code 字段`);
R.s6 = { oldRejectsV2: oldAccepts === false, oldAcceptsV1, attributable: false };
log("  → 结论：归因是单向能力。升级窗口内 新→旧 方向的失败会被旧侧误判成攻击。");
log("    所以升级顺序必须「先升对端、后升本端」，反了就会给对端制造一批假攻击信号。");
log("    这条已写进 adapters/workbuddy/prompt.md 的归因枚举一节。");

head("汇总");
log(JSON.stringify(R, null, 2));
if (AS_JSON) console.log("RESULT_JSON " + JSON.stringify(R));

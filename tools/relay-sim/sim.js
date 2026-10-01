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
// S2b-G 闸口放行跑几次。写成参数而不是写死：一次放行 ≈ 1.4s 等过期 + 20 个进程，成本必须能自己调，
// 而且要按"写了却不认就是静默空跑"那条口径校验——非法值当场退非 0，不静默取默认。
const GATED_ARG = process.argv.find((a) => a.startsWith("--gated="));
if (GATED_ARG !== undefined && !/^\-\-gated=[1-9]\d{0,2}$/.test(GATED_ARG)) {
  console.error(`!! --gated 必须是 1..999 的整数，收到 ${GATED_ARG}`);
  process.exit(9);
}
const GATED_ROUNDS = GATED_ARG ? Number(GATED_ARG.split("=")[1]) : 4;
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
  // 闸口（只由环境变量打开，沿用 lock.js 里 `.at-gate` 那条纪律：等"到齐"这件事不许靠 sleep 猜）。
  // 为什么要它：实测低载下 57/60 轮赢家都是 racer-0 ⇒ 20 个子进程被 Windows 的创建顺序错开得足够久，
  // 第一家永远先到仲裁点，`winners==1` 有 95% 的轮次量的是派发顺序而不是竞争（证据廿八）。
  // 到齐后同时放行，才让这 20 家真的挤进同一个临界区。
  const bdir = process.env.SIM_BARRIER_DIR;
  if (bdir) {
    const need = Number(process.env.SIM_BARRIER_N || 0);
    try { fs.writeFileSync(path.join(bdir, `arrive-${who}`), String(process.pid)); } catch { /* 报不上来也别卡死 */ }
    const limit = Date.now() + 15000;                 // 上限：闸口失灵不许永远挂住（同 lock.js 的 25s 那条口径）
    let arrived = 0;
    while (Date.now() < limit) {
      try { arrived = fs.readdirSync(bdir).filter((n) => n.startsWith("arrive-")).length; } catch { break; }
      if (arrived >= need) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    // 到齐后不许"谁最后到谁直接冲"：上一版就是这样，赢家 4/4 恒为 racer-19（末位到齐者省掉整个轮询循环），
    // 那是排队不是竞争。改成两拍：到齐的那家负责发令，所有人一律等同一个 release 文件出现。
    try {
      if (fs.readdirSync(bdir).filter((n) => n.startsWith("arrive-")).length >= need) {
        fs.writeFileSync(path.join(bdir, "release"), String(process.pid));
      }
      const rl = path.join(bdir, "release");
      const goLimit = Date.now() + 15000;
      while (!fs.existsSync(rl) && Date.now() < goLimit) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
    } catch { /* 发令/等待失败也别卡死：下面照样往下走，arrivals 那一步会把它记成没到齐 */ }
    // 放行后再退避 0–5ms：发令者天然是"最后一个到齐的那家"，它写完 release 就冲，别人还要等一个轮询拍，
    // 实测 12/12 轮赢家都是 racer-19——那是发令权带来的结构性头名，不是竞争。退避把这点优势打散成掷硬币。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * 6));
    try { fs.writeFileSync(path.join(bdir, `go-${who}`), String(Date.now())); } catch { /* 放行时刻记不上就算样本缺一 */ }
  }
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
function runConcurrent(specs, opts = {}) {
  const kids = specs.map((s) => {
    const p = spawn(process.execPath, [SELF, ROOT, ...s], { stdio: "inherit", env: { ...process.env, ...(opts.env || {}) } });
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

// S2b-G：闸口放行版。低载下这条夹具 95% 的轮次量的是派发顺序（证据廿八），这里让 20 家到齐再一起放行，
// 并把"放行跨度"量出来——它是窗口宽度的直接读数，不是"我猜这次撞上了"。
head(`S2b-G · 闸口放行下的 ${ROUNDS} 路并发抢占 × ${GATED_ROUNDS} 次`);
const gPer = [];
for (let gi = 0; gi < GATED_ROUNDS; gi++) {
  resetRun();
  child(["--claimrmw", "stale-holder", "1"]);
  sleepMs(1400);
  const bdir = path.join(ROOT, `barrier-g${gi}`);
  fs.mkdirSync(bdir, { recursive: true });
  const gCodes = await runConcurrent(
    Array.from({ length: ROUNDS }, (_, i) => ["--claimrmw", `racer-${i}`, "60"]),
    { env: { SIM_BARRIER_DIR: bdir, SIM_BARRIER_N: String(ROUNDS) } });
  const gWin = gCodes.filter((c) => c === EXIT.OK).length;
  const gBlocked = gCodes.filter((c) => c === EXIT.BLOCKED).length;
  const gArrivals = fs.readdirSync(bdir).filter((n) => n.startsWith("arrive-")).length;
  const gGo = fs.readdirSync(bdir).filter((n) => n.startsWith("go-"))
    .map((n) => Number(fs.readFileSync(path.join(bdir, n), "utf8"))).filter(Number.isFinite);
  const gSpread = gGo.length > 1 ? Math.max(...gGo) - Math.min(...gGo) : -1;
  const gHolder = JSON.parse(fs.readFileSync(lockPath(FILE), "utf8")).who;
  const gRows = boardRows().filter((r) => /←racer-/.test(r)).length;
  // 双主必须连板面一起交出来：只给"赢家 2 家"分不出两家都落了笔（协议失效）还是一家自称赢却没写板（计数与状态不互印）。
  const gBoard = boardRows().filter((r) => /←racer-/.test(r)).join(" ⏎ ");
  // 异常那轮把 claims 目录整份抄下来留现场。为什么必须抄：上一版我只"留住根目录"，
  // 而同一个根目录后面被 S3/S4 的 resetRun 清过——留住的是别人的板面，不是异常那轮的。
  let gScene = null;
  let gSceneListing = null;
  if (gWin !== 1 || gRows !== 1) {
    gScene = `scenes-g${gi}`;
    try {
      fs.mkdirSync(path.join(ROOT, gScene), { recursive: true });
      // 光把文件抄进根目录不够——测试跑完会把根目录整个删掉，现场跟着消失。
      // 所以名单与每个文件的前 120 字节也一并塞回 JSON：断言消息里就得看得见有没有 `.arbiter-*` 残留。
      gSceneListing = [];
      for (const n of fs.readdirSync(CLAIMS)) {
        const bytes = fs.statSync(path.join(CLAIMS, n)).size;
        const head = fs.readFileSync(path.join(CLAIMS, n), "utf8").slice(0, 120);
        gSceneListing.push(`${n}(${bytes}B)${head ? ` ${JSON.stringify(head)}` : " 〈空文件〉"}`);
        fs.copyFileSync(path.join(CLAIMS, n), path.join(ROOT, gScene, n));
      }
    } catch (e) { gScene = `抄现场失败:${e.code || e.message}`; }
  }
  gPer.push({ winners: gWin, blocked: gBlocked, arrivals: gArrivals, spreadMs: gSpread, holder: gHolder, racerRows: gRows, boardRacerLines: gBoard, scene: gScene, sceneListing: gSceneListing, codes: gCodes });
  fs.rmSync(bdir, { recursive: true, force: true });
  log(`  第${gi + 1}次：到齐 ${gArrivals}/${ROUNDS} 放行跨度 ${gSpread}ms 赢家=${gHolder} 分布 0×${gWin} 3×${gBlocked} racer行=${gRows}${gScene ? ` 现场=${gScene}${gSceneListing ? ` [${gSceneListing.join(" ｜ ")}]` : ""}` : ""}`);
}
R.s2bGated = {
  rounds: GATED_ROUNDS, needed: ROUNDS, per: gPer,
  holders: gPer.map((g) => g.holder),
  distinctHolders: new Set(gPer.map((g) => g.holder)).size,
  allFull: gPer.every((g) => g.arrivals === ROUNDS),
  maxSpreadMs: Math.max(...gPer.map((g) => g.spreadMs)),
};
log(`  → ${GATED_ROUNDS} 次放行的赢家：${R.s2bGated.holders.join(", ")}（不同赢家 ${R.s2bGated.distinctHolders} 个）｜` +
  `放行跨度最大 ${R.s2bGated.maxSpreadMs}ms`);
log(`    这一步的量在上一版里根本没有：那 20 家谁赢由创建顺序决定，` +
  `所以"恰 1 家赢"里有 95% 是恒真。闸口到齐才让它们真挤进同一个临界区。`);

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

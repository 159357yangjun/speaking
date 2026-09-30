#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadRoster, keyringOf } from "./proto/roster.js";
import { seal, verifyEnvelope, msgFileName, newNonce } from "./proto/envelope.js";
// 故意不导入 verifyHold：归属复验只发生在 writeBoard 内部（锁序声明见 src/claims/lock.js）。
// cli.js 自己拿一次复验，就多出一条"在板锁之外判断归属"的路径。
import { acquire, release, list, noteWait, writeBoard, auditBoard, EXIT } from "./claims/lock.js";
import { printSummary } from "./claims/summary.js";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = {};
for (const a of args.slice(1)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) opt[m[1]] = m[2] === undefined ? true : m[2];
}

const CH = opt.channel ?? process.env.AGENT_RELAY_CHANNEL;
if (!CH) die("缺 --channel=<目录>");

function die(msg) {
  console.error("错误：" + msg);
  process.exit(1);
}
function read(p, fb) {
  return existsSync(p) ? readFileSync(p, "utf8") : fb;
}
function roster() {
  try {
    return loadRoster(readFileSync(join(CH, "roster.json"), "utf8"));
  } catch (e) {
    die(e.message);
  }
}
// 私钥解析：只有两档，且**永不回退进频道目录**。
//
// 曾有第三档 <频道>/keys。删掉它的理由不是洁癖：私钥曾与名册同处共享频道区，
// 而该区里那份残留**改名后仍能签通现存的 qoder.pub**——只要还留一条能命中它的路径，
// "已移出共享区"这句话就是假的。fail-closed：宁可拒绝签名，也不静默用共享区里的钥匙。
function keySource() {
  if (opt["keys-dir"]) return { dir: opt["keys-dir"], via: "--keys-dir" };
  if (process.env.AGENT_RELAY_KEYS_DIR) return { dir: process.env.AGENT_RELAY_KEYS_DIR, via: "AGENT_RELAY_KEYS_DIR" };
  die("必须给 --keys-dir=<目录> 或设 AGENT_RELAY_KEYS_DIR。代码不再回退到 <频道>/keys——" +
      "那里可能留着能签通现存公钥的旧私钥。");
}
function myKey(handle) {
  const { dir, via } = keySource();
  const p = join(dir, `${handle}.pem`);
  if (!existsSync(p)) die(`找不到私钥 ${p}（来源：${via}）。私钥位置由人填写，不由 agent 生成。`);
  if (resolve(p).startsWith(resolve(CH) + sep))
    die(`拒绝使用频道目录内的私钥 ${p}。它来自共享区，即使被显式指认也不用。`);
  process.stderr.write(`[密钥来源] ${via} → ${p}\n`);
  return readFileSync(p, "utf8");
}
function lastSeen(me) {
  return parseInt(read(join(CH, "agents", me, ".last_seen"), "0"), 10) || 0;
}
function seenNonces(me) {
  const p = join(CH, "agents", me, ".seen-nonce");
  return new Set(existsSync(p) ? read(p, "").split("\n").filter(Boolean) : []);
}
function allMessages() {
  const out = [];
  for (const dir of readdirSync(join(CH, "agents"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const base = join(CH, "agents", dir.name);
    for (const f of readdirSync(base).filter((n) => /^msg-\d+\.json$/.test(n)).sort()) {
      try {
        out.push({ file: join(base, f), env: JSON.parse(readFileSync(join(base, f), "utf8")) });
      } catch (e) {
        out.push({ file: join(base, f), broken: e.message });
      }
    }
  }
  return out;
}

if (cmd === "seal") {
  const r = roster();
  const me = opt.me ?? die("缺 --me");
  if (!r.members.some((m) => m.handle === me)) die(`${me} 不在名册里`);
  const body = opt["body-file"] ? readFileSync(opt["body-file"], "utf8") : (opt.body ?? die("缺 --body 或 --body-file"));
  const seq = parseInt(opt.seq ?? Math.max(0, ...allMessages().map((m) => m.env?.seq ?? 0)) + 1, 10);
  const dir = join(CH, "agents", me);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, msgFileName(seq));
  const part = path + ".part";
  if (existsSync(path)) die(`${msgFileName(seq)} 已存在。seq 撞号，重跑一次。`);
  const env = seal({ seq, from: me, to: opt.to ?? "*", type: opt.type ?? "offer", body, nonce: newNonce() }, myKey(me));
  // 封帧靠改名，不靠翻位：读者只看 msg-N.json，永远看不到半截文件
  writeFileSync(part, JSON.stringify(env, null, 2));
  renameSync(part, path);
  console.log(`已写入 ${path}（.part 改名封帧，done 在签名域内）`);
  process.exit(0);
}

if (cmd === "drain") {
  const r = roster();
  const keys = keyringOf(r);
  const me = opt.me ?? die("缺 --me");
  const before = lastSeen(me);
  const found = scanNew(me, keys, before);
  report(me, found, before);
  // 退出码 7 = 本轮拒收里有"版本不支持"。让脚本能把它和真伪造分开数。
  process.exit(found.bad.some((x) => x.code === "UNSUPPORTED_VERSION") ? 7 : 0);
}

if (cmd === "show") {
  const r = roster();
  const keys = keyringOf(r);
  console.log(`频道 ${r.channel}｜成员 ${r.members.map((m) => m.handle).join(", ")}｜closed=${r.closed === true}`);
  for (const { env, broken } of allMessages()) {
    if (broken || !env) {
      console.log(`  ?  损坏`);
      continue;
    }
    const v = verifyEnvelope(env, keys);
    console.log(
      `  ${v.ok ? "✓" : "✗"} seq=${env.seq} ${env.from}→${env.to} ${env.type} done=${env.done}` +
        (v.ok ? ` ${JSON.stringify(env.body).slice(0, 40)}` : ` [${v.code}] ${v.reason}`)
    );
  }
  process.exit(0);
}

if (cmd === "wait") {
  const r = roster();
  const keys = keyringOf(r);
  const me = opt.me ?? die("缺 --me");
  const timeoutMs = (parseInt(opt.timeout, 10) || 300) * 1000;
  const everyMs = (parseInt(opt.every, 10) || 5) * 1000;
  const start = lastSeen(me);
  const deadline = Date.now() + timeoutMs;
  process.stderr.write(`等待 ${me} 的新消息（last_seen>${start}），每 ${everyMs / 1000}s 轮询，超时 ${timeoutMs / 1000}s\n`);
  for (;;) {
    const before = lastSeen(me);
    const found = scanNew(me, keys, before);
    if (found.ok.length || found.bad.length) {
      report(me, found, before);
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      console.log(`超时：${timeoutMs / 1000}s 内没有新消息。对端可能没被唤醒——这本身就是结论。`);
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, everyMs);
  }
}

// 缺参数走 2，不走 die 的 1：README 的锁退码表里 2 就是"参数缺失"，
// 让表格和代码不一致等于再造一次"文档教错规则"。
function needArg(value, name) {
  if (value === undefined) {
    console.error(`✗ 参数缺失（exit ${EXIT.BAD_ARG}）：缺 --${name}`);
    process.exit(EXIT.BAD_ARG);
  }
  return value;
}

// 文件系统异常不是协议结论。频道目录被删/只读/不可写时，给一个**文档里的退码 + 一句人话**，
// 而不是把 stack trace 丢到进程外（实测旧行为：claim 连崩 10 次 exit=1，退出码 1 在退码表里
// 只代表"die()"，谁也不知道那是环境坏了还是机制判负）。
// 这不是把红抹掉：errno、syscall、路径全部原样带出来，且**非 fs 错误照抛**——
// 伪装成环境问题比抛栈更难查。
function lockOp(fn, args) {
  try {
    return fn(args);
  } catch (e) {
    if (!e || !e.code) throw e;
    return { status: "io-error", code: EXIT.LOCK_IO, file: args.file, path: args.claimsDir,
      reason: `文件系统拒绝 ${e.syscall || "操作"}（${e.code}${e.path ? "：" + e.path : ""}）` };
  }
}

// 文件占用锁：单次尝试，**默认不阻塞**。
// 为什么不阻塞：阻塞版要自己决定轮询间隔与超时，超时后又得映射成一个新退码；
// 而调用方本来就要重试循环——把循环放在 CLI 里等于替 agent 决定了等待策略。
// 非阻塞 + 固定退码 3，让调用方自己决定等多久、放弃几次。
if (cmd === "claim") {
  const CLAIMS = join(CH, "claims");
  const file = needArg(opt.file, "file=<要占用的文件>");
  const who = needArg(opt.who, "who=<handle>");
  const r = lockOp(acquire, { claimsDir: CLAIMS, file, who, ttl: opt.ttl });
  if (r.status === "io-error") {
    console.error(`✗ 文件系统不可用（exit ${r.code}）：${r.reason}`);
    console.error("  这不是锁判负，是频道目录本身读不了/写不了。修目录，别改协议。");
    process.exit(r.code);
  }
  // 退码一律取 r.code，不在这里按 status 重新映射一遍：
  // M7 变异演示暴露过——CLI 自己 re-map 的话，模块里的 code 字段不在可观测路径上，
  // 改它测不出红，那条"每个退码都能实跑到"的断言就是死的。
  if (r.status === "refused") {
    console.error(`✗ 拒建（exit ${r.code}）：${r.reason}`);
    process.exit(r.code);
  }
  if (r.status === "dirty-blocked") {
    // 脏锁不是"有人在持"，也不是"没动静"。它必须用自己的退码留一行 DIRTY，
    // 否则旁观者只看见 exit 非 0，猜不到频道是被一把读不懂的文件卡住的。
    const line = noteWait({ claimsDir: CLAIMS, file, who, holder: r.holder, ageS: r.ageS, ttl: r.ttl, tag: "DIRTY" });
    console.log(`✗ 脏锁挡住（exit ${r.code}）：${file} —— ${r.reason}`);
    console.log(`  已登记：${line}`);
    process.exit(r.code);
  }
  if (r.status === "blocked") {
    // 被挡住必须留下一行：否则旁观者看见目录没变化，分不清「它在等锁」和「它没干活」
    const line = noteWait({ claimsDir: CLAIMS, file, who, holder: r.holder, ageS: r.ageS, ttl: r.ttl });
    console.log(`✗ 受阻（exit ${r.code}）：${file} 被 ${r.holder} 占着，已 ${r.ageS?.toFixed?.(1) ?? "?"}s / TTL ${r.ttl ?? "?"}s`);
    console.log(`  已登记：${line}`);
    process.exit(r.code);
  }
  if (r.status === "renew-failed") {
    // 续期失败 = 停手。这一支只报错、不写板：调用方拿到非 0 就必须放弃那一行。
    // 协议能给的最强保证就是"只有退码 0 才是通行证"——写 PROGRESS.md 这个动作本身在 CLI 之外，
    // 所以这里绝不给出任何可以被误当成"可以继续"的输出。
    console.log(`✗ 续期失败（exit ${r.code}）：${file} —— ${r.reason}`);
    console.log(`  你现在**不持有**这把锁：PROGRESS.md 上你自己那一行不许写、已写的要撤，更不许提交。`);
    console.log(`  下一步：重新 claim 拿一把新的，或把这次改动让给 ${r.holder}。`);
    process.exit(r.code);
  }
  console.log(
    r.status === "stolen"
      ? `✓ 抢占 ${file} → ${who}：原持有者 ${r.prevHolder}，回收原因：${r.why}`
      : r.status === "renewed"
        ? `✓ 续期 ${file} → ${who}：TTL 重置为 ${r.ttl}s（${r.why ?? "标记已落"}）`
        : `✓ 领取 ${file} → ${who}（TTL ${r.ttl}s）`
  );
  // 化身令牌必须打出来：它是调用方唯一能带回来的凭据。
  // 不带回来，"被抢占后原方提交"就只能靠名字判断，而名字是原方也报得出的。
  console.log(`  锁文件：${r.path}`);
  console.log(`  化身令牌：--at=${r.at ?? "?"}   释放/提交时带上它；对不上就是 5，别写板`);
  process.exit(EXIT.OK);
}

if (cmd === "release") {
  const file = needArg(opt.file, "file");
  const who = needArg(opt.who, "who");
  const r = lockOp(release, { claimsDir: join(CH, "claims"), file, who, at: opt.at });
  if (r.status === "io-error") { console.error(`✗ 文件系统不可用（exit ${r.code}）：${r.reason}`); process.exit(r.code); }
  if (r.status === "stale-token") {
    console.log(`✗ 令牌过期（exit ${r.code}）：${file} —— ${r.reason}`);
    console.log("  这条比 5 更硬：名字可以冒充，化身号冒充不了。你不持有这把锁，那一行不许写、不许提交。");
    process.exit(r.code);
  }
  // 同 claim：退码只从 r.code 出处走，不在 CLI 里再抄一遍常量
  if (r.status === "no-lock") { console.log(`✗ 无锁可放（exit ${r.code}）：${file}`); process.exit(r.code); }
  if (r.status === "dirty-blocked") { console.log(`✗ 无法释放（exit ${r.code}）：${file} —— ${r.reason}`); process.exit(r.code); }
  if (r.status === "not-holder") {
    console.log(`✗ 拒绝释放（exit ${r.code}）：${file} 现在属于 ${r.holder}，不是 ${who}`);
    console.log("  这条就是「被抢占后原方回来 release 必须被拒」：锁的归属以文件内容为准，不以谁写的为准。");
    process.exit(r.code);
  }
  console.log(`✓ 已释放 ${file}`);
  process.exit(r.code);
}

if (cmd === "locks") {
  const CLAIMS = join(CH, "claims");
  const view = lockOp(list, { claimsDir: CLAIMS });
  if (view && view.status === "io-error") {
    console.error(`✗ 读不到锁目录（exit ${view.code}）：${view.reason}`);
    process.exit(view.code);
  }
  const { locks, stray } = view;
  const wl = join(CLAIMS, "waiters.log");
  const waits = existsSync(wl) ? readFileSync(wl, "utf8").trim().split("\n").filter(Boolean).length : 0;
  console.log(`锁 ${locks.length} 把，等待登记 ${waits} 行，仲裁残留 ${stray.length} 个：`);
  for (const x of locks) console.log(`  ${x.lock}  持有者=${x.holder}  已占 ${x.ageS}s / TTL ${x.ttl ?? "-"}s  ${x.state}`);
  if (!locks.length) console.log("  （当前无锁）");
  for (const s of stray) console.log(`  ! 仲裁残留 ${s}（搬错人又放不回去的现场，不参与归属判定）`);
  process.exit(EXIT.OK);
}

// 在锁的保护下写一行进度板：**归属复验和写板在同一个调用里**。
// 为什么要有它：`claim` 返回 0 只承诺"复查那一瞬间我持着"。从那一刻到调用方自己伸手写
// PROGRESS.md 之间隔的是"一次进程退出 + agent 想多久"，无界——而本系统最初的事故
// 恰好就是"我以为我拿着，我写了"。把写板装进同一次调用，窗口就从无界压到零个动作。
if (cmd === "board") {
  const CLAIMS = join(CH, "claims");
  const file = needArg(opt.file, "file=<你占用的文件>");
  const who = needArg(opt.who, "who=<handle>");
  // --at 必填：可省的话 board 就退化成"只认名字"，而名字是丢锁那方也报得出的东西。
  const at = needArg(opt.at, "at=<claim 打出的化身令牌>");
  const boardPath = needArg(opt.board, "board=<PROGRESS.md 路径>");
  const row = needArg(opt.row, "row=<要写的那一行>");
  // --wait 必须真接进去：测试传了它而代码不读，等于留了一个静默失效的开关
  const waitMs = opt.wait === undefined ? undefined : parseInt(opt.wait, 10);
  const r = lockOp(writeBoard, { claimsDir: CLAIMS, boardPath, file, who, at, row, waitMs });
  if (r.status === "board-busy") {
    // 这一支**可以重试**（和 9 正好相反）：不是归属丢了，是没排到写板的队。
    console.log(`✗ 板级排队超时（exit ${r.code}）：${file} —— ${r.reason}`);
    console.log("  这一条可以重试；不用重新 claim，归属没变。");
    process.exit(r.code);
  }
  if (r.wrote !== true) {
    // 没过复验就一个字节都不写。这一支不产生任何可以被当成"可以继续"的输出。
    console.log(`✗ 写板被拒（exit ${r.code}）：${file} —— ${r.reason ?? "归属复验未通过"}`);
    console.log("  板子没动。你现在不持有这把锁：不要提交，重新 claim。");
    process.exit(r.code);
  }
  console.log(`✓ 已写板 ${boardPath}：${file} → ${who}（写前复验通过，化身 ${r.at}）`);
  console.log(`  落的那一行：${r.row}`);
  process.exit(EXIT.OK);
}

// 一条命令看出"这块板子上有没有越写者"：板上的行声称持锁，盘上却没有对应的活锁。
// **只报不拒**——要拒就得把令牌纳入签名域，那是跳客户端的契约变更。
// 读数侧的原始 mtime：与 src/claims/lock.js 里的 safeMtime 同语义（拿不到就 0，绝不抛）。
// 判据在 lock.js 里夹、这里把"夹之前/夹之后"两个数都报出来 —— 分居两处是本轮边界
// （不改 lock/配置）换来的代价：如果哪天 clamp 改了形，这里的 `采用` 就会说的不是真话。
// 所以它由两条断言钉着：docs-drift 钉 lock.js 里那句 `Math.min(safeMtime(p), Date.now())` 还在，
// claims 的两面夹具钉"发生过必有码、没发生过必无码"。
function lockMtime(claimsDir, file) {
  try { return statSync(join(claimsDir, file)).mtimeMs; } catch { return 0; }
}

if (cmd === "audit") {
  const CLAIMS = join(CH, "claims");
  const boardPath = needArg(opt.board, "board=<PROGRESS.md 路径>");
  const a = lockOp(auditBoard, { claimsDir: CLAIMS, boardPath });
  if (a && a.status === "io-error") { console.error(`✗ 读不到（exit ${a.code}）：${a.reason}`); process.exit(a.code); }
  console.log(`板 ${boardPath}：数据行 ${a.total} 条`);
  for (const s of a.stale) console.log(`  ✗ 越写者：${s.row}\n      声称 ${s.who} 持锁（化身 ${s.at}），盘上没有这把活锁`);
  for (const u of a.untagged) console.log(`  ? 无令牌行（不经 board 写上去的，锁管不到它）：${u}`);
  if (!a.stale.length && !a.untagged.length) console.log("  板上每一行都对得上活锁。");
  // 第二段：盘上现在谁持着锁的现状。**这也是只报不拒**——它存在的理由很具体：
  // 上一场崩溃留下的板锁还没到期时，下一个写者只看见退码 12，
  // 而他分不清"真有人在并发重写这张板"和"前面死了一个人、还剩几秒自动好"。
  // 不做拒绝：那会把一个进程的可交付性挂在另一个进程的命运上（同 seal 那条划分）。
  console.log(`\n盘上现持锁 ${a.holders.length} 把（现状，不是判决）：`);
  if (!a.holders.length) console.log("  （一把都没有：现在没人占着，也没有尸体）");
  for (const h of a.holders) {
    const pid = h.holderPid === null ? "无 pid 后缀"
      : `pid=${h.holderPid} ${h.samePid ? "=本进程" : h.pidAlive === true ? "本机在跑" : h.pidAlive === false ? "本机查不到(尸体?)" : "跨机未知"}`;
    console.log(`  ${h.lock}`.padEnd(28) + ` 持有者=${h.who}` +
      `  已占 ${h.ageS}s  剩 ${h.leftS}s / TTL ${h.ttl}s  ${h.expired ? "已到期可回收" : "未到期"}  ${pid}`);
    if (h.clockNote) console.log(`      时钟：${h.clockNote}`);
    // 【clamp 必须发生得可见】`deadlineOf` 里那句 `Math.min(safeMtime(p), Date.now())` 会把
    // "mtime 被改到未来"（同步盘重写 / 对端时钟 / 手动 utimes / 模拟器 GMT 错位）与
    // "刚刚才写的正常文件"**夹成同一个读数**：判据是对的，但报告里两种现场完全同形、也不报错，
    // 于是下一个入看到"剩 60s"会以为盘上时间可信 —— 其实是别人的钟在替他决定。
    // 这里只重算并打印，**不动 clamp**；来因写"未判定"是刻意的：本仓从没在真同步盘上验过
    // "远端会重写 mtime"这个前提（见 README 那句"未验"），没有证据就不许替用户下结论。
    const rawM = lockMtime(CLAIMS, h.file);
    const usedM = Math.min(rawM, Date.now());
    if (rawM !== usedM) {
      console.log(`      [MTIME_CLAMPED] 原始=${rawM} 采用=${usedM} 抹掉=${rawM - usedM}ms` +
        `  来因=未判定（候选：写方钟超前 / 同步盘重写 / 手动改时间 / 时区错位）`);
      // 上面那行与 `h.clockNote` 那句"写方钟偏早"是**同一个观测的两种说法**：`at − mtime` 是负的，
      // 既可能是写方的钟真早，也可能是 mtime 被改到了未来 —— 本地信息分不出。
      // clockNote 的措辞在 lock.js 里（本轮不改 lock），所以在读数侧当场把它降回"候选解释"，
      // 否则两句挨着出现，前一句看起来像已经查明了。
      if (h.clockNote) {
        console.log(`      ↑ 上一条时钟注释里的来因不是结论：同一个差值也可由 mtime 被改到未来产生（本机无法区分，见上 [MTIME_CLAMPED]）`);
      }
    }
  }
  // 机读汇总行：退码只表达"有没有越写者(stale)"这一件事，
  // 无令牌行(untagged)、现状条数这些**同样要能被机器判**，所以它们进这一行而不是挤进退码。
  // 这是"少报"那一侧的处置：表头/人类注释行也是"无令牌"的形状，把它们并进 11
  // 会把每张正常板子判成有问题（多报）；完全不给机读入口又会让靠退码自动化的脚本漏掉这一类。
  printSummary({
    kind: "audit", rows: a.total, stale: a.stale.length, untagged: a.untagged.length,
    holders: a.holders.length,
    code: a.stale.length ? EXIT.STALE_BOARD_ROW : EXIT.OK,
    codes: [...new Set([EXIT.STALE_BOARD_ROW, EXIT.OK])],
  });
  process.exit(a.stale.length ? EXIT.STALE_BOARD_ROW : EXIT.OK);
}

function scanNew(me, keys, since) {
  const seen = seenNonces(me);
  const ok = [];
  const bad = [];
  for (const { file, env, broken } of allMessages()) {
    if (broken) { bad.push({ file, code: "BAD_ENVELOPE", reason: "JSON 解析失败" }); continue; }
    if (env.done !== true) continue;
    if (env.from === me) continue;
    if (env.to !== me && env.to !== "*") continue;
    if (env.seq <= since) continue;
    const v = verifyEnvelope(env, keys);
    if (!v.ok) { bad.push({ file, code: v.code, reason: v.reason }); continue; }
    const k = `${v.env.from}:${v.env.nonce}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ok.push(v.env);
  }
  ok.sort((a, b) => a.seq - b.seq || a.from.localeCompare(b.from));
  const maxSeq = Math.max(since, ...ok.map((e) => e.seq));
  mkdirSync(join(CH, "agents", me), { recursive: true });
  writeFileSync(join(CH, "agents", me, ".last_seen"), String(maxSeq));
  writeFileSync(join(CH, "agents", me, ".seen-nonce"), [...seen].join("\n"));
  return { ok, bad, maxSeq };
}

function report(me, found, before) {
  console.log(`\n=== ${me}：新消息 ${found.ok.length} 条，被拒 ${found.bad.length} 条，last_seen ${before} → ${found.maxSeq} ===`);
  for (const e of found.ok) {
    console.log(`\n[seq ${e.seq}] ${e.from} → ${e.to}  type=${e.type}`);
    console.log(e.body);
  }
  for (const x of found.bad) console.log(`\n✗ 拒收 ${x.file}\n  code=${x.code}  原因：${x.reason}   （body 未读取）`);
  const stale = found.bad.filter((x) => x.code === "UNSUPPORTED_VERSION").length;
  if (stale) console.log(`\n注意：其中 ${stale} 条是「版本不支持」而非伪造。它们同样被拒，但不应计入攻击信号——见 docs/specs/06。`);
}

console.log(`agent-relay CLI

  seal   --channel=<目录> --me=<handle> --to=<handle|*> --type=<t> (--body=<文本> | --body-file=<路径>)
  drain  --channel=<目录> --me=<handle>
  wait   --channel=<目录> --me=<handle> [--timeout=300] [--every=5]     阻塞到新消息出现，替代盲等 sleep
  show   --channel=<目录>

  claim    --channel=<目录> --file=<路径> --who=<handle> --ttl=<正整数秒>
  release  --channel=<目录> --file=<路径> --who=<handle> [--at=<化身令牌>]
  board    --channel=<目录> --file=<路径> --who=<handle> --at=<化身令牌> --board=<PROGRESS.md> --row=<一行> [--wait=2000]
  audit    --channel=<目录> --board=<PROGRESS.md>     看这块板有没有越写者（只报不拒）
  locks    --channel=<目录>

封帧：seal 先写 msg-N.json.part，再改名为 msg-N.json。读者只看 .json，永远读不到半截文件。
done 在签名域内——翻动它即验签失败。

锁的退码：0 拿到/续期/写板/释放成功，2 参数缺失，3 被别人占着（非阻塞，已写 waiters.log），
4 没有这把锁，5 持有者不是你不是我（含令牌对不上），6 TTL 非法（缺失、非正整数），
8 锁文件内容读不懂（脏锁）；躺过 120s 上界后 claim 会回收它，release 一律不给裸删，
9 续期失败：复查时基锁已换化身 —— **停笔**，那一行不许写、已写的要撤，不许原地重试，
10 文件系统本身不可用（目录被删/只读/是个普通文件）；这不是锁判负，修环境，
11 audit 发现越写者（板上行声称持锁而盘上无对应活锁）；只报不拒，
12 board 板级排队超时：**可以重试**，归属没丢，只是没排到重写这张板的队。
--ttl 必填：允许 ttl=0 等于允许一把永远卡死频道的脏锁。
锁保护的是走 board 的写；不走 board 的写不受这层保护——用 audit 去检测它。`)

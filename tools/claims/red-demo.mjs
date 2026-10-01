// 变异演示：逐处把实现改坏，跑对应测试，确认它**真的红**。
// 一次调用做完全部四处，不接 <mode> 参数——上一版把命令行顺序写反，变异根本没发生，
// 测试却报绿，那是假绿灯里最难发现的一种。用法：node tools/claims/red-demo.mjs <仓库绝对路径>
import { readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { printSummary, crossCheck, HARNESS_EXIT } from "../../src/claims/summary.js";

// 退码声明表（见 board-race.mjs 同名表的注释）：7 专留给"测具自己在骗人"
const EXIT_CODES = { allRed: 0, harness: 7, notAllRed: 8, badUsage: 9 };

const ROOT = process.argv[2];
if (!ROOT) { console.error("用法：node tools/claims/red-demo.mjs <仓库绝对路径>（参数只有一个，别再写反顺序）"); process.exit(EXIT_CODES.badUsage); }
const LOCK = join(ROOT, "src/claims/lock.js");
const CLI = join(ROOT, "src/cli.js");
const README = join(ROOT, "README.md");
const SUM = join(ROOT, "src/claims/summary.js");
const BR = join(ROOT, "tools/claims/board-race.mjs");
const DEMO = join(ROOT, "tools/claims/red-demo.mjs");
const CENSUS = join(ROOT, "tools/claims/dirty-census.mjs");
const RENEW = join(ROOT, "tools/claims/renew-race.mjs");
const HARNESS = join(ROOT, "tools/claims/selfcheck-harness.mjs");

// M27 的锚点是**从 README 当场读出来的**，不是手抄的。
// 上一版手抄了"121"，本轮 121→122→123 连炸两次"锚点没命中"——那是测具自己的固定故障，
// 与被测代码无关，却会把一次真跑降级成"结论不成立"。改成：读出当前那个数，写回"它 −4"。
// 命中因此是必然的，错也是必然的（断言那边数的是各套件的真值）。
const README_TOTAL = (() => {
  const m = /测试总数 \*\*(\d+)\*\*/.exec(readFileSync(join(ROOT, "README.md"), "utf8"));
  if (!m) {
    console.error("!! README 里找不到 `测试总数 **N**`：M27 的锚点读不出来，停下（不静默跳过，那等于少测一条）");
    process.exit(EXIT_CODES.badUsage);
  }
  return Number(m[1]);
})();
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
    pairs: [['if (cur.who !== who) {', 'if (false) {']],
    test: "非持有者 release",
  },
  {
    name: "M3 独占创建退化成普通写（单胜者判据整个失效）",
    file: LOCK,
    // 旧版这条是「把 rename 换成 rm」；现在单胜者由 wx 独占创建保证，
    // 所以等价的做法是把 flag:"wx" 摘掉——那才是"谁都能自称拿到"的形态。
    pairs: [
      ['fs.writeFileSync(p, JSON.stringify({ who, at: incarnation, ttl: t.value }), { flag: "wx" });',
       'fs.writeFileSync(p, JSON.stringify({ who, at: incarnation, ttl: t.value }));'],
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
    test: "关键语义",
  },
  {
    name: "M7 代码不再返回退码 4，「每个值都能实跑」那条该红",
    file: LOCK,
    suite: "test/docs-drift.test.js",
    pairs: [['if (!cur) return { status: "no-lock", code: EXIT.NO_LOCK,', 'if (!cur) return { status: "no-lock", code: EXIT.BLOCKED,']],
    test: "每个值都能被 CLI 真跑到",
  },
  {
    name: "M8 独占创建退化，推演器 S2b 那条该红（证据文档引的是它的数字）",
    file: LOCK,
    suite: "test/sim.test.js",
    pairs: [
      ['fs.writeFileSync(p, JSON.stringify({ who, at: incarnation, ttl: t.value }), { flag: "wx" });',
       'fs.writeFileSync(p, JSON.stringify({ who, at: incarnation, ttl: t.value }));'],
    ],
    test: "S2b",
  },
  {
    name: "M9 脏锁重新抛异常（栈穿出进程顶，退码 1）",
    file: LOCK,
    pairs: [['  } catch {\n    return corruptLock(p, "JSON 解析失败");', '  } catch (e) {\n    throw new Error(`锁文件损坏或不可读: ${e.message}`);']],
    test: "截断的锁文件",
  },
  {
    name: "M10 去掉脏锁回收上界（等于承认存在无限期锁，永久卡死）",
    file: LOCK,
    pairs: [["export const CORRUPT_GRACE_S = 120;", "export const CORRUPT_GRACE_S = Infinity;"]],
    test: "脏锁超过上界后可被回收",
  },
  {
    name: "M11 locks 不认脏锁（旁观者现场被一把坏文件打瞎）",
    file: LOCK,
    pairs: [["    if (cur.corrupt) {\n      const idleS = +(((Date.now() - cur.mtimeMs) / 1000).toFixed(1));", "    if (false) {\n      const idleS = +(((Date.now() - cur.mtimeMs) / 1000).toFixed(1));"]],
    test: "脏锁不再打崩 locks",
  },
  {
    name: "M12 续期换回裸覆盖写（洞 1 原样）",
    file: LOCK,
    pairs: [["    const m = markerOf(p, cur.at);",
             "    fs.writeFileSync(p, JSON.stringify({ who, at: Date.now(), ttl: t.value }));\n    const m = markerOf(p, cur.at);"]],
    test: "落笔前复查必须判它输",
  },
  {
    name: "M13 抢占不做「搬走后复查」，判可拿就动手",
    file: LOCK,
    pairs: [["    const canTake = !got || (got.corrupt", "    const canTake = true || !got || (got.corrupt"]],
    test: "抢占复查搬到的那一把时必须收手",
  },
  {
    name: "M14 去掉化身令牌校验（名字对就放行）",
    file: LOCK,
    pairs: [["if (at !== undefined && at !== null && String(at) !== String(cur.at)) {", "if (false) {"]],
    test: "化身令牌",
  },
  {
    name: "M15 到期计算忽略续期标记（第一道防线：外层判据不算标记）",
    file: LOCK,
    // 锚点跟着 deadlineOf 改过两次形状：标记那一行从单行 for 变成了带 corrupt 分支的块；
    // 本轮 clamp 改成返回结构时循环变量 `m` 改名 `mk`（外层已有 `const m` 被它遮蔽，
    // 那种同名本身就是读代码的坑），于是老锚点又整段失配。
    // red-demo 每次都报"锚点没命中"而不是绿——这条守卫是对的，也是它该有的样子。
    pairs: [["    d = Math.max(d, Math.max(mk.at, mm) + (mk.ttl || c.ttl) * 1000);",
             "    void mk;   // 变异：标记不参与到期计算"]],
    test: "标记已在盘上时，外层判据就该直接收手",
  },
  {
    name: "M16 观测面与判定各算各的：locks 不报续期次数",
    file: LOCK,
    pairs: [["    const renewals = markersFor(path.join(claimsDir, f), cur.at).length;", "    const renewals = 0;"]],
    test: "同持有者重复 claim",
  },
  {
    name: "M17 fs 异常不收敛成退码 10，直接漏到进程顶",
    file: CLI,
    suite: "test/docs-drift.test.js",
    pairs: [["    return { status: \"io-error\", code: EXIT.LOCK_IO, file: args.file, path: args.claimsDir,", "    throw e;\n    return { status: \"io-error\", code: EXIT.LOCK_IO, file: args.file, path: args.claimsDir,"]],
    test: "每个值都能被 CLI 真跑到",
  },
  {
    name: "M18 board 跳过归属复验（写板退回裸 append）",
    file: LOCK,
    // 两次复验都得拆：writeBoard 现在有入口 + 拿到板级锁之后两道。
    // 只拆一道它仍会被另一道拦住——那种"摘一层不红"不等于另一层是多余的，
    // 但作为变异演示，它必须整体拆掉才算测到了"复验这件事本身"。
    pairs: [['  if (held0.status !== "held") return { ...held0, wrote: false };', "  if (false) return { ...held0, wrote: false };"],
            ['    if (held.status !== "held") return { ...held, wrote: false, boardLockHeldBy: boardWho };', "    if (false) return { ...held, wrote: false, boardLockHeldBy: boardWho };"]],
    test: "board 必须拒写",
  },
  {
    name: "M19 闸口无视环境变量、只看磁盘（等于给靶场开一条 DoS 通道）",
    file: LOCK,
    pairs: [["  if (!gateEnabled()) return false;", "  if (false) return false;"]],
    test: "完全不生效",
  },
  {
    name: "M20 复验不看化身令牌（名字对就让写）",
    file: LOCK,
    pairs: [["if (at !== undefined && at !== null && String(cur.at) !== String(at)) {", "if (false) {"]],
    test: "没有令牌时放行",
  },
  {
    name: "M21 拆掉板级锁（board 只验自己的文件锁就重写整张板）",
    file: LOCK,
    pairs: [['    if (b.status === "acquired" || b.status === "stolen") break;',
             '    if (true) break;   // 变异：不排队，直接读整张板再写回去']],
    test: "板级锁时退 12",
  },
  {
    name: "M22 audit 只看不报（越写者被算成干净）",
    file: LOCK,
    pairs: [["if (!liveKeys.has(`${fileCol}|${whoCol}|${m[1]}`)) stale.push({ row: line.trim(), who: whoCol, file: fileCol, at: m[1] });",
             "void liveKeys; void whoCol; void fileCol;"]],
    test: "伪造一行",
  },
  // ---- 本轮新增代码面：锁序、seal 隔离、崩溃回收 ----
  {
    name: "M23 持板锁时再去取文件锁（AB-BA 死锁的形状长回来）",
    file: LOCK,
    pairs: [["  try {\n    const held = verifyHold({ claimsDir, file, who, at });",
             "  try {\n    acquire({ claimsDir, file, who, ttl: 60 });   // 变异：把复验改成重新 claim 一次\n    const held = verifyHold({ claimsDir, file, who, at });"]],
    test: "锁序不变式",
  },
  {
    name: "M24 在 seal 里加一次板级读取（我的可交付性挂在别人的守规矩上）",
    file: CLI,
    pairs: [['  const dir = join(CH, "agents", me);',
             '  auditBoard({ claimsDir: join(CH, "claims"), boardPath: join(CH, "PROGRESS.md") });   // 变异：签名前先看别人有没有写坏板\n  const dir = join(CH, "agents", me);']],
    test: "seal 不看令牌是决定",
  },
  {
    name: "M25 板锁 TTL 拉长到一小时（崩溃的持有者把这张板卡死一小时）",
    file: LOCK,
    // 不写 Infinity：那不是"回收不生效"，是 acquire 的 ttl 校验直接把板锁变成拿不到（退 6），
    // 测试会红在错误的判据上——红的方向比红本身更要紧。
    pairs: [["export const BOARD_LOCK_TTL_S = 5;", "export const BOARD_LOCK_TTL_S = 3600;"]],
    test: "崩溃后",
  },
  {
    name: "M26 写板成功却不放开板锁（下次写者白等，回收变成一次性）",
    file: LOCK,
    pairs: [["    release({ claimsDir, file: BOARD_LOCK, who: boardWho });",
             "    void boardWho;   // 变异：finally 里忘了 release"]],
    test: "崩溃后",
  },
  // ---- 文档层的新门：三条都要能红 ----
  {
    name: "M27 README 的测试总数与分项对不上代码",
    file: README,
    suite: "test/docs-drift.test.js",
    pairs: [[`测试总数 **${README_TOTAL}**`, `测试总数 **${README_TOTAL - 4}**`]],
    test: "测试计数",
  },
  {
    name: "M28 代码把板锁 TTL 改成 9s，README 还写着 5s",
    file: LOCK,
    suite: "test/docs-drift.test.js",
    pairs: [["export const BOARD_LOCK_TTL_S = 5;", "export const BOARD_LOCK_TTL_S = 9;"]],
    test: "板锁 TTL",
  },
  {
    name: "M29 README 的探针行少解释一个退码（4）",
    file: README,
    suite: "test/docs-drift.test.js",
    pairs: [["**4 = 前提不成立**", "**（原文已删）**"]],
    test: "探针与夹具",
  },
  // ---- 跨机时钟与现状输出：四条新判据各配一处变异 ----
  {
    name: "M30 到期判定退回只看头部 at（写方钟偏早 ⇒ 抢走活锁 ⇒ 双写回来）",
    file: LOCK,
    pairs: [["  let d = Math.max(Number(c.at) || 0, m) + c.ttl * 1000;",
             "  let d = Number(c.at) + c.ttl * 1000;   // 变异：丢掉本地 mtime"]],
    test: "偏早",
  },
  {
    name: "M31 到期判定只信本地 mtime（写方钟偏晚那一侧被误当过期）",
    file: LOCK,
    // 不用 min(at, mtime)：steal 的复查里路径已经指向搬走后的文件，min 的 0 会被 `|| at` 兜住，
    // 红就落在观测断言上而不是"不得被抢"那条——红的方向比红本身更要紧。
    pairs: [["  let d = Math.max(Number(c.at) || 0, m) + c.ttl * 1000;",
             "  let d = m + c.ttl * 1000;   // 变异：完全不看头部 at"]],
    test: "偏晚",
  },
  {
    name: "M32 不做字段校验（无 at/ttl 的锁重新变成永不超期）",
    file: LOCK,
    pairs: [['    if (obj && typeof obj === "object" && lockShapeOk(obj)) {',
             '    if (obj && typeof obj === "object") {   // 变异：残缺锁重新算合法']],
    test: "字段残缺",
  },
  {
    name: "M33 audit 看见盘上有锁就拒（把\"点名\"做成\"拦截\"）",
    file: CLI,
    pairs: [["  process.exit(a.stale.length ? EXIT.STALE_BOARD_ROW : EXIT.OK);",
             "  process.exit(a.stale.length || a.holders.length ? EXIT.STALE_BOARD_ROW : EXIT.OK);"]],
    test: "退码仍按越写者判",
  },
  {
    name: "M34 现状段不再区分\"已到期可回收\"（尸体和拥堵混成一坨）",
    file: LOCK,
    pairs: [["    leftS, expired: leftS <= 0,", "    leftS, expired: false,"]],
    test: "audit 的现状段要能同时说出",
  },
  {
    name: "M35 max 被当成'谁也别想回收'（两个钟都老也不许过期）",
    file: LOCK,
    pairs: [["  let d = Math.max(Number(c.at) || 0, m) + c.ttl * 1000;",
             "  void p; void m; let d = Number.MAX_SAFE_INTEGER;   // 变异：到期时刻永远到不了"]],
    test: "两个钟都老",
  },
  // ---- 通令那一族：读不到 ≠ 0、双向印证、少报形状 ----
  {
    name: "M36 目录读失败整块吞成\"没有标记\"（少报：所有续期一笔勾销）",
    file: LOCK,
    pairs: [["    if (e.code === \"ENOENT\") return [];\n    throw e;", "    return [];"]],
    test: "目录读失败",
  },
  {
    name: "M37 半截续期标记被当成没有标记（把正在写的那一次续期读成不存在）",
    file: LOCK,
    // 打在 catch 那一支：用例喂的是 `{"at": 17`（半截 JSON），走的是 parse 抛错这条路。
    // 上一版打的是"字段不完整"那一支，红不到——**变异要落在被测路径上，不是落在同名的相邻行上**。
    pairs: [['      out.push({ corrupt: true, mtimeMs: safeMtime(full), why: e.code === "ENOENT" ? "刚被清掉" : `读不出（${e.code}）` });',
             "      void e;   // 变异：读不懂就当没有这个标记"]],
    test: "半截续期标记",
  },
  {
    name: "M38 audit 把手写得不规整的行整行跳过（少一个尾巴的 | 就看不见越写者）",
    file: LOCK,
    pairs: [["    const cols = line.split(\"|\").map((s) => s.trim()).filter(Boolean);",
             "    if (!/\\|\\s*$/.test(line.trimEnd())) continue;   // 变异：形状不合就整行不看\n    const cols = line.split(\"|\").map((s) => s.trim()).filter(Boolean);"]],
    test: "少一个尾巴的手写行",
  },
  {
    name: "M39 audit 把无令牌行也判成 11（表头与它形状一样，每张正常板子都会被拒）",
    file: CLI,
    pairs: [["    code: a.stale.length ? EXIT.STALE_BOARD_ROW : EXIT.OK,", "    code: a.stale.length || a.untagged.length ? EXIT.STALE_BOARD_ROW : EXIT.OK,"],
            ["  process.exit(a.stale.length ? EXIT.STALE_BOARD_ROW : EXIT.OK);",
             "  process.exit(a.stale.length || a.untagged.length ? EXIT.STALE_BOARD_ROW : EXIT.OK);"]],
    test: "表头会被算进 untagged",
  },
  {
    name: "M40 双向印证不看\"打印的数 vs 现场重算的数\"",
    file: SUM,
    pairs: [["  else if (raw !== reported) bad.push(", "  else if (false) bad.push("]],
    test: "双向印证",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M41 计数行读不到时静默兜底成 0（NOT REPORTED 就此变成 PASSED）",
    file: SUM,
    pairs: [["  if (!all.length) {", "  if (false) {"]],
    test: "读不到就抛",
    suite: "test/docs-drift.test.js",
  },
  // M42 已撤回，ID 不复用（留在这儿是为了"为什么少一条"有地方查）：
  // 它想证"判读器必须先自证"，但目标文件是 red-demo 自己——pairs 的字面量也住在这个文件里，
  // replace() 先命中 pairs 那一份，真调用点一个字节没动，而"写盘后回读与原文不同"这条守卫
  // 照样通过（文件确实变了）。那是一条**伪装成测量结果的空操作**。
  // 同一件事改用两条不自我指涉的判据：① docs-drift 断言源码里 runSelftest() 在变异循环之前；
  // ② docs-drift 以子进程真跑一次 --selftest-only，要求 7 条 ok 且退 0。
  {
    name: "M43 退码表打进汇总行这件事被摘掉（读的人只能靠猜有哪些码）",
    file: BR,
    pairs: [["  code, codes: [...new Set(Object.values(EXIT_CODES))],", "  code,"]],
    test: "探针与夹具",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M44 摘掉『mtime 夹到本地此刻』（未来的 mtime 能把租约拉长）",
    file: LOCK,
    pairs: [["  const m = Math.min(rawMtime, now);", "  const m = rawMtime;   // 变异：不夹"]],
    test: "未来的 mtime",
  },
  {
    name: "M45 摘掉『超阈就降级』（让 clamp 单独决定 = 时钟回跳等于提前过期）",
    file: LOCK,
    pairs: [["      if (skew !== null && skew > SKEW_UNTRUSTED_S) {", "      if (false) {"]],
    test: "一整个小时",
  },
  // M46 已撤回，ID 不复用。理由要留在这儿，不然下一个人会以为是漏了：
  //   它把 `mismatch` 归零，指望"两把尺子不同向 ⇒ 退 9"这道门独自失火。
  //   本轮把 raw 改成"现场按 n1/n2 独立重算"之后，面 E 那份"格子尺说两行都在"的伪证
  //   会同时造成 reported=0 与 raw>0 ⇒ crossCheck 先报"退 0 却报 bad=0" ⇒ 探针仍然退 9。
  //   也就是说 mismatch 那道门在这一个场景里**已被上游的门替掉**，不再独自决定任何一次观测——
  //   一条没人独自依赖的变异会被记成"没咬住"，那是测具在骗人。
  //   它仍然留在探针代码里（"板上那一行不是声称那一行"这种改写只有它看得见，raw/lost 都看不见），
  //   但要给它配红，得先造出"两把尺子不同向而 reported 与 raw 恰好相等"的现场——本轮没造出来，
  //   所以宁可撤条并写明，也不留一条注定报绿的变异冒充覆盖率。
  {
    name: "M47 parseSummary 允许同一 kind 出现两条（挑一条当结论）",
    file: SUM,
    pairs: [["  if (hits.length > 1) {", "  if (false) {"]],
    test: "五面自证",
    suite: "test/docs-drift.test.js",
  },
  // ↓ 这一组是"探针自己把命令读错"一族。起因是本轮真实踩中的 slice(3)：
  //   仓库路径被吞、探针炸 ENOENT，而 npm test 121/121 全绿——因为没人真的跑过它。
  {
    name: "M48 探针入参偏移（slice(2)→slice(3)，仓库路径整个被吞掉）",
    file: BR,
    pairs: [["const argv = process.argv.slice(2);", "const argv = process.argv.slice(3);   // 变异：本轮真写过的一版"]],
    test: "探针必须真被跑起来",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M49 参数白名单重新放行裸数字（漏写 --inject= 前缀又被静默忽略）",
    file: BR,
    pairs: [['const known = (a) => a.startsWith("--inject=") || a === "--unlocked" || a === "--detector-selftest-only";',
             'const known = (a) => a.startsWith("--inject=") || a === "--unlocked" || /^\\d+$/.test(a);   // 变异']],
    test: "探针必须真被跑起来",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M50 注入值写坏不再拦（--inject=abc 退化成『没注入』、还照样打印 inject:0）",
    file: BR,
    pairs: [["if (injectRaw && !/^[1-9]\\d*$/.test(injectRaw)) {", "if (false) {"]],
    test: "探针必须真被跑起来",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M51 摘掉『ROOT 必须像仓库』（参数写反时只剩一串 cpSync 的 ENOENT 栈）",
    file: BR,
    pairs: [['if (!fs.existsSync(path.join(ROOT, "src", "cli.js"))) {', "if (false) {"]],
    test: "探针必须真被跑起来",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M52 护栏因入参缺失静默跳过：漏传 raw 时 crossCheck 仍返『可信』",
    file: SUM,
    pairs: [["  if (!Number.isFinite(raw)) bad.push(", "  if (false) bad.push("],
            ["  else if (raw !== reported) bad.push(", "  else if (false) bad.push("]],
    test: "双向印证",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M53 样本齐不齐那道护栏因漏传 expect 而整条跳过",
    file: SUM,
    pairs: [["  if (!Number.isFinite(expect)) bad.push(", "  if (false) bad.push("],
            ["  else if (!Number.isFinite(measured)) bad.push(", "  else if (false) bad.push("],
            ["  else if (measured !== expect) bad.push(", "  else if (false) bad.push("]],
    test: "双向印证",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M54 丢行判据把『有一家被拒、竞争没跑成』也数成丢行（凭空指控缺陷）",
    file: BR,
    pairs: [["const lost = rows.filter((x) => x.applicable && !x.both);",
             "const lost = rows.filter((x) => !x.both);   // 变异：回到本轮之前的错判据"]],
    test: "探针必须真被跑起来",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M55 摘掉『一轮都没跑成竞争 ⇒ 退 4』（空跑被读成结论）",
    file: BR,
    pairs: [["if (applicable === 0) {\n  const byCode = {};", "if (false) {\n  const byCode = {};"]],
    test: "探针必须真被跑起来",
    suite: "test/docs-drift.test.js",
  },
  {
    // 这不是假想：本轮我把一条用例的声明写成了**缩进**，于是"核对测试总数"那条断言少数一条、
    // 照报绿，而 runner 实际多跑一条（README 写 124 / 实跑 127）。判据只认顶格声明，
    // 就等于判据替一个真实的错记账。M56 把那条声明重新缩进一次，验这条 strengthened 断言真会红。
    name: "M56 把一条用例声明缩进（顶格数法少数一条，README 的测试总数变假账）",
    file: join(ROOT, "test/docs-drift.test.js"),
    pairs: [['test("README 写的板锁 TTL 与代码常量一致（数字抄错=文档说谎）", () => {',
             '   test("README 写的板锁 TTL 与代码常量一致（数字抄错=文档说谎）", () => {']],
    test: "测试计数",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M57 把 S2b 的一条普查拼进消息摘掉（间歇红又变回光秃秃的数字差）",
    // 20 路并发那两条间歇红过两次，旧消息只有 `18 !== 19`：分不清"双主"与"静默消失"。
    // 这条变异证明"诊断必须在消息里"这件事有人守着——删掉一处 census 就红。
    file: join(ROOT, "test/sim.test.js"),
    pairs: [["家。双主 = 锁失效｜${census(out.s2b)}", "家。双主 = 锁失效"]],
    test: "S2b 的每条断言都必须自带普查",
    suite: "test/docs-drift.test.js",
  },
  {
    // clamp 的两面夹具各配一条变异：摘掉 ⇒ 正例不红（等于什么都没印）；无条件印 ⇒ 反例红
    // （具名短码失去分辨力）。两条合起来才证明"两面"不是摆设 —— 只配前一条的话，
    // "任何锁都打这行"这种写法照样能过整个套件。
    name: "M58 摘掉 clamp 的可见性报告（被夹过的锁与正常锁又长成一个样子）",
    file: CLI,
    pairs: [["if (h.clampedFrom != null) {", "if (false) {   // 变异：夹还是照夹，只是不说了"]],
    test: "clamp 发生过就必须看得见",
    suite: "test/claims.test.js",
  },
  {
    name: "M59 让那条报告无条件打印（具名短码失去分辨力 ⇒ 反例面就是空的）",
    file: CLI,
    pairs: [["if (h.clampedFrom != null) {", "if (true) {   // 变异：正常锁也打，『打过』不再有信息量"]],
    test: "clamp 没发生过就不许打",
    suite: "test/claims.test.js",
  },
  {
    name: "M60 摘掉那句『来因不是结论』（clockNote 还写着结论式措辞，旁边却没人否认它了）",
    file: CLI,
    pairs: [["      if (h.clockNote) {\n        console.log(`      ↑ 上一条时钟注释里的来因不是结论",
             "      if (false) {\n        console.log(`      ↑ 上一条时钟注释里的来因不是结论"]],
    test: "clamp 发生过就必须看得见",
    suite: "test/claims.test.js",
  },
  {
    // 上面三条打的是**打印器**。这两条打**返回值**本身：可见性只长在 stdout 上时，
    // 走 API 的人（writeBoard 经 verifyHold 决定要不要写板）拿到的仍是一个被默默夹过的普通数字。
    name: "M61 clampedFrom 恒为 null（夹过这件事又从返回值里消失了）",
    file: LOCK,
    pairs: [["  let clampedFrom = rawMtime > m ? rawMtime : null;", "  let clampedFrom = null;   // 变异：事实不再随返回值走"]],
    test: "被夹过要跟着返回值走",
    suite: "test/claims.test.js",
  },
  {
    name: "M62 clampedFrom 恒等于原始 mtime（正常锁也报被夹 ⇒ 字段失去分辨力）",
    file: LOCK,
    pairs: [["  let clampedFrom = rawMtime > m ? rawMtime : null;", "  let clampedFrom = rawMtime;   // 变异：恒真"]],
    test: "没夹过就不许带",
    suite: "test/claims.test.js",
  },
  {
    // 下面三条打的是本轮新加的**扫描器与它的两面夹具**（tools/claims/dirty-census.mjs）。
    // "两面夹具能把 --scan-root 拓出来的红抦住"这句话此前只是我的声明：没有变异证明过，
    // 它就必须标成"不占功"。这三条把它变成证据。
    name: "M63 吞掉 --scan-root= 的值（夹具指向哪都一样，永远扫仓根）",
    file: CENSUS,
    pairs: [['if (a.startsWith("--scan-root=")) out.root = path.resolve(a.slice("--scan-root=".length));',
             'if (a.startsWith("--scan-root=")) out.root = out.root;   // 变异：入参被吞']],
    test: "两面夹具",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M64 摘掉未跟踪兜底层（名单之外的任何名字从此隐身）",
    file: CENSUS,
    pairs: [['const untracked = g && g.status === 0 ? (g.stdout || "").trim().split(/\\r?\\n/).filter(Boolean) : [];',
             'const untracked = [];   // 变异：兜底层不产出任何数']],
    test: "两面夹具",
    suite: "test/docs-drift.test.js",
  },
  {
    name: "M65 摘掉分隔符归一（Windows 上反斜杠路径与 git 的正斜杠去比，覆盖恒为漏扫）",
    file: CENSUS,
    pairs: [['const slashed = new Set(kept.map((p) => p.split("\\\\").join("/")));',
             'const slashed = new Set(kept.map((p) => p));   // 变异：不归一']],
    test: "探针的读数只作即时判别",
    suite: "test/docs-drift.test.js",
  },
  {
    // M66 打的是"临时树前缀不许跨文件复用"这条新门。它挑得很刁：两个前缀同名**不会改变任何行为**
    // （mkdtemp 还带随机后缀），所以除了这条门，没有任何一条用例会红——这正是"只活在注释里的约定"该有的靶子。
    name: "M66 让 renew-race 复用 board-race 的临时树前缀（两条路开始互删对方的树）",
    file: RENEW,
    pairs: [['"relay-race-src-"', '"relay-board-src-"']],
    test: "临时树前缀两两不同",
    suite: "test/docs-drift.test.js",
  },
  {
    // M67 摘掉撕点守卫：短行本该"撕不动"（返回 null ⇒ 那面判『没验过』），守卫没了就一律返回中点。
    // 这条靶子的价值在于它是这一面**唯一的红路**：守卫在位时五面全咬住、退 0，
    // 摘掉之后没有任何行为变化（长行照样抛），只有这条自检会发现"以后它只会一直绿"。
    name: "M67 撕点守卫失效（短行也被判成可撕 ⇒ 那面从此只会一直绿）",
    file: HARNESS,
    pairs: [["  return mid > prefixLen && mid < String(line).length ? mid : null;", "  return mid;   // 变异：不判行内性"]],
    test: "五面自证",
    suite: "test/docs-drift.test.js",
  },
];

// 计数行的正则与判读放在**同一处**定义：`node --test` 的报告格式一改，
// "读不到 fail" 和 "fail 确实是 0" 就长得一模一样，而阶段状态如果只看退出码，
// 汇总器会把它报成 PASSED。隔壁仓刚在这种形状上实出来一次，本仓同形的有四处。
// 所以：**读不到计数 = harness error（非 0）**，绝不当 0。
const COUNT_RE = { tests: /\nℹ tests (\d+)/, pass: /\nℹ pass (\d+)/, fail: /\nℹ fail (\d+)/ };

function classify(status, out) {
  const grab = (re) => { const m = re.exec(out); return m === null ? null : Number(m[1]); };
  const ran = grab(COUNT_RE.tests), pass = grab(COUNT_RE.pass), fail = grab(COUNT_RE.fail);
  const missing = [ran, pass, fail].filter((x) => x === null).length;
  if (missing) {
    return { verdict: "harness-error", ran, pass, fail,
      why: `计数行读不到 ${missing} 项（node --test 的报告格式变了？读不到不等于 0）` };
  }
  // 双向印证：状态与计数必须互相印证，单方向不一致就是测具在骗人
  if (status === 0 && fail > 0) return { verdict: "harness-error", ran, pass, fail, why: `退 0 却报 fail=${fail}` };
  if (status !== 0 && fail === 0) {
    return { verdict: "harness-error", ran, pass, fail,
      why: "退非 0 但 fail=0：语法错或未捕获异常，测试根本没跑起来——这不是『变异被抓住了』" };
  }
  if (ran === 0) return { verdict: "empty", ran, pass, fail, why: "模式匹配到 0 条测试：空跑的绿灯" };
  return { verdict: fail > 0 ? "red" : "green", ran, pass, fail, why: "" };
}

// 判读器自己先过一次对照表：它没资格在没被验证的情况下验证别人。
// 每条都是"临时打印错的数，但**不改退出码**"——正是要看双向印证咬不咬得住。
const SELFTEST = [
  { status: 1, out: "\nℹ tests 1\nℹ pass 0\nℹ fail 1\n", want: "red", why: "真红" },
  { status: 0, out: "\nℹ tests 1\nℹ pass 1\nℹ fail 0\n", want: "green", why: "真绿" },
  { status: 0, out: "\nℹ tests 3\nℹ pass 1\nℹ fail 2\n", want: "harness-error", why: "退 0 但 bad>0" },
  { status: 1, out: "\nℹ tests 3\nℹ pass 3\nℹ fail 0\n", want: "harness-error", why: "退非 0 但 bad=0" },
  { status: 1, out: "SyntaxError: missing ) after argument list\n", want: "harness-error", why: "计数行整个没了" },
  { status: 0, out: "\nℹ tests 1\nℹ pass 0\nℹ failing 1\n", want: "harness-error", why: "字段改名（fail→failing）" },
  { status: 0, out: "\nℹ tests 0\nℹ pass 0\nℹ fail 0\n", want: "empty", why: "匹配到 0 条" },
];

function runSelftest() {
  let bad = 0;
  for (const t of SELFTEST) {
    const got = classify(t.status, t.out);
    const ok = got.verdict === t.want;
    if (!ok) bad++;
    console.log(`${ok ? "  ok " : "  ✗✗"} classify(退 ${t.status}, ${t.why}) = ${got.verdict}（应为 ${t.want}）${got.why ? "｜" + got.why : ""}`);
  }
  return bad;
}

function runTest(pattern, suite) {
  const r = spawnSync(process.execPath, ["--test", "--test-name-pattern", pattern, suite || "test/claims.test.js"], {
    cwd: ROOT, encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const c = classify(r.status, out);
  return {
    ...c,
    // 把断言消息原文抓出来：只报"红了"不够，要看得见红在哪条判据上
    msg: (out.match(/AssertionError[^\n]*/) || [])[0] || "",
    raw: out,
    detail: (out.match(/(并发出现[^\n]*|自称赢[^\n]*|TTL 必须是[^\n]*|被拒的 release[^\n]*|被挡住必须留痕[^\n]*|退码表与代码不符[^\n]*|这些退码在[^\n]*|那一行没[^\n]*|第\d+次：脏锁[^\n]*|躺了 \d+s 的脏锁[^\n]*|locks 自己崩了[^\n]*|应判脏锁[^\n]*|实退 \d+[^\n]*|就该收手[^\n]*|一复查就该收手[^\n]*|持板锁期间又去取[^\n]*|不许绕过 writeBoard[^\n]*|板锁仍未被回收[^\n]*|回收写完还留着[^\n]*|seal 里出现了板级读取[^\n]*|那不是过期回收[^\n]*|本地刚落地的锁[^\n]*|mtime 单独说了算[^\n]*|字段残缺的锁[^\n]*|板锁被一个死名字持着[^\n]*|已过期的锁必须在现状里写明[^\n]*)/) || [])[1] || "",
  };
}

// 锚点必须对行尾符免疫。今天这四个文件在工作区里都是 LF（实测 CRLF 计数=0），
// 但仓里 core.autocrlf=true 且没有 .gitattributes：换一次检出就可能全是 CRLF。
// 多行锚点一旦撞上 CRLF 就"锚点没命中"——那比报红更危险：
// 报的是"我测不到"，很容易被读成"我测过没测到"。
function pairOf(src, from, to) {
  for (const nl of ["\n", "\r\n"]) {
    const f = from.split("\n").join(nl);
    if (src.includes(f)) return [f, to.split("\n").join(nl)];
  }
  return null;
}

// RELAY_ONLY="M15,M16"：只跑其中几条。追因时"改一处要等 40 秒"会让人放弃验证，
// 而放弃验证的代价正是这类假绿灯。
const ONLY = (process.env.RELAY_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const TODO = ONLY.length ? MUT.filter((m) => ONLY.some((o) => m.name.startsWith(o))) : MUT;
if (ONLY.length && !TODO.length) { console.error(`!! RELAY_ONLY 没匹配到任何变异：${ONLY.join(",")}`); process.exit(EXIT_CODES.badUsage); }

// 判读器先自证：它没资格在没被验证的情况下验证别人。
// 这一步失败就**不去跑 35 处变异**——汇总器自己都不可信时，任何"全红"都不能引用。
const selfBad = runSelftest();
if (selfBad) {
  console.error(`\n!! classify 对照表有 ${selfBad} 条判错，停下，不出变异结论。`);
  process.exit(EXIT_CODES.harness);
}
if (process.argv.includes("--selftest-only")) { console.log("=== 判读器对照表全过（只跑了自测）==="); process.exit(0); }
console.log("");

let allRed = true;
let harness = 0, empty = 0, green = 0, missed = 0;
const verdicts = [];   // 每条变异最终判成什么，独立于上面的计数器
for (const m of TODO) {
  const bak = m.file + ".bak-red";
  copyFileSync(m.file, bak);
  const src = readFileSync(m.file, "utf8");
  let patched = src;
  let missedAnchor = null;
  if (m.file === DEMO) {
    console.error(`!! ${m.name}：不许拿 red-demo 自己当变异对象（自指锚点会先命中自己的 pairs）`);
    process.exit(EXIT_CODES.badUsage);
  }
  for (const [from, to] of m.pairs) {
    if (from === to) {
      console.error(`!! ${m.name}：某处 pairs 的 from 与 to 完全相同——这是空变异，不算测过`);
      process.exit(EXIT_CODES.badUsage);
    }
    const pair = pairOf(patched, from, to);
    if (!pair) { missedAnchor = from; break; }
    patched = patched.replace(pair[0], pair[1]);
  }
  if (missedAnchor) {
    console.log(`!! ${m.name}\n   变异锚点没命中：${missedAnchor}\n   跳过——锚点没命中的话，报绿不算证据\n`);
    allRed = false; missed++; verdicts.push("anchor-missed");
    rmSync(bak);
    continue;
  }
  writeFileSync(m.file, patched);
  // 写完立刻回读：变异没落地时，"绿"是变异器的绿，不是代码的绿。
  // M15 就撞上过这一次——现场手工打同一个变异行为明确变了，变异器却报绿，
  // 差别只能出在"补丁到底有没有写进去"。
  const back = readFileSync(m.file, "utf8");
  if (back === src) {
    console.log(`!! ${m.name}\n   写盘后回读与原文一致——变异根本没落地，这条不算测过\n`);
    rmSync(m.file); copyFileSync(bak, m.file); rmSync(bak);
    allRed = false; harness++; verdicts.push("not-landed");
    continue;
  }
  const res = runTest(m.test, m.suite);
  rmSync(m.file);
  copyFileSync(bak, m.file);
  rmSync(bak);
  const icon = { red: "红 ✓", green: "绿 ✗ 假绿灯！", empty: "空跑 ✗ 一条都没匹配到", "harness-error": "测具 ✗ 状态与计数不互相印证" }[res.verdict];
  console.log(`${icon}  ${m.name}`);
  console.log(`   套件 ${m.suite || "test/claims.test.js"} 匹配「${m.test}」：跑到 ${res.ran} 条，pass=${res.pass} fail=${res.fail}${res.why ? `｜${res.why}` : ""}`);
  console.log(`   断言原文：${(res.detail || res.msg || "（未匹配到）").slice(0, 200)}`);
  // 非红的一切情形都要把原始输出摊开：靠猜修不动"到底是断言没咬住还是我没跑起来"。
  if (res.verdict !== "red") console.log(`   原始输出（末 22 行）：\n${res.raw.split("\n").slice(-22).map((l) => "     " + l).join("\n")}`);
  console.log("");
  verdicts.push(res.verdict);
  if (res.verdict === "green") { allRed = false; green++; }
  if (res.verdict === "empty") { allRed = false; empty++; }
  if (res.verdict === "harness-error") { allRed = false; harness++; }
  if (readFileSync(m.file, "utf8") !== src) { console.log("!! 还原失败，停下"); process.exit(EXIT_CODES.badUsage); }
}
// RELAY_ONLY 时不能报"35 处全部红"——那是把跑过的条数说成全部。
const scope = ONLY.length ? `按 RELAY_ONLY 只跑了 ${TODO.length}/${MUT.length} 处：` : "";
const notRed = green + empty + harness + missed;
const tally = `（红 ${TODO.length - notRed}／绿 ${green}／空跑 ${empty}／测具不可信 ${harness}／锚点没命中 ${missed}）`;
console.log(allRed ? `=== ${scope}${TODO.length} 处变异全部把测试打红 ${tally}===`
  : `=== 结论不成立 ${tally}。绿=断言没咬住；空跑=模式没匹配；测具不可信=状态与计数不互相印证或计数行读不到 ===`);
// 汇总器自己也要留一行机读结论：bad 是"这一批里没有一条断言咬住的次数"，
// 读不到这行 = 这次跑不能引用（正是隔壁仓实出来的那个形状）。
const raw = verdicts.filter((v) => v !== "red").length;   // 现场重算：与上面那组计数器互相印证
const code = harness > 0 ? EXIT_CODES.harness : raw > 0 ? EXIT_CODES.notAllRed : EXIT_CODES.allRed;
const summary = {
  kind: "red-demo", rounds: TODO.length, measured: TODO.length, lost: notRed,
  green, emptyCount: empty, harness, missedAnchor: missed,
  code, codes: [...new Set(Object.values(EXIT_CODES))],
};
printSummary(summary);
// crossCheck 只认"0 / 非 0"两种状态，所以把 7、8 折成非 0 的 1 再印证：
// 报出去的统计与最终退码必须是同一个判断的两半。
const why = crossCheck(code === 0 ? 0 : 1, { reported: summary.lost, raw, expect: TODO.length, measured: TODO.length });
if (why) console.error(`!! 汇总器自身不自洽：${why}`);
// 退出码分档：7 单独留给"测具自己在骗人"——它和"缺陷没被抓住"处置完全不同，
// 前者要先修判读器，后者才轮到改代码或补断言。
process.exit(why ? HARNESS_EXIT : code);

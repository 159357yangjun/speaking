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
    pairs: [["  for (const m of markersFor(p, c.at)) d = Math.max(d, m.at + (m.ttl || c.ttl) * 1000);",
             "  void p;   // 变异：标记不参与到期计算"]],
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
    raw: out,
    detail: (out.match(/(并发抢占出现[^\n]*|自称赢[^\n]*|TTL 必须是[^\n]*|被拒的 release[^\n]*|被挡住必须留痕[^\n]*|退码表与代码不符[^\n]*|这些退码在[^\n]*|那一行没[^\n]*|第\d+次：脏锁[^\n]*|躺了 \d+s 的脏锁[^\n]*|locks 自己崩了[^\n]*|应判脏锁[^\n]*|实退 \d+[^\n]*|就该收手[^\n]*|一复查就该收手[^\n]*)/) || [])[1] || "",
  };
}

// 锚点必须对行尾符免疫：src/claims/lock.js 全文 CRLF，README.md 是 LF，
// 而多行锚点用 \n 写的——不处理的话 M9/M11 会"锚点没命中"，
// 那比报红更危险：报的是"我测不到"，很容易被读成"我测过没测到"。
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
if (ONLY.length && !TODO.length) { console.error(`!! RELAY_ONLY 没匹配到任何变异：${ONLY.join(",")}`); process.exit(9); }

let allRed = true;
for (const m of TODO) {
  const bak = m.file + ".bak-red";
  copyFileSync(m.file, bak);
  const src = readFileSync(m.file, "utf8");
  let patched = src;
  let missed = null;
  for (const [from, to] of m.pairs) {
    const pair = pairOf(patched, from, to);
    if (!pair) { missed = from; break; }
    patched = patched.replace(pair[0], pair[1]);
  }
  if (missed) {
    console.log(`!! ${m.name}\n   变异锚点没命中：${missed}\n   跳过——锚点没命中的话，报绿不算证据\n`);
    allRed = false;
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
    allRed = false;
    continue;
  }
  const res = runTest(m.test, m.suite);
  rmSync(m.file);
  copyFileSync(bak, m.file);
  rmSync(bak);
  // 模式名匹配不到任何测试时，node --test 退出码是 0：那是一条**空跑的绿灯**。
  // 上一轮就吃过这个亏，所以这里把"跑到几条"一起判掉。
  const empty = res.ran === "0" || res.ran === undefined;
  console.log(`${res.red && !empty ? "红 ✓" : "绿 ✗ 假绿灯！"}  ${m.name}`);
  console.log(`   套件 ${m.suite || "test/claims.test.js"} 匹配「${m.test}」：跑到 ${res.ran} 条，pass=${res.pass} fail=${res.fail}`);
  console.log(`   断言原文：${(res.detail || res.msg || "（未匹配到）").slice(0, 200)}`);
  // 变异器报绿、而现场证明行为变了——这种矛盾必须把原始输出摊开，否则下一步只能靠猜。
  if (!res.red || empty) console.log(`   原始输出（末 22 行）：\n${res.raw.split("\n").slice(-22).map((l) => "     " + l).join("\n")}`);
  console.log("");
  if (!res.red || empty) allRed = false;
  if (readFileSync(m.file, "utf8") !== src) { console.log("!! 还原失败，停下"); process.exit(9); }
}
console.log(allRed ? `=== ${MUT.length} 处变异全部把测试打红 ===` : "=== 有变异没打红、空跑或没命中，结论不成立 ===");
process.exit(allRed ? 0 : 8);

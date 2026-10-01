#!/usr/bin/env node
// 测具自己的证伪脚本：证明"双向印证"不是装饰。
// 用法：node tools/claims/selfcheck-harness.mjs <仓库绝对路径>
//
// 通令来源（2026-09-30，隔壁仓实出来的一次自骗）：一串变异 / 一个探针如果
//   · 阶段状态只取退出码，
//   · 计数行只当展示，
// 那么打印方一改字段名，判读方正则失配，"读不到计数"与"计数为 0"就长得一模一样，
// 汇总器会报出 `PASSED count: NOT REPORTED` 然后自己被当成通过。
//
// 本脚本造的就是那个现场：**只把对外打印的计数改错，退码推导一行都不碰**。
// 两个方向各来一次，因为本仓有两种约定——只演示一种的话，另一半规则从没开过火：
//   面 A 探针约定（0 = 抓到缺陷）：真有丢行(raw>0) 却对外打印 lost=0 ⇒ 必须判"测具不可信"
//   面 B 汇总器约定（0 = 全绿）  ：有变异没咬住(raw>0) 却对外打印 lost=0 ⇒ 同样必须翻脸
// 任何一面没被抓到，本脚本就退非 0：说明那个印证只在原地好看，不咬人。
//
// 只改临时副本，不动在库文件。副本必须是一棵**能解析相对导入的小树**：
// `<tmp>/tools/claims/*` + `<tmp>/src/**` + `<tmp>/README.md`，并把 `<tmp>` 当 ROOT 传给被检工具。
// 只拷 tools/claims 是不够的——判读模块在 src/claims 下，相对路径会指到 tmp 外面去。
// README 也得拷：red-demo 有一处变异的靶子就是 README，而它现在还要从 ROOT 读"测试总数"那一行
// 来构造锚点（本轮就是漏了这一步，面 B 直接崩在 readFileSync，报的是"没咬住"而不是"咬不住"——
// 差别正是要点：一棵装不全的树会让证伪脚本自己变成假信号）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printSummary, parseSummary, crossCheck, HARNESS_EXIT, SUMMARY_PREFIX } from "../../src/claims/summary.js";

/**
 * 撕行的切点：**按长度取中点，并要求它落在行内**。
 * 上一版这里钉的是绝对偏移 40——那在当时的行上是行内，可一旦字段顺序或值变了、
 * 整行短到 40 以内，`slice(0,40)` 就是整行本身：那次"撕"根本没撕，而判读侧不抛，
 * 于是这一面会从"咬住"变成"静默通过"。取中点让这个靶子随行长自动走。
 * 返回 null = 这行撕不动（太短 ⇒ 中点落在前缀里或行外），调用方必须把这一面判成"没验过"而不是"过了"。
 */
export function tearPoint(line) {
  const prefixLen = `${SUMMARY_PREFIX} `.length;
  const mid = Math.floor(String(line).length / 2);
  return mid > prefixLen && mid < String(line).length ? mid : null;
}

// 退 10 那一族的现场取证：失败那一刻 %TEMP% 下有多少棵 relay-* 临时树、都是谁的。
// 上限 6 条 + 按前缀计数（打印必须有上限，否则诊断自己变成第二个 .verify/）。
function relayTempCensus() {
  const t = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(t).filter((n) => n.startsWith("relay-")); }
  catch (e) { return [`读不到 %TEMP%（${e.code || e.message}）`]; }
  const byPrefix = {};
  const now = Date.now();
  const aged = names.map((n) => {
    const head = n.replace(/-?[A-Za-z0-9]{6}$/, "-*");
    byPrefix[head] = (byPrefix[head] || 0) + 1;
    let age = -1;
    try { age = Math.round((now - fs.statSync(path.join(t, n)).mtimeMs) / 1000); } catch { }
    return `${n}${age >= 0 ? `(${age}s)` : ""}`;
  });
  return [`总=${names.length}`, ...Object.entries(byPrefix).map(([k, v]) => `${k}×${v}`), ...aged.slice(0, 6)];
}

// 退码声明表（见 board-race.mjs 同名表的注释）
const EXIT_CODES = { bothCaught: 0, notCaught: 8, badUsage: 9, harness: HARNESS_EXIT };

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("用法：node tools/claims/selfcheck-harness.mjs <仓库绝对路径>");
  process.exit(EXIT_CODES.badUsage);
}

function sabotage(target, patch) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-selfcheck-"));
  const dir = path.join(tmp, "tools", "claims");
  fs.cpSync(path.join(ROOT, "tools", "claims"), dir, { recursive: true });
  fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });
  // README 也进树：red-demo 从 ROOT 读 `测试总数 **N**` 来构造它那条文档变异锚点。
  // 少了这一步，面 B 会在 red-demo 的 readFileSync 里崩成 exit 1——一个"装不全的副本"
  // 表现出来却像"印证没咬住"，那是测具自己造的假信号，比没测更糟。
  fs.copyFileSync(path.join(ROOT, "README.md"), path.join(tmp, "README.md"));
  const file = path.join(dir, target);
  const before = fs.readFileSync(file, "utf8");
  patch(file, before);
  // 回读比对用**动手前读到的那份原文**。上一版改成"从仓库路径反推副本路径再读原件"，
  // 一跨目录就 ENOENT：验证 sabotage 落地这件事自己先崩，什么也没证明。
  if (fs.readFileSync(file, "utf8") === before) {
    console.error(`!! ${target} 的 sabotage 写盘后回读与原文一致：改动没落地，这次的『两个方向都被抓到』是假的`);
    process.exit(EXIT_CODES.badUsage);
  }
  return { tmp, file };
}

const CASES = [
  {
    name: "面 A｜探针约定（0=抓到缺陷）：raw>0 却对外打印 lost=0",
    // --unlocked 才有真丢行：raw=3 ⇒ 退码仍按 raw 取 0；汇总行谎报 lost=0
    target: "board-race.mjs",
    patch(file, src) {
      const out = src.replace("  lost: lost.length,", "  lost: 0,   //  sabotage：只改对外报的数");
      if (out === src) { console.error("!! 面 A 的锚点没命中（lost: lost.length,）"); process.exit(EXIT_CODES.badUsage); }
      fs.writeFileSync(file, out);
    },
    run: (file, tmp) => spawnSync(process.execPath, [file, tmp, "3", "--inject=600", "--unlocked"], { encoding: "utf8", cwd: tmp }),
  },
  {
    name: "面 B｜汇总器约定（0=全绿）：有变异没咬住却对外打印 lost=0",
    // 两处 sabotage：① 往 MUT 数组开头插一条"锚点永不命中"的变异 ⇒ 制造 notRed>0（退码本应是 8）；
    //                ② 只把对外报出的那个数改成 0，退码推导一行都不碰。
    // 锚点只挑**结构性**的两处（数组开头、汇总行的字段名）。上一版借的是 M30 打在业务行上的锚点，
    // deadlineOf 一改文案它就静默失配（本轮真失配过一次）——那时它至少还报了"sabotage 没落地"退 9，
    // 那才是这一面该有的样子：证伪脚本自己也要能被证伪。
    target: "red-demo.mjs",
    patch(file, src) {
      const A = ["const MUT = [",
        'const MUT = [\n  { name: "面B临时变异（锚点永不命中）", file: LOCK, pairs: [["  const NEVER_MATCHES_X = 1;", "  const NEVER_MATCHES_X = 2;"]], test: "真红", suite: "test/claims.test.js" },'];
      const B = ['kind: "red-demo", rounds: TODO.length, measured: TODO.length, lost: notRed,',
                 'kind: "red-demo", rounds: TODO.length, measured: TODO.length, lost: 0,'];
      let out = src.replace(A[0], A[1]);
      out = out.replace(B[0], B[1]);
      for (const [needle, tag] of [[A[1], "sabotage-A"], [B[1], "sabotage-B"]]) {
        if (!out.includes(needle)) {
          console.error(`!! 面 B 的 ${tag} 锚点没命中：${needle.slice(0, 60)}…`);
          console.error("   停下：sabotage 没落地时，『几个面都被抓到』是假的。");
          process.exit(EXIT_CODES.badUsage);
        }
      }
      fs.writeFileSync(file, out);
    },
    run: (file, tmp) => spawnSync(process.execPath, [file, tmp],
      { encoding: "utf8", cwd: tmp, env: { ...process.env, RELAY_ONLY: "面B临时变异" } }),
  },
  {
    name: "面 C｜行数契约：同一 kind 印了两条（退码没变，两份数并存）",
    // 重试路径再打一行、finally 里补一行都会造成这个形状。判读方若"取最后一条"或"取第一条"，
    // 拿到的就是一个看起来完全合法的数——所以契约是恰好一条，多了要抛。
    target: "board-race.mjs",
    patch(file, src) {
      const extra = "printSummary({ ...summary, lost: 999, code: 0 });   // sabotage-C：多印一条";
      const out = src.replace("printSummary(summary);", "printSummary(summary);".concat("\n", extra));
      if (out === src) { console.error("!! 面 C 的锚点没命中（printSummary(summary);）"); process.exit(EXIT_CODES.badUsage); }
      fs.writeFileSync(file, out);
    },
    run: (file, tmp) => spawnSync(process.execPath, [file, tmp, "2", "--inject=600", "--unlocked"], { encoding: "utf8", cwd: tmp }),
    // 这一面不看退码：退码本来就不该变。看的是"读这份输出会不会拿到一个数"。
    judge: (r) => {
      try { parseSummary(r.stdout || "", "board-race", ["lost", "code"]); return [false, "两条汇总行被照单接受了（parseSummary 没抛）⇒ 读的人会拿其中任意一条当结论"]; }
      catch (e) { return [true, `抛了：${String(e.message).split(String.fromCharCode(10))[0].slice(0, 120)}`]; }
    },
  },
  {
    name: "面 D｜行数契约：汇总行被 stdout 刷新拆成两段",
    // 不用起子进程：拆行是字符串层面的事，构造出来即可，省掉一次调度抖动。
    target: null,
    patch() {},
    run: () => ({ stdout: `${printSummary({ kind: "board-race", rounds: 2, measured: 2 })}
`, status: 0 }),
    judge: (r) => {
      // 上面那行是完整 JSON，先确认它能读；再把它从中间截断，模拟被别的写者插进一行
      const whole = r.stdout.trim();
      // 两面自检：**短行必须撕不动**（tearPoint 返 null），**长行必须有行内切点**。
      // 只测长行那一面的话，"守卫被摘掉"这件事没有任何东西能发现——它只会一直绿。
      const shortLine = `${SUMMARY_PREFIX} {}`;
      const pShort = tearPoint(shortLine);
      if (pShort !== null) {
        return [false, `撕点守卫失效：短行 '${shortLine}'（长度 ${shortLine.length}）被判成可撕（切点 ${pShort}）` +
          `⇒ 那次"撕"可能根本没撕，这面从此只会一直绿`];
      }
      const cut = tearPoint(whole);
      if (cut === null) {
        return [false, `这一面这次撕不动（行长 ${whole.length}，中点落在前缀里或行外）` +
          `⇒ 判"没验过"，不算咬住——把没量到当通过是本仓反复犯的那一族`];
      }
      const torn = `${whole.slice(0, cut)}
${whole.slice(cut)}`;
      try { parseSummary(whole, "board-race", ["rounds"]); } catch (e) { return [false, `完整行反而读不了：${e.message}`]; }
      try { parseSummary(torn, "board-race", ["rounds"]); return [false, `半截 JSON 被接受了（应当抛）｜切点=${cut}/${whole.length}`]; }
      catch (e) { return [true, `抛了：${String(e.message).split(String.fromCharCode(10))[0].slice(0, 120)}` +
        `｜撕点=中点 ${cut}/${whole.length}（不是绝对偏移，行长变了它跟着走）`]; }
    },
  },
  {
    name: "面 E｜第二把尺子：reported 与 raw 同源且一起说谎（只有独立来源能抓到）",
    // has1/has2 是判据用的布尔，primary(lost) 与 raw 都从它们算出来 ⇒ crossCheck 永远一致。
    // 把它们钉成 true 就是"两把同源尺子一起错"。抓得住的只有来源不同的第二把尺子：
    // countToken 用的令牌值来自 claim 的 stdout，不是从板子上读出来的。
    target: "board-race.mjs",
    patch(file, src) {
      const from = "  const has1 = n1 === 1, has2 = n2 === 1;";
      const to = "  const has1 = true, has2 = true;   // sabotage-E：两把同源尺子一起说谎";
      const out = src.replace(from, to);
      if (out === src) { console.error("!! 面 E 的锚点没命中（has1 = n1 === 1）"); process.exit(EXIT_CODES.badUsage); }
      fs.writeFileSync(file, out);
    },
    run: (file, tmp) => spawnSync(process.execPath, [file, tmp, "2", "--inject=600", "--unlocked"], { encoding: "utf8", cwd: tmp }),
  },
];

let caught = 0;
let ran = 0;
for (const c of CASES) {
  const { tmp, file } = c.target ? sabotage(c.target, c.patch) : { tmp: null, file: null };
  const r = c.run(file, tmp);
  const out = (r.stdout || "") + (r.stderr || "");
  const sum = (out.match(/^RELAY-SUMMARY .*$/m) || ["（没打到汇总行）"])[0];
  // 面 A/B 的判据是"被判读器印证的退码"，不是"非零"：崩在 import 阶段也非零，那不算抓到。
  // 面 C/D 的判据不是退码（退码本来就不该变），而是"这份输出能不能被读成一个数"。
  const verdict = c.judge ? c.judge(r) : [r.status === EXIT_CODES.harness, `退出码 ${r.status}（期望 ${EXIT_CODES.harness}）`];
  const ok = verdict[0];
  // 取**最后**一条 !!：锚点/用法报错也在前面，真正的判读结论是最后那句。
  const whyLine = out.split(/\r?\n/).filter((l) => l.trimStart().startsWith("!!")).pop() ?? "（没有 !! 那一行：印证没说话）";
  console.log(`${ok ? "咬住 ✓" : "没咬住 ✗"}  ${c.name}`);
  console.log(`   判据 = ${verdict[1]}`);
  console.log(`   汇总行 = ${sum.slice(0, 200)}`);
  console.log(`   判读原文 = ${whyLine.slice(0, 200)}`);
  if (!ok) {
    // 偶发的"某面没咬住"只留上面那三行是分不出原因的：分不清是被检工具真没翻脸，
    // 还是它压根没跑到那一步（ENOENT、锚点没落地、临时副本装不全都会长得一样）。
    // 所以没咬住时把那一次运行的原文尾部摊出来；成功时不摊，免得把 5 面输出泡在水里。
    // 尾部 10 行还不够：退 10（文件系统失败）那句 `文件系统拒绝 rename（EPERM：…）` 会出现在
    // **任意位置**，而收尾那几行永远是判据与汇总——所以先按 errno 扫全文，再摊尾部兜底。
    const errnoLines = out.split(/\r?\n/).filter((l) =>
      /文件系统拒绝|EPERM|ENOENT|EBUSY|ENOTEMPTY|EMFILE|EACCES|被拒那家/.test(l));
    if (errnoLines.length) {
      console.log("   errno 扫描（全文，不是尾部窗口）：");
      for (const l of errnoLines.slice(0, 6)) console.log("     " + l.slice(0, 190));
    } else {
      console.log("   errno 扫描：没匹配到任何 errno 行（那这次的退 10/退 4 就不是文件系统层的事）");
    }
    console.log(`   现场：%TEMP% 此刻 relay-* = ${relayTempCensus().join(", ")}`);
    console.log("   那一次运行的原文尾部：");
    for (const l of out.split(/\r?\n/).slice(-10)) console.log("     " + l.slice(0, 170));
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  ran++;                                     // 跑到数与咬住数是两件事：一件没咬住不等于它没跑
  if (ok) caught++;
}

const raw = CASES.length - caught;                       // 现场重算：没被抓到的面数
const code = raw > 0 ? EXIT_CODES.notCaught : EXIT_CODES.bothCaught;
const summary = {
  kind: "selfcheck-harness", rounds: CASES.length, measured: ran, caught,
  lost: raw, code, codes: [...new Set(Object.values(EXIT_CODES))],
};
console.log("");
console.log(code === EXIT_CODES.bothCaught
  ? `=== ${caught}/${CASES.length} 面都被双向印证抓到 ===`
  : `=== 只抓到 ${caught}/${CASES.length} 面：印证有半边是装饰，结论不成立 ===`);
printSummary(summary);
// 本脚本也遵守同一条规矩：报出去的面数必须等于现场重算的，且与退码互相印证。
// 旧版把 `measured` 填成 caught ⇒ 任何"有一面没咬住"都会额外触发"样本数不齐"，
// 于是 8（印证是装饰）这一档永远到不了，报出去的都是 9（测具不可信）。
// 现在 measured=跑到数，另加一条恒等式：咬住数 + 没咬住数 必须等于跑到数 = 安排数。
const why = crossCheck(code, { reported: summary.lost, raw, expect: CASES.length, measured: ran })
  || (caught + raw === ran && ran === CASES.length
    ? null
    : `恒等式不成立：安排 ${CASES.length}、跑到 ${ran}、咬住 ${caught}、没咬住 ${raw}（四者凑不齐，这份计数是拼出来的）`);
if (why) console.error(`!! 本脚本自身不自洽：${why}`);
process.exit(why ? EXIT_CODES.harness : code);

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
// `<tmp>/tools/claims/*` + `<tmp>/src/**`，并把 `<tmp>` 当 ROOT 传给被检工具。
// 只拷 tools/claims 是不够的——判读模块在 src/claims 下，相对路径会指到 tmp 外面去。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printSummary, parseSummary, crossCheck, HARNESS_EXIT } from "../../src/claims/summary.js";

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
      const torn = `${whole.slice(0, 40)}
${whole.slice(40)}`;
      try { parseSummary(whole, "board-race", ["rounds"]); } catch (e) { return [false, `完整行反而读不了：${e.message}`]; }
      try { parseSummary(torn, "board-race", ["rounds"]); return [false, "半截 JSON 被接受了（应当抛）"]; }
      catch (e) { return [true, `抛了：${String(e.message).split(String.fromCharCode(10))[0].slice(0, 120)}`]; }
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
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (ok) caught++;
}

const raw = CASES.length - caught;                       // 现场重算：没被抓到的面数
const code = raw > 0 ? EXIT_CODES.notCaught : EXIT_CODES.bothCaught;
const summary = {
  kind: "selfcheck-harness", rounds: CASES.length, measured: caught,
  lost: raw, code, codes: [...new Set(Object.values(EXIT_CODES))],
};
console.log("");
console.log(code === EXIT_CODES.bothCaught
  ? `=== ${caught}/${CASES.length} 面都被双向印证抓到 ===`
  : `=== 只抓到 ${caught}/${CASES.length} 面：印证有半边是装饰，结论不成立 ===`);
printSummary(summary);
// 本脚本也遵守同一条规矩：报出去的面数必须等于现场重算的，且与退码互相印证。
const why = crossCheck(code, { reported: summary.lost, raw, expect: CASES.length, measured: caught });
if (why) console.error(`!! 本脚本自身不自洽：${why}`);
process.exit(why ? EXIT_CODES.harness : code);

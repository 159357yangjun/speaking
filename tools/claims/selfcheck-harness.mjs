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
import { printSummary, crossCheck, HARNESS_EXIT } from "../../src/claims/summary.js";

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
    // 两处 sabotage：① 让 M30 的锚点不可能命中（制造"有变异没咬住"⇒ 退码本应是 8）；
    //                ② 只把对外报出的那个数改成 0，退码推导不碰。
    target: "red-demo.mjs",
    patch(file, src) {
      const A = ['pairs: [["  let d = Math.max(Number(c.at) || 0, safeMtime(p)) + c.ttl * 1000;",',
                 'pairs: [["  XX 这个锚点在本仓不存在（sabotage-A：制造一条没咬住的变异）",'];
      const B = ['kind: "red-demo", rounds: TODO.length, measured: TODO.length, lost: notRed,',
                 'kind: "red-demo", rounds: TODO.length, measured: TODO.length, lost: 0, // sabotage-B：只改对外报的数'];
      let out = src.replace(A[0], A[1]);
      out = out.replace(B[0], B[1]);
      for (const [needle, tag] of [[A[1], "sabotage-A"], [B[1], "sabotage-B"]]) {
        if (!out.includes(needle)) {
          console.error(`!! 面 B 的 ${tag} 锚点没命中：${needle.slice(0, 60)}…`);
          console.error("   停下：sabotage 没落地时，『两个方向都被抓到』是假的。");
          process.exit(EXIT_CODES.badUsage);
        }
      }
      fs.writeFileSync(file, out);
    },
    run: (file, tmp) => spawnSync(process.execPath, [file, tmp], { encoding: "utf8", cwd: tmp, env: { ...process.env, RELAY_ONLY: "M30" } }),
  },
];

let caught = 0;
for (const c of CASES) {
  const { tmp, file } = sabotage(c.target, c.patch);
  const r = c.run(file, tmp);
  const out = (r.stdout || "") + (r.stderr || "");
  const sum = (out.match(/^RELAY-SUMMARY .*$/m) || ["（没打到汇总行）"])[0];
  // 判据是"被判读器印证的退码"，不是"非零"：崩在 import 阶段也非零，那不算印证抓到。
  const ok = r.status === EXIT_CODES.harness;
  // 取**最后**一条 !!：锚点/用法报错也在前面，真正的判读结论是最后那句。
  const whyLine = out.split(/\r?\n/).filter((l) => l.trimStart().startsWith("!!")).pop() ?? "（没有 !! 那一行：印证没说话）";
  console.log(`${ok ? "咬住 ✓" : "没咬住 ✗"}  ${c.name}`);
  console.log(`   退出码 = ${r.status}（期望 ${EXIT_CODES.harness}＝测具不可信）`);
  console.log(`   汇总行 = ${sum.slice(0, 200)}`);
  console.log(`   判读原文 = ${whyLine.slice(0, 200)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
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

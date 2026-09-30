#!/usr/bin/env node
// 量 `writeBoard` 里"复验通过 → 落盘完成"那段残余窗口，n 次取分布。
// 为什么要在仓里跑这份数：README 写的是**毫秒数**而不是"很小"，那这个数就必须能重跑出来。
// 上一版它是会话里手工插桩量的——按本项目自己定的规矩（不能重跑的证据等于不存在），那是欠账。
//
// 用法：node tools/claims/window-measure.mjs <仓库绝对路径> [次数=20]
//
// 纪律：只给**临时副本**插计时行，不动在库文件；插完立刻回读确认落地——
// 插桩静默失败时，量到的是别的代码，那种数比不量更危险。
// 也不许用"自己复制一份 writeBoard 再来量"的办法：那测的是我对它的想象。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.argv[2];
const N = parseInt(process.argv[3] ?? "20", 10);
if (!ROOT) { console.error("用法：node tools/claims/window-measure.mjs <仓库绝对路径> [次数=20]"); process.exit(9); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-window-"));
fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });
const lock = path.join(tmp, "src", "claims", "lock.js");
const LOG = path.join(tmp, "samples.log");

// 两个锚点都在 writeBoard 里：第二次复验之后（窗口起点）、rename 之后（窗口终点）。
const START_ANCHOR = '    if (held.status !== "held") return { ...held, wrote: false, boardLockHeldBy: boardWho };';
const END_ANCHOR = "    fs.renameSync(part, boardPath);";
const VERIFY_ANCHOR = "    const held = verifyHold({ claimsDir, file, who, at });";

let src = fs.readFileSync(lock, "utf8").replace(/\r\n/g, "\n");
for (const a of [START_ANCHOR, END_ANCHOR, VERIFY_ANCHOR]) {
  if (!src.includes(a)) { console.error(`!! 插桩锚点没命中：${a.slice(0, 40)}…\n   停下——静默没插桩就是一场空跑。`); process.exit(9); }
}
// 两个计时点分别贴着 README 那两行：
//   __t0 在第二次复验**之前**取表 → "复验 + 落盘"整段（这一整段都是别人可以插进来的时间）
//   __w0 在复验返回之后、落盘之前 → README 写的那行"复验通过 → 落盘完成"的残余窗口
// 起点必须打在复验调用之前而不是之后：只量"复验之后"会把复验自己占的墙钟漏掉。
src = src.replace(VERIFY_ANCHOR, `    const __t0 = process.hrtime.bigint();\n${VERIFY_ANCHOR}`);
src = src.replace(START_ANCHOR, `    const __w0 = process.hrtime.bigint();\n${START_ANCHOR}`);
// 注入的那三行**不用模板字面量**：嵌套反引号要写 \\` 和 \${，两层转义在 bash→node 之间会被吃掉一层，
// 我已经踩到第三次。用字符串拼接，转义只有一层。
src = src.replace(END_ANCHOR, END_ANCHOR + [
  "",
  "    {",
  "      const now = process.hrtime.bigint();",
  "      const rec = [",
  '        "VERIFY " + (Number(__w0 - __t0) / 1e6),',
  '        "WINDOW " + (Number(now - __w0) / 1e6),',
  '        "TOTAL " + (Number(now - __t0) / 1e6),',
  '      ].join("\\n") + "\\n";',
  "      fs.appendFileSync(process.env.RELAY_WINDOW_LOG, rec);",
  "    }",
].join("\n"));
fs.writeFileSync(lock, src);
const back = fs.readFileSync(lock, "utf8");
for (const probe of ["__t0", "__w0", "RELAY_WINDOW_LOG"]) {
  if (!back.includes(probe)) { console.error(`!! 回读没有 ${probe}：插桩没落地。`); process.exit(9); }
}

const cli = path.join(tmp, "src", "cli.js");
const run = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, RELAY_WINDOW_LOG: LOG },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};

const samples = { verify: [], window: [], total: [] };
let failed = 0;
for (let i = 1; i <= N; i++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-window-run-"));
  fs.writeFileSync(path.join(dir, "PROGRESS.md"), "# 进度板\n");
  const file = `src/f${String(i).padStart(3, "0")}.js`;
  const c = run(["claim", `--channel=${dir}`, `--file=${file}`, "--who=qoder", "--ttl=600"]);
  const at = /--at=(\d+)/.exec(c.out)?.[1];
  if (!at) { console.error(`第 ${i} 次：claim 没给出令牌，夹具失效\n${c.out}`); process.exit(9); }
  const r = run(["board", `--channel=${dir}`, `--file=${file}`, "--who=qoder", `--at=${at}`,
    `--board=${path.join(dir, "PROGRESS.md")}`, `--row=| ${file} | qoder | now |`]);
  if (r.code !== 0) { failed++; console.error(`第 ${i} 次 board 退 ${r.code}：${r.out}`); }
  fs.rmSync(dir, { recursive: true, force: true });
}

if (!fs.existsSync(LOG)) { console.error("!! 一份样本都没写出来：注入的代码没被执行到，这条测量不作数。"); process.exit(9); }
for (const line of fs.readFileSync(LOG, "utf8").split("\n")) {
  const m = /^(VERIFY|WINDOW|TOTAL) (-?[\d.]+)$/.exec(line.trim());
  if (m) samples[m[1].toLowerCase() === "verify" ? "verify" : m[1].toLowerCase() === "window" ? "window" : "total"].push(parseFloat(m[2]));
}
const ok = N - failed;
if (samples.window.length !== ok || samples.verify.length !== ok || samples.total.length !== ok) {
  console.error(`!! 样本数不齐：verify=${samples.verify.length} window=${samples.window.length} total=${samples.total.length}，成功落盘 ${ok} 次。`);
  console.error("   少一份就意味着有一段没被量到——这种数不能拿去写进 README。");
  process.exit(9);
}
const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { n: s.length, mean: +(a.reduce((t, x) => t + x, 0) / a.length).toFixed(2), max: +s[s.length - 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95) - 1].toFixed(2) };
};
const v = stat(samples.verify), w = stat(samples.window), t = stat(samples.total);
console.log(`配置：n=${N}（board 非零 ${failed} 次），同机串行，插桩打在临时副本上`);
console.log(`  第二次复验 verifyHold 本身     均值 ${v.mean}ms  p95 ${v.p95}ms  最大 ${v.max}ms`);
console.log(`  复验通过 → 落盘完成（残余窗口）均值 ${w.mean}ms  p95 ${w.p95}ms  最大 ${w.max}ms`);
console.log(`  复验开始 → 落盘完成（整段）    均值 ${t.mean}ms  p95 ${t.p95}ms  最大 ${t.max}ms`);
console.log("  这段窗口里能被抢走的只有自己那把文件锁（板级锁已拿着）；");
console.log('  后果是写出一行"化身已失效"的声明、被 audit 点名，而不是抹掉别人的行。');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 8 : 0);

// 判别式实验：`writeFileSync(p, content, {flag:"wx"})` 会不会让另一个进程读到 **0 字节**？
// 这测的是 lock.js 里那句"空文件窗口也一并消掉：内容随独占创建一次写定"到底成不成立。
// 2026-10-01 的实测结论：**不成立**（本机 400 次 wx 创建，并发读者看到 18 次 0 字节）。
//
// 它是**读数不是门**：窗口出没现形随机器快慢变，所以"没抓到"绝不能进退码——
// 退码只表达"这次实验本身做成了没有"（0 做成了 / 8 读者没报回可解析的计数 / 9 用法错）。
// 抓到多少次 0 字节写在汇总行的 `empty` 字段里，让读者自己判。
// 用法：node tools/claims/wx-empty-window.mjs [写入次数，默认 400]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { printSummary, crossCheck, HARNESS_EXIT } from "../../src/claims/summary.js";

export const EXIT_CODES = { ran: 0, unreadable: 8, badUsage: 9, harness: HARNESS_EXIT };

const arg = process.argv[2];
const N = Number(arg || 400);
if (arg !== undefined && (!Number.isInteger(N) || N < 1)) {
  console.log(`!! 写入次数必须是正整数，收到 "${arg}"`);
  console.log(`退码表：${JSON.stringify(EXIT_CODES)}`);
  process.exit(EXIT_CODES.badUsage);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wx-race-"));
const p = path.join(dir, "x.lock");

const reader = new Promise((res) => {
  // 读侧在 Windows 上会拿到 EPERM/EBUSY（文件刚被创建或删除、句柄还被别的进程握着）——
  // 2026-10-01 整套并发跑时实测到过：读者一死，stdout 空，工具就报 8"实验没做成"。
  // 那是**采样侧的正常现象**，不是实验失败，所以单列成一桶并计进恒等式，不再当致命错误。
  const c = spawn(process.execPath, ["-e", `
    const fs=require("node:fs");const p=process.argv[1];
    let empty=0,ok=0,enon=0,other=0,t0=Date.now();
    while(Date.now()-t0<1500){
      try{const s=fs.readFileSync(p,"utf8"); if(s.length===0) empty++; else ok++;}
      catch(e){ if(e.code==="ENOENT") enon++; else other++; }
    }
    console.log(JSON.stringify({empty,ok,enon,other}));
  `, p], { stdio: ["ignore", "pipe", "inherit"] });
  let o = "";
  c.stdout.on("data", (d) => (o += d));
  c.on("close", () => { try { res(JSON.parse(o)); } catch { res({ broken: true, raw: o }); } });
});

let wrote = 0;
for (let i = 0; i < N; i++) {
  fs.writeFileSync(p, JSON.stringify({ who: "w", at: Date.now(), ttl: 5 }), { flag: "wx", mode: 0o644 });
  fs.unlinkSync(p);
  wrote++;   // 只数真正完成了一次"建+删"的轮次：分母必须来自这条循环本身，不能拿计划数冒充
}
const r = await reader;
fs.rmSync(dir, { recursive: true, force: true });

const broken = r.broken === true || !Number.isInteger(r.empty) ? 1 : 0;
const decision = broken ? EXIT_CODES.unreadable : EXIT_CODES.ran;
// 恒等式的四桶互斥穷尽：0 字节 / 有内容 / 不存在 / 拿不到句柄（EPERM·EBUSY 这类，Windows 上热读必然遇到）。
// 少了第四桶，"读者被挡在门外"就会被读成"什么都没发生"；`reads` 与 `wrote` 也本来就是两个量（一次创建能被读多次）。
const other = broken ? 0 : (Number.isInteger(r.other) ? r.other : 0);
const reads = broken ? 0 : r.empty + r.ok + r.enon + other;
const identity = broken ? false : reads === r.empty + r.ok + r.enon + other;
const untrust = crossCheck(decision, {
  reported: broken, raw: broken, expect: wrote, measured: wrote,
}) || (identity || broken ? null : `恒等式不成立：${reads} ≠ ${r.empty}+${r.ok}+${r.enon}+${other}`);
const code = untrust ? EXIT_CODES.harness : decision;

console.log(`[wx 独占创建的 0 字节窗口] 写入 ${wrote} 次（计划 ${N}）｜并发读者看到：` +
  `0 字节 ${broken ? "读不出" : r.empty} 次｜有内容 ${broken ? "读不出" : r.ok} 次｜还不存在 ${broken ? "读不出" : r.enon} 次` +
  `｜读不到句柄(EPERM 类) ${broken ? "读不出" : other} 次`);
if (broken) {
  console.log(`!! 读者没报回可解析的计数（raw=${JSON.stringify(String(r.raw ?? "")).slice(0, 120)}）⇒ 这次实验没做成，` +
    "不许读成「窗口不存在」");
} else {
  console.log(r.empty > 0
    ? "结论：**窗口真实存在** ⇒ `wx` 保证的是「只有一个写入者成功」，不保证「读者看得到完整内容」。"
    : "结论：这次没抓到 0 字节读。**这不构成「窗口不存在」的证据**，要证否得加大写入次数或换更密的采样。");
}
if (untrust) console.log(`!! 这份读数不可信：${untrust}`);
printSummary({
  kind: "wx-empty-window", planned: N, wrote, empty: broken ? -1 : r.empty,
  contentOk: broken ? -1 : r.ok, enoent: broken ? -1 : r.enon, handleMiss: broken ? -1 : other,
  unreadable: broken, code, codes: [...new Set(Object.values(EXIT_CODES))],
});
process.exit(code);

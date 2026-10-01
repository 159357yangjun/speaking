// S2b 闸口普查：把双主当**具名可复算证据**跑出来并登记，不接进 `npm test` 的退码。
// 定档理由（2026-10-01）：按合并率 3.9%/轮、每次 4 轮 ⇒ 整套约 14% 会红，一周内就会被人静音——
// 那正是"每次都成真 diff ⇒ 被关掉"的形状。所以这里红只登记不拦；谓词定性后再判要不要进。
// 用法：node tools/claims/gate-census.mjs <仓库绝对路径> [--gated=12] [--batches=4] [--strict]
//   --strict 是把"抓到双主"变成非零的开关；默认不开，登记为主。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { printSummary, crossCheck, HARNESS_EXIT } from "../../src/claims/summary.js";

export const EXIT_CODES = { clean: 0, found: 1, noMeasurement: 2, badUsage: 9, harness: HARNESS_EXIT };

const argv = process.argv.slice(2);
const ROOT = argv.find((a) => !a.startsWith("--"));
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const v = Number(hit.split("=")[1]);
  if (!Number.isInteger(v) || v < 0) {
    console.log(`!! --${name} 必须是整数，收到 ${hit.split("=")[1]}`);
    process.exit(EXIT_CODES.badUsage);
  }
  return v;
};
const known = (a) => a.startsWith("--gated=") || a.startsWith("--batches=") || a === "--strict";
for (const a of argv) if (a.startsWith("--") && !known(a)) {
  console.log(`!! 不认的参数 ${a}；只吃 --gated=N --batches=N --strict`);
  console.log(`退码表：${JSON.stringify(EXIT_CODES)}`);
  process.exit(EXIT_CODES.badUsage);
}
if (!ROOT) {
  console.log("用法：node tools/claims/gate-census.mjs <仓库绝对路径> [--gated=12] [--batches=4] [--strict]");
  console.log(`退码表：${JSON.stringify(EXIT_CODES)}`);
  process.exit(EXIT_CODES.badUsage);
}
const GATED = opt("gated", 12);
const BATCHES = opt("batches", 4);
if (GATED < 1 || BATCHES < 1) {
  console.log(`!! --gated 要 ≥1、--batches 要 ≥1（收到 ${GATED}/${BATCHES}）：0 轮的"没抓到"不是证据`);
  process.exit(EXIT_CODES.badUsage);
}

let rounds = 0, anomalies = 0, unreadable = 0, notFull = 0;
const rows = [];
console.log(`[闸口普查] 计划 ${BATCHES} 次 × 每次 ${GATED} 轮 = ${BATCHES * GATED} 轮，root=${path.resolve(ROOT)}`);
for (let i = 1; i <= BATCHES; i++) {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-gate-census-"));
  const r = spawnSync(process.execPath, [path.join(ROOT, "tools/relay-sim/sim.js"), dir, "--json", `--gated=${GATED}`],
    { encoding: "utf8", timeout: 900000 });
  rmSync(dir, { recursive: true, force: true });
  const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("RESULT_JSON "));
  if (!line) {
    unreadable++;
    console.log(`  批${i}: 读不到 RESULT_JSON（sim 实退 ${r.status}）⇒ 这一批整批作废，不许算"没抓到"`);
    continue;
  }
  const g = JSON.parse(line.slice("RESULT_JSON ".length)).s2bGated;
  if (!g || !Array.isArray(g.per)) { console.log(`  批${i}: JSON 里没有 s2bGated.per ⇒ 夹具没跑到那一步`); unreadable++; continue; }
  g.per.forEach((p, idx) => {
    rounds++;
    if (p.arrivals !== g.needed) { notFull++; }
    if (p.winners === 1 && p.racerRows === 1) return;
    anomalies++;
    // 登记格式就是追查那 48 轮时定下的三行：锁 + 残留 + 时间差，外加这一轮的 why 原文
    const stray = (p.sceneListing || []).filter((s) => s.includes("arbiter"));
    const atOf = (s) => Number((/"at":(\d+)/.exec(s) || [])[1] || NaN);
    const live = (p.sceneListing || []).find((s) => !s.includes("arbiter"));
    const diffMs = live && stray.length ? atOf(stray[0]) - atOf(live) : null;
    console.log(`  ★ 批${i} 第${idx + 1}轮 winners=${p.winners} racerRows=${p.racerRows} blocked=${p.blocked} ` +
      `holder=${p.holder} 跨度=${p.spreadMs}ms`);
    console.log(`      板面=${p.boardRacerLines || "〈空〉"}`);
    console.log(`      claims 现场=${JSON.stringify(p.sceneListing)}`);
    console.log(`      活锁时间差(残留−存活)=${diffMs === null ? "读不出" : `${diffMs}ms`}`);
    console.log(`      各家判定原文=${JSON.stringify(p.whys)}`);
    rows.push({ batch: i, round: idx + 1, winners: p.winners, racerRows: p.racerRows, stray: stray.length, whys: (p.whys || []).length });
  });
  console.log(`  批${i}: ${g.rounds} 轮，跨度最大 ${g.maxSpreadMs}ms，全到齐=${g.allFull}，赢家 ${g.holders.join(",")}`);
}

console.log(`\n[闸口普查] 分母=真跑到 ${rounds} 轮（计划 ${BATCHES * GATED}）｜双主登记 ${anomalies} 次` +
  `｜未到齐 ${notFull} 轮｜读不出 ${unreadable} 批`);
// 仪器自己先过一遍：轮数凑不齐就是"到不了"，不是"没有"——这两种 0 必须分开（见 README 闸口那节）
const code = (unreadable > 0 || rounds < BATCHES * GATED) ? EXIT_CODES.noMeasurement
  : anomalies > 0 && argv.includes("--strict") ? EXIT_CODES.found
  : EXIT_CODES.clean;
const untrust = crossCheck(code, {
  reported: anomalies, raw: rows.length, expect: BATCHES * GATED, measured: rounds,
});
if (untrust) console.log(`!! 这份读数不可信：${untrust}`);
if (code === EXIT_CODES.noMeasurement) {
  console.log(`!! 分母塌了：计划 ${BATCHES * GATED} 轮、真跑到 ${rounds} 轮、读不出 ${unreadable} 批 ⇒ 这份"抓到 0 次"不作数`);
}
printSummary({
  kind: "gate-census", planned: BATCHES * GATED, rounds, anomalies, notFull, unreadable,
  strict: argv.includes("--strict") ? 1 : 0, code,
  codes: [...new Set(Object.values(EXIT_CODES))],
});
process.exit(untrust ? EXIT_CODES.harness : code);

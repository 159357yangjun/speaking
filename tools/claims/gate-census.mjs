// S2b 闸口普查：把双主与 MC-1-A 当**具名可复算证据**跑出来并登记。
// 定档（2026-10-01）说的是"不接进 `npm test` 的退码"，说的是套件那一侧；
// 不是"工具永远报干净"——本工具抓到事件就退 1，理由见 README 闸口那节。
// 为什么不能像上一版那样"抓到也只退 0"：那会让 crossCheck 的"退 0 却报 bad>0"判成测具不可信（实退 9），
// 于是同一次真缺陷同时被读成"登记到了"和"仪器坏了"，两边都不认账。
// 用法：node tools/claims/gate-census.mjs <仓库绝对路径> [--gated=12] [--batches=4]
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
// `--strict` 这个开关已经摘了：抓到事件直接退 1。旧写法留着会让 "--strict" 变成一个
// "看起来加了保护、其实什么都没说"的空旗子，所以它落进"不认的参数"那一档（退 9 并印原因）。
const known = (a) => a.startsWith("--gated=") || a.startsWith("--batches=");
for (const a of argv) if (a.startsWith("--") && !known(a)) {
  console.log(`!! 不认的参数 ${a}；只吃 --gated=N --batches=N（抓到事件就退 1，没有 --strict 这一档了）`);
  console.log(`退码表：${JSON.stringify(EXIT_CODES)}`);
  process.exit(EXIT_CODES.badUsage);
}
if (!ROOT) {
  console.log("用法：node tools/claims/gate-census.mjs <仓库绝对路径> [--gated=12] [--batches=4]");
  console.log(`退码表：${JSON.stringify(EXIT_CODES)}`);
  process.exit(EXIT_CODES.badUsage);
}
const GATED = opt("gated", 12);
const BATCHES = opt("batches", 4);
if (GATED < 1 || BATCHES < 1) {
  console.log(`!! --gated 要 ≥1、--batches 要 ≥1（收到 ${GATED}/${BATCHES}）：0 轮的"没抓到"不是证据`);
  process.exit(EXIT_CODES.badUsage);
}

let rounds = 0, events = 0, dbl = 0, mc1a = 0, silent = 0, unreadable = 0, notFull = 0;
let strayExpired = 0, strayUnreadable = 0;
let onlyTag = null;   // 记的是 sim 回来的 only 标记：没有它，读者分不清这数是全量跑还是快路径
const rows = [];

// 判据只住这一处（sim 交的是原始读数 at/ttl/liveMs，不再自己判一遍）：
//   dbl  = winners≠1 或 racerRows≠1 ⇒ 双主/多主现形（两家都落了笔）
//   MC-1-A = 残留那把 `.arbiter-*` 按它**自己记的** at+ttl 还没到期（liveMs>0），且 who ≠ 这一轮的存活持有者
//            ⇒ 一把还活着的锁被搬进仲裁临时名后再没归位，它的归属证据被静默摘走
//   到期残骸（liveMs≤0）与读不出的（liveMs===null）各自单列：前者是正常老化、不是缺陷，
//   后者是量具到不了——两种都不进 MC-1-A，但绝不能混成"确实没有"。
const classify = (p) => {
  const strays = p.strays || [];
  return {
    dbl: p.winners !== 1 || p.racerRows !== 1,
    foreign: strays.filter((s) => s.liveMs !== null && s.liveMs > 0 && s.who !== p.holder),
    expired: strays.filter((s) => s.liveMs !== null && s.liveMs <= 0),
    unreadable: strays.filter((s) => s.liveMs === null),
  };
};

console.log(`[闸口普查] 计划 ${BATCHES} 次 × 每次 ${GATED} 轮 = ${BATCHES * GATED} 轮，root=${path.resolve(ROOT)}`);
for (let i = 1; i <= BATCHES; i++) {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-gate-census-"));
  // 走 sim 的 --only=s2bg 快路径：一批约 4s，而不是把整支推演器跑一遍（16s）。
  // 代价写在读数里：快路径不跑 S1/S2/S2b/S3..S6，完整推演器由 sim.test.js 顶部那次整套真跑负责。
  const r = spawnSync(process.execPath,
    [path.join(ROOT, "tools/relay-sim/sim.js"), dir, "--json", "--only=s2bg", `--gated=${GATED}`],
    { encoding: "utf8", timeout: 900000 });
  rmSync(dir, { recursive: true, force: true });
  const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("RESULT_JSON "));
  if (!line) {
    unreadable++;
    console.log(`  批${i}: 读不到 RESULT_JSON（sim 实退 ${r.status}）⇒ 这一批整批作废，不许算"没抓到"`);
    continue;
  }
  const parsed = JSON.parse(line.slice("RESULT_JSON ".length));
  if (parsed.only) onlyTag = parsed.only;
  const g = parsed.s2bGated;
  if (!g || !Array.isArray(g.per)) { console.log(`  批${i}: JSON 里没有 s2bGated.per ⇒ 夹具没跑到那一步`); unreadable++; continue; }
  g.per.forEach((p, idx) => {
    rounds++;
    // 没等齐的轮不是"并发放行"，是又一次顺序派发 ⇒ 它测不到这条判据。计入分母塌，不算"没抓到"。
    if (p.arrivals !== g.needed) { notFull++; }
    const c = classify(p);
    strayExpired += c.expired.length;
    strayUnreadable += c.unreadable.length;
    if (!c.dbl && c.foreign.length === 0) return;
    events++;
    if (c.dbl) dbl++;
    if (c.foreign.length > 0) mc1a++;
    if (!c.dbl) silent++;   // 板面看着正常、只有活锁被摘走：这一类才是"静默"那一半
    console.log(`  ★ 批${i} 第${idx + 1}轮 winners=${p.winners} racerRows=${p.racerRows} blocked=${p.blocked} ` +
      `holder=${p.holder} 跨度=${p.spreadMs}ms ` +
      `判据=${[c.dbl ? "双主" : null, c.foreign.length ? `MC-1-A×${c.foreign.length}` : null].filter(Boolean).join("+")}`);
    console.log(`      板面=${p.boardRacerLines || "〈空〉"}`);
    console.log(`      还活着的仲裁残留=${JSON.stringify(
      c.foreign.map((s) => `${s.name} who=${s.who} at=${s.at} ttl=${s.ttl}s 距自己到期还有 ${s.liveMs}ms`))}`);
    if (p.sceneListing) console.log(`      claims 现场=${JSON.stringify(p.sceneListing)}`);
    console.log(`      各家判定原文=${JSON.stringify(p.whys)}`);
    rows.push({ batch: i, round: idx + 1, winners: p.winners, racerRows: p.racerRows,
      dbl: c.dbl ? 1 : 0, foreign: c.foreign.length, expired: c.expired.length, whys: (p.whys || []).length });
  });
  console.log(`  批${i}: ${g.rounds} 轮，跨度最大 ${g.maxSpreadMs}ms，全到齐=${g.allFull}，赢家 ${g.holders.join(",")}`);
}

// 分母塌 = 这份读数是"到不了"而不是"没有"：读不出批、轮数不齐、或有轮没等齐（顺序派发冒充并发）。
const collapsed = unreadable > 0 || rounds < BATCHES * GATED || notFull > 0;
const decision = events > 0 ? EXIT_CODES.found : EXIT_CODES.clean;
// crossCheck 管"状态与计数互印"；分母塌不塌是另一条判据，有自己的退码 2 与 !! 原文。
// 塌的时候把 expect 交成本轮真跑到的 rounds：让它继续管"报出去的数是不是判据用的那个数"，
// 不再冒充计划数——否则分母塌会被 crossCheck 判成"样本不齐"退 9，README 的 2 那一档永远走不到。
const untrustFromCross = crossCheck(decision, {
  reported: events, raw: rows.length, expect: collapsed ? rounds : BATCHES * GATED, measured: rounds,
});
// 恒等式不是印给人看的装饰：不成立就不许带着"抓到 N 次"退出去（否则某一类事件既不算通过也不算失败）。
const identityHolds = events === dbl + silent;
const untrust = untrustFromCross || (identityHolds ? null
  : `恒等式不成立：事件 ${events} ≠ 双主 ${dbl} + 静默 ${silent} ⇒ 有事件没被归进任何一类`);
const code = untrust ? EXIT_CODES.harness : collapsed ? EXIT_CODES.noMeasurement : decision;

console.log(`\n[闸口普查] 分母=真跑到 ${rounds} 轮（计划 ${BATCHES * GATED}）｜事件 ${events} 次` +
  `（双主 ${dbl}｜MC-1-A ${mc1a}｜其中板面正常的"静默" ${silent}）` +
  `｜到期残骸 ${strayExpired} 把｜读不出的残留 ${strayUnreadable} 把｜未到齐 ${notFull} 轮｜读不出 ${unreadable} 批`);
console.log(`[闸口普查] 恒等式：事件 ${events} = 双主 ${dbl} + 静默(只有 MC-1-A、板面正常) ${silent} ⇒ ` +
  `${dbl}+${silent}=${dbl + silent}｜${identityHolds ? "成立" : "不成立 ⇒ 已判读数不可信（退 9），不许带着它报「抓到 N 次」"}` +
  `｜MC-1-A ${mc1a} 与双主 ${dbl} 是交叉关系（可同轮共现），不许加成事件数`);
if (untrust) console.log(`!! 这份读数不可信：${untrust}`);
if (collapsed && !untrust) {
  console.log(`!! 分母塌了：计划 ${BATCHES * GATED} 轮、真跑到 ${rounds} 轮、未到齐 ${notFull} 轮、读不出 ${unreadable} 批 ⇒ ` +
    `这份"抓到 ${events} 次"不作数（到不了 ≠ 没有）`);
}
// 两个分母各自印，不许互相冒充（--only 快路径不跑 S1/S2/S2b/S3..S6）
console.log(`[闸口普查] 分母 A（本工具，--only=s2bg 快路径）=闸口轮 ${rounds}；` +
  `分母 B（完整推演器）=另由 sim.test.js 顶部那次整套真跑负责，本工具没跑过它`);
printSummary({
  kind: "gate-census", planned: BATCHES * GATED, rounds, events, dbl, mc1a, silent,
  strayExpired, strayUnreadable, notFull, unreadable,
  fastPath: onlyTag === "s2bg" ? 1 : 0, collapsed: collapsed ? 1 : 0, code,
  codes: [...new Set(Object.values(EXIT_CODES))],
});
process.exit(code);

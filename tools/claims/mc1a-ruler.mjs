// MC-1-A 的判据只住这一处（与 tools/claims/dirty-census.mjs 同族：门、普查、夹具共用一把尺子）。
// 为什么必须单独成文件：判据原来内联在 gate-census 里 ⇒ 想证明"它会分对桶"就只能真跑 50 轮并发，
// 而 50 轮里根本没有"板面正常但活锁被摘走"和"残留读不出 at/ttl"这两种样本（本轮实测各 0 个证人）。
// 没有可喂的合成靶子，这两格就只能永远空着，而空桶会被读成"结构上不可能"。
//
// 输入形状来自 sim 的原始读数（`tools/relay-sim/sim.js` 每轮交 `strays`，自己一判都不判）：
//   { winners, racerRows, holder, strays: [{ name, who, at, ttl, liveMs }] }
//   liveMs = (at + ttl*1000) − 读取那一刻的 now；at/ttl 读不出来时是 null。
import process from "node:process";

export const STRAY_MARK = ".lock.arbiter-";

// 五个桶，互斥且穷尽：
//   foreign   = 按它自己记的 at+ttl 还活着，且 who ≠ 本轮存活持有者 ⇒ **MC-1-A**（活锁的归属证据被摘走）
//   own       = 还活着、但 who 就是当前持有者本人 ⇒ 不是"摘走"（人还在位），单独一格，不许混进 foreign
//   expired   = 已到期 ⇒ 正常老化，谁都能合法抢，不是缺陷
//   unreadable= at/ttl 读不出来 ⇒ 量具到不了，与"确实没有"分开放（这是全仓那条"两种 0"的规矩）
export const BUCKETS = ["foreign", "own", "expired", "unreadable"];

export function classifyStray(s, holder) {
  if (s.liveMs === null || s.liveMs === undefined || !Number.isFinite(s.liveMs)) return "unreadable";
  if (s.liveMs > 0) return s.who !== holder ? "foreign" : "own";
  return "expired";
}

export function classifyRound(p) {
  const out = { foreign: [], own: [], expired: [], unreadable: [] };
  const strays = (p && p.strays) || [];
  for (const s of strays) out[classifyStray(s, p.holder)].push(s);
  out.dbl = p.winners !== 1 || p.racerRows !== 1;
  out.event = out.dbl || out.foreign.length > 0;
  // silent 的定义要说死：板面看着正常（不是双主）、却有活锁被摘走。
  // 它是本案"静默"二字的唯一可测形式，也是判据有没有独立自由度的那条判别式。
  out.silent = out.event && !out.dbl;
  return out;
}

// 一批轮次的汇总 + 恒等式。恒等式由这里算、由调用方拿去拦退码：
// 只印不拦的话，"某一类既不算通过也不算失败"还是会活着。
export function tallyPeriods(per) {
  const t = { rounds: 0, events: 0, dbl: 0, mc1a: 0, silent: 0, own: 0, expired: 0, unreadable: 0 };
  for (const p of per) {
    const c = classifyRound(p);
    t.rounds++;
    if (c.dbl) t.dbl++;
    if (c.foreign.length > 0) t.mc1a++;
    if (c.event) t.events++;
    if (c.silent) t.silent++;
    t.own += c.own.length;
    t.expired += c.expired.length;
    t.unreadable += c.unreadable.length;
  }
  t.identityHolds = t.events === t.dbl + t.silent;
  return t;
}

// 被独立核对的判据本身也要能单跑（`node tools/claims/mc1a-ruler.mjs` 打印桶表与一条自检）。
// isMain 的写法照抄 dirty-census.mjs（那条在本机被套件真跑过）：比 URL 后缀更稳，能吃下反斜杠 argv。
import { fileURLToPath } from "node:url";
import path from "node:path";
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const demo = [
    { winners: 1, racerRows: 1, holder: "a", strays: [{ name: "x", who: "b", liveMs: 500 }] },
    { winners: 1, racerRows: 1, holder: "a", strays: [{ name: "x", who: "b", liveMs: -1 }] },
    { winners: 2, racerRows: 2, holder: "a", strays: [{ name: "x", who: "b", liveMs: 500 }] },
  ];
  console.log(`桶定义：${BUCKETS.join(" / ")}`);
  console.log(JSON.stringify(tallyPeriods(demo)));
}

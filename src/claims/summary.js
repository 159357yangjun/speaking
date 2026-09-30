// 计数行的**打印与判读放在同一个文件**里定义。
// 起因（2026-09-30，隔壁仓实出来的同形风险）：一串变异/一个汇总器如果
//   · 阶段状态只取退出码，
//   · 计数行只当展示，
// 那么打印方一改字段名，判读方正则就失配，于是"读不到计数"和"计数为 0"长得一模一样——
// 汇总器会报 `PASSED count: NOT REPORTED`，然后自己被当成通过。
// 本仓同形的有四处：red-demo 的 35 处变异、`npm test` 的计数、三个探针各自的"几行都在"。
//
// 三条规矩在这里一次实现，四个工具共用：
//   ① 读不到计数 = 抛（汇总器据此判失败），绝不返回 null 让调用方 `?? 0`；
//   ② 状态与计数必须**双向**印证：退 0 而 bad>0 ⇒ 测具不可信；退非 0 而 bad=0 ⇒ 同样不可信；
//   ③ 计数的自洽性先查（measured 必须等于 expected，各项加起来必须等于总数）——
//      不自洽就是漏计/重计，那种数进 README 比不进更坏。
export const SUMMARY_PREFIX = "RELAY-SUMMARY";

/**
 * 打印一行机读汇总。入参就是**要被判读的那一份对象**（kind 在里面）。
 * 为什么这么定：如果打印用一份表达式、判读用另一份，那"把对外报的数改错"就抓不到——
 * 调用方必须先建这个对象、打印它、再拿**它的字段**去 crossCheck（见四个工具的收尾）。
 */
export function printSummary(fields) {
  const line = `${SUMMARY_PREFIX} ${JSON.stringify(fields)}`;
  console.log(line);
  return line;
}

/**
 * 从任意输出里取出指定 kind 的汇总行。**契约是"恰好一条"**：
 *  · 0 条 ⇒ 抛（读不到 ≠ 0）
 *  · ≥2 条 ⇒ 抛。重试路径再打一行、finally 里补一行，都会让"两份数"同时存在；
 *    这时随便取第一条还是最后一条都是**猜**，而猜出来的数长得像量出来的数。
 *  · 行被 stdout 刷新拆开 ⇒ JSON 解析失败 ⇒ 抛（消息里带上原文，否则无从下手）
 */
export function parseSummary(text, kind, requireFields) {
  const all = String(text).split(/\r?\n/).filter((l) => l.startsWith(`${SUMMARY_PREFIX} `));
  if (!all.length) {
    throw new Error(`读不到 ${SUMMARY_PREFIX} 行（kind=${kind}）——打印方改了前缀、或这一步根本没跑到打印那句`);
  }
  const hits = [];
  for (const l of all) {
    let o;
    try { o = JSON.parse(l.slice(SUMMARY_PREFIX.length + 1)); }
    catch (e) { throw new Error(`${SUMMARY_PREFIX} 行不是合法 JSON：${e.message}｜原文：${l.slice(0, 160)}`); }
    if (o && o.kind === kind) hits.push({ line: l, obj: o });
  }
  if (!hits.length) throw new Error(`汇总行里没有 kind=${kind} 的那一行（现有：${all.map((x) => x.slice(0, 40)).join(" | ")}）`);
  if (hits.length > 1) {
    throw new Error(`kind=${kind} 的汇总行有 ${hits.length} 条，不能挑一条用：\n   ${hits.map((h) => h.line.slice(0, 160)).join("\n   ")}`);
  }
  const hit = hits[0].obj;
  for (const f of requireFields ?? []) {
    if (typeof hit[f] !== "number" || !Number.isFinite(hit[f])) {
      throw new Error(`字段 ${f} 读不到或不是数（拿到 ${JSON.stringify(hit[f])}）——字段被改名或被印成字符串，等于保护静默消失`);
    }
  }
  return hit;
}

/**
 * 状态与计数的双向印证 + 计数自洽。返回 null 表示可信，否则返回"为什么不可信"一句话。
 *
 * 约定必须先说清：并发探针的 0 是**坏消息**（0 = 抓到丢行/双主），而汇总器（red-demo、npm test）
 * 的 0 是好消息。所以"退 0 当且仅当 bad=0"这条规则必须按调用方的约定反过来判——
 * 不加这个开关，探针每次成功复现缺陷都会被自己的测具判成 harness error。
 *
 * @param code     这一步将要返回的退出码（由同一个 reported 推出，不是另算一遍）
 * @param reported 对外报出去的坏消息数（就是汇总行里写的那个数）
 * @param raw      现场重算的同一个数（不等 = 打印时改了数）
 * @param measured / expect 实测样本数 / 安排的样本数
 * @param badIsSuccess 约定：true = 探针（0 表示抓到了缺陷）；false = 汇总器（0 表示全绿）
 */
export function crossCheck(code, { reported, raw, expect, measured, badIsSuccess = false }) {
  const bad = [];
  if (!Number.isFinite(code)) bad.push(`退出码不是数（${code}）`);
  if (!Number.isFinite(reported)) bad.push(`报出的 bad 不是数（${reported}）`);
  if (bad.length) return bad.join("；");
  if (badIsSuccess) {
    // 探针：0 必须伴随 bad>0；非 0（除 harness 通道）必须伴随 bad=0
    if (code === 0 && reported === 0) return "退 0（探针的 0 = 抓到缺陷）却报 bad=0：状态说抓到了、计数说没有";
    if (code !== 0 && code !== HARNESS_EXIT && reported > 0) return `退 ${code}（=没抓到）却报 bad=${reported}：计数说抓到了、状态说没有`;
  } else {
    if (code === 0 && reported > 0) return `退 0 却报 bad=${reported}：状态说没事发生、计数说有 ⇒ 判读器不能只信一边`;
    if (code !== 0 && code !== HARNESS_EXIT && reported === 0) return `退 ${code} 但报 bad=0：状态说有事发生、计数说没有 ⇒ 多半是崩在打印之前`;
  }
  // 对外报的数必须等于现场重算的数（抓"临时把计数打印错"这一类）
  if (Number.isFinite(raw) && raw !== reported) {
    return `报出的 bad=${reported} 与现场重算的 bad=${raw} 不一致：对外说的那个数不是判据用的那个数`;
  }
  // 样本必须齐（少一份就是有一段没被量到，那种表不能写进 README）
  if (Number.isFinite(expect) && measured !== expect) {
    return `样本数不齐：安排 ${expect}，实测到 ${measured}`;
  }
  return null;
}

// 测具不可信用**单独的退码**：它和"抓到缺陷"(0) 与"没抓到"(3) 都不是一回事。
// 混在一起就会出现用户点出的那个形状——读不到计数与被当成 0，于是 NOT REPORTED 长得像 PASSED。
export const HARNESS_EXIT = 9;

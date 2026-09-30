// 文件占用锁：独占创建 + TTL 必填。
//
// 为什么是这个形状：markdown 进度表做"声明-领取"接不住并发——实测 20 轮并发
// 20 轮谎报（两个写入者都以为锁是自己的，表上只有一行）。见
// docs/evidence/2026-09-29-claim-mechanism-measurement.md。
//
// 两条不可协商的规则：
//   1) TTL 必填且为正整数。允许 ttl=0/"永不过期"等于允许脏锁永久卡死频道
//      ——实测过：无 TTL 的锁后来者无权回收。所以从入口上就不让这种锁存在。
//   2) 抢占后原持有者回来 release 必须被拒。锁的归属以文件内容为准，不以谁写的为准。
import fs from "node:fs";
import path from "node:path";

export const EXIT = {
  OK: 0,            // 领取成功 / 释放成功
  BAD_ARG: 2,       // 缺 --file / --who
  BLOCKED: 3,       // 锁被别人持有且未过期
  NO_LOCK: 4,       // release 时没有锁文件
  NOT_HOLDER: 5,    // release 者不是当前持有者
  BAD_TTL: 6,       // TTL 非法（缺失、非数字、<=0）
  DIRTY_LOCK: 8,    // 锁文件内容不可解析（截断/空/非 JSON），且还没躺够回收上界
  RENEW_FAILED: 9,  // 续期失败：锁在"我读到它"和"我动手改它"之间已被他人拿走
  LOCK_IO: 10,      // 文件系统层面的失败：频道目录被删/只读/不可写。不是协议结论，是环境问题
};

// 不可解析锁的回收上界（秒）。这类锁没有 TTL 可读，只能拿文件 mtime 当钟。
// 没有上界它就等于一把"无限 TTL"的锁——而本文件第 8-9 行声称不允许那种锁存在。
export const CORRUPT_GRACE_S = 120;

// 文件名 → 锁文件名。必须吃掉路径分隔符与 ..，否则 claim("../../x") 能把锁写到别处
export function lockFileName(file) {
  const flat = file.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "-");
  return `${flat}.lock`;
}

function lockPath(claimsDir, file) {
  return path.join(claimsDir, lockFileName(file));
}

// 返回 null 只有一种含义：文件不存在。
// 存在但读不懂 → corruptLock()。**绝不抛**：抛出来不是退码表里的任何值，而且会把
// `locks` 这个旁观者唯一的现场一起打崩（实测：一把截断的锁让 claim 连崩 10 次 exit=1）。
function corruptLock(p, why) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(p).mtimeMs; } catch { /* 连 stat 都失败，按"刚出现"处理，保守不回收 */ }
  return { corrupt: true, why, who: null, at: null, ttl: null, mtimeMs };
}

function readLock(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;   // 权限/设备这类真 I/O 故障不算"脏锁"，别把它伪装成可回收
  }
  if (!raw) return corruptLock(p, "空文件");
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
    return corruptLock(p, `不是对象（${typeof obj}）`);
  } catch {
    return corruptLock(p, "JSON 解析失败");
  }
}

function validateTtl(ttl) {
  // 布尔必须单独挡掉：`--ttl` 不带值会被解析成 true，而 Number(true) === 1，
  // 于是"忘了给 TTL"会变成"建了一把 1 秒后就放手的锁"——比拒绝危险得多。
  if (typeof ttl === "boolean" || ttl === null || ttl === undefined || typeof ttl === "object") {
    return { ok: false, reason: `TTL 必须是正整数秒（收到 ${typeof ttl} 型的 "${ttl}"）。不允许无过期时间的锁存在。` };
  }
  const n = Number(ttl);
  if (!Number.isInteger(n) || n <= 0)
    return { ok: false, reason: `TTL 必须是正整数秒（收到 "${ttl}"）。不允许无过期时间的锁存在。` };
  return { ok: true, value: n };
}

// 抢占必须重新走一次独占创建。直接覆盖写会造出双主：B 与 C 同时读到过期锁、
// 同时 write()、同时返回 stolen——和我们用锁要消灭的那个 bug 是同一个。
// 所以规则是：谁 wx 成功谁是主，抢不到就老实报 blocked。
// 空文件窗口也一并消掉：内容随独占创建一次写定，读者不会看到半截锁。

// 「先 rm 再 wx」有 TOCTOU：A 搬走过期锁并建好新锁之后，慢半步的 B 仍可能执行它的 rm，
// 把 A 的新鲜锁删掉再建一把——两个 stolen。rename 要求源存在，且并发下只有一个进程能成功，
// 所以用它当仲裁。
//
// **抢占和续期必须共用这一套仲裁**。分家写就会写出双主：续期原本是
// `读到"还是我的、没过期" → 裸 writeFileSync 覆盖`，而 A 通过检查后、落笔前的那段
// 时间里，B 完全可以合法搬走并重建 A 的锁——A 盖掉的正是 B 的记录，两边都自认为持有者。
function arbiterMove(p) {
  const tmp = `${p}.arbiter-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(p, tmp);
  } catch (e) {
    if (e.code === "ENOENT") return null;   // 别人先搬走了
    throw e;
  }
  return tmp;
}

function arbiterSweep(tmp) {
  try { fs.unlinkSync(tmp); } catch { /* 搬走即等于有权重建，删不掉不影响归属 */ }
}

// 搬错了人要原样放回。**不用 link+unlink**：本机实测那条路会给同一 inode 造出第二个名字，
// 和别的进程的 rename 互相踩——trace 现场是「rename 返回成功、tmp 却不存在，目录里躺着的是
// 别人的 arbiter 临时文件」，进程直接 ENOENT 崩掉。
// 带守卫的 rename 是唯一能说的清楚的做法：只在空位上放回；位置已被占就不放，
// 让 locks 把残留打出来。放回失败意味着现持有者被误伤一次（liveness），
// 但绝不产生双主（safety）——两害取其轻，锁宁可错杀不可双主。
function arbiterPutBack(tmp, p) {
  if (fs.existsSync(p)) return false;
  try {
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EEXIST") return false;
    throw e;
  }
}

// ---- 续期标记：只增不改的 CAS ----
// 基锁 <name>.lock 的字节**一旦写成就不再被任何人覆盖**（除了仲裁搬走）。
// 续期 = 为"基锁的某一个化身"独占追加一个标记文件 `<name>.lock.r-<baseAt>`。
// 于是"延长 TTL"和"抢占别人的锁"落在两个不同的路径上，永远不会互相盖。
export function markerOf(p, baseAt) {
  return `${p}.r-${baseAt}`;
}

function createMarker(m, baseAt, ttl) {
  try {
    fs.writeFileSync(m, JSON.stringify({ at: Date.now(), base: baseAt, ttl }), { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;   // 同化身已有标记：同身份，视为已续
    throw e;
  }
}

// 某个基锁化身的所有标记。前缀里带上 baseAt，所以只可能读到同一化身的标记。
function markersFor(p, baseAt) {
  const dir = path.dirname(p), pre = `${path.basename(p)}.r-${baseAt}`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names.filter((n) => n.startsWith(pre))) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (o && o.base === baseAt && typeof o.at === "number") out.push(o);
    } catch { /* 半截标记：忽略，它不延长任何东西 */ }
  }
  return out;
}

// 有效到期时刻 = 基锁自身 与 每个续期标记 里最晚的那个。
// 没有这一步，续期就只是写了个文件、锁照样被抢——那比不写更坏。
function deadlineOf(p, c) {
  let d = c.at + c.ttl * 1000;
  for (const m of markersFor(p, c.at)) d = Math.max(d, m.at + (m.ttl || c.ttl) * 1000);
  return d;
}

// 续期作废时把死化身的标记清掉。删的是"基锁已经不是这一把"之后谁都不再引用的文件，
// 不参与归属判定，所以不需要仲裁。
function sweepMarkers(p, baseAt) {
  try { fs.unlinkSync(markerOf(p, baseAt)); } catch { /* 本来就没有，或已被别人清过 */ }
}

// —— 确定性闸口 ——
// 存在 `<锁文件>.freeze` 时，在"读完基锁"与"动手改锁/落标记"之间停住，直到标记被删。
// 为什么要有它：续期与抢占的临界只有几微秒，靠并发去撞，撞不上就是**假绿灯**
// （本项目已经被这种绿灯骗过两次：一次注入延迟才红，一次发现改的字段根本不在观测路径上）。
// 有了它，"A 读到还是自己的锁 → B 合法抢占 → A 才动手"这段时序可以被**逐字复现**，
// 而不是"跑 20 轮希望撞上"。生产路径上不存在这个文件，代价只有一次 existsSync。
function pauseForFreeze(p) {
  const f = `${p}.freeze`;
  if (!fs.existsSync(f)) return false;
  // 到闸了要**报到**，调用方等的是这个报到而不是"猜 200ms 够不够"。
  // 靠 sleep 同步的测试不是确定性测试，是换了个形式的假绿灯——实测把延迟固定成 200ms 时，
  // 子进程有时还没读到锁，外层判据因此发生在续期之后，M13 那种变异就照样绿。
  const gate = `${p}.at-gate`;
  const limit = Date.now() + 25000;                 // 上限：闸口失灵也不许永远挂住
  try { fs.writeFileSync(gate, String(process.pid)); } catch { /* 报到失败也不影响等待 */ }
  while (fs.existsSync(f) && Date.now() < limit) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try { fs.unlinkSync(gate); } catch { /* 已被人清过 */ }
  return true;
}

/**
 * 领取锁。单次尝试，不阻塞。
 * @returns {{status:"acquired"|"renewed"|"renew-failed"|"stolen"|"blocked"|"dirty-blocked"|"refused", code:number, file:string, holder?:string, ageS?:number, ttl?:number, reason?:string, why?:string, path:string}}
 */
export function acquire({ claimsDir, file, who, ttl }) {
  fs.mkdirSync(claimsDir, { recursive: true });
  const p = lockPath(claimsDir, file);
  const t = validateTtl(ttl);
  if (!t.ok) return { status: "refused", code: EXIT.BAD_TTL, file, path: p, reason: t.reason };

  // 化身令牌（fencing token）：基锁的 at。**只有抢占会换它**，续期不换。
  // 为什么必须有它：客户端协议关不掉"我复查通过之后别人才动手"这个窗口——
  // 复查永远可以被一次更晚的抢占超过，这是 lock fencing 的老问题，不是实现瑕疵。
  // 能关的地方只有写入点：调用方把令牌带回来（release/提交），过期的那一律退 5。
  let incarnation = null;
  const create = () => {
    incarnation = Date.now();
    try {
      fs.writeFileSync(p, JSON.stringify({ who, at: incarnation, ttl: t.value }), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
  };
  const ageOf = (c) => (c && c.at ? (Date.now() - c.at) / 1000 : 0);
  const idleOf = (c) => (Date.now() - (c?.mtimeMs || 0)) / 1000;
  const dirtyBlocked = (cur) => ({
    status: "dirty-blocked", code: EXIT.DIRTY_LOCK, file, path: p, holder: "(内容不可解析)",
    ageS: idleOf(cur), ttl: CORRUPT_GRACE_S,
    reason: `锁文件内容解析不出来（${cur.why}），已躺 ${idleOf(cur).toFixed(0)}s；超过上界 ${CORRUPT_GRACE_S}s 才允许回收`,
  });
  const blocked = (cur) => (!cur
    ? { status: "blocked", code: EXIT.BLOCKED, file, path: p, holder: "?", ageS: 0, ttl: undefined }
    : cur.corrupt ? dirtyBlocked(cur)
    : { status: "blocked", code: EXIT.BLOCKED, file, path: p, holder: cur.who ?? "?", ageS: ageOf(cur), ttl: cur.ttl });

  const acquired = () => ({ status: "acquired", code: EXIT.OK, file, path: p, holder: who, ttl: t.value, at: incarnation });
  // 续期失败的专用退码：它和"别人正持着"(3)、"我不是持有者所以不能放"(5) 都不一样——
  // 调用方拿到 9 时的正确动作是**停手**：这一行不写板、不提交，回去重新领取。
  // 分开计数才有意义：9 的上升说明 TTL 猜小了或任务超时，3 的上升才说明真的撞车。
  const renewRefused = (cur, now) => ({
    status: "renew-failed", code: EXIT.RENEW_FAILED, file, path: p, holder: now.who ?? "(内容不可解析)",
    ageS: ageOf(now), ttl: now.ttl,
    reason: `我读到的是 ${new Date(cur.at).toISOString()} 那把（${who}），落笔时锁位上已经是 ${now.who ?? "?"} 的——续期作废`,
  });
  // 抢占的判定必须建立在**搬走之后**读到的那份快照上，而不是搬走之前的 cur。
  // 用 cur 判过期有和续期一模一样的洞：A 读到"过期了"→ 持有者正好续期成功 →
  // A 把**别人的活锁**搬走删掉。rename 才是仲裁点：搬走之后那把才算数，
  // 一判它没过期就原样放回、自己认输。
  const steal = (why) => {
    const tmp = arbiterMove(p);
    if (!tmp) return null;                                  // 仲裁输了
    const got = readLock(tmp);
    const canTake = !got || (got.corrupt
      ? idleOf(got) > CORRUPT_GRACE_S
      : Date.now() > deadlineOf(p, got));                   // 标记还在盘上，判过期要一起算
    if (!canTake) {
      // 搬错人了。放回；空位若已被第三方合法占住，就不放（放会覆盖），
      // 残留文件由 locks 打出来——它不是垃圾，是"谁在临界点上被误伤"的现场。
      if (!arbiterPutBack(tmp, p)) { /* 留给 locks 看见 */ }
      return blocked(readLock(p));
    }
    arbiterSweep(tmp);
    if (create()) return { status: "stolen", code: EXIT.OK, file, path: p, holder: who,
      prevHolder: got?.who ?? "(空位)", ageS: got ? (got.at ? ageOf(got) : idleOf(got)) : 0,
      ttl: t.value, at: incarnation, why };
    return blocked(readLock(p));   // 搬走后空位又被合法新建，认输
  };

  if (create()) return acquired();

  let cur = readLock(p);
  if (!cur) return create() ? acquired() : blocked(readLock(p));

  // 不可解析的锁没有 TTL 可读，只能按 mtime 的固定上界回收。
  // 它必须在续期判定**之前**分流：cur.who 是 null，走下去只会拿到 NaN 的比较结果。
  if (cur.corrupt) {
    if (idleOf(cur) > CORRUPT_GRACE_S) {
      return steal(`内容不可解析，已躺 ${idleOf(cur).toFixed(0)}s > 上界 ${CORRUPT_GRACE_S}s`) ?? blocked(readLock(p));
    }
    return dirtyBlocked(cur);
  }

  // 自己已持有且没过期 → 续期。TTL 的意义是"死了会被回收"，长任务必须能延长它。
  //
  // **续期既不能是覆盖写，也不能是"搬走—验货—放回"。**
  // 覆盖写：A 在 age=9.9 通过下面这个检查，B 在 10.01 合法抢占建好新锁，A 在 10.02 盖上去
  // → A 自认为续上了、B 的记录被抹 = 双主。
  // "搬走—验货—放回"是我先前的实现，被探针打出来了：A 搬走的可能是 **B 的活锁**，而放回时
  // p 若已被第三方合法新建，A 就放不回去——**B 的锁被 A 销毁**。20 续期 + 20 抢占的实测里
  // 这一条造出了"自称赢的名字数 2"。
  //
  // 所以续期改成**只增不改的 compare-and-swap**：给"我这一个化身"独占创建一个续期标记，
  // 然后复查基锁是否还是我读到的那一把。是 → 续期成立；不是 → 作废（退码 9）。
  // 标记对过期判定是加分项，对别人的锁零破坏：不存在任何一次写会覆盖别人的字节。
  const alive = deadlineOf(p, cur) >= Date.now();
  if (cur.who === who && alive) {
    pauseForFreeze(p);                                  // 确定性临界：见 pauseForFreeze 注释
    const m = markerOf(p, cur.at);
    const wrote = createMarker(m, cur.at, t.value);   // EEXIST 也算握过：同化身已有标记
    const now = readLock(p);
    if (!now) {
      // 基锁消失了（被人搬走抢占）。绝不重建一把"我以为是我的"锁；空位按合法新建处理。
      sweepMarkers(p, cur.at);
      return create() ? acquired() : blocked(readLock(p));
    }
    if (now.who === who && now.at === cur.at) {
      return { status: "renewed", code: EXIT.OK, file, path: p, holder: who, ageS: 0, ttl: t.value,
        at: cur.at,
        why: `续期标记 ${path.basename(m)} ${wrote ? "已落" : "已存在"}` };
    }
    // 基锁换了化身：这次续期作废。留下的标记属于死化身，sweepMarkers 清它，不影响归属判定。
    sweepMarkers(p, cur.at);
    return renewRefused(cur, now);
  }

  // 可回收 = 已过期，或者压根没有正 TTL。
  // 后半条是补的：实测过"无 TTL 的锁后来者无权回收"，那种锁能把频道永久卡死。
  // 入口已经拒绝新建 ttl<=0 的锁，但已存在的违规锁（手改、旧版本残留）也得有回收路径，
  // 否则"从入口消除"只挡住了增量，没挡住存量。
  // 过期判定必须把续期标记算进来：不算的话，一次正常续期之后锁照样能被抢，
  // 那"允许续期"就变成"允许被误伤"。
  const expired = Date.now() > deadlineOf(p, cur);
  const invalid = !(cur.ttl > 0);
  if (expired || invalid) {
    pauseForFreeze(p);                                  // 同样给抢占留出可复现的临界窗口
    const r = steal(invalid ? "无有效 TTL" : `超时 ${ageOf(cur).toFixed(1)}s > TTL ${cur.ttl}s`);
    if (r) return r;
    const now = readLock(p);
    if (!now) return create() ? acquired() : blocked(readLock(p));   // 仲裁输了但位置空着，合法新建
    return blocked(now);
  }
  return blocked(cur);
}

/**
 * 释放锁。只有当前持有者能释放；内容读不懂时没人能证明自己是持有者。
 * 带 `at` 时做**令牌校验**（fencing）：名字对但化身不对也拒。
 * 这一条才是"被抢占后原方回来必须被拒"的完整形式——原方报得出自己的名字，
 * 但报不出新持有者的化身号，所以它连"我还在持着"这件事都伪造不了。
 */
export function release({ claimsDir, file, who, at }) {
  const p = lockPath(claimsDir, file);
  const cur = readLock(p);
  if (!cur) return { status: "no-lock", code: EXIT.NO_LOCK, file, path: p };
  if (cur.corrupt) {
    // 不许裸删：这把读不懂的文件可能是别人**正在写**的锁，删它等于替对方丢工作。
    return { status: "dirty-blocked", code: EXIT.DIRTY_LOCK, file, path: p, holder: "(内容不可解析)",
      ageS: (Date.now() - (cur.mtimeMs || 0)) / 1000, ttl: CORRUPT_GRACE_S,
      reason: `锁文件内容解析不出来（${cur.why}），无法确认持有者；等它躺够上界后由 claim 回收` };
  }
  if (cur.who !== who) {
    return { status: "not-holder", code: EXIT.NOT_HOLDER, file, path: p, holder: cur.who,
      reason: `当前持有者是 ${cur.who}，不是 ${who}` };
  }
  if (at !== undefined && at !== null && String(at) !== String(cur.at)) {
    return { status: "stale-token", code: EXIT.NOT_HOLDER, file, path: p, holder: who,
      reason: `名字对，但化身号对不上：你带回来的是 ${at}，锁位上是 ${cur.at}——这把锁中途被抢走过` };
  }
  fs.unlinkSync(p);
  return { status: "released", code: EXIT.OK, file, path: p };
}

/** 当前所有锁 + 仲裁残留，供人一眼看出"谁在等/谁占着/谁被误伤过"。这个命令自己绝不能崩——它是旁观者唯一的现场。 */
export function list({ claimsDir }) {
  if (!fs.existsSync(claimsDir)) return { locks: [], stray: [] };
  const names = fs.readdirSync(claimsDir);
  const locks = names.filter((f) => f.endsWith(".lock")).map((f) => {
    const cur = readLock(path.join(claimsDir, f)) ?? {};
    if (cur.corrupt) {
      const idleS = +(((Date.now() - cur.mtimeMs) / 1000).toFixed(1));
      return { lock: f, holder: "(内容不可解析)", ageS: idleS, ttl: null,
        state: idleS > CORRUPT_GRACE_S ? `脏锁可回收(躺 ${idleS}s > 上界 ${CORRUPT_GRACE_S}s)` : `脏锁等上界(${idleS}/${CORRUPT_GRACE_S}s)` };
    }
    const ageS = cur.at ? +(((Date.now() - cur.at) / 1000).toFixed(1)) : null;
    // state 必须和 acquire 的过期判定**用同一个函数**算。
    // 各算各的会出现：一把刚续过的锁在 `locks` 里被标成"已过期可回收"，
    // 而 claim 实际返回 3——旁观者照着板子做决定，决定是错的。
    const left = ((deadlineOf(path.join(claimsDir, f), cur) - Date.now()) / 1000).toFixed(1);
    const renewals = markersFor(path.join(claimsDir, f), cur.at).length;
    const state = !(cur.ttl > 0) ? "违规(无TTL)"
      : Date.now() > deadlineOf(path.join(claimsDir, f), cur) ? "已过期可回收"
      : `持有中(剩 ${left}s${renewals ? `，含 ${renewals} 次续期` : ""})`;
    return { lock: f, holder: cur.who ?? "?", ageS, ttl: cur.ttl ?? null, state };
  });
  // 仲裁残留：搬错人又放不回去的那把锁留在这儿。它后缀不是 .lock、不参与归属判定，
  // 但它是"谁在临界点上被误伤"的唯一现场——必须看得见，不能变成暗垃圾。
  const stray = names.filter((f) => f.includes(".lock.arbiter-"));
  return { locks, stray };
}

/**
 * 把"被挡住"这件事写进日志。
 * 这条不是装饰：不写的话，旁观者看到一个目录没变化，分不清"它在等锁"和"它没干活"。
 */
export function noteWait({ claimsDir, file, who, holder, ageS, ttl, tag = "WAIT" }) {
  const line = `${new Date().toISOString()}  ${tag}  ${who} 等 ${file}  持有者=${holder}  已占 ${ageS?.toFixed?.(1) ?? "?"}s / TTL ${ttl ?? "?"}s\n`;
  fs.appendFileSync(path.join(claimsDir, "waiters.log"), line);
  return line.trim();
}

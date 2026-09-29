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
  BLOCKED: 3,       // 锁被别人持有且未过期
  NO_LOCK: 4,       // release 时没有锁文件
  NOT_HOLDER: 5,    // release 者不是当前持有者
  BAD_TTL: 6,       // TTL 非法（缺失、非数字、<=0）
  BAD_ARG: 2,
};

// 文件名 → 锁文件名。必须吃掉路径分隔符与 ..，否则 claim("../../x") 能把锁写到别处
export function lockFileName(file) {
  const flat = file.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "-");
  return `${flat}.lock`;
}

function lockPath(claimsDir, file) {
  return path.join(claimsDir, lockFileName(file));
}

function readLock(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`锁文件损坏或不可读 ${p}: ${e.message}`);
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
function payloadOf(who, ttl) {
  return JSON.stringify({ who, at: Date.now(), ttl });
}

// 「先 rm 再 wx」有 TOCTOU：A 搬走过期锁并建好新锁之后，慢半步的 B 仍可能执行它的 rm，
// 把 A 的新鲜锁删掉再建一把——两个 stolen。rename 要求源存在，且只有一个并发者能成功，
// 所以用它当抢占仲裁：搬走过期锁的人才有资格建新的。
function stealExpired(p) {
  const tmp = `${p}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(p, tmp);
  } catch (e) {
    if (e.code === "ENOENT") return false;   // 别人先搬走了
    throw e;
  }
  try { fs.unlinkSync(tmp); } catch { /* 搬走即等于持有，删不掉不影响归属 */ }
  return true;
}

/**
 * 领取锁。单次尝试，不阻塞。
 * @returns {{status:"acquired"|"renewed"|"stolen"|"blocked"|"refused", code:number, file:string, holder?:string, ageS?:number, ttl?:number, reason?:string, why?:string, path:string}}
 */
export function acquire({ claimsDir, file, who, ttl }) {
  fs.mkdirSync(claimsDir, { recursive: true });
  const p = lockPath(claimsDir, file);
  const t = validateTtl(ttl);
  if (!t.ok) return { status: "refused", code: EXIT.BAD_TTL, file, path: p, reason: t.reason };

  const create = () => {
    try {
      fs.writeFileSync(p, payloadOf(who, t.value), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
  };
  const ageOf = (c) => (c ? (Date.now() - c.at) / 1000 : 0);
  const blocked = (cur) => ({
    status: "blocked", code: EXIT.BLOCKED, file, path: p,
    holder: cur?.who ?? "?", ageS: ageOf(cur), ttl: cur?.ttl,
  });

  const acquired = () => ({ status: "acquired", code: EXIT.OK, file, path: p, holder: who, ttl: t.value });
  const steal = (cur, why) => {
    if (!stealExpired(p)) return null;
    if (create()) return { status: "stolen", code: EXIT.OK, file, path: p, holder: who, prevHolder: cur.who, ageS: ageOf(cur), ttl: t.value, why };
    return blocked(readLock(p));   // 搬走后空位又被合法新建，认输
  };

  if (create()) return acquired();

  let cur = readLock(p);
  if (!cur) return create() ? acquired() : blocked(readLock(p));

  // 自己已持有且没过期 → 续期。TTL 的意义是"死了会被回收"，长任务必须能延长它；
  // 不给续期就等于要求调用方在开工前猜中一个够大的 TTL，猜小了会被自己合法抢占。
  if (cur.who === who && ageOf(cur) <= cur.ttl) {
    fs.writeFileSync(p, payloadOf(who, t.value));
    return { status: "renewed", code: EXIT.OK, file, path: p, holder: who, ageS: ageOf(cur), ttl: t.value };
  }

  // 可回收 = 已过期，或者压根没有正 TTL。
  // 后半条是补的：实测过"无 TTL 的锁后来者无权回收"，那种锁能把频道永久卡死。
  // 入口已经拒绝新建 ttl<=0 的锁，但已存在的违规锁（手改、旧版本残留）也得有回收路径，
  // 否则"从入口消除"只挡住了增量，没挡住存量。
  const expired = ageOf(cur) > cur.ttl;
  const invalid = !(cur.ttl > 0);
  if (expired || invalid) {
    const r = steal(cur, invalid ? "无有效 TTL" : `超时 ${ageOf(cur).toFixed(1)}s > TTL ${cur.ttl}s`);
    if (r) return r;
    const now = readLock(p);
    if (!now) return create() ? acquired() : blocked(readLock(p));   // 仲裁输了但位置空着，合法新建
    return blocked(now);
  }
  return blocked(cur);
}

/** 释放锁。只有当前持有者能释放。 */
export function release({ claimsDir, file, who }) {
  const p = lockPath(claimsDir, file);
  const cur = readLock(p);
  if (!cur) return { status: "no-lock", code: EXIT.NO_LOCK, file, path: p };
  if (cur.who !== who) return { status: "not-holder", code: EXIT.NOT_HOLDER, file, path: p, holder: cur.who };
  fs.unlinkSync(p);
  return { status: "released", code: EXIT.OK, file, path: p };
}

/** 当前所有锁，供人一眼看出"谁在等/谁占着"。 */
export function list({ claimsDir }) {
  if (!fs.existsSync(claimsDir)) return [];
  return fs.readdirSync(claimsDir).filter((f) => f.endsWith(".lock")).map((f) => {
    const cur = readLock(path.join(claimsDir, f)) ?? {};
    const ageS = cur.at ? +(((Date.now() - cur.at) / 1000).toFixed(1)) : null;
    // state 必须显式算出来：不标的话，一把过期锁和一把活锁在 `locks` 输出里长得一样，
    // 旁观者就分不出"占着不动"和"已经可以被回收"。
    const state = !(cur.ttl > 0) ? "违规(无TTL)" : ageS > cur.ttl ? "已过期可回收" : "持有中";
    return { lock: f, holder: cur.who ?? "?", ageS, ttl: cur.ttl ?? null, state };
  });
}

/**
 * 把"被挡住"这件事写进日志。
 * 这条不是装饰：不写的话，旁观者看到一个目录没变化，分不清"它在等锁"和"它没干活"。
 */
export function noteWait({ claimsDir, file, who, holder, ageS, ttl }) {
  const line = `${new Date().toISOString()}  WAIT  ${who} 等 ${file}  持有者=${holder}  已占 ${ageS?.toFixed?.(1) ?? "?"}s / TTL ${ttl ?? "?"}s\n`;
  fs.appendFileSync(path.join(claimsDir, "waiters.log"), line);
  return line.trim();
}

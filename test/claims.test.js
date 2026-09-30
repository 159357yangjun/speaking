// 文件占用锁的测试。测真实 CLI 进程的退出码——"抢锁失败返回几"只有在进程边界上才作数。
// 上一轮的教训：断言写成内部函数调用，就测不到参数解析、退出码、日志落盘这三件事。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lockFileName, markerOf, BOARD_LOCK_TTL_S } from "../src/claims/lock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.js");

function mkChannel() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-claims-"));
}
function claim(dir, args, env = {}) {
  return run(CLI, ["claim", `--channel=${dir}`, ...args], env);
}
function release(dir, args, env = {}) {
  return run(CLI, ["release", `--channel=${dir}`, ...args], env);
}
function locks(dir) {
  return run(CLI, ["locks", `--channel=${dir}`]);
}
function board(dir, args, env = {}) {
  return run(CLI, ["board", `--channel=${dir}`, ...args], env);
}
function run(bin, args, env = {}) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [bin, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code, out, err }));
  });
}

// 闸口只在该环境变量为 "1" 时存在。测试要自己打开它——
// 反过来讲：**任何没打开这个变量的调用都必须完全不理会 .freeze**，
// 那正是下面那条生产路径用例要守的东西。
const GATE = { AGENT_RELAY_TEST_GATE: "1" };

// 等子进程**自己报到**它停在闸口上，而不是 sleep 一个"大概够"的毫秒数。
// 差别是本质的：sleep 同步的用例里子进程可能还没读到锁，判据就发生在续期之后，
// 于是把第二道防线拆掉的变异也照样绿——M13 就这么逃过了一次。
async function waitAtGate(lockPath) {
  const gate = `${lockPath}.at-gate`;
  const until = Date.now() + 8000;
  while (!fs.existsSync(gate) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(gate), "子进程没到闸口报到，这条用例的前提没成立——不许当成通过");
}
function lockOf(dir, file) {
  return path.join(dir, "claims", lockFileName(file));
}
function readLockRaw(dir, file) {
  return JSON.parse(fs.readFileSync(lockOf(dir, file), "utf8"));
}
function waiters(dir) {
  const p = path.join(dir, "claims", "waiters.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("领取成功 exit 0，锁落在频道内的 claims/ 下", async () => {
  const d = mkChannel();
  const r = await claim(d, ["--file=src/a.js", "--who=qoder", "--ttl=600"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /领取/);
  assert.ok(fs.existsSync(lockOf(d, "src/a.js")), "锁文件没建出来");
  assert.equal(readLockRaw(d, "src/a.js").who, "qoder");
});

test("TTL 缺失 / 0 / 负数 / 非数字 一律 exit 6，且**不建锁**", async () => {
  const d = mkChannel();
  for (const bad of [["--ttl=0"], ["--ttl=-5"], ["--ttl=abc"], ["--ttl=1.5"], []]) {
    const r = await claim(d, ["--file=src/b.js", "--who=qoder", ...bad]);
    assert.equal(r.code, 6, `TTL ${JSON.stringify(bad)} 应退 6，实退 ${r.code}：${r.out}${r.err}`);
    assert.match(r.out + r.err, /TTL 必须是正整数秒/);
    assert.ok(!fs.existsSync(lockOf(d, "src/b.js")), `非法 TTL ${JSON.stringify(bad)} 却建出了锁`);
  }
});

test("--ttl 不带值（解析成布尔 true）不许变成 1 秒锁", async () => {
  const d = mkChannel();
  const r = await claim(d, ["--file=src/t.js", "--who=qoder", "--ttl"]);
  assert.equal(r.code, 6, `Number(true)===1 会建出一把 1 秒后就放手的锁：${r.out}${r.err}`);
  assert.ok(!fs.existsSync(lockOf(d, "src/t.js")));
});

test("他人抢占未过期锁：exit 3，且往板上写一行 WAIT", async () => {
  const d = mkChannel();
  assert.equal((await claim(d, ["--file=src/a.js", "--who=qoder", "--ttl=600"])).code, 0);
  const r = await claim(d, ["--file=src/a.js", "--who=workbuddy", "--ttl=600"]);
  assert.equal(r.code, 3, r.out + r.err);
  assert.match(r.out, /受阻/);
  const w = waiters(d);
  assert.equal(w.length, 1, "被挡住必须留痕，否则旁观者分不清「在等」和「没干活」");
  assert.match(w[0], /WAIT\s+workbuddy\s+等 src\/a\.js\s+持有者=qoder/);
  assert.equal(readLockRaw(d, "src/a.js").who, "qoder", "受阻方不许改动锁的归属");
});

test("同持有者重复 claim = 续期：追加标记、延长到期时刻，但**不换化身号**", async () => {
  const d = mkChannel();
  await claim(d, ["--file=src/a.js", "--who=qoder", "--ttl=600"]);
  const before = readLockRaw(d, "src/a.js");
  await new Promise((r) => setTimeout(r, 30));
  const r = await claim(d, ["--file=src/a.js", "--who=qoder", "--ttl=900"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /续期/);
  const after = readLockRaw(d, "src/a.js");
  // 基锁字节一个都没动：at 就是 fencing 令牌，续期换它等于把"我还在持着"的证据自己撕掉
  assert.equal(after.at, before.at, "续期不该改基锁化身号——那是令牌的本体");
  assert.equal(after.ttl, before.ttl, "续期不该改基锁 TTL，延长靠标记");
  assert.ok(fs.existsSync(markerOf(lockOf(d, "src/a.js"), before.at)), "续期没落下标记，TTL 等于没延长");
  // 延长必须真的可判：把标记算进来之后，过期时刻要比基锁自己说的晚
  const mark = JSON.parse(fs.readFileSync(markerOf(lockOf(d, "src/a.js"), before.at), "utf8"));
  assert.equal(mark.ttl, 900);
  assert.ok(mark.at + mark.ttl * 1000 > before.at + before.ttl * 1000, "标记没延长有效期，续期是空的");

  // 观测面必须和判定用同一个函数：否则一把刚续过的锁在 locks 里被标成"已过期可回收"，
  // 旁观者照着板子做决定，决定是错的
  const l = await locks(d);
  assert.match(l.out, /src_a\.js\.lock.*持有中.*含 1 次续期/s, `locks 没把续期算进去：\n${l.out}`);
});

test("非持有者 release 被拒：exit 5（被抢占后原方回来必须失败）", async () => {
  const d = mkChannel();
  await claim(d, ["--file=src/a.js", "--who=qoder", "--ttl=600"]);
  const r = await release(d, ["--file=src/a.js", "--who=workbuddy"]);
  assert.equal(r.code, 5, r.out + r.err);
  assert.ok(fs.existsSync(lockOf(d, "src/a.js")), "被拒的 release 不许把锁删掉");
  assert.equal(readLockRaw(d, "src/a.js").who, "qoder");
});

test("持有者 release：exit 0，锁消失；再放一次 exit 4", async () => {
  const d = mkChannel();
  await claim(d, ["--file=src/a.js", "--who=qoder", "--ttl=600"]);
  assert.equal((await release(d, ["--file=src/a.js", "--who=qoder"])).code, 0);
  assert.ok(!fs.existsSync(lockOf(d, "src/a.js")));
  assert.equal((await release(d, ["--file=src/a.js", "--who=qoder"])).code, 4);
});

test("锁过期后可被抢占，原持有者回来 release 仍被拒 exit 5", async () => {
  const d = mkChannel();
  await claim(d, ["--file=src/c.js", "--who=qoder", "--ttl=1"]);
  assert.equal((await claim(d, ["--file=src/c.js", "--who=workbuddy", "--ttl=600"])).code, 3, "1 秒 TTL 不该立刻就能抢");
  await new Promise((r) => setTimeout(r, 1200));
  const s = await claim(d, ["--file=src/c.js", "--who=workbuddy", "--ttl=600"]);
  assert.equal(s.code, 0, s.out + s.err);
  assert.match(s.out, /抢占/);
  assert.match(s.out, /原持有者 qoder/);
  assert.equal(readLockRaw(d, "src/c.js").who, "workbuddy");
  const back = await release(d, ["--file=src/c.js", "--who=qoder"]);
  assert.equal(back.code, 5, `被抢占后原方 release 必须被拒：${back.out}${back.err}`);
});

test("存量违规锁（ttl=0）可被回收——入口挡住增量，也要有存量出口", async () => {
  const d = mkChannel();
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  const p = lockOf(d, "src/d.js");
  fs.writeFileSync(p, JSON.stringify({ who: "ghost", at: Date.now() - 99000, ttl: 0 }));
  const r = await claim(d, ["--file=src/d.js", "--who=qoder", "--ttl=600"]);
  assert.equal(r.code, 0, `无 TTL 的锁把频道永久卡死了：${r.out}${r.err}`);
  assert.match(r.out, /无有效 TTL/);
  assert.equal(readLockRaw(d, "src/d.js").ttl, 600, "回收后必须补上合法 TTL");
});

test("claim 里的路径穿越关不进 claims/ 以外", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claims-root-"));
  const d = path.join(root, "channel");
  fs.mkdirSync(d, { recursive: true });
  const before = fs.readdirSync(root).sort().join(",");

  const evil = "../../../escape.js";
  const r = await claim(d, ["--file=" + evil, "--who=qoder", "--ttl=600"]);
  assert.equal(r.code, 0, r.out + r.err);

  const abs = path.resolve(lockOf(d, evil));
  assert.ok(abs.startsWith(path.resolve(path.join(d, "claims")) + path.sep), `锁写到了频道外：${abs}`);
  assert.equal(fs.readdirSync(root).sort().join(","), before, "频道同级目录里冒出了新东西");
  assert.ok(!fs.existsSync(path.resolve(root, "..", "escape.js.lock")), "锁逃到了 temp 根目录");
  const out = await locks(d);
  assert.match(out.out, /escape\.js\.lock/, "锁应能在 claims/ 里被列出");
});

test("20 个进程真并发抢同一把过期锁：恰好 1 家拿到", async () => {
  const d = mkChannel();
  const N = 20;
  await claim(d, ["--file=src/race.js", "--who=stale-holder", "--ttl=1"]);
  await new Promise((r) => setTimeout(r, 1200));

  // 必须用 spawn：spawnSync 会把 20 次调用串成 20 轮顺序执行，
  // 那测出来的是"没有并发"，绿灯是假的。
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => claim(d, ["--file=src/race.js", `--who=racer-${i}`, "--ttl=600"]))
  );
  const winners = results.filter((x) => x.code === 0);
  const losers = results.filter((x) => x.code === 3);

  assert.equal(winners.length, 1, `并发抢占出现 ${winners.length} 个赢家（应为 1）：双主 = 锁失效`);
  assert.equal(losers.length, N - 1, `其余应全部 exit 3，实得 ${losers.length}：${results.map((x) => x.code).join(",")}`);
  const winner = winners[0].out.match(/抢占 \S+ → (\S+)：/)[1];
  assert.equal(readLockRaw(d, "src/race.js").who, winner, "锁的内容和报赢的不是同一家");
  assert.equal(waiters(d).length, N - 1, "每个受阻方都该在板子上留一行");
});

test("20 个进程真并发抢同一把**未过期**锁：0 家拿到", async () => {
  const d = mkChannel();
  const N = 20;
  await claim(d, ["--file=src/hot.js", "--who=owner", "--ttl=600"]);
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => claim(d, ["--file=src/hot.js", `--who=racer-${i}`, "--ttl=600"]))
  );
  assert.equal(results.filter((x) => x.code === 0).length, 0, "未过期的锁被抢动过，归属判定不成立");
  assert.equal(readLockRaw(d, "src/hot.js").who, "owner");
});

test("locks 把「已过期可回收」和「持有中」区分开", async () => {
  const d = mkChannel();
  await claim(d, ["--file=src/live.js", "--who=qoder", "--ttl=600"]);
  await claim(d, ["--file=src/dead.js", "--who=qoder", "--ttl=1"]);
  await new Promise((r) => setTimeout(r, 1200));
  const r = await locks(d);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /src_live\.js\.lock.*持有中/s);
  assert.match(r.out, /src_dead\.js\.lock.*已过期可回收/s);
});

test("缺 --file / --who 退 2，不退 die 的 1（退码表写了 2 就得真是 2）", async () => {
  const d = mkChannel();
  assert.equal((await claim(d, ["--who=qoder", "--ttl=600"])).code, 2);
  assert.equal((await claim(d, ["--file=src/a.js", "--ttl=600"])).code, 2);
  assert.equal((await release(d, ["--file=src/a.js"])).code, 2);
});

// ============ 洞 2：不可解析的锁必须有定义好的回收路径，不能 throw ============
test("截断的锁文件：claim 收敛到退码 8，不把异常漏到进程外", async () => {
  const d = mkChannel();
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  fs.writeFileSync(lockOf(d, "src/bad.js"), '{"who"');           // 等价于 echo -n '{"who" > 锁文件
  for (let i = 0; i < 3; i++) {
    const r = await claim(d, ["--file=src/bad.js", "--who=qoder", "--ttl=600"]);
    assert.equal(r.code, 8, `第${i + 1}次：脏锁要给已定义的 8，实退 ${r.code}\n${r.out}${r.err}`);
    assert.doesNotMatch(r.out + r.err, /SyntaxError|at readLock|锁文件损坏或不可读/,
      "又 throw 出去了：栈不是退出码，旁观者拿它没法判断");
    assert.match(r.out + r.err, /不可解析/);
  }
});

test("空文件与非法 JSON 同样算脏锁（它没有 TTL，等于无限期占用）", async () => {
  const d = mkChannel();
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  for (const [name, content] of [["src/e.js", ""], ["src/n.js", "not json at all"], ["src/a2.js", '"just-a-string"']]) {
    fs.writeFileSync(lockOf(d, name), content);
    const r = await claim(d, ["--file=" + name, "--who=qoder", "--ttl=600"]);
    assert.equal(r.code, 8, `${name} 内容 ${JSON.stringify(content)} 应判脏锁，实退 ${r.code}`);
  }
});

test("脏锁不再打崩 locks——它是旁观者唯一的现场", async () => {
  const d = mkChannel();
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  fs.writeFileSync(lockOf(d, "src/bad.js"), '{"who"');
  const r = await locks(d);
  assert.equal(r.code, 0, `locks 自己崩了，频道就彻底没有观测面：${r.out}${r.err}`);
  assert.match(r.out, /脏锁等上界/);
});

test("脏锁超过上界后可被回收，回收后补上合法 TTL", async () => {
  const d = mkChannel();
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  const p = lockOf(d, "src/old.js");
  fs.writeFileSync(p, '{"who":"ghost","at":');
  const past = Math.floor(Date.now() / 1000) - 4000;             // mtime 推到上界之外
  fs.utimesSync(p, past, past);
  const r = await claim(d, ["--file=src/old.js", "--who=qoder", "--ttl=600"]);
  assert.equal(r.code, 0, `躺了 4000s 的脏锁回收不掉：${r.out}${r.err}`);
  assert.match(r.out, /抢占/);
  assert.equal(readLockRaw(d, "src/old.js").ttl, 600, "回收后必须带合法 TTL");
});

// ============ 洞 1：续期不得是裸覆盖写 ============
// 说明白这条断言的性质：**它是结构断言，不是行为断言**。
// 双主要的三段时序（A 读到"还是我的" → B 合法抢占 → A 落笔）在单进程里造不出来，
// 行为层面的前后对比由 tools/claims/renew-race.mjs 量（改前 4/4 轮双主、改后 0/4，
// 数字在 docs/evidence/ 那份实测差异里）。
// 这条结构断言负责的是：任何人再把锁路径写成非独占覆盖，npm test 立刻红。
test("锁路径上不允许出现非独占覆盖写（不变量的机械化版本）", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/claims/lock.js"), "utf8");
  const bad = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (!/fs\.writeFileSync\(\s*p\s*,/.test(line)) return;   // 只管"写到锁路径 p"的那些行
    if (/\bflag\s*:\s*"wx"/.test(line)) return;              // 独占创建，合法
    bad.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(bad, [],
    `这些行对锁文件做非独占覆盖写。按本文件不变量，除 wx 独占创建成功外，\n` +
    `没有任何方式能让自己成为持有者——覆盖写不算：\n  ${bad.join("\n  ")}\n`);
});

test("续期不碰基锁字节：只追加标记，复查后才知道自己还赢不赢", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/claims/lock.js"), "utf8");
  const renew = /if \(cur\.who === who && alive\) \{([\s\S]*?)\n  \}\n/.exec(src);
  assert.ok(renew, "找不到续期分支——它的入口条件被改了，这条守卫就什么都守不住了");
  const body = renew[1];
  assert.doesNotMatch(body, /arbiterMove\(/,
    "续期又去搬基锁了。上一版这么做被探针打出来：搬走的是**别人刚抢到的活锁**，" +
    "放回失败就等于把对方销毁");
  assert.doesNotMatch(body, /fs\.writeFileSync\(\s*p\s*,/, "续期分支里不许出现对基锁的写");
  assert.match(body, /createMarker\(/, "续期必须落一个只增的标记文件");
  assert.match(body, /readLock\(p\)/, "落完标记必须复查基锁——不复查就不知道自己是不是已经被抢占");
  // 过期判定要把标记算进来，否则续期等于没续
  assert.match(src, /const expired = Date\.now\(\) > deadlineOf\(p, cur\)/,
    "抢占判定没算续期标记：那续期只是写了个文件，锁照样被抢，比不写更误导");
});

test("确定性临界：续期读到锁之后被抢占，落笔前复查必须判它输（退码 9）", async () => {
  // 不靠"跑 20 轮希望撞上"。<锁>.freeze 是可复现的闸口：A 在"读完基锁"与"落标记/复查"
  // 之间停住，父进程在此期间把锁换成别人的化身，A 醒来后必须认输。
  const d = mkChannel();
  const a = await claim(d, ["--file=src/c.js", "--who=owner", "--ttl=600"]);
  assert.equal(a.code, 0, a.out + a.err);
  const token = /--at=(\d+)/.exec(a.out)[1];

  fs.writeFileSync(lockOf(d, "src/c.js") + ".freeze", "hold");
  const renew = claim(d, ["--file=src/c.js", "--who=owner", "--ttl=600"], GATE);   // 会停在闸口
  await waitAtGate(lockOf(d, "src/c.js"));   // 等它自己报到停在闸口

  // 闸口期间把基锁换成别人的化身——等价于"B 合法抢占成功"
  fs.writeFileSync(lockOf(d, "src/c.js"), JSON.stringify({ who: "other", at: Date.now(), ttl: 600 }));
  fs.rmSync(lockOf(d, "src/c.js") + ".freeze");
  const r = await renew;

  assert.equal(r.code, 9, `续期该判输退 9，实退 ${r.code}：\n${r.out}${r.err}`);
  assert.equal(readLockRaw(d, "src/c.js").who, "other", "续期方把别人的化身覆盖掉了——双主回来");
  // 死化身留下的标记不能延长**别人**的锁：这是 CAS 只增不改之外必须成立的一条
  const stale = await release(d, ["--file=src/c.js", "--who=owner", "--at=" + token]);
  assert.equal(stale.code, 5, `原方拿旧令牌还能解别人的锁：${stale.out}${stale.err}`);
  assert.ok(fs.existsSync(lockOf(d, "src/c.js")), "被拒的 release 删掉了现持有者的锁");
});

test("续期标记要算进过期判定：标记已在盘上时，外层判据就该直接收手", async () => {
  // 与下一条是一对：**这条打第一道防线（外层 expired 算不算标记），
  // 下一条打第二道（搬走之后复不算不算）**。只留一条，另一道拆掉也没人报警。
  const d = mkChannel();
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  const p = lockOf(d, "src/d.js");
  const baseAt = Date.now() - 5000;
  fs.writeFileSync(p, JSON.stringify({ who: "owner", at: baseAt, ttl: 1 }));
  fs.writeFileSync(markerOf(p, baseAt), JSON.stringify({ at: Date.now(), base: baseAt, ttl: 600 }));
  const r = await claim(d, ["--file=src/d.js", "--who=other", "--ttl=600"]);
  assert.equal(r.code, 3, `标记已经把有效期推到 600s，抢占还是动手了：${r.code}\n${r.out}${r.err}`);
  assert.equal(readLockRaw(d, "src/d.js").who, "owner");
});

test("确定性临界：判据成立之后才被续期，抢占复查搬到的那一把时必须收手", async () => {
  // 这条专打**第二道防线**。上一条里外层 expired 就已经判 false，压根走不到 steal；
  // M13（把 steal 里的"搬走后再复查"拆掉）在那一条上是绿的——一道防线被测到不等于两道都被测到。
  // 这里让外层判"确实过期"，然后在闸口期间才落下续期标记，逼 steal 走到复查那一步。
  const d = mkChannel();
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  const p = lockOf(d, "src/h.js");
  const baseAt = Date.now() - 5000;
  fs.writeFileSync(p, JSON.stringify({ who: "owner", at: baseAt, ttl: 1 }));   // 没有标记：真的过期了

  fs.writeFileSync(p + ".freeze", "hold");
  const stealing = claim(d, ["--file=src/h.js", "--who=other", "--ttl=600"], GATE);
  await waitAtGate(p);                           // 等它自己报到：已判过期、还没动手
  fs.writeFileSync(markerOf(p, baseAt), JSON.stringify({ at: Date.now(), base: baseAt, ttl: 600 })); // 闸口里被续期
  fs.rmSync(p + ".freeze");
  const r = await stealing;

  assert.equal(r.code, 3, `搬走之后一复查就该收手，实得 ${r.code}：\n${r.out}${r.err}`);
  assert.equal(readLockRaw(d, "src/h.js").who, "owner", "抢占方把刚续期的活锁搬走删掉了");
});

test("化身令牌（fencing）：名字对但令牌对不上也要被拒", async () => {
  const d = mkChannel();
  const got = await claim(d, ["--file=src/f.js", "--who=owner", "--ttl=1"]);
  assert.equal(got.code, 0, got.out + got.err);
  const token = /--at=(\d+)/.exec(got.out)?.[1];
  assert.ok(token, "claim 没把化身令牌打出来，调用方拿什么带回来？");
  await new Promise((r) => setTimeout(r, 1200));
  const steal = await claim(d, ["--file=src/f.js", "--who=other", "--ttl=600"]);
  assert.equal(steal.code, 0, steal.out + steal.err);
  const otherToken = /--at=(\d+)/.exec(steal.out)?.[1];
  assert.notEqual(otherToken, token, "抢占必须换化身号，否则原方的旧令牌还能用，fencing 形同虚设");
  // 拿**别人的名字 + 自己的旧令牌**回来：光看名字会放行，看令牌才拦得住
  const stale = await release(d, ["--file=src/f.js", "--who=other", "--at=" + token]);
  assert.equal(stale.code, 5, `旧令牌竟然放行：${stale.out}${stale.err}`);
  assert.ok(fs.existsSync(lockOf(d, "src/f.js")), "被拒的 release 不许删掉现持有者的锁");
  const fresh = await release(d, ["--file=src/f.js", "--who=other", "--at=" + otherToken]);
  assert.equal(fresh.code, 0, `新令牌被拒了：${fresh.out}${fresh.err}`);
});

test("被抢占后原方回来续期：拿到 9（停手），不是 0", async () => {
  const d = mkChannel();
  // 造一个"读到还是我的，落笔时已经不是我的"的可复现替身：
  // 先让 owner 持一把 TTL=1 的锁，等它过期被 other 抢走；owner 再来 claim 时
  // 走的是"过期→抢占"分支，所以这里单独验证 release/续期两条对非持有者的退码。
  await claim(d, ["--file=src/r.js", "--who=owner", "--ttl=1"]);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await claim(d, ["--file=src/r.js", "--who=other", "--ttl=600"])).code, 0);
  const snap = fs.readFileSync(lockOf(d, "src/r.js"), "utf8");
  const back = await claim(d, ["--file=src/r.js", "--who=owner", "--ttl=600"]);
  assert.notEqual(back.code, 0, "被抢占的原方重新 claim 竟然成功——双主回来了");
  assert.equal(fs.readFileSync(lockOf(d, "src/r.js"), "utf8"), snap, "非持有者的那一次动了锁内容");
});

// 这里**不放**并发探针当门。`tools/claims/renew-race.mjs` 的量是 20 轮前后对比（证据），
// 不是断言：npm test 六个文件并发跑时 CPU 抢不到，注入窗口就失效，实测会闪红。
// 计时窗口不能当门——门是上面那两条靠 .at-gate 报到的确定性用例，
// 它们分别被 M12 / M13 / M15 打得红，不需要运气。

test("脏锁不许被 release 抹掉（那会把别人正在写的锁当垃圾删）", async () => {
  const d = mkChannel();
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  fs.writeFileSync(lockOf(d, "src/keep.js"), '{"who":"x"');
  const r = await release(d, ["--file=src/keep.js", "--who=x"]);
  assert.equal(r.code, 8, `${r.out}${r.err}`);
  assert.ok(fs.existsSync(lockOf(d, "src/keep.js")), "脏锁被裸删了");
});


// ============ 闸口延时只在测试里存在（第 4 条） ============
test("没打开 AGENT_RELAY_TEST_GATE 时，.freeze 完全不生效", async () => {
  // 这条不是"顺手加的"：上一版 pauseForFreeze 只看磁盘上有没有 .freeze。
  // 而本项目的威胁模型明写"任何能往该目录写文件的程序都能给两个 agent 下指令"——
  // 于是任何写入方建一个 .freeze 就能把对方卡到 25s 上限。那是我自己开的 DoS 通道。
  const d = mkChannel();
  const first = await claim(d, ["--file=src/g.js", "--who=owner", "--ttl=600"]);
  assert.equal(first.code, 0, first.out + first.err);
  fs.writeFileSync(lockOf(d, "src/g.js") + ".freeze", "hold");
  const t0 = Date.now();
  const r = await claim(d, ["--file=src/g.js", "--who=owner", "--ttl=600"]);   // 无 env
  const waited = Date.now() - t0;
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.ok(waited < 3000, `生产路径竟然等了 ${waited}ms——闸口没被环境变量关住`);
  assert.ok(!fs.existsSync(lockOf(d, "src/g.js") + ".at-gate"), "报到文件都不该被创建：那条路径上不该有任何动作");
});

test("源码里闸口的唯一入口是环境变量（防「默认开着」回潮）", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "claims", "lock.js"), "utf8");
  assert.match(src, /process\.env\[GATE_ENV\] === "1"/, "闸口必须只由 AGENT_RELAY_TEST_GATE 打开");
  assert.match(src, /if \(!gateEnabled\(\)\) return false;/, "pauseForFreeze 第一句就必须在生产路径上返回");
});

// ============ 写板装进 CAS：使用点复验（第 1、2 条） ============
test("renewed 之后被合法抢占，board 必须拒写并且板子一个字节都不动", async () => {
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  fs.writeFileSync(bd, "# 进度板\n");
  const before = fs.readFileSync(bd, "utf8");

  const a = await claim(d, ["--file=src/b.js", "--who=owner", "--ttl=1"]);
  assert.equal(a.code, 0, a.out + a.err);
  const token = /--at=(\d+)/.exec(a.out)[1];
  await new Promise((r) => setTimeout(r, 1200));                 // TTL 到点
  const steal = await claim(d, ["--file=src/b.js", "--who=other", "--ttl=600"]);
  assert.equal(steal.code, 0, steal.out + steal.err);            // 抢占合法成立
  const otherToken = /--at=(\d+)/.exec(steal.out)[1];

  // 原方**不知道**自己被抢，照常来写板：使用点复验必须拦住它
  const lost = await board(d, ["--file=src/b.js", "--who=owner", "--at=" + token,
    `--board=${bd}`, "--row=| src/b.js | owner | now |"]);
  assert.equal(lost.code, 5, `丢锁的一方写板竟然放行，退码 ${lost.code}：\n${lost.out}${lost.err}`);
  assert.equal(fs.readFileSync(bd, "utf8"), before, "写板被拒却动了板子");

  // 现持有者写板必须成
  const ok = await board(d, ["--file=src/b.js", "--who=other", "--at=" + otherToken,
    `--board=${bd}`, "--row=| src/b.js | other | now |"]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  const after = fs.readFileSync(bd, "utf8");
  // 行尾被 board 盖了化身令牌（`| src/b.js | other | now <at=..> |`），
  // 逐字匹配 `| now |` 的断言会因为多了一个字段而静默失效——按前缀匹配，并单独验令牌。
  assert.match(after, /\| src\/b\.js \| other \| now\b/);
  assert.match(after, /other \| now <at=\d+> \|/, "令牌没盖进已有单元格（它得在不改列数的前提下可被 audit 读到）");
  assert.doesNotMatch(after, /\| src\/b\.js \| owner \|/, "丢锁一方的行留在了板上 = 双重声明");
});

test("board 幂等：同一行写两次只有一行（否则复跑一次就造出假的双重声明）", async () => {
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  const a = await claim(d, ["--file=src/i.js", "--who=qoder", "--ttl=600"]);
  const token = /--at=(\d+)/.exec(a.out)[1];
  const args = ["--file=src/i.js", "--who=qoder", "--at=" + token, `--board=${bd}`, "--row=| src/i.js | qoder | now |"];
  assert.equal((await board(d, args)).code, 0);
  assert.equal((await board(d, args)).code, 0);
  const txt = fs.readFileSync(bd, "utf8");
  assert.equal((txt.match(/src\/i\.js \| qoder \| now/g) || []).length, 1, txt);
});

test("board 不许在没有令牌时放行（否则 CAS 写板退化成裸 append）", async () => {
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  await claim(d, ["--file=src/n.js", "--who=qoder", "--ttl=600"]);
  // (a) 整个 --at 不给：必须当参数缺失拒掉，而不是"跳过令牌校验"
  const noArg = await board(d, ["--file=src/n.js", "--who=qoder", `--board=${bd}`, "--row=| src/n.js | qoder | now |"]);
  assert.equal(noArg.code, 2, `缺 --at 应该退 2，实退 ${noArg.code}：\n${noArg.out}${noArg.err}`);
  assert.ok(!fs.existsSync(bd), "被拒的写板创建了板文件");
  // (b) 给了一个不相干的令牌：必须走归属判定退 5，而不是当成"没给"
  const wrongArg = await board(d, ["--file=src/n.js", "--who=qoder", "--at=1",
    `--board=${bd}`, "--row=| src/n.js | qoder | now |"]);
  assert.equal(wrongArg.code, 5, `乱给令牌应该退 5，实退 ${wrongArg.code}：\n${wrongArg.out}${wrongArg.err}`);
  assert.ok(!fs.existsSync(bd), "令牌被拒却还是落了盘");
});

// ============ 板级锁：两个各自合法持锁的人不得互相抹行 ============
test("board 拿不到板级锁时退 12（可重试），且不动板子", async () => {
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  fs.writeFileSync(bd, "# 进度板\n");
  const before = fs.readFileSync(bd, "utf8");
  const a = await claim(d, ["--file=src/q.js", "--who=qoder", "--ttl=600"]);
  const token = /--at=(\d+)/.exec(a.out)[1];
  // 别人正持有这张板（__board__.lock 由另一家的 pid 命名）
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  fs.writeFileSync(path.join(d, "claims", "__board__.lock"),
    JSON.stringify({ who: "workbuddy#99999", at: Date.now(), ttl: 600 }));
  const r = await board(d, ["--file=src/q.js", "--who=qoder", "--at=" + token, `--board=${bd}`,
    "--row=| src/q.js | qoder | now |", "--wait=300"]);
  assert.equal(r.code, 12, `该退 12（板级排队超时），实退 ${r.code}：\n${r.out}${r.err}`);
  assert.match(r.out + r.err, /可以重试/, "退码 12 必须和 9 分清：这是没排到队，不是丢了归属");
  assert.equal(fs.readFileSync(bd, "utf8"), before, "排队超时却动了板子");
});

test("board 写的行里带化身令牌，且不改表的列数", async () => {
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  const a = await claim(d, ["--file=src/t.js", "--who=qoder", "--ttl=600"]);
  const token = /--at=(\d+)/.exec(a.out)[1];
  const r = await board(d, ["--file=src/t.js", "--who=qoder", "--at=" + token, `--board=${bd}`,
    "--row=| src/t.js | qoder | now |"]);
  assert.equal(r.code, 0, r.out + r.err);
  const line = fs.readFileSync(bd, "utf8").split("\n").find((l) => l.includes("src/t.js"));
  assert.ok(line.includes(`<at=${token}>`), `行里没带化身令牌，检测无从下手：${line}`);
  assert.equal(line.split("|").length - 2, 3, `令牌不该新增一列（列数是对话层在读的东西）：${line}`);
});

// ============ 检测：只报不拒 ============
function audit(d, args) { return run(CLI, ["audit", `--channel=${d}`, ...args]); }

test("伪造一行、其化身盘上没有活锁 —— audit 必须报出来（退码 11）", async () => {
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  const a = await claim(d, ["--file=src/real.js", "--who=qoder", "--ttl=600"]);
  const token = /--at=(\d+)/.exec(a.out)[1];
  await board(d, ["--file=src/real.js", "--who=qoder", "--at=" + token, `--board=${bd}`,
    "--row=| src/real.js | qoder | now |"]);
  // 手写的越写者行：名字像真的、化身是编的
  fs.appendFileSync(bd, "| src/fake.js | workbuddy | now <at=1234567890123> |\n");
  // 不经 board 写上去的行：没令牌，锁管不到它——也必须被点名
  fs.appendFileSync(bd, "| src/notoken.js | someone | now |\n");

  const r = await audit(d, [`--board=${bd}`]);
  assert.equal(r.code, 11, `该退 11（板上有越写者），实退 ${r.code}：\n${r.out}${r.err}`);
  assert.match(r.out, /src\/fake\.js/, "伪造行没被点名");
  assert.match(r.out, /无令牌行/, "不经 board 写的行必须被点成'锁管不到它'，而不是当成干净");
  // 合法行压根不该出现在输出里——出现了就是误报。
  // （上一版我写成 assert.match(r.out, /src\/real\.js/)，把"没被点名"判成失败，方向反了。）
  assert.doesNotMatch(r.out, /越写者：\| src\/real\.js/, "合法行被误报成越写者");
  assert.doesNotMatch(r.out, /无令牌行.*src\/real\.js/, "合法行被误报成无令牌行");
});

test("--wait 不是摆设：把它传成非数字也不许挂死", async () => {
  // `--wait=abc` → parseInt → NaN → `Date.now() >= NaN` 永假 → 排队循环没有退出条件。
  // 一个拼错的参数不该变成挂死，所以这条专门钉：给定非法值也必须在上界内返回。
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  fs.writeFileSync(bd, "# 进度板\n");
  const a = await claim(d, ["--file=src/w2.js", "--who=qoder", "--ttl=600"]);
  const token = /--at=(\d+)/.exec(a.out)[1];
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  fs.writeFileSync(path.join(d, "claims", "__board__.lock"),
    JSON.stringify({ who: "workbuddy#99998", at: Date.now(), ttl: 600 }));
  const t0 = Date.now();
  const r = await board(d, ["--file=src/w2.js", "--who=qoder", "--at=" + token, `--board=${bd}`,
    "--row=| src/w2.js | qoder | now |", "--wait=abc"]);
  const took = Date.now() - t0;
  assert.equal(r.code, 12, `非法 --wait 该走上界返回 12，实退 ${r.code}：\n${r.out}${r.err}`);
  assert.ok(took < 8000, `非法参数后等了 ${took}ms，疑似没有退出条件`);
});

test("audit 只报不拒：报出没改板子一个字节", async () => {
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  fs.writeFileSync(bd, "# 进度板\n| src/x.js | ghost | now <at=1> |\n");
  const before = fs.readFileSync(bd, "utf8");
  const r = await audit(d, [`--board=${bd}`]);
  assert.equal(r.code, 11, r.out + r.err);
  assert.equal(fs.readFileSync(bd, "utf8"), before, "audit 说了'只报不拒'，却动了板子");
});

test("板全干净时 audit 退 0（否则'没问题'和'没检查'分不开）", async () => {
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  const a = await claim(d, ["--file=src/clean.js", "--who=qoder", "--ttl=600"]);
  const token = /--at=(\d+)/.exec(a.out)[1];
  await board(d, ["--file=src/clean.js", "--who=qoder", "--at=" + token, `--board=${bd}`,
    "--row=| src/clean.js | qoder | now |"]);
  const r = await audit(d, [`--board=${bd}`]);
  assert.equal(r.code, 0, `干净板子应该退 0：\n${r.out}${r.err}`);
  assert.match(r.out, /每一行都对得上活锁/);
});

// ============ 新代码面的两条：崩溃回收 + 锁序 ============
test("持板锁的进程崩溃后，板锁必须被过期回收（不许永远 BOARD_BUSY）", async () => {
  // 夹具是一个**真子进程**：拿到板锁后 process.exit(0)，刻意不 release。
  // 不用 mock 假装崩溃——那样测的是我对 release 的想象，不是死掉的人留在盘上的现场。
  const d = mkChannel();
  const bd = path.join(d, "PROGRESS.md");
  fs.writeFileSync(bd, "# 进度板\n");
  const a = await claim(d, ["--file=src/one.js", "--who=qoder", "--ttl=600"]);
  const token = /--at=(\d+)/.exec(a.out)[1];

  const fixture = path.join(ROOT, "test", "fixtures", "hold-board-lock-and-die.mjs");
  const dead = spawnSync(process.execPath, [fixture, path.join(d, "claims"), "deadholder"], { encoding: "utf8" });
  assert.equal(dead.status, 0, `夹具没拿到板锁就退了：${dead.stdout}${dead.stderr}`);
  // 夹具那行输出必须收得到：它退出前最后一件事就是打印这行，管道上的异步写会被 exit 截掉。
  assert.ok((dead.stdout || "").trim(), "夹具没打印出现场（stdout 为空）——这条用例的前提没法核对");
  const witness = JSON.parse(dead.stdout.trim());
  assert.equal(witness.status, "acquired", `夹具报的不是"新拿到"：${dead.stdout}`);
  console.log(`  夹具（真子进程，拿锁后不 release 直接 exit）：${(dead.stdout || "").trim()}`);
  const boardLock = path.join(d, "claims", "__board__.lock");
  assert.ok(fs.existsSync(boardLock), "子进程退了，但盘上没有留下板锁——那这条用例没测任何东西");
  const deadSnapshot = fs.readFileSync(boardLock, "utf8");
  assert.match(JSON.parse(deadSnapshot).who, /^deadholder#\d+$/, `留下的板锁持有者名字不对：${deadSnapshot}`);
  // 夹具自己报的化身号必须就是盘上那一份：否则"死者留下的锁"这个前提只是我在叙述。
  assert.equal(String(JSON.parse(deadSnapshot).at), String(witness.at),
    `夹具报的化身 ${witness.at} 与盘上锁记的 ${JSON.parse(deadSnapshot).at} 不是同一把`);

  // (a) 当场：后来的写者拿不到，给 12（可重试），且不动板子
  const before = fs.readFileSync(bd, "utf8");
  const busy = await board(d, ["--file=src/one.js", "--who=qoder", "--at=" + token, `--board=${bd}`,
    "--row=| src/one.js | qoder | now |", "--wait=200"]);
  assert.equal(busy.code, 12, `死锁在场时应该先吃 12，实退 ${busy.code}：\n${busy.out}${busy.err}`);
  assert.equal(fs.readFileSync(bd, "utf8"), before, "拿不到板锁却动了板子");

  // (b) 回收：必须靠**过期**收回来，不是靠谁放开（死人不会 release）。
  // 每次失败重试前，盘上的板锁必须**还是死者那份字节**——
  // 一旦这里变了，就说明有别的代码路径把死锁删了/覆盖了，那测的就不是过期回收，而是另一条我没声明的门。
  const t0 = Date.now();
  let got = null, took = 0, tries = 0;
  while (Date.now() - t0 < 15000) {
    if (fs.existsSync(boardLock)) {
      assert.equal(fs.readFileSync(boardLock, "utf8"), deadSnapshot,
        `第 ${tries + 1} 次重试前，死者留下的板锁被人改动过了——回收不是靠过期发生的`);
    }
    const r = await board(d, ["--file=src/one.js", "--who=qoder", "--at=" + token, `--board=${bd}`,
      "--row=| src/one.js | qoder | now |", "--wait=200"]);
    tries++;
    took = Date.now() - t0;
    if (r.code === 0) { got = r; break; }
    assert.equal(r.code, 12, `回收路上出现了没定义过的退码 ${r.code}：\n${r.out}${r.err}`);
    await new Promise((s) => setTimeout(s, 150));
  }
  assert.ok(got, `等了 ${took}ms 板锁仍未被回收——崩溃的持有者把这张板永久卡死了`);
  console.log(`  回收耗时 ${took}ms / 重试 ${tries} 次（板锁 TTL ${BOARD_LOCK_TTL_S}s）`);
  // 判据钉在**盘上那份锁自己记的到期时刻**，不是"四千多毫秒"这种形容词：
  // 钉墙钟数会随机器快慢飘（夹具与 t0 之间的间隔就是浮动的），钉 at+ttl 才是同一条判据的两端。
  const deadAt = JSON.parse(deadSnapshot);
  const deadlineMs = Number(deadAt.at) + Number(deadAt.ttl) * 1000;
  assert.ok(t0 + took >= deadlineMs,
    `写成功落在 ${t0 + took - deadlineMs}ms（相对到期时刻），早于盘上记录的到期——那不是过期回收，是有人替死者 release 了，前提不成立`);
  assert.ok(tries >= 2, `只试了 ${tries} 次就成功，没经过 12 这一档，回收路径没被走到`);
  assert.match(fs.readFileSync(bd, "utf8"), /\| src\/one\.js \| qoder \| now\b/, "回收后写进去的行没落板");
  // 写成功后 writeBoard 在 finally 里放开板锁：盘上不该再留下锁文件。
  // 留着 = 后来的写者要吃 12，这条用例测的"崩溃不永久卡板"就变成了"这次不卡、下次卡"。
  assert.ok(!fs.existsSync(boardLock),
    "回收写完还留着死者的板锁——说明这次写根本没经过板锁，或 finally 没放");
});

test("锁序不变式：全仓不存在「持板锁时再取文件锁」的形状（AB-BA）", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "claims", "lock.js"), "utf8");
  const wb = /export function writeBoard\([\s\S]*?\n\}\n/.exec(src);
  assert.ok(wb, "找不到 writeBoard，锁序不变式失去对象");
  const body = wb[0];
  // 这条扫描必须和后面的"取锁点清点"配套才成立：只盯 writeBoard 的话，
  // 在别处新加一个取板锁点就绕过了它。清点把板锁钉死在 writeBoard 一处、文件锁钉死在 claim 一处，
  // "持板锁再取文件锁"这个嵌套才只剩 writeBoard 一个可能的发生地。
  const boardTake = body.indexOf("acquire({ claimsDir, file: BOARD_LOCK");
  assert.ok(boardTake >= 0, "writeBoard 不再取板级锁了？那第二道防线没了");
  // 关键一条：取了板锁之后，除板锁自身的 release 外不得再出现任何 acquire。
  // 注释里把"复验只读"写死：verifyHold 走 readLock/readFileSync，没有 wx/rename/acquire——
  // 否则下一个人会"顺手"把复验改成重新 claim 一次，AB-BA 就成立了。
  const nestedTake = body.slice(boardTake).split("\n")
    .filter((l) => /\bacquire\(/.test(l) && !/file: BOARD_LOCK/.test(l));
  assert.deepEqual(nestedTake, [],
    `持板锁期间又去取别的锁（AB-BA 的形状就这样长回来）：\n  ${nestedTake.map((s) => s.trim()).join("\n  ")}`);
  assert.match(body, /release\(\{ claimsDir, file: BOARD_LOCK/, "板锁必须在 finally 里放开，否则崩溃窗口全靠 TTL 兜");

  // verifyHold / auditBoard 必须是纯读：不取锁、不写文件。
  // 不用 new RegExp 拼函数名——从模板串造正则会把反斜杠吃掉一层（实测报
  // "Invalid regular expression: Unterminated group"，红的是夹具自己而不是被测代码）。
  function bodyOf(name) {
    const start = src.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}，这条不变式失去对象`);
    const end = src.indexOf("\n}\n", start);
    assert.ok(end > start, `${name} 的函数体没闭合到预期位置`);
    return src.slice(start, end);
  }
  for (const fn of ["verifyHold", "auditBoard"]) {
    const b = bodyOf(fn);
    assert.ok(!/\bacquire\(/.test(b), `${fn} 里出现了 acquire——它不再是只读复验，锁序声明作废`);
    assert.ok(!/writeFileSync|renameSync|unlinkSync/.test(b), `${fn} 里出现了写操作，只读承诺是假的`);
  }
  // 取锁点清点**按文件分开说**：把两个文件混进一条正则会测出假话——
  // 文件锁是 cli.js 交给 `lockOp(acquire, …)` 取的（不是 `acquire(` 直调），
  // 板锁只在 lock.js 的 writeBoard 里取。所以每个文件各有一条自己的上限。
  const lockTakes = [...src.matchAll(/\bacquire\(\{[^)]*?file: ([A-Za-z_][\w.]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(lockTakes)], ["BOARD_LOCK"],
    `lock.js 里的取锁点应当只有板锁，实得 ${lockTakes.join(", ") || "（无）"}——
     文件锁只能由调用方取，模块内多一个取锁点就多一条锁序`);
  const cliSrc = fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8");
  const cliTakes = [...cliSrc.matchAll(/\blockOp\(acquire\b/g)].length;
  assert.equal(cliTakes, 1,
    `cli.js 里取文件锁的地方应当只有 claim 那一处，实得 ${cliTakes} 处；多一处就多一条锁序`);
  assert.doesNotMatch(cliSrc, /\bBOARD_LOCK\b/,
    "cli.js 不许绕过 writeBoard 直接碰板锁——那板锁的持有/放开就不在同一个函数里了");
});

test("seal 不看令牌是决定，不是遗漏：seal 的代码路径里不得出现板级读取", () => {
  // 裁定理由（写进 README）：seal 的契约是"把我的声明封成密码学承诺"。
  // 把"别人有没有把我的行写坏"塞进签名前的判断，等于把我的可交付性挂在另一个进程的守规矩上——
  // 那会把可容忍的退化（板子被抹一行）升级成硬故障（我因别人而签不了）。
  const cli = fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8");
  const seal = /\nif \(cmd === "seal"\) \{([\s\S]*?)\n\}\n/.exec(cli);
  assert.ok(seal, "找不到 seal 分支，这条不变式会静默空跑");
  assert.doesNotMatch(seal[1], /board|Board|auditBoard|verifyHold|PROGRESS/,
    "seal 里出现了板级读取/令牌校验——越写者一旦能拦住签名，可交付性就挂在别人的守规矩上了");
  // 反向护栏：seal 只该依赖 roster + 私钥 + 信封
  assert.match(seal[1], /myKey\(/, "seal 分支被改写了？不变式的前提取不到");
});

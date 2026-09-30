// 文件占用锁的测试。测真实 CLI 进程的退出码——"抢锁失败返回几"只有在进程边界上才作数。
// 上一轮的教训：断言写成内部函数调用，就测不到参数解析、退出码、日志落盘这三件事。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lockFileName, markerOf } from "../src/claims/lock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.js");

function mkChannel() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-claims-"));
}
function claim(dir, args) {
  return run(CLI, ["claim", `--channel=${dir}`, ...args]);
}
function release(dir, args) {
  return run(CLI, ["release", `--channel=${dir}`, ...args]);
}
function locks(dir) {
  return run(CLI, ["locks", `--channel=${dir}`]);
}
function run(bin, args) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [bin, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code, out, err }));
  });
}

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
  const renew = claim(d, ["--file=src/c.js", "--who=owner", "--ttl=600"]);   // 会停在闸口
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
  const stealing = claim(d, ["--file=src/h.js", "--who=other", "--ttl=600"]);
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

test("真并发下续期不许抹掉抢占者：20 家续期 + 20 家抢占，自称赢的名字只能有 1 个", async () => {
  // 这条跑的是出厂实现 + 注入窗口（在临时副本里，不动在库文件）。
  // 判据若没被执行到（抢占方一家没赢），探针退出码 4，这条直接算失败——
  // 因为"0 轮双主"在这种情形下是空跑出来的绿灯，不是证据。
  const probe = path.join(ROOT, "tools", "claims", "renew-race.mjs");
  const r = spawnSync(process.execPath,
    [probe, ROOT, "1", "1000", "--inject=2500", "--stealdelay=1100", "--label=CI"],
    { encoding: "utf8", timeout: 180000 });
  const out = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 3,
    `探针退出码应为 3（判据被执行到且 0 轮双主）。实得 ${r.status}：\n${out}`);
  assert.match(out, /前置条件满足/);
});

test("脏锁不许被 release 抹掉（那会把别人正在写的锁当垃圾删）", async () => {
  const d = mkChannel();
  fs.mkdirSync(path.join(d, "claims"), { recursive: true });
  fs.writeFileSync(lockOf(d, "src/keep.js"), '{"who":"x"');
  const r = await release(d, ["--file=src/keep.js", "--who=x"]);
  assert.equal(r.code, 8, `${r.out}${r.err}`);
  assert.ok(fs.existsSync(lockOf(d, "src/keep.js")), "脏锁被裸删了");
});


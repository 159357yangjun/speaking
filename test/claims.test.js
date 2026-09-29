// 文件占用锁的测试。测真实 CLI 进程的退出码——"抢锁失败返回几"只有在进程边界上才作数。
// 上一轮的教训：断言写成内部函数调用，就测不到参数解析、退出码、日志落盘这三件事。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lockFileName } from "../src/claims/lock.js";

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

test("同持有者重复 claim = 续期，exit 0", async () => {
  const d = mkChannel();
  await claim(d, ["--file=src/a.js", "--who=qoder", "--ttl=600"]);
  const before = readLockRaw(d, "src/a.js").at;
  await new Promise((r) => setTimeout(r, 30));
  const r = await claim(d, ["--file=src/a.js", "--who=qoder", "--ttl=900"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /续期/);
  const after = readLockRaw(d, "src/a.js");
  assert.ok(after.at > before, "续期没重置 at，TTL 等于没延长");
  assert.equal(after.ttl, 900);
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

// 文档漂移测试：代码是唯一真源，文档必须与代码逐行一致。
// 目的不是"检查文档写得好"，是让"改了代码忘了改文档"这件事变成非零退出。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { digestOf } from "../src/proto/envelope.js";

const SIGNING_DOC = new URL("../docs/specs/03-signing.md", import.meta.url);
const SCHEMA = new URL("../proto/envelope.schema.json", import.meta.url);

// 从代码取真源：用一个假信封导出签名域的"形状"= 版本行 + 字段名有序列表。
// 只比字段名与顺序，不比值——body-sha256 那行代码里是真哈希，文档里是占位符，比整行必然假报警。
function domainShapeFromCode() {
  const d = digestOf({
    seq: "1", from: "x", to: "y", type: "offer",
    done: true, nonce: "n", body: "b",
  });
  return d.split("\n").map((l) => (l.startsWith("agent-relay/") ? l : l.slice(0, l.indexOf("="))));
}

// 从文档取声明：找那个以 agent-relay/ 开头的围栏代码块
function domainShapeFromDoc() {
  const md = readFileSync(SIGNING_DOC, "utf8");
  const blocks = [...md.matchAll(/```[^\n]*\r?\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  const b = blocks.find((x) => /^agent-relay\/v/.test(x));
  if (!b) throw new Error(`${SIGNING_DOC.pathname} 里找不到以 agent-relay/ 开头的签名域示例块`);
  return b
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("agent-relay/") ? l : l.replace(/^([a-z0-9-]+)=.*$/, "$1")));
}

test("文档声明的签名域形状（版本 + 字段名有序列表）与代码逐行一致", () => {
  const code = domainShapeFromCode();
  const doc = domainShapeFromDoc();
  assert.deepEqual(
    doc,
    code,
    `\n文档声明的签名域与代码不符。\n  代码: ${JSON.stringify(code)}\n  文档: ${JSON.stringify(doc)}\n`
  );
});

test("文档声明的行数与代码一致（防'加行漏文档'）", () => {
  assert.equal(
    domainShapeFromDoc().length,
    domainShapeFromCode().length,
    "签名域行数漂移：代码加了字段但文档没同步"
  );
});

test("schema 的 sig 描述不得声称 done 不在签名域", () => {
  const s = JSON.parse(readFileSync(SCHEMA, "utf8"));
  const desc = s.properties.sig.description;
  assert.ok(!/不含\s*done/.test(desc), `schema 的 sig 描述与代码矛盾：${desc}`);
  assert.ok(/done/.test(desc), "schema 的 sig 描述必须明确 done 在不在签名域");
});

test("schema 的 done 描述不得声称刻意排除在签名域外", () => {
  const s = JSON.parse(readFileSync(SCHEMA, "utf8"));
  assert.ok(!/刻意排除在签名域之外/.test(s.properties.done.description),
    `schema 的 done 描述与代码矛盾：${s.properties.done.description}`);
});

// ============ 锁的退码表：README 写的数字必须等于代码里的常量 ============
// 这条是结构比对，不是 grep 关键词：把表抽成 {退码 → 行文本}，与 src/claims/lock.js
// 导出的 EXIT 逐值对齐。改代码不改文档 → 红；改文档不改代码 → 红。
const README = new URL("../README.md", import.meta.url);
const { EXIT } = await import("../src/claims/lock.js");

function exitTableFromDoc() {
  const md = readFileSync(README, "utf8");
  const sec = md.split(/^## /m).find((s) => s.startsWith("文件占用锁"));
  if (!sec) throw new Error("README 里找不到「文件占用锁」这一节，退码表失去比对对象");
  const rows = [...sec.matchAll(/^\|\s*(\d+)\s*\|(.*)$/gm)].map((m) => ({ code: Number(m[1]), rest: m[2] }));
  if (rows.length === 0) throw new Error("「文件占用锁」一节里没有以退码开头的表格行");
  return rows;
}

test("README 的锁退码表与代码 EXIT 常量逐值一致（不多、不少、不改号）", () => {
  const doc = exitTableFromDoc();
  const docCodes = doc.map((r) => r.code).sort((a, b) => a - b);
  const codeCodes = [...new Set(Object.values(EXIT))].sort((a, b) => a - b);
  assert.deepEqual(docCodes, codeCodes,
    `\n退码表与代码不符。\n  代码 EXIT: ${JSON.stringify(codeCodes)}\n  README 表: ${JSON.stringify(docCodes)}\n`);
});

test("README 必须把关键语义钉在对应退码上，而不是只列个数字", () => {
  const byCode = Object.fromEntries(exitTableFromDoc().map((r) => [r.code, r.rest]));
  // 3 = 争用：必须写明不阻塞 + 留痕落在哪个文件
  assert.match(byCode[3] ?? "", /waiters\.log/, "退码 3 那一行没写留痕文件，读者不知道该去哪看「它在等」");
  assert.match(byCode[3] ?? "", /否/, "退码 3 必须显式回答阻塞与否");
  // 5 = 被抢占后原方回来：必须写明"不是当前持有者"
  assert.match(byCode[5] ?? "", /持有者/, "退码 5 那一行没写明是归属判定");
  // 6 = TTL 非法：必须写明是拒建而不是取默认值
  assert.match(byCode[6] ?? "", /拒建|TTL/, "退码 6 那一行没说明它拒绝的是什么");
  // 8 = 脏锁：必须写明回收上界与"release 也不给裸删"，否则读者会去手删锁文件
  assert.match(byCode[8] ?? "", /120/, "退码 8 那一行没写回收上界，读者不知道要等多久才收敛");
  assert.match(byCode[8] ?? "", /release/i, "退码 8 那一行没说明 release 的行为");
  // 9 = 续期失败：必须写明动作是"停笔"，而且**不许当成可重试**
  assert.match(byCode[9] ?? "", /停笔/, "退码 9 那一行没给出动作，调用方会把它当普通失败重试着继续写");
  assert.match(byCode[9] ?? "", /不许重试|重新 claim/, "退码 9 必须区分'停笔'与'可重试'：重试要用新令牌，不是原地再写一次");
  // 10 = 文件系统失败：必须与协议结论区分开，否则有人会把环境问题当判负去改锁
  assert.match(byCode[10] ?? "", /不是锁判负|修目录|修环境/, "退码 10 那一行没和「锁判负」划清界限");
});

test("代码里 EXIT 的每个值都能被 CLI 真跑到（防「表里有、代码里永远不会返回」）", async () => {
  const { spawnSync, spawn } = await import("node:child_process");
  const fsv = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const cli = new URL("../src/cli.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
  const dir = fsv.mkdtempSync(path.join(os.tmpdir(), "relay-exit-"));
  const run = (args) => spawnSync(process.execPath, [cli, ...args, `--channel=${dir}`], { encoding: "utf8" }).status;
  const observed = new Set([
    run(["claim", "--file=src/x.js", "--who=a", "--ttl=600"]),          // 0
    run(["claim", "--file=src/x.js", "--who=b", "--ttl=600"]),          // 3
    run(["claim", "--file=src/x.js", "--who=a"]),                        // 6：缺 --ttl
    run(["claim", "--who=a", "--ttl=600"]),                              // 2：缺 --file
    run(["release", "--file=src/x.js", "--who=b"]),                      // 5
    run(["release", "--file=src/x.js", "--who=a"]),                      // 0
    run(["release", "--file=src/x.js", "--who=a"]),                      // 4
  ]);
  // 8 需要一个**读不懂的锁**，不是构造出来的返回值——所以现场写一个截断文件再真跑
  fsv.mkdirSync(path.join(dir, "claims"), { recursive: true });
  fsv.writeFileSync(path.join(dir, "claims", "src_dirty.js.lock"), '{"who"');
  observed.add(run(["claim", "--file=src/dirty.js", "--who=a", "--ttl=600"]));
  // 10 = 文件系统不可用：把 claims 做成一个**普通文件**，mkdir 立刻 ENOENT/EEXIST 类错误。
  // 这条必须真跑：退码表里写 10 而代码从没返回过它，等于对外承诺了一个不存在的诊断信号。
  const dir2 = fsv.mkdtempSync(path.join(os.tmpdir(), "relay-exit2-"));
  fsv.writeFileSync(path.join(dir2, "claims"), "这不是目录");
  observed.add(spawnSync(process.execPath, [cli, "claim", "--file=src/x.js", "--who=a", "--ttl=60", `--channel=${dir2}`], { encoding: "utf8" }).status);
  // 9 = 续期失败：靠 .freeze 闸口把临界钉死，不靠运气撞。码必须从那次真跑里**收回来**，
  // 不能写成 observed.add(9)——那等于把断言的结果当断言的证据。
  // 闸口只认 AGENT_RELAY_TEST_GATE（生产路径上这条代码不存在），所以这里要显式打开；
  // 并且等子进程**自己报到**（.at-gate），不是 sleep 一个"大概够"的毫秒数——
  // 上一版用 sleep 200ms，闸口一关就再也没收到过 9 而测试仍然"绿"，那种默默不成立比红更糟。
  const dir3 = fsv.mkdtempSync(path.join(os.tmpdir(), "relay-exit3-"));
  const cli3 = (args) => new Promise((res) => {
    const pr = spawn(process.execPath, [cli, ...args, `--channel=${dir3}`], {
      encoding: "utf8", env: { ...process.env, AGENT_RELAY_TEST_GATE: "1" },
    });
    pr.on("close", (code) => res(code));
  });
  fsv.mkdirSync(path.join(dir3, "claims"), { recursive: true });
  const lk = path.join(dir3, "claims", "src_g.js.lock");
  fsv.writeFileSync(lk, JSON.stringify({ who: "a", at: Date.now(), ttl: 600 }));
  fsv.writeFileSync(lk + ".freeze", "hold");
  const renewing = cli3(["claim", "--file=src/g.js", "--who=a", "--ttl=600"]);
  const gateUntil = Date.now() + 8000;
  while (!fsv.existsSync(lk + ".at-gate") && Date.now() < gateUntil) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fsv.existsSync(lk + ".at-gate"),
    "子进程没到闸口报到：这条覆盖退码 9 的用例前提没成立，不许算通过");
  fsv.writeFileSync(lk, JSON.stringify({ who: "b", at: Date.now(), ttl: 600 }));   // 闸口期间换化身
  fsv.rmSync(lk + ".freeze");
  observed.add(await renewing);
  const unreachable = [...new Set(Object.values(EXIT))].filter((c) => c !== 0 && !observed.has(c));
  assert.deepEqual(unreachable, [],
    `这些退码在 README/代码里存在，但本轮 CLI 实跑一次都没命中：${unreachable.join(", ")}。\n` +
    `本轮实跑覆盖：${[...observed].sort().join(", ")}。`);
});

test("文档与 schema 的协议版本必须等于代码版本", () => {
  const codeVersion = domainShapeFromCode()[0];
  const doc = readFileSync(SIGNING_DOC, "utf8");
  const occurrences = [...doc.matchAll(/agent-relay\/v\d+/g)].map((m) => m[0]);
  assert.ok(occurrences.length > 0, "文档里找不到任何 agent-relay/vN 版本号");
  for (const v of occurrences) {
    assert.equal(v, codeVersion, `docs/specs/03-signing.md 里有 ${v}，代码是 ${codeVersion}`);
  }
});

// ============ 写板 CAS 与测试闸口：文档/代码不许各说各话 ============
test("README 必须写明 renewed 的承诺边界，并且 board 是那条边界的落地", () => {
  const md = readFileSync(README, "utf8");
  assert.match(md, /只承诺一件事/, "README 没界定 renewed 到底承诺多久——不界定就会被当成保险");
  assert.match(md, /不承诺[\s\S]{0,40}到我下一次检查之前/, "必须明写'不承诺到下一次检查前'，否则读者以为拿到 0 就可以慢慢写");
  assert.match(md, /cli\.js board/, "README 讲了边界却没给出落地手段：board 那条命令必须在表里");
  // 窗口必须带数，不能只写"很小"
  assert.match(md, /\*\*2\.12ms\*\*/, "复验到落盘的残余窗口要写实测数，不写形容词");
});

test("写板 CAS 在代码里真的是'先复验后落盘'，且复验不过时一个字节都不写", () => {
  const src = readFileSync(new URL("../src/claims/lock.js", import.meta.url), "utf8");
  const fn = /export function writeBoard\([\s\S]*?\n\}/.exec(src);
  assert.ok(fn, "找不到 writeBoard：写板 CAS 被摘掉了，README 那节立刻是空话");
  const body = fn[0];
  const verifyAt = body.indexOf("verifyHold(");
  const writeAt = body.indexOf("fs.writeFileSync(part");
  assert.ok(verifyAt >= 0, "writeBoard 没做归属复验");
  assert.ok(writeAt > verifyAt, "落盘发生在复验之前，或根本没复验");
  assert.match(body, /if \(held\.status !== "held"\) return \{ \.\.\.held, wrote: false \};/,
    "复验失败必须原样返回且不写盘——少了这句就是'拒了但还是写了'");
  assert.match(body, /renameSync\(part, boardPath\)/, "写板必须走 .part → rename，和消息封帧同一个原子边界");
});

test("测试专用延时闸口只能由环境变量打开（生产路径上这条代码不存在）", () => {
  const src = readFileSync(new URL("../src/claims/lock.js", import.meta.url), "utf8");
  assert.match(src, /export const GATE_ENV = "AGENT_RELAY_TEST_GATE"/, "闸口开关必须是具名常量，便于两侧一起检索");
  const fn = /function pauseForFreeze\([\s\S]*?\n\}/.exec(src);
  assert.ok(fn, "找不到 pauseForFreeze");
  assert.match(fn[0], /if \(!gateEnabled\(\)\) return false;/,
    "函数第一句就必须按环境变量返回：只看磁盘等于给任何能写该目录的进程一条 25s 的拒绝服务通道");
  const first = fn[0].split("\n").slice(0, 3).join("\n");
  assert.doesNotMatch(first, /existsSync\(f\)/, "在 gateEnabled 判定之前不允许出现任何磁盘探测");
});

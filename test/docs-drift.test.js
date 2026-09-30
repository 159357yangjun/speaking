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
  // 9 = 续期失败：必须写明动作是"停手"，不是"重试"
  assert.match(byCode[9] ?? "", /停手|不许写/, "退码 9 那一行没给出动作，调用方会当成普通失败接着写板");
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
  const dir3 = fsv.mkdtempSync(path.join(os.tmpdir(), "relay-exit3-"));
  const cli3 = (args) => new Promise((res) => {
    const pr = spawn(process.execPath, [cli, ...args, `--channel=${dir3}`], { encoding: "utf8" });
    pr.on("close", (code) => res(code));
  });
  fsv.mkdirSync(path.join(dir3, "claims"), { recursive: true });
  const lk = path.join(dir3, "claims", "src_g.js.lock");
  fsv.writeFileSync(lk, JSON.stringify({ who: "a", at: Date.now(), ttl: 600 }));
  fsv.writeFileSync(lk + ".freeze", "hold");
  const renewing = cli3(["claim", "--file=src/g.js", "--who=a", "--ttl=600"]);
  await new Promise((r) => setTimeout(r, 200));                 // 让它停在闸口上
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

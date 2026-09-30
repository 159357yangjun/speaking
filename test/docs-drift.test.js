// 文档漂移测试：代码是唯一真源，文档必须与代码逐行一致。
// 目的不是"检查文档写得好"，是让"改了代码忘了改文档"这件事变成非零退出。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { digestOf } from "../src/proto/envelope.js";
// 计数行的判读函数与打印函数同处定义（src/claims/summary.js）。
// 这里**直接 import 它**而不是正则读它：文档说"汇总行能被读到"，就得用真的判读器验一遍。
import { parseSummary } from "../src/claims/summary.js";

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
const CORRUPT_GRACE = 120;   // 与 lock.js 的 CORRUPT_GRACE_S 同值，下面有断言核它
const rootDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");

// 【全机位口径】凡被文档当证据引用的可执行探针，套件里必须有一条**真的 spawn 它一次**的用例。
// 这条口径的来由：上一批 `board-race.mjs:35` 写成 `process.argv.slice(3)`，仓库路径被整个吞掉，
// 探针一跑就 ENOENT —— 而 `npm test` 当时报 121/121 全绿。原因不是"测试不够严"，
// 是**套件与探针之间根本没有执行边**：所有用例都在读它的源码文本，全绿只证明"关于它的断言对"，
// 不证明"它能跑"。文本核对永远看不见"参数偏移"这类错，因为它从没把参数喂进去过。
//
// 记法用"真跑一次就往 Set 里登记"，不用"扫源码里有没有 spawn 字样"：
// 后者会被注释、被 readFileSync 的字符串、被一条从不执行的分支骗过去；前者只能由实际发生凑齐。
const SPAWNED = new Set();
function runProbe(rel, args, opts = {}) {
  SPAWNED.add(rel);
  return spawnSync(process.execPath,
    [fileURLToPath(new URL("../" + rel, import.meta.url)), ...args],
    { encoding: "utf8", timeout: 300000, ...opts });
}
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
  // 11 = 检测：必须写明"只报不拒"，否则读者以为报了就会被拦下
  assert.match(byCode[11] ?? "", /只报不拒/, "退码 11 必须写明它只报警、不拦写——拦写要改信封，本轮不做");
  // 12 = 板级排队：必须写明"可重试"，且与 9（停笔） opposite，否则调用方会把两者一起当成丢锁
  assert.match(byCode[12] ?? "", /可以重试/, "退码 12 那一行没写明可重试；它和 9 的动作正好相反");
  const retry9 = /重试/.test(byCode[9] ?? "停笔，不许原地重试");
  assert.doesNotMatch(byCode[9] ?? "", /可以重试|可重试/, "退码 9 绝不能被写成可重试——那是把丢锁当成排队中");
  void retry9;
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
  // 11 = audit 发现越写者；12 = board 板级排队超时。两个都真跑：
  // 表里写了码却从没被任何路径返回过，等于对外承诺了一个不存在的诊断信号。
  const auditDir = fsv.mkdtempSync(path.join(os.tmpdir(), "relay-exit11-"));
  fsv.mkdirSync(path.join(auditDir, "claims"), { recursive: true });
  fsv.writeFileSync(path.join(auditDir, "PROGRESS.md"), "| src/z.js | ghost | now <at=1> |\n");
  observed.add(spawnSync(process.execPath, [cli, "audit", `--channel=${auditDir}`,
    `--board=${path.join(auditDir, "PROGRESS.md")}`], { encoding: "utf8" }).status);
  const busyDir = fsv.mkdtempSync(path.join(os.tmpdir(), "relay-exit12-"));
  fsv.mkdirSync(path.join(busyDir, "claims"), { recursive: true });
  const held = spawnSync(process.execPath, [cli, "claim", `--channel=${busyDir}`,
    "--file=src/b.js", "--who=a", "--ttl=600"], { encoding: "utf8" }).stdout;
  const heldToken = /--at=(\d+)/.exec(held)?.[1];
  fsv.writeFileSync(path.join(busyDir, "claims", "__board__.lock"),
    JSON.stringify({ who: "b#99997", at: Date.now(), ttl: 600 }));
  observed.add(spawnSync(process.execPath, [cli, "board", `--channel=${busyDir}`, "--file=src/b.js",
    "--who=a", "--at=" + heldToken, `--board=${path.join(busyDir, "PROGRESS.md")}`,
    "--row=| src/b.js | a | now |", "--wait=200"], { encoding: "utf8" }).status);
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
  // 窗口必须带数，不能只写形容词；而且这个数必须能重跑——
  // 上一版这条钉的是字面量 "2.12ms"，那个数是会话里手工插桩量的，脚本没进仓，
  // 于是断言只保证"文档里印着这串字符"，不保证这串字符还能被生产出来。
  assert.match(md, /\*\*复验通过 → 落盘完成\*\*[\s\S]{0,120}?\d+\.\d+ms/, "复验到落盘的残余窗口要写实测数，不写形容词");
  assert.match(md, /window-measure\.mjs/, "窗口数字必须给出重跑命令，否则它就是一次性的叙述");
  assert.ok(existsSync(new URL("../tools/claims/window-measure.mjs", import.meta.url)),
    "README 引用了 tools/claims/window-measure.mjs，可它不在仓里——按本项目的规矩等于不存在");
});

test("写板 CAS 在代码里真的是'先复验后落盘'，而且复验跑两次", () => {
  const src = readFileSync(new URL("../src/claims/lock.js", import.meta.url), "utf8");
  const fn = /export function writeBoard\([\s\S]*?\n\}\n/.exec(src);
  assert.ok(fn, "找不到 writeBoard：写板 CAS 被摘掉了，README 那节立刻是空话");
  const body = fn[0];
  const verifyAt = body.indexOf("verifyHold(");
  const writeAt = body.indexOf("fs.writeFileSync(part");
  assert.ok(verifyAt >= 0, "writeBoard 没做归属复验");
  assert.ok(writeAt > verifyAt, "落盘发生在复验之前，或根本没复验");
  // 复验必须是两次：入口一次，拿到板级锁之后再一次。
  // 只验入口的话，等板级锁那几毫秒里自己的文件锁照样可能被抢走——那正是我们要消灭的信念。
  const verifies = (body.match(/verifyHold\(/g) || []).length;
  assert.ok(verifies >= 2, `writeBoard 只复验了 ${verifies} 次；等板级锁期间丢的锁没人再查`);
  assert.ok((body.match(/wrote: false/g) || []).length >= 2, "两次复验都必须有不写盘的回程");
  assert.match(body, /if \(!fs\.existsSync\(boardPath\)[\s\S]*|const before = fs\.existsSync\(boardPath\)/,
    "读板必须先确认板子存在，否则首次写会凭空建文件而无人知晓");
  assert.match(body, /renameSync\(part, boardPath\)/, "写板必须走 .part → rename，和消息封帧同一个原子边界");
  // 令牌进的是已有单元格，不是新列：列数是对话层在读的东西
  assert.match(body, /stampToken\(/, "board 必须把化身令牌盖进行文本，否则 audit 无从检测");
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

// ============ README 引用的"现场证据源"：文件在、参数在、退码在 ============
// 本轮唯一的现场证据是那两个并发探针加一个夹具。它们只在提交信息里存在过一次的账，
// 这次一起清：README 按文件名引用，就得能按文件名跑到，且引用的参数/退码与脚本自己一致。
// 现场证据表里点名的那几个探针：既用来核对 README 与脚本自己的退码表，
// 也用来核对"套件里是不是真的 spawn 过它"（见文件末尾那条覆盖断言）。
const PROBE_ROWS = [
  ["tools/claims/board-race.mjs", [0, 3, 4, 9]],
  ["tools/claims/renew-race.mjs", [0, 3, 4, 9]],
  ["tools/claims/window-measure.mjs", [0, 8, 9]],
  ["tools/claims/red-demo.mjs", [0, 7, 8, 9]],
  ["tools/claims/selfcheck-harness.mjs", [0, 8, 9]],
];

test("README 引用的探针与夹具必须真实存在，且写明的参数、退码与脚本一致", () => {
  const md = readFileSync(README, "utf8");
  // 具名退码从 summary.mjs 取数：判读方与打印方共用一处定义，改常量名/值都会被这里抓到。
  const sumSrc = readFileSync(new URL("../src/claims/summary.js", import.meta.url), "utf8");
  const SYMBOLS = {};
  for (const m of sumSrc.matchAll(/export const ([A-Z0-9_]+) = (\d+);/g)) SYMBOLS[m[1]] = Number(m[2]);
  assert.ok(Number.isInteger(SYMBOLS.HARNESS_EXIT),
    "summary.js 里必须给『测具不可信』一个具名退码：它和『抓到缺陷』『没抓到』都要分得开");
  for (const [rel, codes] of PROBE_ROWS) {
    const url = new URL("../" + rel, import.meta.url);
    assert.ok(existsSync(url), `README 按文件名引用了 ${rel}，可它不在仓里——那等于不存在`);
    const src = readFileSync(url, "utf8");
    // 判读"实际会退哪些码"不再正则扫 `process.exit(...)`——那已经骗过我一次
    // （收尾写成 `process.exit(lost.length > 0 ? 0 : 3)`，0 和 3 整个漏读，"实际集合"被看成 [9]）。
    // 现在读工具**自己声明的退码表** `const EXIT_CODES = { … }`：具名常量从 summary.mjs 取数，
    // 且同一张表必须由汇总行打印出来（codes: Object.values(EXIT_CODES)）——
    // 打印的、判读的、README 解释的，三份必须是同一个定义处。
    const table = /\bconst EXIT_CODES = \{([^}]*)\}/.exec(src);
    assert.ok(table, `${rel} 没有声明 EXIT_CODES 退码表——判读只能靠猜形状，改写法就静默失去保护`);
    const entries = [...table[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*(\d+|[A-Z][A-Z0-9_]*)/g)];
    assert.ok(entries.length >= 2, `${rel} 的 EXIT_CODES 表读不出条目：${table[1].trim().slice(0, 80)}`);
    // 用 m[1]/m[2] 明写，不用 `([, v])`：上面第一版就是这么错的——
    // `[, v]` 取到的是**键名**而不是值，于是 foundLoss/clean/badUsage 被当成"解不出的常量"，
    // 一个判读器自己读错字段序号，正是要防的那类"看起来是代码错了、其实是判据写歪了"。
    const resolved = entries.map((m) => (SYMBOLS[m[2]] !== undefined ? SYMBOLS[m[2]] : Number(m[2])));
    const unresolved = entries.filter((m) => !/^\d+$/.test(m[2]) && SYMBOLS[m[2]] === undefined).map((m) => m[2]);
    assert.deepEqual(unresolved, [],
      `${rel} 的退码表引用了 summary.mjs 里没有的常量：${unresolved.join(", ")}——解不出数就等于读不到计数`);
    const inCode = [...new Set(resolved)].sort((a, b) => a - b);
    assert.deepEqual(inCode, codes,
      `${rel} 声明的退码是 ${inCode.join(", ")}，README 那行按 ${codes.join(", ")} 解释的——对不上就是文档过期`);
    for (const m of entries) {
      // m[0] 是整段匹配（"foundLoss: 0"），m[1] 才是成员名——上一版这里写的是 `const [name] of entries`，
      // 于是"用到没用到"的检索拿整段匹配去拼字符串，永远拼不中。判读器自己下标读错，
      // 报出来的是一条看起来很有道理的假红：正是这条通令针对的形状。
      assert.ok(src.includes(`EXIT_CODES.${m[1]}`),
        `${rel} 声明了退码 ${m[1]} 却没有哪条出口用到它——表在骗 README`);
    }
    assert.ok(src.includes("codes: [...new Set(Object.values(EXIT_CODES))]"),
      `${rel} 没把退码表打进汇总行：读不到计数与计数为 0 就又长成一个样子了`);
    assert.ok(src.includes("printSummary(") && src.includes("crossCheck("),
      `${rel} 没走 summary.mjs 的打印/印证——共用一处定义这件事，写在注释里不算实现`);
    const row = md.split(/\r?\n/).find((l) => l.startsWith(`| \`${rel}\``));
    assert.ok(row, `README 必须有一行以 | \`${rel}\` 开头：探针不能只在提交信息里存在`);
    for (const c of codes) assert.ok(row.includes(`**${c} =`), `README 那行没解释退码 ${c} 的含义`);
    // README 教人用的每个 --flag，脚本里必须真有这个锚点（写了却不认，是静默空跑的开端）
    for (const f of new Set([...row.matchAll(/--([a-z-]+)/g)].map((m) => m[1]))) {
      assert.ok(src.includes(`--${f}`), `README 教人用 --${f}，但 ${rel} 里找不到这个锚点`);
    }
  }
  // --unlocked 是本轮补的账：README 那对 0/6 ↔ 6/6 的"改前"一列之前不可重跑
  const br = readFileSync(new URL("../tools/claims/board-race.mjs", import.meta.url), "utf8");
  assert.match(br, /--unlocked/, "board-race 不再支持 --unlocked，README 的对照列就只有一列能重跑");
  assert.match(br, /--unlocked 必须配 --inject/, "对照列不注入会产出'改前也干净'这种假绿灯，脚本必须拦住");
  assert.match(md, /0\/6/, "README 要写明'改前'那一列的数字");
  assert.match(md, /6\/6/, "README 要写明'加板级锁后'那一列的数字");

  const fxUrl = new URL("../test/fixtures/hold-board-lock-and-die.mjs", import.meta.url);
  assert.ok(existsSync(fxUrl), "README 引用的崩溃夹具不在仓里");
  const fx = readFileSync(fxUrl, "utf8");
  assert.match(fx, /process\.exit\(0\)/, "夹具必须真的直接退出——它不 exit，测的就不是崩溃");
  assert.doesNotMatch(fx, /\brelease\s*\(/, "夹具里出现了 release：那测的是正常收尾，不是死者留下的现场");
  assert.match(fx, /fs\.writeSync\(1,/, "夹具打印后立刻 exit：console.log 走管道会被截断，证据源自己静默失效");

  // README 里引用的三条用例名必须真的存在（标题逐字对得上）
  const claims = readFileSync(new URL("./claims.test.js", import.meta.url), "utf8");
  for (const name of [
    "持板锁的进程崩溃后，板锁必须被过期回收（不许永远 BOARD_BUSY）",
    "锁序不变式：全仓不存在「持板锁时再取文件锁」的形状（AB-BA）",
    "seal 不看令牌是决定，不是遗漏：seal 的代码路径里不得出现板级读取",
  ]) {
    assert.ok(claims.includes(`test("${name}"`), `README 引用的用例名在 test/claims.test.js 里不存在：${name}`);
    assert.ok(md.includes(name.slice(0, 12)), `README 没把这条用例名写出来：${name}`);
  }
});

// 上一条用例只**读文本**核对锚点，它挡不住"参数偏移"：本轮 board-race 把
// `process.argv.slice(2)` 写成 slice(3)，仓库路径被整个吞掉，探针在 cpSync 里炸 ENOENT，
// 而 `npm test` 121/121 全绿——因为没有任何一条用例子进程真的跑过它。
// 文档里写着"这一列能用这条命令重跑"，就必须有人把那条命令真跑一遍。
test("探针必须真被跑起来：board-race 的入参契约与两条对照列都由现跑核对", () => {
  // 每组参数里已经带了仓库路径（写错的用例正是要把路径放在错的位置），这里不再补一次。
  const run = (args) => runProbe("tools/claims/board-race.mjs", args);
  const ROOT = rootDir;

  // 这几类写错的命令：必须在入口就响，而且**要响在该响的那一处**——
  // 只断言"退了 9"是不够的：摘掉 ROOT 那道护栏后，同一个错误会一路走到 spawn 一个不存在的
  // cli.js，最后由"没拿到令牌"替它报 9（M51 实测就是这么绿的）。退码对、归因错，
  // 读的人照样会去查错的地方，所以每条都钉它自己的那句话。
  const wrong = [
    [["3", ROOT], "参数顺序写反（轮数占了仓库路径的位置）", /不像仓库/],
    [["5"], "第一个参数根本不是仓库", /不像仓库/],
    [[ROOT, "2", "600"], "注入值漏写 --inject= 前缀（裸数字）", /不认识的参数/],
    [[ROOT, "3x"], "轮数不是正整数", /轮数必须是正整数/],
    [[ROOT, "2", "--inject=abc"], "注入值写坏（旧版静默当成『没注入』并照样打印 inject:0）", /--inject= 必须是正整数/],
    [[ROOT, "2", "--inject=600", "--unlocked", "--typo=1"], "多出不认识的开关", /不认识的参数/],
  ];
  for (const [args, why, msg] of wrong) {
    const r = run(args);
    assert.equal(r.status, 9, `${why}：期望退 9（用法错），实际退 ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
    assert.match(r.stderr, msg, `${why}：退了 9，但那句话不是这一类的归因`);
  }

  const need = ["rounds", "measured", "lost", "rulerMismatch", "rulerApplicable", "code"];
  // 改后那一列：板级锁在，3 轮都不许丢行
  const after = run([ROOT, "3", "--inject=600"]);
  assert.equal(after.status, 3, `带板级锁的对照应退 3（干净），实际退 ${after.status}\n${after.stdout}\n${after.stderr}`);
  const s1 = parseSummary(after.stdout, "board-race", need);
  assert.equal(s1.measured, 3, "实测轮数必须等于安排的轮数");
  assert.equal(s1.lost, 0, `板级锁在却丢了 ${s1.lost} 行：README 那句"改后 0/6"就是假的`);
  assert.equal(s1.rulerApplicable, 3, "第二把尺子一轮都没说话，等于这张表只有一把尺子");
  assert.equal(s1.rulerMismatch, 0, "两把尺子不同向：这份表不可信");
  // 改前那一列：拆掉板级锁 + 注入 600ms，必须**当场抓到丢行**（退 0 才是好消息）
  const before = run([ROOT, "3", "--inject=600", "--unlocked"]);
  assert.equal(before.status, 0, `拆掉板级锁后仍退 ${before.status}（= 没撞出缺陷）：README 的"改前"一列不可重跑\n${before.stdout}\n${before.stderr}`);
  const s2 = parseSummary(before.stdout, "board-race", need);
  assert.ok(s2.lost > 0, `改前形状必须抓到丢行，实际 lost=${s2.lost}`);
  assert.equal(s2.rulerMismatch, 0, "改前那列两把尺子不同向：这张对照表不可用");
  assert.equal(s2.unlocked, 1, "汇总行没记 unlocked：读的人分不出这是改前还是改后");
  // 一句"丢了 N 行"必须自带非零分母：没有一轮跑成竞争时，不许凭空签发缺陷结论。
  assert.ok(s2.applicable > 0, `报 lost=${s2.lost} 却只有 applicable=${s2.applicable}：结论没有承载它的样本`);

  // 注入超过板级锁的排队预算 ⇒ 第二家一律被拒 ⇒ "两家都自称写成功"这个前提一次都没成立。
  // 上一版这里错得很典型：板子上自然只剩一行，旧判据把它数成 lost=6/6 还退 0（=指控"缺陷在场"），
  // 而那其实是"这场竞争根本没跑成"。现在必须退 4，并把被拒的轮单独报出来。
  const over = run([ROOT, "1", "--inject=3000"]);
  assert.equal(over.status, 4, `注入 3000ms ≥ BOARD_WAIT_MS 时应退 4（前提不成立），实际退 ${over.status}\n${over.stdout}\n${over.stderr}`);
  const s3 = parseSummary(over.stdout, "board-race", [...need, "refused", "applicable"]);
  assert.equal(s3.applicable, 0, "这一档没有任何一轮两家都写成：判据没被走到");
  assert.equal(s3.lost, 0, "『没跑成竞争』不许计进 lost——那是指控，不是测量");
  assert.equal(s3.refused, 1, "被拒的轮必须单独报出来，否则读表的人会以为这些轮不存在");
  // 退 4 这个数字本身不解释自己：`code` 是按 applicable 算的，摘掉那段诊断输出后**退码照旧是 4**，
  // 读的人只剩一个孤零零的 4（M55 实测就是这么绿的）。归因必须印在报警行里，所以按文本核。
  assert.match(over.stderr, /前提不成立/,
    "退 4 却没打出『前提不成立』那句：一个没有归因的退码等于让下一个人重新猜一遍");
  assert.match(over.stderr, /BOARD_WAIT_MS/,
    "诊断里必须给出为什么没跑成（注入 ≥ 板级锁排队预算），否则只知道'这次没量到'");
  assert.match(over.stdout, /有一家被拒\/没退 0/,
    "人读的那份逐轮表也要标出'本轮没跑成竞争'，不许留成一行★ 有一行整块丢了那种误导");
});

// README 写的板锁 TTL 与代码常量一致（数字抄错=文档说谎）
test("renew-race 也必须有执行边：真跑 1 轮，判据被走到、汇总行的 code 就是真退码", () => {
  // 上一批 board-race 坏了而套件全绿那件事之后，"探针只被读文本核对过"就不能再留成缺口。
  // 这一条不重复 22.6 那对统计数字（那是测量），它只验**这台仪器能开机**：
  // 判据没被走到时探针自己会退 4（precondition=1），那正是"跑了但什么都没量"的形状。
  // 这一条只验**这台仪器能开机、且它对自己的状态说得对**，不验测量结论（结论在 22.6 那对数字里）。
  //
  // 第一版把它写错了：断言"退码 ∈ {0,3}"，24 次整套里红了 **1 次**，红在 `4`
  // （那一轮 20 家抢占方一次都没赢 ⇒ 判据没被走到）。**那是探针自报得完全正确的一次**，
  // 是我把"这次没量到"写成了失败：单轮 + 真并发本质是概率性的，烟雾用例不该赌它。
  // 但也不能反过来写成"4 也算过"就完事 —— 那样 skipped 与 passed 又混成一类。
  // 所以这里判的是**一致性**：三个合法出口各自必须满足自己那句话，且每次都印一行出来。
  const r = runProbe("tools/claims/renew-race.mjs", [rootDir, "1", "400", "--inject=2500"]);
  const out = (r.stdout || "") + (r.stderr || "");
  const s = parseSummary(r.stdout, "renew-race", ["rounds", "measured", "lost", "precondition", "code"]);
  assert.equal(s.measured, s.rounds, "安排的轮数必须都实测到");
  assert.equal(s.code, r.status, "汇总行里写的 code 必须就是进程真实退码（两份数不能各说各话）");
  if (r.status === 0) {
    assert.ok(s.lost > 0 && s.precondition === 0,
      `退 0 该是"抓到双主"，却报 lost=${s.lost} precondition=${s.precondition}`);
  } else if (r.status === 3) {
    assert.ok(s.lost === 0 && s.precondition === 0,
      `退 3 该是"单胜者且判据走过"，却报 lost=${s.lost} precondition=${s.precondition}`);
  } else if (r.status === 4) {
    assert.equal(s.precondition, 1,
      `退 4（前提不成立）却报 precondition=${s.precondition}：它得说自己为什么没量到，空跑不能只是退个码`);
    assert.equal(s.lost, 0, `退 4 时不许同时报丢行（${s.lost}）："没量到"与"抓到缺陷"不能同时成立`);
  } else {
    assert.fail(`renew-race 退了 ${r.status}，不在仪器正常出口 [0,3,4] 之内：\n${out.split(/\r?\n/).slice(-12).join("\n")}`);
  }
  // skipped 与 passed 必须**看得见**：每次跑都印一行，不让"这次没量到"沉到输出底下。
  console.log(`   [renew-race 烟雾] 退 ${r.status}｜lost=${s.lost} precondition=${s.precondition}` +
    (r.status === 4 ? "｜本次抢占方一家都没赢：仪器开过机，但判据没被走到（烟雾算过，测量不作数）" : ""));
});

test("window-measure 也必须有执行边：真跑 2 次，样本齐且窗口量为正", () => {
  const r = runProbe("tools/claims/window-measure.mjs", [rootDir, "2"]);
  const out = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 0, `window-measure 实退 ${r.status}（8=有 board 非零退出，9=锚点没命中/样本不齐）：\n${out.split(/\r?\n/).slice(-12).join("\n")}`);
  const s = parseSummary(r.stdout, "window-measure", ["rounds", "measured", "lost", "windowMax", "code"]);
  assert.equal(s.measured, 2, "两次落盘必须都量到：少一次就是有一段没被量");
  assert.equal(s.lost, 0, "有落盘没被量到：那份窗口表的分母就不诚实");
  assert.ok(Number.isFinite(s.windowMax) && s.windowMax >= 0, `窗口最大值得是个正数（拿到 ${s.windowMax}）`);
  assert.equal(s.code, r.status, "汇总行的 code 与真退码不能两份数各说各话");
});

test("README 写的板锁 TTL 与代码常量一致（数字抄错=文档说谎）", () => {
  const md = readFileSync(README, "utf8");
  const src = readFileSync(new URL("../src/claims/lock.js", import.meta.url), "utf8");
  const n = /export const BOARD_LOCK_TTL_S = (\d+);/.exec(src)?.[1];
  assert.ok(n, "代码里没有 BOARD_LOCK_TTL_S 常量，README 那句'5s'没有真源");
  assert.ok(md.includes(`BOARD_LOCK_TTL_S = ${n}`),
    `代码里板锁 TTL 是 ${n}s，README 写的不是这个数——回收窗口对外承诺就错了`);
});

// 探针的 stdout 不落盘这件事，必须**写在文档里**而不是留着让人猜。
// 不写出来的话，下一个会话看到的只是 README 那些 N/N 分数，很容易当成"仓里有运行产物可查"，
// 进而把"我跑过"当成证据——而这三个量是随机的，同一命令本轮就给出过 12/12 与 10/10。
test("探针的读数只作即时判别：README 明写了'不落盘'与'引用一次=重跑一次'", () => {
  const md = readFileSync(README, "utf8");
  assert.match(md, /即时判别/, "README 没说清探针读数的制品形态：那些数字会被当成历史证据");
  assert.match(md, /不落盘/, "必须明写 stdout 不落盘——否则'仓里查得到 log'会被默认成真的");
  assert.match(md, /引用一次 = 重跑一次/, "要当场成立只能重跑：这句话不能只活在提交信息里");
  const block = /先说清这些探针的制品形态([\s\S]*?)这一条由 `docs-drift`/.exec(md);
  assert.ok(block, "README 里找不到那段'即时判别'的正文：这三个字不能只出现在标题式的一句话里");
  for (const p of ["board-race", "renew-race", "window-measure"]) {
    assert.ok(block[1].includes(p), `那段话没点名 ${p}：不点名就等于没说清"哪些数字不可事后核对"`);
  }
  // 反过来也要钉住"确实没有 log 制品"：文档说有、盘上没有，比文档没写更坏。
  const stray = readdirSync(new URL("../tools/claims/", import.meta.url)).filter((f) => f.endsWith(".log"));
  assert.deepEqual(stray, [], `tools/claims 下出现了 ${stray.join(", ")}：README 那句"不落盘"就过期了，两处必须一起改`);
  // "让下一次自己交代"这件事一旦开始落文件，就会变成第二个 `.verify/`：
  // 隔壁仓的教训是拒收样本堆到上百个、把真信号埋掉、还没人删。所以这里给三条硬约束，
  // 由断言核对而不是由我的注释担保：
  //   ① dump 只走 stdout（仓库里不得出现 .log / .verify / .shots-rejected 这类目录或文件）
  //   ② 有上限（每处 slice 到位：harness 10 行 ×170 字、烟雾 12 行、普查 20 个码一行）
  //   ③ 只在失败时印（成功路径不产文件、也不堆输出）
  const all = readdirSync(new URL("..", import.meta.url), { recursive: true, encoding: "utf-8" })
    .filter((p) => !p.startsWith("node_modules") && !p.startsWith(".git"));
  const dumps = all.filter((p) => /\.(log|tmp)$/i.test(p) || /(^|[/\\])(\.verify|\.shots-rejected|dumps)([/\\]|$)/.test(p));
  assert.deepEqual(dumps, [],
    `仓里出现了运行期产物 ${dumps.slice(0, 8).join(", ")}：诊断必须先有上限和清理，才能落盘（参见 README 那段"即时判别"第 3 条）`);
});

test("README 写的变异条数必须等于 red-demo 的条目数（两处数字不许各飘各的）", () => {
  // 上一段刚把 46 改成 52，而 README 那句"锁这组 46 处变异"是手抄的：
  // 测试计数有断言钉，变异条数没有——同一族漂移只是还没被抓到而已。
  const demo = readFileSync(new URL("../tools/claims/red-demo.mjs", import.meta.url), "utf8");
  assert.ok(/^const MUT = \[/m.test(demo), "red-demo 里找不到 `const MUT = [`：这条断言失去真源，先去修它");
  const n = (demo.match(/^    name: "M\d+/gm) || []).length;
  assert.ok(n >= 40, `只从 MUT 数出 ${n} 条变异，少得可疑——是判据读错了形状，不是真少了那么多条`);
  const md = readFileSync(README, "utf8");
  // README 里这个数写了**两处**（探针表那行写"35 处变异逐条打靶"，发布约束表那格写"锁这组 46 处变异"），
  // 只核对其中一处等于放过另一处——同一数字两处各飘正是这条断言要抓的形状。
  const stated = [...md.matchAll(/(\d+) 处变异/g)].map((m) => Number(m[1]));
  assert.ok(stated.length >= 2,
    `README 里只数到 ${stated.length} 处"变异条数"的说法：探针表与发布约束表各写了一份，两处都要核`);
  assert.deepEqual([...new Set(stated)], [n],
    `README 写的变异条数是 ${stated.join(" / ")}，red-demo 实际 ${n} 条——有一处已经过期`);
});

test("README 的测试计数必须等于各套件 test( 的行数之和", () => {
  // 手抄的总数会飘：本轮加了 3 条用例，README 还停在 89。
  // 断言结果不能当断言证据，所以数字从代码里数出来，不写在测试里。
  const md = readFileSync(README, "utf8");
  const files = ["protocol", "claims", "cli-keys", "docs-drift", "docs-coverage", "sim"];
  // 两种数法都要数：`^test\(` 只认顶格声明。本轮我把一条用例的声明写成了缩进（挪代码时误伤了它），
  // 于是这条"核对计数"的断言自己少数了一条——README 写 124、runner 实际跑 127，而它照样报绿。
  // 判据只认顶格 ⇒ 判据会替一个真实的错记账。现在顶格数与全量数必须相等，不等就把行号摊出来。
  const per = files.map((f) => {
    const src = readFileSync(new URL(`./${f}.test.js`, import.meta.url), "utf8");
    const top = (src.match(/^test\(/gm) || []).length;
    const any = (src.match(/^[ \t]*test\(/gm) || []).length;
    const indented = src.split(/\r?\n/).map((l, i) => [i + 1, l])
      .filter(([ , l]) => /^[ \t]+test\(/.test(l)).map(([n]) => n);
    assert.equal(any, top,
      `${f}.test.js 里有 ${indented.length} 条缩进的 test( 声明（行 ${indented.join(", ")}）：` +
      "顶格数法会静默少数，README 那个'测试总数'就成假账——把声明挪回顶格，别放宽这条断言");
    return [f, top];
  });
  const total = per.reduce((s, [, n]) => s + n, 0);
  const docLine = /测试总数 \*\*(\d+)\*\*（([^）]*)）/.exec(md);
  assert.ok(docLine, "README 里找不到'测试总数 **N**（…）'那行");
  assert.equal(Number(docLine[1]), total, `README 写 ${docLine[1]}，各套件实际 ${total}`);
  for (const [f, n] of per) {
    assert.ok(docLine[2].includes(`${f} ${n}`), `README 的分项数少了 ${f}（实际 ${n} 条）：${docLine[2]}`);
  }
  // 发布约束表里那一格抄的是同一个数，两处会各自飘——一起钉住。
  assert.ok(md.includes(`✅ ${total}/${total}`),
    `README 判据 1 那格写的通过数不是 ${total}/${total}，和上一行的总数自相矛盾`);
});

// ============ 跨机时钟与现状输出：文档与代码必须是同一句话 ============
test("脏锁的定义包含\"解析得出来但字段算不出到期时刻\"，README 写的是同一个集合", () => {
  const src = readFileSync(new URL("../src/claims/lock.js", import.meta.url), "utf8");
  const fn = /function lockShapeOk\([\s\S]*?\n\}/.exec(src);
  assert.ok(fn, "找不到 lockShapeOk：残缺锁又走回『永不超期』那条路了");
  assert.match(fn[0], /Number\.isFinite\(Number\(o\.at\)\)/, "残缺校验必须管 at（NaN 的到期时刻永远判不出过期）");
  assert.match(fn[0], /Number\.isFinite\(Number\(o\.ttl\)\)/, "…也要管 ttl");
  assert.doesNotMatch(fn[0], /o\.ttl > 0/,
    "ttl=0 是一条已经能走通的回收出口（locks 标违规、claim 立即可回收），在这里顺手拦成脏锁等于凭空多等 120s");
  const md = readFileSync(README, "utf8");
  assert.match(md, /字段残缺/, "README 退码 8 那行没把这道新入口写进去");
});

test("跨机时钟：max(at, mtime) 的两道护栏都在，README 连没关掉的那侧一起写", () => {
  const src = readFileSync(new URL("../src/claims/lock.js", import.meta.url), "utf8");
  assert.match(src, /const m = Math\.min\(safeMtime\(p\), Date\.now\(\)\);/,
    "mtime 没夹到本地此刻：未来的 mtime（同步盘重写/时钟回跳）会把到期推到未来，锁看着永不过期");
  assert.match(src, /let d = Math\.max\(Number\(c\.at\) \|\| 0, m\) \+ c\.ttl \* 1000;/,
    "到期判定不再是 max(头部 at, 本地 mtime)——写方钟偏早就会提前抢走活锁");
  assert.match(src, /const mm = Math\.min\(m\.mtimeMs \|\| 0, Date\.now\(\)\);/,
    "续期标记的 mtime 也要同法夹，否则标记能把到期无限推到未来");
  assert.match(src, /skew !== null && skew > SKEW_UNTRUSTED_S/,
    "两个钟相差超过阈值必须降级成脏锁；只靠 clamp 单独决定，backward 时钟跳变就等于提前过期（丢数据方向）");
  assert.match(src, /export const SKEW_UNTRUSTED_S = (\d+);/, "不可信阈值必须是具名常量，README 要引用同一个数");
  const untrusted = Number(/export const SKEW_UNTRUSTED_S = (\d+);/.exec(src)[1]);
  const alert = Number(/export const SKEW_ALERT_S = (\d+);/.exec(src)[1]);
  assert.ok(alert < untrusted && untrusted > CORRUPT_GRACE,
    `阈值顺序错了：报警线 ${alert}s 应低于不可信线 ${untrusted}s，且不可信线要大于脏锁上界 ${CORRUPT_GRACE}s，否则降级就等于永久`);

  const md = readFileSync(README, "utf8");
  for (const k of ["偏早", "偏晚", "时钟差", "同步盘"]) {
    assert.ok(md.includes(k), `README 少了"${k}"：这条前提只写在代码注释里，下一个人会直接在同步盘上拄走`);
  }
  assert.match(md, /只卡不丢|不丢数据/, "README 要写清偏晚那侧的代价是等待而不是丢数据");
  assert.ok(md.includes(`SKEW_UNTRUSTED_S = ${untrusted}`), `README 写的不可信阈值与代码不是同一个数（代码 ${untrusted}）`);
});

test("audit 的现状段是只报不拒，README 与代码都说同一件事", () => {
  const cli = readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  const branch = /\nif \(cmd === "audit"\) \{([\s\S]*?)\n\}\n/.exec(cli);
  assert.ok(branch, "找不到 audit 分支");
  // 退码只能由 stale 决定：有人持锁（哪怕是死掉的尸体）都不改判据
  assert.match(branch[1], /process\.exit\(a\.stale\.length \? EXIT\.STALE_BOARD_ROW : EXIT\.OK\);/,
    "audit 的退码不再只由越写者决定——现状段被做成了拦截");
  assert.doesNotMatch(branch[1], /holders\.length \?/, "audit 里出现了『有活锁就非 0』的形状");
  const md = readFileSync(README, "utf8");
  assert.match(md, /现状，不是判决/, "README 没写 audit 现在会打出盘上持锁现状");
});

// ============ 对照数字的"可重跑性"与出处 ============
test("README 的改前列必须能用一条命令重跑，每批数字都带出处", () => {
  const md = readFileSync(README, "utf8");
  const br = readFileSync(new URL("../tools/claims/board-race.mjs", import.meta.url), "utf8");
  const rr = readFileSync(new URL("../tools/claims/renew-race.mjs", import.meta.url), "utf8");

  // ① 两个探针都要有"改前列"的开关，而且 README 要教出来
  assert.match(br, /--unlocked/, "board-race 没有 --unlocked：README 的改前列就只能靠手工改副本");
  assert.match(rr, /--revertcas/, "renew-race 没有 --revertcas：双主的改前列不可重跑");
  assert.match(rr, /--revertcas 锚点没命中/, "改前列的锚点失配必须停下——失配跑出来会被读成\"旧代也没双主\"");
  for (const f of ["--unlocked", "--revertcas"]) {
    assert.ok(md.includes(f), `README 没教 ${f}，那它就等于不存在`);
  }
  // ② 取整代旧代码要连入口一起取，否则是混合代（本轮实测退 4）
  assert.match(rr, /gitShow\(REF, "src\/cli\.js"\)/, "只取旧 lock.js 不取旧 cli.js = 混合代，子进程全崩在 import");
  assert.match(rr, /混合代/, "探针要能把混合代这件事说出来");

  // ③ 数字要有出处：至少两批，且各带日期
  const dated = [...md.matchAll(/2026-09-\d{2} (?:那轮|重跑)/g)].map((m) => m[0]);
  assert.ok(dated.length >= 2, `README 的对照数字没标"取于哪一次"（找到 ${dated.length} 处）——旧数被新数覆盖就查不到当时量到哪一步`);
  assert.ok(/取于 [^\n]*`?c?[0-9a-f]{7}`?/.test(md), "README 的测量表必须钉一个 commit（或工作树等于哪个 commit + 本批改动）");
});

// ============ 计数行的判读器：读不到 ≠ 0，状态与计数必须双向印证 ============
// 通令来源：隔壁仓实出来的一次自骗——汇总器把阶段状态**只取退出码**、计数行当展示，
// 打印方改了字段名后判读正则失配，于是报出 `PASSED count: NOT REPORTED` 自己被当成通过。
// 本仓同形的四处（red-demo 的变异计数、npm test 的条数、三个探针的"几行都在"）
// 都改成共用 tools/claims/summary.mjs 这一处定义；这里先把那处定义本身钉住。
test("计数行：读不到就抛（绝不当成 0），打印与判读共用同一处定义", async () => {
  const { printSummary, parseSummary } = await import("../src/claims/summary.js");
  const line = printSummary({ kind: "demo", rounds: 3, measured: 3, lost: 0, code: 3 });
  assert.ok(line.startsWith("RELAY-SUMMARY "), "汇总行必须有可寻址的前缀");
  assert.equal(parseSummary(line, "demo", ["rounds", "measured", "lost", "code"]).lost, 0);

  // ① 读不到计数 = 失败。三种"读不到"都要抛，不能返回 undefined 让调用方 `?? 0`：
  assert.throws(() => parseSummary("PASSED count: NOT REPORTED\n", "demo", ["lost"]), /RELAY-SUMMARY/,
    "整行没有时必须抛——这正是隔壁仓那个形状");
  assert.throws(() => parseSummary('RELAY-SUMMARY {"kind":"other","lost":0}\n', "demo", ["lost"]), /kind/,
    "kind 对不上等于没打到这一步");
  assert.throws(() => parseSummary('RELAY-SUMMARY {"kind":"demo","rounds":3,"measured":3}\n', "demo", ["lost"]),
    /字段 lost/, "字段被改名/删掉时必须抛，判 `?? 0` 通过就是把保护静默撤走");
  assert.throws(() => parseSummary('RELAY-SUMMARY {"kind":"demo","lost":"0"}\n', "demo", ["lost"]),
    /不是数/, "字符串 \"0\" 不是数：Number.isFinite 那一关必须拦住");
});

test("双向印证：退 0 但 bad>0 与 退非 0 但 bad=0 两面都判测具不可信", async () => {
  const { crossCheck } = await import("../src/claims/summary.js");
  // 汇总器约定（0=全绿）：两个方向都要咬
  // 先判"有没有返回一句话"，再判那句话的内容：
  // 直接 assert.match(返回值,…) 时，变异把判据删掉会返回 null，assert.match 抛的是 TypeError，
  // 红是红了，但红在参数类型上——读的人看不出"是判据没了"。
  const a1 = crossCheck(0, { reported: 2, raw: 2, expect: 3, measured: 3 });
  assert.equal(typeof a1, "string", "退 0 而 bad>0 必须返回一句『为什么不可信』");
  assert.match(a1, /退 0 却报 bad=2/);
  const a2 = crossCheck(8, { reported: 0, raw: 0, expect: 3, measured: 3 });
  assert.equal(typeof a2, "string", "退非 0 而 bad=0 必须返回一句『为什么不可信』");
  assert.match(a2, /退 8 但报 bad=0/);
  assert.equal(crossCheck(0, { reported: 0, raw: 0, expect: 3, measured: 3 }), null, "自洽时不该误伤");
  // 探针约定（0=抓到缺陷）必须反过来判，否则探针每次成功复现缺陷都会被自己的测具打死
  assert.equal(crossCheck(0, { reported: 2, raw: 2, expect: 3, measured: 3, badIsSuccess: true }), null);
  assert.match(crossCheck(3, { reported: 2, raw: 2, expect: 3, measured: 3, badIsSuccess: true }), /退 3（=没抓到）却报 bad=2/);
  // ③报出去的数 ≠ 现场重算的数 / 样本不齐：两种"计数在骗人"都要咬
  assert.match(crossCheck(8, { reported: 1, raw: 3, expect: 3, measured: 3 }), /bad=1 与现场重算的 bad=3/);
  assert.match(crossCheck(0, { reported: 0, raw: 0, expect: 12, measured: 11 }), /样本数不齐：安排 12，实测到 11/);
  // ④护栏**不能因为入参缺失就自动跳过**。旧写法是 `if (Number.isFinite(raw) && raw !== reported)`：
  // 调用方漏一个字段 ⇒ 那条比对整条静默失效 ⇒ crossCheck 仍返 null（=可信）。
  // 隔壁仓那一课是"修完欠剥（假红）换过剥（假绿）"，这里是同一族：欠检不报错、反而更绿。
  assert.equal(typeof crossCheck(0, { reported: 0, expect: 3, measured: 3 }), "string",
    "漏传 raw 必须判不可信：没有第二个数可比，『对外报的数被手滑改掉』这一类就没人管了");
  assert.match(crossCheck(0, { reported: 0, expect: 3, measured: 3 }), /raw 不是数/);
  const b2 = crossCheck(0, { reported: 0, raw: 0, measured: 3 });
  assert.equal(typeof b2, "string",
    "漏传 expect 必须判不可信：『样本齐不齐』这条不能因为没人传就整条跳过");
  assert.match(b2, /expect 不是数/);
});

// ============ 计数定义的"单一出处"：谁都不许再自己写一份判读正则 ============
test("机读汇总行的格式只有一处定义，五个出口都从那里取", () => {
  const sum = readFileSync(new URL("../src/claims/summary.js", import.meta.url), "utf8");
  for (const needle of ["export const SUMMARY_PREFIX", "export function printSummary",
    "export function parseSummary", "export function crossCheck", "export const HARNESS_EXIT = 9"]) {
    assert.ok(sum.includes(needle), `summary.js 少了 ${needle}——判读与打印必须同源`);
  }
  const consumers = ["src/cli.js", "tools/claims/board-race.mjs", "tools/claims/renew-race.mjs",
    "tools/claims/window-measure.mjs", "tools/claims/red-demo.mjs", "tools/claims/selfcheck-harness.mjs"];
  for (const f of consumers) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.match(src, /claims\/summary\.js"|\.\/summary\.js"/,
      `${f} 没从 summary.js 取计数格式——它自己写一份，就是下一场"读不到当成 0"`);
    assert.ok(src.includes("printSummary("), `${f} 没有机读汇总行`);
  }
  // red-demo 的判读器必须先自证：顺序错了（先跑变异再自测）等于自测永远不影响结论
  const rd = readFileSync(new URL("../tools/claims/red-demo.mjs", import.meta.url), "utf8");
  const selfAt = rd.indexOf("runSelftest()");
  const loopAt = rd.indexOf("for (const m of TODO)");
  assert.ok(selfAt > 0 && loopAt > 0 && selfAt < loopAt,
    "red-demo 必须在跑任何变异之前先过 classify 对照表");
  assert.ok(/harness:\s*7/.test(rd), "对照表判错必须有专属退码 7，不能混进『有变异没红』");
  assert.ok(rd.includes("process.exit(EXIT_CODES.harness)"), "对照表判错必须真从表里取那个码");
});

test("README 说清了两件事：退码 11 只管越写者，无令牌行走机读出口", () => {
  const md = readFileSync(README, "utf8");
  const row11 = md.split(/\r?\n/).find((l) => l.startsWith("| 11 |"));
  assert.ok(row11, "找不到退码 11 那行");
  assert.ok(row11.includes("无令牌") && row11.includes("不进退码"),
    "11 那行必须写明：无令牌行只点名、不进退码，并给出机读出口（untagged）——旧文案承诺过『或该行根本没令牌』，代码从来没这么退过");
  assert.ok(row11.includes("RELAY-SUMMARY"), "出口必须是那个可被机器读的字段名，不是一句形容词");
  assert.ok(md.includes("测具不可信"), "README 要写清退码里『测具不可信』是哪一档");
});

// 判读器的对照表不能只在"我手动跑了 red-demo"时才生效：npm test 里就子进程跑一次。
// 上一版我只在测试里断言"源码里有 runSelftest() 且顺序在前"——那证明的是形状，不是行为。
test("red-demo 的 classify 对照表在 npm test 里真跑一次（子进程，不退 7 才算过）", () => {
  // 必须走 fileURLToPath：Windows 上 `new URL(...).pathname` 得到 "/C:/Users/…"，
  // 那个前导斜杠会让 node 按 CJS 解析模块直接失败（实退 1，红在测具自己身上）。—— 现在由 runProbe 统一做。
  const r = runProbe("tools/claims/red-demo.mjs", [rootDir, "--selftest-only"]);
  const out = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 0, `判读器自测没退 0（实退 ${r.status}）：\n${out.split("\n").slice(-14).join("\n")}`);
  const oks = (out.match(/^ {2}ok /gm) || []).length;
  assert.ok(oks >= 7, `对照表只打了 ${oks} 条 ok，预期至少 7 条——少一条就是某面没验`);
  assert.ok(!/✗✗/.test(out), `对照表里有判错：\n${out}`);
});

// 五面自证不能只在我手动跑的时候算数：npm test 里以子进程真跑一次。
// 面 C/D（行数契约）与面 E（第二把尺子）都只有"真起一个被改坏的副本"才作数。
test("五面自证：harness 的五个面在 npm test 里真跑一次（任一面没咬住就红）", () => {
  const r = runProbe("tools/claims/selfcheck-harness.mjs", [rootDir], { cwd: rootDir });
  const out = (r.stdout || "") + (r.stderr || "");
  const lines = out.split(/\r?\n/);
  // 面 A 排在最前面，而旧写法只摊最后 20 行：面 A 没咬住时，报出来的全是后面几个面的成功行，
  // 红是红了，但把"哪一面、为什么"藏起来了（本轮就撞上一次偶发红，靠残尾行无法归因）。
  // 现在按面块摊：每条 `没咬住 ✗` 连同它后面 4 行（判据 / 汇总行 / 判读原文）一起打出来。
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    if (/没咬住 ✗/.test(lines[i])) bad.push(...lines.slice(i, i + 5), "   ---");
  }
  const faces = (out.match(/咬住 [✓✗]/g) || []).length;
  assert.equal(faces, 5,
    `只跑到 ${faces} 个面，预期 5 个（跑一半崩掉与某面没咬住是两件事，先看这份原文）：\n${out}\n[harness 真退码 ${r.status}]`);
  assert.ok(bad.length === 0, `有面没被抓到（这才是这条断言真正防的事）：\n${bad.join("\n")}\n--- 全文尾部 ---\n${lines.slice(-12).join("\n")}`);
  assert.equal(r.status, 0, `harness 没退 0（实退 ${r.status}）：\n${out}`);
});

test("S2b 的每条断言都必须自带普查（红一次只报数字差，等于下次还得重新猜）", () => {
  // 20 路并发这类间歇红过两次，旧断言的消息只有 `18 !== 19` / `2 !== 1` 这种数字差：
  // 读的人分不清"双主（锁失效）"与"有一家静默消失（归因丢失）"，而那两种的处置完全不同。
  // 现在四条断言每条都拼 `census(out.s2b)`。这条用例不去测 census 的内容（那要真红一次），
  // 只钉住"消息里必须带它"——摘掉任何一条就红，避免"诊断写好了但被人顺手删了"。
  const sim = readFileSync(new URL("./sim.test.js", import.meta.url), "utf8");
  const body = /test\("S2b[\s\S]*?\n\}\);/.exec(sim);
  assert.ok(body, "找不到 S2b 那条用例：这条核对失去了对象");
  const asserts = (body[0].match(/assert\.(equal|ok|match)\(/g) || []).length;
  const withCensus = (body[0].match(/census\(out\.s2b\)/g) || []).length;
  assert.ok(asserts >= 4, `S2b 只剩 ${asserts} 条断言（应至少 4 条：winners / rows / blocked / holder）`);
  assert.equal(withCensus, asserts,
    `S2b 有 ${asserts} 条断言、只有 ${withCensus} 条带普查：剩下那些一旦红，报出来的还是光秃秃的数字差`);
});

// 分隔符本身可以出现在被解析的文本里（看板正文是 agent 写的，不是代码）。
// 判读方若用" split 后取第 N 格"或"按行读汇总"，字面量里的分隔符就会把行切错位。
test("被解析的文本里含分隔符：不许静默少读一行，也不许把两行读成一行", async () => {
  const { parseSummary } = await import("../src/claims/summary.js");
  // ① 汇总行：值里带换行与竖线，JSON 转义之后仍是**一行**
  const line = [
    "RELAY-SUMMARY",
    JSON.stringify({ kind: "pipe", lost: 0, code: 0, note: "a|b\nc" }),
  ].join(" ");
  const s = parseSummary(`正在写板\n${line}\n下一行普通输出`, "pipe", ["lost", "code"]);
  assert.equal(s.lost, 0, "值里含 | 与换行不影响汇总行的行数契约");
  assert.equal(s.note, "a|b\nc");
  // ② 两条同 kind ⇒ 抛（上一条测过；这里测"其中一条含竖线"时也别被数错）
  assert.throws(() => parseSummary(`${line}\n${line}`, "pipe", ["lost"]), /2 条/);
  // ③ 看板行：正文里含 | 的行必须仍被计数、仍被点名，不能因切分结果奇怪而整行丢掉
  const fsv = await import("node:fs");
  const osv = await import("node:os");
  const dir = fsv.mkdtempSync(path.join(osv.tmpdir(), "relay-pipe-"));
  const md = path.join(dir, "PROGRESS.md");
  fsv.writeFileSync(md, "# 板\n| src/a.js | qoder | 修 A|B|C 三段 <at=123> |\n| src/b.js | qoder | ok <at=456> |\n");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "audit", `--channel=${dir}`, `--board=${md}`], { encoding: "utf8" });
  const sum = parseSummary((r.stdout || "") + (r.stderr || ""), "audit", ["rows", "stale", "untagged"]);
  assert.equal(sum.rows, 2, `含竖线的那行被漏掉了（rows=${sum.rows}）：\n${r.stdout}`);
  assert.equal(sum.stale, 2, "两行都对不上活锁，必须都点名");
  assert.equal(r.status, 11, "有越写者就该退 11");
});

// ============ 全机位口径：文档引用的每个可执行探针，套件里必须真 spawn 过它 ============
// 上一批 board-race 的 `slice(3)` 把仓库路径吞掉、探针一跑就 ENOENT，而 `npm test` 121/121 全绿。
// 根因不是断言不够严，是**套件与探针之间没有执行边**：所有用例都在读它的源码文本，
// 全绿只证明"关于它的断言对"，不证明"它能跑"。文本核对天生看不见参数偏移这类错——它从没喂过参数。
//
// 这条断言用"真跑一次才登记"而不是"扫源码里有没有 spawn 字样"：后者会被注释、
// 被 readFileSync 的字符串、被一条永不执行的分支骗过去。SPAWNED 只能由实际发生凑齐。
// 顺序依赖：node:test 顶层用例按登记顺序执行，本条放在文件最末，前面五个探针都已真跑过。
test("现场证据表点名的五个探针都被套件真 spawn 过（没有执行边就不许写'N/N 全绿'）", () => {
  const missing = PROBE_ROWS.map(([rel]) => rel).filter((rel) => !SPAWNED.has(rel));
  assert.deepEqual(missing, [],
    `这几个探针只被"读文本"核对过、从没被 spawn 过一次：${missing.join("、")}。` +
    "把它的烟雾用例补上（runProbe 一条即登记），否则对外那句'npm test 全绿'不成立。");
  assert.equal(SPAWNED.size >= PROBE_ROWS.length, true,
    `登记到 ${SPAWNED.size} 个 spawn，少于现场证据表的 ${PROBE_ROWS.length} 个：覆盖断言自身没被喂到`);
});

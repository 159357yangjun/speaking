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
// 脏件普查的尺子与门共用同一份实现（名单、分桶、分母都在这里，测试不许自己抄一遍正则）。
import { census, censusLine, SCRATCH } from "../tools/claims/dirty-census.mjs";
// MC-1-A 的判据同样从它自己那一处取：夹具喂合成靶子、普查数真轮次，两边共用一把尺子。
import { classifyRound, tallyPeriods, BUCKETS } from "../tools/claims/mc1a-ruler.mjs";

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
  // 13 = audit 看见"还活着的仲裁残留"（MC-1-A 现场）。两面都必须是**盘上真跑**出来的：
  // 只演正例，等于允许"把所有 arbiter 残留都算缺陷"这种放宽蒙混过关（灵敏度又是靠误报换的）。
  // 板面留成空表 ⇒ stale/untagged 都是 0，退码只可能由残留决定，两面的差别干净可指。
  const resDir = fsv.mkdtempSync(path.join(os.tmpdir(), "relay-exit13-"));
  fsv.mkdirSync(path.join(resDir, "claims"), { recursive: true });
  const resBoard = path.join(resDir, "PROGRESS.md");
  fsv.writeFileSync(resBoard, "| 文件 | 谁 | 声明时间 |\n|---|---|---|\n");
  const runAudit13 = () => spawnSync(process.execPath, [cli, "audit", `--channel=${resDir}`,
    `--board=${resBoard}`], { encoding: "utf8" });
  // 正例：位置上是 victim 的活锁，旁边躺一把**自己还没到期**、自称 ghost 的残留 ⇒ 归属证据被摘走
  fsv.writeFileSync(path.join(resDir, "claims", "src_r.js.lock"),
    JSON.stringify({ who: "victim", at: Date.now(), ttl: 600 }));
  fsv.writeFileSync(path.join(resDir, "claims", "src_r.js.lock.arbiter-99998-live"),
    JSON.stringify({ who: "ghost", at: Date.now(), ttl: 600 }));
  const res13 = runAudit13();
  observed.add(res13.status);
  assert.equal(res13.status, 13, `活着的仲裁残留必须吃 13（实退 ${res13.status}）：\n${res13.stdout}${res13.stderr}`);
  assert.match(res13.stdout, /仲裁残留（活锁被摘走）[\s\S]*ghost[\s\S]*victim/,
    `13 必须指名道姓说出残留自称谁、位置上的活锁是谁：\n${res13.stdout}`);
  // 反例：同一位置，残留换成**已到期**的那把 ⇒ 正常老化，退码必须回到 0，且要说出为什么不算缺陷
  fsv.rmSync(path.join(resDir, "claims", "src_r.js.lock.arbiter-99998-live"));
  fsv.writeFileSync(path.join(resDir, "claims", "src_r.js.lock.arbiter-99997-old"),
    JSON.stringify({ who: "oldholder", at: Date.now() - 700000, ttl: 1 }));
  const resOld = runAudit13();
  assert.equal(resOld.status, 0, `已到期残骸被当成缺陷了（实退 ${resOld.status}）：\n${resOld.stdout}`);
  assert.match(resOld.stdout, /已到期残骸/, `退 0 却没说出它为什么不是缺陷：\n${resOld.stdout}`);
  const busyDir = fsv.mkdtempSync(path.join(os.tmpdir(), "relay-exit12-"));  fsv.mkdirSync(path.join(busyDir, "claims"), { recursive: true });
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
  ["tools/claims/dirty-census.mjs", [0, 1, 2, 9]],
  ["tools/claims/gate-census.mjs", [0, 1, 2, 9]],
  ["tools/claims/wx-empty-window.mjs", [0, 8, 9]],
  // mc1a-ruler.mjs 不在这张表里：它是判据的定义处、不是对用户开放的取证入口（没有退码契约）。
  // 但它确实被真 spawn 过一次（见下面七面靶子那条用例末尾），所以它享有一条执行边。
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

test("gate-census 必须真跑一次：工具抓到事件就退 1，而套件这一侧仍只登记（允许 0/1/2/9）", () => {
  const t0 = Date.now();
  const r = runProbe("tools/claims/gate-census.mjs", [rootDir, "--batches=1", "--gated=1"]);
  const out = (r.stdout || "") + (r.stderr || "");
  const s = parseSummary(out, "gate-census",
    ["planned", "rounds", "events", "dbl", "mc1a", "silent", "notFull", "unreadable",
      "strayExpired", "strayUnreadable", "fastPath", "collapsed", "code"]);
  // 快路径必须自己声明：--only=s2bg 不跑其它场景，所以"完整推演器还能动"这句话只能由
  // sim.test.js 顶部那次整套真跑来说。两个分母各印各的，谁也不许冒充谁。
  assert.equal(s.fastPath, 1,
    `普查没走 --only=s2bg 快路径（fastPath=${s.fastPath}）⇒ 一条执行边又要付整支推演器的钱，` +
    "而且这个数会被读成『完整推演器也跑过了』");
  assert.equal(s.rounds, s.planned, `计划 ${s.planned} 轮、真跑到 ${s.rounds} 轮：分母塌了，退码必须是 2 而不是 0`);
  // 没等齐 = 窗口没开 = 这一轮量的还是派发顺序。这里不加"必须等齐"的断言（那会把已知间歇挤进套件），
  // 只要求它**被如实标成分母塌**：塌了却还退 0/1，就是拿一个没量到的样本冒充量到了。
  if (s.notFull > 0 || s.collapsed === 1) {
    assert.equal(r.status, 2,
      `有 ${s.notFull} 轮没等齐 / collapsed=${s.collapsed} ⇒ 这不是并发放行，是又一次顺序派发；` +
      `分母必须塌（退 2），不许退 ${r.status} 冒充量到了`);
  }
  assert.equal(s.unreadable, 0, `有批读不出 RESULT_JSON ⇒ 这份"抓到 ${s.events} 次"不作数（到不了 ≠ 没有）`);
  // 三张脸必须互印：事件数 = 双主 + 静默，且 MC-1-A 不许被加成第四类
  assert.equal(s.events, s.dbl + s.silent,
    `恒等式不成立：事件 ${s.events} ≠ 双主 ${s.dbl} + 静默 ${s.silent} ⇒ 有一类事件既不算通过也不算失败`);
  assert.ok(s.mc1a <= s.events, `MC-1-A ${s.mc1a} 比事件总数 ${s.events} 还多 ⇒ 同轮共现被当成多起`);
  assert.equal(s.code, r.status, "汇总行写的 code 必须就是进程真实退码（两份数不能各说各话）");
  assert.ok([0, 1, 2, 9].includes(r.status),
    `实退 ${r.status}（0=这轮没事件 · 1=抓到事件 · 2=分母塌 · 9=测具档：用法错 / 读数与状态不互印，各印自己的 !! 原文）：\n` +
    `${out.split(/\r?\n/).slice(-8).join("\n")}`);
  // 这一条是"定档"的正面：工具退 1 是真缺陷现形，但 npm test 不因此变红——
  // 摘掉这条容忍，整套会按合并率 ~14% 概率红，一周内就会被人静音（见 README 闸口那节）。
  if (r.status === 1) {
    assert.ok(s.events > 0, `退 1 却报 events=${s.events}：状态说抓到了、计数说没有`);
  }
  console.log(`[gate-census 烟雾] 1 轮：事件 ${s.events}（双主 ${s.dbl}｜MC-1-A ${s.mc1a}｜静默 ${s.silent}）` +
    `｜到期残骸 ${s.strayExpired} 把｜读不出的残留 ${s.strayUnreadable} 把｜退 ${r.status}` +
    `｜本条耗时 ${Date.now() - t0}ms（工具抓到就退 1；套件允许 1，所以这条不因真缺陷红）`);
});

// 判据必须**能被合成靶子喂到**。上一轮 50 圈真并发里"静默"与"读不出"两格各 0 个证人，
// 只靠真跑的后果是：这两格永远空着，而空桶会被下一个读台账的人当成"结构上不可能"。
// 更要紧的是第①面：如果 MC-1-A 只能在 `winners≠1` 的轮里出现，它就只是双主的另一个名字，
// "归属证据可被静默摘走"这句话就没有仪器支撑——这面证明判据自己有独立于双主的自由度。
test("MC-1-A 判据的七面合成靶子：静默摘走不许只是双主的别名，到期残骸与读不出不许冒充它", () => {
  const stray = (who, liveMs) => ({ name: `src_x.js.lock.arbiter-1-abc`, who, at: 1, ttl: 60, liveMs });
  const faces = [
    ["① 板面正常 + 一把还活着的**他人**残留 ⇒ 事件 + 静默（判据的独立自由度）",
      { winners: 1, racerRows: 1, holder: "a", strays: [stray("b", 500)] },
      { event: true, dbl: false, silent: true, foreign: 1, own: 0, expired: 0, unreadable: 0 }],
    ["② 双主 + 一把还活着的他人残留 ⇒ 事件、但不是静默（上一轮 4/4 就是这一面）",
      { winners: 2, racerRows: 2, holder: "a", strays: [stray("b", 500)] },
      { event: true, dbl: true, silent: false, foreign: 1, own: 0, expired: 0, unreadable: 0 }],
    ["③ 多赢家公司却没多落板（计数与状态不互印）⇒ 仍算双主",
      { winners: 5, racerRows: 1, holder: "a", strays: [] },
      { event: true, dbl: true, silent: false, foreign: 0, own: 0, expired: 0, unreadable: 0 }],
    ["④ 板面正常 + **已到期**残骸 ⇒ 不算事件（这条就是被撤回的那个判据的靶子：只看 who 会在这里误报）",
      { winners: 1, racerRows: 1, holder: "a", strays: [stray("b", -1)] },
      { event: false, dbl: false, silent: false, foreign: 0, own: 0, expired: 1, unreadable: 0 }],
    ["⑤ 板面正常 + 还活着但 who 就是当前持有者本人 ⇒ 不算摘走，单列 own 格",
      { winners: 1, racerRows: 1, holder: "a", strays: [stray("a", 500)] },
      { event: false, dbl: false, silent: false, foreign: 0, own: 1, expired: 0, unreadable: 0 }],
    ["⑥ 板面正常 + at/ttl 读不出 ⇒ 不算事件、也不算'没有'，单列 unreadable 格（安全侧）",
      { winners: 1, racerRows: 1, holder: "a", strays: [stray("b", null)] },
      { event: false, dbl: false, silent: false, foreign: 0, own: 0, expired: 0, unreadable: 1 }],
    ["⑦ 干净轮 ⇒ 什么都不算",
      { winners: 1, racerRows: 1, holder: "a", strays: [] },
      { event: false, dbl: false, silent: false, foreign: 0, own: 0, expired: 0, unreadable: 0 }],
  ];
  for (const [name, p, want] of faces) {
    const c = classifyRound(p);
    for (const k of ["event", "dbl", "silent"]) {
      assert.equal(c[k], want[k], `${name}：${k} 判成 ${c[k]}，期望 ${want[k]}`);
    }
    for (const b of BUCKETS) {
      assert.equal(c[b].length, want[b], `${name}：桶 ${b} 装了 ${c[b].length} 把，期望 ${want[b]}`);
    }
  }
  // 恒等式在这七面上必须成立，且 census 那边是拿它拦退码的（不只是印一句话）。
  const t = tallyPeriods(faces.map(([, p]) => p));
  assert.equal(t.identityHolds, true, `恒等式在七面上不成立：events=${t.events} dbl=${t.dbl} silent=${t.silent}`);
  assert.equal(t.events, t.dbl + t.silent, `聚合器自己就不自洽：${t.events} ≠ ${t.dbl} + ${t.silent}`);
  assert.deepEqual([t.events, t.dbl, t.silent, t.mc1a, t.own, t.expired, t.unreadable], [3, 2, 1, 2, 1, 1, 1],
    `七面聚合出来的数变了（${JSON.stringify(t)}）：要么有人改了判据没改靶子，要么靶子被悄悄放宽了`);
  // 判据只许住一处：普查里若再写一遍寿命式，就有两份真相（与 clamp 那一族同形）。
  const gc = readFileSync(new URL("../tools/claims/gate-census.mjs", import.meta.url), "utf8");
  assert.ok(gc.includes('from "./mc1a-ruler.mjs"'), "gate-census 不再从尺子取判据了：它内联了第二份");
  assert.doesNotMatch(gc, /liveMs\s*[><=!]+\s*0\s*&&/, "gate-census 里出现了第二处寿命判据：两份谓词会各自飘");
  console.log(`[MC-1-A 判据靶子] 七面全过｜聚合 events=${t.events}=dbl ${t.dbl}+silent ${t.silent}｜` +
    `foreign ${t.mc1a} own ${t.own} expired ${t.expired} unreadable ${t.unreadable}｜桶定义 ${BUCKETS.join("/")}`);
  // 尺子自己被真 spawn 过一次（README 按文件名引用它，就得能按文件名跑到）
  const rr = runProbe("tools/claims/mc1a-ruler.mjs", []);
  assert.equal(rr.status, 0, `尺子单跑退 ${rr.status}：\n${(rr.stdout || "") + (rr.stderr || "")}`);
});

// gate-census 的退码 2 与 9 这两档，上一轮只有 README 里的一句话、没有任何夹具走到过：
// "分母塌了要退 2"这句从没被真验一次，等于该档可能只是注释担保（读到 0 与到不了不分的形状）。
test("gate-census 的 2 与 9 三面必须真被走到：分母塌不许读成'没抓到'，摘掉的开关必须降到安全侧", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const fields = ["planned", "rounds", "events", "collapsed", "code"];
  // 面 1：ROOT 指向一个空目录 ⇒ sim 起不来、RESULT_JSON 读不到 ⇒ 必须退 2 并自报 collapsed
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-empty-"));
  try {
    const r = runProbe("tools/claims/gate-census.mjs", [dir, "--batches=1", "--gated=1"]);
    const out = (r.stdout || "") + (r.stderr || "");
    const s = parseSummary(out, "gate-census", fields);
    assert.equal(r.status, 2, `分母塌了却退 ${r.status}（0=量到了、干净）：\n${out.split(/\r?\n/).slice(-8).join("\n")}`);
    assert.equal(s.code, r.status, "汇总行的 code 必须就是真实退码（否则读者核的是两份数）");
    assert.equal(s.collapsed, 1, `退 2 却没标 collapsed=1：${s.collapsed}`);
    assert.equal(s.planned, 1);
    assert.equal(s.rounds, 0, `计划 1 轮却数到 ${s.rounds} 轮：到不了的轮次不许计进分母`);
    assert.equal(s.events, 0);
    assert.ok(out.includes("!! 分母塌了"), "退 2 没印出自己的成因原文：读者只能猜是哪一侧塌了");
    console.log(`[gate-census 塌分母] 空 ROOT ⇒ 退 ${r.status}、collapsed=${s.collapsed}、rounds=${s.rounds}/${s.planned}（原文含「!! 分母塌了」）`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // 面 2：`--strict` 这一档已经摘了；旧写法必须落到"不认的参数"（退 9），不能被静默吞掉
  const r2 = runProbe("tools/claims/gate-census.mjs", [rootDir, "--batches=1", "--gated=1", "--strict"]);
  const out2 = (r2.stdout || "") + (r2.stderr || "");
  assert.equal(r2.status, 9, `不认的开关 --strict 退了 ${r2.status}：它必须降到安全侧，不能被忽略后装作按老语义跑了`);
  assert.ok(out2.includes("不认的参数 --strict"), `没打印拒绝原因：\n${out2.split(/\r?\n/).slice(-6).join("\n")}`);
  // 面 3：0 轮的"没抓到"不是证据 ⇒ 用法档拒绝
  const r3 = runProbe("tools/claims/gate-census.mjs", [rootDir, "--batches=1", "--gated=0"]);
  assert.equal(r3.status, 9, `--gated=0 退了 ${r3.status}，应为 9：0 轮的普查没有分母`);
  console.log("[gate-census 用法档] --strict 与 --gated=0 都退 9，各印自己的 !! 原文");
});

// renew-race / window-measure 的参数纪律此前只有 `if (!ROOT)` 一道：写反顺序会在 cpSync 里炸看不懂的
// ENOENT，而**多写一个位置参数**会被静默忽略（board-race 为这两种错付过 M48–M57 十条变异）。
// 两面都要：坏命令必须响在该响的那一处；好命令必须照旧跑得起来（否则这条门只是"永远红"的假护栏）。
test("renew-race 与 window-measure 的入参契约：写反/裸数字/多写位置参数各退 9，好参数照旧跑通", () => {
  const wrong = [
    ["tools/claims/renew-race.mjs", ["3", rootDir], "顺序写反（轮数占了仓库路径）", /不像仓库/],
    ["tools/claims/renew-race.mjs", [rootDir, "abc"], "轮数不是整数", /轮数 必须是|轮数 必须/],
    ["tools/claims/renew-race.mjs", [rootDir, "3", "70", "600"], "注入值漏写 --inject= 前缀（裸数字）", /不认识的参数/],
    ["tools/claims/renew-race.mjs", [rootDir, "3", "70", "--oops=1"], "多出不认识的开关", /不认识的参数/],
    ["tools/claims/window-measure.mjs", ["20", rootDir], "顺序写反（次数占了仓库路径）", /不像仓库/],
    ["tools/claims/window-measure.mjs", [rootDir, "2x"], "次数不是整数", /次数必须是非负整数/],
    ["tools/claims/window-measure.mjs", [rootDir, "2", "--inject=600"], "把别的探针的开关搬过来（本探针不认）", /不认识的参数/],
  ];
  for (const [rel, args, why, msg] of wrong) {
    const r = runProbe(rel, args);
    const out = (r.stdout || "") + (r.stderr || "");
    assert.equal(r.status, 9, `${rel} ${why}：期望退 9（用法错），实退 ${r.status}\n${out.slice(0, 400)}`);
    assert.match(out, msg, `${rel} ${why}：退了 9，但那句话不是这一类的归因（读的人会去查错的地方）：\n${out.slice(0, 400)}`);
  }
  // 好参数那一面：必须还在跑真实测量，不能被守卫拒掉（这里只要求"不是用法错"，
  // 真实测量本身可以退 0/3/4，那是协议结论不是入参问题）。
  const goodRenew = runProbe("tools/claims/renew-race.mjs", [rootDir, "1", "400", "--inject=2500"]);
  assert.ok([0, 3, 4].includes(goodRenew.status),
    `好命令被入参守卫拒了（实退 ${goodRenew.status}）：\n${(goodRenew.stdout || "") + (goodRenew.stderr || "")}`);
  const goodWm = runProbe("tools/claims/window-measure.mjs", [rootDir, "2"]);
  assert.equal(goodWm.status, 0, `好命令被入参守卫拒了（实退 ${goodWm.status}）`);
  console.log(`[参数纪律] 两面各核过：坏命令 ${(wrong.length)} 类各退 9 且各说各的话；好命令照旧跑通（renew 退 ${goodRenew.status}、window 退 ${goodWm.status}）`);
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
  // 【运行期脏件的门：命名清单 + 未跟踪兜底，两层】扫描逻辑住在 tools/claims/dirty-census.mjs，
  // 门与 %TEMP% 夹具共用同一把尺子——这里若再抄一遍正则，两边可以一起错（"测量用复制品"那一族）。
  // 旧版只扫 `.log`/`.tmp` 两种后缀，于是**本轮我自己写的 `.tmp-readme-fix.cjs`（用来改 README 的一次性脚本）
  // 它一个都不认**——"名字里带 tmp、后缀是源码"恰恰是最常见的"用完就忘"形状。两层缺一不可：
  // 清单管"已经跟踪上的脏名字"（有人把 .log 提交进来，兜底看不见它），兜底管"任何名字的临时件"。
  const c = census(rootDir);
  console.log(censusLine(c));
  // 范围下限不许我发明魔数："至少扫到 100 个"对一个 51 文件的仓是凭空定的，它只会把干净树判红。
  // 真正的下限来自**另一个独立来源**：git 认得的每个跟踪文件都必须在这次扫描里出现
  // （分隔符归一在 census 里做：readdir 给 `src\claims\lock.js`，git ls-files 给正斜杠，不归一就是"全没覆盖"）。
  assert.ok(c.tracked >= 1,
    `git 认得的跟踪文件数是 ${c.tracked}：兜底层没有分母，"未跟踪=0"是 git 瞎了不是仓干净`);
  assert.deepEqual(c.missing.slice(0, 8), [],
    `扫描没覆盖到 ${c.missing.length} 个已跟踪文件（列前 8 个：${c.missing.slice(0, 8).join(", ")}）` +
    `\n—— 那是扫描根/排除正则/分隔符归一坏了，"名单命中=0"随之不作数`);
  assert.equal(c.hits.length, c.catSum,
    `恒等式不成立：名单命中=${c.hits.length} 但逐类之和=${c.catSum}（分桶不止一处在做判断，某类既没算命中也没算漏）`);
  assert.deepEqual([...c.hits.map((h) => `${h.file} ← ${h.why}`), ...c.untracked.map((p) => `未跟踪:${p}`)], [],
    "仓里有运行期脏件（清单命中或未被跟踪）。临时脚本用完必须删；确要留就 `git add` 进仓并由 README 说清它是什么。" +
    `\n处置上限：诊断只走 stdout、有上限、只在失败时印（README"即时判别"第 3 条）。`);
  assert.ok(SCRATCH.every(([, why]) => typeof why === "string" && why.length > 8),
    "清单每条必须带理由，不然下个人只会放宽它");
});

test("脏件普查的两面夹具：同一支工具，脏树退 1、清树退 0、没分母的树退 2", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  // 上一笔交付的"两面"只是我手动 touch + 跑 + rm，原文落在 /tmp——这台机器上最容易被清的位置。
  // 现在两面长在套件里：脏树造在 %TEMP%，靠 `--scan-root` 指过去，所以"门会红自己的仓"不再是不做的理由。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-scan-"));
  try {
    const git = (args) => spawnSync("git", args, {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    assert.equal(git(["init", "-q"]).status, 0, "夹具建不起 git 树：这一面从没验过，不许算通过");
    fs.writeFileSync(path.join(dir, "keep.js"), "export const x = 1;\n");
    assert.equal(git(["add", "keep.js"]).status, 0, "git add 失败：夹具没有分母");
    assert.equal(git(["commit", "-qm", "fixture"]).status, 0, "git commit 失败：夹具没有分母");
    // 三类名单形状 + 一个谁都不认识的野名字（野名字只能由兜底层抓到）
    for (const f of ["run.log", ".tmp-oops.mjs", "src-copy.js", "notes.md"]) fs.writeFileSync(path.join(dir, f), "x");
    const dirty = runProbe("tools/claims/dirty-census.mjs", [`--scan-root=${dir}`]);
    const dOut = (dirty.stdout || "") + (dirty.stderr || "");
    assert.equal(dirty.status, 1, `脏树应当退 1（抓到脏件），实退 ${dirty.status}：\n${dOut.split(/\r?\n/).slice(-8).join("\n")}`);
    const ds = parseSummary(dOut, "dirty-census", ["scope", "tracked", "missing", "hits", "untracked", "bad", "code"]);
    assert.equal(ds.code, dirty.status, "汇总行写的 code 必须就是进程真实退码（两份数不许各说各话）");
    assert.equal(ds.hits, 3, `名单该抓到 3 个（run.log / .tmp-oops.mjs / src-copy.js），实抓 ${ds.hits}`);
    assert.equal(ds.untracked, 4, `兜底该抓到 4 个（含名单不认识的 notes.md），实抓 ${ds.untracked}`);
    assert.equal(ds.bad, ds.hits + ds.untracked, "bad 必须是两层之和，只报其中一层就是替下一层遮丑");
    assert.equal(ds.tracked, 1, "夹具的分母就是那 1 个跟踪文件；不是 1 说明扫描根指错了地方");
    assert.equal(ds.missing, 0, "有跟踪文件没被扫到：分母在但覆盖塌了");
    console.log(`[两面夹具·脏] ${dOut.split(/\r?\n/).find((l) => l.startsWith("[脏件普查]"))}`);
    // 同一入参指向清干净后的同一棵树 ⇒ 必须退 0。只测红的那面不叫两面夹具。
    for (const f of ["run.log", ".tmp-oops.mjs", "src-copy.js", "notes.md"]) fs.rmSync(path.join(dir, f));
    const clean = runProbe("tools/claims/dirty-census.mjs", [`--scan-root=${dir}`]);
    const cOut = (clean.stdout || "") + (clean.stderr || "");
    assert.equal(clean.status, 0, `清树应当退 0，实退 ${clean.status}：\n${cOut.split(/\r?\n/).slice(-8).join("\n")}`);
    console.log(`[两面夹具·清] ${cOut.split(/\r?\n/).find((l) => l.startsWith("[脏件普查]"))}`);
    // 第三面：非 git 的空树必须退 2——"什么都没见过"从来不等于"干净"
    const wild = fs.mkdtempSync(path.join(os.tmpdir(), "relay-scan-plain-"));
    try {
      fs.writeFileSync(path.join(wild, "a.txt"), "x");
      const w = runProbe("tools/claims/dirty-census.mjs", [`--scan-root=${wild}`]);
      assert.equal(w.status, 2,
        `没有分母的目录必须退 2，实退 ${w.status}：\n${((w.stdout || "") + (w.stderr || "")).split(/\r?\n/).slice(-6).join("\n")}`);
    } finally { fs.rmSync(wild, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("临时树前缀两两不同且都带 relay-：这条约定不许只活在'代码恰好遵守'里", () => {
  // 来源：退 10 那条间歇的一个假设是"两条路在同一前缀的临时树上互删"。我用静态普查把它推掉了
  // （那一刻 16 个前缀互不相同）。但**普查是读数，不是门**：按本仓口径，只存在于"当前代码恰好遵守"
  // 的约定必须加断言——否则下一个人复用同一个前缀时，这条推论会静默失效，而没人会红。
  // 两面：M66 把 renew-race 的 `relay-race-src-` 改成 board-race 正在用的 `relay-board-src-` ⇒ 这条必须红。
  // Windows 上 readdir(recursive) 用反斜杠连路径，这里必须归一（否则"嵌套目录一个都扫不到"
  // 会被读成"仓里只有 16 处调用"——正是本轮 26.1c 那条分隔符教训的同一个坑，我自己差点再踩一次）
  const tree = readdirSync(new URL("..", import.meta.url), { recursive: true, encoding: "utf-8" })
    .map((p) => p.split("\\").join("/"))
    .filter((p) => /\.(?:m)?js$/.test(p) && !p.startsWith("node_modules/") && !p.startsWith(".git/"));
  const rows = [];
  for (const rel of tree) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    const calls = (src.match(/mkdtempSync\(/g) || []).length;
    if (!calls) continue;
    const got = [...src.matchAll(/mkdtempSync\([^,]+,\s*"(relay-[^"]*)\s*"/g)].map((m) => m[1]);
    // 调用数与解出的前缀数必须相等：不等就是**判据瞎了**（写法一变就少读），不是"没有临时树"
    assert.equal(got.length, calls,
      `${rel} 里有 ${calls} 处 mkdtempSync，却只解出 ${got.length} 个 relay- 前缀：正则读不出≠不存在，这条门失去对象`);
    for (const p of got) rows.push({ file: rel, prefix: p });
  }
  // 同一文件里两处共用一个前缀是良性的（mkdtemp 还会加随机后缀，那是同一条路的两种现场）；
  // 要紧的是**两个不同的路**（不同文件）抢同一个前缀 ⇒ 那才是互删对方还在用的树。
  const byPrefix = new Map();
  for (const r of rows) {
    if (!byPrefix.has(r.prefix)) byPrefix.set(r.prefix, new Set());
    byPrefix.get(r.prefix).add(r.file);
  }
  const dups = [...byPrefix.entries()].filter(([, files]) => files.size > 1)
    .map(([p, files]) => `${p} 被 ${files.size} 个文件共用：${[...files].join(", ")}`);
  console.log(`[临时树普查] 前缀数=${byPrefix.size} 调用处=${rows.length} 跨文件重复=${dups.length} `
    + `清单=${[...byPrefix.keys()].sort().join(",")}`);
  assert.ok(rows.length >= 10, `只数到 ${rows.length} 处临时树调用，少得可疑——多半是扫描根或正则坏了，这份"没有重复"不作数`);
  assert.deepEqual(dups, [],
    "两个及以上的文件复用同一个临时树前缀：并发跑起来就是互删对方还在用的树（退 10 那一族的候选成因，别留给运气）");
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
  assert.match(src, /const m = Math\.min\(rawMtime, now\);/,
    "mtime 没夹到本地此刻：未来的 mtime（同步盘重写/时钟回跳）会把到期推到未来，锁看着永不过期");
  assert.match(src, /let d = Math\.max\(Number\(c\.at\) \|\| 0, m\) \+ c\.ttl \* 1000;/,
    "到期判定不再是 max(头部 at, 本地 mtime)——写方钟偏早就会提前抢走活锁");
  assert.match(src, /const mm = Math\.min\(rawMarker, Date\.now\(\)\);/,
    "续期标记的 mtime 也要同法夹，否则标记能把到期无限推到未来。" +
    "而且这里必须**现取 Date.now()**，不许复用 deadlineOf 入口那个 now：复用会让夹值偏早几微秒，" +
    "方向是'到期更早 ⇒ 更容易被抢'——那种改变不该藏在一次只搬可见性的改动里");
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

test("audit 的退码只许由 stale 与活着的仲裁残留决定，别的现状一律只报不拒", () => {
  const cli = readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  const branch = /\nif \(cmd === "audit"\) \{([\s\S]*?)\n\}\n/.exec(cli);
  assert.ok(branch, "找不到 audit 分支");
  // 2026-10-01 的边界变化要说准：MC-1-A 的兜底从 locks 的一行打印升成了 audit 的硬信号（13），
  // 所以"退码只能由越写者决定"这句话不再成立——成立的是**只多允许一件事**：活着的仲裁残留。
  // 其余现状（谁正持着锁、无令牌行、已到期残骸、仲裁闸）都还是只报不拒，这条测试守的就是这个"只多一个"。
  assert.match(branch[1], /const auditCode = ar\.live\.length \? EXIT\.ARBITRATION_RESIDUE\n\s*: a\.stale\.length \? EXIT\.STALE_BOARD_ROW : EXIT\.OK;/,
    "audit 的退码不再是那一个表达式推出来的：要么有人另算了一遍判据，要么拦截面被悄悄扩宽了");
  assert.match(branch[1], /process\.exit\(auditCode\);/,
    "退码与汇总行里的 code 必须来自同一个表达式——分两处算是『状态与计数各说各话』");
  assert.doesNotMatch(branch[1], /holders\.length \?/, "audit 里出现了『有活锁就非 0』的形状");
  assert.doesNotMatch(branch[1], /untagged\.length \?/, "audit 里出现了『无令牌行就非 0』的形状（表头会被算进去，每张正常板都会红）");
  assert.doesNotMatch(branch[1], /expired\.length \?/, "audit 把**已到期残骸**当成拦截条件：那是正常老化，不是缺陷");
  const md = readFileSync(README, "utf8");
  assert.match(md, /现状，不是判决/, "README 没写 audit 现在会打出盘上持锁现状");
  assert.match(md, /\*\*硬信号\*\*/, "README 必须点明 13 是拒的（原来这件事只有一行打印）");
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

// 上一轮这条断言钉的是"两处公式必须同形"（判据在 lock.js 夹、读数侧在 cli.js 再算一遍）。
// 那种并存本身就是缺陷：读数侧算出来的"采用值"未必是判据真用过的数。本轮改成**返回值携带事实**
// （`deadlineOf` 返 `{ms, clampedFrom, clampedTo}`），所以这里钉的方向反过来：
// **不许出现第二处 clamp 计算** —— 谁再在 cli.js 里算 `Math.min(mtime…)`，就是又开了一个真相源。
test("clamp 的可见性走返回值：判据算一次，读数侧不许再算第二遍", () => {
  const lock = readFileSync(new URL("../src/claims/lock.js", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  assert.match(lock, /let clampedFrom = rawMtime > m \? rawMtime : null;/,
    "『夹之前』那个数没被记下来了：clamp 又变回只在数字里留痕，读的人分不清实测与被抹值");
  assert.match(lock, /return \{ ms: d, clampedFrom, clampedTo \};/,
    "deadlineOf 不再返回结构：三个出口（list / verifyHold / auditBoard）就拿不到这件事，只有打印器看得见");
  // 三个出口各自都要带——少一个就是"轨道存在但轨道里没东西"
  for (const [needle, who] of [
    ["clampedFrom: dl.clampedFrom, clampedTo: dl.clampedTo, state", "list().locks[]"],
    ["clampedFrom: dl.clampedFrom, clampedTo: dl.clampedTo,", "auditBoard 的 holder"],
    ["status: \"held\", code: EXIT.OK, file, path: p, holder: who, at: cur.at, clampedFrom: dl.clampedFrom", "verifyHold()"],
  ]) assert.ok(lock.includes(needle), `${who} 没带 clampedFrom：走 API 的调用方拿到的还是一个普通数字`);
  assert.doesNotMatch(cli, /Math\.min\([^)]*mtime/i,
    "cli.js 又开始自己算 mtime 的夹法了：那就有第二处 clamp 公式，两处会各自飘而报告看着完全正常");
  assert.match(cli, /if \(h\.clampedFrom != null\) \{/,
    "打印器不再按返回值判『被夹过』：它与判据就用的是两个事实了");
  assert.match(cli, /\[MTIME_CLAMPED\] 原始=\$\{h\.clampedFrom\} 采用=\$\{used\}/,
    "报告里两个量必须同时在场：只打一个数就等于没打（分清不了『被夹过』与『正常』）");
  // 来因必须是"未判定 + 候选"，不许写成结论：本仓从没在真同步盘上跑过（见 README 那句实测）
  assert.match(cli, /来因=未判定/,
    "来因被写成确定原因了：我们没有那个证据，写死就是替用户下结论");
  // `clockNote`（在 lock.js 里）会说"写方钟偏早"这种结论式措辞，而 `at − mtime < 0`
  // 这一个观测同时由"钟早"与"mtime 被改到未来"产生 ⇒ 读数侧当场把它降回候选解释。
  assert.match(cli, /来因不是结论/,
    "clamp 与那句结论式时钟注释同时出现时，必须补一句『来因不是结论』——否则两句挨着，前一句看起来像已查明");
});

// 全机口径（2026-09-30，隔壁仓实测）：同一端口可以被两个进程分别绑 127.0.0.1 与 ::1，
// 两边 `<title>` 完全相同 ⇒ `--strictPort` 与"抓 title 断言"两条都拓不到，承重的只有
// "该端口 LISTEN 的 pid 集合恰为 1"。本仓的处置是**声明没有这个面**，而这条断言就是那句声明的门：
// 将来任何人加了 http 入口，这条会红，并要求他先补 pid 判据 —— 而不是让那句话默默过期。
test("本仓探针与 CLI 不走 http：一旦有人起了服务器，必须先补『该端口 LISTEN 的 pid 恰为 1』这条判据", () => {
  const files = ["src/cli.js", "src/claims/lock.js", "src/claims/summary.js",
    "tools/claims/board-race.mjs", "tools/claims/renew-race.mjs", "tools/claims/window-measure.mjs",
    "tools/claims/red-demo.mjs", "tools/claims/selfcheck-harness.mjs", "tools/claims/dirty-census.mjs", "tools/relay-sim/sim.js"];
  const hits = [];
  for (const f of files) {
    const s = readFileSync(new URL("../" + f, import.meta.url), "utf8");
    for (const m of s.matchAll(/createServer|net\.connect|\.listen\(|https?:\/\/[^\s"']*localhost|fetch\(/g)) {
      hits.push(`${f}:${m[0]}`);
    }
  }
  const md = readFileSync(README, "utf8");
  if (hits.length === 0) {
    assert.match(md, /本仓探针不走 ?http/,
      "盘上确实没有 http 入口，但 README 那句『本仓探针不走 http』没了 —— 这条声明也得有人钉着");
    return;
  }
  assert.fail(`出现了 http/端口入口：${hits.join(" ")}。同端口可被 v4/v6 各绑一个进程且标题相同，` +
    "所以『起了服务器就算验过』这类判据都不承重。先补『该端口 LISTEN 的 pid 集合恰为 1』，再把这条断言改成正面核对。");
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

// mismatch（第二把尺子不同向）这条腿此前**从没单独开火过**：套件里只有 `rulerMismatch === 0` 那种绿侧断言。
// 穷举判定空间后发现它确实有独立证人（n1=n2=1 而 claim 尺说不在 ⇒ raw=0、lost=0、只有看得见），
// 而当时的代码只打印两行 `!!` 就 `process.exit(code)`，code 完全不含 mismatch ⇒ 那道闸没有电。
// 所以两面都要：注入开 ⇒ 必须真拦（退 9 + 归因原文）；注入关 ⇒ 不得凭空变红（否则这条腿是永红夹具）。
test("mismatch 这条腿必须独自拦得下来：注入开退 9、注入关不得变红，读数带 skew 状态", () => {
  const fields = ["rounds", "measured", "applicable", "lost", "rulerMismatch", "skew", "code"];
  const off = runProbe("tools/claims/board-race.mjs", [rootDir, "2"]);
  const offOut = (off.stdout || "") + (off.stderr || "");
  const s0 = parseSummary(offOut, "board-race", fields);
  assert.equal(s0.skew, 0, `默认跑法必须标 skew=0：读数不带输入状态就分不清两次运行（${offOut.slice(-300)}）`);
  assert.equal(s0.rulerMismatch, 0, `注入关着却有 mismatch=${s0.rulerMismatch}：这条腿在没有靶子时也报红，是假护栏`);
  assert.notEqual(s0.code, 9, `注入关着却判成测具不可信：\n${offOut.slice(-400)}`);
  assert.equal(s0.code, off.status, "汇总行 code 必须就是真实退码");

  const on = runProbe("tools/claims/board-race.mjs", [rootDir, "2", "--skew-claim"]);
  const onOut = (on.stdout || "") + (on.stderr || "");
  const s1 = parseSummary(onOut, "board-race", fields);
  assert.equal(s1.skew, 1, "注入开了却没在汇总行标出来：这份表与那条命令对不上");
  assert.equal(s1.applicable, 2, `注入把竞争轮打空了（applicable=${s1.applicable}）⇒ 靶子没摆对，这次不算开火`);
  assert.equal(s1.lost, 0, `注入本不该动格子尺（lost=${s1.lost}）：那说明 skew 改的是被测实现而不是第二把尺子`);
  assert.ok(s1.rulerMismatch >= 1, `注入开了却没有不同向的尺子（rulerMismatch=${s1.rulerMismatch}）⇒ 靶子失效`);
  // 这一条就是本笔补的牙：只有第二把尺子能看见的那种轮，必须拦得下来，不能只打印两行话。
  assert.equal(s1.code, 9, `mismatch=${s1.rulerMismatch} 而 code=${s1.code}：嘴上说"停下不出表"、退码却照常 ⇒ 半坏的自检`);
  assert.equal(on.status, 9, `真实退码 ${on.status} 与汇总行 ${s1.code} 不一致`);
  assert.match(onOut, /两把尺子不同向[\s\S]*停下不出表/, `退了 9 却没打印自己的归因：\n${onOut.slice(-400)}`);
  console.log(`[mismatch 这条腿] 关：skew=${s0.skew} rulerMismatch=${s0.rulerMismatch} 退 ${off.status}｜` +
    `开：skew=${s1.skew} rulerMismatch=${s1.rulerMismatch} lost=${s1.lost} 退 ${on.status}（含"停下不出表"原文）`);
});
// 「静默」与「读不出」这两格在 200 轮自然跑里各 0 个证人；没有靶子就永远无法证明判据数得出它们。
// `SIM_SEED_STRAY=live|garbage` 由 sim 往 claims/ 摆一把**确定性**残留（默认 off ⇒ 什么都不摆）。
// 这三面各管一件事：live ⇒ 板面正常也要拦（MC-1-A 不是双主的别名）；garbage ⇒ 读不出单列、
// 既不冒充缺陷也不冒充"没有"；off ⇒ 没摆靶子时不许凭空长出证人。
// 已知的抖动预算写在这儿：off 面若撞上自然事件（合并率 ~6%/轮 × 2 轮 ≈ 少数情况）会假红一次，
// 那时该改的是这一面的期望（把自然事件与注入分开计）而不是放宽判据。
test("注入证人三面：静默拦得下、读不出不冒充缺陷、关着不许多出证人", () => {
  const seedFields = ["rounds", "events", "dbl", "mc1a", "silent", "strayUnreadable", "collapsed", "code"];
  const go = (seed) => {
    const r = runProbe("tools/claims/gate-census.mjs", [rootDir, "--batches=2", "--gated=1"],
      { env: { ...process.env, SIM_SEED_STRAY: seed } });
    const out = (r.stdout || "") + (r.stderr || "");
    return { r, s: parseSummary(out, "gate-census", seedFields), out };
  };
  const live = go("live");
  assert.equal(live.s.collapsed, 0, `注入面分母塌了，这次没量到：\n${live.out.slice(-400)}`);
  assert.ok(live.s.silent >= 2, `摆了两把活着的他人残留，静默却只有 ${live.s.silent} ⇒ 判数不清得出这一格`);
  assert.equal(live.s.events, live.s.dbl + live.s.silent, `恒等式在注入面上就不成立：${JSON.stringify(live.s)}`);
  assert.equal(live.s.code, 1, `只有静默、没有双主的轮，普查 code=${live.s.code}（应当 1）⇒ 静默这条腿仍然没有电`);
  assert.equal(live.r.status, 1, `真实退码 ${live.r.status} 与汇总行 ${live.s.code} 不一致`);
  const garbage = go("garbage");
  assert.equal(garbage.s.strayUnreadable, 2, `摆了两把读不出的残留，却数到 ${garbage.s.strayUnreadable} ⇒ 这一格是空的`);
  assert.equal(garbage.s.mc1a, 0, "读不出的残留被算成 MC-1-A：那是把'量具到不了'冒充成'抓到了'");
  assert.equal(garbage.s.events, 0, `读不出不该成为事件（events=${garbage.s.events}）：它只许被单列点名`);
  assert.equal(garbage.r.status, 0, `注入 garbage 面应当退 0，实退 ${garbage.r.status}`);
  const off = go("off");
  assert.equal(off.s.strayUnreadable, 0, `注入关着却有 ${off.s.strayUnreadable} 把读不出 ⇒ 这条腿自己会造证人`);
  assert.equal(off.s.collapsed, 0);
  assert.equal(off.s.code, off.r.status, "汇总行 code 必须就是真实退码");
  // 不认的取值：sim 当场退 9 拒绝，普查那一批因此读不到 RESULT_JSON ⇒ 整体退 2（"到不了"）。
  // 两件事都要成立：既不降级成"照跑"，也不把死因埋在"分母塌"这句话底下（本笔刚补的 sim 原文回显）。
  const bogus = runProbe("tools/claims/gate-census.mjs", [rootDir, "--batches=1", "--gated=1"],
    { env: { ...process.env, SIM_SEED_STRAY: "everything" } });
  const bOut = (bogus.stdout || "") + (bogus.stderr || "");
  assert.notEqual(bogus.status, 0, "不认的注入值被静默放行（退 0）：那等于按默认跑完还报干净");
  assert.match(bOut, /--seed-stray 只认/, `退了 ${bogus.status} 却没带 sim 的拒绝原文 ⇒ 归因埋在"分母塌"里：\n${bOut.slice(-500)}`);
  console.log(`[注入证人] live: silent=${live.s.silent} events=${live.s.events} 退 ${live.r.status}｜` +
    `garbage: unreadable=${garbage.s.strayUnreadable} mc1a=${garbage.s.mc1a} 退 ${garbage.r.status}｜` +
    `off: unreadable=${off.s.strayUnreadable} 退 ${off.r.status}｜bogus 退 ${bogus.status}`);
});
// ============ 行尾普查：工作树在盘上必须是 LF ============
// 2026-10-01 的脏重启事故里，`git checkout HEAD -- .` 按本机 core.autocrlf=true 把 5 个文件重新物化成 CRLF。
// 后果是三条吃 `\n}\n` 这种 LF 形状的源码扫描断言集体红（"找不到 writeBoard"那一族），看着像锁被人改了。
// 为什么必须单独一条门：那两条平时用来对账的尺子在这个事故里都靠不住——
//   · 内容哈希对账看不见它（clean 过滤把 CRLF 折回 LF ⇒ 与 blob 同哈希，字节却不同）；
//   · git status 到这事上一边在 README 被整份清零时仍报"干净"（stat 缓存命中，压根没重算），
//     一边在我把行尾换回 LF 后把 5 个文件列成 M（autocrlf 认为 CRLF 才是规范形态）。
// 所以承重的判据只有一条：**盘上字节里有没有 CR**。"盘上是 LF"是那三条断言的前提，不许靠运气。
test("跟踪文件在盘上必须是 LF：三条源码扫描断言的前提不许靠运气", () => {
  const g = spawnSync("git", ["-C", rootDir, "ls-files", "-z"], { encoding: "utf8" });
  if (g.status !== 0 || !g.stdout) {
    console.log(`[行尾普查] skipped-because=git ls-files 实退 ${g.status}（拿不到跟踪名单）⇒ 这条没判，不等于通过`);
    return;
  }
  const files = g.stdout.split("\0").filter(Boolean);
  // 单点分桶：LF / CRLF / 裸 CR / 读不到 —— 四类必须凑成分母，缺一类就有既不算过也不算失败的桶
  const classify = (f) => {
    let s;
    try { s = readFileSync(path.join(rootDir, f), "latin1"); } catch { return "missing"; }
    if (/\r\n/.test(s)) return "crlf";
    if (/\r/.test(s)) return "barecr";
    return "lf";
  };
  const cat = { lf: 0, crlf: [], barecr: [], missing: [] };
  for (const f of files) {
    const k = classify(f);
    if (k === "lf") cat.lf++; else cat[k].push(f);
  }
  const bad = [...cat.crlf, ...cat.barecr, ...cat.missing];
  const sum = cat.lf + cat.crlf.length + cat.barecr.length + cat.missing.length;
  console.log(`[行尾普查] 分母=跟踪文件 ${files.length}｜LF ${cat.lf}｜CRLF ${cat.crlf.length}｜裸 CR ${cat.barecr.length}` +
    `｜读不到 ${cat.missing.length}｜恒等式 ${sum}===${files.length} → ${sum === files.length ? "成立" : "不成立"}`);
  assert.equal(sum, files.length, "分桶没凑齐分母：有一类文件既没算进通过也没算进违规");
  assert.deepEqual(bad, [],
    `${bad.length}/${files.length} 个跟踪文件在盘上不是 LF：${bad.join(", ")}。\n` +
    "通常成因是 git 的 smudge（本机 core.autocrlf=true）重新物化：它写回 CRLF。这时内容哈希对账看不出任何异常" +
    "（clean 过滤又把 CRLF 折回 LF ⇒ 与 blob 同哈希），红的是那三条吃 LF 的源码扫描断言，" +
    "报出来像『writeBoard 被摘了』，会被误读成锁被人改了。\n" +
    "修法：把这几个文件行尾换回 LF（只删行尾 CR；换完字节数应等于 git cat-file -s HEAD:<file>）；" +
    "或给仓加一行 text=auto eol=lf 让 LF 成为规范形态 —— 后者改的是全机 checkout 行为，须主控批。");
});

// `wx-empty-window.mjs` 是本轮驳回 lock.js 那句"空文件窗口已消掉"的那次实验。
// README 按文件名引用了它，就得能按文件名跑到（这条口径就是上一批 board-race ENOENT 换来的）。
// 注意这条断言**不判有没有抓到 0 字节**：抓没抓到随机器快慢变，是读数；退码只判实验做成没做成。
test("wx 独占创建的 0 字节窗口实验必须真跑一次：它是读数，所以抓到与否不改退码", () => {
  const r = runProbe("tools/claims/wx-empty-window.mjs", ["60"]);
  const out = (r.stdout || "") + (r.stderr || "");
  const s = parseSummary(out, "wx-empty-window",
    ["planned", "wrote", "empty", "contentOk", "enoent", "handleMiss", "unreadable", "code"]);
  assert.equal(s.code, r.status, "汇总行的 code 必须就是真实退码（两份数不能各说各话）");
  assert.equal(s.wrote, s.planned, `计划写 ${s.planned} 次、真写 ${s.wrote} 次 ⇒ 分母不是本轮真值`);
  assert.equal(r.status, 0, `实验本身没做成（实退 ${r.status}）：\n${out.split(/\r?\n/).slice(-8).join("\n")}`);
  assert.equal(s.unreadable, 0, `unreadable=${s.unreadable} 却退了 0：状态说做成了、计数说没读回来`);
  assert.ok(s.empty >= 0 && s.contentOk >= 0 && s.enoent >= 0 && s.handleMiss >= 0,
    `计数出现负数（${JSON.stringify(s)}）：读不出被塞成了 0，那与"没抓到"就长成一个样`);
  // 四桶必须凑出"读者确实在读"：EPERM 那一桶单独列，否则"被 Windows 挡在门外"会冒充"什么都没发生"
  assert.ok(s.contentOk + s.enoent + s.handleMiss > 0,
    `三个非空桶全为 0（${JSON.stringify(s)}）⇒ 采样侧是死的，这份 0 不算证否`);
  console.log(`[wx 0 字节窗口] 写 ${s.wrote} 次 ⇒ 0 字节 ${s.empty}｜有内容 ${s.contentOk}｜不存在 ${s.enoent}` +
    `｜读不到句柄 ${s.handleMiss}｜退 ${r.status}（抓到与否都不改退码：这是读数，不是门）`);
});

// ============ 全机位口径：文档引用的每个可执行探针，套件里必须真 spawn 过它 ============
// 上一批 board-race 的 `slice(3)` 把仓库路径吞掉、探针一跑就 ENOENT，而 `npm test` 121/121 全绿。
// 根因不是断言不够严，是**套件与探针之间没有执行边**：所有用例都在读它的源码文本，
// 全绿只证明"关于它的断言对"，不证明"它能跑"。文本核对天生看不见参数偏移这类错——它从没喂过参数。
//
// 这条断言用"真跑一次才登记"而不是"扫源码里有没有 spawn 字样"：后者会被注释、
// 被 readFileSync 的字符串、被一条永不执行的分支骗过去。SPAWNED 只能由实际发生凑齐。
// 顺序依赖：node:test 顶层用例按登记顺序执行，本条放在文件最末，前面六个探针都已真跑过。
test("现场证据表点名的六个探针都被套件真 spawn 过（没有执行边就不许写'N/N 全绿'）", () => {
  const missing = PROBE_ROWS.map(([rel]) => rel).filter((rel) => !SPAWNED.has(rel));
  assert.deepEqual(missing, [],
    `这几个探针只被"读文本"核对过、从没被 spawn 过一次：${missing.join("、")}。` +
    "把它的烟雾用例补上（runProbe 一条即登记），否则对外那句'npm test 全绿'不成立。");
  assert.equal(SPAWNED.size >= PROBE_ROWS.length, true,
    `登记到 ${SPAWNED.size} 个 spawn，少于现场证据表的 ${PROBE_ROWS.length} 个：覆盖断言自身没被喂到`);
});

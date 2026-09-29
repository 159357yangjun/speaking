// 文档覆盖与陈旧描述守门。
//
// 三条规则各自的强度与可绕过方式，写在每条断言上方。**这是第二道网，不是门禁。**
// 真正的门禁是 test/docs-drift.test.js 那种结构比对（从围栏块抽字段名与代码 deepEqual），
// 它挡得住改写法；本文件的规则 B、C 是正则，换措辞即可绕过，用途是"顺手写错时被抓一次"。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith(".md")) out.push(rel.replace(/\\/g, "/"));
  }
  return out;
}

// 证据文件豁免：它们记录的是"当时什么是错的"，按仓库约定不可改写。
// 代价：证据文件里的陈旧措辞不受本测试约束，靠人工复核。
const EVIDENCE_DIR = "docs/evidence/";

// ============ 规则 A：受检清单必须动态枚举，新增文档不许静默逃检 ============
const CHECKED_SPECS = [
  "docs/specs/00-scope.md",
  "docs/specs/01-envelope.md",
  "docs/specs/02-identity.md",
  "docs/specs/03-signing.md",
  "docs/specs/04-transports.md",
  "docs/specs/05-security-model.md",
  "docs/specs/06-versioning-and-compat.md",
];

test("规则A：docs/specs/ 下每份文档都必须在受检清单里（新增文档不许静默逃检）", () => {
  const actual = walk("docs/specs");
  const unchecked = actual.filter((f) => !CHECKED_SPECS.includes(f));
  assert.deepEqual(unchecked, [],
    `以下 spec 未登记进 docs-coverage.test.js 的 CHECKED_SPECS，等于不受任何文档检查覆盖：\n  ${unchecked.join("\n  ")}\n` +
    `加进去之前先确认它是否含协议描述；若含，还要给它配结构断言（参照 docs-drift.test.js）。`);
  const ghost = CHECKED_SPECS.filter((f) => !actual.includes(f));
  assert.deepEqual(ghost, [], `CHECKED_SPECS 里列了不存在的文件：${ghost.join(", ")}`);
});

// ============ 规则 B：不许出现"翻位封帧"式描述，除非明确标注为历史 ============
const STALE_FRAMING = /done:?\s*false|不进签名域|不在签名域|排除在签名域/;
const HISTORICAL_MARK = /v1|历史|SUPERSEDED|已弃用|旧规则|旧版|当时的|曾写|曾规定|升级前/;

// **判豁免前必须先把版本号 token 剥掉。**
// 否则 `agent-relay/v1` 里自带 "v1"，任何提到旧版本号的行都会自动获得历史豁免，
// 规则 C 的主断言就变成永远不会开火的死代码——这个 bug 在本文件第一版里真实存在，
// 是靠"插入一行 agent-relay/v1 看它红不红"的演示才暴露的。
function stripVersionTokens(line) {
  return line.replace(/agent-relay\/v\d+/g, " ");
}
function looksHistorical(line) {
  return HISTORICAL_MARK.test(stripVersionTokens(line));
}

test("规则B：非证据文档里，凡描述旧封帧/旧签名域的行必须显式标注是历史", () => {
  const files = walk("docs").concat(walk("proto"), walk("adapters"), walk("tools"), ["README.md", "CONTRIBUTING.md"])
    .filter((f) => !f.startsWith(EVIDENCE_DIR));
  const bad = [];
  for (const f of files) {
    read(f).split(/\r?\n/).forEach((line, i) => {
      if (STALE_FRAMING.test(line) && !looksHistorical(line)) bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [],
    `以下行在描述 v1 的翻位封帧或旧签名域，却没标注它是历史，读者会当成现行规则：\n  ${bad.join("\n  ")}`);
});
// 规则 B 能被什么绕过：把 "done: false" 改写成 "未就绪标志位"、"先落草稿再定稿"等任何
// 不含上述字面的说法，就完全扫不到。它只在"照抄旧句子"时有效。
// 需要更强保证时，扩 docs-drift.test.js 的结构比对，不要扩这里。

// ============ 规则 C：活的指令文件里不许出现 v1 签名域 ============
// 判据：proto/ 与 adapters/*/prompt.md 是被 agent 直接执行的内容，不是历史叙述。
// 它们说 v1，适配器就签出对端验不过的消息，且从文件本身看不出错。
const LIVE_INSTRUCTION = [...walk("proto"), ...walk("adapters").filter((f) => /prompt\.md$/.test(f))];

test("规则C：活指令文件不得指示使用 v1 签名域", () => {
  const bad = [];
  for (const f of LIVE_INSTRUCTION) {
    read(f).split(/\r?\n/).forEach((line, i) => {
      if (/agent-relay\/v1|七行/.test(line) && !looksHistorical(line)) bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [], `以下活指令文件在教适配器签 v1 域：\n  ${bad.join("\n  ")}`);
});

// ============ 规则 D：指令文档里不得出现指向频道目录内的私钥路径 ============
// 正反斜杠都要吃——上一轮我用只匹配正斜杠的 grep 自查，漏掉了
// `channels\dev\keys\workbuddy.pem` 这条反斜杠形态。
//
// 受检范围按**用途**划，不按目录名随手划：
//   受检 = 会被执行或被照抄的东西（活指令、规格、README、adapter 说明）
//   不检 = 记录历史现场的证据与实验（docs/evidence/、experiments/）
// 理由：**证据要按当时的样子记路径，指令要指向东西现在在哪。**
// 迁移记录里那句 ENOENT 的完整路径正是"我们弄断过对端"的唯一物证，
// 把它改了等于毁证。这条边界不是豁免口子——它判据是文件用途，且写死在下面这个列表里。
const INSTRUCTION_DOCS = [
  ...walk("adapters"), ...walk("proto"), ...walk("docs/specs"), ...walk("tools"),
  "README.md", "CONTRIBUTING.md",
];
const CHANNEL_KEY_PATH = /channels[\/\\][^\s`'"()]*[\/\\]keys[\/\\][^\s`'"()]*\.pem/i;

test("规则D：指令文档里不得出现指向频道目录内的私钥路径", () => {
  const bad = [];
  for (const f of INSTRUCTION_DOCS) {
    read(f).split(/\r?\n/).forEach((line, i) => {
      if (CHANNEL_KEY_PATH.test(line)) bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [],
    `以下行写着频道目录内的私钥路径，而两把私钥都已迁出——照它执行必然 ENOENT：\n  ${bad.join("\n  ")}`);
});

test("规则D 的受检清单非空（防空跑：列表若被改错，上面的断言会永远绿）", () => {
  assert.ok(INSTRUCTION_DOCS.length >= 6,
    `指令文档受检清单只有 ${INSTRUCTION_DOCS.length} 项，疑似 walk 失效或路径写错`);
});

test("规则C 附带：活指令文件里出现的协议版本必须等于代码版本（无历史豁免）", async () => {
  const { digestOf } = await import("../src/proto/envelope.js");
  const codeVersion = digestOf({ seq: 1, from: "a", to: "b", type: "offer", done: true, nonce: "n", body: "" })
    .split("\n")[0];
  const bad = [];
  for (const f of LIVE_INSTRUCTION) {
    for (const m of read(f).matchAll(/agent-relay\/v\d+/g)) {
      if (m[0] !== codeVersion) bad.push(`${f}: 写着 ${m[0]}，代码是 ${codeVersion}`);
    }
  }
  assert.deepEqual(bad, [],
    `活指令文件里的版本号与代码不符：\n  ${bad.join("\n  ")}\n` +
    `活指令文件不是历史叙述，出现旧版本号就是错的，不给"这是历史说明"的豁免。`);
});

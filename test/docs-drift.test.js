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

test("文档与 schema 的协议版本必须等于代码版本", () => {
  const codeVersion = domainShapeFromCode()[0];
  const doc = readFileSync(SIGNING_DOC, "utf8");
  const occurrences = [...doc.matchAll(/agent-relay\/v\d+/g)].map((m) => m[0]);
  assert.ok(occurrences.length > 0, "文档里找不到任何 agent-relay/vN 版本号");
  for (const v of occurrences) {
    assert.equal(v, codeVersion, `docs/specs/03-signing.md 里有 ${v}，代码是 ${codeVersion}`);
  }
});

#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadRoster, keyringOf } from "./proto/roster.js";
import { seal, flipDone, verifyEnvelope, msgFileName, newNonce } from "./proto/envelope.js";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = {};
for (const a of args.slice(1)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) opt[m[1]] = m[2] === undefined ? true : m[2];
}

const CH = opt.channel ?? process.env.AGENT_RELAY_CHANNEL;
if (!CH) die("缺 --channel=<目录>");

function die(msg) {
  console.error("错误：" + msg);
  process.exit(1);
}
function read(p, fb) {
  return existsSync(p) ? readFileSync(p, "utf8") : fb;
}
function roster() {
  try {
    return loadRoster(readFileSync(join(CH, "roster.json"), "utf8"));
  } catch (e) {
    die(e.message);
  }
}
function myKey(handle) {
  const p = join(CH, "keys", `${handle}.pem`);
  if (!existsSync(p)) die(`找不到私钥 ${p}。私钥位置由人填写，不由 agent 生成。`);
  return readFileSync(p, "utf8");
}
function lastSeen(me) {
  return parseInt(read(join(CH, "agents", me, ".last_seen"), "0"), 10) || 0;
}
function seenNonces(me) {
  const p = join(CH, "agents", me, ".seen-nonce");
  return new Set(existsSync(p) ? read(p, "").split("\n").filter(Boolean) : []);
}
function allMessages() {
  const out = [];
  for (const dir of readdirSync(join(CH, "agents"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const base = join(CH, "agents", dir.name);
    for (const f of readdirSync(base).filter((n) => /^msg-\d+\.json$/.test(n)).sort()) {
      try {
        out.push({ file: join(base, f), env: JSON.parse(readFileSync(join(base, f), "utf8")) });
      } catch (e) {
        out.push({ file: join(base, f), broken: e.message });
      }
    }
  }
  return out;
}

if (cmd === "seal") {
  const r = roster();
  const me = opt.me ?? die("缺 --me");
  if (!r.members.some((m) => m.handle === me)) die(`${me} 不在名册里`);
  const body = opt["body-file"] ? readFileSync(opt["body-file"], "utf8") : (opt.body ?? die("缺 --body 或 --body-file"));
  const seq = parseInt(opt.seq ?? Math.max(0, ...allMessages().map((m) => m.env?.seq ?? 0)) + 1, 10);
  const dir = join(CH, "agents", me);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, msgFileName(seq));
  if (existsSync(path)) die(`${msgFileName(seq)} 已存在。seq 撞号，重跑一次。`);
  const env = seal({ seq, from: me, to: opt.to ?? "*", type: opt.type ?? "offer", body, nonce: newNonce() }, myKey(me));
  writeFileSync(path, JSON.stringify(env, null, 2));
  writeFileSync(path, JSON.stringify(flipDone(env), null, 2));
  console.log(`已写入并封帧 ${path}`);
  process.exit(0);
}

if (cmd === "drain") {
  const r = roster();
  const keys = keyringOf(r);
  const me = opt.me ?? die("缺 --me");
  const ls = lastSeen(me);
  const seen = seenNonces(me);
  const fresh = [];
  const rejected = [];
  for (const { file, env, broken } of allMessages()) {
    if (broken) {
      rejected.push({ file, reason: "JSON 解析失败" });
      continue;
    }
    if (env.done !== true) continue;
    if (env.from === me) continue;
    if (env.to !== me && env.to !== "*") continue;
    if (env.seq <= ls) continue;
    const v = verifyEnvelope(env, keys);
    if (!v.ok) {
      rejected.push({ file, reason: v.reason });
      continue;
    }
    if (seen.has(`${v.env.from}:${v.env.nonce}`)) continue;
    seen.add(`${v.env.from}:${v.env.nonce}`);
    fresh.push(v.env);
  }
  fresh.sort((a, b) => a.seq - b.seq || a.from.localeCompare(b.from));
  const maxSeq = Math.max(ls, ...fresh.map((e) => e.seq));
  mkdirSync(join(CH, "agents", me), { recursive: true });
  writeFileSync(join(CH, "agents", me, ".last_seen"), String(maxSeq));
  writeFileSync(join(CH, "agents", me, ".seen-nonce"), [...seen].join("\n"));

  console.log(`\n=== ${me}：新消息 ${fresh.length} 条，被拒 ${rejected.length} 条，last_seen → ${maxSeq} ===`);
  for (const e of fresh) {
    console.log(`\n[seq ${e.seq}] ${e.from} → ${e.to}  type=${e.type}`);
    console.log(e.body);
  }
  for (const x of rejected) {
    console.log(`\n✗ 拒收 ${x.file}\n  原因：${x.reason}   （body 未读取）`);
  }
  process.exit(0);
}

if (cmd === "show") {
  const r = roster();
  const keys = keyringOf(r);
  console.log(`频道 ${r.channel}｜成员 ${r.members.map((m) => m.handle).join(", ")}｜closed=${r.closed === true}`);
  for (const { env, broken } of allMessages()) {
    if (broken || !env) {
      console.log(`  ?  损坏`);
      continue;
    }
    const v = verifyEnvelope(env, keys);
    console.log(
      `  ${v.ok ? "✓" : "✗"} seq=${env.seq} ${env.from}→${env.to} ${env.type} done=${env.done}` +
        (v.ok ? ` ${JSON.stringify(env.body).slice(0, 40)}` : ` ${v.reason}`)
    );
  }
  process.exit(0);
}

console.log(`agent-relay CLI

  seal   --channel=<目录> --me=<handle> --to=<handle|*> --type=<t> (--body=<文本> | --body-file=<路径>)
  drain  --channel=<目录> --me=<handle>
  show   --channel=<目录>

seal 会一次写完 done:true，不留下半截文件——本机是单写者，封帧的两次写只在跨 agent 场景才需要。`)

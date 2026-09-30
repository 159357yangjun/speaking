#!/usr/bin/env node
// 测试夹具：**真的**拿一把板级锁，然后不走 release 直接退出。
// 要的是"持有者死了"这一件事在盘上留下的现场：一个活着但没人认领的 `__board__.lock`。
// 不做成 mock/mock-release——那样测的是我对 release 的想象，不是崩溃。
//
// 用法：node test/fixtures/hold-board-lock-and-die.mjs <claimsDir> <who>
// 退出方式：拿到锁后 process.exit(0)，**不**调用 release。
import fs from "node:fs";
import { acquire, BOARD_LOCK, BOARD_LOCK_TTL_S } from "../../src/claims/lock.js";

const claimsDir = process.argv[2];
const who = process.argv[3] ?? "deadholder";
if (!claimsDir) { console.error("用法：node hold-board-lock-and-die.mjs <claimsDir> [who]"); process.exit(9); }

const r = acquire({ claimsDir, file: BOARD_LOCK, who: `${who}#${process.pid}`, ttl: BOARD_LOCK_TTL_S });
if (r.status !== "acquired" && r.status !== "stolen") {
  console.error(`拿板级锁失败：${r.status} ${r.reason ?? ""}`);
  process.exit(8);
}
// 打印锁内容，让测试能断言"留下的是哪一把"。
// 用 fs.writeSync(1, …) 而不是 console.log：紧接着就 process.exit(0)，
// 而 stdout 接的是管道时 console.log 的写入是**异步**的，退出会把它丢掉——
// 现场就成了"子进程确实拿了锁，但父进程什么也没看见"。
fs.writeSync(1, JSON.stringify({ pid: process.pid, status: r.status, at: r.at, path: r.path }) + "\n");
process.exit(0);          // 刻意不 release

// 脏件普查：门与夹具共用的**同一把尺子**。
// 为什么要有这个文件：门原先把扫描写在 test/docs-drift.test.js 里，夹具若再抄一遍正则，
// 就是"拿复制品当测量"——两边可以一起错。现在两面只能引用这里。
// 名单每条必须带理由（无理由的清单，下一个人只会放宽它，不会补它）。
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const SCRATCH = [
  [/\.(log|tmp|bak[-\w]*|orig|rej|save|swp|swo)$/i,
    "跑出来的日志 / 备份 / 合并残留（red-demo 的 .bak-red 若崩在半路也在这儿）"],
  [/(^|[/\\])\.?tmp[-_]/,
    "以 tmp- / .tmp- 起头的一次性脚本：本仓那两个改 README 的 .cjs 就是这个形状"],
  [/(^|[/\\])(scratch[-_]\S*|dumps?|\.verify|\.shots-rejected)([/\\]|$)/i,
    "dump 与输出目录：隔壁仓的 .verify/ 与 .shots-rejected/ 各堆到上百个，把真信号埋掉、没人删"],
  [/[-_ ](?:copy|副本|final|new|old|v\d+|test\d*)\.(?:c|m)?js$/i,
    "手工复制出来的第二份源码：会被人当成现行那份读（过期副本冒充源码那一族）"],
];

// 单点分桶：一条路径算哪一类，只在这里决定一次。
export function classify(p) {
  return SCRATCH.findIndex(([re]) => re.test(p));
}

/**
 * 扫一棵树，返回普查的各个数——**这里只量不断**：断言留在调用方，
 * 因为"仓根必须有分母"与"%TEMP% 夹具可以只有 1 个跟踪文件"是两套要求。
 * @param {string} rootDir 绝对路径
 */
export function census(rootDir) {
  const raw = readdirSync(rootDir, { recursive: true, encoding: "utf-8" });
  // 排除 .git 与 node_modules。Windows 上 readdir(recursive) 用反斜杠连路径（实测 `.git\objects`
  // 的第 5 个字符码 = 92），而归一成正斜杠是"与 git 的输出去比"的前提，不是美化。
  const kept = raw.filter((p) => !p.startsWith("node_modules") && !/^\.git([\\/]|$)/.test(p));
  const slashed = new Set(kept.map((p) => p.split("\\").join("/")));
  const byCat = SCRATCH.map(() => 0);
  const hits = [];
  for (const p of kept) {
    const i = classify(p);
    if (i < 0) continue;
    byCat[i]++;
    hits.push({ file: p, cat: i, why: SCRATCH[i][1] });
  }
  const isRepo = existsSync(path.join(rootDir, ".git"));
  const g = isRepo ? spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: rootDir, encoding: "utf8" }) : null;
  const untracked = g && g.status === 0 ? (g.stdout || "").trim().split(/\r?\n/).filter(Boolean) : [];
  const t = isRepo ? spawnSync("git", ["ls-files"], { cwd: rootDir, encoding: "utf8" }) : null;
  const trackedList = t && t.status === 0 ? (t.stdout || "").trim().split(/\r?\n/).filter(Boolean) : [];
  const missing = trackedList.filter((p) => !slashed.has(p));
  return {
    root: rootDir,
    rawCount: raw.length,
    scope: kept.length,
    distinct: slashed.size,
    tracked: trackedList.length,
    missing,
    hits,
    byCat,
    catSum: byCat.reduce((a, b) => a + b, 0),
    untracked,
    gitOk: Boolean(g && g.status === 0 && t && t.status === 0),
    fallback: !isRepo ? "skipped-because=不是 git 工作树"
      : (g.status === 0 && t.status === 0 ? "已核" : `skipped-because=git 调用失败 status=${g.status}/${t && t.status}`),
  };
}

// 读数行：分母、覆盖、逐类、恒等式、兜底，一行打全（跑法要求重定向到文件，见 README"即时判别"）。
export function censusLine(c) {
  return `[脏件普查] root=${c.root} 分母=扫到 ${c.scope} 个路径(原始 ${c.rawCount}，已排除 node_modules/.git，含 ${c.distinct} 个不同名) `
    + `覆盖=跟踪 ${c.tracked - c.missing.length}/${c.tracked} `
    + `名单命中=${c.hits.length} 每类=[${c.byCat.join(",")}] 恒等式 ${c.hits.length}==${c.catSum} `
    + `未跟踪=${c.untracked.length} 兜底=${c.fallback}`
    + (c.missing.length ? `｜漏扫=${c.missing.slice(0, 5).join(",")}` : "")
    + (c.hits.length ? ` → ${c.hits.slice(0, 6).map((h) => h.file).join(" | ")}` : "")
    + (c.untracked.length ? ` → ${c.untracked.slice(0, 6).join(" | ")}` : "");
}

/**
 * 命令行入口。为什么要入参而不是只扫自己：门若只能扫"自己的仓"，那两面夹具就得往自己仓里造脏件
 * ——那正是"门红自己"的假象，也是这件事此前只做了一半的原因。能指定根，脏树就长在 %TEMP% 里。
 *   node tools/claims/dirty-census.mjs [--scan-root <目录>]     默认=本仓根
 * 退码：0 干净且分母成立 · 1 抓到脏件 · 2 分母不成立（跟踪集为空或 git 不可用 ⇒ 那份"0 命中"不作数）· 9 用法错
 */
export const EXIT_CODES = { clean: 0, found: 1, noDenominator: 2, badUsage: 9 };

function parseArgs(argv) {
  const out = { root: path.resolve(fileURLToPath(new URL("../..", import.meta.url))) };
  const known = (a) => a === "--scan-root" || a.startsWith("--scan-root=");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known(a)) throw new Error(`不认的参数 ${a}（只吃 --scan-root <目录>）`);
    if (a.startsWith("--scan-root=")) out.root = path.resolve(a.slice("--scan-root=".length));
    else {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--scan-root 后面必须跟一个目录（缺参数不许当默认值用）");
      out.root = path.resolve(v);
    }
  }
  return out;
}

// 只有被当命令跑时才打印——被测试 import 时不许往 stdout 里塞读数。
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.log(`!! 用法错：${e.message}`);
    console.log("用法：node tools/claims/dirty-census.mjs [--scan-root <目录>]");
    console.log(`退码表：${JSON.stringify(EXIT_CODES)}`);
    process.exit(EXIT_CODES.badUsage);
  }
  const { printSummary, crossCheck } = await import("../../src/claims/summary.js");
  if (!existsSync(opts.root)) {
    console.log(`!! 扫描根不存在：${opts.root}`);
    process.exit(EXIT_CODES.badUsage);
  }
  const c = census(opts.root);
  const bad = c.hits.length + c.untracked.length;
  console.log(censusLine(c));
  // 分母塌了优先于"干净"：没有分母的 0 命中不是结论（这是 26.1b 那条教训的退码化）。
  const code = c.tracked === 0 || !c.gitOk ? EXIT_CODES.noDenominator : (bad > 0 ? EXIT_CODES.found : EXIT_CODES.clean);
  // raw 现场重算走**另一条路**（逐类之和 + 未跟踪数），reported 走命中清单之和：
  // 两个数同源的话，这条印证就只是把同一个数抄两遍（面 E 那一族）。
  const raw = c.catSum + c.untracked.length;
  const untrust = (code === EXIT_CODES.clean || code === EXIT_CODES.found)
    ? crossCheck(code, { reported: bad, raw, expect: 2, measured: c.gitOk ? 2 : 1 })
    : null;
  if (untrust) console.log(`!! 这份读数不可信：${untrust}`);
  if (code === EXIT_CODES.noDenominator) console.log("!! 没有分母（跟踪集为空或不是 git 树）：这份『0 命中』不作数，别当干净读");
  printSummary({
    kind: "dirty-census", root: c.root, scope: c.scope, tracked: c.tracked,
    missing: c.missing.length, hits: c.hits.length, untracked: c.untracked.length, bad, code,
    codes: [...new Set(Object.values(EXIT_CODES))],
  });
  // 不可信只进报告行、不改退码：退码已经说完"干净/抓到/没分母"，再让它兼职表信噪会串两件事。
  process.exit(code);
}


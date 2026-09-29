# agent-relay

让**只有图形界面、没有 inbound API** 的 AI 客户端，通过往同一个地方写文本完成多轮协作，全程无人传话。

判据一句话：**参与方只需要会读写文件或发一个 HTTP 请求，不需要会任何协议。**

## 为什么存在

A2A 承诺"两个 agent 各开一个端口，对等互调"。实测结论是**这个前提在真实产品上不成立**：
腾讯 WorkBuddy 只有出向 MCP 连接器，文档里没有任何 inbound API。
所有现成的 A2A bridge 都假设对方可被 HTTP 调用，因此对这一类客户端一律接不进来。

本项目不等厂商开端点，用脏信道（文件、定时器）把"不能被调用的 agent"接进来。
代价是延迟以分钟计，收益是**不需要任何人许可**。

## 核心设计：信封归代码，正文归模型

```json
{ "seq":7, "from":"bob", "to":"alice", "type":"offer",
  "done":true, "nonce":"…", "body":"……自由文本……", "sig":"…" }
```

一条不可协商的规则：**信封字段由代码判断，`body` 由模型判断，两者权限不可互越。**
协议不解析 `body`，也不因 `body` 的内容改变行为。这是纯文本方案能守住底线的唯一方式。

## 当前实现状态

| 能力 | 状态 |
|---|---|
| Ed25519 签名与验签 | 已实现 |
| CLI（seal / drain / wait / show） | 已实现并实跑 |
| 伪造 `from` 被拒 | **已实测证伪**：用成员 B 的私钥签成员 A 的 handle → `drain` 拒收，原因"验签失败" |
| 拒收时不泄漏正文 | **已实测**：伪造正文在全部输出中出现 **0 次** |
| 篡改 `body` / `to` / `done` 被拒 | 已验证。`done` 自 v2 起在签名域内，v1 那个"翻位即自毁签名"的取舍已用改名封帧消掉 |
| 名册格式校验、满员判定、nonce 去重 | 已实现 |
| 文档与代码不漂移 | **`test/docs-drift.test.js` 钉住签名域的版本、字段名与顺序**。施加 v1 变异 → 3 条红、退出码 1；恢复 → 全绿 |
| 协作机制的并发保证 | **`tools/relay-sim` 可重跑**。旧 markdown 机制 5/5 轮谎报成功；独占锁 + 强制 TTL 机制 0/5 轮，且每轮恰好 1 领取 + 1 明确受阻 |
| **防篡改 `roster.json` 本身** | **未防护**，见下 |
| 端到端 5 轮无人往返 | 未跑。定时间隔实测最小 1 小时，且 WorkBuddy 无人值守需本人签风险确认 |
| adapter | 仅 `adapters/workbuddy/`，能力矩阵 4 项未知 |

测试总数 **26**（protocol 15 · docs-drift 5 · sim 6）。

```
npm test
node src/cli.js seal  --keys-dir=<私有目录> --channel=<频道目录> --me=<handle> --to=<handle|*> --type=offer --body="…"
node src/cli.js drain --channel=<频道目录> --me=<handle>
node src/cli.js wait  --channel=<频道目录> --me=<handle> --timeout=300
node tools/relay-sim/sim.js <空目录> --json
```

**`--keys-dir` 是必填的**（或设 `AGENT_RELAY_KEYS_DIR`）。代码不再回退到 `<频道>/keys`，
并且**拒绝任何落在频道目录树内的私钥**，即使被显式指认。
原因：私钥曾与名册同处共享区，而那份残留**改名后仍能签通现存公钥**——
只要还有一条路径能命中它，"私钥已移出共享区"就是假话。fail-closed 优于静默成功。

## 目录

命名与放置规则是强制的，见 [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)。

```
README.md              本文件
LICENSE                MIT
CONTRIBUTING.md        怎么加一个 adapter
channel.md             频道定义。人写，agent 只读
docs/
  CONVENTIONS.md       命名与放置约定（强制）
  specs/               00 范围 · 01 信封 · 02 身份 · 03 签名 · 04 传输 · 05 威胁模型 · 06 版本兼容
  evidence/            实测证据，带日期与来源
proto/                 机器可读格式 + 人写的两份提示词。不含任何产品名
src/                   crypto/ + proto/ + cli.js，与厂商无关
tools/relay-sim/       协作机制推演器，可重跑
tools/compat/          legacy-probe.js，只读探针：旧消息在新代码下会怎样
test/                  protocol · docs-drift · sim
experiments/           一次性验证，自带结论 README
adapters/              workbuddy/ —— 产品知识只能待在这里
```

依赖方向单向：`adapters → src → proto`，`test → tools → src → proto`。反向 import 即违规。

## 已知的根问题

`05-security-model.md` 的 A2：**名册本身没有任何保护。**
攻击者不必伪造签名，直接改 `roster.json` 里的公钥即可冒充任何成员。
测试里有一条专门验证这件事（换掉公钥 → 该成员所有消息立刻验不过）。

修它需要存储层能力（服务端按 key 拒写非本人前缀），文本层做不到。
这是本项目推荐尽快从共享目录迁到对象存储 + 条件写的唯一理由。

**在 A2 修好之前，本项目的身份体系应当被视为"防住发布假内容，防不住篡改名册"。**

## 怎么开始

1. 读 `docs/specs/00-scope.md` 确认你要做的不是它排除的那类
2. 人改 `channel.md`：目标、人数上限
3. 人给每个成员生成密钥对，私钥位置**自己填**，不经任何 agent 之手
4. 把 `proto/bootstrap-prompt.md` 交给发起方 agent
5. 人把发起方产出的 join 提示词逐个交给其他成员，并补上 `{{private_key_location}}`
6. 两侧各设定时器，间隔 1–5 分钟

## 本项目同时是一个靶场

共享目录 + 定时器的组合，本身就是一条**绕过所有对话层防护的注入物理通道**：
任何能往该目录写文件的程序，都能给两个厂商的 agent 下指令。

先建靶场，再建防护。顺序反了就没有动力。

## 发布约束：为什么未推的提交不急着推

**本仓库 remote 是公开仓库**（`private: false`）。推上去的东西收不回来——
不是"删掉就没事"，而是搜索引擎、他人 fork、GitHub 自身的缓存都会留下副本。
所以**每一条对外结论在推之前都要当成已发表对待**。

这条约束的实际含义不是"别推"，而是下面五道闸——**全过才推**：

| # | 判据 | 为什么是这条 | 当前 |
|---|---|---|---|
| 1 | `npm test` 全绿，**且每条守门断言都演示过红** | 没红过的断言不知道活没活。本项目已抓到过一条永远开不了火的死断言 | ✅ 42/42 |
| 2 | 新增文档已登记进受检清单 | 文档会加，加了就静默逃检——已经发生过一次 | ✅ 规则A 守着 |
| 3 | 仓库里不含"已防"式无条件结论 | 无条件结论会被下一轮当结论用。A3 已按此降级为条件防护 | ✅ |
| 4 | **归因枚举已被对端实际跑过一轮** | 没跑过，`adapters/` 里那份就只是**未验证的接口约定**，推上去等于对外发布未验证的东西 | ❌ 待本人执行，文本已备好 |
| 5 | **`keys/` 处置已定** | 磁盘上若还留着能签通现存公钥的私钥，对外说"已移出共享区"就是夸大 | ✅ 频道内已无任何私钥 |

**判据 4 未满足 → 当前不推。**

判据 5 的现状：`channels/dev/keys/` 只剩 `qoder.pub` 与 `workbuddy.pub`，
两把私钥分处 `C:\Users\yyyy\.agent-relay\keys\{qoder,workbuddy}\`，另有 qoder 的一份历史备份
在同目录 `superseded-2026-09-29\` 下（**本轮明确不删**，因为回滚已不再是"把文件移回去"就够——
代码第三档回退已删，需同时 revert `src/cli.js` 的 `keySource()`）。
细节、实测输出与回滚在 `docs/evidence/2026-09-29-key-migration.md`。

还有一条与判据无关的操作提醒：**未推提交积压越多，出问题时分不清是哪一笔造成的**。
所以判据 4、5 一满足就立刻推，不要继续往上叠。

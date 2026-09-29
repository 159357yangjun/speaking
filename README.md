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
| Ed25519 签名与验签 | **已实现，14 项单元测试全通过** |
| CLI（seal / drain / show） | **已实现并实跑** |
| 伪造 `from` 被拒 | **已实测证伪**：用成员 B 的私钥签成员 A 的 handle → `drain` 拒收，原因"验签失败" |
| 拒收时不泄漏正文 | **已实测**：伪造正文在全部输出中出现 **0 次** |
| 篡改 `body` / `to` 被拒 | 已验证 |
| 封帧翻 `done` 后签名仍有效 | 已验证 |
| 名册格式校验、满员判定、nonce 去重 | 已实现 |
| **防篡改 `roster.json` 本身** | **未防护，见下** |
| 端到端 5 轮无人往返 | 未跑。卡在两个未验证前提，见 `adapters/workbuddy/README.md` |
| adapter | 仅 `adapters/workbuddy/`，能力矩阵有 4 项未知 |

```
npm test
node src/cli.js seal  --channel=<目录> --me=<handle> --to=<handle|*> --type=offer --body="…"
node src/cli.js drain --channel=<目录> --me=<handle>
node src/cli.js show  --channel=<目录>
```

**一处实现与规范的偏离**：`seal` 一次写完 `done:true`，没走"先 false 再翻 true"。
本机单写者场景没有半截风险；跨 agent 的两次写只在 adapter 里需要，规范保留该要求。

## 目录

命名与放置规则是强制的，见 [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)。

```
README.md              本文件
LICENSE                MIT
CONTRIBUTING.md        怎么加一个 adapter
channel.md             频道定义。人写，agent 只读
docs/
  CONVENTIONS.md       命名与放置约定
  specs/               00 范围 · 01 信封 · 02 身份 · 03 签名 · 04 传输 · 05 威胁模型
  evidence/            实测证据，带日期与来源
proto/                 机器可读格式 + 人写的两份提示词。不含任何产品名
src/                   crypto/ + proto/ + cli.js，与厂商无关
test/                  协议层测试
experiments/           一次性验证，自带结论 README
adapters/              workbuddy/ —— 每个目标客户端一个目录，产品知识只能待在这里
```

依赖方向单向：`adapters → src → proto`，反向 import 即违规。

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

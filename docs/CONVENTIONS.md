# 命名与放置约定

本文件的规则是强制的。文件名和路径本身携带信息，不需要打开文件就该知道它是什么、能不能改、谁写的。

## 一、顶层目录各自承担什么

| 目录 | 承担 | 谁能写 | 判据 |
|---|---|---|---|
| `/` 根 | 项目入口与频道定义 | 人 | 只放 3 个文件，超过就说明有东西该往下挪 |
| `docs/specs/` | 设计决策：为什么这样做 | 人 | 被引用而不引用实现 |
| `docs/evidence/` | 实测事实：什么被验证过 | 人 | 每条带日期、来源、核查方式 |
| `proto/` | 机器可读格式 + 人写的提示词 | 人 | **不许出现任何产品名** |
| `src/` | 与厂商无关的实现 | 人 / agent | 只依赖 `proto/`，不依赖 `adapters/` |
| `test/` | 断言。每条都必须先证明"输入确实生效"才算通过 | 人 | 不含业务逻辑，只调 `src/` 与 `tools/` |
| `tools/` | 可执行的验证器/推演器，被 `test/` 调用也被人直接跑 | 人 | 不依赖 `adapters/`；自带 README 说明怎么跑 |
| `adapters/` | 每个目标客户端的脏活 | 人 / agent | 产品知识只能待在这里 |
| `experiments/` | 一次性验证 | 任意 | 必须自带 README 说明结论，否则删掉 |

**依赖方向单向：`adapters → src → proto`，`test → tools → src → proto`。反向 import 即违规。**
这条决定项目会不会腐化成一堆 `if (client == "xxx")`。

**`tools/` 与 `experiments/` 的分界：** 结论需要能被任何人重跑验证的进 `tools/`，
只回答一次性问题的进 `experiments/`。判据是"别人改完协议还能不能再跑"，不是"当时有没有用"。

## 二、specs 用序号前缀，序号即依赖层

```
00-scope.md          不做什么
01-envelope.md       信封与正文         ← 依赖 无
02-identity.md       接入与身份         ← 依赖 01
03-signing.md        签名与验签         ← 依赖 01,02
04-transports.md     传输层可插拔       ← 依赖 01
05-security-model.md 威胁模型与未防护清单 ← 依赖 01–04
06-versioning-and-compat.md 版本与向后兼容 ← 依赖 01,03
```

规则：**一个 spec 只能引用比它序号小的。** 出现前向引用说明拆分错了。
新增 spec 追加序号，不插号。

## 三、文件名携带的信息

| 类型 | 格式 | 例 |
|---|---|---|
| 证据 | `YYYY-MM-DD-<topic>.md` | `2026-09-28-agent-protocol-landscape.md` |
| 实验目录 | `YYYY-MM-DD-<topic>/` | `2026-09-28-handoff/` |
| 协议格式 | `<对象>.schema.json` | `envelope.schema.json` |
| 人写的提示词 | `<角色>-prompt.md` 或 `<角色>-prompt-template.md` | `bootstrap-prompt.md` |
| 一次性产物 | 沿用原始名，不重命名 | `NOTES.md`（agent 起的名字就是历史） |

**日期一律绝对，不用"最近""上周"。** 证据和实验按时间不可变，写错了新增一份并在旧份顶部标 `SUPERSEDED BY: <新文件>`，不改写历史。

## 四、"谁写的"必须在文件名或首行可见

| 标记 | 含义 |
|---|---|
| 首行 `**本文件由人维护**` | agent 只读，禁止修改 |
| 首行 `状态：待批` | 未生效，可推翻 |
| 首行 `状态：已批准` | 改动需在提交信息里说明理由 |
| `experiments/` 内的 agent 产物 | 保留 agent 原始命名，不做美化 |

## 五、频道内运行时文件的命名

```
channel.md                        人写，agent 只读
roster.json                       发起方首次创建，此后所有人只读
agents/<handle>/msg-<seq>.json    只能新建，永不修改已存在的（done 标志位除外）
agents/<handle>/.last_seen        整数。不入库
agents/<handle>/joins/<handle>.md 发起方为新人填好的 join 提示词副本
```

`msg-<seq>` 的 `<seq>` 为 5 位零填充（`msg-00007.json`），保证文件名字典序等于序号序。

## 六、配置与依赖例外登记

**本仓库不新增任何依赖、不装任何服务。** 唯一被批准的项目配置文件改动记于此，
免得后人看到 `package.json` 被改就以为开了依赖例外。

| 文件 | 改了什么 | 没改什么 | 批准人 / 日期 |
|---|---|---|---|
| `package.json` | 仅 `scripts`：`test` 扩为三个测试文件，新增 `sim` | `dependencies`、`devDependencies`、`version`（仍 `0.1.0`） | 人 / 2026-09-29 |

**规则：动 `dependencies` / `version` / lock 文件需要单独批准，且不因"上次批过 scripts"而自动生效。**

# agent-relay（暂定名，命名未定不影响结构）

让**只有图形界面、没有 API** 的 AI 客户端，通过往同一个地方写文本，完成多轮协作，全程无人传话。

## 不做什么

不做实时、不做协议发现、不做任务编排、不重新定义传输标准。
A2A / MCP 已经存在，本项目只处理它们接不进来的那一类：**不能被调用的桌面 AI 客户端**。

## 目录地图

```
/                       仓库根
├── README.md           本文件：项目边界与约定
├── channel.md          频道定义。人写，agent 只读。目标、人数上限、人的职责
├── docs/
│   ├── specs/          设计规范。一份文件 = 一个子系统。命名 YYYY-MM-DD-<topic>-design.md
│   └── evidence/       实测证据与来源。凡进入决策的事实，必须落在这里，不接受口头引用
├── experiments/        一次性验证。产物标记为可丢弃，不升级为实现
├── proto/              协议定义：信封、名册格式，以及两份人写的提示词
├── src/                实现
└── adapters/           每个目标客户端一个目录，脏活全在这层
```

`proto/` 现有内容：

| 文件 | 性质 |
|---|---|
| `envelope.schema.json` | 一条消息的格式。信封字段归代码，`body` 归模型 |
| `roster.schema.json` | 公开名册格式。**不含任何秘密** |
| `bootstrap-prompt.md` | 人写的，交给频道里第一个 agent |
| `agent-prompt-template.md` | 人写的固定模板。agent 只许填 `{{参数}}` |

## 什么放哪（约定）

| 你要放的东西 | 放这里 | 不放这里 |
|---|---|---|
| 一份设计，还没实现 | `docs/specs/` | 不放代码注释 |
| "某产品没有 inbound"这类结论 | `docs/evidence/`，附核查日期与来源 | 不放 README，不放聊天 |
| 跑过一次就废的验证 | `experiments/` | 不进 `src/` |
| 某个客户端的适配细节 | `adapters/<产品名>/` | 不进 `proto/` |

**一条硬约定：`proto/` 里不许出现任何产品名。** 产品知识只能待在 `adapters/`。这条是本项目会不会变成一堆 if-else 的分界线。

## 当前状态

| 位置 | 内容 | 状态 |
|---|---|---|
| `docs/specs/…cross-agent-text-handoff-design.md` | 信封+正文协议，八节 | 待批 |
| `docs/specs/…bootstrap-and-identity-design.md` | 接入与身份，含五条不变量与伪造路径清单 | 待批 |
| `proto/` 四份 | 协议格式与人写的两份提示词 | 待批 |
| `channel.md` | 首个频道定义 | 待人工生成密钥 |
| `experiments/handoff-2026-09-28/` | 首次双 agent 交接实验 | 已完成，实测通过 |
| `docs/evidence/` | 协议格局核查证据，附来源与日期 | 已归档 |
| `src/` `adapters/` | 空 | 未开始 |

**尚未实现的东西：签名与验签。** 全部规范都依赖它，但 `src/` 里还没有一行代码。
在此之前，第五节的"防伪造消息"只是纸面承诺。

## 已确认的事实前提

- WorkBuddy 5.6.2 无 inbound API，仅出向 MCP/CLI 连接器 → 只能 handoff，不能实时
- WorkBuddy 能执行脚本、能跨出自己的根目录写第三方路径 → 适配层可行
- 两侧都有定时器（WorkBuddy「定时任务」/ Qoder `qoder_cron`）→ 唤醒已解决
- 共享目录**零访问控制** → 本项目要解决的核心问题，不是要绕开的问题

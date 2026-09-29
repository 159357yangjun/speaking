# 实验：双 agent 文件交接（2026-09-28）

一次性验证，产物标记为可丢弃，不升级为实现。

## 问题

在双方都没有 inbound API 的前提下，两个不同厂商的 agent 能否通过读写同一目录完成一次任务交接？

## 结论

**能交接，没交互。** 全程无一条消息在两个 agent 之间直接传递，人是唯一的信道。

| 时刻 | 动作 |
|---|---|
| 05:02–05:03 | Qoder 写 `BRIEF.md`、`EVIDENCE.md` |
| — | 人把提示词粘进 WorkBuddy |
| 05:22–05:23 | WorkBuddy 读、写 `NOTES.md`、改 `STATUS.json` |
| 之后 | Qoder 读回校验 |
| — | 人把 WorkBuddy 的回复粘给 Qoder |

## 实测到的三件事

1. WorkBuddy **能执行脚本**（它自述撞了 `len()` 的 bug 并重跑），因此具备跑 git 的能力
2. WorkBuddy **能跨出自己的根目录**，写进了 `C:\Users\yyyy\Documents\Qoder\...\handoff`
3. 共享目录**零访问控制**——任何一端都能改写另一端的任何文件，包括协议本身

第 3 条催生了本仓库，是本项目要解决的核心问题。

## 校验差异（不采信自述）

WorkBuddy 自报正文 1096 字、整文件 1192 字；实测 **1050 / 1115**，高报约 4–7%，但验收结论不变。
URL 数、事实来源、越界情况三项自述与实测一致。

## 文件

- `BRIEF.md` — 人写的分工与验收标准，含一处刻意留下的矛盾要求（成稿禁链接 vs 可核验）
- `EVIDENCE.md` — 已迁至 `docs/evidence/2026-09-28-agent-protocol-landscape.md`
- `NOTES.md` — WorkBuddy 产出，1050 字，零 URL
- `STATUS.json` — 被 WorkBuddy 改为 `workbuddy-done`

`NOTES.md` 文中引用的 `EVIDENCE.md` 路径是实验当时的目录结构，现已失效，保留原文不改。

## 探针结果

WorkBuddy 守住了边界：把对分工的异议写在 `NOTES.md` 末尾单独一节，未擅改流程。

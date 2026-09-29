# 已核实证据（本文件是事实源，改写时不得超出此范围）

核查时间：2026-09-28。以下条目均来自官方文档或可访问的一手/二手来源。

## 1. A2A 协议已到 1.0.0，且不再是一个"想法"
- 核心对象：Agent Card、Task、Message、Artifact、Part
- 传输：同时支持 JSON-RPC、gRPC、HTTP/REST
- 鉴权：API Key、OAuth2、OIDC、mTLS
- 官方 SDK 语言：**Python、Go、Java、JS、.NET、Rust**（六种，**没有 Kotlin**）
- a2a-java 已发布 1.0.0.CR1（2026 年 5 月），属 Quarkus 技术线，面向服务端
- 来源：https://a2a-protocol.org/latest/specification/ 、 https://quarkus.io/blog/a2a-java-sdk-1-0-0-cr1-released/

## 2. 协议层与身份层已被标准组织占位
- MCP 于 2026-07-28 发布新规范，核心转向**无状态**，目标是企业级跨环境调用
  - 来源：https://blog.yeyupiaoling.cn/article/1785513906544 、 https://friday-go.icu/ai/mcp-2026-roadmap-deep-dive
- Linux 基金会于 2026 年 6 月推出 **Agent Name Service（ANS）**，类 DNS 的智能体身份认证框架
  - 来源：https://news.sina.cn/ai/2026-06-27/detail-iniewnkn6887095.d.html
- 微软 Azure AI Foundry 已把 "enable incoming A2A" 做成产品功能（preview）
  - 来源：https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/enable-agent-to-agent-endpoint
- 行业分工共识：**MCP 管工具，A2A 管 Agent**
  - 来源：http://t.cj.sina.cn/articles/view/1786788815/6a803bcf0010bchcq

## 3. 本次实验的关键发现：能力是不对称的
WorkBuddy 开放平台连接器文档（https://open.workbuddy.cn/docs/connector）实测结论：
- WorkBuddy 支持 **MCP（streamableHttp / SSE）** 与 **CLI** 两类连接器
- 方向是单向的：**第三方暴露 MCP server，WorkBuddy 作为 client 去调用**
- 鉴权：OAuth 2.1 + PKCE，或用户自带 token
- 文档中**没有任何 inbound API**，也没有 A2A agent 端点

推论（这是本笔记的核心论点，允许展开但不得改向）：
- 外部 agent **无法调用** WorkBuddy；WorkBuddy **可以调用**外部 MCP server
- 因此 A2A 设想的"两个 agent 互开端点对等协作"，在真实厂商产品上**前提就不成立**
- 可行的替代路径：把其中一方降格为**共享黑板**（本实验用同一目录交接，而非协议握手）

## 4. 需求侧信号
- 2026 年报道中反复出现的痛点标题："78% 企业多 Agent 集成失败"
  - 来源：https://m.blog.csdn.net/weixin_40967106/article/details/163834063
- 已记录的安全问题：MCP Server 恶意投毒攻击（FreeBuf，2026-09）
  - 来源：https://www.freebuf.com/articles/ai-security/500438.html
- 对 A2A 安全的公开批评："AI 之间开始打电话了，但没人装防盗门"
  - 来源：https://www.jianshu.com/p/9bc3c01997ae

## 5. 明确不成立的说法（写作时不要采用）
- "没有 Kotlin SDK 所以没人做过移动端 A2A" —— 不成立。Kotlin 可直接调用 a2a-java（JVM 互操作）。
  真正的未知是：a2a-java 依赖 Vert.x 与完整 Java 并发 API，Android 无完整 JVM，
  且 SSE 长连接受 Android 后台限制影响 —— **此点尚未验证，不得写成结论**。
- "现在就能做两个 agent 实时对话" —— 不成立。当前只能做**交接（handoff）**，不能做推送。

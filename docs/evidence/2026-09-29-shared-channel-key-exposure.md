# 共享频道目录内的双向私钥暴露

核查时间：2026-09-29　核查人：人（159357yangjun）先查，qoder 复核并补齐
对象：`C:\Users\yyyy\agent-relay\channels\dev\keys\`
本报告**取代** `2026-09-28-progress-board-reconciliation.md` 第三节。
那份通篇只讨论 `qoder.pem`，漏了 `workbuddy.pem`，等于把"对方身份同样可被伪造"这件事并进了结论而没写出来。

---

## 一、事实

```
$ ls -la C:\Users\yyyy\agent-relay\channels\dev\keys\
qoder.pem       119 字节   -----BEGIN PRIVATE KEY-----
qoder.pub        43 字节
workbuddy.pem   119 字节   -----BEGIN PRIVATE KEY-----
workbuddy.pub    43 字节
```

两把**私钥**都在共享频道目录里，同 UID 直接读出，无需提权。

## 二、已经发生过的实际伪造（不是理论）

上一轮为了让 `drain` 的验签路径可观测，qoder 做过这件事：

> 注入一条伪造消息，`from` 填 `qoder`，**用 `workbuddy.pem` 签名**

结果：`drain` 报"验签失败（body 未读取）"，拒收。

**这条实验证明的是双向能力**：持有 `workbuddy.pem` 的一方可以伪造 `from=qoder` 的消息，反之亦然。
roster 里**任何**成员的身份都可被另一方完整伪造。
qoder 当时只把这当成"证伪 drain 的验签逻辑"，没有往上抽一层写进结论——这是漏报，不是笔误。

## 三、轮换判定：**不需要**

| 检查 | 命令 | 结果 |
|---|---|---|
| 私钥是否被跟踪 | `git ls-files \| grep -iE "pem\|keystore\|secret\|\.env"` | **零命中** |
| 全部历史是否含 .pem | `git rev-list --all --objects \| grep -i "\.pem$"` | **零命中**（88 个对象） |
| 密钥是否在本仓工作树内 | 路径对比 | **不在**。仓库是 `Documents\Qoder\2026-09-28\50171e16`，密钥在 `agent-relay\channels\dev\keys\` |
| 远端 | `git remote -v` + GitHub API 匿名 200 | `github.com/159357yangjun/speaking`，`private: false`，`visibility: public` |

**"已进公开历史 → 必须换密钥对、挪文件无效"这个最坏假设已被证伪，撤回。**

**真正的缺陷是：同 UID 下，共享目录里双方私钥互相可读。**

## 四、路径解析：移走会弄坏什么

```
src/cli.js:15   const CH = opt.channel ?? process.env.AGENT_RELAY_CHANNEL
src/cli.js:33     const p = join(CH, "keys", `${handle}.pem`)
src/cli.js:71     seal({…}, myKey(me))
```

| 操作 | 依赖 `.pem` 吗 | 移走后的后果 |
|---|---|---|
| `seal`（签名） | **是** | 立即失败，报"找不到私钥 …"，**显式报错不静默降级** |
| `drain` / `wait` / `show`（验签） | 否，用 `roster.json` 的公钥指纹 | **不受影响** |
| WorkBuddy 侧 `crypto-helper.js` | 是，`TASK.md` 里给它写了路径 | 需同步改 `TASK.md` 与 `capability.txt` 的指引 |

所以"移走密钥"这件事**必然要配套改代码路径**，否则频道当场签不出消息。这是为什么先报方案不动手。

## 五、目录方案（**未批，未执行**）

原则：**两把私钥不得同目录，且都离开 `channels/`。**

```
现在：  channels\dev\keys\{qoder.pem, workbuddy.pem}      ← 一次读取丢两个身份

提议：  C:\Users\yyyy\.agent-relay\ids\qoder.pem            ← 每方一个私有目录
        C:\Users\yyyy\.agent-relay\ids\workbuddy.pem
        channels\dev\keys\*.pub                             ← 公钥可留，本就是公开信息
        channels\dev\roster.json                            ← 不动，验签锚点
```

配套代码改动（一处，向后兼容）：

```
src/cli.js  myKey(handle) 的解析顺序改为：
  1. --keys-dir=<目录>
  2. 环境变量 AGENT_RELAY_KEYS_DIR
  3. 回退 join(CH,"keys",handle+".pem")     ← 保留，旧频道不破
```

**这个方案挡不住什么，写清楚：**

1. 挡不住同 UID 下的任意进程。`.pem` 放在用户目录任何位置，以 `yyyy` 跑的进程都读得到。
   移出 `channels/` 解决的是**"两个 agent 的授权范围重叠"**，不是本机恶意进程。
2. 真正的隔离需要不同用户账户或 DPAPI/凭据管理器按主体授权——那是另一件事，且要装东西，超出边界。
3. 现有 `legacy-v1/` 两条消息的签名链**依赖公钥不变**。不换密钥对，所以历史消息仍可验；
   一旦将来轮换，那两条会永久验不过，必须同时归档说明。

## 六、待你决定

- [ ] 目录方案是否照上面执行（含 `src/cli.js` 的 `--keys-dir` 改动）
- [ ] 或者只挪文件、代码先不动（后果：`seal` 在配好新路径前不可用）
- [ ] 或者暂不动，只把本缺陷写进 `docs/specs/05-security-model.md` 的 A 类攻击面

qoder 未移动、未删除、未重命名 `keys/` 下任何文件，未新建密钥。

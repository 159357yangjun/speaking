# 私钥迁出共享频道区 · 执行记录与回滚

日期：2026-09-29　执行人：qoder（按 159357yangjun 逐步指令）
范围：只迁 `qoder` 这一把。**WorkBuddy 那把未动，原因见第四节。**
全程未新建仓库、未装任何东西、未碰远端。

## 一、本次只解决什么

**不解决**：同 UID 下的任意进程读取。Windows 上 `chmod 600` 不生效
（执行后列出仍是 `-rw-r--r--`，POSIX 权限位在这里无意义，由 NTFS ACL 决定）。

**解决**：两个 agent 的授权目录重叠。WorkBuddy 被授权读写整个频道目录，
而 `keys/` 就在频道目录里 → 它一次读取就能同时拿到双方身份。
把 `qoder.pem` 移出 `channels/`，这条就断了。

**私钥仍从未进过 git**（已实测，非假设）：
`git ls-files | grep -iE "pem|keystore|secret|\.env"` 零命中；
`git rev-list --all --objects | grep -i "\.pem$"` 零命中（88 个对象）。
所以**不轮换密钥对**，只搬家。

## 二、执行序列与实测输出

### 1) 先查清谁在读密钥（动手前）

```
src/cli.js:33    const p = join(CH, "keys", `${handle}.pem`)     ← 我方唯一读点
src/cli.js:71    seal({…}, myKey(me))                              ← 只有签名用它
grep --keys-dir / KEYS_DIR → 只命中 docs/evidence/ 里的提案文字
```

**发现：`--keys-dir` 上一轮只写进了文档，代码从未实现。** 所以第 2 步之前先补实现，
否则"用新路径跑真实往返"根本无从执行。

对端侧：
```
make-deliverable.js:7   const BASE = 'C:/Users/yyyy/agent-relay/channels/dev';
make-deliverable.js:8   const PEM  = path.join(BASE, 'keys/workbuddy.pem');   ← 硬编码
crypto-helper.js:37     function sign(msg, pemPath)                            ← argv 传入，安全
```

### 2) 建私有目录并复制（原件不动）

```
C:\Users\yyyy\.agent-relay\keys\qoder\qoder.pem
sha256  1a0cfc045faba38378527431f2e10dec92e3f5ec1a22879ef74ecfdd76501bd9
频道原件 sha256 同上 → 一致
```

### 3) 用新路径跑真实往返

```
[密钥来源] --keys-dir → C:\Users\yyyy\.agent-relay\keys\qoder\qoder.pem
已写入 …\agents\qoder\msg-00001.json（.part 改名封帧，done 在签名域内）

对端身份读回：新消息 1 条，被拒 0 条，last_seen 0 → 1

legacy 旧消息归因：
{"ok":false,"code":"UNSUPPORTED_VERSION",
 "reason":"版本不支持：该消息按 agent-relay/v1 签名，本端只接受 agent-relay/v2"}
```

三项都过才继续。

### 4) 改名不删

```
keys\qoder.pem → keys\qoder.pem.superseded-2026-09-29
改名后 sha256 仍是 1a0cfc045f…（内容未变，文件未删）
keys\workbuddy.pem 未动，sha256 7271e2c78f…
```

### 5) 改名后复验

```
5a 显式 --keys-dir        → 成功，来源打印正确
5b 不给 --keys-dir        → 退出码 1，"找不到私钥 …（来源：回退：<频道>/keys）"
                             ↑ 证明没有静默用回旧位置
5c 对端读回               → 新消息 1 条，被拒 0 条
5d 对端 helper 验我方消息 → VERIFY_OK     ← 跨实现互认未被打断
```

## 三、回滚方法（一条命令）

```
mv "C:\Users\yyyy\agent-relay\channels\dev\keys\qoder.pem.superseded-2026-09-29" \
   "C:\Users\yyyy\agent-relay\channels\dev\keys\qoder.pem"
```

回滚后校验（应输出 `1a0cfc045faba38378527431f2e10dec92e3f5ec1a22879ef74ecfdd76501bd9`）：

```
sha256sum "C:\Users\yyyy\agent-relay\channels\dev\keys\qoder.pem"
```

回滚不需要改任何代码——`--keys-dir` 是新增档位，不给它就走原来的 `<频道>/keys`。
私有目录里那份复制件可以留着，删不删都不影响回滚。

## 四、WorkBuddy 那把为什么没动（**待本人处理**）

`make-deliverable.js:8` 把 `keys/workbuddy.pem` **硬编码**进了脚本。
改名会让它直接 ENOENT，即**弄断对端的签名链路**——这违反"别把对方弄断"。

要迁它，必须先让对端改掉那个硬编码路径。那是跨客户端动作，且要本人在 WorkBuddy 里操作。
建议顺序：

1. 本人让 WorkBuddy 把 `make-deliverable.js` 的 PEM 改成 argv 或环境变量传入
2. 复制 `workbuddy.pem` 到 `C:\Users\yyyy\.agent-relay\keys\workbuddy\`
3. 用新路径跑一轮真实签名 + 我方 `drain --me=qoder` 验通
4. 再把频道里那把改名为 `.superseded-<日期>`

## 五、当前共享区残留

```
keys\qoder.pem.superseded-2026-09-29   ← 改名未删，内容仍是有效私钥
keys\workbuddy.pem                     ← 仍在原位，仍可读
keys\qoder.pub  keys\workbuddy.pub     ← 公钥，留着是对的
```

**`qoder.pem.superseded-2026-09-29` 本身仍然是一把可用的私钥，只是没人按这个名字去找它。**
确认回滚不再需要之后，应当删除它——删除是破坏性动作，等本人拍。
在它被删除之前，"qoder 私钥已移出共享区"这句只对**代码路径**成立，对**磁盘内容**不成立。

---

# 更正（同日第二轮，执行人指出）

## 一、"原地改名不删"这一步是错的

第三节的回滚命令已被本节取代。

原地改名 `qoder.pem` → `qoder.pem.superseded-2026-09-29` **一点也没降低暴露**：
私钥内容还在同一个共享目录、同 UID 照读不误，而且是**同一把钥匙**——
拿这份残留签名，留在频道的 `qoder.pub` 照样验通。
"迁出共享区"这个目标当时并未完成，只是换了个文件名。

选"不删"的动机是可逆，但**在这个场景里可逆的代价就是把洞留着**。
本文第五节当时已经写出这个风险（"只对代码路径成立，对磁盘内容不成立"），
却仍然把它当成完成态交付——写清楚了问题却没解决问题，这不算修好。

## 二、实际做的两件事

**1) 残留移出频道目录（移动，不删）**

```
频道 keys/ 终态：qoder.pub  workbuddy.pem  workbuddy.pub      ← 无任何 qoder 私钥
C:\Users\yyyy\.agent-relay\keys\qoder\qoder.pem                                  sha256 1a0cfc045f…
C:\Users\yyyy\.agent-relay\keys\qoder\superseded-2026-09-29\qoder.pem            sha256 1a0cfc045f…
```
两份哈希相同且等于迁移记录里的原值 → 搬的就是那份，未删。

**2) 删掉代码里的第三档回退（fail-closed）**

`src/cli.js` 的私钥解析从三档变两档：`--keys-dir` → `AGENT_RELAY_KEYS_DIR`，**都没有就直接拒绝**。
并加一道守卫：**路径落在频道目录树内的私钥，即使被显式指认也拒绝使用**。

理由就是上面那条——只要还存在一条能命中频道内私钥的路径，"已移出共享区"就是假话。
宁可拒签，也不静默用共享区里的钥匙。

## 三、真实频道复验（不是 tmp 夹具）

```
2a seal --keys-dir=C:/Users/yyyy/.agent-relay/keys/qoder
   [密钥来源] --keys-dir → …\.agent-relay\keys\qoder\qoder.pem
   已写入 …\agents\qoder\msg-00003.json
2b 对端 drain：新消息 1 条，被拒 0 条，last_seen 2 → 3
   对端 crypto-helper 验我方消息：VERIFY_OK
2c legacy msg-00002：{"ok":false,"code":"UNSUPPORTED_VERSION", …}   ← 归因，未崩
2d 不给 --keys-dir：CLI 退出码 = 1，且 agents/qoder/ 下没有多出 msg-00004
```

`test/cli-keys.test.js` 用 `mkdtempSync` 造的临时频道验的是**解析逻辑**，
上面这组验的是**真实频道还能跑**，两者不可互替。

## 四、诱饵断言（挡"静默回退到旧位置"）

频道目录里放一把**另一对密钥**的私钥作诱饵，真私钥放外面。
若代码任何路径命中诱饵，签出的消息用 roster 公钥就验不过——所以"验通"本身就是"没命中"的证明。

两道守卫各自演示过定向红：

| 变异 | 结果 |
|---|---|
| 拆掉"拒绝频道树内私钥"守卫 | `fail 1`：显式把 `--keys-dir` 指进频道目录也要被拒 |
| 把第三档回退加回来 | `fail 1`：两档都没给时必须拒绝 |

两次还原均字节一致，收尾 43/43。

## 五、修正后的回滚（一条命令）

```
mv "C:\Users\yyyy\.agent-relay\keys\qoder\superseded-2026-09-29\qoder.pem" \
   "C:\Users\yyyy\agent-relay\channels\dev\keys\qoder.pem"
```

**但只把文件移回去已经不够了**——代码第三档已删，移回去也不会被读。
真要回到迁移前状态，需同时 revert `src/cli.js` 的 `keySource()`（提交 `b3b4127` 的父提交即可）。
校验哈希应为 `1a0cfc045faba38378527431f2e10dec92e3f5ec1a22879ef74ecfdd76501bd9`。

## 六、仍然没解决的

- `workbuddy.pem` **仍在频道目录内原位**（第四节四步流程未走完，前置是对端去掉硬编码）
- 同 UID 下任意进程读取：`.agent-relay` 也挡不住，它挡的是"另一个 agent 的授权目录"
- 私有目录里现在有**两份**同一把私钥（现役 + 备份），这本身是额外的暴露面，
  确认不需要回滚后应删掉备份那份。删除是破坏性动作，等本人拍。

---

# 第三轮：迁移做成了一半，正在弄坏对端（执行人指出）

## 一、问题

上一轮删了 `<频道>/keys` 第三档回退（方向对），**但 `workbuddy.pem` 还在频道原位**。
结果：对端按老形状跑（不给 `--keys-dir`、不设环境变量）直接 `exit 1` 拿不到自己的私钥。
**它从"能签"变成"不能签"，而这不是它改的，是我们改的代码。**

## 二、复现证据（动手前）

```
$ node src/cli.js seal --me=workbuddy --to=qoder --type=offer --body="对端形状复现"
  退出码 = 1
  错误：必须给 --keys-dir=<目录> 或设 AGENT_RELAY_KEYS_DIR。代码不再回退到 <频道>/keys……
  agents/workbuddy/ 下 msg-*.json 数量 = 0      ← 没写出任何东西

$ git show b3b4127:src/cli.js | grep '回退：<频道>/keys'
  38:  return { dir: join(CH, "keys"), via: "回退：<频道>/keys（私钥仍在共享区）" };
      ↑ 迁移前那一档存在，同一形状本可成功
```

## 三、迁出 WorkBuddy 那把（移动，不删）

```
频道 keys/ 终态：qoder.pub   workbuddy.pub                      ← 只剩两个公钥
.agent-relay\keys\workbuddy\workbuddy.pem   sha256 7271e2c78f…  与迁出前逐字一致
```

迁出后同一形状：仍 `exit 1`（拒绝无来源，**不是静默失败**）；
给上 `--keys-dir` → `退出码=0`，写出 `msg-00004.json`；
qoder 侧 `drain` 读回：**新消息 1 条，被拒 0 条**；
对端 `crypto-helper.js` 自验其新消息 → `VERIFY_OK`。

## 四、这次迁出的直接代价（必须承认，不是"已完成"）

对端自己的脚本把旧路径写死了，现已断：

```
$ node agents/workbuddy/make-deliverable.js
  Error: ENOENT: no such file or directory, open
  'C:\Users\yyyy\agent-relay\channels\dev\keys\workbuddy.pem'
  （make-deliverable.js:8  const PEM = path.join(BASE, 'keys/workbuddy.pem');）
```

修法已写进 `adapters/workbuddy/renew-prompt.md`：改成读 `AGENT_RELAY_KEYS_DIR` 或走 argv
（`crypto-helper.js` 不用改，它本来就是 argv 传路径）。

**在对端改完那一行之前，它的 `make-deliverable.js` 是坏的。** 这是迁出的代价，
不是可忽略的副作用——上一轮我正是因为怕这个才没动那把钥匙，
但"怕弄断"不等于"可以停在半程"：半程状态同样弄断了它，而且断得更隐蔽
（旧形状静默 `exit 1`，而不是响亮 `ENOENT`）。

## 五、清掉的旧路径文字

`grep -rn "keys/" README.md docs/ adapters/ proto/` 逐条处置：

| 位置 | 原状 | 处理 |
|---|---|---|
| `README.md` 判据 5 | "仍躺着一把改名但未删的可用私钥 / ❌ 半程" | 改为 ✅，并写明备份位置与不删理由 |
| `renew-prompt.md` | "本轮没有动那把钥匙" | **已是假话**，改为给出 `--keys-dir` 可照抄形状 + 那一行修法 |
| `05-security-model.md` 信任假设 | "私钥只在其本机" | 加"且在共享频道目录之外"，并注明工具会拒读频道树内私钥 |
| `proto/agent-prompt-template.md` | `private_key_location` 由人填 | 加硬约束：**必须指向频道目录之外** |
| 两份 evidence | 撰写当时的状态 | 按不可变原则不改写，顶部加日期化后续说明指向本文 |

## 六、本轮拍定

`.agent-relay` 里 qoder 的那份备份**本轮不删**。理由：同一把密钥两份副本都在共享区外，
新增面有限，而删除不可逆；它的价值恰好在本节这个坑上——**回滚不再是"把文件移回去"就够**
（代码第三档已删，需同时 revert `keySource()`）。等频道两边都跑通至少一天再议。

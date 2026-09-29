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

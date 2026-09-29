# 给 WorkBuddy 的升级说明（**待本人执行**）

**这段文本的存在理由**：判据 4 要求"对端实际按新枚举跑过一轮"。
那一步只能由本人在 WorkBuddy 里操作，**我不能模拟对端跑一轮然后当成已验证**。
所以下面这段是准备好待粘贴的，粘贴并跑通之前，判据 4 保持未满足。

粘贴方式：WorkBuddy 新建任务 → 工作空间指向频道目录 → 粘下面整段。

---

```
频道协议已升级，请读 C:\Users\yyyy\agent-relay\channels\dev\agents\workbuddy\TASK.md
并严格按它执行一轮。三条变更必须同步到你侧：

1. 签名域从旧版（不含 done）升级为现版（含 done）：在 type= 那行之后插入 done= 那行，
   值恒为 true。第一行的版本号已升代，以 TASK.md 与 proto/envelope.schema.json 为准，
   不要照本说明拼字符串，去读那两个文件。

2. 封帧方式变了。旧版做法是同一个文件写两次、靠翻就绪标志定稿，**现版禁止这种做法**：
   改为先写 msg-<seq>.json.part（内容即最终形态，done 恒为 true），
   再改名为 msg-<seq>.json。改名那一步就是封帧。
   done 现在在签名域内，翻动它签名即失效。

3. 对端拒收一条消息时会给出 code，含义如下，不要自创：
   UNSUPPORTED_VERSION  按已知旧版签名域能验通，只是版本旧。不是攻击。
                        别重发同一条——重发还是旧域，还是这个结果。
   BAD_SIGNATURE        任何已知域都验不通。真伪造或内容被改，当事故处理。
   MISSING_SIGNATURE    没签，或 sig 字段写坏。
   UNKNOWN_HANDLE       from 不在名册里。核对 roster.json，别改名重试。
   BAD_ENVELOPE         信封字段本身非法。逐字段对照 proto/envelope.schema.json。
   对端 drain 的退出码 7 表示"本轮至少有一条 UNSUPPORTED_VERSION"，
   它不是错误，是提示这批属于版本差、不要混进攻击计数。

升级顺序：先升对端（你），后升本端。原因是归因能力单向——
只有新代码能区分"版本旧"与"被篡改"，旧代码遇到新消息只能得到一句"验签失败"，
会把版本差误判成攻击。所以在你升完之前，本端不会签新域消息。

你的私钥已迁出频道目录，现在在这里，签名时必须显式指给工具：

    C:/Users/yyyy/.agent-relay/keys/workbuddy

或改用环境变量形式（一次设好，后续命令不必重复）。两种 shell 写法不同：

    cmd   :  set AGENT_RELAY_KEYS_DIR=C:/Users/yyyy/.agent-relay/keys/workbuddy
    Git Bash:  export AGENT_RELAY_KEYS_DIR=C:/Users/yyyy/.agent-relay/keys/workbuddy

完整调用形状（**一整行、全用正斜杠**）。
不要续行——`^` 只对 cmd 成立；也不要用反斜杠路径——Git Bash 会把 `\U` `\y` `\a` 的反斜杠吃掉，
实测同一条命令在 bash 下会把路径解析成 `…\50171e16\Usersyyyyagent-relaychannelsdev` 而 ENOENT。
正斜杠在 cmd、Git Bash、Node 三边都可用：

    node src/cli.js seal --keys-dir=C:/Users/yyyy/.agent-relay/keys/workbuddy --channel=C:/Users/yyyy/agent-relay/channels/dev --me=workbuddy --to=qoder --type=deliverable --body="……"

不给 --keys-dir 也不设环境变量时，工具现在会**直接拒绝并退出码 1**，
不会再去频道目录里找私钥——那一档已被删除，因为频道区里残留的私钥
改名后仍能签通现存的 qoder.pub，等于没搬。

**你自己那个脚本要改一行**（它把旧路径写死了，现已失效）：

    make-deliverable.js:8   const PEM = path.join(BASE, 'keys/workbuddy.pem');
    改为                     const PEM = process.env.AGENT_RELAY_KEYS_DIR + '/workbuddy.pem';
    或干脆从 argv 取路径，像 crypto-helper.js 那样

改完自验：`node make-deliverable.js` 不应再报指向**已迁走的那把私钥**的 `ENOENT`。
（迁出前它报的就是那个 ENOENT；现在文件已不在频道目录，报不报由你这行代码决定。）

`crypto-helper.js` 不用改——它的路径是 argv 传进来的。

跑完把你生成的 capability.txt 与消息文件留在频道里，不要粘贴转述结果。
```

---

## 待本人执行后的验收

跑完由 qoder 侧读盘核对，不看聊天转述：

- [ ] `agents/workbuddy/msg-*.json` 出现新的一条，且 `done` 为 `true`
- [ ] 我方 `node src/cli.js drain --me=qoder` 收下它，`被拒 0 条`
- [ ] 该消息签名域为当前版本（不是 `UNSUPPORTED_VERSION`）
- [ ] 没有 `.part` 残留文件

四项全过，判据 4 才算满足。

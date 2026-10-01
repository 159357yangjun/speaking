# 工作树被整份清零 + 行尾被 smudge 换掉：一次环境事故的实录

日期：2026-10-01（本机时间，`date` 当场取，不用 epoch 反推）
仓库：`C:/Users/yyyy/Documents/Qoder/2026-09-28/50171e16` @ `8a6aba4`
结论先给：**两个独立的损坏，各瞎一侧尺子**。① 未刷盘数据在脏重启后变成"元数据完好、内容全 NUL"，
这一类 `git status` 看不见；② 恢复动作把 5 个文件的行尾换成 CRLF，这一类内容哈希看不见，
红的却是三条吃 LF 的源码扫描断言。

---

## 一、时间线（每条都能指到一次命令的输出）

| 时刻 | 事件 | 出处 |
|---|---|---|
| 02:14:54 | 提交 `8a6aba4`（`.git/COMMIT_EDITMSG` mtime） | `ls -la --time-style=full-iso .git/` |
| 02:11:23 | `README.md` 最后一次被 git 写入时盖的 mtime（索引里也是这个数） | `git ls-files --debug README.md` 与 `stat` 同时给 |
| 02:4x–02:5x | 发现 53 个跟踪文件全部读回 100% NUL（上一轮工作里） | 本轮开始前的扫描，见下"证据 A" |
| **02:50:24** | **机器脏重启**：`LastBootUpTime = 2026-10-01 02:50:24` | `(Get-CimInstance Win32_OperatingSystem).LastBootUpTime` |
| 02:50:26 | Event ID **41** Kernel-Power（关键级）＝ 电源被硬切 | `Get-WinEvent -LogName System` |
| 02:50:39 | Event ID **6008** EventLog（错误级）＝ 上一次关机是非预期的 | 同上 |
| 02:55:57 / 02:57:25 | `git checkout HEAD -- .` 重新物化：`lock.js` 与 `docs-drift.test.js`/`sim.js` 拿到新 mtime | `stat` |
| 03:02:31 | 逐文件对账：只有 `README.md` 仍是全 NUL，其余 52 个已恢复 | 证据 B |
| 03:06 | `touch README.md && git checkout HEAD -- README.md` 才把它救回来 | 证据 C |
| 03:07+ | 发现 5 个文件变成 CRLF ⇒ 三条断言红；把它们换回 LF ⇒ 三条绿 | 证据 D、E |

硬件侧排除了"盘坏"：`Get-PhysicalDisk` = `CT1000P3PSSD8 / Healthy / OK`，`Get-Volume` C = `Healthy`，
`df` = C: 279G/300G 用（94%）、21G 可用 ⇒ 不是 ENOSPC，也没有卷级错误事件。
盘上路径 `C:\Users\yyyy\Documents\Qoder\2026-09-28\<仓>` 的六个祖先都不是 reparse point，
`C:\Users\yyyy\OneDrive` 存在但**不是本仓祖先** ⇒ 这条不支持"云盘脱水占位符"的解释（那是另一种形状：小文件 + reparse）。

## 二、证据 A/B：清零的读数形状

```
# 逐文件：盘上字节数 vs HEAD blob 字节数 vs NUL 计数
NULFILE README.md size=65644 nul=65644          # 100% 是 NUL
SIZEDIFF src/claims/lock.js head=43489 work=44209 nul=0
SIZEDIFF test/docs-drift.test.js head=77584 work=78572 nul=0
SIZEDIFF tools/claims/gate-census.mjs head=6488 work=6596 nul=0
SIZEDIFF tools/relay-sim/sim.js head=24772 work=25192 nul=0
```

那四个 `SIZEDIFF` 起初被我读成"文件被人改了"——**这条读数错了，我撤回**：差值恰好等于文件里的行数
（`lock.js` 44209−43489=720，而 `CR=720 LF=720`；`sim.js` 25192−24772=420，`CR=420`），
是行尾而不是内容。真源核对：`git config --show-origin --get-all core.autocrlf` →
`file:D:/Git/Git/etc/gitconfig true` + `file:C:/Users/yyyy/.gitconfig true`；`git ls-files -v` 无
`assume-unchanged`/`skip-worktree`；无 `.gitattributes`；HEAD 里每个 blob 的 CR 计数都是 0。

## 三、证据 C：`git status` 与 `git checkout` 都看不见"元数据完好的清零"

```
$ git status --porcelain
（空）                      # 而 README.md 此刻是 65644 个 NUL 字节

$ git hash-object README.md
e52f8ed01124d9b76cd728e32fe1066b020ba87b
$ git rev-parse HEAD:README.md
466f8333228661c10c4fa4544ed3259f4b3d357a     # 两者不同，status 却报干净

$ git checkout HEAD -- README.md              # 静默空操作
post-restore bytes=65644 nul=65644            # 没救回来
$ touch README.md && git checkout HEAD -- README.md
attempt2 bytes=65644 nul=0 hash=466f8333…     # 强制让 stat 失配才真的重写
```

机制：`git status` 先比 stat（大小+mtime），命中就不重算哈希。索引里 `README.md` 记的正是
`size: 65644 / mtime 1790835083`（= 02:11:23），与清零后那位的 stat 完全一致 ⇒ 跳过哈希 ⇒ 报干净；
`git checkout HEAD -- <path>` 也信同一份 stat，于是恢复动作**跳过了这个文件**——这就是上一轮
"我把整树恢复了"之后它仍然是坏的、而套件仍红 18 条的原因。
被清零那份的 sha256：`3b5e17a2d4d09e7f3a7e9c2ca741e83bfdd8c7abb2b2b8acd95bed93a115f867`（全 NUL，覆盖前记下）。

所以**"内容对账"不能拿 `git status` 当证人**，只能逐文件 `git hash-object` 对 `git rev-parse HEAD:<file>`：
本轮 53/53 一致（修复后），命令就在 `docs/evidence/2026-10-01-mc1a-red-baseline.txt` 同批工作里，
形状是：

```
git ls-files -z | while IFS= read -r -d '' f; do
  [ "$(git rev-parse "HEAD:$f")" = "$(git hash-object "$f")" ] || echo "DIFF $f"
done
```

## 四、证据 D/E：行尾这一侧反过来——哈希看不出，测试却红

`git checkout` 的 smudge（`core.autocrlf=true`）把重新物化的 5 个文件写成 CRLF。
后果：**`git hash-object` 仍等于 HEAD blob**（clean 过滤把 CRLF 折回 LF），
而三条吃 `\n}\n` 的源码扫描断言一起红：

```
✖ 续期不碰基锁字节：只追加标记，复查后才知道自己还赢不赢
✖ 锁序不变式：全仓不存在「持板锁时再取文件锁」的形状（AB-BA）   ← AssertionError: 找不到 writeBoard，锁序不变式失去对象
✖ 写板 CAS 在代码里真的是'先复验后落盘'，而且复验跑两次        ← AssertionError: 找不到 writeBoard
```

判别式实验（先红后绿，同一原因）：把这 5 个文件的行尾换回 LF（只删行尾 CR，字节数逐一对上
`git cat-file -s HEAD:<file>`：65644→65050、44209→43489、78572→77584、6596→6488、25192→24772），
三条立刻绿：

```
$ node --test --test-name-pattern='锁序不变式|写板 CAS 在代码里|续期不碰基锁字节' test/claims.test.js test/docs-drift.test.js
EXIT=0   ℹ tests 3  ℹ pass 3  ℹ fail 0
```

**这一条我一度写错过方向**，写在门禁消息里的原话是"git status 仍然干净"——注入实验把它推翻了：
把 `tools/claims/gate-census.mjs` 换成 CRLF 后 `git status` 确实把 5 个文件列成 ` M`
（autocrlf 认为 CRLF 才是规范形态，我改回 LF 反而被标"待转换"）。准确的说法是：
**看不见行尾损坏的是内容哈希对账（`hash-object`/`git diff`），`git status` 在清零那一侧才是瞎的。**
已按实测改回。

新门禁 `跟踪文件在盘上必须是 LF：三条源码扫描断言的前提不许靠运气`（`test/docs-drift.test.js`）两面原文见
`docs/evidence/2026-10-01-lineend-gate-twosided.txt`：面 1 = 盘上 LF ⇒ 绿（`分母=跟踪文件 53｜LF 53｜CRLF 0`）；
面 2 = 注入一个 CRLF ⇒ 红（`LF 52｜CRLF 1` + `1/53 个跟踪文件在盘上不是 LF：tools/claims/gate-census.mjs`）。

## 五、这次事故里丢掉的、以及没丢的

- 没丢：`8a6aba4` 的对象库完好（`git fsck` 干净），所有交付物都在版本库里；本轮重放的只有**未提交**那段。
- 丢了（未提交、须重放）：MC-1-A 的寿命谓词增量 —— `sim.js` 每轮清点 `.lock.arbiter-*` 并交原始
  `at/ttl/liveMs`；`gate-census.mjs` 单点判据 + `事件=双主+静默` 恒等式 + 抓到退 1；
  配套的门禁字段表与 README 行。重放后的 50 轮基线见 `docs/evidence/2026-10-01-mc1a-red-baseline.txt`。
- 顺带修正的形状（原来只在注释里、没在代码里）：`gate-census` 的汇总行 `code` 曾写决策码、
  进程却可能退 9 ⇒ `s.code === r.status` 这类核对会被真缺陷那次撞红。现在 `code` 就是真实退码。

## 六、仍未验证 / 没结论的

1. **第一次"53 个文件全清零"发生在脏重启之前还是之后**，我没能定死：它的观测时间在我这边是 02:4x–02:5x，
   而 boot 是 02:50:24。若观测在 boot 前，则写缓存丢失不是唯一解释，还得找另一个来源（AV/另一个进程）。
   现在只能说"02:50 的硬切与两类损坏同批出现"，不能说"硬切是唯一原因"。
2. 同一时刻**别的会话有没有在这个仓里动手**：`git worktree list` 只有本仓一个；`.git` 目录 mtime 02:43:35、
   `index` 03:01:55（是我自己跑 `git status` 刷的）。没有别人的痕迹，也没有排除它的证据 ⇒ 记"未判定"。
3. `strayUnreadable`（残留读不出 `at/ttl`）与 `silent`（只有 MC-1-A、板面正常）两格本轮**各 0 个证人**：
   只说明 50 轮里没被抓到，不说明结构上不可能。前者要等 MC-1-A 的令牌实现那一面来证（主控前提②）。
4. `git checkout` 之后 `git status` 把 5 个 LF 文件列成 ` M`：这条**没有门禁**，只是实测现象。
   要不要加 `.gitattributes`（`* text=auto eol=lf`）从根上关掉 ②，等主控批；本轮不自加。

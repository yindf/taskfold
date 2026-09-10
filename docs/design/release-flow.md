# taskfold 发布流程（release.mjs）

状态：待复评（v2，已并入首轮评审 B1–B3 / M1–M6 / m1–m5）
日期：2025-06

## 背景与目标

0.2.3 之前的历次发版只改 `CHANGELOG.md`、漏改 `package.json` 的 `version`，宿主一直显示 0.1.0。目标：仓库内脚本 `cmpct/scripts/release.mjs` 固化"生成 CHANGELOG 草稿 → 定版 → 同步 package.json → 提交 → 打 tag → 推送"，消除手工同步点。

已确认决策（用户拍板）：CHANGELOG.md 顶部条目是版本号唯一事实源（`package.json` 只由脚本同步）；CHANGELOG 由 git log 生成**草稿**、人工审阅后再发布；终点 = commit + push master + tag `vX.Y.Z` + push tag；**不发 npm**。

## 核心状态模型（B1/B3 的解）

任意时刻的四元组状态：`(CHANGELOG 顶部条目, package.json version, 最新 v* tag, 工作区)`。脚本只接受两类状态、其余一律 fail-fast 并打印四元组对照：

| 状态 | CHANGELOG 顶部 | package.json | 最新 tag | 工作区 |
|---|---|---|---|---|
| **CLEAN**（已发布） | 已定版条目 `vX` | `X` | `vX` | 干净 |
| **DRAFT**（草稿中） | `unreleased draft` 条目 `Y > X` | `X` | `vX` | 仅 CHANGELOG.md 可脏（草稿本身） |
| **PENDING**（半发布，仅 release 续跑） | 已定版 `vY` | `Y` | 本地 `vY`（远端缺 tag 或缺 commit） | 干净 |

- `draft` 只接受 CLEAN；`release` 接受 DRAFT 或 PENDING（PENDING = 幂等续跑，见下）。
- **版本基线三处对齐断言**（draft/release 均执行）：`package.json == CHANGELOG 顶部已定版版本 == 最新 tag`（DRAFT 状态下前两项以 tag/package.json 为准）。仓库尚无 v* tag 时跳过 tag 项（首发布），以 package.json 为基线。
- tag 候选选取：`git tag --list 'v*' --sort=-v:refname` 取最大者，并用 `git merge-base --is-ancestor <tag> HEAD` 校验在祖先链上，不满足则报错（M2）。

## 接口契约

```
node scripts/release.mjs draft [--version X.Y.Z] [--force]
node scripts/release.mjs release
node scripts/release.mjs status   # 只读；不一致时 exit 1
```

两阶段：`draft` 只写 CHANGELOG、不碰 git；`release` 只做发布动作、不改内容语义。

### draft（要求 CLEAN）
- 范围：`git log <tag>..HEAD`（无 tag 则从首 commit；`--tags` 语义已由上面的 tag 候选逻辑取代，不再用 `git describe`——m1）。
- 分组：Conventional Commit 前缀 feat/fix/perf/refactor/test/docs/chore/其他；**排除 `chore(release)` 提交**（m2）；merge commit 标题不可解析 → "其他"。
- 版本推断：`feat` → minor；提交正文含 `^BREAKING CHANGE:`m 或 标题含 `!:` → major；否则 patch（含全 chore——显式选择：patch，文档注明）。`--version` 给定且 ≠ 推断值时打印警告并采用用户值（M4）。
- 在头部插入：`## X.Y.Z — <主题短语> (unreleased draft YYYY-MM-DD)` + 分组列表。
- 已是 DRAFT 时拒绝；`--force` 删除顶部草稿重建（M1）。
- 版本号仅支持 `X.Y.Z`（数字三段）；预发布/build metadata 一律报错（M4）。

### release（要求 DRAFT 或 PENDING）
- 前置：状态属于上表；DRAFT 时脏文件仅允许 CHANGELOG.md；`Y > X`（semver 数值比较）。
- 动作（DRAFT 路径）：
  1. 草稿头替换为 `## Y — <主题短语> (YYYY-MM-DD)`（当天日期）；
  2. 同步 package.json → `Y`；
  3. `git add CHANGELOG.md package.json` → `git commit -m "chore(release): vY"`；
  4. `git tag vY`（轻量）；
  5. **先 push tag，后 push master**（失败窗口最小化：tag 独立可重推）。
- **幂等续跑（B2）**：任一 push 失败后进入 PENDING；重跑 `release` 检测到 PENDING（本地 tag vY 存在、release commit 存在、远端缺其一）时跳过 1–4 直接重试 push。提示文案不猜测失败原因（沙箱/网络/认证），统一给"重跑 release 续传，或手动 `git push origin vY && git push origin HEAD`"（M5）。
- push 前 `git fetch origin` 并断言 `origin/master` 是 HEAD 祖先（防 non-fast-forward 静默覆盖）（M5）。
- 文件级失败（1–4 步）在中止时打印已完成步骤，人工处理；git 子命令非零即中止。

### assets（要求：顶部条目已定版，且本地存在该 tag）
- 目的：README 与插件市场卡片承诺"每个 Release 附带预构建 `dsh-taskfold-<Y>.tgz`"，而实测 v0.31.2–v0.34.0 的 Release 附件数全部为 0（只有 v0.31.1 带 tgz）——发布路径从未上传过附件，承诺早已名不副实。`release` 成功后自动执行本步；`assets` 子命令可单独跑，用于补发历史 Release 或重试失败的上传。
- 动作：`npm pack --pack-destination <tmp>` → 用 `changelogSection` 从 CHANGELOG 抽出 `## Y` 条目作 release notes（末尾附 `Prebuilt plugin bundle attached: <tgz>`）→ `gh release view vY` 判定是否已存在 → 不存在则 `gh release create vY <tgz> --title vY --notes-file <tmp>`，已存在则 `gh release upload vY <tgz> --clobber`（幂等，可反复跑）。
- 失败语义：执行本步时 commit / tag / push 均已持久，**把附件失败当成发版失败是错的**。`release` 路径只打印 warning + 手工补救命令（`manualAssetHint`）；只有显式 `assets` 子命令失败时 exit 1——补附件正是它的全部目的。
- 可移植性（2026-09-10 实测）：Windows 上 npm 是 `.cmd` shim，Node 无 shell 时 spawn 不了（`npm` → ENOENT，`npm.cmd` → EINVAL），故 Windows 改走 `process.execPath` + `<node>/node_modules/npm/bin/npm-cli.js` 直接执行 npm CLI（无 shell、无需参数转义、无 DEP0190 警告），POSIX 仍直接 spawn `npm`。`gh` 先查 PATH，再查 `Program Files\GitHub CLI\gh.exe`（POSIX 为 `/usr/local/bin`、`/opt/homebrew/bin`、`/usr/bin`）——宿主拉起的脚本不一定继承交互 shell 的 PATH。
- 实测（v0.34.0，2026-09-10）：`assets` 首次运行即成功；`gh release view` 显示附件 `dsh-taskfold-0.34.0.tgz` 106,183 B；把该附件下载下来与 committed blob 逐文件比对，18 个文件全部与 tag 内容一致（6 个逐字节相同，12 个仅 CRLF/LF 不同——本机 `core.autocrlf=true`，而 `npm pack` 打的是工作区文件）。**这是修复前的状态：内容正确，但附件不是字节级可复现**。
- 字节级可复现（2026-09-10 修复）：仓库根新增 `.gitattributes`（`* text=auto eol=lf`，二进制类型显式标 `binary`），使 checkout 与 blob 同为 LF。修复后实测：`npm pack` 产物解包后 **18/18 文件与 `HEAD` 的 blob 逐字节相同**（`eolOnly`、`bad`、`missing` 均为空）；提交 `.gitattributes` 本身不改动任何既有 blob（只新增该文件）。
  - 操作要点：仅提交 `.gitattributes` 不够——工作区里已经是 CRLF 的文件必须走 renormalize 流程（`git add --renormalize .` 后 `git rm --cached -r .` + `git reset --hard`，或干脆重新 clone）才会被改写。实测 `git checkout-index -a -f` **不会**改写工作区换行，别指望它。
  - 注意时序：已发布的 v0.34.0 附件早于本修复，**仍非可复现**；下一个 Release 起生效。历史 Release 不回填。
- `gh` 未安装/未登录时自动降级为打印手工配方（`npm pack` + `gh release create ...`），不阻断已完成的发版。

### status
打印四元组 + 所属状态（CLEAN/DRAFT/PENDING/INVALID）+ exit code（非 CLEAN/DRAFT/PENDING → 1）（m4）。

### CHANGELOG 头部 grammar（M3）
- 草稿：`^## (\d+\.\d+\.\d+) — (.+) \(unreleased draft (\d{4}-\d{2}-\d{2})\)$`，破折号匹配 `[-–—]`（宽容手工编辑），生成时固定 em-dash。
- 定版：`^## (\d+\.\d+\.\d+) — (.+) \((\d{4}-\d{2}-\d{2})\)$`，同样宽容破折号。
- 识别失败 → INVALID 状态报错，绝不猜测。

## 模块划分 / 依赖方向
- `cmpct/scripts/release.mjs` 单文件，零第三方依赖（node:child_process + node:fs），不 import 插件代码。
- `cmpct/package.json` 加 `"release": "node scripts/release.mjs"`；scripts/ 不进 files（发布物不含脚本——README 说明该 script 仅源码仓库可用，m3）。
- 依赖方向：脚本 → git/文件系统 only。

## 文件变更清单（实现顺序）
1. `cmpct/scripts/release.mjs`（新建）。
2. `cmpct/package.json`（scripts.release）。
3. `cmpct/test/release.test.mjs`（新建，纯函数测试）。
4. `cmpct/README.md` + `README.zh.md`（Development 节：draft → 审阅/手改 → release；PENDING 续跑说明）。
5. 验证：`status` 实跑；`draft --force` 实跑生成 0.2.4 草稿（本仓库真实 CHANGELOG 上）；`release` 不实际执行，留给下次真实发版。

## 纯函数与测试（M6 清单）
导出：`parseConventional` / `nextVersion` / `renderEntry` / `finalizeDraftHeader` / `parseEntryHeader` / `cmpSemver` / `classifyState`。
测试必须覆盖：
- cmpSemver：0.0.0、不等长数字、非法输入（预发布、`+build`、非数字）报错、相等。
- nextVersion：BREAKING 与 `!:` 并存取 major；全 chore → patch；feat → minor。
- parseConventional：merge commit → 其他；`revert: feat:...` → 其他（不冒充 feat）；`feat(scope)!:`；无前缀。
- parseEntryHeader：em-dash/en-dash/hyphen 均识别；已定版行不被当草稿；畸形行 → null。
- finalizeDraftHeader：正常替换；已被手工改成定版格式 → 报错。
- renderEntry：空组省略；含反引号/换行的 subject 原样保留不转义。
- classifyState：四元组全排列的合法/非法判定（CLEAN/DRAFT/PENDING/INVALID 各至少两例）。

## 二轮复审补充（M1–M3 处置）

- **INVALID 的出口（M1）**：INVALID 不需要脚本恢复路径——它是人工修复状态。status/release 打印四元组对照 + 一句针对性修复指引（例：package.json 落后且顶部已定版 → "手动把 package.json version 改为 X 或回退 CHANGELOG 条目后重跑"）。脚本绝不尝试自动"修复" INVALID（自动写版本正是历史事故的形态）。
- **远端发散（M2）**：push 前检查发现 origin/master 非 HEAD 祖先时，PENDING 处置为：**本地 tag 保留、不删**；指引文案"远端 master 已前进：git pull --rebase 后本地 tag 会随 rebase 移动（轻量 tag 指向 release commit，rebase 会产生新 SHA，此时删本地 tag `git tag -d vY` 并重跑 release 的 DRAFT 路径之外——实际上 CHANGELOG 已定版，正确动作是 `git tag -d vY` + `git reset --hard origin/master` 后重新 draft"）。即：发散场景放弃续跑，明确指引推倒重来，不做自动回滚。
- **远端 tag 探测与离线语义（M3）**：PENDING 判定需要远端信息：`git ls-remote --tags origin vY`（仅 release 时调用，网络失败按"远端未知"处理 → 仍走续跑 push，幂等 push 天然安全）。status 是**纯本地只读**，不联网、不区分远端，PENDING 在 status 里显示为本地视角（"本地 tag vY 存在，远端未知"），文档注明。
- 首发布（无 tag）时 classifyState 的 tag 槽位取 `null`，判据相应放宽（Minor）。
- PENDING 续跑成功后 exit 0；任何 INVALID exit 1（Minor）。

## 明确不处理
npm publish、annotated tag、CHANGELOG 人工纠错（草稿本就要求人工审阅）、monorepo、宿主侧显示逻辑、多远端。
（注意区分：**GitHub Release 及其 tgz 附件**自 0.34.0 起属于流程内（见 `### assets`）；**npm registry publish** 仍然不做。）

## 实操备忘：DSH 沙箱内 push（2026-09-07 实测，用户拍板）

**规矩：下次需要 push 时不要折腾——直接用升级权限跑，不要先在沙箱里试一遍再诊断。**

- 症状：DSH pwsh 沙箱内 `git push`（HTTPS）在凭据环节崩溃——git 拉起 msys `sh.exe` 做凭据提示，沙箱里建不了信号管道（`couldn't create signal pipe, Win32 error 5`），随后回退报 `could not read Username for 'https://github.com'`。`release` 脚本内置 push 因此落入 PENDING（幂等续跑，commit+tag 已持久）。
- 正确动作：对**同一条** push 命令直接带 `sandbox_permissions: danger-full-access` 重跑（凭据管理器需要真实运行环境），一次成功。v0.24.1 实测：tag + master 一次推齐。
- 同类：`dsh plugin --profile web update`（写 `~/.dsh/profiles`，工作区之外）同样需要升级权限，属预期，不是故障。

## README「支持的 dsh 版本」一节写法（用户拍板，2026-09-09）

- **alpha 一条线、rc 一条线**：每条线只写该通道**实测可用的最新版本**（形如「alpha 通道 —— 支持到 `0.1.5-alpha.1`」），并附该版本的验证记录。
- **历史 alpha / rc 版本一律不写**：某通道出现更新版本后，旧版本条目直接删掉；不做「此前已验证」「最低兼容」这类历史清单。上限之外是否兼容，统一由「上界：未测试、未强制」那条说明。
- 两份 README（`cmpct/README.md` / `cmpct/README.zh.md`）必须同步；`release.mjs draft` 会打印这条规矩作为提醒。

## 折叠缓存校验进入流程（用户拍板，2026-09-09）

背景：dsh `0.1.5-alpha.1` 把 `buildSummarizationInput()` 的 system 从独立字段搬进 `messages[0]`，与 taskfold 的前缀信封撞车，导致每次折叠的摘要调用在 span 起点失去前缀缓存（v0.29.2 前 8 次折叠共重复计费 201,196 token）。离线套件当时无法发现——它只验证折叠成功与否，不验证成本。

- **新增 `cmpct/scripts/verify-cache.mjs`**（`npm run verify:cache`）：解码一份 live 会话日志（多帧 zstd），对每个 `compaction/summary` 计算 `tail = uncached − shadowedTokenCount`。判据是 **tail 的符号**：回归时 span 被重付，`tail ≥ 指令 + system 头`（实测 +3,974 ~ +18,587）；健康时 span 全命中，`tail` 为负（实测 −4,806 / −5,445 / −14,141）。阈值 `--tail-budget`（默认 3500）、`--min-span`（默认 0，可选噪声护栏，太小的 span 判为 skip）。`--since-restart` 只判最新一次 `reason=resume` 之后的折叠——dsh 升级后的正确口径。回归时 exit 1。
  - **判据是被实测校准过的**：最初用绝对阈值（`uncached ≤ 3500`），在 fold 1303 上误报——该次 `uncached` 5,655 但 `span` 19,796（tail −14,141，span 其实全部命中，多出的几千 token 来自嵌套折叠对 span 中段的改写）。改为看 tail 符号后，同一日志 `--since-restart` 3/3 通过，而历史 11 次坏折叠仍全部判 fail。
- **流程位置**：每次 dsh 升级后必跑一次 `--since-restart`；触及折叠信封的发版在 CHANGELOG 条目里记录实测数字。`release.mjs draft` 会打印该提醒。离线 `npm test` 覆盖脚本的纯函数（解码、用量提取、分类、restart 切分），共 14 项。
- **为什么不能只靠离线测试**：`cacheReadTokens` 只存在于真实 provider 的 usage 里；离线能钉住的是「折叠请求是主对话的严格前缀、且只有一个 system 消息」这一结构前提（`test/fold-engine.test.mjs`），真实命中率必须由 live 日志给出。

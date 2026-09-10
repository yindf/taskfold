# 设计：turn-end 自动折叠 + 指令内索引 + 归档预览瘦身

> 状态：已完成（2026-09-07 实现收尾；余一项 live 验证待宿主重启，见 §11）
> 创建：2025-11-27  更新：2025-11-27（修订 2）

## 1. 目标与范围

- **特性 1（折叠时点）**：把 pendingArchives 的 drain 增挂到宿主 `agent/turn-stopping` 钩子，使顶层任务的折叠在回合结束、缓存最热时执行，消灭实测的跨闲置期前缀缓存全 miss（fold 1: 173K fresh / fold 7: 107K fresh）。
- **特性 2（行号供给 + 预览瘦身）**：折叠指令尾部附逐消息编号目录（"目录在指令里"，三臂受控实验验证引用 100% 准确、机制为"照抄可见编号"），摘要节点内嵌的 Fold archive 全量预览瘦身为"计数 + 角色直方图 + tail 窗口（真实行号）"，降低每个后续请求的常驻 token（实测预览占摘要节点 64%，`[think]` 占预览字符 49%）。
- 两个特性相互独立，可分别合入（相位化措辞为特性 2 内可独立回滚的搭车项，见 §8）。

**不在本次范围内**：
- 摘要节结构不变（仍是五节，标题不动）；不引入节标题语言强制（用户已裁定"不用管"）。
- 不做 `L<N>` 越界的引擎侧校验（源码行号与消息行号同形，校验会误伤；列为开放问题）。
- 不做清单信封（路径 manifest）——已被"缓存总是热的"论证降级为备胎。
- 不改 `fold_recall`/`list_folds` 行为（含"全量模式总是重写工件"的既有瑕疵）。
- 不动 DETAILED_CHECKPOINT_INSTRUCTION、预算公式、CJK 启发式。
- 不做 per-session drain 守卫（记录为后续项，见 §8 M3 处置）。

## 2. 模块划分

| 模块 | 一句话职责 | 关键类型 | 允许依赖（现状全部保留） |
|---|---|---|---|
| `plugins/span-preview.mjs` | 预览/工件渲染纯函数：`renderSpanPreview` 不变（全量 1:1 索引、指令目录唯一来源）；`renderArchivePreview` 改名 `renderArchiveFooter` 并瘦身为常驻尾注 | `ARCHIVE_HEAD_LINES`、`ARCHIVE_TAIL_LINES` | node 内建 |
| `plugins/fold-instruction.mjs` | 指令文本纯函数：新增引用纪律规则、What happened 相位化措辞（与 Budget 子句同步改写）、新增纯装配器 `assembleFoldInstruction` | `FOLD_SUMMARY_CORE`、`assembleFoldInstruction` | 无 |
| `plugins/fold-engine.mjs` | 信封装配调用方：改调 `assembleFoldInstruction`；摘要节点 footer 换 `renderArchiveFooter` 新格式 | `ScopedEngine.summarize` | span-preview、fold-instruction、events |
| `plugins/compact-region.mjs` | 挂点与模型可读文本：turn-stopping 注册；task_end 描述与系统提示段的预览承诺同步改尾注语义 | `apply(ctx)` | fold-drain、fold-engine、task-marks、events、fold-instruction（DETAILED_CHECKPOINT）、lifecycle-nudges |
| `plugins/fold-drain.mjs` | drain 核心：守卫标志改名 `drainRunning`（自此覆盖两挂点，旧名误导），行为零变化 | `processDeferredArchives` | task-marks、events |
| `plugins/compact-stats.mjs` | 观测面（list_folds/fold_recall）——**已核实不受影响**：L316 复用的 `renderSpanPreview` 不变；省略行的"full index 再生"指引由其现有全量模式承接 | — | span-preview（不变） |

依赖方向单向无环；`assembleFoldInstruction` 落在 fold-instruction（文本层）使"规则 + 目录装配"同模块落地，消除分步实现的语义窗口（见 §7）。

## 3. 公共接口契约（先签名，后实现）

```js
// span-preview.mjs
export const ARCHIVE_HEAD_LINES = 3
export const ARCHIVE_TAIL_LINES = 8
// 导出理由：仅供测试钉住窗口大小，非公共配置面。
// 返回（新契约，替换原 renderArchivePreview；批准修订：直方图头行 → 前 3 行真实预览行）：
//  L = renderSpanPreview(messages) 的输出行数组；N = L.length
//  N === 0 → ['Span preview: (empty)']
//  N <= HEAD+TAIL → 直接返回 L（窗口并集即全集，无省略行）
//  否则 → L[0..HEAD) + '… lines (HEAD+1)-(N-TAIL) omitted — fold_recall({ fold })
//          re-renders the full index' + L[N-TAIL..N)
//  头部与尾部均直接切片 renderSpanPreview 输出（结构性复用：单一行渲染来源，
//  免第二个 messagePreviewLine 循环，防漂移）。
// 防御守卫（新语义）：输出已有界（≤ HEAD+TAIL+1 行），0.6 守卫仅在"近空退化
//  span 的 footer 体量可与 span 本身相当"时触发 → 退化为工件指引行；该悬崖
//  位移为既有行为模式的延续，非回归。
export function renderArchiveFooter(messages) // -> string[]
```

```js
// fold-instruction.mjs
// FOLD_SUMMARY_CORE 变更（三处引用规则 + 两处措辞，同一编辑落地）：
//  '## What happened' 描述行：'…ordered phases; consecutive steps MAY cluster
//    into one phase bullet carrying L<N>-<M> copied from the span message index'
//  Budget 规则 What happened 子句同步改写（消除"允许聚类 vs 禁止聚类"自相矛盾）：
//    'every meaningful step is covered by at least one bullet; consecutive steps
//    may cluster into one phase bullet with L<N>-<M> (compress phrasing, not facts)'
//  新增 Rules：
//   1. Citations：指令末尾的 Span message index 编号每条 span 消息，line N =
//      第 N 条消息 = fold_recall({ fold, line: N }) 所返回；编号必须照抄目录，
//      禁止自行数消息。
//   2. Source-file：源码引用必须带文件名与工具结果中可见的行号；禁止凭记忆估计。
//   3. No-evidence：目录锚点与工具结果均无法定位时，引用逐字内容片段代替行号。
//   4. Mirror 禁令：the span message index is navigation input only — never
//      reproduce it (or any part of it) in your output。
export function buildFoldInstruction(opts) // 签名不变

// 新增纯装配器（离线可测；引擎不再内联拼字符串）：
// parts.indexLines 为 renderSpanPreview(input.messages) 的输出行数组。
// 组装顺序契约：buildFoldInstruction(opts) + budgetLine + closing
//   + '\n\nSpan message index (line N = the N-th span message = artifact line N):\n\n```\n'
//   + indexLines.join('\n') + '\n```'
// 目录引导行为普通文本（非 '## ' 标题）：指令明列五节结构，尾部出现第六个 H2
// 会诱导模型把目录复述进摘要，而结构收据只查首行拦不住（评审 M3）；fenced 块
// + 非 H2 引导行 + Mirror 禁令三重防护。
export function assembleFoldInstruction(parts) // -> string
```

```js
// fold-engine.mjs summarize() 装配（改为调用装配器）：
// 最终 user 指令消息文本 = assembleFoldInstruction({
//   opts: { prefix: prefixMessages.length > 0, name: closingName },
//   budgetLine, closing, indexLines: renderSpanPreview(input.messages) })
// 摘要节点 Fold archive 节 =
//   '\n\n## Fold archive\n\n- fold #N · M messages · originals JSONL (one message per line): <path>\n\n```\n'
//   + renderArchiveFooter(input.messages).join('\n') + '\n```'
// 注：新 bullet 有意省略旧文案中的 span 范围描述（just after "Task begun" …），
// 该语义已由系统提示段承载，不在摘要节点重复计费；消息数 M 并入 bullet（批准
// 修订：直方图取消后唯一的覆盖性计数）。
```

```js
// compact-region.mjs apply() —— 特性 1 契约：
// 注册语句整体入 try/catch（与既有 pre-step 挂点 L130-153 同构）——老宿主无此
// 钩子时 ctx.on 抛错必须被吞掉，否则 apply() 中断、task_begin/task_end 全失：
try {
   ctx.on('agent/turn-stopping', async (payload) => {
     try {
       const agent = payload?.agent
       if (agent !== undefined) await drain.processDeferredArchives(agent, payload?.signal)
     } catch (err) { /* 留给 pre-step 兜底 */ }
   })
 } catch (err) { /* 钩子不可用：行为退回现状（pre-step 兜底） */ }
// 既有 agent/pre-step 挂点原样保留（waterfall 契约不变）。

// compact-region.mjs —— 特性 2 的模型可读文本同步（消除虚假承诺）：
//  task_end 描述（L210）与系统提示段（L285）中
//  "a complete span preview … one line per message, no elision" 改写为
//  尾注语义（"a compact archive footer (counts + tail of the span preview with
//  true line numbers); fold_recall({ fold }) re-renders the full index"）。
```

## 4. 数据流 / 调用链

**特性 1**：回合最后一步 commit → 宿主 loop 判定 `turnEnds && inbox.nextStep 空` → 触发 `agent/turn-stopping`（serial，`throwIfAborted` 保证入口 signal 必活）→ drain 检查 pendingArchives → 交付门控放行的条目立即折叠（drain 的 `for(;;)` 逐条串行处理全部放行条目）→ 此刻距最后一次主请求仅数秒，折叠信封前缀全热。被中止/出错的回合到不了该 dispatch → 下回合 pre-step 照旧兜底。
**并发归因（评审修正）**：同会话内 pre-step 与 turn-stopping 的并发被宿主循环结构性排除（两者在同一 while 循环中顺序 await，dsh-agent-loop L539/L570）——`drainRunning` 同步 check-then-set 守卫的真正职责是**跨会话**防重入（子代理会话与主会话共享进程与 drain 实例）。

**特性 2**：drain 调 `ScopedEngine.summarize` → 信封 = [system+tools] + [前缀] + [span 原文，一字不动] + [指令（尾部 fenced 目录，位于 closing 之后——近因效应）] → 缓存分歧点仍在指令处（span 未改写）→ 摘要产出含照抄目录的 `L<N>` 引用 → 引擎在 commit 前写工件、以 `renderArchiveFooter` 生成尾注式 Fold archive 节 → 常驻成本从"全量逐行"降为"前 3 行 + 省略行 + tail 8 行"。

## 5. 依赖与配置变更

- 无新增 npm 依赖、无新增宿主服务注入（turn-stopping 经 `ctx.on` 注册，与 pre-step 同 API 面；宿主已核实存在，老宿主优雅降级）。
- 无配置项：`ARCHIVE_TAIL_LINES = 8` 为导出常量（仅供测试钉住，非配置面）。

## 6. 文件变更清单

| 文件 | 操作 | 所属模块 |
|---|---|---|
| `cmpct/plugins/span-preview.mjs` | 修改：`renderArchivePreview`→`renderArchiveFooter` 瘦身（头 3 + 省略 + tail 8，均切片复用 renderSpanPreview）；导出 `ARCHIVE_HEAD_LINES`/`ARCHIVE_TAIL_LINES`；**改写文件头 CONTRACT 注释**（区分两契约：renderSpanPreview=全量 1:1 索引、指令目录唯一来源；renderArchiveFooter=常驻尾注、真实行号、非 1:1；防漂移保证=同一 renderSpanPreview 行输出切片，非整渲染复用）；同步改写函数级注释 | span-preview |
| `cmpct/plugins/fold-instruction.mjs` | 修改：三条引用规则 + Mirror 禁令；What happened 描述行与 Budget 子句同步改写；新增 `assembleFoldInstruction` | fold-instruction |
| `cmpct/plugins/fold-engine.mjs` | 修改：改调 `assembleFoldInstruction`；footer 换 `renderArchiveFooter` 新格式；**同步改写 L230-236 注释**（防漂移保证降级表述） | fold-engine |
| `cmpct/plugins/compact-region.mjs` | 修改：① turn-stopping 注册（整体 try/catch）；② task_end 描述 L210 改尾注语义；③ 系统提示段 L285 改尾注语义 | compact-region |
| `cmpct/plugins/fold-drain.mjs` | 修改：`preStepRunning` → `drainRunning`（纯改名 + 注释更新） | fold-drain |
| `cmpct/test/span-preview.test.mjs` | 修改：renderArchiveFooter 新契约锚点（头 3/tail 8 窗口、省略行区间、真实行号、N≤11 全量无省略行）；退化夹具更换（80 空消息不再触发守卫 → 改 tiny-span 近空夹具） | 测试 |
| `cmpct/test/fold-instruction.test.mjs` | 新建：钉五节结构清单（防第六节镜像）、三条引用规则 + Mirror 禁令在场、What happened 与 Budget 子句一致、`assembleFoldInstruction` 组装顺序（index 在 closing 后、fenced、引导行非 H2）、task_end 描述/系统提示段不含 "no elision"（防回归） | 测试 |
| `cmpct/docs/scoped-summary-acceptance.md` | 修改：L49 预览承诺同步为尾注语义 | 文档 |
| `cmpct/CHANGELOG.md` | 修改：新增 draft 条目（release.mjs 状态机要求） | 文档 |
| `cmpct/README.md` / `README.zh.md` | 修改：Supported dsh versions 矩阵补一句"turn-stopping 为可选钩子，老宿主优雅降级到 pre-step" | 文档 |

## 7. 实现顺序

1. **span-preview**：`renderArchiveFooter` + `roleLabel` + 注释契约改写 + 测试更新（独立可验证：`node test/span-preview.test.mjs`）。
2. **指令层与信封装配同提交**（fold-instruction.mjs + fold-engine.mjs + fold-instruction.test.mjs）：引用规则、装配器、footer 新格式必须原子落地——规则先于目录存在会产生"模型编行号"的活体窗口（评审 M1），目录先于规则无害但装配器与规则同模块后无此需要。依赖步骤 1 的 `renderArchiveFooter`。
3. **compact-region + fold-drain**：turn-stopping 挂点 + 模型可读文本同步 + 改名（独立；全测试链回归）。
4. **文档与收尾**：scoped-summary-acceptance / CHANGELOG / README 矩阵。
5. **e2e 验证**：新会话跑 task_begin/task_end 循环，dump `compaction/summary` 事件，断言：指令含非 H2 的 "Span message index" 引导行 + fenced 目录；摘要仍为五节（无第六节镜像）；Fold archive 节为尾注式（直方图 + 省略行 + tail 真实行号）；引用 `L<N>` 与工件行对齐；turn-stopping 折叠发生且缓存命中（usage 的 cacheRead 占比）。

每步完成后全部测试绿。步骤 2 内三条规则与措辞捆绑（e2e 漂移无法二分——已认可：离线测试分别钉住各规则，接受残余风险）。

## 8. 风险与开放问题

- **turn-stopping 排干时长（评审 M2 修正）**：120s 是**单次 foldRegion** 的 guardedSignal 上限；drain 串行处理全部放行条目，嵌套收尾 K 条的现实上界 = 120s×K。期间 turn/end 事件尚未落盘（loop 在 dispatch.serial await 之后才 append，L570→L597）、agent 全程显示 running、兄弟 turn-stopping 监听器被串行阻塞。总 wall-clock 仍不劣于现状（同一等待今天发生在用户消息之后）。
- **折叠期间新消息**（措辞修正）：不丢失、不中断；drain 结束后立即开新回合认领（loop L576：新消息延续/紧接回合），体感等待等价于现状。
- **120s 超时的反例路径**：巨型 span 的温暖尝试若被 120s 截断，作废后下回合 pre-step 冷缓存重付全价——记录为特性 1 的已知残余风险（频率低：guardedSignal 估值针对常规 span）。
- **跨会话 drainRunning 争用**：守卫为进程级，B 会话（子代理）的 turn-stopping 排干会因 A 会话在排干而静默 return、退回冷路径；且每个子回合结束都是潜在排干点，争用频率上升。后续项：per-session 守卫（closingTasks 已按 session.id 键控，改造面小）。
- **目录 fresh 成本**：~15 tok/消息，108 消息 ≈ 1.6K tok 全价；无上限（实验验证至 52 条 100%）。与信封尺寸临界的 fold 有 CONTEXT_WINDOW_EXCEEDED → 重试循环的边缘交互，记录不处理。
- **`L<N>` 双语义并存**：span 消息行号与源码行号同形；靠"源码引用必须带文件名"规则消歧，不做引擎侧校验（误伤源码引用）。开放：未来可用 `L[N]`（方括号）专表消息行号。
- **head=3/tail=8 无实验依据**：实验验证的是全量目录；头尾窗口的定向效果未单独验证（fold_recall 全量模式兜底，风险低）。批准修订：头 3 行替换直方图头行。
- **What happened 相位化**：搭车小特性，无独立实验依据；措辞保守（"每 step 至少被一 bullet 覆盖"），e2e 抽查一份大 fold 摘要对照；可独立 revert。
- **turn-stopping 宿主兼容**：老宿主无此钩子 → 注册语句整体 try/catch 吞掉，行为退回现状。

## 9. 决策记录

- ADR 待实现收尾时落盘：`docs/adr/0001-turn-stopping-drain.md`（折叠时点经济学：缓存双峰根因、挂点选择、120s×K 界与残余风险）、`docs/adr/0002-index-in-instruction.md`（行号供给机制：消息内注入 vs 指令内索引的缓存代价对比、三臂受控实验依据、非 H2 引导行与 Mirror 禁令）。

## 10. 评审记录与处置

| 评审 | 级别 | 条目 | 处置 |
|---|---|---|---|
| A-边界 | Blocker | B1 契约注释矛盾 | §6 显式列注释改写；§3 区分两渲染器契约 ✔ |
| A-边界 | Blocker | B2 模型可读文本虚假承诺 | §3/§6 增列 task_end/系统提示段/acceptance 文档改写 + 测试钉住 ✔ |
| A-边界 | Blocker | B3 指令自相矛盾 | §3 Budget 子句同编辑改写 + 测试断言一致 ✔ |
| A-边界 | Major | M1 规则先于目录窗口 | §7 步骤 2 合并为原子提交 ✔ |
| A-边界 | Major | M2 模块表失真 | §2 补全依赖列 + compact-stats 行 ✔ |
| A-边界 | Major | M3 跨会话守卫 | §4 归因修正 + §8 记录 + 后续项 ✔ |
| B-契约 | Major | M1 注册须整体 try/catch | §3 契约明写 ✔ |
| B-契约 | Major | M2 120s 界错误 | §8 改为 120s×K + UI 语义 ✔ |
| B-契约 | Major | M3 H2 目录诱导镜像 | §3 非 H2 引导行 + Mirror 禁令 + 测试 ✔ |
| B-契约 | Major | M4 CHANGELOG/README 缺失 | §6 增列 ✔ |
| 两评审 | Minor 16 条 | 采纳 11（切片复用、零桶省略、导出理由、守卫新语义、排队措辞、镜像禁令、装配器离线锚点、退化夹具更换、捆绑风险认可、span 范围描述省略明示等）；记录不展开 5（非标准角色命名细节、相位化拆分、信封边缘交互仅记录、⑦二分不可能、⑧反例仅记录） | ✔ |
| 用户批准 | 修订 | footer 形态："计数+角色直方图头行 + 省略行 + tail 8" → "前 3 行真实预览行 + 省略行 + tail 8"；消息数并入 fold bullet；直方图与 roleLabel 提取取消 | §3/§6/§8 已同步 ✔ |

两评审一致结论：架构主干通过（挂点真实、复用成立、依赖无环、七项必查无结构性否决），修订后可进实现。

## 11. 实现记录（收尾）

按 §7 顺序完成，全链 80 测试绿（task-marks 24 / span-preview 16 / compact-stats 13 / release 14 / fold-engine 8 / fold-instruction 5）。偏离与补充：

- **步骤 1 提前携带引擎侧 footer**：`renderArchivePreview`→`renderArchiveFooter` 改名必然触及 fold-engine 调用行，故 footer 新格式与 fold bullet（含消息数）随模块 1 落地（设计原排在步骤 2）；步骤 2 的原子性约束（引用规则+目录装配同提交）不受影响，仍完整保持。
- **"no elision" 钉扎测试随模块 3 提交**（设计 §6 列于 fold-instruction.test.mjs 但该断言依赖模块 3 的文本改写）；同测试顺带钉住 turn-stopping 注册语句。
- **package.json test 脚本追加 fold-instruction.test.mjs**（§6 未列，必要补全）。
- **e2e 以离线集成形态完成**：一次性脚本 `.tmp-e2e-fold.mjs`（工作区根；**未入库，已随临时产物清理删除**）在宿主 checkout 目录下运行，走真实 ScopedEngine/BasicCompactionEngine/BlockAssembler/工件写入 + 伪 llm.stream，断言：指令含非 H2 目录引导行+fenced 16 行真行号+位于 closing 之后、引用规则与 Mirror 禁令在场、span 字节不动、摘要节点五节无镜像、footer=头 3+省略行+tail 8 真行号、fold bullet 含计数、工件 16 行与 L<N> 对齐、usage 透传、双 drain 挂点注册、turn-stopping 监听器空会话安全 no-op。**真·热缓存 turn-stopping 折叠需宿主重启后新会话观察**（插件代码进程内不热更新；usage 的 cacheRead 占比已可观测）。
- 遗留观察项（不阻塞）：跨会话 drainRunning 争用（§8 M3 后续项）、大 span 目录 fresh 成本的边缘交互、head=3/tail=8 窗口的定向效果（fold_recall 兜底）。
- ADR：`docs/adr/0001-turn-stopping-drain.md`、`docs/adr/0002-index-in-instruction.md`。

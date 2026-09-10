# 设计:taskfold 代码评审问题处理

> 状态:已完成(2026-08-31;实现与设计一致,无实质偏离。测试 task-marks 19 + compact-stats 11 = 30 全绿。cmpct/docs/ 下历史设计文档按计划保留不回改)
> 创建:2026-08-31
> 输入:外部代码评审(2026-08-31)+ 用户三项决策(见 D-R1/R2/R3)+ 双评审员对抗评审
> 基线:cmpct/ 当前工作区版本(task_begin/task_fold 双工具 + list_folds/fold_recall)
> 关联存量设计:`task-marker-compaction.md`(D7 严格 LIFO——本设计部分回归该决策)、`compact-region-tool.md`

## 0. 用户已确认的决策

- **D-R1 关闭语义**:task_fold 增加 **LIFO 限制**——只能关闭最新开启的标记;试图关闭更早任务时返回结构化错误(提示先关内层)。回归存量设计 D7。
- **D-R2 引擎降级**:engineFor() 解析失败时 task_fold **降级为"仅结束、不折叠"**(ok:true + unfolded 标记),成功文本照常弹出标记。
- **D-R3 nudge-2 范围**:扫描**全部**开启标记取最大年龄,对最老的 ≥20 轮任务发提示(一次仍只提示一个)。

## 1. 模块划分

不改模块边界,全部改动落在两个既有插件文件 + 测试 + 文档内:

| 模块 | 本次职责 | 允许依赖 |
|---|---|---|
| `compact-region.mjs` 生命周期工具 | LIFO 关闭校验、表面锚校验、引擎降级、按会话 closing 声明、名称分隔符拒绝、nudge-2 全扫、死代码删除、注释修正 | 不变(node builtins + inject 服务) |
| `compact-region.mjs` 纯函数层 | 新增可离线测试的纯函数:`closeTarget(marks, name)`、`validTaskName(name)` | 无 |
| `compact-stats.mjs` | 折叠列表改用时间序编号、导出纯渲染函数、死代码删除、头注释修正 | 不变 |
| `test/*.test.mjs` | 新增纯函数测试;修正受 LIFO 影响的既有测试注释 | node:test |

依赖方向不变、零新增依赖。

## 2. 接口契约(先签名)

### 2.1 纯函数(compact-region.mjs 新导出)

```js
// LIFO 关闭解析。前提:marks 按时间序=栈序(升 seq);重名时匹配"最近一次出现"。
// 返回:
//  { status:'ok', mark }                       — name 命中栈顶
//  { status:'unknown', open:[names] }          — 无此名字的开启任务
//  { status:'lifo', mark, blocking:[names] }   — 名字存在但不是栈顶;blocking=该 mark
//                                               内侧(更新)全部任务名,按序去重
//  { status:'empty' }                          — 无开启任务
export function closeTarget(marks, name)

// 名称校验。'' 或含 ' —'(渲染文本的名字分隔符)→ false。
export function validTaskName(name)
```

`task_begin`/`task_fold` execute 均先过 `validTaskName`(规范化后),不合法返回 `category:'invalid'`,错误文本说明名称不能包含 " —"(分隔符)。

**存量名逃生门**:`taskNameFromText` 以首个 ' —' 切分,故投影里的标记名**从不**含 ' —';唯一理论来源是 legacy `task/mark` 快照的原始 name。兜底:task_fold 若 `validTaskName` 拒绝,但存在**逐字符相等**的开启标记名,放行关闭(该标记随之弹掉,自愈)。

**重名防御**:`task_begin` 额外拒绝**已开启**的同名(错误文本提示换名或先关现有任务)——名字即身份键,重名无合法用例;新流程从此不产生重名,closeTarget 的"最近一次出现"规则仅服务 legacy 快照。

### 2.1.1 task_fold 决策表提为纯函数(可离线测试)

```js
// 输入:marks(栈序)、name、surfaceNodes(seq 数组)、engineAvailable(bool)。
// 返回 { action:'invalid', error } | { action:'lifo', blocking } | { action:'unknown', open }
//      | { action:'unfolded', reason:'anchor'|'engine', mark }
//      | { action:'tooSmall', mark } | { action:'fold', mark, startSeq, endSeq }
export function foldDecision(marks, name, surfaceNodes, engineAvailable)
```

execute 只做 I/O 包装(agent/session/engine 获取、调 compactRegion、写 artifact、渲染值组装);全部分支判断在纯函数内,离线全覆盖。

### 2.2 task_fold execute 决策表(由 foldDecision 纯函数承载)

| 步骤 | 条件 | 结果 |
|---|---|---|
| 1 | 无 agent / 空名 / 名称含 ' —' 且无逐字符相等的存量标记 | invalid 结构化错误 |
| 2 | `foldDecision` → empty/unknown | invalid,列出 open 名单(现行文案) |
| 3 | `foldDecision` → lifo | `{ok:false, category:'invalid', error:'task "' + name + '" is not the innermost open task; close the newer task(s) first: ' + blocking.join(', ')}` |
| 4 | 栈顶 mark.seq **不在表面节点数组中**(被自动压缩遮蔽) | **降级结束**:`{ok:true, name, remainingNames, unfolded:'anchor'}`(span 已不在表面,无法折叠;任务关闭) |
| 5 | `endIdx = nodes.length-2`;`endIdx < 0 \|\| nodes[endIdx] < mark.seq` | 现行 tooSmall 成功(不变) |
| 6 | `engineFor()` 返回 undefined | **降级结束**:`{ok:true, name, remainingNames, unfolded:'engine'}`(D-R2) |
| 7 | compactRegion 成功 | 现行成功路径(不变) |

渲染:失败文本不变;unfolded 按原因区分措辞(anchor → `'mark no longer on the surface; task closed without folding'`;engine → `'engine unavailable; task closed without folding'`),均以 `Task folded: ` 开头,保证 reducer 照常弹栈;NAME 无分隔符后解析无损。

### 2.3 按会话 closing 声明(替换 `engine.__closingTask` 挂实例字段)

- apply 作用域内建 `const closingTasks = new Map()`(sessionId → name);task_fold 在调用 compactRegion 前后 set/delete,**键 = agent.session.id**。
- ScopedEngine.summarize 内改读 `closingTasks.get(agent.session.id)`(类定义在 buildScopedEngine 闭包内,直接捕获,不再触碰 `this`)。多会话并发互不污染。

### 2.4 折叠编号对齐(compact-stats.mjs)

- `collectFolds(events)` 返回顺序即时间序;list_folds 渲染行改为以**时间序 1-based 编号**为主标识:`#3 (seq 4812, range s..e) → …`;fold_recall 校验/文档口径(1..folds.length)不变;task_fold 输出 "Folded #N" 的计数口径(数 compaction/summary 事件个数)与之天然一致。
- 渲染行构造提取为纯导出 `renderFoldList(stats)`(value 字段 → 行文本数组,含表头行),供离线测试断言编号对齐;签名不带 total。

### 2.5 nudge-2 全扫(compact-region.mjs)

```
oldest = marks 中 age = countAssistantSince(seq, 21) 最大的那个
age(oldest) >= 20 → 提示行(单任务、byte-stable,不变格式)
```

并列取更早 seq 之所以等价于"取最老":seq 单调递增且 age 随 seq 递减(仅 ≥20 轮者在 cap=21 处饱和并列)——此不变量依赖 cap ≥ 提示阈值,改 cap 时必须连同复核。每标记一次有界回扫(≤21 命中即停),开销可忽略。提示行的 "if done" 措辞保留,并加 "if blocked by a newer task, close that one first" 一句,与 LIFO 语义对齐。

### 2.6 死代码删除(仅 compact-region.mjs 内的局部符号)

- 删:apply 闭包内的 `readSurface`、`classify`、`indexEvents`、`textPreview` 与局部 `const PREVIEW_LIMIT`、`TAIL_WINDOW`;模块级 `depthPhrase`、`summaryTextOf`;第 47 行 TEMP DIAGNOSTIC 残留;compact-region.mjs:787 注释里 "mirrors classify()" 的悬空引用改为直接描述事件形状。**不动** compact-stats.mjs 自己的导出 `PREVIEW_LIMIT`(firstTextBlock 在用)。
- `task_begin` 锚定改为:对 `session.surface.nodes` 从尾向头找**事件类型为 assistant/message** 的节点(用 sessionEvents 建一次 seq→event 查找,循环内即弃),即现 CONTRACT 注释语义,不需要整套边界/预览机制。
- compact-stats.mjs:删未使用的 `textOf`。

### 2.7 模型可见文案(评审 M-1/M-2,必须改)

- `task_fold` 工具 `description`:改为 LIFO 语义——"Close the innermost open task by name AND fold its span … newer open tasks block older ones (close them first); a name mismatch or a blocked name fails and changes nothing (retry). If the engine is unavailable the task still closes, unfolded."。
- `systemPrompt.section('task-marker-compaction')` 文本:同步 LIFO + 降级措辞;nudge 句 "call task_fold for a task 20+ rounds old" 保持(指向最老任务由 nudge 行自述)。
- `task_begin` description:补一句重名拒绝("a name already open is rejected")。

### 2.8 注释/文档修正

- compact-region.mjs 头注释:改为 plugin-bundle-only 形态的准确描述;删除与实现矛盾的 engineFor "优先 realm ctx.compaction" 两段 NOTE(255-272、398-411),替换为现行真实策略(始终 ScopedEngine 自建;realm 引擎只服务 AUTO 压缩);版本注释统一(schema 形状=v6,reducer 注释 v5→v6,注册 stateVersion=8 不变,测试头 v2→现行)。
- compact-stats.mjs 头注释:save:true/会话工作区 → OS temp 目录 taskfold-artifacts(与 README 一致)。
- cordis.patch.yml 头注释:删除 "realm ctx.get('compaction') 优先" 段,改为"引擎总是插件自建 ScopedEngine,lazy 解析"。
- README.md / README.zh.md:task_fold 行补 LIFO 语义、engine 不可用降级、nudge 表 "a task left open" 行改为 any/oldest;**删除/改写 "Corrupt-edge policy / 损坏边界策略" 整节**(其描述的机制随 readSurface 删除而不复存在,双语同步);README.zh 测试计数 "32 项" 改为不带数字的表述;State model 段按 LIFO 调整措辞。
- 存量设计 `task-marker-compaction.md`:不动历史正文,在 D7 处追加一行"v3 起按名+LIFO(见 taskfold-review-fixes.md D-R1)"。

## 3. 明确不处理(评审项,记录处置)

- 四-1 pending intent 中断残留:无害(投影为派生态),接受现状。
- 四-4 折叠编号依赖提交后快照:compactRegion 返回即已同步提交(引擎内 commit 在 await 内完成),保持计数方案,在计数处补一句注释。
- 四-5 artifact 写失败静默:插件无 logger 服务;维持省略文件段的行为,注释说明。
- span 中段遮蔽(锚在表面但区间中部被其他折叠遮蔽,如内层先折后关外层):存量暴露,compactRegion 的 seq 区间语义由引擎承载;LIFO 限制后内层先折、外层后折的合法序列里外层区间含内层摘要节点属设计内行为;本设计不额外校验中段连续性。
- `engineFor` 失败永久缓存(selfEngine=null 后不再重试):接受——模块解析环境在进程生命周期内不变;D-R2 降级使代价从"报错"变为"静默仅结束",唯一信号是成功文本中的 "engine unavailable" 措辞。记录权衡,不改。

## 4. 文件变更清单(实现顺序,每步独立可验证)

| # | 文件 | 操作 |
|---|---|---|
| 1a | `cmpct/plugins/compact-region.mjs` | 新增纯函数 closeTarget/validTaskName/foldDecision 导出(不改 execute);测试先行落地于步骤 3a |
| 1b | `cmpct/plugins/compact-region.mjs` | execute 接线:task_begin 重名+分隔符拒绝+新锚定;task_fold 走 foldDecision、降级路径;task_fold description 与 systemPrompt 文本(§2.7);per-session closingTasks Map(§2.3) |
| 1c | `cmpct/plugins/compact-region.mjs` | nudge-2 全扫 + "blocked by newer" 措辞 |
| 1d | `cmpct/plugins/compact-region.mjs` | 死代码删除 + 全部注释修正(头注释、engineFor NOTE、版本号、classify 悬空引用) |
| 2 | `cmpct/plugins/compact-stats.mjs` | renderFoldList 导出 + 编号渲染 + textOf 删除 + 头注释修正 |
| 3a | `cmpct/test/task-marks.test.mjs` | 新增 foldDecision/closeTarget/validTaskName 测试;修正乱序关闭测试注释(reducer 保持按名弹,工具层 LIFO);版本注释 |
| 3b | `cmpct/test/compact-stats.test.mjs` | 新增编号对齐测试;允许调整受 renderFoldList 重构影响的既有断言 |
| 4 | `cmpct/README.md` + `README.zh.md` | §2.8 的双语同步(含 Corrupt-edge 节删除、计数去数字化) |
| 5 | `cmpct/cordis.patch.yml` + `docs/design/task-marker-compaction.md` | 注释/决策补记 |

注:1a 与 3a 实际同批提交(纯函数+测试一体的最小可验证单元);上表按逻辑单元拆分。

## 5. 验证清单

- 单测(离线,每步后跑):foldDecision 全分支(ok/unknown/lifo/empty/anchor/engine/tooSmall/fold);closeTarget 四态+重名(最近出现)+blocking 去重;validTaskName(含 ' —' 拒绝、空拒绝、正常、存量相等名放行路径经 foldDecision);renderFoldList 编号= fold_recall 合法参数域;既有 20 测全绿。
- 静态走查(纯 execute 内、无离线测试出口,逐项列出):per-session closingTasks 多会话隔离;unfolded 成功文本以 `Task folded: ` 开头且 reducer 弹栈;task_begin 新锚定循环;task_fold description/systemPrompt 文本与实现一致;README 双语逐节 diff。

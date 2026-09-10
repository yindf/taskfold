# Deferred Fold v5：全 deferred + 交付门控自动折叠（已实施 0.15.0）

状态：已实施（0.15.0）。实施记录：schema/reducer v9（pendingArchives + compaction/summary 闭环）、deferredArchivePlan 纯函数（wait/defer/drop/fold 四态门控）、agent/pre-step 自动折叠器（串行、逐条重读状态、settledArchives 终态簿记）、task_fold 双路径（标准关闭=登记队列；对队列条目再调=手动立即补折）、HOLD 失败告警行、attachFoldTitles 摘要首行兜底、系统提示段/task_begin/task_fold 文案全部改写、死代码 foldDecision 连同其 6 个用例移除（标准关闭改用 closeTarget+锚检查，折叠路径统一走 deferredArchivePlan+foldRegion）。
历史：v1/v2 模型驱动延迟（否决）；v3 mode 参数（否决）；v4 全 deferred；v5 交付检测门控（G2）。

## 0. 目标语义

- `task_fold({ name })`（schema 不变，无新参数）：语义变为"**标记完成 + 登记归档**"——mark 立即弹出（LIFO 干净），归档区间（begin.seq + 任务名 + foldResultSeq）进入 pending 状态；**不折叠**，立即返回，模型继续剩余动作（含交付报告）。
- **自动折叠（交付检测门控，与回合无关）**：pendingArchive 的 task_fold 之后一旦出现交付正文（含非空 text 块的 assistant 消息），**下一个 agent/pre-step**（宿主源码时序：用户消息 claim 后、落盘前；或回合中间的下一步前）自动折叠该区间。交付正文出现之前绝不折。
- 折叠节律：**交付驱动**——每个任务在其交付物落盘后的下一个步骤边界折叠；交付之前细节始终在表面上。
- 好处：交付质量（一切交付物先于折叠）、回合内逐步压缩（A 交付 → A 折 → B 在短表面上开工）、回合内依赖（交付前的任务天然带前序任务原文）、KV cache（折叠只发生在步骤边界，最小化中段失效）。
- 代价（接受并记录）：无交付的中间关闭等到下一条正文才折（通常即外围报告，近似回合末）；摘要调用阻塞该步骤边界（输出上限 300 词，延迟有界）。

## 1. 机制设计

### 1.1 状态：pendingArchives

- reducer 维护 `pendingArchives: [{ seq, name, foldResultSeq }]`（seq = task_begin 锚 seq；foldResultSeq = task_fold 成功结果事件的 seq——N2 要求携带，用于后继锚裁剪与门控）。
- 派生源：task_fold 工具调用（现有事件）成功弹出 mark 时，把 `{seq: mark.seq, name}` 追加进 pendingArchives；归档完成（见 1.3）时移除。
- 持久化 schema：state 增加 `pendingArchives` 数组字段（宽松校验，与 marks 同策略）；stateVersion 8→9（宿主对 ver 不匹配的行为是丢弃持久行后全量重放，非拒载——升级安全；旧日志回放逐字节不变）。

### 1.2 触发：agent/pre-step + 交付检测门控（产品所有者拍板：G2）

- `ctx.on('agent/pre-step', …)`（宿主 AUTO 压缩同款钩子，payload 含 {agent, signal}）。
- **门控（每条 pendingArchive 独立判定，与回合无关；终轮 A 条款合取形式）**：满足当且仅当
  ① `p.foldResultSeq` 之后存在 ≥1 条**交付正文**——content 数组中含 `type === 'text'` 且 `text.trim()` 非空的块的 assistant/message（**reasoning 块、tool-call 块不计**——reasoning 满天飞，计入则门控恒真，终轮 B 条款）；**且**
  ② 该正文 seq < `p.foldResultSeq` 之后第一个"仍开或 pending 的 begin 锚"seq（正文不在后继任务锚之后——违规时序下推迟折叠，待后继任务关闭、裁剪点上移、正文被包进区间后正常折叠；不裁剪穿越锚、也不把交付正文留区间外，终轮 A 裁定）。
  两条件一次后继锚扫描同时得出门控与 END（统一实现）。
- 效果：**回合内逐步压缩**——A 关闭 → 交付正文 → 下一步 pre-step 折 A → 后续任务在更短表面上工作；嵌套链逐步收敛。无交付的中间关闭等到下一条正文（通常为外围报告），可接受。
- steer/inject 触发的 pre-step 同样按门控判定（正文已存在则折——语义正确）。
- 满足门控的条目按 seq 降序（内层先）逐个折叠。
- **区间（N2 修正）**：`[p.seq .. END]`，END 裁剪到 **p.foldResultSeq 之后第一个"仍开或 pending 的任务 begin 锚"之前**（同回合顺序任务 A 关→B 开→折 A 时，不得遮蔽 B 的 begin 锚）。无后继锚时 END = 表面最后节点。复用现有 foldDecision 的引擎前校验与平衡边界逐节点回退（方向安全：只向下，下界 p.seq）。
- **串行折叠实现注意（终轮 C 条款）**：每折一条后表面即变——不得复用折前快照，每条处理前重取表面视图、重跑 foldDecision 校验；遍历 pendingArchives 的快照副本，每条折叠前重验成员资格（前一条 shadowedSeqs 或并发 AUTO 压缩可能已移除该条目）；外层 END 在折完内层后重取；单条失败（busy/不平衡）不中断批处理。
- owner:'current-turn' 合法性：turn/start 已提交（openTurn≠null），与 AUTO 压缩同条件。

### 1.3 归档完成与 mark 弹出的闭环（上轮 B1 裁定）

- 自动折叠成功 → 引擎提交 compaction/summary 事件（data.shadowedSeqs 含被遮蔽区间）→ **reducer 处理 compaction/summary**：移除所有 seq ∈ shadowedSeqs 的 pendingArchives 条目。纯函数、回放安全。（B1 复核：判据精确充分，AUTO 压缩产生的 shadowedSeqs 删除条目即正确降级——锚离表面是永久性的，无需 name 匹配。）
- 失败分级（M1 裁定，消解 v4 矛盾）：
  - **anchor 被遮蔽**（AUTO 压缩先折走了含 begin 锚的区间）：**终态丢弃条目 + 告警**（重试永不成功）。检测点在 pre-step 折叠前的引擎前校验（foldDecision 的 unfolded:anchor 分支），失败原因写入进程内失败 Map。
  - **引擎不可用 / busy / 不平衡边界耗尽**：保留条目，下一轮重试；失败原因写失败 Map。
- 告警渲染（m1 修正）：**HOLD 语义**（条件成立期间持续显示，非一次性——快照 diff 引擎会冲掉一次性行）："auto-fold failed for X (reason) — close it manually with task_fold({ name: 'X' }) or it will retry automatically"。task_fold 对 pendingArchive 条目允许手动补折。

### 1.4 LIFO 与嵌套

- task_fold 弹 mark 时不受 pendingArchives 影响（归档未完成 ≠ 任务开着）——外层可在内层归档前正常关闭，自己的 pendingArchive 登记。
- 下一回合按 seq 降序折叠：内层区间先折，外层区间随后折叠时包含内层 summary 节点——与现有嵌套折叠（fold #5/#6）同构。
- 若 AUTO 压缩先遮蔽了某 pendingArchive 的 begin 锚 → 该条目走降级（任务已关，仅丢弃归档）或 anchor 语义按"任务已结束"处理（实现细节：丢弃条目 + 告警行）。

### 1.5 LLM 摘要（上轮 P5 裁定）

- 复用 ScopedEngine.summarize；signal 来自 pre-step payload（回合 abort signal），外加 `AbortSignal.any([signal, AbortSignal.timeout(120s)])` 防挂死。
- 取消/超时：引擎补 compaction/end 错误事件，条目保留，下轮重试。

### 1.6 工具与文案

- **N1 裁定：结果文本保留 `'Task folded: '` 前缀**（mark 弹出 L362、pendingArchives 登记触发、grace 扫描 L912 全依赖该前缀，改前缀 = 派生链断裂）。仅尾部文案替换折叠说明：`Task folded: <name> — N remain(s). Archival queued; archival queued — the span folds automatically at your next step boundary; deliver your report now with full context.`（无 fold 号/工件/预览——折叠尚未发生。）
- task_fold description："'task_fold marks the work DONE and queues archival — the span folds automatically at your next step boundary (possibly mid-turn). Deliver your report/deliverable AFTER this call with full context, in the same turn. Folding never precedes a deliverable."
- 系统提示段：删除 deliver-then-fold 同回合折叠语义；改为"完成 → task_fold 登记归档 → 同回合交付（完整上下文）→ 交付落盘后的下一个步骤边界自动折叠（可能在回合中段）"。子代理规则同（豁免句删除，全 deferred 天然覆盖）。
- reportPart 偏差护栏保留（防"未交付就回合结束"）。

## 2. N3：list_folds 标题关联重做

compact-stats.mjs 的 attachFoldTitles（L137-155）依赖旧时序契约（compaction/summary 落在 task_fold 调用与结果之间）；v4/v5 折叠事件由 pre-step 处理器提交，早越过该 tool/result → 所有新折叠丢失标题。重做：**解析 compaction/summary 事件的摘要首行 `# <name>`**（closingTasks 声明路径已保证摘要以任务名标题开头——ScopedEngine.summarize 的 closing 指令要求 TITLE 为任务名）。跨版本兼容：旧折叠（有 in-flight 调用时序）继续走旧路径，新路径只作兜底优先级次序——实现时按"先旧路径、miss 则解析首行"。

## 3. 不改动

- task_begin/list_folds/fold_recall 工具形态与工件/预览体系；FOLD_SUMMARY_INSTRUCTION（报告在区间尾部，摘要引用之）。
- 旧日志回放兼容（新状态字段宽松、ver 9 重放安全）。

## 4. 测试与发布

- reducer：pendingArchives 登记/移除（compaction/summary shadowedSeqs 路径）/旧日志回放不变/schema 宽容。
- 门控纯函数：正文出现前不折 / 出现后折 / 无正文跨回合不折 / 多条目 LIFO / steer 场景。
- 区间：后继锚裁剪（N2 场景）、无后继锚、嵌套同构、AUTO 遮蔽降级。
- attachFoldTitles：新折叠按摘要首行取标题、旧折叠兼容。
- 文案断言；0.15.0。

## 5. 已裁定风险清单（终态）

R1 摘要阻塞步骤边界 —— 有界（300 词上限），接受。
R2 无交付中间关闭延迟折叠 —— 等下一条正文，可接受。
R3 连续失败条目残留 —— HOLD 告警行 + 手动补折通道，接受。
R4 ver 9 升级首载全量重放 —— 一次性成本，接受。
R5 pre-step payload 字段（turn/step 可得性）—— 实现时以 {agent, signal} 为准（引擎用法实证），门控用事件日志判定而非 payload 字段。
R6 与 AUTO 压缩同 waterfall 共存 —— 引擎锁互斥（既有机制），记入风险清单。

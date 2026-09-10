# 设计:任务区间自动压缩(task_begin / task_end)

> 状态:已完成(阶段一:动态插件验证通过,含 pkg-8 分类修复);阶段二(固化)待批准
> 创建:2026-08-31  更新:2026-08-31
> 依赖:基于 `compact-region-tool` 设计(已验证通过的 `compact` / `compact_inspect` 与 `surface-reader` 折叠规则)。本设计新增两个标记工具,复用同一动态插件与 `agentPresets.serviceFor` 寻址方式。
> 版本基线:dsh 0.1.2-alpha.2

## 1. 目标与范围

### 目标

让"局部压缩"从"运维操作"变成"任务生命周期的一部分":agent 在开始一个任务时调用 `task_begin` 打标记,任务完成时调用 `task_end`——插件自动算出从标记点到当前的区间并压缩为一条摘要节点。误开或放弃的任务用 `task_abort` 弹出标记(不压缩)。agent 全程不需要知道或记忆任何位置编号(位置在每次压缩后都会漂移,这正是手动 `compact` 最脆弱的地方)。

### 范围外(显式排除)

- **不做事件驱动自动触发**(用户已确认:显式调用 `task_end`;监听 todo 完成/回合结束的自动化留待后续评估)。
- **不与 `todo_write` 系统耦合**:本标记独立于 todo 条目,适用于任意粒度的任务(含非 todo 化的工作)。
- **标记按会话隔离,支持嵌套(栈语义,用户要求)**:标记状态为 `Map<sessionId, Marker[]>`——每会话一个**标记栈**;`task_begin` 压栈,`task_end` 弹栈并结束**最内层未结束任务**(LIFO,不支持按名指定或乱序结束)。嵌套区间天然分层:内层 `task_end` 先压缩内层区间;外层 `task_end` 的区间包含内层已生成的摘要节点(层级化再总结,信息按层递减,by design)。
- **标记不做持久化**:标记存于插件内存(apply 作用域状态),插件 stop/update/进程重启即失效;标记本质是瞬态的,持久化无意义。失效后 `task_end` 命中"no active mark"路径并引导重新 `task_begin`;stale 路径(标记节点被压缩掉)只覆盖标记存在但其 seq 已不在表面的场景。
- **首版不接受自定义摘要文本/任务名参数**:与基座设计一致,摘要由运行时 summarizer 生成。

## 2. 模块划分

在现有插件(`cmpct-1`)内新增一个模块,复用全部既有模块:

| 模块 | 一句话职责 | 关键类型 | 允许依赖 |
|---|---|---|---|
| `task-marker` | `task_begin`/`task_end`/`task_abort` 三工具的 schema/output/execute:标记栈的按会话存取、seq→位置翻译、区间计算、调 engine、成功弹栈、显式放弃 | `Marker { seq }`,`markers: Map<sessionId, Marker[]>`(每会话标记栈) | `surface-reader`(平衡/位置)、`agentPresets.serviceFor`(engine)、`exec.agent/signal`、`register` |

依赖方向保持单向无环:`task-marker → surface-reader → Session`,`task-marker → compaction engine(经 serviceFor)`。

## 3. 公共接口契约(先签名,后实现)

### 3.1 工具 `task_begin`

**注册名**:`task_begin`(无参数)。经 `harness.defineTool` + `harness.registerTool`(alpha 约束同基座设计 §5:output.schema 需显式 `additionalProperties:true`;参数 DSL 无 minimum)。

模型可见 schema:

```json
{
  "name": "task_begin",
  "description": "Mark the start of a task on the current conversation surface. Call it alone in a step when a task begins. When the task is done, call task_end: everything from just after this mark to just before task_end is summarized into one node automatically (positions are tracked for you; no numbers to remember). Tasks may nest: each task_begin pushes a mark onto this session's stack, and task_end always ends the most recent unfinished task (innermost first).",
  "parameters": { "type": "object", "properties": {} }
}
```

`execute(args, exec)` 行为约定:

| 步骤 | 条件 | 结果 |
|---|---|---|
| 1 | `exec.agent` 为 `undefined` | `{ok:false, category:'invalid', error:'task_begin requires an agent context'}` |
| 2 | 成功 | `{ok:true, depth:<压栈后的栈深度,1 表示最外层>}` |

- **标记内容**:从表面尾部**向回扫描最近的 `assistant/message` 节点的 seq**——即本 step 的 assistant 消息(含本次调用)。不用尾节点本身(并行兄弟的工具结果会先于本调用落表面,尾节点可能是兄弟的 tool/result,且可能被 tool-result-pruner 重写);本 step 的 assistant 消息永远存在、永不被 pruner 触碰。不用位置号——位置会漂移,seq 稳定。
- **压栈语义**:`task_begin` 总是压栈(不覆盖任何既有标记);`depth` 回显新栈深度,让模型可见嵌套层级。其他会话的标记栈不受影响(按 sessionId 键控)。
- **不校验**压缩可用性(标记期不需要 engine;探测结果对 end 期无约束力,故不返回)。

### 3.2 工具 `task_end`

**注册名**:`task_end`(无参数)。

模型可见 schema:

```json
{
  "name": "task_end",
  "description": "End the current (innermost unfinished) task and compress everything from its task_begin mark to this point into one summary node. The range is computed automatically: it starts at the first balanced cut after the mark and ends at the last balanced cut before this call. Call task_end alone in a step. This call and its own step are never part of the range. Outer marks stay active. The mark is popped on success and kept on failure so you can retry.",
  "parameters": { "type": "object", "properties": {} }
}
```

`execute(args, exec)` 行为约定(错误全部结构化返回,不抛异常逃逸):

| 步骤 | 条件 | 结果 |
|---|---|---|
| 1 | `exec.agent` 为 `undefined` | `{ok:false, category:'invalid', error:'task_end requires an agent context'}` |
| 2 | engine 不可得(serviceFor 返回空/无 compactRegion) | `{ok:false, category:'invalid', error:'this agent preset mounts no compaction service; task_end is unavailable here'}` |
| 3 | 本会话标记栈为空(含插件更新/重启后状态丢失) | `{ok:false, category:'invalid', error:'no active task mark; call task_begin first'}` |
| 4 | **栈顶**标记 seq 不在当前表面(标记节点已被压缩掉) | **仅弹出该栈顶陈旧标记**,返回 `{ok:false, category:'invalid', error:'the marked position is no longer on the surface (it was compacted away); call task_begin again if this task still needs ending', depth:<剩余栈深度>}` |
| 5 | 计算区间(见 3.3),区间为空 | **保留栈顶标记**,返回 `{ok:false, category:'invalid', error:'nothing to compact: the mark is at the very end of the surface; continue working and call task_end again'}` |
| 6 | end 向回扫描越过标记仍无平衡切割(如 task_begin 与 task_end 同 step、或表面损坏) | **保留栈顶标记**,返回 `{ok:false, category:'invalid', error:'no balanced end cut after the mark; call task_end alone in a step', hint:'retry task_end in its own step once this step settles'}` |
| 7 | `engine.compactRegion(startSeq, endSeq, agent, exec.signal)` | 成功→**弹出栈顶标记**并返回 `{ok:true, summary, shadowedTokenCount, depth:<剩余栈深度,0 表示全部结束>}`;失败→**保留栈顶标记**并返回 `{ok:false, category, error, hint?, depth:<当前栈深度>}`,hint 按 task_end 语境定制(见 D6):`summary` 且 error 含 "not smaller" → 'the range is too small to summarize further (common when a task had little content besides an already-compacted subtask); continue real work to grow the range and retry, or call task_abort to drop this mark';`summary`(其余,summarizer 失败/截断/无路由)→ 'the summarizer failed; resolve the cause and retry, or call task_abort to drop this mark';`changed` → 直接重试(位置每次重算);`busy`/`commit`/`persistence`/`cancelled` 同基座语义 |

### 3.3 工具 `task_abort`

**注册名**:`task_abort`(无参数)。栈语义下误开/放弃的标记没有自愈出口(评审 M1:`task_begin` 只压栈,失败标记无法解除),故补显式放弃路径。

模型可见 schema:

```json
{
  "name": "task_abort",
  "description": "Discard the current (innermost) task mark WITHOUT compacting anything. Use when a task is abandoned or a task_begin was opened by mistake. The mark is popped from this session's stack; the conversation surface is untouched. Use task_end instead when the task is done and should be summarized.",
  "parameters": { "type": "object", "properties": {} }
}
```

`execute(args, exec)` 行为约定:

| 步骤 | 条件 | 结果 |
|---|---|---|
| 1 | `exec.agent` 为 `undefined` | `{ok:false, category:'invalid', error:'task_abort requires an agent context'}` |
| 2 | 本会话标记栈为空 | `{ok:false, category:'invalid', error:'no active task mark; call task_begin first'}` |
| 3 | 成功 | 弹出栈顶标记,**不触碰表面、不调用 engine**,返回 `{ok:true, aborted:true, depth:<剩余栈深度>}` |

- 纯栈操作:无区间计算、无压缩、无 stale 概念(弹出的 seq 以后不再使用)。
- 与 `task_end` 空区间错误(步骤 5,保留标记)语义正交:空区间表示"标记仍有效、区间尚空",abort 表示"放弃这个标记"——两种意图不可混淆。

### 3.4 区间计算规则(契约级定义)

设**栈顶**标记 seq 为 `M`,当前表面长度为 `L`(含本 step 的 assistant 节点)。**先算终点,再算起点**(起点上界受终点约束):

1. `mIdx = surface.nodes.indexOf(M)`;找不到 → §3.2 步骤 4 的 stale 错误。
2. **终点**:从 `L - 1` 向前(向标记方向)扫描到**第一个 `canEndEdge === true` 的位置**作为 `end`。task_end 自身的调用在 execute 期间永远未配对,本 step 的 assistant 节点及其后所有节点均不平衡,因此**本 step 必然整体排除在区间外**;扫描同时跳过历史 max-tokens 步遗留的未配对 tool-call 毒化尾部。扫描越过 `mIdx` 仍未找到 → §3.2 步骤 6 错误。
3. **起点**:`startPos0 = mIdx + 1`(标记节点的下一位置),从 `startPos0` 向后扫描到**第一个 `canStartEdge === true` 且 ≤ `end` 的位置**作为 `start`;该扫描跳过 begin-step 并行兄弟工具结果的配对。找不到 → 区间为空 → §3.2 步骤 5(`end > mIdx` 已由终点扫描步骤保证)。
4. 平衡校验双层:插件侧 advisory(同基座 §3.3),engine 侧 authoritative。

### 3.5 生命周期与失败语义

- 成功后**弹出栈顶标记**(一次弹一个);**一切失败路径保留栈顶标记**(含空区间、end 扫描失败与 engine 失败——继续工作或换方式后均可重试);仅 stale(栈顶 seq 已不在表面)弹出该栈顶标记,此时它已无意义。`task_abort` 显式弹栈顶(不压缩)。外层标记不受内层操作影响(栈隔离)。
- 嵌套分层:内层 `task_end` 先压缩内层区间;外层 `task_end` 的区间把内层摘要节点作为普通节点纳入再总结(层级化,信息按层递减)。
- 插件 stop/update/进程重启:标记栈随 apply 作用域销毁(不持久化,见 §1 范围外),之后 `task_end` 命中 "no active mark" 并引导重建。
- 区间内若 agent 手动调用过 `compact`/其他压缩:seq 翻译天然处理位置漂移;标记节点本身被压掉才触发 stale(该层标记弹出,外层照常)。

## 4. 模型行为保障(分层防御)

协议型工具无法**硬保证**模型正确调用;设计目标是:状态始终可见、误用自解释、忘记也无害。共六层,前四层已含在工具契约中,五、六层为本节新增的插件副作用:

| 层 | 机制 | 状态 |
|---|---|---|
| L1 | 工具描述写明触发时机("Call it alone in a step when a task begins" 等) | 已有(§3.1–3.3) |
| L2 | `depth` 回显:每次调用结果带回栈深度 | 已有(§3.1/3.2) |
| L3 | 误用路径全部为带 hint 的结构化错误,读错即知修法 | 已有(§3.2 步骤 3–6) |
| L4 | 失败安全:忘 begin=不压缩;忘 end=悬栈无副作用;误开可 abort;一切失败保栈 | 已有(§3.5) |
| L5 | **提示词章节**:`ctx.get('systemPrompt').section(...)` 注册任务生命周期约定(开始→task_begin 单独一步;完成→task_end;放弃→task_abort;嵌套 LIFO),出现在每个请求的系统提示中——持续行为契约,非调用时可见的说明 | 本节新增 |
| L6 | **悬栈动态回显**:`systemPrompt.context(...)` 注册动态上下文,每次请求注入 "open task marks: N"(N>0 时),悬栈状态对模型每一步可见,持续提醒收尾 | 本节新增 |

- L5/L6 注册自插件 ctx(作用域化、effect Scoped、stop/update 自动撤销);`systemPrompt` 服务在插件作用域可见已由探针实测,精确契约(PromptSection/PromptContext 形状)在实现期查询。
- 阶段二固化时,L5/L6 随插件进入 preset 组合,机制不变。
- **开放问题(默认不做)**:回合边界悬栈提醒(监听 turn 结束、悬栈时于下一请求注入提醒;不自动压缩,`repeat-tool-reminder` 为同类先例)——若 L5/L6 实测仍不足再评估;与用户已否决的事件驱动自动压缩(直接替模型调 task_end)是两回事。

## 5. 数据流 / 调用链

```
task_begin:  Model → task_begin.execute
               → 从表面尾部向回扫描最近 assistant/message 的 seq
               → 标记栈(本会话)压入 {seq} → {ok:true, depth}
task_end:    Model → task_end.execute
               → readSurface(session) 折叠(位置+平衡)
               → 栈顶 seq→位置翻译 + end 向回扫描 + start 向后扫描(受 end 约束)
               → agentPresets.serviceFor(agent,'compaction').compactRegion(startSeq,endSeq,agent,signal)
               → 成功:弹出栈顶,返回摘要+剩余深度;失败:保留栈顶,结构化错误
task_abort:  Model → task_abort.execute → 弹出栈顶,不压缩 → {ok:true, aborted:true, depth}
```

与基座 `compact` 的差异只有:区间两端不由参数给定,而由标记 + 当前表面位置推导。

## 6. 依赖与配置变更

零新增依赖。复用:`surface-reader`(折叠/平衡)、`agentPresets.serviceFor`(engine 寻址)、`harness.defineTool/registerTool`、`exec.signal`。标记状态 = apply 闭包内的 `Map<sessionId, Marker[]>`(每会话一个标记栈;按会话键控防跨会话/跨 agent 串扰,评审 B1)。

## 7. 文件变更清单

| 文件 | 操作 | 所属模块 |
|---|---|---|
| `docs/design/task-marker-compaction.md` | 新建 | 设计工件(本文件) |
| 动态 Plugin Package `cmpct-1/pkg-7`(append,不落盘) | 新建 | `task-marker` + 复用既有模块 |

## 8. 实现顺序

1. **设计评审通过**(本阶段) → 不写代码。
2. **模块 `task-marker`**(单包,三工具 + 提示词贡献同进):pkg-7 实现 `task_begin`/`task_end`/`task_abort`、L5 提示词章节与 L6 悬栈动态回显,复用 `surface-reader`。
3. **验证**:
   - (a) 正常路径:`task_begin` → 做一小段真实工作(若干工具调用)→ `task_end` → 表面出现 1 条摘要节点,区间 = 标记后到 task_end 前,栈清空;
   - (b) 无标记直接 `task_end` → 结构化错误;
   - (c) 嵌套(核心场景):`task_begin`(depth 1)→ 工作 → `task_begin`(depth 2)→ 工作 → `task_end`(内层压缩,depth 1)→ 工作 → `task_end`(外层压缩,区间包含内层摘要节点,depth 0);
   - (d) stale:栈顶标记节点被手动 `compact` 压掉后 `task_end` → 结构化错误且仅该栈顶弹出,外层照常;
   - (e) 空区间:标记后下一步立即 `task_end` → 结构化错误且**栈顶保留**,继续工作后再 `task_end` 成功;
   - (f) 与任务内手动 `compact` 混用(位置漂移)→ 区间仍正确;
   - (g) 并行边界:`task_end` 与其他工具并行调用(置于批处理末尾)→ 成功但本 step(含兄弟结果)整体排除在区间外;`task_begin` 与其他工具并行 → 向回扫描使标记仍指向本 step 的 assistant 消息,行为正确。
   - (h) 嵌套 shrink 失败(评审 M2):构造"外层除内层子任务外几乎无自身内容"的嵌套 → 外层 `task_end` 得到 `category:'summary'`(not smaller)结构化错误,栈顶保留、depth 不变 → 按 hint 恢复(继续做真实工作扩大区间后重试成功,或 `task_abort` 放弃)→ depth 归位。
   - (i) task_abort:空栈时 → 结构化错误;栈非空 → 弹顶不压缩(表面长度不变),depth 减一;abort 后再 `task_end` 作用于新的栈顶。
   - (j) 行为保障:L5 章节出现在组装后的系统提示中;L6 动态上下文在悬栈时显示 open task marks: N、栈空时不显示(实现期经 `systemPrompt.assemble` 或下一请求的运行时上下文核对)。
4. **收尾**:更新两篇设计文档状态,汇报;固化(阶段二)时与基座一起评估进入 preset isolate 域。

### 阶段一实测结果(2026-08-31,alpha 0.1.2-alpha.2,cmpct-1/pkg-8)

- **(a) 正常路径**:begin → 真实工作 → end,区间自动推导正确,压缩成功,depth 归 0。
- **(b) 空栈**:task_end → `no active task mark; call task_begin first` 结构化错误 ✓。
- **(c) 嵌套(核心)**:begin(1)→工作→begin(2)→工作→end(内层压缩 2396 tokens,depth 1)→end(外层压缩 3659 tokens,**区间含内层摘要节点**,层级化再总结成功,depth 0)✓。
- **(e/h) shrink 失败路径**:微小区间 end → engine 拒绝("not smaller"),**标记保留**、depth 不变;按提示继续真实工作扩大区间后重试成功 ✓。修复前后各验证一次(见下)。
- **(i) task_abort**:弹顶不压缩、表面长度不变、depth 减一 ✓。
- **(j) 行为保障**:L6 悬栈回显在标记存在时显示 "Open task marks: N"、栈空时不显示(两个方向均实测);L5 章节注册无错(与工具同作用域机制,间接验证)。
- **(g) 并行边界 / (d) stale / (f) 手动 compact 混用**:构造条件未在本会话出现,由契约与对账逻辑覆盖,留待固化阶段补充测试。
- **实测发现的实现偏差(已修复,pkg-7→pkg-8)**:engine 的 current-turn 区域压缩路径抛出的是**无 `code` 字段的普通 Error**,仅按 `err.code` 分类会把 "not smaller" 误归为 `other`。修复:category 分类改为 `err.code` 优先 + 消息特征 `/not smaller/i` 兜底 → 正确归入 `summary` 并触发两段式恢复提示(pkg-8 实测:category 'summary' + grow-hint + 标记保留)。该分类规则已并入实现,契约表述见 D6。

## 9. 风险与开放问题

- **标记在内存、更新即失**:pkg 更新/进程重启清空标记栈——`task_end` 报 "no active mark" 并引导重新 `task_begin`,语义闭环,不产生脏数据。
- **嵌套的信息递减(用户已接受)**:外层 task_end 的区间包含内层摘要节点,再总结时内层细节进一步衰减——这是层级化压缩的固有代价;若某层细节重要,应在更外层结束前显式保留(例如写入文件)。
- **嵌套的 shrink 边界与恢复(评审 B1 修订)**:若外层任务除内层子任务外几乎无自身内容,外层区间≈仅含内层摘要节点,engine 的 shrink 校验(分母 = 被替换段的 route token 总量)会失败(`category:'summary'`)。**恢复只能扩大分母**:继续做真实工作让区间增长后重试,或 `task_abort` 放弃该标记;"手动 compact 子区间"与"重新 task_begin"都会**缩小**分母,是错误指导(栈语义下 re-begin 也不能缩短失败标记的区间——起点固定于该 seq)。结构化错误 + hint 已按此口径给出。
- **嵌套误用**:忘记内层 task_end 时,LIFO 保证外层必须后结束——连续调用 task_end 会逐层展开,`depth` 回显使栈状态始终可见;连续多调 task_end 超过 begin 次数则报 "no active mark"。
- **并行调用边界(评审 B2 后的精确语义)**:task_end 自身调用在 execute 期间永远未配对,本 step(assistant 节点 + 兄弟结果)**必然整体排除**在区间外——与工具描述一致;被排除的兄弟结果仍留在表面,可被下一次压缩覆盖。begin 并行时,向回扫描保证标记指向本 step 的 assistant 消息而非兄弟结果(tool/result 可能被 pruner 重写,assistant 消息不会)。描述中的 "call it alone in a step" 是最佳实践(让兄弟结果进入区间),不是正确性前提。
- **模型误用**:忘记 task_end 只是不压缩;误开/放弃的标记用 `task_abort` 解除(栈语义下没有自愈覆盖,评审 M1——不解除会抬高 depth 回显并武装一次误触的大区间压缩)。
- **开放问题**:事件驱动自动触发(todo 完成/回合结束)留待观察显式版本效果后评估;是否需要按名结束任务(非 LIFO 乱序)观察实际用法后评估(当前显式排除)。

## 10. 决策记录

- **D1 — 触发方式**:显式调用 `task_end`(用户已确认);自动化不做。
- **D2 — 命名**:`task_begin` / `task_end`(用户已确认)。
- **D3 — 标记内容与区间推导**(评审 B2 修订):标记 = 从表面尾部向回扫描最近 `assistant/message` 的 seq(位置号会因压缩漂移,seq 稳定;assistant 消息不被 pruner 重写)。区间**先算终点再算起点**:end = 从 `L-1` 向回第一个 `canEndEdge` 位置(本 step 必然整体排除;跳过 max-tokens 毒化尾部),start = 标记后第一个 `canStartEdge` 且 ≤ end 的位置(跳过 begin-step 并行配对)。
- **D4 — 失败保留标记(评审 M1 修订)**:一切失败路径(含空区间与 end 扫描失败)保留标记,语义统一为 "cleared on success and kept on failure";仅 stale(seq 不在表面)清除。
- **D5 — 按会话键控的标记栈(评审 B1 + 用户嵌套要求)**:标记状态 `Map<sessionId, Marker[]>`,每会话一个栈;`task_begin` 压栈、`task_end` 弹栈顶(LIFO);压/弹/stale 只作用于本会话栈,杜绝跨会话串扰;`depth` 字段回显栈深度。
- **D6 — task_end 专属恢复语义(评审 B1 复审修订 + pkg-8 实测修订)**:`summary` 失败按成因二分——"not smaller"(区间分母太小)→ 唯一有效恢复是**继续真实工作扩大区间**后重试,或 `task_abort` 放弃;其余(summarizer 截断/无路由)→ 解决原因后重试。禁止"手动 compact 子区间 / 重新 task_begin"类指导(都只会缩小分母;栈语义下 re-begin 也无法缩短失败标记的区间)。**分类规则(实测)**:`err.code` 优先;engine current-turn 路径抛无 code 普通 Error,以消息特征 `/not smaller/i` 兜底归入 `summary`。
- **D7 — 嵌套语义(用户要求)**:严格 LIFO 栈;内层先结束、外层区间包含内层摘要节点(层级化再总结);不支持按名/乱序结束,避免栈语义歧义。(v3 起经 taskfold-review-fixes.md D-R1 回归此决策:工具层按名+LIFO——只能关最内层;投影层保持按名弹以回放旧日志。)
- **D8 — 显式放弃路径(评审 M1)**:`task_abort` 弹出栈顶标记、不压缩;与 `task_end` 空区间错误正交(标记有效 vs 放弃标记);弥补栈语义下误开标记无自愈出口的回归。
- **D9 — 行为保障分层(§4)**:无法硬保证模型行为,以六层防御逼近——工具描述/depth 回显/结构化错误/失败安全(已有)+ 提示词章节(L5)+ 悬栈动态回显(L6);回合边界悬栈提醒为开放项(只提醒不自动压缩,区别于已否决的事件驱动自动 task_end)。
- 阶段二固化决策与基座合并评估(进入 preset isolate 域,去掉 serviceFor 桥接)。

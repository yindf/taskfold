# Todo Bridge v2：事件式状态汇报 bridge

状态：已完成

## 实现偏离记录

用户评审实现时指出：fingerprint 跨渲染记忆（per-session Map + todosFingerprint）不必要——事件日志里本就有 `todo_write` 调用记录，检测"最近一条 assistant 消息含 todo_write 调用"即等效且完全无状态。最终实现采纳：删除 `todosFingerprint` 与 Map，新增 `lastAssistantHasTodoWrite(session)` 有界回扫（复用 recentWorkCallCount 的事件形状解析）；`todoBridgeLine(names)` 保留。测试 31/31 全绿（task-marks 20 + compact-stats 11）。

已知边界（接受）：todo_write 之后若同一轮内又发了其他 assistant 消息（无 todo_write），提醒行不出现——下次 todo_write 自愈；瞬态行只出现一轮，模型当轮未处理则等下次变化。

## 背景

现有 todo-bridge 是条件式催促（`inProgress > depth` 催 begin、`depth > inProgress` 催 fold），单任务 + 单 in-progress todo 的平衡态下完全静默，且计数启发经常与真实意图错位。用户决定（已确认）：**不要任何条件判断，只汇报现状**——当前 in-progress 的 todo 与当前 open 的 task——是否 task_begin / task_fold 由大模型自己决定。

事实核实：宿主 `dsh-tool-todo` 的 todo 形状 `{ content, status }`，`status ∈ { pending, in_progress | completed }`。

## 设计

### 语义（用户定稿）

todo 列表发生变化的那一轮，runtime context 出现一行汇报，要求模型合理管理任务；下一轮（todos 未再变）自动撤回：

```
Todo bridge: todos changed; open tasks: "fix-bridge", "add-tests" — keep task marks in sync: task_begin for new work, task_fold for finished work.
```

- 触发：todos projection 相对上次渲染发生变化（内容或状态任何差异，fingerprint 逐字符比较）。无 todo 能力（projection undefined）→ 永不出现。
- 内容：todo 侧只说 "todos changed"（变化本身），task 侧列具名 open task 名单（无则 `open tasks: none`），尾接一句管理指令。
- 何时 task_begin / task_fold 完全由模型判断，插件不做任何条件催促。
- 变化检测需要跨渲染记忆：inject 作用域 per-session Map（session.id → fingerprint），与 closingTasks 同模式；纯函数导出保证指纹与行渲染可离线测试。

### 纯函数（新增导出）

```js
export function todosFingerprint(todos)   // → string（稳定序列化，非对象项防御性跳过）
export function todoBridgeLine(names)     // → string（names: 具名 open task 名字数组，可为空）
```

### 保留的既有 nudge（不动）

Nudge-1（无任务时持续工作）、nudge-2（20+ 轮未关）仍按 byte-stable HOLD 语义保留。todo-bridge 原两条条件催促行（inProgress>depth / depth>inProgress）删除。

### 快照行为说明

本行是瞬态的（transient）：todo 变化轮出现、下一轮撤回，两次快照都是期望行为；fingerprint 记忆保证只有真实变化才出行，无逐轮刷屏。

## 文件变更清单（实现顺序）

1. `cmpct/plugins/compact-region.mjs`：新增导出 `todosFingerprint` / `todoBridgeLine`；inject 作用域 per-session fingerprint Map；context 回调 todo-bridge 段重写为事件式一行；头注释 + section 文案更新。
2. `cmpct/test/task-marks.test.mjs`：新增测试组：fingerprint 稳定性（同状态不同对象引用 → 同指纹；内容/状态变化 → 不同指纹；null/非对象项防御）、行渲染（多名、空名 → none）、名字含引号的转义防御。
3. `cmpct/README.md` + `cmpct/README.zh.md`：todo-bridge 描述改为事件式一行语义。
4. 本文档状态改"已完成"。

## 部署注意（非本设计范围）

- 宿主工具注册停在启动时的旧插件实例；生效需宿主重启或重新 apply cordis patch。
- 上线时在场的旧 bridge 行被替换/清除，产生一轮 diff 快照，属预期。

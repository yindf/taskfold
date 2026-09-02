# taskfold

[English](README.md) | [中文](README.zh.md)

让长会话保持精炼：把工作包进命名任务，做完即把整段折叠成一条带标题的短摘要。会话始终可读、上下文成本始终可控，而任何被折叠的原始内容都随时可以取回。面向 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）。

以插件包方式安装：

- `dsh plugin add` 装入 profile——工具族落在 host 平面，任何预设的每个会话都可用；会话组合未提供压缩引擎时自动自托管。

## 提供什么

四个模型工具：

| 工具 | 用途 |
| --- | --- |
| `task_begin({ name })` | 开启**命名**任务。名字即身份；状态由工具输出承载，零上下文注入。已开启的同名会被拒绝；名字不得含 " —"。 |
| `task_fold({ name })` | 关闭**最内层**开启任务并同步折叠（begin 对 + 正文）为单个摘要节点，标题自动取任务名——一次调用完成两件事。LIFO：更新的任务阻塞更早的任务；被阻塞或未知名失败是原子的（先关更新的任务再重试）。输出携带剩余任务、折叠号和**区间工件**路径。太小的跨度——或引擎不可用/标记被遮蔽——也照常结束任务，只是不折叠。 |
| `list_folds` | 折叠索引：每次折叠（1-based 时间序编号、tokens、标题/预览）+ 会话总量——`fold_recall` 消费的编号来源。 |
| `fold_recall({ fold })` | 临时工件被系统清理后，按折叠号**再生成**工件文件。仅此一个参数。 |

`plugins/compact-region.mjs` 提供生命周期工具；`plugins/compact-stats.mjs` 提供折叠索引 + 再生成（无服务依赖）。

### 区间工件（精确原始上下文）

每次折叠成功，把该跨度的**精确原始请求上下文**——模型当时收到的同一批消息，由宿主自己的 `session.deriveEventMessage(session.eventAt(seq))` 派生（引擎摘要器重放用的同一对 API）——以 JSON 写入系统临时目录（`taskfold-artifacts/`）：reasoning 块、工具调用参数、工具结果原样在内。`task_fold` 输出携带路径，模型用任意文件工具 read/grep。临时文件只是便利品，不是事实源——事实源是只追加日志，`fold_recall({ fold: N })` 随时可再生成任何工件。

任务的区间从 begin 锚点一直延伸到**折叠时刻的最后一个表面节点**——任务最后的正文消息进入**自己**的折叠（绝不落入父任务），因此嵌套折叠各自都能 recall 到完整原始上下文。自动压缩保留自己的活边缘余量；显式 task 折叠不需要，且正在执行的折叠步骤本身永远不在区间内（即使宿主提前提交该步骤也有防御）。

### 引擎（scoped，自托管）

显式折叠（`task_fold`）始终走插件自己的 `ScopedEngine extends BasicCompactionEngine`：只覆写 `summarize()`——把原版连续性检查点指令换成**区间摘要**指令（只总结区间内发生的事，受众是续写会话的模型，绝不复述项目背景），并**声明任务已关闭**（区间无法包含自己的结尾，由指令代偿）——锁、校验、稳定性检查、提交路径全部原装。LLM 调用重放同一前缀（供应商前缀缓存复用保留），只换末尾指令。

组合行的引擎（`dsh-compaction-basic`）刻意留给**自动**压缩（压力/溢出）——那里检查点语义恰好正确。两个实例通过事件日志的持久锁天然互斥。ScopedEngine 在 shim ctx 上构造（不与服务注册冲突）、`auto: false`；先裸导入（profile 安装场景），失败则从宿主锚点向上找到引擎包的 `node_modules` 按文件 URL 导入。

只依赖 host 平面服务（`tokenMeter`、`llm`），因此在**完全没有 compaction 组**的组合里也能折叠——已在 `minimal` 派生预设和 profile 安装下实测。引擎包完全解析不到时 `task_fold` 优雅降级：任务照常关闭、不折叠（解析结果在进程生命周期内缓存）。兼容 dsh 0.1.2-alpha.4 的按需会话 API（`snapshotEvents()`；旧版的 `session.events` 亦受支持）。

### 状态模型

- 开启的任务是**命名派生态**：`taskMarks` 会话投影只折叠宿主原生事件——工具调用块注册待定意图，工具结果文本（`Task begun: NAME` / `Task folded: NAME`）按名压栈/弹栈。工具层关闭是 LIFO（只能关最内层；投影本身保持按名弹，LIFO 之前的旧日志回放不变）；失败的 `task_fold` 不改变任何状态（原子结束即折叠）。
- 标记穿越宿主重启、会话恢复和压缩（只追加日志）。无名的 legacy 标记在投影加载时自愈清除。

### 生命周期催办（hold 语义）

干净的 begin→work→end 流程全程静默。流程被跳过时催办行出现并**驻留**（每轮渲染、字节稳定）直到条件消失——diff 驱动的快照引擎让驻留行等待期间零开销，条件消失只产生一条撤回。年龄以**模型轮次**计量，绝不用原始事件 seq。

| 信号 | 驻留条件 | 提示 |
| --- | --- | --- |
| 无任务干活 | 无开启任务、最近 10 轮 ≥3 次非任务工具调用（task_fold 后 3 轮宽限） | `task_begin({ name })` |
| 任务开太久 | 任一开启标记满 20 轮（点名最老的那个） | `task_fold({ name })` |

另有一个 todo 桥接做状态汇报：模型调用 `todo_write` 后的下一轮出现一行瞬态提示——`Todo bridge: todos changed; open tasks: …`——要求模型保持任务标记同步（新工作 `task_begin`、完成工作 `task_fold`），再下一轮自动撤回。它是现状汇报而非条件催促：决策留给模型，且不包装原生 `todo_write` 工具。

## 安装

**插件包**（任意 profile；所有会话可用）：

```sh
dsh plugin --profile web add github:yindf/taskfold
```

装完重启 dsh。

## 目录

```
package.json      npm 清单 + dsh.bundle.patch 声明
cordis.patch.yml  host 平面 bundle 补丁（插件安装路径）
plugins/          compact-region.mjs、compact-stats.mjs
test/             离线测试套件（node test/*.test.mjs）
CHANGELOG.md      发布历史
```

## 许可

MIT。基于 DeepSeek Harness（`@deepseek-ai/*`，MIT）公开包开发。

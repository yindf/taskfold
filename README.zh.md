# taskfold

[English](README.md) | [中文](README.zh.md)

让长会话保持精炼：把工作包进命名任务，做完即把整段折叠成一条带标题的短摘要。会话始终可读、上下文成本始终可控，而任何被折叠的原始内容都随时可以取回。面向 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）。

两种安装方式：

- **插件包**（推荐）：`dsh plugin add` 装入 profile——工具族落在 host 平面，任何预设的每个会话都可用；会话组合未提供压缩引擎时自动自托管。
- **Agent 预设**：克隆到 `.agent-presets/`——完整 `cordis` 编码代理组合 + compaction realm 内的 taskfold 工具。

## 提供什么

七个模型工具：

| 工具 | 用途 |
| --- | --- |
| `task_begin({ name })` | 开启**命名**任务。名字即身份；状态由工具输出承载，零上下文注入。 |
| `task_fold({ name })` | **按名关闭任务并同步折叠**（begin 对 + 正文）为单个摘要节点，标题自动取任务名——一次调用完成两件事。失败是原子的：标记保留、可重试。输出携带剩余任务、折叠号和**区间工件**路径。太小的跨度照常结束但不折叠。 |
| `list_folds` | 折叠索引：每次折叠（编号、tokens、标题/预览）+ 会话总量——`compact_recall` 消费的编号来源。 |
| `compact_recall({ fold })` | 临时工件被系统清理后，按折叠号**再生成**工件文件。仅此一个参数。 |

`plugins/compact-region.mjs` 提供生命周期工具；`plugins/compact-stats.mjs` 提供折叠索引 + 再生成（无服务依赖）。

### 区间工件（精确原始上下文）

每次折叠成功，把该跨度的**精确原始请求上下文**——模型当时收到的同一批消息，由宿主自己的 `session.deriveEventMessage(session.eventAt(seq))` 派生（引擎摘要器重放用的同一对 API）——以 JSON 写入系统临时目录（`taskfold-artifacts/`）：reasoning 块、工具调用参数、工具结果原样在内。`task_fold` 输出携带路径，模型用任意文件工具 read/grep。临时文件只是便利品，不是事实源——事实源是只追加日志，`compact_recall({ fold: N })` 随时可再生成任何工件。

### 引擎（scoped，自托管）

显式折叠（`task_fold`）始终走插件自己的 `ScopedEngine extends BasicCompactionEngine`：只覆写 `summarize()`——把原版连续性检查点指令换成**区间摘要**指令（只总结区间内发生的事，受众是续写会话的模型，绝不复述项目背景），并**声明任务已关闭**（区间无法包含自己的结尾，由指令代偿）——锁、校验、稳定性检查、提交路径全部原装。LLM 调用重放同一前缀（供应商前缀缓存复用保留），只换末尾指令。

组合行的引擎（`dsh-compaction-basic`）刻意留给**自动**压缩（压力/溢出）——那里检查点语义恰好正确。两个实例通过事件日志的持久锁天然互斥。ScopedEngine 在 shim ctx 上构造（不与服务注册冲突）、`auto: false`；先裸导入（profile 安装场景），失败则从宿主锚点向上找到引擎包的 `node_modules` 按文件 URL 导入。

只依赖 host 平面服务（`tokenMeter`、`llm`），因此在**完全没有 compaction 组**的组合里也能折叠——已在 `minimal` 派生预设和 profile 安装下实测。兼容 dsh 0.1.2-alpha.4 的按需会话 API（`snapshotEvents()`；旧版的 `session.events` 亦受支持）。

### 状态模型

- 开启的任务是**命名派生态**：`taskMarks` 会话投影只折叠宿主原生事件——工具调用块注册待定意图，工具结果文本（`Task begun: NAME` / `Task folded: NAME`）按名压栈/弹栈。按名关闭不可能破坏其他任务；失败的 `task_fold` 不改变任何状态（原子结束即折叠）。
- 标记穿越宿主重启、会话恢复和压缩（只追加日志）。无名的 legacy 标记在投影加载时自愈清除。

### 生命周期催办（hold 语义）

干净的 begin→work→end 流程全程静默。流程被跳过时催办行出现并**驻留**（每轮渲染、字节稳定）直到条件消失——diff 驱动的快照引擎让驻留行等待期间零开销，条件消失只产生一条撤回。年龄以**模型轮次**计量，绝不用原始事件 seq。

| 信号 | 驻留条件 | 提示 |
| --- | --- | --- |
| 无任务干活 | 无开启任务、最近 10 轮 ≥3 次非任务工具调用（task_fold 后 3 轮宽限） | `task_begin({ name })` |
| 任务开太久 | 最新开启标记满 20 轮 | `task_fold({ name })` |

另有一个 todo 桥接，把进行中的 todo 与任务标记配对（不包装原生 `todo_write` 工具）。

## 安装

**插件包**（任意 profile；所有会话可用）：

```sh
dsh plugin --profile web add github:yindf/taskfold
```

**Agent 预设**（完整 `cordis` 组合 + taskfold）：

```sh
git clone https://github.com/yindf/taskfold "$(dsb="${DSH_HOME:-$HOME/.dsh}"; echo "$dsb/.agent-presets/taskfold")"
```

两种方式装完都要重启 dsh。不要在同一进程同时挂两种——工具名在共享注册表，重复注册会失败。

> **信任提示：**预设形态携带自指的 Cordis 工具集——其上的会话可以读写自己运行所在的 harness，视同 shell 权限。插件包形态只含工具。

## 目录

```
package.json      npm 清单 + dsh.bundle.patch 声明
cordis.patch.yml  host 平面 bundle 补丁（插件安装路径）
preset.yml        预设元数据
agent.cordis.yml  完整组合（预设路径）
plugins/          compact-region.mjs、compact-stats.mjs
test/             离线测试套件（node test/*.test.mjs）——32 项
CHANGELOG.md      发布历史
```

## 损坏边界策略

若表面事件缺失（如外部折叠后），边界标记从断裂处到下一个用户消息边界之间不可信，随后配对账目重新基线——单个损坏点不会禁用会话余下部分的压缩。

## 许可

MIT。基于 DeepSeek Harness（`@deepseek-ai/*`，MIT）公开包开发。

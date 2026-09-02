# cmpct

[English](README.md) | [中文](README.zh.md)

面向 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）的任务生命周期会话压缩：**命名任务**的完整跨度折叠为单个摘要节点、手动区间压缩、归档回看，以及 hold 语义的生命周期催办。

两种安装方式：

- **插件包**（推荐）：`dsh plugin add` 装入 profile——工具族落在 host 平面，任何预设的每个会话都可用；会话组合未提供压缩引擎时自动自托管。
- **Agent 预设**：克隆到 `.agent-presets/`——完整 `cordis` 编码代理组合 + compaction realm 内的 cmpct 工具。

## 提供什么

七个模型工具：

| 工具 | 用途 |
| --- | --- |
| `task_begin({ name })` | 开启**命名**任务。名字即身份；状态由工具输出承载，零上下文注入。 |
| `task_end({ name })` | **按名**关闭任务（终局、纯状态转移）。记录结束跨度（begin 对 + 正文 + end 对）待折叠。 |
| `task_commit` | 将结束任务的完整跨度折叠为单个摘要节点，标题自动取任务名。`task_end` 结果在折叠范围内，摘要看到的是**已完成**的任务——没有过期的"call task_end"。太小的跨度如实上报并持久放弃。 |
| `compact_inspect` | 只读列出会话表面：位置、角色、预览、合法压缩边界。 |
| `compact(start, end)` | 把显式表面区间压缩为单个摘要节点。 |
| `compact_stats` | 可观测性：表面长度、每次折叠（tokens、预览、标题）、累计总量、漂移告警。 |
| `compact_recall` | 从只追加的事件日志读回被折叠条目的**原始内容**——折叠清单、单条、seq 区间、`full` 全文模式。 |

`plugins/compact-region.mjs` 提供五个生命周期/区间工具；`plugins/compact-stats.mjs` 提供统计 + 回看（无服务依赖）。

### 引擎分层（realm / 自托管）

可折叠工具（`compact`、`task_commit`）惰性解析压缩引擎：

1. **Realm 引擎**——组合里已有的 `dsh-compaction-basic` 行注册的 `ctx.compaction`。经 `ctx.get('compaction')` 探测；命中即直接使用，不构造任何东西。
2. **自托管**——`new BasicCompactionEngine(ctx, { auto: false })`：不注册自动压缩监听、不带触发策略，只有 `compactRegion`。先裸导入（profile 安装场景），失败则从宿主锚点向上找到引擎包的 `node_modules` 按文件 URL 导入。

第二层只依赖 host 平面服务（`tokenMeter`、`llm`），因此在**完全没有 compaction 组**的组合里也能折叠——已在 `minimal` 派生预设和 profile 安装下实测。兼容 dsh 0.1.2-alpha.4 的按需会话 API（`snapshotEvents()`；旧版的 `session.events` 亦受支持）。

### 状态模型

- 开启的任务是**命名派生态**：`taskMarks` 会话投影只折叠宿主原生事件——工具调用块注册待定意图，工具结果文本（`Task begun: NAME` / `Task ended: NAME`）按名压栈/弹栈。按名关闭不可能破坏其他任务；失败不改变任何状态。
- 成功的 end 记录 `lastEnded { beginSeq, endSeq, name }`（持久化、重启安全）；`task_commit` 折叠该跨度；覆盖它的 `compaction/summary`——或终局的 too-small 裁决——清除记录。
- 标记穿越宿主重启、会话恢复和压缩（只追加日志）。无名的 legacy 标记在投影加载时自愈清除。

### 生命周期催办（hold 语义）

干净的 begin→work→end→commit 流程全程静默。流程被跳过时催办行出现并**驻留**（每轮渲染、字节稳定）直到条件消失——diff 驱动的快照引擎让驻留行等待期间零开销，条件消失只产生一条撤回。年龄以**模型轮次**计量，绝不用原始事件 seq。

| 信号 | 驻留条件 | 提示 |
| --- | --- | --- |
| 无任务干活 | 无开启任务、最近 10 轮 ≥3 次非任务工具调用、且无未决折叠问题（任何 end/commit 结局后 3 轮宽限） | `task_begin({ name })` |
| 任务开太久 | 最新开启标记满 20 轮 | `task_end({ name })` |
| end 后未 commit | `task_end` 后下一步不是 `task_commit` | `task_commit` |

另有一个 todo 桥接，把进行中的 todo 与任务标记配对（不包装原生 `todo_write` 工具）。

## 安装

**插件包**（任意 profile；所有会话可用）：

```sh
dsh plugin --profile web add github:<you>/cmpct
```

**Agent 预设**（完整 `cordis` 组合 + cmpct）：

```sh
git clone https://github.com/<you>/cmpct "$(dsb="${DSH_HOME:-$HOME/.dsh}"; echo "$dsb/.agent-presets/cmpct")"
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

<p align="center">
  <img src="https://raw.githubusercontent.com/yindf/taskfold/master/assets/banner.zh.png" width="100%" alt="taskfold —— 给你的编程智能体，近乎无限的上下文" />
</p>

<p align="center"><b>给你的编程智能体，近乎无限的上下文</b></p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/yindf/taskfold/releases/latest">Releases</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center">
  <a href="https://github.com/yindf/taskfold/releases/latest"><img src="https://img.shields.io/github/v/release/yindf/taskfold?style=flat-square&color=4c8dff" alt="最新版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT 许可"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c8dff?style=flat-square" alt="DeepSeek Harness 插件"></a>
</p>

让长时间的 AI 编程会话保持快速、便宜、可读：完成的工作被折叠成一条短摘要，完整原始内容随时一条命令取回。

面向 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）。

## 快速开始

```sh
dsh plugin --profile <你的profile> add github:yindf/taskfold
```

重启 dsh——该 profile 下的每个会话都拥有这些工具。之后智能体用命名任务包住自己的工作：

```
task_begin("修复登录 bug")   … 干活 …   task_end("修复登录 bug")
```

整段来回就此折叠成一条带标题的摘要，`fold_recall` 随时能读回原始内容。

## 它解决什么问题

长会话会被自己的历史淹没：每个请求都在重发几小时前就完成的工作——旧的工具输出、调试日志、失败的尝试。成本越滚越高，模型注意力被稀释，上下文窗口迟早被塞满。

taskfold 用“好笔记本”的方式解决：干活前，智能体先用 `task_begin("修复登录 bug")` 开一个任务；做完后 `task_end` 关闭任务，**同时**把整段来回替换成一条带标题的短摘要：

```
之前：  [800 条原始调试消息……]
之后：  「修复登录 bug」— 摘要：试了什么、为什么失败、改了什么、
        用户拍板了什么。（约一屏）
```

会话保持可读，每个请求都更便宜，模型带走的是**经验**而不是**流水账**。

**什么都不丢。** 每次折叠都会把原始消息原样存成文件，`fold_recall({ fold: N })` 随时能重新生成。先折叠、后查阅——像合上一本随时能翻开的书记。

## 与 dsh 内置压缩的关系

同一个目标，不同的时机——两者可以叠加。

- **dsh 内置压缩是自动的、由压力驱动的。** 它在窗口快满时触发，按 token 压力选出一段区间替换成摘要；原始事件仍留在会话日志里，只是被 shadow 掉，而不是删除。
- **taskfold 是显式的、按任务划分的。** 每完成一个任务就顺手折叠一次，摘要是趁那一段还在上下文里时写下的——天然准确——而且带标题，会话始终可导航。
- **因为你折叠得早，窗口很少被塞满。** 下面实测会话的峰值是 20.7% 而不是 59.5%，于是压力压缩要么更晚触发、要么根本不触发；真触发时，需要总结的东西也更少。
- **每一次折叠都可寻址。** `fold_recall({ fold: N })` 取回的是原始消息，不是二手摘要。

## 原理（通俗版）

- **命名任务。** 智能体开工前开任务、完工后关任务。开启状态跨重启不丢；关闭按嵌套顺序（内层先关）；关闭失败不会破坏任何状态——重试即可。
- **折叠 = 关闭 + 总结，一次调用完成。** 摘要在原始内容还在上下文里时一次性写好，所以准确——不是“摘要的摘要”。
- **摘要保留要紧的东西。** 总结指令明确要求保留用户的关键决策与反馈（措辞重要处原文照录）、踩过的坑和*为什么*失败、改了什么、最终结果。
- **温和护栏。** 智能体忘记纪律时，上下文里会出现一条简短提示。提示是事件而非状态：只在条件出现或措辞变化时发布一条；条件解除后什么都不发（模型已经照做了，不需要再被告知）；没有包装标签、没有取代声明、也没有过期通知——流程健康时零噪音。
- **对缓存友好。** 折叠只改写历史中段；稳定前缀（系统提示词、工具、更早的上下文）保持缓存命中。

## 省了多少（实测）

一次真实会话——411 个模型步、26 次折叠——数字直接读自 harness 自己的用量记录：

| | 不折叠 | 用 taskfold |
| --- | --- | --- |
| 提示 token 总量 | 142,654,308 | 52,127,098（**−63.5%**） |
| 单次请求最大体积 | 594,909 | 206,896（−65%） |
| 峰值上下文窗口占用 | 59.5% | 20.7% |

机制：折叠把 **441,100 token** 的已完成工作移出表层。这些历史本来会在之后每个请求里被重发一遍，累计下来就是 **90,527,210 token 从未发出**。生成那 26 条摘要本身花了 3,550,270 token（相当于节省量的 3.9%，且其中大部分是缓存读取）；单次折叠最多一次性移走 40,422 token。

这些被省下的 token 大多是缓存**读取**而非全新输入——单价更低，但依然计费、依然占窗口。会话再长一些，这就成了「还在窗口内」和「已经塞满」的区别。

一次会话、一种任务形态——你的数字会不同；关键是机制：完成的工作离开表层，稳定前缀持续命中，模型带走经验而不是流水账。

## 它添加了什么

四个智能体工具（加上上述提醒机制）：

| 工具 | 一句话 |
| --- | --- |
| `task_begin({ name })` | 开一个命名任务。 |
| `task_end({ name })` | 关闭它，并把整段折叠成一条带标题的摘要。 |
| `list_folds` | 列出全部折叠（编号、大小、标题）。 |
| `fold_recall({ fold })` | 按需取回任意折叠的原始内容。 |

## 其他安装方式

每个 Release 都附带预构建的 `dsh-taskfold-<版本>.tgz`。插件市场会优先提供该资产而不是源码构建命令，同时也免去 dsh 的 `allowBuilds` 构建授权——见[最新 Release](https://github.com/yindf/taskfold/releases/latest)。

## 支持的 dsh 版本

- **alpha 通道 —— 支持到 `0.1.5-alpha.1`**（2026-09-09 实测：离线测试套件 83 个测试全绿；针对真实 `dsh-compaction-basic`/`dsh-llm`/`dsh-session` 包的宿主 API 探针——引擎类导出、`summarize` 钩子、`BlockAssembler`、会话 surface/`deriveEventMessage` 接口，以及用插件自己的 shim ctx 构造 `ScopedEngine`；经由真实引擎与装配器的端到端折叠——前缀锚定信封、带真行号的围栏式 span 索引、span 字节零改动、归档 footer 行号准确；接缝审计确认 `agent/pre-step`、`agent/turn-stopping`、`sessionProjections.register`/`stateOf`、`systemPrompt.section`/`context`、`tools.register` 与 `dsh-compaction-basic` 的 compaction 判别器形态均未变；以及在运行中的 0.1.5-alpha.1 宿主上活体折叠，挂载副本与本仓库 HEAD 逐字节一致。本轮无需改代码。发现一处宿主侧 API 漂移：`dsh-session` 移除了 `decodeStorageRecord`/`packChunkRuns` 导出，而本插件从不使用它们——只 import `dsh-compaction-basic` 与 `dsh-llm`——因此依赖它们的离线区域事务回放本轮未重跑，该路径改由活体折叠覆盖）。
- **rc 通道 —— 支持到 `0.1.2-rc.1`**（2026-09-07 实测：离线测试套件 + 真实包宿主 API 探针 + 用真实 `dsh-compaction-basic` 区域事务离线回放线上会话日志 + 重启宿主上的进程内子任务活体折叠——普通与并行 `task_begin` 两种拓扑、`fold_recall` 回读、重启时排队归档自动排干；该轮验证抓出并修复了一个并行 `task_begin` 的折叠起点缺陷）。`dsh`、`dsh-compaction-basic`、`dsh-llm` 三者版本锁步发布，一个数字覆盖全部耦合面。
- **上界：未测试、未强制。** dsh 尚未向插件提供宿主版本协商机制，不兼容的宿主不会被自动拒绝——在不兼容的 dsh 上，折叠会降级（任务照常关闭、不折叠），不会损坏数据。每次 dsh 升级后，请复核本节并按实测结果更新。
- **可选钩子：`agent/turn-stopping`** —— 0.26.0 起归档排干还会在回合结束时运行，让回合末交付的折叠赶在 provider 前缀缓存还热时执行。没有该钩子的宿主保持原来的纯 pre-step 语义（折叠照常发生，只是晚一个回合）；注册语句整体包裹，钩子缺失不会破坏 `apply()`。

## 维护者须知

- 目录：`plugins/`（两个挂载行 `compact-region.mjs` 与 `compact-stats.mjs`，及其共享纯模块 `events.mjs`、`task-marks.mjs`、`fold-instruction.mjs`、`fold-engine.mjs`、`fold-drain.mjs`、`lifecycle-nudges.mjs`、`lifecycle-injection.mjs`、`span-preview.mjs`）、`scripts/release.mjs` 与 `scripts/verify-cache.mjs`、`test/`（`npm test`）、`assets/`（README banner 与仓库设置里上传的社交预览图）、`CHANGELOG.md`。
- 发版：`node scripts/release.mjs draft` → 审阅 CHANGELOG 条目 → `node scripts/release.mjs release`（CHANGELOG 是版本唯一事实源）。若本次发版改变了支持的 dsh 版本范围，发版前先更新**两份** README 的“支持的 dsh 版本”一节——release 脚本会提醒。该节保持**每个通道一行**：最新的 alpha 一条、最新的 rc 一条；历史 alpha / rc 条目直接删掉，不要罗列。
- **折叠缓存校验是流程的一部分。** 每次 dsh 升级后——以及任何触及折叠信封的发版前——对一份 live 会话日志跑 `node scripts/verify-cache.mjs --since-restart`，并把数字记进 CHANGELOG 条目。若某次折叠的摘要调用重新付费了它的 span——判据是 `uncached − span > --tail-budget`（tail 为正）——脚本以非零码退出，这正是前缀信封不再匹配宿主摘要输入的 signature。离线测试只能钉住结构前提（只有一个 system 消息、严格前缀）；真实缓存命中只能由 live 日志给出。
- 设计决策与历史见 `CHANGELOG.md` 及源仓库中的设计笔记。

## 许可

MIT。基于 DeepSeek Harness（`@deepseek-ai/*`，MIT）公开包开发。

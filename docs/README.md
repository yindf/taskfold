# 文档索引

开发与设计文档。**不随 npm 包发布**——`package.json` 的 `files` 白名单只含 `plugins/`、两份 README、`CHANGELOG.md`、`LICENSE`、`cordis.patch.yml`。

## design/ — 设计与实现记录

| 文档 | 主题 |
| --- | --- |
| `design/compact-region-tool.md` | 局部上下文压缩工具（`compact` / `compact_inspect`）；阶段一验证，阶段二固化待批准 |
| `design/deferred-report-fold.md` | Deferred Fold v5：全 deferred + 交付门控自动折叠（0.15.0 实施） |
| `design/fold-recall-range.md` | `fold_recall` 区间重载（`from`/`to`）（0.27.0） |
| `design/fold-summary-prompt-v2.md` | 折叠摘要 prompt v2：user inputs / pitfalls 升为一等段落 |
| `design/lazy-fold.md` | Deliver-then-Fold：交付先行、立即折叠 |
| `design/release-flow.md` | 发布流程（`scripts/release.mjs`）：`draft` / `release` / `assets` / `status` |
| `design/stage2-preset-solidification.md` | 阶段二固化：compact-region 进驻用户 preset |
| `design/task-marker-compaction.md` | 任务区间自动压缩（`task_begin` / `task_end`） |
| `design/task-stack-ui.md` | **task 栈实时显示**（Web 客户端 dock）：wire、客户端半件、卡片几何、归档见证收敛 |
| `design/taskfold-review-fixes.md` | 代码评审问题处理 |
| `design/todo-bridge-v2.md` | Todo Bridge v2：事件式状态汇报 |
| `design/turn-stop-drain-and-indexed-preview.md` | turn-end 自动折叠 + 指令内索引 + 归档预览瘦身 |
| `design/what-happened-granularity.md` | What happened 粒度规则（数值锚点 + 预算免责） |

## adr/ — 架构决策记录

| 文档 | 决策 |
| --- | --- |
| `adr/0001-turn-stopping-drain.md` | turn-stopping 排干：折叠时点的缓存经济学 |
| `adr/0002-index-in-instruction.md` | 行号供给：目录放进指令 + 归档 footer 瘦身 |

## 布局说明

根目录保留两份历史设计文档，**故意不迁入 `design/`**：

- `design-compact-stats.md`
- `scoped-summary-acceptance.md`

原因有二：`CHANGELOG.md` 按这两条路径引用它们（历史条目不追改路径）；且 `design/taskfold-review-fixes.md` 已明文记录"`cmpct/docs/` 下历史设计文档按计划保留不回改"。

# Fold Summary Prompt v2 — user inputs & pitfalls as first-class sections

Status: 已完成（0.2.2）

## 背景

外部诉求：task_fold 的压缩摘要提示词应保留折叠区间内的踩坑记录、用户输入等重要信息。参考对象是宿主 `dsh-compaction-basic` 的全量压缩提示词（8 节 continuity checkpoint，L225-254）。

## 决策

- 保留 span-scoped 哲学：fold 只总结区间内，不回灌区间外已有的背景（宿主提示词的核心差异点）。
- 结构 3 节 → 5 节：新增 `## User inputs & decisions`（区间内用户的要求、纠正、否决、回答、批准，措辞重要处 verbatim）与 `## Pitfalls & gotchas`（失败尝试及原因、绕行、环境陷阱、"别再做 X"教训）。
- 规则区新增两条（借自宿主、按 fold 语义改写）：忠实保留用户反馈尤其纠正；坑与原因是区间最有复用价值的知识，不得丢"为什么失败"。
- 明确不搬宿主的 `Pending Jobs / Current Work / Next Step / Primary Request`：它们与 fold 的 "This fold CLOSES the task" 声明矛盾（任务已关、会话其余上下文仍活着）。测试以 banned-words 断言固化。
- 实现载体：`SCOPED_SPAN_INSTRUCTION` 从 inject 作用域提为模块级导出 `FOLD_SUMMARY_INSTRUCTION`（与纯函数导出测试模式一致），调用点不变（拼接 closing 声明）。

## 记录不处理

- 旧 fold 摘要仍是 3 节结构，新旧混排只影响观感；原文均可 fold_recall 取回，无损。
- 提示词增长约百余 token/次 fold，相对区间本身可忽略。
- README 未描述摘要结构，无需同步。

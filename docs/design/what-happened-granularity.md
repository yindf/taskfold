# 设计：What happened 粒度规则（数值锚点 + 预算免责）

> 状态：已实现（0.28.0 未发布草稿，与 Reasoning 规则同批）
> 创建：2025-11-27（会话内日期 2026-09-07）

## 背景

0.26.0 的走查式摘要允许"consecutive steps MAY cluster into one phase bullet"
但无上限。实测（fold 17，0.27.0 会话）：摘要器把 ~37 条消息（L20-L56）打包进
单个 bullet，用分号串联子动作——事实保真，但扫描粒度与逐动作召回锚点退化。
三臂受控实验的自然密度是 4-9 条消息/bullet：问题在许可而非能力。

用户裁定：What happened 不受预算限制，**覆盖精度是主要目标**；给出可靠、
稳定的提示词约束。

## 规则（最终措辞见 fold-instruction.mjs）

1. **步的单位**：a step = one assistant action together with its tool results
   (typically 2-4 span lines)——消除"步"的歧义。
2. **数值锚点**：one bullet per phase of 3-5 steps；**10 is the hard ceiling**，
   超限 MUST 拆分为连续 bullet，各自保留 `L<N>-<M>`。
3. **反打包**：Never join distinct actions with separators inside one bullet
   （针对实测病灶）。
4. **预算免责**：Coverage is a correctness requirement that outweighs the word
   budget——词不够时写更短的 bullet，绝不减条、合并、丢弃；Budget 规则同编辑
   声明 "The budget shapes prose economy, never coverage"。

## 为什么安全（自限性）

硬上限本身就是界：bullet 数 ≥ span_lines/30，实践中 5-30 个 bullet
（300 行 span ≈ 20-33 个 ≈ 400-700 词），远低于 4000 词预算与 maxTokens；
不存在失控路径，无需引擎侧校验。

## 追加：Reasoning 规则（同批 0.28.0）

用户追加观察：0.27.0 的摘要只有动作、没有任何推理过程——决策理由只存在于
thinking 块，折叠即失传；而动作可从工件/代码反推，推理不可再生。

规则（最终措辞见 fold-instruction.mjs）：

- 节描述行追加：`AND the reasoning behind the work: why this path, which
  alternatives were rejected and why`。
- 专职 Reasoning 规则：thinking blocks 是决策理由的一手来源（假设权衡、
  路径取舍、结果证实/证伪）；bullet 必须写 `not only WHAT was done but WHY`，
  锚定决定性考量；保留被否决的备选与其败因；区分定论与猜测。
- 分工边界：失败原因归 Pitfalls & gotchas（既有规则），选择理由归
  What happened。

## 不做的事

- 引擎侧 bullet 数/行数硬校验：步骤定义本身有模糊性，误伤率高（沿此前
  "L<N> 越界校验"同一裁定）。
- 其他四节的预算语义不变（Changes 仍穷举、Pitfalls 仍保失败原因）。

## 追加：预算机制整体移除（0.29.0，用户裁定"从机制上就不要限制"）

0.28.0 发布后用户进一步裁定：不要预算免责，**把预算相关的规则与代码全部去掉**。

- 引擎侧：删除 estTokens/wordBudget/budgetLine 计算与注入；折叠调用不再设
  `maxTokens`（机制层不设长度限制，provider 默认与宿主 not-smaller 拒绝兜底）。
- 指令侧：Budget 规则整体删除，代之以 Sections 规则（仅保留覆盖职责：忠实
  不注水、"(none)" 如实、Changes 穷举、Pitfalls 保全失败原因、压缩叙事优先、
  绝不动锚点/决策/失败原因）；Granularity 规则的预算引用改为
  "when detail must compress, write terser bullets — never fewer bullets,
  never merged, never dropped"。
- 上文"预算免责"与"安全（自限性）"中涉及预算/ maxTokens 的表述自此作废；
  自限性论证仍然成立（3-5 步/bullet 的数值规则本身界定 bullet 数）。

## 验证（0.29.0 后）

- 离线：fold-instruction.test.mjs 断言指令中不出现 "budget" 字样；
  task-marks.test.mjs 的旧 10% 预算断言翻转为排除断言。
- 在线：发布后观察真实大 fold 的 What happened bullet 数与区间分布。

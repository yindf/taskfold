# Deliver-then-Fold（交付先行、立即折叠）设计

状态：**最终定稿（converged）**——4 轮迭代评审（R1-R3 lazy 形态收敛后被产品所有者否决时序；R4 按"交付先行、立即折叠"形态复核通过，机制零改动确认）
目标版本：0.13.0
前置：v0.12.0

## 1. 问题与方案演进

fold-first 契约（先折、报告从摘要 relay）被实证有质量缺陷。lazy fold（折到下一回合）经三轮评审收敛，但被产品所有者否决：done 状态滞留导致上下文混乱 + KV cache 失效面扩大（折叠越晚、region 后已缓存 token 越多）。最终洞察：**缺陷根因不是折得早，而是折在交付之前**。

## 2. 最终契约

**任务完成 → 同回合先写报告/交付物（全上下文）→ 立即 task_fold。**

- 报告先落表面节点 → 现行区间末端（最后节点）自然包含报告 → 摘要以高质量报告为素材
- done 零滞留：表面永远是活跃工作，无交错归属问题；KV 失效面最小
- 机制**零改动**：foldDecision / execute / 平衡边界回退 / nudge 全部保持 v0.12.0 现状；lazy 的回合钳制、双过滤判据、crossTurn 路径、新 nudge 全部不需要（N1 类合成事件误判风险随回合判定一起消失，R4 确认）

## 3. 改动清单（纯提示词 + 结果文案）

1. **系统提示段契约反转**：
   - 统一规则（原委派豁免句升格）："任务完成 → 同回合先交付（报告/交付物，全上下文，**报告单独一步**）→ 立即 task_fold（**单独一步**）"
   - 删除 "task_fold is the FIRST closing action: fold BEFORE any closing report — the fold summary IS the summary"
   - **嵌套收尾句一并反转**（R4 指出的后门）：删除 "when all close, write the report from the outermost fold summaries"，改为最外层任务完成 → 先写报告 → 再 fold
   - "报告单独一步、fold 单独一步" 明示（防报告与 fold 同消息导致单步回退把报告排出 span——报告不丢但 summary 失素材）
2. **task_fold 结果 reportPart** 改为偏离兜底，保留三个护栏（R4）：
   - 锚定可观察事实："若你在**之前的步骤**尚未发送本任务的交付/报告"（查历史，非凭感觉）
   - 保留 "and no tasks remain open" 守卫
   - 保留 otherwise 显式抑制（已发送或任务未全闭 → 不写、继续周围工作）
3. **FOLD_SUMMARY_INSTRUCTION**：relay 基调句保留为兜底语义，补 "span 内已有报告则 Outcomes 引用结论不复述"
4. 委派豁免句随统一契约吸收（子代理：交付 → 立即 fold，与会话终结语义一致）

## 4. 测试

- 机制回归应全绿（零行为变化）
- 提示词结构断言更新（新契约关键词、旧句删除断言）
- reportPart 措辞断言（三护栏）

## 5. 已接受取舍

- 模型偏离契约（先折后报）→ reportPart 兜底补写（摘要级保真）
- 报告与 fold 同消息 → 报告留表面（不丢，仅 summary 少素材），提示词明示规避
- 会话终结未 fold → 无成本泄漏

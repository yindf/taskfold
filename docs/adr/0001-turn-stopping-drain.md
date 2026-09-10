# ADR 0001：turn-stopping 排干——折叠时点的缓存经济学

日期：2026-09-07 · 状态：已接受（taskfold 0.26.0）

## 背景

对一份真实工作会话 7 次 fold 的逐条成本解剖显示缓存命中呈双峰：回合中段的嵌套折叠
95–99% 命中（上一次主请求刚发生、前缀缓存热）；两次跨回合顶层折叠 **0% 命中**
（fold 1：173,297 fresh 输入 / 5,658 tok span；fold 7：107,309 fresh / 1,610 tok），
各占其折叠调用 ~82% 的 fresh 成本。根因：交付门控保证折叠晚于交付物，而顶层任务的
交付物是回合最后一条消息——drain 只挂在 `agent/pre-step`，折叠被推迟到**用户下一回
合开头**，正好落在闲置期之后、provider 前缀缓存已过期之时。

## 备选方案

1. **仅提前 drain**（turn-stopping 挂点）：宿主在回合最后一步提交后、agent 空闲前
   dispatch `agent/turn-stopping`（dsh-agent-loop L570，serial、无 next()）——此刻距
   最后一次主请求数秒，缓存最热。被中止/出错的回合不触发，pre-step 兜底仍在。
2. 清单信封（path manifest）：以派生摘要替换前缀，免疫缓存温度——但"缓存总是热的"
   论证成立后降级为备胎（仅在失败重试跨闲置期等残余冷路径上可能启用）。
3. 消息内联行号注入等信封改写方案：破坏前缀锚（span 字节变化 → 分歧点提前到 span
   起点），warm 大 span 折叠调用 ×2–5，否决（见 ADR 0002）。

## 决策

双挂点排干：`processDeferredArchives` 同时挂 `agent/pre-step`（waterfall 契约不变）
与 `agent/turn-stopping`（serial 契约、注册语句整体 try/catch——老宿主优雅退化为纯
pre-step 语义）。守卫更名 `drainRunning`：同会话并发被宿主单步循环结构性排除，守卫
的真实职责是跨会话防重入（子代理共享进程）。span 边界由 `deferredArchivePlan` 锚定，
与 drain 时机无关——turn-stopping 只是把同一区间的折叠提前到缓存热时执行。

## 后果

- 顶层任务的折叠调用从"冷全价"回到"热 ~97% 命中"；交互等待严格不增（同一等待从
  用户消息之后移到用户阅读回复的窗口里）。
- 已知残余：120s×K 排干上界（K=回合末放行条数，guardedSignal 逐条限时）；期间
  turn/end 落盘推迟、agent 显示 running；巨型 span 温暖尝试被 120s 截断后下回合
  pre-step 冷重付（低频）；跨会话 drainRunning 争用使 B 会话静默退回冷路径
  （后续项：per-session 守卫）。
- 观测面：summarize 返回的 usage（含 cacheRead）已随 fold 事件记录，命中率可查。

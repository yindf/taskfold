# 设计：fold_recall 区间重载（from/to）

> 状态：已批准（2026-09-07，随 0.27.0 实现）
> 背景：0.26.0 起走查摘要以 `L<N>-<M>` 区间引用 span 消息，但 fold_recall 只有单行（line）与全量（无参数）两种形态——工具语法与引用语法脱节。已知区间时要么付全量预览（~15 tok/消息 + 无条件写盘），要么 N 次单行调用。

## 契约

```js
// span-preview.mjs
export const RECALL_RANGE_MAX = 10
// 返回 { ok: true, lines: [{ line, message }] } 或 { ok: false, error }。
// 校验：from/to 均须整数；1 <= from <= to <= messages.length；
// to-from+1 <= RECALL_RANGE_MAX（软护栏：区间让一次肥调用比单行模式容易得多，
// 一条原始消息本身可达数千 token）。消息形状与 artifactLineAt 一致：
// {role, content} 精简（召回服务内容恢复，宿主溯源元数据留在持久日志）。

// compact-stats.mjs fold_recall 参数新增：
//   from / to（可选，含端点 1-based；与 line 互斥，同传报错）
// render：'Fold #N lines A-B of M:' + 每行 '<真实行号> <JSON>'。
// 不写工件（对齐 line 模式；全量模式的写盘服务 grep）。
```

## 决策

- **from/to 两整数参数**（而非 `"2-4"` 字符串）：自校验、无解析层。
- **≤10 行软护栏**：超限报错提示收窄或改用全量。
- **描述最短化**：常驻工具描述只加两句（区间语义 + 互斥），措辞对齐 `L<N>-<M>` 引用语法。
- **不动**引擎、指令层、工件格式、list_folds。

## 测试

- `span-preview.test.mjs`：artifactLines 合法切片（真行号 + 精简形状）、from>to、to 越界、半传参、>10 护栏。
- `compact-stats.test.mjs`：工具级 render 形态、互斥报错、越界错误前缀、不写盘。

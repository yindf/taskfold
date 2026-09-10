# 设计：task 栈实时显示（Web 客户端 dock）

> 状态：已实现、已发布（v0.34.0，tag `fc76711`）。
> 本文档 2026-09-10 刷新，纳入三处后到的变更：面板布局重做（宿主原生卡片几何）、逐行 `folding…`、以及归档状态收敛的 reducer 修复（`stateVersion 9 → 10`）。初版只覆盖"wire + dock"这一步。

## 背景与问题

`task_begin` / `task_end` 的任务栈此前只对模型可见（工具回执文本 + 系统提示行）：宿主侧 `taskMarks` 投影自 0.32 起就存在（注册于 `plugins/compact-region.mjs`），但**没有 wire**，浏览器读不到；插件也**没有客户端半件**。用户要求"显示当前 task 栈，跟 todo 一样"——Web GUI 里 todo 的形态是 `conversation.input.dock` 上 id=`todo` 的 TodoDock，实时读 `todos` 投影。

上线后又暴露两个只有真机才能发现的问题：**面板视觉粗糙**（插件类名不在壳层样式表里，裸 `<ol>/<li>` 全裸奔），以及**幽灵 `folding…` 行**（实测 5~7 行，重启重放也清不掉）。两者都在本轮一并解决。

## 契约

### 1. 宿主侧：wire（`plugins/compact-region.mjs`）

新增逐字段镜像 `dsh-tool-todo` 的 `todos` 注册：

```js
wire: {
  viewSchema: taskMarksStateSchema,
  view: (state) => state
}
```

- wire 值离开宿主前必过 `viewSchema.parse`（dsh-session-projection 的 viewCheckpoint）；客户端收到的必然是清洗后的 `null | { pending, marks, pendingArchives? }`。
- `stateVersion: 10`（原 9）。提升版本号是修复存量会话的手段：**重放会按新 reducer 重算**，旧日志里残留的归档条目因此自动收敛（目标 0.32.1 无需手工清理）。
- 客户端仅把 `marks` 当栈读（栈序：旧→新，最内层在末尾）；`seq` 全局唯一，旧日志可能重名，**渲染 key 用 `seq` 不用 name**。`pending` 是"正在提交"的意图计数，`pendingArchives` 是已出栈、等待归档的任务。
- task 名是模型自由文本（允许引号等），渲染走 React 文本节点转义；不做任何 HTML 拼接。

### 2. 客户端半件：`plugins/taskfold-client.mjs`（构建生成）

- **零构建取舍**：宿主把该文件当 classic script 原样吐给浏览器（`window.__ModuleLoader__.load({ id, factory })`），文件里不允许 import/export，因此逻辑必须内联。单一事实源是 `plugins/task-stack-ui.mjs`（纯函数 + react 注入工厂，离线可测）；`scripts/build-client.mjs` 从 `scripts/taskfold-client.template.mjs` 做"剥 ESM 关键字 + 拼装 envelope"的确定性生成，**产物提交入库**（宿主服务的是安装包里的原始字节）。
- **双新鲜度门禁**：`test/client-bundle.test.mjs` 做字节级重建比对；`scripts/release.mjs` 在 draft 与 release 前调 `assertClientBundleFresh()`，陈旧即拒绝发版。注意 `npm pack` 打的是**工作区文件**而非 blob，故 EOL 也必须在门禁意义上一致——由仓库根的 `.gitattributes`（`* text=auto eol=lf`）保证。
- **依赖面**：bundle 只 `require("react")`（种子词，无需声明），第一方包零依赖 → `dsh.client` 只声明 `{ platform: "web" }`，不填 `inject`。
- **挂载**：`ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name, id: "task-stack", order: 15, locale }, TaskStackDock))`——order 15 落在 goal(10) 与 queue(20) 之间；组件契约 `{ useProjection, t }` 由聊天宿主提供，`useProjection("taskMarks")` 实时取 wire 视图（与 TodoDock 读 `todos` 完全同构）。
- **manifest**：`exports` 含 `"./client": "./plugins/taskfold-client.mjs"`（`dsh.client` 缺 `exports["./client"]` 会在 boot 期直接抛错）；`"./plugins/*"` 通配保留历史子路径可达性。

### 3. 视觉与交互（`plugins/task-stack-ui.mjs`）

样式**自注入**：插件类名不在壳层样式表里（实测第一方插件类在 shell bundle 中 0 命中），因此模块自带并注入自己的样式表——与第一方 bundle 同款做法：`<style data-plugin-css="dsh-taskfold/TaskStack.module.css">`，按 id 幂等（热重载/重挂载不会叠副本），无 `document` 时安静返回 false（离线测试渲染器即此路径）。

几何与排版逐字取自宿主自己的列表 dock recipe：composer 对齐宽度（`--dsh-composer-side-clearance` / `--dsh-composer-dock-inset`，缺失时回退满宽，绝不让 calc 崩掉）、`.5px` 发丝边 + 12px 圆角 + `--dsw-specific-tip` 表面、13px/20px 行高、16×16 字形格、列表 `max-height:180px` 超出滚动、hover 用 `--dsw-alias-interactive-bg-hover`。

层级不再靠序号：左侧是 **rail + 状态点**——深度 = rail 竖条数（渐变发丝线），状态由点色区分（当前任务 `state-business-primary` 实心、待归档 `state-warn-primary`、普通 `label-caption`）。最内层任务名加粗为 `label-primary` 并带旋转 spinner（`@keyframes tf-stack-spin`）。

行为：

- 折叠/展开由 `defaultCollapsed` + 内部 `useState` 控制；表头 meta 在展开态显示计数（`countsSummary`，如 `3 open · 1 folding`），折叠态/紧凑态显示 `planSummary`（如 `3 open · verify the bundle freshness gate · 1 folding`）。
- **每个待归档任务一行**：逐行 `li`，各带 `folding…` 后缀与 warn 点（此前是 `closing.join(', ')` 挤在一行，已废弃）。
- pending 意图渲染为一行 `opening…` / `closing…`（带 spinner）。
- **空栈完全不渲染**（`visible === false` → `return null`），与宿主 TodoPanel 的"无内容即缺席"一致；不再留空条。
- 模型读取全程防御式（`taskStackView` 永不抛错），畸形/旧版形状一律退化为空模型。

## 状态收敛：归档见证（`plugins/task-marks.mjs` + `plugins/fold-drain.mjs`）

**症状**：`pendingArchives` 只增不减 → dock 上每个已结束任务留一行永久 `folding…`（实测 6 行）。

**根因**：归档完成的判据只认 **begin 锚点**被 `compaction/summary` 遮蔽，而折叠契约刻意让 span **从 'Task begun' 结果之后**开始（否则前导 cut 不平衡、无法压缩）——于是锚点永远留在表面，条目永不清除，重放也清不掉。

**修复**：改判 **双证人**——`event.data.shadowedSeqs` 命中 `p.seq`（begin 锚点）**或** `p.foldResultSeq`（close 结果）任一，即认为该归档再也不可能折叠，丢弃。close 结果是**每次成功折叠都会遮蔽**的那个见证；锚点规则保留给 `foldResultSeq` 出现之前写入的旧行（向后兼容 + 重放安全）。

配套两处：

- **`stateVersion 9 → 10`**：强制重放，存量会话的残留条目自动收敛。
- **drain 的 settle 语义**（`fold-drain.mjs:285-295`）：只在"本趟没提交任何折叠（`result === null`）"或"本趟提交的折叠真的把该行移除"时 settle。**因边界不平衡而把 region 收缩到 close 结果之下**的折叠，故意保持 queued + unsettled——下一趟按重写后的表面重新规划，与既有行为一致。这里不能图省事写"成功即 settle"，那会吃掉"END 边界收缩需下轮重规划"的语义。

## 提示通道：整栈单行（`plugins/lifecycle-nudges.mjs`）

`taskStackLine(marks, archives, pending)` 生成：

```
Task lifecycle: task stack — 3 open, outermost first: "a" > "b" > "c"; 2 folding, 1 end pending.
```

空栈为 `... — empty; nothing folding or pending.`。作为**既有提示行的追加行**输出，从不单独发射（常驻状态行会在每次 lifecycle 调用后重复注入，而深度信息本就随每个 `task_begin/task_end` 回执下发）。

**字节稳定是硬约束**：该通道逐字比对已发布文本（`planLifecycleInjection` 的 latch），任何逐轮漂移的值都会让 latch 每轮重新开火。因此这行**只带形状**——名字（栈序）、open 计数、folding/pending 计数；**不带轮数、不带 seq**。名字是模型文本，渲染时用双引号包裹并把内部 `"` 替换为 `'`。

## 决策

- **dock 而非 per-call toolview 行**：toolview 行按调用渲染，而 task 栈是会话级实时状态——在历史调用上渲染"当前"栈语义误导；常驻 dock 才是"当前 task 栈"。被否方案：为 `task_begin`/`task_end` 注册 keyed toolview 行。
- **生成即提交 + 双门禁**：宁可多一个生成物，不可让浏览器版逻辑与离线测试版漂移。
- **内联 key 常量**：`task-stack-ui.mjs` 保持 import-free（内联可行性），`TASK_STACK_KEY='taskMarks'` 本地定义，与宿主 `TASK_MARKS_KEY` 的一致性由离线测试断言钉死。
- **样式自注入而非依赖壳层**：实测插件类不在壳层样式表内，靠类名"裸奔"是初版粗糙的直接原因；自注入是与第一方 bundle 对齐的做法。
- **不动**事件日志（无任何自定义事件）、工具层 LIFO 规则；客户端只读投影。

## 测试

- `test/task-stack-ui.test.mjs`：防御式建模（畸形/旧版形状）、`planSummary`/`countsSummary`/`tailSummary` 各变体、dock 工厂（fake `useProjection`：缺失/空/嵌套/带 closing/pending，并 spy 断言读的就是 `'taskMarks'`）、`TASK_STACK_KEY === TASK_MARKS_KEY` 防漂移；react 存在时用 `react-dom/server` 断言真实 markup（含逐行 `folding…`）。
- `test/client-bundle.test.mjs`：重建字节相等（新鲜度）、envelope 契约（load/factory/apply/inject）、dock 注册形状（slot key/id/order）、`transformModel` 无 ESM 残留且可解析、manifest 路由与 platform、以及**release 守卫实际调用的那条默认 root 路径**与"陈旧产物必须 `throws /is stale/` 而非崩溃"。
- 相邻门禁：`test/task-marks.test.mjs`（双证人收敛/兼容旧行）、`test/fold-drain.test.mjs`（settle 语义）、`test/lifecycle-nudges.test.mjs`（整栈行文本与字节稳定）。
- 全量：12 套件 / 162 项 / 0 失败。

## 部署与生效链路

- **已发布**：v0.34.0（tag `fc76711`），GitHub Release 附带 `dsh-taskfold-0.34.0.tgz`。安装方式 `github:yindf/taskfold#v0.34.0`（钉 tag 可复现）或 `file:<本地 checkout>`（**注意：`pnpm install` 对未变的 `file:` 依赖会报 up-to-date 而不重新硬链，切换来源前先删 `node_modules/dsh-taskfold`；`write`/`edit` 这类换 inode 的保存会切断硬链接**）。
- **客户端改动**：`node scripts/build-client.mjs` 后**刷新浏览器即可**——combo 路由的 `rev` 由磁盘字节重算，产物提交入库再由宿主按字节框接。
- **宿主改动**（`task-marks.mjs` / `fold-drain.mjs` / `lifecycle-nudges.mjs` / `compact-region.mjs`）：必须重装（重新链接）+ **重启 dsh**；宿主对"非客户端包"的否定判定会缓存到重启为止，仅刷新页面不够。
- 无需改 `cordis.patch.yml`：行 id 不变，客户端半件经最近 `package.json` 的 `dsh.client` 声明被自动发现并服务为 `/plugins/dsh-taskfold/client.js`。

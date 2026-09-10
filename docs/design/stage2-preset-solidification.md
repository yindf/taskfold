# 设计:阶段二固化 —— compact-region 进驻用户 preset

> 状态:已完成(挂载验证通过;新会话实测待用户)
> 创建:2026-08-31  更新:2026-08-31
> 依赖:`compact-region-tool.md`(基座,阶段一已完成)与 `task-marker-compaction.md`(任务标记,阶段一已完成)。
> 本文档决定两篇文档预留的"阶段二方向"的落地细节。

## 1. 目标与范围

把已验证的五个工具(compact / compact_inspect / task_begin / task_end / task_abort)+ L5 提示词章节 + L6 悬栈回显,从进程级动态插件固化为**随 preset 持久存在**的能力:进程重启后依然可用,不依赖 cordis_define/run。

范围外:不改 shipped preset(规范红线);不做 npm 发布;不做事件驱动自动化(前文已否决)。

**实例共享事实(评审 M1 修订)**:standing 挂载按 **preset 代际**共享——同进程内所有选用 cmpct 的会话及其子代理共享**同一个插件实例与同一个 markers Map**(composeFrom:"the same plugin objects, the same tool registrations")。因此 markers 的 sessionId 键控与 L6 的聚合显示是**正确性要求,不是保险**;动态版行为与此一致(其工具同样注册在 preset 层)。

## 2. 形态决策

### 2.1 载体:用户 preset 副本 + 本地插件行

- 经 roster 服务 `copy('cordis', 'cmpct', …)` 复制 shipped `cordis` preset 到用户根目录(`${DSH_HOME}/.agent-presets/cmpct/`),后续编辑全部作用于副本。
- 插件以**本地 ESM 文件**随 preset 目录分发:`plugins/compact-region.mjs`,行 `name: ./plugins/compact-region.mjs`。
  依据(alpha `dsh-agent-presets/lib/types/specifier.js` 实读):行名以 `.` 开头 → `kind:'preset'`,按 **preset 组合文件所在目录**解析(baseUrl = 组合文件目录,cordis-plugin-include L133;"a preset's own files travel with it")。裸包名行**能**解析(mount 覆写为 harness 基址)但仅对已装进 harness node_modules 的包成立——本插件不发布不安装,故不可用裸包名;`file:`/绝对路径虽可用但把插件钉死在机器路径,不如随目录自带。
  文件用 `.mjs` 后缀:用户 preset 目录无 `package.json`(type:module),`.js` 会被按 CommonJS 解析导致 `export` 语法失败。
- 插件文件**零 import 依赖**:全部能力经 `inject` 服务取得(`compaction`/`tools`/`systemPrompt`),与沙箱版最大的不同是从"harness 桥"回到"普通 cordis 插件"。

### 2.2 行位置:compaction isolate 域内

行加入 `agent.cordis.yml` 既有的 compaction 组:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config: {...}
    - id: compact-region            # 新增行
      name: ./plugins/compact-region.mjs
```

依据:本插件**消费** `compaction`(域内提供)→ 按"provider 与消费者同域"规则进组;先例是同组的 `command-compact`(`inject = ["commands","compaction"]`,域内服务 + host 服务混排,生产验证)。域内 inject host 服务可行(compaction-basic 在域内 inject host 的 `llm/tokenMeter/sessions`)。realm 使**服务**对域外不可见(isolate 私有符号按原型链解析),但 standing 组合本身按 preset 代际**跨会话共享**(见 §1 实例共享事实)——插件实例、markers Map、工具注册均为共享;每会话正确性由 sessionId 键控保证,与动态版行为等价。域内行注册的工具/命令对 agent 可见有正面先例(delegation 组;mount.js:"every ctx.tools and ctx.systemPrompt registration inside the preset files into that agent's layer")。

## 3. 代码差异(相对 pkg-8)

| 项 | 动态版(pkg-8) | 固化版 |
|---|---|---|
| 模块形态 | 沙箱函数体 | ESM `export default { name, inject, apply }` |
| engine 获取 | `agentPresets.serviceFor(agent,'compaction')`(域外桥接) | `ctx.compaction`(inject 直连,同域) |
| 工具注册 | `harness.defineTool` + `harness.registerTool` | `ctx.tools.register(definition)` 直传;`.mjs` 内嵌 **defineTool 归一化后的最终形态**(parameters 根 `{type:'object', properties, required?}`、无根级 additionalProperties;output.schema 显式 `additionalProperties:true`)。注意 register() 对 parameters **无注册期校验**——拷错形态最早在首次 prompt 组装才暴露,故 §5(b) 加 schema 逐字一致性检查 |
| 提示词 | `ctx.get('systemPrompt')` + 探测 | `inject:['compaction','tools','systemPrompt']`(硬依赖,park 语义正确) |
| markers | Map 按 sessionId 键控(防跨会话) | **保留,且为正确性要求**(standing 实例跨会话/子代理共享,见 §1 实例共享事实) |
| 可见性 | 动态工具仅本会话 agent 层 | 行在 standing 层:**子代理(spawn/fork)经同一挂载继承五工具**;markers 按 sessionId 隔离(评审 m2,声明的行为扩展) |
| compact 描述 | 平级定位 | **降级为逃生舱定位**(ad-hoc 区间:无标记历史/精准部分压缩/合并旧摘要;日常走 task 生命周期)——已获用户认可 |
| 其余逻辑 | — | 逐字不变(区间推导/错误契约/两段式 hint/depth 回显) |

## 4. 实施步骤

1. 挂临时探针动态插件(注册 preset_ops 工具,包装 roster 的 `list/resolve/read/copy/standingKeyFor`),用毕即卸。
2. `copy('cordis', 'cmpct', 'Cordis + Compact Region')` → 取回真实路径。
3. 写 `plugins/compact-region.mjs`(零依赖 ESM);`edit agent.cordis.yml` 加行;补 `preset.yml` description。
4. `standingKeyFor('cmpct')` 挂载验证(拒绝四种失败:包不解析/配置非法/行未激活/服务泄入根域)。
   **运维事实(评审 M2)**:`.mjs` 变更在同一进程内**永不生效**——ESM 模块按 URL 缓存,代际 stamp 只看组合 yml 的 mtime/size。迭代回路中修复 `.mjs` 后需**文件名版本化**(`compact-region-v2.mjs` + yml 行同步改,新 URL + 新 stamp)或重启 dsh 进程;发布后改 `.mjs` 不动 yml 对新会话同样无效。
5. 请用户在新会话选择 `cmpct` preset 实测:五工具在列、task_begin→…→task_end 全链路、L6 显示正确。

## 5. 验证清单

- (a) `standingKeyFor('cmpct')` 通过(组合真实挂载,同会话启动路径减去 agent);
- (b) 新会话(用户操作):工具清单含五工具 + /compact 命令共存无冲突;**五工具的 parameters schema 与任务标记设计 §3.1/§3.2 逐字一致**(直传无注册期校验,见 §3);
- (c) 新会话:task_begin → 小段工作 → task_end 成功且 summary 落地;L6 显示与清除正确;
- (d) 固化版无 serviceFor 依赖:直接 ctx.compaction(域内),错误路径 `'this agent preset mounts no compaction service'` 仅在 inject park 失败场景由 park 语义表达,不再是运行期探测分支;
- (e) 本会话(旧 preset)不受影响:cmpct-1 动态插件与新 preset 各行其道;
- (f)(可选)子代理冒烟:spawn 子代理可见五工具且 markers 与父会话隔离。

## 6. 风险与回滚

- **风险**:行未激活(域内服务解析失败)——standingKeyFor 在发布前拦截;preset 副本继承 shipped 全部行为,升级不跟随(副本快照语义,规范如此);**`.mjs` 修改需重启 dsh 或文件名版本化才对新会话生效**(评审 M2,见 §4);迭代修复后重验证必须换文件名,否则导入缓存旧模块出现"改了没用"。
- **回滚**:删除 `${DSH_HOME}/.agent-presets/cmpct/` 即完全移除;不影响 shipped preset 与其他会话。
- **探针纪律**:preset_ops 为临时能力,验证后 cordis_stop + cordis_undefine。

## 7. 决策记录

- **E5 — 移除副本中的 tool-cordis 行(实施期偏离,挂载验证发现)**:cordis 全量副本首次 `standingKeyFor` 失败——`tool-cordis` 的 Host inspect provider 注册于进程全局注册表(按 id 去重),与已挂载的 cordis 预设(standing 代际活到进程退出)冲突,同进程永不共存。处置:从 cmpct 副本移除该行并以注释注明原因;cmpct = cordis − 动态插件创作工具 + 压缩工具族,与 cordis 预设**可同进程共存**;需要 cordis_* 创作工具时使用 cordis 预设会话。移除后挂载验证一次通过。

- **E1 — 本地相对路径行**:行名 `./plugins/compact-region.mjs`,依据 specifier 三分类(`.` 前缀 → preset 目录解析);`.mjs` 规避 CJS 误解析。
- **E2 — compaction 域内直连(评审 M1 修订)**:消费 ctx.compaction 的行进 isolate 组,去 serviceFor 桥;standing 实例按 preset 代际跨会话共享,sessionId 键控与 L6 聚合为正确性要求(非保险)。
- **E3 — compact 降级定位**:描述改为逃生舱语义,task 生命周期为主接口(用户已认可)。
- **E4 — 零 import 插件**:inject 三服务,规避用户目录 node_modules 解析不可达问题。

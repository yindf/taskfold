/**
 * taskStackUi — client-side presentation of the open-task stack.
 *
 * Reads the `taskMarks` session projection's wire view (host: task-marks.mjs /
 * compact-region.mjs; state = null | { pending, marks, pendingArchives? }).
 * marks are in STACK order: index 0 is the outermost (earliest-begun) task,
 * the last element is the innermost (currently active) task. tasks span turns
 * and survive host restarts, so this surface is session-global, unlike the
 * per-turn `todos` projection.
 *
 * Visual language is copied from the host's own list dock
 * (`dsh-client-ui-conversation`'s TodoPanel): the same composer-aligned card
 * geometry (--dsh-composer-* variables), the same .5px hairline + 12px radius
 * + `--dsw-specific-tip` surface, 13px rows, and a 16x16 glyph cell. Nothing
 * here can rely on shell CSS: plugin classes are NOT in the host stylesheet
 * (verified: 0 hits for first-party plugin classes in the shell bundles), so
 * this module ships and injects its own stylesheet — exactly what the
 * first-party bundles do (`style[data-plugin-css=...]`).
 *
 * Everything here is pure except makeTaskStack / injectTaskStackCss; the
 * react module is passed in so the file stays importable offline (node tests
 * without a browser) while the real bundle passes require('react').
 */

/**
 * Pure display model over the projection's wire state. Never throws on
 * foreign/malformed state (e.g. older persisted rows mid-replay): every field
 * is read defensively.
 * Returns {
 *   open: [{ seq, name, depth, innermost }],  // stack order, outermost first
 *   count,                                    // open.length
 *   innermost,                                // name of the active task or null
 *   pending: { begin, end },                  // lifecycle calls awaiting results
 *   closing: [{ seq, name }],                 // closed, fold queued (pendingArchives)
 *   empty,                                    // count === 0
 *   visible                                   // anything worth rendering at all
 * }
 */
export function taskStackView(state) {
  const base = state !== null && typeof state === 'object' && !Array.isArray(state) ? state : null
  const marks = base !== null && Array.isArray(base.marks) ? base.marks : []
  const open = []
  for (let i = 0; i < marks.length; i += 1) {
    const m = marks[i]
    if (m === null || typeof m !== 'object' || typeof m.name !== 'string') continue
    open.push({
      seq: Number.isInteger(m.seq) ? m.seq : 0,
      name: m.name,
      depth: open.length + 1,
      innermost: false
    })
  }
  if (open.length > 0) open[open.length - 1].innermost = true
  let pending = { begin: 0, end: 0 }
  if (base !== null && base.pending !== null && typeof base.pending === 'object') {
    for (const key of Object.keys(base.pending)) {
      const e = base.pending[key]
      if (e === null || typeof e !== 'object') continue
      if (e.kind === 'begin') pending.begin += 1
      else if (e.kind === 'end') pending.end += 1
    }
  }
  const closing = []
  if (base !== null && Array.isArray(base.pendingArchives)) {
    for (const a of base.pendingArchives) {
      if (a !== null && typeof a === 'object' && typeof a.name === 'string') {
        closing.push({ seq: Number.isInteger(a.seq) ? a.seq : 0, name: a.name })
      }
    }
  }
  const pendingCount = pending.begin + pending.end
  return {
    open,
    count: open.length,
    innermost: open.length > 0 ? open[open.length - 1].name : null,
    pending,
    closing,
    empty: open.length === 0,
    visible: open.length > 0 || closing.length > 0 || pendingCount > 0
  }
}

/** Defensive accessor: any non-model input is treated as the empty model. */
function asModel(model) {
  return model !== null && typeof model === 'object' && Array.isArray(model.open)
    ? model
    : taskStackView(null)
}

/**
 * Locale namespace of the dock's dictionary entries. The bundle wiring binds
 * a locale reader to this NS when the locale service is available; the dock's
 * slot registration deliberately does NOT declare `locale:` (scoped slots
 * throw on locale-declaring entries when no locale face is installed), so the
 * reader arrives through the wiring instead and every miss falls back to the
 * English dictionary below.
 */
export const TASK_STACK_UI_NS = 'ui.taskfold'

/** English copy. `{n}` fills the count at render time. */
export const taskStackEn = {
  title: 'tasks',
  openCount: '{n} open',
  foldingCount: '{n} folding',
  pendingCount: '{n} pending',
  openingTask: 'opening a task…',
  closingTask: 'closing a task…',
  opening: 'opening…',
  closing: 'closing…',
  folding: 'folding…'
}

/** Simplified Chinese copy. */
export const taskStackZh = {
  title: '任务',
  openCount: '{n} 个进行中',
  foldingCount: '{n} 个折叠中',
  pendingCount: '{n} 个待处理',
  openingTask: '正在打开任务…',
  closingTask: '正在关闭任务…',
  opening: '打开中…',
  closing: '关闭中…',
  folding: '折叠中…'
}

/** English fallback reader for deployments without the locale service. */
function enText(key) {
  return taskStackEn[key] ?? key
}

/**
 * Reader resolver: an explicit reader wins per CALL — a reader that yields
 * nothing for a key (absent service, unregistered dictionary, raw-key stub)
 * falls through to the English copy. Resolution is per call, not per factory:
 * the bundle's reader is wired to a lifetime-managed ref that appears and
 * disappears with the locale service, so a snapshot taken earlier must never
 * pin the answer.
 */
function readerOf(t) {
  if (typeof t !== 'function') return enText
  return (key) => {
    const value = t(key)
    return typeof value === 'string' && value !== '' ? value : enText(key)
  }
}

/** Fill a copy template's {n} placeholder with a count. */
function fillCount(template, n) {
  return String(template).replace('{n}', String(n))
}

/**
 * Count-only tail: 'folding' / 'pending' parts, used by the expanded header
 * and appended to the collapsed summary. '' when there is nothing extra.
 * `t` is an optional locale reader; without one the English copy prints.
 */
export function tailSummary(model, t) {
  const read = readerOf(t)
  const m = asModel(model)
  const parts = []
  if (m.closing.length > 0) parts.push(fillCount(read('foldingCount'), m.closing.length))
  const pending = m.pending.begin + m.pending.end
  if (pending > 0) parts.push(fillCount(read('pendingCount'), pending))
  return parts.join(' · ')
}

/**
 * Expanded header meta: the stack at a glance, without repeating a task name
 * that is already listed below ('3 open · 1 folding').
 */
export function countsSummary(model, t) {
  const read = readerOf(t)
  const m = asModel(model)
  const parts = []
  if (m.count > 0) parts.push(fillCount(read('openCount'), m.count))
  const tail = tailSummary(m, read)
  if (tail !== '') parts.push(tail)
  return parts.join(' · ')
}

/**
 * One-line summary for compact surfaces (tool row, collapsed subtitle) — the
 * analog of the todos projection's "N of M done": the active task name plus
 * the counts tail. '' when there is nothing worth printing.
 */
export function planSummary(model, t) {
  const read = readerOf(t)
  const m = asModel(model)
  const tail = tailSummary(m, read)
  const suffix = tail === '' ? '' : ' · ' + tail
  if (m.count === 0) {
    if (m.pending.begin > 0) return read('openingTask')
    if (m.pending.end > 0) return read('closingTask')
    return ''
  }
  return fillCount(read('openCount'), m.count) + ' · ' + m.innermost + suffix
}

/**
 * Session-projection key the client reads. Kept local so this module stays
 * import-free (the client bundle inlines it verbatim); the offline suite
 * asserts it equals task-marks.mjs' TASK_MARKS_KEY, which is what the host
 * actually registers.
 */
export const TASK_STACK_KEY = 'taskMarks'

/** Identifier stamped on the injected <style>, mirroring the host bundles. */
export const TASK_STACK_CSS_ID = 'dsh-taskfold/TaskStack.module.css'

/**
 * The dock's stylesheet. Geometry/typography are the host's list-dock recipe
 * (composer-aligned width, hairline border, 12px radius, 13px rows, 16x16
 * glyph cell); the rails/nodes are this widget's own. `var(..., fallback)`
 * is used for the composer variables, which the conversation package injects at
 * runtime — a missing variable must degrade to full width, never to a broken calc.
 */
export function taskStackCss() {
  return [
    '.tf_root{box-sizing:border-box;',
    'width:calc(100% - 2*var(--dsh-composer-side-clearance,0px) - 4*var(--dsh-composer-dock-inset,0px));',
    'max-width:calc(var(--dsh-composer-card-max-width,100%) - 4*var(--dsh-composer-dock-inset,0px));',
    'border:.5px solid var(--dsw-alias-border-l1);',
    'background:var(--dsw-specific-tip);',
    'border-radius:12px;flex:none;margin:0 auto;overflow:hidden;',
    '--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);',
    '--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
    '.tf_body{display:flex;flex-direction:column;gap:6px;padding:6px 12px}',
    '.tf_header{display:flex;align-items:center;gap:10px;width:100%;padding:0;border:none;background:0 0;',
    'text-align:left;color:inherit;font:inherit;cursor:pointer}',
    '.tf_lead{display:grid;place-items:center;flex:none;color:var(--dsw-alias-label-tertiary)}',
    '.tf_title{flex:none;font-size:13px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
    '.tf_meta{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
    '.tf_chevron{display:grid;place-items:center;flex:none;color:var(--dsw-alias-label-tertiary);',
    'transition:transform var(--ds-transition-duration-fast,120ms) var(--ds-ease-in-out,ease)}',
    '.tf_chevronOpen{transform:rotate(180deg)}',
    '.tf_list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0 0 2px;list-style:none;',
    'max-height:180px;overflow-y:auto}',
    '.tf_item{display:flex;align-items:center;min-width:0;border-radius:6px;',
    'font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
    '.tf_item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.tf_rail{display:flex;align-items:center;gap:0;flex:none;align-self:stretch}',
    '.tf_bar{flex:none;width:13px;height:100%;background:linear-gradient(',
    'to right,transparent 6px,var(--dsw-alias-border-l2) 6px,var(--dsw-alias-border-l2) 7px,transparent 7px)}',
    '.tf_node{flex:none;width:6px;height:6px;margin:0 7px 0 5px;border-radius:50%;',
    'background:var(--dsw-alias-label-caption)}',
    '.tf_nodeActive{background:var(--dsw-alias-state-business-primary)}',
    '.tf_nodeClosing{background:var(--dsw-alias-state-warn-primary)}',
    '.tf_name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.tf_nameActive{color:var(--dsw-alias-label-primary);font-weight:500}',
    '.tf_suffix{flex:none;margin-left:6px;color:var(--dsw-alias-label-caption)}'
  ].join('')
}

/**
 * Idempotently inject the stylesheet, the way every first-party bundle does:
 * keyed by `data-plugin-css` so a hot reload or remount never stacks copies.
 * Returns true when a tag was appended (false when already present or when
 * there is no document — e.g. the offline test renderer).
 */
export function injectTaskStackCss(doc) {
  const d = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : null)
  if (d === null || d === undefined || typeof d.createElement !== 'function') return false
  const head = d.head
  if (head === null || head === undefined || typeof head.appendChild !== 'function') return false
  if (typeof d.querySelector === 'function' && d.querySelector('style[data-plugin-css="' + TASK_STACK_CSS_ID + '"]') !== null) return false
  const tag = d.createElement('style')
  tag.dataset.plugin = 'dsh-taskfold'
  tag.dataset.pluginCss = TASK_STACK_CSS_ID
  tag.textContent = taskStackCss()
  head.appendChild(tag)
  return true
}

/** 14x14 stroke icons, in the host's icon idiom (currentColor, aria-hidden). */
function stackGlyph(h) {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M7 2.2 12.4 5 7 7.8 1.6 5z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
    h('path', { d: 'M2.6 8.3 7 10.7l4.4-2.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function chevronGlyph(h) {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M3.6 5.4 7 8.8l3.4-3.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

/** Rails + state dot: depth is the leading rail run, state is the dot colour. */
function railCell(h, depth, state, key) {
  const bars = []
  for (let i = 1; i < depth; i += 1) bars.push(h('span', { key: 'b' + i, className: 'tf_bar' }))
  const node = state === 'active'
    ? 'tf_node tf_nodeActive'
    : state === 'closing' ? 'tf_node tf_nodeClosing' : 'tf_node'
  bars.push(h('span', { key: 'n', className: node }))
  return h('span', { key: key, className: 'tf_rail' }, bars)
}

/** One pending lifecycle intent: 'opening…' while a task_begin is in flight. */
function pendingRow(h, m, t) {
  const read = readerOf(t)
  const bits = []
  if (m.pending.begin > 0) bits.push(read('opening'))
  if (m.pending.end > 0) bits.push(read('closing'))
  return h('li', { key: 'pending', className: 'tf_item' },
    railCell(h, 1, 'pending', 'rail'),
    h('span', { className: 'tf_name' }, bits.join(' ')))
}

/**
 * Component factory. `react` is the react module (createElement + hooks of the
 * host's react instance). Renders the stack card; `compact` drops the per-task
 * list in favor of the one-line summary. Renders nothing at all when there is
 * no stack, no queued closure and no pending intent — the same "empty means
 * absent" rule the host's TodoPanel follows.
 */
export function makeTaskStack(react) {
  const h = react.createElement
  const useState = react.useState

  function TaskStack({ model, compact, defaultCollapsed, t }) {
    const read = readerOf(t)
    const m = asModel(model)
    const [collapsed, setCollapsed] = useState(defaultCollapsed === true)
    if (!m.visible) return null
    const toggle = () => setCollapsed((v) => !v)
    const header = h('button', {
      type: 'button',
      className: 'tf_header',
      'aria-expanded': !collapsed,
      onClick: toggle
    },
    h('span', { className: 'tf_lead' }, stackGlyph(h)),
    h('span', { className: 'tf_title' }, read('title')),
    h('span', { className: 'tf_meta' }, compact === true || collapsed ? planSummary(m, read) : countsSummary(m, read)),
    h('span', { className: 'tf_chevron' + (collapsed ? '' : ' tf_chevronOpen') }, chevronGlyph(h)))

    if (compact === true) {
      return h('div', { className: 'tf_root tf_rootCompact' }, h('div', { className: 'tf_body' }, header))
    }
    const rows = []
    for (const task of m.open) {
      rows.push(h('li', {
        key: 'k' + task.seq + ':' + task.name,
        className: 'tf_item' + (task.innermost ? ' tf_itemActive' : '')
      },
      railCell(h, task.depth, task.innermost ? 'active' : 'open', 'rail'),
      h('span', { className: 'tf_name' + (task.innermost ? ' tf_nameActive' : '') }, task.name)))
    }
    for (const c of m.closing) {
      rows.push(h('li', { key: 'c' + c.seq + ':' + c.name, className: 'tf_item' },
        railCell(h, 1, 'closing', 'rail'),
        h('span', { className: 'tf_name' }, c.name),
        h('span', { className: 'tf_suffix' }, read('folding'))))
    }
    if (m.pending.begin + m.pending.end > 0) rows.push(pendingRow(h, m, read))
    return h('div', { className: 'tf_root' },
      h('div', { className: 'tf_body' },
        header,
        collapsed ? null : h('ul', { className: 'tf_list' }, rows)))
  }
  return TaskStack
}

/**
 * Dock adapter for the host's `conversation.input.dock` slot — the same
 * surface TodoDock uses for the `todos` projection. `useProjection` is a
 * host-provided render prop (dock components receive it from the chat package;
 * GoalDock and TodoDock consume the same prop). Read-only surface: the header
 * collapses/expands, nothing else is interactive.
 */
export function makeTaskStackDock(react, readText) {
  const h = react.createElement
  const TaskStack = makeTaskStack(react)
  const fallback = readerOf(readText)
  function TaskStackDock({ useProjection, t }) {
    const read = typeof t === 'function' ? t : fallback
    const state = typeof useProjection === 'function' ? useProjection(TASK_STACK_KEY) : undefined
    return h(TaskStack, { model: taskStackView(state), t: read })
  }
  return TaskStackDock
}

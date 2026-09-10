// Offline tests for the client-side task-stack presentation pieces exported
// from plugins/task-stack-ui.mjs: the pure display model (taskStackView), the
// summary helpers (planSummary / countsSummary / tailSummary), the injected
// stylesheet (taskStackCss / injectTaskStackCss), and the react-injected widget
// factory (makeTaskStack — rendered through react-dom/server when a react
// install is resolvable; skipped gracefully otherwise so the suite stays
// machine-independent).
// Run in-process (the sandbox blocks node --test child processes):
//   node test/task-stack-ui.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  taskStackView,
  planSummary,
  countsSummary,
  tailSummary,
  taskStackCss,
  injectTaskStackCss,
  TASK_STACK_CSS_ID,
  makeTaskStack,
  makeTaskStackDock,
  TASK_STACK_KEY
} from '../plugins/task-stack-ui.mjs'
import { TASK_MARKS_KEY } from '../plugins/task-marks.mjs'

/** Wire states in the v9 persisted shape (see task-marks.mjs). */
const EMPTY = null
const ONE = { pending: {}, marks: [{ seq: 10, name: 'recon' }] }
const NESTED = {
  pending: { c1: { kind: 'begin', anchorSeq: 40 }, c2: { kind: 'end', anchorSeq: 41 } },
  marks: [
    { seq: 10, name: 'outer' },
    { seq: 20, name: 'mid' },
    { seq: 30, name: 'inner' }
  ],
  pendingArchives: [
    { seq: 25, name: 'old', foldResultSeq: 26 },
    { seq: 27, name: 'older', foldResultSeq: 28 }
  ]
}

test('taskStackView: empty and malformed inputs yield the empty model', () => {
  for (const bad of [EMPTY, undefined, 'nope', 42, [], { marks: 'x' }, { pending: 7, marks: null }]) {
    const m = taskStackView(bad)
    assert.equal(m.empty, true, JSON.stringify(bad))
    assert.equal(m.visible, false, JSON.stringify(bad))
    assert.equal(m.count, 0)
    assert.equal(m.innermost, null)
    assert.deepEqual(m.pending, { begin: 0, end: 0 })
    assert.deepEqual(m.closing, [])
  }
})

test('taskStackView: single mark is the innermost task', () => {
  const m = taskStackView(ONE)
  assert.equal(m.empty, false)
  assert.equal(m.visible, true)
  assert.equal(m.count, 1)
  assert.deepEqual(m.open, [{ seq: 10, name: 'recon', depth: 1, innermost: true }])
  assert.equal(m.innermost, 'recon')
})

test('taskStackView: stack order, depth and innermost flag', () => {
  const m = taskStackView(NESTED)
  assert.equal(m.count, 3)
  assert.deepEqual(m.open.map((t) => [t.name, t.depth, t.innermost]), [
    ['outer', 1, false],
    ['mid', 2, false],
    ['inner', 3, true]
  ])
  assert.equal(m.innermost, 'inner')
})

test('taskStackView: pending intents and queued closures surface separately', () => {
  const m = taskStackView(NESTED)
  assert.deepEqual(m.pending, { begin: 1, end: 1 })
  // one entry per queued closure, keeping seq so rows can be keyed by it
  assert.deepEqual(m.closing, [{ seq: 25, name: 'old' }, { seq: 27, name: 'older' }])
  // pending entries are NOT part of the open stack
  assert.deepEqual(m.open.map((t) => t.name), ['outer', 'mid', 'inner'])
})

test('taskStackView: malformed marks are skipped, well-formed kept', () => {
  const m = taskStackView({ pending: {}, marks: [{ seq: 1, name: 'ok' }, null, { seq: 2, name: 7 }, { name: 'anon' }] })
  assert.deepEqual(m.open.map((t) => t.name), ['ok', 'anon'])
  assert.equal(m.open[1].seq, 0)
})

test('taskStackView: a stack that is empty but still folding stays visible', () => {
  const folding = taskStackView({ pending: {}, marks: [], pendingArchives: [{ seq: 5, name: 'done' }] })
  assert.equal(folding.empty, true)
  assert.equal(folding.visible, true)
  const beginning = taskStackView({ pending: { c: { kind: 'begin', anchorSeq: 9 } }, marks: [] })
  assert.equal(beginning.visible, true)
})

test('summaries: counts tail, expanded meta and collapsed line', () => {
  assert.equal(tailSummary(taskStackView(EMPTY)), '')
  assert.equal(countsSummary(taskStackView(EMPTY)), '')
  assert.equal(planSummary(taskStackView(EMPTY)), '')

  const one = taskStackView(ONE)
  assert.equal(countsSummary(one), '1 open')
  assert.equal(tailSummary(one), '')
  assert.equal(planSummary(one), '1 open · recon')

  const nested = taskStackView(NESTED)
  assert.equal(tailSummary(nested), '2 folding · 2 pending')
  assert.equal(countsSummary(nested), '3 open · 2 folding · 2 pending')
  // the expanded header must not repeat a name that is listed right below it
  assert.doesNotMatch(countsSummary(nested), /inner/)
  assert.equal(planSummary(nested), '3 open · inner · 2 folding · 2 pending')

  assert.equal(planSummary(taskStackView({ pending: { c: { kind: 'begin', anchorSeq: 9 } }, marks: [] })), 'opening a task…')
  assert.equal(planSummary(taskStackView({ pending: { c: { kind: 'end', anchorSeq: 9 } }, marks: [] })), 'closing a task…')
  assert.equal(planSummary(), '')
  assert.equal(planSummary({ nonsense: true }), '')
})

test('taskStackCss: host card geometry, no browser-default list markers', () => {
  const css = taskStackCss()
  // composer-aligned card, copied from the host's own list dock
  assert.match(css, /--dsh-composer-side-clearance/)
  assert.match(css, /--dsh-composer-dock-inset/)
  assert.match(css, /--dsh-composer-card-max-width/)
  assert.match(css, /margin:0 auto/)
  assert.match(css, /border-radius:12px/)
  assert.match(css, /var\(--dsw-specific-tip\)/)
  assert.match(css, /list-style:none/)
  // every composer variable is read with a fallback: a missing variable must
  // degrade to full width, never to an invalid calc
  for (const m of css.match(/var\(--dsh-composer-[a-z-]+\)/g) || []) {
    assert.fail('composer variable without fallback: ' + m)
  }
  assert.match(css, /var\(--dsh-composer-dock-inset,0px\)/)
})

test('injectTaskStackCss: appends once, keyed by data-plugin-css', () => {
  const appended = []
  const doc = {
    head: { appendChild: (tag) => { appended.push(tag); return tag } },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: () => null
  }
  assert.equal(injectTaskStackCss(doc), true)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].dataset.pluginCss, TASK_STACK_CSS_ID)
  assert.equal(appended[0].dataset.plugin, 'dsh-taskfold')
  assert.equal(appended[0].textContent, taskStackCss())

  // second activation (remount / hot reload): already-present tag is reused
  const present = {
    head: { appendChild: () => { appended.push('unexpected'); return null } },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: (sel) => (sel.includes(TASK_STACK_CSS_ID) ? {} : null)
  }
  assert.equal(injectTaskStackCss(present), false)
  assert.equal(appended.length, 1)

  // defensive: no document / no host
  assert.equal(injectTaskStackCss(null), false)
  assert.equal(injectTaskStackCss({}), false)
})

// ── markup assertions (only when a react install is resolvable) ─────────────

function tryResolveReact() {
  const roots = [
    process.env.DSH_TEST_REACT_ROOT,
    'C:/Users/yindf/.dsh/profiles/node_modules/'
  ].filter(Boolean)
  for (const root of roots) {
    try {
      const require = createRequire(root)
      const react = require('react')
      const server = require('react-dom/server')
      return { react, server }
    } catch (err) { /* try next root */ }
  }
  return null
}

const reactEnv = tryResolveReact()
const noReact = reactEnv === null && 'react not resolvable; set DSH_TEST_REACT_ROOT to enable markup assertions'

test('makeTaskStack: renders nothing when there is no stack to show', { skip: noReact }, () => {
  const TaskStack = makeTaskStack(reactEnv.react)
  const { renderToStaticMarkup } = reactEnv.server
  for (const state of [EMPTY, null, { pending: {}, marks: [] }, undefined]) {
    assert.equal(renderToStaticMarkup(reactEnv.react.createElement(TaskStack, { model: taskStackView(state) })), '')
  }
})

test('makeTaskStack: card header, rails, and the active row', { skip: noReact }, () => {
  const TaskStack = makeTaskStack(reactEnv.react)
  const { renderToStaticMarkup } = reactEnv.server
  const one = renderToStaticMarkup(reactEnv.react.createElement(TaskStack, { model: taskStackView(ONE) }))
  assert.match(one, /class="tf_root"/)
  assert.match(one, /class="tf_header"/)
  assert.match(one, /aria-expanded="true"/)
  assert.match(one, />tasks</)
  assert.match(one, /class="tf_meta">1 open</)
  assert.match(one, />recon</)
  assert.match(one, /tf_nameActive/)
  assert.match(one, /tf_nodeActive/)
  // the old crude rendering used an <ol> with browser default numbering
  assert.doesNotMatch(one, /<ol/)

  const nested = renderToStaticMarkup(reactEnv.react.createElement(TaskStack, { model: taskStackView(NESTED) }))
  assert.ok(nested.indexOf('outer') < nested.indexOf('mid'), 'outer rendered before mid')
  assert.ok(nested.indexOf('mid') < nested.indexOf('inner'), 'mid rendered before inner')
  // depth becomes rail bars, not decimal prefixes
  assert.equal((nested.match(/class="tf_bar"/g) || []).length, 3, '1 + 2 rail bars for depths 1 and 2 sibling rows')
  assert.match(nested, /class="tf_meta">3 open · 2 folding · 2 pending</)
})

test('makeTaskStack: one row per folding task, never a joined line', { skip: noReact }, () => {
  const TaskStack = makeTaskStack(reactEnv.react)
  const { renderToStaticMarkup } = reactEnv.server
  const nested = renderToStaticMarkup(reactEnv.react.createElement(TaskStack, { model: taskStackView(NESTED) }))
  assert.equal((nested.match(/folding…/g) || []).length, 2, 'each queued closure gets its own row')
  assert.match(nested, />old</)
  assert.match(nested, />older</)
  assert.doesNotMatch(nested, /old, older/)
  assert.match(nested, /tf_nodeClosing/)
})

test('makeTaskStack: pending intent row, and collapsed state', { skip: noReact }, () => {
  const TaskStack = makeTaskStack(reactEnv.react)
  const { renderToStaticMarkup } = reactEnv.server
  const pending = renderToStaticMarkup(reactEnv.react.createElement(TaskStack, {
    model: taskStackView({ pending: { a: { kind: 'begin' }, b: { kind: 'end' } }, marks: [{ seq: 1, name: 'live' }] })
  }))
  assert.match(pending, /opening… closing…/)

  const collapsed = renderToStaticMarkup(reactEnv.react.createElement(TaskStack, {
    model: taskStackView(NESTED),
    defaultCollapsed: true
  }))
  assert.match(collapsed, /aria-expanded="false"/)
  assert.match(collapsed, /class="tf_meta">3 open · inner · 2 folding · 2 pending</)
  assert.doesNotMatch(collapsed, /<ul/, 'collapsed card hides the list')
  assert.doesNotMatch(collapsed, />mid</)
})

test('makeTaskStackDock: reads the live taskMarks projection through useProjection', { skip: noReact }, () => {
  const TaskStackDock = makeTaskStackDock(reactEnv.react)
  const { renderToStaticMarkup } = reactEnv.server
  const h = reactEnv.react.createElement

  // host with no projection (old installs): useProjection returns undefined
  assert.equal(renderToStaticMarkup(h(TaskStackDock, { useProjection: () => undefined })), '')
  // empty stack: the dock occupies no space at all
  assert.equal(renderToStaticMarkup(h(TaskStackDock, { useProjection: () => null })), '')

  // live stack fixture
  let lastKey = ''
  const useProjection = (key) => { lastKey = key; return NESTED }
  const live = renderToStaticMarkup(h(TaskStackDock, { useProjection, t: () => '' }))
  assert.equal(lastKey, 'taskMarks', 'dock reads the taskMarks projection key')
  assert.match(live, />outer</)
  assert.match(live, />inner</)
  assert.match(live, /tf_nameActive/)
  assert.match(live, /folding…/)

  // v8 persisted shape (no pendingArchives) must not crash the dock
  const v8 = renderToStaticMarkup(h(TaskStackDock, { useProjection: () => ({ pending: {}, marks: [{ seq: 3, name: 'legacy' }] }) }))
  assert.match(v8, />legacy</)

  // unescaped task names are host-untrusted text: react must escape them
  const evil = renderToStaticMarkup(h(TaskStackDock, {
    useProjection: () => ({ pending: {}, marks: [{ seq: 4, name: '<img src=x onerror=alert(1)>' }] })
  }))
  assert.doesNotMatch(evil, /<img/)

  // dock without the host render prop (defensive)
  assert.equal(renderToStaticMarkup(h(TaskStackDock, {})), '')
})

test('TASK_STACK_KEY stays aligned with the host projection key', () => {
  assert.equal(TASK_STACK_KEY, TASK_MARKS_KEY)
})

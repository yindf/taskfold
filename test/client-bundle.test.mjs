// Tests for the generated browser client bundle (client/taskfold-client.mjs):
// freshness (committed bytes must equal a fresh build), envelope contract
// (loader factory form, exports.apply/inject), and the ESM-stripping
// transform (embedding must never leak import/export into a classic script).
// Run in-process (the sandbox blocks node --test child processes):
//   node test/client-bundle.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformModel, renderBundle, clientBundlePath, repoBundleText, CLIENT_ID, TASK_STACK_DOCK_ID } from '../scripts/build-client.mjs'
import { assertClientBundleFresh } from '../scripts/release.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundlePath = clientBundlePath(root)
const committed = readFileSync(bundlePath, 'utf8')

test('committed client bundle is fresh (byte-equal to a rebuild)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'client', 'package.json'), 'utf8'))
  const template = readFileSync(join(root, 'scripts', 'taskfold-client.template.mjs'), 'utf8')
  const model = transformModel(readFileSync(join(root, 'plugins', 'task-stack-ui.mjs'), 'utf8'))
  const settingsModel = transformModel(readFileSync(join(root, 'plugins', 'fold-settings-ui.mjs'), 'utf8'))
  const rebuilt = renderBundle({ template, model, settingsModel, pkgId: pkg.name, dockId: TASK_STACK_DOCK_ID })
  assert.equal(rebuilt, committed, 'regenerate with: node scripts/build-client.mjs')
})

test('bundle envelope is loader-factory form with apply/inject exports', () => {
  assert.match(committed, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(committed, /id: ["']dsh-taskfold-client["']/)
  assert.match(committed, /let react = require\("react"\)/)
  assert.ok(committed.includes('exports.apply = apply'))
  assert.ok(committed.includes('exports.inject = inject'))
  assert.match(committed, /const inject = \["slots"\]/)
})

test('bundle registers the task-stack dock beside shipped docks', () => {
  assert.ok(committed.includes('"conversation.input.dock"'))
  assert.match(committed, /id: "task-stack"/)
  assert.match(committed, /order: 15/)
  assert.ok(committed.includes('makeTaskStackDock(react)'))
  assert.ok(committed.includes('useProjection'))
})

test('bundle registers the fold-floor settings card on the Plugins page', () => {
  assert.ok(committed.includes('require("@deepseek-ai/dsh-client-ui-primitives")'))
  assert.ok(committed.includes('makeFoldSettingsCard(react, primitives)'))
  assert.ok(committed.includes('"plugins.item"'))
  assert.ok(committed.includes('configForms.get(FoldSettings.FOLD_SETTINGS_PLUGIN_NS)'))
  assert.ok(committed.includes("configForms.whileServed"))
  assert.ok(committed.includes('id: "taskfold"'))
  assert.match(committed, /order: 40/)
})

test('transformModel removes ESM keywords and stays embeddable', () => {
  const source = readFileSync(join(root, 'plugins', 'task-stack-ui.mjs'), 'utf8')
  const body = transformModel(source)
  assert.equal(body.match(/\b(?:import|export)\s+/g), null, 'no ESM statements may survive')
  assert.doesNotThrow(() => new Function(body), 'model body must parse in function scope')
  assert.ok(body.includes('function taskStackView('))
  assert.ok(body.includes('function makeTaskStackDock('))
})

test('fold-floor field spec clamps drafts to the schema bounds', async () => {
  const { minSpanNodesFieldSpec } = await import('../plugins/fold-settings-ui.mjs')
  const primitives = { settingsNumberField: (f) => ({
    field: f,
    format: (v) => typeof v === 'number' ? String(v) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    }
  }) }
  const spec = minSpanNodesFieldSpec(primitives)
  assert.deepEqual(spec.parse('8'), { kind: 'set', value: 8 })
  assert.deepEqual(spec.parse(' 0 '), { kind: 'set', value: 0 })
  assert.deepEqual(spec.parse('100000'), { kind: 'set', value: 100000 })
  assert.deepEqual(spec.parse(''), { kind: 'clear' })
  assert.equal(spec.parse('-1'), undefined)
  assert.equal(spec.parse('100001'), undefined)
  assert.equal(spec.parse('3.5'), undefined)
  assert.equal(spec.parse('abc'), undefined)
})

test('nested client package owns the browser half; root declares no client', () => {
  const clientPkg = JSON.parse(readFileSync(join(root, 'client', 'package.json'), 'utf8'))
  assert.equal(clientPkg.name, 'dsh-taskfold-client')
  assert.equal(clientPkg.exports?.['./client'], './taskfold-client.mjs')
  assert.ok(clientPkg.dsh?.client?.platform === 'web', 'client package dsh.client.platform must be web')
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(rootPkg.dsh?.client, undefined, 'root package must NOT declare dsh.client (two mounted rows would collide)')
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: taskfold-client/)
  assert.match(patch, /\.\/client\/index\.mjs/)
})

test('the release guard runs the default-root path it actually uses', () => {
  assert.equal(clientBundlePath(), join(root, 'client', 'taskfold-client.mjs'), 'default root must be this repo')
  assert.equal(repoBundleText(), committed, 'default-root render must equal the committed bytes')
  assert.doesNotThrow(() => assertClientBundleFresh(), 'the exact call cmdDraft/cmdRelease make')
})

test('the release guard rejects a stale bundle instead of crashing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-taskfold-stale-'))
  mkdirSync(join(tmp, 'plugins'), { recursive: true })
  mkdirSync(join(tmp, 'scripts'), { recursive: true })
  mkdirSync(join(tmp, 'client'), { recursive: true })
  copyFileSync(join(root, 'client', 'package.json'), join(tmp, 'client', 'package.json'))
  copyFileSync(join(root, 'scripts', 'taskfold-client.template.mjs'), join(tmp, 'scripts', 'taskfold-client.template.mjs'))
  copyFileSync(join(root, 'plugins', 'task-stack-ui.mjs'), join(tmp, 'plugins', 'task-stack-ui.mjs'))
  copyFileSync(join(root, 'plugins', 'fold-settings-ui.mjs'), join(tmp, 'plugins', 'fold-settings-ui.mjs'))
  writeFileSync(join(tmp, 'client', 'taskfold-client.mjs'), '// stale bundle\n')
  assert.throws(() => assertClientBundleFresh(tmp), /is stale/, 'a stale artifact must fail the release, not crash the guard')
  copyFileSync(bundlePath, join(tmp, 'client', 'taskfold-client.mjs'))
  assert.doesNotThrow(() => assertClientBundleFresh(tmp))
})
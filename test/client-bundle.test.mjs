// Tests for the generated browser client bundle (plugins/taskfold-client.mjs):
// freshness (committed bytes must equal a fresh build), envelope contract
// (loader factory form, exports.apply/inject), and the ESM-stripping
// transform (embedding must never leak import/export into a classic script).
// Run in-process (the sandbox blocks node --test child processes):
//   node test/client-bundle.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformModel, renderBundle, clientBundlePath, CLIENT_ID, TASK_STACK_DOCK_ID } from '../scripts/build-client.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundlePath = clientBundlePath(root)
const committed = readFileSync(bundlePath, 'utf8')

test('committed client bundle is fresh (byte-equal to a rebuild)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const template = readFileSync(join(root, 'scripts', 'taskfold-client.template.mjs'), 'utf8')
  const model = transformModel(readFileSync(join(root, 'plugins', 'task-stack-ui.mjs'), 'utf8'))
  const rebuilt = renderBundle({ template, model, pkgId: pkg.name, dockId: TASK_STACK_DOCK_ID })
  assert.equal(rebuilt, committed, 'regenerate with: node scripts/build-client.mjs')
})

test('bundle envelope is loader-factory form with apply/inject exports', () => {
  assert.match(committed, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(committed, /id: ["']dsh-taskfold["']/)
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

test('transformModel removes ESM keywords and stays embeddable', () => {
  const source = readFileSync(join(root, 'plugins', 'task-stack-ui.mjs'), 'utf8')
  const body = transformModel(source)
  assert.equal(body.match(/\b(?:import|export)\s+/g), null, 'no ESM statements may survive')
  assert.doesNotThrow(() => new Function(body), 'model body must parse in function scope')
  assert.ok(body.includes('function taskStackView('))
  assert.ok(body.includes('function makeTaskStackDock('))
})

test('manifest routes exports["./client"] to the committed bundle', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports?.['./client'], './plugins/taskfold-client.mjs')
  assert.ok(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web')
})
// Tests for the generated browser client bundle (client/taskfold-client.mjs):
// freshness (committed bytes must equal a fresh build), envelope contract
// (loader factory form, exports.apply/inject), and the ESM-stripping
// transform (embedding must never leak import/export into a classic script).
// Run in-process (the sandbox blocks node --test child processes):
//   node test/client-bundle.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
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
  assert.ok(committed.includes('makeTaskStackDock(react,'))
  assert.ok(committed.includes('useProjection'))
  /* The dock registration must NOT declare a locale namespace: scoped slots
   * throw on locale-declaring entries when no locale face is installed, and
   * the dock has to render on every deployment. Localized copy arrives via
   * the dockReader ref, wired by a locale-only fiber below, with per-call
   * fallback to the English built-ins inside the model. */
  assert.equal(committed.includes('locale: TASK_STACK_UI_NS'), false, 'dock registration must stay locale-free')
  assert.ok(committed.includes('ctx.inject(["locale"], (lctx) => {'), 'a locale-only fiber owns the dictionaries (no configForms dependency)')
  assert.ok(committed.includes('lctx.locale.register(TASK_STACK_UI_NS'))
  assert.ok(committed.includes('zh: taskStackZh'))
  assert.ok(committed.includes('dockReader = lctx.locale.bind(TASK_STACK_UI_NS)'), 'the dock reader follows the locale fiber lifetime')
})

test('fold-settings dictionaries ship exact en/zh key parity', async () => {
  const { makeFoldSettingsCard } = await import('../plugins/fold-settings-ui.mjs')
  const stubReact = { createElement: () => null, Fragment: null }
  const card = makeFoldSettingsCard(stubReact, {})
  assert.deepEqual(
    Object.keys(card.foldSettingsZh).sort(),
    Object.keys(card.foldSettingsEn).sort(),
    'every settings-card copy key must exist in both languages'
  )
  for (const [key, value] of Object.entries(card.foldSettingsEn)) {
    assert.equal(typeof card.foldSettingsZh[key], 'string', 'zh missing key: ' + key)
    assert.ok(value.length > 0 && card.foldSettingsZh[key].length > 0, 'empty copy: ' + key)
  }
})

test('package metadata is localized through exported locale files', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./locale/*'], './locale/*', 'readPluginMeta resolves <pkg>/locale/<lang>.json through exports')
  assert.ok(pkg.files.includes('locale'), 'the published package must ship its locale directory')
  const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
  assert.equal(typeof en?.meta?.title, 'string')
  assert.equal(typeof en?.meta?.description, 'string')
  assert.equal(typeof zh?.meta?.title, 'string')
  assert.equal(typeof zh?.meta?.description, 'string')
  assert.notEqual(zh.meta.description, en.meta.description, 'zh must carry a real translation, not the English text')
})

test('each Plugins-page row mounts a specifier its own subsystem reads', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./plugins'], './plugins/taskfold.mjs', 'the host row subpath must resolve to the mounted module')
  /* The client row mounts its OWN package name, the way the official bundles
   * mount their halves. A subpath of the root package would be dropped by
   * client-modules (locatePkgJson() accepts only a path-like name or an exact
   * bare package name), and a path-like name gets no plugin metadata at all —
   * the Plugins page would print the resolved file:/// URL as the row title. */
  assert.equal(pkg.exports['./client'], undefined, 'the client row must never mount a subpath of the root package')
  assert.equal(pkg.dependencies?.['dsh-taskfold-client'], 'file:./client', 'the component name must be declared: dsh-app-boot publishes a bundle\'s resolvable dependencies as profile-scope resolution entries')
  /* The host row subpath IS covered by the ./plugins/* wildcard, so the only
   * thing keeping its description empty is the absence of that manifest. */
  assert.equal(existsSync(join(root, 'plugins', 'package.json')), false, 'a manifest under plugins/ would hand readPluginMeta a description fallback')
  const hostEn = JSON.parse(readFileSync(join(root, 'plugins', 'locale', 'en.json'), 'utf8'))
  const hostZh = JSON.parse(readFileSync(join(root, 'plugins', 'locale', 'zh.json'), 'utf8'))
  /* The client row is titled by the nested package's own locale; its manifest
   * description stays empty because the row's one-line introduction must come
   * from the locale file, never from this English fallback. */
  const clientEn = JSON.parse(readFileSync(join(root, 'client', 'locale', 'en.json'), 'utf8'))
  const clientZh = JSON.parse(readFileSync(join(root, 'client', 'locale', 'zh.json'), 'utf8'))
  const rootEn = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
  const rootZh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
  assert.equal(hostEn.meta.title, 'Taskfold')
  assert.equal(hostZh.meta.title, 'Taskfold')
  assert.equal(clientEn.meta.title, 'Taskfold Client')
  assert.equal(clientZh.meta.title, 'Taskfold 客户端')
  /* client.js prints a row's id only when the title differs from the row id and
   * the module name only when the title differs from that (`title === row.rowId
   * ? null : code(rowId)`). Titles distinct from BOTH are therefore what keeps
   * the two rows the same shape — title, introduction, row id, module name —
   * which is how the official bundles' rows render. */
  for (const row of [
    { rowId: 'taskfold', moduleName: 'dsh-taskfold/plugins', en: hostEn.meta, zh: hostZh.meta },
    { rowId: 'taskfold-client', moduleName: 'dsh-taskfold-client', en: clientEn.meta, zh: clientZh.meta }
  ]) {
    for (const lang of ['en', 'zh']) {
      const meta = row[lang]
      assert.equal(typeof meta.description, 'string', lang + ' row introduction must exist')
      assert.ok(meta.description.length > 0, lang + ' row introduction must not be empty')
      assert.notEqual(meta.title, row.rowId, lang + ' row title must differ from the row id, or the id line vanishes')
      assert.notEqual(meta.title, row.moduleName, lang + ' row title must differ from the module name, or that line vanishes')
    }
    assert.notEqual(row.en.description, row.zh.description, 'each row introduction must be translated, not copied')
    /* One short line per row: the package blurb stays on the page header and the
     * npm listing. */
    assert.ok(row.zh.description.length <= 40, 'zh row introduction must stay short: ' + row.zh.description)
    assert.ok(row.en.description.length <= 96, 'en row introduction must stay short: ' + row.en.description)
    assert.notEqual(row.zh.description, rootZh.meta.description, 'a row must not repeat the package blurb')
    assert.notEqual(row.en.description, rootEn.meta.description, 'a row must not repeat the package blurb')
  }
  const clientPkg = JSON.parse(readFileSync(join(root, 'client', 'package.json'), 'utf8'))
  assert.equal(clientPkg.description, undefined, 'a client manifest description would be the row-introduction fallback')
  /* The component must be reachable BY NAME from the bundle directory — that is
   * the entry dependencyClosure() publishes. node_modules/ is gitignored
   * (`pnpm install` recreates it), so the resolution check only runs when the
   * component link is present. */
  if (existsSync(join(root, 'node_modules', 'dsh-taskfold-client'))) {
    const fromRoot = createRequire(join(root, 'package.json'))
    assert.equal(fromRoot.resolve('dsh-taskfold-client'), join(root, 'client', 'index.mjs'), 'the row name must resolve to the mounted client module')
    assert.equal(fromRoot.resolve('dsh-taskfold-client/package.json'), join(root, 'client', 'package.json'), 'readPluginMeta needs the component manifest')
    assert.equal(fromRoot.resolve('dsh-taskfold-client/locale/en.json'), join(root, 'client', 'locale', 'en.json'), 'readPluginMeta needs the row title through the locale export')
  }
})

test('bundle registers the fold-floor settings card on the Plugins page', () => {
  assert.ok(committed.includes('require("@deepseek-ai/dsh-client-ui-primitives")'))
  assert.ok(committed.includes('makeFoldSettingsCard(react, primitives)'))
  assert.ok(committed.includes('configForms.get(FoldSettings.FOLD_SETTINGS_PLUGIN_NS)'))
  assert.ok(committed.includes("configForms.whileServed"))
  /* The bundle.config slot is the only registration: plugins.item is reserved
   * for official companions, so a third-party bundle must not pose there. */
  assert.ok(committed.includes('"plugins.bundle.config"'))
  assert.ok(committed.includes('key: "dsh-taskfold"'))
  assert.ok(committed.includes('locale: FoldSettings.FOLD_SETTINGS_NS'))
  assert.equal(committed.includes('"plugins.item"'), false)
})

test('the fold-settings card binds the namespace the host serves (its row id)', async () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const rows = [...patch.matchAll(/-\s*id:\s*(\S+)\s*\r?\n\s*name:\s*'([^']+)'/g)].map((m) => ({ id: m[1], name: m[2] }))
  const hostRow = rows.find((r) => r.name === 'dsh-taskfold/plugins')
  assert.ok(hostRow, 'cordis.patch.yml must declare the host row this card configures')
  /* dsh-settings serves ONE config form per profile entry id (the row id), and
   * the card is registered `whileServed`: a rename that misses this constant
   * leaves the card permanently absent with no error anywhere — exactly what
   * the 0.37.7 row rename `cmpct-region` → `taskfold` would have shipped. */
  const { makeFoldSettingsCard } = await import('../plugins/fold-settings-ui.mjs')
  const card = makeFoldSettingsCard({ createElement: () => null, Fragment: null }, {})
  const FOLD_SETTINGS_PLUGIN_NS = card.FOLD_SETTINGS_PLUGIN_NS
  assert.equal(FOLD_SETTINGS_PLUGIN_NS, hostRow.id, 'the card must bind the mounted row id, not a retired one')
  assert.ok(
    committed.includes("FOLD_SETTINGS_PLUGIN_NS = '" + FOLD_SETTINGS_PLUGIN_NS + "'"),
    'the shipped bundle must carry the row id too (regenerate with: node scripts/build-client.mjs)'
  )
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
  const { minSpanTokensFieldSpec } = await import('../plugins/fold-settings-ui.mjs')
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
  const spec = minSpanTokensFieldSpec(primitives)
  assert.deepEqual(spec.parse('8'), { kind: 'set', value: 8 })
  assert.deepEqual(spec.parse(' 0 '), { kind: 'set', value: 0 })
  assert.deepEqual(spec.parse('1000000'), { kind: 'set', value: 1000000 })
  assert.deepEqual(spec.parse(''), { kind: 'clear' })
  assert.equal(spec.parse('-1'), undefined)
  assert.equal(spec.parse('1000001'), undefined)
  assert.equal(spec.parse('3.5'), undefined)
  assert.equal(spec.parse('abc'), undefined)
})

test('nested client package owns the browser half; root declares no client', () => {
  const clientPkg = JSON.parse(readFileSync(join(root, 'client', 'package.json'), 'utf8'))
  assert.equal(clientPkg.name, 'dsh-taskfold-client')
  assert.equal(clientPkg.exports?.['./client'], './taskfold-client.mjs')
  assert.equal(clientPkg.exports?.['./locale/*'], './locale/*', 'readPluginMeta resolves the row title through this export')
  assert.ok(clientPkg.dsh?.client?.platform === 'web', 'client package dsh.client.platform must be web')
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(rootPkg.dsh?.client, undefined, 'root package must NOT declare dsh.client (two mounted rows would collide)')
  assert.equal(rootPkg.dependencies?.['dsh-taskfold-client'], 'file:./client', 'the client package is a declared component, not just a nested directory')
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: taskfold-client/)
  assert.match(patch, /name: 'dsh-taskfold\/plugins'/, 'the host row mounts a package subpath (a relative name renders as a file:/// title)')
  assert.match(patch, /name: 'dsh-taskfold-client'/, 'the client row mounts its own package name: a relative name renders as a file:/// path, and a root subpath is dropped by locatePkgJson()')
  assert.equal(patch.includes("./client/index.mjs'"), false, 'no row may mount the relative client path any more')
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
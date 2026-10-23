/**
 * build-client — generate the browser client bundle for the task-fold web UI.
 *
 * The host serves client bundles as classic scripts in loader-factory form
 * (window.__ModuleLoader__.load({ id, factory })) — a served file cannot
 * contain import/export statements. To keep ONE source of truth per module,
 * this script strips the ESM keywords from plugins/task-stack-ui.mjs and
 * plugins/fold-settings-ui.mjs (both must stay import-free) and splices the
 * bodies into scripts/taskfold-client.template.mjs, emitting
 * client/taskfold-client.mjs. The output is deterministic (no timestamps),
 * committed to the repo, and gated for freshness by test/client-bundle.test.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/** Widget id of this bundle inside the host's module loader: the nested
 * client package's name (the single owner row mounts client/index.mjs). */
export const CLIENT_ID = 'dsh-taskfold-client'
/** Dock id registered under conversation.input.dock (unique beside todo/goal/queue). */
export const TASK_STACK_DOCK_ID = 'task-stack'

/**
 * Strip ESM keywords so the module bodies can run inside the classic-script
 * factory. The shared modules only use `export function` / `export const`
 * declarations, so removing the keyword keeps every binding intact.
 * @param {string} source - raw module source (task-stack-ui.mjs / fold-settings-ui.mjs).
 * @returns {string} body-embedding-compatible source.
 */
export function transformModel(source) {
  const body = source
    .replace(/\bexport\s+(?=function\b)/g, '')
    .replace(/\bexport\s+(?=const\b)/g, '')
  const leftovers = [...body.matchAll(/\b(?:import|export)\s+/g)]
  if (leftovers.length > 0) {
    throw new Error(
      `build-client: task-stack-ui.mjs contains ESM statements the inliner cannot embed: ` +
        leftovers.map((m) => m[0].trim()).join(', ')
    )
  }
  return body
}

/**
 * Substitute EVERY occurrence of one placeholder, with the value inserted
 * literally. `String.replace` was wrong twice over here: a string pattern
 * replaces only the FIRST match (the template declares the dock id at both
 * registrations — mount and re-show — so shipped bundles kept a literal
 * `__DOCK_ID__` in the re-show path), and it reads `$&`/`$'` in the
 * replacement as patterns, so a spliced source carrying `$&` would expand to
 * the placeholder instead of landing verbatim. `split`/`join` does neither.
 * @param {string} text - text to rewrite.
 * @param {string} token - placeholder to replace.
 * @param {string} value - literal replacement.
 * @returns {string} the rewritten text.
 */
function substitute(text, token, value) {
  return text.split(token).join(value)
}

/**
 * Render the bundle text from its inputs (pure; the freshness gate uses it).
 * Every placeholder must be gone from the result: a template that grows a
 * fourth token the build does not know, or an id the substitution misses,
 * would otherwise ship as a literal `__…__` inside a served bundle.
 * @param {object} parts
 * @param {string} parts.template - envelope source with placeholders.
 * @param {string} parts.model - transformed task-stack-ui body.
 * @param {string} parts.settingsModel - transformed fold-settings-ui body.
 * @param {string} parts.pkgId - loader id (package name).
 * @param {string} parts.dockId - dock id under conversation.input.dock.
 * @returns {string} deterministic bundle source.
 */
export function renderBundle({ template, model, settingsModel, pkgId, dockId }) {
  let out = substitute(template, '__TASKFOLD_MODEL_SOURCE__', model)
  out = substitute(out, '__FOLD_SETTINGS_MODEL_SOURCE__', settingsModel)
  out = substitute(out, '__PACKAGE_ID__', pkgId)
  out = substitute(out, '__DOCK_ID__', dockId)
  const leftover = [...new Set([...out.matchAll(/__[A-Z_]+__/g)].map((m) => m[0]))]
  if (leftover.length > 0) {
    throw new Error('build-client: unsubstituted template placeholders: ' + leftover.join(', '))
  }
  return out
}

/** Repo root, derived from this file. Exported so the release guard and the
 *  tests can ask for the bundle without re-deriving (and mis-deriving) it. */
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Absolute path of the emitted bundle file (in the nested client package). */
export function clientBundlePath(root = REPO_ROOT) {
  return join(root, 'client', 'taskfold-client.mjs')
}

/**
 * Render the bundle text for a repo tree, reading package.json, the envelope
 * template and the model (pure: never writes). The release guard compares this
 * against the committed bytes, so sharing ONE function with the build is what
 * guarantees the two sides read the same inputs.
 * @param {string} [root] - repo root; defaults to this repo.
 * @returns {string} the bundle source the build would emit.
 */
export function repoBundleText(root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'client', 'package.json'), 'utf8'))
  const template = readFileSync(join(root, 'scripts', 'taskfold-client.template.mjs'), 'utf8')
  const model = transformModel(readFileSync(join(root, 'plugins', 'task-stack-ui.mjs'), 'utf8'))
  const settingsModel = transformModel(readFileSync(join(root, 'plugins', 'fold-settings-ui.mjs'), 'utf8'))
  return renderBundle({ template, model, settingsModel, pkgId: pkg.name, dockId: TASK_STACK_DOCK_ID })
}

/** Build the bundle into the repo tree. @returns the emitted absolute path. */
export function buildClient(root = REPO_ROOT) {
  const out = repoBundleText(root)
  const path = clientBundlePath(root)
  writeFileSync(path, out)
  return path
}

// CLI entry: node scripts/build-client.mjs
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const path = buildClient()
  console.log(`build-client: wrote ${path}`)
}
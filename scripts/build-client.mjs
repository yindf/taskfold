/**
 * build-client — generate the browser client bundle for the task-fold web UI.
 *
 * The host serves client bundles as classic scripts in loader-factory form
 * (window.__ModuleLoader__.load({ id, factory })) — a served file cannot
 * contain import/export statements. To keep ONE source of truth for the
 * presentation logic, this script strips the ESM keywords from
 * plugins/task-stack-ui.mjs (which must stay import-free) and splices the
 * body into scripts/taskfold-client.template.mjs, emitting
 * plugins/taskfold-client.mjs. The output is deterministic (no timestamps),
 * committed to the repo, and gated for freshness by test/client-bundle.test.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/** Widget id of this bundle inside the host's module loader. */
export const CLIENT_ID = 'dsh-taskfold'
/** Dock id registered under conversation.input.dock (unique beside todo/goal/queue). */
export const TASK_STACK_DOCK_ID = 'task-stack'

/**
 * Strip ESM keywords so the module body can run inside the classic-script
 * factory. The shared module only uses `export function` / `export const`
 * declarations, so removing the keyword keeps every binding intact.
 * @param {string} source - raw module source.
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
 * Render the bundle text from its inputs (pure; the freshness gate uses it).
 * @param {object} parts
 * @param {string} parts.template - envelope source with placeholders.
 * @param {string} parts.model - transformed model body.
 * @param {string} parts.pkgId - loader id (package name).
 * @param {string} parts.dockId - dock id under conversation.input.dock.
 * @returns {string} deterministic bundle source.
 */
export function renderBundle({ template, model, pkgId, dockId }) {
  return template
    .replace('__TASKFOLD_MODEL_SOURCE__', model)
    .replace('__PACKAGE_ID__', pkgId)
    .replace('__DOCK_ID__', dockId)
}

/** Absolute path of the emitted bundle file. */
export function clientBundlePath(root) {
  return join(root, 'plugins', 'taskfold-client.mjs')
}

/** Build the bundle into the repo tree. @returns the emitted absolute path. */
export function buildClient(root = dirname(dirname(fileURLToPath(import.meta.url)))) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const template = readFileSync(join(root, 'scripts', 'taskfold-client.template.mjs'), 'utf8')
  const model = transformModel(readFileSync(join(root, 'plugins', 'task-stack-ui.mjs'), 'utf8'))
  const out = renderBundle({ template, model, pkgId: pkg.name, dockId: TASK_STACK_DOCK_ID })
  const path = clientBundlePath(root)
  writeFileSync(path, out)
  return path
}

// CLI entry: node scripts/build-client.mjs
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const path = buildClient()
  console.log(`build-client: wrote ${path}`)
}
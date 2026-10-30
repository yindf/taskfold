/**
 * Host half of the dedicated client row for the taskfold browser bundle.
 *
 * client-modules requires every client package (a package.json declaring
 * dsh.client) to be owned by EXACTLY ONE Loader row: two rows of one package
 * make it throw "resolves from multiple active Loader sources" and the whole
 * browser half is dropped from the boot graph. A client half can therefore
 * never share the single mounted host row (taskfold), so the browser bundle
 * lives in its own nested package (this directory) and this row is its single
 * owner — the same shape as the official ui-settings companion packages: an
 * empty apply, present only so the row exists for the client module system.
 */
export default {
  name: 'taskfold-client',
  apply() {}
}

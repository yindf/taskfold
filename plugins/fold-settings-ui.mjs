/**
 * foldSettingsUi — the Settings-page card for the fold floor (client half).
 *
 * The host's Settings/Plugins page does NOT auto-render a plugin's exported
 * Config schema: `autoGenerate` is reserved for schema-driven clients and no
 * shipped client builds pages that way (dsh-settings README). Every visible
 * card is a browser-half component that binds its namespace through
 * `ctx.configForms` and registers into the Plugins page's `plugins.item`
 * slot — this module is taskfold's card for the `cmpct-region` namespace's
 * volatile `minSpanNodes` field (schema: compact-region.mjs Config export).
 *
 * Structure copies the official ui-settings-subagent companion: a
 * SettingsFormModel staging edits over the namespace, one SettingsValueField
 * control, one save/discard footer, and a `whileServed` registration so the
 * card appears exactly while the Host serves the namespace.
 *
 * Import-free by contract: react and the ui-primitives module arrive via the
 * makeFoldSettingsCard factory so this file stays loadable in node tests.
 * The client bundle build (scripts/build-client.mjs) inlines it beside
 * task-stack-ui.mjs.
 */

/** Namespace of this card's dictionary entries. */
const FOLD_SETTINGS_NS = 'settings.taskfold'
/** Host settings namespace this card edits — the profile entry id. */
const FOLD_SETTINGS_PLUGIN_NS = 'cmpct-region'
/** The one volatile field this card stages. */
const FOLD_SETTINGS_FIELD = 'minSpanNodes'
/** Inclusive bounds, mirroring the Config schema in compact-region.mjs. */
const FOLD_SETTINGS_MIN = 0
const FOLD_SETTINGS_MAX = 100000

/** English copy. */
const foldSettingsEn = {
  title: 'Taskfold',
  summary: 'Set the fold floor: how long a finished task must be before a summary is billed for it.',
  fieldLabel: 'Fold floor (messages + tool results)',
  helpLabel: 'About the fold floor',
  helpBody: 'A closed task folds into a summary only when its span covers at least this many surface nodes (messages + tool results). Shorter spans close unfolded — their original content stays on the surface, so no summarization call is billed. 0 folds everything.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  invalid: 'Enter a whole number between 0 and 100000.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  save: 'Save',
  saving: 'Saving…'
}

/** Simplified Chinese copy. */
const foldSettingsZh = {
  title: 'Taskfold',
  summary: '设置折叠下限：任务结束后至少多长才会为摘要计费。',
  fieldLabel: '折叠下限（消息 + 工具结果数）',
  helpLabel: '折叠下限说明',
  helpBody: '任务关闭后，只有其折叠区间覆盖的表面节点（消息 + 工具结果）不少于该数量时才会调用模型生成摘要；更短的区间直接关闭、不折叠，原始内容保留在表面上，不产生摘要计费。0 表示全部折叠。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalid: '请输入 0 到 100000 之间的整数。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  readOnly: '本部署的设置为只读。',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  save: '保存',
  saving: '保存中…'
}

/**
 * Wrap ui-primitives' whole-number field with the floor's inclusive bounds.
 * A draft that parses but falls outside 0..100000 is invalid (blocks save);
 * an empty draft still clears back to the composition default.
 * Pure — exported for offline tests.
 * @param {object} primitives - ui-primitives module (settingsNumberField).
 * @returns {object} field conversion spec for SettingsFormModel.
 */
export function minSpanNodesFieldSpec(primitives) {
  const numeric = primitives.settingsNumberField(FOLD_SETTINGS_FIELD)
  return {
    ...numeric,
    parse: (text) => {
      const write = numeric.parse(text)
      if (write?.kind !== 'set') return write
      const value = write.value
      return Number.isSafeInteger(value) &&
        value >= FOLD_SETTINGS_MIN &&
        value <= FOLD_SETTINGS_MAX &&
        !Object.is(value, -0)
        ? write
        : undefined
    }
  }
}

/**
 * The labels the shared SettingsForm footer renders, from this card's copy.
 * @param {Function} t - this card's locale reader.
 * @returns {object} footer labels.
 */
function foldSettingsFormLabels(t) {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving')
  }
}

/**
 * Build the card module: component + form factory + constants.
 * @param {object} react - the react module (createElement, Fragment).
 * @param {object} primitives - ui-primitives (SettingsForm, SettingsValueField, SettingsFormModel).
 * @returns {object} the pieces the client bundle wires together.
 */
export function makeFoldSettingsCard(react, primitives) {
  const h = react.createElement
  const Fragment = react.Fragment

  /**
   * Stage one field over the `cmpct-region` namespace.
   * @param {object} scope - ctx.configForms.get('cmpct-region').
   * @returns {{ inject: () => object, dispose: () => void }} slot face + release.
   */
  function makeFoldSettingsForm(scope) {
    const form = new primitives.SettingsFormModel(scope, [minSpanNodesFieldSpec(primitives)])
    const store = form.bind(() => ({
      ...form.shell(),
      minSpanNodes: form.field(FOLD_SETTINGS_FIELD)
    }))
    return {
      inject() {
        return {
          hooks: { foldSettingsCard: store },
          ...form.actions()
        }
      },
      dispose() {
        form.dispose()
      }
    }
  }

  /**
   * The card: Plugins-page summary text, or the one-field form with footer.
   * Props arrive from the plugins.item slot: t, view, useFoldSettingsCard,
   * and the staged actions (edit/resetField/save/discard).
   */
  function FoldSettingsCard(props) {
    const t = props.t
    const state = props.useFoldSettingsCard((snapshot) => snapshot)
    if (props.view === 'summary') return t('summary')
    return h(
      primitives.SettingsForm,
      { labels: foldSettingsFormLabels(t), state, onSave: props.save, onDiscard: props.discard },
      h(primitives.SettingsValueField, {
        id: 'plugin-config-taskfold-min-span-nodes',
        label: t('fieldLabel'),
        help: {
          label: t('helpLabel'),
          content: h('p', null, t('helpBody'))
        },
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalid'),
        numeric: true,
        disabled: !state.writable || state.saving,
        ...state.minSpanNodes,
        onEdit: (text) => { props.edit(FOLD_SETTINGS_FIELD, text) },
        onReset: () => { props.resetField(FOLD_SETTINGS_FIELD) }
      })
    )
  }

  return {
    FOLD_SETTINGS_NS,
    FOLD_SETTINGS_PLUGIN_NS,
    foldSettingsEn,
    foldSettingsZh,
    minSpanNodesFieldSpec,
    makeFoldSettingsForm,
    FoldSettingsCard
  }
}

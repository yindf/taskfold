/**
 * foldSettingsUi — the Settings-page card for the fold floor (client half).
 *
 * The host's Settings/Plugins page does NOT auto-render a plugin's exported
 * Config schema: `autoGenerate` is reserved for schema-driven clients and no
 * shipped client builds pages that way (dsh-settings README). Every visible
 * card is a browser-half component that binds its namespace through
 * `ctx.configForms` and registers into the Plugins page's slots — this
 * module is taskfold's card for the `cmpct-region` namespace's
 * volatile `minSpanTokens` field (schema: compact-region.mjs Config export).
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
const FOLD_SETTINGS_FIELD = 'minSpanTokens'
/** The task-bar visibility field this card stages (boolean). */
const TASKBAR_FIELD = 'showTaskBar'
/** Inclusive bounds, mirroring the Config schema in compact-region.mjs. */
const FOLD_SETTINGS_MIN = 0
const FOLD_SETTINGS_MAX = 1000000

/**
 * Section chrome copied from the official ui-settings-subagent card
 * (SubagentCard.module.css): a titled section inside the shared SettingsForm.
 * Client bundles carry no css-modules pipeline, so the two rules travel as
 * inline styles with the same design tokens.
 */
const FOLD_SECTION_STYLE = { minWidth: 0, padding: '16px 0' }
const FOLD_HEADING_STYLE = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)'
}

/** English copy. */
const foldSettingsEn = {
  title: 'Taskfold',
  sectionTitle: 'Fold floor',
  fieldLabel: 'Fold floor (tokens)',
  helpLabel: 'About the fold floor',
  helpBody: 'A closed task folds into a summary only when its span carries at least this many estimated tokens. The count is a CJK-aware heuristic over the span\'s message text, taken before any model call. Shorter spans close unfolded — their original content stays on the surface, so no summarization call is billed. Default 2000: below it the summary\'s fixed overhead outweighs the context saved (docs/fold-floor.md). 0 folds everything.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  invalid: 'Enter a whole number between 0 and 1000000.',
  taskbarLabel: 'Show task bar',
  taskbarHelp: 'Show the task-stack dock beside the conversation input. Hiding it does not affect folding.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  save: 'Save',
  saving: 'Saving…'
}

/** Simplified Chinese copy. */
const foldSettingsZh = {
  title: 'Taskfold',
  sectionTitle: '折叠下限',
  fieldLabel: '折叠下限（token 数）',
  helpLabel: '折叠下限说明',
  helpBody: '任务关闭后，只有其折叠区间携带的估算 token 不少于该数量时才会调用模型生成摘要。token 按消息文本估算（区分中日韩字符），在任何模型调用之前即可算出。更短的区间直接关闭、不折叠，原始内容保留在表面上，不产生摘要计费。默认 2000：低于该值时摘要的固定开销超过省下的上下文（依据见 docs/fold-floor.md）。0 表示全部折叠。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalid: '请输入 0 到 1000000 之间的整数。',
  taskbarLabel: '显示任务栏',
  taskbarHelp: '在对话输入框旁显示任务栏。隐藏它不影响折叠行为。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  readOnly: '本部署的设置为只读。',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  save: '保存',
  saving: '保存中…'
}

/**
 * Wrap ui-primitives' whole-number field with the floor's inclusive bounds.
 * A draft that parses but falls outside 0..1000000 is invalid (blocks save);
 * an empty draft still clears back to the composition default.
 * Pure — exported for offline tests.
 * @param {object} primitives - ui-primitives module (settingsNumberField).
 * @returns {object} field conversion spec for SettingsFormModel.
 */
export function minSpanTokensFieldSpec(primitives) {
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
 * A boolean field staged as its literal text ('true'/'false'), rendered as a
 * Switch. An empty draft clears back to the composition default (true).
 * Pure — exported for offline tests.
 * @returns {object} field conversion spec for SettingsFormModel.
 */
export function showTaskBarFieldSpec() {
  return {
    field: TASKBAR_FIELD,
    format: (value) => value === true ? 'true' : value === false ? 'false' : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      if (trimmed === '') return { kind: 'clear' }
      return undefined
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
    const form = new primitives.SettingsFormModel(scope, [minSpanTokensFieldSpec(primitives), showTaskBarFieldSpec()])
    const store = form.bind(() => ({
      ...form.shell(),
      minSpanTokens: form.field(FOLD_SETTINGS_FIELD),
      showTaskBar: form.field(TASKBAR_FIELD)
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
   * The card: the sectioned form with its save/discard footer. Props arrive
   * from the plugins.bundle.config slot: t (the registration declares its
   * locale namespace), useFoldSettingsCard, and the staged actions
   * (edit/resetField/save/discard). Only the 'page' view is ever rendered
   * for a keyed bundle-config entry.
   */
  function FoldSettingsCard(props) {
    const t = props.t
    const state = props.useFoldSettingsCard((snapshot) => snapshot)
    return h(
      primitives.SettingsForm,
      { labels: foldSettingsFormLabels(t), state, onSave: props.save, onDiscard: props.discard },
      h(
        'section',
        { style: FOLD_SECTION_STYLE, 'aria-labelledby': 'taskfold-fold-floor-heading' },
        h('h3', { id: 'taskfold-fold-floor-heading', style: FOLD_HEADING_STYLE }, t('sectionTitle')),
        h(primitives.SettingsValueField, {
          id: 'plugin-config-taskfold-min-span-tokens',
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
          ...state.minSpanTokens,
          onEdit: (text) => { props.edit(FOLD_SETTINGS_FIELD, text) },
          onReset: () => { props.resetField(FOLD_SETTINGS_FIELD) }
        }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginTop: '16px' } },
          h(
            'span',
            { style: { fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', title: t('taskbarHelp') } },
            t('taskbarLabel')
          ),
          h(primitives.Switch, {
            checked: state.showTaskBar.text === 'true',
            onChange: (next) => { props.edit(TASKBAR_FIELD, next ? 'true' : 'false') },
            label: t('taskbarLabel'),
            disabled: !state.writable || state.saving
          })
        )
      )
    )
  }

  return {
    FOLD_SETTINGS_NS,
    FOLD_SETTINGS_PLUGIN_NS,
    foldSettingsEn,
    foldSettingsZh,
    minSpanTokensFieldSpec,
    makeFoldSettingsForm,
    FoldSettingsCard
  }
}

/**
 * 入力の規則（補完）のフォーム（Task 29 の設計書 3 章の「補完の画面」、4.4。T29e）。
 * - 送る欄ごとに、判定の結果（状態と細分、出どころ、外部到達）を出し、人の規則（意味の種類、作り方、値の一覧、範囲）を編集する。「自動」は人の規則を
 *   持たない（業務テンプレートか汎用の規則で決まる）。選べる意味の種類は、欄の型に合うものだけ（サーバが返した一覧）。
 * - 欄どうしの関係（人が決めたもの）と、一意にする欄の組を編集する。当てる関係と組（テンプレートの既定を含む）も出す。
 * - 保存は、確認のダイアログ（保存すると再承認になることを示す）の後にだけ送る。判定と保存の確かめは、サーバの owner が決める（画面の確かめはない）。
 * - FM2c（手動の操作を減らす設計書 3A.3）: 保存した規則・関係・一意にする欄の組の出どころの印（推した・人）と、基準日からの幅を出す。既定の幅を
 *   使った欄（推測の印。画面のサーバが求めた `defaultRange`）を一覧にする。編集していない規則は、保存した規則のまま送る（出どころの印と基準日からの
 *   幅と桁の数を残す）。編集した規則は人の規則として送る（意味の種類を変えていなければ、基準日からの幅（範囲を入れていないとき）と桁の数は残す）。
 *   一意にする欄の組は、変えていなければ出どころの印を残す。テンプレートの既定を保存した印は、そのまま送る。
 */
import { useState } from 'react';
import type {
  FieldRelation,
  FieldRelationKind,
  FieldRule,
  GenerationMethod,
  RuleOrigin,
  RuleSetContent,
  SemanticKind,
} from '../../../../src/control/data-rules-view.js';
// PRE42-CC 組 UI-K3（台帳の CC-113）: 規則の値の作り方と出どころの印の値は、管理データに触れない純粋な core の owner から読む（書き写さない）。
import { FIXED_LIST_GENERATION_METHOD, TEMPLATE_GENERATION_METHOD } from '../../../../src/core/generation-methods.js';
import { DEFAULT_UNRANGED_DATE_WINDOW_DAYS, DEFAULT_UNRANGED_INTEGER_RANGE } from '../../../../src/core/limits.js';
import { DEFAULT_RULE_ORIGIN } from '../../../../src/core/rule-origins.js';
import { formatCount, formatInteger } from '../../../../src/presentation/format.js';
import {
  DATA_RULE_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_DATA_RULE_INFERENCE_TEXT,
  LOCAL_UI_DATA_RULE_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  RULE_PROBLEM_DETAIL_DESCRIPTIONS,
  SCENARIO_REQUEST_REJECTION_DESCRIPTIONS,
  listText,
} from '../../../../src/presentation/messages.js';
import { candidateFieldConstraintsText } from '../display/candidate-fields';
import { linesOf, textOfLines } from '../display/form-lines';
import {
  externalDeliveryKindDisplay,
  fieldRelationKindDisplay,
  fieldRuleStatusDisplay,
  generationMethodDisplay,
  ruleOriginDisplay,
  ruleSourceDisplay,
  semanticKindDisplay,
  toneClass,
} from '../display/labels';
import type { DataRuleFieldView, DataRulePageView, DataRuleSaveView } from '../server/data-rule-functions';
import { ConfirmDialog } from './ConfirmDialog';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

const text = LOCAL_UI_DATA_RULE_TEXT;
const inferenceText = LOCAL_UI_DATA_RULE_INFERENCE_TEXT;
/** 印のない規則の出どころ（人の規則。契約の `ruleOriginOf` と同じ読み方。PRE42-CC 組 UI-K3: 値は純粋な core の owner から読む）。 */
const UNMARKED_ORIGIN: RuleOrigin = DEFAULT_RULE_ORIGIN;

/** 人の規則のない欄の、意味の種類の選択の値。 */
const AUTO_KIND = '';
/** 人が入れた値の一覧の作り方。 */
const FIXED_METHOD: GenerationMethod = FIXED_LIST_GENERATION_METHOD;
/** 人の規則の既定の作り方（意味の種類を選んだとき）。 */
const DEFAULT_METHOD: GenerationMethod = TEMPLATE_GENERATION_METHOD;
// 値の一覧（1 行に 1 つ）の読み方と書き方は、`display/form-lines.ts` の `linesOf`・`textOfLines`（T43b fix round 1）。

/** 欄 1 つの編集の値。 */
interface FieldDraft {
  readonly kind: SemanticKind | typeof AUTO_KIND;
  readonly method: GenerationMethod;
  readonly fixed: string;
  readonly min: string;
  readonly max: string;
  readonly step: string;
}

const draftOf = (rule: FieldRule | null): FieldDraft => ({
  kind: rule?.semanticKind ?? AUTO_KIND,
  method: rule?.method ?? DEFAULT_METHOD,
  fixed: rule === null ? '' : textOfLines(rule.fixedValues),
  min: rule?.range?.min ?? '',
  max: rule?.range?.max ?? '',
  step: rule?.range?.step ?? '',
});

/** 空の文字は null（範囲の項目）。 */
const orNull = (value: string): string | null => (value.trim().length === 0 ? null : value.trim());

/** 編集の値から、人の規則（「自動」は null）。 */
const ruleOf = (fieldName: string, draft: FieldDraft): FieldRule | null => {
  if (draft.kind === AUTO_KIND) {
    return null;
  }
  const range = { min: orNull(draft.min), max: orNull(draft.max), step: orNull(draft.step) };
  return {
    fieldName,
    semanticKind: draft.kind,
    method: draft.method,
    range: range.min === null && range.max === null && range.step === null ? null : range,
    fixedValues: draft.method === FIXED_METHOD ? linesOf(draft.fixed) : [],
  };
};

/** 2 つの名前の一覧が、同じ名前の集まりか（並びは見ない）。 */
const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  new Set(left).size === new Set(right).size && left.every((name) => right.includes(name));

/** 2 つの編集の値が同じか。 */
const sameDraft = (left: FieldDraft, right: FieldDraft): boolean =>
  left.kind === right.kind && left.method === right.method && left.fixed === right.fixed
  && left.min === right.min && left.max === right.max && left.step === right.step;

/**
 * 送る規則（FM2c）: 編集していなければ保存した規則のまま（出どころの印と基準日からの幅を残す）。編集したら人の規則（範囲を入れず、意味の種類を
 * 変えていなければ、保存した規則の基準日からの幅は残す）。「自動」は null。
 */
const savedRuleOf = (fieldName: string, draft: FieldDraft, stored: FieldRule | null): FieldRule | null => {
  if (stored !== null && sameDraft(draft, draftOf(stored))) {
    return stored;
  }
  const rule = ruleOf(fieldName, draft);
  if (rule === null || stored === null || rule.semanticKind !== stored.semanticKind) {
    return rule;
  }
  // 意味の種類を変えていなければ、保存した規則の基準日からの幅（範囲を入れていないとき）と、番号・コードの桁の数を残す。
  const window = stored.baseDateWindow ?? null;
  const digits = stored.digitCount ?? null;
  return {
    ...rule,
    ...(window === null || rule.range !== null ? {} : { baseDateWindow: window }),
    ...(digits === null ? {} : { digitCount: digits }),
  };
};

/** 関係の欄の名前（役割の順）。 */
const relationNamesOf = (relation: FieldRelation, roles: readonly string[]): readonly string[] =>
  roles.map((role) => (relation as unknown as Readonly<Record<string, string>>)[role] ?? '');

/** 関係の表示（関係の名前と、役割ごとの欄）。 */
const relationTextOf = (relation: FieldRelation, roles: readonly string[]): string => {
  const names = relationNamesOf(relation, roles);
  return `${fieldRelationKindDisplay(relation.kind).label}: ${listText(roles.map((role, index) =>
    `${text.relationRoles[role as keyof typeof text.relationRoles]} ${names[index] ?? ''}`))}`;
};

/** 欄の判定の表示（状態と、細分の説明と手順）。 */
function FieldStatus({ field }: Readonly<{ field: DataRuleFieldView }>) {
  const status = fieldRuleStatusDisplay(field.status);
  return (
    <div data-testid="data-rule-status" data-status={field.status} data-detail={field.problem?.detail ?? ''}>
      <span className={toneClass(status.tone)}>{status.label}</span>
      {field.problem === null ? null : (
        <>
          <p className="field-hint">{RULE_PROBLEM_DETAIL_DESCRIPTIONS[field.problem.detail].description}</p>
          <p className="field-hint">{RULE_PROBLEM_DETAIL_DESCRIPTIONS[field.problem.detail].action}</p>
        </>
      )}
    </div>
  );
}

export function DataRuleForm({ page, onSave, onSaved, onReload }: Readonly<{
  page: DataRulePageView;
  onSave: (content: RuleSetContent) => Promise<DataRuleSaveView>;
  onSaved: (result: Extract<DataRuleSaveView, { ok: true }>) => void;
  onReload: () => void;
}>) {
  const selectedFields = page.fields.filter((field) => field.selected);
  const humanRules = new Map(page.content.fieldRules.map((rule) => [rule.fieldName, rule]));
  const [drafts, setDrafts] = useState<Readonly<Record<string, FieldDraft>>>(
    Object.fromEntries(selectedFields.map((field) => [field.fieldName, draftOf(humanRules.get(field.fieldName) ?? null)])),
  );
  const [relations, setRelations] = useState<readonly FieldRelation[]>(page.content.relations);
  const [unique, setUnique] = useState<readonly string[]>(page.content.uniqueKeyFieldNames);
  const [newKind, setNewKind] = useState<FieldRelationKind>(page.choices.relationKinds[0] ?? 'END_AFTER_START');
  const [newRoles, setNewRoles] = useState<Readonly<Record<string, string>>>({});
  const [dialog, setDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<Extract<DataRuleSaveView, { ok: false }> | null>(null);
  const fieldNames = selectedFields.map((field) => field.fieldName);
  const defaultRangeFieldNames = selectedFields.filter((field) => field.defaultRange).map((field) => field.fieldName);
  const rolesOf = (kind: FieldRelationKind): readonly string[] => page.choices.relationRoles[kind];

  const setDraft = (fieldName: string, change: Partial<FieldDraft>): void => {
    const current = drafts[fieldName] ?? draftOf(null);
    setDrafts({ ...drafts, [fieldName]: { ...current, ...change } });
  };
  const content = (): RuleSetContent => ({
    fieldRules: selectedFields.flatMap((field) => {
      const rule = savedRuleOf(field.fieldName, drafts[field.fieldName] ?? draftOf(null), humanRules.get(field.fieldName) ?? null);
      return rule === null ? [] : [rule];
    }),
    relations: [...relations],
    uniqueKeyFieldNames: fieldNames.filter((name) => unique.includes(name)),
    ...(page.content.uniqueKeyOrigin === undefined || !sameNames(unique, page.content.uniqueKeyFieldNames)
      ? {}
      : { uniqueKeyOrigin: page.content.uniqueKeyOrigin }),
    ...(page.content.templateDefaultsSaved === undefined ? {} : { templateDefaultsSaved: page.content.templateDefaultsSaved }),
  });
  const save = (): void => {
    setSaving(true);
    void onSave(content())
      .then((result) => {
        setDialog(false);
        if (result.ok) {
          setRejection(null);
          onSaved(result);
        } else {
          setRejection(result);
        }
      })
      .finally(() => setSaving(false));
  };
  const addRelation = (): void => {
    const roles = rolesOf(newKind);
    const relation = Object.fromEntries([['kind', newKind], ...roles.map((role) => [role, newRoles[role] ?? fieldNames[0] ?? ''])]) as unknown as FieldRelation;
    setRelations([...relations, relation]);
  };

  return (
    <form
      className="form-grid"
      data-testid="data-rule-form"
      onSubmit={(event) => {
        event.preventDefault();
        setDialog(true);
      }}
    >
      {rejection === null ? null : (
        <Notice kind="critical" heading={text.saveRejectedHeading}>
          <div data-testid="data-rule-rejection" data-stage={rejection.stage} data-reason={rejection.reason}>
            {rejection.stage === 'RULE_SET' ? (
              <>
                <p>{DATA_RULE_REQUEST_REJECTION_DESCRIPTIONS[rejection.reason].description}</p>
                <p>{DATA_RULE_REQUEST_REJECTION_DESCRIPTIONS[rejection.reason].action}</p>
              </>
            ) : (
              <>
                <p>{text.attachRejected}</p>
                <p>{SCENARIO_REQUEST_REJECTION_DESCRIPTIONS[rejection.reason].description}</p>
              </>
            )}
          </div>
          <div className="button-row">
            <button type="button" className="button" onClick={onReload}>{text.reload}</button>
          </div>
        </Notice>
      )}

      <fieldset className="field-group" data-testid="data-rule-fields">
        <legend className="field-group-heading">{text.fieldsHeading}</legend>
        <p className="field-hint">{text.fieldsNote}</p>
        {defaultRangeFieldNames.length === 0 ? null : (
          <Notice kind="caution" heading={inferenceText.defaultRangeHeading}>
            <div data-testid="data-rule-default-ranges">
              <p>
                {inferenceText.defaultRangeNote(formatInteger(DEFAULT_UNRANGED_DATE_WINDOW_DAYS.toDays),
                  formatInteger(DEFAULT_UNRANGED_INTEGER_RANGE.min), formatInteger(DEFAULT_UNRANGED_INTEGER_RANGE.max))}
              </p>
              <ul>
                {defaultRangeFieldNames.map((name) => <li key={name} data-default-range-field={name}><code>{name}</code></li>)}
              </ul>
            </div>
          </Notice>
        )}
        {page.fields.length === 0 ? <p>{text.noFields}</p> : page.fields.map((field) => {
          const draft = drafts[field.fieldName] ?? draftOf(null);
          const source = field.source === null ? null : ruleSourceDisplay(field.source);
          const origin = field.humanRule === null ? null : ruleOriginDisplay(field.humanRule.origin ?? UNMARKED_ORIGIN);
          const window = field.humanRule?.baseDateWindow ?? null;
          return (
            <div key={field.fieldName} className="field" data-testid="data-rule-field" data-field-name={field.fieldName} data-selected={String(field.selected)}
              data-source={field.source ?? ''}>
              <p>
                <code>{field.fieldName}</code>
                {' '}
                <span className="field-hint">
                  {listText([
                    field.type ?? LOCAL_UI_DISCOVERY_TEXT.noFlags,
                    candidateFieldConstraintsText(field),
                  ])}
                </span>
              </p>
              <FieldStatus field={field} />
              <p className="field-hint">
                {`${text.columns.source}: `}
                {source === null ? text.noSource : <span className={toneClass(source.tone)} data-testid="data-rule-source">{source.label}</span>}
                {field.rule === null ? null : (
                  <span data-testid="data-rule-applied" data-kind={field.rule.semanticKind}>
                    {` / ${text.columns.rule}: ${listText([semanticKindDisplay(field.rule.semanticKind).label, generationMethodDisplay(field.rule.method).label])}`}
                  </span>
                )}
              </p>
              {origin === null || field.humanRule === null ? null : (
                <p className="field-hint" data-testid="data-rule-origin" data-origin={field.humanRule.origin ?? UNMARKED_ORIGIN}
                  data-default-range={String(field.defaultRange)}>
                  {`${inferenceText.originLabel}: `}
                  <span className={toneClass(origin.tone)}>{origin.label}</span>
                  {field.defaultRange ? ` / ${inferenceText.defaultRangeBadge}` : null}
                  {window === null
                    ? null
                    : ` / ${inferenceText.baseDateWindowLabel}: ${inferenceText.baseDateWindowText(formatInteger(window.fromDays), formatInteger(window.toDays))}`}
                </p>
              )}
              <p className="field-hint" data-testid="data-rule-external">
                {`${text.columns.external}: `}
                {field.externalDeliveryKinds.length === 0 ? text.noExternal : listText(field.externalDeliveryKinds.map((kind) => externalDeliveryKindDisplay(kind).label))}
              </p>
              {!field.selected ? <p className="field-hint">{text.notSelected}</p> : (
                <div className="form-grid">
                  <FieldFrame label={text.kindLabel} errors={[]}>
                    {({ id, describedBy }) => (
                      <select id={id} className="input" name={`kind-${field.fieldName}`} data-kind-for={field.fieldName} value={draft.kind}
                        aria-describedby={describedBy} disabled={!page.editable}
                        onChange={(event) => setDraft(field.fieldName, { kind: event.target.value as FieldDraft['kind'] })}>
                        <option value={AUTO_KIND}>{text.autoKind}</option>
                        {field.allowedKinds.map((kind) => <option key={kind} value={kind}>{semanticKindDisplay(kind).label}</option>)}
                      </select>
                    )}
                  </FieldFrame>
                  {draft.kind === AUTO_KIND ? null : (
                    <>
                      <FieldFrame label={text.methodLabel} errors={[]}>
                        {({ id, describedBy }) => (
                          <select id={id} className="input" name={`method-${field.fieldName}`} data-method-for={field.fieldName} value={draft.method}
                            aria-describedby={describedBy} disabled={!page.editable}
                            onChange={(event) => setDraft(field.fieldName, { method: event.target.value as GenerationMethod })}>
                            {page.choices.generationMethods.map((method) => (
                              <option key={method} value={method}>{generationMethodDisplay(method).label}</option>
                            ))}
                          </select>
                        )}
                      </FieldFrame>
                      {draft.method !== FIXED_METHOD ? null : (
                        <FieldFrame label={text.fixedValuesLabel}
                          hint={text.fixedValuesHint(formatCount(page.choices.maxFixedValues), formatInteger(page.choices.maxFixedValueLength))} errors={[]}>
                          {({ id, describedBy }) => (
                            <textarea id={id} className="input" name={`fixed-${field.fieldName}`} data-fixed-for={field.fieldName} value={draft.fixed}
                              aria-describedby={describedBy} disabled={!page.editable}
                              onChange={(event) => setDraft(field.fieldName, { fixed: event.target.value })} />
                          )}
                        </FieldFrame>
                      )}
                      <fieldset className="field-group">
                        <legend className="field-group-heading">{text.rangeLabel}</legend>
                        {([['min', text.rangeMin], ['max', text.rangeMax], ['step', text.rangeStep]] as const).map(([key, label]) => (
                          <FieldFrame key={key} label={label} errors={[]}>
                            {({ id, describedBy }) => (
                              <input id={id} className="input" name={`${key}-${field.fieldName}`} data-range-for={`${field.fieldName}:${key}`} value={draft[key]}
                                aria-describedby={describedBy} disabled={!page.editable}
                                onChange={(event) => setDraft(field.fieldName, { [key]: event.target.value })} />
                            )}
                          </FieldFrame>
                        ))}
                      </fieldset>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </fieldset>

      <fieldset className="field-group" data-testid="data-rule-relations">
        <legend className="field-group-heading">{text.relationsHeading}</legend>
        <p className="field-hint">{text.relationsNote}</p>
        {relations.length === 0 ? <p>{text.noRelations}</p> : (
          <ul>
            {relations.map((relation, index) => (
              <li key={`${relation.kind}:${String(index)}`} data-testid="data-rule-relation" data-kind={relation.kind}
                data-origin={relation.origin ?? UNMARKED_ORIGIN}>
                {relationTextOf(relation, rolesOf(relation.kind))}
                {` / ${inferenceText.originLabel}: ${ruleOriginDisplay(relation.origin ?? UNMARKED_ORIGIN).label}`}
                {' '}
                {page.editable ? (
                  <button type="button" className="button" onClick={() => setRelations(relations.filter((_relation, other) => other !== index))}>
                    {text.removeRelation}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {!page.editable || fieldNames.length === 0 ? null : (
          <div className="form-grid">
            <FieldFrame label={text.relationKindLabel} errors={[]}>
              {({ id, describedBy }) => (
                <select id={id} className="input" name="relation-kind" value={newKind} aria-describedby={describedBy}
                  onChange={(event) => setNewKind(event.target.value as FieldRelationKind)}>
                  {page.choices.relationKinds.map((kind) => <option key={kind} value={kind}>{fieldRelationKindDisplay(kind).label}</option>)}
                </select>
              )}
            </FieldFrame>
            {rolesOf(newKind).map((role) => (
              <FieldFrame key={role} label={text.relationRoles[role as keyof typeof text.relationRoles]} errors={[]}>
                {({ id, describedBy }) => (
                  <select id={id} className="input" name={`relation-${role}`} data-role={role} value={newRoles[role] ?? fieldNames[0] ?? ''}
                    aria-describedby={describedBy} onChange={(event) => setNewRoles({ ...newRoles, [role]: event.target.value })}>
                    {fieldNames.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                )}
              </FieldFrame>
            ))}
            <div className="button-row">
              <button type="button" className="button" data-testid="data-rule-add-relation" onClick={addRelation}>{text.addRelation}</button>
            </div>
          </div>
        )}
        <p data-testid="data-rule-effective-relations">
          {`${text.effectiveRelationsLabel}: `}
          {page.relations.length === 0 ? text.noEffectiveRelations : listText(page.relations.map((relation) => relationTextOf(relation, rolesOf(relation.kind))))}
        </p>
      </fieldset>

      <fieldset className="field-group" data-testid="data-rule-unique">
        <legend className="field-group-heading">{text.uniqueHeading}</legend>
        <p className="field-hint">{text.uniqueNote}</p>
        {page.content.uniqueKeyFieldNames.length === 0 ? null : (
          <p className="field-hint" data-testid="data-rule-unique-origin" data-origin={page.content.uniqueKeyOrigin ?? UNMARKED_ORIGIN}>
            {`${inferenceText.originLabel}: ${ruleOriginDisplay(page.content.uniqueKeyOrigin ?? UNMARKED_ORIGIN).label}`}
          </p>
        )}
        {fieldNames.map((name) => (
          <div key={name} className="field">
            <label className="choice">
              <input type="checkbox" name={`unique-${name}`} data-unique={name} checked={unique.includes(name)} disabled={!page.editable}
                onChange={(event) => setUnique(event.target.checked ? [...unique.filter((other) => other !== name), name] : unique.filter((other) => other !== name))} />
              <span><code>{name}</code></span>
            </label>
          </div>
        ))}
        <p data-testid="data-rule-effective-unique">
          {`${text.effectiveUniqueLabel}: `}
          {page.uniqueKeyFieldNames.length === 0 ? text.noUnique : listText(page.uniqueKeyFieldNames)}
        </p>
      </fieldset>

      {page.editable ? (
        <div className="button-row">
          <button type="submit" className="button button--primary" disabled={saving} data-testid="data-rule-save">{saving ? text.saving : text.save}</button>
        </div>
      ) : null}
      <ConfirmDialog
        open={dialog}
        title={text.saveDialog.title}
        body={text.saveDialog.body}
        confirmLabel={text.saveDialog.confirm}
        cancelLabel={text.saveDialog.cancel}
        busy={saving}
        onCancel={() => setDialog(false)}
        onConfirm={save}
      />
    </form>
  );
}

/**
 * 入力の規則（補完）のフォーム（Task 29 の設計書 3 章の「補完の画面」、4.4。T29e）。
 * - 送る欄ごとに、判定の結果（状態と細分、出どころ、外部到達）を出し、人の規則（意味の種類、作り方、値の一覧、範囲）を編集する。「自動」は人の規則を
 *   持たない（業務テンプレートか汎用の規則で決まる）。選べる意味の種類は、欄の型に合うものだけ（サーバが返した一覧）。
 * - 欄どうしの関係（人が決めたもの）と、一意にする欄の組を編集する。当てる関係と組（テンプレートの既定を含む）も出す。
 * - 保存は、確認のダイアログ（保存すると再承認になることを示す）の後にだけ送る。判定と保存の確かめは、サーバの owner が決める（画面の確かめはない）。
 */
import { useState } from 'react';
import type {
  FieldRelation,
  FieldRelationKind,
  FieldRule,
  GenerationMethod,
  RuleSetContent,
  SemanticKind,
} from '../../../../src/control/data-rules-view.js';
import { formatCount, formatInteger } from '../../../../src/presentation/format.js';
import {
  DATA_RULE_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_DATA_RULE_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  RULE_PROBLEM_DETAIL_DESCRIPTIONS,
  SCENARIO_REQUEST_REJECTION_DESCRIPTIONS,
  listText,
} from '../../../../src/presentation/messages.js';
import { candidateFieldConstraintsText } from '../display/candidate-fields';
import {
  externalDeliveryKindDisplay,
  fieldRelationKindDisplay,
  fieldRuleStatusDisplay,
  generationMethodDisplay,
  ruleSourceDisplay,
  semanticKindDisplay,
  toneClass,
} from '../display/labels';
import type { DataRuleFieldView, DataRulePageView, DataRuleSaveView } from '../server/data-rule-functions';
import { ConfirmDialog } from './ConfirmDialog';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

const text = LOCAL_UI_DATA_RULE_TEXT;

/** 人の規則のない欄の、意味の種類の選択の値。 */
const AUTO_KIND = '';
/** 人が入れた値の一覧の作り方。 */
const FIXED_METHOD: GenerationMethod = 'FROM_FIXED_LIST';
/** 人の規則の既定の作り方（意味の種類を選んだとき）。 */
const DEFAULT_METHOD: GenerationMethod = 'FROM_TEMPLATE';
/** 値の一覧の区切り（1 行に 1 つ）。 */
const LINE_BREAK = '\n';

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
  fixed: rule?.fixedValues.join(LINE_BREAK) ?? '',
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
    fixedValues: draft.method === FIXED_METHOD ? draft.fixed.split(LINE_BREAK).map((line) => line.trim()).filter((line) => line.length > 0) : [],
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
  onSaved: () => void;
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
  const rolesOf = (kind: FieldRelationKind): readonly string[] => page.choices.relationRoles[kind];

  const setDraft = (fieldName: string, change: Partial<FieldDraft>): void => {
    const current = drafts[fieldName] ?? draftOf(null);
    setDrafts({ ...drafts, [fieldName]: { ...current, ...change } });
  };
  const content = (): RuleSetContent => ({
    fieldRules: selectedFields.flatMap((field) => {
      const rule = ruleOf(field.fieldName, drafts[field.fieldName] ?? draftOf(null));
      return rule === null ? [] : [rule];
    }),
    relations: [...relations],
    uniqueKeyFieldNames: fieldNames.filter((name) => unique.includes(name)),
  });
  const save = (): void => {
    setSaving(true);
    void onSave(content())
      .then((result) => {
        setDialog(false);
        if (result.ok) {
          setRejection(null);
          onSaved();
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
        {page.fields.length === 0 ? <p>{text.noFields}</p> : page.fields.map((field) => {
          const draft = drafts[field.fieldName] ?? draftOf(null);
          const source = field.source === null ? null : ruleSourceDisplay(field.source);
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
              <li key={`${relation.kind}:${String(index)}`} data-testid="data-rule-relation" data-kind={relation.kind}>
                {relationTextOf(relation, rolesOf(relation.kind))}
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

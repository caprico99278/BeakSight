/**
 * シナリオの内容のフォーム（Task 28 の設計書 4.6。T28e）。作成と変更の画面が共用する。
 * - 送る欄: 候補の、名前のある欄を並べる。選べない欄（秘密に見える名前、危険な語、送れない欄。理由はサーバが下書きの確かめの owner で求めて
 *   返したもの）は、選べなくして理由を出す。値の入力の欄はない（送る値の作り方は Task 29）。
 * - 照らす READ の定義（任意）、上限（既定以下）、期限（既定以下）、副作用の確認（4 項目）。上限・期限・項目の一覧は、サーバが返した契約の値。
 * - T30g: 検証の指定（成功の条件・入力の誤りの条件・登録の ID の取り方・照合の READ）の入力（`ScenarioVerificationFields`）。
 * - 保存は、サーバの確かめ（`validateScenarioDraft`）と保存の部品が決める。拒まれたら、理由を項目ごとに日本語で出す（送る欄の誤りはその欄に、
 *   照らす READ の定義の誤りはその定義に、ほかは上のお知らせに）。画面の確かめ（数の範囲）は補助だけ。
 * - T31h-1: UPDATE の候補では、送る欄の選択の代わりに、UPDATE の指定の入力（`ScenarioUpdateFields`。台帳、path の型、欄の役割）を出す。変える欄が
 *   送る欄（`fieldNames`）、保つ欄が UPDATE の指定の `keepFieldNames` になる。UPDATE の指定の誤りは、その入力の近くに出す。
 */
import { useState } from 'react';
import type {
  ReadCheckReference,
  ScenarioDraftRejectionReason,
  ScenarioVerification,
  SideEffectConfirmation,
  SideEffectConfirmations,
} from '../../../../src/control/approval-view.js';
import { SIDE_EFFECT_CONFIRMATION_CATALOG, sortByDisplayOrder } from '../../../../src/presentation/catalog.js';
import { formatCount, formatInteger } from '../../../../src/presentation/format.js';
import {
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
  SCENARIO_DRAFT_REJECTION_DESCRIPTIONS,
  SCENARIO_REQUEST_REJECTION_DESCRIPTIONS,
  listText,
} from '../../../../src/presentation/messages.js';
import { candidateFieldConstraintsText, candidateFieldFlagsText } from '../display/candidate-fields';
import { sideEffectConfirmationDisplay } from '../display/labels';
import type {
  ScenarioCandidateView,
  ScenarioChangeView,
  ScenarioFormRulesView,
  ScenarioReadCheckOptionView,
  ScenarioRejectionView,
  ScenarioUpdateFormView,
  ScenarioUpdateView,
} from '../server/scenario-functions';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';
import { ScenarioUpdateFields, UPDATE_PLACED_REASONS, updateDraftOf, updateStateOf } from './ScenarioUpdateFields';
import { ScenarioVerificationFields, verificationInputOf, verificationStateOf } from './ScenarioVerificationFields';

const text = LOCAL_UI_SCENARIO_TEXT;

/** フォームの初めの値（変更の画面は、今の版の内容）。 */
export interface ScenarioFormInitial {
  readonly fieldNames: readonly string[];
  readonly readChecks: readonly ReadCheckReference[];
  readonly sideEffectConfirmations: SideEffectConfirmations;
  readonly maxCreatesPerRun: number;
  readonly maxCumulativeCreates: number;
  readonly approvalTtlDays: number;
  /** 検証の指定（T30g。作成の画面は、すべて未指定）。 */
  readonly verification: ScenarioVerification;
  /** T31h-1: UPDATE の指定（作成の画面と CREATE は null）。 */
  readonly update: ScenarioUpdateView | null;
}

/** 検証の指定の誤りの理由（T30g。検証の指定の欄の近くに出す）。 */
const VERIFICATION_REJECTION_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS',
  'SCENARIO_VERIFICATION_PARAMETER_UNKNOWN',
  'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
]);

/** 送る内容（プロファイルと候補は、呼び出し側が足すか、サーバがシナリオから取る）。数の欄は、整数の文字でなければ文字のまま送る。 */
export interface ScenarioDraftContentInput {
  readonly fieldNames: readonly string[];
  readonly readChecks: readonly ReadCheckReference[];
  readonly sideEffectConfirmations: Readonly<Record<SideEffectConfirmation, boolean>>;
  readonly limits: { readonly maxCreatesPerRun: number | string; readonly maxCumulativeCreates: number | string };
  readonly approvalTtlDays: number | string;
  /** 検証の指定（T30g。形の確かめはサーバ）。 */
  readonly verification: Readonly<Record<string, unknown>>;
  /** T31h-1: UPDATE の指定（UPDATE の候補だけ。形の確かめはサーバ）。 */
  readonly update?: Readonly<Record<string, unknown>>;
}

/** 数の欄の値（0 以上の整数の文字だけを数にする。ほかは文字のまま送り、サーバの形の確かめが拒む）。 */
const NON_NEGATIVE_INTEGER = /^[0-9]+$/u;
const numberValueOf = (value: string): number | string => (NON_NEGATIVE_INTEGER.test(value) ? Number(value) : value);

export function ScenarioForm({ candidate, readChecks, rules, update, initial, onSave, onSaved, onReload }: Readonly<{
  candidate: ScenarioCandidateView;
  readChecks: readonly ScenarioReadCheckOptionView[];
  rules: ScenarioFormRulesView;
  /** T31h-1: UPDATE の候補のフォームの値（UPDATE の候補でなければ null）。 */
  update: ScenarioUpdateFormView | null;
  initial: ScenarioFormInitial;
  onSave: (content: ScenarioDraftContentInput) => Promise<ScenarioChangeView>;
  onSaved: (scenarioId: string) => void;
  onReload: () => void;
}>) {
  const items = sortByDisplayOrder(rules.sideEffects, SIDE_EFFECT_CONFIRMATION_CATALOG);
  const [fieldNames, setFieldNames] = useState<readonly string[]>(initial.fieldNames);
  const [selectedChecks, setSelectedChecks] = useState<readonly string[]>(initial.readChecks.map(({ readCheckId }) => readCheckId));
  const [confirmations, setConfirmations] = useState<Readonly<Record<SideEffectConfirmation, boolean>>>(initial.sideEffectConfirmations);
  const [perRun, setPerRun] = useState(String(initial.maxCreatesPerRun));
  const [cumulative, setCumulative] = useState(String(initial.maxCumulativeCreates));
  const [ttlDays, setTtlDays] = useState(String(initial.approvalTtlDays));
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<ScenarioRejectionView | null>(null);
  const [verification, setVerification] = useState(() => verificationStateOf(initial.verification));
  // T31h-1: UPDATE の指定の入力（UPDATE の候補だけ）。
  const updateView = candidate.scenarioKind === 'UPDATE' ? update : null;
  const [updateState, setUpdateState] = useState(() =>
    (updateView === null ? null : updateStateOf(candidate, updateView, initial.fieldNames, initial.update)));
  const updateDraft = updateView === null || updateState === null ? null : updateDraftOf(candidate, updateView, updateState);
  const verificationErrors = rejection === null
    ? []
    : [...new Set(rejection.errors
      .filter((error) => VERIFICATION_REJECTION_REASONS.has(error.code) || (error.readCheckId !== null && error.readCheckId === verification.readCheckId))
      .map((error) => SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[error.code].description))];

  const itemErrors = (match: (error: ScenarioRejectionView['errors'][number]) => boolean): readonly string[] =>
    (rejection === null ? [] : rejection.errors.filter(match).map((error) => SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[error.code].description));
  const generalCodes = rejection === null
    ? []
    : [...new Set(rejection.errors
      .filter((error) => error.fieldName === null && error.readCheckId === null && !(updateDraft !== null && UPDATE_PLACED_REASONS.has(error.code)))
      .map((error) => error.code))];
  const toggle = (values: readonly string[], value: string, on: boolean): readonly string[] =>
    (on ? [...values.filter((current) => current !== value), value] : values.filter((current) => current !== value));

  return (
    <form
      className="form-grid"
      data-testid="scenario-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void onSave({
          fieldNames: updateDraft === null ? candidate.fields.map((field) => field.name).filter((name) => fieldNames.includes(name)) : updateDraft.fieldNames,
          readChecks: readChecks.filter(({ readCheckId }) => selectedChecks.includes(readCheckId)).map(({ readCheckId, revision }) => ({ readCheckId, revision })),
          sideEffectConfirmations: Object.fromEntries(items.map((item) => [item, confirmations[item]])) as Record<SideEffectConfirmation, boolean>,
          limits: { maxCreatesPerRun: numberValueOf(perRun), maxCumulativeCreates: numberValueOf(cumulative) },
          approvalTtlDays: numberValueOf(ttlDays),
          verification: verificationInputOf(verification, readChecks),
          ...(updateDraft === null ? {} : { update: updateDraft.update }),
        })
          .then((result) => {
            if (result.ok) {
              setRejection(null);
              onSaved(result.scenarioId);
            } else {
              setRejection(result);
            }
          })
          .finally(() => setSaving(false));
      }}
    >
      {rejection === null ? null : (
        <Notice kind="critical" heading={text.saveRejectedHeading}>
          <div data-testid="scenario-rejection" data-reason={rejection.reason}>
            <p>{SCENARIO_REQUEST_REJECTION_DESCRIPTIONS[rejection.reason].description}</p>
            <p>{SCENARIO_REQUEST_REJECTION_DESCRIPTIONS[rejection.reason].action}</p>
            {generalCodes.map((code) => (
              <div key={code} data-code={code}>
                <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[code].description}</p>
                <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[code].action}</p>
              </div>
            ))}
          </div>
          <div className="button-row">
            <button type="button" className="button" onClick={onReload}>{LOCAL_UI_TEXT.reload}</button>
          </div>
        </Notice>
      )}

      {updateView === null || updateState === null ? null : (
        <ScenarioUpdateFields
          candidate={candidate}
          view={updateView}
          state={updateState}
          onChange={setUpdateState}
          errors={rejection === null ? [] : rejection.errors}
          describeField={(field) => listText([field.type, candidateFieldFlagsText(field), candidateFieldConstraintsText(field)])}
        />
      )}

      {updateView !== null ? null : <fieldset className="field-group" data-testid="scenario-fields">
        <legend className="field-group-heading">{text.fieldsHeading}</legend>
        <p className="field-hint">{text.fieldsNote}</p>
        {candidate.fields.length === 0 ? <p>{text.noFields}</p> : candidate.fields.map((field) => {
          const errors = itemErrors((error) => error.fieldName === field.name);
          const blocked = field.rejection !== null;
          return (
            <div key={field.name} className="field" data-testid="scenario-field" data-field-name={field.name} data-rejection={field.rejection ?? ''}>
              <label className="choice">
                <input
                  type="checkbox"
                  name={`field-${field.name}`}
                  checked={fieldNames.includes(field.name)}
                  disabled={blocked}
                  aria-invalid={errors.length > 0}
                  data-field={field.name}
                  onChange={(event) => setFieldNames(toggle(fieldNames, field.name, event.target.checked))}
                />
                <span><code>{field.name}</code></span>
              </label>
              <span className="field-hint">
                {listText([field.type, candidateFieldFlagsText(field), candidateFieldConstraintsText(field)])}
              </span>
              {field.rejection === null ? null : (
                <span className="field-hint" data-testid="scenario-field-blocked">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[field.rejection].description}</span>
              )}
              {errors.length === 0 ? null : <span className="field-error">{errors.join(' ')}</span>}
            </div>
          );
        })}
      </fieldset>}

      <fieldset className="field-group" data-testid="scenario-read-checks">
        <legend className="field-group-heading">{text.readChecksHeading}</legend>
        <p className="field-hint">{text.readChecksNote}</p>
        {readChecks.length === 0 ? <p>{text.noReadChecks}</p> : readChecks.map(({ readCheckId, revision }) => {
          const errors = itemErrors((error) => error.readCheckId === readCheckId);
          return (
            <div key={readCheckId} className="field" data-testid="scenario-read-check" data-read-check-id={readCheckId}>
              <label className="choice">
                <input
                  type="checkbox"
                  name={`read-check-${readCheckId}`}
                  checked={selectedChecks.includes(readCheckId)}
                  aria-invalid={errors.length > 0}
                  onChange={(event) => setSelectedChecks(toggle(selectedChecks, readCheckId, event.target.checked))}
                />
                <span>{text.readCheckOption(readCheckId, formatInteger(revision))}</span>
              </label>
              {errors.length === 0 ? null : <span className="field-error">{errors.join(' ')}</span>}
            </div>
          );
        })}
      </fieldset>

      <ScenarioVerificationFields
        state={verification}
        onChange={setVerification}
        readChecks={readChecks}
        fieldNames={candidate.fields.filter((field) => field.rejection === null && (updateView === null || field.roleRequired)).map((field) => field.name)}
        errors={verificationErrors}
      />

      <fieldset className="field-group" data-testid="scenario-limits">
        <legend className="field-group-heading">{text.limitsHeading}</legend>
        <FieldFrame label={text.perRunLimit} hint={text.limitHint(formatCount(rules.minLimit), formatCount(rules.maxCreatesPerRun))} errors={[]}>
          {({ id, describedBy }) => (
            <input id={id} name="maxCreatesPerRun" className="input" type="number" required min={rules.minLimit} max={rules.maxCreatesPerRun} step={1}
              value={perRun} aria-describedby={describedBy} onChange={(event) => setPerRun(event.target.value)} />
          )}
        </FieldFrame>
        <FieldFrame label={text.cumulativeLimit} hint={text.limitHint(formatCount(rules.minLimit), formatCount(rules.maxCumulativeCreates))} errors={[]}>
          {({ id, describedBy }) => (
            <input id={id} name="maxCumulativeCreates" className="input" type="number" required min={rules.minLimit} max={rules.maxCumulativeCreates}
              step={1} value={cumulative} aria-describedby={describedBy} onChange={(event) => setCumulative(event.target.value)} />
          )}
        </FieldFrame>
      </fieldset>

      <fieldset className="field-group" data-testid="scenario-ttl">
        <legend className="field-group-heading">{text.ttlHeading}</legend>
        <FieldFrame label={text.ttl} hint={text.ttlHint(formatInteger(rules.minTtlDays), formatInteger(rules.maxTtlDays))} errors={[]}>
          {({ id, describedBy }) => (
            <input id={id} name="approvalTtlDays" className="input" type="number" required min={rules.minTtlDays} max={rules.maxTtlDays} step={1}
              value={ttlDays} aria-describedby={describedBy} onChange={(event) => setTtlDays(event.target.value)} />
          )}
        </FieldFrame>
      </fieldset>

      <fieldset className="field-group" data-testid="scenario-side-effects">
        <legend className="field-group-heading">{text.sideEffectsHeading}</legend>
        <p className="field-hint">{text.sideEffectsNote}</p>
        {items.map((item) => {
          const display = sideEffectConfirmationDisplay(item);
          return (
            <div key={item} className="field">
              <label className="choice">
                <input
                  type="checkbox"
                  name={`side-effect-${item}`}
                  checked={confirmations[item]}
                  data-side-effect={item}
                  onChange={(event) => setConfirmations({ ...confirmations, [item]: event.target.checked })}
                />
                <span>{display.label}</span>
              </label>
              {display.description === null ? null : <span className="field-hint">{display.description}</span>}
            </div>
          );
        })}
      </fieldset>

      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={saving} data-testid="scenario-save">
          {saving ? text.saving : text.save}
        </button>
      </div>
    </form>
  );
}

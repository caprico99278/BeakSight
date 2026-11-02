/**
 * シナリオの内容のフォーム（Task 28 の設計書 4.6。T28e）。作成と変更の画面が共用する。
 * - 送る欄: 候補の、名前のある欄を並べる。選べない欄（秘密に見える名前、危険な語、送れない欄。理由はサーバが下書きの確かめの owner で求めて
 *   返したもの）は、選べなくして理由を出す。値の入力の欄はない（送る値の作り方は Task 29）。
 * - 照らす READ の定義（任意）、上限（既定以下）、期限（既定以下）。上限・期限・項目の一覧は、サーバが返した契約の値。
 * - T30g: 検証の指定（成功の条件・入力の誤りの条件・登録の ID の取り方・照合の READ）の入力（`ScenarioVerificationFields`）。
 * - 保存は、サーバの確かめ（`validateScenarioDraft`）と保存の部品が決める。拒まれたら、理由を項目ごとに日本語で出す（送る欄の誤りはその欄に、
 *   照らす READ の定義の誤りはその定義に、ほかは上のお知らせに）。画面の確かめ（数の範囲）は補助だけ。
 * - T31h-1: UPDATE の候補では、送る欄の選択の代わりに、UPDATE の指定の入力（`ScenarioUpdateFields`。台帳、path の型、欄の役割）を出す。変える欄が
 *   送る欄（`fieldNames`）、保つ欄が UPDATE の指定の `keepFieldNames` になる。UPDATE の指定の誤りは、その入力の近くに出す。
 * - T38f: 型の digest で選んだ API の候補では、送る欄の選択と UPDATE の指定の代わりに、API の指定の入力（`ScenarioApiFields`）を出す。送る鍵が
 *   送る欄（`fieldNames`）になり、送り方 `API` と API の指定を下書きに足す。照合の READ には、`{id}` つきの画面の path の READ の定義も選べる。
 * - MI-6（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6、ユーザーの判断 2）: 副作用の確認の 4 項目のチェックは置かない（承認のダイアログの
 *   1 回で確かめる）。保存する値は、今の版の値（作成の画面は、すべて確かめていない今の既定）を引き継ぐ。1 つの値しか通らない欄（1 回の Run の上限、
 *   既定の値が分からない送る欄）は、入力でなく表示だけにする（保存する値は今と同じ）。累積の上限と承認の期限は、たたんだ「詳しい設定」に置く（その
 *   誤りで拒まれたら開く）。
 * - MI-7（同 4.6）: 作成の画面の API の更新は、照合の READ を、選んだ台帳の照合の READ と人が選んだ変える鍵から埋める（`apiUpdateReadFillOf`）。変える鍵を
 *   選ぶ前と、埋められないとき（理由）は、照合の READ の欄の上に知らせる。人が照合の READ の欄を変えたら、その後は人の値のまま。
 */
import { useState, type ReactNode } from 'react';
import type {
  ReadCheckReference,
  ScenarioApiSpec,
  ScenarioDraftRejectionReason,
  ScenarioVerification,
  SideEffectConfirmation,
  SideEffectConfirmations,
} from '../../../../src/control/approval-view.js';
// PRE42-CC 組 UI-K（組 2 の引き継ぎ。CC-106）: シナリオの種類の値は、管理データに触れない純粋な owner から読む（文字列で比べない）。
import { UPDATE_SCENARIO_KIND } from '../../../../src/core/scenario-kind.js';
import { API_SCENARIO_TRANSPORT } from '../../../../src/core/scenario-transport.js';
import { formatCount, formatInteger } from '../../../../src/presentation/format.js';
import {
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
  LOCAL_UI_WRITE_STAGE_TEXT,
  SCENARIO_DRAFT_REJECTION_DESCRIPTIONS,
  SCENARIO_REQUEST_REJECTION_DESCRIPTIONS,
  listText,
} from '../../../../src/presentation/messages.js';
import { candidateFieldFlagsText } from '../display/candidate-fields';
import type {
  ScenarioApiFormView,
  ScenarioCandidateView,
  ScenarioChangeView,
  ScenarioFormRulesView,
  ScenarioReadCheckOptionView,
  ScenarioRejectionView,
  ScenarioUpdateFormView,
  ScenarioUpdateView,
} from '../server/scenario-functions';
import { AdvancedSettings } from './AdvancedSettings';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';
import { API_PLACED_REASONS, ScenarioApiAdvancedFields, ScenarioApiFields, apiDraftOf, apiStateOf } from './ScenarioApiFields';
import { ScenarioUpdateFields, UPDATE_DETAILS_REASONS, UPDATE_PLACED_REASONS, updateDraftOf, updateStateOf } from './ScenarioUpdateFields';
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
  /** T38f: API の指定（作成の画面と FORM のシナリオは null）。 */
  readonly api: ScenarioApiSpec | null;
}

/** 検証の指定の誤りの理由（T30g。検証の指定の欄の近くに出す）。 */
const VERIFICATION_REJECTION_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_VERIFICATION_PARAMETER_UNKNOWN',
  'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
  // T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の I-2）: API のシナリオの照合の READ の期待（T40R2-fix: 登録の ID の型は注意にした）。
  'SCENARIO_API_READ_VERIFICATION_NOT_BOUND',
]);

/** MI-6: たたんだ詳しい設定の欄（累積の上限と承認の期限）の誤り（拒まれたら、詳しい設定を開く）。 */
const ADVANCED_REJECTION_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_LIMIT_ABOVE_DEFAULT',
  'SCENARIO_LIMIT_INCONSISTENT',
  'SCENARIO_TTL_ABOVE_DEFAULT',
  'SCENARIO_INPUT_INVALID',
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
  /** T38f: 送り方と API の指定（API の候補だけ。形の確かめはサーバ）。 */
  readonly transport?: typeof API_SCENARIO_TRANSPORT;
  readonly api?: Readonly<Record<string, unknown>>;
}

/** 数の欄の値（0 以上の整数の文字だけを数にする。ほかは文字のまま送り、サーバの形の確かめが拒む）。 */
const NON_NEGATIVE_INTEGER = /^[0-9]+$/u;
const numberValueOf = (value: string): number | string => (NON_NEGATIVE_INTEGER.test(value) ? Number(value) : value);

export function ScenarioForm({ candidate, readChecks, rules, update, api, initial, onSave, onSaved, onReload, detailsLead, openDetails }: Readonly<{
  candidate: ScenarioCandidateView;
  readChecks: readonly ScenarioReadCheckOptionView[];
  rules: ScenarioFormRulesView;
  /** T31h-1: UPDATE の候補のフォームの値（UPDATE の候補でなければ null）。 */
  update: ScenarioUpdateFormView | null;
  /** T38f: API の候補のフォームの値（型の digest で選んだ API の候補だけ。ほかは null）。 */
  api: ScenarioApiFormView | null;
  initial: ScenarioFormInitial;
  onSave: (content: ScenarioDraftContentInput) => Promise<ScenarioChangeView>;
  /** PL-5 の 9 の (1): 保存の結果（保存のときに付けた入れる値の決まりを含む）。 */
  onSaved: (saved: Extract<ScenarioChangeView, { readonly ok: true }>) => void;
  onReload: () => void;
  /** OP-3（設計書 PL 3 章の 1）: 詳しい内容の初めに置く、候補の要点など（画面のアドレスの後ろは、詳しい内容の中だけ）。 */
  detailsLead?: ReactNode;
  /** OP-3: 詳しい内容を初めから開くか（作ったデータの一覧を人が選ぶときなど）。 */
  openDetails?: boolean;
}>) {
  // MI-6: 副作用の確認は、今の版の値（作成の画面は今の既定）を引き継ぐ（画面では変えない。承認のダイアログで確かめる）。
  const confirmations = Object.fromEntries(rules.sideEffects.map((item) => [item, initial.sideEffectConfirmations[item]])) as Record<SideEffectConfirmation, boolean>;
  // MI-6: 1 回の Run の上限が 1 つの値しか通らない（下限と既定が同じ）なら、その値を表示だけにする。
  const perRunFixed = rules.minLimit === rules.maxCreatesPerRun;
  const [fieldNames, setFieldNames] = useState<readonly string[]>(initial.fieldNames);
  const [perRun, setPerRun] = useState(String(perRunFixed ? rules.maxCreatesPerRun : initial.maxCreatesPerRun));
  const [cumulative, setCumulative] = useState(String(initial.maxCumulativeCreates));
  const [ttlDays, setTtlDays] = useState(String(initial.approvalTtlDays));
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<ScenarioRejectionView | null>(null);
  const [verification, setVerification] = useState(() => verificationStateOf(initial.verification));
  // T38f: API の指定の入力（API の候補だけ。FORM の送る欄と UPDATE の指定の入力の代わり）。
  const [apiState, setApiState] = useState(() => (api === null ? null : apiStateOf(api, initial.api)));
  const apiDraft = api === null || apiState === null ? null : apiDraftOf(api, apiState);
  // T31h-1: UPDATE の指定の入力（UPDATE の候補だけ）。
  const updateView = candidate.scenarioKind === UPDATE_SCENARIO_KIND && api === null ? update : null;
  const [updateState, setUpdateState] = useState(() =>
    (updateView === null ? null : updateStateOf(candidate, updateView, initial.fieldNames, initial.update)));
  const updateDraft = updateView === null || updateState === null ? null : updateDraftOf(candidate, updateView, updateState);
  // PL-5 の 9 の (2)（設計者の判断）: 書き換えの答え合わせは、保存の口が台帳の登録の書き込みの手順から写す（写し方の 1 か所 `update-verification-copy.ts`）。
  // 画面は写さず、作成の画面の書き換え（人が答え合わせを入れていない）では、写すことを 1 行で出すだけ（中身は出さない）。
  const shownVerification = verification;
  const copiesLedgerVerification = initial.verification.readVerification === null
    && ((api !== null && api.kind === UPDATE_SCENARIO_KIND && initial.api === null) || (updateView !== null && initial.update === null));
  const verificationErrors = rejection === null
    ? []
    : [...new Set(rejection.errors
      .filter((error) => VERIFICATION_REJECTION_REASONS.has(error.code) || (error.readCheckId !== null && error.readCheckId === shownVerification.readCheckId))
      .map((error) => SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[error.code].description))];

  const itemErrors = (match: (error: ScenarioRejectionView['errors'][number]) => boolean): readonly string[] =>
    (rejection === null ? [] : rejection.errors.filter(match).map((error) => SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[error.code].description));
  const generalCodes = rejection === null
    ? []
    : [...new Set(rejection.errors
      .filter((error) => error.fieldName === null && error.readCheckId === null && !(updateDraft !== null && UPDATE_PLACED_REASONS.has(error.code))
        && !(apiDraft !== null && API_PLACED_REASONS.has(error.code)))
      .map((error) => error.code))];
  const advancedRejected = rejection !== null && rejection.errors.some((error) => error.fieldName === null && ADVANCED_REJECTION_REASONS.has(error.code));
  // OP-3: 詳しい内容に置いた更新の指定（作ったデータの一覧・アドレスの形）の誤りでも、詳しい内容を開く。
  const detailsRejected = rejection !== null && rejection.errors.some((error) => error.fieldName === null && UPDATE_DETAILS_REASONS.has(error.code));
  // PL-5（4 章の 5）: 送れる欄だけ（選べない理由がある欄は出さない）。
  const sendableFields = candidate.fields.filter((field) => field.rejection === null);
  // PL-5: 欄の説明は、必須などの印があるときだけ（欄の型と、`maxlength` などの技術の制約は出さない）。
  const fieldHintOf = (field: ScenarioCandidateView['fields'][number]): string => {
    const flags = candidateFieldFlagsText(field);
    return flags === LOCAL_UI_DISCOVERY_TEXT.noFlags ? '' : flags;
  };
  const toggle = (values: readonly string[], value: string, on: boolean): readonly string[] =>
    (on ? [...values.filter((current) => current !== value), value] : values.filter((current) => current !== value));

  return (
    <form
      className="form-grid"
      data-testid="scenario-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        // MI-6: 必ず送る欄（既定の値が分からない欄）は、選ばなくても送る。
        const formFieldNames = updateDraft === null
          ? candidate.fields.filter((field) => field.mustSend || fieldNames.includes(field.name)).map((field) => field.name)
          : updateDraft.fieldNames;
        void onSave({
          fieldNames: apiDraft === null ? formFieldNames : apiDraft.fieldNames,
          // PL-5: 照らす見るだけの確かめは、今の版の値のまま（選ぶ所は出さない）。
          readChecks: initial.readChecks.map(({ readCheckId, revision }) => ({ readCheckId, revision })),
          sideEffectConfirmations: confirmations,
          limits: { maxCreatesPerRun: numberValueOf(perRun), maxCumulativeCreates: numberValueOf(cumulative) },
          approvalTtlDays: numberValueOf(ttlDays),
          // T40a-fix: API のシナリオは、成否の条件と入力の誤りの条件を送らない（null。使わない）。
          verification: verificationInputOf(shownVerification, readChecks, api !== null),
          ...(updateDraft === null ? {} : { update: updateDraft.update }),
          ...(apiDraft === null ? {} : { transport: API_SCENARIO_TRANSPORT, api: apiDraft.api }),
        })
          .then((result) => {
            if (result.ok) {
              setRejection(null);
              onSaved(result);
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
          part="MAIN"
          candidate={candidate}
          view={updateView}
          state={updateState}
          onChange={setUpdateState}
          errors={rejection === null ? [] : rejection.errors}
          // PL-5（4 章の 5、PL-W の発見事項）: 欄の型の生の表示（`text` など）は出さない。
          describeField={(field) => {
            const flags = candidateFieldFlagsText(field);
            return flags === LOCAL_UI_DISCOVERY_TEXT.noFlags ? '' : flags;
          }}
        />
      )}

      {api === null || apiState === null ? null : <ScenarioApiFields view={api} state={apiState} onChange={setApiState} rejection={rejection} />}

      {updateView !== null || api !== null ? null : <fieldset className="field-group" data-testid="scenario-fields">
        <legend className="field-group-heading">{text.fieldsHeading}</legend>
        <p className="field-hint">{text.fieldsNote}</p>
        {/* PL-5（設計書 4 章の 5）: 送れない欄（選べない理由がある欄）の checkbox は出さない。 */}
        {sendableFields.length === 0 ? <p>{text.noFields}</p> : sendableFields.map((field) => {
          const errors = itemErrors((error) => error.fieldName === field.name);
          return (
            <div key={field.name} className="field" data-testid="scenario-field" data-field-name={field.name} data-must-send={String(field.mustSend)}>
              {/* MI-6: 必ず送る欄は、1 つの値しか通らないので、入力でなく表示だけにする。 */}
              {field.mustSend ? (
                <p data-testid="scenario-field-must-send">
                  <code>{field.name}</code>{`: ${text.selectedYes}`}
                  {' '}
                  <span className="field-hint">{text.mustSendHint}</span>
                </p>
              ) : (
                <label className="choice">
                  <input
                    type="checkbox"
                    name={`field-${field.name}`}
                    checked={fieldNames.includes(field.name)}
                    aria-invalid={errors.length > 0}
                    data-field={field.name}
                    onChange={(event) => setFieldNames(toggle(fieldNames, field.name, event.target.checked))}
                  />
                  <span><code>{field.name}</code></span>
                </label>
              )}
              {/* PL-5: 欄の型の生の表示は出さない（印と制約だけ）。 */}
              {fieldHintOf(field) === '' ? null : <span className="field-hint">{fieldHintOf(field)}</span>}
              {errors.length === 0 ? null : <span className="field-error">{errors.join(' ')}</span>}
            </div>
          );
        })}
      </fieldset>}

      {/* PL-5（設計書 4 章の 5、8 章）: 照らす見るだけの確かめを選ぶ所は出さない（今の版の値を引き継ぐ。答え合わせは BeakSight が作る）。 */}
      {copiesLedgerVerification ? <p data-testid="scenario-verification-copied">{LOCAL_UI_WRITE_STAGE_TEXT.scenario.verificationCopied}</p> : null}

      {/* OP-3（設計書 PL 3 章の 1）: 主のボタンは、詳しい内容の前（要点 → 主のボタン → 詳しい内容）。MI-6: 1 回の上限・累積の上限・承認の期限は、既定のままで
          保存できるので、詳しい内容にたたむ（その誤りで拒まれたら開く）。 */}
      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={saving} data-testid="scenario-save">
          {saving ? text.saving : text.save}
        </button>
      </div>

      <AdvancedSettings testId="scenario-advanced-settings" openRequested={openDetails === true || advancedRejected || detailsRejected || verificationErrors.length > 0}>
        {detailsLead ?? null}
        {/* OP-3（D12）: 更新の指定のうち、作ったデータの一覧・アドレスの形（データの ID の区切り）・役割のない欄の名前は、詳しい内容の中だけ。 */}
        {updateView === null || updateState === null ? null : (
          <ScenarioUpdateFields
            part="DETAILS"
            candidate={candidate}
            view={updateView}
            state={updateState}
            onChange={setUpdateState}
            errors={rejection === null ? [] : rejection.errors}
            describeField={(field) => {
              const flags = candidateFieldFlagsText(field);
              return flags === LOCAL_UI_DISCOVERY_TEXT.noFlags ? '' : flags;
            }}
          />
        )}
        <fieldset className="field-group" data-testid="scenario-limits">
          <legend className="field-group-heading">{text.limitsHeading}</legend>
          {perRunFixed ? (
            <dl className="facts">
              <dt>{text.perRunLimit}</dt>
              <dd data-testid="scenario-per-run-fixed" data-value={perRun}>{text.perRunLimitValue(formatCount(rules.maxCreatesPerRun))}</dd>
            </dl>
          ) : (
            <FieldFrame label={text.perRunLimit} hint={text.limitHint(formatCount(rules.minLimit), formatCount(rules.maxCreatesPerRun))} errors={[]}>
              {({ id, describedBy }) => (
                <input id={id} name="maxCreatesPerRun" className="input" type="number" required min={rules.minLimit} max={rules.maxCreatesPerRun} step={1}
                  value={perRun} aria-describedby={describedBy} onChange={(event) => setPerRun(event.target.value)} />
              )}
            </FieldFrame>
          )}
        </fieldset>
        {/* PL-5 の修正の 1 回目（設計書 3 章の 1）: 詳しい内容は 1 つ。API の指定のうち BeakSight が決める欄も、ここに置く。 */}
        {api === null || apiState === null ? null : <ScenarioApiAdvancedFields view={api} state={apiState} onChange={setApiState} />}
        {/* PL-5（設計書 3 章の 2、8 章）: 答え合わせのしかた（検証の指定）は BeakSight が決める。直すときだけ、詳しい内容で開く。 */}
        <ScenarioVerificationFields
          state={shownVerification}
          onChange={setVerification}
          readNote={null}
          readChecks={readChecks}
          fieldNames={apiDraft !== null
            ? apiDraft.fieldNames
            : candidate.fields.filter((field) => field.rejection === null && (updateView === null || field.roleRequired)).map((field) => field.name)}
          errors={verificationErrors}
          allowPageTemplate={api !== null}
          api={api !== null}
          writePagePath={candidate.pagePath}
        />
        <p className="field-hint">{text.advancedLimitsNote}</p>
        <FieldFrame label={text.cumulativeLimit} hint={text.limitHint(formatCount(rules.minLimit), formatCount(rules.maxCumulativeCreates))} errors={[]}>
          {({ id, describedBy }) => (
            <input id={id} name="maxCumulativeCreates" className="input" type="number" required min={rules.minLimit} max={rules.maxCumulativeCreates}
              step={1} value={cumulative} aria-describedby={describedBy} onChange={(event) => setCumulative(event.target.value)} />
          )}
        </FieldFrame>
        <FieldFrame label={text.ttl} hint={text.ttlHint(formatInteger(rules.minTtlDays), formatInteger(rules.maxTtlDays))} errors={[]}>
          {({ id, describedBy }) => (
            <input id={id} name="approvalTtlDays" className="input" type="number" required min={rules.minTtlDays} max={rules.maxTtlDays} step={1}
              value={ttlDays} aria-describedby={describedBy} onChange={(event) => setTtlDays(event.target.value)} />
          )}
        </FieldFrame>
      </AdvancedSettings>
    </form>
  );
}

/**
 * シナリオの検証の指定の入力（Task 30 の設計書 3 章の「検証の指定」、10 章の 5。T30g）。シナリオのフォーム（作成と変更）が使う。
 * - 成功の条件・入力の誤りの条件（path の前方一致と、任意のセレクタ）、登録の ID の取り方（path の型か要素のセレクタ）、照合の READ（同じ
 *   プロファイルの、取り消していない READ の確かめの定義を選び、送る値の一部をシナリオの送る欄に結び付け、期待を選ぶ）。
 * - 値は、ページの構造（path とセレクタ）と、欄の名前だけ。比べる値は、生成した値を送る欄の名前で指す（値を入力しない）。
 * - 画面の確かめは補助だけ。形と結び付けの確かめは、サーバの下書きの確かめ（`validateScenarioDraft`）が決め、誤りは項目の近くに出す。
 * - 文言は `src/presentation/` のカタログだけ。
 * - T40a-fix: API のシナリオでは、成否の条件と入力の誤りの条件の欄を出さない（使わない。下書きにも null で送る）。
 */
import type {
  RecordIdSource,
  ScenarioResultCondition,
  ScenarioVerification,
  VerificationExpectation,
  VerificationExpectationKind,
} from '../../../../src/control/approval-view.js';
// PRE42-CC 組 UI-K3（台帳の CC-113）: 照合の READ の期待の種類の一覧と値は、管理データに触れない純粋な core の owner から読む（書き写さない。
// 文字列で比べない。Gate `browser-list-values` の (d)(e)）。
import {
  DETAIL_FIELD_EQUALS_EXPECTATION_KIND,
  ROW_COUNT_EQUALS_EXPECTATION_KIND,
  TEXT_CONTAINS_EXPECTATION_KIND,
  VERIFICATION_EXPECTATION_KINDS,
} from '../../../../src/core/read-check-expectation-kinds.js';
import { recordIdPatternMatchesPagePath } from '../../../../src/core/record-id-path-pattern.js';
import { formatInteger } from '../../../../src/presentation/format.js';
import { LOCAL_UI_WRITE_TEXT } from '../../../../src/presentation/messages.js';
import { readCheckExpectationKindDisplay, recordIdSourceDisplay, scenarioVerificationItemDisplay } from '../display/labels';
import type { ScenarioReadCheckOptionView } from '../server/scenario-functions';
import { FieldFrame } from './FieldFrame';

const text = LOCAL_UI_WRITE_TEXT;

/** 登録の ID の取り方の選択肢（閉じた一覧の順）。 */
const RECORD_ID_SOURCE_OPTIONS: readonly RecordIdSource[] = Object.freeze(['URL_PATH_PATTERN', 'ELEMENT']);
/** 照合の READ の期待の種類の選択肢（閉じた一覧の順）。 */
const EXPECTATION_KIND_OPTIONS: readonly VerificationExpectationKind[] = VERIFICATION_EXPECTATION_KINDS;
/** 行の数の期待の既定。 */
const DEFAULT_ROW_COUNT = '1';
/** 未指定の選択肢の値。 */
const UNSET = '';

/** 結果の条件の入力の値。 */
interface ConditionState {
  readonly pathPrefix: string;
  readonly selector: string;
}

/** 期待 1 件の入力の値（数は文字のまま。サーバの形の確かめが拒む）。 */
export interface ExpectationState {
  readonly kind: VerificationExpectationKind;
  readonly count: string;
  readonly field: string;
  readonly fieldName: string;
}

/** 検証の指定の入力の値。 */
export interface VerificationState {
  readonly success: ConditionState;
  readonly inputError: ConditionState;
  readonly recordSource: RecordIdSource | typeof UNSET;
  readonly recordValue: string;
  readonly readCheckId: string;
  /** READ の定義の送る値の名前 → シナリオの送る欄の名前（空は結び付けない）。 */
  readonly bindings: Readonly<Record<string, string>>;
  readonly expectations: readonly ExpectationState[];
}

const conditionStateOf = (condition: ScenarioResultCondition | null): ConditionState =>
  ({ pathPrefix: condition?.pathPrefix ?? '', selector: condition?.selector ?? '' });

const expectationStateOf = (expectation: VerificationExpectation): ExpectationState => {
  switch (expectation.kind) {
    case ROW_COUNT_EQUALS_EXPECTATION_KIND:
      return { kind: expectation.kind, count: String(expectation.count), field: '', fieldName: '' };
    case TEXT_CONTAINS_EXPECTATION_KIND:
      return { kind: expectation.kind, count: DEFAULT_ROW_COUNT, field: '', fieldName: expectation.fieldName };
    case DETAIL_FIELD_EQUALS_EXPECTATION_KIND:
      return { kind: expectation.kind, count: DEFAULT_ROW_COUNT, field: expectation.field, fieldName: expectation.fieldName };
  }
};

/** 保存した検証の指定から、入力の値を作る（作成の画面は、すべて未指定）。 */
export const verificationStateOf = (verification: ScenarioVerification): VerificationState => {
  const { recordId, readVerification } = verification;
  return {
    success: conditionStateOf(verification.successCondition),
    inputError: conditionStateOf(verification.inputErrorCondition),
    recordSource: recordId?.source ?? UNSET,
    recordValue: recordId === null ? '' : recordId.source === 'URL_PATH_PATTERN' ? recordId.pathPattern : recordId.selector,
    readCheckId: readVerification?.readCheckId ?? UNSET,
    bindings: Object.fromEntries((readVerification?.bindings ?? []).map(({ parameterName, fieldName }) => [parameterName, fieldName])),
    expectations: (readVerification?.expectations ?? []).map(expectationStateOf),
  };
};

/** 0 以上の整数の文字だけを数にする（ほかは文字のまま送り、サーバの形の確かめが拒む）。 */
const NON_NEGATIVE_INTEGER = /^[0-9]+$/u;

const conditionInputOf = (condition: ConditionState): ScenarioResultCondition | null =>
  (condition.pathPrefix.trim() === '' ? null : { pathPrefix: condition.pathPrefix, selector: condition.selector === '' ? null : condition.selector });

const expectationInputOf = (expectation: ExpectationState): Record<string, unknown> => {
  switch (expectation.kind) {
    case ROW_COUNT_EQUALS_EXPECTATION_KIND:
      return { kind: expectation.kind, count: NON_NEGATIVE_INTEGER.test(expectation.count) ? Number(expectation.count) : expectation.count };
    case TEXT_CONTAINS_EXPECTATION_KIND:
      return { kind: expectation.kind, fieldName: expectation.fieldName };
    case DETAIL_FIELD_EQUALS_EXPECTATION_KIND:
      return { kind: expectation.kind, field: expectation.field, fieldName: expectation.fieldName };
  }
};

/**
 * 入力の値を、下書きの検証の指定にする（形の確かめはサーバ）。T40a-fix: API のシナリオ（`api`）は、成否の条件と入力の誤りの条件を null にする
 * （使わない。欄も出さない）。
 */
export const verificationInputOf = (
  state: VerificationState,
  readChecks: readonly ScenarioReadCheckOptionView[],
  api = false,
): Record<string, unknown> => {
  const readCheck = readChecks.find(({ readCheckId }) => readCheckId === state.readCheckId);
  return {
    successCondition: api ? null : conditionInputOf(state.success),
    inputErrorCondition: api ? null : conditionInputOf(state.inputError),
    recordId: state.recordSource === UNSET
      ? null
      : state.recordSource === 'URL_PATH_PATTERN'
        ? { source: state.recordSource, pathPattern: state.recordValue }
        : { source: state.recordSource, selector: state.recordValue },
    readVerification: readCheck === undefined
      ? null
      : {
        readCheckId: readCheck.readCheckId,
        revision: readCheck.revision,
        bindings: readCheck.parameterNames
          .filter((parameterName) => (state.bindings[parameterName] ?? UNSET) !== UNSET)
          .map((parameterName) => ({ parameterName, fieldName: state.bindings[parameterName] ?? UNSET })),
        expectations: state.expectations.map(expectationInputOf),
      },
  };
};

/** 説明があるときだけ、枠の説明にする。 */
const hintOf = (description: string | null): { readonly hint?: string } => (description === null ? {} : { hint: description });

/** 結果の条件の 2 つの欄。 */
function ConditionFields({ name, value, onChange }: Readonly<{
  name: 'successCondition' | 'inputErrorCondition';
  value: ConditionState;
  onChange: (next: ConditionState) => void;
}>) {
  const display = scenarioVerificationItemDisplay(name);
  return (
    <fieldset className="field-group" data-testid={`scenario-verification-${name}`}>
      <legend className="field-group-heading">{display.label}</legend>
      <p className="field-hint">{text.conditionHint}</p>
      <FieldFrame label={text.conditionPathPrefix} errors={[]}>
        {({ id, describedBy }) => (
          <input id={id} name={`${name}-pathPrefix`} className="input" type="text" value={value.pathPrefix} aria-describedby={describedBy}
            onChange={(event) => onChange({ ...value, pathPrefix: event.target.value })} />
        )}
      </FieldFrame>
      <FieldFrame label={text.conditionSelector} errors={[]}>
        {({ id, describedBy }) => (
          <input id={id} name={`${name}-selector`} className="input" type="text" value={value.selector} aria-describedby={describedBy}
            onChange={(event) => onChange({ ...value, selector: event.target.value })} />
        )}
      </FieldFrame>
    </fieldset>
  );
}

/** 検証の指定の入力（成功の条件、入力の誤りの条件、登録の ID の取り方、照合の READ）。 */
export function ScenarioVerificationFields({
  state, onChange, readChecks, fieldNames, errors, allowPageTemplate = false, api = false, writePagePath = null,
}: Readonly<{
  state: VerificationState;
  onChange: (next: VerificationState) => void;
  readChecks: readonly ScenarioReadCheckOptionView[];
  /** 結び付けと期待に選べる欄（候補の、送る欄に選べる欄の名前）。 */
  fieldNames: readonly string[];
  /** 検証の指定の誤りの説明（サーバの下書きの確かめ）。 */
  errors: readonly string[];
  /** T38f: `{id}` つきの画面の path の READ の定義も選べるか（API のシナリオだけ。受けるかの判定はサーバの下書きの確かめ）。 */
  allowPageTemplate?: boolean;
  /** T40a-fix: API のシナリオか（成否の条件と入力の誤りの条件の欄を出さず、使わないことの説明を出す）。 */
  api?: boolean;
  /**
   * T40R2-fix: 書き込みの画面の path（API のシナリオで、画面から ID を取る型がこの path にも当たれば注意を出す。保存は拒まない。判定は core の
   * `recordIdPatternMatchesPagePath`）。
   */
  writePagePath?: string | null;
}>) {
  const readCheck = readChecks.find(({ readCheckId }) => readCheckId === state.readCheckId);
  const recordDisplay = scenarioVerificationItemDisplay('recordId');
  const readDisplay = scenarioVerificationItemDisplay('readVerification');
  const setExpectation = (index: number, next: ExpectationState): void =>
    onChange({ ...state, expectations: state.expectations.map((current, position) => (position === index ? next : current)) });
  const fieldOptions = (
    <>
      <option value={UNSET}>{text.bindingUnset}</option>
      {fieldNames.map((name) => <option key={name} value={name}>{name}</option>)}
    </>
  );

  return (
    <fieldset className="field-group" data-testid="scenario-verification">
      <legend className="field-group-heading">{text.verificationHeading}</legend>
      <p className="field-hint">{text.verificationNote}</p>
      {errors.length === 0 ? null : <p className="field-error" data-testid="scenario-verification-errors">{errors.join(' ')}</p>}

      {api ? <p className="field-hint" data-testid="scenario-verification-api-note">{text.apiVerificationNote}</p> : (
        <>
          <ConditionFields name="successCondition" value={state.success} onChange={(success) => onChange({ ...state, success })} />
          <ConditionFields name="inputErrorCondition" value={state.inputError} onChange={(inputError) => onChange({ ...state, inputError })} />
        </>
      )}

      <fieldset className="field-group" data-testid="scenario-verification-recordId">
        <legend className="field-group-heading">{recordDisplay.label}</legend>
        {recordDisplay.description === null ? null : <p className="field-hint">{recordDisplay.description}</p>}
        <FieldFrame label={text.recordIdSource} errors={[]}>
          {({ id, describedBy }) => (
            <select id={id} name="recordId-source" className="input" value={state.recordSource} aria-describedby={describedBy}
              onChange={(event) => onChange({ ...state, recordSource: event.target.value as VerificationState['recordSource'] })}>
              <option value={UNSET}>{text.recordIdUnset}</option>
              {RECORD_ID_SOURCE_OPTIONS.map((source) => <option key={source} value={source}>{recordIdSourceDisplay(source).label}</option>)}
            </select>
          )}
        </FieldFrame>
        {state.recordSource === UNSET ? null : (
          <FieldFrame label={text.recordIdValue} {...hintOf(recordIdSourceDisplay(state.recordSource).description)} errors={[]}>
            {({ id, describedBy }) => (
              <input id={id} name="recordId-value" className="input" type="text" value={state.recordValue} aria-describedby={describedBy}
                onChange={(event) => onChange({ ...state, recordValue: event.target.value })} />
            )}
          </FieldFrame>
        )}
        {/* T40R2-fix（使える度合い）: API のシナリオで、ID の型が書き込みの画面にも当たれば注意を出す（保存は拒まない）。 */}
        {api && writePagePath !== null && state.recordSource === 'URL_PATH_PATTERN'
          && recordIdPatternMatchesPagePath({ source: state.recordSource, pathPattern: state.recordValue }, writePagePath) ? (
            <p className="field-hint" role="note" data-testid="scenario-verification-record-id-caution">{text.recordIdPatternCaution}</p>
          ) : null}
      </fieldset>

      <fieldset className="field-group" data-testid="scenario-verification-readVerification">
        <legend className="field-group-heading">{readDisplay.label}</legend>
        {readDisplay.description === null ? null : <p className="field-hint">{readDisplay.description}</p>}
        {readChecks.length === 0 ? <p>{text.noReadChecks}</p> : (
          <FieldFrame label={text.readVerificationCheck} errors={[]}>
            {({ id, describedBy }) => (
              <select id={id} name="readVerification-check" className="input" value={state.readCheckId} aria-describedby={describedBy}
                onChange={(event) => onChange({ ...state, readCheckId: event.target.value, bindings: {} })}>
                <option value={UNSET}>{text.readVerificationUnset}</option>
                {/* T37d fix round 1: 画面の path を読む定義は、照合の READ に使えないので出さない（サーバも拒む）。T38f: API のシナリオは、`{id}` つきの
                    画面の path の定義も出す（結び付けは 0 件。`{id}` には台帳の ID が入る）。 */}
                {readChecks.filter(({ verifiable, pageTemplate }) => verifiable || (allowPageTemplate && pageTemplate)).map(({ readCheckId, revision }) => (
                  <option key={readCheckId} value={readCheckId}>{text.readVerificationOption(readCheckId, formatInteger(revision))}</option>
                ))}
              </select>
            )}
          </FieldFrame>
        )}
        {readCheck === undefined ? null : (
          <>
            <h4>{text.bindingsHeading}</h4>
            <p className="field-hint">{text.bindingsNote}</p>
            {readCheck.parameterNames.map((parameterName) => (
              <div key={parameterName} data-testid="scenario-verification-binding" data-parameter-name={parameterName}>
                <FieldFrame label={text.bindingLabel(parameterName)} errors={[]}>
                  {({ id, describedBy }) => (
                    <select id={id} name={`binding-${parameterName}`} className="input" value={state.bindings[parameterName] ?? UNSET}
                      aria-describedby={describedBy}
                      onChange={(event) => onChange({ ...state, bindings: { ...state.bindings, [parameterName]: event.target.value } })}>
                      {fieldOptions}
                    </select>
                  )}
                </FieldFrame>
              </div>
            ))}
            <h4>{text.expectationsHeading}</h4>
            {state.expectations.map((expectation, index) => (
              <div key={index} className="field-group" data-testid="scenario-verification-expectation" data-index={String(index)}>
                <FieldFrame label={text.expectationKind} errors={[]}>
                  {({ id, describedBy }) => (
                    <select id={id} name={`expectation-${String(index)}-kind`} className="input" value={expectation.kind} aria-describedby={describedBy}
                      onChange={(event) => setExpectation(index, { ...expectation, kind: event.target.value as VerificationExpectationKind })}>
                      {EXPECTATION_KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{readCheckExpectationKindDisplay(kind).label}</option>)}
                    </select>
                  )}
                </FieldFrame>
                {expectation.kind === ROW_COUNT_EQUALS_EXPECTATION_KIND ? (
                  <FieldFrame label={text.expectationCount} errors={[]}>
                    {({ id, describedBy }) => (
                      <input id={id} name={`expectation-${String(index)}-count`} className="input" type="number" min={1} step={1} value={expectation.count}
                        aria-describedby={describedBy} onChange={(event) => setExpectation(index, { ...expectation, count: event.target.value })} />
                    )}
                  </FieldFrame>
                ) : (
                  <>
                    {expectation.kind === DETAIL_FIELD_EQUALS_EXPECTATION_KIND ? (
                      <FieldFrame label={text.expectationField} errors={[]}>
                        {({ id, describedBy }) => (
                          <input id={id} name={`expectation-${String(index)}-field`} className="input" type="text" value={expectation.field}
                            aria-describedby={describedBy} onChange={(event) => setExpectation(index, { ...expectation, field: event.target.value })} />
                        )}
                      </FieldFrame>
                    ) : null}
                    <FieldFrame label={text.expectationFieldName} errors={[]}>
                      {({ id, describedBy }) => (
                        <select id={id} name={`expectation-${String(index)}-fieldName`} className="input" value={expectation.fieldName}
                          aria-describedby={describedBy} onChange={(event) => setExpectation(index, { ...expectation, fieldName: event.target.value })}>
                          {fieldOptions}
                        </select>
                      )}
                    </FieldFrame>
                  </>
                )}
                <div className="button-row">
                  <button type="button" className="button" data-testid="scenario-verification-remove-expectation"
                    onClick={() => onChange({ ...state, expectations: state.expectations.filter((_current, position) => position !== index) })}>
                    {text.removeExpectation}
                  </button>
                </div>
              </div>
            ))}
            <div className="button-row">
              <button type="button" className="button" data-testid="scenario-verification-add-expectation"
                onClick={() => onChange({
                  ...state,
                  expectations: [...state.expectations, { kind: ROW_COUNT_EQUALS_EXPECTATION_KIND, count: DEFAULT_ROW_COUNT, field: '', fieldName: '' }],
                })}>
                {text.addExpectation}
              </button>
            </div>
          </>
        )}
      </fieldset>
    </fieldset>
  );
}

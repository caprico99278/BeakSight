/**
 * API のシナリオの指定の入力（Task 38 の設計書 3.2、3.7。T38f）。シナリオのフォーム（作成と変更）が、型の digest で選んだ API の候補で使う。
 * - 鍵と欄の対応: probe の案（欄に対応する鍵と、その欄の識別）を示し、送るかを確かめる（欄に対応する鍵は、すべて送る決まり。判定は下書きの確かめ）。
 * - ページが決める鍵: 欄に対応しない鍵を一覧で示し、許すものを選ぶ。選べない鍵（秘密に見える名前）は、サーバが下書きの確かめの owner で求めた理由を出す。
 * - 型の要約の案（要求の型、許すヘッダの名前（probe の名前から、ブラウザが付ける名前を除いた案）など）: 承認の画面と同じ部品 `ScenarioApiShape` で出す
 *   （表示だけ。保存の値は、下書きの確かめが型から作る）。
 * - UPDATE: filter の名前（型の filter の案）と、台帳の参照（登録のシナリオと、更新の画面の path の型）。filter の列の名前は確かめていない注意を出す。
 * - 登録の ID の取り方: 応答の本文の鍵（任意。空なら、検証の指定の今の取り方）。
 * - 画面の確かめは補助だけ。誤りは、サーバの下書きの確かめ（`validateScenarioDraft`）の理由を、鍵ごと・項目の近くに出す。文言はカタログだけ。
 * - T41e（Task 41 の設計書 3.1、3.5）: UPDATE では、目印を入れた欄の鍵ごとに、変えるか保つかを選ぶ（form の更新と同じ語。既定は保つ。メールアドレスと
 *   電話番号の欄は、既定で保つことを近くで知らせる）。下書きは、変える鍵を `fieldNames`、保つ鍵を `api.keptKeys` で送る。欄として識別できないページが
 *   決める鍵と、台帳の ID と filter が結び付かない台帳の理由は、この入力の近くに出す。
 * - DEF-147: 公開の状態にあたる鍵は、型の要約に注意の印を出し、UPDATE では既定で保つことを近くで知らせる（保つ欄の既定の候補。利用者が変える欄に移せる）。
 */
import type { ScenarioApiSpec, ScenarioDraftRejectionReason } from '../../../../src/control/approval-view.js';
import { UPDATE_SCENARIO_KIND } from '../../../../src/core/scenario-kind.js';
// PRE42-CC 組 UI-K2（CC-113）: 連絡先の欄の型は、純粋な core の owner から読む（`ScenarioUpdateFields.tsx` と同じ一覧。書き写さない）。
import { CONTACT_CANDIDATE_FIELD_TYPES } from '../../../../src/core/candidate-field-types.js';
import { LOCAL_UI_SCENARIO_TEXT, SCENARIO_DRAFT_REJECTION_DESCRIPTIONS } from '../../../../src/presentation/messages.js';
import type { ScenarioApiFormView, ScenarioRejectionView } from '../server/scenario-functions';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';
import { ScenarioApiShape } from './ScenarioApiShape';

const text = LOCAL_UI_SCENARIO_TEXT.api;
/** T41e: 変える・保つの語と、メールアドレスと電話番号の欄の知らせ（form の更新と同じ文言）。 */
const roleText = LOCAL_UI_SCENARIO_TEXT.update;

/** 未選択の値。 */
const UNSET = '';
/** 登録の ID の取り方（応答の本文の鍵）。 */
const RESPONSE_BODY_KEY = 'RESPONSE_BODY_KEY';
/**
 * T41e: 更新のシナリオの種類（変えるか保つかを選ぶ）。CC-106（PRE42-CC の組 2）: 値はシナリオの種類の owner（`src/core/scenario-kind.ts`。管理データに
 * 触れない純粋なファイルなので、ブラウザ側からも読める）から読む。
 */
const UPDATE_KIND = UPDATE_SCENARIO_KIND;
/** T41e: 鍵の役割の値（form の更新の役割の入力と同じ値。`data-role` と radio の値）。 */
const CHANGE_ROLE = 'CHANGE';
const KEEP_ROLE = 'KEEP';
/** T41e: 既定で保つことを知らせる欄の型（メールアドレスと電話番号。Task 31 の判断 3。PRE42-CC 組 UI-K2: 一覧は core から読む）。 */
const CONTACT_FIELD_TYPES: ReadonlySet<string> = new Set<string>(CONTACT_CANDIDATE_FIELD_TYPES);

/** API の指定の入力の値。UPDATE では `sentKeys` が変える鍵で、ほかの目印の欄の鍵は保つ鍵。 */
export interface ApiFieldsState {
  readonly sentKeys: readonly string[];
  readonly pageKeys: readonly string[];
  readonly filterName: string;
  readonly ledger: string;
  readonly formPathTemplate: string;
  readonly recordIdKey: string;
}

/** API の指定の誤りのうち、この入力の近くに出す理由（鍵に結び付かない API の理由と、台帳の参照の理由）。 */
export const API_PLACED_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_API_KEY_NOT_ALLOWED',
  'SCENARIO_API_PAGE_KEY_SECRET_LIKE',
  'SCENARIO_API_FILTER_MISMATCH',
  // T38R-fix の I-2。
  'SCENARIO_API_PAGE_KEY_NOT_SCALAR',
  'SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE',
  'SCENARIO_UPDATE_SPEC_MISSING',
  'SCENARIO_UPDATE_SPEC_NOT_ALLOWED',
  'SCENARIO_UPDATE_TARGET_NOT_FOUND',
  'SCENARIO_UPDATE_TARGET_NOT_CREATE',
  'SCENARIO_UPDATE_PATH_MISMATCH',
  'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
  // T41e: 更新の画面の欄として識別できないページが決める鍵、台帳の ID と filter・画面の型の結び付き、変える鍵がない。
  'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE',
  'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID',
  'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID',
  'SCENARIO_UPDATE_NO_CHANGED_FIELD',
]);

/**
 * 入力の初めの値（作成の画面は、登録は欄に対応する鍵をすべて送り、T41e: 更新は変える鍵なし（すべて保つ）。型の filter と型の最初の案。FM2b: 前もって
 * 選ぶ値があれば、台帳と画面の型はその値。変更の画面は、今の版の値）。
 */
export const apiStateOf = (view: ScenarioApiFormView, current: ScenarioApiSpec | null): ApiFieldsState => ({
  sentKeys: current === null
    ? (view.kind === UPDATE_KIND ? [] : view.keyFields.map(({ key }) => key))
    : current.keyFields.map(({ key }) => key),
  pageKeys: current === null ? [] : current.pageKeys.map(({ key }) => key),
  filterName: current?.filterName ?? view.filterName ?? '',
  // FM2b: 自動の下書きの案内から開いた作成の画面は、前もって選ぶ台帳と画面の型（サーバが選択肢にあると確かめた案）から始める。
  ledger: current?.ledger?.targetCreateScenarioId ?? (current === null ? view.preset?.ledger?.value : undefined) ?? UNSET,
  formPathTemplate: current?.ledger?.formPathTemplate ?? (current === null ? view.preset?.formPathTemplate?.value : undefined)
    ?? view.formPathTemplates[0] ?? UNSET,
  recordIdKey: current?.recordId?.key ?? '',
});

/** 入力の値を、下書きの送る鍵と API の指定にする（形の確かめはサーバ）。T41e: 更新は、変える鍵でない目印の欄の鍵を保つ鍵（`keptKeys`）で送る。 */
export const apiDraftOf = (view: ScenarioApiFormView, state: ApiFieldsState): {
  readonly fieldNames: readonly string[];
  readonly api: Readonly<Record<string, unknown>>;
} => ({
  fieldNames: view.keyFields.map(({ key }) => key).filter((key) => state.sentKeys.includes(key)),
  api: {
    ...(view.kind === UPDATE_KIND ? { keptKeys: view.keyFields.map(({ key }) => key).filter((key) => !state.sentKeys.includes(key)) } : {}),
    shapeDigest: view.shapeDigest,
    pageKeys: view.pageKeys.map(({ key }) => key).filter((key) => state.pageKeys.includes(key)),
    filterName: view.kind === UPDATE_KIND && state.filterName.trim() !== '' ? state.filterName : null,
    recordId: state.recordIdKey.trim() === '' ? null : { source: RESPONSE_BODY_KEY, key: state.recordIdKey },
    ledger: view.kind === UPDATE_KIND && state.ledger !== UNSET ? { targetCreateScenarioId: state.ledger, formPathTemplate: state.formPathTemplate } : null,
  },
});

const toggled = (values: readonly string[], value: string, on: boolean): readonly string[] =>
  (on ? [...values.filter((current) => current !== value), value] : values.filter((current) => current !== value));

/** API の指定の入力。 */
export function ScenarioApiFields({ view, state, onChange, rejection }: Readonly<{
  view: ScenarioApiFormView;
  state: ApiFieldsState;
  onChange: (next: ApiFieldsState) => void;
  rejection: ScenarioRejectionView | null;
}>) {
  const errors = rejection === null ? [] : rejection.errors;
  const keyErrors = (key: string): readonly string[] =>
    errors.filter((error) => error.fieldName === key).map((error) => SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[error.code].description);
  const placed = [...new Set(errors.filter((error) => error.fieldName === null && API_PLACED_REASONS.has(error.code)).map((error) => error.code))];
  return (
    <fieldset className="field-group" data-testid="scenario-api-fields" data-shape-digest={view.shapeDigest} data-kind={view.kind ?? ''}>
      <legend className="field-group-heading">{text.formHeading}</legend>
      <p className="field-hint">{text.formNote}</p>
      {placed.length === 0 ? null : (
        <Notice kind="critical" heading={text.errorsHeading}>
          <div data-testid="scenario-api-errors">
            {placed.map((code) => (
              <div key={code} data-code={code}>
                <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[code].description}</p>
                <p>{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[code].action}</p>
              </div>
            ))}
          </div>
        </Notice>
      )}
      {/* 型の要約の案（承認の画面と同じ部品。許すヘッダの名前は、ブラウザが付ける名前を除いた案）。 */}
      {view.proposal === null ? null : (
        <ScenarioApiShape api={view.proposal} transport={view.transport} testId="scenario-form-api-shape" publicationStateKeys={view.publicationStateKeys} />
      )}
      <p className="field-hint">{text.headerNamesNote}</p>

      <h3>{text.keyFields}</h3>
      <p className="field-hint">{text.keyFieldsNote}</p>
      {view.keyFields.length === 0 ? <p>{text.none}</p> : view.keyFields.map(({ key, type, field, fieldType, rejection: blocked }) => {
        const messages = keyErrors(key);
        const fieldText = text.keyField(key, type, field.kind === 'NAME' ? text.fieldName(field.name) : text.fieldSelector(field.selector));
        if (view.kind === UPDATE_KIND) {
          // T41e: 更新は、変えるか保つかを選ぶ（既定は保つ）。
          const change = state.sentKeys.includes(key);
          const setRole = (on: boolean): void => onChange({ ...state, sentKeys: toggled(state.sentKeys, key, on) });
          return (
            <fieldset key={key} className="field" data-testid="scenario-api-key" data-key={key} data-role={change ? CHANGE_ROLE : KEEP_ROLE}
              data-rejection={blocked ?? ''}>
              <legend>{fieldText}</legend>
              <label className="choice">
                <input type="radio" name={`api-role-${key}`} value={CHANGE_ROLE} checked={change} aria-invalid={messages.length > 0} data-api-role={key}
                  onChange={() => setRole(true)} />
                <span>{roleText.roleChange}</span>
              </label>
              <label className="choice">
                <input type="radio" name={`api-role-${key}`} value={KEEP_ROLE} checked={!change} aria-invalid={messages.length > 0} data-api-role={key}
                  onChange={() => setRole(false)} />
                <span>{roleText.roleKeep}</span>
              </label>
              {CONTACT_FIELD_TYPES.has(fieldType) ? <span className="field-hint" data-testid="scenario-api-contact-hint">{roleText.contactFieldHint}</span> : null}
              {/* DEF-147: 公開の状態にあたる欄は、既定で保つことを近くで知らせる（既定は保つ）。 */}
              {view.publicationStateKeys.includes(key)
                ? <span className="field-hint" data-testid="scenario-api-publication-state-hint">{text.publicationStateKeepHint}</span>
                : null}
              {blocked === null ? null : <span className="field-hint">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[blocked].description}</span>}
              {messages.length === 0 ? null : <span className="field-error">{messages.join(' ')}</span>}
            </fieldset>
          );
        }
        return (
          <div key={key} className="field" data-testid="scenario-api-key" data-key={key} data-rejection={blocked ?? ''}>
            <label className="choice">
              <input
                type="checkbox"
                name={`api-key-${key}`}
                checked={state.sentKeys.includes(key)}
                aria-invalid={messages.length > 0}
                data-api-key={key}
                onChange={(event) => onChange({ ...state, sentKeys: toggled(state.sentKeys, key, event.target.checked) })}
              />
              <span>{fieldText}</span>
            </label>
            {blocked === null ? null : <span className="field-hint">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[blocked].description}</span>}
            {messages.length === 0 ? null : <span className="field-error">{messages.join(' ')}</span>}
          </div>
        );
      })}

      <h3>{text.pageKeys}</h3>
      <p className="field-hint">{text.pageKeysNote}</p>
      {view.pageKeys.length === 0 ? <p>{text.noPageKeys}</p> : view.pageKeys.map(({ key, type, rejection: blocked }) => (
        <div key={key} className="field" data-testid="scenario-api-page-key" data-key={key} data-rejection={blocked ?? ''}>
          <label className="choice">
            <input
              type="checkbox"
              name={`api-page-key-${key}`}
              checked={state.pageKeys.includes(key)}
              disabled={blocked !== null}
              data-api-page-key={key}
              onChange={(event) => onChange({ ...state, pageKeys: toggled(state.pageKeys, key, event.target.checked) })}
            />
            <span>{text.pageKey(key, type)}</span>
          </label>
          {blocked === null ? null : <span className="field-hint">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[blocked].description}</span>}
        </div>
      ))}

      {view.kind !== UPDATE_KIND ? null : (
        <>
          <FieldFrame label={text.filterNameLabel} hint={text.filterNameHint} errors={[]}>
            {({ id, describedBy }) => (
              <input id={id} name="api-filterName" className="input" type="text" value={state.filterName} aria-describedby={describedBy}
                onChange={(event) => onChange({ ...state, filterName: event.target.value })} />
            )}
          </FieldFrame>
          {view.ledgerOptions.length === 0 ? <p data-testid="scenario-api-no-ledger">{text.noLedgerOptions}</p> : null}
          <FieldFrame label={text.ledgerLabel} errors={[]}>
            {({ id, describedBy }) => (
              <select id={id} name="api-ledger" className="input" value={state.ledger} aria-describedby={describedBy}
                onChange={(event) => onChange({ ...state, ledger: event.target.value })}>
                <option value={UNSET}>{text.ledgerUnset}</option>
                {view.ledgerOptions.map(({ scenarioId, pagePath }) => (
                  <option key={scenarioId} value={scenarioId}>{text.ledgerOption(scenarioId, pagePath)}</option>
                ))}
              </select>
            )}
          </FieldFrame>
          <FieldFrame label={text.formPathTemplateLabel} hint={text.formPathTemplateHint} errors={[]}>
            {({ id, describedBy }) => (
              <select id={id} name="api-formPathTemplate" className="input" value={state.formPathTemplate} aria-describedby={describedBy}
                onChange={(event) => onChange({ ...state, formPathTemplate: event.target.value })}>
                {view.formPathTemplates.map((template) => <option key={template} value={template}>{template}</option>)}
              </select>
            )}
          </FieldFrame>
        </>
      )}

      <FieldFrame label={text.recordIdKeyLabel} hint={text.recordIdKeyHint} errors={[]}>
        {({ id, describedBy }) => (
          <input id={id} name="api-recordIdKey" className="input" type="text" value={state.recordIdKey} aria-describedby={describedBy}
            onChange={(event) => onChange({ ...state, recordIdKey: event.target.value })} />
        )}
      </FieldFrame>
    </fieldset>
  );
}

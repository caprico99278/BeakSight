/**
 * UPDATE の指定の入力（Task 31 の設計書 3 章の「UPDATE の指定」、2 章のユーザーの判断 3・4。T31h-1）。シナリオのフォーム（`ScenarioForm`）が、UPDATE の
 * 候補のときに、送る欄の選択の代わりに出す。
 * - 台帳: 同じプロファイルの登録（CREATE）のシナリオを選ぶ（サーバが返した一覧）。
 * - path の型: 候補から作れる path の型の組（サーバが候補の識別の owner で求めた一覧）から、ID の区切りを選ぶ。作れない・合わないときは、手で入力する
 *   （型の印はサーバが返した契約の値。画面に書き写さない）。
 * - 欄の役割: 見えていて編集できる欄（サーバが下書きの確かめの owner に聞いた欄）ごとに「変える」「保つ」を選ぶ。既定は保つ（メールと電話も保つ）。
 *   変える欄に選べない欄（状態の欄など。理由はサーバが下書きの確かめの owner で求めたもの）は、「変える」を選べなくして理由を出す。
 * - 保存は、今のシナリオの保存の口（`validateScenarioDraft` が確かめる）。誤りは、台帳・型・欄の近くに出す。
 * - T31R-fix-1 の I-2: 選んだ台帳の登録の ID の取り方に結び付かない型の組（サーバが下書きの確かめの owner の判定で求めた番号）は、選べなくする。
 *   選んでいた組が、台帳を替えて結び付かなくなったら、理由を型の近くに出す（保存すれば、サーバも同じ理由で拒む）。
 * 値は、どの欄も持たない（入力の値・hidden の値・保つ欄の値は、サーバも返さない）。
 */
import type { ScenarioDraftRejectionReason } from '../../../../src/control/approval-view.js';
import type { CandidateFieldType } from '../../../../src/control/discovery-view.js';
import { LOCAL_UI_SCENARIO_TEXT, SCENARIO_DRAFT_REJECTION_DESCRIPTIONS } from '../../../../src/presentation/messages.js';
import type {
  ScenarioCandidateView,
  ScenarioErrorView,
  ScenarioFieldView,
  ScenarioUpdateFormView,
  ScenarioUpdateView,
} from '../server/scenario-functions';
import { FieldFrame } from './FieldFrame';

const text = LOCAL_UI_SCENARIO_TEXT.update;

/** 型を手で入力する選択（組の選択肢の番号のほか）。 */
const MANUAL_TEMPLATE = 'manual';

/** 台帳の参照の誤り（台帳の選択の近くに出す）。 */
const LEDGER_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set(['SCENARIO_UPDATE_TARGET_NOT_FOUND', 'SCENARIO_UPDATE_TARGET_NOT_CREATE']);
/** path の型の誤り（型の近くに出す）。 */
const TEMPLATE_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_UPDATE_PATH_MISMATCH',
  'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
  // T31R-fix-1 の I-2。
  'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID',
]);
/** T31R-fix-1 の I-2: 型の組が台帳の取り方に結び付かない理由。 */
const UNBOUND_REASON = 'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID' satisfies ScenarioDraftRejectionReason;

/** 台帳の取り方に結び付かない組の番号（台帳が選択肢になければ空）。 */
const unboundTemplatesOf = (view: ScenarioUpdateFormView, ledgerId: string): ReadonlySet<number> =>
  new Set(view.ledgerOptions.find((option) => option.scenarioId === ledgerId)?.unboundTemplates ?? []);
/** 欄の役割の全体の誤り（役割の近くに出す）。 */
const ROLE_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set(['SCENARIO_UPDATE_NO_CHANGED_FIELD']);
/** UPDATE の指定の入力の近くに出す、欄に結び付かない誤り（フォームの上のお知らせには出さない）。 */
export const UPDATE_PLACED_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([...LEDGER_REASONS, ...TEMPLATE_REASONS, ...ROLE_REASONS]);

/** メールアドレスと電話番号の欄の型（既定で保つことを、欄の近くで知らせる。ユーザーの判断 3）。 */
const CONTACT_FIELD_TYPES: ReadonlySet<CandidateFieldType> = new Set(['email', 'tel'] satisfies readonly CandidateFieldType[]);

/** UPDATE の指定の入力の状態。保つ欄は、役割を決める欄のうち変える欄でないもの（既定は保つ）。 */
export interface ScenarioUpdateState {
  readonly changeNames: readonly string[];
  readonly ledgerId: string;
  /** 組の選択肢の番号（文字）か、手で入力する（`MANUAL_TEMPLATE`）。 */
  readonly templateChoice: string;
  readonly manualForm: string;
  readonly manualAction: string;
}

/** 役割を決める欄の名前（候補の欄の順）。 */
const roleFieldNamesOf = (candidate: ScenarioCandidateView): readonly string[] =>
  candidate.fields.filter((field) => field.roleRequired).map((field) => field.name);

/**
 * 初めの状態（作成の画面は、変える欄なし（すべて保つ）・最初の台帳・最後の組（path の最も後ろの区切り。ID の区切りであることが多い）。変更の画面は、
 * 保存した UPDATE の指定）。
 */
export const updateStateOf = (
  candidate: ScenarioCandidateView,
  view: ScenarioUpdateFormView,
  fieldNames: readonly string[],
  saved: ScenarioUpdateView | null,
): ScenarioUpdateState => {
  const roles = roleFieldNamesOf(candidate);
  if (saved === null) {
    const ledgerId = view.ledgerOptions[0]?.scenarioId ?? '';
    // T31R-fix-1 の I-2: 最初の台帳の取り方に結び付く組のうち、最後の組（なければ手で入力する）。
    const unbound = unboundTemplatesOf(view, ledgerId);
    const bound = view.templateOptions.map((_option, index) => index).filter((index) => !unbound.has(index));
    return {
      changeNames: [],
      ledgerId,
      templateChoice: bound.length === 0 ? MANUAL_TEMPLATE : String(bound[bound.length - 1]),
      manualForm: '',
      manualAction: '',
    };
  }
  const option = view.templateOptions.findIndex((candidateOption) =>
    candidateOption.formPathTemplate === saved.formPathTemplate && candidateOption.actionPathTemplate === saved.actionPathTemplate);
  return {
    changeNames: fieldNames.filter((name) => roles.includes(name)),
    ledgerId: saved.targetCreateScenarioId,
    templateChoice: option < 0 ? MANUAL_TEMPLATE : String(option),
    manualForm: saved.formPathTemplate,
    manualAction: saved.actionPathTemplate,
  };
};

/** 送る UPDATE の指定（下書きの `update`）と、変える欄（下書きの `fieldNames`。候補の欄の順）。 */
export const updateDraftOf = (
  candidate: ScenarioCandidateView,
  view: ScenarioUpdateFormView,
  state: ScenarioUpdateState,
): { readonly fieldNames: readonly string[]; readonly update: Readonly<Record<string, unknown>> } => {
  const roles = roleFieldNamesOf(candidate);
  const option = state.templateChoice === MANUAL_TEMPLATE ? undefined : view.templateOptions[Number(state.templateChoice)];
  return {
    fieldNames: roles.filter((name) => state.changeNames.includes(name)),
    update: {
      targetCreateScenarioId: state.ledgerId,
      formPathTemplate: option?.formPathTemplate ?? state.manualForm,
      actionPathTemplate: option?.actionPathTemplate ?? state.manualAction,
      keepFieldNames: roles.filter((name) => !state.changeNames.includes(name)),
    },
  };
};

/** 誤りの説明（同じ理由は 1 つ）。 */
const descriptionsOf = (errors: readonly ScenarioErrorView[]): readonly string[] =>
  [...new Set(errors.map((error) => SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[error.code].description))];

export function ScenarioUpdateFields({ candidate, view, state, onChange, errors, describeField }: Readonly<{
  candidate: ScenarioCandidateView;
  view: ScenarioUpdateFormView;
  state: ScenarioUpdateState;
  onChange: (next: ScenarioUpdateState) => void;
  /** 保存を拒んだときの、下書きの誤り（なければ空）。 */
  errors: readonly ScenarioErrorView[];
  /** 欄の型・属性・制約の表示（フォームと同じもの）。 */
  describeField: (field: ScenarioFieldView) => string;
}>) {
  const general = errors.filter((error) => error.fieldName === null && error.readCheckId === null);
  const ledgerErrors = descriptionsOf(general.filter((error) => LEDGER_REASONS.has(error.code)));
  const templateErrors = descriptionsOf(general.filter((error) => TEMPLATE_REASONS.has(error.code)));
  const roleErrors = descriptionsOf(general.filter((error) => ROLE_REASONS.has(error.code)));
  const roleFields = candidate.fields.filter((field) => field.roleRequired);
  const otherFields = candidate.fields.filter((field) => !field.roleRequired);
  const manual = state.templateChoice === MANUAL_TEMPLATE;
  // T31R-fix-1 の I-2: 選んだ台帳の取り方に結び付かない組と、選んでいる組が結び付かないか。
  const unbound = unboundTemplatesOf(view, state.ledgerId);
  const chosenUnbound = !manual && unbound.has(Number(state.templateChoice));
  const setRole = (name: string, change: boolean): void => onChange({
    ...state,
    changeNames: change ? [...state.changeNames.filter((current) => current !== name), name] : state.changeNames.filter((current) => current !== name),
  });

  return (
    <fieldset className="field-group" data-testid="scenario-update">
      <legend className="field-group-heading">{text.heading}</legend>
      <p className="field-hint">{text.note}</p>

      {view.ledgerOptions.length === 0 ? <p data-testid="scenario-update-no-ledger">{text.noLedger}</p> : null}
      <FieldFrame label={text.ledger} hint={text.ledgerHint} errors={ledgerErrors}>
        {({ id, describedBy, invalid }) => (
          <select id={id} name="update-ledger" className="input" value={state.ledgerId} aria-describedby={describedBy} aria-invalid={invalid}
            data-testid="scenario-update-ledger" onChange={(event) => onChange({ ...state, ledgerId: event.target.value })}>
            {view.ledgerOptions.map((option) => (
              <option key={option.scenarioId} value={option.scenarioId}>{text.ledgerOption(option.scenarioId, option.pagePath)}</option>
            ))}
          </select>
        )}
      </FieldFrame>

      <fieldset className="field-group" data-testid="scenario-update-templates">
        <legend className="field-group-heading">{text.templates}</legend>
        <p className="field-hint" data-testid="scenario-update-candidate-paths">
          {text.candidatePaths(candidate.pagePath, candidate.actionPath ?? '')}
        </p>
        {view.templateOptions.length === 0 ? <p data-testid="scenario-update-no-template">{text.noTemplateOption}</p> : null}
        <FieldFrame label={text.templates} hint={text.templatesHint(view.placeholder)} errors={manual ? [] : templateErrors}>
          {({ id, describedBy, invalid }) => (
            <select id={id} name="update-template" className="input" value={state.templateChoice} aria-describedby={describedBy}
              aria-invalid={invalid} data-testid="scenario-update-template" onChange={(event) => onChange({ ...state, templateChoice: event.target.value })}>
              {view.templateOptions.map((option, index) => (
                <option key={`${option.formPathTemplate} ${option.actionPathTemplate}`} value={String(index)} disabled={unbound.has(index)}>
                  {text.templateOption(option.formPathTemplate, option.actionPathTemplate, option.recordId)}
                </option>
              ))}
              <option value={MANUAL_TEMPLATE}>{text.manualTemplate}</option>
            </select>
          )}
        </FieldFrame>
        {chosenUnbound ? (
          <p className="field-error" data-testid="scenario-update-template-unbound">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[UNBOUND_REASON].description}</p>
        ) : null}
        {!manual ? null : (
          <>
            <FieldFrame label={text.formPathTemplate} hint={text.manualTemplateHint(view.placeholder)} errors={templateErrors}>
              {({ id, describedBy, invalid }) => (
                <input id={id} name="update-form-path-template" className="input" type="text" value={state.manualForm} aria-describedby={describedBy}
                  aria-invalid={invalid} onChange={(event) => onChange({ ...state, manualForm: event.target.value })} />
              )}
            </FieldFrame>
            <FieldFrame label={text.actionPathTemplate} hint={text.manualTemplateHint(view.placeholder)} errors={templateErrors}>
              {({ id, describedBy, invalid }) => (
                <input id={id} name="update-action-path-template" className="input" type="text" value={state.manualAction} aria-describedby={describedBy}
                  aria-invalid={invalid} onChange={(event) => onChange({ ...state, manualAction: event.target.value })} />
              )}
            </FieldFrame>
          </>
        )}
      </fieldset>

      <fieldset className="field-group" data-testid="scenario-update-roles">
        <legend className="field-group-heading">{text.rolesHeading}</legend>
        <p className="field-hint">{text.rolesNote}</p>
        {roleErrors.length === 0 ? null : <p className="field-error" data-testid="scenario-update-roles-errors">{roleErrors.join(' ')}</p>}
        {roleFields.map((field) => {
          const change = state.changeNames.includes(field.name);
          const fieldErrors = descriptionsOf(errors.filter((error) => error.fieldName === field.name));
          return (
            <fieldset key={field.name} className="field" data-testid="scenario-update-role" data-field-name={field.name}
              data-role={change ? 'CHANGE' : 'KEEP'} data-rejection={field.rejection ?? ''}>
              <legend><code>{field.name}</code></legend>
              <span className="field-hint">{describeField(field)}</span>
              <label className="choice">
                <input type="radio" name={`role-${field.name}`} value="CHANGE" checked={change} disabled={field.rejection !== null}
                  aria-invalid={fieldErrors.length > 0} onChange={() => setRole(field.name, true)} />
                <span>{text.roleChange}</span>
              </label>
              <label className="choice">
                <input type="radio" name={`role-${field.name}`} value="KEEP" checked={!change} aria-invalid={fieldErrors.length > 0}
                  onChange={() => setRole(field.name, false)} />
                <span>{text.roleKeep}</span>
              </label>
              {field.rejection === null ? null : (
                <span className="field-hint" data-testid="scenario-update-role-blocked">{SCENARIO_DRAFT_REJECTION_DESCRIPTIONS[field.rejection].description}</span>
              )}
              {CONTACT_FIELD_TYPES.has(field.type) ? <span className="field-hint" data-testid="scenario-update-contact-hint">{text.contactFieldHint}</span> : null}
              {fieldErrors.length === 0 ? null : <span className="field-error">{fieldErrors.join(' ')}</span>}
            </fieldset>
          );
        })}
      </fieldset>

      <div className="field-group" data-testid="scenario-update-other-fields">
        <h3 className="field-group-heading">{text.otherFieldsHeading}</h3>
        <p className="field-hint">{text.otherFieldsNote}</p>
        {otherFields.length === 0 ? <p>{text.noOtherFields}</p> : (
          <ul>
            {otherFields.map((field) => (
              <li key={field.name} data-testid="scenario-update-other-field" data-field-name={field.name}>
                <code>{field.name}</code> <span className="field-hint">{describeField(field)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </fieldset>
  );
}

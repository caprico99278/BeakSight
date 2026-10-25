/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 1 回の操作で自動ログインの設定を終える欄（資格情報の画面の、手動のログインのプロファイルの形）。
 * - 中身は 3 つ: 認証の方式の変更（今の方式 → 自動ログイン）、ログインの 3 つのセレクタ（最後の手動のログインの段の観察の案を入れて出し、推測の印を付ける。
 *   人が直せる。直した値は「人が決める」の印）、資格情報の入力（ユーザー名、パスワードを 2 回）。
 * - 「変更を確かめる」で確認のダイアログを開き、変えるもの（方式・セレクタ・回数の上限・資格情報）、改訂が進むこと、承認が外れるシナリオの数を出す。
 *   確定で 1 回だけ保存の要求を送る（順はサーバの `setUpAutomatedLogin`）。送った後は、成否にかかわらず資格情報の入力をすぐに空にする。
 * - 値（ユーザー名とパスワード）は画面の状態の中だけに置き、表示しない（`CredentialValueField`）。文言はカタログだけ（`LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT`）。
 * - 「ログインを確かめる」は自動で始めない（保存の後の画面がボタンを出す）。
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { AUTOMATED_LOGIN_AUTH_STRATEGY } from '../../../../src/control/contracts.js';
import type { EntryCheckField } from '../../../../src/control/entry-check.js';
import { formatCount, formatInteger, formatTimes } from '../../../../src/presentation/format.js';
import {
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_TEXT,
} from '../../../../src/presentation/messages.js';
import { authStrategyDisplay } from '../display/labels';
import type { AuthSetupFormField } from '../server/auth-setup-errors';
import {
  setUpAutomatedLoginFn,
  type AutomatedLoginSetupResultView,
  type AutomatedLoginSetupView,
  type CredentialPageView,
} from '../server/credential-functions';
import { ConfirmDialog } from './ConfirmDialog';
import { CredentialValueField } from './CredentialValueField';
import { DraftValueMark } from './DraftValueMark';
import { FieldFrame } from './FieldFrame';
import { Notice } from './Notice';

const text = LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT;
const credentialText = LOCAL_UI_CREDENTIAL_TEXT;
const setupText = LOCAL_UI_AUTH_TEXT.setup;
/** 保存の後の認証の方式（FM2R の Minor 4: 値は owner `contracts.ts` の定数）。 */
const AUTOMATED_LOGIN = AUTOMATED_LOGIN_AUTH_STRATEGY;

/** 3 つのセレクタの欄（順、認証の設定のフォームの項目、ラベルと説明）。 */
const SELECTOR_FIELDS: readonly {
  readonly field: EntryCheckField;
  readonly formField: AuthSetupFormField;
  readonly label: string;
  readonly hint: string;
}[] = Object.freeze([
  { field: 'username', formField: 'usernameSelector', label: setupText.usernameSelector, hint: setupText.usernameSelectorHint },
  { field: 'password', formField: 'passwordSelector', label: setupText.passwordSelector, hint: setupText.passwordSelectorHint },
  { field: 'submit', formField: 'submitSelector', label: setupText.submitSelector, hint: setupText.submitSelectorHint },
]);

type Selectors = Readonly<Record<EntryCheckField, string>>;

/** 欄の最初の値（案があれば案、なければ今の設定の値、どちらもなければ空）。 */
const initialSelectorsOf = (setup: AutomatedLoginSetupView): Selectors => ({
  username: setup.proposals.username?.value ?? setup.currentSelectors.username ?? '',
  password: setup.proposals.password?.value ?? setup.currentSelectors.password ?? '',
  submit: setup.proposals.submit?.value ?? setup.currentSelectors.submit ?? '',
});

/** 資格情報の入力の値（画面の入力のまま。送った後に、すぐに空にする）。 */
interface ValueState {
  readonly username: string;
  readonly password: string;
  readonly passwordConfirmation: string;
}
const EMPTY_VALUES: ValueState = Object.freeze({ username: '', password: '', passwordConfirmation: '' });

/** 拒否の結果（要求が届かなかったときは `REQUEST_FAILED`）。 */
type Failure = Exclude<AutomatedLoginSetupResultView, { ok: true }> | 'REQUEST_FAILED';

/** 結果の形を読む（形でなければ、要求が届かなかった）。 */
const resultOf = (value: unknown): AutomatedLoginSetupResultView | 'REQUEST_FAILED' => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'REQUEST_FAILED';
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record['ok'] === true) {
    return value as AutomatedLoginSetupResultView;
  }
  if (record['ok'] === false && typeof record['reason'] === 'string'
    && (record['kind'] === 'CREDENTIAL' ? Object.hasOwn(CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS, record['reason'])
      : record['kind'] === 'SETUP' && Object.hasOwn(text.rejections, record['reason']))) {
    return value as AutomatedLoginSetupResultView;
  }
  return 'REQUEST_FAILED';
};

/** 拒否の知らせ（説明と、することと、資格情報のファイルの戻し）。 */
function FailureNotice({ failure }: Readonly<{ failure: Failure }>) {
  if (failure === 'REQUEST_FAILED') {
    return (
      <Notice kind="critical" heading={text.rejectedHeading}>
        <p data-testid="automated-login-setup-request-failed">{text.requestFailed}</p>
      </Notice>
    );
  }
  const description = failure.kind === 'CREDENTIAL' ? CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[failure.reason] : text.rejections[failure.reason];
  return (
    <Notice kind="critical" heading={text.rejectedHeading}>
      <p data-testid="automated-login-setup-rejection" data-kind={failure.kind} data-reason={failure.reason}
        data-rollback={failure.kind === 'SETUP' ? failure.rollback : 'NOT_NEEDED'}>
        {description.description}
      </p>
      <p>{description.action}</p>
      <p data-testid="automated-login-setup-rollback">{text.rollbacks[failure.kind === 'SETUP' ? failure.rollback : 'NOT_NEEDED']}</p>
    </Notice>
  );
}

export function AutomatedLoginSetupForm({ page, setup, onSaved }: Readonly<{
  page: CredentialPageView;
  setup: AutomatedLoginSetupView;
  /** 保存の後（画面を読み直して、保存の後の状態と「ログインを確かめる」のボタンを出す）。 */
  onSaved: () => void;
}>) {
  const send = useServerFn(setUpAutomatedLoginFn);
  const { profile } = page;
  const [selectors, setSelectors] = useState<Selectors>(() => initialSelectorsOf(setup));
  const [values, setValues] = useState<ValueState>(EMPTY_VALUES);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const valueLengthHint = credentialText.valueLengthHint(formatInteger(page.minValueLength), formatInteger(page.maxValueLength));

  const changeSelector = (field: EntryCheckField, value: string): void => {
    setSelectors((current) => ({ ...current, [field]: value }));
    setFailure(null);
  };
  const setValue = (key: keyof ValueState, value: string): void => {
    setValues((current) => ({ ...current, [key]: value }));
    setFailure(null);
  };
  const selectorErrors = (formField: AuthSetupFormField): readonly string[] =>
    failure !== null && failure !== 'REQUEST_FAILED' && failure.kind === 'SETUP'
      ? failure.errors.filter((error) => error.field === formField).map((error) => AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS[error.code])
      : [];
  const credentialErrors = (field: 'username' | 'password'): readonly string[] =>
    failure !== null && failure !== 'REQUEST_FAILED' && failure.kind === 'CREDENTIAL' && failure.field === field
      ? [CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[failure.reason].description]
      : [];
  const save = (): void => {
    setSaving(true);
    setFailure(null);
    const sending = send({
      data: {
        profileId: profile.profileId,
        expectedRevision: profile.revision,
        usernameSelector: selectors.username,
        passwordSelector: selectors.password,
        submitSelector: selectors.submit,
        username: values.username,
        password: values.password,
        passwordConfirmation: values.passwordConfirmation,
      },
    });
    // 送った後は、成否にかかわらず、資格情報の入力をすぐに空にする。
    setValues(EMPTY_VALUES);
    void sending
      .then(resultOf, (): 'REQUEST_FAILED' => 'REQUEST_FAILED')
      .then((result) => {
        setDialogOpen(false);
        if (result !== 'REQUEST_FAILED' && result.ok) {
          onSaved();
        } else {
          setFailure(result);
        }
      })
      .finally(() => setSaving(false));
  };
  const selectorText = (value: string | null): string => (value === null || value.trim().length === 0 ? text.dialog.emptySelector : value.trim());
  const attempts = setup.maxLoginAttempts;

  return (
    <section className="panel" data-testid="automated-login-setup">
      <h2 className="panel-heading">{text.heading}</h2>
      <p>{text.intro}</p>
      {failure === null ? null : <FailureNotice failure={failure} />}
      {setup.authSetupCurrent ? null : (
        <Notice kind="caution" heading={text.authSetupNotCurrentHeading}>
          <p data-testid="automated-login-setup-auth-setup-not-current">{text.authSetupNotCurrentBody}</p>
          <p><Link to="/auth-setup/$profileId" params={{ profileId: profile.profileId }}>{text.openAuthSetup}</Link></p>
        </Notice>
      )}
      <form
        className="form-grid"
        noValidate
        data-testid="automated-login-setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          setDialogOpen(true);
        }}
      >
        <fieldset className="field">
          <legend className="field-label">{text.method.heading}</legend>
          <dl className="facts" data-testid="automated-login-setup-method">
            <dt>{text.method.before}</dt>
            <dd data-item="before" data-auth={setup.currentAuth}>{authStrategyDisplay(setup.currentAuth).label}</dd>
            <dt>{text.method.after}</dt>
            <dd data-item="after" data-auth={AUTOMATED_LOGIN}>{authStrategyDisplay(AUTOMATED_LOGIN).label}</dd>
          </dl>
        </fieldset>
        <fieldset className="field">
          <legend className="field-label">{text.selectors.heading}</legend>
          <p className="field-hint">{text.selectors.body}</p>
          {SELECTOR_FIELDS.map(({ field, formField, label, hint }) => {
            const proposal = setup.proposals[field];
            const value = selectors[field];
            return (
              <div key={field} data-testid="automated-login-setup-selector" data-field={field}>
                <FieldFrame label={label} hint={hint} errors={selectorErrors(formField)}>
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      className="input"
                      name={formField}
                      value={value}
                      spellCheck={false}
                      autoComplete="off"
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      onChange={(event) => changeSelector(field, event.target.value)}
                    />
                  )}
                </FieldFrame>
                {proposal === null
                  ? <p className="field-hint" data-testid="automated-login-setup-no-proposal">{text.selectors.noProposal}</p>
                  : <DraftValueMark testId="automated-login-setup-origin" origin={value === proposal.value ? proposal.origin : 'HUMAN'}
                    ground={value === proposal.value ? proposal.ground : 'HUMAN_CHOICE'} />}
              </div>
            );
          })}
        </fieldset>
        <fieldset className="field">
          <legend className="field-label">{text.credentials.heading}</legend>
          <CredentialValueField kind="username" label={credentialText.username} name="username" hint={valueLengthHint}
            value={values.username} errors={credentialErrors('username')} onChange={(value) => setValue('username', value)} />
          <CredentialValueField kind="password" label={credentialText.password} name="password" hint={valueLengthHint}
            value={values.password} errors={credentialErrors('password')} onChange={(value) => setValue('password', value)} />
          <CredentialValueField kind="password" label={credentialText.passwordConfirmation} name="passwordConfirmation"
            value={values.passwordConfirmation} errors={[]} onChange={(value) => setValue('passwordConfirmation', value)} />
        </fieldset>
        <div className="button-row">
          <button type="submit" className="button button--primary" disabled={saving || !setup.authSetupCurrent} data-testid="automated-login-setup-review">
            {saving ? text.saving : text.review}
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={dialogOpen}
        title={text.dialog.title}
        body={text.dialog.body}
        confirmLabel={text.dialog.confirm}
        cancelLabel={text.dialog.cancel}
        busy={saving}
        onCancel={() => setDialogOpen(false)}
        onConfirm={save}
      >
        <table data-testid="automated-login-setup-changes">
          <thead>
            <tr>
              <th scope="col">{text.dialog.item}</th>
              <th scope="col">{text.dialog.before}</th>
              <th scope="col">{text.dialog.after}</th>
            </tr>
          </thead>
          <tbody>
            <tr data-testid="automated-login-setup-change" data-item="method">
              <th scope="row">{text.dialog.method}</th>
              <td>{authStrategyDisplay(setup.currentAuth).label}</td>
              <td>{authStrategyDisplay(AUTOMATED_LOGIN).label}</td>
            </tr>
            {SELECTOR_FIELDS.map(({ field, label }) => (
              <tr key={field} data-testid="automated-login-setup-change" data-item={field}>
                <th scope="row">{label}</th>
                <td>{selectorText(setup.currentSelectors[field])}</td>
                <td><code>{selectorText(selectors[field])}</code></td>
              </tr>
            ))}
            {attempts.before === attempts.after ? null : (
              <tr data-testid="automated-login-setup-change" data-item="maxLoginAttempts">
                <th scope="row">{text.dialog.maxLoginAttempts}</th>
                <td>{formatTimes(attempts.before)}</td>
                <td>{formatTimes(attempts.after)}</td>
              </tr>
            )}
            <tr data-testid="automated-login-setup-change" data-item="credential">
              <th scope="row">{text.dialog.credential}</th>
              <td>{text.dialog.credentialBefore}</td>
              <td>{text.dialog.credentialAfter}</td>
            </tr>
          </tbody>
        </table>
        <Notice kind="caution">
          <p data-testid="automated-login-setup-revision">
            {text.dialog.revisionNotice(LOCAL_UI_TEXT.profileForm.revisionText(profile.revision), LOCAL_UI_TEXT.profileForm.revisionText(profile.revision + 1))}
          </p>
        </Notice>
        {setup.approvedScenarioCount === 0 ? null : (
          <Notice kind="caution">
            <p data-testid="automated-login-setup-approval">{text.dialog.approvalNotice(formatCount(setup.approvedScenarioCount))}</p>
          </Notice>
        )}
      </ConfirmDialog>
    </section>
  );
}

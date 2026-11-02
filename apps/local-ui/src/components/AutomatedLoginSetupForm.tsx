/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 1 回の操作で自動ログインの設定を終える欄（資格情報の画面の、手動のログインのプロファイルの形）。
 * - 「自動ログインにする」で確認のダイアログを開き、変えるもの（方式・回数の上限・資格情報）、改訂が進むこと、承認が外れるシナリオの数を出す。
 *   確定で 1 回だけ保存の要求を送る（順はサーバの `setUpAutomatedLogin`）。送った後は、成否にかかわらず資格情報の入力をすぐに空にする。
 * - 値（ユーザー名とパスワード）は画面の状態の中だけに置き、表示しない（`CredentialValueField`）。文言はカタログだけ（`LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT`）。
 * - PL-S（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 7 章・9 章の 2）: 確認のダイアログに、CSS セレクタを出さない（変えるものの表は、方式・回数の
 *   上限・資格情報）。代わりに、パスワードを入れる先（手でログインしたときと同じログインの画面の、ホストだけ。Origin の表記や path は出さない）、テスト用の
 *   アカウントだけを入れること、保存の場所、回数の決まり（定義元の定数 `auto-login-limits.ts`）を出す。
 * - PL-4（同 3 章の 1・2・3、4 章の 3、6 章の 4）: 資格情報の画面の要点のパネルの中身として描く。見える入力は ID・パスワード・パスワードをもう一度の 3 つと、
 *   主のボタン「自動ログインにする」だけ。ログインの 3 つのセレクタは、最後の手動のログインの観察か最後の入口の確かめの案（`setup.proposals`）が 3 つそろうときだけ、
 *   その案のまま送る（欄・推測の印・方式の表・詳しい設定は出さない。人が CSS を書く道は残さない。MI 4.7.1 の 6 の「送信先は観察からだけ」と同じ考え）。案が
 *   そろわないときは「このサイトでは自動ログインを使えません」と出し、欄もボタンも出さない。認証の設定が古いときも、理由と直す画面へのリンクだけを出す
 *   （押せないボタンは出さない）。保存の後は、画面の側（`onSaved`）が点検の開始の画面へ移す（`automatedLoginSetUpSearch` の印つき）。
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { AUTOMATED_LOGIN_AUTH_STRATEGY } from '../../../../src/control/contracts.js';
import { AUTO_LOGIN_DAILY_MAX_ATTEMPTS, AUTO_LOGIN_DAILY_WINDOW_MS, AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../../src/control/job/auto-login-limits.js';
import { DAY_MS, MINUTE_MS } from '../../../../src/core/time-units.js';
import { formatCount, formatInteger, formatTimes } from '../../../../src/presentation/format.js';
import {
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_TEXT,
} from '../../../../src/presentation/messages.js';
import { authStrategyDisplay } from '../display/labels';
import {
  setUpAutomatedLoginFn,
  type AutomatedLoginSetupResultView,
  type AutomatedLoginSetupView,
  type CredentialPageView,
} from '../server/credential-functions';
import { authSetupErrorSummaryText } from './AuthSetupForm';
import { ConfirmDialog } from './ConfirmDialog';
import { CredentialValueField } from './CredentialValueField';
import { Notice } from './Notice';
import { ARRIVAL_SEARCH } from './PageFrame';

const text = LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT;
const credentialText = LOCAL_UI_CREDENTIAL_TEXT;
/** 保存の後の認証の方式（FM2R の Minor 4: 値は owner `contracts.ts` の定数）。 */
const AUTOMATED_LOGIN = AUTOMATED_LOGIN_AUTH_STRATEGY;

/** PL-4: 自動ログインにした後に、点検の開始の画面へ移すときの search の鍵と値（何が起きたかの印）。 */
const AUTOMATED_LOGIN_SET_UP_SEARCH_KEY = 'automatedLogin';
const AUTOMATED_LOGIN_SET_UP_SEARCH_VALUE = 'setUp';

/**
 * PL-4（設計書 6 章の 4、13 章の最後の段落）: 自動ログインにした後に、点検の開始の画面へ移すときの search（移った印 `ARRIVAL_SEARCH` と、自動ログインにした印）。
 * 移った先は `arrivedFromAutomatedLoginSetUp` で読み、要点の 1 行目に `LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.arrived` を出す。
 */
export const automatedLoginSetUpSearch = Object.freeze({
  ...ARRIVAL_SEARCH,
  [AUTOMATED_LOGIN_SET_UP_SEARCH_KEY]: AUTOMATED_LOGIN_SET_UP_SEARCH_VALUE,
} as { readonly arrived: 'auto'; readonly automatedLogin: 'setUp' });

/** PL-4: 移った先の route で、自動ログインにした直後に移ってきたかを読む（印がなければ偽）。 */
export const arrivedFromAutomatedLoginSetUp = (search: Readonly<Record<string, unknown>>): boolean =>
  search[AUTOMATED_LOGIN_SET_UP_SEARCH_KEY] === AUTOMATED_LOGIN_SET_UP_SEARCH_VALUE;

/** PL-S: 確認のダイアログの回数の決まり（定義元の定数を、分・日・回で示す）。 */
const LIMITS_TEXT = text.dialog.limits(
  formatInteger(AUTO_LOGIN_MIN_INTERVAL_MS / MINUTE_MS),
  formatInteger(AUTO_LOGIN_DAILY_WINDOW_MS / DAY_MS),
  formatInteger(AUTO_LOGIN_DAILY_MAX_ATTEMPTS),
);

/** PL-S: パスワードを入れる先の文（ログインの画面のホストだけ。分からなければ、ホストを出さない文）。 */
const destinationTextOf = (loginHost: string | null): string =>
  (loginHost === null ? text.dialog.destinationUnknown : text.dialog.destination(loginHost));

/** 3 つのセレクタ（観察の案。3 つそろうときだけ）。 */
interface ProposedSelectors {
  readonly usernameSelector: string;
  readonly passwordSelector: string;
  readonly submitSelector: string;
}

/** PL-4: 観察の案が 3 つそろうときの、送るセレクタ（そろわなければ `null`。人は直さない）。 */
const proposedSelectorsOf = (setup: AutomatedLoginSetupView): ProposedSelectors | null => {
  const { username, password, submit } = setup.proposals;
  return username === null || password === null || submit === null
    ? null
    : { usernameSelector: username.value, passwordSelector: password.value, submitSelector: submit.value };
};

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

/**
 * 拒否の知らせ（説明と、することと、資格情報のファイルの戻し）。PL-4: セレクタの欄を出さないので、認証の設定の誤り（`SETUP` の `errors`）は、項目の名前つきの
 * 文で、ここに並べる（開始の画面と同じ文の部品 `authSetupErrorSummaryText`）。
 */
function FailureNotice({ failure }: Readonly<{ failure: Failure }>) {
  if (failure === 'REQUEST_FAILED') {
    return (
      <Notice kind="critical" heading={text.rejectedHeading}>
        <p data-testid="automated-login-setup-request-failed">{text.requestFailed}</p>
      </Notice>
    );
  }
  const description = failure.kind === 'CREDENTIAL' ? CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[failure.reason] : text.rejections[failure.reason];
  const setupErrors = failure.kind === 'SETUP' ? [...new Set(failure.errors.map(authSetupErrorSummaryText))] : [];
  return (
    <Notice kind="critical" heading={text.rejectedHeading}>
      <p data-testid="automated-login-setup-rejection" data-kind={failure.kind} data-reason={failure.reason}
        data-rollback={failure.kind === 'SETUP' ? failure.rollback : 'NOT_NEEDED'}>
        {description.description}
      </p>
      {setupErrors.map((error) => <p key={error} data-testid="automated-login-setup-error">{error}</p>)}
      <p>{description.action}</p>
      <p data-testid="automated-login-setup-rollback">{text.rollbacks[failure.kind === 'SETUP' ? failure.rollback : 'NOT_NEEDED']}</p>
    </Notice>
  );
}

export function AutomatedLoginSetupForm({ page, setup, onSaved }: Readonly<{
  page: CredentialPageView;
  setup: AutomatedLoginSetupView;
  /** 保存の後（画面の側が、点検の開始の画面へ移す）。 */
  onSaved: () => void;
}>) {
  const send = useServerFn(setUpAutomatedLoginFn);
  const { profile } = page;
  const [values, setValues] = useState<ValueState>(EMPTY_VALUES);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const valueLengthHint = credentialText.valueLengthHint(formatInteger(page.minValueLength), formatInteger(page.maxValueLength));
  const selectors = proposedSelectorsOf(setup);

  const setValue = (key: keyof ValueState, value: string): void => {
    setValues((current) => ({ ...current, [key]: value }));
    setFailure(null);
  };
  const credentialErrors = (field: 'username' | 'password'): readonly string[] =>
    failure !== null && failure !== 'REQUEST_FAILED' && failure.kind === 'CREDENTIAL' && failure.field === field
      ? [CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[failure.reason].description]
      : [];

  // PL-4: 観察の案がそろわないときは、欄もボタンも出さない（人に CSS を書かせない）。
  if (selectors === null) {
    return (
      <div data-testid="automated-login-setup">
        <p data-testid="automated-login-setup-not-available">{text.notAvailable}</p>
      </div>
    );
  }
  // 認証の設定が古いか、ないとき: 理由と直す画面へのリンクだけ（押せないボタンは出さない）。
  if (!setup.authSetupCurrent) {
    return (
      <div data-testid="automated-login-setup">
        <Notice kind="caution" heading={text.authSetupNotCurrentHeading}>
          <p data-testid="automated-login-setup-auth-setup-not-current">{text.authSetupNotCurrentBody}</p>
          <p><Link to="/auth-setup/$profileId" params={{ profileId: profile.profileId }}>{text.openAuthSetup}</Link></p>
        </Notice>
      </div>
    );
  }

  const save = (): void => {
    setSaving(true);
    setFailure(null);
    const sending = send({
      data: {
        profileId: profile.profileId,
        expectedRevision: profile.revision,
        ...selectors,
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
  const attempts = setup.maxLoginAttempts;

  return (
    <div data-testid="automated-login-setup">
      <p>{text.intro}</p>
      <Notice kind="caution" heading={credentialText.testAccountOnlyHeading}>
        <p data-testid="credential-test-account-only">{credentialText.testAccountOnlyBody}</p>
        <p>{credentialText.browserSaveNote}</p>
      </Notice>
      {failure === null ? null : <FailureNotice failure={failure} />}
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
          <legend className="field-label">{text.credentials.heading}</legend>
          <CredentialValueField kind="username" label={credentialText.username} name="username" hint={valueLengthHint}
            value={values.username} errors={credentialErrors('username')} onChange={(value) => setValue('username', value)} />
          <CredentialValueField kind="password" label={credentialText.password} name="password" hint={valueLengthHint}
            value={values.password} errors={credentialErrors('password')} onChange={(value) => setValue('password', value)} />
          <CredentialValueField kind="password" label={credentialText.passwordConfirmation} name="passwordConfirmation"
            value={values.passwordConfirmation} errors={[]} onChange={(value) => setValue('passwordConfirmation', value)} />
        </fieldset>
        <div className="button-row">
          <button type="submit" className="button button--primary" disabled={saving} data-testid="automated-login-setup-review">
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
        confirmTone="primary"
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
          <p data-testid="automated-login-setup-destination">{destinationTextOf(setup.loginHost)}</p>
          <p data-testid="automated-login-setup-test-account">{text.dialog.testAccountOnly}</p>
          <p data-testid="automated-login-setup-storage">{text.dialog.storage}</p>
          <p data-testid="automated-login-setup-limits">{LIMITS_TEXT}</p>
        </Notice>
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
    </div>
  );
}

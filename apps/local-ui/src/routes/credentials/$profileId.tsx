import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  AUTO_LOGIN_DAILY_MAX_ATTEMPTS,
  AUTO_LOGIN_DAILY_WINDOW_MS,
  AUTO_LOGIN_MIN_INTERVAL_MS,
} from '../../../../../src/control/job/auto-login-limits.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../../src/control/store/profile-records.js';
import { formatDateTime, formatDuration, formatInteger, formatTimes } from '../../../../../src/presentation/format.js';
import {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  LOCAL_UI_TEXT,
} from '../../../../../src/presentation/messages.js';
import { AutomatedLoginSetupForm } from '../../components/AutomatedLoginSetupForm';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CredentialValueField } from '../../components/CredentialValueField';
import { NextStepLinks } from '../../components/NextSteps';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import {
  automatedLoginResultDisplay,
  credentialChangeKindDisplay,
  credentialEnvironmentDisplay,
  profileStatusDisplay,
  toneClass,
} from '../../display/labels';
import type { CredentialRequestRejection } from '../../server/credential-errors';
import {
  changeCredentialFn,
  getCredentialPageFn,
  registerCredentialFn,
  removeCredentialFn,
  replaceCredentialFn,
  type CredentialPageView,
  type CredentialRequestView,
} from '../../server/credential-functions';

/** 保存の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。FM2e: 1 回の操作で自動ログインに切り替えた後（`automatedLoginSetUp`）。 */
const DONE_NOTICES = Object.freeze([
  'registered', 'changed', 'replaced', 'removed', 'changedAndHoldCleared', 'replacedAndHoldCleared', 'automatedLoginSetUp',
] as const);
type DoneNotice = (typeof DONE_NOTICES)[number];
const isDoneNotice = (value: unknown): value is DoneNotice => DONE_NOTICES.some((notice) => notice === value);

export const Route = createFileRoute('/credentials/$profileId')({
  validateSearch: (search: Record<string, unknown>): { done?: DoneNotice } => (isDoneNotice(search['done']) ? { done: search['done'] } : {}),
  loader: async ({ params }) => {
    const page = await getCredentialPageFn({ data: { profileId: params.profileId } });
    if (page === null) {
      throw notFound();
    }
    return page;
  },
  component: CredentialPage,
});

const text = LOCAL_UI_CREDENTIAL_TEXT;

/** 知らせの文（保存のあと）。停止も解いたときは、2 つの文を出す。 */
const DONE_TEXT: Readonly<Record<DoneNotice, readonly string[]>> = Object.freeze({
  registered: [text.register.done],
  changed: [text.change.done],
  replaced: [text.replace.done],
  removed: [text.remove.done],
  changedAndHoldCleared: [text.change.done, text.clearHold.done],
  replacedAndHoldCleared: [text.replace.done, text.clearHold.done],
  automatedLoginSetUp: [LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.done],
});

/**
 * FM2e: 1 回の操作で自動ログインに切り替えた後の、「ログインを確かめる」の知らせ（自動では始めない。自動ログインの間隔と上限に数えるため、利用者が押す）。
 * ボタンは、保存の後に出す「次の手順」（`NextStepLinks` の資格情報の後の段。ログインを確かめる）を使う（同じボタンを 2 つ出さない）。
 */
function AutomatedLoginSetUpNext() {
  return (
    <Notice kind="caution">
      <p data-testid="automated-login-setup-login-check-note">{LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.loginCheckNote}</p>
      <p>{LOGIN_CHECK_LIMIT_NOTE}</p>
    </Notice>
  );
}

/** 自動ログインの上限の説明（ログインの確かめの画面と同じ文言と、上限の名前つきの定数）。 */
const LOGIN_CHECK_LIMIT_NOTE = LOCAL_UI_LOGIN_CHECK_TEXT.limitNote(
  formatDuration(AUTO_LOGIN_MIN_INTERVAL_MS),
  formatDuration(AUTO_LOGIN_DAILY_WINDOW_MS),
  formatTimes(AUTO_LOGIN_DAILY_MAX_ATTEMPTS),
);


/** 拒否の表示（説明と手順。項目の誤りは、その欄にも出す）。 */
function RejectionNotice({ rejection, heading }: Readonly<{ rejection: CredentialRequestRejection; heading: string }>) {
  const description = CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[rejection.reason];
  return (
    <Notice kind="critical" heading={heading}>
      <p data-testid="credential-rejection" data-reason={rejection.reason} data-field={rejection.field ?? ''}>{description.description}</p>
      <p>{description.action}</p>
    </Notice>
  );
}

/** 保存の状態（値は出さない）。 */
function CredentialStatus({ page }: Readonly<{ page: CredentialPageView }>) {
  const status = text.status;
  const { credential, hold } = page;
  const protection = credentialEnvironmentDisplay(page.environment);
  const originText = page.originMatches === null
    ? status.originUnknown
    : page.originMatches ? status.originMatches : status.originStale;
  return (
    <section className="panel">
      <h2 className="panel-heading">{status.heading}</h2>
      <dl className="facts" data-testid="credential-status">
        <dt>{status.saved}</dt>
        <dd data-testid="credential-saved" data-saved={credential === null ? 'no' : 'yes'}>
          {credential === null ? status.savedNo : status.savedYes}
        </dd>
        {credential === null ? null : (
          <>
            <dt>{status.createdAt}</dt>
            <dd>{formatDateTime(credential.createdAt)}</dd>
            <dt>{status.updatedAt}</dt>
            <dd>{formatDateTime(credential.updatedAt)}</dd>
            <dt>{status.lastChangeKind}</dt>
            <dd data-testid="credential-last-change" data-kind={credential.lastChangeKind}>
              {credentialChangeKindDisplay(credential.lastChangeKind).label}
            </dd>
            <dt>{status.revision}</dt>
            <dd>{LOCAL_UI_TEXT.profileForm.revisionText(credential.credentialRevision)}</dd>
            <dt>{status.loginOrigin}</dt>
            <dd className="cell-break"><code>{credential.loginOrigin}</code></dd>
          </>
        )}
        <dt>{status.currentLoginOrigin}</dt>
        <dd className="cell-break">{page.currentLoginOrigin === null ? status.originUnknown : <code>{page.currentLoginOrigin}</code>}</dd>
        {credential === null ? null : (
          <>
            <dt>{status.originState}</dt>
            <dd data-testid="credential-origin-state" data-state={page.originMatches === false ? 'stale' : 'ok'}>{originText}</dd>
          </>
        )}
        <dt>{status.protection}</dt>
        <dd>
          <span className={toneClass(protection.tone)} data-testid="credential-protection" data-state={page.environment}>{protection.label}</span>
        </dd>
        <dt>{status.hold}</dt>
        <dd data-testid="credential-hold" data-held={hold === null ? 'no' : 'yes'}>
          {hold === null ? status.notHeld : status.heldText(automatedLoginResultDisplay(hold.reason).label, formatDateTime(hold.heldAt))}
        </dd>
      </dl>
      {hold === null ? null : <p className="section-gap">{AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS[hold.reason].action}</p>}
    </section>
  );
}

/** 資格情報の入力の値（画面の入力のまま。送った後に、すぐに空にする）。 */
interface ValueState {
  readonly username: string;
  readonly password: string;
  readonly passwordConfirmation: string;
}
const EMPTY_VALUES: ValueState = Object.freeze({ username: '', password: '', passwordConfirmation: '' });

/** 資格情報の画面（Task 26 の設計書 4.2）。プロファイルの詳細から開く。値（ユーザー名を含む）は、一度も出さない。 */
function CredentialPage() {
  const page = Route.useLoaderData();
  const { done } = Route.useSearch();
  const register = useServerFn(registerCredentialFn);
  const change = useServerFn(changeCredentialFn);
  const replace = useServerFn(replaceCredentialFn);
  const remove = useServerFn(removeCredentialFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [values, setValues] = useState<ValueState>(EMPTY_VALUES);
  const [changeUsername, setChangeUsername] = useState(false);
  const [changePassword, setChangePassword] = useState(false);
  const [clearHold, setClearHold] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<CredentialRequestRejection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeRejection, setRemoveRejection] = useState<CredentialRequestRejection | null>(null);
  const { profile, credential } = page;
  const status = profileStatusDisplay(profile.status);
  const active = profile.status === ACTIVE_PROFILE_STATUS;
  const savable = page.eligible && active && page.environment === 'AVAILABLE' && page.currentLoginOrigin !== null;
  const replaceNeeded = credential !== null && page.originMatches === false;
  const environment = credentialEnvironmentDisplay(page.environment);
  // 欄の長さの説明（上限と下限は資格情報のファイルの部品の名前つきの定数を、サーバが渡す。T36c で下限を足した）。
  // T36R-fix（DEF-123）: 長さは単位のない整数の書式（件数の単位を付けない）。
  const valueLengthHint = text.valueLengthHint(formatInteger(page.minValueLength), formatInteger(page.maxValueLength));

  const setValue = (key: keyof ValueState, value: string): void => {
    setValues((current) => ({ ...current, [key]: value }));
    setRejection(null);
  };
  const showDone = (notice: DoneNotice): void => {
    // 先に今の内容を読み直し（loader）、それから知らせを出す（知らせと内容が食い違わないように）。
    void router.invalidate().then(() =>
      navigate({ to: '/credentials/$profileId', params: { profileId: profile.profileId }, search: { done: notice }, replace: true }));
  };
  /** 送る（送った後は、成否にかかわらず、入力の値をすぐに空にする）。 */
  const submit = (send: () => Promise<CredentialRequestView>, notice: DoneNotice, noticeWithHold: DoneNotice): void => {
    setSubmitting(true);
    setRejection(null);
    const sending = send();
    setValues(EMPTY_VALUES);
    void sending
      .then((result) => {
        if (result.ok) {
          setChangeUsername(false);
          setChangePassword(false);
          setClearHold(false);
          showDone(result.holdCleared ? noticeWithHold : notice);
        } else {
          setRejection(result);
        }
      })
      .finally(() => setSubmitting(false));
  };
  const fieldErrors = (field: 'username' | 'password'): readonly string[] =>
    rejection !== null && rejection.field === field ? [CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[rejection.reason].description] : [];

  const clearHoldChoice = page.hold === null ? null : (
    <div className="field">
      <label className="choice">
        <input type="checkbox" name="clearHold" checked={clearHold} onChange={(event) => setClearHold(event.target.checked)} />
        <span>{text.clearHold.label}</span>
      </label>
      <span className="field-hint">{text.clearHold.hint}</span>
    </div>
  );
  // 削除の操作（ファイルがあるか、読めないときだけ）。自動ログインのプロファイルと、自動ログインでなくなったプロファイルの両方で使う。
  const removeSection = credential === null && page.readError === null ? null : (
    <section className="panel">
      {removeRejection === null ? null : <RejectionNotice rejection={removeRejection} heading={text.removeRejectedHeading} />}
      <button type="button" className="button button--danger" data-testid="credential-remove" onClick={() => setDialogOpen(true)}>
        {text.remove.open}
      </button>
      <ConfirmDialog
        open={dialogOpen}
        title={text.remove.title}
        body={text.remove.body}
        confirmLabel={text.remove.confirm}
        cancelLabel={text.remove.cancel}
        busy={removing}
        onCancel={() => setDialogOpen(false)}
        onConfirm={() => {
          setRemoving(true);
          void remove({ data: { profileId: profile.profileId } })
            .then((result) => {
              setDialogOpen(false);
              if (result.ok) {
                setRemoveRejection(null);
                showDone('removed');
              } else {
                setRemoveRejection(result);
              }
            })
            .finally(() => setRemoving(false));
        }}
      />
    </section>
  );
  const submitButton = (label: string, busyLabel: string, testId: string) => (
    <div className="button-row">
      <button type="submit" className="button button--primary" disabled={submitting} data-testid={testId}>
        {submitting ? busyLabel : label}
      </button>
    </div>
  );

  return (
    <PageFrame title={text.pages.credentials}>
      {done === undefined ? null : (
        <Notice kind="positive">
          {DONE_TEXT[done].map((line) => <p key={line} data-testid="credential-done" data-notice={done}>{line}</p>)}
        </Notice>
      )}
      {done === 'automatedLoginSetUp' && page.eligible && active ? <AutomatedLoginSetUpNext /> : null}
      {/* T43a（Task 43 の設計書 4.1）: 資格情報を保存した後（削除の後は除く）に、次の手順（ログインの確かめ）と「次にすること」へのリンク。 */}
      {done === undefined || done === 'removed' || !page.eligible || !active ? null : (
        <NextStepLinks profileId={profile.profileId} after="CREDENTIAL" mode={profile.mode} auth={profile.auth} />
      )}
      <section className="panel">
        <h2 className="panel-heading">{profile.profileId}</h2>
        <dl className="facts">
          <dt>{LOCAL_UI_TEXT.profileList.columns.status}</dt>
          <dd><span className={toneClass(status.tone)}>{status.label}</span></dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.revision}</dt>
          <dd>{LOCAL_UI_TEXT.profileForm.revisionText(profile.revision)}</dd>
        </dl>
      </section>

      {!page.eligible ? (
        <>
          {/* FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインのプロファイルは、1 回の操作で自動ログインに切り替える欄を出す（残った資格情報の
              ファイルがあれば、先に消す。暗号化を使えない、ジョブが動いている間は出さない）。 */}
          {page.automatedLoginSetup !== null && removeSection === null ? null : (
            <Notice kind="caution">
              <p data-testid="credential-not-eligible">{text.notEligible}</p>
            </Notice>
          )}
          {page.automatedLoginSetup !== null && removeSection === null && page.environment !== 'AVAILABLE' ? (
            <Notice kind="caution" heading={text.unavailableHeading}>
              <p data-testid="credential-unavailable" data-state={page.environment}>{environment.description}</p>
            </Notice>
          ) : null}
          {page.automatedLoginSetup !== null && removeSection === null && page.environment === 'AVAILABLE' && page.inUse ? (
            <Notice kind="caution" heading={text.inUseHeading}>
              <p data-testid="credential-in-use">{text.inUseBody}</p>
            </Notice>
          ) : null}
          {page.automatedLoginSetup !== null && removeSection === null && page.environment === 'AVAILABLE' && !page.inUse ? (
            <>
              <Notice kind="caution" heading={text.testAccountOnlyHeading}>
                <p data-testid="credential-test-account-only">{text.testAccountOnlyBody}</p>
                <p>{text.browserSaveNote}</p>
              </Notice>
              <AutomatedLoginSetupForm page={page} setup={page.automatedLoginSetup} onSaved={() => showDone('automatedLoginSetUp')} />
            </>
          ) : null}
          {/* T26g-2 round 1: 自動ログインでないプロファイルに残ったファイルは、削除の操作だけを出す。 */}
          {removeSection === null ? null : (
            <>
              <Notice kind="caution">
                <p data-testid="credential-leftover">{text.leftoverNotEligible}</p>
              </Notice>
              {page.inUse ? (
                <Notice kind="caution" heading={text.inUseHeading}>
                  <p data-testid="credential-in-use">{text.inUseBody}</p>
                </Notice>
              ) : null}
              {removeSection}
            </>
          )}
        </>
      ) : (
        <>
          <Notice kind="caution" heading={text.testAccountOnlyHeading}>
            <p data-testid="credential-test-account-only">{text.testAccountOnlyBody}</p>
            <p>{text.browserSaveNote}</p>
          </Notice>
          <CredentialStatus page={page} />
          {page.readError === null ? null : (
            <Notice kind="critical" heading={text.status.readFailedHeading}>
              <p data-testid="credential-read-error" data-reason={page.readError}>
                {CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[page.readError].description}
              </p>
              <p>{CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[page.readError].action}</p>
            </Notice>
          )}
          {active ? null : (
            <Notice kind="caution">
              <p data-testid="credential-retired">{text.retired}</p>
            </Notice>
          )}
          {active && page.environment !== 'AVAILABLE' ? (
            <Notice kind="caution" heading={text.unavailableHeading}>
              <p data-testid="credential-unavailable" data-state={page.environment}>{environment.description}</p>
            </Notice>
          ) : null}
          {active && page.environment === 'AVAILABLE' && page.currentLoginOrigin === null ? (
            <Notice kind="caution" heading={text.authSetupMissingHeading}>
              <p data-testid="credential-auth-setup-missing">{text.authSetupMissingBody}</p>
              <p>
                <Link to="/auth-setup/$profileId" params={{ profileId: profile.profileId }}>{text.openAuthSetup}</Link>
              </p>
            </Notice>
          ) : null}
          {page.inUse ? (
            <Notice kind="caution" heading={text.inUseHeading}>
              <p data-testid="credential-in-use">{text.inUseBody}</p>
            </Notice>
          ) : null}

          {savable && credential === null && page.readError === null ? (
            <section className="panel">
              <h2 className="panel-heading">{text.register.heading}</h2>
              <p>{text.register.body}</p>
              {rejection === null ? null : <RejectionNotice rejection={rejection} heading={text.rejectedHeading} />}
              <form
                className="form-grid"
                noValidate
                data-testid="credential-register-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const { username, password, passwordConfirmation } = values;
                  submit(() => register({ data: { profileId: profile.profileId, username, password, passwordConfirmation } }), 'registered', 'registered');
                }}
              >
                <CredentialValueField kind="username" label={text.username} name="username" hint={valueLengthHint}
                  value={values.username} errors={fieldErrors('username')} onChange={(value) => setValue('username', value)} />
                <CredentialValueField kind="password" label={text.password} name="password" hint={valueLengthHint}
                  value={values.password} errors={fieldErrors('password')} onChange={(value) => setValue('password', value)} />
                <CredentialValueField kind="password" label={text.passwordConfirmation} name="passwordConfirmation"
                  value={values.passwordConfirmation} errors={[]} onChange={(value) => setValue('passwordConfirmation', value)} />
                {submitButton(text.register.submit, text.register.submitting, 'credential-register-submit')}
              </form>
            </section>
          ) : null}

          {savable && credential !== null && !replaceNeeded ? (
            <section className="panel">
              <h2 className="panel-heading">{text.change.heading}</h2>
              {rejection === null ? null : <RejectionNotice rejection={rejection} heading={text.rejectedHeading} />}
              <form
                className="form-grid"
                noValidate
                data-testid="credential-change-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const { username, password, passwordConfirmation } = values;
                  submit(() => change({
                    data: {
                      profileId: profile.profileId,
                      username: changeUsername ? username : null,
                      password: changePassword ? password : null,
                      passwordConfirmation: changePassword ? passwordConfirmation : null,
                      clearHold: page.hold !== null && clearHold,
                    },
                  }), 'changed', 'changedAndHoldCleared');
                }}
              >
                <fieldset className="field">
                  <legend className="field-label">{text.change.legend}</legend>
                  <label className="choice">
                    <input type="checkbox" name="changeUsername" checked={changeUsername}
                      onChange={(event) => setChangeUsername(event.target.checked)} />
                    <span>{text.change.changeUsername}</span>
                  </label>
                  <label className="choice">
                    <input type="checkbox" name="changePassword" checked={changePassword}
                      onChange={(event) => setChangePassword(event.target.checked)} />
                    <span>{text.change.changePassword}</span>
                  </label>
                  <p className="field-hint">{text.change.unchangedNote}</p>
                </fieldset>
                {changeUsername ? (
                  <CredentialValueField kind="username" label={text.change.newUsername} name="username" hint={valueLengthHint}
                    value={values.username} errors={fieldErrors('username')} onChange={(value) => setValue('username', value)} />
                ) : null}
                {changePassword ? (
                  <>
                    <CredentialValueField kind="password" label={text.change.newPassword} name="password" hint={valueLengthHint}
                      value={values.password} errors={fieldErrors('password')} onChange={(value) => setValue('password', value)} />
                    <CredentialValueField kind="password" label={text.change.newPasswordConfirmation} name="passwordConfirmation"
                      value={values.passwordConfirmation} errors={[]} onChange={(value) => setValue('passwordConfirmation', value)} />
                  </>
                ) : null}
                {clearHoldChoice}
                {submitButton(text.change.submit, text.change.submitting, 'credential-change-submit')}
              </form>
            </section>
          ) : null}

          {savable && replaceNeeded ? (
            <section className="panel">
              <h2 className="panel-heading">{text.replace.heading}</h2>
              <p data-testid="credential-replace-needed">{text.replace.body}</p>
              {rejection === null ? null : <RejectionNotice rejection={rejection} heading={text.rejectedHeading} />}
              <form
                className="form-grid"
                noValidate
                data-testid="credential-replace-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const { username, password, passwordConfirmation } = values;
                  submit(() => replace({
                    data: { profileId: profile.profileId, username, password, passwordConfirmation, clearHold: page.hold !== null && clearHold },
                  }), 'replaced', 'replacedAndHoldCleared');
                }}
              >
                <CredentialValueField kind="username" label={text.username} name="username" hint={valueLengthHint}
                  value={values.username} errors={fieldErrors('username')} onChange={(value) => setValue('username', value)} />
                <CredentialValueField kind="password" label={text.password} name="password" hint={valueLengthHint}
                  value={values.password} errors={fieldErrors('password')} onChange={(value) => setValue('password', value)} />
                <CredentialValueField kind="password" label={text.passwordConfirmation} name="passwordConfirmation"
                  value={values.passwordConfirmation} errors={[]} onChange={(value) => setValue('passwordConfirmation', value)} />
                {clearHoldChoice}
                {submitButton(text.replace.submit, text.replace.submitting, 'credential-replace-submit')}
              </form>
            </section>
          ) : null}

          {removeSection}
        </>
      )}
      <div className="button-row">
        {page.eligible && active ? (
          <Link to="/login-check/$profileId" params={{ profileId: profile.profileId }} className="button">
            {LOCAL_UI_LOGIN_CHECK_TEXT.pages.loginCheck}
          </Link>
        ) : null}
        <Link to="/profiles/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToProfile}</Link>
      </div>
    </PageFrame>
  );
}

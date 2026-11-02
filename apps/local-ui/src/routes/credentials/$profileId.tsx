import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  AUTO_LOGIN_DAILY_MAX_ATTEMPTS,
  AUTO_LOGIN_DAILY_WINDOW_MS,
  AUTO_LOGIN_MIN_INTERVAL_MS,
} from '../../../../../src/control/job/auto-login-limits.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../../src/control/store/profile-records.js';
import { formatElapsedTime, formatInteger, formatTimes } from '../../../../../src/presentation/format.js';
import {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
} from '../../../../../src/presentation/messages.js';
import { AdvancedSettings } from '../../components/AdvancedSettings';
import { AutomatedLoginSetupForm, automatedLoginSetUpSearch } from '../../components/AutomatedLoginSetupForm';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CredentialValueField } from '../../components/CredentialValueField';
import { ProfileActionLink } from '../../components/NextSteps';
import { Notice } from '../../components/Notice';
import { PageFrame, siteTrail } from '../../components/PageFrame';
import { automatedLoginResultDisplay, credentialEnvironmentDisplay, usesAuthSetup } from '../../display/labels';
import { closedSearchValueOf, isClosedSearchValue } from '../../display/search-values';
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

/**
 * 保存の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。PL-4: 自動ログインにした後は、点検の開始の画面へ移すので、この画面の知らせはない
 * （前の `automatedLoginSetUp` は消した）。
 */
const DONE_NOTICES = Object.freeze([
  'registered', 'changed', 'replaced', 'removed', 'changedAndHoldCleared', 'replacedAndHoldCleared',
] as const);
type DoneNotice = (typeof DONE_NOTICES)[number];
const isDoneNotice = (value: unknown): value is DoneNotice => isClosedSearchValue(DONE_NOTICES, value);

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
});

/**
 * 自動ログインの上限の説明（ログインの確かめの画面と同じ文言と、上限の名前つきの定数）。PL-4: 止めているときに、要点に出す（なぜすぐに再開しないか）。
 * 時間は `formatElapsedTime`（分・日。秒の表示はしない）。
 */
const LOGIN_CHECK_LIMIT_NOTE = LOCAL_UI_LOGIN_CHECK_TEXT.limitNote(
  formatElapsedTime(AUTO_LOGIN_MIN_INTERVAL_MS),
  formatElapsedTime(AUTO_LOGIN_DAILY_WINDOW_MS),
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

/** テスト用のアカウントだけを入れることと、ブラウザに保存させないこと（入力の欄があるときだけ。設計書 7 章）。 */
function TestAccountOnlyNotice() {
  return (
    <Notice kind="caution" heading={text.testAccountOnlyHeading}>
      <p data-testid="credential-test-account-only">{text.testAccountOnlyBody}</p>
      <p>{text.browserSaveNote}</p>
    </Notice>
  );
}

/**
 * PL-4: 要点の、保存の状態の行（値は出さない）。保存してあれば、保存の場所とログインする先（ホストだけ）。止めていれば、理由と、人がすることと、回数の決まり。
 * 日時・改訂・Origin・暗号化の行は出さない（設計書 3 章の 2。記録は管理データにある）。
 */
function CredentialSummaryLines({ page }: Readonly<{ page: CredentialPageView }>) {
  const { credential, hold } = page;
  return (
    <>
      {credential === null ? (
        page.readError === null ? <p data-testid="credential-saved" data-saved="no">{text.summary.notSaved}</p> : null
      ) : (
        <>
          <p data-testid="credential-saved" data-saved="yes">{text.summary.saved}</p>
          {page.loginHost === null ? null : <p data-testid="credential-destination">{text.summary.destination(page.loginHost)}</p>}
        </>
      )}
      {hold === null ? null : (
        <Notice kind="caution">
          <p data-testid="credential-hold" data-held="yes" data-reason={hold.reason}>{text.summary.held(automatedLoginResultDisplay(hold.reason).label)}</p>
          <p>{AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS[hold.reason].action}</p>
          <p>{LOGIN_CHECK_LIMIT_NOTE}</p>
        </Notice>
      )}
    </>
  );
}

/** 資格情報の入力の値（画面の入力のまま。送った後に、すぐに空にする）。 */
interface ValueState {
  readonly username: string;
  readonly password: string;
  readonly passwordConfirmation: string;
}
const EMPTY_VALUES: ValueState = Object.freeze({ username: '', password: '', passwordConfirmation: '' });

/**
 * 資格情報の画面（Task 26 の設計書 4.2）。プロファイルの詳細から開く。値（ユーザー名を含む）は、一度も出さない。
 * PL-4（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1〜3、4 章の 3、6 章の 4）: 上から、要点のパネル（今の様子の行、入れる欄があるときは
 * その欄、主のボタン 1 つ）→ 詳しい内容 1 つ（`AdvancedSettings`。変える・削除）。
 * - 手でログインするサイト: 自動ログインにする欄（`AutomatedLoginSetupForm`）。確定で点検の開始の画面へ移る。ログインの設定がないときは「先に 1 回、手でログインして
 *   点検してください」と主のボタン「点検を始める」。公開の画面だけのサイトは、要らない旨だけ。残ったファイルがあれば、削除だけ。
 * - 自動ログインのサイト: 保存してあれば、保存の場所とログインする先、主のボタン「点検を始める」（止めているときは主のボタンを出さず、理由と停止を解く入口）。
 *   まだなければ、登録の 3 欄と主のボタン「登録する」。ログインする先が変わったときは、入れ直しの 3 欄。変える・削除は詳しい内容の中。ログインの確かめの画面への
 *   入口は、停止を解くときだけ（判断 1）。
 */
function CredentialPage() {
  const page = Route.useLoaderData();
  const { done: rawDone } = Route.useSearch();
  // MI-C2 項目 19: ルータは根の生の search も子へ渡すので、知らせの値は描く前に閉じた一覧でもう一度確かめる（`display/search-values.ts`）。
  const done = closedSearchValueOf(DONE_NOTICES, rawDone);
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
  /**
   * PL-4（設計書 6 章の 4）: 自動ログインにした後は、点検の開始の画面へ移す（移った印と、自動ログインにした印。開始の画面の route は search を受けないので、
   * 印は location の search のまま残り、`PageFrame` と移った先が直接読む。search の型の確かめだけを外して渡す）。
   */
  const showAudit = (): void => {
    const search = (): never => automatedLoginSetUpSearch as never;
    void navigate({ to: '/start/$profileId', params: { profileId: profile.profileId }, search });
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
    <div data-testid="credential-remove-section">
      {removeRejection === null ? null : <RejectionNotice rejection={removeRejection} heading={text.removeRejectedHeading} />}
      <div className="button-row">
        <button type="button" className="button button--danger" data-testid="credential-remove" onClick={() => setDialogOpen(true)}>
          {text.remove.open}
        </button>
      </div>
      <ConfirmDialog
        open={dialogOpen}
        title={text.remove.title}
        body={text.remove.body}
        confirmLabel={text.remove.confirm}
        cancelLabel={text.remove.cancel}
        confirmTone="danger"
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
    </div>
  );
  /** 送るボタン（要点の中の登録・入れ直しは主のボタン。詳しい内容の中の変更は二次のボタン。主のボタンは main に 1 つまで）。 */
  const submitButton = (label: string, busyLabel: string, testId: string, primary: boolean) => (
    <div className="button-row">
      <button type="submit" className={primary ? 'button button--primary' : 'button'} disabled={submitting} data-testid={testId}>
        {submitting ? busyLabel : label}
      </button>
    </div>
  );
  const doneNotice = done === undefined ? null : (
    <Notice kind="positive">
      {DONE_TEXT[done].map((line) => <p key={line} data-testid="credential-done" data-notice={done}>{line}</p>)}
    </Notice>
  );
  const inUseNotice = page.inUse ? (
    <Notice kind="caution" heading={text.inUseHeading}>
      <p data-testid="credential-in-use">{text.inUseBody}</p>
    </Notice>
  ) : null;
  const unavailableNotice = (
    <Notice kind="caution" heading={text.unavailableHeading}>
      <p data-testid="credential-unavailable" data-state={page.environment}>{environment.description}</p>
    </Notice>
  );

  if (!page.eligible) {
    // 手でログインするサイトと、公開の画面だけのサイト（要点のパネルだけ）。
    const setup = page.automatedLoginSetup;
    const manual = usesAuthSetup(profile.mode, profile.auth);
    return (
      <PageFrame title={text.pages.credentials} trail={siteTrail(profile.profileId)}>
        <section className="panel" data-testid="credential-summary">
          <h2 className="panel-heading">{LOCAL_UI_NEXT_STEP_TEXT.summaryHeading}</h2>
          {doneNotice}
          {removeSection !== null ? (
            // T26g-2 round 1: 自動ログインでないプロファイルに残ったファイルは、削除の操作だけを出す。
            <>
              <Notice kind="caution">
                <p data-testid="credential-leftover">{text.leftoverNotEligible}</p>
              </Notice>
              {inUseNotice}
              {removeSection}
            </>
          ) : !active ? (
            <p data-testid="credential-retired">{text.retired}</p>
          ) : setup !== null ? (
            // FM2e・PL-4: 1 回の操作で自動ログインにする欄（暗号化を使えない、ジョブが動いている間は出さない）。
            page.environment !== 'AVAILABLE' ? unavailableNotice
              : page.inUse ? inUseNotice
                : <AutomatedLoginSetupForm page={page} setup={setup} onSaved={showAudit} />
          ) : (
            // PL-4（作業記録 UX-1 の画面 C の S4）: 手でログインするサイトでログインの設定がまだないときは、先に手でログインする点検へ。公開の画面だけのサイトは文だけ。
            <>
              <p data-testid="credential-not-eligible" data-kind={manual ? 'MANUAL' : 'PUBLIC'}>{manual ? text.notEligibleManual : text.notEligiblePublic}</p>
              {manual ? (
                <div className="button-row">
                  <ProfileActionLink action="AUDIT_START" profileId={profile.profileId} primary />
                </div>
              ) : null}
            </>
          )}
        </section>
      </PageFrame>
    );
  }

  /** 要点に出す入力の欄（登録か入れ直し）。 */
  const registerForm = savable && credential === null && page.readError === null ? (
    <>
      <TestAccountOnlyNotice />
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
        {submitButton(text.register.submit, text.register.submitting, 'credential-register-submit', true)}
      </form>
    </>
  ) : null;
  const replaceForm = savable && replaceNeeded ? (
    <>
      <p data-testid="credential-replace-needed">{text.replace.body}</p>
      <TestAccountOnlyNotice />
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
        {submitButton(text.replace.submit, text.replace.submitting, 'credential-replace-submit', true)}
      </form>
    </>
  ) : null;
  /** 詳しい内容の、変える欄（保存してあって、入れ直しが要らないとき）。 */
  const changeForm = savable && credential !== null && !replaceNeeded ? (
    <section className="panel">
      <h2 className="panel-heading">{text.change.heading}</h2>
      <TestAccountOnlyNotice />
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
        {submitButton(text.change.submit, text.change.submitting, 'credential-change-submit', false)}
      </form>
    </section>
  ) : null;
  // 削除は、ほかにすることがないとき（読めない・取り消した）は要点に、ふだんは詳しい内容に出す。
  const removeInSummary = page.readError !== null || !active;
  // 要点のボタン: 保存してあって使えるときは「点検を始める」（主）。止めているときは主のボタンを出さず、停止を解く入口（ログインの確かめの画面）を二次で。
  const ready = credential !== null && !replaceNeeded && active && page.readError === null && page.environment === 'AVAILABLE'
    && page.currentLoginOrigin !== null && !page.inUse;

  return (
    <PageFrame title={text.pages.credentials} trail={siteTrail(profile.profileId)}>
      <section className="panel" data-testid="credential-summary">
        <h2 className="panel-heading">{LOCAL_UI_NEXT_STEP_TEXT.summaryHeading}</h2>
        {doneNotice}
        {page.readError === null ? null : (
          <Notice kind="critical" heading={text.status.readFailedHeading}>
            <p data-testid="credential-read-error" data-reason={page.readError}>
              {CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[page.readError].description}
            </p>
            <p>{CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[page.readError].action}</p>
          </Notice>
        )}
        {active ? null : <p data-testid="credential-retired">{text.retired}</p>}
        {active && page.environment !== 'AVAILABLE' ? unavailableNotice : null}
        {active && page.environment === 'AVAILABLE' && page.currentLoginOrigin === null ? (
          <Notice kind="caution" heading={text.authSetupMissingHeading}>
            <p data-testid="credential-auth-setup-missing">{text.authSetupMissingBody}</p>
            <p>
              <Link to="/auth-setup/$profileId" params={{ profileId: profile.profileId }}>{text.openAuthSetup}</Link>
            </p>
          </Notice>
        ) : null}
        {inUseNotice}
        <CredentialSummaryLines page={page} />
        {registerForm}
        {replaceForm}
        {removeInSummary ? removeSection : null}
        {ready ? (
          <div className="button-row" data-testid="credential-summary-actions">
            {page.hold === null
              ? <ProfileActionLink action="AUDIT_START" profileId={profile.profileId} primary />
              : <ProfileActionLink action="CLEAR_HOLD" profileId={profile.profileId} primary={false} />}
          </div>
        ) : null}
      </section>
      {changeForm === null && (removeInSummary || removeSection === null) ? null : (
        <section className="panel">
          <AdvancedSettings testId="credential-advanced-settings" openRequested={rejection !== null || removeRejection !== null}>
            {changeForm}
            {removeInSummary ? null : removeSection}
          </AdvancedSettings>
        </section>
      )}
    </PageFrame>
  );
}

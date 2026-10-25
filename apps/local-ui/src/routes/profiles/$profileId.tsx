import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { RETIRED_PROFILE_STATUS } from '../../../../../src/control/store/profile-records.js';
import { formatDateTime } from '../../../../../src/presentation/format.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_LEDGER_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
  PROFILE_STORE_REJECTION_DESCRIPTIONS,
} from '../../../../../src/presentation/messages.js';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EntryCheckPanel } from '../../components/EntryCheckPanel';
import { NextStepsPanel } from '../../components/NextSteps';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import { ProfileForm, formValuesOf, profileDocumentOf } from '../../components/ProfileForm';
import {
  auditModeDisplay,
  authSetupFreshnessDisplay,
  authStrategyDisplay,
  environmentDisplay,
  offersAutomatedLogin,
  profileStatusDisplay,
  toneClass,
  usesAuthSetup,
  usesAutomatedLogin,
  usesDiscovery,
  usesReadCheck,
  usesScenarios,
} from '../../display/labels';
import {
  getProfileFn,
  retireProfileFn,
  targetConfigCandidatesFn,
  updateProfileFn,
  type ProfileAuthSetupScopeView,
  type ProfileChangeView,
} from '../../server/profile-functions';
import { entryCheckSummaryFn } from '../../server/entry-check-functions';
import { profileOnboardingFn } from '../../server/profile-onboarding-functions';
import { LoginSetupPanel } from '../../components/LoginSetupPanel';
import { DisplaySettingsPanel } from '../../components/DisplaySettingsPanel';
import { profileDisplaySettingsFn } from '../../server/display-settings-functions';
import { CrawlLimitsPanel } from '../../components/CrawlLimitsPanel';
import { crawlLimitsPanelFn } from '../../server/crawl-limits-functions';
import { isSavedNoticeCurrent, savedRevisionOf } from '../../display/saved-notice';

/**
 * 保存の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。`retiredCredentialKept` は、取り消しは成功したが、保存した資格情報を消せなかった
 * とき（T26g-2、T26R の I1。資格情報の画面から消すよう案内する）。
 */
const SAVED_NOTICES = Object.freeze(['created', 'updated', 'retired', 'retiredCredentialKept'] as const);
type SavedNotice = (typeof SAVED_NOTICES)[number];

const isSavedNotice = (value: unknown): value is SavedNotice => SAVED_NOTICES.some((notice) => notice === value);

export const Route = createFileRoute('/profiles/$profileId')({
  // DEF-137: 保存した改訂（`savedRevision`）も受ける（知らせは、画面の改訂がそれに届いたときだけ出す）。
  validateSearch: (search: Record<string, unknown>): { saved?: SavedNotice; savedRevision?: number } => {
    const savedRevision = savedRevisionOf(search['savedRevision']);
    return isSavedNotice(search['saved']) ? { saved: search['saved'], ...(savedRevision === undefined ? {} : { savedRevision }) } : {};
  },
  loader: async ({ params }) => {
    const [detail, candidates, onboarding, entryCheck, displaySettings, crawlLimits] = await Promise.all([
      getProfileFn({ data: { profileId: params.profileId } }),
      targetConfigCandidatesFn(),
      profileOnboardingFn({ data: { profileId: params.profileId } }),
      entryCheckSummaryFn({ data: { profileId: params.profileId } }),
      // FM-1（手動の操作を減らす設計書 2.2）: 表示の設定（プロファイルの改訂とは別に持つ）。
      profileDisplaySettingsFn({ data: { profileId: params.profileId } }),
      // T44d（Task 44 の設計書 P2-1）: 監査の負荷（設定のファイルの値。変えると設定のファイルを書き換える）。
      crawlLimitsPanelFn({ data: { profileId: params.profileId } }),
    ]);
    if (detail === null || onboarding === null || entryCheck === null || crawlLimits === null) {
      throw notFound();
    }
    return { detail, candidates, onboarding, entryCheck, displaySettings, crawlLimits };
  },
  component: EditProfilePage,
});

const SAVED_TEXT: Readonly<Record<SavedNotice, string>> = Object.freeze({
  created: LOCAL_UI_TEXT.profileForm.created,
  updated: LOCAL_UI_TEXT.profileForm.updated,
  retired: LOCAL_UI_TEXT.retireDialog.done,
  retiredCredentialKept: LOCAL_UI_TEXT.retireDialog.done,
});

/** 前方一致のパスの一覧（空なら `emptyText`）。 */
function PathList({ paths, emptyText }: Readonly<{ paths: readonly string[]; emptyText: string }>) {
  return paths.length === 0 ? <>{emptyText}</> : (
    <ul className="word-list">
      {paths.map((path) => <li key={path}><code>{path}</code></li>)}
    </ul>
  );
}

/**
 * T44d（Task 44 の設計書 P2-2）: 認証の設定への入り口（「認証の設定を開く」）と、保存してある設定の読む範囲・読まないパス・新しさの要約（読むだけ。
 * 変えるのは認証の設定の画面）。保存していなければ、その旨を出す。
 */
function AuthSetupEntry({ profileId, scope }: Readonly<{ profileId: string; scope: ProfileAuthSetupScopeView | null }>) {
  const text = LOCAL_UI_AUTH_TEXT;
  const freshness = scope === null ? null : authSetupFreshnessDisplay(scope.freshness);
  return (
    <section className="panel" data-testid="profile-auth-setup">
      <h2 className="panel-heading">{text.profileDetail.heading}</h2>
      <p>{text.profileDetail.body}</p>
      {scope === null || freshness === null ? (
        <p data-testid="profile-auth-setup-summary" data-saved="no">{text.setup.notSaved}</p>
      ) : (
        <dl className="facts" data-testid="profile-auth-setup-summary" data-saved="yes">
          <dt>{text.start.auditScope}</dt>
          <dd className="cell-break" data-testid="profile-auth-setup-audit-scope">
            <PathList paths={scope.auditPathPrefixes} emptyText={text.start.auditScopeAll} />
          </dd>
          <dt>{text.profileDetail.excludedPaths}</dt>
          <dd className="cell-break" data-testid="profile-auth-setup-excluded">
            <PathList paths={scope.excludedPaths} emptyText={text.profileDetail.excludedPathsNone} />
          </dd>
          <dt>{text.setup.state}</dt>
          <dd><span className={toneClass(freshness.tone)}>{freshness.label}</span></dd>
        </dl>
      )}
      <p>
        <Link to="/auth-setup/$profileId" params={{ profileId }} className="button button--primary">
          {text.profileDetail.open}
        </Link>
      </p>
    </section>
  );
}

/** プロファイルの編集と取り消し（設計書 4.7）。 */
function EditProfilePage() {
  const { detail, candidates, onboarding, entryCheck, displaySettings, crawlLimits } = Route.useLoaderData();
  const search = Route.useSearch();
  // DEF-137: 保存の知らせは、画面の改訂が保存した改訂に届いたときだけ出す（改訂のない知らせは今のまま）。
  const saved = search.saved !== undefined && isSavedNoticeCurrent(search.savedRevision, detail.profile.revision) ? search.saved : undefined;
  const update = useServerFn(updateProfileFn);
  const retire = useServerFn(retireProfileFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [retireRejection, setRetireRejection] = useState<Extract<ProfileChangeView, { ok: false }> | null>(null);
  const { profile } = detail;
  const status = profileStatusDisplay(detail.status);
  const retired = detail.status === RETIRED_PROFILE_STATUS;
  const reload = (): void => {
    void router.invalidate();
  };
  const showSaved = (notice: SavedNotice, savedRevision?: number): void => {
    // 先に今の内容を読み直し（loader）、それから保存の知らせを出す（知らせと内容が食い違わないように）。DEF-137: 保存した改訂も載せ、画面の改訂がそれに
    // 届くまで知らせを出さない（ルータが読み直しを反映し終える前に、新しい search で一度描くことがあるため）。
    void router.invalidate().then(() => navigate({
      to: '/profiles/$profileId',
      params: { profileId: profile.profileId },
      search: { saved: notice, ...(savedRevision === undefined ? {} : { savedRevision }) },
      replace: true,
    }));
  };

  return (
    <PageFrame title={LOCAL_UI_TEXT.pages.editProfile}>
      {saved === undefined ? null : (
        <Notice kind="positive">
          <p>{SAVED_TEXT[saved]}</p>
        </Notice>
      )}
      {saved === 'retiredCredentialKept' ? (
        <Notice kind="caution">
          <p data-testid="profile-credential-not-removed">{LOCAL_UI_TEXT.retireDialog.credentialNotRemoved}</p>
          <p>
            <Link to="/credentials/$profileId" params={{ profileId: profile.profileId }}>{LOCAL_UI_CREDENTIAL_TEXT.profileDetail.open}</Link>
          </p>
        </Notice>
      ) : null}
      <section className="panel">
        <h2 className="panel-heading">{profile.profileId}</h2>
        <dl className="facts">
          <dt>{LOCAL_UI_TEXT.profileList.columns.status}</dt>
          <dd><span className={toneClass(status.tone)} data-testid="profile-status">{status.label}</span></dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.revision}</dt>
          <dd data-testid="profile-revision">{LOCAL_UI_TEXT.profileForm.revisionText(profile.revision)}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.updatedAt}</dt>
          <dd>{formatDateTime(detail.updatedAt)}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.environment}</dt>
          <dd>{environmentDisplay(profile.environment).label}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.mode}</dt>
          <dd>{auditModeDisplay(profile.mode).label}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.auth}</dt>
          <dd>{authStrategyDisplay(profile.auth).label}</dd>
        </dl>
      </section>

      {/* T44d（Task 44 の設計書 P2-2）: 認証の設定への入り口を、プロファイルの要点のすぐ後に置き、読む範囲と読まないパスの今の値の要約を近くに出す。 */}
      {!retired && usesAuthSetup(profile.mode, profile.auth) ? <AuthSetupEntry profileId={profile.profileId} scope={detail.authSetupScope} /> : null}

      {/* T43a（Task 43 の設計書 4.1）: 監査を始める（一覧の列のボタンは残す）。始められないときは、押せない形で、開始の画面と同じ確かめの理由を出す。 */}
      <section className="panel" data-testid="profile-audit-start">
        <h2 className="panel-heading">{LOCAL_UI_NEXT_STEP_TEXT.auditStart.heading}</h2>
        {onboarding.auditStartBlocker === null ? (
          <p>
            <Link to="/start/$profileId" params={{ profileId: profile.profileId }} className="button button--primary">
              {LOCAL_UI_AUDIT_TEXT.profileList.startAudit}
            </Link>
          </p>
        ) : (
          <>
            <p>
              <button type="button" className="button button--primary" disabled aria-describedby="profile-audit-start-reason">
                {LOCAL_UI_AUDIT_TEXT.profileList.startAudit}
              </button>
            </p>
            <div id="profile-audit-start-reason">
              <p>{LOCAL_UI_NEXT_STEP_TEXT.auditStart.unavailable}</p>
              <p data-testid="profile-audit-start-reason" data-reason={onboarding.auditStartBlocker}>
                {AUDIT_JOB_START_REJECTION_DESCRIPTIONS[onboarding.auditStartBlocker].description}
              </p>
              <p>{AUDIT_JOB_START_REJECTION_DESCRIPTIONS[onboarding.auditStartBlocker].action}</p>
            </div>
          </>
        )}
      </section>

      {/* T43a: 次にすること（取り消したプロファイルには出さない）。 */}
      {retired ? null : <NextStepsPanel profileId={profile.profileId} steps={onboarding.steps} />}

      {/* T43c（Task 43 の設計書 4.3）: 入口の確かめ（取り消したプロファイルには出さない。始められない理由は開始の確かめと同じ）。 */}
      {retired ? null : <EntryCheckPanel summary={entryCheck} />}

      {/* ML-b（手動のログインの設計書 2.3）: 手動のログインの成功から自動で登録した設定（見直して直す入口）。 */}
      {retired || detail.loginSetup === null ? null : <LoginSetupPanel
        profileId={detail.loginSetup.profileId}
        setup={detail.loginSetup}
        testId="profile-login-setup"
        offerAutomatedLogin={offersAutomatedLogin(profile.mode, profile.auth)}
      />}

      {/* FM-1（手動の操作を減らす設計書 2.2）: 表示の設定（ジョブのブラウザを表示する。プロファイルの改訂とは別に持つ）。 */}
      <DisplaySettingsPanel profileId={profile.profileId} settings={displaySettings} editable={!retired} />

      {/* T44d（Task 44 の設計書 P2-1）: 監査の負荷（ページの上限・時間の上限・読み込みの間隔。取り消したプロファイルには出さない）。 */}
      {retired ? null : <CrawlLimitsPanel view={crawlLimits} />}

      {/* T27f（Task 27 の設計書 4.7）: 操作の候補と READ の確かめを使うプロファイルだけ、その画面へのリンクを出す（取り消したプロファイルでも、
          記録は見られる。始める・作るは、それぞれの画面が止める）。T28b: 判定は `execution-policy.ts` の `DISCOVERY`・`READ_CHECK` の行（認証つきの
          読み取りの監査と、書き込みのモード）。 */}
      {usesDiscovery(profile.mode, profile.auth) || usesReadCheck(profile.mode, profile.auth) ? (
        <section className="panel" data-testid="profile-discovery">
          <h2 className="panel-heading">{LOCAL_UI_DISCOVERY_TEXT.profileDetail.heading}</h2>
          <p>{LOCAL_UI_DISCOVERY_TEXT.profileDetail.body}</p>
          <div className="button-row">
            <Link to="/discovery/$profileId" params={{ profileId: profile.profileId }} className="button button--primary">
              {LOCAL_UI_DISCOVERY_TEXT.profileDetail.openDiscovery}
            </Link>
            <Link to="/read-checks/$profileId" params={{ profileId: profile.profileId }} className="button">
              {LOCAL_UI_DISCOVERY_TEXT.profileDetail.openReadChecks}
            </Link>
          </div>
        </section>
      ) : null}

      {/* T28e（Task 28 の設計書 4.6）: 書き込みのシナリオを使うプロファイル（`usesScenarios`。`execution-policy.ts` の `SCENARIO` の行）だけ、シナリオの一覧への
          リンクを出す（取り消したプロファイルでも、記録は見られる。作る・変える・承認するは、シナリオの画面とサーバが止める）。 */}
      {usesScenarios(profile.mode, profile.auth) ? (
        <section className="panel" data-testid="profile-scenarios">
          <h2 className="panel-heading">{LOCAL_UI_SCENARIO_TEXT.profileDetail.heading}</h2>
          <p>{LOCAL_UI_SCENARIO_TEXT.profileDetail.body}</p>
          <div className="button-row">
            <Link to="/scenarios/$profileId" params={{ profileId: profile.profileId }} className="button button--primary">
              {LOCAL_UI_SCENARIO_TEXT.profileDetail.open}
            </Link>
            {/* T32g（Task 32 の設計書 4.1）: 監査済みデータの台帳（書き込みのモードのプロファイルだけ。読むだけ）。 */}
            <Link to="/ledger/$profileId" params={{ profileId: profile.profileId }} className="button" data-testid="profile-open-ledger">
              {LOCAL_UI_LEDGER_TEXT.profileDetail.open}
            </Link>
          </div>
        </section>
      ) : null}

      {usesAutomatedLogin(profile.mode, profile.auth) ? (
        <section className="panel" data-testid="profile-credentials">
          <h2 className="panel-heading">{LOCAL_UI_CREDENTIAL_TEXT.profileDetail.heading}</h2>
          <p>{LOCAL_UI_CREDENTIAL_TEXT.profileDetail.body}</p>
          <div className="button-row">
            <Link to="/credentials/$profileId" params={{ profileId: profile.profileId }} className="button button--primary">
              {LOCAL_UI_CREDENTIAL_TEXT.profileDetail.open}
            </Link>
            {retired ? null : (
              <Link to="/login-check/$profileId" params={{ profileId: profile.profileId }} className="button">
                {LOCAL_UI_LOGIN_CHECK_TEXT.profileList.loginCheck}
              </Link>
            )}
          </div>
        </section>
      ) : null}

      {/* T26g-3: 自動ログインでないプロファイルでも、資格情報のファイルが残っていれば（判定はサーバ）、資格情報の画面へのリンクを出す。 */}
      {!usesAutomatedLogin(profile.mode, profile.auth) && detail.credentialRemains ? (
        <Notice kind="caution">
          <div data-testid="profile-credential-leftover">
            <p>{LOCAL_UI_CREDENTIAL_TEXT.profileDetail.leftover}</p>
            <p>
              <Link to="/credentials/$profileId" params={{ profileId: profile.profileId }}>{LOCAL_UI_CREDENTIAL_TEXT.profileDetail.open}</Link>
            </p>
          </div>
        </Notice>
      ) : null}

      {retired ? (
        <Notice kind="caution">
          <p>{LOCAL_UI_TEXT.profileForm.retiredNotice}</p>
        </Notice>
      ) : (
        <>
          <section className="panel">
            <ProfileForm
              key={`${profile.profileId}:${profile.revision}`}
              kind="edit"
              initialValues={formValuesOf(profile)}
              targetConfigCandidates={candidates}
              onSave={(values) => update({ data: { profile: profileDocumentOf(values, profile.revision + 1), expectedRevision: profile.revision } })}
              onSaved={(result) => showSaved('updated', result.detail.profile.revision)}
              onReload={reload}
            />
          </section>
          <section className="panel">
            {retireRejection === null ? null : (
              <Notice kind="critical" heading={LOCAL_UI_TEXT.profileForm.rejectedHeading}>
                <p>{PROFILE_STORE_REJECTION_DESCRIPTIONS[retireRejection.reason].description}</p>
                <p>{PROFILE_STORE_REJECTION_DESCRIPTIONS[retireRejection.reason].action}</p>
                <div className="button-row">
                  <button type="button" className="button" onClick={reload}>{LOCAL_UI_TEXT.reload}</button>
                </div>
              </Notice>
            )}
            <button type="button" className="button button--danger" onClick={() => setDialogOpen(true)}>
              {LOCAL_UI_TEXT.retireDialog.open}
            </button>
          </section>
          <ConfirmDialog
            open={dialogOpen}
            title={LOCAL_UI_TEXT.retireDialog.title}
            body={LOCAL_UI_TEXT.retireDialog.body}
            confirmLabel={LOCAL_UI_TEXT.retireDialog.confirm}
            cancelLabel={LOCAL_UI_TEXT.retireDialog.cancel}
            busy={retiring}
            onCancel={() => setDialogOpen(false)}
            onConfirm={() => {
              setRetiring(true);
              void retire({ data: { profileId: profile.profileId, expectedRevision: profile.revision } })
                .then((result) => {
                  setDialogOpen(false);
                  if (result.ok) {
                    setRetireRejection(null);
                    // 取り消しは成功のまま。資格情報を消せなかったときだけ、資格情報の画面から消すよう案内する。
                    showSaved(result.credentialCleanup === 'FAILED' ? 'retiredCredentialKept' : 'retired');
                  } else {
                    setRetireRejection(result);
                  }
                })
                .finally(() => setRetiring(false));
            }}
          />
        </>
      )}
      <p>
        <Link to="/" className="button">{LOCAL_UI_TEXT.backToList}</Link>
      </p>
    </PageFrame>
  );
}

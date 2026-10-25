import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { SCRIPT_REQUEST_TRANSPORT } from '../../../../../src/control/auth/auth-setup-contracts.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../../src/control/store/profile-records.js';
// PRE42-CC 組 UI-K2（CC-113）: 認証の設定の新しさの値は、純粋な core の owner から読む（文字列で比べない）。
import { STALE_AUTH_SETUP_FRESHNESS } from '../../../../../src/core/auth-setup-freshness.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../../../../src/core/default-excluded-url-words.js';
import { formatDateTime } from '../../../../../src/presentation/format.js';
import {
  approvedServiceOriginsToAdd,
  parseObservedAuthSetupDraft,
  type ObservedAuthSetupDraft,
} from '../../../../../src/control/login-observation-draft.js';
import {
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_ENTRY_CHECK_TEXT,
  LOCAL_UI_LOGIN_OBSERVATION_TEXT,
  LOCAL_UI_SCRIPT_LOGIN_TEXT,
  LOCAL_UI_TEXT,
} from '../../../../../src/presentation/messages.js';
import { AuthSetupForm, authSetupDocumentOf, authSetupFormValuesOf } from '../../components/AuthSetupForm';
import { serviceOriginSourcesOf } from '../../display/entry-check-draft';
import { EntryCheckPanel } from '../../components/EntryCheckPanel';
import { NextStepLinks } from '../../components/NextSteps';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import {
  auditModeDisplay,
  authSetupFreshnessDisplay,
  authStrategyDisplay,
  profileStatusDisplay,
  toneClass,
  usesAutomatedLogin,
} from '../../display/labels';
import { scriptLoginNoticesOf } from '../../display/script-login-notices';
import { getAuthSetupFn, saveAuthSetupFn, saveAuthSetupWithServiceOriginsFn } from '../../server/auth-setup-functions';
import { entryCheckSummaryFn } from '../../server/entry-check-functions';

/** 保存の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。 */
const SAVED_NOTICE = 'saved';
/**
 * 画面の search。T43d（Task 43 の設計書 4.4）: ジョブの詳細の「登録する」「案を認証の設定に入れる」の下書き（`draft`。サーバに保存しない形。値は
 * Origin・path・method・必須の query・鍵の名前・CSS だけ）。URL の値は信用せず、画面で毎回 `parseObservedAuthSetupDraft` で確かめ、合わなければ
 * 下書きなしにして知らせる（router は、確かめた search に入れなかった URL の値も渡しうるため、型は下書きでも中身は確かめ直す）。
 */
interface AuthSetupSearch {
  readonly saved?: typeof SAVED_NOTICE;
  readonly draft?: ObservedAuthSetupDraft;
}

export const Route = createFileRoute('/auth-setup/$profileId')({
  validateSearch: (search: Record<string, unknown>): AuthSetupSearch => {
    const draft = search['draft'] === undefined ? null : parseObservedAuthSetupDraft(search['draft']);
    return {
      ...(search['saved'] === SAVED_NOTICE ? { saved: SAVED_NOTICE } : {}),
      ...(draft === null ? {} : { draft }),
    };
  },
  loader: async ({ params }) => {
    const [page, entryCheck] = await Promise.all([
      getAuthSetupFn({ data: { profileId: params.profileId } }),
      entryCheckSummaryFn({ data: { profileId: params.profileId } }),
    ]);
    if (page === null || entryCheck === null) {
      throw notFound();
    }
    return { ...page, entryCheck };
  },
  component: AuthSetupPage,
});

/** 認証の設定（Task 25 の設計書 4.1、4.5、4.6）。プロファイルの詳細から開く。認証の設定を使うプロファイルだけ、フォームを出す。 */
function AuthSetupPage() {
  const page = Route.useLoaderData();
  const { saved, draft: rawDraft } = Route.useSearch();
  // T43d: URL の下書きを確かめ直す（合わなければ下書きなし）。
  const checkedDraft = rawDraft === undefined ? undefined : parseObservedAuthSetupDraft(rawDraft);
  const observedDraft = checkedDraft ?? undefined;
  const draftInvalid = checkedDraft === null;
  const save = useServerFn(saveAuthSetupFn);
  const saveWithServiceOrigins = useServerFn(saveAuthSetupWithServiceOriginsFn);
  const navigate = useNavigate();
  const router = useRouter();
  const text = LOCAL_UI_AUTH_TEXT.setup;
  const { profile, stored } = page;
  const status = profileStatusDisplay(profile.status);
  const freshness = stored === null ? null : authSetupFreshnessDisplay(stored.freshness);
  const editable = page.eligible && profile.status === ACTIVE_PROFILE_STATUS;
  // T26e: 認証の方式が自動ログインのプロファイルは、自動ログインの欄を出し、回数を固定にする。
  const automated = usesAutomatedLogin(profile.mode, profile.auth);
  // T43c（Task 43 の設計書 4.3）: 新しい認証の設定（保存した設定がない）なら、最後の成功した入口の確かめの案を欄に埋める（保存は利用者）。
  const entryLatest = page.entryCheck.latest;
  const entryProposal = stored === null ? entryLatest?.result?.proposal ?? null : null;
  // T44h の判断 (2): 入口の確かめの案の送り方がスクリプトで送るときの文（手動のログインのプロファイルは、自動の登録に合わせた文）。
  const entryScriptNotice = scriptLoginNoticesOf({
    automated,
    serviceOriginCount: profile.approvedServiceOrigins.length,
    entryProposalScript: entryProposal?.loginTransport === SCRIPT_REQUEST_TRANSPORT,
  }).entryCheckScript;
  // T43d: 下書きを保存するために、プロファイルの承認したサービスの Origin に足す Origin の見込み（知らせと欄の選択肢。保存の時点では欄の値から決め直す。
  // T43R-fix の M-3）。
  const addServiceOrigins = observedDraft === undefined ? [] : approvedServiceOriginsToAdd(observedDraft, profile);
  const textObserved = LOCAL_UI_LOGIN_OBSERVATION_TEXT;
  const reload = (): void => {
    void router.invalidate();
  };
  const showSaved = (): void => {
    // 先に今の内容を読み直し（loader）、それから保存の知らせを出す（知らせと内容が食い違わないように）。
    void router.invalidate().then(() =>
      navigate({ to: '/auth-setup/$profileId', params: { profileId: profile.profileId }, search: { saved: SAVED_NOTICE }, replace: true }));
  };

  return (
    <PageFrame title={LOCAL_UI_AUTH_TEXT.pages.authSetup}>
      {saved === undefined ? null : (
        <Notice kind="positive">
          <p data-testid="auth-setup-saved">{text.saved}</p>
        </Notice>
      )}
      {/* T43a（Task 43 の設計書 4.1）: 保存の後に、次の手順（自動ログインなら資格情報、手動のログインなら監査の開始）と「次にすること」へのリンク。 */}
      {saved === undefined || !editable ? null : (
        <NextStepLinks profileId={profile.profileId} after="AUTH_SETUP" mode={profile.mode} auth={profile.auth} />
      )}
      <section className="panel">
        <h2 className="panel-heading">{text.profileHeading}</h2>
        <dl className="facts" data-testid="auth-setup-profile">
          <dt>{LOCAL_UI_TEXT.profileList.columns.profileId}</dt>
          <dd>
            <Link to="/profiles/$profileId" params={{ profileId: profile.profileId }}>{profile.profileId}</Link>
          </dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.revision}</dt>
          <dd>{LOCAL_UI_TEXT.profileForm.revisionText(profile.revision)}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.mode}</dt>
          <dd>{auditModeDisplay(profile.mode).label}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.auth}</dt>
          <dd>{authStrategyDisplay(profile.auth).label}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.status}</dt>
          <dd><span className={toneClass(status.tone)}>{status.label}</span></dd>
          <dt>{text.approvedTestOrigins}</dt>
          <dd className="cell-break">
            <ul className="word-list">
              {profile.approvedTestOrigins.map((origin) => <li key={origin}><code>{origin}</code></li>)}
            </ul>
          </dd>
          {/* T34d: 承認したサービスの Origin（スクリプトで送るログインの token の送信先の選択肢）。 */}
          <dt>{LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.approvedServiceOrigins}</dt>
          <dd className="cell-break" data-testid="auth-setup-service-origins">
            {profile.approvedServiceOrigins.length === 0 ? LOCAL_UI_SCRIPT_LOGIN_TEXT.setup.noServiceOrigins : (
              <ul className="word-list">
                {profile.approvedServiceOrigins.map((origin) => <li key={origin}><code>{origin}</code></li>)}
              </ul>
            )}
          </dd>
          <dt>{text.state}</dt>
          <dd>
            {freshness === null || stored === null ? (
              <span data-testid="auth-setup-freshness" data-freshness="NONE">{text.notSaved}</span>
            ) : (
              <span className={toneClass(freshness.tone)} data-testid="auth-setup-freshness" data-freshness={stored.freshness}>{freshness.label}</span>
            )}
          </dd>
          {stored === null ? null : (
            <>
              <dt>{text.updatedAt}</dt>
              <dd>{formatDateTime(stored.updatedAt)}</dd>
            </>
          )}
        </dl>
      </section>

      {!page.eligible ? (
        <Notice kind="caution">
          <p data-testid="auth-setup-not-eligible">{text.notEligible}</p>
        </Notice>
      ) : profile.status !== ACTIVE_PROFILE_STATUS ? (
        <Notice kind="caution">
          <p data-testid="auth-setup-retired">{text.retired}</p>
        </Notice>
      ) : null}

      {editable && stored !== null && stored.freshness === STALE_AUTH_SETUP_FRESHNESS ? (
        <Notice kind="caution" heading={text.staleHeading}>
          <p data-testid="auth-setup-stale">{text.staleBody}</p>
        </Notice>
      ) : null}

      {editable ? (
        <>
          <Notice kind="caution" heading={text.noSecretHeading}>
            <p data-testid="auth-setup-no-secret">{automated ? text.noSecretBodyAutomated : text.noSecretBody}</p>
          </Notice>
          <section className="panel">
            <h2 className="panel-heading">{text.formHeading}</h2>
            {/* T43b（Task 43 の設計書 4.2）: 新しい認証の設定で、開始の URL の path から案を埋めたことを示す（保存するまでは案）。 */}
            {stored === null && page.startUrlPath !== null ? (
              <p className="field-hint" data-testid="auth-setup-start-url-draft">{text.startUrlDraftNotice(page.startUrlPath)}</p>
            ) : null}
            {entryProposal === null || entryLatest === null ? null : (
              <Notice kind="caution">
                <p data-testid="auth-setup-entry-check-draft" data-job-id={entryLatest.jobId}>
                  {LOCAL_UI_ENTRY_CHECK_TEXT.authSetup.proposalNotice(entryLatest.finishedAt === null ? '' : formatDateTime(entryLatest.finishedAt))}
                </p>
                {/* T44h の判断 (2): 手動のログインのプロファイルでは、送信先は自動の登録が埋める旨の文（`scriptLoginNoticesOf`）。 */}
                {entryScriptNotice === null ? null : <p data-testid="auth-setup-entry-check-script">{entryScriptNotice}</p>}
              </Notice>
            )}
            {draftInvalid === true ? (
              <Notice kind="caution">
                <p data-testid="auth-setup-observed-draft-invalid">{textObserved.draftInvalid}</p>
              </Notice>
            ) : null}
            {observedDraft === undefined ? null : (
              <Notice kind="caution" heading={textObserved.draftHeading}>
                <p data-testid="auth-setup-observed-draft">{textObserved.draftBody}</p>
                {addServiceOrigins.length === 0 ? null : (
                  <>
                    <p>{textObserved.draftServiceOrigins}</p>
                    <ul className="word-list" data-testid="auth-setup-observed-service-origins">
                      {addServiceOrigins.map((origin) => <li key={origin}><code>{origin}</code></li>)}
                    </ul>
                  </>
                )}
              </Notice>
            )}
            <AuthSetupForm
              key={`${profile.profileId}:${profile.revision}:${stored?.updatedAt ?? ''}:${entryLatest?.jobId ?? ''}:${JSON.stringify(observedDraft ?? null)}`}
              initialValues={authSetupFormValuesOf(stored?.setup ?? null, automated, page.startUrlPath, entryProposal, observedDraft ?? null)}
              automated={automated}
              testOrigins={profile.approvedTestOrigins}
              serviceOrigins={[...profile.approvedServiceOrigins, ...addServiceOrigins]}
              onSave={(values) => {
                // T43R-fix の M-3: 足す Origin は、保存の時点の欄の値（token の送信先とログインに伴う送信の Origin）から決め直す（下書きのある画面だけ）。
                const toAdd = observedDraft === undefined ? [] : approvedServiceOriginsToAdd(serviceOriginSourcesOf(values), profile);
                return toAdd.length === 0
                  ? save({ data: { setup: authSetupDocumentOf(values, profile.profileId, profile.revision, automated) } })
                  // T43d: プロファイルの次の改訂（Origin を足したもの）に結びつけて、1 回で保存する（画面が読んだ改訂の照合は保つ）。
                  : saveWithServiceOrigins({
                    data: {
                      setup: authSetupDocumentOf(values, profile.profileId, profile.revision + 1, automated),
                      expectedRevision: profile.revision,
                      addServiceOrigins: [...toAdd],
                    },
                  });
              }}
              onSaved={showSaved}
              onReload={reload}
            />
          </section>
          {/* T43c: 入口の確かめ（開始の URL を 1 回読み、この画面の案を作る）。 */}
          <EntryCheckPanel summary={page.entryCheck} />
          <section className="panel">
            <h2 className="panel-heading">{text.defaultExcludedHeading}</h2>
            <p>{text.defaultExcludedBody}</p>
            <ul className="word-list" data-testid="auth-setup-default-excluded">
              {DEFAULT_EXCLUDED_URL_WORDS.map((word) => <li key={word}><code>{word}</code></li>)}
            </ul>
          </section>
        </>
      ) : null}
      <p>
        <Link to="/profiles/$profileId" params={{ profileId: profile.profileId }} className="button">{text.backToProfile}</Link>
      </p>
    </PageFrame>
  );
}

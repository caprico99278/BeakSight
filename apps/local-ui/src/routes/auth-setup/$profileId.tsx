import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../../../../src/control/auth/auth-setup-contracts.js';
import { formatDateTime } from '../../../../../src/presentation/format.js';
import { LOCAL_UI_AUTH_TEXT, LOCAL_UI_TEXT } from '../../../../../src/presentation/messages.js';
import { AuthSetupForm, authSetupDocumentOf, authSetupFormValuesOf } from '../../components/AuthSetupForm';
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
import { getAuthSetupFn, saveAuthSetupFn } from '../../server/auth-setup-functions';

/** 保存の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。 */
const SAVED_NOTICE = 'saved';

export const Route = createFileRoute('/auth-setup/$profileId')({
  validateSearch: (search: Record<string, unknown>): { saved?: typeof SAVED_NOTICE } =>
    search['saved'] === SAVED_NOTICE ? { saved: SAVED_NOTICE } : {},
  loader: async ({ params }) => {
    const page = await getAuthSetupFn({ data: { profileId: params.profileId } });
    if (page === null) {
      throw notFound();
    }
    return page;
  },
  component: AuthSetupPage,
});

/** 認証の設定（Task 25 の設計書 4.1、4.5、4.6）。プロファイルの詳細から開く。認証の設定を使うプロファイルだけ、フォームを出す。 */
function AuthSetupPage() {
  const page = Route.useLoaderData();
  const { saved } = Route.useSearch();
  const save = useServerFn(saveAuthSetupFn);
  const navigate = useNavigate();
  const router = useRouter();
  const text = LOCAL_UI_AUTH_TEXT.setup;
  const { profile, stored } = page;
  const status = profileStatusDisplay(profile.status);
  const freshness = stored === null ? null : authSetupFreshnessDisplay(stored.freshness);
  const editable = page.eligible && profile.status === 'ACTIVE';
  // T26e: 認証の方式が自動ログインのプロファイルは、自動ログインの欄を出し、回数を固定にする。
  const automated = usesAutomatedLogin(profile.mode, profile.auth);
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
      ) : profile.status !== 'ACTIVE' ? (
        <Notice kind="caution">
          <p data-testid="auth-setup-retired">{text.retired}</p>
        </Notice>
      ) : null}

      {editable && stored !== null && stored.freshness === 'STALE' ? (
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
            <AuthSetupForm
              key={`${profile.profileId}:${profile.revision}:${stored?.updatedAt ?? ''}`}
              initialValues={authSetupFormValuesOf(stored?.setup ?? null, automated)}
              automated={automated}
              onSave={(values) => save({ data: { setup: authSetupDocumentOf(values, profile.profileId, profile.revision, automated) } })}
              onSaved={showSaved}
              onReload={reload}
            />
          </section>
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

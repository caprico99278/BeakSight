import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatDateTime } from '../../../../../src/presentation/format.js';
import {
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_LEDGER_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_TEXT,
  PROFILE_STORE_REJECTION_DESCRIPTIONS,
} from '../../../../../src/presentation/messages.js';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import { ProfileForm, formValuesOf, profileDocumentOf } from '../../components/ProfileForm';
import {
  auditModeDisplay,
  authStrategyDisplay,
  environmentDisplay,
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
  type ProfileChangeView,
} from '../../server/profile-functions';

/**
 * 保存の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。`retiredCredentialKept` は、取り消しは成功したが、保存した資格情報を消せなかった
 * とき（T26g-2、T26R の I1。資格情報の画面から消すよう案内する）。
 */
const SAVED_NOTICES = Object.freeze(['created', 'updated', 'retired', 'retiredCredentialKept'] as const);
type SavedNotice = (typeof SAVED_NOTICES)[number];

const isSavedNotice = (value: unknown): value is SavedNotice => SAVED_NOTICES.some((notice) => notice === value);

export const Route = createFileRoute('/profiles/$profileId')({
  validateSearch: (search: Record<string, unknown>): { saved?: SavedNotice } =>
    isSavedNotice(search['saved']) ? { saved: search['saved'] } : {},
  loader: async ({ params }) => {
    const [detail, candidates] = await Promise.all([
      getProfileFn({ data: { profileId: params.profileId } }),
      targetConfigCandidatesFn(),
    ]);
    if (detail === null) {
      throw notFound();
    }
    return { detail, candidates };
  },
  component: EditProfilePage,
});

const SAVED_TEXT: Readonly<Record<SavedNotice, string>> = Object.freeze({
  created: LOCAL_UI_TEXT.profileForm.created,
  updated: LOCAL_UI_TEXT.profileForm.updated,
  retired: LOCAL_UI_TEXT.retireDialog.done,
  retiredCredentialKept: LOCAL_UI_TEXT.retireDialog.done,
});

/** プロファイルの編集と取り消し（設計書 4.7）。 */
function EditProfilePage() {
  const { detail, candidates } = Route.useLoaderData();
  const { saved } = Route.useSearch();
  const update = useServerFn(updateProfileFn);
  const retire = useServerFn(retireProfileFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [retireRejection, setRetireRejection] = useState<Extract<ProfileChangeView, { ok: false }> | null>(null);
  const { profile } = detail;
  const status = profileStatusDisplay(detail.status);
  const retired = detail.status === 'RETIRED';
  const reload = (): void => {
    void router.invalidate();
  };
  const showSaved = (notice: SavedNotice): void => {
    // 先に今の内容を読み直し（loader）、それから保存の知らせを出す（知らせと内容が食い違わないように）。
    void router.invalidate().then(() =>
      navigate({ to: '/profiles/$profileId', params: { profileId: profile.profileId }, search: { saved: notice }, replace: true }));
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

      {!retired && usesAuthSetup(profile.mode, profile.auth) ? (
        <section className="panel" data-testid="profile-auth-setup">
          <h2 className="panel-heading">{LOCAL_UI_AUTH_TEXT.profileDetail.heading}</h2>
          <p>{LOCAL_UI_AUTH_TEXT.profileDetail.body}</p>
          <p>
            <Link to="/auth-setup/$profileId" params={{ profileId: profile.profileId }} className="button button--primary">
              {LOCAL_UI_AUTH_TEXT.profileDetail.open}
            </Link>
          </p>
        </section>
      ) : null}

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
              onSaved={() => showSaved('updated')}
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

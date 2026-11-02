import { createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
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
  LOCAL_UI_NEXT_STEP_TEXT,
} from '../../../../../src/presentation/messages.js';
import { AdvancedSettings } from '../../components/AdvancedSettings';
import { AuthSetupForm, authSetupDocumentOf, authSetupFormValuesOf } from '../../components/AuthSetupForm';
import type { LoginStageRowTarget } from '../../components/LoginStageRegister';
import { serviceOriginSourcesOf } from '../../display/entry-check-draft';
import { EntryCheckPanel } from '../../components/EntryCheckPanel';
import { NextStepLinks } from '../../components/NextSteps';
import { Notice } from '../../components/Notice';
import { PageFrame, siteTrail } from '../../components/PageFrame';
import { authSetupFreshnessDisplay, toneClass, usesAutomatedLogin } from '../../display/labels';
import { scriptLoginNoticesOf } from '../../display/script-login-notices';
import { closedSearchValueOf, isClosedSearchValue } from '../../display/search-values';
import { getAuthSetupFn, saveAuthSetupFn, saveAuthSetupWithServiceOriginsFn } from '../../server/auth-setup-functions';
import { entryCheckSummaryFn } from '../../server/entry-check-functions';

/** 保存の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。 */
const SAVED_NOTICE = 'saved';
/** 保存の知らせの閉じた一覧（MI-C2 項目 19）。 */
const SAVED_NOTICES = Object.freeze([SAVED_NOTICE] as const);
/**
 * 画面の search。T43d（Task 43 の設計書 4.4）: ジョブの詳細の「登録する」「案を認証の設定に入れる」の下書き（`draft`。サーバに保存しない形。値は
 * Origin・path・method・必須の query・鍵の名前・CSS だけ）。URL の値は信用せず、画面で毎回 `parseObservedAuthSetupDraft` で確かめ、合わなければ
 * 下書きなしにして知らせる（router は、確かめた search に入れなかった URL の値も渡しうるため、型は下書きでも中身は確かめ直す）。
 */
interface AuthSetupSearch {
  readonly saved?: typeof SAVED_NOTICE;
  readonly draft?: ObservedAuthSetupDraft;
  /**
   * MI-F1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 1）: 下書きを作ったジョブの記録の行（ジョブの詳細の「認証の設定の画面で
   * 直す」が付ける）。承認したサービスの Origin を足す保存は、サーバがこの行から足す Origin を組み立て直す（行のない下書きからは足さない）。
   */
  readonly row?: LoginStageRowTarget;
}

/** URL の search の値を、ジョブの記録の行の指定として読む（形が合わなければ `undefined`。値はサーバがスキーマとジョブの記録で確かめ直す）。 */
const loginStageRowOfSearch = (value: unknown): LoginStageRowTarget | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { jobId, passed, index, ...rest } = value as Record<string, unknown>;
  return Object.keys(rest).length === 0 && typeof jobId === 'string' && typeof passed === 'boolean' && typeof index === 'number'
    && Number.isSafeInteger(index) && index >= 0
    ? { jobId, passed, index }
    : undefined;
};

export const Route = createFileRoute('/auth-setup/$profileId')({
  validateSearch: (search: Record<string, unknown>): AuthSetupSearch => {
    const draft = search['draft'] === undefined ? null : parseObservedAuthSetupDraft(search['draft']);
    const row = loginStageRowOfSearch(search['row']);
    return {
      ...(isClosedSearchValue(SAVED_NOTICES, search['saved']) ? { saved: SAVED_NOTICE } : {}),
      ...(draft === null ? {} : { draft }),
      ...(row === undefined ? {} : { row }),
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


/**
 * 認証の設定（Task 25 の設計書 4.1、4.5、4.6）。プロファイルの詳細の「詳しい設定」から開く。認証の設定を使うプロファイルだけ、フォームを出す。
 * MI-3: 今の欄は全部、たたんだ「詳しい設定」に入れる（開いたときは閉じた状態。ジョブの詳細から観察した要求の下書きを持ってきたときだけ、確かめて保存するために
 * 開く。形の正しくない下書きのときも、その知らせを見せるために開く）。
 * PL-4（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・2・3。作業記録 UX-1 の画面 C の 5 章）: 上から、要点のパネル（自動で保存した設定で
 * あることと、直すのは観察で入らない欄だけであること、設定の状態、保存の知らせと次の手順。設定がまだないときは入口の確かめ 1 つ）→ 詳しい内容 1 つ（フォーム）。
 * サイトの値の表（改訂・点検のしかた・ログインのしかた・状態・Origin の一覧・最後の保存）と「どこから来た値か」の表は出さない。読むだけの送信先の欄も出さない
 * （`AuthSetupForm`）。主のボタンは main に 1 つまで（要点に主のボタンがあるときは、フォームの「保存する」は二次の見た目）。
 */
function AuthSetupPage() {
  const page = Route.useLoaderData();
  const { saved: rawSaved, draft: rawDraft, row: rawRow } = Route.useSearch();
  // MI-C2 項目 19: ルータは根の生の search も子へ渡すので、知らせの値は描く前に閉じた一覧でもう一度確かめる（`display/search-values.ts`）。
  const saved = closedSearchValueOf(SAVED_NOTICES, rawSaved);
  // T43d: URL の下書きを確かめ直す（合わなければ下書きなし）。
  const checkedDraft = rawDraft === undefined ? undefined : parseObservedAuthSetupDraft(rawDraft);
  const observedDraft = checkedDraft ?? undefined;
  const draftInvalid = checkedDraft === null;
  // MI-F1: 下書きを作ったジョブの記録の行（下書きのあるときだけ。形をもう一度確かめる）。
  const draftRow = observedDraft === undefined ? undefined : loginStageRowOfSearch(rawRow);
  const save = useServerFn(saveAuthSetupFn);
  const saveWithServiceOrigins = useServerFn(saveAuthSetupWithServiceOriginsFn);
  const navigate = useNavigate();
  const router = useRouter();
  const text = LOCAL_UI_AUTH_TEXT.setup;
  const { profile, stored } = page;
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
  // PL-4: 要点の主のボタン（設定がまだないときの入口の確かめ、保存の後の次の手順）があるときは、フォームの「保存する」を二次の見た目にする。
  const showEntryCheck = editable && stored === null;
  const showNextSteps = saved !== undefined && editable;
  const reload = (): void => {
    void router.invalidate();
  };
  const showSaved = (): void => {
    // 先に今の内容を読み直し（loader）、それから保存の知らせを出す（知らせと内容が食い違わないように）。
    void router.invalidate().then(() =>
      navigate({ to: '/auth-setup/$profileId', params: { profileId: profile.profileId }, search: { saved: SAVED_NOTICE }, replace: true }));
  };

  return (
    <PageFrame title={LOCAL_UI_AUTH_TEXT.pages.authSetup} trail={siteTrail(profile.profileId)}>
      {/* 3 章の 1: 要点のパネル。 */}
      <section className="panel" data-testid="auth-setup-summary">
        <h2 className="panel-heading">{LOCAL_UI_NEXT_STEP_TEXT.summaryHeading}</h2>
        {saved === undefined ? null : (
          <Notice kind="positive">
            <p data-testid="auth-setup-saved">{text.saved}</p>
          </Notice>
        )}
        {!page.eligible ? (
          <p data-testid="auth-setup-not-eligible">{text.notEligible}</p>
        ) : profile.status !== ACTIVE_PROFILE_STATUS ? (
          <p data-testid="auth-setup-retired">{text.retired}</p>
        ) : (
          <>
            <p data-testid="auth-setup-summary-line" data-saved={stored === null ? 'no' : 'yes'}>
              {stored === null ? text.summaryNotSaved : text.summarySaved}
            </p>
            <p>
              {`${text.state}: `}
              {freshness === null || stored === null ? (
                <span data-testid="auth-setup-freshness" data-freshness="NONE">{text.notSaved}</span>
              ) : (
                <span className={toneClass(freshness.tone)} data-testid="auth-setup-freshness" data-freshness={stored.freshness}>{freshness.label}</span>
              )}
            </p>
          </>
        )}
        {editable && stored !== null && stored.freshness === STALE_AUTH_SETUP_FRESHNESS ? (
          <Notice kind="caution" heading={text.staleHeading}>
            <p data-testid="auth-setup-stale">{text.staleBody}</p>
          </Notice>
        ) : null}
        {/* T43a（Task 43 の設計書 4.1）: 保存の後に、次の手順（自動ログインなら資格情報、手動のログインなら監査の開始）と「次にすること」へのリンク。 */}
        {showNextSteps ? <NextStepLinks profileId={profile.profileId} after="AUTH_SETUP" mode={profile.mode} auth={profile.auth} /> : null}
        {/* T43c・PL-4: 設定がまだないときだけ、入口の確かめ（開始のアドレスを 1 回読み、この画面の案を作る。設定があるときは、確かめ直しても上書きしない）。 */}
        {showEntryCheck && !showNextSteps ? <EntryCheckPanel summary={page.entryCheck} /> : null}
      </section>

      {editable ? (
        // 3 章の 1: 詳しい内容 1 つ（開かなくても流れは進む）。
        <section className="panel">
          <AdvancedSettings testId="auth-setup-advanced-settings" openRequested={rawDraft !== undefined}>
            <h2 className="panel-heading">{text.formHeading}</h2>
            <Notice kind="caution">
              <p data-testid="auth-setup-no-secret">{automated ? text.noSecretBodyAutomated : text.noSecretBody}</p>
            </Notice>
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
                // MI-F1（設計書 4.7.1 の 1）: Origin を足す保存は、ジョブの記録の行のある下書きだけ（足す Origin は、サーバが行から組み立て直す）。行のない
                // 下書きは、足さない保存（承認していない送信先は、保存の検証が誤りにする）。
                // MI-F5（設計書 4.7.1 の 6）: 行のある下書きは、足す Origin がなくても、行の観察と照らす下書きの保存で送る（送信先は観察からだけ入る。画面の保存
                // は、送信先を変える保存を拒む）。設定の結びつく改訂は、サーバが決める（足すときは次の改訂、足さないときは今の改訂）。
                return draftRow === undefined
                  ? save({ data: { setup: authSetupDocumentOf(values, profile.profileId, profile.revision, automated) } })
                  // T43d: プロファイルの次の改訂（Origin を足したもの）に結びつけて、1 回で保存する（画面が読んだ改訂の照合は保つ）。
                  : saveWithServiceOrigins({
                    data: {
                      setup: authSetupDocumentOf(values, profile.profileId, toAdd.length === 0 ? profile.revision : profile.revision + 1, automated),
                      expectedRevision: profile.revision,
                      row: draftRow,
                    },
                  });
              }}
              onSaved={showSaved}
              onReload={reload}
              // MI-F5（設計書 4.7.1 の 6）・PL-4: 認証の設定があるときは、ログインの送信先の項目を出さない（変えられない）。
              destinationsLocked={stored !== null}
              submitPrimary={!showEntryCheck && !showNextSteps}
            />
            {/* 既定で読まない語（変えられない。読まないパスの欄の説明の続き）。 */}
            <h3>{text.defaultExcludedHeading}</h3>
            <p>{text.defaultExcludedBody}</p>
            <ul className="word-list" data-testid="auth-setup-default-excluded">
              {DEFAULT_EXCLUDED_URL_WORDS.map((word) => <li key={word}><code>{word}</code></li>)}
            </ul>
          </AdvancedSettings>
        </section>
      ) : null}
    </PageFrame>
  );
}

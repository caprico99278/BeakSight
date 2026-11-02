import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { WRITE_AUDIT_MODE } from '../../../../../src/control/contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../../../../src/core/default-excluded-url-words.js';
import { formatCount, formatDateTime, formatDuration, formatElapsedTime } from '../../../../../src/presentation/format.js';
import {
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_TEXT,
} from '../../../../../src/presentation/messages.js';
import { AdvancedSettings } from '../../components/AdvancedSettings';
import { authSetupErrorSummaryText } from '../../components/AuthSetupForm';
import { arrivedFromAutomatedLoginSetUp } from '../../components/AutomatedLoginSetupForm';
import { FieldFrame } from '../../components/FieldFrame';
import { Notice } from '../../components/Notice';
import { PageFrame, arrivalSearchOf, siteTrail } from '../../components/PageFrame';
import { StartReasonDetails } from '../../components/StartReasonDetails';
import {
  auditJobKindDisplay,
  authSetupFreshnessDisplay,
  automatedLoginResultDisplay,
  toneClass,
} from '../../display/labels';
import { linesOf, textOfLines } from '../../display/form-lines';
import {
  auditStartSummaryFn,
  startAuditJobFn,
  startStageChainFn,
  type AuditJobStartView,
  type AuditStartSummaryView,
} from '../../server/audit-job-functions';
import { saveExcludedPathsFn, type AuthSetupSaveView } from '../../server/auth-setup-functions';

export const Route = createFileRoute('/start/$profileId')({
  // PL-3（PL-4 の続き。設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 4、13 章の最後の段落）: 自動ログインにする確定の後に移ってきた印（自動で移った印と、
  // 自動ログインにした印）を受ける。
  validateSearch: (search: Record<string, unknown>): { arrived?: 'auto'; automatedLogin?: 'setUp' } => ({
    ...arrivalSearchOf(search),
    ...(arrivedFromAutomatedLoginSetUp(search) ? { automatedLogin: 'setUp' as const } : {}),
  }),
  loader: async ({ params }) => {
    const summary = await auditStartSummaryFn({ data: { profileId: params.profileId } });
    if (summary === null) {
      throw notFound();
    }
    return summary;
  },
  component: StartAuditPage,
});

/** 自動ログインの上限の状態（T26e。Task 26 の設計書 4.6。止めているか、次に始められる日時）。PL-3: 詳しい内容に出す（止めている・待つときの理由は要点）。 */
function AutoLoginLimitState({ summary }: Readonly<{ summary: AuditStartSummaryView }>) {
  const text = LOCAL_UI_AUTH_TEXT.start;
  const { autoLogin } = summary;
  if (autoLogin === null) {
    return null;
  }
  const state = autoLogin.hold !== null ? 'held' : autoLogin.nextAllowedAt !== null ? 'waiting' : 'ready';
  return (
    <>
      <dt>{text.limitState}</dt>
      <dd data-testid="start-auto-login-limit" data-state={state}>
        {autoLogin.hold !== null
          ? `${text.limitHeld}（${automatedLoginResultDisplay(autoLogin.hold.reason).label}）`
          : autoLogin.nextAllowedAt !== null ? text.limitWaitText(formatDateTime(autoLogin.nextAllowedAt)) : text.limitReady}
      </dd>
    </>
  );
}

/**
 * 認証つきの監査の、ログインの詳しい情報（T25e。設計書 4.5。T26e: 自動ログインの上限の状態）。PL-3: 詳しい内容に出す（ログインのしかたの案内の 1 行は、
 * 要点のパネル）。認証の設定の要点と、直す画面への入口。
 */
function LoginDetails({ summary }: Readonly<{ summary: AuditStartSummaryView }>) {
  const text = LOCAL_UI_AUTH_TEXT.start;
  const { authSetup } = summary;
  const freshness = authSetup === null ? null : authSetupFreshnessDisplay(authSetup.freshness);
  const automated = summary.autoLogin !== null;
  return (
    <section data-testid="start-login-details">
      <h3>{text.heading}</h3>
      <p className="muted">{automated ? text.automatedGuidanceNote : text.guidanceNote}</p>
      {automated ? (
        <dl className="facts">
          <AutoLoginLimitState summary={summary} />
        </dl>
      ) : null}
      {authSetup === null || freshness === null ? null : (
        <dl className="facts" data-testid="start-auth-setup">
          <dt>{text.loginStartUrl}</dt>
          <dd className="cell-break"><code>{authSetup.loginStartUrl}</code></dd>
          <dt>{text.auditScope}</dt>
          <dd className="cell-break">
            {authSetup.auditPathPrefixes.length === 0 ? text.auditScopeAll : (
              <ul className="word-list">
                {authSetup.auditPathPrefixes.map((prefix) => <li key={prefix}><code>{prefix}</code></li>)}
              </ul>
            )}
          </dd>
          <dt>{LOCAL_UI_AUTH_TEXT.setup.state}</dt>
          <dd><span className={toneClass(freshness.tone)}>{freshness.label}</span></dd>
        </dl>
      )}
      <p className="button-row">
        <Link to="/auth-setup/$profileId" params={{ profileId: summary.profileId }} className="button">{text.openSetup}</Link>
        {automated ? <Link to="/credentials/$profileId" params={{ profileId: summary.profileId }} className="button">{text.openCredentials}</Link> : null}
      </p>
    </section>
  );
}

/**
 * MI-3 の C（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 「読まないパス（任意。1 行に 1 つ）」の欄（認証の設定のあるプロファイルだけ）。
 * 初めの値は今の認証の設定の読まないパス。既定で読まない語（`DEFAULT_EXCLUDED_URL_WORDS`）を説明に出す。保存が拒まれたときは、欄に理由を出す。
 */
function ExcludedPathsField({ value, onChange, rejection, approvedScenarioCount }: Readonly<{
  value: string;
  onChange: (value: string) => void;
  rejection: Extract<AuthSetupSaveView, { ok: false }> | null;
  /** MI-C 項目 9: 今承認が有効なシナリオの数（1 件以上なら、変えると承認し直しが要ることを出す）。 */
  approvedScenarioCount: number;
}>) {
  const text = LOCAL_UI_AUTH_TEXT.start;
  const errors = rejection === null
    ? []
    : [
      text.excludedPathsRejected,
      AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS[rejection.reason].description,
      ...rejection.errors.map(authSetupErrorSummaryText),
    ];
  return (
    <>
      <FieldFrame label={text.excludedPaths} hint={text.excludedPathsHint} errors={errors}>
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            className="input"
            name="excludedPaths"
            value={value}
            spellCheck={false}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            data-testid="start-excluded-paths"
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </FieldFrame>
      {approvedScenarioCount === 0 ? null : (
        <p className="field-hint" data-testid="start-excluded-paths-reapproval">{text.excludedPathsReapproval(formatCount(approvedScenarioCount))}</p>
      )}
      <p className="field-hint">{text.excludedPathsDefaultWords}</p>
      <ul className="word-list" data-testid="start-default-excluded">
        {DEFAULT_EXCLUDED_URL_WORDS.map((word) => <li key={word}><code>{word}</code></li>)}
      </ul>
    </>
  );
}

/** MI-3 の C: 欄の読まないパスが、今の認証の設定の読まないパスと違うか（空の行を除き、行の順も比べる）。 */
const excludedPathsChanged = (text: string, saved: readonly string[]): boolean => {
  const lines = linesOf(text);
  return lines.length !== saved.length || lines.some((line, index) => line !== saved[index]);
};

/**
 * 監査の開始（Task 24 の設計書 4.8）。PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、2 章の判断 3、4 章の 4）で、要点のパネル＋詳しい内容 1 つの
 * 形にした。
 * - 要点のパネル: 1 回押すと何が起きるか（主のボタンが始めるものごと）、ログインのしかたの 1 行、書き込みのモードでも見るだけの一文、前回の点検が最後まで
 *   終わらなかったときの一文。始められるときは主のボタン「点検を始める」1 つ（始めるものは画面のサーバの `primaryStart`。まとめて実行のできるモードは、まとめて
 *   実行。公開の画面だけのサイトは点検だけ）。始められないときはボタンを出さず、理由と直す道（二次の見た目のリンク）。
 * - 詳しい内容: 始め方の選択（前回の点検が最後まで終わらなかったときだけ。既定は続きから。`resumeChoiceOffered`）、読まないパスの欄（MI-3 の C）、ステップの
 *   並び、読む量の上限、ログインの詳しい情報。
 * MI-3 の C: 読まないパスを変えて「点検を始める」を押すと、認証の設定を保存（今の保存の部品。検証と改訂の照合）してから始める。変えなければ保存しない。保存が
 * 拒まれたら、始めずに欄に理由を出す（詳しい内容を開く）。
 */
function StartAuditPage() {
  const summary = Route.useLoaderData();
  // ルータは根の生の search も子へ渡すので、描く前に印をもう一度確かめる（`arrivedFromAutomatedLoginSetUp`）。
  const automatedLoginSetUp = arrivedFromAutomatedLoginSetUp(Route.useSearch());
  const startAudit = useServerFn(startAuditJobFn);
  const startChain = useServerFn(startStageChainFn);
  const saveExcluded = useServerFn(saveExcludedPathsFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [startNew, setStartNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<Extract<AuditJobStartView, { ok: false }> | null>(null);
  const { authSetup, primaryStart, target, chain } = summary;
  const [excludedText, setExcludedText] = useState(textOfLines(authSetup?.excludedPaths ?? []));
  const [excludedRejection, setExcludedRejection] = useState<Extract<AuthSetupSaveView, { ok: false }> | null>(null);
  const text = LOCAL_UI_AUDIT_TEXT.start;
  const authText = LOCAL_UI_AUTH_TEXT.start;
  const automated = summary.autoLogin !== null;
  const startable = primaryStart.blocker === null;
  /** 読まないパスを変えたときだけ、認証の設定を保存する（保存できたか。変えていなければ真）。 */
  const saveExcludedPaths = async (): Promise<boolean> => {
    if (authSetup === null || !excludedPathsChanged(excludedText, authSetup.excludedPaths)) {
      return true;
    }
    // MI-F3（MI-R の Minor 5）: 読まないパスだけを送る（サーバが今の設定の読まないパスだけを替える。別のタブで保存した変更を古い値に戻さない）。
    const saved = await saveExcluded({ data: { profileId: summary.profileId, expectedRevision: summary.revision, excludedPaths: linesOf(excludedText) } });
    setExcludedRejection(saved.ok ? null : saved);
    return saved.ok;
  };
  /** 主のボタン: 変えた読まないパスを保存してから、画面のサーバが決めたもの（まとめて実行か、点検だけか）を始める。 */
  const begin = async (): Promise<AuditJobStartView | undefined> => {
    if (!(await saveExcludedPaths())) {
      return undefined;
    }
    const data = { profileId: summary.profileId, expectedRevision: summary.revision, startNew };
    return primaryStart.kind === 'STAGE_CHAIN' ? startChain({ data }) : startAudit({ data });
  };

  return (
    <PageFrame title={LOCAL_UI_AUDIT_TEXT.pages.startAudit} trail={siteTrail(summary.profileId)}>
      {/* 3 章の 1: 要点のパネル（何が起きるか、ログインのしかた、主のボタン 1 つ。知らせもこの中）。 */}
      <section className="panel" data-testid="start-summary" data-start-kind={primaryStart.kind}>
        <h2 className="panel-heading">{LOCAL_UI_NEXT_STEP_TEXT.summaryHeading}</h2>
        {/* 13 章の最後の段落: 自動で移ってきたときは、1 行目に何が起きたかを書く（自動ログインにする確定の後）。 */}
        {automatedLoginSetUp ? <p data-testid="start-arrived-automated-login">{LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.arrived}</p> : null}
        {/* OP-G（指示書の 5）: チェックした画面があれば、そこでは登録・更新することを言う（「読むだけ」は、チェックがないときだけ。決めるのはサーバ）。 */}
        <p data-testid="start-what-happens" data-kind={primaryStart.kind} data-writes={summary.writesOnCheckedScreens ? 'yes' : 'no'}>
          {summary.writesOnCheckedScreens ? text.whatHappensWithWrites : text.whatHappens[primaryStart.kind]}
        </p>
        {summary.authRequired ? (
          <div data-testid="start-login">
            <p data-testid="start-login-guidance" data-automated={automated ? 'yes' : 'no'}>{automated ? (summary.jobBrowserShown ? authText.automatedGuidanceBrowserShown : authText.automatedGuidance) : authText.guidance}</p>
          </div>
        ) : null}
        {summary.mode === WRITE_AUDIT_MODE && !summary.writesOnCheckedScreens ? (
          <Notice kind="caution">
            <p data-testid="start-write-mode-read-only">{text.readOnlyInWriteMode}</p>
          </Notice>
        ) : null}
        {startable && summary.resumeChoiceOffered ? (
          <p data-testid="start-resume-note">{text.resumeNote(LOCAL_UI_TEXT.advancedSettings.summary)}</p>
        ) : null}
        {primaryStart.blocker === null ? (
          <>
            {rejection === null ? null : (
              <Notice kind="critical" heading={text.rejectedHeading}>
                <StartReasonDetails
                  profileId={summary.profileId}
                  reason={rejection.reason}
                  errorCodes={rejection.errorCodes}
                  configError={null}
                  authSetupErrors={rejection.authSetupErrors}
                  nextAllowedAt={rejection.nextAllowedAt ?? null}
                  showLoginCheckLink
                />
                <div className="button-row">
                  <button type="button" className="button" onClick={() => void router.invalidate().then(() => setRejection(null))}>
                    {LOCAL_UI_TEXT.reload}
                  </button>
                </div>
              </Notice>
            )}
            {excludedRejection === null ? null : (
              <Notice kind="critical">
                <p data-testid="start-excluded-paths-not-saved">{authText.excludedPathsRejectedNote(LOCAL_UI_TEXT.advancedSettings.summary)}</p>
              </Notice>
            )}
            <div className="button-row">
              <button
                type="button"
                className="button button--primary"
                data-testid="start-submit"
                data-kind={primaryStart.kind}
                disabled={submitting}
                onClick={() => {
                  setSubmitting(true);
                  void begin()
                    .then(async (result) => {
                      if (result === undefined) {
                        return undefined;
                      }
                      if (result.ok) {
                        setRejection(null);
                        return navigate({ to: '/jobs/$jobId', params: { jobId: result.jobId } });
                      }
                      setRejection(result);
                      return undefined;
                    })
                    .finally(() => setSubmitting(false));
                }}
              >
                {submitting ? text.submitting : text.submit}
              </button>
            </div>
          </>
        ) : (
          <Notice kind="critical" heading={text.cannotStartHeading}>
            <StartReasonDetails
              profileId={summary.profileId}
              reason={primaryStart.blocker}
              errorCodes={primaryStart.errorCodes}
              configError={summary.configError}
              authSetupErrors={primaryStart.authSetupErrors}
              nextAllowedAt={primaryStart.nextAllowedAt}
              showLoginCheckLink
            />
          </Notice>
        )}
      </section>

      {/* 3 章の 1: 詳しい内容 1 つ（開かなくても点検は始められる）。保存が拒まれた読まないパスの欄は、開いて理由を見せる。 */}
      <section className="panel">
        <AdvancedSettings testId="start-advanced-settings" openRequested={excludedRejection !== null}>
          {startable && summary.resumeChoiceOffered ? (
            <fieldset className="field">
              <legend className="field-label">{text.modeLegend}</legend>
              <label className="choice">
                <input type="radio" name="start-mode" value="resume" checked={!startNew} onChange={() => setStartNew(false)} />
                <span>{text.resume}</span>
              </label>
              <p className="field-hint">{text.resumeHint}</p>
              <label className="choice">
                <input type="radio" name="start-mode" value="new" checked={startNew} onChange={() => setStartNew(true)} />
                <span>{text.startNew}</span>
              </label>
              <p className="field-hint">{text.startNewHint}</p>
            </fieldset>
          ) : null}
          {startable && authSetup !== null ? (
            <ExcludedPathsField
              value={excludedText}
              onChange={(value) => {
                setExcludedText(value);
                setExcludedRejection(null);
              }}
              rejection={excludedRejection}
              approvedScenarioCount={summary.approvedScenarioCount}
            />
          ) : null}
          {chain === null ? null : (
            <dl className="facts">
              <dt>{text.stagesLabel}</dt>
              <dd>
                <ol data-testid="start-stage-chain-stages">
                  {chain.stages.map((kind) => <li key={kind} data-kind={kind}>{auditJobKindDisplay(kind).label}</li>)}
                </ol>
              </dd>
            </dl>
          )}
          {target === null ? null : (
            <>
              <dl className="facts" data-testid="start-target">
                <dt>{text.startUrl}</dt>
                <dd className="cell-break"><code>{target.startUrl}</code></dd>
                <dt>{text.maxPages}</dt>
                <dd>{formatCount(target.maxPages)}</dd>
                <dt>{text.maxRuntime}</dt>
                <dd>{formatElapsedTime(target.maxRuntimeMs)}</dd>
                <dt>{text.minNavigationInterval}</dt>
                <dd data-testid="start-interval">{formatDuration(target.minNavigationIntervalMs)}</dd>
              </dl>
              <p className="muted">{text.configNote}</p>
            </>
          )}
          {summary.authRequired ? <LoginDetails summary={summary} /> : null}
        </AdvancedSettings>
      </section>
    </PageFrame>
  );
}

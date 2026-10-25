// T44a（設計書 `doc/design/2026-10-21-beaksight-task-44-efficiency-precision-usability-design.md` 2 章。指示書
// `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/T44a-brief.md`）: fixture の代表のサイトで、監査の精度と効率の数を測る（判定はしない）。
// ふだんの `npm test` では流さない（`TASK44_METRICS=1` のときだけ。`DEF144_INVESTIGATE` と同じ考え）。結果は Markdown の表で `TASK44_METRICS_OUTPUT` の
// ファイルに書く（省略すると一時のフォルダの `beaksight-task44-metrics.md`）。
// - 静的なサイト（公開の監査）: 入口の確かめ → 読み取りの監査（製品の既定の設定。幅の走査・スクリーンショット・Interaction を含む）。
// - スクリプトでログインする SPA の管理画面（`spa-auth-site-fixture.ts`）: 入口の確かめ → 手動のログイン（ページの送信を通して形だけ記録）→ 通した送信の
//   自動の登録（`manualLoginRegistrationOf`）→ 送信の扱い `PASS_EXCEPT_DELETE` で、読み取りの監査 → 発見（probe）→ READ の確かめ。
// - T44c: 実テスト環境の形を足した SPA（`SPA_REAL_ENV_SHAPE_OPTIONS`。ダイアログの中の保存、押す候補の多い更新の画面、内側のスクロール、幅の走査のサービスへの
//   読み取り、閉じるときの計測の送信）を、同じ流れで測る（probe の結果・内側のスクロールの画面を正解と比べ、送信の数を記録に写す）。
// 通す部品はどれも本物（Chromium はテストの既定の headless。`TASK44_CHROMIUM=cli` で CLI の起動の設定）。サーバは 127.0.0.1 の fixture だけ。
// 読み込みの間隔は `TASK44_NAVIGATION_INTERVAL_MS`（既定 1,000 ms。実テスト環境の画面が作る設定は 10,000 ms）。出力先は一時のフォルダで、終わったら消す。
// 値（資格情報・token・API の鍵）は出力しない。
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { startFixtureServer } from '../../fixtures/server.js';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { sessionLostPathPrefixOf } from '../../src/control/auth/auth-setup-policy.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { EntryCheckDocument } from '../../src/control/entry-check.js';
import { manualLoginRegistrationOf } from '../../src/control/manual-login-registration.js';
import type { WorkerStartAuthentication, WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
import type { AuditSendPolicyName } from '../../src/core/audit-send-policy.js';
import { ENTRY_CHECK_ARTIFACT_FILE_NAME, RUN_ARTIFACT_FILE_NAMES, artifactFilePath } from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import { collectLayoutEvidence, STRESS_VIEWPORT_HEIGHT } from '../../src/evidence/layout-collector.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { auditStageItemOf } from '../../src/worker/audit-stage-requests.js';
import { runLoginStage } from '../../src/worker/authenticated-login.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { executeEntryCheckRun } from '../../src/worker/entry-check-run.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import {
  accuracyTable,
  answerTable,
  artifactSizesOf,
  auditedPagePathsOf,
  auditInteractionAccuracyOf,
  auditPageAccuracyOf,
  auditPagesWithReasonOf,
  auditViewportAccuracyOf,
  authenticationRowsOf,
  blockedRequestReasonsOf,
  compareWithAnswers,
  createTimedLauncher,
  discoveryApiCandidatesOf,
  discoveryCandidateClassesOf,
  discoveryProbeAccuracyOf,
  discoveryReadScreensOf,
  discoveryScreenAccuracyOf,
  entryCheckAccuracyOf,
  findingRulesOf,
  formatCounts,
  formatLayoutFacts,
  formatMs,
  layoutFactSummaryOf,
  layoutFindingSourcesOf,
  markdownTable,
  pathOf,
  PRIORITY_WORD_SUFFIX,
  probeOutcomesOf,
  probePressesOf,
  probeWaitEstimateMs,
  readCheckAccuracyOf,
  runLoadRowsOf,
  sizeTable,
  stressLayoutRowsOf,
  timingsBetween,
  timingTable,
  type AnswerComparison,
  type ArtifactSizes,
  type StageAccuracy,
  type StageTimings,
  type TimedLauncher,
} from '../helpers/audit-metrics.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { readRunAudit } from '../helpers/run-harness.js';
import {
  SPA_EXPECTED_API_CANDIDATES,
  SPA_EXPECTED_EXCLUDED_SCREENS,
  SPA_EXPECTED_READ_CHECKS,
  SPA_EXPECTED_SCREENS,
  SPA_REAL_ENV_EXPECTED_CREATE_SCREEN_PROBES,
  SPA_REAL_ENV_EXPECTED_EDIT_SCREEN_PROBES,
  SPA_REAL_ENV_EXPECTED_INNER_SCROLL_PAGES,
  SPA_REAL_ENV_SHAPE_OPTIONS,
  SPA_REPRESENTATIVE_MEMBERS,
  SPA_REPRESENTATIVE_OPTIONS,
  SPA_REPRESENTATIVE_START_PATH,
  STATIC_SITE_EXPECTED_PAGES,
  STATIC_SITE_EXPECTED_RULE_IDS,
  STATIC_SITE_METADATA_DIRECTORY,
  STATIC_SITE_START_PATH,
} from '../helpers/representative-site-answers.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_HIDDEN_PRESS_PATH_PREFIX,
  SPA_LOGIN_FIELDS,
  SPA_MEMBER_DETAIL_TERMS,
  SPA_SERVICE_READ_QUERY,
  SPA_STATE_ELEMENTS,
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
} from '../helpers/spa-auth-site-fixture.js';
import { createTestConfig } from '../helpers/test-config.js';

const ENABLED = process.env['TASK44_METRICS'] === '1';
/** 1 つのサイトの測りの上限（ms。既定の設定の監査と発見を含む）。 */
const SITE_TIMEOUT_MS = 1_800_000;
/** 読み込みの間隔（ms）。 */
const NAVIGATION_INTERVAL_MS = Number(process.env['TASK44_NAVIGATION_INTERVAL_MS'] ?? '1000');
/** 監査と発見の画面の上限（どちらの代表のサイトも、全部の画面を読める数）。 */
const MAX_PAGES = 10;
const SEND_POLICY: AuditSendPolicyName = 'PASS_EXCEPT_DELETE';
const UI_TIMEOUT_MS = 15_000;
const LOGIN_STAGE_TIMEOUT_MS = 60_000;
const LOGIN_STAGE_POLL_MS = 100;
/** 各段の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const CHROMIUM_NAME = process.env['TASK44_CHROMIUM'] === 'cli' ? 'CLI の起動の設定' : 'テストの既定（headless shell）';
const launchChromium = (): Promise<Browser> => (process.env['TASK44_CHROMIUM'] === 'cli' ? launchCliChromium() : launchHeadlessChromium());
const noObserver = { onRunStarted: (): void => undefined, onSessionLost: (): void => undefined };

/** 1 つのサイトの測りの結果。 */
interface SiteMetrics {
  readonly title: string;
  readonly accuracy: StageAccuracy[];
  readonly answers: AnswerComparison[];
  readonly timings: StageTimings[];
  readonly sizes: (readonly [string, ArtifactSizes])[];
  readonly records: (readonly [string, string])[];
  readonly notes: string[];
  /** T44h: 見出しつきの、ほかの表（P1-5 の幅の走査のレイアウトの事実など）。 */
  readonly tables: (readonly [string, string])[];
}

const newSiteMetrics = (title: string): SiteMetrics => ({ title, accuracy: [], answers: [], timings: [], sizes: [], records: [], notes: [], tables: [] });
const results: SiteMetrics[] = [];

/** 段を測る（合計の時間、Browser の時間の差、仕上げの時間）。 */
const measureStage = async <T>(
  timed: TimedLauncher,
  run: (onFinalizing: () => void) => Promise<T>,
): Promise<{ readonly value: T; readonly totalMs: number; readonly finalizeMs: number | null; readonly browser: StageTimings['browser'] }> => {
  const before = timed.snapshot();
  const started = performance.now();
  let finalizingAt: number | null = null;
  const value = await run(() => {
    finalizingAt ??= performance.now();
  });
  const ended = performance.now();
  return { value, totalMs: ended - started, finalizeMs: finalizingAt === null ? null : ended - finalizingAt, browser: timingsBetween(before, timed.snapshot()) };
};

const readJsonFile = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/** 静的なサイトとSPA の両方で使う、測りの設定（製品の既定に、出力先・画面の上限・読み込みの間隔だけを重ねる）。 */
const metricsConfig = (origin: string, startPath: string, name: string, outputDirectory: string, sendPolicy?: AuditSendPolicyName): AuditConfig =>
  createTestConfig(origin, startPath, {
    target: { id: `task44-${name}` },
    crawl: { maxPages: MAX_PAGES, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    output: { directory: join(outputDirectory, name) },
    ...(sendPolicy === undefined ? {} : { audit: { sendPolicy } }),
  });

/** 入口の確かめ（ジョブ 1 件）を測る。 */
const measureEntryCheck = async (timed: TimedLauncher, metrics: SiteMetrics, config: AuditConfig): Promise<EntryCheckDocument | null> => {
  const pacer = createTestNavigationPacer(config);
  const measured = await measureStage(timed, async () => executeEntryCheckRun({
    config, jobId: 'job-task44-entry', launchBrowser: timed.launcher, clock: () => new Date(), now: () => Date.now(),
    stopSignal: new AbortController().signal, navigationPacer: pacer,
  }, { onRunStarted: () => undefined }));
  const outcome = measured.value;
  const document = outcome.kind === 'RAN'
    ? readJsonFile<EntryCheckDocument>(artifactFilePath(outcome.runDirectory, ENTRY_CHECK_ARTIFACT_FILE_NAME))
    : null;
  metrics.accuracy.push(entryCheckAccuracyOf(document));
  metrics.timings.push({
    stage: '入口の確かめ', totalMs: measured.totalMs, pacingWaitMs: pacer.snapshot().totalWaitMs, navigationCount: pacer.snapshot().navigationCount,
    servicePacingWaitMs: null, probeWaitMs: null, probePresses: null, finalizeMs: measured.finalizeMs, browser: measured.browser,
  });
  if (outcome.kind === 'RAN') {
    metrics.sizes.push(['入口の確かめ', artifactSizesOf(outcome.runDirectory)]);
  }
  return document;
};

/** 読み取りの監査を測る（`run.json` と `audit.json` を読む）。 */
const measureAudit = async (
  timed: TimedLauncher,
  metrics: SiteMetrics,
  config: AuditConfig,
  authentication?: RunAuthentication,
): Promise<{ readonly run: RunSummary; readonly audit: Awaited<ReturnType<typeof readRunAudit>> }> => {
  const measured = await measureStage(timed, async (onFinalizing) => executeAuditRun(config, {
    launchBrowser: timed.launcher, clock: () => new Date(), now: () => Date.now(), ...(authentication === undefined ? {} : { authentication }),
  }, { startNew: true }, { onFinalizing }));
  const outcome = measured.value;
  if (outcome.kind !== 'RAN') {
    throw new Error(`the audit did not run: ${outcome.kind}`);
  }
  const run = readJsonFile<RunSummary>(join(outcome.runDirectory, RUN_ARTIFACT_FILE_NAMES.run));
  const audit = await readRunAudit(outcome.runDirectory);
  metrics.accuracy.push(auditPageAccuracyOf(audit.pages), auditViewportAccuracyOf(audit.pages), auditInteractionAccuracyOf(audit.pages));
  metrics.accuracy.push({
    stage: '読み取りの監査（Run の未完了の理由）', unit: 'Run', total: 1, undetermined: run.runStatus === 'COMPLETE' ? 0 : 1,
    reasons: Object.fromEntries(run.incompleteReasons.map(({ code }) => code).reduce((map, code) => map.set(code, (map.get(code) ?? 0) + 1), new Map<string, number>())),
    outcomes: { [`runStatus=${run.runStatus}`]: 1, [`endReason=${run.executions.at(-1)?.endReason ?? '-'}`]: 1 },
  });
  metrics.timings.push({
    stage: '読み取りの監査', totalMs: measured.totalMs, pacingWaitMs: run.load.pacingWaitMs, navigationCount: run.load.navigationCount,
    servicePacingWaitMs: run.authentication?.serviceRequestPacingWaitMs ?? null, probeWaitMs: null, probePresses: null,
    finalizeMs: measured.finalizeMs, browser: measured.browser,
  });
  metrics.sizes.push(['読み取りの監査', artifactSizesOf(outcome.runDirectory)]);
  metrics.records.push(...runLoadRowsOf(run).map(([name, value]) => [`監査: ${name}`, value] as const));
  // T44c: `run.json` のページの未完了の理由ごとのページ数（任意の項目。理由を持つページがなければ持たない）。
  metrics.records.push(['監査: ページの未完了の理由ごとのページ数（`run.json` の `pageIncompleteReasonCounts`）',
    run.pageIncompleteReasonCounts === undefined ? '—' : run.pageIncompleteReasonCounts.map(({ code, pages }) => `${code} ${String(pages)}`).join('、')]);
  return { run, audit };
};

describe.runIf(ENABLED)('T44a・T44c: the metrics of the representative fixture sites', () => {
  afterAll(() => {
    const output = process.env['TASK44_METRICS_OUTPUT'] ?? join(tmpdir(), 'beaksight-task44-metrics.md');
    const sections = results.map((metrics) => [
      `## ${metrics.title}`,
      '',
      '### 精度: 段ごとの「判定できない」の数と理由',
      '',
      accuracyTable(metrics.accuracy),
      '',
      '### 精度: fixture の正解との差',
      '',
      answerTable(metrics.answers),
      '',
      '### 効率: 段ごとの所要時間',
      '',
      timingTable(metrics.timings),
      '',
      '### 効率: 成果物の大きさ',
      '',
      sizeTable(metrics.sizes),
      '',
      '### 記録の写し（サイトへの負荷と安全）',
      '',
      markdownTable(['記録すること', '値'], metrics.records),
      ...metrics.tables.flatMap(([heading, table]) => ['', `### ${heading}`, '', table]),
      ...(metrics.notes.length === 0 ? [] : ['', '### 補足', '', ...metrics.notes.map((note) => `- ${note}`)]),
      '',
    ].join('\n'));
    const header = [
      `測った日時: ${new Date().toISOString()}`,
      `Chromium: ${CHROMIUM_NAME}。読み込みの間隔: ${String(NAVIGATION_INTERVAL_MS)} ms。画面の上限: ${String(MAX_PAGES)}。`,
      '',
    ].join('\n');
    writeFileSync(output, `${header}\n${sections.join('\n')}`, 'utf8');
  });

  it('measures the static site (the public audit)', async () => {
    const metrics = newSiteMetrics('静的なサイト（公開の監査。`fixtures/site/full-crawl/`）');
    const server = await startFixtureServer({ siteMetadataDirectory: STATIC_SITE_METADATA_DIRECTORY });
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-task44-static-'));
    const timed = createTimedLauncher(launchChromium);
    try {
      await measureEntryCheck(timed, metrics, metricsConfig(server.origin, STATIC_SITE_START_PATH, 'entry', outputDirectory));
      const { audit } = await measureAudit(timed, metrics, metricsConfig(server.origin, STATIC_SITE_START_PATH, 'audit', outputDirectory));
      metrics.answers.push(compareWithAnswers('監査したページ', STATIC_SITE_EXPECTED_PAGES, auditedPagePathsOf(audit.pages)));
      const expectedRules = Object.entries(STATIC_SITE_EXPECTED_RULE_IDS).flatMap(([path, ruleIds]) => ruleIds.map((ruleId) => `${path} ${ruleId}`));
      const foundRules = findingRulesOf(audit.findings, audit.pages);
      const comparison = compareWithAnswers('壊したページの Finding（ruleId）', expectedRules, foundRules.filter((rule) => expectedRules.includes(rule)));
      metrics.answers.push(comparison);
      metrics.notes.push(`Finding の総数 ${String(audit.findings.length)}（ruleId の種類 ${String(new Set(audit.findings.map(({ ruleId }) => ruleId)).size)}）。`
        + '正解の表は「壊したページに必ず出る Finding」だけを持つので、正解にない Finding は数えない。');
      metrics.notes.push('発見と READ の確かめは、公開の監査のモードでは行えない（`PROFILE_OPERATION_POLICY`）ので測らない。');
      await wait(LATE_REQUEST_WAIT_MS);
      const counters = server.getCounters();
      metrics.records.push(['サーバに届いた読み取りでない要求（POST・PUT・PATCH・DELETE・OPTIONS・ほか・WebSocket・ダウンロード）',
        [counters.post, counters.put, counters.patch, counters.delete, counters.options, counters.other, counters.webSocketUpgrade, counters.download].join('・')]);
      expect(counters.post + counters.put + counters.patch + counters.delete).toBe(0);
    } finally {
      results.push(metrics);
      await server.close();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }, SITE_TIMEOUT_MS);

  /**
   * SPA の管理画面を測る（T44c: `realEnvShapes` のときは、実テスト環境の形を足した SPA。正解との差と記録の写しに、その形の行を足す）。
   */
  const measureSpaSite = async (title: string, options: SpaAuthSiteOptions, realEnvShapes: boolean): Promise<void> => {
    const metrics = newSiteMetrics(title);
    const site: SpaAuthSite = await startSpaAuthSite(options);
    for (const name of SPA_REPRESENTATIVE_MEMBERS) {
      site.addMember(name);
    }
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-task44-spa-'));
    const timed = createTimedLauncher(launchChromium);
    const spaConfig = (name: string, sendPolicy?: AuditSendPolicyName): AuditConfig => {
      const base = metricsConfig(site.appOrigin, SPA_REPRESENTATIVE_START_PATH, name, outputDirectory, sendPolicy);
      return { ...base, site: { startUrl: `${site.appOrigin}${SPA_REPRESENTATIVE_START_PATH}`, allowedOrigins: [site.appOrigin] } };
    };
    try {
      // 1. 入口の確かめ（利用者が入れる開始の URL = ログインの後の管理画面。ログインしていないので、ページの JS がログインの画面へ移る）。
      await measureEntryCheck(timed, metrics, spaConfig('entry'));

      // 2. 手動のログイン（フォームの送信の認証の設定。フォームの送信先はアプリの Origin の `/login`。ページの送信は通して形だけ記録する。人の操作はテストの口で代える）。
      const setup: AuthSetup = {
        ...FORM_NAVIGATION_SETUP_ITEMS, profileId: 'task44-spa', profileRevision: 1,
        loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, loginPostEndpoints: [{ origin: site.appOrigin, path: '/login' }],
        successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}` },
        sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth }, excludedPaths: [SPA_APP_PATHS.logout], auditPathPrefixes: [],
        maxLoginAttempts: 1, allowedIdpOrigins: [], automatedLogin: null,
      };
      const loginStarted = performance.now();
      const login = await runLoginStage({
        config: spaConfig('login'), setup, approvedTestOrigins: [site.appOrigin], approvedServiceOrigins: [],
        signal: new AbortController().signal, onAwaitingLogin: () => undefined,
      }, {
        launchLoginBrowser: launchChromium, loginTimeoutMs: LOGIN_STAGE_TIMEOUT_MS, pollIntervalMs: LOGIN_STAGE_POLL_MS,
        onLoginPageReady: async (page: Page) => {
          await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
          await site.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
          await page.locator(SPA_LOGIN_FIELDS.submit).click();
        },
      });
      const loginMs = performance.now() - loginStarted;
      metrics.accuracy.push({
        stage: 'ログイン（手動）', unit: 'ログインの試み', total: 1, undetermined: login.kind === 'AUTHENTICATED' ? 0 : 1,
        reasons: login.kind === 'AUTHENTICATED' ? {} : { [login.kind]: 1 },
        outcomes: { [login.kind]: 1, [`通した送信の行 ${String(login.passedRequests?.requests.length ?? 0)}`]: 1 },
      });
      metrics.records.push(['ログイン（手動）の所要時間（人の操作をテストの口で代えた時間を含む）', formatMs(loginMs)]);
      if (login.kind !== 'AUTHENTICATED') {
        throw new Error(`the manual login did not succeed: ${login.kind}`);
      }

      // 3. 通した送信の自動の登録（今の「登録する」の部品）。スクリプトで送るログインの設定（版 3）と、足す承認したサービスの Origin。
      const built = manualLoginRegistrationOf({
        setup, profile: { approvedTestOrigins: [site.appOrigin], approvedServiceOrigins: [] },
        passedRequests: login.passedRequests, observation: login.loginObservation, nextProfileRevision: 2,
      });
      if (!built.ok) {
        throw new Error(`the registration was skipped: ${built.reason}`);
      }
      metrics.records.push(['自動の登録: ログインに伴う送信の数・足した承認したサービスの Origin の数',
        `${String(built.setup.loginSideRequests.length)}・${String(built.addServiceOrigins.length)}`]);
      const start: WorkerStartAuthentication = {
        setup: built.setup, approvedTestOrigins: [site.appOrigin], approvedServiceOrigins: built.addServiceOrigins, authenticationSha256: 'task44',
      };
      const authentication: RunAuthentication = {
        initialState: login.state,
        approvedTestOrigins: start.approvedTestOrigins,
        auditExclusions: { excludedPathPrefixes: built.setup.excludedPaths, auditPathPrefixes: built.setup.auditPathPrefixes, dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: sessionLostPathPrefixOf(built.setup),
        filterState: filterAuthenticatedState,
        ...auditStageItemOf(start, MAX_PAGES),
      };

      // 4. 読み取りの監査（送信の扱い `PASS_EXCEPT_DELETE`）。
      const requestsBeforeAudit = site.requests.length;
      const closingBeaconsBeforeAudit = site.closingBeacons;
      const { audit } = await measureAudit(timed, metrics, spaConfig('audit', SEND_POLICY), authentication);
      metrics.answers.push(compareWithAnswers('監査したページ', SPA_EXPECTED_SCREENS, auditedPagePathsOf(audit.pages)));
      // T44h（P1-5）: 管理画面の読み込みのうち、一覧の手続きの呼び出し（テナントの呼び出しの後に出る）まで進んだ数と、幅の走査のレイアウトの事実。
      {
        await wait(LATE_REQUEST_WAIT_MS);
        const auditWindow = site.requests.slice(requestsBeforeAudit);
        const countOf = (origin: string, method: string, path: string): number => auditWindow.filter((request) =>
          request.origin === origin && request.method === method && !request.preflight && request.path.split('?')[0] === path).length;
        metrics.records.push(['監査（P1-5）: 管理画面の読み込み・テナントの手続きの呼び出し・一覧の手続きの呼び出し（一覧を描くのに要る）',
          `${String(countOf('app', 'GET', SPA_APP_PATHS.admin))}・${String(countOf('backend', 'POST', SPA_BACKEND_PATHS.rpcResolveTenant))}・`
          + `${String(countOf('backend', 'POST', SPA_BACKEND_PATHS.rpcListMembers))}`]);
        metrics.tables.push(['幅の走査のレイアウトの事実（P1-5。管理画面）',
          markdownTable(['ページ', '読み込み', '収集の状態', 'レイアウトの事実'], stressLayoutRowsOf(audit.pages, SPA_APP_PATHS.admin))]);
      }
      if (realEnvShapes) {
        // T44c: 内側のスクロールの領域（P1-4）、幅の走査の読み込みのサービスへの読み取り（P1-1）、閉じるときの計測の送信（P1-2）。
        await wait(LATE_REQUEST_WAIT_MS);
        const auditRequests = site.requests.slice(requestsBeforeAudit);
        metrics.answers.push(compareWithAnswers('内側のスクロールの領域で止まったページ（`INNER_SCROLL_CONTAINER_NOT_TRAVERSED`）',
          SPA_REAL_ENV_EXPECTED_INNER_SCROLL_PAGES, auditPagesWithReasonOf(audit.pages, 'INNER_SCROLL_CONTAINER_NOT_TRAVERSED')));
        metrics.records.push(
          ['監査: 管理画面の読み込み（アプリの GET）・届いた一覧の後のサービスへの読み取り（GET）', `${String(auditRequests.filter((request) =>
            request.origin === 'app' && request.method === 'GET' && request.path === SPA_APP_PATHS.admin).length)}・${String(auditRequests.filter((request) =>
            request.origin === 'backend' && request.method === 'GET' && request.path === `${SPA_BACKEND_PATHS.members}?${SPA_SERVICE_READ_QUERY}`).length)}`],
          ['監査: 止めた要求の理由ごとの数（ページの safety の記録）', formatCounts(blockedRequestReasonsOf(audit.pages))],
          ['監査: 届いた閉じるときの計測の送信', String(site.closingBeacons - closingBeaconsBeforeAudit)],
        );
      }

      // 5. 発見（probe。製品の既定の静まりの待ち）。
      const discoveryConfig = spaConfig('discovery', SEND_POLICY);
      const discoveryPacer = createTestNavigationPacer(discoveryConfig);
      const discovered = await measureStage(timed, async (onFinalizing) => executeDiscoveryRun({
        config: discoveryConfig, jobId: 'job-task44-discovery', authentication, launchBrowser: timed.launcher, clock: () => new Date(),
        now: () => Date.now(), stopSignal: new AbortController().signal, navigationPacer: discoveryPacer,
      }, { ...noObserver, onFinalizing }));
      if (discovered.value.kind !== 'RAN') {
        throw new Error(`the discovery did not run: ${discovered.value.kind}`);
      }
      const discovery = readJsonFile<DiscoveryDocument>(join(discovered.value.runDirectory, 'discovery.json'));
      metrics.accuracy.push(discoveryScreenAccuracyOf(discovery), discoveryProbeAccuracyOf(discovery));
      metrics.answers.push(
        compareWithAnswers('発見で読んだ画面', SPA_EXPECTED_SCREENS, discoveryReadScreensOf(discovery)),
        compareWithAnswers('読まないパスとして除いた画面', SPA_EXPECTED_EXCLUDED_SCREENS,
          discovery.pages.flatMap((page) => (page.state === 'NOT_READ' && page.reason === 'EXCLUDED' ? [pathOf(page.url)] : []))),
        compareWithAnswers('API の候補（送らずに観察した送り方）',
          Object.entries(SPA_EXPECTED_API_CANDIDATES).flatMap(([path, kinds]) => kinds.map((kind) => `${path} ${kind}`)),
          discoveryApiCandidatesOf(discovery)),
      );
      if (realEnvShapes) {
        // T44c: probe の押し漏れ（P1-3）。更新の画面と登録の画面の probe の結果を、fixture の作りから決めた正解と比べる。
        const edit = SPA_REAL_ENV_EXPECTED_EDIT_SCREEN_PROBES;
        const editPaths = SPA_REPRESENTATIVE_MEMBERS.map((_name, index) => spaMemberEditPathOf(index + 1));
        const repeat = (value: string, count: number): readonly string[] => Array.from({ length: count }, () => value);
        metrics.answers.push(
          compareWithAnswers('更新の画面の probe の結果', editPaths.flatMap(() => [
            'API_UPDATE',
            ...repeat('NOT_OBSERVED/TARGET_NOT_FOUND', edit.targetNotFound),
            ...repeat('NO_REQUEST', edit.noRequest),
            ...repeat(`NOT_OBSERVED/PRESS_LIMIT_REACHED${PRIORITY_WORD_SUFFIX}`, edit.priorityPressLimitReached),
            ...repeat('NOT_OBSERVED/PRESS_LIMIT_REACHED', edit.otherPressLimitReached),
          ]), probeOutcomesOf(discovery, (path) => editPaths.includes(path))),
          compareWithAnswers('登録の画面の probe の結果', [
            ...repeat('NO_REQUEST', SPA_REAL_ENV_EXPECTED_CREATE_SCREEN_PROBES.noRequest),
            ...repeat('API_CREATE', SPA_REAL_ENV_EXPECTED_CREATE_SCREEN_PROBES.apiCreate),
          ], probeOutcomesOf(discovery, (path) => path === SPA_APP_PATHS.memberNew)),
        );
        metrics.records.push(['発見: 押す数の上限で押せなかった登録・更新の語の候補（候補から数えた数・成果物の数）',
          `${String(probeOutcomesOf(discovery).filter((outcome) => outcome.endsWith(PRIORITY_WORD_SUFFIX)).length)}・`
          + `${String((discovery as { readonly pressLimitProbes?: { readonly priorityNotPressed: number } }).pressLimitProbes?.priorityNotPressed ?? '—')}`]);
      }
      const presses = probePressesOf(discovery);
      metrics.timings.push({
        stage: '発見', totalMs: discovered.totalMs, pacingWaitMs: discoveryPacer.snapshot().totalWaitMs, navigationCount: discoveryPacer.snapshot().navigationCount,
        servicePacingWaitMs: discovery.authentication?.serviceRequestPacingWaitMs ?? null, probeWaitMs: probeWaitEstimateMs(presses), probePresses: presses,
        finalizeMs: discovered.finalizeMs, browser: discovered.browser,
      });
      metrics.sizes.push(['発見', artifactSizesOf(discovered.value.runDirectory)]);
      metrics.records.push(
        ['発見: 終わり方・Run の状態', `${discovery.endReason}・${discovery.runStatus}`],
        ['発見: 候補の分類（種類/分類/理由）', Object.entries(discoveryCandidateClassesOf(discovery)).map(([name, count]) => `${name} ${String(count)}`).join('、') || '—'],
        ['発見: 外部スキームで押さなかった数・読み込み直した画面', `${String(discovery.externalSchemeProbes?.notPressed ?? 0)}・${String(discovery.externalSchemeProbes?.reloadedPages ?? 0)}`],
        ...authenticationRowsOf(discovery.authentication).map(([name, value]) => [`発見: ${name}`, value] as const),
      );

      // 6. READ の確かめ（画面の path の定義。一覧と詳細）。
      const readConfig = spaConfig('read-check', SEND_POLICY);
      const readPacer = createTestNavigationPacer(readConfig);
      const readChecks: readonly WorkerStartReadCheck[] = [
        {
          readCheckId: SPA_EXPECTED_READ_CHECKS.list.id, readCheckRevision: 1, targetPage: { origin: site.appOrigin, path: SPA_EXPECTED_READ_CHECKS.list.path },
          definition: { targetPagePath: SPA_EXPECTED_READ_CHECKS.list.path, parameters: {}, expectations: [
            { kind: 'ROW_COUNT_EQUALS', count: SPA_REPRESENTATIVE_MEMBERS.length }, { kind: 'TEXT_CONTAINS', text: SPA_REPRESENTATIVE_MEMBERS[1] ?? '' },
          ] },
        },
        {
          readCheckId: SPA_EXPECTED_READ_CHECKS.detail.id, readCheckRevision: 1, targetPage: { origin: site.appOrigin, path: SPA_EXPECTED_READ_CHECKS.detail.path },
          definition: { targetPagePath: SPA_EXPECTED_READ_CHECKS.detail.path, parameters: {}, expectations: [
            { kind: 'DETAIL_FIELD_EQUALS', field: SPA_MEMBER_DETAIL_TERMS.name, value: SPA_REPRESENTATIVE_MEMBERS[0] ?? '' },
          ] },
        },
      ];
      const readMeasured = await measureStage(timed, async (onFinalizing) => executeReadCheckRun({
        config: readConfig, jobId: 'job-task44-read', authentication, readChecks, launchBrowser: timed.launcher, clock: () => new Date(),
        now: () => Date.now(), stopSignal: new AbortController().signal, navigationPacer: readPacer,
      }, { ...noObserver, onFinalizing }));
      if (readMeasured.value.kind !== 'RAN') {
        throw new Error(`the READ check did not run: ${readMeasured.value.kind}`);
      }
      const readEvidence = readJsonFile<ReadEvidenceDocument>(join(readMeasured.value.runDirectory, 'read-evidence.json'));
      metrics.accuracy.push(readCheckAccuracyOf(readEvidence));
      metrics.answers.push(compareWithAnswers('READ の確かめの結果',
        Object.values(SPA_EXPECTED_READ_CHECKS).map(({ id, expected }) => `${id} ${expected}`),
        readEvidence.checks.map((check) => `${check.readCheckId} ${check.state === 'EXECUTED' ? check.result : 'NOT_EXECUTED'}`)));
      metrics.timings.push({
        stage: 'READ の確かめ', totalMs: readMeasured.totalMs, pacingWaitMs: readPacer.snapshot().totalWaitMs, navigationCount: readPacer.snapshot().navigationCount,
        servicePacingWaitMs: readEvidence.authentication?.serviceRequestPacingWaitMs ?? null, probeWaitMs: null, probePresses: null,
        finalizeMs: readMeasured.finalizeMs, browser: readMeasured.browser,
      });
      metrics.sizes.push(['READ の確かめ', artifactSizesOf(readMeasured.value.runDirectory)]);
      metrics.records.push(...authenticationRowsOf(readEvidence.authentication).map(([name, value]) => [`READ の確かめ: ${name}`, value] as const));

      // サーバに届いた読み取りでない要求（事前確認を除く。Origin・method・path ごと。query は写さない）。
      await wait(LATE_REQUEST_WAIT_MS);
      const nonReads = site.requests.filter((request) => !request.preflight && !READ_METHODS.has(request.method))
        .map(({ origin, method, path }) => `${origin} ${method} ${path.split('?')[0] ?? ''}`);
      const counted = [...nonReads.reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map<string, number>())]
        .sort(([left], [right]) => left.localeCompare(right));
      metrics.records.push(['SPA のサーバに届いた読み取りでない要求（全段の合計。ログインの段を含む）', counted.map(([key, count]) => `${key} ${String(count)}`).join('、') || '—']);
      metrics.notes.push('SPA の会員の詳細の画面は一覧からのリンクがないので、監査と発見の正解の画面に入れない（READ の確かめの定義だけが読む）。');
      metrics.notes.push('ログインは 1 回だけ行い、その状態を監査・発見・READ の確かめに渡した（実際のジョブは、手動のログインの方式ではジョブごとにログインする）。');
      // 安全の前提: 削除の要求は届かない。
      expect(nonReads.filter((request) => request.includes(' DELETE '))).toEqual([]);
      if (realEnvShapes) {
        // T44c: 見えないボタンの送り先（押せないはず）と、道具のボタン（何も送らない）の送り先は、どれも届かない。
        expect(nonReads.filter((request) => request.includes(SPA_HIDDEN_PRESS_PATH_PREFIX))).toEqual([]);
      }
    } finally {
      results.push(metrics);
      await site.close();
      await rm(outputDirectory, { recursive: true, force: true });
    }
  };

  it('measures the SPA admin screens with the script login (manual login, PASS_EXCEPT_DELETE)', async () => {
    await measureSpaSite('スクリプトでログインする SPA の管理画面（手動のログイン、送信の扱い `PASS_EXCEPT_DELETE`）', SPA_REPRESENTATIVE_OPTIONS, false);
  }, SITE_TIMEOUT_MS);

  // T44c（設計書の履歴の「T44a の報告」の (1)）: 実テスト環境の形を足した SPA（`SPA_REAL_ENV_SHAPE_OPTIONS`）。
  it('measures the SPA admin screens with the shapes of the real test environment (T44c)', async () => {
    await measureSpaSite('実テスト環境の形を足した SPA の管理画面（ダイアログの中の保存、押す候補の多い更新の画面、内側のスクロール、幅の走査のサービスへの読み取り、'
      + '閉じるときの計測の送信。手動のログイン、`PASS_EXCEPT_DELETE`）', SPA_REAL_ENV_SHAPE_OPTIONS, true);
  }, SITE_TIMEOUT_MS);

  // T44h（設計書の P1-5。直さない。測るだけ）: 幅の走査（`collectStressLayout`）は `load` の直後にレイアウトを採る。SPA の非同期の読み取りの後の画面を
  // 見ていないことで、幅のレイアウトの判定が変わるかを確かめる。
  // 1. 代表の SPA の管理画面を、幅の走査と同じ幅と高さの素の Context（Guard なし。127.0.0.1 の fixture だけ）で開き、`load` の直後と、一覧を描き終えた後に、
  //    製品のレイアウトの収集（`collectLayoutEvidence`）で事実を採って比べる。
  // 2. 一覧を後から描く画面（広い表）と、同じ表を最初から持つ画面を、製品の監査（公開の監査。既定の幅の走査）で読み、横のはみ出しの Finding の出どころを比べる。
  it('measures the effect of the stress sweep that does not wait for the SPA reads (P1-5)', async () => {
    const metrics = newSiteMetrics('P1-5: 幅の走査が SPA の読み取りを待たないことの影響（測るだけ）');
    try {
      // 1. 代表の SPA と、実テスト環境の形を足した SPA の管理画面。
      const browser = await launchChromium();
      const rows: string[][] = [];
      try {
        for (const [label, options] of [['代表の SPA', SPA_REPRESENTATIVE_OPTIONS], ['実テスト環境の形の SPA', SPA_REAL_ENV_SHAPE_OPTIONS]] as const) {
          const site = await startSpaAuthSite(options);
          for (const name of SPA_REPRESENTATIVE_MEMBERS) {
            site.addMember(name);
          }
          try {
            for (const width of P15_STRESS_WIDTHS) {
              for (const waitForData of [false, true]) {
                const viewport = { width, height: STRESS_VIEWPORT_HEIGHT };
                const context = await browser.newContext({
                  viewport,
                  storageState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
                });
                try {
                  const page = await context.newPage();
                  await page.goto(`${site.appOrigin}${SPA_APP_PATHS.admin}`, { waitUntil: 'load' });
                  if (waitForData) {
                    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
                    // 一覧の後の読み取り（実テスト環境の形）も終わるよう、名前つきの時間だけ待つ（`networkidle` は、この fixture では来ないことがある）。
                    await wait(P15_AFTER_DATA_WAIT_MS);
                  }
                  const drawnRows = await page.evaluate((id) => document.querySelectorAll(`#${id} tbody tr`).length, SPA_STATE_ELEMENTS.members);
                  const collected = await collectLayoutEvidence(page, viewport, { deadlineAtMs: Date.now() + UI_TIMEOUT_MS });
                  rows.push([label, String(width), waitForData ? '一覧を描き終えた後' : '`load` の直後（今の幅の走査と同じ）', String(drawnRows), collected.status,
                    formatLayoutFacts(collected.layout === null ? null : layoutFactSummaryOf(collected.layout))]);
                } finally {
                  await context.close();
                }
              }
            }
          } finally {
            await site.close();
          }
        }
      } finally {
        await browser.close();
      }
      metrics.tables.push(['1. SPA の管理画面の、幅の走査の幅でのレイアウトの事実（素の Context。`load` の直後と、一覧を描き終えた後）',
        markdownTable(['サイト', '幅', '採った時', '描けていた一覧の行', '収集の状態', 'レイアウトの事実'], rows)]);

      // 2. 一覧を後から描く画面と、最初から持つ画面（公開の監査。製品の既定の幅の走査）。
      const server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        request.resume();
        const page = P15_PAGES[path];
        if (page === undefined) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('not found');
          return;
        }
        response.writeHead(200, { 'content-type': page.type, 'cache-control': 'no-store' });
        response.end(page.body);
      });
      const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-task44-p15-'));
      try {
        const timed = createTimedLauncher(launchChromium);
        const { audit } = await measureAudit(timed, metrics, metricsConfig(server.origin, P15_PATHS.static, 'p15-audit', outputDirectory));
        const overflow = compareWithAnswers('横のはみ出しの Finding の出どころ（`DOCUMENT_HORIZONTAL_OVERFLOW`）', P15_EXPECTED_OVERFLOW_SOURCES,
          layoutFindingSourcesOf(audit.findings, audit.pages, ['DOCUMENT_HORIZONTAL_OVERFLOW']));
        metrics.answers.push(overflow);
        // P1-5 を直した後（幅の走査も落ち着くまで待ってから測る）: 後から描く表の幅 320 のはみ出しも見つける（見逃しがない）。
        expect(overflow.missing).toEqual([]);
        metrics.tables.push(['2. 広い表を最初から持つ画面と、後から描く画面のレイアウトの事実（製品の監査）',
          markdownTable(['ページ', '読み込み', '収集の状態', 'レイアウトの事実'], stressLayoutRowsOf(audit.pages))]);
        metrics.notes.push(`2 の正解は「表が画面にあれば、幅 ${String(P15_WIDE_TABLE_PX)}px の表は、最初の読み込みの Mobile（390）と幅の走査の 320 で横にはみ出す」`
          + 'という fixture の作り（`P15_EXPECTED_OVERFLOW_SOURCES`）。後から描く画面は、読み込みの後 '
          + `${String(P15_DATA_DELAY_MS)} ms 待ってから同じ Origin の JSON を読んで表を描く。`);
      } finally {
        await server.close();
        await rm(outputDirectory, { recursive: true, force: true });
      }
      metrics.notes.push('1 の素の Context は Guard を通さない（測りだけの比べ。127.0.0.1 の fixture だけに送る）。製品の幅の走査は `PASS_EXCEPT_DELETE` でも、同じく `load` の直後に採る。');
    } finally {
      results.push(metrics);
    }
  }, SITE_TIMEOUT_MS);
});

/** P1-5 の素の Context で比べる幅（製品の既定の幅の走査のうち、最初の読み込みの幅（390・1440）と重ならないもの）。 */
const P15_STRESS_WIDTHS: readonly number[] = Object.freeze([320, 768, 1024]);
/** P1-5 の 2 の画面の、広い表の幅（px）と、後から描く画面が読み込みの後に待つ時間（ms）。 */
const P15_WIDE_TABLE_PX = 700;
const P15_DATA_DELAY_MS = 100;
/** P1-5 の 1 で、一覧を描き終えた後に待つ時間（ms）。 */
const P15_AFTER_DATA_WAIT_MS = 1_000;
const P15_PATHS = Object.freeze({ static: '/p15/static.html', async: '/p15/async.html', data: '/p15/data.json' });
const P15_TABLE_STYLE = `<style>table{min-width:${String(P15_WIDE_TABLE_PX)}px;border-collapse:collapse}td{border:1px solid #333;padding:4px}</style>`;
const P15_HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,">${P15_TABLE_STYLE}`;
const P15_ROWS = ['一覧花子', '一覧太郎'];
const P15_TABLE = `<table><tbody>${P15_ROWS.map((name, index) => `<tr><td>${String(index + 1)}</td><td>${name}</td><td>有効</td></tr>`).join('')}</tbody></table>`;
const P15_PAGES: Readonly<Record<string, { readonly type: string; readonly body: string }>> = Object.freeze({
  [P15_PATHS.static]: {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="ja"><head><title>最初から持つ一覧</title>${P15_HEAD}</head><body><main><h1>一覧</h1>${P15_TABLE}`
      + `<p><a href="${P15_PATHS.async}">後から描く一覧</a></p></main></body></html>`,
  },
  [P15_PATHS.async]: {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="ja"><head><title>後から描く一覧</title>${P15_HEAD}</head><body><main><h1>一覧</h1><div id="list"></div>`
      + `<p><a href="${P15_PATHS.static}">最初から持つ一覧</a></p><script>setTimeout(async () => { const rows = await (await fetch('${P15_PATHS.data}')).json();`
      + ' document.getElementById(\'list\').innerHTML = \'<table><tbody>\' + rows.map((name, index) => \'<tr><td>\' + (index + 1) + \'</td><td>\' + name'
      + ` + '</td><td>有効</td></tr>').join('') + '</tbody></table>'; }, ${String(P15_DATA_DELAY_MS)});</script></main></body></html>`,
  },
  [P15_PATHS.data]: { type: 'application/json; charset=utf-8', body: JSON.stringify(P15_ROWS) },
});
/** P1-5 の 2 の正解（fixture の作り）: どちらの画面も、最初の読み込みの Mobile と幅の走査の 320 で横にはみ出す。 */
const P15_EXPECTED_OVERFLOW_SOURCES: readonly string[] = Object.freeze([P15_PATHS.static, P15_PATHS.async].flatMap((path) => [
  `${path} DOCUMENT_HORIZONTAL_OVERFLOW 最初の読み込み（mobile）`,
  `${path} DOCUMENT_HORIZONTAL_OVERFLOW 幅 320 px`,
]));

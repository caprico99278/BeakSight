// T30f（Task 30 の設計書 3 章、4 章の「読み込みの回数と間隔」、6 章）: 書き込みのジョブの流れ（`src/worker/write-create-run.ts` の
// `executeWriteCreateRun`）を、同じ process の中で、本物の Chromium（headless だけ。テストの既定と、CLI の起動の設定の両方）と 127.0.0.1 の fixture の
// サイト（`tests/helpers/write-site-fixture.ts`）で確かめる結合テスト。ログインの段は通さず、fixture が作ったセッションを、認証つきの Run の指定
// （メモリの状態）で渡す。IPC の 2 つの口（確かめ直し、送信の報告）は、テストが偽の親として受ける。
// - 承認に縛った候補の 2 つの digest と、照合の READ の対象の識別の digest は、本物の発見の入口（`readCandidatePage`）で読んだ候補から取る。
// - 終わりまでの流れ: 成功 → `VERIFIED`（ID あり、READ 一致）、入力の誤り・429 → `FAILED`、5xx・どれにも当たらない・2 つに当たる・307 → `UNKNOWN`、
//   ID が取れない・形の外 → `PARTIAL`、READ の不一致 → `UNKNOWN`（`actionOutcomeOf` のとおり）。
// - 送らない: 画面の digest の不一致、確かめ直しの拒否・時間切れ、ページの JS が送信の前に欄を足す・値を変える・form を差し替える・送信の先を新しい
//   窓にする（サーバの POST の記録で数え、全部の回の後に 2 秒待って数え直す）。
// - `action-run.json` がスキーマに合い、秘密の目印（セッションの値、CSRF のトークン、readonly の値）を含まない。送信の報告は 1 回で、成果物と同じ。
// - 読み込みの間隔: 読み込みの開始どうしの間が、設定の `crawl.minNavigationIntervalMs` 以上。
// - DEF-099 fix: 承認の POST は BeakSight（`src/safety/write-submission-sender.ts`）が中継を通して 1 回だけ送る。応答の前に接続が切れても POST は
//   1 件で、`UNKNOWN`（`NO_RESPONSE`）・予約 `UNKNOWN`。https（テストだけの自前の証明書）でも、成功の回と接続が切れる回を確かめ、送り手が証明書を
//   信頼しない場合は送らない（`NOT_SENT`。POST は届かない。製品の TLS の確かめが働く）。https の回のブラウザは、テストの起動の引数で証明書の誤りを
//   無視する（テストの中だけ）。
// - T30f fix round 1（DEF-098）: 任意の欄（text・textarea・checkbox・radio・同じ名前の hidden と checkbox の組）のある画面で、名前だけを送る欄に
//   選ぶ: 選ばなかった欄が空・未チェックのまま（組は外した値だけ）1 回の POST が届いて `VERIFIED`。ページの JS が送信の前に、選ばなかった text の
//   欄に値を入れる・checkbox をチェックすると、POST は届かない（`PAYLOAD_MISMATCH`）。
// 出力先は一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartWrite } from '../../src/control/worker-protocol.js';
import { ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { wait } from '../../src/core/deadline.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createNavigationPacer, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { readCandidatePage } from '../../src/discovery/read-executor.js';
import { InFlightRequestCounter } from '../../src/discovery/settle.js';
import { authenticatedContextOptions, type RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeWriteCreateRun, type WriteCreateRunOutcome } from '../../src/worker/write-create-run.js';
import type { WorkerWriteRecheckOutcome, WorkerWriteSubmissionReport } from '../../src/worker/write-ipc.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { LOOPBACK_TEST_CERTIFICATE, TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS } from '../helpers/tls-test-certificate.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { readWriteReportFiles, type WriteReportFiles } from '../helpers/write-report-checks.js';
import { WRITE_SITE_PATHS, WRITE_SITE_SESSION_COOKIE, startWriteSite, type WriteSite, type WriteSiteMode } from '../helpers/write-site-fixture.js';

/** 両方の Chromium と、http と https（DEF-099 fix）。 */
const CASES = [
  ['the default test Chromium over http', () => launchHeadlessChromium(), false],
  ['the CLI launch settings over http', () => launchCliChromium(), false],
  ['the default test Chromium over https', () => launchHeadlessChromium({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS }), true],
  ['the CLI launch settings over https', () => launchCliChromium({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS }), true],
] as const;
const TEST_TIMEOUT_MS = 120_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
/** 押した後に結果を待つ上限（ms。どの条件にも当たらない回を短くする）。 */
const RESULT_TIMEOUT_MS = 3_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const NAME_VALUE = '山田 太郎';
const EMAIL_VALUE = 'sample0001@example.invalid';
const ALLOWED: WorkerWriteRecheckOutcome = Object.freeze({ allowed: true });
/** T30R-fix-1（DEF-103）: 押す前の最後の待ちの読み込みの番号（画面の確かめ 0、書き込みの画面 1、押す前 2）。 */
const PRE_CLICK_NAVIGATION_INDEX = 2;
/**
 * T30R-fix-1（DEF-103）: 確かめ直しの答えから POST が届くまでの上限（ms）。間には、押す直前の form の確かめ直し（isolated world で読む）、押す操作、
 * Guard の照合、送り手の接続が入る（測った値は 70〜280ms 程度）。待ちと読み込み（前の作りでは、書き込みの画面の読み込みと 2 回の間隔の待ち）を
 * 入れないことの確かめ。
 */
const RECHECK_TO_POST_WINDOW_LIMIT_MS = 1_000;

describe.each(CASES)('T30f: the write job flow (%s)', (_name, launch, tls) => {
  let browser: Browser;
  let site: WriteSite;
  let sessionValue: string;
  let outputDirectory: string;
  let formCandidate: DiscoveryCandidate;
  let searchCandidate: DiscoveryCandidate;
  /** DEF-098: 任意の欄のある書き込みの画面の候補。 */
  let optionalCandidate: DiscoveryCandidate;
  /** これまでの回で、サーバに届いてよいと確かめた POST の数。 */
  let expectedPosts = 0;

  beforeAll(async () => {
    browser = await launch();
    site = await startWriteSite({ tls });
    sessionValue = site.issueSession();
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-write-create-run-'));
    [formCandidate, searchCandidate, optionalCandidate] = await readCandidates();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    site.setMode('success');
  });

  afterEach(() => {
    expect(site.postBodies.length, 'POSTs that reached the server').toBe(expectedPosts);
  });

  const configFor = (): AuditConfig => createTestConfig(site.origin, WRITE_SITE_PATHS.form, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    audit: { screenshots: false },
    output: { directory: outputDirectory },
  });

  const authenticationFor = (): RunAuthentication => ({
    initialState: {
      cookies: [{
        name: WRITE_SITE_SESSION_COOKIE, value: sessionValue, domain: new URL(site.origin).hostname, path: '/', expires: -1, httpOnly: true,
        secure: false, sameSite: 'Lax',
      }],
      origins: [],
    },
    approvedTestOrigins: [site.origin],
    auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    sessionLostPathPrefix: WRITE_SITE_PATHS.login,
    filterState: filterAuthenticatedState,
  });

  /** 本物の発見の入口で、書き込みの画面と一覧の画面の候補を読む（承認に縛る digest を手で書かない）。 */
  async function readCandidates(): Promise<[DiscoveryCandidate, DiscoveryCandidate, DiscoveryCandidate]> {
    const factory = new BrowserContextFactory(browser, configFor(), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: authenticatedContextOptions(authenticationFor()),
    });
    const read = async (path: string): Promise<readonly DiscoveryCandidate[]> => {
      const context = await factory.createPassiveContext(VIEWPORT);
      const page = await factory.createPassivePage(context);
      const counter = new InFlightRequestCounter(page);
      await page.goto(`${site.origin}${path}`);
      const candidates = await readCandidatePage(page, { classificationPolicy: { allowedOrigins: new Set([site.origin]) }, requestCounter: counter });
      counter.dispose();
      await factory.closePassiveContext(context);
      return candidates.candidates;
    };
    const isCreate = (candidate: DiscoveryCandidate): boolean => candidate.formMethod === 'POST' && candidate.action?.path === WRITE_SITE_PATHS.create;
    const form = (await read(WRITE_SITE_PATHS.form)).find(isCreate);
    const search = (await read(WRITE_SITE_PATHS.list)).find((candidate) => candidate.formMethod === 'GET' && candidate.classification === 'READ');
    const optional = (await read(WRITE_SITE_PATHS.optionalForm)).find(isCreate);
    await factory.close();
    if (form === undefined || search === undefined || optional === undefined) {
      throw new Error('the fixture candidates were not found');
    }
    return [form, search, optional];
  }

  /** 書き込みの画面（既定の画面か、DEF-098 の任意の欄のある画面）。 */
  type WriteForm = 'default' | 'optional';

  /** 生成した名前（回ごとに別の値。照合の READ の行が、ほかの回の登録と混ざらない）。 */
  const nameOf = (mode: WriteSiteMode, form: WriteForm = 'default'): string =>
    (form === 'default' ? `${NAME_VALUE} ${mode}` : `${NAME_VALUE} ${mode} ${form}`);

  const writeSpecOf = (name: string, form: WriteForm = 'default', candidateOverride?: DiscoveryCandidate): WorkerStartWrite => {
    const candidate = candidateOverride ?? (form === 'default' ? formCandidate : optionalCandidate);
    return {
      scenarioId: 'scenario-w',
      scenarioRevision: 1,
      grantId: 'grant-w',
      profileId: 'example-write',
      seedRecord: {
        seed: 'e'.repeat(64) as never,
        seedInput: { profileId: 'example-write', scenarioId: 'scenario-w', scenarioRevision: 1, ruleSetDigest: `sha256:${'f'.repeat(64)}`, executionGrantId: 'grant-w' },
        baseDate: '2026-10-13',
        attempt: 0,
      },
      request: { formMethod: 'POST', methodOverride: null, origin: site.origin, path: WRITE_SITE_PATHS.create, enctype: 'application/x-www-form-urlencoded' },
      formPage: { origin: candidate.page.origin, path: candidate.page.path },
      candidate: { identityDigest: candidate.identityDigest, ruleDigest: candidate.ruleDigest },
      candidateFields: candidate.fields.map(({ name: fieldName, type, readonly, hidden, disabled }) => ({ name: fieldName, type, readonly, hidden, disabled })),
      // DEF-098: 任意の欄のある画面は、名前だけを送る欄に選ぶ。
      values: form === 'default' ? { name, email: EMAIL_VALUE, newsletter: null } : { name },
      verification: {
        successCondition: { pathPrefix: `${WRITE_SITE_PATHS.create}/`, selector: '.registered' },
        inputErrorCondition: { pathPrefix: WRITE_SITE_PATHS.create, selector: '.error' },
        recordId: { source: 'URL_PATH_PATTERN', pathPattern: `${WRITE_SITE_PATHS.create}/{id}` },
      },
      readVerification: {
        readCheckId: 'rc-verify',
        readCheckRevision: 1,
        targetPage: { origin: searchCandidate.page.origin, path: searchCandidate.page.path },
        definition: { targetIdentityDigest: searchCandidate.identityDigest, parameters: { q: name }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] },
      },
      // T32d: 承認の要約（ワーカーは照らさずに書き写す）。
      approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: 'example-write', scenarioId: 'scenario-w', scenarioRevision: 1, grantId: 'grant-w' }),
    };
  };

  interface Run {
    readonly outcome: WriteCreateRunOutcome;
    readonly document: ActionRunDocument;
    /** T32e: 書き込みの報告の 2 つの JSON（スキーマ・目印・`action-run.json` との一致・承認の要約を確かめた後）。 */
    readonly report: WriteReportFiles;
    readonly reports: readonly WorkerWriteSubmissionReport[];
    readonly rechecks: number;
    readonly starts: readonly number[];
    /** T30R-fix-1（DEF-103）: 確かめ直しの答えを受けた時刻（呼ばなければ null）。 */
    readonly recheckResolvedAt: number | null;
  }

  /** 書き込みの流れを 1 回動かし、`action-run.json` を読んでスキーマで確かめる。 */
  const runWrite = async (
    mode: WriteSiteMode,
    recheck: () => Promise<WorkerWriteRecheckOutcome> = () => Promise.resolve(ALLOWED),
    form: WriteForm = 'default',
    /** 送り手が fixture の証明書を信頼するか（https だけ意味がある。偽なら製品の確かめだけ）。 */
    trusted = true,
    /** T30R-fix-1（DEF-103）: 読み込みの開始（pacer の待ちの後。0 から数える）ごとに呼ぶ口と、止める印。 */
    hooks: { readonly onNavigation?: (index: number) => void; readonly stop?: AbortController; readonly candidate?: DiscoveryCandidate } = {},
  ): Promise<Run> => {
    site.setMode(mode);
    const config = configFor();
    const reports: WorkerWriteSubmissionReport[] = [];
    const starts: number[] = [];
    /** Guard が main frame の文書の要求を送った時刻（pacer が記録する時刻以下。DEF-100 fix）。 */
    const sents: number[] = [];
    let rechecks = 0;
    const inner = createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now: () => Date.now(), sleep: wait });
    let recheckResolvedAt: number | null = null;
    const pacer: NavigationPacer = forwardingNavigationPacer(inner, async () => {
      const waited = await inner.beforeNavigation();
      starts.push(Date.now());
      hooks.onNavigation?.(starts.length - 1);
      return waited;
    }, () => {
      sents.push(Date.now());
    });
    const write = writeSpecOf(nameOf(mode, form), form, hooks.candidate);
    const outcome = await executeWriteCreateRun({
      config,
      jobId: `job-${mode}`,
      authentication: authenticationFor(),
      write,
      launchBrowser: launch,
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: hooks.stop?.signal ?? new AbortController().signal,
      recheck: async () => {
        rechecks += 1;
        const answer = await recheck();
        recheckResolvedAt = Date.now();
        return answer;
      },
      reportSubmission: (report) => reports.push(report),
      navigationPacer: pacer,
      resultTimeoutMs: RESULT_TIMEOUT_MS,
      writeSubmissionCertificates: trusted ? [LOOPBACK_TEST_CERTIFICATE] : [],
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the write run did not run: ${outcome.kind}`);
    }
    const text = readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8');
    const validation = await validateArtifact('action-run', JSON.parse(text));
    expect(validation).toEqual({ ok: true });
    for (const marker of [sessionValue, site.csrfMarker, site.readonlyMarker]) {
      expect(text).not.toContain(marker);
    }
    const document = JSON.parse(text) as ActionRunDocument;
    // T32e: どの回も（送らなかった回を含む）、書き込みの報告の 2 つの JSON ができ、スキーマに合い、秘密の目印を含まず、`action-run.json` と重なる値が
    // 一致し、承認の要約は `START` の承認の要約の事実と同じ。
    const report = await readWriteReportFiles(outcome.runDirectory, document, {
      markers: [sessionValue, site.csrfMarker, site.readonlyMarker],
      approvalFacts: write.approvalFacts,
    });
    expect(reports).toEqual([{ submission: document.submission, blockReason: document.blockReason }]);
    starts.slice(1).forEach((start, index) => {
      expect(start - (starts[index] ?? Number.NaN), `interval before navigation ${index + 1}`).toBeGreaterThanOrEqual(NAVIGATION_INTERVAL_MS);
    });
    // DEF-100 fix: Guard は、送った文書の要求（承認の POST は送り手が書き始めた時刻）を pacer に記録し、どの読み込みの開始も、それより前に
    // 送った時刻から間隔以上空く（サイトに届く間隔も設定以上）。
    expect(sents.length).toBeGreaterThan(0);
    for (const [index, start] of starts.entries()) {
      for (const sent of sents.filter((at) => at < start)) {
        expect(start - sent, `interval from a sent document before navigation ${index}`).toBeGreaterThanOrEqual(NAVIGATION_INTERVAL_MS);
      }
    }
    return { outcome, document, report, reports, rechecks, starts, recheckResolvedAt };
  };

  it('sends the approved POST once, judges SUCCESS, takes the record id, verifies it by the READ, and writes VERIFIED', async () => {
    const run = await runWrite('success');
    expectedPosts += 1;
    expect(run.document).toMatchObject({
      submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId: String(1001),
      readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, result: 'MATCHED' }, reservationState: 'COMMITTED',
      result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', submittedValues: { name: nameOf('success'), email: EMAIL_VALUE },
    });
    expect(run.outcome).toMatchObject({ runStatus: 'COMPLETE', result: 'VERIFIED' });
    expect(run.rechecks).toBe(1);
    const body = new URLSearchParams(site.postBodies.at(-1) ?? '');
    expect(body.get('name')).toBe(nameOf('success'));
    expect(body.get('email')).toBe(EMAIL_VALUE);
    expect(body.has('newsletter')).toBe(false);
    expect(body.get('csrf_token')).toBe(site.csrfMarker);
    // 読み込み: 画面の確かめ、書き込みの画面、押す、照合の READ の対象の画面と READ の URL（5 回。読み込み直しはしない）。
    expect(run.starts).toHaveLength(5);
    // T32e: 書き込みの報告の証拠（送る前の確かめ、送信先、判定の時刻、照合の READ の証拠の全体、Guard の数の要約）。
    const { evidence } = run.report;
    expect(evidence).toMatchObject({
      kind: 'CREATE', containsHumanEnteredValues: false, precheck: { candidateDigestMatched: true, blockReason: null },
      submission: { state: 'SENT', actionPath: WRITE_SITE_PATHS.create },
      readVerification: { readCheckId: 'rc-verify', state: 'EXECUTED', result: 'MATCHED', detail: 'EXPECTATIONS_EVALUATED', httpStatus: 200,
        expectations: [{ expectation: { kind: 'ROW_COUNT_EQUALS', count: 1 }, result: 'MATCHED', observedRowCount: 1 }] },
      guard: { submissionWindowOpen: false, documentCharsetRead: true, responseDeliveryCanceled: false, blockedByOtherRulesInWindow: 0 },
    });
    expect(evidence.response?.judgedAt).toMatch(/^[0-9]{14}$/u);
    expect(Number(evidence.response?.judgedAt)).toBeGreaterThanOrEqual(Number(evidence.submission.submittedAt));
    expect(Object.values(evidence.guard?.blockedByPayloadReason ?? {}).every((count) => count === 0)).toBe(true);
    expect(run.report.approvalSummary).toMatchObject({ scenario: { kind: 'CREATE' }, grantAtStart: { grantId: 'grant-w' } });
  }, TEST_TIMEOUT_MS);

  if (!tls) {
    // http の回: すべての結果の種類と、送らない回（https の回は、下の DEF-099 fix の回だけ）。
    it.each<[WriteSiteMode, Partial<ActionRunDocument>]>([
      ['input-error', { responseJudgement: 'INPUT_ERROR', result: 'FAILED', reason: 'INPUT_ERROR', reservationState: 'COMMITTED' }],
      ['rate-limited', { httpStatus: 429, responseJudgement: 'RATE_LIMITED', result: 'FAILED', reason: 'RATE_LIMITED' }],
      ['server-error', { httpStatus: 500, responseJudgement: 'SERVER_ERROR', result: 'UNKNOWN', reason: 'SERVER_ERROR' }],
      ['no-condition', { responseJudgement: 'NO_CONDITION_MATCHED', result: 'UNKNOWN', reason: 'NO_CONDITION_MATCHED' }],
      ['both-conditions', { responseJudgement: 'MULTIPLE_CONDITIONS_MATCHED', result: 'UNKNOWN', reason: 'MULTIPLE_CONDITIONS_MATCHED' }],
      ['no-record-id', { responseJudgement: 'SUCCESS', recordId: null, result: 'PARTIAL', reason: 'RECORD_ID_NOT_FOUND' }],
      ['unsafe-record-id', { responseJudgement: 'SUCCESS', recordId: 'a.b', result: 'PARTIAL', reason: 'RECORD_ID_UNSAFE' }],
      ['read-mismatch', { responseJudgement: 'SUCCESS', readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, result: 'NOT_MATCHED' },
        result: 'UNKNOWN', reason: 'READ_VERIFICATION_NOT_MATCHED' }],
      ['repost-307', { httpStatus: 307, responseJudgement: 'REPOST_REDIRECT', result: 'UNKNOWN', reason: 'REPOST_REDIRECT' }],
    ])('judges the %s response after sending once', async (mode, expected) => {
      const run = await runWrite(mode);
      expectedPosts += 1;
      expect(run.document).toMatchObject({ submission: 'SENT', blockReason: null, reservationState: 'COMMITTED', ...expected });
    }, TEST_TIMEOUT_MS);

    it.each<[string, WriteSiteMode, (() => Promise<WorkerWriteRecheckOutcome>) | undefined, 'PRECHECK_FAILED' | 'PAYLOAD_MISMATCH']>([
      ['the form page whose candidate digests differ from the approval', 'form-changed', undefined, 'PRECHECK_FAILED'],
      ['a recheck that the parent rejects', 'success', () => Promise.resolve({ allowed: false, reason: 'GRANT_INVALID' }), 'PRECHECK_FAILED'],
      ['a recheck that times out', 'success', () => Promise.resolve({ allowed: false, reason: 'RECHECK_TIMEOUT' }), 'PRECHECK_FAILED'],
      ['a field that the page adds before the submission', 'js-field', undefined, 'PAYLOAD_MISMATCH'],
      ['a value that the page changes before the submission', 'js-value', undefined, 'PAYLOAD_MISMATCH'],
      ['a form that the page replaces while filling', 'js-replace', undefined, 'PRECHECK_FAILED'],
      ['a submission that the page moves to a popup', 'js-popup', undefined, 'PRECHECK_FAILED'],
    ])('does not send %s, and writes BLOCKED', async (_label, mode, recheck, blockReason) => {
      const run = await runWrite(mode, recheck);
      expect(run.document).toMatchObject({
        submission: 'NOT_SENT', blockReason, httpStatus: null, responseJudgement: null, recordId: null, readVerification: null, submittedAt: null,
        reservationState: 'RELEASED', result: 'BLOCKED', reason: blockReason,
      });
      // T32e: 送らなかった回も報告を書く（送った値は空、応答と照合の READ の証拠はない）。
      const { evidence } = run.report;
      expect(evidence).toMatchObject({
        precheck: { blockReason }, submission: { state: 'NOT_SENT', submittedValues: {}, actionPath: null, submittedAt: null }, response: null,
        recordId: null, readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, state: 'NOT_EXECUTED' }, result: 'BLOCKED',
      });
      if (mode === 'form-changed') {
        // 画面の候補の digest が承認と違う: 書き込みの段に入らない（Guard の要約はない）。
        expect(evidence.precheck.candidateDigestMatched).toBe(false);
        expect(evidence.guard).toBeNull();
      } else {
        expect(evidence.precheck.candidateDigestMatched).toBe(true);
        expect(evidence.guard).not.toBeNull();
      }
      if (blockReason === 'PAYLOAD_MISMATCH') {
        expect(Object.values(evidence.guard?.blockedByPayloadReason ?? {}).some((count) => count > 0)).toBe(true);
      }
    }, TEST_TIMEOUT_MS);

    // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 値を入れる間は送信の窓の観察の段で、ページの JS が入力の事象で承認どおりの form の POST を出しても、
    // Guard は通さずに止めて数える（送り手に渡さない）。押す直前の確かめ直しが拒んでも許しても、POST は届かず、押さずに `PRECHECK_FAILED`。
    it.each<[string, (() => Promise<WorkerWriteRecheckOutcome>) | undefined]>([
      ['the recheck rejects', () => Promise.resolve({ allowed: false, reason: 'GRANT_INVALID' })],
      ['the recheck allows', undefined],
    ])('does not send the form that the page script submits on the input events while values are typed (%s)', async (_label, recheck) => {
      const run = await runWrite('js-submit-on-input', recheck);
      expect(run.document).toMatchObject({
        submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', httpStatus: null, recordId: null, reservationState: 'RELEASED', result: 'BLOCKED',
      });
      // 止めた証拠: 窓の中で、今の判定で止めた要求を数えた。
      expect(run.report.evidence.guard?.blockedByOtherRulesInWindow ?? 0).toBeGreaterThan(0);
    }, TEST_TIMEOUT_MS);

    // T40R-fix-A2（Task 40 の設計書 7 章の「T40R-fix-A・B の報告」）: 成功の条件に当たる画面が書き込みの画面（`/members/new`）のままで、その path が ID の
    // 型（`/members/{id}`）に当たる。押す前の画面から同じ取り方で取れた値（`new`）は ID として使わない（`RECORD_ID_NOT_FOUND`。成功と偽らない）。
    it('does not take the value that the form page itself gives by the record id pattern before the click, and writes PARTIAL', async () => {
      const run = await runWrite('stay-on-form');
      expectedPosts += 1;
      expect(run.document).toMatchObject({
        submission: 'SENT', blockReason: null, responseJudgement: 'SUCCESS', recordId: null, reservationState: 'COMMITTED', result: 'PARTIAL',
        reason: 'RECORD_ID_NOT_FOUND',
      });
    }, TEST_TIMEOUT_MS);

    it('DEF-098: sends the form with optional fields once, leaving the unchosen fields empty and unchecked, and writes VERIFIED', async () => {
      const run = await runWrite('success', undefined, 'optional');
      expectedPosts += 1;
      expect(run.document).toMatchObject({
        submission: 'SENT', blockReason: null, responseJudgement: 'SUCCESS', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED',
        reservationState: 'COMMITTED', submittedValues: { name: nameOf('success', 'optional') },
      });
      const body = new URLSearchParams(site.postBodies.at(-1) ?? '');
      expect([...body.keys()]).toEqual(['csrf_token', 'name', 'nickname', 'memo', 'notify', 'serial']);
      expect(body.get('name')).toBe(nameOf('success', 'optional'));
      expect([body.get('nickname'), body.get('memo')]).toEqual(['', '']);
      expect(body.getAll('notify')).toEqual(['0']);
    }, TEST_TIMEOUT_MS);

    it.each<[string, WriteSiteMode]>([
      ['a value that the page puts in an unchosen text field', 'js-optional-text'],
      ['an unchosen checkbox that the page checks', 'js-optional-check'],
    ])('DEF-098: does not send %s, and writes BLOCKED', async (_label, mode) => {
      const run = await runWrite(mode, undefined, 'optional');
      expect(run.document).toMatchObject({
        submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', httpStatus: null, reservationState: 'RELEASED', result: 'BLOCKED',
      });
    }, TEST_TIMEOUT_MS);
  }

  // T31R-fix-1（C-1。DEF-108）: 秘密に見えない hidden・readonly の欄は、画面の確かめで読んだ値で照らす。ページの JS が送信の前に hidden の
  // `owner_id`、readonly の `member_no` を書き換えると、POST は届かない。CSRF の hidden（秘密に見える名前）は今どおり名前だけで照らすので、
  // 書き換えても届く（この限界は手順書に書く）。
  if (!tls) {
    it.each<[string, WriteSiteMode]>([
      ['the hidden owner_id', 'js-owner'],
      ['the readonly member_no', 'js-member-no'],
    ])('C-1: does not send when the page script rewrites %s, and writes BLOCKED', async (_label, mode) => {
      const before = site.postBodies.length;
      const run = await runWrite(mode);
      expect(site.postBodies.length - before).toBe(0);
      expect(run.document).toMatchObject({
        submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', httpStatus: null, reservationState: 'RELEASED', result: 'BLOCKED',
      });
    }, TEST_TIMEOUT_MS);

    // T31R2-fix-1（C-1。DEF-108 の残り）: 見えない checkbox をチェックする、見えない select を選び直す、disabled の hidden を有効にして値を入れる
    // （T31R2 の E8 の形）は、届かない。秘密に見える名前の一覧に当たる一般の名前の hidden（`code`・`key`）がある画面は、期待を作らず送らない。
    it.each<[string, WriteSiteMode]>([
      ['the invisible checkbox that the page script checks', 'js-hidden-checkbox'],
      ['the invisible select that the page script changes', 'js-hidden-select'],
      ['the disabled hidden that the page script enables with a value', 'js-enable-disabled'],
    ])('C-1 (T31R2): does not send %s, and writes BLOCKED', async (_label, mode) => {
      const before = site.postBodies.length;
      const run = await runWrite(mode);
      expect(site.postBodies.length - before).toBe(0);
      expect(run.document).toMatchObject({
        submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', httpStatus: null, reservationState: 'RELEASED', result: 'BLOCKED',
      });
    }, TEST_TIMEOUT_MS);

    it('C-1 (T31R2): does not send on a form with the hidden code and key (secret-like names other than the page-issued tokens)', async () => {
      site.setSecretHiddenFields(true);
      try {
        const [secretCandidate] = await readCandidates();
        const before = site.postBodies.length;
        const run = await runWrite('success', undefined, 'default', true, { candidate: secretCandidate });
        expect(site.postBodies.length - before).toBe(0);
        expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', reservationState: 'RELEASED', result: 'BLOCKED' });
        expect(run.rechecks).toBe(0);
      } finally {
        site.setSecretHiddenFields(false);
      }
    }, TEST_TIMEOUT_MS);

    it('C-1: still sends when the page script rewrites the CSRF hidden (checked by the name only)', async () => {
      const before = site.postBodies.length;
      const run = await runWrite('js-csrf');
      expectedPosts += 1;
      expect(site.postBodies.length - before).toBe(1);
      expect(run.document).toMatchObject({ submission: 'SENT' });
    }, TEST_TIMEOUT_MS);
  }

  // T30R-fix-1（DEF-103）: 送る直前の確かめ直しは、押す前の最後の待ちと止める印の確かめの後（押す直前）。最後の待ちの間に止める印が来る・承認が
  // 撤回されると、押さない（POST 0、`NOT_SENT`・`BLOCKED`・`RELEASED`）。成功の回で、確かめ直しの答えから POST が届くまでの時間（残る窓）を測る。
  if (!tls) {
    it('DEF-103: does not send when the stop signal comes during the last wait before the click', async () => {
      const before = site.postBodies.length;
      const stop = new AbortController();
      const run = await runWrite('success', undefined, 'default', true, { stop, onNavigation: (index) => {
        if (index === PRE_CLICK_NAVIGATION_INDEX) {
          stop.abort();
        }
      } });
      expect(site.postBodies.length - before).toBe(0);
      expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', reservationState: 'RELEASED', result: 'BLOCKED' });
    }, TEST_TIMEOUT_MS);

    it('DEF-103: does not send when the approval is revoked during the last wait before the click (the recheck comes after the wait)', async () => {
      const before = site.postBodies.length;
      let revoked = false;
      const run = await runWrite('success', () => Promise.resolve(revoked ? { allowed: false, reason: 'GRANT_INVALID' } : ALLOWED), 'default', true, {
        onNavigation: (index) => {
          if (index === PRE_CLICK_NAVIGATION_INDEX) {
            revoked = true;
          }
        },
      });
      expect(site.postBodies.length - before).toBe(0);
      expect(run.rechecks).toBe(1);
      expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', reservationState: 'RELEASED', result: 'BLOCKED' });
    }, TEST_TIMEOUT_MS);

    it('DEF-103: measures the window from the recheck answer to the POST arrival', async () => {
      const run = await runWrite('success', undefined, 'default', true, {});
      expectedPosts += 1;
      expect(run.document.submission).toBe('SENT');
      const post = site.requests.filter(({ method }) => method === 'POST').at(-1);
      const windowMs = (post?.at ?? Number.NaN) - (run.recheckResolvedAt ?? Number.NaN);
      process.stdout.write(`DEF-103 window (${_name}): ${windowMs} ms
`);
      expect(windowMs).toBeGreaterThanOrEqual(0);
      expect(windowMs).toBeLessThan(RECHECK_TO_POST_WINDOW_LIMIT_MS);
    }, TEST_TIMEOUT_MS);
  }

  if (!tls) {
    // T30R2-fix-1（M-b）: 送り手が送っている間（応答が遅い）に、ページの JS が GET で登録の画面（成功の条件に当たる形）へ移る。ブラウザは POST の
    // 要求を取り消すので、送り手の応答はブラウザに返らず、今の画面は POST の応答ではない。その画面で成功の条件と ID を判定せず、`UNKNOWN`
    // （`RESPONSE_NOT_DELIVERED`）にする（`VERIFIED` にしない）。POST は 1 件。
    it('M-b: does not judge the page that the page script opened while the response was slow, and writes UNKNOWN (RESPONSE_NOT_DELIVERED)', async () => {
      const before = site.postBodies.length;
      const run = await runWrite('js-navigate-slow');
      expectedPosts += 1;
      expect(site.postBodies.length - before).toBe(1);
      expect(run.document.result).not.toBe('VERIFIED');
      expect(run.document).toMatchObject({
        submission: 'SENT', blockReason: null, httpStatus: 303, responseJudgement: 'RESPONSE_NOT_DELIVERED', recordId: null, readVerification: null,
        result: 'UNKNOWN', reason: 'RESPONSE_NOT_DELIVERED',
      });
      expect(run.starts).toHaveLength(3);
    }, TEST_TIMEOUT_MS);
  }

  // DEF-099 fix: 応答の前に接続が切れても、POST は 1 件（BeakSight が 1 回だけ送る。ブラウザの自動の送り直しがない）。
  it('DEF-099: sends once when the connection closes before a response, and writes UNKNOWN (NO_RESPONSE)', async () => {
    const before = site.postBodies.length;
    const run = await runWrite('connection-drop');
    expectedPosts += 1;
    expect(site.postBodies.length - before).toBe(1);
    expect(run.document).toMatchObject({
      submission: 'SENT', blockReason: null, httpStatus: null, responseJudgement: null, recordId: null, readVerification: null,
      reservationState: 'UNKNOWN', result: 'UNKNOWN', reason: 'NO_RESPONSE',
    });
  }, TEST_TIMEOUT_MS);

  if (tls) {
    // DEF-099 fix: 送り手が証明書を信頼しない（製品の確かめだけ）→ 要求の bytes を書く前に止まり、送らない。
    it('DEF-099: does not send when the sender does not trust the certificate, and writes BLOCKED', async () => {
      const before = site.postBodies.length;
      const run = await runWrite('success', undefined, 'default', false);
      expect(site.postBodies.length - before).toBe(0);
      expect(run.document).toMatchObject({
        submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', httpStatus: null, reservationState: 'RELEASED', result: 'BLOCKED',
      });
    }, TEST_TIMEOUT_MS);
  }

  it('after all the runs, no POST arrives late (counted again after a named wait)', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(site.postBodies.length).toBe(expectedPosts);
    // http: 成功・結果の種類・任意の欄の 11 件と、DEF-103 の窓の 1 件、M-b の 1 件、接続が切れる回の 1 件。https: 成功と、接続が切れる回。
    // T31R-fix-1（C-1）: CSRF の hidden を書き換えた回の 1 件を足した。
    // T40R-fix-A2: http の回に、書き込みの画面に戻る形の 1 回を足した（15 から 16）。
    expect(expectedPosts).toBe(tls ? 2 : 16);
  }, TEST_TIMEOUT_MS);
});

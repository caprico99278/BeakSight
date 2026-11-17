// T30f（Task 30 の設計書 3 章、4 章の「読み込みの回数と間隔」、6 章）: 書き込みのジョブの流れ（`src/worker/write-create-run.ts` の
// `executeWriteCreateRun`）を、同じ process の中で、本物の Chromium（テストの既定の headless）と 127.0.0.1 の fixture の
// サイト（`tests/helpers/write-site-fixture.ts`）で確かめる結合テスト。ログインの段は通さず、fixture が作ったセッションを、認証つきの Run の指定
// （メモリの状態）で渡す。IPC の 2 つの口（確かめ直し、送信の報告）は、テストが偽の親として受ける。
// - 承認に縛った候補の 2 つの digest と、照合の READ の対象の識別の digest は、本物の発見の入口（`readCandidatePage`）で読んだ候補から取る。
// - 終わりまでの流れ: 成功 → `VERIFIED`（ID あり、READ 一致）、同じ form の入力の誤り → `FAILED`、ID が取れない → `PARTIAL`、READ の不一致 → `UNKNOWN`
//   （`actionOutcomeOf` のとおり。SLIM W-3: ほかの結果の種類は単体 `form-result-judgement`・`action-outcome` が確かめる）。
//   PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1）: 判定は構造の判定 (b2)。入力の誤りは、4xx か、送った値を保った同じフォームがもう一度出た
//   ときだけ（form のない誤りの画面は判定できない）。答え合わせの READ が一致すれば成功の側（2 つの条件に当たった画面も）。送る前に答え合わせの READ を
//   読み、値がもう見えている・読めないときは送らない。
// - 送らない: 画面の digest の不一致、確かめ直しの拒否・時間切れ、ページの JS が送信の前に欄を足す・値を変える・form を差し替える・送信の先を新しい
//   窓にする（サーバの POST の記録で数え、全部の回の後に 2 秒待って数え直す）。
// - `action-run.json` がスキーマに合い、秘密の目印（セッションの値、CSRF のトークン、readonly の値）を含まない。送信の報告は 1 回で、成果物と同じ。
// - 読み込みの間隔: 読み込みの開始どうしの間が、設定の `crawl.minNavigationIntervalMs` 以上。
// - DEF-099 fix: 承認の POST は BeakSight（`src/safety/write-submission-sender.ts`）が中継を通して 1 回だけ送る。応答の前に接続が切れても POST は
//   1 件で、`UNKNOWN`（`NO_RESPONSE`）・予約 `UNKNOWN`。https（テストだけの自前の証明書）では、成功の回を確かめ、送り手が証明書を
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
import type { AuditConfig } from '../../src/config/types.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import type { WorkerStartWrite } from '../../src/control/worker-protocol.js';
import { ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { wait } from '../../src/core/deadline.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createNavigationPacer, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeWriteCreateRun, type WriteCreateRunOutcome } from '../../src/worker/write-create-run.js';
import type { WorkerWriteRecheckOutcome, WorkerWriteSubmissionReport } from '../../src/worker/write-ipc.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { browserSharedForRun } from '../helpers/browser-proxies.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { LOOPBACK_TEST_CERTIFICATE, TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS } from '../helpers/tls-test-certificate.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS, TEST_WRITE_RESULT_QUIET_LIMIT_MS } from '../helpers/test-waits.js';
import { readWriteReportFiles, type WriteReportFiles } from '../helpers/write-report-checks.js';
import { readWriteSiteCandidates, writeSiteRunAuthenticationOf, type WriteSiteCandidates } from '../helpers/write-site-candidates.js';
import {
  WRITE_SITE_PATHS,
  startWriteSite,
  type WriteSite,
  type WriteSiteMode,
} from '../helpers/write-site-fixture.js';

/** テストの既定の Chromium で、http と https（DEF-099 fix）。 */
const CASES = [
  ['the default test Chromium over http', () => launchHeadlessChromium(), false],
  ['the default test Chromium over https', () => launchHeadlessChromium({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS }), true],
] as const;
const TEST_TIMEOUT_MS = 120_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
const NAME_VALUE = '山田 太郎';
const EMAIL_VALUE = 'sample0001@example.invalid';
const ALLOWED: WorkerWriteRecheckOutcome = Object.freeze({ allowed: true });
/**
 * T30R-fix-1（DEF-103）: 押す前の最後の待ちの読み込みの番号（画面の確かめ 0、書き込みの画面 1、押す前 2）。PL-6a: 送る前の答え合わせの READ（対象の画面と
 * READ の URL）を、画面の確かめの後に足した（画面の確かめ 0、答え合わせ 1・2、書き込みの画面 3、押す前 4）。
 */
const PRE_CLICK_NAVIGATION_INDEX = 4;
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
    ({ form: formCandidate, search: searchCandidate, optional: optionalCandidate } = await readCandidates());
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

  /**
   * 出力先（REV-RB8911 M-3 の流し直しで、速くなった回が前の回と同じ秒に始まり、同じ出力先の Run のディレクトリの名前が重なった。回ごとに出力先を分ける。
   * `read-check-run.test.ts` と同じ形）。
   */
  const configFor = (runName = 'candidates'): AuditConfig => createTestConfig(site.origin, WRITE_SITE_PATHS.form, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    audit: { screenshots: false },
    output: { directory: join(outputDirectory, runName) },
  });

  const authenticationFor = (): RunAuthentication => writeSiteRunAuthenticationOf(site.origin, sessionValue);

  /** 本物の発見の入口で、書き込みの画面と一覧の画面の候補を読む（承認に縛る digest を手で書かない。`write-site-candidates.ts`）。 */
  const readCandidates = (): Promise<WriteSiteCandidates> => readWriteSiteCandidates(browser, configFor(), authenticationFor());

  /** 書き込みの画面（既定の画面か、DEF-098 の任意の欄のある画面）。 */
  type WriteForm = 'default' | 'optional';

  /**
   * 生成した名前（回ごとに別の値。照合の READ の行が、ほかの回の登録と混ざらない）。PL-6a: 送る前の答え合わせの READ が、前の回の登録の値を見つけて送らずに
   * 止めないように、回の番号（3 桁。ほかの回の名前を含まない）で作る。形の名前は入れない（`js-enable-disabled` の語が、READ の送る値の危険な語に当たり、
   * 答え合わせを読まずに止めるため）。
   */
  let runSequence = 0;
  const nameOf = (form: WriteForm = 'default'): string => {
    runSequence += 1;
    const run = `r${String(runSequence).padStart(3, '0')}`;
    return form === 'default' ? `${NAME_VALUE} ${run}` : `${NAME_VALUE} ${form} ${run}`;
  };

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
        resultJudgement: 'FORM_STRUCTURE',
        recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: [`${WRITE_SITE_PATHS.create}/{id}`] },
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
    /** PL-6a: この回の生成した名前（照合の READ の検索の値）。 */
    readonly name: string;
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
    hooks: {
      readonly onNavigation?: (index: number) => void;
      readonly stop?: AbortController;
      readonly candidate?: DiscoveryCandidate;
    } = {},
  ): Promise<Run> => {
    site.setMode(mode);
    const name = nameOf(form);
    const config: AuditConfig = configFor(`run-${String(runSequence)}`);
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
    const write = writeSpecOf(name, form, hooks.candidate);
    const outcome = await executeWriteCreateRun({
      config,
      jobId: `job-${mode}`,
      authentication: authenticationFor(),
      write,
      // SLIM-2（X7）: 流れごとに Chromium を起こさず、この組の Browser を共有する（Context は流れごと）。
      launchBrowser: async () => browserSharedForRun(browser),
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
      // REV-RB8911 M-3（DEF-280）: 混んでいても応答を待てる長さ（テストの設定の置き場所 `test-waits.ts`）。
      resultTimeoutMs: TEST_WRITE_RESULT_QUIET_LIMIT_MS,
      writeSubmissionCertificates: trusted ? [LOOPBACK_TEST_CERTIFICATE] : [],
      // TEST-TIME-B: 押した後の静まりの窓を短くする（押した後に遅れて動く fixture の遅れは、この窓より短い）。
      observationWindows: TEST_OBSERVATION_WINDOWS,
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
    return { name, outcome, document, report, reports, rechecks, starts, recheckResolvedAt };
  };

  it('sends the approved POST once, judges SUCCESS, takes the record id, verifies it by the READ, and writes VERIFIED', async () => {
    const run = await runWrite('success');
    expectedPosts += 1;
    expect(run.document).toMatchObject({
      submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId: String(1001),
      readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, result: 'MATCHED' }, reservationState: 'COMMITTED',
      result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', submittedValues: { name: run.name, email: EMAIL_VALUE },
    });
    expect(run.outcome).toMatchObject({ runStatus: 'COMPLETE', result: 'VERIFIED' });
    expect(run.rechecks).toBe(1);
    const body = new URLSearchParams(site.postBodies.at(-1) ?? '');
    expect(body.get('name')).toBe(run.name);
    expect(body.get('email')).toBe(EMAIL_VALUE);
    expect(body.has('newsletter')).toBe(false);
    expect(body.get('csrf_token')).toBe(site.csrfMarker);
    // 読み込み: 画面の確かめ、送る前の答え合わせの READ の対象の画面と READ の URL（PL-6a）、書き込みの画面、押す、照合の READ の対象の画面と READ の URL
    // （7 回。読み込み直しはしない）。
    expect(run.starts).toHaveLength(7);
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
    // PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1。構造の判定 (b2)）: 成否は人が入れた条件ではなく、答え合わせの READ と、送った値を保った同じ
    // フォームの形と、URL の ID の型（数字・UUID の形の区切りだけ）で決める。form のない誤りの画面（`input-error`）は判定できない（入力の誤りと言わない）。
    // 登録した後の、ID のない画面（`no-condition`）と、条件が 2 つ当たった画面（`both-conditions`）は、答え合わせが一致するので成功の側。ID の形でない区切り
    // （`a.b`）は ID にしない。同じ form が送った値を保って出たら（200・422・後から JS で描く）入力の誤り、値を消したら判定できない。
    // SLIM W-3: 結果の種類ごとの判定の表は単体（`tests/unit/form-result-judgement.test.ts`・`tests/unit/action-outcome.test.ts`）が確かめる。ここは本物の
    // 画面の読み取りから判定へ渡る代表（同じ form の入力の誤り・照合の不一致・ID の取れない成功）だけ。
    // RB-11: 本物の画面の読み取りから判定へ渡る代表（ID の取れない成功・照合の不一致・同じ form の入力の誤り）は、送った後の画面の観察の順
    // （`write-stage-steps` の `formResultStepOf`）、観察からの判定（`form-result-judgement`）、照合の選び方（`write-run-loop`）の単体に移した。
    // RB-11: LU-SFIX2-B（照合の READ の Context に、書き込みの段でページが保存した localStorage を渡さない）は、`api-list-row-update-run` の 1 か所に寄せた。

    // PL-6a（設計書 8.1 の「事前の確かめ」）: 送る前に、同じ値で答え合わせの READ を 1 回読む。値がもう見えていれば（同じ名前の会員がもういる）、送らずに
    // 止める（`VALUE_ALREADY_PRESENT`）。一覧を読めなければ、送った後の照合もできないので送らない（`VERIFICATION_READ_UNAVAILABLE`）。どちらも POST は 0 件で、
    // 予約は返す。読み込みは、画面の確かめと答え合わせの 2 回（読み込み直しはしない）。
    // RB-11: 送る前の答え合わせの READ で止める場面（値がもう見える・READ の画面が読めない）は、止める判定（`form-result-judgement` の送る前の確かめ）と、
    // 書き込みの段を開かない順（`write-run-loop`）の単体に移した。

    it.each<[string, WriteSiteMode, (() => Promise<WorkerWriteRecheckOutcome>) | undefined, 'PRECHECK_FAILED' | 'PAYLOAD_MISMATCH']>([
      ['the form page whose candidate digests differ from the approval', 'form-changed', undefined, 'PRECHECK_FAILED'],
      ['a recheck that the parent rejects', 'success', () => Promise.resolve({ allowed: false, reason: 'GRANT_INVALID' }), 'PRECHECK_FAILED'],
      ['a recheck that times out', 'success', () => Promise.resolve({ allowed: false, reason: 'RECHECK_TIMEOUT' }), 'PRECHECK_FAILED'],
      // RB-14a: ページが足した欄・変えた値の照合（js-field・js-value）は、guard-write-stage（照合の段）と単体 write-run-loop（PAYLOAD_MISMATCH の記録）が確かめる。
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
        // OP-L（L1）: どこが違ったかを、値を含まない形で残す（欄が増えたので、承認の識別と同じ候補が画面にない）。
        expect(evidence.precheck.candidateMismatch).toEqual({ reason: 'IDENTITY_NOT_FOUND', pageCandidateCount: expect.any(Number), sameIdentityCount: 0, fieldPosition: null });
      } else {
        expect(evidence.precheck.candidateDigestMatched).toBe(true);
        expect(evidence.guard).not.toBeNull();
      }
      if (mode === 'js-replace') {
        // OP-O（O1）: 値を入れる間に form が入れ替わった。段と理由を、値を含まない形で残す（form の欄の位置は分からない）。
        expect(evidence.precheck.inputFailure).toEqual({
          stage: 'FILL', reason: 'FORM_CHANGED', fieldPosition: null, fieldType: null, fieldAttributes: null, valueChange: null,
        });
      }
    }, TEST_TIMEOUT_MS);

    // RB-14a: 値を入れる間にページの JS が出す承認どおりの form の POST を止めること（T40R-fix-A）は guard-write-stage（窓を開かない POST・ページが自分で
    // 送る要求）が、止めたら押さない判定（`UNEXPECTED_REQUEST`）は単体 write-stage-steps（`submissionWindowVerdictOf`）が確かめる。

    // T40R-fix-A2（Task 40 の設計書 7 章の「T40R-fix-A・B の報告」）: 成功の条件に当たる画面が書き込みの画面（`/members/new`）のままで、その path が ID の
    // 型（`/members/{id}`）に当たる。押す前の画面から同じ取り方で取れた値（`new`）は ID として使わない（`RECORD_ID_NOT_FOUND`。成功と偽らない）。
    // PL-5 の 9 の (4)（設計書 8.1 の「登録の ID の取り方」の行）: 下書きが ID の取り方を決められなかった（null）書き込みの指定は、送った後の URL に ID が
    // あっても取らず、答え合わせが一致しても ID なしの `PARTIAL`（`RECORD_ID_NOT_FOUND`。`VERIFIED` と言わない）。送るのは 1 回。
    // RB-11: ID の取り方が null の指定と、押す前の画面が ID の型に当たる場面（どちらも ID なしの PARTIAL）は、URL からの ID の取り方
    // （`form-result-judgement` の `recordIdOfResultUrl`）と、ID の取り方のない書き込み（`form-write-without-record-id`）の単体に移した。
    // SLIM W-3: L12b（結果の待ちの上限・ID の長さの上限の撤廃、押した後にページが移る形）の場面は消した（撤廃した上限の名残。撤廃は Gate の grep で確かめる）。

    // RB-11: DEF-098 の任意の欄を空・未選択で送る入力の部品のふるまいは、write-form-submitter と単体 write-form-unselected-fields が確かめる。

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
        const { form: secretCandidate } = await readCandidates();
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

  // RB-11: M-b（遅い応答の間にページが移り、応答をページに返せなかった）の段の輪の反応は `write-run-loop`、観察の順は `write-stage-steps` の
  // `formResultStepOf`、取り消しの観察は guard-write-stage（223）が確かめる。

  // RB-11: DEF-099 の送り手のふるまい（応答の前の切断で 1 回だけ送る、証明書を信頼しなければ書かない）は write-submission-sender と guard-write-stage が、
  // 応答のない送信の記録は write-run-loop が確かめる。

  // RB-11（再構築の設計書 2 章 3）: 全部の回の後に遅れて届く POST の数え直しは、ずれの確かめと guard-write-stage の 1 か所に集めた（ここでは数えない）。
});

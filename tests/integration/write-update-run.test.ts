// T31g-2（Task 31 の設計書 3 章の「更新の前の読み取り」「送信」「結果の判定」「更新の後の照合」「証拠と記録」、4 章の「読み込みの回数と間隔」）:
// 更新の書き込みのジョブの流れ（`src/worker/write-create-run.ts` の `executeWriteCreateRun` が、`write.update` を持つ指定で UPDATE を行う）を、
// 同じ process の中で、本物の Chromium（headless だけ。テストの既定と、CLI の起動の設定の両方）と 127.0.0.1 の fixture のサイト
// （`tests/helpers/write-site-fixture.ts` の更新の画面）で確かめる結合テスト。ログインの段は通さず、fixture が作ったセッションを渡す。IPC の 2 つの口
// （確かめ直し、送信の報告）は、テストが偽の親として受ける。
// - 承認に縛る型にした識別の digest と規則の digest、照合の READ の対象の識別の digest は、本物の発見の入口（`readCandidatePage`）で読んだ候補から取る。
// - 成功 → `VERIFIED`（証拠の `CHANGED` は前の値と新しい値、`KEPT` は値なし、どの欄も一致）。サーバが保つ欄・状態も変える → `UNKNOWN`
//   （`UNEXPECTED_FIELD_CHANGE`）。成功の画面の ID が対象と違う → `UNKNOWN`（`RECORD_ID_MISMATCH`）。更新の後に更新の画面が開けない → `PARTIAL`
//   （`UPDATE_POSTCHECK_UNDETERMINED`）。
// - 送らない（POST 0）: 前の読み取りと書き込みの画面の間に値が変わる、ページの JS が送信の前に保つ欄・状態の hidden・組の hidden・`_method` を
//   変える、確かめ直しの拒否、止める印、変える欄の前の値が証拠の長さの上限を超える。サーバの記録で回ごとに数え、全部の回の後に 2 秒待って数え直す。
// - `action-run.json` がスキーマに合い、秘密の目印（セッションの値、CSRF、`lock_version`）と保つ欄の値を含まない。送信の報告は 1 回で、成果物と同じ。
// - 読み込み: 前の読み取り、書き込みの画面、押す（POST と redirect）、後の読み取り、照合の READ（対象の画面と READ の URL）。開始どうしの間は、設定の
//   `crawl.minNavigationIntervalMs` 以上。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { MAX_SUBMITTED_VALUE_LENGTH, type ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/control/auth/auth-setup-contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartWrite } from '../../src/control/worker-protocol.js';
import { ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { wait } from '../../src/core/deadline.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createNavigationPacer, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { templatedIdentityDigestForRecordIdOf } from '../../src/discovery/fingerprint.js';
import { readCandidatePage } from '../../src/discovery/read-executor.js';
import { InFlightRequestCounter } from '../../src/discovery/settle.js';
import { authenticatedContextOptions, type RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeWriteCreateRun, type WriteCreateRunOutcome } from '../../src/worker/write-create-run.js';
import type { WorkerWriteRecheckOutcome, WorkerWriteSubmissionReport } from '../../src/worker/write-ipc.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { readWriteReportFiles, type WriteReportFiles } from '../helpers/write-report-checks.js';
import {
  WRITE_SITE_MEMBER_DEFAULTS,
  WRITE_SITE_PATHS,
  WRITE_SITE_SESSION_COOKIE,
  startWriteSite,
  writeSiteEditPathOf,
  writeSiteRecordPathOf,
  type WriteSite,
  type WriteSiteUpdateMode,
} from '../helpers/write-site-fixture.js';

const LAUNCHES = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const TEST_TIMEOUT_MS = 120_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
/** 押した後に結果を待つ上限（ms）。 */
const RESULT_TIMEOUT_MS = 3_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const ALLOWED: WorkerWriteRecheckOutcome = Object.freeze({ allowed: true });
const CHANGED_FIELD_NAMES = ['name'] as const;
/** T31i: 保つ欄に、人の値（目印 `keptMarker`）の入った備考（`note`）を足した。 */
const KEPT_FIELD_NAMES = ['email', 'note', 'newsletter', 'published'] as const;
/** 成功の回の読み込みの数（前の読み取り、書き込みの画面、押す、後の読み取り、照合の READ の対象の画面と READ の URL）。 */
const SUCCESS_NAVIGATIONS = 6;

describe.each(LAUNCHES)('T31g-2: the update write job flow (%s)', (_name, launch) => {
  let browser: Browser;
  let site: WriteSite;
  let sessionValue: string;
  let outputDirectory: string;
  let editCandidate: DiscoveryCandidate;
  let searchCandidate: DiscoveryCandidate;
  let templatedDigest: string;
  /** これまでの回で、サーバに届いてよいと確かめた POST の数。 */
  let expectedPosts = 0;
  let round = 0;

  /** 回ごとに別の出力先（Run の ID は秒の単位なので、速く終わる回が続いても、Run のディレクトリが重ならない）。 */
  const configFor = (): AuditConfig => createTestConfig(site.origin, WRITE_SITE_PATHS.list, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    audit: { screenshots: false },
    output: { directory: join(outputDirectory, `round-${round}`) },
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

  /** 本物の発見の入口で、更新の画面と一覧の画面の候補を読む。 */
  async function readCandidates(memberId: number): Promise<[DiscoveryCandidate, DiscoveryCandidate]> {
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
    const edit = (await read(writeSiteEditPathOf(memberId))).find((candidate) => candidate.action?.path === writeSiteRecordPathOf(memberId));
    const search = (await read(WRITE_SITE_PATHS.list)).find((candidate) => candidate.formMethod === 'GET' && candidate.classification === 'READ');
    await factory.close();
    if (edit === undefined || search === undefined) {
      throw new Error('the fixture candidates were not found');
    }
    return [edit, search];
  }

  beforeAll(async () => {
    browser = await launch();
    site = await startWriteSite();
    site.enableUpdatePages();
    sessionValue = site.issueSession();
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-write-update-run-'));
    const first = site.addMember('候補 一郎');
    [editCandidate, searchCandidate] = await readCandidates(first);
    const digest = templatedIdentityDigestForRecordIdOf(editCandidate, String(first));
    if (digest === null) {
      throw new Error('the templated identity digest of the fixture was not computed');
    }
    templatedDigest = digest;
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  afterEach(() => {
    site.setUpdateMode('success');
    expect(site.postBodies.length, 'POSTs that reached the server').toBe(expectedPosts);
  });

  const writeSpecOf = (memberId: number, newName: string, candidateOverride?: DiscoveryCandidate, digestOverride?: string): WorkerStartWrite => ({
    scenarioId: 'scenario-u',
    scenarioRevision: 1,
    grantId: 'grant-u',
    profileId: 'example-write',
    seedRecord: {
      seed: 'e'.repeat(64) as never,
      seedInput: { profileId: 'example-write', scenarioId: 'scenario-u', scenarioRevision: 1, ruleSetDigest: `sha256:${'f'.repeat(64)}`, executionGrantId: 'grant-u' },
      baseDate: '2026-10-14',
      attempt: 0,
    },
    request: { formMethod: 'POST', methodOverride: 'PATCH', origin: site.origin, path: writeSiteRecordPathOf(memberId), enctype: 'application/x-www-form-urlencoded' },
    formPage: { origin: site.origin, path: writeSiteEditPathOf(memberId) },
    candidate: { identityDigest: (candidateOverride ?? editCandidate).identityDigest, ruleDigest: (candidateOverride ?? editCandidate).ruleDigest },
    candidateFields: (candidateOverride ?? editCandidate).fields.map(({ name, type, readonly, hidden, disabled }) => ({ name, type, readonly, hidden, disabled })),
    values: { name: newName },
    verification: {
      successCondition: { pathPrefix: `${WRITE_SITE_PATHS.create}/`, selector: '.registered' },
      inputErrorCondition: { pathPrefix: WRITE_SITE_PATHS.create, selector: '.error' },
      recordId: { source: 'URL_PATH_PATTERN', pathPattern: `${WRITE_SITE_PATHS.create}/{id}` },
    },
    readVerification: {
      readCheckId: 'rc-verify',
      readCheckRevision: 1,
      targetPage: { origin: searchCandidate.page.origin, path: searchCandidate.page.path },
      definition: { targetIdentityDigest: searchCandidate.identityDigest, parameters: { q: newName }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] },
    },
    update: {
      targetRecordId: String(memberId),
      templatedIdentityDigest: digestOverride ?? templatedDigest,
      changedFieldNames: [...CHANGED_FIELD_NAMES],
      keptFieldNames: [...KEPT_FIELD_NAMES],
    },
    // T32d: 承認の要約（ワーカーは照らさずに書き写す）。
    approvalFacts: sampleApprovalFacts({ kind: 'UPDATE', profileId: 'example-write', scenarioId: 'scenario-u', scenarioRevision: 1, grantId: 'grant-u' }),
  });

  interface Run {
    readonly outcome: WriteCreateRunOutcome;
    readonly document: ActionRunDocument;
    /** T32e: 書き込みの報告の 2 つの JSON（スキーマ・目印・`action-run.json` との一致・承認の要約を確かめた後）。 */
    readonly report: WriteReportFiles;
    readonly reports: readonly WorkerWriteSubmissionReport[];
    readonly rechecks: number;
    readonly starts: readonly number[];
    readonly memberId: number;
    readonly priorName: string;
    readonly newName: string;
  }

  /** 会員を足し、更新の流れを 1 回動かして、`action-run.json` を読んでスキーマで確かめる。 */
  const runUpdate = async (
    mode: WriteSiteUpdateMode,
    options: {
      readonly recheck?: () => Promise<WorkerWriteRecheckOutcome>;
      readonly stop?: AbortController;
      readonly priorName?: string;
      /** T31R2-fix-1: 承認した候補を替える（会員を足した後に、その会員の更新の画面から読む）。 */
      readonly candidateOf?: (memberId: number) => Promise<{ readonly candidate: DiscoveryCandidate; readonly digest: string }>;
    } = {},
  ): Promise<Run> => {
    round += 1;
    const priorName = options.priorName ?? `前の名前 ${round}`;
    const newName = `新しい名前 ${round}`;
    const memberId = site.addMember(priorName);
    const override = options.candidateOf === undefined ? undefined : await options.candidateOf(memberId);
    site.setUpdateMode(mode);
    const config = configFor();
    const reports: WorkerWriteSubmissionReport[] = [];
    const starts: number[] = [];
    let rechecks = 0;
    const inner = createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now: () => Date.now(), sleep: wait });
    const pacer: NavigationPacer = forwardingNavigationPacer(inner, async () => {
      const waited = await inner.beforeNavigation();
      starts.push(Date.now());
      return waited;
    });
    const write = writeSpecOf(memberId, newName, override?.candidate, override?.digest);
    const outcome = await executeWriteCreateRun({
      config,
      jobId: `job-update-${round}`,
      authentication: authenticationFor(),
      write,
      launchBrowser: launch,
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: options.stop?.signal ?? new AbortController().signal,
      recheck: async () => {
        rechecks += 1;
        return (options.recheck ?? (() => Promise.resolve(ALLOWED)))();
      },
      reportSubmission: (report) => reports.push(report),
      navigationPacer: pacer,
      resultTimeoutMs: RESULT_TIMEOUT_MS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the update run did not run: ${outcome.kind}`);
    }
    const text = readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8');
    expect(await validateArtifact('action-run', JSON.parse(text))).toEqual({ ok: true });
    for (const marker of [sessionValue, site.csrfMarker, site.lockMarker, site.keptMarker, WRITE_SITE_MEMBER_DEFAULTS.email]) {
      expect(text).not.toContain(marker);
    }
    const document = JSON.parse(text) as ActionRunDocument;
    // T32e: どの回も、書き込みの報告の 2 つの JSON ができ、スキーマに合い、秘密の目印と保つ欄の値を含まず、`action-run.json` と重なる値（UPDATE の
    // 前後の値を含む）が一致し、承認の要約は `START` の承認の要約の事実と同じ。
    const report = await readWriteReportFiles(outcome.runDirectory, document, {
      markers: [sessionValue, site.csrfMarker, site.lockMarker, site.keptMarker, WRITE_SITE_MEMBER_DEFAULTS.email],
      approvalFacts: write.approvalFacts,
    });
    expect(reports).toEqual([{ submission: document.submission, blockReason: document.blockReason }]);
    starts.slice(1).forEach((start, index) => {
      expect(start - (starts[index] ?? Number.NaN), `interval before navigation ${index + 1}`).toBeGreaterThanOrEqual(NAVIGATION_INTERVAL_MS);
    });
    return { outcome, document, report, reports, rechecks, starts, memberId, priorName, newName };
  };

  /** 保つ欄・状態の hidden・組の、値を持たない証拠（一致したか）。 */
  const keptEvidence = (matched: Readonly<Record<string, boolean | null>> = {}) => [...KEPT_FIELD_NAMES, 'active'].map((fieldName) => ({
    fieldName, role: 'KEPT', previousValue: null, newValue: null, matched: Object.hasOwn(matched, fieldName) ? matched[fieldName] : true,
  }));

  it('updates the target record and writes VERIFIED, with the prior and new values of the changed field and no value of the kept fields', async () => {
    const run = await runUpdate('success');
    expectedPosts += 1;
    expect(run.document).toMatchObject({
      submission: 'SENT', blockReason: null, httpStatus: 200, responseJudgement: 'SUCCESS', recordId: String(run.memberId),
      readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, result: 'MATCHED' }, reservationState: 'COMMITTED',
      result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', submittedValues: { name: run.newName },
    });
    expect(run.document.update).toEqual({
      targetRecordId: String(run.memberId),
      updateEvidence: { fields: [{ fieldName: 'name', role: 'CHANGED', previousValue: run.priorName, newValue: run.newName, matched: true }, ...keptEvidence()] },
    });
    expect(site.memberOf(run.memberId)).toMatchObject({ name: run.newName, email: WRITE_SITE_MEMBER_DEFAULTS.email, active: '1', published: true, newsletter: true });
    const body = new URLSearchParams(site.postBodies.at(-1) ?? '');
    expect(body.get('_method')).toBe('PATCH');
    expect(body.get('name')).toBe(run.newName);
    expect(body.get('email')).toBe(WRITE_SITE_MEMBER_DEFAULTS.email);
    expect(body.getAll('published')).toEqual(['0', '1']);
    expect(run.rechecks).toBe(1);
    expect(run.starts).toHaveLength(SUCCESS_NAVIGATIONS);
    expect(run.outcome).toMatchObject({ runStatus: 'COMPLETE', result: 'VERIFIED' });
    // T32e: 報告の証拠は、変えた欄の前の値（人の値でありうる）と新しい値、照合の READ の証拠の全体を持ち、人の値の印が真。
    const { evidence } = run.report;
    expect(evidence).toMatchObject({
      kind: 'UPDATE', containsHumanEnteredValues: true, precheck: { candidateDigestMatched: true, blockReason: null },
      submission: { state: 'SENT', actionPath: writeSiteRecordPathOf(run.memberId), submittedValues: { name: run.newName } },
      readVerification: { readCheckId: 'rc-verify', state: 'EXECUTED', result: 'MATCHED' },
      guard: { submissionWindowOpen: false, documentCharsetRead: true },
    });
    expect(evidence.update?.updateEvidence?.fields[0]).toEqual({
      fieldName: 'name', role: 'CHANGED', previousValue: run.priorName, newValue: run.newName, matched: true,
    });
    expect(run.report.approvalSummary).toMatchObject({ scenario: { kind: 'UPDATE' }, humanDecisions: expect.arrayContaining(['UPDATE_FIELD_ROLES']) });
  }, TEST_TIMEOUT_MS);

  it.each<[WriteSiteUpdateMode, string]>([
    ['server-changes-kept', 'email'],
    ['server-changes-state', 'active'],
  ])('writes UNKNOWN (UNEXPECTED_FIELD_CHANGE) when the server also changes a kept field or the state (%s)', async (mode, changedByServer) => {
    const run = await runUpdate(mode);
    expectedPosts += 1;
    expect(run.document).toMatchObject({ submission: 'SENT', responseJudgement: 'SUCCESS', result: 'UNKNOWN', reason: 'UNEXPECTED_FIELD_CHANGE', reservationState: 'COMMITTED' });
    expect(run.document.update?.updateEvidence?.fields).toEqual([
      { fieldName: 'name', role: 'CHANGED', previousValue: run.priorName, newValue: run.newName, matched: true },
      ...keptEvidence({ [changedByServer]: false }),
    ]);
  }, TEST_TIMEOUT_MS);

  it('writes UNKNOWN (RECORD_ID_MISMATCH) when the success page has another id than the target', async () => {
    const run = await runUpdate('id-mismatch');
    expectedPosts += 1;
    expect(run.document).toMatchObject({ submission: 'SENT', responseJudgement: 'SUCCESS', recordId: `${run.memberId}9`, result: 'UNKNOWN', reason: 'RECORD_ID_MISMATCH' });
  }, TEST_TIMEOUT_MS);

  it('writes PARTIAL (UPDATE_POSTCHECK_UNDETERMINED) when the update form cannot be opened after the update', async () => {
    const run = await runUpdate('postcheck-missing');
    expectedPosts += 1;
    expect(run.document).toMatchObject({ submission: 'SENT', responseJudgement: 'SUCCESS', result: 'PARTIAL', reason: 'UPDATE_POSTCHECK_UNDETERMINED' });
    expect(run.document.update?.updateEvidence?.fields).toEqual([
      { fieldName: 'name', role: 'CHANGED', previousValue: run.priorName, newValue: run.newName, matched: null },
      ...keptEvidence({ email: null, note: null, newsletter: null, published: null, active: null }),
    ]);
    // T32e: 更新の後の照合を判定できない（一致しない欄はない）ので、照合の READ は行われ、その証拠の全体が入る。変えた欄の前の値はあるので、人の値の
    // 印は真。
    expect(run.report.evidence).toMatchObject({
      containsHumanEnteredValues: true, readVerification: { state: 'EXECUTED' }, result: 'PARTIAL', reason: 'UPDATE_POSTCHECK_UNDETERMINED',
    });
  }, TEST_TIMEOUT_MS);

  // T31i: 応答の前に接続が切れても、更新の POST は 1 件（BeakSight の送り手が 1 回だけ送る）。結果は `UNKNOWN`、成功と偽らない。
  it('sends once when the connection closes before a response, and writes UNKNOWN (NO_RESPONSE) without evidence', async () => {
    const before = site.postBodies.length;
    const run = await runUpdate('connection-drop');
    expectedPosts += 1;
    expect(site.postBodies.length - before).toBe(1);
    expect(run.document).toMatchObject({
      submission: 'SENT', httpStatus: null, responseJudgement: null, reservationState: 'UNKNOWN', result: 'UNKNOWN', reason: 'NO_RESPONSE',
      update: { targetRecordId: String(run.memberId), updateEvidence: null },
    });
  }, TEST_TIMEOUT_MS);

  it.each<[string, WriteSiteUpdateMode, 'PRECHECK_FAILED' | 'PAYLOAD_MISMATCH']>([
    ['a value that changes between the prior read and the write stage', 'drift', 'PRECHECK_FAILED'],
    // T31i: 削除にあたる作用の形（組の checkbox を外す、`deleted=1` の hidden を足す）。
    ['the checkbox of the pair that the page script unchecks', 'js-pair-uncheck', 'PAYLOAD_MISMATCH'],
    ['a hidden deleted=1 that the page script adds', 'js-add-deleted', 'PAYLOAD_MISMATCH'],
    // T31R-fix-1（C-1。DEF-108）: 秘密に見えない hidden・readonly の値（T31R の E6 の形）。
    ['the hidden id that the page script points to another record', 'js-id', 'PAYLOAD_MISMATCH'],
    ['the hidden member[_destroy] that the page script sets to 1', 'js-destroy', 'PAYLOAD_MISMATCH'],
    ['the readonly member_no that the page script rewrites', 'js-member-no', 'PAYLOAD_MISMATCH'],
    ['the lock_version that the page script rewrites', 'js-lock', 'PAYLOAD_MISMATCH'],
    // T31R2-fix-1（C-1。DEF-108 の残り）: 見えない checkbox・見えない select・disabled の hidden（T31R2 の E8 の形）。
    ['the invisible checkbox that the page script checks', 'js-hidden-checkbox', 'PAYLOAD_MISMATCH'],
    ['the invisible select that the page script changes', 'js-hidden-select', 'PAYLOAD_MISMATCH'],
    ['the disabled hidden that the page script enables with a value', 'js-enable-disabled', 'PAYLOAD_MISMATCH'],
    ['a kept value that the page script rewrites', 'js-kept', 'PAYLOAD_MISMATCH'],
    ['the state hidden that the page script sets to 0', 'js-state', 'PAYLOAD_MISMATCH'],
    ['the hidden of the pair that the page script rewrites', 'js-pair-hidden', 'PAYLOAD_MISMATCH'],
    ['_method that the page script sets to DELETE', 'js-method', 'PAYLOAD_MISMATCH'],
  ])('does not send for %s (BLOCKED, RELEASED)', async (_label, mode, blockReason) => {
    const run = await runUpdate(mode);
    expect(run.document).toMatchObject({
      submission: 'NOT_SENT', blockReason, httpStatus: null, reservationState: 'RELEASED', result: 'BLOCKED', update: { updateEvidence: null },
    });
    expect(site.memberOf(run.memberId)).toMatchObject({ name: run.priorName, active: WRITE_SITE_MEMBER_DEFAULTS.active, published: true });
  }, TEST_TIMEOUT_MS);

  // T31R2-fix-1（C-1）: 秘密に見える名前の一覧に当たる一般の名前の hidden（`code`・`key`）がある画面は、期待を作らず送らない。
  it('does not send on a form with the hidden code and key (secret-like names other than the page-issued tokens)', async () => {
    site.setSecretHiddenFields(true);
    try {
      const before = site.postBodies.length;
      const run = await runUpdate('success', {
        candidateOf: async (memberId) => {
          const [candidate] = await readCandidates(memberId);
          const digest = templatedIdentityDigestForRecordIdOf(candidate, String(memberId));
          if (digest === null) {
            throw new Error('the templated identity digest was not computed');
          }
          return { candidate, digest };
        },
      });
      expect(site.postBodies.length - before).toBe(0);
      expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', reservationState: 'RELEASED', result: 'BLOCKED' });
      expect(run.rechecks).toBe(0);
    } finally {
      site.setSecretHiddenFields(false);
    }
  }, TEST_TIMEOUT_MS);

  // T31R-fix-1（C-1）: CSRF の hidden（秘密に見える名前）は今どおり名前だけで照らすので、書き換えても届く（手順書に書く限界）。
  it('still sends when the page script rewrites the CSRF hidden (checked by the name only)', async () => {
    const before = site.postBodies.length;
    const run = await runUpdate('js-csrf');
    expectedPosts += 1;
    expect(site.postBodies.length - before).toBe(1);
    expect(run.document).toMatchObject({ submission: 'SENT', result: 'VERIFIED' });
  }, TEST_TIMEOUT_MS);

  it('does not send when the recheck before the click is rejected, or when the stop signal comes', async () => {
    const rejected = await runUpdate('success', { recheck: () => Promise.resolve({ allowed: false, reason: 'GRANT_INVALID' }) });
    expect(rejected.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED', reservationState: 'RELEASED' });
    const stop = new AbortController();
    stop.abort();
    const stopped = await runUpdate('success', { stop });
    expect(stopped.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(stopped.rechecks).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('does not send when the prior value of the changed field is longer than the evidence can hold', async () => {
    const run = await runUpdate('success', { priorName: 'x'.repeat(MAX_SUBMITTED_VALUE_LENGTH + 1) });
    expect(run.document).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED', reservationState: 'RELEASED' });
    expect(run.rechecks).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('after all the runs, no POST arrives late (counted again after a named wait)', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(site.postBodies.length).toBe(expectedPosts);
    // 成功、サーバが欄を変える 2 回、ID の違い、後の画面が開けない回、応答の前の切断、CSRF の書き換え（T31R-fix-1）。
    expect(expectedPosts).toBe(7);
  }, TEST_TIMEOUT_MS);
});

// T31g-2（Task 31 の設計書 3 章の「更新の前の読み取り」「送信」「結果の判定」「更新の後の照合」「証拠と記録」、4 章の「読み込みの回数と間隔」）:
// 更新の書き込みのジョブの流れ（`src/worker/write-create-run.ts` の `executeWriteCreateRun` が、`write.update` を持つ指定で UPDATE を行う）を、
// 同じ process の中で、本物の Chromium（テストの既定の headless）と 127.0.0.1 の fixture のサイト
// （`tests/helpers/write-site-fixture.ts` の更新の画面）で確かめる結合テスト。ログインの段は通さず、fixture が作ったセッションを渡す。IPC の 2 つの口
// （確かめ直し、送信の報告）は、テストが偽の親として受ける。
// - 承認に縛る型にした識別の digest と規則の digest、照合の READ の対象の識別の digest は、本物の発見の入口（`readCandidatePage`）で読んだ候補から取る。
// - 成功 → `VERIFIED`（証拠の `CHANGED` は前の値と新しい値、`KEPT` は値なし、どの欄も一致）。サーバが保つ欄・状態も変える → `UNKNOWN`
//   （`UNEXPECTED_FIELD_CHANGE`）。成功の画面の ID が対象と違う → `UNKNOWN`（`RECORD_ID_MISMATCH`）。
// - PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1。構造の判定 (b2)）: 成否は人が入れた条件ではなく、更新の後の照合で決める。更新の後に更新の
//   画面が開けない → 判定できない（`UNKNOWN`・`NO_CONDITION_MATCHED`。前は成功の条件に当たったので `PARTIAL`）。更新せずに同じ更新の form が送った値を
//   保って出る → `FAILED`（`INPUT_ERROR`）。
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
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
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
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import { readWriteReportFiles, type WriteReportFiles } from '../helpers/write-report-checks.js';
import {
  WRITE_SITE_MEMBER_DEFAULTS,
  WRITE_SITE_OTHER_TABLE_PATH,
  WRITE_SITE_PATHS,
  WRITE_SITE_SESSION_COOKIE,
  startWriteSite,
  writeSiteEditPathOf,
  writeSiteRecordPathOf,
  type WriteSite,
  type WriteSiteUpdateMode,
} from '../helpers/write-site-fixture.js';

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

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('T31g-2: the update write job flow (%s)', (_name, launch) => {
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
  /** LU-SFIX3-B: 送信の扱い（省略はテストの設定の既定。N2 を確かめる回だけ `PASS_EXCEPT_DELETE`）。 */
  const configFor = (sendPolicy?: 'PASS_EXCEPT_DELETE'): AuditConfig => createTestConfig(site.origin, WRITE_SITE_PATHS.list, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    audit: { screenshots: false, ...(sendPolicy === undefined ? {} : { sendPolicy }) },
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
      resultJudgement: 'FORM_STRUCTURE',
      recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: [`${WRITE_SITE_PATHS.create}/{id}`] },
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
      /** LU-SFIX3-B: 送信の扱い。 */
      readonly sendPolicy?: 'PASS_EXCEPT_DELETE';
    } = {},
  ): Promise<Run> => {
    round += 1;
    const priorName = options.priorName ?? `前の名前 ${round}`;
    const newName = `新しい名前 ${round}`;
    const memberId = site.addMember(priorName);
    site.setUpdateMode(mode);
    const config = configFor(options.sendPolicy);
    const reports: WorkerWriteSubmissionReport[] = [];
    const starts: number[] = [];
    let rechecks = 0;
    const inner = createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now: () => Date.now(), sleep: wait });
    const pacer: NavigationPacer = forwardingNavigationPacer(inner, async () => {
      const waited = await inner.beforeNavigation();
      starts.push(Date.now());
      return waited;
    });
    const write = writeSpecOf(memberId, newName);
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
      observationWindows: TEST_OBSERVATION_WINDOWS,
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

  // LU-SFIX3-B（LU-SREV3 の Important-2）: 形 C（送信先の最後の区切りが対象の番号のフォームの更新）の窓の前（N2）に守るのは、送信先の型（`/members/{id}`）と
  // 表の path（`/members`）。更新の画面のページの JS が送る、ほかの会員への POST と表の path への POST は、送る前の確かめの Context でも書き込みの段の Context
  // でも届かない。別の表への POST は今のとおり届く（N2 の口）。正しい更新は今のとおり 1 件で `VERIFIED`。
  it('stops the page POSTs to another member and to the table path before the window, and lets the POST to another table pass (LU-SFIX3-B)', async () => {
    const since = site.requests.length;
    const postsBefore = site.postBodies.length;
    const run = await runUpdate('js-sends-on-load', { sendPolicy: 'PASS_EXCEPT_DELETE' });
    // TEST-TIME-B（案 9）: Browser を閉じた後なので、受けている途中の要求が 0 になってから短い余白だけ待つ（上限は前の固定の待ち）。
    await settleLateDeliveries(LATE_DELIVERY_SETTLE_MS, site);
    const posts = site.requests.slice(since).filter(({ method }) => method === 'POST').map(({ path }) => path);
    const otherTable = posts.filter((path) => path === WRITE_SITE_OTHER_TABLE_PATH).length;
    expect(posts.filter((path) => path !== WRITE_SITE_OTHER_TABLE_PATH)).toEqual([writeSiteRecordPathOf(run.memberId)]);
    expect(otherTable).toBeGreaterThan(0);
    expect(site.postBodies.length - postsBefore).toBe(1 + otherTable);
    expectedPosts += 1 + otherTable;
    expect(run.document).toMatchObject({ submission: 'SENT', result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED' });
  }, TEST_TIMEOUT_MS);

  // RB-11: 本物の画面から判定へ渡る代表（保つ欄の副作用・同じ form の入力の誤り）は、更新の後の照合の分け方と判定（`form-result-judgement`・
  // `action-outcome`）、更新の後の照合と READ の順（`write-run-loop`）の単体に移した。

  // RB-11: 応答の前の切断で 1 回だけ送る送り手のふるまいは write-submission-sender と guard-write-stage が、応答のない送信の記録は write-run-loop が確かめる。

  it.each<[string, WriteSiteUpdateMode, 'PRECHECK_FAILED' | 'PAYLOAD_MISMATCH']>([
    ['a value that changes between the prior read and the write stage', 'drift', 'PRECHECK_FAILED'],
    // T31i: 削除にあたる作用の形（`deleted=1` の hidden を足す）。
    // RB-14a: 組の checkbox を外す・保つ値・状態の hidden・組の hidden・`_method` を DELETE にする形は、write-form-update（更新の form の照合）が確かめる。
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
  ])('does not send for %s (BLOCKED, RELEASED)', async (_label, mode, blockReason) => {
    const run = await runUpdate(mode);
    expect(run.document).toMatchObject({
      submission: 'NOT_SENT', blockReason, httpStatus: null, reservationState: 'RELEASED', result: 'BLOCKED', update: { updateEvidence: null },
    });
    expect(site.memberOf(run.memberId)).toMatchObject({ name: run.priorName, active: WRITE_SITE_MEMBER_DEFAULTS.active, published: true });
  }, TEST_TIMEOUT_MS);

  // RB-11: 秘密に見える hidden（`code`・`key`）の form で送らない判定は、write-form-update（更新の form）と write-create-run（登録の form）が確かめる。

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

  // SLIM W-3: L12b（前の値の長さの上限の撤廃）の場面は消した（撤廃した上限の名残。撤廃は Gate の grep で確かめる）。

  // RB-11（再構築の設計書 2 章 3）: 全部の回の後に遅れて届く POST の数え直しは、ずれの確かめと guard-write-stage の 1 か所に集めた（ここでは数えない）。
});

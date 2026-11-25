// RB-11（再構築の設計書 2 章 1・3、INV-REBUILD の plan 2 章の 12）: READ の確かめの段の輪（`executeReadCheckRun` の `check`）を、偽の段の口
// （`readCheckPorts`）で、ブラウザなしに確かめる。1 画面の読み取りの中身（候補の確かめ・READ の URL・構造の照らし合わせ・Guard）は口の向こうにあり、
// ここでは口の答えを前提として信じる（決まり 3）。
// - まとめ方: 同じ画面の候補の定義は、対象の画面を 1 回だけ読む。画面の分からない定義・事前の判定に当たる画面は読まない。
// - 止まり方: セッションの切れ（残りは NOT_EXECUTED、URL は伏せ字）、違反、止める印（今の定義を終えてから）、Run の前の確認の失敗、サイトの不調の確かめ直し。
// - 最後の読み込みだけ、見せたまま待たずに閉じる（DEF-236）。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartReadCheck, WorkerStartSearchCheck } from '../../src/control/worker-protocol.js';
import type { RunProgressReport } from '../../src/core/contracts.js';
import { READ_EVIDENCE_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  READ_CHECK_DETAIL_RESULTS,
  readCheckEvidenceTargetOf,
  type ReadCheckDetail,
  type ReadCheckExecutedEvidence,
  type ReadEvidenceDocument,
} from '../../src/discovery/read-check-evaluation.js';
import type { ReadCandidatePage } from '../../src/discovery/read-executor.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import {
  executeReadCheckRun,
  type ReadCheckPageVisitOptions,
  type ReadCheckPorts,
  type ReadCheckRunOutcome,
  type ReadCheckSession,
  type ScriptSearchVisit,
} from '../../src/worker/read-check-run.js';
import type { GuardedPageVisit } from '../../src/worker/worker-run-session.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4174';

const authentication: RunAuthentication = Object.freeze({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [ORIGIN],
  auditExclusions: { excludedPathPrefixes: ['/admin/private'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
});

let nextId = 0;
const candidateCheck = (path: string | null, digest = `sha256:${'a'.repeat(64)}`): WorkerStartReadCheck => {
  nextId += 1;
  return {
    readCheckId: `read-${String(nextId)}`, readCheckRevision: 1, targetPage: path === null ? null : { origin: ORIGIN, path },
    definition: { targetIdentityDigest: digest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }] },
  };
};

/** 口が返す、読んで決まった 1 つの定義の結果（構造は持たない。詳しい理由から結果を決める）。 */
const evidenceOf = (readCheck: WorkerStartReadCheck, detail: Exclude<ReadCheckDetail, 'EXPECTATIONS_EVALUATED'>, url: string | null = null): ReadCheckExecutedEvidence => ({
  readCheckId: readCheck.readCheckId, readCheckRevision: readCheck.readCheckRevision, ...readCheckEvidenceTargetOf(readCheck.definition),
  state: 'EXECUTED', result: READ_CHECK_DETAIL_RESULTS[detail] ?? 'UNDETERMINED', detail, url, httpStatus: 200, blockedRequests: 0, structure: null,
  expectations: [],
});

type Checked = Awaited<ReturnType<ReadCheckSession['visitAndRead']>>;
const checked = (evidence: ReadCheckExecutedEvidence, facts: Partial<Checked> = {}): Checked =>
  ({ evidence, sessionLostUrl: null, sessionLostDetail: null, violation: false, ...facts });

const VISITED_FACTS = Object.freeze({
  blockedRequests: 0, violation: false, auditStageObservation: null,
  pageLoad: { limitReached: false },
});
const CANDIDATES: ReadCandidatePage = Object.freeze({ candidates: [], reliable: true });

/** 偽の口に頼んだ読み込み（何を・どの指定で）。 */
interface PortCall {
  readonly kind: 'CANDIDATES' | 'READ' | 'PAGE';
  readonly target: string;
  readonly lastLoad: boolean;
}

interface FakeAnswers {
  readonly read?: (readCheck: WorkerStartReadCheck, index: number) => Checked;
  readonly opened?: boolean;
  /** 対象の画面の読み込みで、サイトの不調だった回数（その後は読める）。 */
  readonly unavailableCandidateVisits?: number;
  /** RCA-7: スクリプトの組の n 回目の答え（省略すると、口はスクリプトの組を動かせない）。 */
  readonly script?: (index: number) => GuardedPageVisit<ScriptSearchVisit>;
}

const fakePorts = (answers: FakeAnswers = {}): { readonly ports: ReadCheckPorts; readonly calls: PortCall[]; readonly closed: number[] } => {
  const calls: PortCall[] = [];
  const closed: number[] = [];
  let reads = 0;
  let candidateVisits = 0;
  let scripts = 0;
  const lastLoad = (options: ReadCheckPageVisitOptions): boolean => options.pacingWaitBeforeClose === false;
  const session: ReadCheckSession = {
    readTargetCandidates: async (url, options) => {
      calls.push({ kind: 'CANDIDATES', target: url, lastLoad: lastLoad(options) });
      candidateVisits += 1;
      const siteUnavailable = candidateVisits <= (answers.unavailableCandidateVisits ?? 0);
      return { kind: 'VISITED', value: { candidates: siteUnavailable ? null : CANDIDATES, siteUnavailable }, ...VISITED_FACTS };
    },
    visitAndRead: async (readCheck, _confirmation, options) => {
      calls.push({ kind: 'READ', target: readCheck.readCheckId, lastLoad: lastLoad(options) });
      reads += 1;
      return answers.read?.(readCheck, reads - 1) ?? checked(evidenceOf(readCheck, 'CANDIDATE_NOT_FOUND'));
    },
    visitAndReadPage: async (readCheck, options) => {
      calls.push({ kind: 'PAGE', target: readCheck.readCheckId, lastLoad: lastLoad(options) });
      return checked(evidenceOf(readCheck, 'TARGET_PAGE_UNREADABLE'));
    },
    // REV-RCA の M-4: 番号を埋めた画面の読み取りは、書き込みの照合だけが使う（READ の確かめの段は呼ばない）。
    visitAndReadRecordPage: () => Promise.reject(new Error('the READ check stage reads no record page')),
    ...(answers.script === undefined ? {} : { runScriptSearch: async () => answers.script?.(scripts++) ?? { kind: 'NOT_OPENED', violation: false } }),
    carry: { latestAuthenticatedState: () => null },
    close: async () => {
      closed.push(closed.length);
    },
  };
  return { ports: { open: async () => (answers.opened === false ? null : session) }, calls, closed };
};

describe('RB-11: the READ check loop on a fake stage port', () => {
  let directory = '';
  let runs = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-read-check-loop-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  interface LoopRun {
    readonly outcome: ReadCheckRunOutcome;
    readonly document: ReadEvidenceDocument | null;
    readonly sessionLost: readonly string[];
  }

  const run = async (
    readChecks: readonly WorkerStartReadCheck[],
    ports: ReadCheckPorts,
    stop?: AbortController,
    search: {
      readonly searchChecks?: readonly WorkerStartSearchCheck[];
      readonly onProgress?: (report: RunProgressReport) => void;
      readonly bouncedSearchCheckKey?: string;
    } = {},
  ): Promise<LoopRun> => {
    runs += 1;
    const config = createTestConfig(ORIGIN, '/admin', {
      crawl: { minNavigationIntervalMs: 1_000 }, audit: { screenshots: false }, output: { directory: join(directory, `run-${String(runs)}`) },
    });
    const sessionLost: string[] = [];
    const outcome = await executeReadCheckRun({
      config, jobId: 'job-read-loop', authentication, readChecks,
      launchBrowser: () => Promise.reject(new Error('the fake stage port starts no browser')),
      clock: () => new Date(), now: () => Date.now(), sleep: async () => undefined, siteUnavailableRecheckDelayMs: 1,
      stopSignal: (stop ?? new AbortController()).signal, readCheckPorts: ports,
      ...(search.searchChecks === undefined ? {} : { searchChecks: search.searchChecks }),
      bouncedSearchCheckKey: search.bouncedSearchCheckKey,
    }, {
      onRunStarted: () => undefined, onSessionLost: (url) => sessionLost.push(url),
      ...(search.onProgress === undefined ? {} : { onProgress: search.onProgress }),
    });
    if (outcome.kind !== 'RAN') {
      return { outcome, document: null, sessionLost };
    }
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8')) as ReadEvidenceDocument;
    const validation = await validateArtifact('read-evidence', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    return { outcome, document, sessionLost };
  };
  const statesOf = (document: ReadEvidenceDocument | null): readonly string[] =>
    (document?.checks ?? []).map((check) => (check.state === 'EXECUTED' ? check.detail : check.reason));

  // RCA-7（検索の確かめの設計書 2.2・2.3）: GET のフォームの組は、定義の READ と同じ手順で読み、状態の番号で判定する。進み具合は 0 / M から組ごとに送る。
  it('checks the GET form combos with the same READ steps, judges by the status, and reports the progress N / M from 0', async () => {
    const formCombo = (letter: string, parameters: Readonly<Record<string, string>>): WorkerStartSearchCheck => ({
      kind: 'FORM', key: `sha256:${letter.repeat(64)}`, page: { origin: ORIGIN, path: '/admin/orders' }, targetIdentityDigest: `sha256:${'d'.repeat(64)}`,
      parameters, change: { kind: 'TEXT', field: 'q', text: 'HALF_WIDTH' }, unsentHiddenFields: false,
    });
    const fake = fakePorts({
      read: (readCheck, index) => checked({ ...evidenceOf(readCheck, 'HTTP_ERROR_STATUS'), httpStatus: index === 0 ? 404 : 500 }),
    });
    const progress: string[] = [];
    const { document } = await run([], fake.ports, undefined, {
      searchChecks: [formCombo('a', { q: 'a' }), formCombo('b', { q: 'あ' })],
      onProgress: (report) => progress.push(`${String(report.pagesFinished)}/${String(report.pagesDiscovered)}`),
    });
    expect(fake.calls.map(({ kind }) => kind)).toEqual(['CANDIDATES', 'READ', 'READ']);
    expect(document?.searchChecks.map((check) => (check.state === 'EXECUTED' ? check.detail : check.reason))).toEqual(['CLIENT_ERROR_STATUS', 'SERVER_ERROR']);
    expect(document?.checks).toEqual([]);
    expect(progress).toEqual(['0/2', '1/2', '2/2']);
  });

  // RCA-7（同 2.2・2.3）: スクリプトの組は、組ごとに押す口で動かし、きっかけの読み取りの状態で判定する。
  it('runs the script combos on the pressing port, and judges by the reads', async () => {
    const scriptCombo = (letter: string, text: 'EMPTY' | 'HALF_WIDTH' | 'FULL_WIDTH'): WorkerStartSearchCheck => ({
      kind: 'SCRIPT', key: `sha256:${letter.repeat(64)}`, page: { origin: ORIGIN, path: '/admin/orders' }, text,
      trigger: { kind: 'PRESS', stage: 1, priorPresses: [], identityDigest: `sha256:${'d'.repeat(64)}`, ordinal: 0, inputFields: [] },
    });
    const visited = (outcome: ScriptSearchVisit['outcome']): GuardedPageVisit<ScriptSearchVisit> =>
      ({ kind: 'VISITED', value: { outcome, siteUnavailable: false }, ...VISITED_FACTS });
    const ran = (status: number): ScriptSearchVisit['outcome'] =>
      ({ kind: 'RAN', reads: [{ method: 'GET', resourceType: 'fetch', url: `${ORIGIN}/api/orders?q=x`, status }] });
    const portsWith = (visits: readonly GuardedPageVisit<ScriptSearchVisit>[]): ReadCheckPorts =>
      fakePorts({ script: (index) => visits[index] ?? visited({ kind: 'NOT_REBUILT' }) }).ports;
    const combos = [scriptCombo('a', 'HALF_WIDTH'), scriptCombo('b', 'FULL_WIDTH'), scriptCombo('c', 'EMPTY')];
    const progress: string[] = [];
    const judged = await run([], portsWith([visited(ran(500)), visited(ran(404)), visited({ kind: 'NOT_REBUILT' })]), undefined, {
      searchChecks: combos, onProgress: (report) => progress.push(`${String(report.pagesFinished)}/${String(report.pagesDiscovered)}`),
    });
    expect(judged.document?.searchChecks.map((check) => (check.state === 'EXECUTED' ? check.detail : check.reason)))
      .toEqual(['SERVER_ERROR', 'CLIENT_ERROR_STATUS', 'STATE_NOT_REBUILT']);
    expect(progress).toEqual(['0/3', '1/3', '2/3', '3/3']);
  });

  // REV-RCA の M-6: 進み具合の M は人の定義と組の数。読んでよい URL でない画面の組は、始める前に除く（守りが止めた組として残し、M に入れない）。
  it('counts the definitions of a person in M, and leaves out the combo of a page not to read before the start', async () => {
    const formOn = (letter: string, path: string): WorkerStartSearchCheck => ({
      kind: 'FORM', key: `sha256:${letter.repeat(64)}`, page: { origin: ORIGIN, path }, targetIdentityDigest: `sha256:${'d'.repeat(64)}`,
      parameters: { q: 'a' }, change: { kind: 'TEXT', field: 'q', text: 'HALF_WIDTH' }, unsentHiddenFields: false,
    });
    const progress: string[] = [];
    const { document } = await run([candidateCheck('/admin/orders')], fakePorts().ports, undefined, {
      searchChecks: [formOn('a', '/admin/orders'), formOn('b', '/admin/private/x')],
      onProgress: (report) => progress.push(`${String(report.pagesFinished)}/${String(report.pagesDiscovered)}`),
    });
    expect(progress).toEqual(['0/2', '1/2', '2/2']);
    expect(document?.searchChecks.map((check) => (check.state === 'EXECUTED' ? check.detail : check.reason))).toEqual(['STATE_NOT_REBUILT', 'BLOCKED_BY_BEAKSIGHT']);
  });

  // REV-RCA の M-1（検索の確かめの設計書 2.2）: 検索の不調（429・502〜504・応答なし）は 1 回だけ確かめ直し、まだ不調でも画面が開ければ、検索だけ開けない誤り。
  it('rechecks a search that stays unavailable once, and says NOT_OPENED when the page itself opens', async () => {
    const script: WorkerStartSearchCheck = {
      kind: 'SCRIPT', key: `sha256:${'e'.repeat(64)}`, page: { origin: ORIGIN, path: '/admin/orders' }, text: 'HALF_WIDTH',
      trigger: { kind: 'PRESS', stage: 1, priorPresses: [], identityDigest: `sha256:${'d'.repeat(64)}`, ordinal: 0, inputFields: [] },
    };
    const form: WorkerStartSearchCheck = {
      kind: 'FORM', key: `sha256:${'f'.repeat(64)}`, page: { origin: ORIGIN, path: '/admin/orders' }, targetIdentityDigest: `sha256:${'d'.repeat(64)}`,
      parameters: { q: 'a' }, change: { kind: 'TEXT', field: 'q', text: 'HALF_WIDTH' }, unsentHiddenFields: false,
    };
    const unavailableRead: GuardedPageVisit<ScriptSearchVisit> = {
      kind: 'VISITED', ...VISITED_FACTS,
      value: { outcome: { kind: 'RAN', reads: [{ method: 'GET', resourceType: 'fetch', url: `${ORIGIN}/api/orders?q=a`, status: 503 }] }, siteUnavailable: false },
    };
    let scripts = 0;
    const fake = fakePorts({
      read: (readCheck) => ({ ...checked(evidenceOf(readCheck, 'HTTP_ERROR_STATUS')), siteUnavailable: true }),
      script: () => {
        scripts += 1;
        return unavailableRead;
      },
    });
    const { document } = await run([], fake.ports, undefined, { searchChecks: [form, script] });
    expect(scripts).toBe(2);
    expect(fake.calls.map(({ kind }) => kind)).toEqual(['CANDIDATES', 'READ', 'READ', 'CANDIDATES']);
    expect(document?.searchChecks.map((check) => (check.state === 'EXECUTED' ? check.detail : check.reason))).toEqual(['NOT_OPENED', 'NOT_OPENED']);
  });

  // REV-RCA の I-4: ログインし直したジョブは、親が渡した「戻された組」を最初に流し、その組でまた戻されたときだけ 2 回目の戻し（誤り）。戻された組の鍵を成果物に残す。
  // 鍵がない（人の定義で戻された）なら、最初の組で切れても 2 回目の戻しにしない。
  it('runs the bounced combo first after a re-login, and says LOGIN_BOUNCE only when that combo is bounced again', async () => {
    const scriptCombo = (letter: string): WorkerStartSearchCheck => ({
      kind: 'SCRIPT', key: `sha256:${letter.repeat(64)}`, page: { origin: ORIGIN, path: '/admin/orders' }, text: 'HALF_WIDTH',
      trigger: { kind: 'PRESS', stage: 1, priorPresses: [], identityDigest: `sha256:${'d'.repeat(64)}`, ordinal: 0, inputFields: [] },
    });
    const formCombo: WorkerStartSearchCheck = {
      kind: 'FORM', key: `sha256:${'f'.repeat(64)}`, page: { origin: ORIGIN, path: '/admin/orders' }, targetIdentityDigest: `sha256:${'d'.repeat(64)}`,
      parameters: { q: 'a' }, change: { kind: 'TEXT', field: 'q', text: 'HALF_WIDTH' }, unsentHiddenFields: false,
    };
    const lost: GuardedPageVisit<ScriptSearchVisit> = { kind: 'SESSION_LOST', url: `${ORIGIN}/login`, detail: null, blockedRequests: 0, violation: false, sessionLoss: null };
    const lostRead = (readCheck: WorkerStartReadCheck): Checked => checked(evidenceOf(readCheck, 'SESSION_LOST'), { sessionLostUrl: `${ORIGIN}/login` });
    const detailsOf = (document: ReadEvidenceDocument | null) =>
      document?.searchChecks.map((check) => `${check.key.slice(7, 8)}:${check.state === 'EXECUTED' ? check.detail : check.reason}`);
    const combos = [formCombo, scriptCombo('a'), scriptCombo('b')];
    // スクリプトの組 b で戻された後: b を最初に流し（人の定義とフォームの組より先）、また戻されたので誤り。
    const scriptBounced = fakePorts({ script: () => lost, read: (readCheck) => lostRead(readCheck) });
    const again = await run([candidateCheck('/admin/orders')], scriptBounced.ports, undefined, { searchChecks: combos, bouncedSearchCheckKey: `sha256:${'b'.repeat(64)}` });
    expect(scriptBounced.calls).toEqual([]);
    expect(detailsOf(again.document)).toEqual(['f:AUTH_SESSION_LOST', 'a:AUTH_SESSION_LOST', 'b:LOGIN_BOUNCE']);
    expect(again.document?.sessionLostSearchCheckKey).toBe(`sha256:${'b'.repeat(64)}`);
    // フォームの組 f で戻された後: f を人の定義より先に読み、また戻されたので誤り。
    const formBounced = fakePorts({ read: (readCheck) => lostRead(readCheck) });
    const formAgain = await run([candidateCheck('/admin/orders')], formBounced.ports, undefined, { searchChecks: combos, bouncedSearchCheckKey: formCombo.key });
    expect(formBounced.calls.filter(({ kind }) => kind === 'READ')).toHaveLength(1);
    expect(detailsOf(formAgain.document)).toEqual(['f:LOGIN_BOUNCE', 'a:AUTH_SESSION_LOST', 'b:AUTH_SESSION_LOST']);
    // 人の定義で戻された後（鍵なし）: 最初の組で切れても 2 回目の戻しにせず、切れた組の鍵を残す。
    const noKey = await run([], fakePorts({ script: () => lost }).ports, undefined, { searchChecks: [scriptCombo('a'), scriptCombo('b')] });
    expect(detailsOf(noKey.document)).toEqual(['a:AUTH_SESSION_LOST', 'b:AUTH_SESSION_LOST']);
    expect(noKey.document?.sessionLostSearchCheckKey).toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('reads the target page once per page, decides an unknown page and a blocked page without reading, and closes the last load at once', async () => {
    const checks = [candidateCheck('/admin/orders'), candidateCheck('/admin/orders'), candidateCheck(null), candidateCheck('/admin/private/x')];
    const fake = fakePorts();
    const { document } = await run(checks, fake.ports);
    expect(document?.endReason).toBe('COMPLETED');
    expect(statesOf(document)).toEqual(['CANDIDATE_NOT_FOUND', 'CANDIDATE_NOT_FOUND', 'TARGET_PAGE_UNKNOWN', 'REQUEST_POLICY']);
    expect(fake.calls).toEqual([
      { kind: 'CANDIDATES', target: `${ORIGIN}/admin/orders`, lastLoad: false },
      { kind: 'READ', target: checks[0]?.readCheckId, lastLoad: false },
      // 最後のまとまりは読まない画面なので、この画面の最後の読み込みも見せたまま待つ（最後のまとまりの最後の READ だけが待たない）。
      { kind: 'READ', target: checks[1]?.readCheckId, lastLoad: false },
    ]);
    expect(fake.closed).toHaveLength(1);
  });

  it('closes the last READ of the job without the pacing wait (DEF-236)', async () => {
    const checks = [candidateCheck('/admin/orders'), candidateCheck('/admin/orders')];
    const fake = fakePorts();
    await run(checks, fake.ports);
    expect(fake.calls.filter(({ kind }) => kind === 'READ').map(({ lastLoad }) => lastLoad)).toEqual([false, true]);
  });

  it('stops at a lost session, tells the URL once and leaves the rest NOT_EXECUTED', async () => {
    const checks = [1, 2, 3].map(() => candidateCheck('/admin/orders'));
    const fake = fakePorts({
      read: (readCheck, index) => (index === 1
        ? checked(evidenceOf(readCheck, 'SESSION_LOST'), { sessionLostUrl: `${ORIGIN}/login?token=secret-value` })
        : checked(evidenceOf(readCheck, 'CANDIDATE_NOT_FOUND'))),
    });
    const { document, sessionLost } = await run(checks, fake.ports);
    expect(document?.endReason).toBe('AUTH_SESSION_LOST');
    expect(statesOf(document)).toEqual(['CANDIDATE_NOT_FOUND', 'SESSION_LOST', 'AUTH_SESSION_LOST']);
    expect(sessionLost).toHaveLength(1);
    expect(sessionLost[0]).not.toContain('secret-value');
    expect(fake.calls.filter(({ kind }) => kind === 'READ')).toHaveLength(2);
  });

  it('stops at a safety violation and leaves the rest NOT_EXECUTED', async () => {
    const checks = [candidateCheck('/admin/orders'), candidateCheck('/admin/orders')];
    const fake = fakePorts({ read: (readCheck) => checked(evidenceOf(readCheck, 'CANDIDATE_NOT_FOUND'), { violation: true }) });
    const { document } = await run(checks, fake.ports);
    expect(document?.endReason).toBe('SAFETY_VIOLATION');
    expect(statesOf(document)).toEqual(['CANDIDATE_NOT_FOUND', 'SAFETY_VIOLATION']);
  });

  it('stops after the current definition when asked to stop', async () => {
    const stop = new AbortController();
    const checks = [1, 2, 3].map(() => candidateCheck('/admin/orders'));
    const fake = fakePorts({
      read: (readCheck) => {
        stop.abort();
        return checked(evidenceOf(readCheck, 'CANDIDATE_NOT_FOUND'));
      },
    });
    const { document } = await run(checks, fake.ports, stop);
    expect(document?.endReason).toBe('STOPPED');
    expect(statesOf(document)).toEqual(['CANDIDATE_NOT_FOUND', 'STOPPED', 'STOPPED']);
  });

  it('ends with PREFLIGHT_FAILED and reads nothing when the stage port cannot open', async () => {
    const fake = fakePorts({ opened: false });
    const { document } = await run([candidateCheck('/admin/orders')], fake.ports);
    expect(document?.endReason).toBe('PREFLIGHT_FAILED');
    expect(statesOf(document)).toEqual(['PREFLIGHT_FAILED']);
    expect(fake.calls).toEqual([]);
  });

  it('reads the target page again once after the site was unavailable (DEF-136)', async () => {
    const fake = fakePorts({ unavailableCandidateVisits: 1 });
    const { document } = await run([candidateCheck('/admin/orders')], fake.ports);
    expect(document?.endReason).toBe('COMPLETED');
    expect(fake.calls.filter(({ kind }) => kind === 'CANDIDATES')).toHaveLength(2);
  });

  it('reads every page path definition once each, more than the former limit of 20 (L4)', async () => {
    const checks = Array.from({ length: 21 }, (_value, index): WorkerStartReadCheck => ({
      readCheckId: `read-page-${String(index)}`, readCheckRevision: 1, targetPage: { origin: ORIGIN, path: '/admin' },
      definition: { targetPagePath: '/admin', parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] },
    }));
    const fake = fakePorts();
    const { document } = await run(checks, fake.ports);
    expect(fake.calls.map(({ kind, target }) => [kind, target])).toEqual(checks.map(({ readCheckId }) => ['PAGE', readCheckId]));
    expect(statesOf(document)).toEqual(checks.map(() => 'TARGET_PAGE_UNREADABLE'));
  });
});

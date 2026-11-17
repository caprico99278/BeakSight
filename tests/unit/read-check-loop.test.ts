// RB-11（再構築の設計書 2 章 1・3、INV-REBUILD の plan 2 章の 12）: READ の確かめの段の輪（`executeReadCheckRun` の `check`）を、偽の段の口
// （`readCheckPorts`）で、ブラウザなしに確かめる。1 画面の読み取りの中身（候補の確かめ・READ の URL・構造の照らし合わせ・Guard）は口の向こうにあり、
// ここでは口の答えを前提として信じる（決まり 3）。
// - まとめ方: 同じ画面の候補の定義は、対象の画面を 1 回だけ読む。画面の分からない定義・事前の判定に当たる画面は読まない。
// - 止まり方: セッションの切れ（残りは NOT_EXECUTED、URL は伏せ字）、違反、止める印（今の定義を終えてから）、Run の前の確認の失敗、サイトの不調の確かめ直し。
// - 番号の入る画面の path の型（DEF-235）: 親の番号を全部読む、なければ一覧の画面を 1 回だけ読んで番号を埋める、どれもなければ RECORD_ID_NOT_AVAILABLE。
// - 最後の読み込みだけ、見せたまま待たずに閉じる（DEF-236）。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
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
} from '../../src/worker/read-check-run.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4174';
const LIST = '/admin/members';

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
const templateCheck = (recordIds?: readonly string[]): WorkerStartReadCheck => {
  nextId += 1;
  return {
    readCheckId: `read-${String(nextId)}`, readCheckRevision: 1, targetPage: { origin: ORIGIN, path: `${LIST}/{id}` },
    definition: { targetPagePath: `${LIST}/{id}`, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] },
    ...(recordIds === undefined ? {} : { recordIds }),
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
  readonly kind: 'LIST' | 'CANDIDATES' | 'READ' | 'PAGE' | 'RECORD';
  readonly target: string;
  readonly lastLoad: boolean;
}

interface FakeAnswers {
  readonly read?: (readCheck: WorkerStartReadCheck, index: number) => Checked;
  readonly record?: (readCheck: WorkerStartReadCheck, recordId: string) => Checked;
  readonly listUrls?: readonly string[];
  readonly opened?: boolean;
  /** 対象の画面の読み込みで、サイトの不調だった回数（その後は読める）。 */
  readonly unavailableCandidateVisits?: number;
}

const fakePorts = (answers: FakeAnswers = {}): { readonly ports: ReadCheckPorts; readonly calls: PortCall[]; readonly closed: number[] } => {
  const calls: PortCall[] = [];
  const closed: number[] = [];
  let reads = 0;
  let candidateVisits = 0;
  const lastLoad = (options: ReadCheckPageVisitOptions): boolean => options.pacingWaitBeforeClose === false;
  const session: ReadCheckSession = {
    readListPageLinks: async (url, options) => {
      calls.push({ kind: 'LIST', target: url, lastLoad: lastLoad(options) });
      return { kind: 'VISITED', value: { urls: answers.listUrls ?? [], siteUnavailable: false }, ...VISITED_FACTS };
    },
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
    visitAndReadRecordPage: async (readCheck, recordId, options) => {
      calls.push({ kind: 'RECORD', target: recordId, lastLoad: lastLoad(options) });
      return answers.record?.(readCheck, recordId) ?? checked(evidenceOf(readCheck, 'TARGET_PAGE_UNREADABLE', `${ORIGIN}${LIST}/${recordId}`));
    },
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

  const run = async (readChecks: readonly WorkerStartReadCheck[], ports: ReadCheckPorts, stop?: AbortController): Promise<LoopRun> => {
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
    }, { onRunStarted: () => undefined, onSessionLost: (url) => sessionLost.push(url) });
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

  it('reads every record id given by the parent once, without reading the list page (DEF-235)', async () => {
    const fake = fakePorts();
    const { document } = await run([templateCheck(['7', '9'])], fake.ports);
    expect(fake.calls.map(({ kind, target }) => [kind, target])).toEqual([['RECORD', '7'], ['RECORD', '9']]);
    expect(document?.checks[0]).toMatchObject({ state: 'EXECUTED', records: [{ url: `${ORIGIN}${LIST}/7` }, { url: `${ORIGIN}${LIST}/9` }] });
  });

  it('reads the list page once to fill the ids, and says RECORD_ID_NOT_AVAILABLE when it lists none (DEF-235)', async () => {
    const listed = fakePorts({ listUrls: [`${ORIGIN}${LIST}/3`, `${ORIGIN}/admin/other/4`] });
    await run([templateCheck(), templateCheck()], listed.ports);
    expect(listed.calls.map(({ kind, target }) => [kind, target])).toEqual([
      ['LIST', `${ORIGIN}${LIST}`], ['RECORD', '3'], ['RECORD', '3'],
    ]);
    const empty = fakePorts();
    const { document } = await run([templateCheck()], empty.ports);
    expect(statesOf(document)).toEqual(['RECORD_ID_NOT_AVAILABLE']);
  });
});

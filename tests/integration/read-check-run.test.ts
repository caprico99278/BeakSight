// T27e（Task 27 の設計書 3 章、4.5、4.8、6 章）: READ の確かめのジョブの流れ（`src/worker/read-check-run.ts` の `executeReadCheckRun`）を、同じ
// process の中で、本物の Chromium（headless だけ。テストの既定と、CLI の起動の設定の両方）と 127.0.0.1 の fixture のサーバ
// （`discovery-site-fixture.ts` の `readCheckPages`）で確かめる結合テスト。ログインの段は通さず、fixture が作ったセッションを、認証つきの Run の
// 指定（メモリの状態）で渡す（ログインの段からの端から端は `discovery-job-fork.test.ts` の「T27e」の describe）。
// - 対象の候補は、先に同じ fixture で発見の流れ（`executeDiscoveryRun`）を動かし、その `discovery.json` の候補から取る（識別の digest を手で
//   書かない）。
// - 照合: 各期待の種類の `MATCHED`・`NOT_MATCHED`、構造がないときの `UNDETERMINED`、HTTP の 4xx・5xx の `UNDETERMINED`。
// - 事前の判定: 読まないパスへ送る検索、危険な語の値、秘密に見える名前の送る値は、読まずに `READ_BLOCKED_BY_POLICY`（サーバに届かない）。
// - CCX-10: 保存の後に、送る値の欄が見えない・readonly・disabled に変わった → 読まずに `READ_BLOCKED_BY_POLICY`（`PARAMETER_NOT_SENDABLE`。
//   fail-closed。READ の URL はサーバに届かない）。
// - 候補の確かめ: 欄を足した・POST に変えた → `READ_CANDIDATE_DRIFTED`、JS の結び付きを足した → `READ_CANDIDATE_NOT_READ`、画面の分からない
//   定義 → `READ_CANDIDATE_DRIFTED`（どれも READ の URL を読まない）。凍結した Context では、ページを読み込めない（READ の URL を別の Context で
//   読む理由）。
// - サイトへの要求: GET（と HEAD）だけ。READ の URL の query は、定義の欄の名前だけ（CSRF のトークンや hidden の値が入らない）。読み込みの間隔は
//   設定の値以上（読み込みの開始どうし。pacer の記録で、許容なし。どの要求も、その開始の後にサーバに届く）。
// - 止まり方: セッションの切れ（`AUTH_SESSION_LOST`。残りは `NOT_EXECUTED`）、止める要求（今の定義を終えてから）。
// - 秘密: セッションの値、localStorage の値、トークン、入力の値、hidden の値、選択肢の label、表の行の目印が、成果物に出ない。
// 出力先は一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, READ_EVIDENCE_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import { discoveryCandidatesOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadCheckExpectation, ReadCheckParameters } from '../../src/discovery/read-check-contracts.js';
import type { ReadCheckExecutedEvidence, ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import { authenticatedContextOptions, type RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { executeReadCheckRun, type ReadCheckRunOutcome, type ReadCheckRunRequest } from '../../src/worker/read-check-run.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  DISCOVERY_SITE_LOCAL_STORAGE_ITEM,
  DISCOVERY_SITE_PATHS,
  DISCOVERY_SITE_READ_CHECK_PATHS,
  DISCOVERY_SITE_SESSION_COOKIE,
  startDiscoverySite,
  type DiscoverySite,
  type DiscoverySiteRequest,
} from '../helpers/discovery-site-fixture.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { createTestNavigationPacer, forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const TEST_TIMEOUT_MS = 240_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 400;
/** 発見で読む画面の数より大きい上限。 */
const ENOUGH_PAGES = 50;
const WAIT_POLL_MS = 20;
const R = DISCOVERY_SITE_READ_CHECK_PATHS;

const pathOf = (path: string): string => path.split('?')[0] ?? path;

/**
 * 読み込みの間隔の確かめ（`discovery-run.test.ts` と同じ方式）: 読み込みの開始（pacer の記録）の間隔が設定の値以上（許容なし）で、開始の数と
 * サーバに届いた管理画面の HTML の要求の数が同じで、k 番目の要求は k 番目の開始の後に届く。
 */
const expectPaced = (starts: readonly number[], documents: readonly { readonly at: number }[], intervalMs: number): void => {
  expect(starts).toHaveLength(documents.length);
  starts.slice(1).forEach((start, index) => {
    expect(start - (starts[index] ?? Number.NaN), `interval before navigation ${index + 1}`).toBeGreaterThanOrEqual(intervalMs);
  });
  documents.forEach((request, index) => {
    expect(request.at, `request ${index} reaches the server after its start`).toBeGreaterThanOrEqual(starts[index] ?? Number.NaN);
  });
};

describe.each(LAUNCHERS)('T27e: the READ check job flow (%s)', (_name, launch) => {
  let site: DiscoverySite;
  let outputDirectory: string;

  beforeAll(async () => {
    // 起動できることを先に確かめる（起動の失敗を、READ の確かめの失敗と取り違えない）。
    const browser: Browser = await launch();
    await browser.close();
  });

  beforeEach(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-read-check-run-'));
  });

  afterEach(async () => {
    await site?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  const configFor = (): AuditConfig => createTestConfig(site.origin, DISCOVERY_SITE_PATHS.admin, {
    crawl: { maxPages: ENOUGH_PAGES, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    audit: { screenshots: false },
    output: { directory: outputDirectory },
  });

  const authenticationFor = (): RunAuthentication => ({
    initialState: {
      cookies: [{
        name: DISCOVERY_SITE_SESSION_COOKIE,
        value: site.issueSession(),
        domain: new URL(site.origin).hostname,
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      }],
      origins: [{ origin: site.origin, localStorage: [{ name: DISCOVERY_SITE_LOCAL_STORAGE_ITEM, value: 'seed' }] }],
    },
    approvedTestOrigins: [site.origin],
    auditExclusions: {
      excludedPathPrefixes: [DISCOVERY_SITE_PATHS.logout, R.privateArea],
      auditPathPrefixes: [DISCOVERY_SITE_PATHS.admin],
      dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
    },
    sessionLostPathPrefix: DISCOVERY_SITE_PATHS.login,
    filterState: filterAuthenticatedState,
  });

  /** 発見を動かして、候補を返す（READ の確かめの対象の識別の digest を、本物の発見から取る）。 */
  const discover = async (): Promise<readonly DiscoveryCandidate[]> => {
    const outcome = await executeDiscoveryRun({
      config: configFor(),
      jobId: 'job-discovery-for-read',
      authentication: authenticationFor(),
      launchBrowser: launch,
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error('the discovery did not run');
    }
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    return discoveryCandidatesOf(document);
  };

  /** 画面の、ただ 1 つの FORM の候補。 */
  const formOn = (candidates: readonly DiscoveryCandidate[], path: string): DiscoveryCandidate => {
    const forms = candidates.filter((candidate) => candidate.page.path === path && candidate.kind === 'FORM');
    expect(forms, path).toHaveLength(1);
    const [form] = forms;
    if (form === undefined) {
      throw new Error(`no form on ${path}`);
    }
    return form;
  };

  let nextId = 0;
  const readCheckOf = (
    candidate: DiscoveryCandidate,
    parameters: ReadCheckParameters,
    expectations: readonly ReadCheckExpectation[],
    targetPage: WorkerStartReadCheck['targetPage'] = candidate.page,
  ): WorkerStartReadCheck => {
    nextId += 1;
    return { readCheckId: `read-${nextId}`, readCheckRevision: 1, targetPage, definition: { targetIdentityDigest: candidate.identityDigest, parameters, expectations } };
  };

  interface Run {
    readonly outcome: ReadCheckRunOutcome;
    readonly document: ReadEvidenceDocument;
    readonly text: string;
    readonly sessionLost: readonly string[];
    readonly starts: readonly number[];
  }

  const runReadChecks = async (readChecks: readonly WorkerStartReadCheck[], overrides: Partial<ReadCheckRunRequest> = {}): Promise<Run> => {
    const config = configFor();
    const sessionLost: string[] = [];
    const starts: number[] = [];
    const pacer = createTestNavigationPacer(config);
    const outcome = await executeReadCheckRun({
      config,
      jobId: 'job-read-check-1',
      authentication: authenticationFor(),
      readChecks,
      launchBrowser: launch,
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
      navigationPacer: forwardingNavigationPacer(pacer, async () => {
        const waitedMs = await pacer.beforeNavigation();
        starts.push(pacer.snapshot().lastNavigationStartedAtMs ?? Number.NaN);
        return waitedMs;
      }),
      ...overrides,
    }, {
      onRunStarted: () => undefined,
      onSessionLost: (url) => sessionLost.push(url),
    });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    const text = readFileSync(artifactFilePath(outcome.runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8');
    const document = JSON.parse(text) as ReadEvidenceDocument;
    expect((await validateArtifact('read-evidence', document)).ok).toBe(true);
    // AS-b: 結果の記録に、実効の監査の段の送信の扱いを残す（このファイルの設定は既定の読み取りだけ）。
    expect(document.auditSendPolicy).toBe('READ_ONLY');
    return { outcome, document, text, sessionLost, starts };
  };

  const executed = (document: ReadEvidenceDocument, readCheckId: string): ReadCheckExecutedEvidence => {
    const check = document.checks.find((candidate) => candidate.readCheckId === readCheckId);
    if (check?.state !== 'EXECUTED') {
      throw new Error(`the READ check ${readCheckId} was not executed`);
    }
    return check;
  };

  /** 秘密の目印が、`text` に現れたもの。 */
  const leaked = (text: string): readonly string[] => site.secretValues().filter((marker) => text.includes(marker));

  /** `since` 番目からの、管理画面の HTML の要求（読み込み）。 */
  const documentsSince = (since: number): readonly DiscoverySiteRequest[] => site.requests.slice(since).filter(({ adminDocument }) => adminDocument);

  it('matches and does not match each kind of expectation, with GET only, the definition names only and the configured interval', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const candidates = await discover();
    const orders = formOn(candidates, R.orders);
    const lookup = formOn(candidates, R.lookup);
    expect([orders.classification, lookup.classification]).toEqual(['READ', 'READ']);
    const since = site.requests.length;
    const checks = [
      readCheckOf(orders, { q: 'りんご' }, [{ kind: 'ROW_COUNT_EQUALS', count: 2 }, { kind: 'TEXT_CONTAINS', text: 'りんごジュース' }]),
      readCheckOf(orders, { q: 'りんご', status: 'open' }, [{ kind: 'ROW_COUNT_EQUALS', count: 2 }]),
      readCheckOf(orders, { status: 'closed' }, [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }]),
      readCheckOf(orders, { q: 'ぶどう' }, [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }, { kind: 'TEXT_CONTAINS', text: 'みかん' }]),
      readCheckOf(lookup, { id: 'A-2' }, [{ kind: 'DETAIL_FIELD_EQUALS', field: '名前', value: 'みかん' }, { kind: 'DETAIL_FIELD_EQUALS', field: '状態', value: 'open' }]),
      readCheckOf(lookup, { id: 'A-2' }, [{ kind: 'DETAIL_FIELD_EQUALS', field: '状態', value: 'closed' }]),
      readCheckOf(lookup, { id: 'A-1' }, [{ kind: 'ROW_COUNT_EQUALS', count: 1 }]),
    ];
    const run = await runReadChecks(checks);

    expect(run.document.checks.map((check) => (check.state === 'EXECUTED' ? check.result : check.reason)))
      .toEqual(['MATCHED', 'NOT_MATCHED', 'MATCHED', 'NOT_MATCHED', 'MATCHED', 'NOT_MATCHED', 'UNDETERMINED']);
    expect(run.document).toMatchObject({ jobId: 'job-read-check-1', endReason: 'COMPLETED', runStatus: 'PARTIAL' });
    expect(run.outcome).toMatchObject({ kind: 'RAN', runStatus: 'PARTIAL', summary: { checks: checks.length, executed: checks.length } });
    // 照らした項目だけ（行の数、見つかったか、詳細の値）。
    const first = executed(run.document, checks[0]?.readCheckId ?? '');
    expect(first).toMatchObject({ detail: 'EXPECTATIONS_EVALUATED', httpStatus: 200, structure: { region: 'MAIN', tables: 1, tableRowCounts: [2], lists: 0 } });
    expect(first.expectations).toEqual([
      { expectation: { kind: 'ROW_COUNT_EQUALS', count: 2 }, result: 'MATCHED', undeterminedReason: null, rowSource: 'TABLE', observedRowCount: 2 },
      { expectation: { kind: 'TEXT_CONTAINS', text: 'りんごジュース' }, result: 'MATCHED', undeterminedReason: null, found: true },
    ]);
    expect(executed(run.document, checks[5]?.readCheckId ?? '').expectations).toEqual([
      { expectation: { kind: 'DETAIL_FIELD_EQUALS', field: '状態', value: 'closed' }, result: 'NOT_MATCHED', undeterminedReason: null, observedValue: 'open' },
    ]);
    expect(executed(run.document, checks[6]?.readCheckId ?? '').expectations).toEqual([
      { expectation: { kind: 'ROW_COUNT_EQUALS', count: 1 }, result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_NOT_FOUND', rowSource: null, observedRowCount: null },
    ]);

    // サイトへの要求: GET（と HEAD）だけ。対象の画面は 1 回ずつ（同じ画面の定義は 1 回の読み込みで確かめる）、READ の URL は定義ごとに 1 回。
    const requests = site.requests.slice(since);
    expect(requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    const documents = documentsSince(since);
    expect(documents.map(({ path }) => pathOf(path))).toEqual([R.orders, R.orders, R.orders, R.orders, R.orders, R.lookup, R.order, R.order, R.order]);
    // READ の URL の query は、定義の欄の名前だけ（CSRF のトークン、hidden の値、選択肢の既定の値が入らない）。
    const readUrls = documents.filter(({ path }) => path.includes('?')).map(({ path }) => new URL(path, site.origin));
    expect(readUrls.map((url) => [...url.searchParams.keys()])).toEqual([['q'], ['q', 'status'], ['status'], ['q'], ['id'], ['id'], ['id']]);
    expect(readUrls.map((url) => url.searchParams.get('q') ?? url.searchParams.get('status') ?? url.searchParams.get('id')))
      .toEqual(['りんご', 'りんご', 'closed', 'ぶどう', 'A-2', 'A-2', 'A-1']);
    expect(requests.filter(({ path }) => path.includes('authenticity_token') || path.includes('scope='))).toEqual([]);
    expectPaced(run.starts, documents, NAVIGATION_INTERVAL_MS);

    // 秘密と表の全体: 成果物に出ない（表の各行の目印も出ない）。
    expect(leaked(run.text)).toEqual([]);
    expect(site.secretValues().length).toBeGreaterThan(5);
  }, TEST_TIMEOUT_MS);

  it('returns UNDETERMINED without comparing for HTTP 4xx and 5xx', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const broken = formOn(await discover(), R.brokenSearch);
    const checks = [
      readCheckOf(broken, { kind: 'missing' }, [{ kind: 'TEXT_CONTAINS', text: '誤り' }]),
      readCheckOf(broken, { kind: 'error' }, [{ kind: 'ROW_COUNT_EQUALS', count: 1 }]),
    ];
    const run = await runReadChecks(checks);
    expect(run.document.checks.map((check) => (check.state === 'EXECUTED' ? [check.result, check.detail, check.httpStatus, check.expectations] : [])))
      .toEqual([['UNDETERMINED', 'HTTP_ERROR_STATUS', 404, []], ['UNDETERMINED', 'HTTP_ERROR_STATUS', 500, []]]);
  }, TEST_TIMEOUT_MS);

  // PRE42-CC 組 R（CC-042）: 600 以上の決まっていない status も、今どおり誤りとして扱う（対象の画面の候補を読まない）。
  it('treats a non-standard HTTP status of 600 or more of the target page as an error, and does not read its candidates', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const broken = formOn(await discover(), R.brokenSearch);
    // 対象の画面が 600 を返す（候補を読まないので、読めなかった画面として扱う。読めば候補が見つからない、になる）。
    site.setPageFault(R.brokenSearch, { kind: 'STATUS', status: 600, times: 1 });
    const target = await runReadChecks([readCheckOf(broken, { kind: 'missing' }, [{ kind: 'TEXT_CONTAINS', text: '誤り' }])]);
    expect(target.document.checks.map((check) => (check.state === 'EXECUTED' ? [check.result, check.detail] : [check.state])))
      .toEqual([['UNDETERMINED', 'TARGET_PAGE_UNREADABLE']]);
  }, TEST_TIMEOUT_MS);

  // DEF-164: READ の URL の画面が 600 以上の status を返しても、観察した status を捨てずに成果物を書く（判定は今どおり誤り）。成果物の `httpStatus` の
  // 範囲は、Chromium が渡しうる値（`OBSERVABLE_HTTP_STATUS_RANGE`）。
  it('writes the evidence with HTTP_ERROR_STATUS and the observed status when the READ URL returns 600 (DEF-164)', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const broken = formOn(await discover(), R.brokenSearch);
    site.setPageFault(R.broken, { kind: 'STATUS', status: 600 });
    const run = await runReadChecks([readCheckOf(broken, { kind: 'missing' }, [{ kind: 'TEXT_CONTAINS', text: '誤り' }])]);
    expect(run.document.checks.map((check) => (check.state === 'EXECUTED' ? [check.result, check.detail, check.httpStatus, check.expectations] : [check.state])))
      .toEqual([['UNDETERMINED', 'HTTP_ERROR_STATUS', 600, []]]);
  }, TEST_TIMEOUT_MS);

  it('blocks a READ by the request policy before reading: an excluded path, a dangerous value and a secret-like name', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const candidates = await discover();
    const exit = formOn(candidates, R.exitSearch);
    const orders = formOn(candidates, R.orders);
    const secret = formOn(candidates, R.secretSearch);
    expect(exit.classification).toBe('READ');
    const since = site.requests.length;
    const checks = [
      readCheckOf(exit, { reason: 'x' }, [{ kind: 'TEXT_CONTAINS', text: 'x' }]),
      readCheckOf(orders, { q: 'delete' }, [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }]),
      // 契約は秘密に見える名前の送る値を拒む。ここでは契約を通さずに渡し、流れの確かめ直し（fail-closed）を確かめる。
      readCheckOf(secret, { q: 'りんご', api_key: 'example-value' }, [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }]),
    ];
    const run = await runReadChecks(checks);
    // T27R-fix-1（DEF-088）: 危険な語の値（`delete`）は、要求の判定（`REQUEST_POLICY`）の前に、URL を組み立てる所の発見の分類の危険な語の判定
    // （`PARAMETER_DANGEROUS_WORD`）で止まる（どちらも読まずに `READ_BLOCKED_BY_POLICY`）。修正の前は `REQUEST_POLICY` だった。
    expect(run.document.checks.map((check) => (check.state === 'EXECUTED' ? [check.result, check.detail] : [])))
      .toEqual([['READ_BLOCKED_BY_POLICY', 'REQUEST_POLICY'], ['READ_BLOCKED_BY_POLICY', 'PARAMETER_DANGEROUS_WORD'], ['READ_BLOCKED_BY_POLICY', 'SECRET_LIKE_PARAMETER']]);
    // 対象の画面は読むが、READ の URL は読まない（読まないパスと、危険な語と、秘密に見える名前の要求は届かない）。
    const requests = site.requests.slice(since);
    expect(requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    expect(requests.filter(({ path }) => path.includes('?'))).toEqual([]);
    expect(requests.filter(({ path }) => path.startsWith(R.privateArea) || path.includes('delete') || path.includes('api_key'))).toEqual([]);
    expect(documentsSince(since).map(({ path }) => pathOf(path))).toEqual([R.exitSearch, R.orders, R.secretSearch]);
    expect(run.text.includes('example-value')).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('does not read when a value or a name to send has a dangerous word of the discovery, also a Japanese one (T27R-fix-1, DEF-088)', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const orders = formOn(await discover(), R.orders);
    expect(orders.classification).toBe('READ');
    const since = site.requests.length;
    // 保存の確かめ（`validateReadCheckDefinition`）は、同じ判定で拒む。ここでは、保存の後に候補が変わらないまま（修正の前に保存した定義など）、
    // 実行の前の確かめで止まることを確かめる（契約を通さずに渡す）。日本語の危険な語は、要求の判定（Guard の既定の危険な語）にない。
    const checks = [
      readCheckOf(orders, { q: '削除' }, [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }]),
      readCheckOf(orders, { q: 'りんご', status: '取り消し済み' }, [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }]),
      readCheckOf(orders, { q: '%E5%89%8A%E9%99%A4' }, [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }]),
    ];
    const run = await runReadChecks(checks);
    // 対象の画面は 1 回読むが、READ の URL（GET）はサーバに届かない（サーバの記録で数える）。
    expect(site.requests.slice(since).filter(({ path }) => path.includes('?')).length).toBe(0);
    expect(documentsSince(since).map(({ path }) => pathOf(path))).toEqual([R.orders]);
    expect(site.requests.slice(since).filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    expect(run.document.checks.map((check) => (check.state === 'EXECUTED' ? [check.result, check.detail, check.url] : [])))
      .toEqual(checks.map(() => ['READ_BLOCKED_BY_POLICY', 'PARAMETER_DANGEROUS_WORD', null]));
  }, TEST_TIMEOUT_MS);

  it('does not read when the candidate drifted (a field added, POST) or is no longer READ (a JS binding), or the page is unknown', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const shape = formOn(await discover(), R.shape);
    expect(shape.classification).toBe('READ');
    const expectations: readonly ReadCheckExpectation[] = [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }];
    for (const [variant, result, detail] of [
      ['extra-field', 'READ_CANDIDATE_DRIFTED', 'CANDIDATE_NOT_FOUND'],
      ['post', 'READ_CANDIDATE_DRIFTED', 'CANDIDATE_NOT_FOUND'],
      ['bound', 'READ_CANDIDATE_NOT_READ', 'CANDIDATE_NOT_READ'],
      ['base', 'MATCHED', 'EXPECTATIONS_EVALUATED'],
    ] as const) {
      site.setShape(variant);
      const since = site.requests.length;
      const run = await runReadChecks([readCheckOf(shape, { q: 'りんご' }, expectations)]);
      expect(run.document.checks.map((check) => (check.state === 'EXECUTED' ? [check.result, check.detail] : [])), variant).toEqual([[result, detail]]);
      const paths = documentsSince(since).map(({ path }) => pathOf(path));
      expect(paths, variant).toEqual(result === 'MATCHED' ? [R.shape, R.orders] : [R.shape]);
    }
    const since = site.requests.length;
    const unknown = await runReadChecks([readCheckOf(shape, { q: 'りんご' }, expectations, null)]);
    expect(unknown.document.checks.map((check) => (check.state === 'EXECUTED' ? [check.result, check.detail] : []))).toEqual([['READ_CANDIDATE_DRIFTED', 'TARGET_PAGE_UNKNOWN']]);
    expect(documentsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS * 2);

  it('does not read when a field to send became hidden, readonly or disabled after the definition was saved (CCX-10, fail-closed)', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const shape = formOn(await discover(), R.shape);
    expect(shape.classification).toBe('READ');
    const expectations: readonly ReadCheckExpectation[] = [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }];
    for (const variant of ['hidden-field', 'readonly-field', 'disabled-field'] as const) {
      site.setShape(variant);
      const since = site.requests.length;
      const run = await runReadChecks([readCheckOf(shape, { q: 'りんご' }, expectations)]);
      expect(run.document.checks.map((check) => (check.state === 'EXECUTED' ? [check.result, check.detail, check.url] : [])), variant)
        .toEqual([['READ_BLOCKED_BY_POLICY', 'PARAMETER_NOT_SENDABLE', null]]);
      // 対象の画面は読むが、READ の URL（GET）はサーバに届かない。
      expect(documentsSince(since).map(({ path }) => pathOf(path)), variant).toEqual([R.shape]);
      expect(site.requests.slice(since).filter(({ path }) => path.includes('?') || pathOf(path) === R.orders), variant).toEqual([]);
      expect(site.requests.slice(since).filter(({ method }) => !READ_METHODS.has(method)), variant).toEqual([]);
    }
  }, TEST_TIMEOUT_MS * 2);

  it('stops at a lost session, tells the redacted URL, and leaves the rest NOT_EXECUTED', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const orders = formOn(await discover(), R.orders);
    const since = site.requests.length;
    const watcher = setInterval(() => {
      // 1 つ目の READ の URL が届いたら、セッションを切る（2 つ目の READ の読み込みで、ログインの画面へ戻される）。
      if (site.requests.slice(since).some(({ path }) => path.includes('?'))) {
        site.expireSessions();
        clearInterval(watcher);
      }
    }, WAIT_POLL_MS);
    try {
      const checks = [1, 2, 3].map(() => readCheckOf(orders, { q: 'りんご' }, [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }]));
      const run = await runReadChecks(checks);
      expect(run.document.endReason).toBe('AUTH_SESSION_LOST');
      expect(run.document.runStatus).toBe('PARTIAL');
      expect(run.document.checks.map((check) => (check.state === 'EXECUTED' ? check.result : check.reason)))
        .toEqual(['MATCHED', 'UNDETERMINED', 'AUTH_SESSION_LOST']);
      expect(executed(run.document, checks[1]?.readCheckId ?? '').detail).toBe('SESSION_LOST');
      expect(run.sessionLost).toHaveLength(1);
      expect(pathOf(new URL(run.sessionLost[0] ?? 'http://x/').pathname)).toBe(DISCOVERY_SITE_PATHS.login);
      // ログインの画面へは移動しない（Guard が読む範囲の外として止める）。GET のほかは送らない。
      expect(site.requests.slice(since).filter(({ path }) => path.startsWith(DISCOVERY_SITE_PATHS.login))).toEqual([]);
      expect(site.requests.slice(since).filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    } finally {
      clearInterval(watcher);
    }
  }, TEST_TIMEOUT_MS);

  it('stops after the current definition when asked to stop', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const orders = formOn(await discover(), R.orders);
    const since = site.requests.length;
    const controller = new AbortController();
    const watcher = setInterval(() => {
      if (site.requests.slice(since).some(({ path }) => path.includes('?'))) {
        controller.abort();
        clearInterval(watcher);
      }
    }, WAIT_POLL_MS);
    try {
      const checks = [1, 2, 3].map(() => readCheckOf(orders, { q: 'りんご' }, [{ kind: 'ROW_COUNT_AT_LEAST', count: 0 }]));
      const run = await runReadChecks(checks, { stopSignal: controller.signal });
      expect(run.document.endReason).toBe('STOPPED');
      expect(run.document.checks.map((check) => (check.state === 'EXECUTED' ? check.result : check.reason))).toEqual(['MATCHED', 'STOPPED', 'STOPPED']);
      expect(site.requests.slice(since).filter(({ path }) => path.includes('?'))).toHaveLength(1);
    } finally {
      clearInterval(watcher);
    }
  }, TEST_TIMEOUT_MS);

  it('cannot load another page in a Context after the freeze (the reason the READ URL is read in a new Context)', async () => {
    site = await startDiscoverySite({ readCheckPages: true });
    const config = configFor();
    const browser = await launch();
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: authenticatedContextOptions(authenticationFor()),
    });
    try {
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${R.orders}`, { waitUntil: 'domcontentloaded' });
      const record = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.origin]) } });
      expect(record.candidates.length).toBeGreaterThan(0);
      const since = site.requests.length;
      const navigation = await page.goto(`${site.origin}${R.orders}?q=x`, { waitUntil: 'domcontentloaded', timeout: 10_000 }).then(() => 'LOADED', () => 'FAILED');
      expect(navigation).toBe('FAILED');
      expect(site.requests.slice(since).filter(({ path }) => path.includes('?'))).toEqual([]);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
      await browser.close();
    }
  }, TEST_TIMEOUT_MS);
});

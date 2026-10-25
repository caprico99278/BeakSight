// T27d（Task 27 の設計書 3 章、4.2、4.4、4.6、6 章）: 発見のジョブの流れ（`src/worker/discovery-run.ts` の `executeDiscoveryRun`）を、同じ process の
// 中で、本物の Chromium（headless だけ。テストの既定と、CLI の起動の設定の両方）と 127.0.0.1 の fixture のサーバ（`discovery-site-fixture.ts`）で
// 確かめる結合テスト。ログインの段は通さず、fixture が作ったセッションを、認証つきの Run の指定（メモリの状態）で渡す（ログインの段からの端から端は
// `discovery-job-fork.test.ts`）。
// - 巡回: 開始の画面から、リンクでつながった管理画面をすべて読み、成果物 `discovery.json`（スキーマに通る）に、読んだ画面と読まなかった画面
//   （除外）と候補（分類）を書く。リンクの抽出は凍結の後の同じページで行い、各画面の読み込みは 1 回だけ。
// - サイトへの要求: GET（と HEAD）だけ。読まないパス・危険な語・読む範囲の外は 0 件。ページ自身の beacon は Guard が止めて数える（サーバへは
//   0 件）。読み込みの間隔は設定の値以上（読み込みの開始どうし。pacer の記録で、許容なし。どの要求も、その開始の後にサーバに届く）。
//   読んだ画面の数は上限以下。
// - 止まり方: 上限（`MAX_PAGES_REACHED`）、セッションの切れ（`AUTH_SESSION_LOST`。伏せ字の後の URL を知らせる）、止める要求（`STOPPED`）。
// - 出力先の開始のロックと Run のロック: 実行の間は Run のロックが動いている Run のものとして見え（CLI の監査から見える）、終わったら消える。
//   出力先に動いている Run があれば、始めずに `RUN_ACTIVE`。
// - 秘密: セッションの値、localStorage の値、トークン、入力の値、hidden の値、選択肢の label が、成果物に出ない。
// 出力先は一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  DISCOVERY_ARTIFACT_FILE_NAME,
  OUTPUT_START_LOCK_FILE_NAME,
  artifactFilePath,
  checkpointArtifactRelativePath,
  listRunDirectories,
} from '../../src/core/artifact-layout.js';
import type { RunId } from '../../src/core/contracts.js';
import { createRunLock, currentProcessRunLockHost, isProcessRunning, judgeRunLock } from '../../src/core/process-lock.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { executeDiscoveryRun, type DiscoveryRunOutcome, type DiscoveryRunRequest } from '../../src/worker/discovery-run.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  DISCOVERY_SITE_FORBIDDEN_PATHS,
  DISCOVERY_SITE_LOCAL_STORAGE_ITEM,
  DISCOVERY_SITE_PATHS,
  DISCOVERY_SITE_READ_CHECK_PATHS,
  DISCOVERY_SITE_READ_PAGES,
  DISCOVERY_SITE_SESSION_COOKIE,
  startDiscoverySite,
  type DiscoverySite,
} from '../helpers/discovery-site-fixture.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { createTestNavigationPacer, forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const TEST_TIMEOUT_MS = 180_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 400;
/** 1 画面を読む時間（落ち着きの待ちを含めて 1 秒前後）より長い、読み込みの最小の間隔（ms。間隔を待っていることを見分ける）。 */
const LONG_NAVIGATION_INTERVAL_MS = 2_500;
/** 読む画面の数より大きい上限。 */
const ENOUGH_PAGES = 30;
const SMALL_MAX_PAGES = 3;
const WAIT_POLL_MS = 20;

/** 期待する分類（画面の path → 分類の一覧）。 */
const EXPECTED_CLASSIFICATIONS: Readonly<Record<string, readonly string[]>> = {
  [DISCOVERY_SITE_PATHS.admin]: [],
  [DISCOVERY_SITE_PATHS.list]: [],
  [DISCOVERY_SITE_PATHS.detail]: [],
  [DISCOVERY_SITE_PATHS.search]: ['READ'],
  [DISCOVERY_SITE_PATHS.create]: ['CREATE'],
  [DISCOVERY_SITE_PATHS.update]: ['UPDATE'],
  [DISCOVERY_SITE_PATHS.remove]: ['NOT_EXECUTABLE'],
  [DISCOVERY_SITE_PATHS.js]: ['NEEDS_BINDING', 'NEEDS_BINDING'],
  [DISCOVERY_SITE_PATHS.spa]: ['READ'],
  [DISCOVERY_SITE_PATHS.variant]: ['READ', 'CREATE'],
  [DISCOVERY_SITE_PATHS.duplicate]: ['READ', 'READ'],
  [DISCOVERY_SITE_PATHS.beacon]: ['READ'],
};

const pathOf = (url: string): string => new URL(url).pathname;

/**
 * 読み込みの間隔の確かめ（`navigation-pacing.test.ts` と同じ方式）: 読み込みの開始（pacer の記録）の間隔が設定の値以上（許容なし）で、開始の数と
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

describe.each(LAUNCHERS)('T27d: the discovery job flow (%s)', (_name, launch) => {
  let site: DiscoverySite;
  let outputDirectory: string;

  beforeAll(async () => {
    // 起動できることを先に確かめる（起動の失敗を、発見の失敗と取り違えない）。
    const browser: Browser = await launch();
    await browser.close();
  });

  beforeEach(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-run-'));
  });

  afterEach(async () => {
    await site?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  afterAll(() => undefined);

  const configFor = (maxPages = ENOUGH_PAGES): AuditConfig => createTestConfig(site.origin, DISCOVERY_SITE_PATHS.admin, {
    crawl: { maxPages, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
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
      excludedPathPrefixes: [DISCOVERY_SITE_PATHS.logout],
      auditPathPrefixes: [DISCOVERY_SITE_PATHS.admin],
      dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
    },
    sessionLostPathPrefix: DISCOVERY_SITE_PATHS.login,
    filterState: filterAuthenticatedState,
  });

  interface Run {
    readonly outcome: DiscoveryRunOutcome;
    readonly document: DiscoveryDocument | null;
    readonly started: readonly { readonly runId: RunId; readonly runDirectory: string }[];
    readonly sessionLost: readonly string[];
    /** Run を始めたときに、出力先の動いている Run として見えたか（CLI の監査の確かめと同じ判定）。 */
    readonly visibleAsActive: boolean;
    /** 読み込みの開始の時刻（pacer の記録。`Date.now()`）。 */
    readonly starts: readonly number[];
  }

  const run = async (config: AuditConfig, overrides: Partial<DiscoveryRunRequest> = {}): Promise<Run> => {
    const started: { runId: RunId; runDirectory: string }[] = [];
    const sessionLost: string[] = [];
    let activeCheck: Promise<boolean> = Promise.resolve(false);
    const starts: number[] = [];
    const pacer = createTestNavigationPacer(config);
    const outcome = await executeDiscoveryRun({
      config,
      jobId: 'job-discovery-1',
      authentication: authenticationFor(),
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
      onRunStarted: (event) => {
        started.push(event);
        activeCheck = (async () => {
          const host = currentProcessRunLockHost(Date.now());
          const lock = await new ArtifactWriter().readRunLock(event.runDirectory);
          return judgeRunLock(lock, { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning }) === 'ACTIVE';
        })();
      },
      onSessionLost: (url) => sessionLost.push(url),
    });
    const document = outcome.kind === 'RAN'
      ? JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument
      : null;
    return { outcome, document, started, sessionLost, visibleAsActive: await activeCheck, starts };
  };

  const readPathsOf = (document: DiscoveryDocument): readonly string[] =>
    document.pages.flatMap((page) => (page.state === 'READ' ? [pathOf(page.url)] : []));

  const candidatesOf = (document: DiscoveryDocument): readonly DiscoveryCandidate[] =>
    document.pages.flatMap((page) => (page.state === 'READ' ? page.record.candidates : []));

  /** 秘密の目印が、`text` に現れたもの。 */
  const leaked = (text: string): readonly string[] => site.secretValues().filter((marker) => text.includes(marker));

  it('reads every linked admin page once, writes discovery.json, and sends only reads with the configured interval', async () => {
    site = await startDiscoverySite();
    const result = await run(configFor());

    expect(result.outcome).toMatchObject({ kind: 'RAN', runStatus: 'COMPLETE', exitCode: 0 });
    const document = result.document;
    if (document === null || result.outcome.kind !== 'RAN') {
      throw new Error('the discovery did not run');
    }
    expect((await validateArtifact('discovery', document)).ok).toBe(true);
    expect(document).toMatchObject({ jobId: 'job-discovery-1', runId: result.outcome.runId, endReason: 'COMPLETED', maxPages: ENOUGH_PAGES });
    // AS-b: 結果の記録に、実効の監査の段の送信の扱い（既定の読み取りだけ）を残す。
    expect(document.auditSendPolicy).toBe('READ_ONLY');
    // 読んだ画面: リンクでつながったすべての管理画面（2 段目の詳細を含む。凍結の後のリンクの抽出で先へ進めた）。
    expect([...readPathsOf(document)].sort()).toEqual([...DISCOVERY_SITE_READ_PAGES].sort());
    // 読まなかった画面: 除外（読まないパス、危険な語、読む範囲の外、ログインの画面）。
    expect(document.pages.flatMap((page) => (page.state === 'NOT_READ' ? [[pathOf(page.url), page.reason]] : [])).sort()).toEqual([
      [DISCOVERY_SITE_PATHS.danger, 'EXCLUDED'],
      [DISCOVERY_SITE_PATHS.logout, 'EXCLUDED'],
      [DISCOVERY_SITE_PATHS.login, 'EXCLUDED'],
      [DISCOVERY_SITE_PATHS.outside, 'EXCLUDED'],
    ].sort());
    // 分類（画面ごと）。
    for (const page of document.pages) {
      if (page.state === 'READ') {
        expect(page.record.candidates.map(({ classification }) => classification), pathOf(page.url))
          .toEqual(EXPECTED_CLASSIFICATIONS[pathOf(page.url)]);
        expect(page.record.incompleteReasons, pathOf(page.url)).toEqual([]);
      }
    }
    // ページ自身の beacon は、Guard が止めて数える（サーバへは届かない）。
    const beacon = document.pages.find((page) => pathOf(page.url) === DISCOVERY_SITE_PATHS.beacon);
    expect(beacon?.state === 'READ' ? beacon.blockedRequests : 0).toBeGreaterThan(0);
    expect(result.outcome.summary).toEqual({ pagesRead: DISCOVERY_SITE_READ_PAGES.length, pagesNotRead: 4, candidates: candidatesOf(document).length });

    // サイトへの要求。
    const requests = site.requests;
    expect(requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    expect(requests.filter(({ path }) => DISCOVERY_SITE_FORBIDDEN_PATHS.includes(path.split('?')[0] ?? path))).toEqual([]);
    const documents = requests.filter(({ adminDocument }) => adminDocument);
    expect(documents.map(({ path }) => path).sort()).toEqual([...DISCOVERY_SITE_READ_PAGES].sort());
    expect(documents.every(({ authenticated }) => authenticated)).toBe(true);
    const otherRequests = requests.filter(({ adminDocument }) => !adminDocument).map(({ path }) => path);
    expect([...new Set(otherRequests)]).toEqual([DISCOVERY_SITE_PATHS.api]);
    expectPaced(result.starts, documents, NAVIGATION_INTERVAL_MS);

    // 出力先の開始のロックと Run のロック: 実行の間は動いている Run として見え、終わったら消える。
    expect(result.visibleAsActive).toBe(true);
    expect(existsSync(artifactFilePath(result.outcome.runDirectory, checkpointArtifactRelativePath('lock')))).toBe(false);
    expect(existsSync(join(outputDirectory, OUTPUT_START_LOCK_FILE_NAME))).toBe(false);
    expect(readdirSync(result.outcome.runDirectory).filter((name) => name !== 'checkpoint')).toEqual([DISCOVERY_ARTIFACT_FILE_NAME]);
    expect(result.started).toEqual([{ runId: result.outcome.runId, runDirectory: result.outcome.runDirectory }]);

    // 秘密: 成果物に出ない。
    expect(leaked(readFileSync(artifactFilePath(result.outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8'))).toEqual([]);
    expect(site.secretValues().length).toBeGreaterThan(5);
  }, TEST_TIMEOUT_MS);

  it('does not write the text, aria-label or title of the row buttons into discovery.json, only the classification words (T27R-fix-1, DEF-086)', async () => {
    // 注文の一覧の各行のボタンの文字・`aria-label`・`title` に、行の目印（表の行の中身の代わり）がある（`readCheckPages`）。
    site = await startDiscoverySite({ readCheckPages: true });
    const result = await run(configFor());
    const document = result.document;
    if (document === null || result.outcome.kind !== 'RAN') {
      throw new Error('the discovery did not run');
    }
    expect((await validateArtifact('discovery', document)).ok).toBe(true);
    expect(leaked(readFileSync(artifactFilePath(result.outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8'))).toEqual([]);
    const rowButtons = candidatesOf(document)
      .filter((candidate) => candidate.page.path === DISCOVERY_SITE_READ_CHECK_PATHS.orders && candidate.kind === 'BUTTON');
    // 行ごとの 3 つのボタン（文字に「編集」、`aria-label` に「削除」、`title` に語なし）は、語の組ごとに同じ識別になる。
    expect([...new Set(rowButtons.map(({ submitterWords, classification, identityDigest }) =>
      JSON.stringify([submitterWords, classification, identityDigest])))].map((entry) => JSON.parse(entry) as readonly unknown[])
      .map(([words, classification]) => [words, classification]).sort())
      .toEqual([[[], 'DISPLAY_ONLY'], [['削除'], 'NOT_EXECUTABLE'], [['編集'], 'DISPLAY_ONLY']].sort());
  }, TEST_TIMEOUT_MS);

  // AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1・2.2）: 監査の段の送信の扱いが `PASS_EXCEPT_DELETE` の発見は、Passive の Context に口を
  // 渡し、ページ自身の beacon（同じ Origin の POST）をサイトに届け、結果の記録に扱いを残す。届くのは beacon だけ（ほかの読み取りでない要求はない）。
  it('lets the beacon of the page reach the site with PASS_EXCEPT_DELETE, and records the policy in discovery.json', async () => {
    site = await startDiscoverySite();
    const config = configFor();
    const result = await run({ ...config, audit: { ...config.audit, sendPolicy: 'PASS_EXCEPT_DELETE' } });
    const document = result.document;
    if (document === null || result.outcome.kind !== 'RAN') {
      throw new Error('the discovery did not run');
    }
    expect((await validateArtifact('discovery', document)).ok).toBe(true);
    expect(document.auditSendPolicy).toBe('PASS_EXCEPT_DELETE');
    const beacon = document.pages.find((page) => pathOf(page.url) === DISCOVERY_SITE_PATHS.beacon);
    expect(beacon?.state === 'READ' ? beacon.blockedRequests : Number.NaN).toBe(0);
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method)).map(({ method, path }) => `${method} ${path.split('?')[0] ?? path}`))
      .toEqual([`POST ${DISCOVERY_SITE_PATHS.collect}`]);
  }, TEST_TIMEOUT_MS);

  it('keeps the configured interval between the page loads even when it is longer than reading a page', async () => {
    site = await startDiscoverySite();
    const config = configFor(SMALL_MAX_PAGES);
    const result = await run({ ...config, crawl: { ...config.crawl, minNavigationIntervalMs: LONG_NAVIGATION_INTERVAL_MS } });
    expect(result.outcome).toMatchObject({ kind: 'RAN' });
    const documents = site.requests.filter(({ adminDocument }) => adminDocument);
    expect(documents).toHaveLength(SMALL_MAX_PAGES);
    expectPaced(result.starts, documents, LONG_NAVIGATION_INTERVAL_MS);
  }, TEST_TIMEOUT_MS);

  it('stops at crawl.maxPages and records the rest as not read (PARTIAL)', async () => {
    site = await startDiscoverySite();
    const result = await run(configFor(SMALL_MAX_PAGES));
    const document = result.document;
    if (document === null) {
      throw new Error('the discovery did not run');
    }
    expect(result.outcome).toMatchObject({ kind: 'RAN', runStatus: 'PARTIAL' });
    expect(document.endReason).toBe('MAX_PAGES_REACHED');
    expect(readPathsOf(document)).toHaveLength(SMALL_MAX_PAGES);
    expect(site.requests.filter(({ adminDocument }) => adminDocument)).toHaveLength(SMALL_MAX_PAGES);
    expect(document.pages.filter((page) => page.state === 'NOT_READ' && page.reason === 'MAX_PAGES_REACHED').length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it('stops at a lost session, tells the redacted URL, and does not read the rest', async () => {
    site = await startDiscoverySite({ expireAfterAdminPages: 2 });
    const result = await run(configFor());
    const document = result.document;
    if (document === null) {
      throw new Error('the discovery did not run');
    }
    expect(document.endReason).toBe('AUTH_SESSION_LOST');
    expect(result.outcome).toMatchObject({ kind: 'RAN', runStatus: 'PARTIAL' });
    expect(readPathsOf(document)).toHaveLength(2);
    expect(result.sessionLost).toHaveLength(1);
    expect(pathOf(result.sessionLost[0] ?? 'http://x/')).toBe(DISCOVERY_SITE_PATHS.login);
    expect(document.pages.filter((page) => page.state === 'NOT_READ' && page.reason === 'AUTH_SESSION_LOST').length).toBeGreaterThan(0);
    // ログインの画面へは移動しない（Guard が読む範囲の外として止める）。GET のほかは送らない。
    expect(site.requests.filter(({ path }) => path.startsWith(DISCOVERY_SITE_PATHS.login))).toEqual([]);
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('stops after the current page when asked to stop', async () => {
    site = await startDiscoverySite();
    const controller = new AbortController();
    const watcher = setInterval(() => {
      if (site.requests.some(({ adminDocument }) => adminDocument)) {
        controller.abort();
        clearInterval(watcher);
      }
    }, WAIT_POLL_MS);
    try {
      const result = await run(configFor(), { stopSignal: controller.signal });
      expect(result.document?.endReason).toBe('STOPPED');
      expect(result.outcome).toMatchObject({ kind: 'RAN', runStatus: 'PARTIAL' });
      expect(readPathsOf(result.document as DiscoveryDocument).length).toBeGreaterThanOrEqual(1);
      expect(readPathsOf(result.document as DiscoveryDocument).length).toBeLessThan(DISCOVERY_SITE_READ_PAGES.length);
    } finally {
      clearInterval(watcher);
    }
  }, TEST_TIMEOUT_MS);

  it('does not start when a Run in the output directory is active (RUN_ACTIVE), and reads nothing', async () => {
    site = await startDiscoverySite();
    const activeRunId = 'RUN-20261011000000' as RunId;
    const activeDirectory = join(outputDirectory, activeRunId);
    const writer = new ArtifactWriter();
    expect((await writer.acquireRunLock(activeDirectory, createRunLock(currentProcessRunLockHost(Date.now())))).acquired).toBe(true);
    const result = await run(configFor());
    expect(result.outcome).toEqual({ kind: 'RUN_ACTIVE', activeRunId, exitCode: 4 });
    expect(result.started).toEqual([]);
    expect(site.requests).toEqual([]);
    expect((await listRunDirectories(outputDirectory)).map(({ runId }) => runId)).toEqual([activeRunId]);
  }, TEST_TIMEOUT_MS);
});

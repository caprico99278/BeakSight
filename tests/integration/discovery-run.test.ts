// T27d（Task 27 の設計書 3 章、4.2、4.4、4.6、6 章）: 発見のジョブの流れ（`src/worker/discovery-run.ts` の `executeDiscoveryRun`）を、同じ process の
// 中で、本物の Chromium（テストの既定。漏れの確かめの場面だけ、CLI の起動の設定でも）と 127.0.0.1 の fixture のサーバ（`discovery-site-fixture.ts`）で
// 確かめる結合テスト。ログインの段は通さず、fixture が作ったセッションを、認証つきの Run の指定（メモリの状態）で渡す（ログインの段からの端から端は
// 画面の `full-flow.test.ts`）。
// - 巡回: 開始の画面から、リンクでつながった管理画面をすべて読み、成果物 `discovery.json`（スキーマに通る）に、読んだ画面と読まなかった画面
//   （除外）と候補（分類）を書く。リンクの抽出は凍結の後の同じページで行い、各画面の読み込みは 1 回だけ。
// - サイトへの要求: GET（と HEAD）だけ。読まないパス・危険な語・読む範囲の外は 0 件。ページ自身の beacon は Guard が止めて数える（サーバへは
//   0 件）。読み込みの間隔は設定の値以上（読み込みの開始どうし。pacer の記録で、許容なし。どの要求も、その開始の後にサーバに届く）。
//   読んだ画面の数は上限以下。
// - 止まり方: セッションの切れ（`AUTH_SESSION_LOST`。伏せ字の後の URL を知らせる）。RB-8: 上限と止める要求で止まる巡回の輪は、偽の巡回の口の単体
//   （`tests/unit/discovery-crawl.test.ts`）で確かめる。
// - 出力先の監査中の印: 実行の間は動いている Run のものとして見え（CLI の監査から見える）、終わったら離す。動いている Run があれば始めない（`RUN_ACTIVE`）
//   ことは、単体 `output-start-lock.test.ts` と結合 `integration/output-start-lock.test.ts`（SPEC-2 の排他）で確かめる。
// - 秘密: セッションの値、localStorage の値、トークン、入力の値、hidden の値、選択肢の label が、成果物に出ない。
// 出力先は一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
// SLIM BD-3: 前の discovery-probe（T27b。発見の入口の読み取り）を、このファイルの後半に取り込んだ。両方の Chromium に広げるのは、発見のジョブの流れの
// 1 場面（読み取りだけ・間隔・ページ自身の beacon を止める・秘密）と、T27b のページ自身の beacon・POST を止める場面と読む前の凍結の場面だけ。ほかは組の先頭の回。
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { wait } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  DISCOVERY_ARTIFACT_FILE_NAME,
  artifactFilePath,
} from '../../src/core/artifact-layout.js';
import type { RunId } from '../../src/core/contracts.js';
import { acquireRunExclusion, type RunExclusion } from '../../src/core/run-exclusion.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { DISCOVERY_READ_TIMEOUT_MS, discoverPageCandidates } from '../../src/discovery/discover-page.js';
import type { DiscoveryDocument, DiscoveryReadPageRecord } from '../../src/discovery/discovery-result.js';
import { probePageCandidates } from '../../src/discovery/probe.js';
import { readPageStructure, readSettledPageStructure } from '../../src/discovery/read-executor.js';
import { DISCOVERY_SETTLE_TIMEOUT_MS, InFlightRequestCounter } from '../../src/discovery/settle.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { assertPassiveRequestGuardActive } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeDiscoveryRun, type DiscoveryRunOutcome, type DiscoveryRunRequest } from '../../src/worker/discovery-run.js';
import { BOTH_CHROMIUM_LAUNCHERS, ONCE_CHROMIUM_LABEL } from '../helpers/chromium.js';
import {
  DISCOVERY_FIXTURE_PATHS,
  MANY_OPTIONS_COUNT,
  PAGE_HITS_GLOBAL,
  SPA_LATE_HEADING_TEXT,
  startDiscoveryFixture,
  type DiscoveryFixture,
  type DiscoveryFixtureRequest,
} from '../helpers/discovery-fixture.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
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
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';

/**
 * TEST-SLIM D2（TEST-POLICY の 3）: 2 つの Chromium で流すのは、読み取りでない要求・読まないパス・ログインの画面がサイトに届かないこと、秘密が成果物に
 * 出ないことの場面だけ。止まり方とロックの場面は、既定の Chromium だけで流す。
 */
const DEFAULT_LABEL = ONCE_CHROMIUM_LABEL;
const TEST_TIMEOUT_MS = 180_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 400;
/** 読む画面の数より大きい上限。 */
const ENOUGH_PAGES = 30;

/** 取った監査中の印を離す（取れたときだけ）。 */
async function releaseIfAcquired(exclusion: RunExclusion): Promise<void> {
  if (exclusion.kind === 'ACQUIRED') {
    await exclusion.release();
  }
}

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

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T27d: the discovery job flow (%s)', (name, launch) => {
  const itOnDefault = it.runIf(name === DEFAULT_LABEL);
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
      // SLIM-2（X2）: probe の観察はテストの短い値（本番の値は `production-wait-values` と Gate (n)(p) が確かめる）。
      observationWindows: TEST_OBSERVATION_WINDOWS,
      ...overrides,
    }, {
      onRunStarted: (event) => {
        started.push(event);
        activeCheck = (async () => {
          const exclusion = await acquireRunExclusion(dirname(event.runDirectory));
          await releaseIfAcquired(exclusion);
          return exclusion.kind === 'HELD';
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

    // 出力先の監査中の印（SPEC-2）: 実行の間は動いている Run として見え、終わったら離す。
    expect(result.visibleAsActive).toBe(true);
    const after = await acquireRunExclusion(outputDirectory);
    expect(after.kind).toBe('ACQUIRED');
    await releaseIfAcquired(after);
    expect(readdirSync(result.outcome.runDirectory).filter((name) => name !== 'checkpoint')).toEqual([DISCOVERY_ARTIFACT_FILE_NAME]);
    expect(result.started).toEqual([{ runId: result.outcome.runId, runDirectory: result.outcome.runDirectory }]);

    // 秘密: 成果物に出ない。
    expect(leaked(readFileSync(artifactFilePath(result.outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8'))).toEqual([]);
    expect(site.secretValues().length).toBeGreaterThan(5);
  }, TEST_TIMEOUT_MS);

  itOnDefault('does not write the text, aria-label or title of the row buttons into discovery.json, only the classification words (T27R-fix-1, DEF-086)', async () => {
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
  itOnDefault('lets the beacon of the page reach the site with PASS_EXCEPT_DELETE, and records the policy in discovery.json', async () => {
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

  // RB-8: ページの上限と止める印で止まる場面は、巡回の輪の場面として偽の巡回の口で確かめる（`tests/unit/discovery-crawl.test.ts`）。読み込みの間隔は
  // `navigation-pacing` が確かめる。セッションの切れは、本物の画面のログインの画面への移りを見分けるので、ここに残す。
  itOnDefault('stops at a lost session, tells the redacted URL, and does not read the rest', async () => {
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
    // SD-2: Guard は main frame の移動を止めないので、ログインの画面への移りは GET で届く（読み取りとしては使わない）。GET のほかは送らない。
    expect(site.requests.filter(({ path }) => path.startsWith(DISCOVERY_SITE_PATHS.login)).map(({ method }) => method)).toEqual(['GET']);
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// ---------- T27b（Task 27 の設計書 4.2、6 章）: 発見の入口（`discoverPageCandidates`）の読み取り ----------
// 本物の factory の Passive の Context（Guard つき）と、127.0.0.1 の fixture のサーバ（`tests/helpers/discovery-fixture.ts`）で確かめる。
// - 候補の形と分類（T27a の分類を通した結果）、値・トークン・選択肢の label・hidden の値が結果に出ない、候補が成果物のスキーマに通る。
// - 発見の間（呼んでから、終わって `QUIET_PERIOD_MS` 待つまで）に fixture のサーバが受けた要求は 0 件。サーバが受けた GET 以外の要求は、全体で 0 件
//   （ページ自身の beacon と fetch の POST は、Guard が止めて Safety Ledger に記録する）。
// - SPA の待ち、落ち着かない画面の不完全の記録、closed な shadow root と iframe の不完全の記録、open な shadow root の中の form、DOM clobbering の
//   フォーム、凍結の後のページの JS の送信がサーバに届かないこと、凍結の条件（page が 1 つ）が満たされないときは読まずに不完全として返すこと。
// - DEF-087: ページの JS が標準の getter とメソッドを偽っても、probe と READ の結果の構造の読み取りが本来の値を返すこと（isolated world で読む）、
//   読み取りの間にページの JS が走らないこと、読み込み直しで古くなった world と期限切れが、読めなかった結果（fail-closed）になること。

/** 発見の後に、遅れて届く要求を待つ時間（ms）。 */
const QUIET_PERIOD_MS = 500;
/** 落ち着かない画面のテストの上限（ms）。落ち着きの待ちの上限と、読み取りの時間を含む。 */
const UNSTABLE_TEST_TIMEOUT_MS = 60_000;
const NO_LISTENERS = { form: [], submitter: [], ancestor: [], document: [], window: [], inlineHandler: false };
const NO_CONSTRAINTS = { pattern: null, min: null, max: null, step: null, minlength: null, maxlength: null, autocomplete: null };
/** DEF-087: ページの主の thread を占める時間（ms）と、占めている間の読み取りの期限（ms）、占め始めるのを待つ時間（ms）。 */
const BUSY_PAGE_MS = 3_000;
const BUSY_READ_DEADLINE_MS = 300;
const BUSY_START_WAIT_MS = 100;

/** DEF-087: ページの JS が走った回数（`PAGE_HITS_GLOBAL`）を、CDP の `Runtime.evaluate` で値として読む（ページの getter やメソッドを呼ばない）。 */
const readPageHits = async (page: Page): Promise<number> => {
  const session = await page.context().newCDPSession(page);
  try {
    const { result } = await session.send('Runtime.evaluate', { expression: `window.${PAGE_HITS_GLOBAL}`, returnByValue: true });
    return typeof result.value === 'number' ? result.value : Number.NaN;
  } finally {
    await session.detach();
  }
};

interface EntryDiscovery {
  readonly record: DiscoveryReadPageRecord;
  /** 発見を呼んでから、終わって `QUIET_PERIOD_MS` 待つまでに、サーバが受けた要求。 */
  readonly requestsDuringDiscovery: readonly DiscoveryFixtureRequest[];
  readonly elapsedMs: number;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly ledger: SafetyLedger;
}

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T27b: discovering candidates by reading only (%s)', (name, launch) => {
  const itOnDefault = it.runIf(name === DEFAULT_LABEL);
  let browser: Browser;
  let fixture: DiscoveryFixture;
  const resources: { factory: BrowserContextFactory; context: BrowserContext }[] = [];

  beforeAll(async () => {
    browser = await launch();
    fixture = await startDiscoveryFixture();
  });

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      await closePassiveResources(resource);
      await resource.factory.close();
    }
  });

  afterAll(async () => {
    // 全体で、GET と HEAD 以外の要求は 1 件もサーバに届かない。
    expect(fixture?.requests.filter(({ method }) => !READ_METHODS.has(method)) ?? []).toEqual([]);
    await fixture?.close();
    await browser?.close();
  });

  /** Guard つきの Passive の Context で画面を開く（要求の数え方は、読み込みの前に付ける）。 */
  const open = async (path: string): Promise<{ page: Page; context: BrowserContext; ledger: SafetyLedger; counter: InFlightRequestCounter; factory: BrowserContextFactory }> => {
    const config = createTestConfig(fixture.origin);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    resources.push({ factory, context });
    const page = await factory.createPassivePage(context);
    const counter = new InFlightRequestCounter(page);
    await page.goto(fixture.url(path));
    return { page, context, ledger: factory.getSafetyLedger(context), counter, factory };
  };

  /** `ready` は、発見を始める前に待つこと（ページ自身の要求がサーバに届くのを待つなど）。 */
  const discover = async (path: string, ready?: () => Promise<void>): Promise<EntryDiscovery> => {
    const { page, context, ledger, counter } = await open(path);
    await ready?.();
    const start = fixture.requests.length;
    const startedAt = Date.now();
    const record = await discoverPageCandidates(page, {
      classificationPolicy: { allowedOrigins: new Set([fixture.origin]) },
      requestCounter: counter,
    });
    const elapsedMs = Date.now() - startedAt;
    counter.dispose();
    await wait(QUIET_PERIOD_MS);
    return { record, requestsDuringDiscovery: fixture.requests.slice(start), elapsedMs, page, context, ledger };
  };

  /** 値・トークン・選択肢の label・hidden の値の目印が、結果のどこにも出ない。候補は成果物のスキーマに通る。 */
  const expectSafeRecord = (record: DiscoveryReadPageRecord): void => {
    const text = JSON.stringify(record);
    for (const value of Object.values(fixture.markers)) {
      expect(text.includes(value), value).toBe(false);
    }
    for (const candidate of record.candidates) {
      const result = validateControlDocument('candidate', candidate);
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(candidate.incompleteReasons).toEqual(record.incompleteReasons);
      expect(candidate.page).toEqual(record.location);
    }
  };

  const byName = (candidate: DiscoveryCandidate | undefined, fieldName: string) => candidate?.fields.find((field) => field.name === fieldName);

  itOnDefault('reads a GET search form as READ, with option values but without input values or option labels', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.search);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.location).toEqual({ origin: fixture.origin, path: DISCOVERY_FIXTURE_PATHS.search });
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates).toHaveLength(1);
    const [candidate] = record.candidates;
    expect(candidate).toMatchObject({
      kind: 'FORM',
      formMethod: 'GET',
      methodOverride: null,
      action: { origin: fixture.origin, path: '/items', queryNames: [] },
      enctype: 'application/x-www-form-urlencoded',
      target: '',
      // T27R-fix-1（DEF-086）: ボタンの文言「検索」は持たず、分類の語だけを持つ。
      submitterWords: ['検索'],
      jsBinding: NO_LISTENERS,
      classification: 'READ',
      reasonCode: 'READ_GET_FORM',
      hasStateField: false,
    });
    expect(candidate?.identityDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(candidate?.fields).toEqual([
      {
        name: 'q', tag: 'input', type: 'search', required: true, readonly: false, disabled: false, hidden: false,
        constraints: { ...NO_CONSTRAINTS, pattern: '[^<>]*', maxlength: '50' }, options: null, omittedOptionCount: 0, hasValue: true,
      },
      {
        name: 'category', tag: 'select', type: 'select-one', required: false, readonly: false, disabled: false, hidden: false,
        constraints: NO_CONSTRAINTS, options: ['', 'a', ''], omittedOptionCount: 0, hasValue: true,
      },
      {
        name: 'in_stock', tag: 'input', type: 'checkbox', required: false, readonly: false, disabled: false, hidden: false,
        constraints: NO_CONSTRAINTS, options: ['1'], omittedOptionCount: 0, hasValue: true,
      },
      {
        name: 'sort', tag: 'input', type: 'radio', required: false, readonly: false, disabled: false, hidden: false,
        constraints: NO_CONSTRAINTS, options: ['new'], omittedOptionCount: 0, hasValue: false,
      },
      {
        name: 'sort', tag: 'input', type: 'radio', required: false, readonly: false, disabled: false, hidden: false,
        constraints: NO_CONSTRAINTS, options: ['on'], omittedOptionCount: 0, hasValue: false,
      },
    ]);
  });

  itOnDefault('reads the registration, update and delete forms (CREATE, UPDATE by _method, NOT_EXECUTABLE), without tokens', async () => {
    const create = await discover(DISCOVERY_FIXTURE_PATHS.create);
    expect(create.requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(create.record);
    expect(create.record.candidates.map(({ classification, reasonCode, formMethod }) => [classification, reasonCode, formMethod]))
      .toEqual([['CREATE', 'CREATE_WORD', 'POST']]);
    expect(byName(create.record.candidates[0], 'authenticity_token')).toMatchObject({ type: 'hidden', hidden: true, hasValue: true });
    expect(byName(create.record.candidates[0], 'note')).toMatchObject({ tag: 'textarea', type: 'textarea', hasValue: true });
    // OP-2 の修正の 1 回目（判断 2）: 登録の画面は h1 を持たず、題だけを画面の名前として持つ（isolated world で読む。要求はない）。
    expect(create.record.screenName).toEqual({ heading: null, title: '登録' });

    const update = await discover(DISCOVERY_FIXTURE_PATHS.update);
    expect(update.requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(update.record);
    expect(update.record.candidates.map(({ classification, reasonCode, methodOverride }) => [classification, reasonCode, methodOverride]))
      .toEqual([['UPDATE', 'UPDATE_METHOD', 'PATCH']]);

    const remove = await discover(DISCOVERY_FIXTURE_PATHS.remove);
    expect(remove.requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(remove.record);
    expect(remove.record.candidates.map(({ classification, reasonCode, methodOverride, submitterWords }) =>
      [classification, reasonCode, methodOverride, submitterWords])).toEqual([['NOT_EXECUTABLE', 'DESTRUCTIVE', 'DELETE', ['削除']]]);

    // 新しい token で読み込み直しても、識別と規則の digest は変わらない。
    const again = await discover(DISCOVERY_FIXTURE_PATHS.create);
    expect(again.record.candidates[0]?.identityDigest).toBe(create.record.candidates[0]?.identityDigest);
    expect(again.record.candidates[0]?.ruleDigest).toBe(create.record.candidates[0]?.ruleDigest);
  });

  itOnDefault('keeps only the classification words of the row buttons, not their text, aria-label or title (T27R-fix-1, DEF-086)', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.rowButtons);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    const rows = [1, 2, 3];
    expect(record.candidates.map(({ kind, submitterWords, classification, reasonCode }) => [kind, submitterWords, classification, reasonCode])).toEqual([
      ...rows.flatMap(() => [['FORM', ['編集'], 'UPDATE', 'UPDATE_WORD'], ['FORM', ['削除'], 'NOT_EXECUTABLE', 'DESTRUCTIVE']]),
      ...rows.map(() => ['BUTTON', ['検索'], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION']),
    ]);
    // 行ごとの文言の違いは、識別の digest を変えない。
    expect(new Set(record.candidates.map(({ identityDigest }) => identityDigest)).size).toBe(3);
  });

  itOnDefault('reads the JS bindings (element listeners, inline onsubmit, buttons outside the forms) through CDP', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.jsBound);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.candidates.map(({ kind, submitterWords, classification, reasonCode }) => [kind, submitterWords, classification, reasonCode])).toEqual([
      ['FORM', [], 'NEEDS_BINDING', 'JS_BOUND'],
      ['FORM', [], 'NEEDS_BINDING', 'JS_BOUND'],
      ['BUTTON', [], 'NEEDS_BINDING', 'JS_BOUND'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
    ]);
    const [element, inline, outsideBound, outsidePlain] = record.candidates;
    expect(element?.jsBinding).toEqual({ ...NO_LISTENERS, form: ['submit'] });
    expect(inline?.jsBinding).toEqual({ ...NO_LISTENERS, form: ['submit'], inlineHandler: true });
    expect(outsideBound?.jsBinding).toEqual({ ...NO_LISTENERS, submitter: ['click'] });
    expect(outsidePlain?.jsBinding).toEqual(NO_LISTENERS);
    expect(outsideBound).toMatchObject({ formMethod: null, action: null, enctype: null, target: null, fields: [] });
  });

  itOnDefault('lists the buttons inside a form that are not submit buttons as BUTTON candidates that cannot be run (round 1)', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.formButtons);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates.map(({ kind, submitterWords, classification, reasonCode }) => [kind, submitterWords, classification, reasonCode])).toEqual([
      ['FORM', ['登録'], 'CREATE', 'CREATE_WORD'],
      ['BUTTON', [], 'NEEDS_BINDING', 'JS_BOUND'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', ['削除'], 'NOT_EXECUTABLE', 'DESTRUCTIVE'],
    ]);
    const buttons = record.candidates.filter(({ kind }) => kind === 'BUTTON');
    for (const button of buttons) {
      expect(button).toMatchObject({ formMethod: null, methodOverride: null, action: null, enctype: null, target: null, fields: [] });
    }
    expect(buttons[0]?.jsBinding).toEqual({ ...NO_LISTENERS, submitter: ['click'] });
    expect(buttons.every(({ classification }) => ['NEEDS_BINDING', 'DISPLAY_ONLY', 'NOT_EXECUTABLE'].includes(classification))).toBe(true);
  });

  itOnDefault('marks every candidate as NEEDS_BINDING when the document delegates clicks', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.jsDelegated);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.candidates.map(({ formMethod, classification, reasonCode, jsBinding }) => [formMethod, classification, reasonCode, jsBinding.document]))
      .toEqual([['GET', 'NEEDS_BINDING', 'JS_DELEGATED', ['click']], ['POST', 'NEEDS_BINDING', 'JS_DELEGATED', ['click']]]);
  });

  itOnDefault('finds no candidate on the list and detail pages, and reads them completely', async () => {
    for (const [path, title] of [[DISCOVERY_FIXTURE_PATHS.list, '一覧'], [DISCOVERY_FIXTURE_PATHS.detail, '詳細']] as const) {
      const { record, requestsDuringDiscovery } = await discover(path);
      expect(requestsDuringDiscovery).toEqual([]);
      expect(record).toEqual({ location: { origin: fixture.origin, path }, incompleteReasons: [], candidates: [], screenName: { heading: title, title } });
    }
  });

  // OP-K（K1）: SPA の見出しが後から描かれる画面は、凍結の前に上限まで待って、見出しを画面の名前にする。見出しのない画面は、上限だけ待って、題を残す。
  itOnDefault('waits for the heading that a SPA renders late, and keeps the title of a SPA without a heading (OP-K K1)', async () => {
    const late = await discover(DISCOVERY_FIXTURE_PATHS.spaLateHeading);
    expect(late.requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(late.record);
    expect(late.record.screenName).toEqual({ heading: SPA_LATE_HEADING_TEXT, title: 'SPA' });
    const none = await discover(DISCOVERY_FIXTURE_PATHS.spaNoHeading);
    expect(none.requestsDuringDiscovery).toEqual([]);
    expect(none.record.screenName).toEqual({ heading: null, title: 'SPA' });
    expect(none.record.candidates).toHaveLength(1);
  });

  itOnDefault('waits for a SPA that renders its form after a GET response', async () => {
    // ページ自身の GET（応答はサーバが遅らせる）がサーバに届いてから、発見を始める。
    const apiRequests = (): number => fixture.requests.filter(({ path }) => path === DISCOVERY_FIXTURE_PATHS.apiItems).length;
    const before = apiRequests();
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.spa, async () => {
      await expect.poll(apiRequests).toBe(before + 1);
    });
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates.map(({ classification, fields }) => [classification, fields.map(({ name: fieldName }) => fieldName)])).toEqual([['READ', ['q']]]);
  });

  itOnDefault('records a page that does not settle within the limit as incomplete (INCOMPLETE_SETTLE_TIMEOUT)', async () => {
    const { record, requestsDuringDiscovery, elapsedMs } = await discover(DISCOVERY_FIXTURE_PATHS.spaUnstable);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(elapsedMs).toBeGreaterThanOrEqual(DISCOVERY_SETTLE_TIMEOUT_MS);
    expect(record.incompleteReasons).toEqual(['INCOMPLETE_SETTLE_TIMEOUT']);
    expect(record.candidates.length).toBeGreaterThan(0);
  }, UNSTABLE_TEST_TIMEOUT_MS);

  itOnDefault('reads readonly, disabled (fieldset), hidden, select, checkbox, file fields and the submit button overrides', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.controls);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.incompleteReasons).toEqual([]);
    const [preview, save] = record.candidates;
    expect(record.candidates.map(({ kind, submitterWords, classification, reasonCode }) => [kind, submitterWords, classification, reasonCode])).toEqual([
      ['FORM', [], 'READ', 'READ_GET_FORM'],
      ['FORM', ['保存'], 'UPDATE', 'UPDATE_WORD'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
      ['BUTTON', [], 'DISPLAY_ONLY', 'NO_KNOWN_ACTION'],
    ]);
    expect(preview).toMatchObject({
      kind: 'FORM',
      formMethod: 'GET',
      action: { origin: fixture.origin, path: '/preview', queryNames: ['mode', 'lang'] },
      enctype: 'text/plain',
      target: 'preview',
      submitterWords: [],
      hasStateField: true,
    });
    expect(save).toMatchObject({
      kind: 'FORM',
      formMethod: 'POST',
      action: { origin: fixture.origin, path: '/settings', queryNames: [] },
      enctype: 'multipart/form-data',
      target: '_self',
      submitterWords: ['保存'],
      classification: 'UPDATE',
      reasonCode: 'UPDATE_WORD',
    });
    expect(save?.fields.map(({ name: fieldName, type }) => [fieldName, type])).toEqual([
      ['csrf', 'hidden'], ['secret_hidden', 'hidden'], ['title', 'text'], ['locked', 'text'], ['invisible', 'text'], ['count', 'number'],
      ['mail', 'email'], ['upload', 'file'], ['many', 'select-one'], ['multi', 'select-multiple'], ['active', 'checkbox'],
      ['body', 'textarea'], ['weird', 'text'], ['', 'text'],
    ]);
    expect(byName(save, 'csrf')).toMatchObject({ hidden: true, hasValue: true });
    expect(byName(save, 'title')).toMatchObject({ readonly: true, disabled: false, hidden: false, hasValue: true });
    expect(byName(save, 'locked')).toMatchObject({ readonly: false, disabled: true, hidden: false, hasValue: true });
    expect(byName(save, 'invisible')).toMatchObject({ hidden: true, hasValue: false });
    expect(byName(save, 'count')?.constraints).toEqual({ ...NO_CONSTRAINTS, min: '1', max: '10', step: '1' });
    expect(byName(save, 'mail')?.constraints).toEqual({ ...NO_CONSTRAINTS, minlength: '3', autocomplete: 'email' });
    expect(byName(save, 'upload')).toMatchObject({ hasValue: false, options: null });
    const many = byName(save, 'many');
    // L13（N29）: 選択肢は件数で切らない。
    expect(many?.options).toHaveLength(MANY_OPTIONS_COUNT);
    expect(many?.options?.[0]).toBe('o0');
    expect(many?.omittedOptionCount).toBe(0);
    expect(byName(save, 'multi')).toMatchObject({ options: ['x'], hasValue: true });
    expect(byName(save, 'active')).toMatchObject({ options: ['yes'], hasValue: false });
    expect(byName(save, 'body')).toMatchObject({ hasValue: true });
    expect(save?.fields.some(({ name: fieldName }) => fieldName === 'op')).toBe(false);
  });

  itOnDefault('reads a form inside an open shadow root, and records pages with a closed shadow root or an iframe as incomplete', async () => {
    const openShadow = await discover(DISCOVERY_FIXTURE_PATHS.shadowOpen);
    expect(openShadow.requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(openShadow.record);
    expect(openShadow.record.incompleteReasons).toEqual([]);
    expect(openShadow.record.candidates.map(({ classification, fields }) => [classification, fields.map(({ name: fieldName }) => fieldName)])).toEqual([['READ', ['q']]]);
    for (const path of [DISCOVERY_FIXTURE_PATHS.shadowClosed, DISCOVERY_FIXTURE_PATHS.iframe]) {
      const { record, requestsDuringDiscovery } = await discover(path);
      expect(requestsDuringDiscovery, path).toEqual([]);
      expectSafeRecord(record);
      expect(record.incompleteReasons, path).toEqual(['INCOMPLETE_FRAME_OR_CLOSED_SHADOW']);
      expect(record.candidates.map(({ formMethod, classification }) => [formMethod, classification]), path).toEqual([['GET', 'READ']]);
    }
  });

  itOnDefault('is not misled by DOM clobbering on the form and on the document', async () => {
    const { record, requestsDuringDiscovery } = await discover(DISCOVERY_FIXTURE_PATHS.clobber);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates).toHaveLength(2);
    const [named, clobbered] = record.candidates;
    expect(named).toMatchObject({ formMethod: 'GET', action: { path: DISCOVERY_FIXTURE_PATHS.clobber }, fields: [], submitterWords: [] });
    expect(clobbered).toMatchObject({
      formMethod: 'POST',
      action: { origin: fixture.origin, path: '/clobbered', queryNames: [] },
      enctype: 'application/x-www-form-urlencoded',
      target: '',
      submitterWords: ['登録'],
      classification: 'CREATE',
    });
    expect(clobbered?.fields.map(({ name: fieldName }) => fieldName)).toEqual([
      'action', 'method', 'elements', 'attributes', 'getAttribute', 'hasAttribute', 'enctype', 'target', 'children', 'localName', 'nodeType',
      'parentNode', 'submit', 'id',
    ]);
  });

  it('lets the Guard block and record the beacon and fetch POSTs of the page itself (the server never receives them)', async () => {
    const { record, requestsDuringDiscovery, ledger } = await discover(DISCOVERY_FIXTURE_PATHS.beacon);
    expect(requestsDuringDiscovery).toEqual([]);
    expectSafeRecord(record);
    expect(record.candidates.map(({ classification }) => classification)).toEqual(['READ']);
    expect(fixture.requests.filter(({ path }) => path === DISCOVERY_FIXTURE_PATHS.collect)).toEqual([]);
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedRequests.filter(({ method }) => method === 'POST').length).toBeGreaterThan(0);
    expect(snapshot.invariantViolations).toEqual([]);
  });

  it('freezes the page before reading, so that the scripts of the page cannot send anything afterwards', async () => {
    const { record, requestsDuringDiscovery, page, ledger } = await discover(DISCOVERY_FIXTURE_PATHS.sender);
    expect(requestsDuringDiscovery).toEqual([]);
    expect(record.candidates).toHaveLength(1);
    const start = fixture.requests.length;
    await page.evaluate((collect) => {
      navigator.sendBeacon(collect, 'after-freeze');
      void fetch(collect, { method: 'POST', body: 'after-freeze' }).catch(() => undefined);
      void fetch(`${collect}?get=after-freeze`).catch(() => undefined);
      const image = new Image();
      image.src = `${collect}?image=after-freeze`;
      const form = document.getElementById('send');
      if (form instanceof HTMLFormElement) {
        HTMLFormElement.prototype.submit.call(form);
      }
    }, DISCOVERY_FIXTURE_PATHS.collect).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
    // DEF-208-1: 凍結の後も、許可 Origin への読み取り（GET の fetch と画像）は監査の段と同じ判定で通す。読み取りでない送信は、今どおりサーバに届かない。
    const afterFreeze = fixture.requests.slice(start);
    expect(afterFreeze.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    expect(afterFreeze.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
      `GET ${DISCOVERY_FIXTURE_PATHS.collect}?get=after-freeze`,
      `GET ${DISCOVERY_FIXTURE_PATHS.collect}?image=after-freeze`,
    ]);
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedInteractionRequests.length + snapshot.blockedInteractionNavigations.length).toBeGreaterThan(0);
  });

  itOnDefault('does not read a page whose context has another page (the freeze conditions do not hold)', async () => {
    const { page, context, counter, factory } = await open(DISCOVERY_FIXTURE_PATHS.search);
    await factory.createPassivePage(context);
    const start = fixture.requests.length;
    const record = await discoverPageCandidates(page, {
      classificationPolicy: { allowedOrigins: new Set([fixture.origin]) },
      requestCounter: counter,
    });
    counter.dispose();
    await wait(QUIET_PERIOD_MS);
    expect(fixture.requests.slice(start)).toEqual([]);
    expect(record).toEqual({
      location: { origin: fixture.origin, path: DISCOVERY_FIXTURE_PATHS.search },
      incompleteReasons: ['INCOMPLETE_FREEZE_UNAVAILABLE'],
      candidates: [],
    });
    // 凍結を呼ばないので、Guard は無効にならない。
    expect(() => assertPassiveRequestGuardActive(context)).not.toThrow();
  });

  // DEF-087: probe と構造の読み取りは、CDP の isolated world で動く（ページの JS が、標準の getter とメソッドの結果を偽れない）。
  itOnDefault.each([
    ['Function.prototype.call', DISCOVERY_FIXTURE_PATHS.forgedCall],
    ['the prototype getters', DISCOVERY_FIXTURE_PATHS.forgedPrototype],
    ['Function.prototype.call, in an open shadow root', DISCOVERY_FIXTURE_PATHS.forgedShadow],
  ])('keeps the delete form DESTRUCTIVE when the page forges the standard getters by %s (DEF-087)', async (_forgery, path) => {
    const { record, requestsDuringDiscovery, page } = await discover(path);
    expect(requestsDuringDiscovery).toEqual([]);
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates.map(({ formMethod, methodOverride, action, classification, reasonCode }) =>
      [formMethod, methodOverride, action?.path, classification, reasonCode])).toEqual([['POST', 'DELETE', '/items/1', 'NOT_EXECUTABLE', 'DESTRUCTIVE']]);
    // 偽りは、main world では効いている（fixture が壊れていて GREEN になったのではない）。
    const forgedMethod = await page.evaluate(() => {
      const form = document.getElementById('del') ?? document.getElementById('host')?.shadowRoot?.getElementById('del');
      return Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'method')?.get?.call(form);
    });
    expect(forgedMethod).toBe('get');
  });

  itOnDefault('reads the structure of a READ result honestly when the page forges the collection length and innerText (DEF-087)', async () => {
    const { page, counter } = await open(DISCOVERY_FIXTURE_PATHS.forgedStructure);
    const read = await readSettledPageStructure(page, counter);
    counter.dispose();
    expect(read).toMatchObject({
      status: 'READ',
      structure: {
        region: 'MAIN', tableRowCounts: [3], listItemCounts: [2], detailEntries: [{ term: '状態', value: '有効' }], text: 'h 1 2 3 a b 状態 有効',
      },
    });
    const forgedLength = await page.evaluate(() =>
      Object.getOwnPropertyDescriptor(HTMLCollection.prototype, 'length')?.get?.call(document.querySelector('ul')?.children));
    expect(forgedLength).toBe(1);
  });

  itOnDefault('does not run the page JS while discovering and reading the structure (DEF-087)', async () => {
    const { page, counter } = await open(DISCOVERY_FIXTURE_PATHS.countingHooks);
    const before = await readPageHits(page);
    expect(Number.isSafeInteger(before)).toBe(true);
    const record = await discoverPageCandidates(page, {
      classificationPolicy: { allowedOrigins: new Set([fixture.origin]) },
      requestCounter: counter,
    });
    expect(record.incompleteReasons).toEqual([]);
    expect(record.candidates.map(({ kind, formMethod, methodOverride }) => [kind, formMethod, methodOverride])).toEqual([
      ['FORM', 'POST', 'DELETE'],
      ['BUTTON', null, null],
    ]);
    expect(record.candidates[0]?.classification).toBe('NOT_EXECUTABLE');
    expect(await readPageHits(page)).toBe(before);
    const read = await readSettledPageStructure(page, counter);
    counter.dispose();
    expect(read).toMatchObject({ status: 'READ', structure: { tableRowCounts: [3], listItemCounts: [2] } });
    expect(await readPageHits(page)).toBe(before);
    // 数える仕掛けは、main world の読み取りでは数える（仕掛けが効いている）。
    await page.evaluate(() => document.documentElement.localName);
    expect(await readPageHits(page)).toBeGreaterThan(before);
  });

  itOnDefault('fails to read (fail-closed) when the isolated world is gone because the page was loaded again (DEF-087)', async () => {
    const { page, context, counter } = await open(DISCOVERY_FIXTURE_PATHS.search);
    counter.dispose();
    const openSession = context.newCDPSession.bind(context);
    let reloads = 0;
    const spy = vi.spyOn(context, 'newCDPSession').mockImplementation(async (target) => {
      const session = await openSession(target);
      // world を作った直後に、ページを読み込み直す（作った world の id は古くなる）。
      const send: CDPSession['send'] = async (method, params) => {
        const result = await session.send(method, params);
        if (method === 'Page.createIsolatedWorld') {
          reloads += 1;
          await page.reload();
        }
        return result;
      };
      return new Proxy(session, { get: (object, key) => (key === 'send' ? send : Reflect.get(object, key) as unknown) });
    });
    try {
      expect(await probePageCandidates(page, Date.now() + DISCOVERY_READ_TIMEOUT_MS)).toEqual({ status: 'FAILED' });
      expect(await readPageStructure(page, Date.now() + DISCOVERY_READ_TIMEOUT_MS)).toEqual({ status: 'FAILED' });
    } finally {
      spy.mockRestore();
    }
    expect(reloads).toBe(2);
  });

  itOnDefault('fails to read (fail-closed) by the deadline while the page is busy (DEF-087)', async () => {
    const { page, counter } = await open(DISCOVERY_FIXTURE_PATHS.search);
    counter.dispose();
    await page.evaluate((busyMs) => {
      setTimeout(() => {
        const end = Date.now() + busyMs;
        while (Date.now() < end) {
          // ページの主の thread を占める（読み取りの関数は動けない）。
        }
      }, 0);
    }, BUSY_PAGE_MS);
    await wait(BUSY_START_WAIT_MS);
    const startedAt = Date.now();
    expect(await probePageCandidates(page, startedAt + BUSY_READ_DEADLINE_MS)).toEqual({ status: 'FAILED' });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(BUSY_PAGE_MS - BUSY_START_WAIT_MS);
    // 後片付けの前に、ページが空くのを待つ。
    await wait(BUSY_PAGE_MS - BUSY_START_WAIT_MS - elapsedMs);
  });
});

// SU3c（サイトが応答しないときに Run を止める設計書 3.1、3.2、3.2.1、5章の「結合」）: `run` のコマンドの流れ（`runAuditCommand` を同じ
// プロセスで呼ぶ。`tests/integration/cli-resume.test.ts` と同じ形）で、監査の途中でサイトが応答しなくなると、そのページの残りと次のページの
// 読み込みがサイトに届かずに止まり、サイトが戻ってから同じ設定で再開すると、最後まで終えることを確かめる。
//
// - サイト: fixture のサーバ（`fixtures/server.ts` の `/crawl/` のページ）の前に、このテストの中の 127.0.0.1 の中継のサーバ（`node:http`）を
//   置く。Run の設定の Origin と許可 Origin は、中継のサーバのもの。中継のサーバは、モードを切り替えられる（`NORMAL`: fixture のサーバに
//   中継する。`HANG`: 接続を受けるが何も返さない。`EMPTY_503`: 本文が空の 503 を返す）。受けた要求（method、パス、受けた時刻、その時の
//   モード）を記録し、サイトに届いた要求（負荷）の確かめに使う。
//   fixture のサーバは、robots.txt と sitemap.xml の本文に自分の Origin を埋め込む（`requestOrigin`）。BeakSight は、sitemap の URL を
//   巡回の入口に使わず（Cross-page rule の入力だけ）、sitemap.xml は `<Origin>/sitemap.xml` から取る（robots.txt の `Sitemap:` は使わない）
//   ので、要求は中継のサーバだけに届く。比べる相手の中断しない Run も、同じ中継のサーバで監査する。
// - モードの切り替えは、k ページ目の監査が終わったとき（`onProgress` の `pagesFinished`。`cli-resume.test.ts` の `stoppingAfter` と同じ形）
//   に行う。robots.txt と sitemap.xml の段階を確かめる場面では、Run の前から切り替えておく。
// - Chromium は、CLI と同じ起動の設定（`chromiumLaunchOptions({ headless: true })`）で起動する（DEF-030。本文が空の 503 は、テストの補助の
//   既定の headless（`chrome-headless-shell`）と CLI の Chromium で振る舞いが違う）。launcher の作り方は
//   `tests/integration/guard-response-received-failures.test.ts` に合わせる（要求された `headless` の値によらず、いつも headless）。
// - 設定は `fastRunConfig`（スクリーンショットをしない）に、短い読み込みの期限（`UNRESPONSIVE_NAVIGATION_TIMEOUT_MS`）と、幅の走査の1つの幅
//   （`STRESS_WIDTHS`。不調の後に幅の走査の読み込みが届かないことを確かめるため）を加えたもの。`/crawl/` のページには Interaction の候補が
//   ないので、Interaction の読み込みは、不調がなくても起きない（Interaction の段階で止めることは、`page-auditor-site-unavailability.test.ts`
//   で確かめる）。
//
// 空振りでないこと（機能を外した場合に失敗する形）:
// - 不調で止めなければ、切り替えた後に、そのページの幅の走査と Mobile と、次のページの読み込みが中継のサーバに届く（中断しない Run の
//   記録で、そのページと次のページの文書に、各ビューポートと幅の走査の GET が届くことを、対照として確かめる）。負荷の確かめは、切り替えた
//   後の要求が、そのページの文書の GET の1件だけであることを求めるので、失敗する。終わり方、Run の理由、保存の状態、CLI の1行も、機能が
//   なければ出ない。
// - 不調のページを捨てなければ（3.2）、そのページは失敗の結果として残り、再開で監査し直されない（中断しない Run と状態が違う）。
// - 止まり続けないための決まり（3.2.1）がなければ、戻る前の再開でそのページを捨て、次の再開で監査し直す（3回目に、そのページの文書の
//   要求が届く）。
//
// D2（サイトの不調で止めたときの診断の記録の設計書 2.3、4章の「結合」）: 不調でページを捨てた実行と、前の実行のきっかけのページを普通の結果と
// して保存した実行の後に、Run のディレクトリの `diagnostics/` に、そのページの診断の記録が1つずつでき、Run を最後まで終えた後も残ることを
// 確かめる。応答しなくなる場面では、止まったビューポートの文書の要求に、ヘッダを送った時刻があり、応答の時刻がないことを確かめる。
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { EXIT_CODES, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import { resumingRunLines } from '../../src/cli/output.js';
import { runAuditCommand, type RunCommandDependencies } from '../../src/cli/run-command.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AuditConfig } from '../../src/config/types.js';
import { validateConfig } from '../../src/config/validate-config.js';
import {
  CHECKPOINT_PAGES_ARTIFACT_DIRECTORY,
  DIAGNOSTICS_ARTIFACT_DIRECTORY,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  checkpointArtifactRelativePath,
  checkpointPageIdOfFileName,
  siteUnavailableDiagnosticRelativePath,
} from '../../src/core/artifact-layout.js';
import {
  VIEWPORT_PROFILES,
  type Finding,
  type IncompleteReason,
  type NavigationDocumentRequestHop,
  type PageAuditResult,
  type PageId,
  type RunExecutionEndReason,
  type RunSummary,
  type ViewportProfile,
} from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import type { RunCheckpoint } from '../../src/orchestration/run-checkpoint.js';
import {
  RunCoordinator,
  SITE_UNAVAILABLE_DIAGNOSTIC_SCHEMA_VERSION,
  SITE_UNAVAILABLE_RECHECK_DELAYS_MS,
  SITE_UNAVAILABLE_SLOWDOWN_FACTOR,
  type SiteUnavailableDiagnosticRecord,
} from '../../src/orchestration/run-coordinator.js';
import { SITE_UNAVAILABLE_SKIP_REASON } from '../../src/orchestration/site-availability.js';
import { skippedPageResult } from '../../src/orchestration/skipped-page.js';
import { formatDuration } from '../../src/presentation/format.js';
import { CLI_TEXT, siteUnavailableRecheckText, siteUnavailableSlowdownText, siteUnavailableStopText } from '../../src/presentation/messages.js';
import { BROWSER_DEFAULT_FAVICON_PATH } from '../helpers/chromium.js';
import { captureCliOutput, fastRunConfig, readJson, readRunAudit } from '../helpers/run-harness.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
/** 中継のサーバのモードを切り替える前に、監査を終えるページの数（k）。 */
const PAGES_BEFORE_SWITCH = 2;
/**
 * ページの読み込みと robots.txt・sitemap.xml の取得の期限（ms。`crawl.navigationTimeoutMs`）。応答のない時間切れを早く起こすので、短くする。
 * ヘッダの後の時間切れを使う場面はないので、設計書 2.2 の 2 秒の決まりは関係しない。中継の後の fixture のページ（小さな HTML）は、
 * この期限の中で読み込める。
 */
const UNRESPONSIVE_NAVIGATION_TIMEOUT_MS = 3_000;
/** `EMPTY_503` で返す status（503 Service Unavailable。`SITE_UNAVAILABLE_HTTP_STATUSES` の1つ）。 */
const SERVICE_UNAVAILABLE_STATUS = 503;
/** BeakSight が取得する robots.txt と sitemap.xml の、Origin からのパス（`src/crawl/site-metadata.ts` の取得の順）。 */
const ROBOTS_TXT_PATH = '/robots.txt';
const SITEMAP_XML_PATH = '/sitemap.xml';
/** 監査するページの文書のパスの接頭辞（`START_PATH` のディレクトリ。fixture のサイトの `/crawl/` のページ）。 */
const PAGE_PATH_PREFIX = START_PATH.slice(0, START_PATH.lastIndexOf('/') + 1);

/** Desktop の Passive の読み込みが、応答のない時間切れで不調だったときの、Run の理由の `detail`（設計書 3.1、3.2）。 */
const DESKTOP_PASSIVE_TIMEOUT = 'desktop:passive:TIMEOUT';
/** Desktop の Passive の読み込みが、503 で不調だったときの、Run の理由の `detail`。 */
const DESKTOP_PASSIVE_HTTP_503 = `desktop:passive:HTTP ${SERVICE_UNAVAILABLE_STATUS}`;
/** robots.txt の取得が、応答のない時間切れで不調だったときの、Run の理由の `detail`。 */
const SITE_METADATA_TIMEOUT = 'site-metadata:TIMEOUT';

const SITE_UNAVAILABLE_END_REASON: RunExecutionEndReason = 'STOPPED_BY_SITE_UNAVAILABLE';
const COMPLETED_END_REASON: RunExecutionEndReason = 'COMPLETED';

/**
 * 幅の走査の幅。`fastRunConfig` は幅の走査をしないが、不調の後に幅の走査の読み込みがサイトに届かないことを確かめるので、既定の幅のうち、
 * 主要な2つのビューポートの幅ではない（走査で読み込む）最初の1つだけにする（実行時間を抑える）。
 */
const STRESS_WIDTHS: readonly number[] = DEFAULT_CONFIG.viewports.stressWidths
  .filter((width) => width !== DEFAULT_CONFIG.viewports.primaryDesktop.width && width !== DEFAULT_CONFIG.viewports.primaryMobile.width)
  .slice(0, 1);
/**
 * 中断しない Run で、1つのページの文書に届く GET の件数（主要な各ビューポートと、幅の走査の各幅の読み込み。`/crawl/` のページには
 * Interaction の候補がないので、Interaction の読み込みはない）。
 */
const DOCUMENT_GETS_PER_PAGE = VIEWPORT_PROFILES.length + STRESS_WIDTHS.length;

// ---------------------------------------------------------------------------------------------------------------
// 中継のサーバ
// ---------------------------------------------------------------------------------------------------------------

/**
 * 中継のサーバのモード。
 * - `NORMAL`: すべての要求を fixture のサーバに中継する。
 * - `HANG`: 接続を受けるが、何も返さない（ヘッダも返さない）。
 * - `EMPTY_503`: 本文が空の 503 を返す。
 */
type RelayMode = 'NORMAL' | 'HANG' | 'EMPTY_503';

/** 中継のサーバが受けた要求。 */
interface RelayedRequest {
  readonly method: string;
  readonly pathname: string;
  /** 受けた時刻（`Date.now()`）。 */
  readonly receivedAtMs: number;
  /** 受けた時のモード。 */
  readonly mode: RelayMode;
}

interface RelayServer {
  readonly origin: string;
  /** 受けた要求（受けた順。`reset` で空にする）。 */
  readonly requests: readonly RelayedRequest[];
  setMode(mode: RelayMode): void;
  /** 応答しない接続を切り、受けた要求の記録を空にして、モードを `mode` にする（各実行の前に呼ぶ）。 */
  reset(mode: RelayMode): void;
  /** 応答しない接続を含むすべての接続を切ってから、サーバを閉じる。何度呼んでもよい。 */
  close(): Promise<void>;
}

/** 中継で、要求と応答から除く hop-by-hop のヘッダ（接続の扱いは、中継のサーバの両側で別々に決める）。 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

/** `headers` から hop-by-hop のヘッダを除いたもの。 */
function endToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      kept[name] = value;
    }
  }
  return kept;
}

/** `upstream`（fixture のサーバ）の前に置く、127.0.0.1 の中継のサーバを起動する（モードは `NORMAL` から始める）。 */
async function startRelayServer(upstream: FixtureServer): Promise<RelayServer> {
  const upstreamUrl = new URL(upstream.origin);
  // fixture のサーバへの接続は、要求ごとに作って閉じる（閉じた後に残る接続を作らない）。
  const agent = new Agent({ keepAlive: false });
  const requests: RelayedRequest[] = [];
  const sockets = new Set<Socket>();
  const hungResponses = new Set<ServerResponse>();
  let mode: RelayMode = 'NORMAL';

  const relay = (request: IncomingMessage, response: ServerResponse): void => {
    const upstreamRequest = httpRequest({
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: request.method,
      path: request.url,
      headers: endToEndHeaders(request.headers),
      agent,
    }, (upstreamResponse) => {
      const { statusCode } = upstreamResponse;
      if (statusCode === undefined) {
        response.destroy();
        return;
      }
      response.writeHead(statusCode, endToEndHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
      upstreamResponse.once('error', () => response.destroy());
    });
    upstreamRequest.once('error', () => response.destroy());
    // ブラウザが要求をやめたら、fixture のサーバへの要求もやめる（終わった後に呼んでも何もしない）。
    response.once('close', () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  };

  const cutHungConnections = (): void => {
    for (const response of hungResponses) {
      response.socket?.destroy();
      response.destroy();
    }
    hungResponses.clear();
  };

  const server = createServer((request, response) => {
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
    requests.push(Object.freeze({ method: request.method ?? '', pathname, receivedAtMs: Date.now(), mode }));
    switch (mode) {
      case 'HANG':
        // 何も返さない。接続は、ブラウザが切るか、`reset` と `close` で切る。
        hungResponses.add(response);
        response.once('close', () => hungResponses.delete(response));
        return;
      case 'EMPTY_503':
        response.writeHead(SERVICE_UNAVAILABLE_STATUS, { 'Content-Length': '0' });
        response.end();
        return;
      case 'NORMAL':
        relay(request, response);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    setMode: (next) => {
      mode = next;
    },
    reset: (next) => {
      cutHungConnections();
      requests.splice(0);
      mode = next;
    },
    close: () => {
      closing ??= new Promise<void>((resolveClose, reject) => {
        cutHungConnections();
        for (const socket of sockets) {
          socket.destroy();
        }
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
        agent.destroy();
      });
      return closing;
    },
  };
}

/** ブラウザ自身の `/favicon.ico` の GET を除いた、要求の method とパス（受けた順）。 */
const siteRequests = (requests: readonly RelayedRequest[]): { readonly method: string; readonly pathname: string }[] =>
  requests
    .filter(({ method, pathname }) => !(method === 'GET' && pathname === BROWSER_DEFAULT_FAVICON_PATH))
    .map(({ method, pathname }) => ({ method, pathname }));

/** `requests` のうち、`pathname` への GET の件数。 */
const getCount = (requests: readonly RelayedRequest[], pathname: string): number =>
  requests.filter((request) => request.method === 'GET' && request.pathname === pathname).length;

// ---------------------------------------------------------------------------------------------------------------
// Run の起動
// ---------------------------------------------------------------------------------------------------------------

let fixtureServer: FixtureServer;
let relay: RelayServer;
let workDirectory: string;
/** launcher が起動した Browser（後に残っていないことを確かめる）。 */
const runBrowsers: Browser[] = [];

/**
 * CLI と同じ起動の設定（`chromiumLaunchOptions`）で Chromium を起動する launcher。`createRunLauncher`（`tests/helpers/run-harness.ts`）と
 * 同じく、要求された `headless` の値によらず、いつも headless で起動する。
 */
const launchCliChromium: BrowserLauncher = async () => {
  const launched = await chromium.launch(chromiumLaunchOptions({ headless: true }));
  runBrowsers.push(launched);
  return launched;
};

beforeAll(async () => {
  fixtureServer = await startFixtureServer();
  relay = await startRelayServer(fixtureServer);
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-cli-site-unavailable-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = runBrowsers.filter((browser) => browser.isConnected());
  await Promise.all(leftovers.map((browser) => browser.close().catch(() => undefined)));
  // 応答しない接続を切ってから、中継のサーバを閉じる。
  await relay?.close();
  await fixtureServer?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(leftovers.length, 'Browsers left connected after the Runs').toBe(0);
});

/**
 * 作業のディレクトリの下の、`name` の出力先に書く、実行時間を抑えた Run の設定（中継のサーバの `/crawl/` のページ）。
 * `minNavigationIntervalMs` を渡すと、ページの読み込みの間隔をその値にする（既定は `createTestConfig` の 0。減速（SU6）を確かめる場面で使う。
 * 待ちは差し替えるので、実際には待たない）。
 */
const configFor = (name: string, minNavigationIntervalMs = 0): AuditConfig =>
  fastRunConfig(relay.origin, START_PATH, {
    target: { id: 'cli-site-unavailable' },
    output: { directory: join(workDirectory, name) },
    crawl: { navigationTimeoutMs: UNRESPONSIVE_NAVIGATION_TIMEOUT_MS, minNavigationIntervalMs },
    viewports: { stressWidths: [...STRESS_WIDTHS] },
  });

/**
 * Run Coordinator に加える、テストの差し替え（`createRunCoordinator` で、CLI が渡すものに加えて `new RunCoordinator` に渡す）。
 * - `switchAfterPages`: そのページ数の監査が終わったとき（`onProgress`）に、中継のサーバのモードを切り替える。
 * - `onRecheckWait`: 確かめ直しの前の待ち（`SITE_UNAVAILABLE_RECHECK_DELAYS_MS` のどれかの `sleep`。SU5、SU6）のときに呼ぶ（引数は、その
 *   待ちの長さと、この実行で何回目の確かめ直しの待ちか（0 から））。
 * 待ち（`sleep`）は、いつも差し替える（実際には待たずに、待った長さを記録する。60 秒〜8 分の待ちをテストで待たないため。設定の間隔が 0 でない
 * 場面（減速。SU6）では、間隔の待ちも記録されるが、実際には待たない）。
 */
interface CoordinatorHooks {
  readonly switchAfterPages?: { readonly pages: number; readonly mode: RelayMode };
  readonly onRecheckWait?: (delayMs: number, index: number) => void;
}

/** 確かめ直しの前の待ちの長さか（`SITE_UNAVAILABLE_RECHECK_DELAYS_MS` のどれか）。 */
const isRecheckDelay = (ms: number): boolean => SITE_UNAVAILABLE_RECHECK_DELAYS_MS.includes(ms);

interface CommandOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** この実行の間に、中継のサーバが受けた要求（受けた順）。 */
  readonly requests: readonly RelayedRequest[];
  /** Run Coordinator が待った長さ（ms。呼ばれた順。実際には待っていない）。 */
  readonly sleeps: readonly number[];
  /** `sleeps` のうち、確かめ直しの前の待ち（間隔の待ちを除く）。 */
  readonly recheckSleeps: readonly number[];
  /** 確かめ直しの前の待ちのたびに、その時点までに中継のサーバが受けた要求の数（待っている間に何も送らないことの確かめ）。 */
  readonly requestCountsAtRecheckWait: readonly number[];
}

/**
 * 中継のサーバを `mode` にしてから（応答しない接続を切り、要求の記録を空にする）、CLI と同じ起動の設定の headless Chromium（時計は実際の
 * 時刻）で `runAuditCommand` を実行し、終了コード、標準出力・標準エラーに書いたもの、この実行の間に中継のサーバが受けた要求、待ちの記録を
 * 返す。
 */
async function runCommand(config: AuditConfig, mode: RelayMode, hooks: CoordinatorHooks = {}): Promise<CommandOutcome> {
  relay.reset(mode);
  const stdout = captureCliOutput();
  const stderr = captureCliOutput();
  const sleeps: number[] = [];
  const requestCountsAtRecheckWait: number[] = [];
  const dependencies: RunCommandDependencies = {
    launchBrowser: launchCliChromium,
    clock: () => new Date(),
    now: () => Date.now(),
    createRunCoordinator: (coordinatorDependencies) => new RunCoordinator({
      ...coordinatorDependencies,
      onProgress: (report) => {
        coordinatorDependencies.onProgress?.(report);
        if (report.pagesFinished === hooks.switchAfterPages?.pages) {
          relay.setMode(hooks.switchAfterPages.mode);
        }
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        if (isRecheckDelay(ms)) {
          requestCountsAtRecheckWait.push(relay.requests.length);
          hooks.onRecheckWait?.(ms, requestCountsAtRecheckWait.length - 1);
        }
      },
    }),
  };
  const code = await runAuditCommand(config, { stdout: stdout.output, stderr: stderr.output }, dependencies);
  return {
    code,
    stdout: stdout.text(),
    stderr: stderr.text(),
    requests: [...relay.requests],
    sleeps,
    recheckSleeps: sleeps.filter(isRecheckDelay),
    requestCountsAtRecheckWait,
  };
}

/** `NORMAL` で始め、`PAGES_BEFORE_SWITCH` ページ目の後に `mode` に切り替える Run を、`config` で行う。 */
const runSwitchedAfterPages = async (config: AuditConfig, mode: RelayMode, hooks: Omit<CoordinatorHooks, 'switchAfterPages'> = {}): Promise<CommandOutcome> =>
  await runCommand(config, 'NORMAL', { ...hooks, switchAfterPages: { pages: PAGES_BEFORE_SWITCH, mode } });

/** 1 ページにつき確かめ直す回数の上限（待ちの段階の数。SU6）。 */
const MAX_RECHECKS = SITE_UNAVAILABLE_RECHECK_DELAYS_MS.length;

/** `value` を `count` 個並べた配列。 */
const repeated = <T>(value: T, count: number): T[] => Array.from({ length: count }, () => value);

/** `attempt` 回目（1 から）の確かめ直しの知らせの1行（SU5、SU6。文言は `messages.ts`、待つ時間の書式は `format.ts`）。 */
const recheckLineOf = (pageUrl: string, attempt: number): string =>
  siteUnavailableRecheckText(pageUrl, formatDuration(SITE_UNAVAILABLE_RECHECK_DELAYS_MS[attempt - 1] as number), attempt, MAX_RECHECKS);

/** 減速の知らせの1行（SU6。新しい間隔の書式は `format.ts`）。 */
const slowdownLineOf = (minIntervalMs: number): string => siteUnavailableSlowdownText(formatDuration(minIntervalMs));

/** 減速の知らせの行の、間隔の前の部分（どの間隔の知らせも出ていないことを確かめるときに使う）。 */
const SLOWDOWN_LINE_PREFIX = slowdownLineOf(0).split(formatDuration(0))[0] as string;

/** `stdout` にある、減速の知らせの行（どの間隔でも）の数。 */
const slowdownLinesIn = (stdout: string): number => stdout.split('\n').filter((line) => line.startsWith(SLOWDOWN_LINE_PREFIX)).length;

/** `stdout` にある、`pages` のどれかのページの、どの回の確かめ直しの知らせの行の数（出ていないことを確かめるときに使う）。 */
const recheckLinesIn = (stdout: string, pages: readonly PageAuditResult[]): number =>
  pages.reduce(
    (count, page) => count + SITE_UNAVAILABLE_RECHECK_DELAYS_MS.reduce((sum, _, index) => sum + linesEqualTo(stdout, recheckLineOf(page.pageUrl, index + 1)), 0),
    0,
  );

// ---------------------------------------------------------------------------------------------------------------
// 結果の読み方
// ---------------------------------------------------------------------------------------------------------------

/** 出力先の直下の、ただ1つの Run のディレクトリ。 */
async function onlyRunDirectoryIn(outputDirectory: string): Promise<string> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory()).map(({ name }) => name);
  expect(names).toHaveLength(1);
  return join(outputDirectory, names[0] ?? '');
}

const readState = async (runDirectory: string): Promise<RunCheckpoint> =>
  await readJson(artifactFilePath(runDirectory, checkpointArtifactRelativePath('state'))) as RunCheckpoint;
const readRun = async (runDirectory: string): Promise<RunSummary> =>
  await readJson(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;
/**
 * Run のディレクトリの `checkpoint/pages/` にある、ページの保存のページの ID（名前の順）。終わった Run では、CLI がページの保存を片付ける
 * ので、止まった実行の直後に読む。
 */
async function checkpointPageIdsIn(runDirectory: string): Promise<PageId[]> {
  const directory = artifactFilePath(runDirectory, CHECKPOINT_PAGES_ARTIFACT_DIRECTORY);
  if (!existsSync(directory)) {
    return [];
  }
  return (await readdir(directory))
    .map(checkpointPageIdOfFileName)
    .filter((pageId): pageId is PageId => pageId !== null)
    .sort();
}

/** Run のディレクトリの `diagnostics/` にあるものの、Run のディレクトリからの相対パス（名前の順。`diagnostics/` がなければ空）。D2。 */
async function diagnosticPathsIn(runDirectory: string): Promise<string[]> {
  const directory = artifactFilePath(runDirectory, DIAGNOSTICS_ARTIFACT_DIRECTORY);
  if (!existsSync(directory)) {
    return [];
  }
  return (await readdir(directory)).sort().map((name) => `${DIAGNOSTICS_ARTIFACT_DIRECTORY}/${name}`);
}

/**
 * Run のディレクトリの、ページ `pageId` の、`executionNumber` 回目の実行の診断の記録（D2）。ファイルがなければ `null`（ほかの確かめを、
 * 診断の記録の有無に左右させないため。有無は、それを確かめるテストで確かめる）。
 */
async function readDiagnostic(
  runDirectory: string,
  pageId: PageId,
  executionNumber: number,
  attemptNumber: number,
): Promise<SiteUnavailableDiagnosticRecord | null> {
  const path = artifactFilePath(runDirectory, siteUnavailableDiagnosticRelativePath(pageId, executionNumber, attemptNumber));
  return existsSync(path) ? await readJson(path) as SiteUnavailableDiagnosticRecord : null;
}

/** 1 回目の試行の番号（診断の記録のファイルの名前。SU5）。 */
const FIRST_ATTEMPT = 1;
/** `count` 回目の確かめ直しの試行の番号（1 回目の次から。SU6）。 */
const recheckAttempt = (count: number): number => FIRST_ATTEMPT + count;
/** 1 回目と、最大の回数の確かめ直しの、すべての試行の番号（1〜5）。 */
const ALL_ATTEMPTS: readonly number[] = Array.from({ length: MAX_RECHECKS + 1 }, (_, index) => FIRST_ATTEMPT + index);

/** 診断の記録があることを確かめて返す（D2）。 */
function presentDiagnostic(record: SiteUnavailableDiagnosticRecord | null): SiteUnavailableDiagnosticRecord {
  expect(record, 'the site-unavailable diagnostic was not written').not.toBeNull();
  return record as SiteUnavailableDiagnosticRecord;
}

/**
 * 診断の記録の `viewport` の Passive の観察の結果のうち、ページの文書（`pageUrl`）の要求の最初の回（D2。D3 の形では、ビューポートの
 * `passive`）。観察した結果で、その文書の要求があることも確かめる。
 */
function documentHopOf(record: SiteUnavailableDiagnosticRecord, viewport: ViewportProfile, pageUrl: string): NavigationDocumentRequestHop {
  const diagnostics = record.navigationDiagnostics[viewport]?.passive;
  expect(diagnostics?.status, JSON.stringify(diagnostics)).toBe('OBSERVED');
  const hops = diagnostics?.status === 'OBSERVED' ? diagnostics.documentRequests.flatMap(({ hops: requestHops }) => requestHops) : [];
  const hop = hops.find(({ url }) => url === pageUrl);
  expect(hop, JSON.stringify(diagnostics)).toBeDefined();
  return hop as NavigationDocumentRequestHop;
}

/** 実行の記録の終わり方（実行の順）。 */
const endReasonsOf = (run: RunSummary): RunExecutionEndReason[] => run.executions.map(({ endReason }) => endReason);
/** Run の理由のうち、コード `SITE_UNAVAILABLE` のもの。 */
const siteUnavailableReasonsOf = (run: RunSummary): IncompleteReason[] =>
  run.incompleteReasons.filter(({ code }) => code === SITE_UNAVAILABLE_SKIP_REASON.code);
/** 監査の結果のページの文書のパス。 */
const pathOf = (page: PageAuditResult): string => new URL(page.pageUrl).pathname;
/** ページの identity（URL と ID）と状態。 */
const pageIdentityAndStatus = ({ pageId, pageUrl, status }: PageAuditResult): Pick<PageAuditResult, 'pageId' | 'pageUrl' | 'status'> =>
  ({ pageId, pageUrl, status });
/** 標準出力の行のうち、`line` と同じものの件数。 */
const linesEqualTo = (stdout: string, line: string): number => stdout.split('\n').filter((candidate) => candidate === line).length;
/** 再開の知らせ（`RESUME`。1行）。ページの数は、再開の前に監査を終えたページの数。 */
const resumeLineOf = (runId: string, completedPages: number): string => {
  const [line, ...rest] = resumingRunLines(runId, completedPages);
  expect(rest).toEqual([]);
  return line ?? '';
};

/** Finding を、ID（Finding と Evidence の ID）に依らない値で表す（Rule の ID、ページ、ビューポート、fingerprint）。 */
const findingKeyWithoutIds = ({ ruleId, pageId, pageUrl, viewport, fingerprint }: Finding): string =>
  JSON.stringify([ruleId, pageId, pageUrl, viewport, fingerprint]);

/**
 * 中断しない Run と比べる項目: Run Status、ページの一覧（URL、ID）と状態と理由、Finding（ID に依らない値の一覧。名前の順）、Run の理由。
 * Evidence と Finding の ID は比べない（不調で捨てた試行が採番を使うので、違ってよい。SU3a の報告）。Run の ID、時刻、負荷、実行の記録、
 * 環境も比べない。
 */
async function comparableRunIn(runDirectory: string): Promise<unknown> {
  const run = await readRun(runDirectory);
  const audit = await readRunAudit(runDirectory);
  return {
    runStatus: run.runStatus,
    pages: audit.pages.map((page) => ({ ...pageIdentityAndStatus(page), reasons: page.incompleteReasons })),
    findings: audit.findings.map(findingKeyWithoutIds).sort(),
    incompleteReasons: run.incompleteReasons,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 中断しない Run（比べる相手）
// ---------------------------------------------------------------------------------------------------------------

let uninterrupted: {
  readonly outcome: CommandOutcome;
  readonly pages: readonly PageAuditResult[];
  readonly comparable: unknown;
};

beforeAll(async () => {
  const outcome = await runCommand(configFor('uninterrupted'), 'NORMAL');
  const runDirectory = await onlyRunDirectoryIn(join(workDirectory, 'uninterrupted'));
  const run = await readRun(runDirectory);
  uninterrupted = { outcome, pages: (await readRunAudit(runDirectory)).pages, comparable: await comparableRunIn(runDirectory) };
  expect(outcome.code, outcome.stderr).toBe(exitCodeForRunStatus(run.runStatus));
  expect(outcome.stderr).toBe('');
  expect(endReasonsOf(run)).toEqual([COMPLETED_END_REASON]);
  expect(siteUnavailableReasonsOf(run)).toEqual([]);
  // 不調がなければ、待たない（間隔は 0）し、確かめ直しの知らせも出ない。
  expect(outcome.sleeps).toEqual([]);
  expect(recheckLinesIn(outcome.stdout, uninterrupted.pages)).toBe(0);
  // k ページ目の後に、まだ監査するページが2つ以上ある（切り替えた後のページと、その次のページ）。
  expect(uninterrupted.pages.length).toBeGreaterThan(PAGES_BEFORE_SWITCH + 1);
}, SUITE_TIMEOUT_MS);

/** 中断しない Run で、k+1 ページ目に監査したページ（切り替えた後に読み込むページ）。 */
const pageAfterSwitch = (): PageAuditResult => uninterrupted.pages[PAGES_BEFORE_SWITCH] as PageAuditResult;

describe('SU3c: the configuration of the Runs', () => {
  it('passes the validation of the configuration of the CLI, with the relay server as the origin and the allowed origin', () => {
    const config = configFor('validation');

    expect(validateConfig(config)).toMatchObject({ ok: true });
    expect(config.site).toEqual({ startUrl: `${relay.origin}${START_PATH}`, allowedOrigins: [relay.origin] });
    expect(config.crawl.navigationTimeoutMs).toBe(UNRESPONSIVE_NAVIGATION_TIMEOUT_MS);
  });

  it('control: without the stop, the relay server gets the GETs of every viewport and stress width of the k+1-th page and of the next page', () => {
    // 不調で止めなければ届く要求（Desktop、幅の走査、Mobile の読み込みと、次のページの読み込み）。負荷の確かめが空振りでないことの対照。
    const requests = uninterrupted.outcome.requests;

    expect(STRESS_WIDTHS).toHaveLength(1);
    expect(getCount(requests, pathOf(pageAfterSwitch()))).toBe(DOCUMENT_GETS_PER_PAGE);
    expect(getCount(requests, pathOf(uninterrupted.pages[PAGES_BEFORE_SWITCH + 1] as PageAuditResult))).toBe(DOCUMENT_GETS_PER_PAGE);
    expect(getCount(requests, ROBOTS_TXT_PATH)).toBe(1);
    expect(getCount(requests, SITEMAP_XML_PATH)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 場面 1・2: ページの監査の途中で、応答しなくなる・本文が空の 503 を返す
// ---------------------------------------------------------------------------------------------------------------

describe.each([
  // `stoppedViewport` は、不調を検知した（止まった）ビューポート（`detail` の最初の部分）。`responseStatus` は、そのビューポートのページの
  // 文書の要求の応答の status（応答がなければ `null`）。D2。
  { scenario: 'stops responding (HANG)', mode: 'HANG', detail: DESKTOP_PASSIVE_TIMEOUT, outputName: 'hang', stoppedViewport: 'desktop', responseStatus: null },
  {
    scenario: 'returns an empty 503 (EMPTY_503)',
    mode: 'EMPTY_503',
    detail: DESKTOP_PASSIVE_HTTP_503,
    outputName: 'empty-503',
    stoppedViewport: 'desktop',
    responseStatus: SERVICE_UNAVAILABLE_STATUS,
  },
] as const)('SU3c: the site $scenario after the k-th page (design 3.1, 3.2, 5)', ({ mode, detail, outputName, stoppedViewport, responseStatus }) => {
  let outputDirectory: string;
  let stopped: CommandOutcome;
  let runDirectory: string;
  let stoppedRun: RunSummary;
  let stoppedPages: readonly PageAuditResult[];
  let stoppedState: RunCheckpoint;
  let stoppedCheckpointPageIds: PageId[];
  let stoppedDiagnosticPaths: string[];
  let stoppedDiagnostic: SiteUnavailableDiagnosticRecord | null;
  /** 各確かめ直しの試行（2〜5）の診断の記録（SU6）。 */
  let stoppedRecheckDiagnostics: (SiteUnavailableDiagnosticRecord | null)[];
  let resumed: CommandOutcome;
  let resumedDiagnosticPaths: string[];
  let resumedDiagnostic: SiteUnavailableDiagnosticRecord | null;

  beforeAll(async () => {
    const config = configFor(outputName);
    outputDirectory = config.output.directory;
    // 1回目: k ページ目の後に、中継のサーバを `mode` にする（各確かめ直し（SU5、SU6）のときも、そのまま）。
    stopped = await runSwitchedAfterPages(config, mode);
    runDirectory = await onlyRunDirectoryIn(outputDirectory);
    stoppedRun = await readRun(runDirectory);
    stoppedPages = (await readRunAudit(runDirectory)).pages;
    stoppedState = await readState(runDirectory);
    stoppedCheckpointPageIds = await checkpointPageIdsIn(runDirectory);
    stoppedDiagnosticPaths = await diagnosticPathsIn(runDirectory);
    stoppedDiagnostic = await readDiagnostic(runDirectory, pageAfterSwitch().pageId, 1, FIRST_ATTEMPT);
    stoppedRecheckDiagnostics = [];
    for (const attempt of ALL_ATTEMPTS.slice(1)) {
      stoppedRecheckDiagnostics.push(await readDiagnostic(runDirectory, pageAfterSwitch().pageId, 1, attempt));
    }
    // 2回目: サイトが戻った（`NORMAL`）後に、同じ設定で実行する。
    resumed = await runCommand(config, 'NORMAL');
    resumedDiagnosticPaths = await diagnosticPathsIn(runDirectory);
    resumedDiagnostic = await readDiagnostic(runDirectory, pageAfterSwitch().pageId, 1, FIRST_ATTEMPT);
  }, SUITE_TIMEOUT_MS);

  it('ends the first execution with PARTIAL, STOPPED_BY_SITE_UNAVAILABLE and the Run reason with the first failure, without a violation', () => {
    expect(stopped.code, stopped.stderr).toBe(EXIT_CODES.PARTIAL);
    expect(stopped.stderr).toBe('');
    expect(stoppedRun.runStatus).toBe('PARTIAL');
    expect(endReasonsOf(stoppedRun)).toEqual([SITE_UNAVAILABLE_END_REASON]);
    expect(siteUnavailableReasonsOf(stoppedRun)).toEqual([{ code: SITE_UNAVAILABLE_SKIP_REASON.code, detail }]);
    // DEF-029: 本文が空の 503 の読み込みの失敗は、Guard の違反にしない（ABORTED_BY_SAFETY にならない）。
    expect(stoppedRun.safety.invariantViolationCount).toBe(0);
    expect(stoppedRun.safety.invariantViolations).toEqual([]);
  });

  it('keeps the first k pages, and does not keep the result of the k+1-th page: it is SKIPPED with the first failure and not saved', () => {
    const afterSwitch = pageAfterSwitch();
    const [kept, skipped] = [stoppedPages.slice(0, PAGES_BEFORE_SWITCH), stoppedPages.slice(PAGES_BEFORE_SWITCH)];

    expect(kept.map(pageIdentityAndStatus)).toEqual(uninterrupted.pages.slice(0, PAGES_BEFORE_SWITCH).map(pageIdentityAndStatus));
    // k+1 ページ目: 結果に残らず、理由 `SITE_UNAVAILABLE`（`detail` は最初の失敗。止まるきっかけのページの印）の SKIPPED。
    expect(skipped[0]).toEqual(skippedPageResult(afterSwitch.pageUrl, afterSwitch.pageId, { code: SITE_UNAVAILABLE_SKIP_REASON.code, detail }));
    // 残りの、発見済みの URL: 理由 `SITE_UNAVAILABLE`（`detail` は `null`）の SKIPPED。
    expect(skipped.length).toBeGreaterThan(1);
    for (const page of skipped.slice(1)) {
      expect(page).toEqual(skippedPageResult(page.pageUrl, page.pageId, SITE_UNAVAILABLE_SKIP_REASON));
    }
    // 保存: STOPPED（再開できる）。終わったページは k ページだけで、k+1 ページ目のページの保存はない。
    expect(stoppedState.state).toBe('STOPPED');
    expect(stoppedState.completedPageIds).toEqual(kept.map(({ pageId }) => pageId));
    expect(stoppedCheckpointPageIds).toEqual([...stoppedState.completedPageIds].sort());
    expect(stoppedCheckpointPageIds).not.toContain(afterSwitch.pageId);
    expect(stoppedState.frontier.entries.find(({ pageId }) => pageId === afterSwitch.pageId)).toMatchObject({
      state: 'SKIPPED',
      skipReason: { code: SITE_UNAVAILABLE_SKIP_REASON.code, detail },
    });
  });

  it('sends only the document GET of the k+1-th page to the site after the switch, once per attempt (no Mobile, Interaction nor later page loads)', () => {
    const afterSwitch = stopped.requests.filter((request) => request.mode === mode);
    const documentGet = { method: 'GET', pathname: pathOf(pageAfterSwitch()) };

    // 1 回目の試行と、各確かめ直し（SU5、SU6。最大 4 回）の 1 回ずつ。
    expect(siteRequests(afterSwitch), JSON.stringify(stopped.requests)).toEqual(repeated(documentGet, MAX_RECHECKS + 1));
  });

  it('waits in stages (60 s, 2 min, 4 min, 8 min) before each recheck and sends nothing to the site while waiting (SU6, design 3.6.2)', () => {
    expect(stopped.sleeps).toEqual([...SITE_UNAVAILABLE_RECHECK_DELAYS_MS]);
    // 各待ちの時点までの要求の次の要求が、その確かめ直しの文書の GET（待っている間の要求はない）。
    const counts = stopped.requestCountsAtRecheckWait;
    expect(counts).toHaveLength(MAX_RECHECKS);
    for (const [index, countAtWait] of counts.entries()) {
      expect(siteRequests(stopped.requests.slice(countAtWait, counts[index + 1])), JSON.stringify(stopped.requests)).toEqual([
        { method: 'GET', pathname: pathOf(pageAfterSwitch()) },
      ]);
    }
  });

  it('shows the recheck notice once per stage (1/4 to 4/4) with the URL of the page, in order, before the one line of the stop, and no slowdown notice', () => {
    const lines = stopped.stdout.split('\n');
    const recheckLines = SITE_UNAVAILABLE_RECHECK_DELAYS_MS.map((_, index) => recheckLineOf(pageAfterSwitch().pageUrl, index + 1));

    for (const recheckLine of recheckLines) {
      expect(lines.filter((line) => line === recheckLine)).toHaveLength(1);
    }
    expect(linesEqualTo(stopped.stdout, siteUnavailableStopText(detail))).toBe(1);
    const indexes = [CLI_TEXT.run.started, ...recheckLines, siteUnavailableStopText(detail)].map((line) => lines.indexOf(line));
    expect([...indexes].sort((left, right) => left - right)).toEqual(indexes);
    expect(slowdownLinesIn(stopped.stdout)).toBe(0);
  });

  it('resumes from the k+1-th page by the same command after the site is back, and finishes the Run', async () => {
    const lines = resumed.stdout.split('\n');
    const resumeLine = resumeLineOf(stoppedState.runId, PAGES_BEFORE_SWITCH);

    expect(lines.filter((line) => line === resumeLine)).toHaveLength(1);
    expect(lines.indexOf(resumeLine)).toBeLessThan(lines.indexOf(CLI_TEXT.run.started));
    expect(resumed.stderr).toBe('');
    expect(await onlyRunDirectoryIn(outputDirectory)).toBe(runDirectory);
    const run = await readRun(runDirectory);
    expect(run.runId).toBe(stoppedState.runId);
    expect(resumed.code, resumed.stderr).toBe(uninterrupted.outcome.code);
    expect(endReasonsOf(run)).toEqual([SITE_UNAVAILABLE_END_REASON, COMPLETED_END_REASON]);
    expect((await readState(runDirectory)).state).toBe('FINISHED');
    // 不調だったページから、監査し直した（そのページの文書の要求が、サイトに届いた）。
    expect(getCount(resumed.requests, pathOf(pageAfterSwitch()))).toBeGreaterThan(0);
  });

  it('has no SITE_UNAVAILABLE in the Run reasons of the finished Run, and does not show the line of the stop', async () => {
    expect(siteUnavailableReasonsOf(await readRun(runDirectory))).toEqual([]);
    expect(linesEqualTo(resumed.stdout, siteUnavailableStopText(detail))).toBe(0);
    expect(linesEqualTo(resumed.stdout, siteUnavailableStopText(null))).toBe(0);
  });

  it('gives the same pages, page IDs, statuses, Findings (without the IDs) and Run Status as the uninterrupted Run', async () => {
    expect(await comparableRunIn(runDirectory)).toEqual(uninterrupted.comparable);
  });

  it('writes one diagnostic per discarded attempt (1 to 5) of the k+1-th page in diagnostics/ in the first execution, matching its schema (D2, SU5, SU6)', async () => {
    const afterSwitch = pageAfterSwitch();

    expect(stoppedDiagnosticPaths).toEqual(ALL_ATTEMPTS.map((attempt) => siteUnavailableDiagnosticRelativePath(afterSwitch.pageId, 1, attempt)));
    const [execution] = stoppedRun.executions;
    const rechecks = stoppedRecheckDiagnostics.map(presentDiagnostic);
    const diagnostics = [presentDiagnostic(stoppedDiagnostic), ...rechecks];
    for (const diagnostic of diagnostics) {
      await expect(validateArtifact('site-unavailable-diagnostic', diagnostic)).resolves.toEqual({ ok: true });
      expect(diagnostic).toMatchObject({
        schemaVersion: SITE_UNAVAILABLE_DIAGNOSTIC_SCHEMA_VERSION,
        runId: stoppedState.runId,
        executionNumber: 1,
        pageId: afterSwitch.pageId,
        url: afterSwitch.pageUrl,
        siteUnavailableDetail: detail,
      });
      // ページの監査の結果（捨てた試行の結果。出力の結果には残らない）。
      expect(diagnostic.page).toMatchObject({ pageId: afterSwitch.pageId, pageUrl: afterSwitch.pageUrl });
      expect(diagnostic.page.viewports[stoppedViewport].requestedUrl).toBe(afterSwitch.pageUrl);
      // 書いた時刻は、1回目の実行の開始と終わりの間。
      expect(Date.parse(diagnostic.writtenAt)).toBeGreaterThanOrEqual(Date.parse(execution?.startedAt ?? ''));
      expect(Date.parse(diagnostic.writtenAt)).toBeLessThanOrEqual(Date.parse(execution?.finishedAt ?? ''));
    }
    // 各確かめ直しの試行の記録は、別の試行の観察（前の試行より後に書いた）。
    for (const [index, recheck] of rechecks.entries()) {
      const previous = diagnostics[index] as SiteUnavailableDiagnosticRecord;
      expect(Date.parse(recheck.writtenAt)).toBeGreaterThanOrEqual(Date.parse(previous.writtenAt));
      expect(documentHopOf(recheck, stoppedViewport, afterSwitch.pageUrl).issuedAtMs)
        .toBeGreaterThan(documentHopOf(previous, stoppedViewport, afterSwitch.pageUrl).issuedAtMs);
    }
  });

  it('records in the observation of the stopped viewport that the document request headers were sent, and the response as the site gave it (D2)', () => {
    const diagnostic = presentDiagnostic(stoppedDiagnostic);
    const hop = documentHopOf(diagnostic, stoppedViewport, pageAfterSwitch().pageUrl);

    expect(hop.method).toBe('GET');
    // 要求のヘッダは、ネットワークへ送られた（中継のサーバは、その要求を受けた）。
    expect(hop.requestHeadersSentAtMs).toEqual(expect.any(Number));
    expect(hop.requestHeadersSentAtMs as number).toBeGreaterThanOrEqual(hop.issuedAtMs);
    expect(hop.httpStatus).toBe(responseStatus);
    if (responseStatus === null) {
      // 応答しない場面: 応答のヘッダを受けていない（サイト側か経路の問題）。
      expect(hop.responseHeadersReceivedAtMs).toBeNull();
    } else {
      // 本文が空の 503 の場面: 応答のヘッダを受けた。
      expect(hop.responseHeadersReceivedAtMs).toEqual(expect.any(Number));
    }
    // 不調を検知した後のビューポートは、読み込みを始めなかった。
    for (const viewport of VIEWPORT_PROFILES.filter((profile) => profile !== stoppedViewport)) {
      expect(diagnostic.navigationDiagnostics[viewport], viewport).toBeNull();
    }
  });

  // D3（設計書 2.2 の 2026-10-07 の改訂、2.3）: 診断の記録は 1.1 の形で、ビューポートごとに、Passive の観察に加えて、幅の走査の幅ごとと
  // Interaction の候補ごとの観察の項目を持つ。Passive の読み込みで止まったので、どちらの読み込みも始めておらず、項目は空の配列である。
  it('writes the diagnostic in the schema version 1.1, with the stress width and the interaction candidate items of the stopped viewport (D3)', () => {
    const diagnostic = presentDiagnostic(stoppedDiagnostic);

    expect(diagnostic.schemaVersion).toBe('site-unavailable-diagnostic-schema/1.1');
    const stopped = diagnostic.navigationDiagnostics[stoppedViewport];
    expect(stopped, JSON.stringify(stopped)).not.toBeNull();
    expect(Object.keys(stopped as object).sort()).toEqual(['interactionCandidates', 'passive', 'stressWidths']);
    expect(stopped?.passive?.status).toBe('OBSERVED');
    expect(stopped?.stressWidths).toEqual([]);
    expect(stopped?.interactionCandidates).toEqual([]);
  });

  it('keeps the diagnostics as they are after the resumed execution finishes the Run and cleans up checkpoint/ (D2)', async () => {
    expect((await readState(runDirectory)).state).toBe('FINISHED');
    expect(resumedDiagnosticPaths).toEqual(stoppedDiagnosticPaths);
    expect(presentDiagnostic(resumedDiagnostic)).toEqual(presentDiagnostic(stoppedDiagnostic));
    // 戻ったサイトでの再開では、待たず、確かめ直しの知らせも出ない。
    expect(resumed.sleeps).toEqual([]);
    expect(recheckLinesIn(resumed.stdout, uninterrupted.pages)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 場面 5（SU5、SU6。設計書 3.5、3.6）: ページの監査の途中で応答しなくなり、1 回目の確かめ直しも通らず、2 回目の確かめ直しの前の待ち
// （2 分）の間にサイトが戻る。同じ起動の中で、同じページを確かめ直して通り、ページの読み込みの間隔を 2 倍にして、Run を最後まで終える。
// ---------------------------------------------------------------------------------------------------------------

describe('SU6: the site is back before the second recheck of the k+1-th page: the Run passes, slows down and finishes (design 3.6)', () => {
  const OUTPUT_NAME = 'recheck-recovers';
  /** この場面の設定の間隔（ms。減速の知らせを出すために 0 でない値にする。待ちは差し替えるので、実際には待たない）。 */
  const BASE_INTERVAL_MS = 1_000;

  let outcome: CommandOutcome;
  let runDirectory: string;
  let run: RunSummary;
  let diagnosticPaths: string[];
  let diagnostics: (SiteUnavailableDiagnosticRecord | null)[];

  beforeAll(async () => {
    const config = configFor(OUTPUT_NAME, BASE_INTERVAL_MS);
    // k ページ目の後に `HANG` にし、2 回目の確かめ直しの前の待ちのときに `NORMAL` に戻す（待ちは実際には行わない）。
    outcome = await runSwitchedAfterPages(config, 'HANG', {
      onRecheckWait: (_delayMs, index) => {
        if (index === 1) {
          relay.setMode('NORMAL');
        }
      },
    });
    runDirectory = await onlyRunDirectoryIn(config.output.directory);
    run = await readRun(runDirectory);
    diagnosticPaths = await diagnosticPathsIn(runDirectory);
    diagnostics = [];
    for (const attempt of ALL_ATTEMPTS.slice(0, 2)) {
      diagnostics.push(await readDiagnostic(runDirectory, pageAfterSwitch().pageId, 1, attempt));
    }
  }, SUITE_TIMEOUT_MS);

  it('finishes the Run in the one execution, with the same pages, statuses, Findings and Run Status as the uninterrupted Run', async () => {
    expect(outcome.code, outcome.stderr).toBe(uninterrupted.outcome.code);
    expect(outcome.stderr).toBe('');
    expect(endReasonsOf(run)).toEqual([COMPLETED_END_REASON]);
    expect(siteUnavailableReasonsOf(run)).toEqual([]);
    expect(run.safety.invariantViolationCount).toBe(0);
    expect((await readState(runDirectory)).state).toBe('FINISHED');
    expect(await comparableRunIn(runDirectory)).toEqual(uninterrupted.comparable);
    // 設定の間隔は、`run.json` の `load` に設定の値のまま残る（減速は保存しない）。
    expect(run.load.minNavigationIntervalMs).toBe(BASE_INTERVAL_MS);
  });

  it('waits twice (60 s, then 2 min), sends nothing while waiting, and then loads the same page again before going on', () => {
    const afterSwitch = pageAfterSwitch();
    const documentGet = { method: 'GET', pathname: pathOf(afterSwitch) };

    expect(outcome.recheckSleeps).toEqual(SITE_UNAVAILABLE_RECHECK_DELAYS_MS.slice(0, 2));
    // 応答しない間に届いたのは、そのページの文書の GET の 2 件（1 回目と、1 回目の確かめ直し）だけ。
    expect(siteRequests(outcome.requests.filter((request) => request.mode === 'HANG')), JSON.stringify(outcome.requests)).toEqual([documentGet, documentGet]);
    // 各待ちの時点までの要求の次が、その確かめ直しの文書の GET。2 回目の確かめ直し（`NORMAL`）で、そのページは中断しない Run と同じ回数の
    // 読み込みを受ける。
    const counts = outcome.requestCountsAtRecheckWait;
    expect(counts).toHaveLength(2);
    expect(siteRequests(outcome.requests.slice(counts[0], counts[1]))).toEqual([documentGet]);
    expect(outcome.requests[counts[0] as number]?.mode).toBe('HANG');
    expect(siteRequests(outcome.requests.slice(counts[1], (counts[1] as number) + 1))).toEqual([documentGet]);
    expect(outcome.requests[counts[1] as number]?.mode).toBe('NORMAL');
    expect(getCount(outcome.requests.filter((request) => request.mode === 'NORMAL'), pathOf(afterSwitch))).toBe(DOCUMENT_GETS_PER_PAGE);
  });

  it('shows the recheck notices (1/4, 2/4) and then the slowdown notice with the doubled interval, in order, and no line of a stop', () => {
    const lines = outcome.stdout.split('\n');
    const pageUrl = pageAfterSwitch().pageUrl;
    const firstRecheckLine = recheckLineOf(pageUrl, 1);
    const secondRecheckLine = recheckLineOf(pageUrl, 2);
    const slowdownLine = slowdownLineOf(BASE_INTERVAL_MS * SITE_UNAVAILABLE_SLOWDOWN_FACTOR);

    expect(lines.filter((line) => line === firstRecheckLine)).toHaveLength(1);
    expect(lines.filter((line) => line === secondRecheckLine)).toHaveLength(1);
    expect(lines.filter((line) => line === slowdownLine)).toHaveLength(1);
    expect(slowdownLinesIn(outcome.stdout)).toBe(1);
    expect(recheckLinesIn(outcome.stdout, uninterrupted.pages)).toBe(2);
    const indexes = [CLI_TEXT.run.started, firstRecheckLine, secondRecheckLine, slowdownLine, CLI_TEXT.run.resultHeading].map((line) => lines.indexOf(line));
    expect([...indexes].sort((left, right) => left - right)).toEqual(indexes);
    expect(linesEqualTo(outcome.stdout, siteUnavailableStopText(DESKTOP_PASSIVE_TIMEOUT))).toBe(0);
    expect(linesEqualTo(outcome.stdout, siteUnavailableStopText(null))).toBe(0);
  });

  it('writes the diagnostics of the discarded attempts (1 and 2) only, and keeps them after the Run is finished (D2, SU5, SU6)', async () => {
    const afterSwitch = pageAfterSwitch();

    expect(diagnosticPaths).toEqual(ALL_ATTEMPTS.slice(0, 2).map((attempt) => siteUnavailableDiagnosticRelativePath(afterSwitch.pageId, 1, attempt)));
    for (const diagnostic of diagnostics) {
      const record = presentDiagnostic(diagnostic);
      await expect(validateArtifact('site-unavailable-diagnostic', record)).resolves.toEqual({ ok: true });
      expect(record).toMatchObject({ runId: run.runId, executionNumber: 1, pageId: afterSwitch.pageId, siteUnavailableDetail: DESKTOP_PASSIVE_TIMEOUT });
      const hop = documentHopOf(record, 'desktop', afterSwitch.pageUrl);
      expect(hop.requestHeadersSentAtMs).toEqual(expect.any(Number));
      expect(hop.responseHeadersReceivedAtMs).toBeNull();
    }
    // 出力の結果では、そのページは確かめ直しの結果（中断しない Run と同じ状態）。
    const page = (await readRunAudit(runDirectory)).pages.find(({ pageId }) => pageId === afterSwitch.pageId);
    expect(page?.status).toBe(afterSwitch.status);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 場面 3: robots.txt の段階で、応答しない
// ---------------------------------------------------------------------------------------------------------------

describe('SU3c: the site does not respond to robots.txt from the start of the Run (design 3.1, 3.2.1)', () => {
  const OUTPUT_NAME = 'site-metadata-hang';

  let outputDirectory: string;
  let stopped: CommandOutcome;
  let runDirectory: string;
  let stoppedRun: RunSummary;
  let stoppedPages: readonly PageAuditResult[];
  let stoppedState: RunCheckpoint;
  let stoppedDiagnosticPaths: string[];
  let resumed: CommandOutcome;

  beforeAll(async () => {
    const config = configFor(OUTPUT_NAME);
    outputDirectory = config.output.directory;
    // 1回目: Run の前から `HANG` にする。
    stopped = await runCommand(config, 'HANG');
    runDirectory = await onlyRunDirectoryIn(outputDirectory);
    stoppedRun = await readRun(runDirectory);
    stoppedPages = (await readRunAudit(runDirectory)).pages;
    stoppedState = await readState(runDirectory);
    stoppedDiagnosticPaths = await diagnosticPathsIn(runDirectory);
    // 2回目: サイトが戻った（`NORMAL`）後に、同じ設定で実行する。
    resumed = await runCommand(config, 'NORMAL');
  }, SUITE_TIMEOUT_MS);

  it('does not write a diagnostic when it stops at robots.txt and sitemap.xml (site-unavailable diagnostics design 2.3, D2)', () => {
    expect(stoppedDiagnosticPaths).toEqual([]);
  });

  it('does not wait or check again at robots.txt and sitemap.xml (SU5, design 3.5.2)', () => {
    expect(stopped.sleeps).toEqual([]);
    expect(recheckLinesIn(stopped.stdout, uninterrupted.pages)).toBe(0);
  });

  it('sends only the GET of robots.txt to the site: no page load and no sitemap.xml', () => {
    expect(siteRequests(stopped.requests), JSON.stringify(stopped.requests)).toEqual([{ method: 'GET', pathname: ROBOTS_TXT_PATH }]);
  });

  it('ends the first execution with STOPPED_BY_SITE_UNAVAILABLE, the detail of the site metadata, and the start URL SKIPPED', () => {
    expect(stopped.code, stopped.stderr).toBe(EXIT_CODES.PARTIAL);
    expect(stopped.stderr).toBe('');
    expect(endReasonsOf(stoppedRun)).toEqual([SITE_UNAVAILABLE_END_REASON]);
    expect(siteUnavailableReasonsOf(stoppedRun)).toEqual([{ code: SITE_UNAVAILABLE_SKIP_REASON.code, detail: SITE_METADATA_TIMEOUT }]);
    expect(stoppedRun.safety.invariantViolationCount).toBe(0);
    const [start] = uninterrupted.pages;
    expect(start).toBeDefined();
    expect(stoppedPages).toEqual([skippedPageResult((start as PageAuditResult).pageUrl, (start as PageAuditResult).pageId, SITE_UNAVAILABLE_SKIP_REASON)]);
    // 保存: STOPPED。取得の結果は残さない（再開のときに、取得し直す）。
    expect(stoppedState.state).toBe('STOPPED');
    expect(stoppedState.siteMetadata).toBeNull();
    expect(stoppedState.completedPageIds).toEqual([]);
    expect(linesEqualTo(stopped.stdout, siteUnavailableStopText(SITE_METADATA_TIMEOUT))).toBe(1);
  });

  it('fetches robots.txt and sitemap.xml again after the site is back, and finishes the Run as the uninterrupted Run', async () => {
    const lines = resumed.stdout.split('\n');
    const resumeLine = resumeLineOf(stoppedState.runId, 0);

    expect(lines.filter((line) => line === resumeLine)).toHaveLength(1);
    expect(resumed.stderr).toBe('');
    expect(getCount(resumed.requests, ROBOTS_TXT_PATH)).toBe(1);
    expect(getCount(resumed.requests, SITEMAP_XML_PATH)).toBe(1);
    expect(await onlyRunDirectoryIn(outputDirectory)).toBe(runDirectory);
    const run = await readRun(runDirectory);
    expect(resumed.code, resumed.stderr).toBe(uninterrupted.outcome.code);
    expect(endReasonsOf(run)).toEqual([SITE_UNAVAILABLE_END_REASON, COMPLETED_END_REASON]);
    expect(siteUnavailableReasonsOf(run)).toEqual([]);
    expect(linesEqualTo(resumed.stdout, siteUnavailableStopText(SITE_METADATA_TIMEOUT))).toBe(0);
    // 取得の結果（robots.txt と sitemap.xml の Evidence。開始の URL のページに置く）。
    const [start] = (await readRunAudit(runDirectory)).pages;
    const metadata = start?.evidence.flatMap((record) => (record.type === 'metadata' ? [record] : []));
    expect(metadata?.map((record) => [record.payload.kind, record.payload.outcome])).toEqual([['ROBOTS_TXT', 'OK'], ['SITEMAP_XML', 'OK']]);
    expect(await comparableRunIn(runDirectory)).toEqual(uninterrupted.comparable);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 場面 4: サイトが戻る前に再開した（設計書 3.2.1）
// ---------------------------------------------------------------------------------------------------------------

describe('SU3c: a Run resumed before the site is back keeps the trigger page as FAILED and goes on (design 3.2.1)', () => {
  const OUTPUT_NAME = 'resumed-before-back';

  let outputDirectory: string;
  let first: CommandOutcome;
  let runDirectory: string;
  let firstState: RunCheckpoint;
  let second: CommandOutcome;
  let secondRun: RunSummary;
  let secondPages: readonly PageAuditResult[];
  let secondState: RunCheckpoint;
  let secondCheckpointPageIds: PageId[];
  let secondDiagnosticPaths: string[];
  let secondDiagnostic: SiteUnavailableDiagnosticRecord | null;
  let third: CommandOutcome;
  let finalRun: RunSummary;
  let finalPages: readonly PageAuditResult[];
  let finalDiagnosticPaths: string[];

  beforeAll(async () => {
    const config = configFor(OUTPUT_NAME);
    outputDirectory = config.output.directory;
    // 1回目: 場面 1 と同じく、k ページ目の後に `HANG` にして止める。
    first = await runSwitchedAfterPages(config, 'HANG');
    runDirectory = await onlyRunDirectoryIn(outputDirectory);
    firstState = await readState(runDirectory);
    // 2回目: `HANG` のまま、同じ設定で実行する。
    second = await runCommand(config, 'HANG');
    secondRun = await readRun(runDirectory);
    secondPages = (await readRunAudit(runDirectory)).pages;
    secondState = await readState(runDirectory);
    secondCheckpointPageIds = await checkpointPageIdsIn(runDirectory);
    secondDiagnosticPaths = await diagnosticPathsIn(runDirectory);
    secondDiagnostic = await readDiagnostic(runDirectory, pageAfterSwitch().pageId, 2, FIRST_ATTEMPT);
    // 3回目: サイトが戻った（`NORMAL`）後に、同じ設定で実行する。
    third = await runCommand(config, 'NORMAL');
    finalRun = await readRun(runDirectory);
    finalPages = (await readRunAudit(runDirectory)).pages;
    finalDiagnosticPaths = await diagnosticPathsIn(runDirectory);
  }, SUITE_TIMEOUT_MS);

  it('writes the diagnostic of the trigger page in the second execution too, with the execution number 2 and the attempt number 1, and keeps all to the end (D2, SU5)', () => {
    const afterSwitch = pageAfterSwitch();
    // 1 回目の実行: 試行 1 と確かめ直しの試行 2〜5。2 回目の実行: 前の実行のきっかけのページなので、確かめ直さずに試行 1 だけ。
    const expectedPaths = [
      ...ALL_ATTEMPTS.map((attempt) => siteUnavailableDiagnosticRelativePath(afterSwitch.pageId, 1, attempt)),
      siteUnavailableDiagnosticRelativePath(afterSwitch.pageId, 2, FIRST_ATTEMPT),
    ];

    expect(secondDiagnosticPaths).toEqual(expectedPaths);
    const diagnostic = presentDiagnostic(secondDiagnostic);
    expect(diagnostic).toMatchObject({
      runId: firstState.runId,
      executionNumber: 2,
      pageId: afterSwitch.pageId,
      siteUnavailableDetail: DESKTOP_PASSIVE_TIMEOUT,
    });
    // 2回目の実行では、きっかけのページを普通の結果として保存した。診断の記録のページの結果は、その結果と同じ。
    expect(diagnostic.page).toEqual(secondPages[PAGES_BEFORE_SWITCH]);
    const hop = documentHopOf(diagnostic, 'desktop', afterSwitch.pageUrl);
    expect(hop.requestHeadersSentAtMs).toEqual(expect.any(Number));
    expect(hop.responseHeadersReceivedAtMs).toBeNull();
    expect(finalDiagnosticPaths).toEqual(expectedPaths);
  });

  it('stops the first execution after the k-th page as in the first scenario', () => {
    expect(first.code, first.stderr).toBe(EXIT_CODES.PARTIAL);
    expect(firstState.state).toBe('STOPPED');
    expect(firstState.completedPageIds).toEqual(uninterrupted.pages.slice(0, PAGES_BEFORE_SWITCH).map(({ pageId }) => pageId));
    expect(linesEqualTo(first.stdout, siteUnavailableStopText(DESKTOP_PASSIVE_TIMEOUT))).toBe(1);
  });

  it('second execution (still HANG): keeps the trigger page as a FAILED result, skips the rest, and stops again', () => {
    const afterSwitch = pageAfterSwitch();
    const trigger = secondPages[PAGES_BEFORE_SWITCH];

    expect(linesEqualTo(second.stdout, resumeLineOf(firstState.runId, PAGES_BEFORE_SWITCH))).toBe(1);
    expect(second.code, second.stderr).toBe(EXIT_CODES.PARTIAL);
    expect(second.stderr).toBe('');
    expect(endReasonsOf(secondRun)).toEqual([SITE_UNAVAILABLE_END_REASON, SITE_UNAVAILABLE_END_REASON]);
    expect(siteUnavailableReasonsOf(secondRun)).toEqual([{ code: SITE_UNAVAILABLE_SKIP_REASON.code, detail: DESKTOP_PASSIVE_TIMEOUT }]);
    expect(linesEqualTo(second.stdout, siteUnavailableStopText(DESKTOP_PASSIVE_TIMEOUT))).toBe(1);
    // きっかけのページ（k+1 ページ目）は、失敗の結果として残る（終わったページになり、ページの保存がある）。
    expect(trigger).toMatchObject({ pageId: afterSwitch.pageId, pageUrl: afterSwitch.pageUrl, status: 'FAILED' });
    expect(trigger?.viewports.desktop.status).toBe('FAILED');
    expect(trigger?.viewports.mobile).toMatchObject({ status: 'SKIPPED', incompleteReasons: [SITE_UNAVAILABLE_SKIP_REASON] });
    expect(secondState.state).toBe('STOPPED');
    expect(secondState.completedPageIds).toEqual([...firstState.completedPageIds, afterSwitch.pageId]);
    expect(secondCheckpointPageIds).toEqual([...secondState.completedPageIds].sort());
    expect(secondCheckpointPageIds).toContain(afterSwitch.pageId);
    // 残りの URL は、理由 `SITE_UNAVAILABLE`（`detail` は `null`）の SKIPPED。
    const rest = secondPages.slice(PAGES_BEFORE_SWITCH + 1);
    expect(rest.length).toBeGreaterThan(0);
    for (const page of rest) {
      expect(page).toEqual(skippedPageResult(page.pageUrl, page.pageId, SITE_UNAVAILABLE_SKIP_REASON));
    }
  });

  it('second execution: the only request that reaches the site is the document GET of the trigger page (no recheck of the trigger page, SU5)', () => {
    expect(siteRequests(second.requests), JSON.stringify(second.requests)).toEqual([{ method: 'GET', pathname: pathOf(pageAfterSwitch()) }]);
    expect(second.requests.every((request) => request.mode === 'HANG')).toBe(true);
    expect(second.sleeps).toEqual([]);
    expect(recheckLinesIn(second.stdout, uninterrupted.pages)).toBe(0);
  });

  it('third execution (NORMAL): goes on from the next page without auditing the trigger page again, and finishes the Run', async () => {
    const afterSwitch = pageAfterSwitch();
    const triggerBefore = secondPages[PAGES_BEFORE_SWITCH];
    const triggerAfter = finalPages[PAGES_BEFORE_SWITCH];

    expect(linesEqualTo(third.stdout, resumeLineOf(firstState.runId, PAGES_BEFORE_SWITCH + 1))).toBe(1);
    expect(third.stderr).toBe('');
    expect(await onlyRunDirectoryIn(outputDirectory)).toBe(runDirectory);
    expect(third.code, third.stderr).toBe(exitCodeForRunStatus(finalRun.runStatus));
    expect(endReasonsOf(finalRun)).toEqual([SITE_UNAVAILABLE_END_REASON, SITE_UNAVAILABLE_END_REASON, COMPLETED_END_REASON]);
    expect(siteUnavailableReasonsOf(finalRun)).toEqual([]);
    expect(linesEqualTo(third.stdout, siteUnavailableStopText(DESKTOP_PASSIVE_TIMEOUT))).toBe(0);
    expect((await readState(runDirectory)).state).toBe('FINISHED');
    // きっかけのページは、監査し直さない（文書の要求が届かない）。結果は、2回目の失敗の結果のまま（FAILED）。
    expect(getCount(third.requests, pathOf(afterSwitch))).toBe(0);
    expect(triggerAfter?.status).toBe('FAILED');
    const unchanged = (page: PageAuditResult | undefined): unknown =>
      ({ status: page?.status, viewports: page?.viewports, incompleteReasons: page?.incompleteReasons, evidence: page?.evidence });
    expect(unchanged(triggerAfter)).toEqual(unchanged(triggerBefore));
    // 次のページから続けた（その文書の要求が届いた）。
    const next = uninterrupted.pages[PAGES_BEFORE_SWITCH + 1] as PageAuditResult;
    expect(getCount(third.requests, pathOf(next))).toBeGreaterThan(0);
    expect(third.requests.filter(({ pathname }) => pathname.startsWith(PAGE_PATH_PREFIX)).length).toBeGreaterThan(0);
    // ページの一覧と ID は、中断しない Run と同じ。状態は、きっかけのページのほかは、中断しない Run と同じ。
    expect(finalPages.map(({ pageId, pageUrl }) => ({ pageId, pageUrl })))
      .toEqual(uninterrupted.pages.map(({ pageId, pageUrl }) => ({ pageId, pageUrl })));
    const withoutTrigger = (pages: readonly PageAuditResult[]): unknown[] =>
      pages.filter(({ pageId }) => pageId !== afterSwitch.pageId).map(pageIdentityAndStatus);
    expect(withoutTrigger(finalPages)).toEqual(withoutTrigger(uninterrupted.pages));
  });
});

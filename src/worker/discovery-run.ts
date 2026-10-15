/**
 * 発見のジョブ（`DISCOVERY`）の流れ（Task 27 の設計書 3 章、4.2、4.4、4.6 と、変更履歴の「T27b・T27c の報告と T27d の前の判断」「Blocker: T27d」の
 * 行。T27d）。ワーカーの流れ（`audit-worker-session.ts`）が、ログインの段の後に、認証の指定（`RunAuthentication`）を付けて呼ぶ。今の監査の流れ
 * （`page-auditor.ts`、Run Coordinator）には手を入れない（公開監査と認証つきの監査の出力を変えないため）。
 *
 * 1. 出力先の開始のロックと Run のロック（監査と同じ。CLI の監査から、動いている Run として見える）:
 *    - 開始のロックを、CLI の監査と同じ部品（`src/orchestration/output-start-lock.ts`。CCX-6）で取る。動いている持ち主のものなら `RUN_ACTIVE`。
 *    - 出力先に動いている Run（Run のロックが `ACTIVE`）があれば `RUN_ACTIVE`。
 *    - Run の ID は今の決まり（`createRunIdFromTime`）。Run のディレクトリを排他的に作り（`createRunArtifactDirectory`）、作れなければ
 *      `RUN_DIRECTORY_UNAVAILABLE`。Run のロックは保存のセッション（`RunCheckpointSession` の `NEW_RUN`。ロックとハートビートだけを使い、保存の
 *      状態は書かない。再開の対象にしない）で取り、終わりに、ハートビートを止めてロックを消す。開始のロックは、Run のロックを取った後に離す。
 * 2. Run の前の確認（`runPreflight`。認証の指定を付けた factory）。失敗したら、画面を読まずに `PREFLIGHT_FAILED`。
 * 3. 巡回（今の監査の巡回の部品を使う。同じ意味の巡回を書き写さない）: 開始の URL（`normalizeUrl`）から、`CrawlFrontier`（深さの上限と BFS）、
 *    リンクの抽出の唯一の入口 `discoverLinks`（受け入れの判定 `classifyUrl`。許可 Origin は設定の `site.allowedOrigins`）、認証つきの Run の
 *    巡回の候補の除外 `isExcludedCrawlCandidate`（認証の設定の読まないパス・読む範囲・既定の危険な語と、セッションの切れの path）、読み込みの
 *    間隔 `createNavigationPacer`（`crawl.minNavigationIntervalMs`）。上限は `crawl.maxPages`（読んだ画面の数）と `crawl.maxRuntimeMs`。
 * 4. 画面ごと（凍結は戻せないので、画面ごとに新しい Context）: Guard の付いた新しい Passive の Context と page
 *    （`openPassiveSessionBeforeDeadline`。認証の状態は factory が世代つきで受け継ぐ）→ 進行中の要求の数え方（`InFlightRequestCounter`）を
 *    `goto` の前に作る → 読み込みの間隔を待つ → 読み込み（`navigatePage`）→ セッションの切れの確かめ → 発見（`discoverPageCandidates`。落ち着きの待ち → 凍結 → 読む）
 *    → 同じページでリンクの抽出（`discoverLinks`。凍結の後の読むだけの evaluate。読み込みを足さない）→ Context を閉じる。
 *    リンクの抽出を発見の後にするのは、凍結の後はページの JS の送信も Guard が止める段階で読むため（凍結の前に読むと、凍結までの間に抽出の
 *    evaluate が走る分、ページの JS が動く時間が延びる）。どちらの順でも、読み込みは 1 画面 1 回。
 * 5. 止まり方: 止める要求（今の画面を終えてから）、セッションの切れ（`AUTH_SESSION_LOST`。止まった画面の URL を伏せ字を通して知らせる。発見の
 *    ジョブは再開しない）、Safety Ledger の不変条件の違反（`SAFETY_VIOLATION`）。
 * 6. 成果物: Run のディレクトリの `discovery.json` を、ArtifactWriter（URL の秘密を伏せる書き手）の `writeDiscovery` で書く。スクリーンショットは
 *    撮らない。結果は、Run の ID、Run のディレクトリ、Run Status、件数の要約（IPC に候補を載せない）。
 * 秘密（Cookie、localStorage）は、メモリの認証の指定のまま factory に渡し、ここで読まない・書かない。
 * T27e: 1 の Run の始めと終わり、4 の 1 画面の読み込み（Context の作り方、間隔、セッションの切れ）は、READ の確かめのジョブと共有するために
 * `worker-run-session.ts` に切り出した（振る舞いは変えない）。
 */
import { resolve } from 'node:path';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { EXIT_CODES } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import type { RunId, RunStatus } from '../core/contracts.js';
import { wait } from '../core/deadline.js';
import type { NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { discoverLinks } from '../crawl/discover-links.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { discoverPageCandidates, type DiscoveryPageRecord } from '../discovery/discover-page.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  MAX_DISCOVERY_UNREAD_PAGE_ENTRIES,
  discoveryRunStatusOf,
  discoverySummaryOf,
  type DiscoveryDocument,
  type DiscoveryEndReason,
  type DiscoveryPageEntry,
  type DiscoveryReadPageRecord,
  type DiscoverySummary,
  type DiscoveryUnreadReason,
} from '../discovery/discovery-result.js';
import {
  authenticatedContextOptions,
  isExcludedCrawlCandidate,
  type RunAuthentication,
} from '../orchestration/authenticated-run.js';
import { CrawlFrontier } from '../orchestration/crawl-frontier.js';
import { IdAllocator } from '../orchestration/id-allocator.js';
import { closeBrowserBeforeDeadline, runPreflight, type BrowserLauncher } from '../orchestration/preflight.js';
import { internalNavigableUrlsOf } from '../orchestration/run-coordinator.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import { redactUrlSecrets } from '../safety/redact.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import { endWorkerRun, startWorkerRun, visitGuardedPage } from './worker-run-session.js';

/** 日時の名前（誤りの文に使う）。 */
const DISCOVERY_TIME_SUBJECT = 'discovery run time';

/** 発見の流れの入力。秘密（認証の状態）はメモリの認証の指定の中だけ。 */
export interface DiscoveryRunRequest {
  /** ワーカーが読んだ設定（`WORKER_CONFIG_OVERRIDES` の headless）。 */
  readonly config: AuditConfig;
  /** 発見のジョブの ID（成果物に書き、親が照らし合わせる）。 */
  readonly jobId: string;
  /** ログインの段の後の、認証つきの Run の指定。 */
  readonly authentication: RunAuthentication;
  readonly launchBrowser: BrowserLauncher;
  readonly clock: () => Date;
  readonly now: () => number;
  /** 止める印（今の画面を終えてから止まる）。 */
  readonly stopSignal: AbortSignal;
  /**
   * 読み込みの間隔を守る部品（省略すると、設定の `crawl.minNavigationIntervalMs` で作る）。ワーカーの流れは渡さない。テストが、読み込みの開始の
   * 時刻を記録するために、同じ部品を包んで渡す（Page Auditor の `navigationPacer` と同じ注入の形）。
   */
  readonly navigationPacer?: NavigationPacer | undefined;
}

/** 観測の口（ワーカーの流れが IPC に写す）。 */
export interface DiscoveryRunObserver {
  /** Run のディレクトリとロックを作った（`RUN_STARTED`）。 */
  readonly onRunStarted: (event: { readonly runId: RunId; readonly runDirectory: string }) => void;
  /** セッションの切れを見つけた（`AUTH_STATE` の `SESSION_LOST`。URL は伏せ字を通した値）。 */
  readonly onSessionLost: (url: string) => void;
}

/** 発見の流れの結果（Run のディレクトリは絶対パス）。 */
export type DiscoveryRunOutcome =
  | {
    readonly kind: 'RAN';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
    readonly summary: DiscoverySummary;
  }
  | { readonly kind: 'RUN_ACTIVE'; readonly activeRunId: RunId | null; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  };

/** 1 画面の結果。 */
type PageVisit =
  | {
    readonly kind: 'READ';
    readonly record: DiscoveryPageRecord;
    readonly links: readonly NormalizedHttpUrlEvidence[];
    readonly blockedRequests: number;
    readonly violation: boolean;
  }
  | { readonly kind: 'NAVIGATION_FAILED'; readonly violation: boolean }
  | { readonly kind: 'SESSION_LOST'; readonly url: string; readonly violation: boolean };

/** 巡回の結果。 */
interface CrawlResult {
  readonly endReason: DiscoveryEndReason;
  readonly pages: readonly DiscoveryPageEntry[];
  readonly omittedUnreadPages: number;
}

/** 発見の巡回（ファイルの先頭の 2〜5）。 */
async function crawl(request: DiscoveryRunRequest, outputDirectory: string, observer: DiscoveryRunObserver): Promise<CrawlResult> {
  const { config, authentication, stopSignal, now } = request;
  const allowedQueryParameters: ReadonlySet<string> = new Set(config.crawl.allowedQueryParameters);
  const start = normalizeUrl(config.site.startUrl, config.site.startUrl, allowedQueryParameters);
  if (!start.ok) {
    throw new RangeError('the start URL of the configuration cannot be normalized');
  }
  const unreadReasons = new Map<string, DiscoveryUnreadReason>();
  // DEF-100 fix: pacer は PREFLIGHT の前に作り、factory にも渡す（Guard が main frame の文書の要求を送った時刻を記録する）。
  const pacer = request.navigationPacer ?? createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now, sleep: wait });
  const preflight = await runPreflight({
    config,
    launchBrowser: request.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    outputDirectory,
    contextFactoryOptions: { authentication: authenticatedContextOptions(authentication), navigationPacer: pacer },
  });
  if (!preflight.ok) {
    return { endReason: 'PREFLIGHT_FAILED', pages: [{ url: start.url, state: 'NOT_READ', reason: 'PREFLIGHT_FAILED' }], omittedUnreadPages: 0 };
  }
  const { browser, factory } = preflight;
  try {
    const crawlAllowedOrigins: ReadonlySet<string> = new Set(config.site.allowedOrigins);
    const linkPolicy = { allowedOrigins: crawlAllowedOrigins, allowedQueryParameters };
    const classificationPolicy = { allowedOrigins: new Set(authentication.approvedTestOrigins) };
    const frontier = new CrawlFrontier(config.crawl.maxDepth, new IdAllocator());
    frontier.discover(start.url, 0);
    /** 除外に当たったリンク（見つけた順。重複なし）。 */
    const excluded = new Set<string>();
    const readPages: DiscoveryPageEntry[] = [];
    const startedAtMs = now();
    let endReason: DiscoveryEndReason = 'COMPLETED';
    for (let entry = frontier.next(); entry !== undefined; entry = frontier.next()) {
      if (stopSignal.aborted) {
        endReason = 'STOPPED';
      } else if (now() - startedAtMs >= config.crawl.maxRuntimeMs) {
        endReason = 'MAX_RUNTIME_REACHED';
      } else if (readPages.length >= config.crawl.maxPages) {
        endReason = 'MAX_PAGES_REACHED';
      }
      if (endReason !== 'COMPLETED') {
        unreadReasons.set(entry.url, endReason);
        break;
      }
      frontier.markAuditing(entry.url);
      const visit = await visitPage(factory, pacer, entry.url, {
        config, allowedQueryParameters, linkPolicy, classificationPolicy, authentication, pageId: entry.pageId,
      });
      if (visit.kind === 'READ') {
        frontier.markFinished(entry.url, 'AUDITED');
        // 画面の記録（`DiscoveryPageRecord`）は、成果物の形（`DiscoveryReadPageRecord`）のまま入る（形が違えば型の誤り）。
        const record: DiscoveryReadPageRecord = visit.record;
        readPages.push({ url: entry.url, state: 'READ', record, blockedRequests: visit.blockedRequests });
        for (const link of visit.links) {
          if (isExcludedCrawlCandidate(link, crawlAllowedOrigins, authentication)) {
            excluded.add(link);
            continue;
          }
          frontier.discover(link, entry.depth + 1);
        }
      } else {
        frontier.markFinished(entry.url, 'FAILED');
        unreadReasons.set(entry.url, visit.kind === 'SESSION_LOST' ? 'AUTH_SESSION_LOST' : 'NAVIGATION_FAILED');
      }
      if (visit.violation) {
        endReason = 'SAFETY_VIOLATION';
        break;
      }
      if (visit.kind === 'SESSION_LOST') {
        observer.onSessionLost(redactUrlSecrets(visit.url));
        endReason = 'AUTH_SESSION_LOST';
        break;
      }
    }
    // 読まなかった画面（見つけた順）: 読み込みの失敗、深さの上限、止まった後に残った画面、除外に当たるリンク。
    const unread: DiscoveryPageEntry[] = [];
    for (const entry of frontier.entries()) {
      if (entry.state === 'AUDITED') {
        continue;
      }
      const reason: DiscoveryUnreadReason = unreadReasons.get(entry.url)
        ?? (entry.state === 'SKIPPED' ? 'MAX_DEPTH_REACHED' : (endReason === 'COMPLETED' ? 'STOPPED' : endReason));
      unread.push({ url: entry.url, state: 'NOT_READ', reason });
    }
    for (const url of excluded) {
      unread.push({ url, state: 'NOT_READ', reason: 'EXCLUDED' });
    }
    return {
      endReason,
      pages: [...readPages, ...unread.slice(0, MAX_DISCOVERY_UNREAD_PAGE_ENTRIES)],
      omittedUnreadPages: Math.max(0, unread.length - MAX_DISCOVERY_UNREAD_PAGE_ENTRIES),
    };
  } finally {
    await closeBrowserBeforeDeadline(browser);
  }
}

/** 1 画面の発見（ファイルの先頭の 4）。例外を投げない（読めなければ `NAVIGATION_FAILED`）。Context は必ず閉じる（`visitGuardedPage`）。 */
async function visitPage(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  url: NormalizedHttpUrlEvidence,
  options: {
    readonly config: AuditConfig;
    readonly allowedQueryParameters: ReadonlySet<string>;
    readonly linkPolicy: Parameters<typeof discoverLinks>[2];
    readonly classificationPolicy: { readonly allowedOrigins: ReadonlySet<string> };
    readonly authentication: RunAuthentication;
    readonly pageId: Parameters<typeof discoverLinks>[1];
  },
): Promise<PageVisit> {
  const visit = await visitGuardedPage(factory, pacer, url, options, async ({ page, counter, navigation }) => {
    if (navigation.navigationOutcome !== 'OK') {
      return null;
    }
    const record = await discoverPageCandidates(page, { classificationPolicy: options.classificationPolicy, requestCounter: counter });
    let links: readonly NormalizedHttpUrlEvidence[] = [];
    try {
      const discovered = await discoverLinks(page, options.pageId, options.linkPolicy);
      links = internalNavigableUrlsOf(discovered.links);
    } catch {
      // リンクを読めなければ、その画面からは先へ進まない（読み込みを足して読み直さない）。
    }
    return { record, links };
  });
  switch (visit.kind) {
    case 'VISITED':
      return visit.value === null
        ? { kind: 'NAVIGATION_FAILED', violation: visit.violation }
        : { kind: 'READ', ...visit.value, blockedRequests: visit.blockedRequests, violation: visit.violation };
    case 'SESSION_LOST':
      return { kind: 'SESSION_LOST', url: visit.url, violation: visit.violation };
    default:
      return { kind: 'NAVIGATION_FAILED', violation: visit.violation };
  }
}

/**
 * 発見のジョブを実行する（流れはファイルの先頭）。Run の外の失敗（成果物を書けない `ArtifactWriteError`、予期しない例外）は、そのまま reject する
 * （ワーカーの流れが `classifyCliFailure` で `FAILED` にする）。
 */
export async function executeDiscoveryRun(request: DiscoveryRunRequest, observer: DiscoveryRunObserver): Promise<DiscoveryRunOutcome> {
  const { config } = request;
  const outputDirectory = resolve(config.output.directory);
  const writer = new ArtifactWriter({ urlSecretRedaction: true });
  const run = await startWorkerRun(writer, outputDirectory, request.clock, request.now);
  if (run.kind !== 'STARTED') {
    return run;
  }
  const { runId, runDirectory, startedAt } = run;
  observer.onRunStarted({ runId, runDirectory });
  try {
    const crawled = await crawl(request, outputDirectory, observer);
    const document: DiscoveryDocument = {
      schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
      jobId: request.jobId,
      runId,
      startedAt: formatCompactUtcTimestamp(startedAt, DISCOVERY_TIME_SUBJECT),
      finishedAt: formatCompactUtcTimestamp(request.clock(), DISCOVERY_TIME_SUBJECT),
      runStatus: discoveryRunStatusOf(crawled),
      endReason: crawled.endReason,
      maxPages: config.crawl.maxPages,
      pages: crawled.pages,
      omittedUnreadPages: crawled.omittedUnreadPages,
    };
    await writer.writeDiscovery(runDirectory, document);
    return {
      kind: 'RAN',
      runId,
      runDirectory,
      runStatus: document.runStatus,
      exitCode: EXIT_CODES[document.runStatus],
      summary: discoverySummaryOf(document),
    };
  } finally {
    // 保存の状態は書かない（再開の対象にしない）。ハートビートを止めてから、Run のロックを消す。
    await endWorkerRun(writer, run);
  }
}

/**
 * 入口の確かめのジョブ（`ENTRY_CHECK`）の流れ（Task 43 の設計書 3 章、4.3。T43c）。ワーカーの流れ（`audit-worker-session.ts`）が、ログインの段を
 * 通さずに（認証の指定なし）呼ぶ。今の監査の流れ（Run Coordinator）には手を入れない。
 *
 * 1. Run の始めと終わり（`startWorkerRun`・`endWorkerRun`。発見のジョブと同じ。CLI の監査から動いている Run として見える。再開の対象にしない）。
 * 2. Run の前の確かめ（`runPreflight`）。factory は、認証の指定なし（ログインの状態を持たない）の Guard の付いた Passive の Context を作る。失敗したら、
 *    読み込まずに `PREFLIGHT_FAILED`。
 * 3. 止める要求が先に来ていれば、読み込まずに `STOPPED`。
 * 4. 開始の URL（`normalizeUrl`）を、Guard の付いた新しい Context で **1 回だけ** 読み込む（`visitGuardedPage`。PRIMARY の viewport。読み込みの直前に
 *    読み込みの間隔を待つ。読み込み直さない）。
 *    - 許可 Origin の外へ移ろうとした（Guard が止めた main frame の移動。Safety Ledger の `blockedNavigations`）: 移ろうとした Origin だけを記録し、
 *      読まない（`LEFT_ALLOWED_ORIGINS`）。読み込みの後に、ページの JS が外へ移ろうとした場合も同じ（読んだ事実は残し、案は作らない）。
 *    - 読み込みが失敗した: `NAVIGATION_FAILED`。
 *    - 読み込めた: 落ち着いたら凍結し、isolated world で読む（`entry-check-page.ts`）。凍結できない・読めなければ `READ_FAILED`。
 * 5. Safety Ledger の不変条件の違反があれば `SAFETY_VIOLATION`。
 * 6. 成果物: Run のディレクトリの `entry-check.json` を、ArtifactWriter（URL の秘密を伏せる書き手）の `writeEntryCheck` で書く。案は
 *    `entryCheckProposalOf`（`src/control/entry-check.ts`）。スクリーンショットは撮らない。結果は Run の ID、Run のディレクトリ、Run Status、件数の要約。
 * 欄の値は読まない（読み取りの部品が `value` を読まない）。秘密（Cookie、localStorage）は持たない（ログインの状態を持たない Context）。
 */
import { resolve } from 'node:path';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { EXIT_CODES } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import {
  ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION,
  entryCheckLocationOf,
  entryCheckProposalOf,
  entryCheckRunStatusOf,
  entryCheckSummaryOf,
  type EntryCheckDocument,
  type EntryCheckEndReason,
  type EntryCheckFacts,
  type EntryCheckLocation,
  type EntryCheckSummary,
} from '../control/entry-check.js';
import type { RunId, RunStatus } from '../core/contracts.js';
import { wait } from '../core/deadline.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import type { DiscoverySettlePolicy } from '../discovery/settle.js';
import { closeBrowserBeforeDeadline, runPreflight, type BrowserLauncher } from '../orchestration/preflight.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import { isPageLoadLimitReached, pageRequestCountsOf, type PageRequestCounts } from '../safety/passive-request-guard.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import { readEntryPage } from './entry-check-page.js';
import { endWorkerRun, startWorkerRun, visitGuardedPage } from './worker-run-session.js';

/** 日時の名前（誤りの文に使う）。 */
const ENTRY_CHECK_TIME_SUBJECT = 'entry check run time';

/** 入口の確かめの流れの入力（秘密を持たない）。 */
export interface EntryCheckRunRequest {
  /** ワーカーが読んだ設定（`WORKER_CONFIG_OVERRIDES` の headless）。 */
  readonly config: AuditConfig;
  /** 入口の確かめのジョブの ID（成果物に書き、親が照らし合わせる）。 */
  readonly jobId: string;
  readonly launchBrowser: BrowserLauncher;
  readonly clock: () => Date;
  readonly now: () => number;
  /** 止める印（読み込みの前だけ見る。読み込んだ後は、その画面を読み終えてから終わる）。 */
  readonly stopSignal: AbortSignal;
  /** 読み込みの間隔を守る部品（省略すると、設定の `crawl.minNavigationIntervalMs` で作る。テストが包んで渡す）。 */
  readonly navigationPacer?: NavigationPacer | undefined;
  /**
   * TS-c: 読む前の落ち着きの待ちの指定（省略すると `DISCOVERY_SETTLE_POLICY`）。ワーカーの流れは渡さない。テストが、落ち着かない画面の場面を短く
   * 確かめるために渡す（`navigationPacer` と同じ注入の形）。期限そのものは、落ち着きの待ちの単体テストと発見の probe の結合テストが確かめる。
   */
  readonly settlePolicy?: DiscoverySettlePolicy | undefined;
}

/** 観測の口（ワーカーの流れが IPC に写す）。 */
export interface EntryCheckRunObserver {
  /** Run のディレクトリとロックを作った（`RUN_STARTED`）。 */
  readonly onRunStarted: (event: { readonly runId: RunId; readonly runDirectory: string }) => void;
  /**
   * T44g（Task 44 の設計書 P4-5。DEF-143 の残り）: 成果物（`entry-check.json`）を組み立てて書く段に入る（画面を読んだ後に 1 回。`RUN_FINALIZING`。監査・発見・
   * READ の確かめの「Run の終わり」の段と同じ口）。
   */
  readonly onFinalizing?: (() => void) | undefined;
}

/** 入口の確かめの流れの結果（Run のディレクトリは絶対パス）。 */
export type EntryCheckRunOutcome =
  | {
    readonly kind: 'RAN';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
    readonly summary: EntryCheckSummary;
  }
  | { readonly kind: 'RUN_ACTIVE'; readonly activeRunId: RunId | null; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  };

/** 1 回の読み込みの結果（成果物の項目）。 */
interface EntryVisit {
  readonly endReason: EntryCheckEndReason;
  readonly landing: EntryCheckLocation | null;
  readonly facts: EntryCheckFacts | null;
  readonly blockedRequests: number;
  /** DEF-129: Guard が通した main frame の文書の要求の数、T37R2-fix で子の frame の文書の要求の数、DEF-130-fix で文書でない要求の数。 */
  readonly requestCounts: PageRequestCounts;
}

/** DEF-129: 読み込まなかった（か、読み込みの事実のない）結果の要求の数。 */
const NO_REQUESTS: PageRequestCounts = Object.freeze({ documentRequests: 0, childFrameDocumentRequests: 0, subresourceRequests: 0 });

/** 読み込まずに終わった結果。 */
const unvisited = (endReason: EntryCheckEndReason): EntryVisit => ({
  endReason, landing: null, facts: null, blockedRequests: 0, requestCounts: NO_REQUESTS,
});

/** Guard が止めた、main frame の許可 Origin の外への移動の、最初の Origin（なければ `null`）。 */
const blockedExternalLandingOf = (ledger: SafetyLedger, allowedOrigins: readonly string[]): EntryCheckLocation | null => {
  for (const { url } of ledger.snapshot().blockedNavigations) {
    const location = entryCheckLocationOf(url, allowedOrigins);
    if (location !== null && !location.inAllowedOrigins) {
      return location;
    }
  }
  return null;
};

/** 開始の URL を 1 回読み込んで読む（ファイルの先頭の 4・5）。例外を投げない。`settlePolicy` は落ち着きの待ちの指定（省略は本番の指定）。 */
async function visitStart(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  config: AuditConfig,
  settlePolicy: DiscoverySettlePolicy | undefined,
): Promise<EntryVisit> {
  const allowedQueryParameters: ReadonlySet<string> = new Set(config.crawl.allowedQueryParameters);
  const start = normalizeUrl(config.site.startUrl, config.site.startUrl, allowedQueryParameters);
  if (!start.ok) {
    throw new RangeError('the start URL of the configuration cannot be normalized');
  }
  const { allowedOrigins } = config.site;
  const visit = await visitGuardedPage(factory, pacer, start.url, { config, allowedQueryParameters }, async ({ page, ledger, counter, navigation }) => {
    const external = blockedExternalLandingOf(ledger, allowedOrigins);
    if (navigation.navigationOutcome !== 'OK') {
      return external === null
        ? { endReason: 'NAVIGATION_FAILED' as const, landing: null, facts: null }
        : { endReason: 'LEFT_ALLOWED_ORIGINS' as const, landing: external, facts: null };
    }
    const reading = await readEntryPage(page, counter, allowedOrigins, settlePolicy);
    // 読み込みの後に、ページの JS が許可 Origin の外へ移ろうとした（Guard が止めた）なら、移ろうとした Origin を移った先にする（案は作らない）。
    const leftAfterLoad = blockedExternalLandingOf(ledger, allowedOrigins);
    const read = reading.location === null ? null : entryCheckLocationOf(`${reading.location.origin}${reading.location.path}`, allowedOrigins);
    const finalUrl = navigation.finalUrl === null ? null : entryCheckLocationOf(navigation.finalUrl, allowedOrigins);
    const landing = leftAfterLoad ?? read ?? finalUrl;
    if (reading.kind !== 'READ') {
      return { endReason: leftAfterLoad === null ? 'READ_FAILED' as const : 'LEFT_ALLOWED_ORIGINS' as const, landing, facts: null };
    }
    return { endReason: leftAfterLoad === null ? 'READ' as const : 'LEFT_ALLOWED_ORIGINS' as const, landing, facts: reading.facts };
  });
  switch (visit.kind) {
    case 'VISITED': {
      const { landing, facts } = visit.value;
      // DEF-129: ページが始めた読み込み（main frame か、T37R2-fix で子の frame）を Guard が上限で止めた画面は、読み切れない（読んだ事実も案も残さない）。
      // DEF-130-fix: 文書でない要求を上限で止めた画面も同じ。
      const endReason = isPageLoadLimitReached(visit.pageLoad) && visit.value.endReason === 'READ' ? 'READ_FAILED' : visit.value.endReason;
      return {
        endReason: visit.violation ? 'SAFETY_VIOLATION' : endReason,
        landing,
        // 事実は、読んだ（`READ`）ときだけ残す（スキーマの決まり）。
        facts: endReason === 'READ' && !visit.violation ? facts : null,
        blockedRequests: visit.blockedRequests,
        requestCounts: pageRequestCountsOf(visit.pageLoad),
      };
    }
    case 'FAILED':
      return {
        endReason: visit.violation ? 'SAFETY_VIOLATION' : 'READ_FAILED', landing: null, facts: null, blockedRequests: visit.blockedRequests,
        requestCounts: NO_REQUESTS,
      };
    case 'NOT_OPENED':
      return unvisited(visit.violation ? 'SAFETY_VIOLATION' : 'NAVIGATION_FAILED');
    case 'SESSION_LOST':
      // 認証の指定を渡さないので起きない（fail-closed に、読まなかったとする）。
      return {
        endReason: visit.violation ? 'SAFETY_VIOLATION' : 'READ_FAILED', landing: null, facts: null, blockedRequests: visit.blockedRequests,
        requestCounts: NO_REQUESTS,
      };
  }
}

/** Run の前の確かめから、読み込みまで（ファイルの先頭の 2〜5）。ブラウザは必ず閉じる。 */
async function check(request: EntryCheckRunRequest, outputDirectory: string): Promise<EntryVisit> {
  const { config, now } = request;
  const pacer = request.navigationPacer ?? createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now, sleep: wait });
  const preflight = await runPreflight({
    config,
    launchBrowser: request.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    outputDirectory,
    contextFactoryOptions: { navigationPacer: pacer },
  });
  if (!preflight.ok) {
    return unvisited('PREFLIGHT_FAILED');
  }
  const { browser, factory } = preflight;
  try {
    if (request.stopSignal.aborted) {
      return unvisited('STOPPED');
    }
    return await visitStart(factory, pacer, config, request.settlePolicy);
  } finally {
    await closeBrowserBeforeDeadline(browser);
  }
}

/**
 * 入口の確かめのジョブを実行する（流れはファイルの先頭）。Run の外の失敗（成果物を書けない `ArtifactWriteError`、予期しない例外）は、そのまま
 * reject する（ワーカーの流れが `classifyCliFailure` で `FAILED` にする）。
 */
export async function executeEntryCheckRun(request: EntryCheckRunRequest, observer: EntryCheckRunObserver): Promise<EntryCheckRunOutcome> {
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
    const visit = await check(request, outputDirectory);
    // T44g（P4-5）: ここから成果物を組み立てて書く段。入る前に 1 回だけ知らせる（発見・READ の確かめと同じ）。
    observer.onFinalizing?.();
    const runStatus = entryCheckRunStatusOf(visit.endReason);
    const document: EntryCheckDocument = {
      schemaVersion: ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION,
      jobId: request.jobId,
      runId,
      startedAt: formatCompactUtcTimestamp(startedAt, ENTRY_CHECK_TIME_SUBJECT),
      finishedAt: formatCompactUtcTimestamp(request.clock(), ENTRY_CHECK_TIME_SUBJECT),
      runStatus,
      endReason: visit.endReason,
      landing: visit.landing,
      facts: visit.facts,
      proposal: visit.landing === null || visit.facts === null ? null : entryCheckProposalOf(visit.landing, visit.facts),
      blockedRequests: visit.blockedRequests,
      ...visit.requestCounts,
    };
    await writer.writeEntryCheck(runDirectory, document);
    return { kind: 'RAN', runId, runDirectory, runStatus, exitCode: EXIT_CODES[runStatus], summary: entryCheckSummaryOf(document) };
  } finally {
    await endWorkerRun(writer, run);
  }
}

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
 * T37a（Task 37 の設計書 3.1）: 認証の指定に監査の段の口があれば（`jobContextFactoryOptions`。登録した読み取りの手続きの呼び出しを通す `REGISTERED`）:
 * - 1 画面ごとに、始める前に、承認したサービスの Origin への要求の上限に届いたか（`isServiceRequestLimitReached`。Run Coordinator と同じ判定）を
 *   確かめ、届いていれば残りの画面を読まずに終える（終わり方 `SERVICE_REQUEST_LIMIT_REACHED`。Run Status は `PARTIAL`）。
 * - 読んだ後に、ログインの状態の鍵がなくなっていれば、セッションの切れと同じ終わり方にする（その画面は捨てて `AUTH_SESSION_LOST` の読まなかった
 *   画面にし、詳しい理由 `endReasonDetail` を `session-key` にする）。
 * - その画面の Context で上限で断った要求か 401 があれば、画面と候補に `SERVICE_READ_REFUSED` を付ける（索引が候補を `MISSING` にしない）。
 * - 成果物に監査の段の数（`authentication`）を書き、件数の要約にも同じ値を載せる。
 * T37c（Task 37 の設計書 3.2）: 4 の 1 画面の流れの最後（候補の分類と `discoverLinks` の後）に、送らずに観察する probe（`src/interaction/submission-probe.ts`）を
 * 行う。factory がその Context に観察の口を渡していなければ行わない。凍結した同じ Context で押し、読み込み直さない（1 画面 1 読み込みのまま）。ログインの画面
 * （認証の設定のセッションの切れの path）と監査の段の除外の画面は、巡回の候補の除外と同じ判定（`isExcludedCrawlCandidate`）で押さない。結果は、押した候補の
 * 任意の項目 `submissionProbe` に入る。
 * DEF-136（設計書 `2026-10-18-beaksight-job-site-unavailability-design.md`）: 1 画面の読み込みごとに、読み取りの監査と同じ不調の判定をかける
 * （`job-site-availability.ts` の `pageLoadVerdictOf`。判定の順は、セッションの切れ → 不調 → 読み込みの失敗 → エラーの状態）。不調なら、その画面の結果を
 * 捨て、読み取りの監査の最初の待ちだけ待って同じ画面を 1 回だけ確かめ直す（`createJobSiteRecheck`。待つ間は知らせ `NOTICE` を出し、止める印で
 * 確かめ直さずに止める）。まだ不調なら止める（終わり方 `SITE_UNAVAILABLE`。残りの画面は読まない）。通ったら続け、読み込みの間隔を 2 倍にする。
 * 4xx・5xx（不調を除く）の画面からは、候補もリンクも拾わない（読まなかった画面 `HTTP_ERROR_STATUS`。次の画面へ進む）。
 * DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md`）: 監査の段の口があれば、承認したサービスの Origin への要求の 1 分あたりの上限で、
 * 次の画面の読み込みの前に待つ（`serviceRequestPacedNavigationPacer`。Run Coordinator と共用する部品。待つたびに知らせ `NOTICE` を出す）。待った回数と時間は
 * 成果物の `authentication` に残る。1 回の Run あたりの上限は今どおり止める。
 * DEF-144: Safety Ledger の不変条件の違反で止まったら、違反の中身（`src/safety/job-safety-violation.ts`。種類と文と結びつく要求、最初に見た段、画面の path、
 * probe の押下の中なら押した候補）を成果物の `safetyViolation` に書き、件数の要約（IPC）にも同じ値を載せる。
 */
import { resolve } from 'node:path';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { EXIT_CODES } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import { auditSendPolicyOf } from '../core/audit-send-policy.js';
import type { RunId, RunStatus, SessionKeyLostDetail } from '../core/contracts.js';
import { wait } from '../core/deadline.js';
import type { NormalizedHttpUrlEvidence, SessionLossEvidence } from '../core/evidence-types.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { discoverLinks } from '../crawl/discover-links.js';
import { internalNavigableUrlsOf } from '../crawl/internal-navigable-links.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { discoverPageCandidates } from '../discovery/discover-page.js';
import type { DiscoverySettlePolicy } from '../discovery/settle.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  MAX_DISCOVERY_UNREAD_PAGE_ENTRIES,
  discoveryRunStatusOf,
  discoverySummaryOf,
  externalSchemeProbesOf,
  pageLoadIncompleteReasonsOf,
  pressLimitProbesOf,
  withIncompleteReason,
  withServiceReadRefused,
  type DiscoveryDocument,
  type DiscoveryEndReason,
  type DiscoveryPageEntry,
  type DiscoveryReadPageRecord,
  type DiscoverySummary,
  type DiscoveryUnreadReason,
} from '../discovery/discovery-result.js';
import {
  isAuditStageReadObstructed,
  isServiceRequestLimitReached,
  intervalTrackingNavigationPacer,
  jobContextFactoryOptions,
  recordRunStageCarry,
  runAuthenticationSummaryOf,
  serviceRequestPacedNavigationPacer,
  type AuditStageRunState,
  type RunStageCarry,
} from '../orchestration/audit-stage-run.js';
import { auditSendOptionsOf } from '../orchestration/audit-send-options.js';
import { isExcludedCrawlCandidate, type RunAuthentication } from '../orchestration/authenticated-run.js';
import { probeDiscoveredSubmissions } from '../interaction/submission-probe.js';
import { CrawlFrontier } from '../orchestration/crawl-frontier.js';
import { IdAllocator } from '../orchestration/id-allocator.js';
import { closeBrowserBeforeDeadline, runPreflight, type BrowserLauncher } from '../orchestration/preflight.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import { pageRequestCountsOf, type PageRequestCounts } from '../safety/passive-request-guard.js';
import {
  CONTEXT_CLOSED_BY_GUARD_PROBE_REASON as CONTEXT_CLOSED_BY_GUARD_REASON,
  MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE,
  MAX_SUBMISSION_PROBE_RELOADS_PER_PAGE,
  externalSchemeSubmissionProbeOf,
  notObservedSubmissionProbeOf,
  withSubmissionProbes,
} from '../discovery/submission-probe-contracts.js';
import { probeViolationContinuationOf, type JobSafetyViolation } from '../safety/job-safety-violation.js';
import { redactUrlSecrets } from '../safety/redact.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import { JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS, createJobSiteRecheck, pageLoadVerdictOf, type JobRunNotice } from './job-site-availability.js';
import { endWorkerRun, hasViolation, startWorkerRun, visitGuardedPage } from './worker-run-session.js';

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
  /**
   * T37c: 送らずに観察する probe の、押した後に静まるまで待つ時間（ms。省略すると `SUBMISSION_PROBE_QUIET_WAIT_MS`）。ワーカーの流れは渡さない。テストが、
   * 押す回数の多い組み合わせを短く確かめるために渡す（`navigationPacer` と同じ注入の形）。
   */
  readonly submissionProbeQuietWaitMs?: number | undefined;
  /**
   * TS-c: 発見の前の落ち着きの待ちの指定（省略すると `DISCOVERY_SETTLE_POLICY`）。ワーカーの流れは渡さない。テストが、落ち着かない画面の場面を短く
   * 確かめるために渡す（`navigationPacer` と同じ注入の形）。期限そのものは、落ち着きの待ちの単体テストと発見の probe の結合テストが確かめる。
   */
  readonly settlePolicy?: DiscoverySettlePolicy | undefined;
  /**
   * DEF-136: サイトの不調の確かめ直しの前の待ち（ms。省略すると `JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS`）。ワーカーの流れは渡さない。テストが短くする。
   */
  readonly siteUnavailableRecheckDelayMs?: number | undefined;
  /**
   * DEF-141: 待つ関数（省略すると本番の待ち `wait`）。ワーカーの流れは渡さない。読み込みの間隔の部品を作るときと、承認したサービスの Origin への要求の
   * 1 分あたりの上限の待ちに使う。テストが `now` と組にして、待ちを短くする。
   */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の持ち越し（ワーカーだけが渡す。メモリの中だけ）。監査の段の上限の部品は
   * 前の段の 1 分の窓から始め、Browser を閉じた後に factory の最新の状態と窓を `record` に渡す（`recordRunStageCarry`）。省略すると今のまま。
   */
  readonly stageCarry?: RunStageCarry | undefined;
}

/** 観測の口（ワーカーの流れが IPC に写す）。 */
export interface DiscoveryRunObserver {
  /** Run のディレクトリとロックを作った（`RUN_STARTED`）。 */
  readonly onRunStarted: (event: { readonly runId: RunId; readonly runDirectory: string }) => void;
  /**
   * セッションの切れを見つけた（`AUTH_STATE` の `SESSION_LOST`。URL は伏せ字を通した値）。DEF-138: `sessionLoss` はその証拠（値を持たない。組み立てられ
   * なければ `null`）。
   */
  readonly onSessionLost: (url: string, sessionLoss: SessionLossEvidence | null) => void;
  /**
   * DEF-136: サイトの不調の確かめ直しを待つ・通って減速した（`NOTICE`。URL は伏せ字を通した値）。DEF-141: 承認したサービスの Origin への要求の 1 分あたりの
   * 上限で、次の読み込みの前に待つ（`SERVICE_REQUEST_PACING_WAIT`。数だけ）。
   */
  readonly onNotice?: ((notice: JobRunNotice) => void) | undefined;
  /**
   * DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断）: 成果物（`discovery.json`）を組み立てて書く段に入る（巡回の後に
   * 1 回。`RUN_FINALIZING`。監査の「Run の終わり」の段と同じ口）。
   */
  readonly onFinalizing?: (() => void) | undefined;
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
    /** FM2d: 終わり方（成果物の `endReason`。まとめて実行の次の段へ進むかの判定に、ワーカーが理由のコードへ写す。IPC には写したコードだけを載せる）。 */
    readonly endReason: DiscoveryEndReason;
  }
  | { readonly kind: 'RUN_ACTIVE'; readonly activeRunId: RunId | null; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  };

/** DEF-144: 1 画面の probe の押下の事実（違反を起こした押下の候補の位置と、押す回数を使った押下の数）。 */
interface PageProbeFacts {
  /** probe の段で違反を最初に見たときに押していた候補の位置（`record.candidates` の添字）。違反がない・probe の段の前からあったときは `null`。 */
  readonly culprit: number | null;
  /** 押す回数を使った押下の数（`onPress` の回数）。 */
  readonly pressed: number;
}

/** DEF-144: 違反の中身（その画面の Context に違反がなければ `null`）。どの結果も持つ。 */
interface PageVisitSafety {
  readonly violation: boolean;
  readonly safetyViolation: JobSafetyViolation | null;
}

/** 1 画面の結果。 */
type PageVisit =
  | ({
    readonly kind: 'READ';
    readonly record: DiscoveryReadPageRecord;
    readonly links: readonly NormalizedHttpUrlEvidence[];
    readonly blockedRequests: number;
    /** DEF-129: Guard が通した main frame の文書の要求の数、T37R2-fix で子の frame の文書の要求の数、DEF-130-fix で文書でない要求の数。 */
    readonly requestCounts: PageRequestCounts;
    readonly probe: PageProbeFacts;
  } & PageVisitSafety)
  | ({ readonly kind: 'NAVIGATION_FAILED' } & PageVisitSafety)
  /** DEF-136: 画面の文書の応答が 4xx・5xx（不調を除く）。候補もリンクも拾わない。 */
  | ({ readonly kind: 'HTTP_ERROR_STATUS' } & PageVisitSafety)
  /** DEF-136: サイトの不調（読み取りの監査と同じ判定）。その画面の結果は捨てる。 */
  | ({ readonly kind: 'SITE_UNAVAILABLE' } & PageVisitSafety)
  | ({
    readonly kind: 'SESSION_LOST';
    readonly url: string;
    readonly detail: SessionKeyLostDetail | null;
    /** DEF-138: セッションの切れの証拠（組み立てられなければ `null`）。 */
    readonly sessionLoss: SessionLossEvidence | null;
  } & PageVisitSafety);

/** DEF-144: 読み込み直した画面で押す指定（読み込み直しの前の記録、残りの候補、残りの押す回数）。 */
interface PageReprobe {
  readonly record: DiscoveryReadPageRecord;
  readonly candidates: ReadonlySet<number>;
  readonly maxPresses: number;
}

/** 巡回の結果。 */
interface CrawlResult {
  readonly endReason: DiscoveryEndReason;
  readonly pages: readonly DiscoveryPageEntry[];
  readonly omittedUnreadPages: number;
  /** 終わり方の詳しい理由（T37a。鍵の消失によるセッションの切れのときだけ）。 */
  readonly endReasonDetail: SessionKeyLostDetail | null;
  /** ジョブの監査の段の状態（T37a。口がなければ `null`）。 */
  readonly auditStage: AuditStageRunState | null;
  /** DEF-138: セッションの切れで止まったときの証拠（なければ `null`）。 */
  readonly sessionLoss: SessionLossEvidence | null;
  /** DEF-144: 違反で止まったときの違反の中身（なければ `null`）。 */
  readonly safetyViolation: JobSafetyViolation | null;
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
  const sleep = request.sleep ?? wait;
  // FM2R の C-1: 上げた最小の間隔を覚える（まとめて実行の次の段へ持ち越す）。
  const intervalTracking = intervalTrackingNavigationPacer(
    request.navigationPacer ?? createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now, sleep }),
    config.crawl.minNavigationIntervalMs,
  );
  const intervalPacer = intervalTracking.pacer;
  const navigationCarry = (): Parameters<typeof recordRunStageCarry>[3] => ({ pacer: intervalPacer, minIntervalMs: intervalTracking.minIntervalMs(), now });
  // T35R2-fix（T35R2 の C-1）: 監査の段の口があれば、Run と同じ部品で作った上限の部品も渡す。T37a: 登録した読み取りの手続きの呼び出しを通し、作った
  // 状態で 1 画面ごとに上限と鍵の消失を確かめる。
  // FM2d: まとめて実行の段なら、前の段の 1 分の窓から始める。
  const { factoryOptions, state: auditStage } = jobContextFactoryOptions(
    authentication, now, 'REGISTERED', request.stageCarry?.serviceRequestWindowMs ?? [],
  );
  // DEF-141: 監査の段の口があれば、承認したサービスの Origin への要求の 1 分あたりの上限で、次の画面の読み込みの前に待つ（Run Coordinator と共用する部品。
  // 待つたびに知らせる）。口がなければ、今の pacer のまま。
  const pacer = serviceRequestPacedNavigationPacer(intervalPacer, auditStage, sleep, (notice) => observer.onNotice?.(notice));
  const preflight = await runPreflight({
    config,
    launchBrowser: request.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    outputDirectory,
    // AS-b: 監査の段の送信の扱いが `PASS_EXCEPT_DELETE` のときだけ、口を渡す（承認したサービスの Origin はプロファイルのもの）。
    contextFactoryOptions: { ...factoryOptions, ...auditSendOptionsOf(config, authentication.approvedTestOrigins), navigationPacer: pacer },
  });
  if (!preflight.ok) {
    // FM2d: factory がないので、状態は持ち越さない（次の段は始まらない）。
    recordRunStageCarry(request.stageCarry, null, auditStage, navigationCarry());
    return {
      endReason: 'PREFLIGHT_FAILED',
      pages: [{ url: start.url, state: 'NOT_READ', reason: 'PREFLIGHT_FAILED' }],
      omittedUnreadPages: 0,
      endReasonDetail: null,
      auditStage,
      sessionLoss: null,
      safetyViolation: null,
    };
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
    let endReasonDetail: SessionKeyLostDetail | null = null;
    let sessionLoss: SessionLossEvidence | null = null;
    // DEF-144: 止まるきっかけの違反の中身（違反で止まった画面の Context のもの）。
    let stopViolation: JobSafetyViolation | null = null;
    // DEF-136: サイトの不調の確かめ直し（読み取りの監査の最初の待ちだけ待って 1 回。通ったら読み込みの間隔を 2 倍。知らせの URL は伏せ字を通す）。
    const siteRecheck = createJobSiteRecheck({
      delayMs: request.siteUnavailableRecheckDelayMs ?? JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS,
      stopSignal,
      pacer,
      configuredMinIntervalMs: config.crawl.minNavigationIntervalMs,
      onNotice: (notice) => observer.onNotice?.(notice.kind === 'SITE_UNAVAILABLE_RECHECK' ? { ...notice, url: redactUrlSecrets(notice.url) } : notice),
    });
    for (let entry = frontier.next(); entry !== undefined; entry = frontier.next()) {
      // T37a: 承認したサービスの Origin への要求の上限に届いたら、次の画面を始めない（Run Coordinator と同じ判定。上限を、止める要求と時間と画面の数より
      // 先に確かめる）。
      if (isServiceRequestLimitReached(auditStage)) {
        endReason = 'SERVICE_REQUEST_LIMIT_REACHED';
      } else if (stopSignal.aborted) {
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
      const pageOptions = {
        config, allowedQueryParameters, linkPolicy, classificationPolicy, authentication, pageId: entry.pageId, auditStage,
        submissionProbeQuietWaitMs: request.submissionProbeQuietWaitMs, settlePolicy: request.settlePolicy,
      };
      // DEF-136: 不調なら、その画面の結果を捨て、待ってから同じ画面を 1 回だけ確かめ直す（`siteRecheck`）。
      const rechecked = await siteRecheck.visit(entry.url, () => visitPage(factory, pacer, entry.url, pageOptions),
        (result) => result.kind === 'SITE_UNAVAILABLE' && !result.violation);
      let visit: PageVisit = rechecked.value;
      // DEF-144: probe の押下で外部スキームへの移動の違反が起きた画面は、発見を止めずに続ける（違反の中身を画面の記録に残し、1 回だけ読み込み直して
      // 残りの候補を押す）。ほかの種類の違反は今どおり止める。
      let continued: ContinuedPage | null = null;
      if (rechecked.kind !== 'STOPPED' && continuesAfterViolation(visit)) {
        continued = await continueAfterExternalScheme(visit, (reprobe) => visitPage(factory, pacer, entry.url, { ...pageOptions, reprobe }));
        visit = continued.stop === null || continued.stop.kind === 'SESSION_LOST'
          ? continued.visit
          : { ...continued.visit, violation: true, safetyViolation: continued.stop.safetyViolation };
      }
      if (rechecked.kind === 'STOPPED') {
        // 待つ間に止める印が来た: 確かめ直さずに止める（その画面は読まなかった）。
        frontier.markFinished(entry.url, 'FAILED');
        unreadReasons.set(entry.url, 'STOPPED');
        endReason = 'STOPPED';
        break;
      }
      if (visit.kind === 'READ') {
        frontier.markFinished(entry.url, 'AUDITED');
        // 画面の記録は、成果物の形（`DiscoveryReadPageRecord`。発見の入口が返す型と同じ 1 つの型。CC-070 (a)）のまま入る。
        const record: DiscoveryReadPageRecord = visit.record;
        readPages.push({
          url: entry.url,
          state: 'READ',
          record,
          blockedRequests: visit.blockedRequests,
          ...visit.requestCounts,
          // DEF-144: 発見を続けた違反の中身と、読み込み直したこと（あるときだけ）。
          ...(continued === null ? {} : { safetyViolations: continued.safetyViolations }),
          ...(continued?.reloaded === true ? { reloadedForProbe: true } : {}),
        });
        for (const link of visit.links) {
          if (isExcludedCrawlCandidate(link, crawlAllowedOrigins, authentication)) {
            excluded.add(link);
            continue;
          }
          frontier.discover(link, entry.depth + 1);
        }
      } else {
        frontier.markFinished(entry.url, 'FAILED');
        unreadReasons.set(entry.url, visit.kind === 'SESSION_LOST' ? 'AUTH_SESSION_LOST' : visit.kind);
      }
      if (visit.violation) {
        stopViolation = visit.safetyViolation;
        endReason = 'SAFETY_VIOLATION';
        break;
      }
      // DEF-144: 読み込み直しでセッションが切れたら、セッションの切れと同じく止める（その画面は、読み込み直しの前に読めた分を残す）。
      if (continued?.stop?.kind === 'SESSION_LOST') {
        const lost = continued.stop;
        observer.onSessionLost(redactUrlSecrets(lost.url), lost.sessionLoss);
        endReason = 'AUTH_SESSION_LOST';
        endReasonDetail = lost.detail;
        sessionLoss = lost.sessionLoss;
        break;
      }
      // DEF-136: 確かめ直しでも不調なら、ジョブを止める（残りの画面は読まない）。
      if (rechecked.kind === 'SITE_UNAVAILABLE') {
        endReason = 'SITE_UNAVAILABLE';
        break;
      }
      if (visit.kind === 'SESSION_LOST') {
        observer.onSessionLost(redactUrlSecrets(visit.url), visit.sessionLoss);
        endReason = 'AUTH_SESSION_LOST';
        endReasonDetail = visit.detail;
        sessionLoss = visit.sessionLoss;
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
      endReasonDetail,
      auditStage,
      sessionLoss,
      // DEF-144: 違反で止まったときだけ（ほかの終わり方では、違反の中身を書かない）。
      safetyViolation: endReason === 'SAFETY_VIOLATION' ? stopViolation : null,
    };
  } finally {
    await closeBrowserBeforeDeadline(browser);
    // FM2d: Browser を閉じた後に、factory の最新の状態と窓を持ち越しの口へ渡す（メモリの中だけ）。
    recordRunStageCarry(request.stageCarry, factory, auditStage, navigationCarry());
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
    readonly auditStage: AuditStageRunState | null;
    readonly submissionProbeQuietWaitMs: number | undefined;
    /** TS-c: 落ち着きの待ちの指定（`DiscoveryRunRequest` の `settlePolicy`。省略は本番の指定）。 */
    readonly settlePolicy: DiscoverySettlePolicy | undefined;
    /**
     * DEF-144: 読み込み直した画面で押す指定（あるときは、読み込み直しの前の記録の残りの候補だけを、残りの回数まで押す。リンクは読まない）。省略すると、
     * 今までどおりの 1 画面の発見。
     */
    readonly reprobe?: PageReprobe | undefined;
  },
): Promise<PageVisit> {
  // DEF-144: この画面の Context の違反の中身（閉じた後に `visitGuardedPage` が渡す）と、probe の押下の事実。
  const safety: { violation: JobSafetyViolation | null } = { violation: null };
  const probe: { culprit: number | null; current: number | null; pressed: number } = { culprit: null, current: null, pressed: 0 };
  const guardedOptions = { ...options, onSafetyViolation: (violation: JobSafetyViolation): void => { safety.violation ??= violation; } };
  const visit = await visitGuardedPage(factory, pacer, url, guardedOptions, async ({
    page, ledger, counter, navigation, enterSubmissionProbe, stopIfSessionLostAfterSettling,
  }) => {
    // DEF-136: 判定の順は、セッションの切れ（読み込みの部品が先に見分ける）→ 不調 → 読み込みの失敗 → エラーの状態。不調とエラーの状態の画面からは、
    // 候補もリンクも拾わない。
    const verdict = pageLoadVerdictOf(navigation);
    if (verdict.kind !== 'READABLE') {
      return verdict.kind;
    }
    // DEF-144: 読み込み直した画面でも、発見の入口で読む（凍結をかける。probe は凍結の段でだけ押す）。押す対象は、読み込み直しの前の記録の残りの候補。
    const discovered = await discoverPageCandidates(page, {
      classificationPolicy: options.classificationPolicy, requestCounter: counter, settlePolicy: options.settlePolicy,
    });
    // DF-3（DEF-167）: 落ち着きを待った後に、セッションの切れを確かめる（当たれば、リンクを拾わず、probe を押さずに止める。その画面はセッションの切れ）。
    stopIfSessionLostAfterSettling();
    const base = options.reprobe?.record ?? discovered;
    let links: readonly NormalizedHttpUrlEvidence[] = [];
    if (options.reprobe === undefined) {
      try {
        const found = await discoverLinks(page, options.pageId, options.linkPolicy);
        links = internalNavigableUrlsOf(found.links);
      } catch {
        // リンクを読めなければ、その画面からは先へ進まない（読み込みを足して読み直さない）。
      }
    }
    // T37c: 1 画面の流れの最後に、送らずに観察する probe（押すと SPA の router が URL を変えうるので、リンクの抽出の後）。観察の口がない Context では
    // 行わない。読み込み直しはしない。
    const observation = factory.submissionObservationOf(page.context());
    // T37R-fix-B（T37R の I-1）: 押す前に、閉じるときに次の Context へ渡す状態を読んでおく（押下でページが書き換えた localStorage・Cookie を受け継がず、
    // 鍵の消失もこの状態で判定する）。probe を行わない Context は今のまま（閉じるときに読む）。
    // DEF-144: probe の段の前からの違反は、押した候補に結びつけない（発見を続ける判定にも使わない）。
    const violationBeforeProbe = hasViolation(ledger);
    /** それまでに違反があれば、今押している候補に結びつける（最初の 1 回だけ）。 */
    const settleCulprit = (): void => {
      if (!violationBeforeProbe && probe.culprit === null && probe.current !== null && hasViolation(ledger)) {
        probe.culprit = probe.current;
      }
    };
    if (observation !== null) {
      await factory.pinAuthenticatedStateBeforeProbe(page.context());
      // DEF-144: ここから probe の段（安全の違反を、この段と、押した候補に結びつける）。
      enterSubmissionProbe(null);
    }
    const record = observation === null ? base : await probeDiscoveredSubmissions(page, observation, base, {
      targetPolicy: {
        allowedOrigins: options.classificationPolicy.allowedOrigins,
        // ログインの画面（セッションの切れの path）と、監査の段の除外に当たる画面は押さない（巡回の候補の除外と同じ判定。owner の関数を使う）。
        isExcludedPage: (location) => isExcludedCrawlCandidate(`${location.origin}${location.path}`, options.linkPolicy.allowedOrigins, options.authentication),
      },
      quietWaitMs: options.submissionProbeQuietWaitMs,
      // DEF-144: 押す候補（送信ボタンの語と識別の digest。値を持たない）。前の押下の後の違反は、前の押下に結びつける。
      onPress: (candidateIndex) => {
        settleCulprit();
        probe.current = candidateIndex;
        probe.pressed += 1;
        const candidate = base.candidates[candidateIndex];
        enterSubmissionProbe(candidate === undefined ? null : { submitterWords: candidate.submitterWords, identityDigest: candidate.identityDigest });
      },
      onlyCandidates: options.reprobe?.candidates,
      maxPresses: options.reprobe?.maxPresses,
    });
    settleCulprit();
    return { record, links };
  });
  const safetyOf = (violation: boolean): PageVisitSafety => ({ violation, safetyViolation: violation ? safety.violation : null });
  switch (visit.kind) {
    case 'VISITED':
      if (visit.value === 'NAVIGATION_FAILED' || visit.value === 'HTTP_ERROR_STATUS' || visit.value === 'SITE_UNAVAILABLE') {
        return { kind: visit.value, ...safetyOf(visit.violation) };
      }
      // T37a: その画面の Context で上限で断った要求か 401 があれば、画面と候補に印を付ける（読み切れなかった画面に数える）。T37R-fix-B（T37R の M-2）:
      // 判定は READ の確かめと共有する 1 か所（`isAuditStageReadObstructed`。止めた登録した手続きの呼び出しと、サービスの Origin への読み取りでない要求も
      // 数える。T37R-fix-B2: 許可 Origin への `fetch`・`xhr` を止めたことは数えない）。
      {
        const refusedRecord = isAuditStageReadObstructed(visit.auditStageObservation) ? withServiceReadRefused(visit.value.record) : visit.value.record;
        // DEF-129: ページが始めた読み込み（main frame か、T37R2-fix で子の frame）を Guard が上限で止めた画面は、読み切れない
        // （`INCOMPLETE_PAGE_NAVIGATION_LIMIT`）。DEF-130-fix: 文書でない要求を上限で止めた画面も（`INCOMPLETE_PAGE_SUBRESOURCE_LIMIT`）。
        return {
          kind: 'READ',
          record: pageLoadIncompleteReasonsOf(visit.pageLoad).reduce(withIncompleteReason, refusedRecord),
          links: visit.value.links,
          blockedRequests: visit.blockedRequests,
          requestCounts: pageRequestCountsOf(visit.pageLoad),
          probe: { culprit: probe.culprit, pressed: probe.pressed },
          ...safetyOf(visit.violation),
        };
      }
    case 'SESSION_LOST':
      return { kind: 'SESSION_LOST', url: visit.url, detail: visit.detail, sessionLoss: visit.sessionLoss, ...safetyOf(visit.violation) };
    default:
      return { kind: 'NAVIGATION_FAILED', ...safetyOf(visit.violation) };
  }
}

/**
 * DEF-144・DEF-145: 発見を続けてよい、probe の押下の違反か（違反の形の判定 `probeViolationContinuationOf` と、押した候補が分かること）。外部スキームへの
 * 移動（DEF-144）と、押下で始まった読み取りの移動の取り消し（DEF-145）。
 */
const continuesAfterViolation = (visit: PageVisit): visit is Extract<PageVisit, { readonly kind: 'READ' }> & { readonly safetyViolation: JobSafetyViolation } =>
  visit.kind === 'READ' && visit.violation && visit.safetyViolation !== null && visit.probe.culprit !== null
  && probeViolationContinuationOf(visit.safetyViolation) !== null;

/**
 * 違反を起こした候補の結果を当てた記録。外部スキームへの移動は `EXTERNAL_SCHEME`（DEF-144）、読み取りの移動の取り消しは `PAGE_CHANGED`（DEF-145。押す前に
 * 入れた欄の数と識別は、押下の記録のまま）。
 */
const withViolationCulprit = (record: DiscoveryReadPageRecord, visit: PageVisit & { readonly safetyViolation: JobSafetyViolation }): DiscoveryReadPageRecord => {
  const culprit = visit.kind === 'READ' ? visit.probe.culprit : null;
  if (culprit === null) {
    return record;
  }
  const pressed = record.candidates[culprit]?.submissionProbe;
  const probe = probeViolationContinuationOf(visit.safetyViolation) === 'EXTERNAL_SCHEME'
    ? externalSchemeSubmissionProbeOf()
    : notObservedSubmissionProbeOf(
      'PAGE_CHANGED',
      { filledFieldCount: pressed?.filledFieldCount ?? 0, skippedFieldCount: pressed?.skippedFieldCount ?? 0 },
      pressed?.inputFields ?? [],
    );
  return withSubmissionProbes(record, new Map([[culprit, probe]]));
};

/** DEF-144: 押せなかった残りの候補（Guard が Context を閉じたので押せなかった候補）の位置。 */
const closedByGuardCandidatesOf = (record: DiscoveryReadPageRecord): ReadonlySet<number> => new Set(record.candidates.flatMap((candidate, index) =>
  (candidate.submissionProbe?.reason === CONTEXT_CLOSED_BY_GUARD_REASON ? [index] : [])));

/** DEF-144: 2 回の読み込みの数を足す。 */
const sumRequestCounts = (left: PageRequestCounts, right: PageRequestCounts): PageRequestCounts => ({
  documentRequests: left.documentRequests + right.documentRequests,
  childFrameDocumentRequests: left.childFrameDocumentRequests + right.childFrameDocumentRequests,
  subresourceRequests: left.subresourceRequests + right.subresourceRequests,
});

/** DEF-144: probe の外部スキームの違反の後に、その画面を続けた結果。 */
interface ContinuedPage {
  /** 画面の結果（記録は、違反を起こした候補を `EXTERNAL_SCHEME` にし、読み込み直した後の押下の結果を入れたもの）。 */
  readonly visit: Extract<PageVisit, { readonly kind: 'READ' }>;
  /** 画面の記録に残す違反の中身（起きた順）。 */
  readonly safetyViolations: readonly JobSafetyViolation[];
  readonly reloaded: boolean;
  /** 読み込み直しで、止めるべきこと（ほかの種類の違反、セッションの切れ）が起きた（なければ `null`）。 */
  readonly stop: Extract<PageVisit, { readonly kind: 'SESSION_LOST' }> | { readonly kind: 'VIOLATION'; readonly safetyViolation: JobSafetyViolation | null } | null;
}

/**
 * DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.2）: probe の押下で外部スキームへの移動の違反が起きた画面を続ける。違反を起こした
 * 候補を `EXTERNAL_SCHEME` にし、押せなかった残りの候補があり、押す回数が残っていれば、新しい Context でその画面を 1 回だけ読み込み直して（読み込みの間隔と
 * サービスへの要求の待ちは `visitGuardedPage` の pacer が守る）、残りの候補を残りの回数まで押す。読み込み直しでも同じ違反が起きたら、その候補も
 * `EXTERNAL_SCHEME` にし、残りは押さない（`CONTEXT_CLOSED_BY_GUARD` のまま）。ほかの種類の違反とセッションの切れは、止めるべきこととして返す。
 * DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.1）: 押下で始まった読み取り（GET・HEAD）の移動が取り消された違反
 * （`HTTP_MAIN_FRAME_DELIVERY_FAILED`）も、同じ部品で続ける（その候補は `PAGE_CHANGED`）。
 */
async function continueAfterExternalScheme(
  first: Extract<PageVisit, { readonly kind: 'READ' }> & { readonly safetyViolation: JobSafetyViolation },
  reload: (reprobe: PageReprobe) => Promise<PageVisit>,
): Promise<ContinuedPage> {
  const marked = withViolationCulprit(first.record, first);
  const remaining = closedByGuardCandidatesOf(marked);
  const maxPresses = MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE - first.probe.pressed;
  const unchanged: ContinuedPage = { visit: { ...first, record: marked, violation: false }, safetyViolations: [first.safetyViolation], reloaded: false, stop: null };
  if (remaining.size === 0 || maxPresses <= 0 || MAX_SUBMISSION_PROBE_RELOADS_PER_PAGE < 1) {
    return unchanged;
  }
  const second = await reload({ record: marked, candidates: remaining, maxPresses });
  const counted = second.kind === 'READ'
    ? { blockedRequests: first.blockedRequests + second.blockedRequests, requestCounts: sumRequestCounts(first.requestCounts, second.requestCounts) }
    : { blockedRequests: first.blockedRequests, requestCounts: first.requestCounts };
  if (continuesAfterViolation(second)) {
    return {
      visit: { ...first, ...counted, record: withViolationCulprit(second.record, second), violation: false },
      safetyViolations: [first.safetyViolation, second.safetyViolation],
      reloaded: true,
      stop: null,
    };
  }
  if (second.violation) {
    return { ...unchanged, visit: { ...unchanged.visit, ...counted }, reloaded: true, stop: { kind: 'VIOLATION', safetyViolation: second.safetyViolation } };
  }
  if (second.kind === 'SESSION_LOST') {
    return { ...unchanged, reloaded: true, stop: second };
  }
  // 読み込み直しで読めなかった画面（失敗・不調・エラーの状態）は、残りの候補を押せなかったまま（`CONTEXT_CLOSED_BY_GUARD`）にする。
  return {
    ...unchanged,
    visit: { ...unchanged.visit, ...counted, ...(second.kind === 'READ' ? { record: second.record } : {}) },
    reloaded: true,
  };
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
    // DEF-143: ここから成果物を組み立てて書く段。入る前に 1 回だけ知らせる。
    observer.onFinalizing?.();
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
      // T37a: 鍵の消失の詳しい理由と、監査の段の数（ブラウザを閉じた後の数。口がなければ書かない）。
      ...(crawled.endReasonDetail === null ? {} : { endReasonDetail: crawled.endReasonDetail }),
      ...(crawled.auditStage === null ? {} : { authentication: runAuthenticationSummaryOf(crawled.auditStage) }),
      // DEF-138: セッションの切れで止まったときの証拠（組み立てられたときだけ）。
      ...(crawled.sessionLoss === null ? {} : { sessionLoss: crawled.sessionLoss }),
      // AS-b: 実効の監査の段の送信の扱い（どの扱いで読んだ結果か）。
      auditSendPolicy: auditSendPolicyOf(config),
      // DEF-144: 違反で止まったときの違反の中身（種類・段・画面の path・押した候補。値を持たない）。
      ...(crawled.safetyViolation === null ? {} : { safetyViolation: crawled.safetyViolation }),
      // DEF-144: 外部スキームで押さなかった候補の数と、読み込み直した画面の数（画面の記録から数える）。
      externalSchemeProbes: externalSchemeProbesOf(crawled.pages),
      // T44c（Task 44 の設計書 P1-3）: 押す数の上限で押せなかった、登録・更新の語の候補の数（画面の一覧から求める）。
      pressLimitProbes: pressLimitProbesOf(crawled.pages),
    };
    await writer.writeDiscovery(runDirectory, document);
    return {
      kind: 'RAN',
      runId,
      runDirectory,
      runStatus: document.runStatus,
      exitCode: EXIT_CODES[document.runStatus],
      summary: discoverySummaryOf(document),
      endReason: document.endReason,
    };
  } finally {
    // 保存の状態は書かない（再開の対象にしない）。ハートビートを止めてから、Run のロックを消す。
    await endWorkerRun(writer, run);
  }
}

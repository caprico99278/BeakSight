import type { Browser } from 'playwright';
import { evaluateCrossPageRules } from '../audit/cross-page-rules.js';
import {
  crossPageFactsOfSummary,
  runPageSummaryOf,
  runPageSummaryWithLeadingEvidence,
  type RunPageSummary,
} from '../audit/run-page-summary.js';
import type { BrowserContextFactory, SafetyLedgerFactory } from '../browser/context-factory.js';
import type { MainFrameLoadObservation } from '../browser/main-frame-load.js';
import { ResourceCache } from '../browser/resource-delivery.js';
import type { AuditConfig } from '../config/types.js';
import { createRunArtifactDirectoryForStart, revisitIndexOfScreenshotPath, type RunArtifactDirectoryCreation } from '../core/artifact-layout.js';
import { auditSendPolicyOf } from '../core/audit-send-policy.js';
import type {
  AuditRunResult,
  CrawlLimitState,
  EvidenceRecord,
  Finding,
  IncompleteReason,
  IncompleteReasonCode,
  PageAuditOutcome,
  PageAuditResult,
  PageAuditStatus,
  PageId,
  PageIncompleteReasonCount,
  RunPageSamenessCounts,
  RunCheckpointState,
  RunEnvironment,
  RunExecution,
  RunExecutionAutomaticRelogin,
  RunExecutionEndReason,
  RunId,
  RunLoad,
  RunProgressReport,
  RunAuthenticationRecord,
  RunRetryRecord,
  RunSummary,
  ViewportAuditResult,
} from '../core/contracts.js';
import { CHECKED_WRITE_SCREENS_SCOPE, type RunPageScopeRecord } from '../core/audit-page-scope.js';
import { resolveTimeoutMs, wait } from '../core/deadline.js';
import type { NormalizedHttpUrlEvidence, SessionLossEvidence, SitemapEvidence } from '../core/evidence-types.js';
import { safeErrorMessage } from '../core/errors.js';
import { isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import type { ObservationWindows } from '../core/observation-windows.js';
import { createDebugTimingLog, DEBUG_TIMING_OFF, type DebugTimingLog, type DebugTimingSwitch } from '../core/debug-timing.js';
import { createRunPageStore, forEachRunPage, type RunPages, type RunPageStore } from '../core/run-page-store.js';
import { BROWSER_CLOSE_TIMEOUT_MS } from '../core/limits.js';
import { lastRunExecutionOf } from '../core/run-executions.js';
import { validateArtifact } from '../core/schema-validator.js';
import {
  deriveRunStatus,
  requiredArtifactInvalidReason,
  ruleEvaluationFailureReason,
  unhandledFailureReason,
  type RunStatusInput,
} from '../core/status.js';
import { crawlableLinkUrlsOf } from '../crawl/internal-navigable-links.js';
import { crawlUrlHasDestructiveWord } from '../discovery/destructive-action.js';
import { createLoadMeter, type RunLoadMeter } from '../crawl/load-meter.js';
import { createNavigationPacer, type NavigationPacer, type NavigationPacerSnapshot } from '../crawl/navigation-pacer.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { collectSiteMetadata as collectSiteMetadataDefault, type SiteMetadataResult } from '../crawl/site-metadata.js';
import { sitemapEvidenceFromMetadata } from '../crawl/sitemap-evidence.js';
import { redactUrlSecrets } from '../safety/redact.js';
import type { SafetyLedger, SafetyLedgerSnapshot } from '../safety/safety-ledger.js';
import {
  assertNoSecretAllowedQueryParameters,
  assertRunAuthentication,
  AUTH_SESSION_LOST_SKIP_REASON,
  authenticatedContextOptions,
  authenticatedRunConfig,
  authSessionLostReason,
  isExcludedCrawlCandidate,
  isOutsideRunAuditScope,
  runCheckpointAuthenticationOf,
  type RunAuthentication,
} from './authenticated-run.js';
import {
  SERVICE_REQUEST_LIMIT_SKIP_REASON,
  auditStageCountsOf,
  hasServiceRequestLimitRefusal,
  resumedAuditStageCounts,
  serviceUnauthorizedCountOf,
  serviceUnauthorizedSessionLostDetailOf,
  sessionKeyLostDetailOf,
  auditStageFactoryOptions,
  createAuditStageRunState,
  runAuthenticationSummaryOf,
  intervalTrackingNavigationPacer,
  recordRunStageCarry,
  serviceRequestPacedNavigationPacer,
  type AuditStageRunState,
  type RunStageCarry,
  type ServiceRequestPacingNotice,
} from './audit-stage-run.js';
import { auditSendOptionsOf } from './audit-send-options.js';
import { CrawlFrontier, type CrawlUrlEntry } from './crawl-frontier.js';
import { auditPageOutcomeOf } from './audit-page-structure.js';
import { classifyUrl } from '../crawl/admission-policy.js';
import {
  collectRunEnvironment as collectRunEnvironmentDefault,
  readToolVersion as readToolVersionDefault,
} from './environment.js';
import { IdAllocator } from './id-allocator.js';
import { PageAuditor, type PageAuditorDependencies } from './page-auditor.js';
import {
  SAFETY_VIOLATION_ABORT_REASON,
  acceptsAsSamenessReference,
  samenessAnswersOf,
  type PageAuditDepthDecision,
  type PageSamenessAnswers,
  type PageSamenessDecision,
  type PageSamenessPort,
} from './page-audit-plan.js';
import { navigationFailureDetail } from './page-navigation.js';
import {
  resolvePassiveSessionDeadlines,
  type PassiveSessionDeadlineOptions,
  type ResolvedPassiveSessionDeadlines,
} from './passive-session-open.js';
import { endPreflightBrowser, runPreflight as runPreflightDefault, type BrowserLauncher, type BrowserLease } from './preflight.js';
import {
  checkRunCheckpointConsistency,
  closeInterruptedRunExecutions,
  createRunCheckpoint,
  createRunCheckpointPage,
  decideRunCheckpointConclusion,
  decideRunExecutionEndReason,
  decideRunResumption,
  restoreRunCheckpointCrawl,
  type RunCheckpoint,
  type RunCheckpointAuthentication,
  type RunCheckpointConclusion,
  type RunCheckpointConclusionAction,
  type RunCheckpointExecution,
  type RunCheckpointInput,
  type RunCheckpointLoad,
  type RunCheckpointPage,
  type RunCheckpointSiteMetadata,
} from './run-checkpoint.js';
import type { RunCheckpointSession } from './run-checkpoint-session.js';
import {
  countInteractionOutcomes,
  countPagesByStatus,
  countPartialViewports,
  countPagesByIncompleteReason,
  countPagesBySameness,
  countViewportPages,
  RunSafetyTotals,
  viewportEvidenceOfType,
} from './run-aggregation.js';
import { createRunIdFromTime } from './run-id.js';
import {
  keepsRevisit,
  needsRevisit,
  pageRevisitFactOf,
  readAgainAfterRevisit,
  resumesAfterRunTimeLimit,
  revisitOrderOf,
  type PageRevisitFact,
} from './resume-revisit.js';
import {
  SITE_UNAVAILABLE_RECHECK_DELAYS_MS,
  SITE_UNAVAILABLE_SKIP_REASON,
  siteUnavailabilityOf,
  siteUnavailableDetail,
  sleepUnlessStopped,
  slowedNavigationIntervalMs,
  type SiteUnavailabilityStage,
} from './site-availability.js';
import { skippedPageResult } from './skipped-page.js';

/** Run Coordinator が使う、1ページを監査するもの（`PageAuditor` の入口）。テストでは偽のものを渡せる。 */
export type RunPageAuditor = Pick<PageAuditor, 'audit'>;

/**
 * Run Coordinator が使う、再開のための保存のセッションの操作（中断した Run の再開の設計書 4.3、4.3.1）。始める、ページの保存、
 * 状態の保存だけである。最後の状態の書き出し（`finish`）と、やめること（`abandon`）は、CLI が呼ぶ。
 */
export type RunCoordinatorCheckpointSession = Pick<RunCheckpointSession, 'start' | 'savePage' | 'saveState'>;

/**
 * Run の後に、CLI が行う保存の終わり方（中断した Run の再開の設計書 4.3.2。`RunCoordinator.checkpointConclusion()` の値）。
 * - `FINISH`: 最後の状態の保存（`checkpoint`）を持つ。CLI は、最後の出力を書き終えた後に、セッションの `finish` にそれを渡す。
 *   `finishEvenIfOutputFails` が真なら、CLI は、最後の出力の書き出しに失敗した場合も `finish` を行う（設計書 4.10 の Important-1 の (b)）。
 * - `ABANDON`: 保存の状態を変えない。CLI は、最後の出力を書き終えた後に、セッションの `abandon` を呼ぶ。
 * - `NONE`: セッションを渡されていない、またはセッションを始めなかった。CLI は何もしない。
 * どれを行うかは、`decideRunCheckpointConclusion`（`run-checkpoint.ts`）だけが決める。`action` の値は、その閉じた一覧
 * （`RunCheckpointConclusionAction`）から導く。判定の結果の型（`RunCheckpointConclusion`）とは別の型で、`FINISH` は、作った最後の状態の
 * 保存と、判定の `finishEvenIfOutputFails` の値（そのまま写す。Run Coordinator は決めない）だけを持つ。
 */
export type RunCoordinatorCheckpointConclusion =
  | {
    readonly action: Extract<RunCheckpointConclusionAction, 'FINISH'>;
    readonly checkpoint: RunCheckpoint;
    readonly finishEvenIfOutputFails: Extract<RunCheckpointConclusion, { readonly action: 'FINISH' }>['finishEvenIfOutputFails'];
  }
  | { readonly action: Extract<RunCheckpointConclusionAction, 'ABANDON'> }
  | { readonly action: Extract<RunCheckpointConclusionAction, 'NONE'> };

/**
 * 保存（チェックポイント）からの再開の入力（中断した Run の再開の設計書 3.1、3.2、4.1）。作るのは CLI（R5）かテストで、
 * `ArtifactWriter.readCheckpoint` に R2 の整合の確かめを渡して読み、`decideRunResumption` で再開すると決めたものだけを渡す。
 * Run Coordinator は、スキーマと整合は確かめ済みとして受け取る（ただし、再開できるかは `decideRunResumption` で確かめ直す）。
 */
export interface RunCoordinatorResumeInput {
  /** 前の回の Run のディレクトリ（`runArtifactDirectory(<出力先>, checkpoint.runId)`。すでにある）。 */
  readonly runDirectory: string;
  /** 再開に使う状態の保存（`checkpoint/state.json` か `state.prev.json` の値）。 */
  readonly checkpoint: RunCheckpoint;
  /**
   * 終わったページの保存（`checkpoint.completedPageIds` の順）。MEM-3c（DEF-266）: CLI は、保存を読みながら作った置き場所（`RestoredRunPages`。
   * `restoredRunPagesCollector` で `ArtifactWriter.readCheckpointCollected` から作る）を渡す。配列（テスト）は、Run の初めに置き場所に入れる。
   */
  readonly pages: readonly RunCheckpointPage[] | RestoredRunPages;
}

/** 印（`RestoredRunPages` を配列や、ほかの値と見分ける）。 */
const RESTORED_RUN_PAGES_KIND = 'RESTORED_RUN_PAGES';

/**
 * MEM-3c（DEF-266）: 再開の入力の、終わったページ（保存を読みながら、1 ページずつ置き場所に入れたもの）。
 * - `results`・`pages`: Run の途中と同じ（`storeRunPage`。要約と、再試行の前の試行の Evidence を加えた本体を圧縮したもの）。
 * - `safety`: ページの保存の Safety Ledger の snapshot を、終わった順に足し込んだもの（D7。snapshot そのものは持たない）。
 */
export interface RestoredRunPages {
  readonly kind: typeof RESTORED_RUN_PAGES_KIND;
  readonly results: Map<string, number>;
  readonly pages: RunPageStore<RunPageSummary>;
  readonly safety: RunSafetyTotals;
  /** EV-5: 読み直す候補のページ（URL を鍵に。`needsRevisit` のページだけ）。 */
  readonly revisits: Map<string, RevisitCandidate>;
}

/**
 * EV-5（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.5）: 保存から戻した、読み直す候補のページ。読み直しの前の事実（`resume-revisit.ts`）、前の結果の状態
 * （読み直しを捨てたときに戻す）、ページの保存の Safety Ledger の snapshot（読み直した後のページの保存にも残す。前の読み込みの記録を、後の再開で落とさないため）。
 */
interface RevisitCandidate {
  readonly fact: PageRevisitFact;
  readonly status: PageAuditStatus;
  readonly safetyLedgerSnapshots: readonly SafetyLedgerSnapshot[];
  /**
   * 設計者の判断（2026-11-16）: この読み直しの画像を置く番号（`pages/<pageId>/revisit-<番号>/`）。前の結果が指す画像の読み直しの番号より 1 大きい（前の結果の画像を
   * 上書きしない。捨てた・途中で終わった読み直しの画像は、どの結果も指さないので、同じ番号で上書きしてよい）。
   */
  readonly revisitIndex: number;
  /** DUP（設計書 2 章の再開）: 前の結果の点検の深さ（読み直しも同じ深さで点検する。軽い点検の読み直しは軽い点検のまま）。 */
  readonly previousDepth: PageAuditDepthDecision;
}

/** DUP: Page Auditor が今のページで知らせた深さ（口の中で書き換わるので、関数で読む）。 */
const decidedSamenessOf = (state: { readonly decision: PageSamenessDecision | null }): PageSamenessDecision | null => state.decision;

/** DUP: 結果の点検の深さ（記録がなければ、しっかり点検した）。 */
const depthOfResult = (result: Pick<PageAuditResult, 'sameness'>): PageAuditDepthDecision =>
  (result.sameness === undefined ? { depth: 'FULL', sameAs: null } : { depth: result.sameness.depth, sameAs: result.sameness.sameAs });

/** 設計者の判断（2026-11-16）: 次の読み直しの番号（その結果の画像が指す読み直しの番号のいちばん大きいものより 1 大きい。読み直しの画像がなければ 1）。 */
const nextRevisitIndexOf = (result: PageAuditResult): number =>
  Math.max(0, ...result.evidence.flatMap((record) => {
    const index = record.type === 'screenshot' ? revisitIndexOfScreenshotPath(record.payload.relativePath) : null;
    return index === null ? [] : [index];
  })) + 1;

const isRestoredRunPages = (value: unknown): value is RestoredRunPages => isRecord(value) && value.kind === RESTORED_RUN_PAGES_KIND;

/**
 * MEM-3c（DEF-266）: 保存のページを 1 つずつ置き場所に入れる口（`ArtifactWriter.readCheckpointCollected` に渡す）。ページの保存の値は、入れたら捨てる。
 */
export function restoredRunPagesCollector(): {
  begin(): { add(page: RunCheckpointPage): Promise<void>; finish(): RestoredRunPages };
} {
  return {
    begin: () => {
      const restored: RestoredRunPages = {
        kind: RESTORED_RUN_PAGES_KIND,
        results: new Map(),
        pages: createRunPageStore<RunPageSummary>(),
        safety: new RunSafetyTotals(),
        revisits: new Map(),
      };
      const retryEvidence = new Map<string, readonly EvidenceRecord[]>();
      return {
        add: async ({ url, result, retryEvidence: earlier, safetyLedgerSnapshots }) => {
          await storeRunPage({ results: restored.results, pages: restored.pages, retryEvidence }, url, result, earlier);
          for (const snapshot of safetyLedgerSnapshots) {
            restored.safety.add(snapshot);
          }
          // EV-5: 読み直す候補のページだけ、事実と Ledger の snapshot を持つ（読み直すかは、再開の実行が決める）。
          const fact = pageRevisitFactOf(result);
          if (needsRevisit(fact)) {
            restored.revisits.set(url, {
              fact,
              status: result.status,
              safetyLedgerSnapshots,
              revisitIndex: nextRevisitIndexOf(withLeadingEvidence(result, earlier)),
              previousDepth: depthOfResult(result),
            });
          }
        },
        finish: () => restored,
      };
    },
  };
}

/** ページの保存の配列（テスト）を、置き場所に入れる。 */
async function restoredRunPagesOf(pages: readonly RunCheckpointPage[] | RestoredRunPages): Promise<RestoredRunPages> {
  if (!Array.isArray(pages)) {
    return pages as RestoredRunPages;
  }
  const collection = restoredRunPagesCollector().begin();
  for (const page of pages as readonly RunCheckpointPage[]) {
    await collection.add(page);
  }
  return collection.finish();
}

/**
 * サイトの不調の確かめ直しの待ちの段階と、減速の倍率と上限（DEF-136 で、ジョブと共有するために判定の owner `site-availability.ts` へ移した。今までの
 * 公開の名前を保つために、ここから公開し直す）。
 */
export {
  SITE_UNAVAILABLE_RECHECK_DELAYS_MS,
  SITE_UNAVAILABLE_SLOWDOWN_FACTOR,
  SITE_UNAVAILABLE_SLOWDOWN_MAX_FACTOR,
} from './site-availability.js';

/**
 * Run Coordinator の、実行中の知らせ（サイトが応答しないときに Run を止める設計書 3.5.4、3.6.2）。進み具合（`RunProgressReport`）とは別の口
 * （`RunCoordinatorDependencies.onNotice`）に渡す、事実だけの値である（文言は、CLI が `messages.ts` で作る）。凍結する。
 * - `SITE_UNAVAILABLE_RECHECK`: サイトの不調でページ（`url`）を捨てた後、`delayMs` だけ待ってから、同じページを確かめ直す（`attempt` 回目。
 *   最大 `maxAttempts` 回）。
 * - `SITE_UNAVAILABLE_SLOWDOWN`: 確かめ直しで通ったので、ページの読み込みの最小の間隔を `minIntervalMs` に上げて続ける。
 * - `AUTH_SESSION_LOST`: 認証つきの Run で、セッションの切れを検知して、そのページ（`url`）を捨て、Run を止める（Task 25 の設計書 4.3、4.4 と、
 *   変更履歴の 2026-10-10 の T25d の Blocker の行の (2)。T25d）。ワーカーが、画面に「このページを読まないパスに足す」を案内するために使う。
 * - `SERVICE_REQUEST_PACING_WAIT`: 承認したサービスの Origin への要求の 1 分あたりの上限で、次の読み込みの前に待つ（DEF-141。形の owner は
 *   `audit-stage-run.ts` の `ServiceRequestPacingNotice`。発見と READ の確かめも同じ知らせを出す）。
 */
export type RunNotice =
  | ServiceRequestPacingNotice
  | {
    readonly kind: 'SITE_UNAVAILABLE_RECHECK';
    /** そのページの URL（巡回の記録の、正規化した URL）。 */
    readonly url: string;
    /** 待つ時間（ms。`SITE_UNAVAILABLE_RECHECK_DELAYS_MS` の、この回の値）。 */
    readonly delayMs: number;
    /** 何回目の確かめ直しか（1 から）。 */
    readonly attempt: number;
    /** 1 ページにつき確かめ直す回数の上限（`SITE_UNAVAILABLE_RECHECK_DELAYS_MS` の数）。 */
    readonly maxAttempts: number;
  }
  | {
    readonly kind: 'SITE_UNAVAILABLE_SLOWDOWN';
    /** 新しい最小の間隔（ms）。 */
    readonly minIntervalMs: number;
  }
  | {
    readonly kind: 'AUTH_SESSION_LOST';
    /**
     * 捨てたページの URL（巡回の記録の、正規化した URL）。認証つきの Run の知らせなので、`#notify` が、URL の秘密の伏せ字
     * （`redactUrlSecrets`。userinfo と秘密に見える query の値。T25f）にかけてから渡す。
     */
    readonly url: string;
    /** DEF-138: セッションの切れの証拠（組み立てられたときだけ。値を持たない）。ワーカーが IPC の `AUTH_STATE` に載せる。 */
    readonly sessionLoss?: SessionLossEvidence;
  };

/** `RunCoordinator` に注入するもの（Task 14〜17 の設計書 5.6.1）。 */
export interface RunCoordinatorDependencies {
  /** `loadConfig` で検証済みの設定。 */
  readonly config: AuditConfig;
  /** Chromium を起動する関数（本番では `chromium.launch`）。 */
  readonly launchBrowser: BrowserLauncher;
  /** RB-5: ワーカーの Browser の lease（あれば PREFLIGHT が `launchBrowser` を呼ばずに借り、Run の終わりに返す）。CLI は渡さない。 */
  readonly browserLease?: BrowserLease | undefined;
  /** Context ごとに新しい `SafetyLedger` を作る関数。 */
  readonly createSafetyLedger: SafetyLedgerFactory;
  /** 時刻（`startedAt`、`finishedAt`、`runId`、Evidence の `observedAt`）に使う時計。 */
  readonly clock: () => Date;
  /** 期限と実行時間に使う、現在の時刻（ミリ秒）。`Date.now()` と同じ基準でなければならない（`PageAuditorDependencies.now`）。 */
  readonly now: () => number;
  /**
   * 出力先の根のディレクトリ。Run の artifact は、この下の `<runId>` のディレクトリ（`runArtifactDirectory`）に置く。
   * そのディレクトリは、Run の開始の時点で、Run Coordinator が排他的に作る（`createRunArtifactDirectoryForStart`。DEF-009。DEF-281: 同じ秒の名前が
   * すでにあれば 2 桁の連番を足した Run の ID にする）。
   * PREFLIGHT は、そのディレクトリに書けることを確かめる。スクリーンショットも、そのディレクトリの下に置く。
   */
  readonly outputDirectory: string;
  /** `PageAuditor` を作る関数（テストで偽の Page Auditor を渡すため）。省略すると `new PageAuditor(dependencies)`。 */
  readonly createPageAuditor?: (dependencies: PageAuditorDependencies) => RunPageAuditor;
  /** robots.txt と sitemap.xml の取得（テスト用の差し替え口）。省略すると `collectSiteMetadata`。 */
  readonly collectSiteMetadata?: typeof collectSiteMetadataDefault;
  /**
   * DEF-245: 進みの見張りの反応なしの長さ（ms。テスト用の注入口）。渡すと、Page Auditor と robots.txt・sitemap.xml の取得の見張りへ渡す。省略すると、本番の
   * 長さ（`PROGRESS_WATCH_QUIET_LIMIT_MS`）。
   */
  readonly progressWatchQuietLimitMs?: number | undefined;
  /**
   * RB-2（TEST-TIME-B。SLIM-2 の閉じる前の待ちを寄せた）: 観察の窓の一式（テスト用の注入口）。渡すと、Run の factory（閉じる前の待ち）と Page Auditor（落ち着きと
   * スクロールの待ち）に渡す。省略すると本番の値。CLI とワーカーの本番の入口は渡さない。
   */
  readonly observationWindows?: ObservationWindows | undefined;
  /**
   * DBG-1（設計書 `2026-11-20-beaksight-discovery-skip-and-debug-timing-design.md` 2.2）: 測りの記録の入切を読む口（起動の入口が作る。Run の始めに 1 回呼ぶ）。
   * 入なら、Run のフォルダの測りの記録（`src/core/debug-timing.ts`）を Page Auditor に渡し、Run の終わりにまとめて書く。省略すると切。
   */
  readonly debugTimingSwitch?: DebugTimingSwitch | undefined;
  /** PREFLIGHT（テスト用の差し替え口）。省略すると `runPreflight`。 */
  readonly runPreflight?: typeof runPreflightDefault;
  /** 環境の事実の収集（テスト用の差し替え口）。省略すると `collectRunEnvironment`。 */
  readonly collectRunEnvironment?: typeof collectRunEnvironmentDefault;
  /** BeakSight の版の読み取り（テスト用の差し替え口）。省略すると `readToolVersion`。 */
  readonly readToolVersion?: typeof readToolVersionDefault;
  /**
   * Browser を閉じる処理を待つ上限（ms。R15r-4）。省略すると `BROWSER_CLOSE_TIMEOUT_MS`。テストで短い期限を注入するための口である。
   * 正の安全な整数でない場合は、コンストラクタが `RangeError` を投げる。
   */
  readonly browserCloseTimeoutMs?: number;
  /**
   * Context と page の作成・終了の期限の注入口（RP18 の指摘2。DEF-008、R15r-4）。PREFLIGHT、環境の事実、サイトの metadata、
   * Page Auditor に、そのまま渡す（PREFLIGHT には、Browser を閉じる期限 `browserCloseTimeoutMs` も加えて渡す）。
   * 省略した項目は、`limits.ts` の定数（`SESSION_OPEN_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を使う。
   * 期限が正の安全な整数でない場合は `RangeError`、形が不正な場合は `TypeError` を、コンストラクタが投げる。
   */
  readonly deadlines?: PassiveSessionDeadlineOptions | undefined;
  /**
   * ページの読み込みの間隔のために待つ関数（`ms` ミリ秒待つ。サイトへの負荷の制御の設計書 4.1。テストで、実際に待たずに確かめるための
   * 口）。省略すると、本番の待ち（`src/core/deadline.ts` の `wait`）。関数でない値は、コンストラクタが `TypeError` を投げる。
   */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * 実行中の進み具合の受け手（サイトへの負荷の制御の設計書 4.8）。省略すると、何もしない。ページの監査が1つ終わるたびに（`markFinished`
   * と Link からの発見の後、次のページを始める前に）、その時点の進み具合の事実（`RunProgressReport`）を渡す。サイトの不調のため捨てた
   * ページ（サイトが応答しないときに Run を止める設計書 3.2）は、監査を終えたページに数えず、渡さない。受け手は待たない。
   * 受け手の例外（と、受け手が返した Promise の reject）は、握りつぶす。Run を止めず、Run の理由にもしない（表示の失敗で監査を止めない
   * ため）。関数でない値は、コンストラクタが `TypeError` を投げる。
   */
  readonly onProgress?: ((report: RunProgressReport) => void) | undefined;
  /**
   * L0（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1・6 の L0）: ページを始めた知らせの受け手。省略すると、何もしない。ページの監査を
   * 始める前（再試行と確かめ直しを除く）に、その時点の進み具合の事実に、そのページの URL（`currentPageUrl`）を足して渡す（止まったページが記録に
   * 残るようにするため。ワーカーは `PROGRESS` で送る）。`onProgress`（CLI の 1 行）とは別の口なので、CLI の出力は変わらない。受け手の例外と reject は
   * 握りつぶす（`onProgress` と同じ）。関数でない値は、コンストラクタが `TypeError` を投げる。
   */
  readonly onPageStarted?: ((report: RunProgressReport) => void) | undefined;
  /**
   * 実行中の知らせの受け手（サイトが応答しないときに Run を止める設計書 3.5.4）。省略すると、何もしない。進み具合とは別の口である。
   * サイトの不調でページを捨てた後、確かめ直しのために待つ前に、知らせ（`RunNotice`）を渡す。
   * 受け手は待たない。受け手の例外（と、受け手が返した Promise の reject）は、握りつぶす。Run を止めず、Run の理由にもしない（表示の
   * 失敗で監査を止めないため）。関数でない値は、コンストラクタが `TypeError` を投げる。
   */
  readonly onNotice?: ((notice: RunNotice) => void) | undefined;
  /**
   * DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断）: 「Run の終わり」の段（Browser を閉じる処理、集計、
   * この後に CLI が行う成果物の書き出し、止めたときの片付け）に入る知らせの受け手。省略すると、何もしない。Run の確定の前に、1 回だけ呼ぶ（巡回を
   * 始めなかった場合と、止める印で止めた場合を含む）。その段は、大きな Run では main thread を長く占める。ワーカーは、この知らせを親へ送り、親は、
   * その段の間だけ途絶えの上限を延ばす。受け手は待たない。受け手の例外（と、受け手が返した Promise の reject）は、握りつぶす（`onNotice` と同じ）。
   * 関数でない値は、コンストラクタが `TypeError` を投げる。
   */
  readonly onFinalizing?: (() => void) | undefined;
  /**
   * 再開のための保存のセッション（中断した Run の再開の設計書 4.3、4.3.1）。省略すると、保存しない（今のまま）。作るのは CLI か
   * テストである。渡すと、Run Coordinator は、次の時期に保存を頼む。
   * - Run のディレクトリを排他的に作った直後（PREFLIGHT の前）に、`start(runDirectory, { mode: 'NEW_RUN' })` で始める。
   * - robots.txt と sitemap.xml の取得の後に、状態の保存（`saveState`）を1回行う。
   * - 各ページの `markFinished` と Link からの発見の後に、そのページの保存（`savePage`）と、状態の保存（`saveState`）を、この順に行う。
   * - サイトの不調のため捨てたページ（サイトが応答しないときに Run を止める設計書 3.2）は、ページの保存をせず、状態の保存だけを行う。
   * 保存の状態は `IN_PROGRESS` のままにする（最後の状態は、CLI が最後の出力を書き終えた後に、セッションの `finish` で書く）。
   * CLI が行う保存の終わり方（`finish` に渡す最後の状態の保存、または `abandon`）は、`run()` の後に `checkpointConclusion()` で返す
   * （設計書 4.3.2。R4b2）。
   * 始め方、ページの保存、状態の保存の関数を持たない値は、コンストラクタが `TypeError` を投げる。
   * 再開（`resumeFrom`）のときは、Run のディレクトリを作らずに、`start(resumeFrom.runDirectory, { mode: 'RESUME', completedPageIds })`
   * で始める（`run()` を見る）。
   */
  readonly checkpointSession?: RunCoordinatorCheckpointSession | undefined;
  /**
   * DEF-200（設計書 `2026-11-04-beaksight-login-session-design.md` 3.4 の 5）: この実行が、ログインの切れの後に自動ログインでログインし直して自動で始めた実行なら、
   * その印と回数（ワーカーだけが渡す）。この実行の記録（保存と `run.json`）に任意の項目として残す。省略は今のまま（項目を書かない）。
   */
  readonly automaticRelogin?: RunExecutionAutomaticRelogin | undefined;
  /**
   * WSO: 「チェックした画面だけ」の点検で読む画面の URL（ワーカーだけが渡す。1 件以上）。渡すと、開始の URL の代わりに、この画面だけを渡した順に待ち行列に入れ、
   * 読んだ画面の辺（リンク・SPA の経路など）は、この画面のどれかに当たるものだけを入れる（ほかの画面へ広げない）。巡回の候補の除外（読まないパス・危険な語）と
   * 許可 Origin の外は、今どおり読まない。範囲は、この実行の記録（保存と `run.json`）に `pageScope` として残す。省略は今のまま（開始の URL から全部の画面）。
   */
  readonly pageScope?: readonly string[] | undefined;
  /**
   * 保存からの再開の入力（中断した Run の再開の設計書 3.1、4.1）。省略すると、新しい Run を始める（今のまま）。渡すと、`run()` は、
   * 保存から Run の状態を作り直し、中断したところから監査を続ける。渡す場合は、`checkpointSession` も必須である（ないなら、コンストラクタが
   * `TypeError` を投げる）。形が不正な値（オブジェクトでない、Run のディレクトリが空、保存がオブジェクトでない、ページの保存が配列でない）
   * も、コンストラクタが `TypeError` を投げる。
   */
  readonly resumeFrom?: RunCoordinatorResumeInput | undefined;
  /**
   * 止める印（中断した Run の再開の設計書 4.6.1。R4b2）。省略すると、止めない（今のまま）。CLI は、1回目のシグナル（Ctrl+C など）で、
   * この印の `AbortController` の `abort()` を呼ぶ（R5）。Run Coordinator は、次のページを始める前にだけ、印を確かめる（違反、保存の
   * 失敗、サイトの不調、ページ数、実行時間の後）。印が付いていれば、その URL から後を、理由 `RUN_INTERRUPTED`（`detail` は `null`）の SKIPPED にする。
   * 今のページ（ビューポート、幅の走査、Interaction の候補、再試行）は最後まで行う。robots.txt と sitemap.xml の取得も止めない。
   * `AbortSignal` でない値は、コンストラクタが `TypeError` を投げる。
   */
  readonly stopSignal?: AbortSignal | undefined;
  /**
   * 認証つきの Run の指定（Task 25 の設計書 3 章、4.3、4.7。T25c。`src/orchestration/authenticated-run.ts`）。省略すると、今と完全に同じ
   * （公開監査）。呼び出し側（ワーカー。T25d）が、ログインの段の後に渡す。渡すと、次のとおりにする。
   * - 有効な設定の `audit.interactions` を false にする（Interaction を行わない。`run.json` の `effectiveConfig` に記録する。4.7）。
   * - PREFLIGHT に、factory の認証の指定（状態の注入、世代つきの受け継ぎ、Guard の監査の段の除外）を渡す（4.3）。
   * - Page Auditor に、セッションの切れの path を渡す。セッションの切れを検知したページは捨て（理由 `AUTH_SESSION_LOST` の SKIPPED。再試行しない）、
   *   次のページを始めず、残りの URL を同じ理由（`detail` は `null`）の SKIPPED にする。Run の理由にも1件残す（Run Status は PARTIAL）。
   * - 巡回の候補に、監査の段の除外に当たる URL と、セッションの切れの path の URL を入れない（`isExcludedCrawlCandidate`）。
   * 形が正しくない値と、`approvedTestOrigins` が設定の `site.allowedOrigins` に含まれない値は、コンストラクタが `TypeError` を投げる。
   * 状態（秘密）は、ログ、誤りの文、成果物、Evidence、保存に入れない。
   */
  readonly authentication?: RunAuthentication | undefined;
  /**
   * 外から渡す、ページの読み込みの間隔を守る部品（CCX-22。CC-085。DEF-102 の続き）。省略すると、今と完全に同じ（Run Coordinator が、設定の
   * `crawl.minNavigationIntervalMs` で自分で作る。CLI は渡さない）。ワーカーは、自動ログインの段と同じ部品を渡す（ログインの段の最後の要求から、
   * Run の最初の読み込みまで、設定の間隔以上空ける）。渡す側は、同じ設定の間隔で作る。
   * - 新しい Run: この部品で待ち、factory の Guard の送った時刻の記録もこの部品に入れる。`run.json` の負荷の記録と保存の記録（回数と待ちの合計）は、
   *   `run()` を始めた時点の記録からの差だけを数える（ログインの段の読み込みは、Run の記録に入れない）。
   * - 再開（`resumeFrom`）: 使わない。今どおり、保存の記録から自分で作る（最後の読み込みの開始の時刻は、保存の値と、この実行の開始の時刻の遅い方。
   *   この実行の開始は、呼ぶ側が先に終えたログインの段の後なので、ログインの段の最後の要求からも、設定の間隔以上空く）。
   * `beforeNavigation`・`waitUntilNextNavigationDue`（DEF-236）・`snapshot`・`raiseMinimumInterval`・`recordDocumentRequestSent` の関数を持たない値は、コンストラクタが
   * `TypeError` を投げる。
   */
  readonly navigationPacer?: NavigationPacer | undefined;
  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の持ち越し（`RunStageCarry`。ワーカーが渡す。メモリの中だけ）。
   * 監査の段の口がある Run の上限の部品は、渡された 1 分の窓から始める（実行の上限は今どおり）。Browser を閉じた後、成果物を書く前に 1 回だけ、factory の
   * 最新の状態と窓を `record` に渡す（PREFLIGHT の前に止まり factory がなければ、状態は `null`）。持ち越しは、成果物・保存・ログに書かない。省略すると、
   * 今と完全に同じ（CLI は渡さない）。`record` が投げても Run を止めない。
   */
  readonly stageCarry?: RunStageCarry | undefined;
}

/** 外から渡す pacer が持つべき操作の名前（CCX-22）。 */
const NAVIGATION_PACER_OPERATION_NAMES = Object.freeze([
  'beforeNavigation', 'waitUntilNextNavigationDue', 'snapshot', 'raiseMinimumInterval', 'recordDocumentRequestSent',
] as const);

/**
 * 再試行の対象の、Desktop の `NAVIGATION_FAILED` の理由の `detail` の一覧（Task 14〜17 の設計書 5.2、5.6.4）。
 * 一時的なナビゲーションの失敗（期限切れと、接続の一時的な失敗）だけである。detail の形は、`navigationFailureDetail` だけが作る。
 * 4xx・5xx の応答（ナビゲーションは `OK`）、安全のための遮断（`BLOCKED_EXTERNAL_REDIRECT`）、そのほかのエラーは、再試行しない。
 * 一覧に入る失敗でも、試行の結果にサイトの不調の印がある場合は、再試行しない（サイトが応答しないときに Run を止める設計書 3.3。
 * `#auditWithRetry`）。
 */
export const RETRYABLE_NAVIGATION_FAILURE_DETAILS: readonly string[] = Object.freeze([
  navigationFailureDetail({ navigationOutcome: 'TIMEOUT', failureDetail: null }),
  ...[
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_EMPTY_RESPONSE',
    'net::ERR_NETWORK_CHANGED',
  ].map((code) => navigationFailureDetail({ navigationOutcome: 'FAILED', failureDetail: code })),
]);

/**
 * MEM-3b（DEF-266）: Run Coordinator が確定した Run。ページの結果は、圧縮して持つ置き場所（`RunPageStore`）に、発見の順に入っている。要約は
 * `RunPageSummary`（評価の形から作ったもの）。
 */
export type StoredAuditRunResult = AuditRunResult<RunPageStore<RunPageSummary>>;

/**
 * Run のディレクトリを、Run の開始の時点で作れなかった（DEF-009。Task 18 の前の整理の設計書 第6章）。`RunCoordinator.run()` が、
 * これで reject する。
 * - `result` は、確定した Run である。PREFLIGHT の失敗と同じく、対象のサイトにアクセスせず、Browser も起動せずに確定したもので、
 *   Run Status は `deriveRunStatus` が導いた `FAILED`、理由は `RUN_DIRECTORY_UNAVAILABLE` である。
 * - この Run の artifact は、書かない（書く場所が、別の Run のディレクトリだから）。確定した Run を返り値にせず、例外にするのは、
 *   呼び出し側が `ArtifactWriter` に渡さないようにするためである。
 * - `alreadyExists` は、同じ名前の Run のディレクトリがすでにあった（`EEXIST`）場合に真。出力先を作れなかった場合などは偽。
 */
export class RunDirectoryUnavailableError extends Error {
  /** 確定した Run（Run Status は `FAILED`。ページは置き場所か配列）。 */
  readonly result: AuditRunResult<RunPages>;
  /** 作ろうとした Run のディレクトリ。 */
  readonly runDirectory: string;
  /** 同じ名前の Run のディレクトリが、すでにあったか。 */
  readonly alreadyExists: boolean;

  constructor(input: {
    readonly result: AuditRunResult<RunPages>;
    readonly runDirectory: string;
    readonly alreadyExists: boolean;
    readonly cause: unknown;
  }) {
    super(
      `run directory could not be created: ${input.runDirectory}: ${safeErrorMessage(input.cause)}`,
      { cause: input.cause },
    );
    this.name = 'RunDirectoryUnavailableError';
    this.result = input.result;
    this.runDirectory = input.runDirectory;
    this.alreadyExists = input.alreadyExists;
  }
}

/**
 * 再開の入力（`resumeFrom`）の保存が、再開できないものだった（`decideRunResumption` が `NOT_RESUMABLE`。中断した Run の再開の設計書 3.2）。
 * 呼び出し側の誤りである（再開すると決めたものだけを渡す決まり）。`RunCoordinator.run()` は、何もせずに（保存のセッションも、PREFLIGHT も
 * 始めずに）、これで reject する。
 */
export class RunNotResumableError extends Error {
  /** 保存の Run の ID。 */
  readonly runId: RunId;
  /** 再開の入力の Run のディレクトリ。 */
  readonly runDirectory: string;
  /** 保存の状態（`IN_PROGRESS`、`STOPPED`、`FINISHED`）。 */
  readonly checkpointState: RunCheckpointState;
  /**
   * 再開できない詳しい理由（T35R2-fix。T35R2 の M-1）。保存の状態のほかの理由で再開しないときだけ持つ（`RUN_NOT_RESUMABLE_DETAILS`）。文にも入れる。
   */
  readonly detail: RunNotResumableDetail | null;

  constructor(input: {
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly checkpointState: RunCheckpointState;
    readonly detail?: RunNotResumableDetail;
  }) {
    const detail = input.detail ?? null;
    super(`run checkpoint is not resumable: ${input.runId} (${input.checkpointState}${detail === null ? '' : `, ${detail}`}): ${input.runDirectory}`);
    this.name = 'RunNotResumableError';
    this.runId = input.runId;
    this.runDirectory = input.runDirectory;
    this.checkpointState = input.checkpointState;
    this.detail = detail;
  }
}

/**
 * 保存の状態のほかに、再開しない詳しい理由の閉じた一覧（T35R2-fix。T35R2 の M-1）。
 * - `AUDIT_STAGE_COUNTS_MISSING`: スクリプトで送るログインの監査の Run（監査の段の口がある）の再開で、保存に監査の段の数（`load.auditStageCounts`。
 *   承認したサービスの Origin への要求の上限の数を含む）がない（Run の全体の上限を数え直せないので、再開しない）。
 */
export const RUN_NOT_RESUMABLE_DETAILS = Object.freeze(['AUDIT_STAGE_COUNTS_MISSING'] as const);
export type RunNotResumableDetail = (typeof RUN_NOT_RESUMABLE_DETAILS)[number];

/**
 * 再開のときに、保存のセッションを始められなかった理由の閉じた一覧（中断した Run の再開の設計書 4.4）。
 * - `CHECKPOINT_STORE_FAILED`: 始め方が reject した（後始末を消せなかった。出力先のロックを作れなかった）。
 */
export const RUN_RESUME_UNAVAILABLE_REASONS = Object.freeze(['CHECKPOINT_STORE_FAILED'] as const);
export type RunResumeUnavailableReason = (typeof RUN_RESUME_UNAVAILABLE_REASONS)[number];

/**
 * 再開のときに、保存のセッションを始められなかった（中断した Run の再開の設計書 4.4）。`RunCoordinator.run()` が、PREFLIGHT も Browser の
 * 起動もせず、Run を確定せずに（出力を作らずに）、これで reject する。Run のディレクトリを作れなかった場合（`RunDirectoryUnavailableError`）
 * と同じく、CLI が文言と終了コードを示す（R5）。
 * - `reason`: 始められなかった理由（`RUN_RESUME_UNAVAILABLE_REASONS`）。
 * - `cause`: 始め方の reject の値。
 */
export class RunResumeUnavailableError extends Error {
  /** 保存の Run の ID。 */
  readonly runId: RunId;
  /** 再開の入力の Run のディレクトリ。 */
  readonly runDirectory: string;
  readonly reason: RunResumeUnavailableReason;

  constructor(input: {
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly reason: RunResumeUnavailableReason;
    readonly cause?: unknown;
  }) {
    const causeMessage = 'cause' in input ? `: ${safeErrorMessage(input.cause)}` : '';
    super(
      `run could not be resumed: ${input.runDirectory}: ${input.reason}${causeMessage}`,
      'cause' in input ? { cause: input.cause } : undefined,
    );
    this.name = 'RunResumeUnavailableError';
    this.runId = input.runId;
    this.runDirectory = input.runDirectory;
    this.reason = input.reason;
  }
}

/** 1つの URL の試行の合計の上限（最初の試行と、1回の再試行）。 */
const MAX_NAVIGATION_ATTEMPTS = 2;

/** クロールの上限の理由のコード（Run の理由に並べる順）。 */
const CRAWL_LIMIT_REASON_CODES = Object.freeze([
  'MAX_PAGES_REACHED',
  'MAX_DEPTH_REACHED',
  'MAX_RUNTIME_REACHED',
] as const satisfies readonly IncompleteReasonCode[]);
type CrawlLimitReasonCode = (typeof CRAWL_LIMIT_REASON_CODES)[number];

/** Run Coordinator の `UNHANDLED_FAILURE` の理由の `detail`（`<場面>:<メッセージ>`）の場面の名前。 */
const RUN_FAILURE_LABELS = Object.freeze({
  /** クロール（開始の URL の正規化、metadata、ページの監査、Link の取り出し）の予期しない例外。 */
  crawl: 'run-crawl',
  /** Cross-page rule の評価の予期しない例外。 */
  crossPage: 'run-cross-page',
  /** スキーマの検証の予期しない例外。 */
  validation: 'run-validation',
  /** Browser を閉じる処理の失敗と、期限切れ。 */
  browserClose: 'browser-close',
  /** metadata の取得に使った Context を閉じる処理の失敗。 */
  metadataContextClose: 'site-metadata-context-close',
  /** 環境の事実（User-Agent）の読み取りに使った Context を閉じる処理の失敗と、期限切れ（RP18 の指摘1）。 */
  environmentContextClose: 'environment-context-close',
} as const);

/**
 * 違反を検出したため、robots.txt と sitemap.xml の取得を始めなかったことを表す Run の理由（Task 19 の前の整理の設計書 4.5。C18f）。
 * `detail` は、始めなかった取得の場面の名前（`site-metadata`）。取得しなかったので、metadata の Evidence は作らない。
 */
const SITE_METADATA_SAFETY_ABORT_REASON: IncompleteReason = Object.freeze({
  code: SAFETY_VIOLATION_ABORT_REASON.code,
  detail: 'site-metadata',
});

/** 予期しない例外で監査を終えられなかった URL の理由。 */
const EXECUTION_INCOMPLETE_REASON: IncompleteReason = Object.freeze({ code: 'EXECUTION_INCOMPLETE', detail: null });

/** 再開のための保存を書けなかったため、監査しなかった URL の理由（中断した Run の再開の設計書 4.3）。 */
const CHECKPOINT_WRITE_FAILED_SKIP_REASON: IncompleteReason = Object.freeze({ code: 'CHECKPOINT_WRITE_FAILED', detail: null });

/**
 * 止める印を受けたため、監査しなかった URL の理由（中断した Run の再開の設計書 4.6.1。R4b2）。SKIPPED のページにこの理由があれば、
 * Run の理由にも、同じ値を1件だけ加える（`#finalize`）。
 */
const RUN_INTERRUPTED_SKIP_REASON: IncompleteReason = Object.freeze({ code: 'RUN_INTERRUPTED', detail: null });

/**
 * 再開した実行で PREFLIGHT に失敗したため、監査しなかった URL の理由（中断した Run の再開の設計書 4.10 の DEF-022。R7b）。Run の理由の
 * `PREFLIGHT_FAILED`（この実行の PREFLIGHT の失敗。`detail` は失敗した項目。PREFLIGHT が作る）は、今のとおり1件で、この理由からは加えない。
 */
const PREFLIGHT_FAILED_SKIP_REASON: IncompleteReason = Object.freeze({ code: 'PREFLIGHT_FAILED', detail: null });

/** 保存の終わり方の `NONE`（セッションがない、始めなかった、`run()` が始める前に reject した。設計書 4.3.2）。 */
const NONE_CHECKPOINT_CONCLUSION: RunCoordinatorCheckpointConclusion = Object.freeze({ action: 'NONE' });
/** 保存の終わり方の `ABANDON`（保存の状態を変えない。設計書 4.3.2）。 */
const ABANDON_CHECKPOINT_CONCLUSION: RunCoordinatorCheckpointConclusion = Object.freeze({ action: 'ABANDON' });

/** 保存のセッションの操作の名前（`RunCoordinatorCheckpointSession`）。 */
const CHECKPOINT_SESSION_OPERATION_NAMES = Object.freeze([
  'start',
  'savePage',
  'saveState',
] as const satisfies readonly (keyof RunCoordinatorCheckpointSession)[]);


/** 保存に使う、Run の値（`run()` が組み立てて `#crawl` に渡す）。 */
interface RunCheckpointContext {
  readonly session: RunCoordinatorCheckpointSession;
  readonly runId: RunId;
  readonly toolVersion: string;
  /** Run の開始の時刻（最初の実行の開始。ISO 8601）。 */
  readonly startedAt: string;
  /**
   * 実行の記録（設計書 4.8）。再開した Run では、保存の記録（前の回のプロセスが途中で終わった実行は、`closeInterruptedRunExecutions` で
   * 閉じたもの）に続けて、この実行の分を最後に1件加えたもの。この実行の分の終わりの時刻と終わり方は `null`（実行の途中）。
   */
  readonly executions: readonly [RunCheckpointExecution, ...RunCheckpointExecution[]];
  /** 保存に記録する Run の種類（T25g-2。認証つきの Run だけ。公開監査では `null` で、保存に項目を書かない）。 */
  readonly authentication: RunCheckpointAuthentication | null;
  /** WSO: 保存に記録する点検の範囲（「チェックした画面だけ」の Run だけ。サイトの全部の画面では `null` で、保存に項目を書かない）。 */
  readonly pageScope: RunPageScopeRecord | null;
}

/**
 * 状態の保存の中身のうち、Run の値（状態、保存の時刻、実行の記録を除いたもの）。途中の状態の保存（`runCheckpointState`）と、最後の状態の
 * 保存（`checkpointConclusionOf`。設計書 4.3.2）は、これに状態、保存の時刻、実行の記録を加えて、`createRunCheckpoint` で作る。
 */
type RunCheckpointContentValues = Omit<RunCheckpointInput, 'state' | 'savedAt' | 'executions'>;

/** 巡回の値（`#crawl` の中のもの）。状態の保存の中身にする。 */
interface RunCrawlRecord {
  readonly frontier: CrawlFrontier;
  readonly allocator: IdAllocator;
  /** 監査を始めたページの数（サイトの不調のため捨てたページは数えない。サイトが応答しないときに Run を止める設計書 3.2）。 */
  readonly pagesStarted: number;
  /**
   * ページの外で作った Safety Ledger の snapshot（再開した Run では、前の回までの分を含む）。サイトの不調のため捨てたページの Ledger の
   * snapshot も、ここに入る（サイトが応答しないときに Run を止める設計書 3.2）。
   */
  readonly outsidePageSnapshots: readonly SafetyLedgerSnapshot[];
  /** 監査を終え、ページの保存を書いたページの ID（終わった順）。 */
  readonly completedPageIds: readonly PageId[];
  /** EV-5: 時間切れの後の再開で読み直しを終えたページの ID（読み直した順。前の回までの分を含む）。 */
  readonly revisitedPageIds: readonly PageId[];
}

/** `#crawl` の結果のうち、Run の後の保存の終わり方に使うもの（設計書 4.3.2。R4b2）。 */
interface RunCrawlOutcome {
  /** この実行で、保存（ページの保存か状態の保存）に失敗した。 */
  readonly checkpointWriteFailed: boolean;
  /** 最後に書けた状態の保存（この実行で書けた値。なければ再開の入力の保存。どちらもなければ `null`）。 */
  readonly lastWrittenCheckpoint: RunCheckpoint | null;
  /**
   * 巡回の終わり（残りの URL を SKIPPED にした後。Browser を閉じる前）の状態の保存の中身（設計書 4.3.2）。保存のセッションがなければ `null`。
   */
  readonly crawlEndContent: RunCheckpointContentValues | null;
}

/** `#finalize` の結果。 */
interface RunFinalization {
  readonly result: StoredAuditRunResult;
  /** SKIPPED のページの理由のコードの集まり（実行の終わり方と、保存の終わり方の判定の入力。設計書 4.3.2、4.8）。 */
  readonly skipReasonCodes: ReadonlySet<IncompleteReasonCode>;
  /** この実行の記録（`run.json` の実行の記録の最後のもの。終わりの時刻は `run.json` の `finishedAt`）。 */
  readonly execution: RunExecution;
}

/** 1回の `run()` で、保存のセッションを始めたか（`run()` が reject した場合の保存の終わり方に使う。設計書 4.3.2）。 */
interface RunSessionStatus {
  started: boolean;
}

/** robots.txt と sitemap.xml の取得の結果のうち、Run Coordinator が使うもの（再開のときは、保存の Evidence から作り直す）。 */
type RunSiteMetadata = Pick<SiteMetadataResult, 'records' | 'sitemap'>;

/**
 * 1つの URL の監査の結果（`#auditWithRetry`）。最終の試行のページの結果と、その試行のサイトの不調の印（不調を検知しなければ `null`。
 * サイトが応答しないときに Run を止める設計書 3.2、3.3）。
 */
type RunPageAudit = Pick<
  PageAuditOutcome,
  'result' | 'siteUnavailableDetail' | 'authSessionLostDetail' | 'authSessionLoss'
>;

/** 1回の `run()` の途中の状態。 */
interface RunProgress {
  readonly reasons: IncompleteReason[];
  readonly retries: RunRetryRecord[];
  /**
   * 保存した Safety Ledger の snapshot（再開した Run だけ。新しい Run では空。中断した Run の再開の設計書 4.1、4.2）。前の回までの、ページの外の
   * Ledger の snapshot（状態の保存のもの）と、終わったページの Ledger の snapshot（ページの保存のもの。終わった順）を、この順に並べたもの。
   * Ledger は作り直さず、この実行の Ledger（`safetyLedgers`）とは別に持つ。違反の確かめ（`#safetyViolationRecorded`）と、Run の Safety の
   * 集計（`#finalize`）は、この snapshot を、この実行の Ledger より前のものとして扱う（Ledger を作った順と同じ）。
   * MEM-3c（DEF-266。D7）: snapshot そのものは持たず、この順に足し込んだもの（`RunSafetyTotals`）と、違反を持つ snapshot があったかだけを持つ。
   */
  readonly savedSafety: RunSafetyTotals;
  /**
   * この Run（この実行）で作ったすべての Safety Ledger の登録（作った順。設計書 5.6.5、R15 の I2）。注入された `createSafetyLedger` を包んだ
   * factory が、作るたびに加える。PREFLIGHT、環境の事実、metadata の取得、各ページ（Passive、Interaction、幅の走査）、再試行の前の
   * 試行の Ledger のすべてである。Page Auditor が例外を投げた場合も、その試行の Ledger は、ここにある。
   * Run の Safety の集計（違反、記録の切り詰め、遮断の件数）は、Browser を閉じた後に、保存した snapshot と、ここの snapshot からだけ行う。
   */
  readonly safetyLedgers: SafetyLedger[];
  /**
   * 違反を検出したか（Task 19 の前の整理の設計書 4.5。C18f）。一度真になったら、戻さない（Ledger の違反は減らないため）。
   * `#detectSafetyViolation` だけが変える（監査を始める前の確かめと、各保存の前（robots.txt と sitemap.xml の取得の後の保存と、各ページの
   * 保存）。中断した Run の再開の設計書 4.2。サイトの不調の印のあるページの後の確かめ（ページを捨てるかを決める前。サイトが応答しないときに
   * Run を止める設計書 3.2））。
   */
  safetyViolationDetected: boolean;
  /**
   * 違反を検出したため、監査を始めなかったものがあるか（ページ、ビューポート、幅の走査の幅、Interaction の候補）。
   * 真なら、Run の理由に `SAFETY_VIOLATION_ABORT` を1件だけ加える。違反の確かめが真を返すと、呼び出し側は必ず監査を始めないので、
   * `#safetyViolationRecorded` が真を返したときに真にする。
   */
  stoppedBySafetyViolation: boolean;
  /** 今のページの監査を始めた時点の、Ledger の登録の件数（Page Auditor の中の確かめは、ここから後の Ledger を調べる）。 */
  pageLedgerStart: number;
  /**
   * この Run の、ページの読み込みの間隔を守る部品（サイトへの負荷の制御の設計書 4.1）。Run の初めに1つだけ作り、robots.txt と
   * sitemap.xml の取得と、Page Auditor に、同じものを渡す。
   */
  readonly navigationPacer: NavigationPacer;
  /**
   * この Run の、監査対象のサイトに送った要求の実績を数える部品（サイトへの負荷の制御の設計書 4.5）。Run の初めに1つだけ作り、
   * PREFLIGHT に `contextFactoryOptions` で渡す（PREFLIGHT が、Run のすべての Context を作る factory に渡す）。
   */
  readonly loadMeter: RunLoadMeter;
  /**
   * T35c（Task 35 の設計書 3.4〜3.7）: スクリプトで送るログインの監査の Run の、この実行の監査の段の部品と数（上限の部品、記録、401 の数、鍵の消失の印）。
   * 監査の段の口のない Run では `null`。上限に届いたら次のページを始めず、鍵がなくなったらセッションの切れにする。
   */
  readonly auditStage: AuditStageRunState | null;
  /**
   * 監査した URL の、ページの置き場所（`pages`）の中の添字。MEM-3b（DEF-266）: 最終の試行の結果は生で持たず、終えたときに `pages` に入れる（`#storePage`）。
   */
  readonly results: Map<string, number>;
  /**
   * MEM-3b: 監査したページの置き場所（終えた順）。本体は、再試行の前の試行の Evidence を先頭に加えた形（出力の形。開始の URL のページの metadata の Evidence は、
   * Run の終わりに加える）を圧縮して持つ。要約（`RunPageSummary`）は、評価の形（最終の試行の Evidence だけ）から作る。
   */
  readonly pages: RunPageStore<RunPageSummary>;
  /**
   * 再試行している URL の、再試行の前の試行の Evidence（最終のページの `evidence` に残す。設計書 5.6.4、R15 の Minor-6）。MEM-3b: ページを `pages` に入れるときに、
   * 本体に加えて消す。
   */
  readonly retryEvidence: Map<string, readonly EvidenceRecord[]>;
  /** EV-5: 保存から戻した、読み直す候補のページ（再開した Run だけ。URL を鍵に）。 */
  readonly revisits: ReadonlyMap<string, RevisitCandidate>;
  /**
   * 実行時間の上限を超えたか（設計書 5.6.3）。ページとページの間でだけ確かめるので、最後のページで超え、監査していない URL が
   * 残らない場合も、事実として `crawlLimits.maxRuntimeReached` に記録する（その場合は、Run の理由は付けない。R15 の Minor-4）。
   */
  maxRuntimeExceeded: boolean;
  /**
   * この実行で最初に検知したサイトの不調の詳細（ページの結果の `siteUnavailableDetail`。サイトが応答しないときに Run を止める設計書 3.2、
   * 3.2.1）。検知していなければ `null`。`#crawl` だけが、不調のページを捨てるときと、前の実行のきっかけのページを普通の結果として保存する
   * ときと、robots.txt と sitemap.xml の取得で不調を検知したとき（詳細は `site-metadata:<判定の詳細>`。設計書 3.1）に、入れる（そのページや
   * 取得までに違反も検出していた場合は入れない。今のとおり違反で止めるため。違反の優先）。
   * `null` でなければ、次のページを始めず（止める理由の確かめ）、`#finalize` が Run の理由 `SITE_UNAVAILABLE`（`detail` はこの値）を1件
   * 加える。保存しない（この実行だけの値。再開した実行で不調を検知しなければ、Run の理由は残らない）。
   */
  siteUnavailableDetail: string | null;
  /**
   * 認証つきの Run で、この実行で最初に検知したセッションの切れの場所（`<ビューポート>:<段階>`。T25c）。検知していなければ `null`。`#crawl` だけが、
   * セッションの切れのページを捨てるときに入れる（そのページに違反もあれば入れない。違反の優先）。`null` でなければ、次のページを始めない。
   * 保存しない（この実行だけの値。再開のときは、もう一度ログインする（T25d））。
   */
  authSessionLostDetail: string | null;
  /**
   * DEF-138: そのときのセッションの切れの証拠（Page Auditor が組み立てたもの。path の切れだけ。鍵の消失と、組み立てられなかったときは `null`）。
   * `run.json` の `authentication.sessionLoss` に書く。保存しない（この実行だけの値）。
   */
  authSessionLoss: SessionLossEvidence | null;
  unhandledFailures: number;
  executionComplete: boolean;
  preflightFailed: boolean;
  guardEnabled: boolean;
  frontier: CrawlFrontier | null;
  allocator: IdAllocator | null;
  startUrl: NormalizedHttpUrlEvidence | null;
  metadata: RunSiteMetadata | null;
}

/**
 * 開始の URL から BFS でクロールし、確定した Run（`AuditRunResult`）を返す（Task 14〜17 の設計書 第5章、5.6）。
 * 同時実行数は1である。依存するものは、コンストラクタで注入する（`RunCoordinatorDependencies`）。
 */
export class RunCoordinator {
  readonly #config: AuditConfig;
  readonly #launchBrowser: BrowserLauncher;
  readonly #browserLease: BrowserLease | undefined;
  readonly #createSafetyLedger: SafetyLedgerFactory;
  readonly #clock: () => Date;
  readonly #now: () => number;
  readonly #outputDirectory: string;
  readonly #createPageAuditor: (dependencies: PageAuditorDependencies) => RunPageAuditor;
  readonly #collectSiteMetadata: typeof collectSiteMetadataDefault;
  /** DEF-245: 進みの見張りの反応なしの長さ（テスト用。省略は `undefined`）。 */
  readonly #progressWatchQuietLimitMs: number | undefined;
  /** RB-2: 観察の窓の一式の注入（`RunCoordinatorDependencies.observationWindows`）。なければ factory と Page Auditor の本番の値。 */
  readonly #observationWindows: ObservationWindows | undefined;
  /** DBG-1: 測りの記録の入切を読む口と、この Run の測りの記録（`run` が Run のディレクトリで作る。切なら何もしない口）。 */
  readonly #debugTimingSwitch: DebugTimingSwitch | undefined;
  #debugTimingLog: DebugTimingLog = DEBUG_TIMING_OFF;
  readonly #runPreflight: typeof runPreflightDefault;
  readonly #collectRunEnvironment: typeof collectRunEnvironmentDefault;
  readonly #readToolVersion: typeof readToolVersionDefault;
  readonly #browserCloseTimeoutMs: number;
  readonly #deadlines: ResolvedPassiveSessionDeadlines;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onProgress: ((report: RunProgressReport) => void) | undefined;
  /** L0: ページを始めた知らせの受け手。 */
  readonly #onPageStarted: ((report: RunProgressReport) => void) | undefined;
  readonly #onNotice: ((notice: RunNotice) => void) | undefined;
  readonly #onFinalizing: (() => void) | undefined;
  readonly #checkpointSession: RunCoordinatorCheckpointSession | undefined;
  readonly #resumeFrom: RunCoordinatorResumeInput | undefined;
  readonly #stopSignal: AbortSignal | undefined;
  /** 認証つきの Run の指定（T25c）。公開監査では `null`。 */
  readonly #authentication: RunAuthentication | null;
  /** 外から渡した pacer（CCX-22）。渡さなければ `null`（自分で作る）。 */
  readonly #externalNavigationPacer: NavigationPacer | null;
  /** FM2d: まとめて実行の段の持ち越し（`RunCoordinatorDependencies.stageCarry`）。渡さなければ `null`（今のまま）。 */
  readonly #stageCarry: RunStageCarry | null;
  /** DEF-200: この実行のログインし直しの印と回数（なければ `null`）。 */
  readonly #automaticRelogin: RunExecutionAutomaticRelogin | null;
  /** WSO: 「チェックした画面だけ」の点検で読む画面（正規化した URL。渡した順。範囲がなければ `null`）。 */
  readonly #pageScope: readonly NormalizedHttpUrlEvidence[] | null;

  /** WSO: 保存と `run.json` に足す範囲の部分（範囲がなければ空）。 */
  #pageScopePart(): { readonly pageScope?: RunPageScopeRecord } {
    return this.#pageScope === null ? {} : { pageScope: { kind: CHECKED_WRITE_SCREENS_SCOPE, pageCount: this.#pageScope.length } };
  }

  /** WSO: 辺の URL を待ち行列に入れてよいか（範囲がなければ、どれでもよい。範囲があれば、範囲の画面だけ）。 */
  #inPageScope(url: string): boolean {
    return this.#pageScope === null || this.#pageScope.includes(url as NormalizedHttpUrlEvidence);
  }

  /** DEF-200: 実行の記録に足す、ログインし直しの印の部分（なければ空）。 */
  #automaticReloginPart(): { readonly automaticRelogin?: RunExecutionAutomaticRelogin } {
    return this.#automaticRelogin === null ? {} : { automaticRelogin: this.#automaticRelogin };
  }
  /** 保存に記録する Run の種類（T25g-2。`runCheckpointAuthenticationOf`）。公開監査では `null`。 */
  readonly #checkpointAuthentication: RunCheckpointAuthentication | null;
  /** 最後に終わった `run()` の後の保存の終わり方（`run()` が終わるまでは `null`）。 */
  #checkpointConclusion: RunCoordinatorCheckpointConclusion | null = null;

  constructor(dependencies: RunCoordinatorDependencies) {
    if (!isRecord(dependencies)) {
      throw new TypeError('RunCoordinator dependencies are required');
    }
    const { config, launchBrowser, createSafetyLedger, clock, now, outputDirectory } = dependencies;
    if (!isRecord(config) || !isRecord(config.site) || !isRecord(config.crawl) || !isRecord(config.target)) {
      throw new TypeError('RunCoordinator requires a validated audit configuration');
    }
    for (const [name, value] of [
      ['launchBrowser', launchBrowser],
      ['createSafetyLedger', createSafetyLedger],
      ['clock', clock],
      ['now', now],
    ] as const) {
      if (typeof value !== 'function') {
        throw new TypeError(`RunCoordinator requires a ${name} function`);
      }
    }
    if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
      throw new TypeError('RunCoordinator requires a non-empty output directory');
    }
    for (const [name, value] of [
      ['createPageAuditor', dependencies.createPageAuditor],
      ['collectSiteMetadata', dependencies.collectSiteMetadata],
      ['runPreflight', dependencies.runPreflight],
      ['collectRunEnvironment', dependencies.collectRunEnvironment],
      ['readToolVersion', dependencies.readToolVersion],
      ['sleep', dependencies.sleep],
      ['onProgress', dependencies.onProgress],
      ['onPageStarted', dependencies.onPageStarted],
      ['onNotice', dependencies.onNotice],
      ['onFinalizing', dependencies.onFinalizing],
    ] as const) {
      if (value !== undefined && typeof value !== 'function') {
        throw new TypeError(`RunCoordinator ${name} must be a function when given`);
      }
    }
    const checkpointSession: unknown = dependencies.checkpointSession;
    if (
      checkpointSession !== undefined
      && (!isRecord(checkpointSession)
        || !CHECKPOINT_SESSION_OPERATION_NAMES.every((name) => typeof checkpointSession[name] === 'function'))
    ) {
      throw new TypeError(`RunCoordinator checkpointSession must have ${CHECKPOINT_SESSION_OPERATION_NAMES.join(', ')} when given`);
    }
    const resumeFrom: unknown = dependencies.resumeFrom;
    if (resumeFrom !== undefined) {
      if (
        !isRecord(resumeFrom)
        || typeof resumeFrom.runDirectory !== 'string'
        || resumeFrom.runDirectory.length === 0
        || !isRecord(resumeFrom.checkpoint)
        || !(Array.isArray(resumeFrom.pages) || isRestoredRunPages(resumeFrom.pages))
      ) {
        throw new TypeError('RunCoordinator resumeFrom must have a run directory, a checkpoint and the list of page checkpoints when given');
      }
      if (checkpointSession === undefined) {
        throw new TypeError('RunCoordinator resumeFrom requires a checkpointSession');
      }
    }
    const stopSignal: unknown = dependencies.stopSignal;
    if (stopSignal !== undefined && !(stopSignal instanceof AbortSignal)) {
      throw new TypeError('RunCoordinator stopSignal must be an AbortSignal when given');
    }
    const authentication: unknown = dependencies.authentication;
    if (authentication !== undefined) {
      assertRunAuthentication(authentication, config);
    }
    // T44g（Task 44 の設計書 P4-1 の発見事項 4）: 公開監査も、許す query の名前に秘密に見える名前があれば始めない（認証つきの Run と同じ部品と理由）。
    assertNoSecretAllowedQueryParameters(config);
    const externalNavigationPacer: unknown = dependencies.navigationPacer;
    if (
      externalNavigationPacer !== undefined
      && (!isRecord(externalNavigationPacer)
        || !NAVIGATION_PACER_OPERATION_NAMES.every((name) => typeof externalNavigationPacer[name] === 'function'))
    ) {
      throw new TypeError(`RunCoordinator navigationPacer must have ${NAVIGATION_PACER_OPERATION_NAMES.join(', ')} when given`);
    }
    this.#externalNavigationPacer = dependencies.navigationPacer ?? null;
    const { stageCarry } = dependencies;
    if (
      stageCarry !== undefined
      && (!isRecord(stageCarry) || typeof stageCarry.record !== 'function' || !Array.isArray(stageCarry.serviceRequestWindowMs))
    ) {
      throw new TypeError('RunCoordinator stageCarry must have a service request window and a record function when given');
    }
    this.#stageCarry = stageCarry ?? null;
    this.#automaticRelogin = dependencies.automaticRelogin === undefined ? null : Object.freeze({ count: dependencies.automaticRelogin.count });
    this.#authentication = authentication ?? null;
    // REV-WSO の M-1: 範囲は、読める画面だけにする（読まない画面は数えない）。
    this.#pageScope = dependencies.pageScope === undefined
      ? null
      : readablePageScope(config, this.#authentication, normalizedPageScope(config, dependencies.pageScope));
    this.#checkpointAuthentication = authentication === undefined ? null : runCheckpointAuthenticationOf(authentication);
    // T25c: 認証つきの Run では、Interaction を行わないことを、有効な設定で記録する（Task 25 の設計書 4.7）。公開監査は、設定のまま。
    this.#config = authentication === undefined ? config : authenticatedRunConfig(config);
    this.#launchBrowser = launchBrowser;
    this.#browserLease = dependencies.browserLease;
    this.#createSafetyLedger = createSafetyLedger;
    this.#clock = clock;
    this.#now = now;
    this.#outputDirectory = outputDirectory;
    this.#createPageAuditor = dependencies.createPageAuditor ?? ((pageAuditorDependencies) => new PageAuditor(pageAuditorDependencies));
    this.#collectSiteMetadata = dependencies.collectSiteMetadata ?? collectSiteMetadataDefault;
    this.#progressWatchQuietLimitMs = dependencies.progressWatchQuietLimitMs;
    this.#observationWindows = dependencies.observationWindows;
    this.#debugTimingSwitch = dependencies.debugTimingSwitch;
    this.#runPreflight = dependencies.runPreflight ?? runPreflightDefault;
    this.#collectRunEnvironment = dependencies.collectRunEnvironment ?? collectRunEnvironmentDefault;
    this.#readToolVersion = dependencies.readToolVersion ?? readToolVersionDefault;
    this.#sleep = dependencies.sleep ?? wait;
    this.#onProgress = dependencies.onProgress;
    this.#onPageStarted = dependencies.onPageStarted;
    this.#onNotice = dependencies.onNotice;
    this.#onFinalizing = dependencies.onFinalizing;
    this.#checkpointSession = dependencies.checkpointSession;
    this.#resumeFrom = dependencies.resumeFrom;
    this.#stopSignal = dependencies.stopSignal;
    // 期限の値の検証は、期限の部品と同じもので行う（正の安全な整数でなければ `RangeError`）。
    this.#browserCloseTimeoutMs = resolveTimeoutMs(dependencies.browserCloseTimeoutMs, BROWSER_CLOSE_TIMEOUT_MS);
    // 作成・終了の期限は、ここで検証し、既定値で埋めたものを下へ渡す（RP18 の指摘2）。
    this.#deadlines = resolvePassiveSessionDeadlines(dependencies.deadlines);
  }

  /**
   * Run を実行し、確定した Run を返す（設計書 5.6.1）。
   *
   * 1. 開始の時刻から `runId` を作る。Run のディレクトリを、排他的に作る（DEF-009）。作れなかった場合は、PREFLIGHT を行わず、
   *    対象のサイトにアクセスせず、Browser も起動せずに確定し（環境の事実は集める）、`RunDirectoryUnavailableError` で reject する。
   *    Run Status は、PREFLIGHT の失敗と同じく `FAILED` で、理由は `RUN_DIRECTORY_UNAVAILABLE` である。
   *    保存のセッション（`checkpointSession`）が注入されていれば、作った直後に始める（中断した Run の再開の設計書 4.3.1）。始められ
   *    なかった場合は、PREFLIGHT を行わず、Browser も起動せずに確定する（環境の事実は集める）。Run のディレクトリを作れなかった場合と
   *    同じく、Run Status の入力は `preflightFailed` で `FAILED`、理由は `CHECKPOINT_WRITE_FAILED` である（reject はしない）。
   * 2. PREFLIGHT を行う。失敗した場合は、対象のサイトにアクセスせずに確定する（環境の事実は集める）。Run Status は `FAILED`
   *    で、違反が記録された場合は `ABORTED_BY_SAFETY` である（設計書 5.6.7）。
   * 3. 環境の事実を集める。User-Agent を読んだ page と Context の閉じる処理の失敗（期限切れを含む）は、Run の理由に加える。
   * 4. 採番器を作り、開始の URL のページの ID を採番する。
   * 5. robots.txt と sitemap.xml を取得する。Evidence は、開始の URL のページに置く（設計書 5.6.2）。取得の観測でサイトの不調を検知したら、
   *    sitemap.xml を読み込まず、ページの監査を始めずに、残りの URL を理由 `SITE_UNAVAILABLE` の SKIPPED にする。取得の結果は、前の実行が
   *    この段階で止まっていなければ残さない（再開のときに取得し直す。`#crawl`。サイトが応答しないときに Run を止める設計書 3.1、3.2.1）。
   * 6. BFS でクロールする（5.6.3）。一時的なナビゲーションの失敗は、1回だけ再試行する（5.6.4）。安全の不変条件の違反を検出した後は、
   *    新しいページを始めず、残りの URL を理由 `SAFETY_VIOLATION_ABORT` の SKIPPED にする。Page Auditor にも、次のビューポート、
   *    幅の走査の次の幅、Interaction の次の候補を始めないよう、違反の確かめを渡す（Task 19 の前の整理の設計書 4.5）。
   *    保存のセッションがあれば、robots.txt と sitemap.xml の後と、各ページの後に、保存を頼む（`#crawl`。中断した Run の再開の設計書 4.3）。
   *    ページの結果にサイトの不調の印があれば、再試行せず、そのページを捨てて（再開で監査し直す）、新しいページを始めずに、残りの URL を
   *    理由 `SITE_UNAVAILABLE` の SKIPPED にする（`#crawl`。サイトが応答しないときに Run を止める設計書 3.2、3.2.1、3.3）。
   * 7. Browser を閉じる（閉じる処理の失敗は、Run の理由に加える）。
   * 8. Cross-page rule を評価する。評価の失敗は、Run の理由に加える。
   * 9. すべてのページと Finding を、スキーマで確かめる。
   * 10. `RunSummary` を組み立て、Run Status を `deriveRunStatus` で導く（5.6.5、5.6.6）。
   *
   * 予期しない例外は、`unhandledFailures` に数え、Run を確定して返す。reject するのは、Run のディレクトリを作れなかった場合
   * （`RunDirectoryUnavailableError`）と、注入した依存が不正な場合（時計が不正な時刻を返す、BeakSight か Playwright の
   * `package.json` が読めない、設定のページの読み込みの最小の間隔が 0 以上の安全な整数でない（`RangeError`。何も始める前）、など）だけである。
   *
   * ページの読み込みの間隔を守る部品（`NavigationPacer`。サイトへの負荷の制御の設計書 4.1）は、Run の初めに1つだけ作る。間隔は設定の
   * `crawl.minNavigationIntervalMs`、時刻は注入した `now`、待ちは注入した `sleep`（省略すると本番の待ち）である。robots.txt と
   * sitemap.xml の取得と、Page Auditor に、同じものを渡す。PREFLIGHT にも `contextFactoryOptions: { navigationPacer }` で渡し、factory が、
   * すべての Context の Guard に、main frame の文書の要求を送った時刻を記録させる（間隔は、開始と送った時刻の遅い方から数える。DEF-100 fix）。
   *
   * 要求の実績を数える部品（`LoadMeter`。設計書 4.5）も、Run の初めに1つだけ作る。許可 Origin は設定の `site.allowedOrigins`、時刻は
   * 注入した `now` である。PREFLIGHT に `contextFactoryOptions: { loadMeter }` で渡し、PREFLIGHT が、Run のすべての Context を作る
   * factory に渡す。Run の結果の `load` は、Browser を閉じた後に、設定、pacer、meter の値から組み立てる（Run が早く終わった場合も入れる）。
   *
   * Run 全体のリソースのキャッシュ（`ResourceCache`。設計書 4.6）も、Run の初めに1つだけ、空で作る。meter と同じく、PREFLIGHT に
   * `contextFactoryOptions` で渡し、PREFLIGHT が factory に渡す。factory は、すべての Context の応答をキャッシュに入れ、読み込み直しの
   * Context（幅の走査と Interaction）では、キャッシュにあるものをキャッシュから返す（設計書 4.7）。キャッシュは、ファイルには書かない。
   *
   * 進み具合の受け手（`onProgress`。設計書 4.8）が注入されていれば、ページの監査が1つ終わるたびに、進み具合の事実を渡す（`#reportProgress`）。
   *
   * 再開の入力（`resumeFrom`。中断した Run の再開の設計書 3.1、3.2、4.1〜4.5、4.9）があれば、保存から Run の状態を作り直し、中断したところから
   * 監査を続ける。新しい Run との違いは次のとおりである。
   * - 最初に `decideRunResumption` で確かめ直し、`NOT_RESUMABLE` なら、何もせずに `RunNotResumableError` で reject する。
   * - Run の ID、BeakSight の版、Run の開始の時刻（`run.json` の `startedAt`）、`run.json` の環境は、保存のもの（最初の実行のもの）。
   *   実行時間の上限は、この実行の開始から数える。
   * - Run のディレクトリは作らず、前の回のものを使う。保存のセッションを `RESUME` で始め、始められなければ、PREFLIGHT も Browser の起動も
   *   せず、Run を確定せずに、`RunResumeUnavailableError` で reject する。PREFLIGHT と環境の事実は、新しい Run と同じく行う。
   * - pacer と meter は、保存の負荷の記録から続ける。pacer の最後の読み込みの開始の時刻は、保存の値と、この実行の開始の時刻の遅い方にする
   *   （設計書 4.9。監査の途中のページの読み込みは保存に入らないため。`resumedNavigationPacerRecord`）。採番器、巡回の記録、理由、再試行の
   *   記録、違反のフラグ、未処理の失敗の件数、監査を始めたページの数、終わったページの結果と再試行の前の Evidence、robots.txt と sitemap.xml の
   *   Evidence（取得し直さない）、保存した Safety Ledger の snapshot を、保存から作り直す。採番器、巡回の記録、robots.txt と sitemap.xml の
   *   Evidence は、PREFLIGHT の前に、PREFLIGHT の結果によらず作り直す（設計書 4.10 の DEF-022。`restoredCrawlProgress`）。
   * - PREFLIGHT に失敗した場合（Browser がない）は、巡回を行わずに、残りの URL（待ち行列のもの。保存の時点で待ち行列に戻したものを含む）を、
   *   理由 `PREFLIGHT_FAILED`（`detail` は `null`）の SKIPPED にする。出力には、前の回までに終わったページの結果と、SKIPPED のページが入る。
   *   Run の理由の `PREFLIGHT_FAILED` は、この実行の PREFLIGHT の失敗の1件で、Run Status は `preflightFailed` から `deriveRunStatus` が導く。
   * - 保存した snapshot に違反があれば（保存のフラグが偽でも。守り）、`#safetyViolationRecorded` が真を返すので、新しいページを始めず、残りの URL を
   *   理由 `SAFETY_VIOLATION_ABORT` の SKIPPED にして、最後の処理だけを行う。
   * - 保存は、保存した分（終わったページの ID、ページの外の Ledger の snapshot、実行の記録）に続けて行う。
   *
   * 止める印（`stopSignal`。中断した Run の再開の設計書 4.6.1。R4b2）が付いていれば、次のページを始めず、残りの URL を理由 `RUN_INTERRUPTED`
   * の SKIPPED にする（`#crawl`）。Run の理由にも1件残す（`#finalize`）。
   *
   * `run.json` の実行の記録（`executions`。設計書 4.8）は、前の回までの記録（再開のときだけ。保存の記録を閉じたものから、環境を除いたもの）に、
   * この実行の分（開始の時刻、`run.json` の `finishedAt` と同じ終わりの時刻、`decideRunExecutionEndReason` の終わり方）を加えたもの。
   *
   * 終わった後（reject した場合も）に、CLI が行う保存の終わり方を決め、`checkpointConclusion()` で返せるようにする（設計書 4.3.2）。
   */
  async run(): Promise<StoredAuditRunResult> {
    this.#checkpointConclusion = null;
    const session: RunSessionStatus = { started: false };
    try {
      const { result, conclusion } = await this.#execute(session);
      this.#checkpointConclusion = conclusion;
      return result;
    } catch (error) {
      // 始められなかった Run（Run のディレクトリ、再開を始められない、再開できない保存）は、セッションを始めていないので `NONE`。
      // 予期しない例外は、セッションを始めていれば `ABANDON`（保存の状態を変えない）、いなければ `NONE`（設計書 4.3.2）。
      this.#checkpointConclusion = isRunUnavailableError(error) || !session.started
        ? NONE_CHECKPOINT_CONCLUSION
        : ABANDON_CHECKPOINT_CONCLUSION;
      throw error;
    }
  }

  /**
   * 最後に終わった `run()` の後に、CLI が行う保存の終わり方を返す（中断した Run の再開の設計書 4.3.2、4.7.1。R4b2）。値は凍結している。
   * - `run()` が Run を返した場合: `decideRunCheckpointConclusion` が決めた終わり方。`FINISH` は、最後の状態の保存（巡回の終わりの値か、
   *   最後に書けた保存の値に、決めた状態、`run.json` の `finishedAt` と同じ保存の時刻、この実行を閉じた実行の記録を加えたもの）を持つ。
   *   巡回の終わりの値が `checkRunCheckpointConsistency` を通らない場合は、最後に書けた保存の値を使い、それもなければ `ABANDON` にする。
   * - `run()` が reject した場合: `RunDirectoryUnavailableError`、`RunResumeUnavailableError`、`RunNotResumableError` なら `NONE`。
   *   予期しない例外なら、保存のセッションを始めていれば `ABANDON`、いなければ `NONE`。
   * `run()` が終わる前（呼ぶ前と、実行の途中）に呼ぶと、`Error` を投げる（呼び出し側の誤り）。
   */
  checkpointConclusion(): RunCoordinatorCheckpointConclusion {
    const conclusion = this.#checkpointConclusion;
    if (conclusion === null) {
      throw new Error('RunCoordinator.checkpointConclusion() requires run() to have finished');
    }
    return conclusion;
  }

  /** `run()` の本体（設計書 5.6.1）。確定した Run と、保存の終わり方を返す。保存のセッションを始めたら、`session.started` を真にする。 */
  async #execute(session: RunSessionStatus): Promise<{
    readonly result: StoredAuditRunResult;
    readonly conclusion: RunCoordinatorCheckpointConclusion;
  }> {
    const config = this.#config;
    const resume = this.#resumeFrom;
    // 再開の入力の保存が、再開できないものなら、何もせずに reject する（呼び出し側の誤り。中断した Run の再開の設計書 3.2）。
    if (resume !== undefined && decideRunResumption(resume.checkpoint) === 'NOT_RESUMABLE') {
      throw new RunNotResumableError({
        runId: resume.checkpoint.runId,
        runDirectory: resume.runDirectory,
        checkpointState: resume.checkpoint.state,
      });
    }
    const saved = resume?.checkpoint;
    // T35R2-fix（T35R2 の M-1）: スクリプトで送るログインの監査の Run の再開は、保存の監査の段の数（上限の数）から数える。数のない保存からは再開しない。
    const auditStageRequests = this.#authentication?.auditStage;
    const resumedCounts = saved === undefined || auditStageRequests === undefined ? undefined : resumedAuditStageCounts(saved.load);
    if (resume !== undefined && resumedCounts === null) {
      throw new RunNotResumableError({
        runId: resume.checkpoint.runId,
        runDirectory: resume.runDirectory,
        checkpointState: resume.checkpoint.state,
        detail: 'AUDIT_STAGE_COUNTS_MISSING',
      });
    }
    // 前の回までの実行の記録（設計書 4.8。再開のときだけ。新しい Run では空）。保存の記録のうち、前の回のプロセスが途中で終わった実行
    // （終わり方が `null`）を、終わり方 `INTERRUPTED_ABNORMALLY`、終わりの時刻を保存の時刻にして閉じたもの（R4b1）。ここで1回だけ作り、
    // 保存の実行の記録（環境付き）と、`run.json` の実行の記録（環境を除く）の両方に使う。
    const previousExecutions: readonly RunCheckpointExecution[] = saved === undefined
      ? []
      : closeInterruptedRunExecutions(saved.executions, saved.savedAt);
    const previousRunExecutions = previousExecutions.map(runExecutionRecord);
    // この実行の開始の時刻（`now()` で1回だけ読む）。実行時間の上限は、新しい Run でも再開のときでも、ここから数える（設計書 4.6）。再開のときは、
    // pacer の最後の読み込みの開始の時刻にも使う（下の `resumedNavigationPacerRecord`。設計書 4.9）。
    const startedAtMs = this.#now();
    // 設定の間隔が不正なら、ここで `RangeError` を投げる（Run のディレクトリを作る前、Browser を起動する前）。再開のときは、pacer と meter を
    // 保存の負荷の記録から続ける（中断した Run の再開の設計書 4.9）。pacer の最後の読み込みの開始の時刻は、保存の値と、この実行の開始の時刻の
    // 遅い方にする（再開の直後の最初の読み込みも、前の回の実際の最後の読み込みから、最小の間隔以上空ける。RR の Minor-1。R7b）。
    // CCX-22: 外から pacer を渡された新しい Run は、その pacer を使う（記録は、ここからの差だけを数える）。自分の pacer も作るのは、設定の間隔の
    // 確かめ（`RangeError`）を、外から渡したときも同じ時点で行うため。再開のときは、外の pacer を使わない（`navigationPacer` の依存の説明）。
    const ownNavigationPacer = createNavigationPacer({
      minIntervalMs: config.crawl.minNavigationIntervalMs,
      now: this.#now,
      sleep: this.#sleep,
      ...(saved === undefined ? {} : { initial: resumedNavigationPacerRecord(saved.load.pacer, startedAtMs) }),
    });
    // FM2R の C-1: 上げた最小の間隔を覚える（まとめて実行の次の段へ持ち越す。再開のときも同じ）。
    const intervalTracking = intervalTrackingNavigationPacer(
      this.#externalNavigationPacer !== null && saved === undefined
        ? runScopedNavigationPacer(this.#externalNavigationPacer)
        : ownNavigationPacer,
      config.crawl.minNavigationIntervalMs,
    );
    const intervalPacer = intervalTracking.pacer;
    // T35c（Task 35 の設計書 3.4）: スクリプトで送るログインの監査の Run だけ、この実行の監査の段の部品を作り、負荷の部品に承認したサービスの Origin の
    // 区分を持たせる（再開のときは、保存の区分と数から続ける。上限の数は、保存と負荷の記録の大きい方から。T35R2-fix）。
    const auditStage = auditStageRequests === undefined
      ? null
      // FM2d: まとめて実行の段なら、前の段の 1 分の窓から始める（持ち越しがなければ空。今のまま）。
      : createAuditStageRunState(this.#now, resumedCounts ?? undefined, this.#stageCarry?.serviceRequestWindowMs ?? []);
    // DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md` 2.2、2.4）: 監査の段の口がある Run だけ、承認したサービスの Origin への要求の
    // 1 分あたりの上限で、次の読み込み（ページ・ビューポート・幅）の前に待つ（発見・READ の確かめと共用する部品。待ちは注入した `sleep`。待つたびに
    // 知らせる）。口がなければ、今の pacer のまま。
    const navigationPacer = serviceRequestPacedNavigationPacer(intervalPacer, auditStage, this.#sleep, (notice) => this.#notify(notice));
    const loadMeter = createLoadMeter({
      allowedOrigins: config.site.allowedOrigins,
      now: this.#now,
      ...(saved === undefined ? {} : { initial: saved.load.meter }),
      ...(auditStageRequests === undefined
        ? {}
        : {
          approvedServiceOrigins: auditStageRequests.approvedServiceOrigins,
          ...(saved?.load.approvedServiceOrigins === undefined ? {} : { initialServiceOriginRequests: saved.load.approvedServiceOrigins }),
        }),
    });
    // Run 全体のリソースのキャッシュ（設計書 4.6）。Run（再開のときは、この実行）ごとに空から始め、終わりに捨てる（ファイルには書かない）。
    const resourceCache = new ResourceCache();
    // この実行の開始の時刻（時計）。再開のときは、Run の ID、BeakSight の版、Run の開始の時刻（最初の実行の開始）は、保存のものを使う。
    const executionStartedAt = this.#clock();
    // DEF-281: 新しい Run の ID は、下の 1. で Run のディレクトリを作るときに決め直す（同じ秒の名前がすでにあれば 2 桁の連番を足す）。
    let runId = saved === undefined ? createRunIdFromTime(executionStartedAt) : saved.runId;
    const executionStartedAtIso = executionStartedAt.toISOString();
    const runStartedAt = saved === undefined ? executionStartedAtIso : saved.startedAt;
    const toolVersion = saved === undefined ? await this.#readToolVersion() : saved.toolVersion;

    const progress: RunProgress = {
      // 再開のときは、理由、再試行の記録、違反のフラグ、未処理の失敗の件数、保存した Safety Ledger の snapshot、終わったページの結果と
      // 再試行の前の Evidence を、保存から作り直す（`restoredRunProgress`）。PREFLIGHT の失敗と Guard の有無は、この実行の PREFLIGHT で決める。
      ...await restoredRunProgress(resume),
      safetyLedgers: [],
      pageLedgerStart: 0,
      navigationPacer,
      loadMeter,
      auditStage,
      maxRuntimeExceeded: false,
      siteUnavailableDetail: null,
      authSessionLostDetail: null,
      authSessionLoss: null,
      executionComplete: false,
      preflightFailed: false,
      guardEnabled: false,
      // 再開のときは、採番器、巡回の記録、開始の URL、robots.txt と sitemap.xml の Evidence も、ここで（PREFLIGHT の前に、PREFLIGHT の結果に
      // よらず）保存から作り直す（`restoredCrawlProgress`。設計書 4.10 の DEF-022）。新しい Run では、`#crawl` が作る。
      ...restoredCrawlProgress(config, saved, this.#pageScope !== null),
    };

    // この Run の Ledger は、すべて、この factory で作る（PREFLIGHT が作る Context の factory も、これを使う）。作った Ledger は、
    // 登録に加える（設計書 5.6.5）。
    const createSafetyLedger: SafetyLedgerFactory = () => {
      const ledger = this.#createSafetyLedger();
      progress.safetyLedgers.push(ledger);
      return ledger;
    };

    // 1. Run のディレクトリ。新しい Run では、排他的に作る（DEF-009）。PREFLIGHT と、対象のサイトへのアクセスの前である。再開のときは、
    // 前の回の Run のディレクトリを使う（作らない）。
    let created: RunArtifactDirectoryCreation | null = null;
    let runDirectory: string;
    let checkpointStartFailure: IncompleteReason | null = null;
    if (resume === undefined) {
      const start = await createRunArtifactDirectoryForStart(this.#outputDirectory, runId);
      ({ runId } = start);
      created = start;
      runDirectory = created.runDirectory;
      // 1a. 保存のセッションを、作った Run のディレクトリで始める（中断した Run の再開の設計書 4.3.1）。
      checkpointStartFailure = created.ok ? await this.#startCheckpointSession(runDirectory) : null;
      session.started = created.ok && checkpointStartFailure === null && this.#checkpointSession !== undefined;
    } else {
      runDirectory = resume.runDirectory;
      // 1a. 保存のセッションを、再開の始め方で始める（設計書 4.4、4.5）。始められなければ、PREFLIGHT も Browser の起動もせず、Run を確定
      // せずに、`RunResumeUnavailableError` で reject する。
      await this.#resumeCheckpointSession(resume, runId);
      session.started = true;
    }
    const directoryFailure = created !== null && !created.ok ? created : null;
    // DBG-1: 測りの記録（入切は Run の始めに 1 回読む。入のときだけ。Run のディレクトリを作れたときだけ書く。Run の終わりにまとめて書く）。
    const debugTimingOn = directoryFailure === null && this.#debugTimingSwitch !== undefined && await this.#debugTimingSwitch().catch(() => false);
    this.#debugTimingLog = createDebugTimingLog({ enabled: debugTimingOn, directory: runDirectory, now: this.#now });

    // 2. PREFLIGHT。PREFLIGHT の Ledger は、上の factory で作るので、登録にある（`safetyLedgers` は集計に使わない）。
    // Run のディレクトリを作れなかった場合と、保存のセッションを始められなかった場合は、PREFLIGHT を行わない（Browser を起動しない）。
    // 扱いは、PREFLIGHT の失敗と同じである。
    const preflight = directoryFailure === null && checkpointStartFailure === null
      ? await this.#runPreflight({
        config,
        launchBrowser: this.#launchBrowser,
        ...(this.#browserLease === undefined ? {} : { browserLease: this.#browserLease }),
        createSafetyLedger,
        outputDirectory: runDirectory,
        deadlines: { ...this.#deadlines, browserCloseTimeoutMs: this.#browserCloseTimeoutMs },
        // Run のすべての Context の要求の終わりの事象を、この Run の meter に渡させる（設計書 4.5。PREFLIGHT は中身を見ない）。
        // 応答は、この Run のキャッシュに渡させ、読み込み直しの Context では、キャッシュから返させる（設計書 4.6、4.7）。
        contextFactoryOptions: {
          // RB-4 fix（REV-RB4 の C-1）: 監査の PRIMARY は凍結しないので、観察の口を付けない（Worker の中のリアルタイムの通信を止めない）。
          pageAuditRun: true,
          loadMeter,
          resourceCache,
          // DEF-100 fix: Run の pacer に、Guard が main frame の文書の要求を送った時刻を記録させる（サイトに届く間隔を設定以上にする）。
          navigationPacer,
          // DEF-245: Guard が閉じるときの作業の待ちにも、同じ見張りの長さを渡す（省略は本番の長さ）。
          ...(this.#progressWatchQuietLimitMs === undefined ? {} : { progressWatchQuietLimitMs: this.#progressWatchQuietLimitMs }),
          // RB-2: 観察の窓の一式の注入（テストだけ。省略は本番の値）。
          ...(this.#observationWindows === undefined ? {} : { observationWindows: this.#observationWindows }),
          // T25c: 認証つきの Run だけ、状態の注入と Guard の監査の段の除外を、factory に渡す（Task 25 の設計書 4.3）。
          ...(this.#authentication === null ? {} : { authentication: authenticatedContextOptions(this.#authentication) }),
          // T35c: スクリプトで送るログインの監査の Run だけ、上限の部品、監査の段の記録、401 と鍵の消失の知らせを、factory に渡す。
          ...(auditStage === null ? {} : auditStageFactoryOptions(auditStage)),
          // AS-b: 監査の段の送信の扱いが `PASS_EXCEPT_DELETE` のときだけ、口を渡す（承認したサービスの Origin は、認証つきならプロファイルのもの、公開の監査なら空）。
          ...auditSendOptionsOf(config, this.#authentication?.approvedTestOrigins ?? []),
        },
      })
      : null;
    const browser: Browser | null = preflight?.ok === true ? preflight.browser : null;
    const factory: BrowserContextFactory | null = preflight?.ok === true ? preflight.factory : null;
    if (directoryFailure !== null) {
      progress.preflightFailed = true;
      progress.reasons.push(runDirectoryUnavailableReason(directoryFailure.error));
    } else if (checkpointStartFailure !== null) {
      // 何も監査しておらず、Run のディレクトリを作れなかった場合と同じく、基盤の失敗である。Run Status は、既存の入力
      // `preflightFailed` から、`deriveRunStatus` が `FAILED` と導く（ARCH05。ここでは決めない）。
      progress.preflightFailed = true;
      progress.reasons.push(checkpointStartFailure);
    } else if (preflight?.ok === false) {
      progress.preflightFailed = true;
      progress.reasons.push(preflight.reason);
    } else {
      progress.guardEnabled = true;
    }

    let environment: RunEnvironment;
    // 巡回の結果（巡回を始めなかった場合は `null`）と、巡回の終わりの状態の保存の中身（保存のセッションを始めた場合だけ。設計書 4.3.2）。
    let crawl: RunCrawlOutcome | null = null;
    let crawlEndContent: RunCheckpointContentValues | null = null;
    try {
      // 3. 環境の事実。PREFLIGHT が失敗した場合も、Browser なしで集める。
      environment = await this.#collectRunEnvironment({
        config,
        browser,
        factory,
        // この Ledger は、Context の factory が作ったもので、すでに登録にある（Safety の集計は、登録からだけ行う）。
        onSafetyLedger: () => undefined,
        // 閉じる処理の失敗（期限切れを含む）は、Run の理由にする（RP18 の指摘1。Context が閉じたことを確かめられていないため、
        // Run は `COMPLETE` にならない。Task 18 の前の整理の設計書 4.2）。
        // 失敗は Context を閉じる処理のものだけ（page は個別に閉じない。DEF-038。CCX-23 で page の場面の名前を消した）。
        onCloseFailure: ({ error }) => {
          progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.environmentContextClose, error));
        },
        deadlines: this.#deadlines,
      });
      if (browser !== null && factory !== null) {
        const checkpointSession = this.#checkpointSession;
        // 保存のセッションは、ここに来た時点で始まっている（始められなかった場合は、PREFLIGHT を行わず、Browser もない）。
        // 実行の記録は、前の回までの記録（再開のとき。前の回のプロセスが途中で終わった実行は、閉じたもの。R4b1）に、この実行の分を
        // 1件加えたもの（設計書 4.8）。この実行の分の終わりの時刻と終わり方は、実行の途中なので `null`（最後の状態の保存で決める）。
        const execution: RunCheckpointExecution = {
          startedAt: executionStartedAtIso, finishedAt: null, endReason: null, environment, ...this.#automaticReloginPart(),
        };
        const checkpoint: RunCheckpointContext | null = checkpointSession === undefined
          ? null
          : {
            session: checkpointSession,
            runId,
            toolVersion,
            startedAt: runStartedAt,
            executions: executionsEndingWith(previousExecutions, execution),
            authentication: this.#checkpointAuthentication,
            pageScope: this.#pageScopePart().pageScope ?? null,
          };
        crawl = await this.#crawl(factory, runDirectory, startedAtMs, progress, checkpoint, saved ?? null, runId);
        crawlEndContent = crawl.crawlEndContent;
      } else {
        // 巡回を始めなかった（PREFLIGHT の失敗など）。
        // 再開した実行（PREFLIGHT に失敗した。保存のセッションを始められなかった場合は、PREFLIGHT の前に reject している）では、PREFLIGHT の前に
        // 保存から作り直した巡回の記録の、残りの URL（待ち行列のもの。保存の時点で待ち行列に戻したものを含む）を、理由 `PREFLIGHT_FAILED` の
        // SKIPPED にする（設計書 4.10 の DEF-022）。前の回までに終わったページの結果（`restoredRunProgress`）は、そのまま、この実行の出力に入る。
        const restoredCrawl: RunCrawlRecord | null = saved === undefined || progress.frontier === null || progress.allocator === null
          ? null
          : {
            frontier: progress.frontier,
            allocator: progress.allocator,
            pagesStarted: saved.progress.pagesStarted,
            outsidePageSnapshots: outsidePageLedgerSnapshots(saved.safetyLedgerSnapshots, progress.safetyLedgers, new Set()),
            completedPageIds: saved.completedPageIds,
            revisitedPageIds: saved.revisitedPageIds ?? [],
          };
        if (restoredCrawl !== null) {
          for (const entry of restoredCrawl.frontier.drain()) {
            restoredCrawl.frontier.markSkipped(entry.url, PREFLIGHT_FAILED_SKIP_REASON);
          }
        }
        if (session.started) {
          // この時点（Browser を閉じる前）の中身を写す（設計書 4.3.2）。再開した実行では、作り直した巡回の記録（残りを SKIPPED にした後）、
          // 採番器、保存の監査を始めたページの数と終わったページの ID、ページの外の Ledger の snapshot（保存のものと、この実行のもの）、保存の
          // robots.txt と sitemap.xml の Evidence。新しい Run では、巡回の記録は空、採番器は新しい採番器の値、終わったページはなし、
          // robots.txt と sitemap.xml はなし、ページの外の Ledger は、この実行のすべての Ledger にした中身。
          crawlEndContent = runCheckpointContent({
            config,
            identity: {
              runId, toolVersion, startedAt: runStartedAt, authentication: this.#checkpointAuthentication, pageScope: this.#pageScopePart().pageScope ?? null,
            },
            progress,
            crawl: restoredCrawl,
          });
        }
      }
    } finally {
      // DEF-143: ここから「Run の終わり」の段（Browser を閉じる処理、集計、CLI が行う成果物の書き出し、止めたときの片付け）。入る前に 1 回だけ知らせる。
      this.#notifyFinalizing();
      // 7. Browser を閉じる（RB-5: lease から借りた Browser は返す）。閉じる処理の失敗と、期限（`BROWSER_CLOSE_TIMEOUT_MS`）を過ぎたことは、Run の理由にする（R15 の Minor-2）。
      if (preflight?.ok === true) {
        const closeFailure = await endPreflightBrowser(preflight, { timeoutMs: this.#browserCloseTimeoutMs });
        if (closeFailure !== null) {
          progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.browserClose, closeFailure.error));
        }
      }
      // FM2d: まとめて実行の段の持ち越し（Browser を閉じた後、成果物を書く前に 1 回。メモリの中だけ。受け手の例外で Run を止めない）。
      // FM2R の C-1: 読み込みの間隔も持ち越す（再開の Run は外の pacer を使わないので、次の段は、この値から待つ）。
      recordRunStageCarry(this.#stageCarry, factory, auditStage, {
        pacer: navigationPacer, minIntervalMs: intervalTracking.minIntervalMs(), now: this.#now,
      });
      // DBG-1: 測りの記録を、段（Run）の終わりにまとめて書く（切なら何もしない）。
      await this.#debugTimingLog.flush();
    }

    // `run.json` の環境は、最初の実行のもの（中断した Run の再開の設計書 4.8。版が同じでなければ再開しないので、主な値は変わらない）。
    const finalized = await this.#finalize({
      runId,
      toolVersion,
      startedAt: runStartedAt,
      environment: saved === undefined ? environment : saved.executions[0].environment,
      progress,
      previousExecutions: previousRunExecutions,
      executionStartedAt: executionStartedAtIso,
      automaticRelogin: this.#automaticRelogin,
    });
    const { result } = finalized;
    if (directoryFailure !== null) {
      throw new RunDirectoryUnavailableError({
        result,
        runDirectory,
        alreadyExists: directoryFailure.alreadyExists,
        cause: directoryFailure.error,
      });
    }
    // Run の後の保存の終わり方（設計書 4.3.2）。最後に書けた保存は、この実行で書けた値か、再開の入力の保存。
    const conclusion = checkpointConclusionOf({
      sessionStarted: session.started,
      resumed: resume !== undefined,
      finalized,
      checkpointWriteFailed: crawl?.checkpointWriteFailed ?? false,
      lastWrittenCheckpoint: crawl === null ? saved ?? null : crawl.lastWrittenCheckpoint,
      crawlEndContent,
      previousExecutions,
      environment,
    });
    return { result, conclusion };
  }

  /**
   * 設計書 5.6.1 の手順4〜6（採番器、metadata、BFS、再試行）。予期しない例外は、数えて、クロールを止める。
   * 再開のとき（`saved` が保存の値）は、PREFLIGHT の前に保存から作り直した採番器、巡回の記録、開始の URL、robots.txt と sitemap.xml の
   * Evidence（`progress` の値。`restoredCrawlProgress`）を使い、監査を始めたページの数と、保存の続き（終わったページの ID、ページの外の
   * Ledger の snapshot）を、保存から作り直して、続きから巡回する（中断した Run の再開の設計書 4.1、4.2、4.10 の DEF-022）。
   * 止める印が付いていれば、次のページを始めず、残りの URL を理由 `RUN_INTERRUPTED` の SKIPPED にする（設計書 4.6.1）。
   * ページの結果にサイトの不調の印があれば（サイトが応答しないときに Run を止める設計書 3.2、3.2.1）、そのページの Ledger に違反がない限り、
   * この実行の不調の詳細（`progress.siteUnavailableDetail`）を残して、次のページを始めず、残りの URL を理由 `SITE_UNAVAILABLE`（`detail` は
   * `null`）の SKIPPED にする。不調のページは、前の実行のきっかけのページ（`saved` の巡回の記録で、理由 `SITE_UNAVAILABLE` の `detail` のある
   * SKIPPED）でなければ捨てて、理由 `SITE_UNAVAILABLE`（`detail` は不調の詳細）の SKIPPED にし、状態だけを保存する。前の実行のきっかけの
   * ページなら、普通の結果として保存する。
   * robots.txt と sitemap.xml の取得の観測でサイトの不調を検知したら（設計書 3.1、3.2.1 の最後の項目）、包んだ間隔の待ちで sitemap.xml を
   * 読み込ませない。Run の初めからの Ledger に違反がなければ、この実行の不調の詳細を残し、ページの監査を始めずに、開始の URL を含む残りの
   * URL を理由 `SITE_UNAVAILABLE`（`detail` は `null`）の SKIPPED にする。取得の結果は、前の実行がこの段階で止まっていなければ残さず（取得の
   * 後の状態の保存の `siteMetadata` は `null` になり、再開のときに取得し直す）、止まっていれば残す（保存し、次の再開では取得し直さない）。
   * 保存のセッションがあれば、巡回の終わり（残りの URL を SKIPPED にした後。例外で止まった経路でも、SKIPPED にした後）の値を、最後の
   * 状態の保存の中身として写して返す（設計書 4.3.2。R4b2）。この後の Browser を閉じる処理と `#finalize` で加わる理由、件数、Finding の
   * ID の採番は、中身に入らない。`runId` は、ロックの確かめに使う。
   * 不調のページを捨てた後、その実行でそのページを確かめ直した回数が上限（`SITE_UNAVAILABLE_RECHECK_DELAYS_MS` の数）に達していなければ、
   * 知らせてから次の段階の待ち（60 秒、2 分、4 分、8 分）で待ち（止める印で打ち切る）、待った後に止める印がなく、実行時間の上限にも達して
   * いなければ、同じページ（同じ `pageId`）を監査し直す（サイトが応答しないときに Run を止める設計書 3.5.2、3.6.2。`#waitBeforeRecheck`）。
   * 確かめ直しで不調がなければ、Run で 1 つの pacer の最小の間隔を上げて（減速。`SITE_UNAVAILABLE_SLOWDOWN_FACTOR` 倍。上限は設定の
   * `SITE_UNAVAILABLE_SLOWDOWN_MAX_FACTOR` 倍。この実行の間だけ）、通常どおり保存して進む。最後の確かめ直しも不調なら今までどおり止める
   * （不調の詳細は最後の試行のもの）。前の実行のきっかけのページは、確かめ直さない。
   */
  async #crawl(
    factory: BrowserContextFactory,
    runDirectory: string,
    startedAtMs: number,
    progress: RunProgress,
    checkpoint: RunCheckpointContext | null,
    saved: RunCheckpoint | null,
    runId: RunId,
  ): Promise<RunCrawlOutcome> {
    const config = this.#config;
    // L14 の後の段（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.1）: Run の時間とページの数の上限は、利用者が指定したときだけ確かめる。
    const { maxRuntimeMs, maxPages } = config.crawl;
    const runtimeLimitReached = (): boolean => maxRuntimeMs !== undefined && this.#now() - startedAtMs >= maxRuntimeMs;
    // 巡回の候補から外す URL の判定（T25c）。Link の候補と、robots.txt と sitemap.xml の取得の両方に、同じ判定を使う（T25c round 3）。
    // SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.3）: 公開監査にも、巡回の移る先の URL の語（`crawlUrlHasDestructiveWord`）を
    // 当てる（認証つきの Run は `isExcludedCrawlCandidate` の中で当てる）。
    const crawlAllowedOrigins: ReadonlySet<string> = new Set(config.site.allowedOrigins);
    const runAuthentication = this.#authentication;
    const excludedCrawlCandidate = excludedCrawlCandidateOf(config, runAuthentication);
    // 保存（中断した Run の再開の設計書 4.1、4.3）。保存のセッションがなければ、何もしない。保存に1回失敗したら、それより後は
    // 保存しない（新しいページも始めない）。終わったページの ID は、終わった順に並べる。ページの中で作った Ledger の snapshot は、
    // そのページの保存に入れ、状態の保存には、ページの外で作った Ledger の snapshot だけを入れる。
    // 再開のときは、監査を始めたページの数、終わったページの ID、ページの外の Ledger の snapshot を、保存した分から続ける（次の保存で、
    // 前の回の分が消えないようにする）。この実行のページの中の Ledger は、`pageLedgers` で区別する。
    let pagesStarted = saved?.progress.pagesStarted ?? 0;
    const pageLimitReached = (): boolean => maxPages !== undefined && pagesStarted >= maxPages;
    let checkpointFailed = false;
    // 最後に書けた状態の保存（設計書 4.3.2。この実行で書けた値。書けていなければ、再開の入力の保存）。
    let lastWritten: RunCheckpoint | null = saved;
    const completedPageIds: PageId[] = [...(saved?.completedPageIds ?? [])];
    // EV-5: 時間切れの後の再開で読み直しを終えたページ（前の回までの分から続ける。後の再開では読み直さない）。
    const revisitedPageIds: PageId[] = [...(saved?.revisitedPageIds ?? [])];
    const savedOutsidePageSnapshots: readonly SafetyLedgerSnapshot[] = saved?.safetyLedgerSnapshots ?? [];
    const pageLedgers = new Set<SafetyLedger>();
    const outsidePageSnapshots = (): SafetyLedgerSnapshot[] =>
      outsidePageLedgerSnapshots(savedOutsidePageSnapshots, progress.safetyLedgers, pageLedgers);
    // 前の実行で止まるきっかけになったページの URL（サイトが応答しないときに Run を止める設計書 3.2.1）。実行の初めに1回だけ、再開の入力の
    // 保存の巡回の記録から読み取る（`restoredCrawlProgress` で待ち行列に戻した後の巡回の記録ではなく、保存の値を見る）。新しい Run では空。
    const previousTriggerUrls = siteUnavailableTriggerUrlsOf(saved);
    // 前の実行が、robots.txt と sitemap.xml の段階で、サイトの不調で止まったか（設計書 3.2.1 の最後の項目）。実行の初めに1回だけ、再開の入力の
    // 保存から決める。新しい Run では偽。
    const previousStoppedAtSiteMetadata = stoppedAtSiteMetadataBefore(saved);
    try {
      // 開始の URL（再開のときは、PREFLIGHT の前に作った値。`restoredCrawlProgress`）。
      // WSO: 「チェックした画面だけ」の点検は、開始の URL の代わりに、範囲の画面のうち読めるもの（許可 Origin の中で、巡回の候補の除外に当たらないもの。
      // `readablePageScope`）を渡した順に入れる（最初の画面に robots.txt の Evidence を置く）。読めるものが 1 つもなければ、開始の URL を読まずに Run の失敗にする。
      const scopeSeeds = this.#pageScope;
      if (saved === null && scopeSeeds !== null && scopeSeeds.length === 0) {
        throw new Error('no screen of the page scope can be read');
      }
      const startUrl = progress.startUrl ?? scopeSeeds?.[0] ?? normalizedStartUrl(config);
      progress.startUrl = startUrl;

      // 4. 採番器を作り、開始の URL のページの ID を採番する（metadata の取得の前）。再開のときは、PREFLIGHT の前に保存から作り直した採番器と
      // 巡回の記録を使う（`restoredCrawlProgress`。監査の途中だった URL と、待ち行列に戻す理由の SKIPPED の URL は、`QUEUED` に戻っている。
      // 設計書 3.2、4.2、4.10 の DEF-022）。
      const allocator = progress.allocator ?? new IdAllocator();
      progress.allocator = allocator;
      const frontier = progress.frontier ?? new CrawlFrontier(config.crawl.maxDepth, allocator);
      progress.frontier = frontier;
      if (saved === null) {
        for (const url of scopeSeeds ?? [startUrl]) {
          frontier.discover(url, 0);
        }
      }
      const [startEntry] = frontier.entries();
      if (startEntry === undefined) {
        throw new Error('start URL was not discovered');
      }

      // 5. robots.txt と sitemap.xml。違反（PREFLIGHT や環境の事実の Ledger など）を検出した後は、対象のサイトへの新しいアクセスなので、
      // 取得を始めない（Task 19 の前の整理の設計書 4.5）。始めなかったことは Run の理由に残し、metadata の Evidence は作らない
      // （sitemap がないものとして、Cross-page rule は sitemap の判定をしない）。
      // 再開のときは、取得し直さない。保存に Evidence があれば、PREFLIGHT の前に、そこから作り直してある（`restoredCrawlProgress`。閉じる処理の
      // 失敗などの理由は、保存の理由にある）。前の回が、違反のため取得を始めなかった場合は、そのことが保存の理由にあるので、理由も加えない
      // （中断しなかった場合と同じ理由にする）。どちらでもない保存のときだけ、今の決まりのとおり取得する（取得でサイトの不調を検知し、
      // 取得の結果を残さずに止まった保存も、ここで取得し直す。サイトが応答しないときに Run を止める設計書 3.1）。
      if (saved !== null && saved.siteMetadata !== null) {
        // 保存の Evidence から作り直してある。
      } else if (saved !== null && saved.progress.reasons.some(isSiteMetadataSafetyAbortReason)) {
        // 前の回が、違反のため取得を始めず、Run の理由に記録した（Evidence は作らない）。
      } else if (this.#safetyViolationRecorded(progress, 0)) {
        progress.reasons.push(SITE_METADATA_SAFETY_ABORT_REASON);
      } else {
        // 各ファイルの読み込みの観測で、サイトの不調を判定し、最初の不調を残す。不調を残した後は、次のファイル（sitemap.xml）の前の待ちが、
        // 待たずに例外を投げ、読み込ませない（サイトが応答しないときに Run を止める設計書 3.1）。
        const hooks = siteMetadataNavigationHooks(progress.navigationPacer);
        const metadata = await this.#collectSiteMetadata({
          contextFactory: factory,
          origin: new URL(startUrl).origin,
          config,
          pageId: startEntry.pageId,
          allocator,
          clock: this.#clock,
          deadlines: this.#deadlines,
          // 各ファイルの読み込みの前に、Run で1つの pacer で間隔を守る（サイトへの負荷の制御の設計書 4.1）。不調を残した後は、待たない。
          beforeNavigation: hooks.beforeNavigation,
          afterNavigation: hooks.afterNavigation,
          ...(this.#progressWatchQuietLimitMs === undefined ? {} : { quietLimitMs: this.#progressWatchQuietLimitMs }),
          // T25c round 3: 巡回の候補と同じ判定で除外に当たるファイルを取りに行かない（Evidence は `EXCLUDED`）。
          isExcludedUrl: excludedCrawlCandidate,
          // WSO（REV-WSO の I-2）: 「チェックした画面だけ」の点検は、sitemap.xml を取りに行かない（サイトの全部を巡回しないので、比べない）。
          skipSitemap: this.#pageScope !== null,
        });
        // metadata の取得の Ledger は、Context の factory が作ったもので、すでに登録にある（`ledgerSnapshot` は集計に使わない）。
        // サイトの不調を検知し、Run の初めからの Ledger に違反がなければ、この実行の不調の詳細を残す（次のページを始めない。設計書 3.2）。
        // 違反があれば、今のとおり違反で止める（不調の詳細を残さない。違反の優先）。不調の詳細を残した場合、取得の結果は、前の実行がこの
        // 段階で止まっていなければ残さず（保存の `siteMetadata` を `null` にし、再開のときに取得し直す）、止まっていれば今のとおり残す
        // （保存し、次の再開では取得し直さない。同じ段階で止まり続けないため。設計書 3.2.1 の最後の項目）。
        const unavailableDetail = hooks.unavailableDetail();
        if (unavailableDetail !== null && !this.#detectSafetyViolation(progress, 0)) {
          progress.siteUnavailableDetail ??= unavailableDetail;
          if (previousStoppedAtSiteMetadata) {
            progress.metadata = metadata;
          }
        } else {
          progress.metadata = metadata;
        }
        // 失敗は Context を閉じる処理のものだけ（page は個別に閉じない。DEF-038。CCX-23 で page の場面の名前を消した）。
        for (const { error } of metadata.closeFailures) {
          progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.metadataContextClose, error));
        }
      }

      const saveState = async (context: RunCheckpointContext): Promise<void> => {
        checkpointFailed = !await this.#requestCheckpoint(progress, async () => {
          const state = runCheckpointState({
            config,
            checkpoint: context,
            // 保存の時刻は、その値を作る時点の時計の値（R4b1。設計書 4.1）。
            savedAt: this.#clock().toISOString(),
            progress,
            crawl: { frontier, allocator, pagesStarted, outsidePageSnapshots: outsidePageSnapshots(), completedPageIds, revisitedPageIds },
          });
          await context.session.saveState(state);
          lastWritten = state;
        });
      };
      // 5a. robots.txt と sitemap.xml の後の、状態の保存（新しい Run では、終わったページはない。再開のときは、この実行の記録を加えた保存）。
      if (checkpoint !== null) {
        // 保存の前に、Run の初めからのすべての Ledger（この実行の PREFLIGHT、環境の記録、取得のものと、保存した snapshot。どれも閉じて
        // いる）を調べ、保存の「違反の検出」のフラグに、それらの違反を含める（中断した Run の再開の設計書 4.2。R5-fix-round-1）。取得した
        // 場合も、保存から作り直した場合も、前の回が違反で取得を始めなかった場合も、ここで1回調べる（再開した実行で、保存から作り直した
        // 場合も、この実行の PREFLIGHT と環境の記録の違反が、この保存のフラグに入る）。ここでは監査を止めないので、止めたことは記録しない
        // （残りの URL は、最初のページを始める前の確かめで止める）。
        this.#detectSafetyViolation(progress, 0);
        await saveState(checkpoint);
      }

      // DUP（設計書 `2026-11-18-beaksight-same-structure-pages-design.md` 2 章）: 同じ作りの画面の口。1 回目の表は巡回の記録（checkpoint に残る）。今のページの
      // 答え方（読み直しは前の深さのまま）と、Page Auditor が知らせた深さは、ページを始めるたびに戻す。チェックした画面だけの点検（WSO）では渡さない。
      const samenessTable: PageSamenessAnswers = {
        referenceOf: (templateKey) => frontier.pageReferenceOf(templateKey),
        sameContentAs: (templateKey, contentDigest) => frontier.samePageOf(templateKey, contentDigest),
      };
      const pageSameness = { answers: samenessTable, decision: null as PageSamenessDecision | null };
      const samenessPort: PageSamenessPort | undefined = this.#pageScope !== null ? undefined : {
        referenceOf: (templateKey) => pageSameness.answers.referenceOf(templateKey),
        sameContentAs: (templateKey, contentDigest) => pageSameness.answers.sameContentAs(templateKey, contentDigest),
        decided: (decision) => {
          pageSameness.decision = decision;
        },
      };
      // 6. BFS。
      const auditor = this.#createPageAuditor({
        contextFactory: factory,
        config,
        allocator,
        clock: this.#clock,
        now: this.#now,
        screenshotRootDirectory: runDirectory,
        deadlines: this.#deadlines,
        // metadata の取得と同じ、Run で1つの pacer（サイトへの負荷の制御の設計書 4.1）。
        navigationPacer: progress.navigationPacer,
        ...(this.#progressWatchQuietLimitMs === undefined ? {} : { progressWatchQuietLimitMs: this.#progressWatchQuietLimitMs }),
        ...(this.#observationWindows === undefined ? {} : { observationWindows: this.#observationWindows }),
        // DBG-1: 測りの記録（入のときだけ渡す）。
        ...(this.#debugTimingLog.enabled ? { debugTiming: this.#debugTimingLog } : {}),
        // L0: Run の時間の上限（`maxRuntimeMs`。この実行の開始から）を、ページの途中でも効かせる。
        // L14 の後の段: 指定がなければ期限なし（進みの見張りで待つ）。
        ...(maxRuntimeMs === undefined ? {} : { runDeadlineAtMs: startedAtMs + maxRuntimeMs }),
        // ページの中（次のビューポート、幅の走査の次の幅、Interaction の次の候補の前）の確かめ。今のページで作った Ledger を調べる
        // （それより前の Ledger は、ページを始める前に調べた）。
        safetyViolationRecorded: () => this.#safetyViolationRecorded(progress, progress.pageLedgerStart),
        // DEF-236 の修正: 次の読み込みの前に見せたまま待つかを決める確かめ。同じ Ledger を調べるが、止めたことは記録しない。
        safetyViolationDetected: () => this.#detectSafetyViolation(progress, progress.pageLedgerStart),
        // COV-4 の区切り 3: 開いた状態の構造の鍵を、Run の巡回の記録（checkpoint に残る）で 1 回だけ受け付ける。
        acceptOpenedStructure: (structureKey) => frontier.acceptOpenedStructure(structureKey),
        // COV-4 の区切り 3（入れ子の開いた状態）: 開いた状態の中で押した組も、巡回の記録（checkpoint に残る）で 1 回だけ受け付ける。
        acceptOpenedPress: (press) => frontier.acceptOpenedPress(press),
        ...(samenessPort === undefined ? {} : { pageSameness: samenessPort }),
        // T25c: 認証つきの Run だけ、セッションの切れを確かめさせる（Task 25 の設計書 4.3）。
        ...(this.#authentication === null ? {} : { sessionLostPathPrefix: this.#authentication.sessionLostPathPrefix }),
        // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 点検の範囲の外へ移った画面は点検しない。
        isOutsideAuditScope: (url: string): boolean => isOutsideRunAuditScope(url, crawlAllowedOrigins, runAuthentication),
        // DEF-138: セッションの切れの証拠の Origin の区別に、承認したサービスの Origin を渡す（スクリプトで送るログインの Run だけ）。
        ...(this.#authentication?.auditStage === undefined ? {} : { approvedServiceOrigins: this.#authentication.auditStage.approvedServiceOrigins }),
      });
      // 新しいページを始めない理由（保存の失敗、サイトの不調、ページ数の上限、実行時間の上限、止める印）。決まった後の URL は、すべてこの
      // 理由の SKIPPED にする。
      let stopReason: IncompleteReason | null = null;
      // 監査を終えたページの数（進み具合の事実。サイトへの負荷の制御の設計書 4.8）。再開のときは、再開の前に終わったページを含める。
      let pagesFinished = saved?.completedPageIds.length ?? 0;
      // 段階的に確かめ直す（サイトが応答しないときに Run を止める設計書 3.5.2、3.6.2）。不調で捨てたページを、待った後にもう 1 回監査する
      // ときは、待ち行列を通さずに、その記録（`recheckEntry`）を次に監査する。URL ごとの確かめ直しの回数（`recheckedUrls`）は、1 つの実行の
      // 中で同じ URL につき `SITE_UNAVAILABLE_RECHECK_DELAYS_MS` の数（4 回）までにするために持つ（最後の確かめ直しの試行でまた不調なら、
      // 今までどおり止める）。
      let recheckEntry: CrawlUrlEntry | null = null;
      const recheckedUrls = new Map<string, number>();
      // この実行の、pacer の今の最小の間隔（設計書 3.6.2。確かめ直しで通るたびに、`SITE_UNAVAILABLE_SLOWDOWN_FACTOR` 倍にする。上限は設定の
      // `SITE_UNAVAILABLE_SLOWDOWN_MAX_FACTOR` 倍）。この実行の間だけで、保存しない（次の起動は設定の値から始める。保存の形を変えないため）。
      // 間隔の意味の owner は pacer のまま（ここは倍率の規則だけを持つ）。
      let slowedMinIntervalMs = config.crawl.minNavigationIntervalMs;
      const slowDownAfterRecheckPassed = (): void => {
        // DEF-136: 倍率と上限の規則は、ジョブと共有する部品（`slowedNavigationIntervalMs`）。
        const raisedMs = slowedNavigationIntervalMs(slowedMinIntervalMs, config.crawl.minNavigationIntervalMs);
        // すでに上限（設定の間隔が 0 なら 0）なら、上げず、知らせも出さない。
        if (raisedMs <= slowedMinIntervalMs) {
          return;
        }
        slowedMinIntervalMs = raisedMs;
        progress.navigationPacer.raiseMinimumInterval(raisedMs);
        this.#notify(Object.freeze({ kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: raisedMs }));
      };
      // EV-5（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 2 章・3.5）: 時間切れで止まった Run を続けるときは、終えたページのうち、一部だけ終わった
      // ページと確かめを待つ指摘のあるページ（`revisitOrderOf` の順。前の回までに読み直しを終えたページは除く）を、まだ見ていないページより先に読み直す。
      // 読み直しは今のページの読み込みと同じ流れ（移動の間隔の守りの中）で、確かめを待つ指摘が減らなくなったら終える（`readAgainAfterRevisit`）。
      const revisitQueue: { readonly entry: CrawlUrlEntry; readonly candidate: RevisitCandidate }[] = saved !== null && resumesAfterRunTimeLimit(saved.executions)
        ? [...revisitOrderOf(frontier.entries()
          .filter(({ state, pageId }) => (state === 'AUDITED' || state === 'FAILED') && !revisitedPageIds.includes(pageId))
          .flatMap((entry) => {
            const candidate = progress.revisits.get(entry.url);
            return candidate === undefined ? [] : [{ entry, candidate, fact: candidate.fact }];
          }))]
        : [];
      // 次に監査する記録と、それが読み直しなら、その候補（ほかは `null`）。
      const nextEntry = (): { readonly entry: CrawlUrlEntry; readonly revisiting: RevisitCandidate | null } | undefined => {
        if (recheckEntry === null) {
          const queued = revisitQueue.shift();
          if (queued !== undefined) {
            return { entry: queued.entry, revisiting: queued.candidate };
          }
          const entry = frontier.next();
          return entry === undefined ? undefined : { entry, revisiting: null };
        }
        const entry = recheckEntry;
        recheckEntry = null;
        return { entry, revisiting: null };
      };
      for (let next = nextEntry(); next !== undefined; next = nextEntry()) {
        // SLIM（設計書 `2026-11-25-beaksight-discovery-input-check-slim-design.md` 2.3 (a)）: 測りの記録を 1 ページごとに書き出す（前のページの行。どの終わり方の
        // ページも次の輪の先頭を通る。最後のページの行は Run の終わりの `flush`。切なら何もしない）。
        await this.#debugTimingLog.flush();
        // EV-5: 読み直すページ（終えたページ）は、止める理由があれば、記録を変えずに飛ばす（前の結果のまま）。ページ数の上限は、新しいページの数なので見ない。
        const { entry, revisiting } = next;
        // この記録を、この実行で何回確かめ直したか（0 なら 1 回目の試行）。1 回以上なら、待った後の確かめ直し（`requeueForRecheck` で
        // `AUDITING` に戻してある）。
        const recheckCount = recheckedUrls.get(entry.url) ?? 0;
        const rechecking = recheckCount > 0;
        // 違反を検出した後は、新しいページを始めない（Task 19 の前の整理の設計書 4.5）。ページを始める前に、Run の間に作ったすべての
        // Ledger を調べる。違反の後の URL は、保存の失敗と上限より先に、理由 `SAFETY_VIOLATION_ABORT` の SKIPPED にする。
        if (stopReason === null && this.#safetyViolationRecorded(progress, 0)) {
          if (revisiting === null) {
            frontier.markSkipped(entry.url, SAFETY_VIOLATION_ABORT_REASON);
          }
          continue;
        }
        // 次のページを始める前に、毎回、保存の失敗（中断した Run の再開の設計書 4.3）、サイトの不調（この実行で不調を検知した。サイトが
        // 応答しないときに Run を止める設計書 3.2）、ページ数、実行時間、止める印（中断した Run の再開の設計書 4.6.1）の順に確かめる（同時に
        // 当てはまる場合は、前のものの理由にする）。止める印は、ここでだけ確かめる（今のページは、再試行を含めて最後まで行う）。
        if (stopReason === null) {
          if (checkpointFailed) {
            stopReason = CHECKPOINT_WRITE_FAILED_SKIP_REASON;
          } else if (progress.siteUnavailableDetail !== null) {
            stopReason = SITE_UNAVAILABLE_SKIP_REASON;
          } else if (progress.authSessionLostDetail !== null) {
            stopReason = AUTH_SESSION_LOST_SKIP_REASON;
            // LZ-3c: 承認したサービスの Origin への要求の上限で次のページを始めない分岐（前の T35c）は、L11 から届かない（上限がない）ので捨てた。
          } else if (revisiting === null && pageLimitReached()) {
            stopReason = crawlLimitReason('MAX_PAGES_REACHED');
          } else if (runtimeLimitReached()) {
            stopReason = crawlLimitReason('MAX_RUNTIME_REACHED');
          } else if (this.#stopSignal?.aborted === true) {
            stopReason = RUN_INTERRUPTED_SKIP_REASON;
          }
        }
        if (stopReason !== null) {
          if (revisiting === null) {
            frontier.markSkipped(entry.url, stopReason);
          }
          continue;
        }
        // EV-5: 読み直しは、新しいページとして数えない（ページ数の上限と進み具合）。前の結果の再試行の記録は、読み直しを残すときに消す（捨てるときは戻す）。
        const earlierRetries = revisiting === null ? [] : progress.retries.filter(({ url }) => url === entry.url);
        // EV-5: 読み直しを捨てる（前の結果のまま終えた記録に戻し、前の再試行の記録を戻して、状態を保存する）。前の結果・画像・ページの保存（Ledger の snapshot を
        // 含む）は変えない。この読み直しの Ledger はページの Ledger に入れないので、ページの外の Ledger として保存と Run の集計に入る。
        const dropRevisit = async (candidate: RevisitCandidate): Promise<void> => {
          frontier.markFinished(entry.url, candidate.status);
          removeRetryRecordsOf(progress.retries, entry.url);
          progress.retries.push(...earlierRetries);
          progress.retryEvidence.delete(entry.url);
          if (checkpoint !== null && !checkpointFailed) {
            await saveState(checkpoint);
          }
        };
        if (revisiting === null) {
          pagesStarted += 1;
        } else {
          removeRetryRecordsOf(progress.retries, entry.url);
        }
        progress.pageLedgerStart = progress.safetyLedgers.length;
        // DUP: 読み直しは前の深さのまま（軽い点検は軽い点検のまま）。知らせた深さは、ページごとに戻す。
        pageSameness.answers = samenessAnswersOf(samenessTable, revisiting?.previousDepth ?? null);
        pageSameness.decision = null;
        // 確かめ直しの記録は、捨てたときに `AUDITING` に戻してある（`requeueForRecheck`）。
        if (revisiting !== null) {
          frontier.reopenForRevisit(entry.url);
          this.#reportProgress(progress, { pagesFinished, pagesDiscovered: frontier.discoveredCount, startedAtMs }, entry.url);
        } else if (!rechecking) {
          frontier.markAuditing(entry.url);
          // L0: 始めたページの URL を知らせる（止まったページが、最後の進み具合の記録に残る）。
          this.#reportProgress(progress, { pagesFinished, pagesDiscovered: frontier.discoveredCount, startedAtMs }, entry.url);
        }
        // DEF-233: 読み込みの前の、承認したサービスの Origin からの 401 の数（後と比べて、このページの 401 を見分ける）。
        const unauthorizedBefore = serviceUnauthorizedCountOf(progress.auditStage);
        const {
          result,
          siteUnavailableDetail,
          authSessionLostDetail: pathSessionLostDetail,
          authSessionLoss,
        } = await this.#auditWithRetry(
          auditor,
          entry,
          progress,
          // DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.1 の 4）: このページの後に次のページを読み込むか（最後のビューポートを閉じる前に、
          // 前の画面を見せたまま待つかを決める）。次のページを始める前の確かめ（下のループの先頭）と同じ理由で始めないなら偽。待ち行列か、このページの Link に、
          // これから監査する URL があれば真。
          (evidence) => {
            if (
              checkpointFailed
              || progress.siteUnavailableDetail !== null
              || progress.authSessionLostDetail !== null
              || pageLimitReached()
              || runtimeLimitReached()
              || this.#stopSignal?.aborted === true
            ) {
              return false;
            }
            const known = frontier.entries();
            if (known.some(({ state }) => state === 'QUEUED')) {
              return true;
            }
            const knownUrls = new Set<string>(known.map(({ url }) => url));
            const { maxDepth } = config.crawl;
            return (maxDepth === undefined || entry.depth + 1 <= maxDepth)
              && desktopLinkUrlsOf(evidence).some((url) => !knownUrls.has(url) && !excludedCrawlCandidate(url) && this.#inPageScope(url));
          },
          // EV-5: 読み直しの画像は、前の結果の画像と別の場所（読み直しの番号のディレクトリ）に置く。
          revisiting?.revisitIndex ?? null,
        );
        // T35c（Task 35 の設計書 3.5）: ログインの状態の鍵がなくなった（factory が状態を読み直したときに見た）なら、そのページでセッションが切れたと
        // みなす（今の `AUTH_SESSION_LOST` の流れ。場所は `SESSION_KEY_LOST_DETAIL` で、path の切れと区別する）。T37a: 判定は、発見と READ の確かめの
        // ジョブと共有する 1 か所（`sessionKeyLostDetailOf`）。
        // DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.3）: このページの間に承認したサービスの Origin から 401 を受けたら、
        // セッションが切れたとみなす（場所は `SERVICE_UNAUTHORIZED`。判定は操作さがし・READ の確かめと共有する 1 か所。監査では 401 そのものを描けなかった印とする）。
        const authSessionLostDetail = pathSessionLostDetail
          ?? sessionKeyLostDetailOf(progress.auditStage)
          ?? serviceUnauthorizedSessionLostDetailOf(progress.auditStage, unauthorizedBefore, true, this.#authentication?.automatedRelogin === true);
        // T25c: 認証つきの Run で、セッションの切れを検知した（Task 25 の設計書 4.3）。そのページの Ledger に違反がなければ、ページを捨てる
        // （ログインの画面を管理画面として監査しない。結果、ページの保存、Link、進み具合には入れない。監査を始めたページの数からも外す）。巡回の
        // 記録で、理由 `AUTH_SESSION_LOST`（`detail` は当たった場所）の SKIPPED にし（再開のときに待ち行列に戻す）、この実行の印を残して、
        // 次のページを始めない。そのページの Ledger は `pageLedgers` に入れないので、ページの外の Ledger として、保存と Run の集計に入る。
        // 違反があれば、今のとおり普通の結果として保存し、違反で止める（違反の優先）。サイトの不調より先に確かめる。
        if (
          authSessionLostDetail !== undefined
          && authSessionLostDetail !== null
          && !this.#detectSafetyViolation(progress, progress.pageLedgerStart)
        ) {
          progress.authSessionLostDetail ??= authSessionLostDetail;
          // DEF-138: path の切れの証拠（Page Auditor が組み立てたもの）を、この実行の記録に残す（最初の 1 件。鍵の消失は証拠を持たない）。
          const sessionLoss = pathSessionLostDetail === undefined || pathSessionLostDetail === null ? null : authSessionLoss ?? null;
          progress.authSessionLoss ??= sessionLoss;
          // EV-5: 読み直しなら、読み直しを捨て、前の結果のまま終えた記録に戻す。
          if (revisiting === null) {
            pagesStarted -= 1;
            frontier.markSkipped(entry.url, authSessionLostReason(authSessionLostDetail));
          } else {
            frontier.markFinished(entry.url, revisiting.status);
          }
          // T25d: 止まったページを、観測の口に知らせる（URL の伏せ字は `#notify` が 1 か所で通す。T25f）。DEF-138: 証拠も渡す。
          this.#notify(Object.freeze({ kind: 'AUTH_SESSION_LOST', url: entry.url, ...(sessionLoss === null ? {} : { sessionLoss }) }));
          removeRetryRecordsOf(progress.retries, entry.url);
          progress.retries.push(...earlierRetries);
          progress.retryEvidence.delete(entry.url);
          if (checkpoint !== null && !checkpointFailed) {
            await saveState(checkpoint);
          }
          continue;
        }
        // サイトの不調の印（サイトが応答しないときに Run を止める設計書 3.2、3.2.1）。まず、そのページの Ledger の違反を確かめる。違反が
        // あれば、ページを捨てずに、今のとおり普通の結果として保存し、違反で止める（違反の Evidence をページに残すため。違反の優先）。
        // 違反がなければ、この実行の不調の詳細を残し（次のページを始めない）、前の実行のきっかけのページでなければ、ページを捨てる。前の実行の
        // きっかけのページなら、捨てずに、普通の結果として保存する（同じページで止まり続けないため。設計書 3.2.1）。
        if (siteUnavailableDetail !== null && !this.#detectSafetyViolation(progress, progress.pageLedgerStart)) {
          progress.siteUnavailableDetail ??= siteUnavailableDetail;
          // EV-5: 読み直しなら、読み直しを捨て、前の結果のまま終えた記録に戻す（確かめ直しはしない。次のページは始めない）。
          if (revisiting !== null) {
            await dropRevisit(revisiting);
            continue;
          }
          if (!previousTriggerUrls.has(entry.url)) {
            // ページを捨てる。巡回の記録で、理由 `SITE_UNAVAILABLE`（`detail` は不調の詳細。止まるきっかけのページの印）の SKIPPED にする
            // （再開のときに、待ち行列に戻す）。結果、ページの保存、終わったページの ID、Link、進み具合には入れない。監査を始めたページの数
            // からも外す（再開で監査し直すときに、二重に数えないため）。そのページの Ledger は `pageLedgers` に入れないので、ページの外の
            // Ledger の snapshot として、状態の保存と Run の Safety の集計に入る。そのページの再試行の記録と、再試行の前の試行の Evidence は
            // 消す（ページの結果がないので、記録の `evidenceIds` の行き先がなくなるため）。
            pagesStarted -= 1;
            frontier.markSkipped(entry.url, siteUnavailableReason(siteUnavailableDetail));
            removeRetryRecordsOf(progress.retries, entry.url);
            progress.retryEvidence.delete(entry.url);
            // 捨てた後に、状態を保存する（理由と `detail` のある SKIPPED を、この後に途中で止まった場合（確かめ直しのために待っている間を
            // 含む）にも残すため）。
            if (checkpoint !== null && !checkpointFailed) {
              await saveState(checkpoint);
            }
            // 段階的に確かめ直す（設計書 3.5.2、3.6.2）。この実行でこのページを確かめ直した回数が上限（待ちの段階の数）に達しておらず、状態を
            // 保存できていれば（保存に失敗した後は、新しいページを始めないので、待たず、確かめ直さない）、知らせてから次の段階の待ちで待ち、
            // 待った後に止める印がなく、実行時間の上限にも達していなければ、この実行の不調の詳細を消し（このページを始める前は `null`
            // だった。上の `??=` で入れた値）、巡回の記録をこのページの `AUDITING` に戻して、同じ記録（同じ `pageId`）を次に監査する。
            // 待っている間は、サイトへ何も送らない。上限に達していれば、今までどおり止める（無限には繰り返さない）。
            const nextDelayMs = SITE_UNAVAILABLE_RECHECK_DELAYS_MS[recheckCount];
            if (
              nextDelayMs !== undefined
              && !checkpointFailed
              && await this.#waitBeforeRecheck(entry.url, nextDelayMs, recheckCount + 1, runtimeLimitReached)
            ) {
              recheckedUrls.set(entry.url, recheckCount + 1);
              progress.siteUnavailableDetail = null;
              frontier.requeueForRecheck(entry.url);
              recheckEntry = entry;
            }
            continue;
          }
        }
        // REV-EV5 の I-1: 読み直しが時間切れで途中になり、前の結果より見たビューポートが少ないなら、読み直しを捨てて前の結果を残す（`keepsRevisit`）。違反があれば、
        // 今のとおり普通の結果として残す（違反の Evidence をページに残すため。違反の優先）。読み直しを終えたページには入れない（次の時間切れの再開で読み直す）。
        if (
          revisiting !== null
          && !keepsRevisit(revisiting.fact, pageRevisitFactOf(result))
          && !this.#detectSafetyViolation(progress, progress.pageLedgerStart)
        ) {
          await dropRevisit(revisiting);
          continue;
        }
        // 確かめ直しで通った（その試行に不調の印がない）ので、減速して続ける（設計書 3.6.2。何回目の確かめ直しで通ったかによらず 1 回）。
        if (rechecking && siteUnavailableDetail === null) {
          slowDownAfterRecheckPassed();
        }
        // MEM-3b: ページの結果は、ここで置き場所に入れる（再試行の前の試行の Evidence は、本体に加えて消す。保存には、下で同じ値を渡す）。
        const pageRetryEvidence = progress.retryEvidence.get(entry.url) ?? [];
        await storeRunPage(progress, entry.url, result, pageRetryEvidence);
        frontier.markFinished(entry.url, result.status);
        // DUP（設計書 2 章）: 点検を終えた画面を、同じ作りの表に入れる（しっかり点検した 1 回目と、中身が同じ画面を省く相手）。途中で止まった画面は入れない
        // （次の同じ作りの画面をしっかり点検する）。省いた画面（SAME）は入れない。表は、下の状態の保存で checkpoint に残る。
        const decided = decidedSamenessOf(pageSameness);
        if (decided !== null && decided.templateKey !== null && decided.depth !== 'SAME' && acceptsAsSamenessReference(result)) {
          frontier.acceptPageReference({ templateKey: decided.templateKey, pageId: entry.pageId, depth: decided.depth, contentDigest: decided.contentDigest });
        }
        // Link は、Desktop の `link` の Evidence から取り、`INTERNAL_NAVIGABLE` のものだけをキューに入れる（ARCH03）。
        // T25c: 認証つきの Run では、監査の段の除外に当たる URL と、セッションの切れの path の URL を入れない（Task 25 の設計書 4.2、4.7）。
        // SD-1: 公開監査でも、削除の語の URL とリンクを入れない。
        // COV-4（網羅の設計書 3.2）: 読んだページの構造の鍵と辺（リンクと同じ Origin の frame）を、待ち行列（`CoverageQueue`）に渡す。待ち行列が、まだ見ていない
        // 場所を入れ、終わりのない続きを閉じる。
        const outcome = auditPageOutcomeOf(result);
        // COV-4 の区切り 3: 操作の後の URL の辺（SPA の経路・query の変化）も、受け入れの判定の唯一の入口（`classifyUrl`）で許可 Origin の中のものだけにする。
        const admission = { allowedOrigins: new Set(config.site.allowedOrigins) };
        frontier.completePage(entry.url, {
          structureKey: outcome.structureKey,
          // WSO: 「チェックした画面だけ」の点検は、範囲の画面への辺だけを入れる（ほかの画面へ広げない）。
          edges: outcome.edges.filter(({ url }) => classifyUrl(new URL(url), admission).kind === 'INTERNAL_NAVIGABLE'
            && !excludedCrawlCandidate(url) && this.#inPageScope(url)),
        });
        // そのページの保存（先）と、状態の保存（後）。状態の `completedPageIds` には、そのページを含める（設計書 4.3）。そのページの
        // すべての Context は、Page Auditor の中で閉じている（そのページの Ledger は、Context を閉じた後のもの）。
        if (checkpoint !== null && !checkpointFailed) {
          // 保存の前に、そのページの Ledger を調べ、保存の「違反の検出」のフラグに、そのページの違反を含める（ページの中の最後の確かめの
          // 後に記録された違反も含む。中断した Run の再開の設計書 4.2）。ここでは監査を止めないので、止めたことは記録しない（残りの URL は、
          // 次のページを始める前の確かめで止める）。
          this.#detectSafetyViolation(progress, progress.pageLedgerStart);
          const ledgers = progress.safetyLedgers.slice(progress.pageLedgerStart);
          for (const ledger of ledgers) {
            pageLedgers.add(ledger);
          }
          // EV-5: 読み直したページは、終わったページの ID にすでにある。ページの保存には、前の読み込みの Ledger の snapshot も残す。
          if (revisiting === null) {
            completedPageIds.push(entry.pageId);
          }
          const earlierSnapshots = revisiting?.safetyLedgerSnapshots ?? [];
          checkpointFailed = !await this.#requestCheckpoint(progress, async () => checkpoint.session.savePage(createRunCheckpointPage({
            result,
            retryEvidence: pageRetryEvidence,
            safetyLedgerSnapshots: [...earlierSnapshots, ...ledgers.map((ledger) => ledger.snapshot())],
          }), { keptUrls: crawlKnownUrlsOf(frontier, progress.pages.summaries()) }));
        }
        // EV-5: 読み直した後の事実で、もう 1 回読み直すかを決める（確かめを待つ指摘が減ったときだけ。列の先に戻す）。読み直さず、一部だけで終わったのでもなければ、
        // 読み直しを終えたページとして残す（後の再開では読み直さない）。
        if (revisiting !== null) {
          const after = pageRevisitFactOf(result);
          if (readAgainAfterRevisit(revisiting.fact, after)) {
            revisitQueue.unshift({
              entry,
              candidate: {
                fact: after,
                status: result.status,
                safetyLedgerSnapshots: [...revisiting.safetyLedgerSnapshots, ...progress.safetyLedgers.slice(progress.pageLedgerStart).map((ledger) => ledger.snapshot())],
                // 採った読み直しの画像を上書きしないよう、次の番号に置く。
                revisitIndex: revisiting.revisitIndex + 1,
                previousDepth: revisiting.previousDepth,
              },
            });
          } else if (!after.cutByRunTimeLimit && !revisitedPageIds.includes(entry.pageId)) {
            revisitedPageIds.push(entry.pageId);
          }
        }
        if (checkpoint !== null && !checkpointFailed) {
          await saveState(checkpoint);
        }
        if (revisiting === null) {
          pagesFinished += 1;
        }
        this.#reportProgress(progress, { pagesFinished, pagesDiscovered: frontier.discoveredCount, startedAtMs });
      }
      // 実行時間の上限を超えたかを、事実として記録する。最後のページで超え、監査していない URL が残らない場合も含む
      // （その場合、SKIPPED の URL がないので、Run の理由は付かない）。
      progress.maxRuntimeExceeded = runtimeLimitReached();
      progress.executionComplete = true;
    } catch (error) {
      progress.unhandledFailures += 1;
      progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.crawl, error));
      // 例外で止まった経路でも、実行時間の上限を超えたかを、事実として記録する（R15r-3。規則は上と同じ 5.6.3）。監査を終えられなかった
      // URL の理由は `EXECUTION_INCOMPLETE` なので、`MAX_RUNTIME_REACHED` の Run の理由は付かず、Run Status の決め方も変わらない。
      progress.maxRuntimeExceeded = runtimeLimitReached();
      // 監査を終えられなかった URL（監査中と、キューに残っているもの）は、隠さずに SKIPPED の結果にする。
      const frontier = progress.frontier;
      if (frontier !== null) {
        for (const entry of frontier.entries()) {
          if (entry.state === 'AUDITING') {
            frontier.markSkipped(entry.url, EXECUTION_INCOMPLETE_REASON);
          }
        }
        for (const entry of frontier.drain()) {
          frontier.markSkipped(entry.url, EXECUTION_INCOMPLETE_REASON);
        }
      }
    }
    // 巡回の終わり（残りの URL を SKIPPED にした後。Browser を閉じる前）の値を、最後の状態の保存の中身として写す（設計書 4.3.2）。
    // 巡回の記録を作る前に止まった場合は、巡回を始めなかった場合と同じ中身にする。
    const { frontier, allocator } = progress;
    return {
      checkpointWriteFailed: checkpointFailed,
      lastWrittenCheckpoint: lastWritten,
      crawlEndContent: checkpoint === null
        ? null
        : runCheckpointContent({
          config,
          identity: checkpoint,
          progress,
          crawl: frontier === null || allocator === null
            ? null
            : { frontier, allocator, pagesStarted, outsidePageSnapshots: outsidePageSnapshots(), completedPageIds, revisitedPageIds },
        }),
    };
  }

  /**
   * 保存のセッションを、Run のディレクトリで始める（中断した Run の再開の設計書 4.3.1。新しい Run）。セッションがなければ、
   * 何もせずに `null` を返す。始められなかった場合（始め方が reject した。出力先のロックを作れなかったときを含む）は、Run の理由
   * `CHECKPOINT_WRITE_FAILED` を返す（`detail` は、失敗のメッセージ）。
   */
  async #startCheckpointSession(runDirectory: string): Promise<IncompleteReason | null> {
    const session = this.#checkpointSession;
    if (session === undefined) {
      return null;
    }
    try {
      await session.start(runDirectory, { mode: 'NEW_RUN' });
      return null;
    } catch (error) {
      return checkpointWriteFailedReason(safeErrorMessage(error));
    }
  }

  /**
   * 保存のセッションを、再開の始め方（`RESUME`。終わったページの ID は、保存の `completedPageIds`）で、前の回の Run のディレクトリで始める
   * （中断した Run の再開の設計書 4.5。後始末は、セッションが行う）。始め方が reject した場合は、`RunResumeUnavailableError` を投げる。
   */
  async #resumeCheckpointSession(resume: RunCoordinatorResumeInput, runId: RunId): Promise<void> {
    const session = this.#checkpointSession;
    if (session === undefined) {
      // 再開の入力があれば、コンストラクタが、セッションがあることを確かめている。
      throw new TypeError('RunCoordinator resumeFrom requires a checkpointSession');
    }
    const { runDirectory } = resume;
    try {
      await session.start(runDirectory, { mode: 'RESUME', completedPageIds: resume.checkpoint.completedPageIds });
    } catch (error) {
      throw new RunResumeUnavailableError({ runId, runDirectory, reason: 'CHECKPOINT_STORE_FAILED', cause: error });
    }
  }

  /**
   * 保存を頼む（中断した Run の再開の設計書 4.3）。保存の値の組み立ても `save` の中で行う。保存できたら真を返す。失敗した（reject か
   * 例外）なら、Run の理由 `CHECKPOINT_WRITE_FAILED`（`detail` は、失敗のメッセージ）を加えて、偽を返す。呼び出し側は、失敗の後に
   * 保存を頼まないので、この理由は Run に1件だけである。
   */
  async #requestCheckpoint(progress: RunProgress, save: () => Promise<void>): Promise<boolean> {
    try {
      await save();
      return true;
    } catch (error) {
      progress.reasons.push(checkpointWriteFailedReason(safeErrorMessage(error)));
      return false;
    }
  }

  /**
   * 進み具合の事実を組み立て、注入された受け手に渡す（サイトへの負荷の制御の設計書 4.8）。受け手がなければ、何もしない（組み立てもしない）。
   * 値は、その時点の事実だけである: ページの数は呼び出し側から、経過時間は注入した `now` から、読み込みの回数と待ちの合計は pacer から、
   * 要求の実績と直近の1分の件数は meter から取る。事実は、深く凍結する。
   * 事実の組み立ての例外（注入した `now` が不正な時刻を返した場合など）、受け手の例外、受け手が返した Promise の reject は、握りつぶす
   * （Run を止めず、Run の理由にもしない。表示の失敗で監査を止めないため。受け手の有無で Run を変えないため）。
   * L0: `currentPageUrl` を渡すと、ページを始めた知らせ（`onPageStarted`）として、URL を足して渡す（認証つきの Run では `#notify` と同じ伏せ字の後）。
   */
  #reportProgress(
    progress: RunProgress,
    facts: { readonly pagesFinished: number; readonly pagesDiscovered: number; readonly startedAtMs: number },
    currentPageUrl?: string,
  ): void {
    const onProgress = currentPageUrl === undefined ? this.#onProgress : this.#onPageStarted;
    if (onProgress === undefined) {
      return;
    }
    try {
      const urlPart = currentPageUrl === undefined
        ? {}
        : { currentPageUrl: this.#authentication === null ? currentPageUrl : redactUrlSecrets(currentPageUrl) };
      const pacer = progress.navigationPacer.snapshot();
      const report: RunProgressReport = deepFreeze({
        pagesFinished: facts.pagesFinished,
        pagesDiscovered: facts.pagesDiscovered,
        // L14 の後の段: ページの上限は、指定したときだけ持つ。
        ...(this.#config.crawl.maxPages === undefined ? {} : { maxPages: this.#config.crawl.maxPages }),
        // 時計が戻っても、経過時間を負にしない。
        elapsedMs: Math.max(0, this.#now() - facts.startedAtMs),
        navigationCount: pacer.navigationCount,
        pacingWaitMs: pacer.totalWaitMs,
        requests: progress.loadMeter.snapshot(),
        recentPerMinute: progress.loadMeter.recentPerMinute(),
        ...urlPart,
      });
      // 型は `void` を返す関数だが、async の関数も渡せるので、返った Promise の reject も握りつぶす（扱われない reject にしない）。
      const returned: unknown = onProgress(report);
      if (returned instanceof Promise) {
        returned.catch(() => undefined);
      }
    } catch {
      // 表示の失敗で、監査を止めない（Run の理由にもしない）。
    }
  }

  /**
   * 知らせ（`RunNotice`）を、注入された受け手に渡す（サイトが応答しないときに Run を止める設計書 3.5.4）。受け手がなければ、何もしない。
   * 受け手の例外と、受け手が返した Promise の reject は、握りつぶす（`#reportProgress` と同じ。表示の失敗で監査を止めないため）。
   * 認証つきの Run（T25f。Task 25 の設計書 4.6）では、URL を持つ知らせの URL を、伏せ字の owner の `redactUrlSecrets` にかけてから渡す（知らせの
   * URL の伏せ字は、ここだけで通す。ワーカーは、この値を IPC の `AUTH_STATE` と `NOTICE`、ジョブの行へ渡す）。公開監査では、今のまま渡す。
   */
  #notify(notice: RunNotice): void {
    const onNotice = this.#onNotice;
    if (onNotice === undefined) {
      return;
    }
    const outgoing = this.#authentication !== null && 'url' in notice
      ? Object.freeze({ ...notice, url: redactUrlSecrets(notice.url) })
      : notice;
    try {
      const returned: unknown = onNotice(outgoing);
      if (returned instanceof Promise) {
        returned.catch(() => undefined);
      }
    } catch {
      // 表示の失敗で、監査を止めない（Run の理由にもしない）。
    }
  }

  /**
   * 「Run の終わり」の段に入ることを、注入された受け手（`onFinalizing`）に渡す（DEF-143）。受け手がなければ、何もしない。受け手の例外と、受け手が
   * 返した Promise の reject は、握りつぶす（`#notify` と同じ）。
   */
  #notifyFinalizing(): void {
    const onFinalizing = this.#onFinalizing;
    if (onFinalizing === undefined) {
      return;
    }
    try {
      const returned: unknown = onFinalizing();
      if (returned instanceof Promise) {
        returned.catch(() => undefined);
      }
    } catch {
      // 知らせの失敗で、Run の終わりを止めない（Run の理由にもしない）。
    }
  }

  /**
   * サイトの不調で捨てたページ（`url`）を、`attempt` 回目に確かめ直す前の待ち（サイトが応答しないときに Run を止める設計書 3.5.2、3.6.2）。
   * 確かめ直してよければ真を返す。
   * - 待つ前に、止める印が付いているか、実行時間の上限に達していれば、待たず（知らせも出さず）に偽を返す（待っても確かめ直せないため）。
   * - 知らせ（`SITE_UNAVAILABLE_RECHECK`。待つ時間、何回目か、最大の回数）を渡してから、`delayMs`（その回の段階の待ち）だけ待つ（注入した
   *   `sleep`。止める印で打ち切る）。待っている間は、サイトへ何も送らない（Page Auditor も、pacer の待ちも呼ばない）。
   * - 待った後、止める印が付いているか、実行時間の上限に達していれば（待った時間は上限に含める）、偽を返す。
   */
  async #waitBeforeRecheck(
    url: NormalizedHttpUrlEvidence,
    delayMs: number,
    attempt: number,
    runtimeLimitReached: () => boolean,
  ): Promise<boolean> {
    if (this.#stopRequested() || runtimeLimitReached()) {
      return false;
    }
    this.#notify(Object.freeze({
      kind: 'SITE_UNAVAILABLE_RECHECK',
      url,
      delayMs,
      attempt,
      maxAttempts: SITE_UNAVAILABLE_RECHECK_DELAYS_MS.length,
    }));
    await this.#sleepUnlessStopped(delayMs);
    return !this.#stopRequested() && !runtimeLimitReached();
  }

  /** 止める印（`stopSignal`）が付いているか（印がなければ偽）。待ちの前後で読み直す（型の絞り込みを待ちの後に持ち越さないため）。 */
  #stopRequested(): boolean {
    return this.#stopSignal?.aborted === true;
  }

  /**
   * `ms` だけ待つ（注入した `sleep`）。止める印が付いたら、待ちを打ち切って返る（`sleep` の終わりは待たない。止める印の受け手は、
   * 終わったら外す）。止める印がなければ、`sleep` の終わりまで待つ。`sleep` の失敗（reject）は、そのまま投げる。
   */
  async #sleepUnlessStopped(ms: number): Promise<void> {
    // DEF-136: ジョブと共有する部品（`sleepUnlessStopped`）。
    await sleepUnlessStopped(this.#sleep, ms, this.#stopSignal);
  }

  /**
   * この Run で作った Ledger（登録の `fromIndex` 番目から後）に、安全の不変条件の違反が1件でも記録されたかを調べ、記録されていれば
   * `progress.safetyViolationDetected` を立てて、その値を返す（Task 19 の前の整理の設計書 4.5。C18f）。違反の検出は、ここだけで行う
   * （Run Coordinator が、Ledger の登録を調べる方法）。止めたことは記録しない（それは `#safetyViolationRecorded` が行う）。
   * - 再開した Run の、保存した Safety Ledger の snapshot（前の回までの Ledger）は、登録の先頭（この実行の Ledger より前）にあるものと
   *   して扱い、Run の初めから調べる場合（`fromIndex` が 0）に調べる（中断した Run の再開の設計書 4.2。保存のフラグが偽で、保存した
   *   snapshot に違反がある場合の守り。R4a2b）。ページの中の確かめと、ページの保存の前の確かめと、サイトの不調の印のあるページを捨てるかを
   *   決める前の確かめ（`fromIndex` は今のページの初め）では調べない（ページを始める前に調べた）。robots.txt と sitemap.xml の取得の後の保存の前の確かめは、Run の初めから（`fromIndex` が 0）
   *   調べる（この実行の PREFLIGHT、環境の記録、取得の Ledger と、保存した snapshot。R5-fix-round-1）。取得でサイトの不調を検知した場合の、
   *   不調の詳細を残すかを決める前の確かめも、Run の初めから調べる（サイトが応答しないときに Run を止める設計書 3.1。SU3b）。
   * - 一度検出したら、それ以後は、調べずに真を返す（Ledger の違反は減らないため）。
   * 違反の種類は問わない。件数は、Ledger の snapshot の `invariantViolationCount` で読む（Run の Safety の集計と同じ値）。
   */
  #detectSafetyViolation(progress: RunProgress, fromIndex: number): boolean {
    if (!progress.safetyViolationDetected) {
      const hasViolation = (snapshot: SafetyLedgerSnapshot): boolean => snapshot.invariantViolationCount > 0;
      progress.safetyViolationDetected = (fromIndex === 0 && progress.savedSafety.hasInvariantViolation)
        || progress.safetyLedgers.slice(fromIndex).some((ledger) => hasViolation(ledger.snapshot()));
    }
    return progress.safetyViolationDetected;
  }

  /**
   * 監査を始める前の、違反の確かめ（Task 19 の前の整理の設計書 4.5。C18f）。`#detectSafetyViolation` で調べ、違反があれば、止めたことを
   * 記録して（Run の理由の `SAFETY_VIOLATION_ABORT`）、真を返す。真を返したときは、呼び出し側は必ず監査を始めない。
   */
  #safetyViolationRecorded(progress: RunProgress, fromIndex: number): boolean {
    const detected = this.#detectSafetyViolation(progress, fromIndex);
    if (detected) {
      progress.stoppedBySafetyViolation = true;
    }
    return detected;
  }

  /**
   * 1つの URL を監査する。Desktop の `NAVIGATION_FAILED` の detail が再試行の対象なら、同じ `pageId` で1回だけ再試行する
   * （設計書 5.6.4）。Page Auditor には、試行の番号と再試行の判断を渡す（再試行の前の試行のスクリーンショットは、
   * `pages/<pageId>/retry-<n>/<ビューポート>/` に置かれる。DEF-007）。最初の試行は `retries` に記録し、その Evidence は、最終のページの `evidence` に残すために取っておく。
   * 最初の試行の Finding は残さない。その試行の Ledger は登録にあるので、Safety の集計に入る。
   * 試行の結果にサイトの不調の印（`siteUnavailableDetail`）があれば、再試行しない（再試行の判断を呼ばずに終える。サイトが応答しないときに
   * Run を止める設計書 3.3。最初の1回で止める）。最終の試行のページの結果と、その試行の不調の印を返す。
   */
  async #auditWithRetry(
    auditor: RunPageAuditor,
    entry: CrawlUrlEntry,
    progress: RunProgress,
    nextPageFollows: (evidence: readonly EvidenceRecord[]) => boolean,
    revisit: number | null = null,
  ): Promise<RunPageAudit> {
    let outcome: PageAuditOutcome | undefined;
    const earlierEvidence: EvidenceRecord[] = [];
    for (let attempt = 1; attempt <= MAX_NAVIGATION_ATTEMPTS; attempt += 1) {
      // 再試行の判断は、ここだけで行う。Page Auditor には、同じ判断を渡し、再試行の前の試行のスクリーンショットの置き場所を
      // 分けさせる（DEF-007）。再試行も対象のサイトへの新しい監査なので、違反を検出した後は再試行しない（Task 19 の前の整理の
      // 設計書 4.5）。違反は、再試行の対象の失敗のときだけ調べる（止めたことを記録するのは、実際に再試行を止めた場合だけにする）。
      const retryAfter = (desktop: ViewportAuditResult): Pick<RunRetryRecord, 'navigationOutcome' | 'detail'> | null => {
        const retryable = attempt < MAX_NAVIGATION_ATTEMPTS ? retryableNavigationFailure(desktop) : null;
        return retryable === null || this.#safetyViolationRecorded(progress, 0) ? null : retryable;
      };
      outcome = await auditor.audit(entry.url, entry.pageId, {
        attempt,
        precedesRetry: (desktop) => retryAfter(desktop) !== null,
        // DEF-236: 再試行は Page Auditor が Desktop の後に知る。次のページは、ここで決める。
        nextPageFollows,
        // EV-5: 読み直しなら、画像を前の結果と別の場所（`revisit-<番号>/`）に置く。
        ...(revisit === null ? {} : { revisit }),
      });
      // サイトの不調の印があれば、再試行しない（設計書 3.3）。再試行の判断（`retryAfter`）より先に確かめ、判断を呼ばない。
      // T25c: セッションの切れの印があっても、再試行しない（ページを捨てて Run を止める）。
      if (outcome.siteUnavailableDetail !== null || (outcome.authSessionLostDetail ?? null) !== null) {
        break;
      }
      const retryable = retryAfter(outcome.result.viewports.desktop);
      if (retryable === null) {
        break;
      }
      const { evidence } = outcome.result;
      progress.retries.push(Object.freeze({
        url: entry.url,
        attempt,
        ...retryable,
        evidenceIds: Object.freeze(evidence.map(({ evidenceId }) => evidenceId)),
      }));
      // 再試行が例外で終わった場合も、`retries` の `evidenceIds` の行き先がページに残るよう、ここで記録する。
      earlierEvidence.push(...evidence);
      progress.retryEvidence.set(entry.url, earlierEvidence);
    }
    if (outcome === undefined) {
      throw new Error('page audit did not run');
    }
    return outcome;
  }

  /**
   * 設計書 5.6.1 の手順8〜11。終わりの時刻は、時計を1回だけ読んで、`run.json` の `finishedAt` と、この実行の記録の終わりの時刻に使う
   * （中断した Run の再開の設計書 4.8）。
   */
  async #finalize(input: {
    readonly runId: RunId;
    readonly toolVersion: string;
    /** Run の開始の時刻（ISO 8601。再開した Run では、最初の実行の開始）。 */
    readonly startedAt: string;
    readonly environment: RunEnvironment;
    readonly progress: RunProgress;
    /** 前の回までの実行の記録（`run.json` の形。新しい Run では空）。 */
    readonly previousExecutions: readonly RunExecution[];
    /** この実行の開始の時刻（ISO 8601）。 */
    readonly executionStartedAt: string;
    /** DEF-200: この実行のログインし直しの印と回数（なければ `null`）。 */
    readonly automaticRelogin: RunExecutionAutomaticRelogin | null;
  }): Promise<RunFinalization> {
    const config = this.#config;
    const { progress } = input;

    // 監査しなかった URL にも結果を作り、発見の順に並べる。metadata の Evidence は、開始の URL のページに置く。
    // Cross-page rule と件数の入力は、最終の試行の Evidence だけ（設計書 5.6.4。要約が持つ）。`pages`（出力）は、それに再試行の前の試行の Evidence を
    // 加えたものである。Evidence は、metadata、再試行の前の試行、最終の試行の順に並べる。
    // MEM-3b（DEF-266）: ページの本体は置き場所（`progress.pages`）に圧縮したまま、発見の順に並べ直す（`ordered`。圧縮し直さない）。監査しなかった URL の結果は、
    // ここで作って入れる（再試行が例外で終わった URL は、再試行の前の試行の Evidence も加える）。開始の URL のページだけを戻し、metadata の Evidence を加えて
    // 入れ替える。Run の Finding、Cross-page rule、件数は、評価の形から作った要約（`RunPageSummary`）だけから作る。
    const order: number[] = [];
    let startPosition = -1;
    for (const entry of progress.frontier?.entries() ?? []) {
      if (!progress.results.has(entry.url)) {
        const skipped = skippedPageResult(entry.url, entry.pageId, entry.skipReason ?? EXECUTION_INCOMPLETE_REASON);
        await storeRunPage(progress, entry.url, skipped, progress.retryEvidence.get(entry.url) ?? []);
      }
      if (entry.url === progress.startUrl) {
        startPosition = order.length;
      }
      order.push(progress.results.get(entry.url) ?? -1);
    }
    const pages = progress.pages.ordered(order);
    if (startPosition >= 0 && progress.metadata !== null && progress.metadata.records.length > 0) {
      const metadataRecords = progress.metadata.records;
      const startSummary = pages.summaries()[startPosition];
      if (startSummary !== undefined) {
        await pages.replace(
          startPosition,
          withLeadingEvidence(await pages.decode(startPosition), metadataRecords),
          runPageSummaryWithLeadingEvidence(startSummary, metadataRecords),
        );
      }
    }
    const summaries = pages.summaries();

    // 8. Cross-page rule。
    const findings: Finding[] = summaries.flatMap((page) => page.findings);
    let unverifiedInternalLinkCount = 0;
    if (!progress.preflightFailed && progress.allocator !== null) {
      try {
        const crossPage = evaluateCrossPageRules({
          targetId: config.target.id,
          firstFindingSequence: progress.allocator.nextFindingSequence,
          allowedOrigins: config.site.allowedOrigins,
          allowedQueryParameters: config.crawl.allowedQueryParameters,
          pages: summaries.map(crossPageFactsOfSummary),
          // WSO（REV-WSO の I-2）: 「チェックした画面だけ」の点検は、sitemap と比べず、全部を巡回した前提の判定をしない。
          sitemap: this.#pageScope === null ? sitemapOf(progress.metadata) : null,
          crawlCoversSite: this.#pageScope === null,
          // DEF-296: 巡回の候補から外した行き先へのリンクは、確かめていないリンクに数えない（巡回と同じ判定）。
          isOutsideReadScope: excludedCrawlCandidateOf(config, this.#authentication),
        });
        progress.allocator.advanceFindingSequence(crossPage.nextFindingSequence);
        findings.push(...crossPage.findings);
        progress.reasons.push(...crossPage.failures.map(ruleEvaluationFailureReason));
        unverifiedInternalLinkCount = crossPage.unverifiedInternalLinkCount;
      } catch (error) {
        progress.unhandledFailures += 1;
        progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.crossPage, error));
      }
    }

    // 9. スキーマの検証。
    let requiredArtifactsValid = true;
    try {
      const invalid = await invalidArtifactReasons(pages, findings);
      requiredArtifactsValid = invalid.length === 0;
      progress.reasons.push(...invalid);
    } catch (error) {
      requiredArtifactsValid = false;
      progress.unhandledFailures += 1;
      progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.validation, error));
    }

    // 上限への到達（設計書 5.6.3）。
    const skipCodes = new Set(summaries.flatMap((page) => (page.status === 'SKIPPED' ? page.incompleteReasons.map(({ code }) => code) : [])));
    const reached = (code: CrawlLimitReasonCode): boolean => skipCodes.has(code);
    const crawlLimits: CrawlLimitState = {
      maxPagesReached: reached('MAX_PAGES_REACHED'),
      maxDepthReached: reached('MAX_DEPTH_REACHED'),
      maxRuntimeReached: reached('MAX_RUNTIME_REACHED') || progress.maxRuntimeExceeded,
    };
    const limitReasons = CRAWL_LIMIT_REASON_CODES
      .filter(reached)
      .map((code): IncompleteReason => Object.freeze({ code, detail: null }));
    // 止める印を受けたため、監査しなかった URL があれば、Run の理由に1件だけ残す（中断した Run の再開の設計書 4.6.1。上限の理由と同じく、
    // SKIPPED のページから導く。再開で URL を待ち行列に戻すと、理由も消える）。クロールの上限ではないので、`crawlLimitReached` には含めない。
    // Run Status は、SKIPPED のページから `deriveRunStatus` が `PARTIAL` と導く（この理由では決めない）。
    const interruptedReasons = skipCodes.has(RUN_INTERRUPTED_SKIP_REASON.code) ? [RUN_INTERRUPTED_SKIP_REASON] : [];
    // この実行でサイトの不調を検知したら、Run の理由に1件だけ残す（サイトが応答しないときに Run を止める設計書 3.2。`detail` は、最初に
    // 検知した不調の詳細）。この実行の事実（`progress.siteUnavailableDetail`）から最後の処理で作り、保存の理由（`progress.reasons`）には
    // 入れない（再開した実行で不調を検知しなければ、残らない）。Run Status は、SKIPPED のページなどから `deriveRunStatus` が導く（この理由
    // では決めない）。
    const siteUnavailableReasons = progress.siteUnavailableDetail === null ? [] : [siteUnavailableReason(progress.siteUnavailableDetail)];
    // 認証つきの Run で、セッションの切れのため監査しなかった URL があれば、Run の理由に1件だけ残す（T25c。`detail` は `null`。止める印と同じく、
    // SKIPPED のページから導く。再開で URL を待ち行列に戻すと、理由も消える）。Run Status は、SKIPPED のページから `deriveRunStatus` が導く。
    const authSessionLostReasons = skipCodes.has(AUTH_SESSION_LOST_SKIP_REASON.code) ? [AUTH_SESSION_LOST_SKIP_REASON] : [];
    // T35c（Task 35 の設計書 3.4）: 承認したサービスの Origin への要求の上限のため監査しなかった URL があれば、Run の理由に 1 件だけ残す（`detail` は
    // `null`。止める印と同じく、SKIPPED のページから導く）。T35R-fix（T35R の I-2）: 上限で止めた要求が Run の全体で 1 つでもあれば（残りのページが
    // なくても、前の実行の分でも）、同じ理由を 1 件だけ残す（Run Status は、理由から `deriveRunStatus` が PARTIAL と導く）。
    const serviceRequestLimitReached = skipCodes.has(SERVICE_REQUEST_LIMIT_SKIP_REASON.code)
      || (progress.auditStage !== null && hasServiceRequestLimitRefusal(progress.auditStage));
    const serviceRequestLimitReasons = serviceRequestLimitReached ? [SERVICE_REQUEST_LIMIT_SKIP_REASON] : [];
    // 違反を検出したため、監査を始めなかったものがあれば、止めたことを Run の理由に1件だけ残す（Task 19 の前の整理の設計書 4.5）。
    // Run Status は、違反の件数から `deriveRunStatus` が `ABORTED_BY_SAFETY` と導く（この理由では決めない）。
    const safetyAbortReasons = progress.stoppedBySafetyViolation ? [SAFETY_VIOLATION_ABORT_REASON] : [];
    const reasons = [
      ...limitReasons,
      ...interruptedReasons,
      ...siteUnavailableReasons,
      ...authSessionLostReasons,
      ...serviceRequestLimitReasons,
      ...safetyAbortReasons,
      ...progress.reasons,
    ];

    // Safety の集計（設計書 5.6.5）。この Run で作ったすべての Ledger の、Browser を閉じた後の snapshot からだけ集計する。再開した Run では、
    // 保存した snapshot（前の回までの Ledger）と、この実行の Ledger の snapshot を、この順に渡す（Ledger を作った順と同じ。
    // 中断した Run の再開の設計書 4.1）。
    // MEM-3c（D7）: 保存した snapshot は足し込んだもの（`savedSafety`）で持つ。要約は、snapshot を並べて `summarizeRunSafety` に渡したときと同じ。
    const runSafety = progress.savedSafety.summary({
      guardEnabled: progress.guardEnabled,
      // AS-b: 実効の監査の段の送信の扱い（項目のない設定は `READ_ONLY` と読む）。
      auditSendPolicy: auditSendPolicyOf(this.#config),
    }, progress.safetyLedgers.map((ledger) => ledger.snapshot()));

    // Run Status の入力（設計書 5.6.6）。Finding の件数は渡さない。件数は、最終の試行の結果から数える。
    const pageCounts = countPagesByStatus(summaries);
    const interactions = countInteractionOutcomes(summaries);
    const statusInput: RunStatusInput = {
      preflightFailed: progress.preflightFailed,
      safetyInvariantViolations: runSafety.invariantViolationCount,
      safetyLedgerTruncated: runSafety.recordTruncated,
      incompleteReasons: reasons,
      unhandledFailures: progress.unhandledFailures,
      crawlLimitReached: limitReasons.length > 0,
      requiredArtifactsValid,
      executionComplete: progress.executionComplete,
      skippedRequiredWork: pageCounts.skipped,
      blockedRequiredWork: 0,
      timedOutRequiredWork: 0,
      notObservedRequiredWork: 0,
      notVerifiedRequiredWork: interactions.checkNotCompleted,
      failedRequiredWork: pageCounts.failed + interactions.executionFailed,
      incompleteCollectorCount: countPartialViewports(summaries),
    };

    // この実行の記録（中断した Run の再開の設計書 4.8）。終わりの時刻は `run.json` の `finishedAt` と同じ値（時計を1回だけ読む）。終わり方は、
    // Run Status と SKIPPED のページの理由のコードから、`decideRunExecutionEndReason` が決める。
    const runStatus = deriveRunStatus(statusInput);
    const finishedAt = this.#clock().toISOString();
    const execution: RunExecution = Object.freeze({
      startedAt: input.executionStartedAt,
      finishedAt,
      endReason: decideRunExecutionEndReason({ runStatus, skipReasonCodes: skipCodes }),
      // DEF-200: ログインし直して自動で始めた実行の印と回数（あるときだけ）。
      ...(input.automaticRelogin === null ? {} : { automaticRelogin: input.automaticRelogin }),
    });
    const run: RunSummary = {
      schemaVersion: 'run-schema/1.0',
      runId: input.runId,
      toolVersion: input.toolVersion,
      target: { id: config.target.id },
      startUrl: config.site.startUrl,
      allowedOrigins: [...config.site.allowedOrigins],
      runStatus,
      startedAt: input.startedAt,
      finishedAt,
      executions: executionsEndingWith(input.previousExecutions, execution),
      discoveredPageCount: progress.frontier?.discoveredCount ?? 0,
      auditedPageCount: pageCounts.audited,
      partialPageCount: pageCounts.partial,
      failedPageCount: pageCounts.failed,
      skippedPageCount: pageCounts.skipped,
      viewportPageCounts: countViewportPages(summaries),
      environment: input.environment,
      // 注入した設定そのものを凍結しないよう、写しを記録する。
      effectiveConfig: structuredClone(config),
      // WSO: 「チェックした画面だけ」の Run だけ、範囲を記録する（サイトの全部の画面の `run.json` の形は変えない）。
      ...this.#pageScopePart(),
      safety: runSafety,
      unverifiedInteractionCount: interactions.unverified,
      unverifiedInternalLinkCount,
      retries: [...progress.retries],
      crawlLimits,
      incompleteReasons: reasons,
      // T44c（Task 44 の設計書 P1-4）: ページの未完了の理由ごとのページ数（理由を持つページがあるときだけ。ほかの Run の `run.json` は変えない）。
      ...pageIncompleteReasonCountsPartOf(summaries),
      // DUP: 軽い点検にしたページと、点検を省いたページの数（どちらかがあるときだけ。ほかの Run の `run.json` は変えない）。
      ...pageSamenessCountsPartOf(summaries),
      load: runLoad(config, progress),
      // T35c（Task 35 の設計書 3.7）: スクリプトで送るログインの監査の Run だけ、監査の段の数を記録する（ほかの Run の `run.json` は変えない）。
      // DEF-138: この実行がセッションの切れで止まったら、その証拠も記録する（監査の段の数のない Run は、証拠だけ）。
      ...runAuthenticationRecordOf(progress.auditStage, progress.authSessionLoss),
    };
    // `statusInput` は、`deriveRunStatus` に渡したものと同じ値である（設計書 6.1.1。artifact の書き出しが、Run Status を導き直すのに使う）。
    return { result: deepFreeze({ run, pages, findings, statusInput }), skipReasonCodes: skipCodes, execution };
  }
}

/** T44c: `run.json` の `pageIncompleteReasonCounts`（理由を持つページがなければ項目を持たない）。 */
function pageIncompleteReasonCountsPartOf(
  pages: readonly RunPageSummary[],
): { readonly pageIncompleteReasonCounts?: readonly PageIncompleteReasonCount[] } {
  const counts = countPagesByIncompleteReason(pages);
  return counts.length === 0 ? {} : { pageIncompleteReasonCounts: counts };
}

/** DUP: `run.json` の `pageSamenessCounts`（軽い点検のページも、省いたページもなければ項目を持たない）。 */
function pageSamenessCountsPartOf(pages: readonly RunPageSummary[]): { readonly pageSamenessCounts?: RunPageSamenessCounts } {
  const counts = countPagesBySameness(pages);
  return counts === null ? {} : { pageSamenessCounts: counts };
}

/**
 * `run.json` の `authentication`（T35c と DEF-138）: 監査の段の数（スクリプトで送るログインの Run）と、セッションの切れの証拠（この実行で止まったとき）。
 * どちらもなければ項目を持たない（公開監査と、止まらなかったフォームの送信のログインの Run の `run.json` は変えない）。
 */
function runAuthenticationRecordOf(
  auditStage: AuditStageRunState | null,
  sessionLoss: SessionLossEvidence | null,
): { readonly authentication?: RunAuthenticationRecord } {
  const loss = sessionLoss === null ? {} : { sessionLoss };
  if (auditStage === null) {
    return sessionLoss === null ? {} : { authentication: { sessionLoss } };
  }
  return { authentication: { ...runAuthenticationSummaryOf(auditStage), ...loss } };
}

/**
 * Run のディレクトリを作れなかった理由（DEF-009）。`detail` は、失敗した作成の例外のメッセージ（切り詰めない）。
 * 結果は凍結する。
 */
function runDirectoryUnavailableReason(error: unknown): IncompleteReason {
  return Object.freeze({ code: 'RUN_DIRECTORY_UNAVAILABLE', detail: safeErrorMessage(error) });
}

/** クロールの上限に達した後の URL の理由（`detail` は `null`。設計書 5.6.3）。結果は凍結する。 */
function crawlLimitReason(code: CrawlLimitReasonCode): IncompleteReason {
  return Object.freeze({ code, detail: null });
}

/** 再開のための保存を書けなかったことを表す Run の理由（中断した Run の再開の設計書 4.3）。結果は凍結する。 */
function checkpointWriteFailedReason(detail: string): IncompleteReason {
  return Object.freeze({ code: CHECKPOINT_WRITE_FAILED_SKIP_REASON.code, detail });
}

/**
 * サイトの不調を検知した理由（サイトが応答しないときに Run を止める設計書 3.2）。止まるきっかけのページ（捨てたページ）の SKIPPED の理由と、
 * Run の理由に使う（どちらも同じ形）。`detail` は、ページの結果の不調の詳細（`PageAuditOutcome.siteUnavailableDetail`）。コードは、
 * `SITE_UNAVAILABLE_SKIP_REASON`（owner は `site-availability.ts`）のものを使う。結果は凍結する。
 */
function siteUnavailableReason(detail: string): IncompleteReason {
  return Object.freeze({ code: SITE_UNAVAILABLE_SKIP_REASON.code, detail });
}

/**
 * 前の実行で止まるきっかけになったページの URL の集まり（サイトが応答しないときに Run を止める設計書 3.2.1）。再開の入力の保存の巡回の
 * 記録で、理由 `SITE_UNAVAILABLE` の、`detail` のある SKIPPED の URL である（始めなかったページの `detail` は `null`）。新しい Run（保存なし）
 * では空。
 */
function siteUnavailableTriggerUrlsOf(saved: RunCheckpoint | null): ReadonlySet<string> {
  return new Set((saved?.frontier.entries ?? [])
    .filter(({ state, skipReason }) => state === 'SKIPPED'
      && skipReason?.code === SITE_UNAVAILABLE_SKIP_REASON.code
      && skipReason.detail !== null)
    .map(({ url }) => url));
}

/** robots.txt と sitemap.xml の取得の段階（サイトの不調の詳細の `<段階>`。サイトが応答しないときに Run を止める設計書 3.1）。 */
const SITE_METADATA_STAGE: Extract<SiteUnavailabilityStage, 'site-metadata'> = 'site-metadata';

/** サイトの不調で止めた実行の終わり方（`decideRunExecutionEndReason` が決める値の1つ。ここでは、前の実行の記録を読むだけに使う）。 */
const SITE_UNAVAILABLE_END_REASON: Extract<RunExecutionEndReason, 'STOPPED_BY_SITE_UNAVAILABLE'> = 'STOPPED_BY_SITE_UNAVAILABLE';

/**
 * 前の実行が、robots.txt と sitemap.xml の段階で、サイトの不調で止まったか（サイトが応答しないときに Run を止める設計書 3.2.1 の最後の項目）。
 * 再開の入力の保存で、取得の結果がなく（`siteMetadata` が `null`）、実行の記録の最後の終わり方が `STOPPED_BY_SITE_UNAVAILABLE` のとき真。
 * 新しい Run（保存なし）では偽。最後の実行は core の `lastRunExecutionOf` で選ぶ（PRE42-CC 組 UI-K。CC-048）。
 */
function stoppedAtSiteMetadataBefore(saved: RunCheckpoint | null): boolean {
  return saved !== null && saved.siteMetadata === null && lastRunExecutionOf(saved.executions)?.endReason === SITE_UNAVAILABLE_END_REASON;
}

/**
 * サイトの不調を検知したため、robots.txt と sitemap.xml の次のファイルを読み込まなかった（サイトが応答しないときに Run を止める設計書 3.1）。
 * `siteMetadataNavigationHooks` の包んだ間隔の待ちが投げる。`collectSiteMetadata` は、そのファイルを読み込まずに `FAILED` にする。
 */
class SiteMetadataNavigationSkippedError extends Error {
  constructor(unavailableDetail: string) {
    super(`site metadata navigation was not started after the site unavailability: ${unavailableDetail}`);
    this.name = 'SiteMetadataNavigationSkippedError';
  }
}

/**
 * robots.txt と sitemap.xml の取得（`collectSiteMetadata`）に渡す、包んだ間隔の待ちと、読み込みの観測の受け口（サイトが応答しないときに Run を
 * 止める設計書 3.1）。
 * - 受け口（`afterNavigation`）: 観測を `siteUnavailabilityOf` で判定し、最初の不調の詳細（`siteUnavailableDetail(null, 'site-metadata', <判定>)`。
 *   例: `site-metadata:TIMEOUT`）だけを残す。
 * - 包んだ間隔の待ち（`beforeNavigation`）: 不調を残していれば、待たずに `SiteMetadataNavigationSkippedError` を投げる（次のファイルを
 *   読み込ませない）。残していなければ、Run で1つの pacer の待ちを呼ぶ（サイトへの負荷の制御の設計書 4.1）。
 * - `unavailableDetail()`: 残した不調の詳細。不調を検知していなければ `null`。
 */
function siteMetadataNavigationHooks(pacer: NavigationPacer): {
  readonly beforeNavigation: () => Promise<number>;
  readonly afterNavigation: (observation: MainFrameLoadObservation) => void;
  readonly unavailableDetail: () => string | null;
} {
  let detail: string | null = null;
  return {
    beforeNavigation: async () => {
      if (detail !== null) {
        throw new SiteMetadataNavigationSkippedError(detail);
      }
      return pacer.beforeNavigation();
    },
    afterNavigation: (observation) => {
      if (detail !== null) {
        return;
      }
      const unavailability = siteUnavailabilityOf(observation);
      if (unavailability !== null) {
        detail = siteUnavailableDetail(null, SITE_METADATA_STAGE, unavailability);
      }
    },
    unavailableDetail: () => detail,
  };
}

/** 再試行の記録の一覧（`RunProgress.retries`）から、`url` の記録を取り除く（一覧そのものを変える。ほかの記録の順は変えない）。 */
function removeRetryRecordsOf(retries: RunRetryRecord[], url: string): void {
  const kept = retries.filter((record) => record.url !== url);
  retries.splice(0, retries.length, ...kept);
}

/**
 * 再開の入力から、`RunProgress` のうち保存から作り直すものを作る（中断した Run の再開の設計書 4.1、4.2）。新しい Run（入力なし）では、空の
 * 値にする。理由、再試行の記録、違反のフラグ、未処理の失敗の件数は、状態の保存の値の写し。保存した Safety Ledger の snapshot は、ページの外の
 * Ledger のもの（状態の保存）と、終わったページの Ledger のもの（ページの保存。終わった順）を、この順に並べたもの。終わったページの結果と
 * 再試行の前の Evidence は、URL を鍵にする（新しい Run と同じく、再試行の前の Evidence は、再試行したページだけに持つ）。MEM-3b: 終わったページの結果は、
 * ページの置き場所に入れる（`storeRunPage`。再試行の前の Evidence も、本体に加える）。
 */
async function restoredRunProgress(resume: RunCoordinatorResumeInput | undefined): Promise<Pick<
  RunProgress,
  | 'reasons'
  | 'retries'
  | 'savedSafety'
  | 'safetyViolationDetected'
  | 'stoppedBySafetyViolation'
  | 'unhandledFailures'
  | 'results'
  | 'pages'
  | 'retryEvidence'
  | 'revisits'
>> {
  if (resume === undefined) {
    return {
      reasons: [],
      retries: [],
      savedSafety: new RunSafetyTotals(),
      safetyViolationDetected: false,
      stoppedBySafetyViolation: false,
      unhandledFailures: 0,
      results: new Map(),
      pages: createRunPageStore<RunPageSummary>(),
      retryEvidence: new Map(),
      revisits: new Map(),
    };
  }
  const { checkpoint } = resume;
  const restored = await restoredRunPagesOf(resume.pages);
  // 状態の保存の snapshot（ページの外の Ledger）を先に、ページの保存の snapshot（終わった順）をその後に足す（並べていたときと同じ順）。
  const savedSafety = new RunSafetyTotals();
  for (const snapshot of checkpoint.safetyLedgerSnapshots) {
    savedSafety.add(snapshot);
  }
  savedSafety.addTotals(restored.safety);
  return {
    reasons: [...checkpoint.progress.reasons],
    retries: [...checkpoint.progress.retries],
    savedSafety,
    safetyViolationDetected: checkpoint.progress.safetyViolationDetected,
    stoppedBySafetyViolation: checkpoint.progress.stoppedBySafetyViolation,
    unhandledFailures: checkpoint.progress.unhandledFailures,
    results: restored.results,
    pages: restored.pages,
    retryEvidence: new Map(),
    revisits: restored.revisits,
  };
}

/**
 * 保存の robots.txt と sitemap.xml の Evidence から、Run Coordinator が使う取得の結果を作り直す（中断した Run の再開の設計書 4.2）。
 * sitemap は、sitemap.xml の Evidence から `sitemapEvidenceFromMetadata` で作り直す（取得したときと同じ変換）。
 */
function restoredSiteMetadata(siteMetadata: RunCheckpointSiteMetadata): RunSiteMetadata {
  const [, sitemap] = siteMetadata.records;
  return { records: siteMetadata.records, sitemap: sitemapEvidenceFromMetadata(sitemap) };
}

/**
 * 設定の開始の URL を、正規化の owner の `normalizeUrl` で正規化する（Run の開始の URL。発見の順の最初の URL）。正規化できなければ `Error` を
 * 投げる（設定は検証済みで、PREFLIGHT の `START_URL` も確かめるので、ふつうは起きない）。
 */
function normalizedStartUrl(config: AuditConfig): NormalizedHttpUrlEvidence {
  const startUrl = normalizeUrl(config.site.startUrl, config.site.startUrl, new Set(config.crawl.allowedQueryParameters));
  if (!startUrl.ok) {
    throw new Error(`start URL could not be normalized: ${startUrl.reason}`);
  }
  return startUrl.url;
}

/**
 * 巡回の候補の除外の判定（T25c。認証つきの Run は、監査の段の除外・セッションの切れの path・危険な語。SD-1: 公開監査は削除の語）。巡回と、WSO の範囲の画面の
 * 読めるかの判定が使う（同じ 1 つの判定）。DEF-296: 確かめていないリンクの数（Cross-page rule）と、表示用モデルのリンクの確かめ（`ReportRunFacts`）も、
 * 読む範囲の外の行き先をこの判定で分ける。
 */
export function excludedCrawlCandidateOf(config: AuditConfig, authentication: RunAuthentication | null): (url: string) => boolean {
  const crawlAllowedOrigins: ReadonlySet<string> = new Set(config.site.allowedOrigins);
  return authentication === null
    ? (url: string): boolean => crawlUrlHasDestructiveWord(url)
    : (url: string): boolean => isExcludedCrawlCandidate(url, crawlAllowedOrigins, authentication);
}

/**
 * WSO: 「チェックした画面だけ」の点検で読む画面のうち、読めるもの（許可 Origin の中で、巡回の候補の除外に当たらないもの。REV-WSO の M-1: 報告の数も、この数）。
 */
function readablePageScope(
  config: AuditConfig,
  authentication: RunAuthentication | null,
  urls: readonly NormalizedHttpUrlEvidence[],
): readonly NormalizedHttpUrlEvidence[] {
  const excluded = excludedCrawlCandidateOf(config, authentication);
  const admission = { allowedOrigins: new Set(config.site.allowedOrigins) };
  return Object.freeze(urls.filter((url) => classifyUrl(new URL(url), admission).kind === 'INTERNAL_NAVIGABLE' && !excluded(url)));
}

/**
 * WSO: 「チェックした画面だけ」の点検で読む画面を、開始の URL と同じ正規化の owner の `normalizeUrl` で正規化する（渡した順。同じ URL は 1 つ）。空・正規化できない
 * ものがあれば `TypeError`（親が確かめた値なので、ふつうは起きない）。
 */
function normalizedPageScope(config: AuditConfig, urls: readonly string[]): readonly NormalizedHttpUrlEvidence[] {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new TypeError('RunCoordinator pageScope must have one URL or more when given');
  }
  const normalized: NormalizedHttpUrlEvidence[] = [];
  for (const url of urls) {
    const result = typeof url === 'string' ? normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters)) : null;
    if (result === null || !result.ok) {
      throw new TypeError('RunCoordinator pageScope must have URLs that can be normalized');
    }
    if (!normalized.includes(result.url)) {
      normalized.push(result.url);
    }
  }
  return Object.freeze(normalized);
}

/**
 * 再開の入力の保存から、`RunProgress` のうち巡回の値（採番器、巡回の記録、開始の URL、robots.txt と sitemap.xml の取得の結果）を作り直す
 * （中断した Run の再開の設計書 4.2、4.10 の DEF-022。R7b）。Run Coordinator は、再開した実行の初め（PREFLIGHT の前）に、PREFLIGHT の結果に
 * よらず呼ぶ。PREFLIGHT に失敗して巡回を行わない実行でも、その出力と最後の状態の保存に、前の回までのページが入るようにするためである。
 * - 採番器と巡回の記録は、保存の整合の確かめと同じ `restoreRunCheckpointCrawl`（`run-checkpoint.ts`。CC-040）で作り直す。設定は、保存の
 *   実効の設定から取る（今の設定とは、再開する Run の選び方で、同じことを確かめ済み）。監査の途中だった URL と、待ち行列に戻す理由
 *   （`RESUME_REQUEUE_SKIP_REASON_CODES`）の SKIPPED の URL は、`QUEUED` に戻る（設計書 3.2、4.2）。
 * - 開始の URL は、新しい Run と同じく、設定の開始の URL を正規化したもの（`normalizedStartUrl`）。
 * - robots.txt と sitemap.xml は、保存に Evidence があれば、そこから作り直す（`restoredSiteMetadata`。取得し直さない）。なければ `null`。
 * 新しい Run（保存なし）では、すべて `null` にする（`#crawl` が作る）。保存の巡回の記録や採番器が不正なら、それぞれの作り直しの例外を投げる。
 */
function restoredCrawlProgress(
  config: AuditConfig,
  saved: RunCheckpoint | undefined,
  /** WSO: 「チェックした画面だけ」の点検か（開始の URL は、巡回の記録の最初の画面。新しい Run と同じ）。 */
  scoped: boolean,
): Pick<RunProgress, 'frontier' | 'allocator' | 'startUrl' | 'metadata'> {
  if (saved === undefined) {
    return { frontier: null, allocator: null, startUrl: null, metadata: null };
  }
  const { allocator, frontier } = restoreRunCheckpointCrawl(saved);
  const [firstEntry] = frontier.entries();
  return {
    frontier,
    allocator,
    startUrl: scoped && firstEntry !== undefined ? firstEntry.url : normalizedStartUrl(config),
    metadata: saved.siteMetadata === null ? null : restoredSiteMetadata(saved.siteMetadata),
  };
}

/**
 * 再開した実行の pacer の `initial`（中断した Run の再開の設計書 4.9 の最後の項目。RR の Minor-1。R7b）。読み込みの回数と待ちの合計は、保存の
 * 値のまま。最後の読み込みの開始の時刻は、保存の値と、この実行の開始の時刻（`run()` の初めに `now()` で1回読んだ値）の遅い方にする（保存の
 * 値が `null` なら、この実行の開始の時刻）。
 * 理由: 監査の途中のページの読み込みは、保存に入らない（ページの保存は、そのページの監査を終えた後に書く）。そのため、保存の値は、前の回の
 * 実際の最後の読み込みより前の時刻になりうる（2回目の Ctrl+C や停電で、そのページの保存の前に終わった場合）。前の回の実際の最後の読み込みは、
 * この実行の開始より前なので、この実行の開始から最小の間隔を空ければ、実際の最後の読み込みからも、最小の間隔以上空く（再開のたびに、最大で
 * 最小の間隔の分だけ待つ）。
 */
function resumedNavigationPacerRecord(saved: NavigationPacerSnapshot, executionStartedAtMs: number): NavigationPacerSnapshot {
  const { lastNavigationStartedAtMs } = saved;
  return {
    navigationCount: saved.navigationCount,
    totalWaitMs: saved.totalWaitMs,
    lastNavigationStartedAtMs: lastNavigationStartedAtMs === null
      ? executionStartedAtMs
      : Math.max(lastNavigationStartedAtMs, executionStartedAtMs),
  };
}

/**
 * 外から渡した pacer を、この Run の記録だけを返す形に包む（CCX-22）。待ち・間隔の引き上げ・送った時刻の記録は、そのまま渡す（待ちの owner は
 * pacer のまま）。記録（`snapshot`）の回数と待ちの合計は、包んだ時点の記録からの差にする（呼ぶ側が先に行った読み込み（ログインの段）を、Run の
 * 負荷の記録と保存に入れない）。最後の読み込みの開始の時刻は、そのまま返す（再開の起点は、遅い方が安全な側）。
 */
function runScopedNavigationPacer(pacer: NavigationPacer): NavigationPacer {
  const baseline = pacer.snapshot();
  return Object.freeze({
    beforeNavigation: () => pacer.beforeNavigation(),
    waitUntilNextNavigationDue: () => pacer.waitUntilNextNavigationDue(),
    snapshot: (): NavigationPacerSnapshot => {
      const current = pacer.snapshot();
      return Object.freeze({
        navigationCount: current.navigationCount - baseline.navigationCount,
        totalWaitMs: current.totalWaitMs - baseline.totalWaitMs,
        lastNavigationStartedAtMs: current.lastNavigationStartedAtMs,
      });
    },
    raiseMinimumInterval: (minIntervalMs: number) => pacer.raiseMinimumInterval(minIntervalMs),
    recordDocumentRequestSent: () => pacer.recordDocumentRequestSent(),
  });
}

/**
 * 状態の保存に入れる、ページの外の Safety Ledger の snapshot（中断した Run の再開の設計書 4.1）。保存した分（再開した Run の、前の回までの
 * ページの外の Ledger の snapshot）に続けて、この実行の Ledger のうち、ページの中で作ったもの（`pageLedgers`）を除いたものの snapshot を、
 * 作った順に並べる。
 */
function outsidePageLedgerSnapshots(
  saved: readonly SafetyLedgerSnapshot[],
  ledgers: readonly SafetyLedger[],
  pageLedgers: ReadonlySet<SafetyLedger>,
): SafetyLedgerSnapshot[] {
  return [...saved, ...ledgers.filter((ledger) => !pageLedgers.has(ledger)).map((ledger) => ledger.snapshot())];
}

/** 違反を検出したため、robots.txt と sitemap.xml の取得を始めなかったことを表す Run の理由か（`SITE_METADATA_SAFETY_ABORT_REASON`）。 */
function isSiteMetadataSafetyAbortReason(reason: IncompleteReason): boolean {
  return reason.code === SITE_METADATA_SAFETY_ABORT_REASON.code && reason.detail === SITE_METADATA_SAFETY_ABORT_REASON.detail;
}

/**
 * この時点の状態の保存（`checkpoint/state.json` の値。中断した Run の再開の設計書 4.1）を、R2 の `createRunCheckpoint` で作る。保存の状態は
 * `IN_PROGRESS`（最後の状態は、CLI がセッションの `finish` で書く。設計書 4.3.1）。Run の開始の時刻と実行の記録は、`checkpoint` のもの
 * （再開した Run では、最初の実行の開始と、保存の記録にこの実行の分を加えたもの）。保存の時刻は `savedAt`（呼び出し側が、その値を作る
 * 時点の時計で読む。R4b1）。中身は `runCheckpointContent` で作る。
 */
function runCheckpointState(input: {
  readonly config: AuditConfig;
  readonly checkpoint: RunCheckpointContext;
  /** 保存の時刻（ISO 8601。設計書 4.1）。 */
  readonly savedAt: string;
  readonly progress: RunProgress;
  readonly crawl: RunCrawlRecord;
}): RunCheckpoint {
  const { checkpoint } = input;
  return createRunCheckpoint({
    ...runCheckpointContent({ config: input.config, identity: checkpoint, progress: input.progress, crawl: input.crawl }),
    state: 'IN_PROGRESS',
    savedAt: input.savedAt,
    executions: checkpoint.executions,
  });
}

/**
 * この時点の Run の値から、状態の保存の中身（状態、保存の時刻、実行の記録を除いたもの）を写す（中断した Run の再開の設計書 4.1、4.3.2）。
 * 巡回の記録、採番器、理由、再試行の記録、各フラグ、未処理の失敗の件数、監査を始めたページの数、ページの外の Ledger の snapshot、robots.txt と
 * sitemap.xml の Evidence、負荷の記録、終わったページの ID を、この時点の値で写す（後で `progress` が変わっても、写した中身は変わらない）。
 * Safety Ledger は、ページの外で作ったものの snapshot（`crawl.outsidePageSnapshots`。再開した Run では、前の回までの分を含む）だけを入れる。
 * robots.txt と sitemap.xml は、`metadata` の Evidence だけを入れる（取得しなかった場合は `null`）。
 * 新しい Run で巡回を始めなかった場合（`crawl` が `null`。PREFLIGHT の失敗など。設計書 4.3.2）は、巡回の記録と採番器を、新しい採番器と、
 * それで作った巡回の記録の値（空）にし、監査を始めたページの数を 0、終わったページを空、robots.txt と sitemap.xml を `null` にして、
 * ページの外の Ledger の snapshot を、この実行のすべての Ledger の snapshot にする。再開した実行で PREFLIGHT に失敗した場合は、保存から
 * 作り直した巡回の値（`crawl`）を渡す（設計書 4.10 の DEF-022）。
 */
function runCheckpointContent(input: {
  readonly config: AuditConfig;
  readonly identity: Pick<RunCheckpointContext, 'runId' | 'toolVersion' | 'startedAt' | 'authentication' | 'pageScope'>;
  readonly progress: RunProgress;
  readonly crawl: RunCrawlRecord | null;
}): RunCheckpointContentValues {
  const { config, identity, progress, crawl } = input;
  const crawlSnapshots = (): Pick<RunCheckpointContentValues, 'frontier' | 'allocator'> => {
    if (crawl !== null) {
      return { frontier: crawl.frontier.snapshot(), allocator: crawl.allocator.snapshot() };
    }
    const allocator = new IdAllocator();
    return { frontier: new CrawlFrontier(config.crawl.maxDepth, allocator).snapshot(), allocator: allocator.snapshot() };
  };
  return {
    runId: identity.runId,
    toolVersion: identity.toolVersion,
    startedAt: identity.startedAt,
    effectiveConfig: config,
    ...crawlSnapshots(),
    progress: {
      reasons: [...progress.reasons],
      retries: [...progress.retries],
      safetyViolationDetected: progress.safetyViolationDetected,
      stoppedBySafetyViolation: progress.stoppedBySafetyViolation,
      unhandledFailures: progress.unhandledFailures,
      guardEnabled: progress.guardEnabled,
      preflightFailed: progress.preflightFailed,
      pagesStarted: crawl === null ? 0 : crawl.pagesStarted,
    },
    safetyLedgerSnapshots: crawl === null ? progress.safetyLedgers.map((ledger) => ledger.snapshot()) : [...crawl.outsidePageSnapshots],
    siteMetadata: crawl === null || progress.metadata === null ? null : { records: progress.metadata.records },
    load: {
      pacer: progress.navigationPacer.snapshot(),
      meter: progress.loadMeter.snapshot(),
      // T35c: スクリプトで送るログインの監査の Run だけ、承認したサービスの Origin の区分と監査の段の数を保存する（再開で続ける）。
      ...serviceOriginLoadOf(progress),
    },
    completedPageIds: crawl === null ? [] : [...crawl.completedPageIds],
    // EV-5: 読み直しを終えたページがあるときだけ（ない保存の形は変えない）。
    ...(crawl === null || crawl.revisitedPageIds.length === 0 ? {} : { revisitedPageIds: [...crawl.revisitedPageIds] }),
    // T25g-2: 認証つきの Run だけ、Run の種類を記録する（公開監査の保存の形は変えない）。
    ...(identity.authentication === null ? {} : { authentication: identity.authentication }),
    // WSO: 「チェックした画面だけ」の Run だけ、範囲を記録する（サイトの全部の画面の保存の形は変えない）。
    ...(identity.pageScope === null ? {} : { pageScope: identity.pageScope }),
  };
}

/** 状態の保存から、状態の保存の中身（`schemaVersion`、状態、保存の時刻、実行の記録を除いたもの）を取る（最後に書けた保存の値。設計書 4.3.2）。 */
function checkpointContentOf(checkpoint: RunCheckpoint): RunCheckpointContentValues {
  const { schemaVersion: _schemaVersion, state: _state, savedAt: _savedAt, executions: _executions, ...content } = checkpoint;
  return content;
}

/**
 * Run の後の保存の終わり方を作る（中断した Run の再開の設計書 4.3.2。R4b2）。行うことは `decideRunCheckpointConclusion` だけが決める
 * （ここでは、その入力を集め、`FINISH` の最後の状態の保存を作るだけ）。
 * - `FINISH` の最後の状態の保存は、判定が指す中身（巡回の終わりの値か、最後に書けた保存の値）に、判定の状態、`run.json` の `finishedAt` と
 *   同じ保存の時刻、実行の記録（前の回までの閉じた記録（環境付き）と、この実行の分（終わりの時刻は `run.json` の `finishedAt`、終わり方は
 *   `run.json` と同じ、環境はこの実行のもの））を加えて、`createRunCheckpoint` で作る。
 * - 巡回の終わりの値が `checkRunCheckpointConsistency` を通らない場合（巡回の途中の予期しない例外で、監査を終えたページの保存を書いて
 *   いないとき）は、最後に書けた保存の値を使う。最後に書けた保存もなければ `ABANDON` にする。
 * 結果は凍結する。
 */
function checkpointConclusionOf(input: {
  readonly sessionStarted: boolean;
  readonly resumed: boolean;
  readonly finalized: RunFinalization;
  readonly checkpointWriteFailed: boolean;
  readonly lastWrittenCheckpoint: RunCheckpoint | null;
  readonly crawlEndContent: RunCheckpointContentValues | null;
  /** 前の回までの実行の記録（保存の形。閉じたもの）。 */
  readonly previousExecutions: readonly RunCheckpointExecution[];
  /** この実行の環境。 */
  readonly environment: RunEnvironment;
}): RunCoordinatorCheckpointConclusion {
  const { result, skipReasonCodes, execution } = input.finalized;
  const decision = decideRunCheckpointConclusion({
    sessionStarted: input.sessionStarted,
    runStatus: result.run.runStatus,
    skipReasonCodes,
    checkpointWriteFailed: input.checkpointWriteFailed,
    resumed: input.resumed,
    preflightFailed: result.statusInput.preflightFailed,
    hasWrittenCheckpoint: input.lastWrittenCheckpoint !== null,
  });
  if (decision.action === 'NONE') {
    return NONE_CHECKPOINT_CONCLUSION;
  }
  if (decision.action === 'ABANDON') {
    return ABANDON_CHECKPOINT_CONCLUSION;
  }
  const finalCheckpoint = (content: RunCheckpointContentValues): RunCheckpoint => createRunCheckpoint({
    ...content,
    state: decision.state,
    savedAt: execution.finishedAt,
    executions: executionsEndingWith(input.previousExecutions, { ...execution, environment: input.environment }),
  });
  const finish = (checkpoint: RunCheckpoint): RunCoordinatorCheckpointConclusion => Object.freeze({
    action: decision.action,
    checkpoint,
    finishEvenIfOutputFails: decision.finishEvenIfOutputFails,
  });
  if (decision.content === 'CRAWL_END' && input.crawlEndContent !== null) {
    const checkpoint = finalCheckpoint(input.crawlEndContent);
    if (checkRunCheckpointConsistency(checkpoint).ok) {
      return finish(checkpoint);
    }
  }
  return input.lastWrittenCheckpoint === null
    ? ABANDON_CHECKPOINT_CONCLUSION
    : finish(finalCheckpoint(checkpointContentOf(input.lastWrittenCheckpoint)));
}

/** 前の回までの実行の記録 `earlier` の後に、この実行の記録 `last` を加えた、1件以上の一覧（中断した Run の再開の設計書 4.8）。 */
function executionsEndingWith<TExecution>(earlier: readonly TExecution[], last: TExecution): readonly [TExecution, ...TExecution[]] {
  const [first, ...rest] = earlier;
  return first === undefined ? [last] : [first, ...rest, last];
}

/**
 * 前の回までの実行の記録（保存の、閉じた記録）を、`run.json` の実行の記録の形にする（環境を除く。中断した Run の再開の設計書 4.8）。
 * 終わり方か終わりの時刻が `null` の記録（閉じていない記録）は、`TypeError` を投げる（保存の整合の確かめ `checkRunCheckpointConsistency`
 * で防いでいるので、起きない）。
 */
function runExecutionRecord(execution: RunCheckpointExecution): RunExecution {
  const { startedAt, finishedAt, endReason, automaticRelogin } = execution;
  if (finishedAt === null || endReason === null) {
    throw new TypeError('an earlier execution of the checkpoint is not closed: its finishedAt or endReason is null');
  }
  // DEF-200: ログインし直して自動で始めた実行の印は、前の回の記録にも残す（あるときだけ）。
  return Object.freeze({ startedAt, finishedAt, endReason, ...(automaticRelogin === undefined ? {} : { automaticRelogin }) });
}

/**
 * Run を始められなかったことを表す例外か（`RunDirectoryUnavailableError`、`RunResumeUnavailableError`、`RunNotResumableError`）。
 * `run()` がこれで reject した場合の保存の終わり方は `NONE`（設計書 4.3.2）。
 */
function isRunUnavailableError(error: unknown): boolean {
  return error instanceof RunDirectoryUnavailableError
    || error instanceof RunResumeUnavailableError
    || error instanceof RunNotResumableError;
}

/**
 * Run の結果の `load`（サイトへの負荷の制御の設計書 4.5）。`#finalize` が、Browser を閉じた後に呼ぶ（閉じる間に届いた要求の終わりの
 * 事象も含めるため）。設定の値は実効の設定から、読み込みの回数と待った時間の合計は pacer から、要求の実績は meter から取る。
 */
function runLoad(config: AuditConfig, progress: RunProgress): RunLoad {
  const pacer = progress.navigationPacer.snapshot();
  const serviceOriginRequests = progress.loadMeter.serviceOriginRequests();
  return {
    minNavigationIntervalMs: config.crawl.minNavigationIntervalMs,
    // L14: 利用者が指定したときだけ書く（ないときは上限なし）。
    ...(config.crawl.maxInteractionsPerPage === undefined ? {} : { maxInteractionsPerPage: config.crawl.maxInteractionsPerPage }),
    navigationCount: pacer.navigationCount,
    pacingWaitMs: pacer.totalWaitMs,
    requests: progress.loadMeter.snapshot(),
    // T35c（Task 35 の設計書 3.4）: 承認したサービスの Origin の区分（スクリプトで送るログインの監査の Run だけ）。
    ...(serviceOriginRequests === null ? {} : { approvedServiceOrigins: serviceOriginRequests }),
  };
}

/** 保存の負荷の記録の、スクリプトで送るログインの監査の Run だけの項目（T35c。ほかの Run は空）。 */
function serviceOriginLoadOf(progress: RunProgress): Pick<RunCheckpointLoad, 'approvedServiceOrigins' | 'auditStageCounts'> {
  const serviceOriginRequests = progress.loadMeter.serviceOriginRequests();
  return {
    ...(serviceOriginRequests === null ? {} : { approvedServiceOrigins: serviceOriginRequests }),
    ...(progress.auditStage === null ? {} : { auditStageCounts: auditStageCountsOf(progress.auditStage) }),
  };
}

/** Desktop のビューポートの `NAVIGATION_FAILED` の detail が再試行の対象なら、再試行の記録の項目を返す。対象でなければ `null`。 */
function retryableNavigationFailure(
  desktop: ViewportAuditResult,
): Pick<RunRetryRecord, 'navigationOutcome' | 'detail'> | null {
  if (desktop.navigationOutcome === null || desktop.navigationOutcome === 'OK') {
    return null;
  }
  const reason = desktop.incompleteReasons.find(
    ({ code, detail }) => code === 'NAVIGATION_FAILED' && detail !== null && RETRYABLE_NAVIGATION_FAILURE_DETAILS.includes(detail),
  );
  return reason === undefined ? null : { navigationOutcome: desktop.navigationOutcome, detail: reason.detail };
}

/**
 * T44R3 の M-2: 巡回が知っている URL（待ち行列のすべての URL と、監査したページの URL・最終の URL）。保存のページを書くとき、書き手が記録した要求の URL を
 * 値で照らす段で照らさない値（あとで監査するページの URL を、続けて終えた Run と同じく伏せない）。
 */
function crawlKnownUrlsOf(frontier: CrawlFrontier, results: readonly Pick<PageAuditResult, 'pageUrl' | 'viewports'>[]): string[] {
  const urls = new Set<string>(frontier.entries().map(({ url }) => url));
  for (const result of results) {
    urls.add(result.pageUrl);
    for (const { finalUrl } of Object.values(result.viewports)) {
      if (finalUrl !== null) {
        urls.add(finalUrl);
      }
    }
  }
  return [...urls];
}

/**
 * DEF-236: Evidence（ページの途中の Evidence も）の、Desktop の Link のうち、待ち行列に入れうる URL（読んだページの辺 `auditPageOutcomeOf` と同じ 1 つの選び方
 * `crawlableLinkUrlsOf`。SD-1: 削除の語のリンクを除く）。
 */
function desktopLinkUrlsOf(evidence: readonly EvidenceRecord[]): NormalizedHttpUrlEvidence[] {
  return viewportEvidenceOfType({ evidence }, 'link', ['desktop']).flatMap(({ payload }) => crawlableLinkUrlsOf(payload.links));
}

/**
 * MEM-3b（DEF-266）: 監査した URL の最終の試行の結果（`result`。評価の形）を、ページの置き場所に入れる。要約は評価の形から作り、本体は再試行の前の試行の Evidence
 * （`retryEvidence`）を先頭に加えた形で圧縮する。同じ URL の結果がすでにあれば、入れ替える（添字は変えない）。再試行の前の試行の Evidence は消す。
 */
async function storeRunPage(
  progress: Pick<RunProgress, 'results' | 'pages' | 'retryEvidence'>,
  url: string,
  result: PageAuditResult,
  retryEvidence: readonly EvidenceRecord[],
): Promise<void> {
  const body = withLeadingEvidence(result, retryEvidence);
  const summary = runPageSummaryOf(result);
  const index = progress.results.get(url);
  if (index === undefined) {
    await progress.pages.add(body, summary);
    progress.results.set(url, progress.pages.length - 1);
  } else {
    await progress.pages.replace(index, body, summary);
  }
  progress.retryEvidence.delete(url);
}

/**
 * ページの結果の Evidence の先頭に、`records` を加える（metadata の Evidence は設計書 5.6.2、再試行の前の試行の Evidence は 5.6.4）。
 * 加えるものがなければ、結果をそのまま返す。
 */
function withLeadingEvidence(result: PageAuditResult, records: readonly EvidenceRecord[]): PageAuditResult {
  return records.length === 0 ? result : { ...result, evidence: [...records, ...result.evidence] };
}

function sitemapOf(metadata: RunSiteMetadata | null): SitemapEvidence | null {
  return metadata === null ? null : metadata.sitemap;
}

/**
 * スキーマに合わないページと Finding の理由（`REQUIRED_ARTIFACT_INVALID`。`detail` は `<スキーマ>:<ID>:<最初の誤り>`）。
 * 理由の組み立ては `requiredArtifactInvalidReason` だけで行う（CC-022。`ArtifactWriter` と同じ理由になり、重複を除ける）。
 */
async function invalidArtifactReasons(
  pages: RunPages,
  findings: readonly Finding[],
): Promise<IncompleteReason[]> {
  const reasons: IncompleteReason[] = [];
  const check = async (schema: 'page' | 'finding', id: PageId | string, value: unknown): Promise<void> => {
    const validation = await validateArtifact(schema, value);
    if (!validation.ok) {
      reasons.push(requiredArtifactInvalidReason(schema, id, validation.errors));
    }
  };
  // MEM-3b: ページは、置き場所から 1 つずつ戻して確かめる。
  await forEachRunPage(pages, async (page) => {
    await check('page', page.pageId, page);
  });
  for (const finding of findings) {
    await check('finding', finding.findingId, finding);
  }
  return reasons;
}

import type { Browser } from 'playwright';
import { evaluateCrossPageRules } from '../audit/cross-page-rules.js';
import type { BrowserContextFactory, SafetyLedgerFactory } from '../browser/context-factory.js';
import { ResourceCache } from '../browser/resource-delivery.js';
import type { AuditConfig } from '../config/types.js';
import { createRunArtifactDirectory, type RunArtifactDirectoryCreation } from '../core/artifact-layout.js';
import type {
  AuditRunResult,
  CrawlLimitState,
  EvidenceRecord,
  Finding,
  IncompleteReason,
  IncompleteReasonCode,
  PageAuditOutcome,
  PageAuditResult,
  PageId,
  RunCheckpointState,
  RunEnvironment,
  RunExecution,
  RunId,
  RunLoad,
  RunProgressReport,
  RunRetryRecord,
  RunSummary,
  ViewportAuditResult,
} from '../core/contracts.js';
import { resolveTimeoutMs, wait } from '../core/deadline.js';
import type { NormalizedHttpUrlEvidence, SitemapEvidence } from '../core/evidence-types.js';
import { safeErrorMessage } from '../core/errors.js';
import { isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { BROWSER_CLOSE_TIMEOUT_MS, MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { validateArtifact } from '../core/schema-validator.js';
import {
  deriveRunStatus,
  requiredArtifactInvalidReason,
  ruleEvaluationFailureReason,
  unhandledFailureReason,
  type RunStatusInput,
} from '../core/status.js';
import { createLoadMeter, type LoadMeter } from '../crawl/load-meter.js';
import { createNavigationPacer, type NavigationPacer, type NavigationPacerSnapshot } from '../crawl/navigation-pacer.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { collectSiteMetadata as collectSiteMetadataDefault, type SiteMetadataResult } from '../crawl/site-metadata.js';
import { sitemapEvidenceFromMetadata } from '../crawl/sitemap-evidence.js';
import type { SafetyLedger, SafetyLedgerSnapshot } from '../safety/safety-ledger.js';
import { CrawlFrontier, type CrawlUrlEntry } from './crawl-frontier.js';
import {
  collectRunEnvironment as collectRunEnvironmentDefault,
  readToolVersion as readToolVersionDefault,
} from './environment.js';
import { IdAllocator } from './id-allocator.js';
import {
  navigationFailureDetail,
  PageAuditor,
  SAFETY_VIOLATION_ABORT_REASON,
  type PageAuditorDependencies,
} from './page-auditor.js';
import {
  resolvePassiveSessionDeadlines,
  type PassiveSessionDeadlineOptions,
  type ResolvedPassiveSessionDeadlines,
} from './passive-session-open.js';
import { closeBrowserBeforeDeadline, runPreflight as runPreflightDefault, type BrowserLauncher } from './preflight.js';
import {
  checkRunCheckpointConsistency,
  closeInterruptedRunExecutions,
  createRunCheckpoint,
  createRunCheckpointPage,
  decideRunCheckpointConclusion,
  decideRunExecutionEndReason,
  decideRunResumption,
  RESUME_REQUEUE_SKIP_REASON_CODES,
  type RunCheckpoint,
  type RunCheckpointConclusion,
  type RunCheckpointConclusionAction,
  type RunCheckpointExecution,
  type RunCheckpointInput,
  type RunCheckpointPage,
  type RunCheckpointSiteMetadata,
} from './run-checkpoint.js';
import {
  RUN_CHECKPOINT_SESSION_RESUME_FAILURE_REASONS,
  type RunCheckpointSession,
  type RunCheckpointSessionStart,
} from './run-checkpoint-session.js';
import {
  countInteractionOutcomes,
  countPagesByStatus,
  countPartialViewports,
  countViewportPages,
  summarizeRunSafety,
  viewportEvidenceOfType,
} from './run-aggregation.js';
import { createRunIdFromTime } from './run-id.js';
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
  /** 終わったページの保存（`checkpoint.completedPageIds` の順）。 */
  readonly pages: readonly RunCheckpointPage[];
}

/** `RunCoordinator` に注入するもの（Task 14〜17 の設計書 5.6.1）。 */
export interface RunCoordinatorDependencies {
  /** `loadConfig` で検証済みの設定。 */
  readonly config: AuditConfig;
  /** Chromium を起動する関数（本番では `chromium.launch`）。 */
  readonly launchBrowser: BrowserLauncher;
  /** Context ごとに新しい `SafetyLedger` を作る関数。 */
  readonly createSafetyLedger: SafetyLedgerFactory;
  /** 時刻（`startedAt`、`finishedAt`、`runId`、Evidence の `observedAt`）に使う時計。 */
  readonly clock: () => Date;
  /** 期限と実行時間に使う、現在の時刻（ミリ秒）。`Date.now()` と同じ基準でなければならない（`PageAuditorDependencies.now`）。 */
  readonly now: () => number;
  /**
   * 出力先の根のディレクトリ。Run の artifact は、この下の `<runId>` のディレクトリ（`runArtifactDirectory`）に置く。
   * そのディレクトリは、Run の開始の時点で、Run Coordinator が排他的に作る（`createRunArtifactDirectory`。DEF-009）。
   * PREFLIGHT は、そのディレクトリに書けることを確かめる。スクリーンショットも、そのディレクトリの下に置く。
   */
  readonly outputDirectory: string;
  /** `PageAuditor` を作る関数（テストで偽の Page Auditor を渡すため）。省略すると `new PageAuditor(dependencies)`。 */
  readonly createPageAuditor?: (dependencies: PageAuditorDependencies) => RunPageAuditor;
  /** robots.txt と sitemap.xml の取得（テスト用の差し替え口）。省略すると `collectSiteMetadata`。 */
  readonly collectSiteMetadata?: typeof collectSiteMetadataDefault;
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
   * 省略した項目は、`limits.ts` の定数（`SESSION_OPEN_TIMEOUT_MS`、`PAGE_CLOSE_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を使う。
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
   * と Link からの発見の後、次のページを始める前に）、その時点の進み具合の事実（`RunProgressReport`）を渡す。受け手は待たない。
   * 受け手の例外（と、受け手が返した Promise の reject）は、握りつぶす。Run を止めず、Run の理由にもしない（表示の失敗で監査を止めない
   * ため）。関数でない値は、コンストラクタが `TypeError` を投げる。
   */
  readonly onProgress?: ((report: RunProgressReport) => void) | undefined;
  /**
   * 再開のための保存のセッション（中断した Run の再開の設計書 4.3、4.3.1）。省略すると、保存しない（今のまま）。作るのは CLI か
   * テストである。渡すと、Run Coordinator は、次の時期に保存を頼む。
   * - Run のディレクトリを排他的に作った直後（PREFLIGHT の前）に、`start(runDirectory, { mode: 'NEW_RUN' })` で始める。
   * - robots.txt と sitemap.xml の取得の後に、状態の保存（`saveState`）を1回行う。
   * - 各ページの `markFinished` と Link からの発見の後に、そのページの保存（`savePage`）と、状態の保存（`saveState`）を、この順に行う。
   * 保存の状態は `IN_PROGRESS` のままにする（最後の状態は、CLI が最後の出力を書き終えた後に、セッションの `finish` で書く）。
   * CLI が行う保存の終わり方（`finish` に渡す最後の状態の保存、または `abandon`）は、`run()` の後に `checkpointConclusion()` で返す
   * （設計書 4.3.2。R4b2）。
   * 始め方、ページの保存、状態の保存の関数を持たない値は、コンストラクタが `TypeError` を投げる。
   * 再開（`resumeFrom`）のときは、Run のディレクトリを作らずに、`start(resumeFrom.runDirectory, { mode: 'RESUME', completedPageIds })`
   * で始める（`run()` を見る）。
   */
  readonly checkpointSession?: RunCoordinatorCheckpointSession | undefined;
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
   * 失敗、ページ数、実行時間の後）。印が付いていれば、その URL から後を、理由 `RUN_INTERRUPTED`（`detail` は `null`）の SKIPPED にする。
   * 今のページ（ビューポート、幅の走査、Interaction の候補、再試行）は最後まで行う。robots.txt と sitemap.xml の取得も止めない。
   * `AbortSignal` でない値は、コンストラクタが `TypeError` を投げる。
   */
  readonly stopSignal?: AbortSignal | undefined;
}

/**
 * 再試行の対象の、Desktop の `NAVIGATION_FAILED` の理由の `detail` の一覧（Task 14〜17 の設計書 5.2、5.6.4）。
 * 一時的なナビゲーションの失敗（期限切れと、接続の一時的な失敗）だけである。detail の形は、`navigationFailureDetail` だけが作る。
 * 4xx・5xx の応答（ナビゲーションは `OK`）、安全のための遮断（`BLOCKED_EXTERNAL_REDIRECT`）、そのほかのエラーは、再試行しない。
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
 * Run のディレクトリを、Run の開始の時点で作れなかった（DEF-009。Task 18 の前の整理の設計書 第6章）。`RunCoordinator.run()` が、
 * これで reject する。
 * - `result` は、確定した Run である。PREFLIGHT の失敗と同じく、対象のサイトにアクセスせず、Browser も起動せずに確定したもので、
 *   Run Status は `deriveRunStatus` が導いた `FAILED`、理由は `RUN_DIRECTORY_UNAVAILABLE` である。
 * - この Run の artifact は、書かない（書く場所が、別の Run のディレクトリだから）。確定した Run を返り値にせず、例外にするのは、
 *   呼び出し側が `ArtifactWriter` に渡さないようにするためである。
 * - `alreadyExists` は、同じ名前の Run のディレクトリがすでにあった（`EEXIST`）場合に真。出力先を作れなかった場合などは偽。
 */
export class RunDirectoryUnavailableError extends Error {
  /** 確定した Run（Run Status は `FAILED`）。 */
  readonly result: AuditRunResult;
  /** 作ろうとした Run のディレクトリ。 */
  readonly runDirectory: string;
  /** 同じ名前の Run のディレクトリが、すでにあったか。 */
  readonly alreadyExists: boolean;

  constructor(input: {
    readonly result: AuditRunResult;
    readonly runDirectory: string;
    readonly alreadyExists: boolean;
    readonly cause: unknown;
  }) {
    super(
      `run directory could not be created: ${input.runDirectory}: ${safeErrorMessage(input.cause, MAX_ERROR_MESSAGE_LENGTH)}`,
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

  constructor(input: { readonly runId: RunId; readonly runDirectory: string; readonly checkpointState: RunCheckpointState }) {
    super(`run checkpoint is not resumable: ${input.runId} (${input.checkpointState}): ${input.runDirectory}`);
    this.name = 'RunNotResumableError';
    this.runId = input.runId;
    this.runDirectory = input.runDirectory;
    this.checkpointState = input.checkpointState;
  }
}

/**
 * 再開のときに、保存のセッションを始められなかった理由の閉じた一覧（中断した Run の再開の設計書 4.4）。
 * - `LOCK_HELD_BY_ACTIVE_RUN`・`LOCK_TAKEN_OVER_CONCURRENTLY`: セッションの再開の始め方の結果の理由
 *   （`RUN_CHECKPOINT_SESSION_RESUME_FAILURE_REASONS`）。別のプロセスが、この Run を実行している。
 * - `CHECKPOINT_STORE_FAILED`: 始め方が reject した（ロックや後始末を、書けなかった、消せなかった）。
 */
export const RUN_RESUME_UNAVAILABLE_REASONS = Object.freeze([
  ...RUN_CHECKPOINT_SESSION_RESUME_FAILURE_REASONS,
  'CHECKPOINT_STORE_FAILED',
] as const);
export type RunResumeUnavailableReason = (typeof RUN_RESUME_UNAVAILABLE_REASONS)[number];

/**
 * 再開のときに、保存のセッションを始められなかった（中断した Run の再開の設計書 4.4）。`RunCoordinator.run()` が、PREFLIGHT も Browser の
 * 起動もせず、Run を確定せずに（出力を作らずに）、これで reject する。Run のディレクトリを作れなかった場合（`RunDirectoryUnavailableError`）
 * と同じく、CLI が文言と終了コードを示す（R5）。
 * - `reason`: 始められなかった理由（`RUN_RESUME_UNAVAILABLE_REASONS`）。
 * - `existingLock`: セッションが判定したロックの中身（`CHECKPOINT_STORE_FAILED` では `null`）。
 * - `cause`: `CHECKPOINT_STORE_FAILED` では、始め方の reject の値。
 */
export class RunResumeUnavailableError extends Error {
  /** 保存の Run の ID。 */
  readonly runId: RunId;
  /** 再開の入力の Run のディレクトリ。 */
  readonly runDirectory: string;
  readonly reason: RunResumeUnavailableReason;
  readonly existingLock: unknown;

  constructor(input: {
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly reason: RunResumeUnavailableReason;
    readonly existingLock: unknown;
    readonly cause?: unknown;
  }) {
    const causeMessage = 'cause' in input ? `: ${safeErrorMessage(input.cause, MAX_ERROR_MESSAGE_LENGTH)}` : '';
    super(
      `run could not be resumed: ${input.runDirectory}: ${input.reason}${causeMessage}`,
      'cause' in input ? { cause: input.cause } : undefined,
    );
    this.name = 'RunResumeUnavailableError';
    this.runId = input.runId;
    this.runDirectory = input.runDirectory;
    this.reason = input.reason;
    this.existingLock = input.existingLock;
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
  /** metadata の取得に使った page を閉じる処理の失敗。 */
  metadataPageClose: 'site-metadata-page-close',
  /** metadata の取得に使った Context を閉じる処理の失敗。 */
  metadataContextClose: 'site-metadata-context-close',
  /** 環境の事実（User-Agent）の読み取りに使った page を閉じる処理の失敗と、期限切れ（RP18 の指摘1）。 */
  environmentPageClose: 'environment-page-close',
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

/** 保存のセッションを始められなかった理由の `detail`（ロックのファイルが、すでにあった。設計書 4.4）。 */
const CHECKPOINT_LOCK_EXISTS_DETAIL = 'checkpoint lock already exists';

/** 保存のセッションの操作の名前（`RunCoordinatorCheckpointSession`）。 */
const CHECKPOINT_SESSION_OPERATION_NAMES = Object.freeze([
  'start',
  'savePage',
  'saveState',
] as const satisfies readonly (keyof RunCoordinatorCheckpointSession)[]);

/** 再開のときに、待ち行列に戻す SKIPPED の理由のコード（`CrawlFrontier.restore` に渡す。中断した Run の再開の設計書 3.2）。 */
const RESUME_REQUEUE_SKIP_REASON_CODE_SET: ReadonlySet<IncompleteReasonCode> = new Set(RESUME_REQUEUE_SKIP_REASON_CODES);

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
  /** 監査を始めたページの数。 */
  readonly pagesStarted: number;
  /** ページの外で作った Safety Ledger の snapshot（再開した Run では、前の回までの分を含む）。 */
  readonly outsidePageSnapshots: readonly SafetyLedgerSnapshot[];
  /** 監査を終え、ページの保存を書いたページの ID（終わった順）。 */
  readonly completedPageIds: readonly PageId[];
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
  readonly result: AuditRunResult;
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

/** 1回の `run()` の途中の状態。 */
interface RunProgress {
  readonly reasons: IncompleteReason[];
  readonly retries: RunRetryRecord[];
  /**
   * 保存した Safety Ledger の snapshot（再開した Run だけ。新しい Run では空。中断した Run の再開の設計書 4.1、4.2）。前の回までの、ページの外の
   * Ledger の snapshot（状態の保存のもの）と、終わったページの Ledger の snapshot（ページの保存のもの。終わった順）を、この順に並べたもの。
   * Ledger は作り直さず、この実行の Ledger（`safetyLedgers`）とは別に持つ。違反の確かめ（`#safetyViolationRecorded`）と、Run の Safety の
   * 集計（`#finalize`）は、この snapshot を、この実行の Ledger より前のものとして扱う（Ledger を作った順と同じ）。
   */
  readonly savedSafetyLedgerSnapshots: readonly SafetyLedgerSnapshot[];
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
   * 保存）。中断した Run の再開の設計書 4.2）。
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
  readonly loadMeter: LoadMeter;
  /** 監査した URL の、最終の試行の結果。 */
  readonly results: Map<string, PageAuditResult>;
  /** 再試行した URL の、再試行の前の試行の Evidence（最終のページの `evidence` に残す。設計書 5.6.4、R15 の Minor-6）。 */
  readonly retryEvidence: Map<string, readonly EvidenceRecord[]>;
  /**
   * 実行時間の上限を超えたか（設計書 5.6.3）。ページとページの間でだけ確かめるので、最後のページで超え、監査していない URL が
   * 残らない場合も、事実として `crawlLimits.maxRuntimeReached` に記録する（その場合は、Run の理由は付けない。R15 の Minor-4）。
   */
  maxRuntimeExceeded: boolean;
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
  readonly #createSafetyLedger: SafetyLedgerFactory;
  readonly #clock: () => Date;
  readonly #now: () => number;
  readonly #outputDirectory: string;
  readonly #createPageAuditor: (dependencies: PageAuditorDependencies) => RunPageAuditor;
  readonly #collectSiteMetadata: typeof collectSiteMetadataDefault;
  readonly #runPreflight: typeof runPreflightDefault;
  readonly #collectRunEnvironment: typeof collectRunEnvironmentDefault;
  readonly #readToolVersion: typeof readToolVersionDefault;
  readonly #browserCloseTimeoutMs: number;
  readonly #deadlines: ResolvedPassiveSessionDeadlines;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onProgress: ((report: RunProgressReport) => void) | undefined;
  readonly #checkpointSession: RunCoordinatorCheckpointSession | undefined;
  readonly #resumeFrom: RunCoordinatorResumeInput | undefined;
  readonly #stopSignal: AbortSignal | undefined;
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
        || !Array.isArray(resumeFrom.pages)
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
    this.#config = config;
    this.#launchBrowser = launchBrowser;
    this.#createSafetyLedger = createSafetyLedger;
    this.#clock = clock;
    this.#now = now;
    this.#outputDirectory = outputDirectory;
    this.#createPageAuditor = dependencies.createPageAuditor ?? ((pageAuditorDependencies) => new PageAuditor(pageAuditorDependencies));
    this.#collectSiteMetadata = dependencies.collectSiteMetadata ?? collectSiteMetadataDefault;
    this.#runPreflight = dependencies.runPreflight ?? runPreflightDefault;
    this.#collectRunEnvironment = dependencies.collectRunEnvironment ?? collectRunEnvironmentDefault;
    this.#readToolVersion = dependencies.readToolVersion ?? readToolVersionDefault;
    this.#sleep = dependencies.sleep ?? wait;
    this.#onProgress = dependencies.onProgress;
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
   * 5. robots.txt と sitemap.xml を取得する。Evidence は、開始の URL のページに置く（設計書 5.6.2）。
   * 6. BFS でクロールする（5.6.3）。一時的なナビゲーションの失敗は、1回だけ再試行する（5.6.4）。安全の不変条件の違反を検出した後は、
   *    新しいページを始めず、残りの URL を理由 `SAFETY_VIOLATION_ABORT` の SKIPPED にする。Page Auditor にも、次のビューポート、
   *    幅の走査の次の幅、Interaction の次の候補を始めないよう、違反の確かめを渡す（Task 19 の前の整理の設計書 4.5）。
   *    保存のセッションがあれば、robots.txt と sitemap.xml の後と、各ページの後に、保存を頼む（`#crawl`。中断した Run の再開の設計書 4.3）。
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
   * sitemap.xml の取得と、Page Auditor に、同じものを渡す。
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
  async run(): Promise<AuditRunResult> {
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
    readonly result: AuditRunResult;
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
    const navigationPacer = createNavigationPacer({
      minIntervalMs: config.crawl.minNavigationIntervalMs,
      now: this.#now,
      sleep: this.#sleep,
      ...(saved === undefined ? {} : { initial: resumedNavigationPacerRecord(saved.load.pacer, startedAtMs) }),
    });
    const loadMeter = createLoadMeter({
      allowedOrigins: config.site.allowedOrigins,
      now: this.#now,
      ...(saved === undefined ? {} : { initial: saved.load.meter }),
    });
    // Run 全体のリソースのキャッシュ（設計書 4.6）。Run（再開のときは、この実行）ごとに空から始め、終わりに捨てる（ファイルには書かない）。
    const resourceCache = new ResourceCache();
    // この実行の開始の時刻（時計）。再開のときは、Run の ID、BeakSight の版、Run の開始の時刻（最初の実行の開始）は、保存のものを使う。
    const executionStartedAt = this.#clock();
    const runId = saved === undefined ? createRunIdFromTime(executionStartedAt) : saved.runId;
    const executionStartedAtIso = executionStartedAt.toISOString();
    const runStartedAt = saved === undefined ? executionStartedAtIso : saved.startedAt;
    const toolVersion = saved === undefined ? await this.#readToolVersion() : saved.toolVersion;

    const progress: RunProgress = {
      // 再開のときは、理由、再試行の記録、違反のフラグ、未処理の失敗の件数、保存した Safety Ledger の snapshot、終わったページの結果と
      // 再試行の前の Evidence を、保存から作り直す（`restoredRunProgress`）。PREFLIGHT の失敗と Guard の有無は、この実行の PREFLIGHT で決める。
      ...restoredRunProgress(resume),
      safetyLedgers: [],
      pageLedgerStart: 0,
      navigationPacer,
      loadMeter,
      maxRuntimeExceeded: false,
      executionComplete: false,
      preflightFailed: false,
      guardEnabled: false,
      // 再開のときは、採番器、巡回の記録、開始の URL、robots.txt と sitemap.xml の Evidence も、ここで（PREFLIGHT の前に、PREFLIGHT の結果に
      // よらず）保存から作り直す（`restoredCrawlProgress`。設計書 4.10 の DEF-022）。新しい Run では、`#crawl` が作る。
      ...restoredCrawlProgress(config, saved),
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
      created = await createRunArtifactDirectory(this.#outputDirectory, runId);
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

    // 2. PREFLIGHT。PREFLIGHT の Ledger は、上の factory で作るので、登録にある（`safetyLedgers` は集計に使わない）。
    // Run のディレクトリを作れなかった場合と、保存のセッションを始められなかった場合は、PREFLIGHT を行わない（Browser を起動しない）。
    // 扱いは、PREFLIGHT の失敗と同じである。
    const preflight = directoryFailure === null && checkpointStartFailure === null
      ? await this.#runPreflight({
        config,
        launchBrowser: this.#launchBrowser,
        createSafetyLedger,
        outputDirectory: runDirectory,
        deadlines: { ...this.#deadlines, browserCloseTimeoutMs: this.#browserCloseTimeoutMs },
        // Run のすべての Context の要求の終わりの事象を、この Run の meter に渡させる（設計書 4.5。PREFLIGHT は中身を見ない）。
        // 応答は、この Run のキャッシュに渡させ、読み込み直しの Context では、キャッシュから返させる（設計書 4.6、4.7）。
        contextFactoryOptions: { loadMeter, resourceCache },
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
        onCloseFailure: ({ step, error }) => {
          progress.reasons.push(unhandledFailureReason(
            step === 'page' ? RUN_FAILURE_LABELS.environmentPageClose : RUN_FAILURE_LABELS.environmentContextClose,
            error,
          ));
        },
        deadlines: this.#deadlines,
      });
      if (browser !== null && factory !== null) {
        const checkpointSession = this.#checkpointSession;
        // 保存のセッションは、ここに来た時点で始まっている（始められなかった場合は、PREFLIGHT を行わず、Browser もない）。
        // 実行の記録は、前の回までの記録（再開のとき。前の回のプロセスが途中で終わった実行は、閉じたもの。R4b1）に、この実行の分を
        // 1件加えたもの（設計書 4.8）。この実行の分の終わりの時刻と終わり方は、実行の途中なので `null`（最後の状態の保存で決める）。
        const execution: RunCheckpointExecution = { startedAt: executionStartedAtIso, finishedAt: null, endReason: null, environment };
        const checkpoint: RunCheckpointContext | null = checkpointSession === undefined
          ? null
          : {
            session: checkpointSession,
            runId,
            toolVersion,
            startedAt: runStartedAt,
            executions: executionsEndingWith(previousExecutions, execution),
          };
        crawl = await this.#crawl(factory, runDirectory, startedAtMs, progress, checkpoint, saved ?? null);
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
            identity: { runId, toolVersion, startedAt: runStartedAt },
            progress,
            crawl: restoredCrawl,
          });
        }
      }
    } finally {
      // 7. Browser を閉じる。閉じる処理の失敗と、期限（`BROWSER_CLOSE_TIMEOUT_MS`）を過ぎたことは、Run の理由にする（R15 の Minor-2）。
      if (browser !== null) {
        const closeFailure = await closeBrowserBeforeDeadline(browser, { timeoutMs: this.#browserCloseTimeoutMs });
        if (closeFailure !== null) {
          progress.reasons.push(unhandledFailureReason(RUN_FAILURE_LABELS.browserClose, closeFailure.error));
        }
      }
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
   * 保存のセッションがあれば、巡回の終わり（残りの URL を SKIPPED にした後。例外で止まった経路でも、SKIPPED にした後）の値を、最後の
   * 状態の保存の中身として写して返す（設計書 4.3.2。R4b2）。この後の Browser を閉じる処理と `#finalize` で加わる理由、件数、Finding の
   * ID の採番は、中身に入らない。
   */
  async #crawl(
    factory: BrowserContextFactory,
    runDirectory: string,
    startedAtMs: number,
    progress: RunProgress,
    checkpoint: RunCheckpointContext | null,
    saved: RunCheckpoint | null,
  ): Promise<RunCrawlOutcome> {
    const config = this.#config;
    const runtimeLimitReached = (): boolean => this.#now() - startedAtMs >= config.crawl.maxRuntimeMs;
    // 保存（中断した Run の再開の設計書 4.1、4.3）。保存のセッションがなければ、何もしない。保存に1回失敗したら、それより後は
    // 保存しない（新しいページも始めない）。終わったページの ID は、終わった順に並べる。ページの中で作った Ledger の snapshot は、
    // そのページの保存に入れ、状態の保存には、ページの外で作った Ledger の snapshot だけを入れる。
    // 再開のときは、監査を始めたページの数、終わったページの ID、ページの外の Ledger の snapshot を、保存した分から続ける（次の保存で、
    // 前の回の分が消えないようにする）。この実行のページの中の Ledger は、`pageLedgers` で区別する。
    let pagesStarted = saved?.progress.pagesStarted ?? 0;
    let checkpointFailed = false;
    // 最後に書けた状態の保存（設計書 4.3.2。この実行で書けた値。書けていなければ、再開の入力の保存）。
    let lastWritten: RunCheckpoint | null = saved;
    const completedPageIds: PageId[] = [...(saved?.completedPageIds ?? [])];
    const savedOutsidePageSnapshots: readonly SafetyLedgerSnapshot[] = saved?.safetyLedgerSnapshots ?? [];
    const pageLedgers = new Set<SafetyLedger>();
    const outsidePageSnapshots = (): SafetyLedgerSnapshot[] =>
      outsidePageLedgerSnapshots(savedOutsidePageSnapshots, progress.safetyLedgers, pageLedgers);
    try {
      // 開始の URL（再開のときは、PREFLIGHT の前に作った値。`restoredCrawlProgress`）。
      const startUrl = progress.startUrl ?? normalizedStartUrl(config);
      progress.startUrl = startUrl;

      // 4. 採番器を作り、開始の URL のページの ID を採番する（metadata の取得の前）。再開のときは、PREFLIGHT の前に保存から作り直した採番器と
      // 巡回の記録を使う（`restoredCrawlProgress`。監査の途中だった URL と、待ち行列に戻す理由の SKIPPED の URL は、`QUEUED` に戻っている。
      // 設計書 3.2、4.2、4.10 の DEF-022）。
      const allocator = progress.allocator ?? new IdAllocator();
      progress.allocator = allocator;
      const frontier = progress.frontier ?? new CrawlFrontier(config.crawl.maxDepth, allocator);
      progress.frontier = frontier;
      if (saved === null) {
        frontier.discover(startUrl, 0);
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
      // （中断しなかった場合と同じ理由にする）。どちらでもない保存のときだけ、今の決まりのとおり取得する。
      if (saved !== null && saved.siteMetadata !== null) {
        // 保存の Evidence から作り直してある。
      } else if (saved !== null && saved.progress.reasons.some(isSiteMetadataSafetyAbortReason)) {
        // 前の回が、違反のため取得を始めず、Run の理由に記録した（Evidence は作らない）。
      } else if (this.#safetyViolationRecorded(progress, 0)) {
        progress.reasons.push(SITE_METADATA_SAFETY_ABORT_REASON);
      } else {
        const metadata = await this.#collectSiteMetadata({
          contextFactory: factory,
          origin: new URL(startUrl).origin,
          config,
          pageId: startEntry.pageId,
          allocator,
          clock: this.#clock,
          deadlines: this.#deadlines,
          // 各ファイルの読み込みの前に、Run で1つの pacer で間隔を守る（サイトへの負荷の制御の設計書 4.1）。
          beforeNavigation: () => progress.navigationPacer.beforeNavigation(),
        });
        // metadata の取得の Ledger は、Context の factory が作ったもので、すでに登録にある（`ledgerSnapshot` は集計に使わない）。
        progress.metadata = metadata;
        for (const { step, error } of metadata.closeFailures) {
          progress.reasons.push(unhandledFailureReason(
            step === 'page' ? RUN_FAILURE_LABELS.metadataPageClose : RUN_FAILURE_LABELS.metadataContextClose,
            error,
          ));
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
            crawl: { frontier, allocator, pagesStarted, outsidePageSnapshots: outsidePageSnapshots(), completedPageIds },
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
        // ページの中（次のビューポート、幅の走査の次の幅、Interaction の次の候補の前）の確かめ。今のページで作った Ledger を調べる
        // （それより前の Ledger は、ページを始める前に調べた）。
        safetyViolationRecorded: () => this.#safetyViolationRecorded(progress, progress.pageLedgerStart),
      });
      // 新しいページを始めない理由（保存の失敗、ページ数の上限、実行時間の上限、止める印）。決まった後の URL は、すべてこの理由の SKIPPED に
      // する。
      let stopReason: IncompleteReason | null = null;
      // 監査を終えたページの数（進み具合の事実。サイトへの負荷の制御の設計書 4.8）。再開のときは、再開の前に終わったページを含める。
      let pagesFinished = saved?.completedPageIds.length ?? 0;
      for (let entry = frontier.next(); entry !== undefined; entry = frontier.next()) {
        // 違反を検出した後は、新しいページを始めない（Task 19 の前の整理の設計書 4.5）。ページを始める前に、Run の間に作ったすべての
        // Ledger を調べる。違反の後の URL は、保存の失敗と上限より先に、理由 `SAFETY_VIOLATION_ABORT` の SKIPPED にする。
        if (stopReason === null && this.#safetyViolationRecorded(progress, 0)) {
          frontier.markSkipped(entry.url, SAFETY_VIOLATION_ABORT_REASON);
          continue;
        }
        // 次のページを始める前に、毎回、保存の失敗（中断した Run の再開の設計書 4.3）、ページ数、実行時間、止める印（設計書 4.6.1）の順に
        // 確かめる（同時に当てはまる場合は、前のものの理由にする）。止める印は、ここでだけ確かめる（今のページは、再試行を含めて最後まで行う）。
        if (stopReason === null) {
          if (checkpointFailed) {
            stopReason = CHECKPOINT_WRITE_FAILED_SKIP_REASON;
          } else if (pagesStarted >= config.crawl.maxPages) {
            stopReason = crawlLimitReason('MAX_PAGES_REACHED');
          } else if (runtimeLimitReached()) {
            stopReason = crawlLimitReason('MAX_RUNTIME_REACHED');
          } else if (this.#stopSignal?.aborted === true) {
            stopReason = RUN_INTERRUPTED_SKIP_REASON;
          }
        }
        if (stopReason !== null) {
          frontier.markSkipped(entry.url, stopReason);
          continue;
        }
        pagesStarted += 1;
        progress.pageLedgerStart = progress.safetyLedgers.length;
        frontier.markAuditing(entry.url);
        const result = await this.#auditWithRetry(auditor, entry, progress);
        progress.results.set(entry.url, result);
        frontier.markFinished(entry.url, result.status);
        // Link は、Desktop の `link` の Evidence から取り、`INTERNAL_NAVIGABLE` のものだけをキューに入れる（ARCH03）。
        for (const url of internalNavigableLinks(result)) {
          frontier.discover(url, entry.depth + 1);
        }
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
          completedPageIds.push(entry.pageId);
          const retryEvidence = progress.retryEvidence.get(entry.url) ?? [];
          checkpointFailed = !await this.#requestCheckpoint(progress, async () => checkpoint.session.savePage(createRunCheckpointPage({
            result,
            retryEvidence,
            safetyLedgerSnapshots: ledgers.map((ledger) => ledger.snapshot()),
          })));
          if (!checkpointFailed) {
            await saveState(checkpoint);
          }
        }
        pagesFinished += 1;
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
            : { frontier, allocator, pagesStarted, outsidePageSnapshots: outsidePageSnapshots(), completedPageIds },
        }),
    };
  }

  /**
   * 保存のセッションを、Run のディレクトリで始める（中断した Run の再開の設計書 4.3.1、4.4。新しい Run）。セッションがなければ、
   * 何もせずに `null` を返す。始められなかった場合（ロックのファイルがすでにあった、書けなかった）は、Run の理由
   * `CHECKPOINT_WRITE_FAILED` を返す（`detail` は、失敗のメッセージ）。
   */
  async #startCheckpointSession(runDirectory: string): Promise<IncompleteReason | null> {
    const session = this.#checkpointSession;
    if (session === undefined) {
      return null;
    }
    try {
      const started = await session.start(runDirectory, { mode: 'NEW_RUN' });
      return started.ok ? null : checkpointWriteFailedReason(CHECKPOINT_LOCK_EXISTS_DETAIL);
    } catch (error) {
      return checkpointWriteFailedReason(safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH));
    }
  }

  /**
   * 保存のセッションを、再開の始め方（`RESUME`。終わったページの ID は、保存の `completedPageIds`）で、前の回の Run のディレクトリで始める
   * （中断した Run の再開の設計書 4.4、4.5。古いロックの作り直しと読み直し、後始末は、セッションが行う）。始められなかった場合
   * （動いている Run のロックがある、別のプロセスが同時にロックを作り直した、始め方が reject した）は、`RunResumeUnavailableError` を投げる。
   */
  async #resumeCheckpointSession(resume: RunCoordinatorResumeInput, runId: RunId): Promise<void> {
    const session = this.#checkpointSession;
    if (session === undefined) {
      // 再開の入力があれば、コンストラクタが、セッションがあることを確かめている。
      throw new TypeError('RunCoordinator resumeFrom requires a checkpointSession');
    }
    const { runDirectory } = resume;
    let started: RunCheckpointSessionStart;
    try {
      started = await session.start(runDirectory, { mode: 'RESUME', completedPageIds: resume.checkpoint.completedPageIds });
    } catch (error) {
      throw new RunResumeUnavailableError({ runId, runDirectory, reason: 'CHECKPOINT_STORE_FAILED', existingLock: null, cause: error });
    }
    if (started.ok) {
      return;
    }
    // 再開の始め方の結果は、始めなかった理由を持つ。持たない結果（新しい Run の始め方の形）は、セッションの誤りとして扱う。
    throw new RunResumeUnavailableError('reason' in started
      ? { runId, runDirectory, reason: started.reason, existingLock: started.existingLock }
      : {
        runId,
        runDirectory,
        reason: 'CHECKPOINT_STORE_FAILED',
        existingLock: started.existingLock,
        cause: new Error('the checkpoint session did not resume and gave no reason'),
      });
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
      progress.reasons.push(checkpointWriteFailedReason(safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH)));
      return false;
    }
  }

  /**
   * 進み具合の事実を組み立て、注入された受け手に渡す（サイトへの負荷の制御の設計書 4.8）。受け手がなければ、何もしない（組み立てもしない）。
   * 値は、その時点の事実だけである: ページの数は呼び出し側から、経過時間は注入した `now` から、読み込みの回数と待ちの合計は pacer から、
   * 要求の実績と直近の1分の件数は meter から取る。事実は、深く凍結する。
   * 事実の組み立ての例外（注入した `now` が不正な時刻を返した場合など）、受け手の例外、受け手が返した Promise の reject は、握りつぶす
   * （Run を止めず、Run の理由にもしない。表示の失敗で監査を止めないため。受け手の有無で Run を変えないため）。
   */
  #reportProgress(
    progress: RunProgress,
    facts: { readonly pagesFinished: number; readonly pagesDiscovered: number; readonly startedAtMs: number },
  ): void {
    const onProgress = this.#onProgress;
    if (onProgress === undefined) {
      return;
    }
    try {
      const pacer = progress.navigationPacer.snapshot();
      const report: RunProgressReport = deepFreeze({
        pagesFinished: facts.pagesFinished,
        pagesDiscovered: facts.pagesDiscovered,
        maxPages: this.#config.crawl.maxPages,
        // 時計が戻っても、経過時間を負にしない。
        elapsedMs: Math.max(0, this.#now() - facts.startedAtMs),
        navigationCount: pacer.navigationCount,
        pacingWaitMs: pacer.totalWaitMs,
        requests: progress.loadMeter.snapshot(),
        recentPerMinute: progress.loadMeter.recentPerMinute(),
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
   * この Run で作った Ledger（登録の `fromIndex` 番目から後）に、安全の不変条件の違反が1件でも記録されたかを調べ、記録されていれば
   * `progress.safetyViolationDetected` を立てて、その値を返す（Task 19 の前の整理の設計書 4.5。C18f）。違反の検出は、ここだけで行う
   * （Run Coordinator が、Ledger の登録を調べる方法）。止めたことは記録しない（それは `#safetyViolationRecorded` が行う）。
   * - 再開した Run の、保存した Safety Ledger の snapshot（前の回までの Ledger）は、登録の先頭（この実行の Ledger より前）にあるものと
   *   して扱い、Run の初めから調べる場合（`fromIndex` が 0）に調べる（中断した Run の再開の設計書 4.2。保存のフラグが偽で、保存した
   *   snapshot に違反がある場合の守り。R4a2b）。ページの中の確かめと、ページの保存の前の確かめ（`fromIndex` は今のページの初め）では
   *   調べない（ページを始める前に調べた）。robots.txt と sitemap.xml の取得の後の保存の前の確かめは、Run の初めから（`fromIndex` が 0）
   *   調べる（この実行の PREFLIGHT、環境の記録、取得の Ledger と、保存した snapshot。R5-fix-round-1）。
   * - 一度検出したら、それ以後は、調べずに真を返す（Ledger の違反は減らないため）。
   * 違反の種類は問わない。件数は、Ledger の snapshot の `invariantViolationCount` で読む（Run の Safety の集計と同じ値）。
   */
  #detectSafetyViolation(progress: RunProgress, fromIndex: number): boolean {
    if (!progress.safetyViolationDetected) {
      const hasViolation = (snapshot: SafetyLedgerSnapshot): boolean => snapshot.invariantViolationCount > 0;
      progress.safetyViolationDetected = (fromIndex === 0 && progress.savedSafetyLedgerSnapshots.some(hasViolation))
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
   */
  async #auditWithRetry(auditor: RunPageAuditor, entry: CrawlUrlEntry, progress: RunProgress): Promise<PageAuditResult> {
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
      });
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
    return outcome.result;
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
  }): Promise<RunFinalization> {
    const config = this.#config;
    const { progress } = input;

    // 監査しなかった URL にも結果を作り、発見の順に並べる。metadata の Evidence は、開始の URL のページに置く。
    // `evaluatedPages` は、最終の試行の Evidence だけを持つ（Cross-page rule と件数の入力。設計書 5.6.4）。`pages`（出力）は、
    // それに、再試行の前の試行の Evidence を加えたものである。Evidence は、metadata、再試行の前の試行、最終の試行の順に並べる。
    const evaluatedPages: PageAuditResult[] = [];
    const pages: PageAuditResult[] = [];
    for (const entry of progress.frontier?.entries() ?? []) {
      const result = progress.results.get(entry.url)
        ?? skippedPageResult(entry.url, entry.pageId, entry.skipReason ?? EXECUTION_INCOMPLETE_REASON);
      const metadataRecords = entry.url === progress.startUrl && progress.metadata !== null ? progress.metadata.records : [];
      evaluatedPages.push(withLeadingEvidence(result, metadataRecords));
      pages.push(withLeadingEvidence(result, [...metadataRecords, ...(progress.retryEvidence.get(entry.url) ?? [])]));
    }

    // 8. Cross-page rule。
    const findings: Finding[] = pages.flatMap((page) => page.findings);
    let unverifiedInternalLinkCount = 0;
    if (!progress.preflightFailed && progress.allocator !== null) {
      try {
        const crossPage = evaluateCrossPageRules({
          targetId: config.target.id,
          firstFindingSequence: progress.allocator.nextFindingSequence,
          allowedOrigins: config.site.allowedOrigins,
          allowedQueryParameters: config.crawl.allowedQueryParameters,
          pages: evaluatedPages,
          sitemap: sitemapOf(progress.metadata),
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
    const skipCodes = new Set(pages.flatMap((page) => (page.status === 'SKIPPED' ? page.incompleteReasons.map(({ code }) => code) : [])));
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
    // 違反を検出したため、監査を始めなかったものがあれば、止めたことを Run の理由に1件だけ残す（Task 19 の前の整理の設計書 4.5）。
    // Run Status は、違反の件数から `deriveRunStatus` が `ABORTED_BY_SAFETY` と導く（この理由では決めない）。
    const safetyAbortReasons = progress.stoppedBySafetyViolation ? [SAFETY_VIOLATION_ABORT_REASON] : [];
    const reasons = [...limitReasons, ...interruptedReasons, ...safetyAbortReasons, ...progress.reasons];

    // Safety の集計（設計書 5.6.5）。この Run で作ったすべての Ledger の、Browser を閉じた後の snapshot からだけ集計する。再開した Run では、
    // 保存した snapshot（前の回までの Ledger）と、この実行の Ledger の snapshot を、この順に渡す（Ledger を作った順と同じ。
    // 中断した Run の再開の設計書 4.1）。
    const runSafety = summarizeRunSafety({
      guardEnabled: progress.guardEnabled,
      snapshots: [...progress.savedSafetyLedgerSnapshots, ...progress.safetyLedgers.map((ledger) => ledger.snapshot())],
    });

    // Run Status の入力（設計書 5.6.6）。Finding の件数は渡さない。件数は、最終の試行の結果から数える。
    const pageCounts = countPagesByStatus(evaluatedPages);
    const interactions = countInteractionOutcomes(evaluatedPages);
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
      incompleteCollectorCount: countPartialViewports(evaluatedPages),
    };

    // この実行の記録（中断した Run の再開の設計書 4.8）。終わりの時刻は `run.json` の `finishedAt` と同じ値（時計を1回だけ読む）。終わり方は、
    // Run Status と SKIPPED のページの理由のコードから、`decideRunExecutionEndReason` が決める。
    const runStatus = deriveRunStatus(statusInput);
    const finishedAt = this.#clock().toISOString();
    const execution: RunExecution = Object.freeze({
      startedAt: input.executionStartedAt,
      finishedAt,
      endReason: decideRunExecutionEndReason({ runStatus, skipReasonCodes: skipCodes }),
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
      viewportPageCounts: countViewportPages(evaluatedPages),
      environment: input.environment,
      // 注入した設定そのものを凍結しないよう、写しを記録する。
      effectiveConfig: structuredClone(config),
      safety: runSafety,
      unverifiedInteractionCount: interactions.unverified,
      unverifiedInternalLinkCount,
      retries: [...progress.retries],
      crawlLimits,
      incompleteReasons: reasons,
      load: runLoad(config, progress),
    };
    // `statusInput` は、`deriveRunStatus` に渡したものと同じ値である（設計書 6.1.1。artifact の書き出しが、Run Status を導き直すのに使う）。
    return { result: deepFreeze({ run, pages, findings, statusInput }), skipReasonCodes: skipCodes, execution };
  }
}

/**
 * Run のディレクトリを作れなかった理由（DEF-009）。`detail` は、失敗した作成の例外のメッセージ（`MAX_ERROR_MESSAGE_LENGTH` 以内）。
 * 結果は凍結する。
 */
function runDirectoryUnavailableReason(error: unknown): IncompleteReason {
  return Object.freeze({ code: 'RUN_DIRECTORY_UNAVAILABLE', detail: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH) });
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
 * 再開の入力から、`RunProgress` のうち保存から作り直すものを作る（中断した Run の再開の設計書 4.1、4.2）。新しい Run（入力なし）では、空の
 * 値にする。理由、再試行の記録、違反のフラグ、未処理の失敗の件数は、状態の保存の値の写し。保存した Safety Ledger の snapshot は、ページの外の
 * Ledger のもの（状態の保存）と、終わったページの Ledger のもの（ページの保存。終わった順）を、この順に並べたもの。終わったページの結果と
 * 再試行の前の Evidence は、URL を鍵にする（新しい Run と同じく、再試行の前の Evidence は、再試行したページだけに持つ）。
 */
function restoredRunProgress(resume: RunCoordinatorResumeInput | undefined): Pick<
  RunProgress,
  | 'reasons'
  | 'retries'
  | 'savedSafetyLedgerSnapshots'
  | 'safetyViolationDetected'
  | 'stoppedBySafetyViolation'
  | 'unhandledFailures'
  | 'results'
  | 'retryEvidence'
> {
  if (resume === undefined) {
    return {
      reasons: [],
      retries: [],
      savedSafetyLedgerSnapshots: [],
      safetyViolationDetected: false,
      stoppedBySafetyViolation: false,
      unhandledFailures: 0,
      results: new Map(),
      retryEvidence: new Map(),
    };
  }
  const { checkpoint, pages } = resume;
  return {
    reasons: [...checkpoint.progress.reasons],
    retries: [...checkpoint.progress.retries],
    savedSafetyLedgerSnapshots: [
      ...checkpoint.safetyLedgerSnapshots,
      ...pages.flatMap(({ safetyLedgerSnapshots }) => safetyLedgerSnapshots),
    ],
    safetyViolationDetected: checkpoint.progress.safetyViolationDetected,
    stoppedBySafetyViolation: checkpoint.progress.stoppedBySafetyViolation,
    unhandledFailures: checkpoint.progress.unhandledFailures,
    results: new Map(pages.map(({ url, result }) => [url, result])),
    retryEvidence: new Map(pages.filter(({ retryEvidence }) => retryEvidence.length > 0).map(({ url, retryEvidence }) => [url, retryEvidence])),
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
 * 再開の入力の保存から、`RunProgress` のうち巡回の値（採番器、巡回の記録、開始の URL、robots.txt と sitemap.xml の取得の結果）を作り直す
 * （中断した Run の再開の設計書 4.2、4.10 の DEF-022。R7b）。Run Coordinator は、再開した実行の初め（PREFLIGHT の前）に、PREFLIGHT の結果に
 * よらず呼ぶ。PREFLIGHT に失敗して巡回を行わない実行でも、その出力と最後の状態の保存に、前の回までのページが入るようにするためである。
 * - 採番器は `IdAllocator.restore`、巡回の記録は `CrawlFrontier.restore` で作り直す。監査の途中だった URL と、待ち行列に戻す理由
 *   （`RESUME_REQUEUE_SKIP_REASON_CODES`）の SKIPPED の URL は、`QUEUED` に戻る（設計書 3.2、4.2）。
 * - 開始の URL は、新しい Run と同じく、設定の開始の URL を正規化したもの（`normalizedStartUrl`）。
 * - robots.txt と sitemap.xml は、保存に Evidence があれば、そこから作り直す（`restoredSiteMetadata`。取得し直さない）。なければ `null`。
 * 新しい Run（保存なし）では、すべて `null` にする（`#crawl` が作る）。保存の巡回の記録や採番器が不正なら、それぞれの作り直しの例外を投げる。
 */
function restoredCrawlProgress(
  config: AuditConfig,
  saved: RunCheckpoint | undefined,
): Pick<RunProgress, 'frontier' | 'allocator' | 'startUrl' | 'metadata'> {
  if (saved === undefined) {
    return { frontier: null, allocator: null, startUrl: null, metadata: null };
  }
  const allocator = IdAllocator.restore(saved.allocator);
  const frontier = CrawlFrontier.restore(saved.frontier, {
    maxDepth: config.crawl.maxDepth,
    allocator,
    allowedQueryParameters: new Set(config.crawl.allowedQueryParameters),
    requeueSkipReasonCodes: RESUME_REQUEUE_SKIP_REASON_CODE_SET,
  });
  return {
    frontier,
    allocator,
    startUrl: normalizedStartUrl(config),
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
  readonly identity: Pick<RunCheckpointContext, 'runId' | 'toolVersion' | 'startedAt'>;
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
    load: { pacer: progress.navigationPacer.snapshot(), meter: progress.loadMeter.snapshot() },
    completedPageIds: crawl === null ? [] : [...crawl.completedPageIds],
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
  const { startedAt, finishedAt, endReason } = execution;
  if (finishedAt === null || endReason === null) {
    throw new TypeError('an earlier execution of the checkpoint is not closed: its finishedAt or endReason is null');
  }
  return Object.freeze({ startedAt, finishedAt, endReason });
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
  return {
    minNavigationIntervalMs: config.crawl.minNavigationIntervalMs,
    maxInteractionsPerPage: config.crawl.maxInteractionsPerPage,
    navigationCount: pacer.navigationCount,
    pacingWaitMs: pacer.totalWaitMs,
    requests: progress.loadMeter.snapshot(),
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

/** ページの Desktop の `link` の Evidence のうち、`INTERNAL_NAVIGABLE` のリンクの正規化した URL（文書の順）。 */
function internalNavigableLinks(result: PageAuditResult): NormalizedHttpUrlEvidence[] {
  return viewportEvidenceOfType(result, 'link', ['desktop']).flatMap(({ payload }) =>
    payload.links.flatMap((link) =>
      (link.admission.kind === 'INTERNAL_NAVIGABLE' && link.normalized.ok ? [link.normalized.url] : [])));
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
  pages: readonly PageAuditResult[],
  findings: readonly Finding[],
): Promise<IncompleteReason[]> {
  const reasons: IncompleteReason[] = [];
  const check = async (schema: 'page' | 'finding', id: PageId | string, value: unknown): Promise<void> => {
    const validation = await validateArtifact(schema, value);
    if (!validation.ok) {
      reasons.push(requiredArtifactInvalidReason(schema, id, validation.errors));
    }
  };
  for (const page of pages) {
    await check('page', page.pageId, page);
  }
  for (const finding of findings) {
    await check('finding', finding.findingId, finding);
  }
  return reasons;
}

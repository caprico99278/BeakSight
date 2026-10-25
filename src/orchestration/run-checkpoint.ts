import type {
  CrawlUrlState,
  EvidenceRecord,
  IncompleteReason,
  IncompleteReasonCode,
  PageAuditResult,
  PageId,
  RunCheckpointState,
  RunEnvironment,
  RunExecutionEndReason,
  RunId,
  RunLoadOriginRequests,
  RunLoadRequests,
  RunRetryRecord,
  RunStatus,
} from '../core/contracts.js';
import { safeErrorMessage } from '../core/errors.js';
import type { EffectiveAuditConfig, NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import type { LockFileAcquisition, RunLock, RunLockTakeover } from '../core/process-lock.js';
import { REDACTED } from '../core/redaction.js';
import type { ArtifactValidationResult } from '../core/schema-validator.js';
import { compareCodeUnits } from '../core/text.js';
import type { NavigationPacerSnapshot } from '../crawl/navigation-pacer.js';
import type { SiteMetadataResult } from '../crawl/site-metadata.js';
import type { SafetyLedgerSnapshot } from '../safety/safety-ledger.js';
import { CrawlFrontier, type CrawlFrontierSnapshot, type CrawlUrlEntry } from './crawl-frontier.js';
import { IdAllocator, type IdAllocatorSnapshot } from './id-allocator.js';

// 中断した Run の再開のための保存（チェックポイント）の内容の作成、整合の確かめ、再開できるかの判定、設定と版の比べ、再開する Run の選び方、
// 実行の終わり方と保存の終わり方の判定（中断した Run の再開の設計書 3.2、4.1、4.2、4.3.2、4.7、4.7.1、4.8、5章。この意味の owner）。
// - ロックの中身と判定、古いロックの取り直し（設計書 4.4）の owner は `src/core/process-lock.ts`（T24h-3 で移した）。ここは、今の名前で
//   export し直すだけである。
// - ファイルは読み書きしない。保存のファイルの読み書き、ロックのファイルの作成・更新・削除は `ArtifactWriter` が行う（ARCH08）。
// - スキーマの検証（`validateArtifact('checkpoint' | 'checkpoint-page', …)`）も、保存のファイルを読み書きする `ArtifactWriter` が行う
//   （ARCH08 の Gate で、`validateArtifact` を呼べる場所は限られているため。R2 の Blocker B1）。ここでは、スキーマの検証の済んだ値の、
//   スキーマでは確かめられない整合だけを確かめる。

/** `checkpoint/state.json` の `schemaVersion`（`schemas/checkpoint.schema.json`）。 */
export const RUN_CHECKPOINT_SCHEMA_VERSION = 'checkpoint-schema/1.0';
/** `checkpoint/pages/<pageId>.json` の `schemaVersion`（`schemas/checkpoint-page.schema.json`）。 */
export const RUN_CHECKPOINT_PAGE_SCHEMA_VERSION = 'checkpoint-page-schema/1.0';

/** 1回の実行（起動）の記録（設計書 4.8）。 */
export interface RunCheckpointExecution {
  /** 実行の開始の時刻（ISO 8601）。 */
  readonly startedAt: string;
  /** 実行の終わりの時刻（ISO 8601）。実行の途中は `null`。プロセスが途中で終わった実行は、最後の保存の時刻。 */
  readonly finishedAt: string | null;
  /** 実行の終わり方。実行の途中は `null`。 */
  readonly endReason: RunExecutionEndReason | null;
  /** その実行の環境（`run.json` の `environment` と同じ形）。 */
  readonly environment: RunEnvironment;
}

/**
 * Run の途中の状態のうち、再開の後も引き継ぐもの（Run Coordinator の `RunProgress` と、`#crawl` の `pagesStarted`）。
 * 1回の実行の状態（`maxRuntimeExceeded`、`executionComplete`、`pageLedgerStart`）は持たない（設計書 4.1）。
 */
export interface RunCheckpointProgress {
  readonly reasons: readonly IncompleteReason[];
  readonly retries: readonly RunRetryRecord[];
  readonly safetyViolationDetected: boolean;
  readonly stoppedBySafetyViolation: boolean;
  readonly unhandledFailures: number;
  readonly guardEnabled: boolean;
  readonly preflightFailed: boolean;
  /** 監査を始めたページの数（ページ数の上限の判定に使う）。 */
  readonly pagesStarted: number;
}

/**
 * robots.txt と sitemap.xml の取得の結果のうち、保存するもの（`metadata` の Evidence の2件。この順）。sitemap は Evidence から
 * 作り直せる（`sitemapEvidenceFromMetadata`）。ほかの値は Run Coordinator が使っていないので、保存しない（設計書 4.2）。
 */
export type RunCheckpointSiteMetadata = Pick<SiteMetadataResult, 'records'>;

/**
 * 負荷の記録（設計書 4.9）。再開のときに、`NavigationPacer` と `LoadMeter` の `initial` に渡す。
 * T35c（Task 35 の設計書 3.4、3.7）: スクリプトで送るログインの監査の Run だけ、承認したサービスの Origin の区分（`approvedServiceOrigins`。`LoadMeter` の
 * `initialServiceOriginRequests` に渡す）と、監査の段の数（`auditStageCounts`。次の実行の数に足す）を持つ（ほかの Run の保存の形は変えない）。
 */
export interface RunCheckpointLoad {
  readonly pacer: NavigationPacerSnapshot;
  readonly meter: RunLoadRequests;
  readonly approvedServiceOrigins?: RunLoadOriginRequests;
  readonly auditStageCounts?: RunCheckpointAuditStageCounts;
}

/**
 * 保存に書く、監査の段の数（T35c。`run.json` の `authentication` の数の部分）。T35R-fix（T35R の I-2・I-3）: 承認したサービスの Origin への要求の上限の
 * 部品が数えた要求の数（`serviceRequestsAdmitted`。次の実行の上限の部品は、この数から数える）と、上限で断った要求の数（`serviceRequestLimitRefused`。
 * 1 つでもあれば Run を PARTIAL にする）も、Run の全体の数として持つ。
 */
export interface RunCheckpointAuditStageCounts {
  readonly registeredReadRequestsAllowed: number;
  readonly tokenRefreshBlocked: number;
  readonly otherNonReadBlocked: number;
  readonly serviceUnauthorizedResponses: number;
  readonly serviceRequestsAdmitted: number;
  readonly serviceRequestLimitRefused: number;
  /**
   * T37R-fix-B2（Task 37 の設計書 8 章の最後の行）: 許可 Origin への `fetch`・`xhr` の読み取りでない要求を止めた数（記録だけ。判定には使わない）。
   * LG-4: 必須（数のない前の版の保存は読まない）。
   */
  readonly allowedOriginDataRequestsBlocked: number;
  /**
   * DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md` 2.2）: 承認したサービスの Origin への要求の 1 分あたりの上限で、次の読み込みの
   * 前に待った回数と、待った時間の合計（ms）。LG-4: 必須。
   */
  readonly serviceRequestPacingWaits: number;
  readonly serviceRequestPacingWaitMs: number;
}

/** `checkpoint/state.json` の値（設計書 4.1。形は `schemas/checkpoint.schema.json`）。 */
export interface RunCheckpoint {
  readonly schemaVersion: typeof RUN_CHECKPOINT_SCHEMA_VERSION;
  readonly state: RunCheckpointState;
  readonly runId: RunId;
  /** BeakSight の版（最初の実行のもの。版が違えば再開しない）。 */
  readonly toolVersion: string;
  /** 最初の実行の開始の時刻（ISO 8601）。 */
  readonly startedAt: string;
  /**
   * 保存の時刻（ISO 8601。その `state.json` の値を作った時刻。設計書 4.1）。再開のときは、前の回のプロセスが途中で終わった実行の、
   * 終わりの時刻に使う（`closeInterruptedRunExecutions`。設計書 4.8）。
   */
  readonly savedAt: string;
  readonly effectiveConfig: EffectiveAuditConfig;
  /** 実行の記録（実行の順。1件以上）。 */
  readonly executions: readonly [RunCheckpointExecution, ...RunCheckpointExecution[]];
  readonly frontier: CrawlFrontierSnapshot;
  readonly allocator: IdAllocatorSnapshot;
  readonly progress: RunCheckpointProgress;
  /**
   * ページの外で作った Safety Ledger（PREFLIGHT、環境の記録、robots.txt と sitemap.xml の取得）の snapshot（作った順）。
   * ページの中で作った Ledger（Passive、幅の走査、Interaction、再試行の前の試行）の snapshot は、そのページの保存
   * （`RunCheckpointPage.safetyLedgerSnapshots`）に入れる（設計書 4.1。保存のたびに書く量が、ページの数に比例して増えないようにする）。
   */
  readonly safetyLedgerSnapshots: readonly SafetyLedgerSnapshot[];
  /** robots.txt と sitemap.xml の Evidence。取得の前（取得しなかった場合を含む）は `null`。 */
  readonly siteMetadata: RunCheckpointSiteMetadata | null;
  readonly load: RunCheckpointLoad;
  /** 監査を終えたページの ID（`checkpoint/pages/<pageId>.json` と対応する）。 */
  readonly completedPageIds: readonly PageId[];
  /**
   * Run の種類（T25g-2。独立レビュー T25R の Important I1）。認証つきの Run だけが持つ（認証の設定を区別する値。秘密を含まない）。
   * ない保存（公開監査の Run と、この項目より前の古い保存）は、公開監査の Run とみなす。再開する Run を選ぶ比べ（`selectRunToResume`）で比べ、
   * 今回の Run の種類と違えば再開しない。
   */
  readonly authentication?: RunCheckpointAuthentication;
}

/**
 * 認証つきの Run の、保存に記録する種類の値（T25g-2）。`settingsDigest` は、認証の設定のうち、秘密を含まない値（許可 Origin、監査の段の除外、
 * セッションの切れの path）の SHA-256（`sha256:<16進64桁>`）。作るのは `runCheckpointAuthenticationOf`（`src/orchestration/authenticated-run.ts`）。
 */
export interface RunCheckpointAuthentication {
  readonly settingsDigest: string;
}

/**
 * 再開する Run を選ぶ比べで、Run の種類が違うときの、違う項目のパス（T25g-2）。実効の設定の違う項目のパスの後に加える。
 */
export const RUN_KIND_DIFFERENCE_PATH = 'authentication';

/** `createRunCheckpoint` の入力（`state.json` の値から `schemaVersion` を除いたもの）。 */
export type RunCheckpointInput = Omit<RunCheckpoint, 'schemaVersion'>;

/** `checkpoint/pages/<pageId>.json` の値（設計書 4.1。形は `schemas/checkpoint-page.schema.json`）。 */
export interface RunCheckpointPage {
  readonly schemaVersion: typeof RUN_CHECKPOINT_PAGE_SCHEMA_VERSION;
  readonly pageId: PageId;
  readonly url: NormalizedHttpUrlEvidence;
  /** 最終の試行の結果（Run Coordinator の `progress.results` の値。metadata と再試行の前の Evidence を前に加える前のもの）。 */
  readonly result: PageAuditResult;
  /** 再試行の前の試行の Evidence（`progress.retryEvidence` の値。再試行しなかったページは空）。 */
  readonly retryEvidence: readonly EvidenceRecord[];
  /**
   * そのページの中で作った Safety Ledger（Passive、幅の走査、Interaction、再試行の前の試行の Context の Ledger）の snapshot
   * （作った順。設計書 4.1）。ページの外の Ledger は、`state.json`（`RunCheckpoint.safetyLedgerSnapshots`）に入れる。
   */
  readonly safetyLedgerSnapshots: readonly SafetyLedgerSnapshot[];
}

/** `createRunCheckpointPage` の入力。ページの ID と URL は、結果から取る。 */
export interface RunCheckpointPageInput {
  readonly result: PageAuditResult;
  readonly retryEvidence: readonly EvidenceRecord[];
  readonly safetyLedgerSnapshots: readonly SafetyLedgerSnapshot[];
}

/**
 * Run の状態から、`checkpoint/state.json` の値を作る（設計書 4.1）。入力を写した、深く凍結した、JSON にできる値を返す
 * （入力は凍結しない。Safety Ledger の snapshot の prototype のないオブジェクトは、普通のオブジェクトになる）。ファイルは書かない。
 */
export function createRunCheckpoint(input: RunCheckpointInput): RunCheckpoint {
  return deepFreeze(structuredClone({
    schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
    state: input.state,
    runId: input.runId,
    toolVersion: input.toolVersion,
    startedAt: input.startedAt,
    savedAt: input.savedAt,
    effectiveConfig: input.effectiveConfig,
    executions: input.executions,
    frontier: input.frontier,
    allocator: input.allocator,
    progress: input.progress,
    safetyLedgerSnapshots: input.safetyLedgerSnapshots,
    siteMetadata: input.siteMetadata,
    load: input.load,
    completedPageIds: input.completedPageIds,
    // T25g-2: 認証つきの Run だけ、Run の種類を記録する（公開監査の保存の形は変えない）。
    ...(input.authentication === undefined ? {} : { authentication: { settingsDigest: input.authentication.settingsDigest } }),
  }));
}

/**
 * 監査を終えた1ページの結果から、`checkpoint/pages/<pageId>.json` の値を作る（設計書 4.1）。ページの ID と URL は、結果の
 * `pageId` と `pageUrl` にする。入力を写した、深く凍結した、JSON にできる値を返す（Safety Ledger の snapshot の prototype のない
 * オブジェクトは、普通のオブジェクトになる）。ファイルは書かない。
 */
export function createRunCheckpointPage(input: RunCheckpointPageInput): RunCheckpointPage {
  return deepFreeze(structuredClone({
    schemaVersion: RUN_CHECKPOINT_PAGE_SCHEMA_VERSION,
    pageId: input.result.pageId,
    url: input.result.pageUrl,
    result: input.result,
    retryEvidence: input.retryEvidence,
    safetyLedgerSnapshots: input.safetyLedgerSnapshots,
  }));
}

/** 監査を終えた URL の状態（`CrawlFrontier.markFinished` が付ける状態）。 */
const AUDIT_FINISHED_CRAWL_URL_STATES: ReadonlySet<CrawlUrlState> = new Set<CrawlUrlState>(['AUDITED', 'FAILED']);

const consistencyResult = (errors: readonly string[]): ArtifactValidationResult =>
  errors.length === 0 ? { ok: true } : { ok: false, errors: Object.freeze([...errors]) };

/**
 * 前の回のプロセスが途中で終わった実行の終わり方（設計書 4.8）。再開のときに、前の回の実行の記録を閉じるとき
 * （`closeInterruptedRunExecutions`）だけ使い、最後の実行の記録には現れない。
 */
const INTERRUPTED_ABNORMALLY_END_REASON = 'INTERRUPTED_ABNORMALLY' satisfies RunExecutionEndReason;

/** 実行の記録（設計書 4.8）の食い違いを、英語の技術的な詳細で `errors` に加える（`checkRunCheckpointConsistency` の一部）。 */
const collectExecutionInconsistencies = (checkpoint: RunCheckpoint, errors: string[]): void => {
  const lastIndex = checkpoint.executions.length - 1;
  checkpoint.executions.forEach((execution, index) => {
    const path = `/executions/${index}`;
    if (index < lastIndex) {
      if (execution.endReason === null) {
        errors.push(`${path}/endReason is null, but only the last execution can be unfinished`);
      }
      if (execution.finishedAt === null) {
        errors.push(`${path}/finishedAt is null, but only the last execution can be unfinished`);
      }
      return;
    }
    // 最後の実行の記録は、保存の状態が IN_PROGRESS（実行の途中）のときだけ、終わり方と終わりの時刻を持たない。
    if (checkpoint.state === 'IN_PROGRESS') {
      if (execution.endReason !== null) {
        errors.push(`${path}/endReason (${execution.endReason}) must be null while the checkpoint state is ${checkpoint.state}`);
      }
      if (execution.finishedAt !== null) {
        errors.push(`${path}/finishedAt must be null while the checkpoint state is ${checkpoint.state}`);
      }
    } else {
      if (execution.endReason === null) {
        errors.push(`${path}/endReason must not be null when the checkpoint state is ${checkpoint.state}`);
      }
      if (execution.finishedAt === null) {
        errors.push(`${path}/finishedAt must not be null when the checkpoint state is ${checkpoint.state}`);
      }
    }
    if (execution.endReason === INTERRUPTED_ABNORMALLY_END_REASON) {
      errors.push(`${path}/endReason is ${INTERRUPTED_ABNORMALLY_END_REASON}, which only closes an earlier execution when the run is resumed`);
    }
  });
};

/**
 * 作り直しの例外のメッセージ（`collectRestorationInconsistencies`）。巡回の記録の URL を伏せ字（`REDACTED`）にしてから、上限
 * （`MAX_ERROR_MESSAGE_LENGTH`）付きの文字列にする。`CrawlFrontier.restore` と `CrawlQueue.restore` は、同じ URL が2回ある場合のメッセージに
 * URL を入れるが、保存の整合の食い違いの文には、URL を入れないためである。長い URL から伏せる（ほかの URL を前の部分に含む URL を、残さない）。
 * 伏せる前に切り詰めると、URL の前の部分が残りうるので、切り詰めは伏せた後に行う。
 */
const restorationFailureMessage = (error: unknown, checkpoint: RunCheckpoint): string => {
  const urls = checkpoint.frontier.entries.map(({ url }) => url).sort((left, right) => right.length - left.length);
  const message = urls.reduce((text, url) => text.replaceAll(url, REDACTED), safeErrorMessage(error, Number.MAX_SAFE_INTEGER));
  return safeErrorMessage(message, MAX_ERROR_MESSAGE_LENGTH);
};

/** 保存から作り直した採番器と巡回の記録（`restoreRunCheckpointCrawl` の結果）。 */
export interface RestoredRunCheckpointCrawl {
  readonly allocator: IdAllocator;
  readonly frontier: CrawlFrontier;
}

/**
 * 保存の値から、採番器と巡回の記録を作り直す（中断した Run の再開の設計書 4.2、4.10 の DEF-022。CC-040。この作り直しの owner）。
 * Run Coordinator の再開の初めの作り直しと、保存の整合の確かめ（`checkRunCheckpointConsistency`）の両方が、これを使う。
 * - 採番器は、`allocator` が渡されなければ、保存の値から `IdAllocator.restore` で作り直す（作り直せなければ、その例外を投げる）。
 * - 巡回の記録は、`CrawlFrontier.restore` で、その採番器と、保存の実効の設定（`effectiveConfig.crawl`）の深さの上限と URL の正規化で
 *   残す query の引数、待ち行列に戻す理由（`RESUME_REQUEUE_SKIP_REASON_CODES`）で作り直す（作り直せなければ、その例外を投げる）。
 *   設定を保存の実効の設定から取るのは、それが Run の設定の正だからである（再開のときの今の設定とは、再開する Run の選び方
 *   `selectRunToResume` で、同じことを確かめ済み。`CC-plan.md` の「設計者の判断」の 1）。
 * 監査の途中だった URL と、待ち行列に戻す理由の SKIPPED の URL は、`QUEUED` に戻る（設計書 3.2、4.2）。
 */
export function restoreRunCheckpointCrawl(
  checkpoint: Pick<RunCheckpoint, 'allocator' | 'frontier' | 'effectiveConfig'>,
  allocator: IdAllocator = IdAllocator.restore(checkpoint.allocator),
): RestoredRunCheckpointCrawl {
  const { maxDepth, allowedQueryParameters } = checkpoint.effectiveConfig.crawl;
  const frontier = CrawlFrontier.restore(checkpoint.frontier, {
    maxDepth,
    allocator,
    allowedQueryParameters: new Set(allowedQueryParameters),
    requeueSkipReasonCodes,
  });
  return { allocator, frontier };
}

/**
 * 保存の値から、採番器と巡回の記録を作り直せるかを確かめ、作り直せなければ、英語の技術的な詳細で `errors` に加える
 * （`checkRunCheckpointConsistency` の一部。設計書 4.2、4.10 の DEF-022。R8）。Run Coordinator が再開の初めに作り直すときと同じ
 * `restoreRunCheckpointCrawl` で作り直す。作り直したものは使わない。採番器を作り直せない場合も、すべての食い違いを返すため、
 * 採番器は先に `IdAllocator.restore` で確かめ、作り直せなければ、巡回の記録は、新しい採番器で確かめる。
 */
const collectRestorationInconsistencies = (checkpoint: RunCheckpoint, errors: string[]): void => {
  let allocator: IdAllocator;
  try {
    allocator = IdAllocator.restore(checkpoint.allocator);
  } catch (error) {
    errors.push(`/allocator cannot be restored: ${restorationFailureMessage(error, checkpoint)}`);
    allocator = new IdAllocator();
  }
  try {
    restoreRunCheckpointCrawl(checkpoint, allocator);
  } catch (error) {
    errors.push(`/frontier cannot be restored: ${restorationFailureMessage(error, checkpoint)}`);
  }
};

/**
 * スキーマの検証の済んだ `state.json` の値の、スキーマでは確かめられない整合を確かめる（設計書 4.2、4.3、4.8）。
 * - 終わったページの ID（`completedPageIds`）は、すべて巡回の記録にあり、その状態が `AUDITED` か `FAILED` である。
 * - 巡回の記録で `AUDITED` か `FAILED` の URL は、すべて終わったページの ID にある（ページの保存を先に書き、その後で `state.json` を
 *   置き換えるので、`state.json` の上で監査を終えた URL には、必ずページの保存がある）。
 * - 実行の記録（R4b1。設計書 4.8）: 最後のもの以外は、終わり方と終わりの時刻が `null` でない。最後のものは、保存の状態が
 *   `IN_PROGRESS` なら、終わり方と終わりの時刻がともに `null`。`STOPPED` と `FINISHED` なら、ともに `null` でない。最後のものの
 *   終わり方は、`INTERRUPTED_ABNORMALLY` でない（再開のときに、前の回の記録を閉じるときだけ使う）。
 * - 作り直し（R8。設計書 4.10 の DEF-022。`collectRestorationInconsistencies`）: 採番器と巡回の記録を、Run Coordinator が再開で使うのと同じ
 *   引数で作り直せる。巡回の記録そのものの正しさ（URL の正規形、深さの上限、同じ URL の重複など）は、作り直す `CrawlFrontier.restore` が
 *   確かめる。作り直せない保存を CLI が選ぶと、再開を始めた後に Run Coordinator の作り直しが失敗し、`--new` を付けるまで、毎回の起動が
 *   予期しない失敗で終わるため、ここで食い違いとし、壊れた保存として扱わせる。
 * 採番器の連番と、巡回の記録のページの ID の整合は確かめない（`src/core/ids.ts` に、ページの ID から連番を読む関数がないため）。
 * 例外を投げずに、すべての食い違いを、英語の技術的な詳細で返す（URL は、エラーの文に入れない）。
 */
export function checkRunCheckpointConsistency(checkpoint: RunCheckpoint): ArtifactValidationResult {
  const errors: string[] = [];
  const entries = new Map<PageId, CrawlUrlEntry>(checkpoint.frontier.entries.map((entry) => [entry.pageId, entry]));
  const completed = new Set<PageId>(checkpoint.completedPageIds);
  checkpoint.completedPageIds.forEach((pageId, index) => {
    const entry = entries.get(pageId);
    if (entry === undefined) {
      errors.push(`/completedPageIds/${index} (${pageId}) is not a page of the crawl frontier`);
    } else if (!AUDIT_FINISHED_CRAWL_URL_STATES.has(entry.state)) {
      errors.push(`/completedPageIds/${index} (${pageId}) has the crawl URL state ${entry.state}, not AUDITED or FAILED`);
    }
  });
  checkpoint.frontier.entries.forEach((entry, index) => {
    if (AUDIT_FINISHED_CRAWL_URL_STATES.has(entry.state) && !completed.has(entry.pageId)) {
      errors.push(`/frontier/entries/${index} (${entry.pageId}) is ${entry.state} but is not listed in /completedPageIds`);
    }
  });
  collectExecutionInconsistencies(checkpoint, errors);
  collectRestorationInconsistencies(checkpoint, errors);
  return consistencyResult(errors);
}

/**
 * スキーマの検証の済んだページの保存の値の、スキーマでは確かめられない整合を、その保存を載せた `state.json` の値と合わせて確かめる
 * （設計書 4.2、4.3）。
 * - ページの ID と URL が、結果の `pageId` と `pageUrl` と同じである。
 * - 再試行の前の試行の Evidence が、すべてそのページのものである。
 * - そのページが、`state.json` の終わったページの ID にあり、巡回の記録の URL と同じである。
 * 例外を投げずに、すべての食い違いを、英語の技術的な詳細で返す（URL は、エラーの文に入れない）。
 */
export function checkRunCheckpointPageConsistency(page: RunCheckpointPage, checkpoint: RunCheckpoint): ArtifactValidationResult {
  const errors: string[] = [];
  const { pageId } = page;
  if (page.result.pageId !== pageId) {
    errors.push(`/pageId (${pageId}) differs from /result/pageId (${page.result.pageId})`);
  }
  if (page.result.pageUrl !== page.url) {
    errors.push(`/url of ${pageId} differs from /result/pageUrl`);
  }
  page.retryEvidence.forEach((evidence, index) => {
    if (evidence.pageId !== pageId) {
      errors.push(`/retryEvidence/${index}/pageId (${evidence.pageId}) differs from /pageId (${pageId})`);
    }
  });
  if (!checkpoint.completedPageIds.includes(pageId)) {
    errors.push(`/pageId (${pageId}) is not listed in /completedPageIds of the checkpoint`);
  }
  const entry = checkpoint.frontier.entries.find((candidate) => candidate.pageId === pageId);
  if (entry !== undefined && entry.url !== page.url) {
    errors.push(`/url of ${pageId} differs from the URL of its crawl frontier entry`);
  }
  return consistencyResult(errors);
}

/**
 * 再開のときに、待ち行列に戻す SKIPPED の理由のコード（設計書 3.2）。再開の流れ（R4a2）は、`CrawlFrontier.restore` の
 * `requeueSkipReasonCodes` に、この一覧を渡す。1回の実行の時間の上限（`MAX_RUNTIME_REACHED`）、止める印（Ctrl+C など）で
 * 止めた理由（`RUN_INTERRUPTED`。R4b1。設計書 4.6.1）、サイトの不調で止めた理由（`SITE_UNAVAILABLE`。不調を検知したページと、
 * 始めなかったページ。サイトが応答しないときに Run を止める設計書 3.2）、認証つきの Run でセッションの切れで止めた理由
 * （`AUTH_SESSION_LOST`。Task 25 の設計書 4.3。T25c。再開のときは、もう一度ログインする（T25d））、承認したサービスの Origin への要求の上限で
 * 止めた理由（`SERVICE_REQUEST_LIMIT_REACHED`。Task 35 の設計書 3.4。T35c。再開の実行は新しい上限で数える）の5つである。
 */
export const RESUME_REQUEUE_SKIP_REASON_CODES = Object.freeze([
  'MAX_RUNTIME_REACHED',
  'RUN_INTERRUPTED',
  'SITE_UNAVAILABLE',
  'AUTH_SESSION_LOST',
  'SERVICE_REQUEST_LIMIT_REACHED',
] as const satisfies readonly IncompleteReasonCode[]);

/**
 * 再開できるかの判定の結果の閉じた一覧（設計書 3.2）。
 * - `RESUME`: 続きから監査する。
 * - `FINALIZE_ONLY`: 違反を検出した後なので、新しいページを始めず、最後の処理だけを行う。
 * - `NOT_RESUMABLE`: 再開の対象にしない（Run を終えている）。
 */
export const RUN_RESUMPTION_DECISIONS = Object.freeze(['RESUME', 'FINALIZE_ONLY', 'NOT_RESUMABLE'] as const);
export type RunResumptionDecision = (typeof RUN_RESUMPTION_DECISIONS)[number];

/**
 * `RESUME_REQUEUE_SKIP_REASON_CODES` の Set（この意味の Set は、ここに1つだけ置く。CC-040）。再開できるかの判定（`isLeftToAudit`）と、
 * 保存からの巡回の記録の作り直し（`restoreRunCheckpointCrawl`）が使う。
 */
const requeueSkipReasonCodes: ReadonlySet<IncompleteReasonCode> = new Set(RESUME_REQUEUE_SKIP_REASON_CODES);

/** 再開したときに監査する URL か（`QUEUED`、`AUDITING`、待ち行列に戻す理由の `SKIPPED`）。 */
const isLeftToAudit = (entry: CrawlUrlEntry): boolean =>
  entry.state === 'QUEUED'
  || entry.state === 'AUDITING'
  || (entry.state === 'SKIPPED' && entry.skipReason !== null && requeueSkipReasonCodes.has(entry.skipReason.code));

/**
 * 保存の状態と違反の検出のフラグから、再開できるかを判定する（設計書 3.2）。
 * - `FINISHED`: `NOT_RESUMABLE`（違反の有無によらない）。
 * - 違反を検出した後（`progress.safetyViolationDetected`）: `IN_PROGRESS` なら `FINALIZE_ONLY`。`STOPPED` は、最後の処理を
 *   行った後なので、`FINISHED` と同じく `NOT_RESUMABLE`。
 * - `IN_PROGRESS`: `RESUME`。
 * - `STOPPED`: 待ち行列に戻す理由（`RESUME_REQUEUE_SKIP_REASON_CODES`）の SKIPPED か、`QUEUED`・`AUDITING` の URL があれば `RESUME`、
 *   なければ `NOT_RESUMABLE`。
 * 違反の検出は、Run Coordinator（`#detectSafetyViolation`。監査を始める前の確かめと、各保存の前に、Ledger を調べて立てる）が記録した
 * フラグだけで判断し、Ledger の snapshot をここで調べ直さない。
 */
export function decideRunResumption(checkpoint: Pick<RunCheckpoint, 'state' | 'progress' | 'frontier'>): RunResumptionDecision {
  if (checkpoint.state === 'FINISHED') {
    return 'NOT_RESUMABLE';
  }
  if (checkpoint.progress.safetyViolationDetected) {
    return checkpoint.state === 'IN_PROGRESS' ? 'FINALIZE_ONLY' : 'NOT_RESUMABLE';
  }
  if (checkpoint.state === 'IN_PROGRESS') {
    return 'RESUME';
  }
  return checkpoint.frontier.entries.some(isLeftToAudit) ? 'RESUME' : 'NOT_RESUMABLE';
}

/**
 * 実行の記録のうち、終わり方が `null` のもの（前の回のプロセスが途中で終わった実行）を、終わり方 `INTERRUPTED_ABNORMALLY`、
 * 終わりの時刻 `savedAt`（その保存の時刻）にした写しを返す（設計書 4.8）。ほかの記録は、そのままの値で写す。再開のときに、Run Coordinator
 * が、保存の実行の記録に、この実行の分を加える前に呼ぶ。入力は変えず、凍結もしない。深く凍結した写しを返す。
 */
export function closeInterruptedRunExecutions(
  executions: RunCheckpoint['executions'],
  savedAt: string,
): RunCheckpoint['executions'] {
  const close = (execution: RunCheckpointExecution): RunCheckpointExecution => (execution.endReason === null
    ? { ...execution, finishedAt: savedAt, endReason: INTERRUPTED_ABNORMALLY_END_REASON }
    : execution);
  const [first, ...rest] = executions;
  const closed: RunCheckpoint['executions'] = [close(first), ...rest.map(close)];
  return deepFreeze(structuredClone(closed));
}

/**
 * 違反を検出した Run か（実行の終わり方と、保存の終わり方の判定の最初の行。設計書 4.3.2、4.8）。Run Status は読むだけで、決めない
 * （決めるのは `deriveRunStatus`。ARCH05）。比べる値は、`RunStatus` との比べとして型で確かめられる。
 */
const isSafetyAbortedRun = (runStatus: RunStatus): boolean => runStatus === 'ABORTED_BY_SAFETY';

/**
 * SKIPPED のページの理由のコードと、そのときの実行の終わり方（設計書 4.8。違反の次に、この順に確かめる）。順は、サイトの不調
 * （サイトが応答しないときに Run を止める設計書 3.2）、実行時間の上限、止める印。ここにある終わり方の実行は、再開できるように止まった
 * （実行時間の上限と止める印は今のページを終えてから、サイトの不調は不調を検知した時点で）ので、保存の状態を `STOPPED` にする
 * （設計書 4.3.2）。
 */
const STOPPING_SKIP_REASONS = Object.freeze([
  { skipReasonCode: 'SITE_UNAVAILABLE', endReason: 'STOPPED_BY_SITE_UNAVAILABLE' },
  { skipReasonCode: 'AUTH_SESSION_LOST', endReason: 'STOPPED_BY_AUTH_SESSION_LOST' },
  // T35c（Task 35 の設計書 3.4）: 承認したサービスの Origin への要求の上限に届いて止めた（セッションの切れの後、実行時間の上限の前）。
  { skipReasonCode: 'SERVICE_REQUEST_LIMIT_REACHED', endReason: 'STOPPED_BY_SERVICE_REQUEST_LIMIT' },
  { skipReasonCode: 'MAX_RUNTIME_REACHED', endReason: 'STOPPED_BY_RUNTIME_LIMIT' },
  { skipReasonCode: 'RUN_INTERRUPTED', endReason: 'STOPPED_BY_SIGNAL' },
] as const satisfies readonly { readonly skipReasonCode: IncompleteReasonCode; readonly endReason: RunExecutionEndReason }[]);

/** 保存の状態を `STOPPED` にする、実行の終わり方（`STOPPING_SKIP_REASONS` の終わり方）。 */
const STOPPING_EXECUTION_END_REASONS: ReadonlySet<RunExecutionEndReason> = new Set(STOPPING_SKIP_REASONS.map(({ endReason }) => endReason));

/**
 * 保存の終わり方の判定の結果の閉じた一覧（設計書 4.3.2）。
 * - `FINISH`: 最後の状態の保存を書く（CLI が、最後の出力を書き終えた後に、セッションの `finish` に渡す）。
 * - `ABANDON`: 保存の状態を変えない（CLI が、最後の出力を書き終えた後に、セッションの `abandon` を呼ぶ）。
 * - `NONE`: 保存のセッションがない、または始めなかった（CLI は何もしない）。
 */
export const RUN_CHECKPOINT_CONCLUSION_ACTIONS = Object.freeze(['FINISH', 'ABANDON', 'NONE'] as const);
export type RunCheckpointConclusionAction = (typeof RUN_CHECKPOINT_CONCLUSION_ACTIONS)[number];

/**
 * 最後の状態の保存の中身を、何で作るかの閉じた一覧（設計書 4.3.2）。
 * - `CRAWL_END`: 巡回の終わり（残りの URL を SKIPPED にした後、Browser を閉じる前）の値。
 * - `LAST_WRITTEN`: 最後に書けた保存（この実行のもの。なければ再開の入力のもの）の値。違反を検出した Run で、この実行の保存に
 *   失敗した場合だけ使う。
 */
export const RUN_CHECKPOINT_FINAL_CONTENTS = Object.freeze(['CRAWL_END', 'LAST_WRITTEN'] as const);
export type RunCheckpointFinalContent = (typeof RUN_CHECKPOINT_FINAL_CONTENTS)[number];

/**
 * 保存の終わり方（設計書 4.3.2）。`FINISH` のときだけ、最後の状態と、その中身を何で作るかと、出力の書き出しに失敗しても `finish` を行うか
 * （`finishEvenIfOutputFails`。設計書 4.10 の Important-1 の (b)）を持つ。
 */
export type RunCheckpointConclusion =
  | { readonly action: Extract<RunCheckpointConclusionAction, 'NONE'> }
  | { readonly action: Extract<RunCheckpointConclusionAction, 'ABANDON'> }
  | {
    readonly action: Extract<RunCheckpointConclusionAction, 'FINISH'>;
    readonly state: Exclude<RunCheckpointState, 'IN_PROGRESS'>;
    readonly content: RunCheckpointFinalContent;
    /**
     * CLI が、最後の出力の書き出しに失敗した場合も、`finish` を行うか。違反を検出した Run（Run Status が `ABORTED_BY_SAFETY`）だけ真にする。
     * 出力を書けなくても、違反の後に再開しない状態（`FINISHED`）にするためである。偽なら、出力をやり直せるよう、保存の状態を変えない
     * （`abandon`）。
     */
    readonly finishEvenIfOutputFails: boolean;
  };

/** 保存の終わり方の判定の入力（設計書 4.3.2。すべて、Run が終わった後の事実）。 */
export interface RunCheckpointConclusionFacts {
  /** 保存のセッションを渡され、始められた。 */
  readonly sessionStarted: boolean;
  /** この実行の Run Status。 */
  readonly runStatus: RunStatus;
  /** SKIPPED のページの理由のコードの集まり。 */
  readonly skipReasonCodes: ReadonlySet<IncompleteReasonCode>;
  /** この実行で、保存に失敗した。 */
  readonly checkpointWriteFailed: boolean;
  /** 再開した実行である。 */
  readonly resumed: boolean;
  /** この実行の Run Status の入力 `preflightFailed`。 */
  readonly preflightFailed: boolean;
  /** 最後に書けた保存がある（この実行で書けた保存か、再開の入力の保存）。 */
  readonly hasWrittenCheckpoint: boolean;
}

const NONE_CONCLUSION: RunCheckpointConclusion = Object.freeze({ action: 'NONE' });
const ABANDON_CONCLUSION: RunCheckpointConclusion = Object.freeze({ action: 'ABANDON' });
/** 違反を検出した Run の `FINISH`（出力の書き出しに失敗しても `finish` を行う。設計書 4.10）。 */
const FINISHED_AFTER_VIOLATION_FROM_CRAWL_END: RunCheckpointConclusion = Object.freeze({
  action: 'FINISH',
  state: 'FINISHED',
  content: 'CRAWL_END',
  finishEvenIfOutputFails: true,
});
const FINISHED_AFTER_VIOLATION_FROM_LAST_WRITTEN: RunCheckpointConclusion = Object.freeze({
  action: 'FINISH',
  state: 'FINISHED',
  content: 'LAST_WRITTEN',
  finishEvenIfOutputFails: true,
});
/** 違反のない Run の `FINISH`（出力の書き出しに失敗したら `finish` を行わない）。 */
const FINISHED_FROM_CRAWL_END: RunCheckpointConclusion = Object.freeze({
  action: 'FINISH',
  state: 'FINISHED',
  content: 'CRAWL_END',
  finishEvenIfOutputFails: false,
});
const STOPPED_FROM_CRAWL_END: RunCheckpointConclusion = Object.freeze({
  action: 'FINISH',
  state: 'STOPPED',
  content: 'CRAWL_END',
  finishEvenIfOutputFails: false,
});

/**
 * この実行の終わり方を決める（設計書 4.8。サイトが応答しないときに Run を止める設計書 3.2）。上から順に、最初に当てはまるもの:
 * 1. Run Status が `ABORTED_BY_SAFETY` → `STOPPED_BY_SAFETY_VIOLATION`
 * 2. 理由 `SITE_UNAVAILABLE` の SKIPPED がある → `STOPPED_BY_SITE_UNAVAILABLE`
 * 2a. 理由 `AUTH_SESSION_LOST` の SKIPPED がある → `STOPPED_BY_AUTH_SESSION_LOST`（認証つきの Run だけ。T25c）
 * 2b. 理由 `SERVICE_REQUEST_LIMIT_REACHED` の SKIPPED がある → `STOPPED_BY_SERVICE_REQUEST_LIMIT`（スクリプトで送るログインの監査の Run だけ。T35c）
 * 3. 理由 `MAX_RUNTIME_REACHED` の SKIPPED がある → `STOPPED_BY_RUNTIME_LIMIT`
 * 4. 理由 `RUN_INTERRUPTED` の SKIPPED がある → `STOPPED_BY_SIGNAL`
 * 5. それ以外 → `COMPLETED`
 * 2〜4 の順は、`STOPPING_SKIP_REASONS` の並びで決まる。
 * `INTERRUPTED_ABNORMALLY` は返さない（再開のときに、前の回の記録を閉じるときだけ使う。`closeInterruptedRunExecutions`）。
 */
export function decideRunExecutionEndReason(
  facts: Pick<RunCheckpointConclusionFacts, 'runStatus' | 'skipReasonCodes'>,
): Exclude<RunExecutionEndReason, typeof INTERRUPTED_ABNORMALLY_END_REASON> {
  if (isSafetyAbortedRun(facts.runStatus)) {
    return 'STOPPED_BY_SAFETY_VIOLATION';
  }
  const stopping = STOPPING_SKIP_REASONS.find(({ skipReasonCode }) => facts.skipReasonCodes.has(skipReasonCode));
  return stopping?.endReason ?? 'COMPLETED';
}

/**
 * Run が終わった後の、保存の終わり方を決める（設計書 4.3.2 の表）。上から順に、最初に当てはまる行:
 * 1. 保存のセッションを始めなかった → `NONE`
 * 2. Run Status が `ABORTED_BY_SAFETY` → この実行で保存に失敗していなければ、巡回の終わりの値で `FINISHED`。失敗していれば、最後に
 *    書けた保存があれば、その値で `FINISHED`、なければ `ABANDON`（違反を検出した Run は、必ず `FINISHED` にする。5章）
 * 3. この実行で、保存に失敗した → `ABANDON`
 * 4. 再開した実行で、PREFLIGHT に失敗した → `ABANDON`
 * 5. それ以外 → 巡回の終わりの値で、この実行の終わり方（`decideRunExecutionEndReason`）が、サイトの不調か実行時間の上限か止める印
 *    （`STOPPING_SKIP_REASONS` の終わり方）なら `STOPPED`、ほかは `FINISHED`
 * `FINISH` の `finishEvenIfOutputFails`（出力の書き出しに失敗しても `finish` を行うか。設計書 4.10）は、2 の行（Run Status が
 * `ABORTED_BY_SAFETY`）だけ真、5 の行は偽にする（この規則は、ここだけに置く）。凍結した値を返す。
 */
export function decideRunCheckpointConclusion(facts: RunCheckpointConclusionFacts): RunCheckpointConclusion {
  if (!facts.sessionStarted) {
    return NONE_CONCLUSION;
  }
  if (isSafetyAbortedRun(facts.runStatus)) {
    if (!facts.checkpointWriteFailed) {
      return FINISHED_AFTER_VIOLATION_FROM_CRAWL_END;
    }
    return facts.hasWrittenCheckpoint ? FINISHED_AFTER_VIOLATION_FROM_LAST_WRITTEN : ABANDON_CONCLUSION;
  }
  if (facts.checkpointWriteFailed) {
    return ABANDON_CONCLUSION;
  }
  if (facts.resumed && facts.preflightFailed) {
    return ABANDON_CONCLUSION;
  }
  return STOPPING_EXECUTION_END_REASONS.has(decideRunExecutionEndReason(facts)) ? STOPPED_FROM_CRAWL_END : FINISHED_FROM_CRAWL_END;
}

/** JSON の値としての項目の一覧（値が `undefined` の項目は、JSON にないものとして除く）。 */
const jsonKeys = (value: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(value).filter((key) => value[key] !== undefined);

/** 2つの値が、JSON の値として同じか（配列は順を含めて比べる）。 */
const sameJsonValue = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false;
    }
    const leftKeys = jsonKeys(left);
    const rightKeys = new Set(jsonKeys(right));
    return leftKeys.length === rightKeys.size
      && leftKeys.every((key) => rightKeys.has(key) && sameJsonValue(left[key], right[key]));
  }
  return left === right;
};

/** `saved` と `current` の違う項目のパス（`.` でつなぐ）を `differences` に加える。オブジェクトの中だけを項目ごとにたどる。 */
const collectJsonDifferences = (saved: unknown, current: unknown, path: string, differences: string[]): void => {
  if (!isRecord(saved) || !isRecord(current)) {
    if (!sameJsonValue(saved, current)) {
      differences.push(path);
    }
    return;
  }
  const savedKeys = jsonKeys(saved);
  const currentKeys = jsonKeys(current);
  const keys = [...savedKeys, ...currentKeys.filter((key) => !savedKeys.includes(key))];
  for (const key of keys) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (!savedKeys.includes(key) || !currentKeys.includes(key)) {
      differences.push(childPath);
    } else {
      collectJsonDifferences(saved[key], current[key], childPath, differences);
    }
  }
};

/**
 * 保存した実効の設定と、今回の実効の設定が、完全に同じかを確かめる（設計書 4.7）。違う項目のパス（例: `crawl.maxPages`）を返し、
 * 同じなら空の配列を返す。比べ方は、JSON の値としての深い比較である（配列は順を含めて比べ、違えば配列の項目のパスを返す）。
 * パスは、保存した設定の項目の順に並べ、今回の設定にだけある項目を最後に加える。
 * AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1）: 監査の段の送信の扱い（`audit.sendPolicy`）も比べる（比べない項目にしない）。
 * LG-4（テストの組の設計書 3.7.3、3.7.5）: 項目を持たない設定（AS-b の前の保存）を `READ_ONLY` と読み替えずに比べる（項目のない保存は「設定が違う」になり、
 * 黙って前の方針で再開しない）。
 */
export function effectiveConfigDifferences(saved: EffectiveAuditConfig, current: EffectiveAuditConfig): readonly string[] {
  const differences: string[] = [];
  collectJsonDifferences(saved, current, '', differences);
  return Object.freeze(differences);
}

/**
 * 再開する Run を選ぶときに比べない、実効の設定の項目のパスの閉じた一覧（設計書 4.7。R5-fix-round-1）。パスの書き方は、
 * `effectiveConfigDifferences` が返すパスと同じ。`selectRunToResume` は、違う項目から、これらのパスを除いてから、設定が違うかを決める。
 * - `output.directory`（`--output` の上書きを含む）: 出力先は、途中の Run を探す場所そのものである。書き方が違っても（例: 相対のパスと、
 *   同じ場所の絶対のパス）、同じ出力先の途中の Run を再開できるようにする（R5b の報告）。
 * - `browser.headed`（画面の表示の設定と、`--headed`・`--headless` の上書きを含む）: 表示は、承認に結ばれるプロファイルの改訂の外にある
 *   （FM-2 fix round 1。設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.2）。表示を切り替えただけで、中断した Run が再開できなく
 *   ならないようにする。Guard・Context・上限は表示で変わらない。
 * 並びは、`effectiveConfigDifferences` が返す順（保存の実効の設定の項目の順）である。
 */
export const RESUME_CONFIG_IGNORED_PATHS = Object.freeze(['browser.headed', 'output.directory'] as const);

const RESUME_CONFIG_IGNORED_PATH_SET: ReadonlySet<string> = new Set(RESUME_CONFIG_IGNORED_PATHS);

/**
 * 再開のときに、保存したものと同じでなければならない版の項目の閉じた一覧（設計書 4.7、4.7.1。この順に比べる）。
 * Chromium の版は比べない。BeakSight は、Playwright に同梱の Chromium だけを使い（`chromium.launch` に実行ファイルのパスは渡さない。
 * `channel` は、Playwright に同梱の Chromium を使う `'chromium'` だけである。設計書 4.10）、Chromium の版は Playwright の版で決まるためで
 * ある（R5a の設計）。各実行の Chromium の版は、保存の実行の記録に残る。
 */
export const RUN_VERSION_FIELDS = Object.freeze(['toolVersion', 'playwrightVersion'] as const);
export type RunVersionField = (typeof RUN_VERSION_FIELDS)[number];

/** BeakSight と Playwright の版（`RUN_VERSION_FIELDS` の項目）。 */
export interface RunVersions {
  readonly toolVersion: string;
  readonly playwrightVersion: RunEnvironment['playwrightVersion'];
}

/** 違う版の1項目（項目、保存の値、今の値）。CLI が、違う版を示すために使う（設計書 4.7.1）。 */
export interface RunVersionDifference {
  readonly field: RunVersionField;
  readonly saved: string;
  readonly current: string;
}

/**
 * 保存の BeakSight の版と、最初の実行の環境の Playwright の版を、今の版と比べる（設計書 4.7、4.7.1）。違う項目を、保存の値と今の値を
 * 添えて、`RUN_VERSION_FIELDS` の順に返し、同じなら空の配列を返す。深く凍結した値を返す。
 */
export function runVersionDifferences(
  checkpoint: Pick<RunCheckpoint, 'toolVersion' | 'executions'>,
  current: RunVersions,
): readonly RunVersionDifference[] {
  const [firstExecution] = checkpoint.executions;
  const saved: RunVersions = {
    toolVersion: checkpoint.toolVersion,
    playwrightVersion: firstExecution.environment.playwrightVersion,
  };
  return deepFreeze(RUN_VERSION_FIELDS
    .filter((field) => saved[field] !== current[field])
    .map((field) => ({ field, saved: saved[field], current: current[field] })));
}

/** 再開する Run を選ぶときの、読めた保存の1件（設計書 4.7.1）。`checkpoint` は、`state.json`（使えなければ `state.prev.json`）の値。 */
export interface RunResumeCandidate {
  readonly runId: RunId;
  readonly runDirectory: string;
  readonly checkpoint: RunCheckpoint;
}

/**
 * 再開する Run の選び方の結果の閉じた一覧（設計書 4.7.1 の「選び方」）。
 * - `START_NEW`: 再開しない。知らせなしに、新しい Run を始める（同じ対象の Run がない、または最も新しいものが再開できない）。
 * - `CONFIG_DIFFERS`: 最も新しいものの実効の設定が今回と違うので、再開しない。違う項目を知らせて、新しい Run を始める。
 * - `RESUME`: 最も新しいものを再開する（`RESUME` か `FINALIZE_ONLY`）。
 */
export const RUN_RESUME_SELECTION_KINDS = Object.freeze(['START_NEW', 'CONFIG_DIFFERS', 'RESUME'] as const);
export type RunResumeSelectionKind = (typeof RUN_RESUME_SELECTION_KINDS)[number];

/** `selectRunToResume` の結果（`kind` は `RUN_RESUME_SELECTION_KINDS`）。 */
export type RunResumeSelection =
  | { readonly kind: Extract<RunResumeSelectionKind, 'START_NEW'> }
  | {
    readonly kind: Extract<RunResumeSelectionKind, 'CONFIG_DIFFERS'>;
    readonly candidate: RunResumeCandidate;
    /** 違う項目のパス（`effectiveConfigDifferences` の値から、比べない項目 `RESUME_CONFIG_IGNORED_PATHS` を除いたもの。1件以上）。 */
    readonly differences: readonly string[];
  }
  | {
    readonly kind: Extract<RunResumeSelectionKind, 'RESUME'>;
    readonly candidate: RunResumeCandidate;
    readonly decision: Exclude<RunResumptionDecision, 'NOT_RESUMABLE'>;
  };

const START_NEW_SELECTION: RunResumeSelection = Object.freeze({ kind: 'START_NEW' });

/** 最初の実行の開始の時刻（ms）。読めない時刻は、最も古いものとして扱う。 */
const firstExecutionStartedAtMs = (candidate: RunResumeCandidate): number => {
  const parsed = Date.parse(candidate.checkpoint.startedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/** `left` が `right` より新しい Run か（最初の実行の開始が後。同じなら、Run の ID がコード単位の順で後）。 */
const isNewerRun = (left: RunResumeCandidate, right: RunResumeCandidate): boolean => {
  const leftMs = firstExecutionStartedAtMs(left);
  const rightMs = firstExecutionStartedAtMs(right);
  return leftMs !== rightMs ? leftMs > rightMs : compareCodeUnits(left.runId, right.runId) > 0;
};

/**
 * 再開する Run を選ぶ（設計書 4.7.1 の「選び方」。この意味の owner）。`runs` は、出力先の `state.json`（使えなければ `state.prev.json`）を
 * 読めた Run（終わった Run も含む）、`current` は今回の実効の設定（対象の ID は `current.target.id`）。
 * 1. 同じ対象（`checkpoint.effectiveConfig.target.id`）の Run のうち、最初の実行の開始（`checkpoint.startedAt`）が最も新しいもの1つだけを
 *    候補にする（同じ時刻なら、Run の ID がコード単位の順で後のもの）。ほかの対象の Run は無視する。候補がなければ `START_NEW`。
 * 2. 候補の `decideRunResumption` が `NOT_RESUMABLE` なら `START_NEW`（古い途中の Run を、後で思いがけず再開しないため）。
 * 3. 候補の実効の設定が違えば（`effectiveConfigDifferences` の結果から、比べない項目 `RESUME_CONFIG_IGNORED_PATHS` を除いたものが空で
 *    ない）、`CONFIG_DIFFERS`（違う項目のパスを持つ。比べない項目は含めない）。Run の種類（保存の `authentication` と、今回の
 *    `currentAuthentication`。どちらも、ないものは公開監査の Run）が違っても `CONFIG_DIFFERS` にし、違う項目のパスの最後に
 *    `RUN_KIND_DIFFERENCE_PATH` を加える（T25g-2。認証つきの Run と公開監査の Run は、互いに再開しない）。
 * 4. それ以外は `RESUME`（`decision` は `RESUME` か `FINALIZE_ONLY`）。
 * 版の確かめと、ページの保存まで読むことは、呼び出し側（CLI）が、この後に行う。入力は変えない。凍結した結果を返す（`candidate` は
 * 入力の値そのもの）。
 */
export function selectRunToResume(
  runs: readonly RunResumeCandidate[],
  current: EffectiveAuditConfig,
  currentAuthentication: RunCheckpointAuthentication | null = null,
): RunResumeSelection {
  let latest: RunResumeCandidate | null = null;
  for (const run of runs) {
    if (run.checkpoint.effectiveConfig.target.id === current.target.id && (latest === null || isNewerRun(run, latest))) {
      latest = run;
    }
  }
  if (latest === null) {
    return START_NEW_SELECTION;
  }
  const decision = decideRunResumption(latest.checkpoint);
  if (decision === 'NOT_RESUMABLE') {
    return START_NEW_SELECTION;
  }
  const savedKind = latest.checkpoint.authentication?.settingsDigest ?? null;
  const currentKind = currentAuthentication?.settingsDigest ?? null;
  const differences = Object.freeze([
    ...effectiveConfigDifferences(latest.checkpoint.effectiveConfig, current).filter((path) => !RESUME_CONFIG_IGNORED_PATH_SET.has(path)),
    ...(savedKind === currentKind ? [] : [RUN_KIND_DIFFERENCE_PATH]),
  ]);
  return differences.length > 0
    ? Object.freeze({ kind: 'CONFIG_DIFFERS', candidate: latest, differences })
    : Object.freeze({ kind: 'RESUME', candidate: latest, decision });
}

// ロックの中身と判定、古いロックの原子的な取り直しの手順の置き場所は `src/core/process-lock.ts`（T24h-3。画面のサーバのロックと共用する）。
// 呼び出し側はそこを直接 import する（LG-4: ここからの export し直しは捨てた）。

/**
 * `RunCheckpointStore.acquireRunLock` の結果（設計書 4.4）。形と意味は `src/core/process-lock.ts` の `LockFileAcquisition`（T24h-3 で移した）。
 * `ArtifactWriter` の `RunLockAcquisition` と同じ形である。
 */
export type RunCheckpointLockAcquisition = LockFileAcquisition;

/**
 * 保存とロックのファイルの書き手（設計書 4.3.1）。`ArtifactWriter` が形の上で満たす（満たすことは、テストの型の確かめで確かめる）。
 * orchestration は report を import しないので、`ArtifactWriter` を型として参照しない。ファイルの読み書きは、書き手だけが行う（ARCH08）。
 * - `writeCheckpointPage`: ページの保存を `checkpoint/pages/<pageId>.json` に書き、Run のディレクトリからの相対パスを返す。
 * - `writeCheckpointState`: 状態の保存を `checkpoint/state.json` に書く（今の `state.json` は `state.prev.json` に移す）。
 * - `acquireRunLock`: `checkpoint/run.lock` を排他的に作る。すでにあれば、作らずにその中身を返す。
 * - `rewriteRunLock`: `checkpoint/run.lock` を、渡した中身でまるごと書き換える（ハートビート）。
 * - `readRunLock`: `checkpoint/run.lock` の中身を JSON として読んだ値を返す（ファイルがない、または JSON として読めなければ `null`。
 *   判定は `judgeRunLock`）。読むだけで、書かない（ほかの起動が同時に取り直したときに、今の中身を示すため。設計書 4.4）。
 * - `releaseRunLock`: `checkpoint/run.lock` を消す（なければ何もしない）。
 * - `cleanUpForResume`: 再開する前に、Run のディレクトリの中の、前の回の途中のもの（終わったページの一覧にないページのディレクトリ、
 *   書き出しの途中の一時ファイルなど）を消し、消したものの、Run のディレクトリからの相対パスを返す（設計書 4.5）。
 * - `takeOverRunLock`: 判定した古い `checkpoint/run.lock` を、原子的に取り直す（DEF-060。`RunLockTakeover`）。保存のセッションは、古いロックの
 *   取り直しにこれを使う（`takeOverStaleLock`）。LG-4: 必須（書き換えて読み直す前の方式は捨てた）。本番の `ArtifactWriter` は持つ。
 * 書けなかった場合は、どれも reject する。
 */
/**
 * `writeCheckpointPage` の指定（T44R3 の M-2）。`keptUrls` は、巡回が知っている URL（待ち行列と、監査したページの URL）。書き手は、記録した要求の URL を
 * 値で照らす段で、これらを照らさない（あとで監査するページの URL を、続けて終えた Run と同じく伏せない）。
 */
export interface RunCheckpointPageWriteOptions {
  readonly keptUrls: readonly string[];
}

export interface RunCheckpointStore {
  takeOverRunLock(runDirectory: string, judged: unknown, lock: RunLock): Promise<RunLockTakeover>;
  writeCheckpointPage(runDirectory: string, page: RunCheckpointPage, options?: RunCheckpointPageWriteOptions): Promise<string>;
  writeCheckpointState(runDirectory: string, state: RunCheckpoint): Promise<void>;
  acquireRunLock(runDirectory: string, lock: RunLock): Promise<RunCheckpointLockAcquisition>;
  rewriteRunLock(runDirectory: string, lock: RunLock): Promise<void>;
  readRunLock(runDirectory: string): Promise<unknown>;
  releaseRunLock(runDirectory: string): Promise<void>;
  cleanUpForResume(runDirectory: string, completedPageIds: readonly PageId[]): Promise<readonly string[]>;
  /**
   * SR-1-F5（SR-1R3 の M3）: 状態の保存（`state.json`、使えなければ `state.prev.json`）を、`checkState` の確かめを通して読む（省略できる。本番の
   * `ArtifactWriter` は持つ）。保存のセッションは、再開の Run のロックを取った後に、再開を選んだときの保存と同じかを確かめるのに使う。
   */
  readCheckpointState?(
    runDirectory: string,
    checkState: (state: RunCheckpoint) => ArtifactValidationResult,
  ): Promise<{ readonly ok: true; readonly state: RunCheckpoint } | { readonly ok: false }>;
}

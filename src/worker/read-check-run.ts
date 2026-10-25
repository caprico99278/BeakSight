/**
 * READ の確かめのジョブ（`READ_CHECK`）の流れ（Task 27 の設計書 3 章、4.5、4.8 と、変更履歴の「T27a の報告」の (6)、「Blocker: T27c」の行。
 * T27e）。ワーカーの流れ（`audit-worker-session.ts`）が、ログインの段の後に、認証の指定（`RunAuthentication`）と `START` の定義の一覧を付けて
 * 呼ぶ。今の監査の流れには手を入れない。サイトへの要求は GET（Guard の付いた Passive の Context の読み込み）だけ。
 *
 * 1. Run の始めと終わり（発見のジョブと同じ部品 `startWorkerRun`・`endWorkerRun`。出力先の開始のロックと Run のロック）。
 * 2. Run の前の確認（`runPreflight`。認証の指定を付けた factory）。失敗したら、どの定義も確かめずに `PREFLIGHT_FAILED`。
 * 3. 定義を、対象の候補の画面ごとにまとめ（`START` の順に、最初に出た画面の順）、画面ごとに:
 *    a. 対象の画面の URL を、事前の判定（`isReadUrlAllowed`）に通す（止まれば、その画面の定義はすべて `READ_BLOCKED_BY_POLICY`）。
 *    b. 新しい Context で画面を読み込み（間隔を守る。`visitGuardedPage`）、発見の入口で候補を読む（`readCandidatePage`。凍結をかける）。
 *    c. 定義ごとに、候補の今の形を確かめる（`confirmReadTargetOnPage`。識別の digest が同じ候補が 1 つあり、今の分類が `READ`）。
 *    d. URL を組み立てる（`buildReadCheckUrl`。候補の送信先と、定義の送る値だけ。秘密に見える名前を確かめ直し、送る値の名前と値が発見の分類の
 *       危険な語に当たれば読まずに `READ_BLOCKED_BY_POLICY`・`PARAMETER_DANGEROUS_WORD`。T27R-fix-1。DEF-088）。送る値の名前が、今の候補の
 *       送れる欄（純粋な契約の `unsendableReadCheckParameterNames`。保存の確かめと同じ判定）であることを確かめ直す（保存の後に欄が見えない・
 *       readonly・disabled に変わったら、読まずに `READ_BLOCKED_BY_POLICY`・`PARAMETER_NOT_SENDABLE`。fail-closed。CCX-10）。
 *    e. 事前の判定（`isReadUrlAllowed`。止まれば読まずに `READ_BLOCKED_BY_POLICY`）。
 *    f. 凍結した Context では読み込めないので、別の新しい Context で、間隔を守って READ の URL を読み込む（GET）。HTTP の状態を記録する。4xx・5xx は
 *       照らさずに `UNDETERMINED`。落ち着いた後に、構造を 1 回の evaluate で読み（`readSettledPageStructure`）、期待と照らす。
 * 4. 止まり方（発見のジョブと同じ）: 止める要求（今の定義を終えてから）、実行の時間の上限（`crawl.maxRuntimeMs`）、セッションの切れ（Task 25 の
 *    判定。止まった画面の URL を伏せ字を通して知らせる。再開しない）、Safety Ledger の不変条件の違反。止まった後の定義は `NOT_EXECUTED`。DEF-144: 違反で
 *    止まったら、違反の中身（`src/safety/job-safety-violation.ts`）を成果物の `safetyViolation` と件数の要約（IPC）に残す。
 * 5. 成果物: Run のディレクトリの `read-evidence.json` を、ArtifactWriter（URL の秘密を伏せる書き手）の `writeReadEvidence` で書く。表の全体は
 *    写さない（件数と照らした項目だけ）。結果は、Run の ID、Run のディレクトリ、Run Status、件数の要約（IPC に結果を載せない）。
 * 事前の判定（`isReadUrlAllowed`）: 読み込みの事前の判定の共通の部品（`isRunNavigationBlocked`。巡回の候補の除外 `isExcludedCrawlCandidate` と
 * 同じ部品。CCX-10）を、どの BLOCK でも止める範囲（`ANY_BLOCK`）で呼ぶ。要求の判定の owner（`classifyPassiveRequest`）に、main frame の
 * ナビゲーションの GET として、設定の許可 Origin と認証の設定の監査の段の除外（読まないパス、読む範囲、既定の危険な語）を渡し、BLOCK なら
 * 止め、セッションの切れの path（ログインの画面）も止める。加えて、プロファイルの許可 Origin の外も止める（fail-closed）。
 * 秘密（Cookie、localStorage）は、メモリの認証の指定のまま factory に渡し、ここで読まない・書かない。
 * T37a（Task 37 の設計書 3.1）: 認証の指定に監査の段の口があれば（`jobContextFactoryOptions`。登録した読み取りの手続きの呼び出しを通す `REGISTERED`）:
 * - 1 つの定義ごとに、始める前に、承認したサービスの Origin への要求の上限に届いたか（`isServiceRequestLimitReached`。Run Coordinator と同じ判定）を
 *   確かめ、届いていれば残りの定義を確かめずに終える（`SERVICE_REQUEST_LIMIT_REACHED`。残りは `NOT_EXECUTED`。Run Status は `PARTIAL`）。
 * - 読み込みの後に、ログインの状態の鍵がなくなっていれば、セッションの切れと同じ終わり方にする（詳しい理由 `endReasonDetail` は `session-key`）。
 * - 対象の画面の Context で上限で断った要求か 401 があれば、その画面は読み切れていない（候補が見つからなくても、消えたと言わず `UNDETERMINED`）。
 * - 成果物に監査の段の数（`authentication`）を書き、件数の要約にも同じ値を載せる。
 * T37d（Task 37 の設計書 3.5）:
 * - 画面の path の定義（`targetPagePath`）は、1 つずつ、設定の開始の URL の Origin とその path の画面を、新しい Context で 1 回だけ読み込み、落ち着きを
 *   待って構造を読み、期待と照らす（`executePageReadCheck`。候補の digest の照合はしない。登録した読み取りの手続きの呼び出しは、監査の段の口の
 *   `REGISTERED` で通す）。
 * - 候補の READ と画面の READ の両方で、読んで照らした定義の読み込みの間に、上限で断ったサービスの Origin への要求か 401、登録した読み取りの手続きの
 *   呼び出しを回数の上限か送り方で止めた、承認したサービスの Origin への読み取りでない要求を止めた、のどれかがあれば、照らした結果に関係なく
 *   `UNDETERMINED`（`SERVICE_READ_REFUSED`・`AUDIT_STAGE_REQUEST_BLOCKED`。`readAndEvaluate`）。許可 Origin への計測の送信は数えない。鍵の消失は
 *   今どおりセッションの切れ（`SESSION_LOST`）。
 * - 書き込みの照合の READ（`verifyReadCheck`）は、画面の path の定義を読まずに止める（`REQUEST_POLICY`）。
 * T40b-2（Task 40 の設計書 3.3、7 章の「T40b-2 の設計（照合の READ の確かめ直し）」）: API の登録の書き込みの照合の READ は、`{id}` の型の画面の path の
 * 定義だけを、取れた登録の ID を入れた具体的な URL で読む（`verifyRecordPageReadCheck`。form の書き込みの `verifyReadCheck` は今のまま画面の path の定義を
 * 拒む）。読む URL の決め方（`recordPageReadTargetOf`）: 使える ID（`isUsableRecordId`）だけを `{id}` に入れ、設定の開始の URL の Origin と組み立てた path で
 * URL を作り、親が入れた対象の画面（Origin と型の path）と合うかを確かめる（合わなければ `URL_NOT_BUILT`）。組み立てた path に、保存の時と同じ画面の path の
 * 確かめ（唯一の owner `readCheckPagePathRejectionsOf`）と事前の判定 `isReadUrlAllowed` をかけ、どれかに当たれば読まずに `REQUEST_POLICY`。通れば画面の
 * path の READ と同じ手順（`readAndEvaluate`）で 1 回だけ読む。
 * DEF-136（設計書 `2026-10-18-beaksight-job-site-unavailability-design.md`）: READ の確かめのジョブ（`check`）は、対象の画面の候補の読み込みと READ の
 * URL の読み込みごとに、読み取りの監査と同じ不調の判定（`job-site-availability.ts` の `pageLoadVerdictOf`）をかける。不調なら、その結果を捨て、読み取りの
 * 監査の最初の待ちだけ待って同じ読み込みを 1 回だけ確かめ直す（`createJobSiteRecheck`。待つ間は知らせ `NOTICE`、止める印で確かめ直さずに止める）。まだ
 * 不調なら止める（終わり方 `SITE_UNAVAILABLE`。その定義と残りの定義は `NOT_EXECUTED`）。通ったら続け、読み込みの間隔を 2 倍にする。不調の判定は
 * `siteUnavailable` の印で渡し、証拠は今までどおり（4xx・5xx は `UNDETERMINED`）。書き込みの照合の READ（`verifyReadCheck`・`verifyRecordPageReadCheck`）は
 * 確かめ直さない（今のまま）。
 * DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md`）: 監査の段の口があれば、承認したサービスの Origin への要求の 1 分あたりの上限で、
 * 次の読み込みの前に待つ（`serviceRequestPacedNavigationPacer`。Run Coordinator・発見と共用する部品。待つたびに知らせ `NOTICE` を出す）。待った回数と時間は
 * 成果物の `authentication` に残る。1 回の Run あたりの上限は今どおり止める。
 */
import { resolve } from 'node:path';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { EXIT_CODES } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import { isUsableRecordId } from '../control/actions/action-outcome.js';
import { readCheckPagePathRejectionsOf, type ReadCheckPageContext } from '../control/read-check-page-path.js';
import type { WorkerStartReadCheck } from '../control/worker-protocol.js';
import { auditSendPolicyOf } from '../core/audit-send-policy.js';
import type { JobSafetyViolation, RunId, RunStatus, SessionKeyLostDetail } from '../core/contracts.js';
import type { SessionLossEvidence } from '../core/evidence-types.js';
import { wait } from '../core/deadline.js';
import { isHttpErrorOrNonStandardStatus } from '../core/http-status.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import type { CandidateLocation } from '../discovery/candidate-contracts.js';
import { pageLoadIncompleteReasonsOf, readInFullAfterIncompleteReasons, readInFullAfterServiceRefusal } from '../discovery/discovery-result.js';
import {
  readCheckPagePathOfTemplate,
  readCheckPageTemplateUrlOf,
  readCheckPageUrlOf,
  unsendableReadCheckParameterNames,
} from '../discovery/read-check-contracts.js';
import {
  READ_CHECK_DETAIL_RESULTS,
  READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  buildReadCheckUrl,
  confirmReadTargetOnPage,
  evaluateReadExpectations,
  readCheckAuditStageDetailOf,
  readCheckEvidenceTargetOf,
  readCheckResultOf,
  readEvidenceRunStatusOf,
  readEvidenceSummaryOf,
  readStructureSummaryOf,
  withReadCheckAuditStageDetail,
  type ReadCandidateConfirmation,
  type ReadCheckDetail,
  type ReadCheckEndReason,
  type ReadCheckEvidence,
  type ReadCheckExecutedEvidence,
  type ReadEvidenceDocument,
  type ReadEvidenceSummary,
} from '../discovery/read-check-evaluation.js';
import { readCandidatePage, readSettledPageStructure, type ReadCandidatePage, type ReadStructureOutcome } from '../discovery/read-executor.js';
import type { DiscoverySettlePolicy } from '../discovery/settle.js';
import {
  isAuditStageReadObstructed,
  isServiceRequestLimitReached,
  intervalTrackingNavigationPacer,
  jobContextFactoryOptions,
  recordRunStageCarry,
  runAuthenticationSummaryOf,
  serviceRequestPacedNavigationPacer,
  type JobAuditStage,
  type RunStageCarry,
} from '../orchestration/audit-stage-run.js';
import { auditSendOptionsOf } from '../orchestration/audit-send-options.js';
import { isRunNavigationBlocked, type RunAuthentication } from '../orchestration/authenticated-run.js';
import { closeBrowserBeforeDeadline, runPreflight, type BrowserLauncher } from '../orchestration/preflight.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import { isPageLoadLimitReached, pageRequestCountsOf, type PageRequestCounts } from '../safety/passive-request-guard.js';
import { redactUrlSecrets } from '../safety/redact.js';
import { hasAllowedOrigin } from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import {
  JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS,
  createJobSiteRecheck,
  pageLoadVerdictOf,
  type JobRunNotice,
  type JobSiteVisit,
} from './job-site-availability.js';
import { endWorkerRun, startWorkerRun, visitGuardedPage, type GuardedPageVisit, type GuardedPageVisitOptions } from './worker-run-session.js';

/** TS-c: READ の流れの読み込みの指定（`GuardedPageVisitOptions` に、読む前の落ち着きの待ちの指定を足す。省略は本番の `DISCOVERY_SETTLE_POLICY`）。 */
type ReadCheckPageVisitOptions = GuardedPageVisitOptions & { readonly settlePolicy?: DiscoverySettlePolicy | undefined };

/** 日時の名前（誤りの文に使う）。 */
const READ_CHECK_TIME_SUBJECT = 'read check run time';

/** READ の確かめの流れの入力。秘密（認証の状態）はメモリの認証の指定の中だけ。 */
export interface ReadCheckRunRequest {
  /** ワーカーが読んだ設定（`WORKER_CONFIG_OVERRIDES` の headless）。 */
  readonly config: AuditConfig;
  /** ジョブの ID（成果物に書き、親が照らし合わせる）。 */
  readonly jobId: string;
  /** ログインの段の後の、認証つきの Run の指定。 */
  readonly authentication: RunAuthentication;
  /** `START` の定義の一覧（契約で、1〜`MAX_WORKER_READ_CHECKS` 件、秘密に見える名前なし）。 */
  readonly readChecks: readonly WorkerStartReadCheck[];
  readonly launchBrowser: BrowserLauncher;
  readonly clock: () => Date;
  readonly now: () => number;
  /** 止める印（今の定義を終えてから止まる）。 */
  readonly stopSignal: AbortSignal;
  /** 読み込みの間隔を守る部品（省略すると、設定の `crawl.minNavigationIntervalMs` で作る。テストが読み込みの開始の時刻を記録するために渡す）。 */
  readonly navigationPacer?: NavigationPacer | undefined;
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
   * TS-c: 読む前の落ち着きの待ちの指定（候補の画面と READ の画面。省略すると `DISCOVERY_SETTLE_POLICY`）。ワーカーの流れは渡さない。テストが、落ち着かない
   * 画面の場面を短く確かめるために渡す。期限そのものは、落ち着きの待ちの単体テストと発見の probe の結合テストが確かめる。
   */
  readonly settlePolicy?: DiscoverySettlePolicy | undefined;
  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の持ち越し（ワーカーだけが渡す。メモリの中だけ）。発見の流れと同じ使い方
   * （前の段の 1 分の窓から始め、Browser を閉じた後に最新の状態と窓を渡す）。省略すると今のまま。
   */
  readonly stageCarry?: RunStageCarry | undefined;
}

/** 観測の口（ワーカーの流れが IPC に写す）。 */
export interface ReadCheckRunObserver {
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
   * DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断）: 成果物（`read-evidence.json`）を組み立てて書く段に入る（確かめの
   * 後に 1 回。`RUN_FINALIZING`。監査の「Run の終わり」の段と同じ口）。
   */
  readonly onFinalizing?: (() => void) | undefined;
}

/** READ の確かめの流れの結果（Run のディレクトリは絶対パス）。 */
export type ReadCheckRunOutcome =
  | {
    readonly kind: 'RAN';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
    readonly summary: ReadEvidenceSummary;
    /** FM2d: 終わり方（成果物の `endReason`。ワーカーが理由のコードへ写す。IPC には写したコードだけを載せる）。 */
    readonly endReason: ReadCheckEndReason;
  }
  | { readonly kind: 'RUN_ACTIVE'; readonly activeRunId: RunId | null; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  };

/** 確かめた結果（`checks` は `START` の定義の ID から）。 */
interface CheckResult {
  readonly endReason: ReadCheckEndReason;
  readonly checks: ReadonlyMap<string, ReadCheckEvidence>;
  /** 終わり方の詳しい理由（T37a。鍵の消失によるセッションの切れのときだけ）。 */
  readonly endReasonDetail?: SessionKeyLostDetail | null;
  /** DEF-138: セッションの切れで止まったときの証拠（なければ省略か `null`）。 */
  readonly sessionLoss?: SessionLossEvidence | null;
}

/** 止まるべき事象（セッションの切れと違反）つきの、1 つの定義の結果。T37a: セッションの切れの詳しい理由（鍵の消失なら `session-key`）も返す。 */
interface CheckedReadCheck<Evidence extends ReadCheckEvidence> {
  readonly evidence: Evidence;
  readonly sessionLostUrl: string | null;
  readonly sessionLostDetail: SessionKeyLostDetail | null;
  readonly violation: boolean;
  /** DEF-138: セッションの切れの証拠（セッションの切れのときだけ。組み立てられなければ `null`。省略は `null`）。 */
  readonly sessionLoss?: SessionLossEvidence | null;
  /**
   * DEF-136: READ の URL の読み込みが、サイトの不調（読み取りの監査と同じ判定）だったか（省略は偽）。証拠は今までどおり（4xx は `HTTP_ERROR_STATUS`、
   * 時間切れ・接続の失敗は `NAVIGATION_FAILED`）。READ の確かめのジョブだけが、これで確かめ直しと止めるかを決める（書き込みの照合の READ は今のまま）。
   */
  readonly siteUnavailable?: boolean;
}

/**
 * 定義のまとまり（`START` の順に、最初に出た順）。候補の定義は、対象の候補の画面ごと（`CANDIDATES`）。T37d: 画面の path の定義は、1 つずつ（`PAGE`。
 * 1 定義あたり読み込み 1 回）。
 */
type PageGroup =
  | { readonly kind: 'CANDIDATES'; readonly page: CandidateLocation | null; readonly readChecks: readonly WorkerStartReadCheck[] }
  | { readonly kind: 'PAGE'; readonly readCheck: WorkerStartReadCheck };

/** 対象の画面の URL（Origin と path）。 */
const pageUrlOf = (page: CandidateLocation): string => `${page.origin}${page.path}`;

/** 定義を、対象の画面ごとにまとめる（画面の分からない定義は、1 つずつ。T37d: 画面の path の定義も 1 つずつ）。 */
const groupByPage = (readChecks: readonly WorkerStartReadCheck[]): readonly PageGroup[] => {
  const groups: PageGroup[] = [];
  const byUrl = new Map<string, { kind: 'CANDIDATES'; page: CandidateLocation | null; readChecks: WorkerStartReadCheck[] }>();
  for (const readCheck of readChecks) {
    if (readCheck.definition.targetPagePath !== undefined) {
      groups.push({ kind: 'PAGE', readCheck });
      continue;
    }
    if (readCheck.targetPage === null) {
      groups.push({ kind: 'CANDIDATES', page: null, readChecks: [readCheck] });
      continue;
    }
    const url = pageUrlOf(readCheck.targetPage);
    const group = byUrl.get(url);
    if (group === undefined) {
      const created = { kind: 'CANDIDATES' as const, page: readCheck.targetPage, readChecks: [readCheck] };
      byUrl.set(url, created);
      groups.push(created);
    } else {
      group.readChecks.push(readCheck);
    }
  }
  return groups;
};

/**
 * 事前の判定（ファイルの先頭の説明）。読み込みの事前の判定の共通の部品を、どの BLOCK でも止める範囲で呼び、止まれば偽（要求の判定の BLOCK と、
 * セッションの切れの path）。プロファイルの許可 Origin の外も偽。
 */
export const isReadUrlAllowed = (url: string, config: AuditConfig, authentication: RunAuthentication): boolean =>
  !isRunNavigationBlocked(url, new Set(config.site.allowedOrigins), authentication, 'ANY_BLOCK')
  && hasAllowedOrigin(url, new Set(authentication.approvedTestOrigins));

/** 読まずに結果が決まった定義（詳しい理由から結果を決める）。 */
const decidedEvidence = (
  readCheck: WorkerStartReadCheck,
  detail: Exclude<ReadCheckDetail, 'EXPECTATIONS_EVALUATED'>,
  values: {
    readonly url?: string | null;
    readonly httpStatus?: number | null;
    readonly blockedRequests?: number;
    /**
     * DEF-129: READ の URL を読み込んだときの、Guard が通した main frame の文書の要求の数、T37R2-fix で子の frame の文書の要求の数、DEF-130-fix で
     * 文書でない要求の数（読み込まなければ書かない）。
     */
    readonly requestCounts?: PageRequestCounts;
  } = {},
): ReadCheckExecutedEvidence => {
  const result = READ_CHECK_DETAIL_RESULTS[detail];
  if (result === null) {
    throw new RangeError(`the READ check detail ${detail} has no result of its own`);
  }
  return Object.freeze({
    readCheckId: readCheck.readCheckId,
    readCheckRevision: readCheck.readCheckRevision,
    ...readCheckEvidenceTargetOf(readCheck.definition),
    state: 'EXECUTED',
    result,
    detail,
    url: values.url ?? null,
    httpStatus: values.httpStatus ?? null,
    blockedRequests: values.blockedRequests ?? 0,
    structure: null,
    expectations: Object.freeze([]),
    ...values.requestCounts,
  });
};

/** 確かめなかった定義。 */
const notExecutedEvidence = (readCheck: WorkerStartReadCheck, reason: Exclude<ReadCheckEndReason, 'COMPLETED'>): ReadCheckEvidence => Object.freeze({
  readCheckId: readCheck.readCheckId,
  readCheckRevision: readCheck.readCheckRevision,
  ...readCheckEvidenceTargetOf(readCheck.definition),
  state: 'NOT_EXECUTED',
  reason,
});

/** READ の URL の読み込みの、読み取りの結果（DEF-136: `siteUnavailable` はサイトの不調だったか。不調の画面は読まない）。 */
type ResultPageRead =
  | { readonly kind: 'NAVIGATION_FAILED'; readonly siteUnavailable: boolean }
  | { readonly kind: 'HTTP_ERROR'; readonly httpStatus: number; readonly siteUnavailable: boolean }
  | { readonly kind: 'READ'; readonly httpStatus: number | null; readonly structure: ReadStructureOutcome; readonly siteUnavailable: false };

/** 1 つの定義の READ（ファイルの先頭の 3 の c〜f）。止まるべき事象（セッションの切れ、違反）も返す。 */
async function executeReadCheck(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  readCheck: WorkerStartReadCheck,
  confirmation: ReadCandidateConfirmation,
  options: ReadCheckPageVisitOptions,
): Promise<CheckedReadCheck<ReadCheckExecutedEvidence>> {
  const done = (evidence: ReadCheckExecutedEvidence): CheckedReadCheck<ReadCheckExecutedEvidence> =>
    ({ evidence, sessionLostUrl: null, sessionLostDetail: null, violation: false });
  switch (confirmation.kind) {
    case 'UNREADABLE':
      return done(decidedEvidence(readCheck, 'TARGET_PAGE_UNREADABLE'));
    case 'NOT_FOUND':
      return done(decidedEvidence(readCheck, 'CANDIDATE_NOT_FOUND'));
    case 'NOT_READ':
      return done(decidedEvidence(readCheck, 'CANDIDATE_NOT_READ'));
    case 'CONFIRMED':
      break;
  }
  const { action } = confirmation.candidate;
  const built = action === null ? { ok: false as const, detail: 'URL_NOT_BUILT' as const } : buildReadCheckUrl(action, readCheck.definition.parameters);
  if (!built.ok) {
    return done(decidedEvidence(readCheck, built.detail));
  }
  // 保存の後に欄が変わった（見えない・readonly・disabled・ない）なら、読まない（保存の確かめと同じ判定。CCX-10）。URL は記録しない。
  if (unsendableReadCheckParameterNames(confirmation.candidate, readCheck.definition.parameters).length > 0) {
    return done(decidedEvidence(readCheck, 'PARAMETER_NOT_SENDABLE'));
  }
  const { url } = built;
  if (!isReadUrlAllowed(url, options.config, options.authentication)) {
    return done(decidedEvidence(readCheck, 'REQUEST_POLICY', { url }));
  }
  return readAndEvaluate(factory, pacer, readCheck, url, options);
}

/**
 * 画面の path の定義の READ（T37d。Task 37 の設計書 3.5）: 画面の URL を、プロファイルの開始の URL（設定の `site.startUrl`）の Origin と定義の path で
 * 組み立て（契約の `readCheckPageUrlOf`。正規の形の path だけ）、親が入れた対象の画面と同じかを確かめる（違えば読まずに `URL_NOT_BUILT`。fail-closed）。
 * 事前の判定（`isReadUrlAllowed`。止まれば読まずに `REQUEST_POLICY`）の後に、新しい Context で 1 回だけ読み込み、照らす（`readAndEvaluate`）。候補の
 * digest の照合はしない。送る値は持たない。
 */
async function executePageReadCheck(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  readCheck: WorkerStartReadCheck,
  options: ReadCheckPageVisitOptions,
): Promise<CheckedReadCheck<ReadCheckExecutedEvidence>> {
  const done = (evidence: ReadCheckExecutedEvidence): CheckedReadCheck<ReadCheckExecutedEvidence> =>
    ({ evidence, sessionLostUrl: null, sessionLostDetail: null, violation: false });
  const path = readCheck.definition.targetPagePath ?? '';
  const startOrigin = startOriginOf(options.config);
  const url = startOrigin === null ? null : readCheckPageUrlOf(startOrigin, path);
  const { targetPage } = readCheck;
  // 親が入れた対象の画面（Origin と path）が、組み立てた URL と同じ（`pageUrlOf` は Origin と path をつなぐだけ）。
  if (url === null || targetPage === null || pageUrlOf(targetPage) !== url) {
    return done(decidedEvidence(readCheck, 'URL_NOT_BUILT'));
  }
  if (!isReadUrlAllowed(url, options.config, options.authentication)) {
    return done(decidedEvidence(readCheck, 'REQUEST_POLICY', { url }));
  }
  return readAndEvaluate(factory, pacer, readCheck, url, options);
}

/** 設定の開始の URL の Origin（読めなければ null。画面の path の READ が、読む URL を組み立てる Origin）。 */
const startOriginOf = (config: AuditConfig): string | null => {
  try {
    return new URL(config.site.startUrl).origin;
  } catch {
    return null;
  }
};

/** T40b-2: 照合の READ の `{id}` の画面の読む URL（組み立てた URL か、読まずに決めた詳しい理由と、分かれば URL）。 */
export type RecordPageReadTarget =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly detail: Extract<ReadCheckDetail, 'URL_NOT_BUILT' | 'REQUEST_POLICY'>; readonly url: string | null };

const URL_NOT_BUILT_TARGET: RecordPageReadTarget = Object.freeze({ ok: false, detail: 'URL_NOT_BUILT', url: null });

/**
 * T40b-2: API の登録の書き込みの照合の READ の、`{id}` の画面の読む URL を決める（純粋。ファイルの先頭の T40b-2）。定義が `{id}` の型の画面の path でない、
 * ID が使える形でない、開始の URL が分からない、親が入れた対象の画面（Origin と型の path）と開始の URL の Origin・型が合わないなら `URL_NOT_BUILT`。組み立てた
 * 具体的な path が、画面の path の確かめ（`readCheckPagePathRejectionsOf`。保存の時と同じ owner）か事前の判定（`isReadUrlAllowed`）に当たれば
 * `REQUEST_POLICY`（URL つき）。
 */
export const recordPageReadTargetOf = (
  readCheck: WorkerStartReadCheck,
  recordId: string,
  config: AuditConfig,
  authentication: RunAuthentication,
): RecordPageReadTarget => {
  const template = readCheck.definition.targetPagePath;
  const startOrigin = startOriginOf(config);
  const { targetPage } = readCheck;
  // 親が入れた対象の画面（Origin と型の path）が、開始の URL の Origin と定義の型と同じ（`pageUrlOf` は Origin と path をつなぐだけ。画面の path の READ と
  // 同じ比べ方）。
  if (template === undefined || startOrigin === null || targetPage === null || pageUrlOf(targetPage) !== pageUrlOf({ origin: startOrigin, path: template })) {
    return URL_NOT_BUILT_TARGET;
  }
  const url = readCheckPageTemplateUrlOf(startOrigin, template, recordId, isUsableRecordId);
  const path = url === null ? null : readCheckPagePathOfTemplate(template, recordId);
  if (url === null || path === null) {
    return URL_NOT_BUILT_TARGET;
  }
  const context: ReadCheckPageContext = {
    startUrl: config.site.startUrl,
    allowedOrigins: config.site.allowedOrigins,
    approvedTestOrigins: authentication.approvedTestOrigins,
    excludedPathPrefixes: authentication.auditExclusions.excludedPathPrefixes,
    auditPathPrefixes: authentication.auditExclusions.auditPathPrefixes,
    sessionLostPathPrefix: authentication.sessionLostPathPrefix,
  };
  if (readCheckPagePathRejectionsOf(path, context).length > 0 || !isReadUrlAllowed(url, config, authentication)) {
    return Object.freeze({ ok: false, detail: 'REQUEST_POLICY', url });
  }
  return Object.freeze({ ok: true, url });
};

/**
 * T40b-2: API の登録の書き込みの照合の READ（ファイルの先頭の T40b-2）。`{id}` に取った登録の ID を入れた画面を、確かめ直しを通したときだけ、画面の path の READ と
 * 同じ手順（`readAndEvaluate`。新しい Context で 1 回だけ読む。監査の段の状態は `options` で渡す）で読む。通らなければ読まずに決めた証拠。止まるべき事象
 * （セッションの切れ、違反）も返す。例外を投げない（読み込みの部品が投げない）。
 */
export async function verifyRecordPageReadCheck(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  readCheck: WorkerStartReadCheck,
  recordId: string,
  options: ReadCheckPageVisitOptions,
): Promise<CheckedReadCheck<ReadCheckExecutedEvidence>> {
  const target = recordPageReadTargetOf(readCheck, recordId, options.config, options.authentication);
  if (!target.ok) {
    return {
      evidence: decidedEvidence(readCheck, target.detail, { url: target.url }), sessionLostUrl: null, sessionLostDetail: null, violation: false,
    };
  }
  return readAndEvaluate(factory, pacer, readCheck, target.url, options);
}

/**
 * 読む URL を、新しい Context で間隔を守って 1 回読み込み（GET）、HTTP の状態を記録し、落ち着いた後に構造を 1 回の evaluate で読み
 * （`readSettledPageStructure`）、期待と照らす（ファイルの先頭の 3 の f。候補の READ と画面の READ が共有する）。4xx・5xx は照らさずに `UNDETERMINED`。
 * T37d: 読み込みの間に、上限で断ったサービスの Origin への要求か 401（`serviceReadRefused`）、登録した読み取りの手続きの呼び出しを回数の上限か送り方で
 * 止めた、承認したサービスの Origin への読み取りでない要求を止めた、のどれかがあれば、照らした結果に関係なく `UNDETERMINED`
 * （`withReadCheckAuditStageDetail`）。鍵の消失は、読み込みの部品がセッションの切れ（`SESSION_LOST`）にする。
 */
async function readAndEvaluate(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  readCheck: WorkerStartReadCheck,
  url: string,
  options: ReadCheckPageVisitOptions,
): Promise<CheckedReadCheck<ReadCheckExecutedEvidence>> {
  const visit = await visitGuardedPage(factory, pacer, url, options, async ({ page, counter, navigation }): Promise<ResultPageRead> => {
    // DEF-136: サイトの不調かを、読み取りの監査と同じ判定で見分ける（証拠は今までどおり。不調の 4 つの状態は 4xx・5xx か読み込みの失敗）。
    const siteUnavailable = pageLoadVerdictOf(navigation).kind === 'SITE_UNAVAILABLE';
    if (navigation.navigationOutcome !== 'OK') {
      return { kind: 'NAVIGATION_FAILED', siteUnavailable };
    }
    // 4xx・5xx と、600 以上の決まっていない status は照らさない（PRE42-CC 組 R。CC-042）。
    if (navigation.httpStatus !== null && isHttpErrorOrNonStandardStatus(navigation.httpStatus)) {
      return { kind: 'HTTP_ERROR', httpStatus: navigation.httpStatus, siteUnavailable };
    }
    return {
      kind: 'READ', httpStatus: navigation.httpStatus, structure: await readSettledPageStructure(page, counter, options.settlePolicy), siteUnavailable: false,
    };
  });
  switch (visit.kind) {
    case 'NOT_OPENED':
      return { evidence: decidedEvidence(readCheck, 'NAVIGATION_FAILED', { url }), sessionLostUrl: null, sessionLostDetail: null, violation: visit.violation };
    case 'FAILED':
      return {
        evidence: decidedEvidence(readCheck, 'NAVIGATION_FAILED', { url, blockedRequests: visit.blockedRequests }),
        sessionLostUrl: null, sessionLostDetail: null,
        violation: visit.violation,
      };
    case 'SESSION_LOST':
      return {
        evidence: decidedEvidence(readCheck, 'SESSION_LOST', { url, blockedRequests: visit.blockedRequests }),
        sessionLostUrl: visit.url,
        sessionLostDetail: visit.detail,
        violation: visit.violation,
        sessionLoss: visit.sessionLoss,
      };
    case 'VISITED':
      break;
  }
  const read = visit.value;
  const requestCounts = pageRequestCountsOf(visit.pageLoad);
  const common = { url, blockedRequests: visit.blockedRequests, requestCounts };
  if (read.kind === 'NAVIGATION_FAILED') {
    return {
      evidence: decidedEvidence(readCheck, 'NAVIGATION_FAILED', common), sessionLostUrl: null, sessionLostDetail: null, violation: visit.violation,
      siteUnavailable: read.siteUnavailable,
    };
  }
  if (read.kind === 'HTTP_ERROR') {
    return {
      evidence: decidedEvidence(readCheck, 'HTTP_ERROR_STATUS', { ...common, httpStatus: read.httpStatus }),
      sessionLostUrl: null, sessionLostDetail: null,
      violation: visit.violation,
      siteUnavailable: read.siteUnavailable,
    };
  }
  if (read.structure.status !== 'READ') {
    return {
      evidence: decidedEvidence(readCheck, 'RESULT_PAGE_UNREADABLE', { ...common, httpStatus: read.httpStatus }),
      sessionLostUrl: null, sessionLostDetail: null,
      violation: visit.violation,
    };
  }
  // DEF-129: ページが始めた読み込み（main frame か、T37R2-fix で子の frame）を Guard が上限で止めた画面は、落ち着いていない画面として照らす（読んだ
  // 内容が途中のものかもしれない。見つかった文字のほかは `UNDETERMINED`（`PAGE_NOT_SETTLED`））。DEF-130-fix: 文書でない要求を上限で止めた画面も同じ。
  const structure = isPageLoadLimitReached(visit.pageLoad) ? Object.freeze({ ...read.structure.structure, settled: false }) : read.structure.structure;
  const expectations = evaluateReadExpectations(structure, readCheck.definition.expectations);
  const evaluated: ReadCheckExecutedEvidence = Object.freeze({
    readCheckId: readCheck.readCheckId,
    readCheckRevision: readCheck.readCheckRevision,
    ...readCheckEvidenceTargetOf(readCheck.definition),
    state: 'EXECUTED',
    result: readCheckResultOf(expectations),
    detail: 'EXPECTATIONS_EVALUATED',
    url,
    httpStatus: read.httpStatus,
    blockedRequests: visit.blockedRequests,
    structure: readStructureSummaryOf(structure),
    expectations,
    ...requestCounts,
  });
  // T37d: この読み込みの間の監査の段の事実（読み込みの部品が閉じた後に数えた差。画面は 1 つずつ読むので、差はこの定義の読み込みの分）。T37R-fix-B
  // （T37R の M-2）: 数え方は、発見と共有する読み込みの部品の 1 か所（`auditStageObservation`）。
  const detail = visit.auditStageObservation === null ? null : readCheckAuditStageDetailOf(visit.auditStageObservation);
  return {
    evidence: withReadCheckAuditStageDetail(evaluated, detail),
    sessionLostUrl: null, sessionLostDetail: null,
    violation: visit.violation,
  };
}

/**
 * 対象の画面を、新しい Context で 1 回だけ読み、発見の入口で候補を読む（ファイルの先頭の 3 の b。凍結をかけるので、READ の URL は別の Context で
 * 読む）。読み込みか HTTP の状態が失敗なら、候補は null。
 */
const readTargetCandidates = (
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  pageUrl: string,
  options: ReadCheckPageVisitOptions,
): Promise<GuardedPageVisit<TargetCandidates>> => {
  const classificationPolicy = { allowedOrigins: new Set(options.authentication.approvedTestOrigins) };
  return visitGuardedPage(factory, pacer, pageUrl, options, async ({ page, counter, navigation }): Promise<TargetCandidates> => ({
    candidates: navigation.navigationOutcome === 'OK' && !isHttpErrorOrNonStandardStatus(navigation.httpStatus)
      ? await readCandidatePage(page, { classificationPolicy, requestCounter: counter, settlePolicy: options.settlePolicy })
      : null,
    // DEF-136: サイトの不調か（読み取りの監査と同じ判定。不調の画面は読まない）。
    siteUnavailable: pageLoadVerdictOf(navigation).kind === 'SITE_UNAVAILABLE',
  }));
};

/** 対象の画面の候補の読み取り（読めなければ候補は null。DEF-136: サイトの不調だったか）。 */
interface TargetCandidates {
  readonly candidates: ReadCandidatePage | null;
  readonly siteUnavailable: boolean;
}

/**
 * 対象の画面の候補（読めなければ null）。T37a: その画面の Context で上限で断った要求か 401 があれば、読み切れていない（候補が見つからなくても、
 * 消えたと言わない。判定は発見の owner の `readInFullAfterServiceRefusal`）。T37R-fix-B（T37R の M-2）: 描けなかった画面かは、発見と共有する
 * `isAuditStageReadObstructed`（止めた登録した手続きの呼び出しなども数える）。
 */
const candidatePageOf = (visit: GuardedPageVisit<TargetCandidates>): ReadCandidatePage | null => {
  const candidates = visit.kind === 'VISITED' ? visit.value.candidates : null;
  if (visit.kind !== 'VISITED' || candidates === null) {
    return null;
  }
  // DEF-129: ページが始めた読み込み（main frame か子の frame）を上限で止めた画面も、読み切れていない（判定は発見の owner の理由の一覧）。DEF-130-fix:
  // 文書でない要求を上限で止めた画面も同じ。
  const reliable = readInFullAfterIncompleteReasons(readInFullAfterServiceRefusal(candidates.reliable, isAuditStageReadObstructed(visit.auditStageObservation)),
    pageLoadIncompleteReasonsOf(visit.pageLoad));
  return reliable === candidates.reliable ? candidates : Object.freeze({ ...candidates, reliable });
};

/** DEF-136: 対象の画面の候補の読み込みが、サイトの不調だったか（違反のある読み込みは、違反の扱いを先にする）。 */
const candidateVisitUnavailable = (visit: GuardedPageVisit<TargetCandidates>): boolean =>
  visit.kind === 'VISITED' && visit.value.siteUnavailable && !visit.violation;

/** DEF-136: 1 つの定義の READ の読み込みが、サイトの不調だったか（違反とセッションの切れは、それぞれの扱いを先にする）。 */
const checkedUnavailable = (checked: CheckedReadCheck<ReadCheckEvidence>): boolean =>
  checked.siteUnavailable === true && !checked.violation && checked.sessionLostUrl === null;

/**
 * 1 つの定義の READ の確かめ（T30f。書き込みのジョブの照合の READ が使う。READ の確かめのジョブの 1 画面 1 定義と同じ手順）: 対象の画面の
 * 事前の判定 → 対象の画面の候補の読み取り（`readTargetCandidates`）→ 候補の確かめ → READ（`executeReadCheck`）。止まるべき事象（セッションの切れ、
 * 違反）も返す。例外を投げない（読み込みの部品が投げない）。
 */
export async function verifyReadCheck(
  factory: BrowserContextFactory,
  pacer: NavigationPacer,
  readCheck: WorkerStartReadCheck,
  options: ReadCheckPageVisitOptions,
): Promise<CheckedReadCheck<ReadCheckEvidence>> {
  // T37d（設計者の判断 5）: 書き込みの照合の READ に、画面の path の定義は使わない（親と IPC の契約も拒む。ここでも読まずに止める。fail-closed）。
  if (readCheck.definition.targetIdentityDigest === undefined) {
    return { evidence: decidedEvidence(readCheck, 'REQUEST_POLICY'), sessionLostUrl: null, sessionLostDetail: null, violation: false };
  }
  if (readCheck.targetPage === null) {
    return { evidence: decidedEvidence(readCheck, 'TARGET_PAGE_UNKNOWN'), sessionLostUrl: null, sessionLostDetail: null, violation: false };
  }
  const pageUrl = pageUrlOf(readCheck.targetPage);
  if (!isReadUrlAllowed(pageUrl, options.config, options.authentication)) {
    return { evidence: decidedEvidence(readCheck, 'REQUEST_POLICY'), sessionLostUrl: null, sessionLostDetail: null, violation: false };
  }
  const visit = await readTargetCandidates(factory, pacer, pageUrl, options);
  if (visit.violation) {
    return { evidence: decidedEvidence(readCheck, 'TARGET_PAGE_UNREADABLE'), sessionLostUrl: null, sessionLostDetail: null, violation: true };
  }
  if (visit.kind === 'SESSION_LOST') {
    return {
      evidence: decidedEvidence(readCheck, 'SESSION_LOST'), sessionLostUrl: visit.url, sessionLostDetail: visit.detail, violation: false, sessionLoss: visit.sessionLoss,
    };
  }
  const candidatePage = candidatePageOf(visit);
  const { targetIdentityDigest } = readCheck.definition;
  const confirmation: ReadCandidateConfirmation = candidatePage === null
    ? { kind: 'UNREADABLE' }
    : confirmReadTargetOnPage(candidatePage, targetIdentityDigest);
  return executeReadCheck(factory, pacer, readCheck, confirmation, options);
}

/** 確かめる（ファイルの先頭の 2〜4）。 */
async function check(
  request: ReadCheckRunRequest,
  outputDirectory: string,
  observer: ReadCheckRunObserver,
  jobAuditStage: JobAuditStage,
  onSafetyViolation: (violation: JobSafetyViolation) => void,
): Promise<CheckResult> {
  const { config, authentication, stopSignal, now } = request;
  const checks = new Map<string, ReadCheckEvidence>();
  const markRest = (reason: Exclude<ReadCheckEndReason, 'COMPLETED'>): void => {
    for (const readCheck of request.readChecks) {
      if (!checks.has(readCheck.readCheckId)) {
        checks.set(readCheck.readCheckId, notExecutedEvidence(readCheck, reason));
      }
    }
  };
  // DEF-100 fix: pacer は PREFLIGHT の前に作り、factory にも渡す（Guard が main frame の文書の要求を送った時刻を記録する）。
  const sleep = request.sleep ?? wait;
  // FM2R の C-1: 上げた最小の間隔を覚える（まとめて実行の持ち越しの形を、どの段でも同じにする）。
  const intervalTracking = intervalTrackingNavigationPacer(
    request.navigationPacer ?? createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now, sleep }),
    config.crawl.minNavigationIntervalMs,
  );
  const intervalPacer = intervalTracking.pacer;
  const navigationCarry = (): Parameters<typeof recordRunStageCarry>[3] => ({ pacer: intervalPacer, minIntervalMs: intervalTracking.minIntervalMs(), now });
  // T35R2-fix（T35R2 の C-1）: 監査の段の口があれば、Run と同じ部品で作った上限の部品も渡す。T37a: 作った状態（呼ぶ側が作る）で 1 つの定義ごとに上限と
  // 鍵の消失を確かめる。
  const { factoryOptions, state: auditStage } = jobAuditStage;
  // DEF-141: 監査の段の口があれば、承認したサービスの Origin への要求の 1 分あたりの上限で、次の読み込みの前に待つ（Run Coordinator と共用する部品。
  // 待つたびに知らせる）。口がなければ、今の pacer のまま。
  const pacer = serviceRequestPacedNavigationPacer(intervalPacer, auditStage, sleep, (notice) => observer.onNotice?.(notice));
  const preflight = await runPreflight({
    config,
    launchBrowser: request.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    outputDirectory,
    // AS-b: 監査の段の送信の扱いが `PASS_EXCEPT_DELETE` のときだけ、口を渡す（承認したサービスの Origin はプロファイルのもの）。
    contextFactoryOptions: { ...factoryOptions, ...auditSendOptionsOf(config, request.authentication.approvedTestOrigins), navigationPacer: pacer },
  });
  if (!preflight.ok) {
    // FM2d: factory がないので、状態は持ち越さない。
    recordRunStageCarry(request.stageCarry, null, auditStage, navigationCarry());
    markRest('PREFLIGHT_FAILED');
    return { endReason: 'PREFLIGHT_FAILED', checks };
  }
  const { browser, factory } = preflight;
  try {
    const options: ReadCheckPageVisitOptions = {
      config,
      allowedQueryParameters: new Set(config.crawl.allowedQueryParameters),
      authentication,
      auditStage,
      // DEF-144: 画面の Context に違反があれば、その中身を受ける（成果物と IPC の要約に残す）。
      onSafetyViolation,
      // TS-c: 落ち着きの待ちの指定（テストだけが渡す。省略は本番の指定）。
      settlePolicy: request.settlePolicy,
    };
    const startedAtMs = now();
    // DEF-136: サイトの不調の確かめ直し（読み取りの監査の最初の待ちだけ待って 1 回。通ったら読み込みの間隔を 2 倍。知らせの URL は伏せ字を通す）。
    const siteRecheck = createJobSiteRecheck({
      delayMs: request.siteUnavailableRecheckDelayMs ?? JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS,
      stopSignal,
      pacer,
      configuredMinIntervalMs: config.crawl.minNavigationIntervalMs,
      onNotice: (notice) => observer.onNotice?.(notice.kind === 'SITE_UNAVAILABLE_RECHECK' ? { ...notice, url: redactUrlSecrets(notice.url) } : notice),
    });
    /** DEF-136: 確かめ直しの結果が止めるものなら、その理由（待つ間の止める印は `STOPPED`、不調が続けば `SITE_UNAVAILABLE`）。止めなければ null。 */
    const siteStopOf = (kind: JobSiteVisit<unknown>['kind']): Extract<ReadCheckEndReason, 'STOPPED' | 'SITE_UNAVAILABLE'> | null =>
      (kind === 'DONE' ? null : kind);
    /** T37a: 上限に届いたか（Run Coordinator と同じ判定）。届いていれば理由。 */
    const limitReason = (): Extract<ReadCheckEndReason, 'SERVICE_REQUEST_LIMIT_REACHED'> | null =>
      (isServiceRequestLimitReached(auditStage) ? 'SERVICE_REQUEST_LIMIT_REACHED' : null);
    /** 止まる理由（T37a の上限・止める要求・時間の上限の順）。止まらなければ null。 */
    const stopReason = (): Extract<ReadCheckEndReason, 'STOPPED' | 'MAX_RUNTIME_REACHED' | 'SERVICE_REQUEST_LIMIT_REACHED'> | null => {
      const limited = limitReason();
      if (limited !== null) {
        return limited;
      }
      if (stopSignal.aborted) {
        return 'STOPPED';
      }
      return now() - startedAtMs >= config.crawl.maxRuntimeMs ? 'MAX_RUNTIME_REACHED' : null;
    };
    for (const group of groupByPage(request.readChecks)) {
      const stopped = stopReason();
      if (stopped !== null) {
        markRest(stopped);
        return { endReason: stopped, checks };
      }
      if (group.kind === 'PAGE') {
        // T37d: 画面の path の定義は、1 定義あたり読み込み 1 回（候補の画面の読み込みはしない）。DEF-136: 不調なら 1 回だけ確かめ直す。
        const { targetPage } = group.readCheck;
        const rechecked = await siteRecheck.visit(targetPage === null ? '' : pageUrlOf(targetPage),
          () => executePageReadCheck(factory, pacer, group.readCheck, options), checkedUnavailable);
        const siteStop = siteStopOf(rechecked.kind);
        if (siteStop !== null) {
          markRest(siteStop);
          return { endReason: siteStop, checks };
        }
        const executed = rechecked.value;
        checks.set(group.readCheck.readCheckId, executed.evidence);
        if (executed.violation) {
          markRest('SAFETY_VIOLATION');
          return { endReason: 'SAFETY_VIOLATION', checks };
        }
        if (executed.sessionLostUrl !== null) {
          const sessionLoss = executed.sessionLoss ?? null;
          observer.onSessionLost(redactUrlSecrets(executed.sessionLostUrl), sessionLoss);
          markRest('AUTH_SESSION_LOST');
          return { endReason: 'AUTH_SESSION_LOST', checks, endReasonDetail: executed.sessionLostDetail, sessionLoss };
        }
        continue;
      }
      if (group.page === null) {
        for (const readCheck of group.readChecks) {
          checks.set(readCheck.readCheckId, decidedEvidence(readCheck, 'TARGET_PAGE_UNKNOWN'));
        }
        continue;
      }
      const pageUrl = pageUrlOf(group.page);
      if (!isReadUrlAllowed(pageUrl, config, authentication)) {
        for (const readCheck of group.readChecks) {
          checks.set(readCheck.readCheckId, decidedEvidence(readCheck, 'REQUEST_POLICY'));
        }
        continue;
      }
      // 対象の画面の候補を、新しい Context で 1 回だけ読む（凍結をかけるので、READ の URL は別の Context で読む）。DEF-136: 不調なら 1 回だけ確かめ直す。
      const candidateRechecked = await siteRecheck.visit(pageUrl, () => readTargetCandidates(factory, pacer, pageUrl, options), candidateVisitUnavailable);
      const candidateSiteStop = siteStopOf(candidateRechecked.kind);
      if (candidateSiteStop !== null) {
        markRest(candidateSiteStop);
        return { endReason: candidateSiteStop, checks };
      }
      const candidateVisit = candidateRechecked.value;
      if (candidateVisit.violation) {
        markRest('SAFETY_VIOLATION');
        return { endReason: 'SAFETY_VIOLATION', checks };
      }
      if (candidateVisit.kind === 'SESSION_LOST') {
        observer.onSessionLost(redactUrlSecrets(candidateVisit.url), candidateVisit.sessionLoss);
        markRest('AUTH_SESSION_LOST');
        return { endReason: 'AUTH_SESSION_LOST', checks, endReasonDetail: candidateVisit.detail, sessionLoss: candidateVisit.sessionLoss };
      }
      const candidatePage: ReadCandidatePage | null = candidatePageOf(candidateVisit);
      for (const [index, readCheck] of group.readChecks.entries()) {
        // 同じ画面の 2 つ目からの定義の前にも、止める要求と時間の上限を確かめる（今の定義を終えてから止まる）。T37a: 上限は、対象の画面の読み込みの
        // 後の 1 つ目の定義の前にも確かめる（1 つの定義ごと）。
        const stoppedBetween = index === 0 ? limitReason() : stopReason();
        if (stoppedBetween !== null) {
          markRest(stoppedBetween);
          return { endReason: stoppedBetween, checks };
        }
        // 候補の定義のまとまり（画面の path の定義は、上で 1 つずつ確かめた）。
        const confirmation: ReadCandidateConfirmation = candidatePage === null
          ? { kind: 'UNREADABLE' }
          : confirmReadTargetOnPage(candidatePage, readCheck.definition.targetIdentityDigest ?? '');
        // DEF-136: READ の URL の読み込みが不調なら、1 回だけ確かめ直す（知らせの URL は対象の画面）。
        const rechecked = await siteRecheck.visit(pageUrl, () => executeReadCheck(factory, pacer, readCheck, confirmation, options), checkedUnavailable);
        const siteStop = siteStopOf(rechecked.kind);
        if (siteStop !== null) {
          markRest(siteStop);
          return { endReason: siteStop, checks };
        }
        const executed = rechecked.value;
        checks.set(readCheck.readCheckId, executed.evidence);
        if (executed.violation) {
          markRest('SAFETY_VIOLATION');
          return { endReason: 'SAFETY_VIOLATION', checks };
        }
        if (executed.sessionLostUrl !== null) {
          const sessionLoss = executed.sessionLoss ?? null;
          observer.onSessionLost(redactUrlSecrets(executed.sessionLostUrl), sessionLoss);
          markRest('AUTH_SESSION_LOST');
          return { endReason: 'AUTH_SESSION_LOST', checks, endReasonDetail: executed.sessionLostDetail, sessionLoss };
        }
      }
    }
    return { endReason: 'COMPLETED', checks };
  } finally {
    await closeBrowserBeforeDeadline(browser);
    // FM2d: Browser を閉じた後に、factory の最新の状態と窓を持ち越しの口へ渡す（メモリの中だけ）。
    recordRunStageCarry(request.stageCarry, factory, auditStage, navigationCarry());
  }
}

/**
 * READ の確かめのジョブを実行する（流れはファイルの先頭）。Run の外の失敗（成果物を書けない `ArtifactWriteError`、予期しない例外）は、そのまま
 * reject する（ワーカーの流れが `classifyCliFailure` で `FAILED` にする）。
 */
export async function executeReadCheckRun(request: ReadCheckRunRequest, observer: ReadCheckRunObserver): Promise<ReadCheckRunOutcome> {
  const outputDirectory = resolve(request.config.output.directory);
  const writer = new ArtifactWriter({ urlSecretRedaction: true });
  const run = await startWorkerRun(writer, outputDirectory, request.clock, request.now);
  if (run.kind !== 'STARTED') {
    return run;
  }
  const { runId, runDirectory, startedAt } = run;
  observer.onRunStarted({ runId, runDirectory });
  try {
    // T37a: 監査の段の状態は、ここで作って確かめの流れに渡す（ブラウザを閉じた後に、成果物に数を書くため）。登録した読み取りの手続きの呼び出しを通す。
    // FM2d: まとめて実行の段なら、前の段の 1 分の窓から始める。
    const jobAuditStage = jobContextFactoryOptions(request.authentication, request.now, 'REGISTERED', request.stageCarry?.serviceRequestWindowMs ?? []);
    // DEF-144: 止まるきっかけの違反の中身（最初の 1 件）。
    const violations: { first: JobSafetyViolation | null } = { first: null };
    const checked = await check(request, outputDirectory, observer, jobAuditStage, (violation) => {
      violations.first ??= violation;
    });
    // DEF-143: ここから成果物を組み立てて書く段。入る前に 1 回だけ知らせる。
    observer.onFinalizing?.();
    const checks =request.readChecks.flatMap(({ readCheckId }) => {
      const evidence = checked.checks.get(readCheckId);
      return evidence === undefined ? [] : [evidence];
    });
    const base = { endReason: checked.endReason, checks };
    const { state } = jobAuditStage;
    const document: ReadEvidenceDocument = {
      schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
      jobId: request.jobId,
      runId,
      startedAt: formatCompactUtcTimestamp(startedAt, READ_CHECK_TIME_SUBJECT),
      finishedAt: formatCompactUtcTimestamp(request.clock(), READ_CHECK_TIME_SUBJECT),
      runStatus: readEvidenceRunStatusOf(base),
      ...base,
      ...(checked.endReasonDetail === undefined || checked.endReasonDetail === null ? {} : { endReasonDetail: checked.endReasonDetail }),
      ...(state === null ? {} : { authentication: runAuthenticationSummaryOf(state) }),
      // DEF-138: セッションの切れで止まったときの証拠（組み立てられたときだけ）。
      ...(checked.sessionLoss === undefined || checked.sessionLoss === null ? {} : { sessionLoss: checked.sessionLoss }),
      // AS-b: 実効の監査の段の送信の扱い（どの扱いで確かめた結果か）。
      auditSendPolicy: auditSendPolicyOf(request.config),
      // DEF-144: 違反で止まったときだけ、違反の中身（種類・段・画面の path。値を持たない）。
      ...(checked.endReason === 'SAFETY_VIOLATION' && violations.first !== null ? { safetyViolation: violations.first } : {}),
    };
    await writer.writeReadEvidence(runDirectory, document);
    return {
      kind: 'RAN',
      runId,
      runDirectory,
      runStatus: document.runStatus,
      exitCode: EXIT_CODES[document.runStatus],
      summary: readEvidenceSummaryOf(document),
      endReason: document.endReason,
    };
  } finally {
    // 保存の状態は書かない（再開の対象にしない）。ハートビートを止めてから、Run のロックを消す。
    await endWorkerRun(writer, run);
  }
}

/**
 * 発見のジョブ（`DISCOVERY`）の流れ（Task 27 の設計書 3 章、4.2、4.4、4.6 と、変更履歴の「T27b・T27c の報告と T27d の前の判断」「Blocker: T27d」の
 * 行。T27d）。ワーカーの流れ（`audit-worker-session.ts`）が、ログインの段の後に、認証の指定（`RunAuthentication`）を付けて呼ぶ。今の監査の流れ
 * （`page-auditor.ts`、Run Coordinator）には手を入れない（公開監査と認証つきの監査の出力を変えないため）。
 *
 * 1. 出力先の監査中の印（監査と同じ。CLI の監査から、動いている Run として見える）:
 *    - 印を、CLI の監査と同じ部品（`src/core/run-exclusion.ts`。SPEC-2）で取る。ほかの起動が持っていれば `RUN_ACTIVE`。
 *    - Run の ID は今の決まり（`createRunIdFromTime`）。Run のディレクトリを排他的に作り（`createRunArtifactDirectory`）、作れなければ
 *      `RUN_DIRECTORY_UNAVAILABLE`。保存の状態は書かない（再開の対象にしない）。終わりに、ロックを離す。
 * 2. Run の前の確認（`runPreflight`。認証の指定を付けた factory）。失敗したら、画面を読まずに `PREFLIGHT_FAILED`。
 * 3. 巡回（今の監査の巡回の部品を使う。同じ意味の巡回を書き写さない）: 開始の URL（`normalizeUrl`）から、`CrawlFrontier`（深さの上限と BFS）、
 *    リンクの抽出の唯一の入口 `discoverLinks`（受け入れの判定 `classifyUrl`。許可 Origin は設定の `site.allowedOrigins`）、認証つきの Run の
 *    巡回の候補の除外 `isExcludedCrawlCandidate`（認証の設定の読まないパス・読む範囲・既定の危険な語と、セッションの切れの path）、読み込みの
 *    間隔 `createNavigationPacer`（`crawl.minNavigationIntervalMs`）。上限は `crawl.maxPages`（読んだ画面の数）と `crawl.maxRuntimeMs`。
 *    OP-I（I2）: 読む順だけ、登録の画面らしいリンク（`isCreatePageLink`）を先にする（`CrawlFrontier` の `preferred`。点検の段の順は変えない）。
 *    OP-J（J1。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.6）: まとめて実行の連鎖で、直前の点検の段の Run のディレクトリ
 *    （`chainedAuditRunDirectory`）を渡されたときは、その段の成果物（各ページの `page.json` の Desktop の `link` の Evidence。点検の段が見つけたリンクの
 *    持ち主は 1 つ）から、登録の画面らしいリンク（`isCreatePageLink`）を、先に読む（COV-2: 数の上限なし）。
 *    続けて、今どおり入口から読む（登録の画面の数は、ページの上限に数えない。すでに読んだページは読み直さない）。読まないパス・危険な語・読む範囲・許可 Origin は、巡回の候補の除外と
 *    同じ判定（`isExcludedCrawlCandidate`）で外し、間隔・時間の上限・Guard は今のまま。読む先が 1 つもなければ、今どおり（入口から、ページの上限まで）。
 *    OP-R（設計書 4.1.9 の R2）: 登録の画面ごとに、その 1 つ上の一覧の画面（`readListPagePathOf`）も、点検の段のリンクにあるときだけ、登録の画面の直後に読む。
 *    点検の段の成果物のリンクの読み方は、共通の部品
 *    （`src/core/audit-stage-links.ts` の `readAuditStageLinks`。画面のサーバの自動の下書きも使う）。
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
 * - 承認したサービスの Origin への要求は数えるだけ（LZ-3c: 上限に届いて残りの画面を読まずに終える分岐は、L11 から届かないので捨てた。終わり方
 *   `SERVICE_REQUEST_LIMIT_REACHED` は前の記録のために残る）。
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
 * DEF-221（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.2）: probe の押下で同じ文書のまま変わった URL（SPA の移った先）は、
 * 条件（`spaRoutePageOf`）に当たれば、見つけたページとして待ち行列に入れ、ページの上限と読み込みの間隔の中で直に GET で読む。読めなかった画面（4xx など）は、
 * 今の読まなかった理由（`HTTP_ERROR_STATUS` など）で記録する。
 * COV-2c（SREV-COV の指摘の直し。網羅の設計書）: 押す輪・読み込み直し・作り直しの中でも、利用者の停止と Run の時間の上限を見る（押す輪を途中で終えた画面の後は、
 * 次の画面を読まずに止める）。押下から生まれた辺（SPA の経路・文書の移り先）は、値に目印を含む query の値を場所の鍵と記録で伏せ、押下の並びを持たせる。再開の後、
 * 伏せた値で URL の分からない押下の移り先は、元の画面を読み直して押下の並びを押し直して作り直す（作り直せなければ、その状態だけを読まなかった画面にする）。
 * COV-2c（SREV-COV の C-1）: 押下から生まれた画面（文書の移動・popup・SPA の辺・開き手の移り先）は、元の画面を読み込んで凍結し、凍結を解かずにその画面を読み込む
 * （`BrowserContextFactory.loadFrozenDocument`。Guard が、その行き先への main frame の GET だけを凍結の読み取りと同じ判定で通す）。移り先の画面の読み取りでない
 * 送信は、読み込みの最初から凍結の決まりで止める。サイトへの負荷: 押下から生まれた画面ごとに、元の画面の読み込みが 1 回増える（読み込みの間隔は今どおり守る）。
 * DEF-236: 待ち行列が空になる最後の画面の後は、読み込みの間隔を見せたまま待たない（`pacingWaitBeforeClose: false`）。
 */
import { basename, resolve } from 'node:path';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { EXIT_CODES, RUN_UNAVAILABLE_EXIT_CODE } from '../cli/exit-codes.js';
import type { AuditConfig } from '../config/types.js';
import { auditSendPolicyOf } from '../core/audit-send-policy.js';
import type { RunId, RunProgressReport, RunStatus, SessionLostDetail } from '../core/contracts.js';
import { deepFreeze } from '../core/immutable.js';
import { observationWindowsOrProduction, type ObservationWindows } from '../core/observation-windows.js';
import { acquireRunExclusion } from '../core/run-exclusion.js';
import { wait } from '../core/deadline.js';
import type { NormalizedHttpUrlEvidence, SessionLossEvidence } from '../core/evidence-types.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { discoverLinks } from '../crawl/discover-links.js';
import { destructiveLinkTextUrlsOf, internalNavigableUrlsOf } from '../crawl/internal-navigable-links.js';
import { createLoadMeter } from '../crawl/load-meter.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import { isOriginInAllowedOrigins, normalizeUrl } from '../crawl/normalize-url.js';
import { readAuditStageLinks } from '../core/audit-stage-links.js';
import { isCreatePageLink } from '../discovery/classify.js';
import {
  CoverageQueue,
  markerCarryingQueryNamesOf,
  unfrozenLoadRefusalOf,
  type CoverageEdgeInput,
  type CoverageFrozenPath,
  type CoverageQueueItem,
  type CoverageQueueSnapshot,
} from '../discovery/coverage-queue.js';
import { stateLocationKeyOf } from '../discovery/state-keys.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { readListPagePathOf } from '../discovery/read-check-contracts.js';
import { PATH_TEMPLATE_ID_SEGMENT, isUsableRecordId } from '../core/record-id-path-pattern.js';
import { discoverPageCandidates, settleAndFreezePage, type SettledFreezeOutcome } from '../discovery/discover-page.js';
import { openReadDeadline } from '../orchestration/stage-deadline.js';
import type { DiscoveryCandidate } from '../discovery/candidate-contracts.js';
import { locationOfUrl } from '../discovery/probe.js';
import { trackOnScreen, watchDiscoveryScreen } from '../discovery/screen-watch.js';
import { discoverySettlePolicyOf, type DiscoverySettlePolicy } from '../discovery/settle.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  discoveryRunStatusOf,
  discoverySummaryOf,
  externalSchemeProbesOf,
  pageLoadIncompleteReasonsOf,
  NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON,
  withIncompleteReason,
  withServiceReadRefused,
  type DiscoveryDocument,
  type DiscoveryEndReason,
  type DiscoveryFrozenReadCounts,
  type DiscoveryPageEntry,
  type DiscoveryReadPageRecord,
  type DiscoverySummary,
  type DiscoveryUnreadReason,
} from '../discovery/discovery-result.js';
import {
  isAuditStageReadObstructed,
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
import { settleAndDismissNotificationFrames } from '../interaction/notification-overlay.js';
import { notificationPressNavigationsOf } from '../safety/passive-request-guard.js';
import {
  pageStateStructureKeyOf,
  probeDiscoveredSubmissions,
  replaySubmissionProbeMove,
  type SubmissionProbeMoveFacts,
  type SubmissionProbeOpenerMoveFacts,
  type SubmissionProbeMovedPage,
  type SubmissionProbeOptions,
  type SubmissionProbeReplayedMove,
  type SubmissionProbeReplayStep,
} from '../interaction/submission-probe.js';
import { IdAllocator, type IdAllocatorSnapshot } from '../orchestration/id-allocator.js';
import type { BrowserLauncher, BrowserLease } from '../orchestration/preflight.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import type { PageLoadFacts } from '../safety/passive-request-guard.js';
import {
  CONTEXT_CLOSED_BY_GUARD_PROBE_REASON as CONTEXT_CLOSED_BY_GUARD_REASON,
  externalSchemeSubmissionProbeOf,
  notObservedSubmissionProbeOf,
  withSubmissionProbes,
} from '../discovery/submission-probe-contracts.js';
import { probeRecordContinuationOf, type JobSafetyViolation, type ProbeViolationContinuation } from '../safety/job-safety-violation.js';
import { redactUrlSecrets } from '../safety/redact.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import {
  JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS, createJobSiteRecheck, pageLoadVerdictOf, type JobRunNotice, type PageLoadVerdict,
} from './job-site-availability.js';
import { playwrightStagePortsOf, type StagePorts, type StageSession } from './stage-ports.js';
import { endWorkerRun, hasViolation, startWorkerRun, visitGuardedPage, type WorkerRunStart } from './worker-run-session.js';
import { navigatePage } from '../orchestration/page-navigation.js';
import { dateOfCompactUtcTimestamp } from '../core/utc-timestamp.js';


/** 日時の名前（誤りの文に使う）。 */
const DISCOVERY_TIME_SUBJECT = 'discovery run time';

// COV-2（L7 の N37）: 点検の段が見つけた登録の画面らしいリンクの先読みの数（前は 10）と、押下で移った先の編集の画面を読む数（前は 3。同じ型は 1 回）の
// 上限は撤廃した（全部を待ち行列に入れる。読み込みの間隔は `crawl.minNavigationIntervalMs` のまま）。定数は LZ-1 で消した。

/** DEF-190: 移った先の編集の画面（読む URL と、番号を `{id}` にした同じ型の鍵）。 */
export interface OpenedEditPage {
  readonly url: NormalizedHttpUrlEvidence;
  readonly templatePath: string;
}

/**
 * DEF-190（設計書 5.8 の 1）: 押した画面の URL と、開き手の押下で移った先の URL から、読む編集の画面を返す（当たらなければ `null`）。条件はすべて:
 * 正規化できる（`normalizeUrl`。許す query の名前は設定のもの）、押した画面と同じ Origin、許可 Origin の中で巡回の候補の除外（`isExcludedCrawlCandidate`。
 * 読まないパス・危険な語・読む範囲・セッションの切れの path）に当たらない、path が押した画面の path の 1 つ下で、最後の区切りが使える番号（`isUsableRecordId`）。
 */
export function openedEditPageOf(
  pressedPageUrl: string,
  movedUrl: string,
  options: MovedPageOptions,
): OpenedEditPage | null {
  const readable = readableMovedPageOf(pressedPageUrl, movedUrl, options);
  if (readable === null) {
    return null;
  }
  const { pressed, moved } = readable;
  const parent = pressed.pathname.replace(/\/+$/u, '');
  const prefix = `${parent}/`;
  if (!moved.pathname.startsWith(prefix)) {
    return null;
  }
  const last = moved.pathname.slice(prefix.length);
  if (last.includes('/') || !isUsableRecordId(last)) {
    return null;
  }
  return { url: readable.url, templatePath: `${prefix}${PATH_TEMPLATE_ID_SEGMENT}` };
}

/** DEF-190・DEF-221: 押下で移った先を読む画面にするかの判定の入力（設定の許す query の名前、許可 Origin、認証の設定の除外）。 */
export interface MovedPageOptions {
  readonly allowedQueryParameters: ReadonlySet<string>;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly authentication: Pick<RunAuthentication, 'auditExclusions' | 'sessionLostPathPrefix'>;
}

/**
 * DEF-190・DEF-221: 押下で移った先の URL が、読んでよい画面か（`openedEditPageOf` と `spaRoutePageOf` が共用する 1 か所の条件）。条件はすべて: 正規化できる
 * （`normalizeUrl`。資格情報を含む URL は正規化できない。許す query の名前は設定のもの。fragment は落ちる）、押した画面と同じ Origin、許可 Origin の中で
 * 巡回の候補の除外（`isExcludedCrawlCandidate`。読まないパス・危険な語・読む範囲・セッションの切れの path）に当たらない。当たらなければ `null`。
 */
function readableMovedPageOf(
  pressedPageUrl: string,
  movedUrl: string,
  options: MovedPageOptions,
): { readonly url: NormalizedHttpUrlEvidence; readonly pressed: URL; readonly moved: URL } | null {
  const normalized = normalizeUrl(movedUrl, movedUrl, options.allowedQueryParameters);
  if (!normalized.ok) {
    return null;
  }
  let pressed: URL;
  let moved: URL;
  try {
    pressed = new URL(pressedPageUrl);
    moved = new URL(normalized.url);
  } catch {
    return null;
  }
  // 同じ Origin の比べ方は、許可 Origin の判定の持ち主（`isOriginInAllowedOrigins`）を使う。
  if (!isOriginInAllowedOrigins([pressed.origin], moved.origin) || !isOriginInAllowedOrigins(options.allowedOrigins, moved.origin)
    || isExcludedCrawlCandidate(normalized.url, options.allowedOrigins, options.authentication)) {
    return null;
  }
  return { url: normalized.url, pressed, moved };
}

/**
 * DEF-221（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.2 の 1）: 押下で同じ文書のまま変わった URL（`pushState`・`replaceState`・
 * ハッシュ）から、読む画面の URL を返す（当たらなければ `null`）。条件は `readableMovedPageOf` の共通の条件に、承認したテストの Origin の中
 * （`approvedTestOrigins`）と、押した画面と同じ正規化の URL でない（fragment だけの変化などは読み直さない）を足したもの。DEF-190 の狭い条件（開き手の語、
 * 1 つ下の番号の path）は当てない。
 */
export function spaRoutePageOf(
  pressedPageUrl: NormalizedHttpUrlEvidence,
  movedUrl: string,
  options: MovedPageOptions & { readonly approvedTestOrigins: ReadonlySet<string> },
): NormalizedHttpUrlEvidence | null {
  const readable = readableMovedPageOf(pressedPageUrl, movedUrl, options);
  if (readable === null || readable.url === pressedPageUrl || !isOriginInAllowedOrigins(options.approvedTestOrigins, readable.moved.origin)) {
    return null;
  }
  return readable.url;
}

/**
 * COV-2b（網羅の設計書 3.2 の 1）: 押下で文書が替わった GET の移り先が、読んでよい画面か（条件は `readableMovedPageOf` の 1 か所: 正規化できる、押した画面と同じ
 * Origin、許可 Origin の中で巡回の候補の除外に当たらない）。当たれば、移り先の URL（query の名前と値をそのまま持つ。場所の鍵の正規化は待ち行列が行う）を返す。
 */
export function movedPageOf(pressedPageUrl: string, movedUrl: string, options: MovedPageOptions): string | null {
  return readableMovedPageOf(pressedPageUrl, movedUrl, options) === null ? null : movedUrl;
}

/** 発見の流れの入力。秘密（認証の状態）はメモリの認証の指定の中だけ。 */
export interface DiscoveryRunRequest {
  /** ワーカーが読んだ設定（`WORKER_CONFIG_OVERRIDES` の headless）。 */
  readonly config: AuditConfig;
  /** 発見のジョブの ID（成果物に書き、親が照らし合わせる）。 */
  readonly jobId: string;
  /** ログインの段の後の、認証つきの Run の指定。 */
  readonly authentication: RunAuthentication;
  readonly launchBrowser: BrowserLauncher;
  /** RB-5: ワーカーの Browser の lease（あれば `launchBrowser` を呼ばずに借りる。`runPreflight` の `browserLease`）。 */
  readonly browserLease?: BrowserLease | undefined;
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
   * RB-2（T37c の probe の待ちを寄せた）: 観察の窓の一式（送らずに観察する probe の押した後に静まるまで待つ時間 `afterPress.probeQuietWaitMs` と、RB-8 の
   * 残り（RB-12 で行った）の発見の落ち着きの待ち `discoverySettle`。前の `settlePolicy` を寄せた。応答の後の本文の猶予も 1 画面の読み込みへ通す）。
   * 省略すると本番の値。ワーカーの本番の流れは渡さない。テストが、押す回数の多い組み合わせや落ち着かない画面を短く確かめるために渡す。
   */
  readonly observationWindows?: ObservationWindows | undefined;
  /**
   * L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 1 画面の進みの見張りの、反応なしの長さ（ms。省略すると
   * `PROGRESS_WATCH_QUIET_LIMIT_MS`）。ワーカーの流れは渡さない。テストが、全く反応のない画面の場面を短く確かめるために渡す（`navigationPacer` と同じ注入の形）。
   */
  readonly progressQuietLimitMs?: number | undefined;
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
  /**
   * OP-J（J1）: まとめて実行の連鎖で、直前の点検の段の Run のディレクトリ（絶対パス。ワーカーだけが渡す）。あれば、その段の成果物の登録の画面らしいリンクだけを
   * 読む（ファイルの先頭の 3）。省略すると今のまま（単独の操作さがし）。
   */
  readonly chainedAuditRunDirectory?: string | undefined;
  /**
   * DEF-200: 状態の保存と、ログインし直した後の続きの指定（ワーカーだけが渡す）。省略すると状態を保存しない（今のまま。続きにもしない）。
   */
  readonly checkpoint?: DiscoveryCheckpointOptions | undefined;
  /**
   * RB-8（再構築の設計書 2 章 1）: 巡回の口（Run の前の確認と 1 画面の読み込み）。省略すると本物（`runPreflight` と `visitPage`）。ワーカーの流れは渡さない。
   * テストが偽の口を渡し、巡回の輪（止まり方・上限・続き・辺・伏せ字・作り直し）をブラウザなしで確かめる（Gate `discovery-crawl-ports-entry`）。
   */
  readonly crawlPorts?: DiscoveryCrawlPorts | undefined;
}

/** RB-8: 1 画面を読む指定（`visitPage` の指定。巡回の口の `visit` が受ける）。 */
export type DiscoveryVisitOptions = Parameters<typeof visitPage>[3];

/**
 * RB-8（再構築の設計書 2 章 1、INV-REBUILD の plan 2 章の 5）: 発見の巡回の口。巡回の輪（`crawl`）はブラウザを直に触らず、この口に Run の前の確認と 1 画面の
 * 読み込みを頼む。本物は `PLAYWRIGHT_DISCOVERY_CRAWL_PORTS`。テストだけが偽の口を差し込む（本番の入口は渡さない）。
 */
export type DiscoveryCrawlPorts = StagePorts<DiscoveryCrawlSession>;

/** RB-8: 開いた巡回の口（Run の前の確認・持ち越し・片付けは、段の口の共通の形 `StageSession`。RB-11）。 */
export interface DiscoveryCrawlSession extends StageSession {
  /** 1 画面を読む（例外を投げない。読み込みの間隔は `open` に渡した pacer が守る）。 */
  readonly visit: (url: NormalizedHttpUrlEvidence, options: DiscoveryVisitOptions) => Promise<DiscoveryPageVisit>;
}

/** RB-8: 本物の巡回の口（今までの `runPreflight`・`visitPage`・`endPreflightBrowser`）。 */
const PLAYWRIGHT_DISCOVERY_CRAWL_PORTS: DiscoveryCrawlPorts = playwrightStagePortsOf<DiscoveryCrawlSession>((factory, pacer) => ({
  visit: (url: NormalizedHttpUrlEvidence, options: DiscoveryVisitOptions) => visitPage(factory, pacer, url, options),
}));

/**
 * DEF-200（設計書 `2026-11-04-beaksight-login-session-design.md` 3.4 の 9）: 操作さがしの続きのための状態（`checkpoint/discovery-state.json` の、巡回の部分）。
 * 読んだページの記録（発見の成果物と同じ形）、待ち行列（`CrawlFrontier` の記録と採番器）、読まなかった理由、除外に当たったリンク、先に読む登録の画面、移った先の
 * 編集の画面とその型、入口からの巡回で読んだ数。値は発見の成果物と同じ範囲の事実だけ。
 */
export interface DiscoveryCrawlCheckpoint {
  /**
   * COV-2（網羅の設計書 3.2。COV-0 の書き出しの案）: 再帰の待ち行列の書き出し（`CoverageQueue.snapshot`。伏せた URL だけを持つ。押した組を含む）。続きは
   * `CoverageQueue.restore` で作り直し、伏せた値を持つ待ちの状態は、祖先の画面を読み直して URL を埋める。
   */
  readonly coverage: CoverageQueueSnapshot;
  readonly allocator: IdAllocatorSnapshot;
  readonly readPages: readonly DiscoveryPageEntry[];
  /** COV-2: 読めなかった状態の ID（場所の鍵）と理由。 */
  readonly unreadReasons: readonly { readonly stateId: string; readonly reason: DiscoveryUnreadReason }[];
  readonly excluded: readonly string[];
  /** COV-2: ページの上限に数えない状態の ID（先に読む登録の画面と、移った先の編集の画面）。 */
  readonly uncountedStateIds: readonly string[];
  readonly crawledPages: number;
  /** DEF-208-4（A）: それまでに押した共通の枠のボタンの識別の digest（値と path を持たない。ないときは持たない）。続きでも押さない。 */
  readonly sharedLayoutDigests?: readonly string[];
}

/** DEF-200: 状態の保存のファイルの全体（巡回の部分と、続きにしてよいかを確かめる値）。 */
export interface DiscoveryCheckpointDocument extends DiscoveryCrawlCheckpoint {
  readonly schemaVersion: typeof DISCOVERY_CHECKPOINT_SCHEMA_VERSION;
  readonly runId: RunId;
  readonly jobId: string;
  readonly authenticationSha256: string;
  readonly targetConfigSha256: string;
  readonly startedAt: string;
}

/** DEF-200: 状態の保存の版。COV-2: 待ち行列を `CoverageQueue` の書き出しにしたので 2.0（1.0 の保存は読まない。続きにできず止まる）。 */
export const DISCOVERY_CHECKPOINT_SCHEMA_VERSION = 'discovery-checkpoint-schema/2.0';

/**
 * DEF-200: 状態の保存と続きの指定（ワーカーだけが渡す）。`identity` は、続きにしてよいかを確かめる値（`START` の認証の設定の SHA-256 と、ターゲット設定の
 * SHA-256。プロファイルの改訂は認証の設定に入っている）。`resume` があれば、その Run のディレクトリの状態の保存を読み、Run・前のジョブ・`identity` が合えば
 * 続きから始める。SFIX-1104（SREV-1104 の M-2）: 合わない・壊れている・その Run を続けられないときは、新しい Run を始めずに止める（`RESUME_UNAVAILABLE`。
 * 読む数を増やさない）。`resume` がなければ、今のとおり新しい Run を始める（人が始める Run）。
 */
export interface DiscoveryCheckpointOptions {
  readonly identity: { readonly authenticationSha256: string; readonly targetConfigSha256: string };
  readonly resume?: { readonly runDirectory: string; readonly previousJobId: string } | undefined;
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
   * DEF-195（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 11）: 進み具合（監査と同じ形の `RunProgressReport`。ワーカーは監査と同じ `PROGRESS` で送る）。
   * 画面を読み終えるたびに 1 回まで（同じ型の画面を読まずに飛ばしたときは送らない）。サイトへの要求は増やさない。受け手の失敗で発見を止めない。
   */
  readonly onProgress?: ((report: RunProgressReport) => void) | undefined;
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
  | { readonly kind: 'RUN_ACTIVE'; readonly exitCode: number }
  | {
    readonly kind: 'RUN_DIRECTORY_UNAVAILABLE';
    readonly runId: RunId;
    readonly runDirectory: string;
    readonly runStatus: RunStatus;
    readonly exitCode: number;
  }
  /**
   * SFIX-1104（SREV-1104 の M-2）: ログインし直した続き（`checkpoint.resume`）で、状態の保存が使えない（壊れている・別のジョブや設定のもの）か、その Run を
   * 続けられなかった。新しい Run を始めず、サイトへも要求を出さずに止めた（前の Run のまま。`runId`・`runDirectory` は続けようとした前の Run）。
   */
  | { readonly kind: 'RESUME_UNAVAILABLE'; readonly runId: RunId; readonly runDirectory: string; readonly exitCode: number };

/** DEF-144: 1 画面の probe の押下の事実（違反を起こした押下の候補の位置と、押した押下の数）。 */
interface PageProbeFacts {
  /**
   * probe の段で、続け方を決める Safety の記録（`probeRecordContinuationOf`）を最初に見たときに押していた候補の位置（`record.candidates` の添字）。記録がない・
   * probe の段の前からあったときは `null`。SAFE-2 の 4: 前は違反を見たときだった。
   */
  readonly culprit: number | null;
  /** SAFE-2 の 4: その記録から決めた続け方（外部スキーム・読み取りの移動の取り消し。`culprit` が `null` なら `null`）。 */
  readonly continuation: ProbeViolationContinuation | null;
  /** 押した押下の数（`onPressCounted` の回数）。 */
  readonly pressed: number;
  /** COV-2: 押さないまま残った候補の位置と、その状態を作り直す押下の並び（読み込み直して押す）。 */
  readonly leftBehind: ReadonlyMap<number, readonly SubmissionProbeReplayStep[]>;
  /** COV-2: 候補の見分けの鍵（読み込み直しに渡す）。 */
  readonly candidateKeys: ReadonlyMap<number, string> | undefined;
  /** COV-3: 選択肢を選んで出た、まだ見ていない構造の鍵の段を作る並び（最後が選ぶ選択肢。読み込み直して、たどり直して押す）。 */
  readonly optionStages: readonly (readonly SubmissionProbeReplayStep[])[];
}

/** DEF-144: 違反の中身（その画面の Context に違反がなければ `null`）。どの結果も持つ。 */
interface PageVisitSafety {
  readonly violation: boolean;
  readonly safetyViolation: JobSafetyViolation | null;
}

/**
 * DEF-248（COV-2c の M-1 の直し）: 凍結の中で順に読み込む画面で、根より後（祖先の並びか行き先）の読み込みが読めなかったか。根の後の読み込みは、根の読み込み方に
 * よらず同じ（`loadFrozenDocument`）なので、今の形に戻して読み直さない（同じ読み込みをサイトへ重ねない）。
 */
interface PageVisitLoadFailure {
  readonly afterRoot?: true;
}

/** 1 画面の結果（RB-8: 巡回の口の `visit` が返す形）。 */
export type DiscoveryPageVisit = PageVisit;
type PageVisit =
  | ({
    readonly kind: 'READ';
    readonly record: DiscoveryReadPageRecord;
    /** COV-2: 許可 Origin の中のリンクの行き先（query の名前と値を持つ URL。待ち行列が正規化する）。 */
    readonly links: readonly string[];
    /** OP-I（I2）: `links` のうち、登録の画面らしいリンク（`isCreatePageLink`）の URL。巡回の待ち行列で先に読む。 */
    readonly preferredLinks: ReadonlySet<string>;
    /** SD-1: リンクの文字が削除の語に当たるので移らないリンクの行き先（`links` と同じ形。除外の記録に残す）。ない画面は空か省く。 */
    readonly excludedLinks?: readonly string[];
    /** COV-2: 同じ Origin の子の frame の文書の URL と入れ子の深さ（状態の辺にする）。 */
    readonly frames: readonly FrameDocument[];
    /** COV-2: 読んだ状態の構造の鍵（押す前の画面）。 */
    readonly structureKey: string;
    /** DEF-190: 開き手の語だけの候補の押下で移った先の編集の画面（`openedEditPageOf` に当たったもの。押した順）。 */
    readonly openedEditPages: readonly (OpenedEditPage & SubmissionProbeOpenerMoveFacts)[];
    /**
     * DEF-221: 押下で同じ文書のまま変わった URL のうち、読む画面にするもの（`spaRoutePageOf` に当たったもの。押した順）。COV-2c（SREV-COV の I-3・I-4）: 値に目印を
     * 含む query の名前と、押下の並びつき。
     */
    readonly spaRoutePages: readonly SpaRoutePage[];
    /** COV-2b: 押下で文書が替わった GET の移り先のうち、読む画面にするもの（`movedPageOf` に当たったもの。値に目印を含む query の名前つき）。 */
    readonly movedPages: readonly SubmissionProbeMovedPage[];
    /** COV-2c（SREV-COV の I-4）: 再開の後の作り直しで、押下の並びを押し直して出た移り先（押し直しの読み込みだけ。ほかは `null`）。 */
    readonly replayedMove: SubmissionProbeReplayedMove | null;
    readonly blockedRequests: number;
    /** DEF-208-1: 凍結の後に Guard が通した読み取りの数（目印を運んだ数を含む）。 */
    readonly frozenReads: DiscoveryFrozenReadCounts;
    readonly probe: PageProbeFacts;
  } & PageVisitSafety)
  | ({ readonly kind: 'NAVIGATION_FAILED' } & PageVisitSafety & PageVisitLoadFailure)
  /** DEF-136: 画面の文書の応答が 4xx・5xx（不調を除く）。候補もリンクも拾わない。 */
  | ({ readonly kind: 'HTTP_ERROR_STATUS' } & PageVisitSafety & PageVisitLoadFailure)
  /** DEF-136: サイトの不調（読み取りの監査と同じ判定）。その画面の結果は捨てる。 */
  | ({ readonly kind: 'SITE_UNAVAILABLE' } & PageVisitSafety & PageVisitLoadFailure)
  | ({
    readonly kind: 'SESSION_LOST';
    readonly url: string;
    readonly detail: SessionLostDetail | null;
    /** DEF-138: セッションの切れの証拠（組み立てられなければ `null`）。 */
    readonly sessionLoss: SessionLossEvidence | null;
  } & PageVisitSafety);

/** DEF-144・COV-2: 読み込み直した画面で押す指定（読み込み直しの前の記録、残りの候補、その状態を作り直す押下の並び、候補の見分けの鍵）。 */
export interface PageReprobe {
  readonly record: DiscoveryReadPageRecord;
  readonly candidates: ReadonlySet<number>;
  readonly replay: readonly SubmissionProbeReplayStep[];
  readonly candidateKeys: ReadonlyMap<number, string> | undefined;
}

/** COV-2c: 押下で同じ文書のまま変わった、読む画面にする URL（値に目印を含む query の名前と、押下の並びつき）。 */
interface SpaRoutePage extends SubmissionProbeMoveFacts {
  readonly url: NormalizedHttpUrlEvidence;
}

/** COV-2b: 同じ Origin の子の frame の文書（URL と、main frame からの入れ子の深さ。main frame の子が 1）。 */
interface FrameDocument {
  readonly url: string;
  readonly depth: number;
}

/**
 * COV-2c fix round 4（SREV-COV 3 回目の C-1。設計者の判断の 2）: 凍結の外で読み込む入口の守りが拒んだ状態の、読まなかった理由。既存の理由の表に合う値がない
 * ため、暫定で `SAFETY_VIOLATION`（安全の決まりで読まなかった）を使う（設計者の判断を待つ。報告に書いた）。正しく作った待ち行列では起きない（2 重の守り）。
 */
const UNFROZEN_LOAD_REFUSED_REASON: DiscoveryUnreadReason = 'SAFETY_VIOLATION';

/** COV-2b: 場所の鍵の frame の印（入れ子の深さだけ。値を含まない）。 */
const frameMarkerOf = (depth: number): string => `frame:${String(depth)}`;

/** COV-2: 構造の鍵を読めなかった状態（読めなかった画面・場所のない画面）の、待ち行列に渡す構造の鍵の代わり（理由ごとの digest）。 */
const unreadStructureKeyOf = (reason: string): string => createSha256Fingerprint(JSON.stringify(['beaksight-discovery-unread-state/1', reason]));

/** 巡回の結果。 */
interface CrawlResult {
  readonly endReason: DiscoveryEndReason;
  readonly pages: readonly DiscoveryPageEntry[];
  /** L7（N34）: 読まなかった画面を件数で打ち切らないので、いつも 0。 */
  readonly omittedUnreadPages: 0;
  /** COV-2c の M-1: 祖先を最初から凍結して読めず、今の形に戻した回数（省略は 0）。 */
  readonly frozenStartFallbacks?: number;
  /** 終わり方の詳しい理由（T37a。鍵の消失によるセッションの切れのときだけ）。 */
  readonly endReasonDetail: SessionLostDetail | null;
  /** ジョブの監査の段の状態（T37a。口がなければ `null`）。 */
  readonly auditStage: AuditStageRunState | null;
  /** DEF-138: セッションの切れで止まったときの証拠（なければ `null`）。 */
  readonly sessionLoss: SessionLossEvidence | null;
  /** DEF-144: 違反で止まったときの違反の中身（なければ `null`）。 */
  readonly safetyViolation: JobSafetyViolation | null;
  /**
   * OP-J（J1）: 読んだ画面の数の上限（成果物の `maxPages`。先に読む登録の画面の数と `crawl.maxPages` の和）。L14 の後の段: `crawl.maxPages` を指定して
   * いなければ持たない（上限なし）。
   */
  readonly maxPages?: number;
}

/**
 * OP-J（J1）: 直前の点検の段の成果物（`readAuditStageLinks`。ページの ID の順、リンクは文書の順）から、登録の画面らしいリンク（`isCreatePageLink`）の
 * 正規化した URL を、見つけた順に重なりなく返す。正規化し直し（`normalizeUrl`。許す query の名前は設定のもの）、許可 Origin の外と、巡回の候補の除外
 * （`isExcludedCrawlCandidate`。読まないパス・危険な語・読む範囲・セッションの切れの path）に当たるものは外す。読めないファイル・形の違うファイルは飛ばす
 * （読む先がなければ、呼ぶ側が今どおりに巡回する）。
 * OP-R（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R2）: 登録の画面ごとに、その 1 つ上の一覧の画面（`readListPagePathOf`）も、点検の段の
 * リンクにあるときだけ（同じ正規化した URL。同じ除外の判定）、登録の画面の直後に入れる。呼ぶ側は、この並びを全部読む（COV-2）。
 */
export async function chainedCreatePageUrlsOf(
  auditRunDirectory: string,
  options: {
    readonly allowedQueryParameters: ReadonlySet<string>;
    readonly allowedOrigins: ReadonlySet<string>;
    readonly authentication: Pick<RunAuthentication, 'auditExclusions' | 'sessionLostPathPrefix'>;
  },
): Promise<readonly NormalizedHttpUrlEvidence[]> {
  const usable = (url: string): NormalizedHttpUrlEvidence | null => {
    const normalized = normalizeUrl(url, url, options.allowedQueryParameters);
    return normalized.ok && isOriginInAllowedOrigins(options.allowedOrigins, new URL(normalized.url).origin)
      && !isExcludedCrawlCandidate(normalized.url, options.allowedOrigins, options.authentication) ? normalized.url : null;
  };
  const links = await readAuditStageLinks(auditRunDirectory);
  const linked = new Set(links.flatMap((link) => {
    const url = usable(link.url);
    return url === null ? [] : [url];
  }));
  const found = new Set<NormalizedHttpUrlEvidence>();
  for (const link of links) {
    const normalized = normalizeUrl(link.url, link.url, options.allowedQueryParameters);
    const url = usable(link.url);
    if (!normalized.ok || url === null || !isCreatePageLink({ ...link, normalized })) {
      continue;
    }
    found.add(url);
    // OP-R（R2）: 一覧の画面（点検の段のリンクにあるときだけ）。
    const created = new URL(url);
    const listPath = readListPagePathOf(created.pathname);
    const list = listPath === null ? null : usable(`${created.origin}${listPath}`);
    if (list !== null && linked.has(list)) {
      found.add(list);
    }
  }
  return [...found];
}

/** 発見の巡回（ファイルの先頭の 2〜5）。 */
async function crawl(
  request: DiscoveryRunRequest,
  outputDirectory: string,
  observer: DiscoveryRunObserver,
  /** DEF-200: 続きから始めるときの、前の実行の状態（なければ `null`）。 */
  saved: DiscoveryCrawlCheckpoint | null = null,
  /** DEF-200: 1 画面ごとに状態を保存する口（なければ保存しない）。 */
  saveCheckpoint: ((state: DiscoveryCrawlCheckpoint) => Promise<void>) | null = null,
): Promise<CrawlResult> {
  const { config, authentication, stopSignal, now } = request;
  const allowedQueryParameters: ReadonlySet<string> = new Set(config.crawl.allowedQueryParameters);
  const start = normalizeUrl(config.site.startUrl, config.site.startUrl, allowedQueryParameters);
  if (!start.ok) {
    throw new RangeError('the start URL of the configuration cannot be normalized');
  }
  // DEF-200: 続きなら、前の実行の読まなかった理由から始める。
  // COV-2: 鍵は状態の ID（場所の鍵）。
  const unreadReasons = new Map<string, DiscoveryUnreadReason>((saved?.unreadReasons ?? []).map(({ stateId, reason }) => [stateId, reason]));
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
  const crawlAllowedOrigins: ReadonlySet<string> = new Set(config.site.allowedOrigins);
  // OP-J（J1）: まとめて実行の連鎖では、直前の点検の段が見つけた登録の画面らしいリンクを先に読む（ページの上限とは別に数える）。COV-2（L7 の N37）: 数で
  // 打ち切らず、全部を待ち行列に入れる。DEF-200: 続きなら、前の実行の待ち行列にもう入っている。
  const chainedCreatePages: readonly string[] = saved !== null || request.chainedAuditRunDirectory === undefined
    ? []
    : await chainedCreatePageUrlsOf(request.chainedAuditRunDirectory, { allowedQueryParameters, allowedOrigins: crawlAllowedOrigins, authentication });
  /** COV-2: ページの上限に数えない状態の ID（先に読む登録の画面と、移った先の編集の画面）。 */
  const uncounted = new Set<string>(saved?.uncountedStateIds ?? []);
  // L14 の後の段（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.1）: ページの数と時間の上限は、利用者が指定したときだけ確かめる。
  const { maxPages, maxRuntimeMs } = config.crawl;
  /** 成果物と進み具合の `maxPages`（指定がなければ項目を置かない）。 */
  const maxPagesItem = (extra: number): { readonly maxPages?: number } => (maxPages === undefined ? {} : { maxPages: maxPages + extra });
  // DEF-195: 進み具合の要求の実績（監査と同じ部品。数えるだけで、要求は足さない）。受け手がなければ作らない（今のまま）。
  const loadMeter = observer.onProgress === undefined ? undefined : createLoadMeter({ allowedOrigins: config.site.allowedOrigins, now });
  // RB-8: Run の前の確認と 1 画面の読み込みは、巡回の口に頼む（省略は本物）。
  const ports = request.crawlPorts ?? PLAYWRIGHT_DISCOVERY_CRAWL_PORTS;
  const session = await ports.open({
    config,
    launchBrowser: request.launchBrowser,
    browserLease: request.browserLease,
    createSafetyLedger: () => new SafetyLedger(),
    outputDirectory,
    // AS-b: 監査の段の送信の扱いが `PASS_EXCEPT_DELETE` のときだけ、口を渡す（承認したサービスの Origin はプロファイルのもの）。
    // DEF-276: 凍結の後に押すのは操作さがしだけなので、この factory だけが印を渡す（PRIMARY の観察の口が押す口になり、Worker の中の WebSocket を止める）。
    contextFactoryOptions: {
      ...factoryOptions, ...auditSendOptionsOf(config, authentication.approvedTestOrigins), navigationPacer: pacer, ...(loadMeter === undefined ? {} : { loadMeter }),
      submissionProbeRun: true,
    },
  }, pacer);
  if (session === null) {
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
      ...maxPagesItem(chainedCreatePages.length),
    };
  }
  try {
    const linkPolicy = { allowedOrigins: crawlAllowedOrigins, allowedQueryParameters };
    const classificationPolicy = { allowedOrigins: new Set(authentication.approvedTestOrigins) };
    // COV-2（網羅の設計書 3.2）: 再帰の待ち行列（`CoverageQueue`）。DEF-200: 続きなら、前の実行の書き出しと採番器から作り直す（読んだ画面は読み直さない。
    // 読んでいる途中で止まった画面（セッションの切れ）は、待ち行列が先頭からもう一度渡す。伏せた値を持つ待ちの状態は、祖先の画面を読み直して URL を埋める）。
    const queue = saved === null ? new CoverageQueue() : CoverageQueue.restore(saved.coverage);
    const allocator = saved === null ? new IdAllocator() : IdAllocator.restore(saved.allocator);
    /**
     * COV-2c fix round 5（SREV-COV 4 回目の I-1・M-2。設計者の判断の 1・4）: 凍結の中でだけ読む状態ごとの、そこに来るまでに押下で入れた目印の値と、この実行で
     * 入れたすべての目印の値（どちらもメモリの中だけ。checkpoint には書かない）。
     */
    const markerValuesByState = new Map<string, readonly string[]>();
    const runMarkerValues = new Set<string>();
    if (saved === null) {
      // OP-J（J1）: 登録の画面を先に読む（待ち行列の先頭。ページの上限に数えない）。続けて入口から（入口は設定の URL のまま。query の名前と値を持つ）。
      for (const url of chainedCreatePages) {
        const queued = queue.enqueue({ kind: 'LINK', url, frame: null, openedRegion: null }, { preferred: true });
        if (queued.status === 'QUEUED') uncounted.add(queued.stateId);
      }
      queue.enqueue({ kind: 'LINK', url: config.site.startUrl, frame: null, openedRegion: null });
    }
    /** OP-J（J1）: ページの上限に数える、読んだ画面の数（先に読んだ登録の画面・移った先の編集の画面は数えない）。DEF-200: 続きなら前の実行の数から。 */
    let crawledPages = saved?.crawledPages ?? 0;
    /** DEF-208-4（設計書 3.7 の A）: 操作さがし全体で押した、共通の枠のボタンの識別の digest（続きなら前の実行の分から）。 */
    const sharedLayoutDigests = new Set<string>(saved?.sharedLayoutDigests ?? []);
    /**
     * COV-2c の M-1（設計者の判断）: この実行で、凍結の外で読み込んだ URL（ふつうの画面の読み込みと、祖先の根の読み込み）。凍結の中でだけ読む状態の祖先の根は、
     * ここにあれば（最初の 1 回の後は）、最初から凍結した Context で読み込む（読み込みのときの自動の書き込みを、作り直すたびに届けない）。メモリの中だけ。
     */
    const unfrozenLoads = new Set<string>();
    /** COV-2c の M-1: 最初から凍結して読めず（描けない・作り直せない・お知らせの枠で押し直せない）、今の形（凍結の外で読み込む）に戻した回数。 */
    let frozenStartFallbacks = 0;
    /**
     * COV-2c の M-1: 1 つの読み込み（`visitPage`）。凍結の中でだけ読む状態で、祖先の根を前に凍結の外で読み込んでいれば、最初から凍結した Context で読む。読めなければ
     * （読み込めない・作り直しの押下で移り先を作れない・お知らせの枠を閉じる押下が止められた）、今の形に戻して読み、戻した回数を数える。
     */
    const visitOnce = async (url: NormalizedHttpUrlEvidence, pageOptions: DiscoveryVisitOptions): Promise<PageVisit> => {
      const root = pageOptions.frozenPath?.rootUrl ?? url;
      if (pageOptions.frozenPath !== undefined && unfrozenLoads.has(root)) {
        const frozen = await session.visit(url, { ...pageOptions, frozenFromStart: true });
        // DEF-248: 根より後の読み込みが読めなかったときは戻さない（戻しても同じ行き先を、もう一度読み込むだけ）。
        const unusable = (frozen.kind === 'NAVIGATION_FAILED' || frozen.kind === 'HTTP_ERROR_STATUS' || frozen.kind === 'SITE_UNAVAILABLE')
          && !frozen.violation && frozen.afterRoot !== true
          || (frozen.kind === 'READ' && !frozen.violation && (
            frozen.record.incompleteReasons.includes(NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON)
            || (pageOptions.replayMove !== undefined && frozen.replayedMove === null)));
        if (!unusable) return frozen;
        frozenStartFallbacks += 1;
      }
      const visited = await session.visit(url, pageOptions);
      unfrozenLoads.add(root);
      return visited;
    };
    /** 除外に当たったリンク（見つけた順。重複なし）。 */
    const excluded = new Set<string>(saved?.excluded ?? []);
    const readPages: DiscoveryPageEntry[] = [...(saved?.readPages ?? [])];
    /**
     * DEF-200: 1 画面を終えるごとに、状態を保存する（セッションの切れた画面は、読んでいる途中（`READING`）のまま保存し、続きで待ち行列が先頭から渡す）。保存の
     * 失敗は発見を止めない（続きにできないだけ。続きの側は、使えない保存なら新しい Run を始めずに止める。SFIX-1104 の M-2）。
     */
    const persist = async (): Promise<void> => {
      if (saveCheckpoint === null) {
        return;
      }
      try {
        await saveCheckpoint({
          coverage: queue.snapshot(),
          allocator: allocator.snapshot(),
          readPages: [...readPages],
          unreadReasons: [...unreadReasons].map(([stateId, reason]) => ({ stateId, reason })),
          excluded: [...excluded],
          uncountedStateIds: [...uncounted],
          crawledPages,
          ...(sharedLayoutDigests.size === 0 ? {} : { sharedLayoutDigests: [...sharedLayoutDigests] }),
        });
      } catch {
        // 保存できなくても、発見は続ける。
      }
    };
    const startedAtMs = now();
    const runtimeReached = (): boolean => maxRuntimeMs !== undefined && now() - startedAtMs >= maxRuntimeMs;
    /** COV-2: 待ち行列の状態の数（見つけた画面の数）と、読み終えた状態の数（進み具合）。 */
    const queueCounts = (): { readonly discovered: number; readonly finished: number } => {
      const states = queue.snapshot().states;
      return { discovered: states.length, finished: states.filter(({ status }) => status === 'READ').length };
    };
    /** DEF-195: 終えた画面の数（読んだ画面と、読めなかった画面。続きなら前の実行の分から。監査の `pagesFinished` と同じ数え方）。 */
    let pagesFinished = queueCounts().finished;
    /** DEF-195: 進み具合を送る（監査の Run Coordinator と同じ形。送れなくても発見を止めない）。 */
    const reportProgress = (): void => {
      if (observer.onProgress === undefined || loadMeter === undefined) {
        return;
      }
      try {
        const paced = pacer.snapshot();
        const returned: unknown = observer.onProgress(deepFreeze({
          pagesFinished,
          pagesDiscovered: queueCounts().discovered,
          ...maxPagesItem(uncounted.size),
          elapsedMs: Math.max(0, now() - startedAtMs),
          navigationCount: paced.navigationCount,
          pacingWaitMs: paced.totalWaitMs,
          requests: loadMeter.snapshot(),
          recentPerMinute: loadMeter.recentPerMinute(),
        }));
        if (returned instanceof Promise) {
          returned.catch(() => undefined);
        }
      } catch {
        // 表示の失敗で、発見を止めない。
      }
    };
    let endReason: DiscoveryEndReason = 'COMPLETED';
    let endReasonDetail: SessionLostDetail | null = null;
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
    /**
     * COV-2（網羅の設計書 3.2 の 1）: 読んだ画面から出た辺（移った先の編集の画面・SPA の経路は先に読む印つき。リンク（OP-I: 登録の画面らしいリンクは先に読む
     * 印つき）・同じ Origin の frame は、巡回の候補の除外 `isExcludedCrawlCandidate` に当たれば入れずに、除外の記録に残す）。
     */
    const edgesOf = (
      visit: Extract<PageVisit, { readonly kind: 'READ' }>,
      from: CoverageQueueItem,
    ): { readonly edges: CoverageEdgeInput[]; readonly preferredUrls: Set<string> } => {
      // COV-2c fix round 4（SREV-COV 3 回目の C-1・I-1。設計者の判断の 1・3）: 子の辺は、親の状態の伏せた名前を受け継ぐ（親の URL から受け継いだ目印を、記録と
      // checkpoint で伏せる）。凍結の中でだけ読む状態から出た辺は、その印を受け継ぐ（押下を経ていない祖先から、凍結の中でたどって読む）。
      // COV-2c fix round 5（4 回目の I-1。設計者の判断の 1）: そのうえで、値で伏せる。辺の URL の query のうち、値に目印の値（この状態に来るまでに入れた目印と、
      // この画面の押下で入れた目印。メモリの中だけ）を含む名前を伏せる。凍結の中でだけ読む状態で目印の値が分からない（再開の後）ときは、すべての名前を伏せる。
      const inherited = from.redactedQueryNames ?? [];
      const fromValues = markerValuesOf(from);
      const redactionOf = (url: string, ownNames: readonly string[], ownValues: readonly string[]): readonly string[] => [...new Set([
        ...ownNames,
        ...inherited,
        ...markerCarryingQueryNamesOf(url, fromValues === 'ALL' ? 'ALL' : [...fromValues, ...ownValues]),
      ])];
      const { edges, preferredUrls } = ownEdgesOf(visit, redactionOf);
      return {
        edges: edges.map(({ edge, ownValues }) => {
          if (edge.kind !== 'LINK' && edge.kind !== 'SPA_ROUTE' && edge.kind !== 'QUERY_CHANGE' && edge.kind !== 'FRAME') {
            return edge;
          }
          for (const value of ownValues) runMarkerValues.add(value);
          const frozenRead = from.frozenRequired || edge.frozenRead === true || edge.pressTrail !== undefined;
          // 子の目印の値を覚える（凍結の中でだけ読む子だけ。メモリの中だけ）。親の値が分からないときは、子も分からないまま（すべての名前を伏せる）。
          const childValues = fromValues === 'ALL' ? null : [...new Set([...fromValues, ...ownValues])];
          const redactedQueryNames = redactionOf(edge.url, edge.redactedQueryNames ?? [], ownValues);
          if (frozenRead && childValues !== null) {
            const location = stateLocationKeyOf({ url: edge.url, frame: edge.frame, openedRegion: edge.openedRegion, redactedQueryNames });
            if (location.ok && !markerValuesByState.has(location.key)) markerValuesByState.set(location.key, childValues);
          }
          return {
            ...edge,
            ...(redactedQueryNames.length === 0 ? {} : { redactedQueryNames }),
            ...(from.frozenRequired ? { frozenRead: true } : {}),
          };
        }),
        preferredUrls,
      };
    };
    /**
     * 読んだ画面そのものから出た辺（親から受け継ぐ前）と、その辺を出した押下で入れた目印の値。`redactionOf` は、除外の記録で伏せる名前を求める部品（`edgesOf` と同じ）。
     */
    const ownEdgesOf = (
      visit: Extract<PageVisit, { readonly kind: 'READ' }>,
      redactionOf: (url: string, ownNames: readonly string[], ownValues: readonly string[]) => readonly string[],
    ): { readonly edges: { readonly edge: CoverageEdgeInput; readonly ownValues: readonly string[] }[]; readonly preferredUrls: Set<string> } => {
      const edges: { readonly edge: CoverageEdgeInput; readonly ownValues: readonly string[] }[] = [];
      const preferredUrls = new Set<string>();
      // COV-2c（C-1）・fix round 3（SREV-COV 再レビューの C-1・I-1）: 開き手の押下の移り先（DEF-190 の編集の画面）は、目印を一度も入れていない文書で押した
      // ものだけ、今どおり凍結の外で読む（押下の並びを持たせない）。目印を入れる押下でたどり着いた状態の開き手（`markedDocument`）の移り先は、ほかの移り先と同じく
      // 押下の並びを持たせて凍結の中で読む（`frozenFrom`）。どちらも、値に目印を含む query の値を、場所の鍵と記録で伏せる。
      for (const { url, markerQueryNames, trail, markedDocument, markerValues } of visit.openedEditPages) {
        edges.push({
          edge: { kind: 'LINK', url, frame: null, openedRegion: null, redactedQueryNames: markerQueryNames, ...(markedDocument ? { pressTrail: trail } : {}) },
          ownValues: markerValues,
        });
        preferredUrls.add(url);
      }
      // COV-2c（SREV-COV の I-3・I-4）: 同じ文書のまま変わった URL も、値に目印を含む query の値を場所の鍵と記録で伏せ、押下の並びを持たせる（再開の後に作り直す）。
      for (const { url, markerQueryNames, trail, markerValues } of visit.spaRoutePages) {
        edges.push({
          edge: { kind: 'SPA_ROUTE', url, frame: null, openedRegion: null, redactedQueryNames: markerQueryNames, pressTrail: trail }, ownValues: markerValues,
        });
        preferredUrls.add(url);
      }
      const admitted = (url: string, redactedQueryNames: readonly string[] = [], ownValues: readonly string[] = []): boolean => {
        const location = stateLocationKeyOf({ url, frame: null, openedRegion: null, redactedQueryNames: redactionOf(url, redactedQueryNames, ownValues) });
        if (!location.ok) {
          return false;
        }
        if (isExcludedCrawlCandidate(location.url as NormalizedHttpUrlEvidence, crawlAllowedOrigins, authentication)) {
          // 除外の記録は、伏せた形で残す（COV-2b: 目印の値も伏せる）。
          excluded.add(location.redactedUrl);
          return false;
        }
        return true;
      };
      // SD-1: リンクの文字が削除の語に当たるリンクは移らず、除外の記録に残す（伏せた形）。
      for (const url of visit.excludedLinks ?? []) {
        const location = stateLocationKeyOf({ url, frame: null, openedRegion: null, redactedQueryNames: redactionOf(url, [], []) });
        if (location.ok) excluded.add(location.redactedUrl);
      }
      for (const url of visit.links) {
        if (!admitted(url)) continue;
        edges.push({ edge: { kind: 'LINK', url, frame: null, openedRegion: null }, ownValues: [] });
        if (visit.preferredLinks.has(url)) preferredUrls.add(url);
      }
      // COV-2b: 子の frame の文書は、frame の印（入れ子の深さ）つきの状態にする（場所の鍵が最上位の文書と分かれる）。読むときは、その URL を直に GET で読む。
      for (const { url, depth } of visit.frames) {
        if (admitted(url)) edges.push({ edge: { kind: 'FRAME', url, frame: frameMarkerOf(depth), openedRegion: null }, ownValues: [] });
      }
      // COV-2b（網羅の設計書 3.2 の 1）: 押下で文書が替わった GET の移り先（押した後の画面）。値に目印を含む query は、場所の鍵と記録で値を伏せる（読む URL は
      // そのまま。目印を運ぶ GET は DEF-208-1 の決定で通す）。
      // COV-2c（SREV-COV の I-4）: 押下の並びも持たせる（再開の後、元の画面を読み直して押し直し、伏せた URL を作り直す）。
      for (const { url, markerQueryNames, trail, markerValues } of visit.movedPages) {
        if (admitted(url, markerQueryNames, markerValues)) {
          edges.push({
            edge: { kind: 'LINK', url, frame: null, openedRegion: null, redactedQueryNames: markerQueryNames, pressTrail: trail }, ownValues: markerValues,
          });
        }
      }
      return { edges, preferredUrls };
    };
    /**
     * COV-2c fix round 5（SREV-COV 4 回目の I-1）: 状態に来るまでに入れた目印の値（メモリの中だけ）。凍結の中でだけ読まない状態は空。凍結の中でだけ読む状態で、
     * その状態にも親にも覚えた値がない（再開の後など）ときは、分からない（`'ALL'`。すべての名前を伏せる）。
     */
    const markerValuesOf = (item: CoverageQueueItem): readonly string[] | 'ALL' => {
      const own = markerValuesByState.get(item.stateId);
      if (own !== undefined) return own;
      if (!item.frozenRequired) return [];
      const parent = item.parentStateId === null ? undefined : markerValuesByState.get(item.parentStateId);
      return parent ?? 'ALL';
    };
    /** COV-2c（SREV-COV の I-1 の 3）: 利用者の停止か、利用者が指定した Run の時間の上限に届いたか（押す輪・読み込み直し・作り直しの中でも見る）。 */
    const stopNow = (): boolean => stopSignal.aborted || runtimeReached();
    for (let entry = queue.next(); entry !== undefined; entry = queue.next()) {
      /** COV-2c: この画面の押す輪を、停止か時間の上限で途中で終えたか。 */
      let probeCut = false;
      /** COV-2c（I-4）: 作り直しの押し直しの読み込みで起きた、止めるべきこと（違反・セッションの切れ。なければ `null`）。 */
      let replayStop: PageVisit | null = null;
      // ページの上限と時間の上限は、利用者が点検の開始で選ぶ上限（網羅の設計書 3.4。残す）。LZ-3c: 承認したサービスの Origin への要求の上限の分岐（前の T37a）は、
      // L11 から届かないので捨てた。
      if (stopSignal.aborted) {
        endReason = 'STOPPED';
      } else if (runtimeReached()) {
        endReason = 'MAX_RUNTIME_REACHED';
      } else if (maxPages !== undefined && !entry.rebuild && !uncounted.has(entry.stateId) && crawledPages >= maxPages) {
        endReason = 'MAX_PAGES_REACHED';
      }
      if (endReason !== 'COMPLETED') {
        break;
      }
      const entryUrl = entry.url as NormalizedHttpUrlEvidence;
      // COV-2c（SREV-COV の C-1）・fix round 4（3 回目の C-1。設計者の判断の 2）: 凍結の外で読み込む入口の守り（唯一の判定 `unfrozenLoadRefusalOf`）。この状態を
      // 読むときに凍結の外で読み込む URL（凍結の中でだけ読む状態では、押下を経ていない祖先）が、押下から生まれた状態か、伏せた query を持てば、読み込まずに、
      // 読まなかった画面として理由つきで残す。凍結の中でだけ読む状態で、たどり方の URL が分からないときも、凍結の外では読まない（読み込みの失敗として残す）。
      // COV-2c fix round 5（M-2）: この実行で入れた目印の値でも照らす。
      const unfrozenRefusal = entry.unfrozenLoad === null ? null : unfrozenLoadRefusalOf(entry.unfrozenLoad, [...runMarkerValues]);
      if (entry.unfrozenLoad === null || unfrozenRefusal !== null) {
        // COV-2c fix round 5（I-2）: たどり方の URL が分からない（伏せた祖先を作り直せなかった）ときは、専用の理由で残す。
        const reason: DiscoveryUnreadReason = unfrozenRefusal === null ? 'REBUILD_FAILED' : UNFROZEN_LOAD_REFUSED_REASON;
        queue.completeRead(entry.stateId, { structureKey: unreadStructureKeyOf(reason), edges: [] });
        if (!entry.rebuild) unreadReasons.set(entry.stateId, reason);
        await persist();
        continue;
      }
      // COV-2（L7 の N37）: 同じ型の画面を 1 つだけ読む決まり（`SAME_TEMPLATE_PAGE_READ`）はなくした。全部の画面を読み、押すのは、まだ見ていない構造の鍵の
      // 状態の、まだ押していない組だけ（押す部品が待ち行列の押した組の記録 `pressRegistry` で見分ける）。
      const pageOptions = {
        config, allowedQueryParameters, linkPolicy, classificationPolicy, authentication, pageId: allocator.allocatePageId(), auditStage,
        submissionProbeQuietWaitMs: observationWindowsOrProduction(request.observationWindows).afterPress.probeQuietWaitMs,
        settlePolicy: discoverySettlePolicyOf(request.observationWindows), observationWindows: request.observationWindows, pressRegistry: queue,
        progressQuietLimitMs: request.progressQuietLimitMs,
        // COV-2: 読み戻した後の作り直し（祖先の画面を読み直し、伏せた値の URL を埋める）は、押さない。
        linksOnly: entry.rebuild,
        sharedLayout: { pressed: sharedLayoutDigests, onPressed: (digest: string): void => { sharedLayoutDigests.add(digest); } },
        // DEF-236: この画面を取り出して待ち行列が空なら、最後の画面として、閉じる前に読み込みの間隔を待たない（この画面で新しい先が出ても、次の読み込みの前に
        // pacer が間隔を空けるので、サイトに届く間隔は変わらない）。
        pacingWaitBeforeClose: !queue.isFinished,
        // COV-2c（SREV-COV の C-1）・fix round 4: 凍結の中でだけ読む状態（押下から生まれた状態と、そこから出た辺の先）は、押下を経ていない祖先を読み込んで凍結し、
        // 祖先から順に凍結の中で読み込んでから読む（読み込み直し・作り直しも同じ）。ほかの画面は今どおり（PASS_EXCEPT_DELETE で読み込んでから凍結）。
        frozenPath: entry.frozenPath ?? undefined,
        // COV-2c（I-1 の 3）: 押す輪の中でも、停止と Run の時間の上限を見る（押す部品が見て止めたら、この画面の後に止める）。
        shouldStop: (): boolean => {
          if (!stopNow()) return false;
          probeCut = true;
          return true;
        },
      };
      // DEF-136: 不調なら、その画面の結果を捨て、待ってから同じ画面を 1 回だけ確かめ直す（`siteRecheck`）。
      // 知らせの URL は伏せた形（COV-2b: 押下の目印の値も伏せる）。
      const rechecked = await siteRecheck.visit(entry.redactedUrl, () => visitOnce(entryUrl, pageOptions),
        (result) => result.kind === 'SITE_UNAVAILABLE' && !result.violation);
      let visit: PageVisit = rechecked.value;
      // DEF-144・COV-1b・COV-2: probe の押下で外部スキームへの移動の違反が起きた画面（発見を止めずに続ける）と、押さないまま残った候補のある画面は、読み込み
      // 直して残りの候補を押す（押していない候補が残り、前の読み込み直しで進みがあった間は続ける）。ほかの種類の違反は今どおり止める。
      let continued: ContinuedPage | null = null;
      if (rechecked.kind !== 'STOPPED' && visit.kind === 'READ' && !entry.rebuild) {
        continued = await reprobeRemaining(visit, (reprobe) => visitOnce(entryUrl, { ...pageOptions, reprobe }), pageOptions.shouldStop);
        if (continued !== null) {
          visit = continued.stop === null || continued.stop.kind === 'SESSION_LOST'
            ? continued.visit
            : { ...continued.visit, violation: true, safetyViolation: continued.stop.safetyViolation };
        }
      }
      if (rechecked.kind === 'STOPPED') {
        // 待つ間に止める印が来た: 確かめ直さずに止める（その画面は読まなかった。読んでいる途中のまま、続きで読み直す）。
        endReason = 'STOPPED';
        break;
      }
      if (visit.kind === 'READ' && entry.rebuild) {
        // COV-2c（SREV-COV の I-4）: 押下から生まれた、URL の分からない状態は、この画面を読み直して押下の並びを押し直し、移り先を作り直す（1 つの並びに 1 回の
        // 読み込み。読み込みの間隔は `visitGuardedPage` の pacer が守る。押した送信は凍結の Guard が届けない）。
        const awaiting = queue.pressTrailsAwaitingFrom(entry.stateId);
        const replayedEdges: CoverageEdgeInput[] = [];
        for (const state of awaiting) {
          if (stopNow()) break;
          const replayed = await visitOnce(entryUrl, { ...pageOptions, replayMove: state.pressTrail });
          if (replayed.kind === 'READ' && replayed.replayedMove !== null) {
            replayedEdges.push({
              kind: state.kind, url: replayed.replayedMove.url, frame: null, openedRegion: null,
              redactedQueryNames: state.redactedQueryNames, pressTrail: state.pressTrail,
              ...(entry.frozenRequired ? { frozenRead: true } : {}),
            });
            // COV-2c fix round 5（I-2）: 押し直しで取り戻した目印の値を覚える（子孫の辺を値で伏せる。メモリの中だけ）。
            const parentValues = markerValuesOf(entry);
            markerValuesByState.set(state.stateId, [...(parentValues === 'ALL' ? [] : parentValues), ...replayed.replayedMove.markerValues]);
            for (const value of replayed.replayedMove.markerValues) runMarkerValues.add(value);
          }
          if (replayed.violation || replayed.kind === 'SESSION_LOST') {
            // 違反とセッションの切れは、読み込みと同じく止める（下の決まりで扱う）。
            replayStop = replayed;
            break;
          }
        }
        // COV-2: 作り直し（祖先の読み直し）は、出た辺で URL を埋めるだけ（画面の記録は前の実行のまま。ページの上限に数えない）。
        queue.completeRead(entry.stateId, { structureKey: visit.structureKey, edges: [...edgesOf(visit, entry).edges, ...replayedEdges] });
        // 作り直せなかった状態は、その状態だけを読まなかった画面として理由つきで残す（再開そのものは続ける）。
        const stillAwaiting = new Set(queue.pressTrailsAwaitingFrom(entry.stateId).map(({ stateId }) => stateId));
        for (const state of awaiting) {
          if (state.status !== 'READ' && stillAwaiting.has(state.stateId) && replayStop === null && !stopNow()) {
            unreadReasons.set(state.stateId, 'REBUILD_FAILED');
          }
        }
      } else if (visit.kind === 'READ') {
        if (!uncounted.has(entry.stateId)) {
          crawledPages += 1;
        }
        // 画面の記録は、成果物の形（`DiscoveryReadPageRecord`。発見の入口が返す型と同じ 1 つの型。CC-070 (a)）のまま入る。
        const record: DiscoveryReadPageRecord = visit.record;
        readPages.push({
          // COV-2b: 記録は伏せた形（秘密に見える名前の値と、押下の目印の値を伏せた URL）。読むのは伏せる前の URL。
          url: entry.redactedUrl,
          state: 'READ',
          record,
          blockedRequests: visit.blockedRequests,
          // DEF-208-1: 凍結の後に通した読み取りの数（値と URL は持たない）。
          frozenReadRequests: visit.frozenReads,
          // DEF-144: 発見を続けた違反の中身と、読み込み直したこと（あるときだけ）。
          ...(continued === null || continued.safetyViolations.length === 0 ? {} : { safetyViolations: continued.safetyViolations }),
          ...(continued?.reloaded === true ? { reloadedForProbe: true } : {}),
        });
        // COV-2（網羅の設計書 3.2 の 1）: 出た先を全部、辺として待ち行列に入れる（リンク・SPA の経路・移った先の編集の画面・同じ Origin の frame）。
        // DEF-190・OP-J: 移った先の編集の画面は、待ち行列の先に入れ、ページの上限に数えない（L7 の N37: 数と同じ型の 1 回の上限は外した）。
        const { edges, preferredUrls } = edgesOf(visit, entry);
        const result = queue.completeRead(entry.stateId, { structureKey: visit.structureKey, edges, preferredUrls });
        const queued = new Set(result.queuedStateIds);
        for (const opened of visit.openedEditPages) {
          const location = stateLocationKeyOf({
            url: opened.url, frame: null, openedRegion: null, redactedQueryNames: [...opened.markerQueryNames, ...(entry.redactedQueryNames ?? [])],
          });
          if (location.ok && queued.has(location.key)) uncounted.add(location.key);
        }
      } else if (visit.kind !== 'SESSION_LOST') {
        // 読めなかった画面: 辺なしで読み終えたことにする（構造の鍵は理由ごとの代わりの digest）。セッションの切れた画面は、読んでいる途中のまま（続きで読み直す）。
        queue.completeRead(entry.stateId, { structureKey: unreadStructureKeyOf(visit.kind), edges: [] });
        if (!entry.rebuild) unreadReasons.set(entry.stateId, visit.kind);
      }
      // DEF-200: この画面を終えた状態を保存する（セッションの切れた画面は、続きで読み直す）。
      await persist();
      // DEF-195: 画面を読み終えた進み具合を 1 回送る（セッションの切れた画面は、続きで読み直すので終えた数に入れない。作り直しは数えない）。
      if (visit.kind !== 'SESSION_LOST' && !entry.rebuild) {
        pagesFinished += 1;
      }
      reportProgress();
      // COV-2c（I-4）: 作り直しの押し直しの読み込みの違反・セッションの切れは、その読み込みの結果で止める（下の決まり）。
      if (replayStop !== null) {
        visit = replayStop;
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
        // COV-2b: 読もうとした画面のままなら、待ち行列の伏せた形（押下の目印の値も伏せる）で知らせる。
        observer.onSessionLost(redactUrlSecrets(visit.url === entryUrl ? entry.redactedUrl : visit.url), visit.sessionLoss);
        endReason = 'AUTH_SESSION_LOST';
        endReasonDetail = visit.detail;
        sessionLoss = visit.sessionLoss;
        break;
      }
      // COV-2c（SREV-COV の I-1 の 3）: この画面の押す輪を停止か時間の上限で途中で終えたら、次の画面を待たずに止める（その画面は読めた分を残す）。
      if (probeCut) {
        endReason = stopSignal.aborted ? 'STOPPED' : 'MAX_RUNTIME_REACHED';
        break;
      }
    }
    // 読まなかった画面（見つけた順）: 読み込みの失敗、止まった後に残った画面、除外に当たるリンク。L7（N34）: 件数で打ち切らず、全部を記録する。
    // COV-2: URL は待ち行列の伏せた形（秘密に見える名前の query の値を伏せたもの）。
    const unread: DiscoveryPageEntry[] = [];
    for (const state of queue.snapshot().states) {
      const reason = unreadReasons.get(state.stateId);
      if (state.status === 'READ' && reason === undefined) {
        continue;
      }
      unread.push({ url: state.url, state: 'NOT_READ', reason: reason ?? (endReason === 'COMPLETED' ? 'STOPPED' : endReason) });
    }
    for (const url of excluded) {
      unread.push({ url, state: 'NOT_READ', reason: 'EXCLUDED' });
    }
    return {
      endReason,
      pages: [...readPages, ...unread],
      omittedUnreadPages: 0,
      frozenStartFallbacks,
      endReasonDetail,
      auditStage,
      sessionLoss,
      // DEF-144: 違反で止まったときだけ（ほかの終わり方では、違反の中身を書かない）。
      safetyViolation: endReason === 'SAFETY_VIOLATION' ? stopViolation : null,
      // DEF-190・OP-J: ページの上限に数えない画面（先に読む登録の画面・移った先の編集の画面）の数も、上限に足す（読んだ画面の数がこの値を超えない）。
      ...maxPagesItem(uncounted.size),
    };
  } finally {
    await session.close();
    // FM2d: Browser を閉じた（RB-5: lease に返した）後に、factory の最新の状態と窓を持ち越しの口へ渡す（メモリの中だけ）。
    recordRunStageCarry(request.stageCarry, session.carry, auditStage, navigationCarry());
  }
}

/** RB-8: 凍結の中でだけ読む画面のたどり方の結果（`walkFrozenPath`）。 */
export type FrozenPathWalk =
  | { readonly kind: 'READABLE' }
  /**
   * 根を凍結できなかった（hop を 1 つも読み込んでいない。REV-RB8911 M-1: 読み込みの失敗ではなく、呼ぶ側は凍結できない理由
   * `INCOMPLETE_FREEZE_UNAVAILABLE` の候補 0 件の画面にする）。
   */
  | { readonly kind: 'FREEZE_UNAVAILABLE'; readonly afterRoot: false }
  /** 根より後の hop が読めなかった（DEF-248: 呼ぶ側は今の形に戻して読み直さない）。 */
  | { readonly kind: Exclude<PageLoadVerdict['kind'], 'READABLE'>; readonly afterRoot: true };

/**
 * RB-8（INV-REBUILD の plan 2 章の 6。S4）: 凍結の中でだけ読む画面のたどり方の順（唯一の置き場所）。根を落ち着かせて凍結し（`freezeRoot`。候補は読まない）、
 * 凍結できたときだけ、祖先の並びと行き先（`hops`）を凍結の中で順に読み込む（`loadHop`）。根を凍結できなければ、どの hop も読み込まない（凍結の外で hop を
 * 読まない）。読めない hop があれば、そこで止める。`afterStep` は、根の後と hop ごとに呼ぶ（セッションの切れの確かめ。投げれば、そのまま外へ投げる）。
 */
export async function walkFrozenPath(
  hops: readonly string[],
  steps: {
    readonly freezeRoot: () => Promise<boolean>;
    readonly loadHop: (hop: string) => Promise<PageLoadVerdict['kind']>;
    readonly afterStep: () => void;
  },
): Promise<FrozenPathWalk> {
  const frozen = await steps.freezeRoot();
  steps.afterStep();
  if (!frozen) {
    return { kind: 'FREEZE_UNAVAILABLE', afterRoot: false };
  }
  for (const hop of hops) {
    const verdict = await steps.loadHop(hop);
    if (verdict !== 'READABLE') {
      return { kind: verdict, afterRoot: true };
    }
    steps.afterStep();
  }
  return { kind: 'READABLE' };
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
    /** RB-2: probe の押した後の最短の観察（依頼の観察の窓の一式から）。 */
    readonly submissionProbeQuietWaitMs: number;
    /** L6/L3-1: 1 画面の進みの見張りの反応なしの長さ（`DiscoveryRunRequest` の `progressQuietLimitMs`。省略は本番の長さ）。 */
    readonly progressQuietLimitMs?: number | undefined;
    /** TS-c: 落ち着きの待ちの指定（`DiscoveryRunRequest` の観察の窓の一式から。省略は本番の指定）。 */
    readonly settlePolicy: DiscoverySettlePolicy | undefined;
    /** RB-8 の残り: 観察の窓の一式（`visitGuardedPage` が、進行中の要求の数え方の本文の猶予に使う。省略は本番の値）。 */
    readonly observationWindows?: ObservationWindows | undefined;
    /** DEF-208-4（A）: 操作さがし全体の、共通の枠のボタンの押した識別（押す部品の `sharedLayout`）。 */
    readonly sharedLayout?: SubmissionProbeOptions['sharedLayout'];
    /** COV-2: 操作さがし全体の押した組の記録（待ち行列。押す部品の `pressRegistry`）。 */
    readonly pressRegistry?: SubmissionProbeOptions['pressRegistry'];
    /** COV-2: 読み戻した後の作り直し（リンクと辺だけを読み、押さない）。 */
    readonly linksOnly?: boolean;
    /**
     * DEF-144・COV-2: 読み込み直した画面で押す指定（あるときは、読み込み直しの前の記録の残りの候補だけを、その状態を作り直してから押す。リンクは読まない）。
     * 省略すると、今までどおりの 1 画面の発見。
     */
    readonly reprobe?: PageReprobe | undefined;
    /** COV-2c（SREV-COV の I-1 の 3）: 利用者の停止か Run の時間の上限に届いたか（押す部品の `shouldStop`）。 */
    readonly shouldStop?: (() => boolean) | undefined;
    /**
     * DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.2）: 閉じる前に、画面を見せたまま次の読み込みの間隔を待つか（`visitGuardedPage` の指定）。
     * 待ち行列が空になる最後の画面は偽（待たずに閉じる）。
     */
    readonly pacingWaitBeforeClose?: boolean | undefined;
    /**
     * COV-2c（SREV-COV の I-4）: 再開の後の作り直しで、この画面で押し直す押下の並び（あるときは、リンクを読まず、押す部品で押さず、並びを押し直して移り先だけを
     * 返す。`replaySubmissionProbeMove`）。
     */
    readonly replayMove?: readonly SubmissionProbeReplayStep[] | undefined;
    /**
     * COV-2c（SREV-COV の C-1。網羅の設計書）・fix round 4（3 回目の C-1）: 凍結の中でだけ読む画面（押下から生まれた画面と、そこから出た辺の先）のたどり方
     * （押下を経ていない祖先の URL と、凍結の中で順に読み込む祖先の URL。伏せる前）。あるときは、祖先を読み込んで凍結し、凍結を解かずに祖先の並びと `url` の画面を
     * 順に読み込んで（`BrowserContextFactory.loadFrozenDocument`）、凍結を始めない読み取りで読む（どの画面の読み取りでない送信も、読み込みの最初から凍結の決まりで
     * 止める）。省略すると、今どおり `url` を読み込んでから凍結する。
     */
    readonly frozenPath?: CoverageFrozenPath | undefined;
    /**
     * COV-2c の M-1（設計者の判断）: 祖先（`frozenPath` の根）を、最初から凍結した Context で読み込むか（`visitGuardedPage` の `frozenFromStart`）。真なら、根の
     * 読み込みのときの自動の書き込みを届けない。根の画面は凍結を始めずに読む。
     */
    readonly frozenFromStart?: true | undefined;
  },
): Promise<PageVisit> {
  // DEF-144: この画面の Context の違反の中身（閉じた後に `visitGuardedPage` が渡す）と、probe の押下の事実。
  const safety: { violation: JobSafetyViolation | null } = { violation: null };
  const probe: {
    culprit: number | null; continuation: ProbeViolationContinuation | null; current: number | null; pressed: number;
    leftBehind: Map<number, readonly SubmissionProbeReplayStep[]>;
    candidateKeys: ReadonlyMap<number, string> | undefined; optionStages: (readonly SubmissionProbeReplayStep[])[];
  } = { culprit: null, continuation: null, current: null, pressed: 0, leftBehind: new Map(), candidateKeys: undefined, optionStages: [] };
  /** DEF-248: 根より後の読み込みが読めなかったか（`PageVisitLoadFailure`）。 */
  let failedAfterRoot = false;
  const guardedOptions = {
    ...options,
    onSafetyViolation: (violation: JobSafetyViolation): void => { safety.violation ??= violation; },
    // DEF-233（設計書 2.3）: 承認したサービスの Origin の 401 で描けなかった画面は、セッションの切れにする（DEF-200 のログインし直しへ回す）。
    serviceUnauthorizedSessionLoss: true,
  };
  const visit = await visitGuardedPage(factory, pacer, options.frozenPath?.rootUrl ?? url, guardedOptions, async ({
    page, ledger, counter, navigation, enterSubmissionProbe, stopIfSessionLostAfterSettling,
  }) => {
    // DEF-136: 判定の順は、セッションの切れ（読み込みの部品が先に見分ける）→ 不調 → 読み込みの失敗 → エラーの状態。不調とエラーの状態の画面からは、
    // 候補もリンクも拾わない。
    const verdict = pageLoadVerdictOf(navigation);
    if (verdict.kind !== 'READABLE') {
      return verdict.kind;
    }
    // DEF-210（通知の枠の設計書 3.2）: 発見の読み取り（凍結）の前に、落ち着くのを待って、通知の枠を閉じる（閉じられない枠は隠す）。閉じる押下は、probe の
    // 押す数（1 画面 3 回）に数えない。押した後の送信は、この Context の Guard が今の段の判定で扱う。
    await settleAndDismissNotificationFrames(page, { requestCounter: counter, settlePolicy: options.settlePolicy });
    // L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 1 画面の発見と押す輪を、1 つの進みの見張り（`watchDiscoveryScreen`）で包む。読み取り
    // と押す操作は期限を置かずに待ち、ブラウザからの応答・ページの通信・画面の変化のどれもない状態が続いたときだけ、見張りが画面を終える。終えたら、その時点
    // までの記録（押しにかかった対象の記録）を残し、残りを「応答しなかった」（`STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`）として、次の画面へ進む。
    const screen: {
      discovered: DiscoveryReadPageRecord | null;
      snapshot: ((reason: 'STAGE_UNRESPONSIVE' | 'STAGE_NEVER_QUIET') => DiscoveryReadPageRecord) | null;
      structureKey: string | null;
      links: readonly string[];
      preferredLinks: ReadonlySet<string>;
      excludedLinks: readonly string[];
      frames: readonly FrameDocument[];
      /** 見張りが画面を終えた（見放した処理の知らせを、後から受けない）。 */
      ended: boolean;
    } = { discovered: null, snapshot: null, structureKey: null, links: [], preferredLinks: new Set(), excludedLinks: [], frames: [], ended: false };
    /** 見張りが画面を終えた後は、見放した処理の知らせを受けない。 */
    const live = <A extends unknown[]>(receive: (...args: A) => void) => (...args: A): void => {
      if (!screen.ended) receive(...args);
    };
    /** DEF-190: 開き手の語だけの候補の押下で移った先の編集の画面（押した順）。読み込み直した画面でも同じく拾う。 */
    const openedEditPages: (OpenedEditPage & SubmissionProbeOpenerMoveFacts)[] = [];
    /** DEF-221: 押下で同じ文書のまま変わった URL のうち、読む画面にするもの（押した順）。読み込み直した画面でも同じく拾う。 */
    const spaRoutePages: SpaRoutePage[] = [];
    /** COV-2b: 押下で文書が替わった GET の移り先のうち、読む画面にするもの（押した順）。 */
    const movedPages: SubmissionProbeMovedPage[] = [];
    const watched = await watchDiscoveryScreen(page, async () => {
      // RB-8（S4）: 凍結の中でだけ読む画面の根は、落ち着かせて凍結するだけ（候補を読まない。読んだ結果は使わなかった）。凍結できなければ、hop を読み込まない
      // （凍結の外で hop を読まない）。凍結した根から、祖先の並びと行き先を凍結の中で順に読み込む（`walkFrozenPath`）。
      if (options.frozenPath !== undefined) {
        /** 根の凍結の結果（凍結できなかった画面の記録に、その画面の場所と理由を使う）。 */
        const root: { freeze: SettledFreezeOutcome | null } = { freeze: null };
        const walked = await walkFrozenPath([...options.frozenPath.hops, url], {
          // COV-2c の M-1: 最初から凍結した Context で読み込んだ根は、凍結を始めずに、凍結の段であることを確かめる。
          freezeRoot: async () => {
            root.freeze = await settleAndFreezePage(page, {
              requestCounter: counter, settlePolicy: options.settlePolicy, ...(options.frozenFromStart === true ? { alreadyFrozen: true as const } : {}),
            }, openReadDeadline);
            return root.freeze.status === 'FROZEN';
          },
          loadHop: async (hop) => {
            // 読み込みの間隔は今どおり守る。L6/L3-1: 凍結の中の読み込みも、返ったら進みの印を付ける（読み込みの間の通信と画面の変化も、見張りが見る）。
            await pacer.beforeNavigation();
            return pageLoadVerdictOf(await trackOnScreen(page, factory.loadFrozenDocument(page, hop, () => navigatePage(page, hop, {
              timeoutMs: options.config.crawl.navigationTimeoutMs, ledger, allowedQueryParameters: options.allowedQueryParameters,
            })))).kind;
          },
          // DF-3（DEF-167）: 根の落ち着きの後と、hop ごとに、セッションの切れを確かめる。
          afterStep: stopIfSessionLostAfterSettling,
        });
        if (walked.kind === 'FREEZE_UNAVAILABLE') {
          // REV-RB8911 M-1: 凍結できない根は、読み込みの失敗ではなく、凍結の部品と同じ理由（`INCOMPLETE_FREEZE_UNAVAILABLE`）の候補 0 件の画面にする（リンクを
          // 拾わず、probe を押さない。hop は読まない）。
          const { freeze } = root;
          const empty: DiscoveryReadPageRecord = Object.freeze({ location: freeze?.location ?? null, incompleteReasons: Object.freeze([]), candidates: Object.freeze([]) });
          const unfrozen = [...(freeze?.reasons ?? []), 'INCOMPLETE_FREEZE_UNAVAILABLE' as const].reduce(withIncompleteReason, empty);
          return {
            record: unfrozen, links: [], preferredLinks: new Set<string>(), frames: [], structureKey: unreadStructureKeyOf('FREEZE_UNAVAILABLE'),
            openedEditPages: [], spaRoutePages: [], movedPages: [], replayedMove: null,
          };
        }
        if (walked.kind !== 'READABLE') {
          if (walked.afterRoot) failedAfterRoot = true;
          return walked.kind;
        }
      }
      // DEF-144: 読み込み直した画面でも、発見の入口で読む（凍結をかける。probe は凍結の段でだけ押す）。押す対象は、読み込み直しの前の記録の残りの候補。
      // COV-2c の M-1: 最初から凍結した Context で読み込んだ根は、凍結を始めずに読む（凍結の段であることを確かめる）。凍結の中で読み込んだ画面も同じ。
      const discovered = await discoverPageCandidates(page, {
        classificationPolicy: options.classificationPolicy, requestCounter: counter, settlePolicy: options.settlePolicy,
        ...(options.frozenFromStart === true || options.frozenPath !== undefined ? { alreadyFrozen: true as const } : {}),
      });
      screen.discovered = discovered;
      // DF-3（DEF-167）: 落ち着きを待った後に、セッションの切れを確かめる（当たれば、リンクを拾わず、probe を押さずに止める。その画面はセッションの切れ）。
      stopIfSessionLostAfterSettling();
      // fix round 4（通知の枠の設計書 3.2.3 の 3）: 閉じる押下か隠しの押す期間に、Guard が移動かポップアップを止めた画面は、誤りの画面を読んだおそれがある。候補 0 件の
      // 画面にせず、理由つきの読めなかった画面として記録する（候補・リンクを拾わず、probe を押さない。読み込み直しはしない）。
      if (notificationPressNavigationsOf(page) > 0) {
        const blocked = withIncompleteReason(Object.freeze({ ...discovered, candidates: Object.freeze([]) }), NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED_REASON);
        return {
          record: blocked, links: [], preferredLinks: new Set<string>(), frames: [], structureKey: unreadStructureKeyOf('NOTIFICATION_DISMISSAL'),
          openedEditPages: [], spaRoutePages: [], movedPages: [], replayedMove: null,
        };
      }
      // COV-2c（SREV-COV の I-4）: 作り直しの押し直し。凍結した Context で、押下の並びを押し直して移り先だけを返す（リンクは読まない。記録は書かない）。
      if (options.replayMove !== undefined) {
        const replayObservation = factory.submissionObservationOf(page.context());
        let replayedMove: SubmissionProbeReplayedMove | null = null;
        if (replayObservation !== null) {
          await trackOnScreen(page, factory.pinAuthenticatedStateBeforeProbe(page.context()));
          enterSubmissionProbe(null);
          replayedMove = await replaySubmissionProbeMove(page, replayObservation, discovered, options.replayMove, {
            quietWaitMs: options.submissionProbeQuietWaitMs,
            onPress: () => enterSubmissionProbe(null),
            dataActivity: () => counter.dataActivity(),
          });
        }
        return {
          record: discovered, links: [], preferredLinks: new Set<string>(), frames: [], structureKey: unreadStructureKeyOf('REPLAY_MOVE'),
          openedEditPages: [], spaRoutePages: [], movedPages: [], replayedMove,
        };
      }
      const base = options.reprobe?.record ?? discovered;
      // COV-2: 押す前の状態の構造の鍵（待ち行列に渡す。場所のない記録は代わりの digest）。
      // 読み込み直した画面では使わないので読まない。
      const structureKey = discovered.location === null || options.reprobe !== undefined
        ? unreadStructureKeyOf(options.reprobe === undefined ? 'NO_LOCATION' : 'REPROBE')
        : await pageStateStructureKeyOf(page, discovered.location);
      screen.structureKey = structureKey;
      let links: readonly string[] = [];
      let preferredLinks: ReadonlySet<string> = new Set();
      let excludedLinks: readonly string[] = [];
      let frames: readonly FrameDocument[] = [];
      if (options.reprobe === undefined) {
        try {
          const found = await trackOnScreen(page, discoverLinks(page, options.pageId, options.linkPolicy));
          // COV-2: 許可 Origin の中のリンクの行き先は、query の名前と値を持つ形（書かれた `href` を画面の URL で解決した URL。切り詰めた `href` は受け入れの
          // 判定の URL）で渡す（場所の鍵の正規化は待ち行列が行う）。
          const destinationOf = (link: (typeof found.links)[number]): string => {
            const admitted = link.normalized.ok ? link.normalized.url : '';
            if (link.truncated) return admitted;
            try {
              return new URL(link.rawHref, page.url()).href;
            } catch {
              return admitted;
            }
          };
          // 受け入れたリンクの見分けは、巡回の部品（`internalNavigableUrlsOf`）に任せる。SD-1: リンクの文字が削除の語に当たるリンクへは移らない
          // （`destructiveLinkTextUrlsOf`）。URL の削除の語は、下の除外の判定（`isExcludedCrawlCandidate`）が除外の記録つきで外す。
          const admittedUrls: ReadonlySet<string> = new Set(internalNavigableUrlsOf(found.links));
          const destructiveTextUrls = destructiveLinkTextUrlsOf(found.links);
          const admittedLinks = found.links.filter((link) => link.normalized.ok && admittedUrls.has(link.normalized.url));
          const internal = admittedLinks.filter((link) => link.normalized.ok && !destructiveTextUrls.has(link.normalized.url));
          links = internal.map(destinationOf);
          excludedLinks = admittedLinks.filter((link) => link.normalized.ok && destructiveTextUrls.has(link.normalized.url)).map(destinationOf);
          preferredLinks = new Set(internal.flatMap((link) => (isCreatePageLink(link) ? [destinationOf(link)] : [])));
        } catch {
          // リンクを読めなければ、その画面からは先へ進まない（読み込みを足して読み直さない）。
        }
        // COV-2（設計書 3.2 の 1）: 同じ Origin の子の frame の文書の URL（frame の URL を読むだけ。ページに何もしない）。
        const pageOrigin = new URL(url).origin;
        // COV-2b: frame の入れ子の深さ（main frame の子が 1）も持つ（場所の鍵の frame の印にする）。
        frames = page.frames().flatMap((frame) => {
          if (frame === page.mainFrame()) return [];
          try {
            const frameUrl = frame.url();
            let depth = 0;
            for (let parent = frame.parentFrame(); parent !== null; parent = parent.parentFrame()) depth += 1;
            return /^https?:/iu.test(frameUrl) && isOriginInAllowedOrigins([pageOrigin], new URL(frameUrl).origin) ? [{ url: frameUrl, depth }] : [];
          } catch {
            return [];
          }
        });
      }
      screen.links = links;
      screen.preferredLinks = preferredLinks;
      screen.excludedLinks = excludedLinks;
      screen.frames = frames;
      // T37c: 1 画面の流れの最後に、送らずに観察する probe（押すと SPA の router が URL を変えうるので、リンクの抽出の後）。観察の口がない Context では
      // 行わない。読み込み直しはしない。
      const observation = factory.submissionObservationOf(page.context());
      // T37R-fix-B（T37R の I-1）: 押す前に、閉じるときに次の Context へ渡す状態を読んでおく（押下でページが書き換えた localStorage・Cookie を受け継がず、
      // 鍵の消失もこの状態で判定する）。probe を行わない Context は今のまま（閉じるときに読む）。
      // DEF-144・SAFE-2 の 4（違反の区分の (3)）: 外部スキームの移動・frame の判定の失敗・読み取りの main frame の移動の失敗は、違反でなく Safety の記録になった。
      // 押下の後に、違反の有無によらず記録から続け方を決める（`probeRecordContinuationOf`）。probe の段の前からの記録は、押した候補に結びつけない。
      const recordBeforeProbe = probeRecordContinuationOf(ledger.snapshot()) !== null;
      /** それまでに記録があれば、今押している候補と、その続け方に結びつける（最初の 1 回だけ）。 */
      const settleCulprit = (): void => {
        if (recordBeforeProbe || probe.culprit !== null || probe.current === null) return;
        const continuation = probeRecordContinuationOf(ledger.snapshot());
        if (continuation !== null) {
          probe.culprit = probe.current;
          probe.continuation = continuation;
        }
      };
      if (observation !== null && options.linksOnly !== true) {
        await trackOnScreen(page, factory.pinAuthenticatedStateBeforeProbe(page.context()));
        // DEF-144: ここから probe の段（安全の違反を、この段と、押した候補に結びつける）。
        enterSubmissionProbe(null);
      }
      const record = observation === null || options.linksOnly === true ? base : await probeDiscoveredSubmissions(page, observation, base, {
        targetPolicy: {
          allowedOrigins: options.classificationPolicy.allowedOrigins,
          // ログインの画面（セッションの切れの path）と、監査の段の除外に当たる画面は押さない（巡回の候補の除外と同じ判定。owner の関数を使う）。
          isExcludedPage: (location) => isExcludedCrawlCandidate(`${location.origin}${location.path}`, options.linkPolicy.allowedOrigins, options.authentication),
        },
        quietWaitMs: options.submissionProbeQuietWaitMs,
        // L6/L3-1: 見張りが画面を終えた後は、見放した押下の知らせ（押した組・枠のボタン・移り先など）を受けない（`live`）。
        sharedLayout: options.sharedLayout === undefined ? undefined : { pressed: options.sharedLayout.pressed, onPressed: live(options.sharedLayout.onPressed) },
        // DEF-144: 押す候補（送信ボタンの語と識別の digest。値を持たない）。前の押下の後の違反は、前の押下に結びつける。
        // LU-4（K6）: 押した後に開いた窓の中の候補は、記録の末尾に足されて `base` にないので、押す部品が渡す候補を使う。
        // SREV-1105-3 の Important-2: 結び付けの印は、欄に入れる前に付ける（押せずに押さなかった候補でも、欄に入れる間の違反をその候補に結びつける）。
        onPress: live((candidateIndex: number, candidate: DiscoveryCandidate | undefined) => {
          settleCulprit();
          probe.current = candidateIndex;
          enterSubmissionProbe(candidate === undefined ? null : { submitterWords: candidate.submitterWords, identityDigest: candidate.identityDigest });
        }),
        // 押した押下を数える（記録だけ。COV-1b: 押す数の上限と、入れたのに押せなかった回の上限はない）。
        onPressCounted: live(() => {
          probe.pressed += 1;
        }),
        onlyCandidates: options.reprobe?.candidates,
        // COV-2: 操作さがし全体の押した組（番号だけ違う同じ作りの画面では押し直さない）、押さないまま残った候補と作り直す押下の並び、候補の見分けの鍵。
        pressRegistry: options.pressRegistry === undefined ? undefined : {
          hasPressed: (key) => options.pressRegistry?.hasPressed(key) === true,
          acceptPress: (key) => !screen.ended && options.pressRegistry?.acceptPress(key) === true,
        },
        replay: options.reprobe?.replay,
        candidateKeys: options.reprobe?.candidateKeys,
        // COV-3（網羅の設計書 3.3）: 選択肢を選んで出た、まだ見ていない構造の鍵の段（その状態を作る並び）。読み込み直し、たどり直して、その段で押す。
        onOptionStage: live((trail: readonly SubmissionProbeReplayStep[]) => {
          probe.optionStages.push(trail);
        }),
        // COV-3: 選んだ後の落ち着きの待ちに渡す、この画面の要求の今の数（進行中の要求の数え方）。
        dataActivity: () => counter.dataActivity(),
        onLeftBehind: live((candidateIndex: number, replay: readonly SubmissionProbeReplayStep[]) => {
          probe.leftBehind.set(candidateIndex, replay);
        }),
        onCandidateKeys: live((keys: ReadonlyMap<number, string>) => {
          probe.candidateKeys = keys;
        }),
        // DEF-190（設計書 5.8 の 1）: 移った先が、押した画面の 1 つ下の番号の path の編集の画面なら覚える（条件は `openedEditPageOf` の 1 か所）。
        onOpenerPageChanged: live((movedUrl: string, move: SubmissionProbeOpenerMoveFacts) => {
          const opened = openedEditPageOf(url, movedUrl, {
            allowedQueryParameters: options.allowedQueryParameters, allowedOrigins: options.linkPolicy.allowedOrigins, authentication: options.authentication,
          });
          if (opened !== null) openedEditPages.push({ ...opened, ...move });
        }),
        // DEF-221（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.2 の 1）: 同じ文書のまま変わった URL が、承認したテストの Origin の中の
        // 読んでよい画面なら覚える（条件は `spaRoutePageOf` の 1 か所。DEF-190 と共通の条件を使う）。
        // COV-2c（SREV-COV の I-3・I-4）: 値に目印を含む query の名前と押下の並びも持つ（場所の鍵と記録で目印の値を伏せ、再開の後に作り直す）。
        onSameDocumentUrlChanged: live((changedUrl: string, move: SubmissionProbeMoveFacts) => {
          const route = spaRoutePageOf(url, changedUrl, {
            allowedQueryParameters: options.allowedQueryParameters, allowedOrigins: options.linkPolicy.allowedOrigins, authentication: options.authentication,
            approvedTestOrigins: options.classificationPolicy.allowedOrigins,
          });
          if (route !== null && !spaRoutePages.some((other) => other.url === route)) spaRoutePages.push({ url: route, ...move });
        }),
        // COV-2c（SREV-COV の I-1 の 3）: 押す輪の中でも、停止と Run の時間の上限を見る。
        shouldStop: options.shouldStop,
        // COV-2b（網羅の設計書 3.2 の 1）: 押下で文書が替わった GET の移り先が、読んでよい画面なら覚える（条件は `movedPageOf` の 1 か所。query はそのまま持つ）。
        onPageMoved: live((moved: SubmissionProbeMovedPage) => {
          const readable = movedPageOf(url, moved.url, {
            allowedQueryParameters: options.allowedQueryParameters, allowedOrigins: options.linkPolicy.allowedOrigins, authentication: options.authentication,
          });
          if (readable !== null && !movedPages.some((other) => other.url === moved.url)) movedPages.push(moved);
        }),
        // L6/L3-1: 見張りが画面を終えたときの記録の作り方を受け取る。
        // L10 の調べの直し: 押す輪の中で外部スキーム・frame の判定の失敗の記録が入ったら、この文書を使うのをやめる（今の候補は記録から `EXTERNAL_SCHEME`、残りは
        // 読み込み直した文書で押す）。probe の段の前からの記録は見ない（押した候補に結びつけないのと同じ）。
        documentUnusable: () => !recordBeforeProbe && probeRecordContinuationOf(ledger.snapshot()) === 'EXTERNAL_SCHEME',
        onRecordSnapshot: (snapshot) => {
          screen.snapshot = snapshot;
        },
      });
      settleCulprit();
      return { record, links, preferredLinks, excludedLinks, frames, structureKey, openedEditPages, spaRoutePages, movedPages, replayedMove: null };
    }, { quietLimitMs: options.progressQuietLimitMs });
    switch (watched.status) {
      case 'FULFILLED':
        return watched.value;
      case 'REJECTED':
        // セッションの切れの知らせ（`stopIfSessionLostAfterSettling`）などは、今どおり外へ投げる。
        throw watched.reason;
      case 'ENDED': {
        // L6/L3-1: 見張りが画面を終えた。押しにかかった対象の記録を残し、残りの対象と画面の記録に理由を付けて、次の画面へ進む（読み込み直さない）。
        screen.ended = true;
        const end = watched.end === 'STAGE_NEVER_QUIET' ? 'STAGE_NEVER_QUIET' : 'STAGE_UNRESPONSIVE';
        probe.leftBehind = new Map();
        probe.optionStages = [];
        const pageLocation = page.isClosed() ? null : locationOfUrl(page.url());
        const partial = screen.snapshot?.(end) ?? screen.discovered ?? Object.freeze({
          location: pageLocation === null || pageLocation.url === null ? null : pageLocation.location, incompleteReasons: Object.freeze([]), candidates: Object.freeze([]),
        });
        return {
          record: withIncompleteReason(partial, end), links: screen.links, preferredLinks: screen.preferredLinks, excludedLinks: screen.excludedLinks,
          frames: screen.frames,
          structureKey: screen.structureKey ?? unreadStructureKeyOf(end),
          openedEditPages: [...openedEditPages], spaRoutePages: [...spaRoutePages], movedPages: [...movedPages], replayedMove: null,
        };
      }
    }
  });
  const safetyOf = (violation: boolean): PageVisitSafety => ({ violation, safetyViolation: violation ? safety.violation : null });
  switch (visit.kind) {
    case 'VISITED':
      if (visit.value === 'NAVIGATION_FAILED' || visit.value === 'HTTP_ERROR_STATUS' || visit.value === 'SITE_UNAVAILABLE') {
        return { kind: visit.value, ...safetyOf(visit.violation), ...(failedAfterRoot ? { afterRoot: true as const } : {}) };
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
          preferredLinks: visit.value.preferredLinks,
          excludedLinks: visit.value.excludedLinks ?? [],
          frames: visit.value.frames,
          structureKey: visit.value.structureKey,
          openedEditPages: visit.value.openedEditPages,
          spaRoutePages: visit.value.spaRoutePages,
          movedPages: visit.value.movedPages,
          replayedMove: visit.value.replayedMove,
          blockedRequests: visit.blockedRequests,
          frozenReads: frozenReadCountsOf(visit.pageLoad),
          probe: { culprit: probe.culprit, continuation: probe.continuation, pressed: probe.pressed, leftBehind: probe.leftBehind, candidateKeys: probe.candidateKeys, optionStages: probe.optionStages },
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
 * DEF-144・DEF-145・SAFE-2 の 4: probe の押下の後に、Safety の記録から続け方が決まった画面か（`probeRecordContinuationOf` の結果と、押した候補が分かること）。
 * 外部スキームへの移動（DEF-144）と、押下で始まった読み取りの移動の取り消し（DEF-145）。違反ではないので、違反の有無によらない。
 */
const continuesAfterRecord = (visit: PageVisit): visit is Extract<PageVisit, { readonly kind: 'READ' }> =>
  visit.kind === 'READ' && visit.probe.culprit !== null && visit.probe.continuation !== null;

/**
 * 記録を出した押下の候補の結果を当てた記録。外部スキームへの移動は `EXTERNAL_SCHEME`（DEF-144）、読み取りの移動の取り消しは `PAGE_CHANGED`（DEF-145。押す前に
 * 入れた欄の数と識別は、押下の記録のまま）。
 */
const withRecordCulprit = (record: DiscoveryReadPageRecord, visit: PageVisit): DiscoveryReadPageRecord => {
  const culprit = visit.kind === 'READ' ? visit.probe.culprit : null;
  if (culprit === null || visit.kind !== 'READ') {
    return record;
  }
  const pressed = record.candidates[culprit]?.submissionProbe;
  // LU-4: 開き手の後に押した候補の、開き手の事実（`opener`）は、作り直した記録にも写す。
  const probe = visit.probe.continuation === 'EXTERNAL_SCHEME'
    ? externalSchemeSubmissionProbeOf(pressed?.opener)
    : notObservedSubmissionProbeOf(
      'PAGE_CHANGED',
      { filledFieldCount: pressed?.filledFieldCount ?? 0, skippedFieldCount: pressed?.skippedFieldCount ?? 0 },
      pressed?.inputFields ?? [],
      pressed?.opener,
    );
  return withSubmissionProbes(record, new Map([[culprit, probe]]));
};

/**
 * DEF-144・COV-2: 押さないまま残った候補の位置と、その状態を作り直す押下の並び。Guard が Context を閉じたので押せなかった候補（並びが分からなければ空の並び）と、
 * 押す部品が知らせた、段や画面が移って押さないまま残った候補（`PAGE_CHANGED`）。
 */
const remainingCandidatesOf = (
  record: DiscoveryReadPageRecord,
  leftBehind: ReadonlyMap<number, readonly SubmissionProbeReplayStep[]>,
): ReadonlyMap<number, readonly SubmissionProbeReplayStep[]> => new Map(record.candidates.flatMap((candidate, index) => {
  const reason = candidate.submissionProbe?.reason;
  if (reason === CONTEXT_CLOSED_BY_GUARD_REASON) {
    return [[index, leftBehind.get(index) ?? []] as const];
  }
  const replay = leftBehind.get(index);
  return reason === 'PAGE_CHANGED' && replay !== undefined ? [[index, replay] as const] : [];
}));

/** DEF-208-1: page の読み込みの事実から、凍結の後に通した読み取りの数を取り出す（書いていない事実は 0）。 */
const frozenReadCountsOf = (facts: PageLoadFacts): DiscoveryFrozenReadCounts => Object.freeze({
  passed: facts.frozenReadRequests ?? 0,
  carryingMarker: facts.frozenMarkerReadRequests ?? 0,
  // DEF-233: 凍結の後に通したサイトの token の更新の数。
  tokenRefreshes: facts.frozenTokenRefreshRequests ?? 0,
});

/** DEF-208-1: 2 回の読み込みの、凍結の後に通した読み取りの数を足す（DEF-233: token の更新の数も）。 */
const sumFrozenReads = (left: DiscoveryFrozenReadCounts, right: DiscoveryFrozenReadCounts): DiscoveryFrozenReadCounts => Object.freeze({
  passed: left.passed + right.passed,
  carryingMarker: left.carryingMarker + right.carryingMarker,
  tokenRefreshes: (left.tokenRefreshes ?? 0) + (right.tokenRefreshes ?? 0),
});

/** DEF-144: probe の外部スキームの違反の後に、その画面を続けた結果（RB-8: 単体の確かめのため公開）。 */
export interface ContinuedPage {
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
 * 候補を `EXTERNAL_SCHEME` にし、押せなかった残りの候補を、新しい Context でその画面を読み込み直して（読み込みの間隔とサービスへの要求の待ちは
 * `visitGuardedPage` の pacer が守る）押す。読み込み直しでも同じ違反が起きたら、その候補も `EXTERNAL_SCHEME` にする。ほかの種類の違反とセッションの切れは、
 * 止めるべきこととして返す。DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.1）: 押下で始まった読み取り（GET・HEAD）の移動が
 * 取り消された違反（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）も、同じ部品で続ける（その候補は `PAGE_CHANGED`）。
 * COV-1b・COV-2（網羅の設計書 3.2 の 2・3.3）: 違反のない画面でも、段や画面が移って押さないまま残った候補（`PAGE_CHANGED`）があれば、読み込み直し、押下の並び
 * をたどってその状態を作り直してから押す。押す数と読み込み直しの回数の上限はない。押していない候補が残り、前の読み込み直しで残りが減った間は続ける。
 * 読み込み直しの要らない画面は `null`。
 */
export async function reprobeRemaining(
  first: Extract<PageVisit, { readonly kind: 'READ' }>,
  reload: (reprobe: PageReprobe) => Promise<PageVisit>,
  /** COV-2c（SREV-COV の I-1 の 3）: 利用者の停止か Run の時間の上限に届いたか（真なら読み込み直さない）。 */
  shouldStop: () => boolean,
): Promise<ContinuedPage | null> {
  if (first.violation) {
    // 違反: 今どおり、呼ぶ側が止める（SAFE-2 の 4: 続けられる形は、違反でなく記録になった）。
    return null;
  }
  // SAFE-2 の 4: 違反の中身は、続ける画面では出ない（記録で続ける）。前の成果物の欄（`safetyViolations`）は、違反が混ざらない限り空。
  const safetyViolations: JobSafetyViolation[] = [];
  const recordContinued = continuesAfterRecord(first);
  let visit: Extract<PageVisit, { readonly kind: 'READ' }> = recordContinued ? { ...first, record: withRecordCulprit(first.record, first) } : first;
  let leftBehind = new Map(first.probe.leftBehind);
  let candidateKeys = first.probe.candidateKeys;
  /** COV-3: 選択肢を選んで出た段を作る並び（出た順。押していない候補の後に、1 つの段に 1 回ずつ読み込み直す）。 */
  const optionStages = [...first.probe.optionStages];
  /** COV-1b・COV-3: 読み込み直しても進みのなかった候補（もう読み込み直さない。選択肢の段は続ける）。 */
  const givenUp = new Set<number>();
  const remainingOf = (): ReadonlyMap<number, readonly SubmissionProbeReplayStep[]> =>
    new Map([...remainingCandidatesOf(visit.record, leftBehind)].filter(([index]) => !givenUp.has(index)));
  let remaining = remainingOf();
  if (remaining.size === 0 && optionStages.length === 0) {
    // 記録で候補の結果を当てた画面は、読み込み直さずに、当てた記録を返す。
    return recordContinued ? { visit, safetyViolations, reloaded: false, stop: null } : null;
  }
  let reloaded = false;
  let stop: ContinuedPage['stop'] = null;
  // COV-1b（網羅の設計書 3.3）: 押していない候補が残り、前の読み込み直しで進み（残りの候補が減った）があった間は続ける。COV-3: 選択肢を選んで出た段は、
  // 押していない候補の後に、段ごとに 1 回読み込み直す（選んで出た段は、まだ見ていない構造の鍵のときだけ出るので、終わる）。
  while (remaining.size > 0 || optionStages.length > 0) {
    if (shouldStop()) {
      break;
    }
    const optionStage = remaining.size === 0 ? optionStages.shift() : undefined;
    let group: ReadonlySet<number>;
    let replay: readonly SubmissionProbeReplayStep[];
    if (optionStage !== undefined) {
      // COV-3: 選択肢の段は、押す候補を前の記録から選ばない（押す部品が、たどり直した後の段の対象を押す）。
      group = new Set();
      replay = optionStage;
    } else {
      // 同じ押下の並びで作り直せる候補をまとめて、1 回の読み込み直しで押す。
      const [firstIndex] = remaining.keys();
      replay = firstIndex === undefined ? [] : remaining.get(firstIndex) ?? [];
      const replayText = JSON.stringify(replay);
      group = new Set([...remaining].flatMap(([index, steps]) => (JSON.stringify(steps) === replayText ? [index] : [])));
    }
    const second = await reload({ record: visit.record, candidates: group, replay, candidateKeys });
    reloaded = true;
    if (second.kind === 'SESSION_LOST') {
      stop = second;
      break;
    }
    if (second.kind !== 'READ') {
      // 読み込み直しで読めなかった画面（失敗・不調・エラーの状態）は、残りの候補を押せなかったままにする。
      if (second.violation) stop = { kind: 'VIOLATION', safetyViolation: second.safetyViolation };
      break;
    }
    const merged = {
      blockedRequests: visit.blockedRequests + second.blockedRequests,
      frozenReads: sumFrozenReads(visit.frozenReads, second.frozenReads),
      // DEF-190・DEF-221: 読み込み直した画面の押下で移った先の編集の画面と、同じ文書のまま変わった URL も足す（重なりは待ち行列が除く）。
      openedEditPages: [...visit.openedEditPages, ...second.openedEditPages],
      spaRoutePages: [...visit.spaRoutePages, ...second.spaRoutePages],
      movedPages: [...visit.movedPages, ...second.movedPages],
    };
    if (second.violation) {
      visit = { ...visit, ...merged };
      stop = { kind: 'VIOLATION', safetyViolation: second.safetyViolation };
      break;
    } else {
      // SAFE-2 の 4: 読み込み直しでも記録が出たら、その候補の結果を当てる。
      visit = { ...visit, ...merged, record: withRecordCulprit(second.record, second) };
    }
    leftBehind = new Map([...leftBehind].filter(([index]) => !group.has(index)));
    for (const [index, steps] of second.probe.leftBehind) leftBehind.set(index, steps);
    candidateKeys = second.probe.candidateKeys ?? candidateKeys;
    optionStages.push(...second.probe.optionStages);
    const next = remainingOf();
    // 候補の読み込み直しで進みがなければ、その候補はもう読み込み直さない（選択肢の段は続ける）。
    if (optionStage === undefined && next.size >= remaining.size) {
      for (const index of next.keys()) givenUp.add(index);
    }
    remaining = remainingOf();
  }
  return { visit, safetyViolations, reloaded, stop };
}

/**
 * DEF-200: 状態の保存が、続きにしてよいものか（Run の ID が Run のディレクトリの名前と同じ、前のジョブの ID、認証の設定とターゲット設定の SHA-256 が同じ）。
 * 形は読む口（`readDiscoveryCheckpoint`）がスキーマで確かめた。合わなければ `null`（壊れた・別の Run の保存を使わない。SFIX-1104 の M-2: 呼ぶ側は止める）。
 */
const usableDiscoveryCheckpointOf = (
  value: unknown,
  runDirectory: string,
  options: DiscoveryCheckpointOptions & { readonly resume: NonNullable<DiscoveryCheckpointOptions['resume']> },
  crawlConfig: AuditConfig['crawl'],
): DiscoveryCheckpointDocument | null => {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const document = value as DiscoveryCheckpointDocument;
  if (
    document.runId !== basename(runDirectory)
    || document.jobId !== options.resume.previousJobId
    || document.authenticationSha256 !== options.identity.authenticationSha256
    || document.targetConfigSha256 !== options.identity.targetConfigSha256
  ) {
    return null;
  }
  // SFIX-1104-2（SREV-1104-2 の M2）: 待ち行列と採番器を、続きと同じ部品で作り直せるかを、Run を始める前（ブラウザの起動の前）に確かめる（正規化の形でない
  // URL など、スキーマに通っても作り直せない保存は使えない）。
  // COV-2: 待ち行列は `CoverageQueue.restore`（場所の鍵と伏せた URL の食い違いなども確かめる）、採番器は `IdAllocator.restore` で作り直せるかを確かめる。
  try {
    CoverageQueue.restore(document.coverage);
    IdAllocator.restore(document.allocator);
  } catch {
    return null;
  }
  return document;
};

/**
 * DEF-200: 前の実行の Run のディレクトリで、続きの Run を始める（出力先の監査中の印は、新しい Run と同じ部品。ほかの起動が持っていれば `RUN_ACTIVE`）。
 * 印を持てたかを決められなければ `null`（SFIX-1104 の M-2: 呼ぶ側は新しい Run を始めずに止める）。
 */
async function resumeDiscoveryWorkerRun(
  outputDirectory: string,
  runDirectory: string,
  startedAt: Date,
): Promise<Extract<WorkerRunStart, { readonly kind: 'STARTED' }> | Extract<WorkerRunStart, { readonly kind: 'RUN_ACTIVE' }> | null> {
  const runLock = await acquireRunExclusion(outputDirectory);
  switch (runLock.kind) {
    case 'HELD':
      return { kind: 'RUN_ACTIVE', exitCode: RUN_UNAVAILABLE_EXIT_CODE };
    case 'UNAVAILABLE':
      return null;
    case 'ACQUIRED':
      return { kind: 'STARTED', runId: basename(runDirectory) as RunId, runDirectory, startedAt, releaseLock: runLock.release };
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
  // DEF-200（設計書 3.4 の 9）: ログインし直した続きなら、前の実行の Run のディレクトリの状態の保存を読み、使えるときだけ同じ Run の続きにする。
  const checkpointOptions = request.checkpoint;
  const resume = checkpointOptions?.resume;
  const resumeRunDirectory = resume === undefined ? null : resolve(resume.runDirectory);
  const saved = checkpointOptions === undefined || resume === undefined || resumeRunDirectory === null
    ? null
    : usableDiscoveryCheckpointOf(await writer.readDiscoveryCheckpoint(resumeRunDirectory), resumeRunDirectory, { ...checkpointOptions, resume }, config.crawl);
  const resumed = saved === null || resumeRunDirectory === null
    ? null
    : await resumeDiscoveryWorkerRun(outputDirectory, resumeRunDirectory, dateOfCompactUtcTimestamp(saved.startedAt));
  if (resumed !== null && resumed.kind === 'RUN_ACTIVE') {
    return resumed;
  }
  // SFIX-1104（SREV-1104 の M-2）: ログインし直した続きで、状態の保存が使えない・その Run を続けられないときは、新しい Run を始めずに止める（読む数を増やさない。
  // 前の Run はセッションの切れで止まったまま）。
  if (resumeRunDirectory !== null && resumed === null) {
    return { kind: 'RESUME_UNAVAILABLE', runId: basename(resumeRunDirectory) as RunId, runDirectory: resumeRunDirectory, exitCode: RUN_UNAVAILABLE_EXIT_CODE };
  }
  const run = resumed ?? await startWorkerRun(outputDirectory, request.clock);
  if (run.kind !== 'STARTED') {
    return run;
  }
  const { runId, runDirectory, startedAt } = run;
  // DEF-200: 1 画面ごとの状態の保存（ワーカーが続きの値を渡したときだけ）。
  const saveCheckpoint = checkpointOptions === undefined
    ? null
    : async (state: DiscoveryCrawlCheckpoint): Promise<void> => {
      const document: DiscoveryCheckpointDocument = {
        schemaVersion: DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
        runId,
        jobId: request.jobId,
        authenticationSha256: checkpointOptions.identity.authenticationSha256,
        targetConfigSha256: checkpointOptions.identity.targetConfigSha256,
        startedAt: formatCompactUtcTimestamp(startedAt, DISCOVERY_TIME_SUBJECT),
        ...state,
      };
      await writer.writeDiscoveryCheckpoint(runDirectory, document);
    };
  try {
    // 知らせの口の例外でも、監査中の印を離す（finally の `endWorkerRun`。REV-SPEC2 第 2 回の M-6）。
    observer.onRunStarted({ runId, runDirectory });
    const crawled = await crawl(request, outputDirectory, observer, resumed === null ? null : saved, saveCheckpoint);
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
      ...(crawled.maxPages === undefined ? {} : { maxPages: crawled.maxPages }),
      pages: crawled.pages,
      // L7（N34）: 読まなかった画面を件数で打ち切らないので、いつも 0（古い版の成果物を読むための項目）。
      omittedUnreadPages: crawled.omittedUnreadPages,
      // COV-2c の M-1: 祖先を最初から凍結して読めず、今の形に戻した回数（あるときだけ）。
      ...((crawled.frozenStartFallbacks ?? 0) > 0 ? { frozenStartFallbacks: crawled.frozenStartFallbacks } : {}),
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
      // COV-1b: 押す数の上限はないので、押す数の上限で押せなかった候補の数（`pressLimitProbes`）は書かない。COV-2: 伏せた URL は祖先の読み直しで埋めるので、
      // 伏せた URL をその形のまま読んだ画面の数（`resumedRedactedUrlPages`）も書かない（どちらも古い版の成果物を読むための項目）。
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
    // 保存の状態は書かない（再開の対象にしない）。出力先のロックを離す。
    await endWorkerRun(run);
  }
}

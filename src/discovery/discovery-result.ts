// 発見のジョブの成果物 `discovery.json` の形と、組み立てとまとめの純粋な部品（Task 27 の設計書 4.2、4.4、4.6 と、変更履歴の
// 「T27b・T27c の報告と T27d の前の判断」「Blocker: T27d」の行。T27d）。
// - 成果物の形（`DiscoveryDocument`）の SSOT。JSON Schema（`schemas/discovery.schema.json`）の enum と上限は、ここの一覧と定数に一致する
//   （`tests/unit/discovery-result.test.ts`、`tests/unit/schema-enum-consistency.test.ts`）。候補の形は `candidate.schema.json` を参照する
//   （書き写さない）。
// - 書くのはワーカー（`src/worker/discovery-run.ts`）が ArtifactWriter で、読むのはジョブの管理（`src/control/job/audit-job-manager.ts`）。
//   どちらも、ここの関数で、読んだ画面・件数の要約・Run Status・候補のまとめを求める（意味の owner を 1 つにする）。
// - 候補のまとめ（`mergeDiscoveryCandidates`）: 同じジョブの中で、同じ識別の digest の候補が中身（規則の digest・分類・理由のコード・状態の欄の
//   印）まで同じなら 1 件にし、違えば 1 件にまとめて `DISPLAY_ONLY`・`DUPLICATE_IDENTITY_CONFLICT` にする（READ の対象にしない）。まとめる場所は、
//   索引に渡す前のここだけ。
// - 純粋な定義と関数だけのファイル。Playwright、ブラウザ、`node:fs`、`src/control/`、監査エンジン、発見のブラウザの部品を import しない
//   （`tests/architecture/discovery-boundary.test.ts` の (x)）。そのため、画面の記録の形（`DiscoveryReadPageRecord`）はここに置き、発見の入口
//   （`discover-page.ts`。ブラウザの部品）は、この型を返す（型は 1 つ。PRE42-CC 組 5b。CC-070 (a)。Gate `run-lock-session-ownership` の (g)）。
// - T37a（Task 37 の設計書 3.1）: 監査の段の口のあるジョブの記録。終わり方 `SERVICE_REQUEST_LIMIT_REACHED`、鍵の消失の詳しい理由
//   （`endReasonDetail`。閉じた一覧 `JOB_END_REASON_DETAILS`）、監査の段の数（任意の `authentication`。`run.json` と同じ形）、サービスの読み取りが
//   届かなかった画面の印（`SERVICE_READ_REFUSED`。読み切れなかった画面に数える）。READ の確かめの成果物（`read-check-evaluation.ts`）も、詳しい理由の
//   一覧と数の比べ方をここから使う。成果物の版を 1.1 に上げた。
import type { AuditSendPolicyName } from '../core/audit-send-policy.js';
import { SESSION_KEY_LOST_DETAIL, type JobSafetyViolation, type RunAuthenticationSummary, type RunStatus } from '../core/contracts.js';
import type { SessionLossEvidence } from '../core/evidence-types.js';
import { deriveRunStatus } from '../core/status.js';
import { compareCodeUnits } from '../core/text.js';
import {
  CANDIDATE_REASON_CLASSIFICATIONS,
  INCOMPLETE_REASONS,
  type CandidateLocation,
  type CandidateReasonCode,
  type DiscoveryCandidate,
  type IncompleteReason,
} from './candidate-contracts.js';
import {
  EXTERNAL_SCHEME_PROBE_REASON as EXTERNAL_SCHEME_REASON,
  PRESS_LIMIT_PROBE_REASON as PRESS_LIMIT_REASON,
  hasSubmissionProbePriorityWord,
  submissionProbeWriteOf,
} from './submission-probe-contracts.js';

/** 成果物の版（書き手が書く版）。T37a: 1.1（終わり方・詳しい理由・監査の段の数・画面の理由を足した）。 */
export const DISCOVERY_ARTIFACT_SCHEMA_VERSION = 'discovery-schema/1.1';

/**
 * 読み手が受ける版（スキーマの `schemaVersion` の enum。T37a fix round 1）。LG-4（テストの組の設計書 3.7.3）: 前の版（1.0）は捨て、今の版だけを受ける
 * （前の版の成果物は、スキーマに合わないので、画面の候補の詳細・READ の確かめの対象の画面・シナリオの候補の探しで読めないものとして扱う）。
 * 版を上げるときは、前の版をここに残すかを決める（最後が書き手の版 `DISCOVERY_ARTIFACT_SCHEMA_VERSION`）。
 */
export const DISCOVERY_ARTIFACT_READABLE_SCHEMA_VERSIONS = Object.freeze([DISCOVERY_ARTIFACT_SCHEMA_VERSION] as const);
export type DiscoveryArtifactSchemaVersion = (typeof DISCOVERY_ARTIFACT_READABLE_SCHEMA_VERSIONS)[number];

/**
 * ジョブの終わり方の詳しい理由（T37a。閉じた一覧。発見と READ の確かめの成果物の任意の項目 `endReasonDetail`）。
 * - `session-key`: ログインの状態の鍵がなくなったことで、セッションの切れとみなした（終わり方は `AUTH_SESSION_LOST`。値の owner は
 *   `src/core/contracts.ts` の `SESSION_KEY_LOST_DETAIL`。Run の理由の `detail` と同じ値）。セッションの切れの path による切れは、この項目を持たない。
 */
export const JOB_END_REASON_DETAILS = Object.freeze([SESSION_KEY_LOST_DETAIL] as const);
export type JobEndReasonDetail = (typeof JOB_END_REASON_DETAILS)[number];

/** サービスの読み取りが届かなかった画面の理由（T37a。`INCOMPLETE_REASONS` の 1 つ）。 */
export const SERVICE_READ_REFUSED_REASON = 'SERVICE_READ_REFUSED' satisfies IncompleteReason;

/** DEF-129: ページが始めた main frame の読み込みを上限で止めた画面の理由（`INCOMPLETE_REASONS` の 1 つ）。 */
export const PAGE_NAVIGATION_LIMIT_REASON = 'INCOMPLETE_PAGE_NAVIGATION_LIMIT' satisfies IncompleteReason;

/** DEF-130-fix: ページが出す文書でない要求を上限で止めた画面の理由（`INCOMPLETE_REASONS` の 1 つ）。 */
export const PAGE_SUBRESOURCE_LIMIT_REASON = 'INCOMPLETE_PAGE_SUBRESOURCE_LIMIT' satisfies IncompleteReason;

/**
 * DEF-129・DEF-130-fix: Guard が上限で止めた読み込みの事実（`src/safety/passive-request-guard.ts` の `PageLoadFacts` の一部）から、画面の不完全の
 * 理由（発見と、READ の確かめの候補の読み取りが共有する唯一の写し方）。
 */
export const pageLoadIncompleteReasonsOf = (facts: { readonly limitReached: boolean; readonly subresourceLimitReached: boolean }): readonly IncompleteReason[] => {
  const reasons: IncompleteReason[] = [];
  if (facts.limitReached) reasons.push(PAGE_NAVIGATION_LIMIT_REASON);
  if (facts.subresourceLimitReached) reasons.push(PAGE_SUBRESOURCE_LIMIT_REASON);
  return Object.freeze(reasons);
};

/** 同じ識別の digest で中身の違う候補を 1 件にまとめたときの理由のコード（分類は `DISPLAY_ONLY`）。 */
export const DUPLICATE_IDENTITY_CONFLICT_REASON = 'DUPLICATE_IDENTITY_CONFLICT' satisfies CandidateReasonCode;

/**
 * 巡回の終わり方（閉じた一覧）。
 * - `COMPLETED`: 待ち行列が空になった（読める画面をすべて読んだ）。
 * - `MAX_PAGES_REACHED`: 読んだ画面の数が `crawl.maxPages` に達した（残りは読まない）。
 * - `MAX_RUNTIME_REACHED`: 実行の時間が `crawl.maxRuntimeMs` に達した。
 * - `STOPPED`: 止める要求を受けた（今の画面を終えてから止まった）。
 * - `AUTH_SESSION_LOST`: セッションの切れを見つけた（Task 25 の `AUTH_SESSION_LOST`。発見のジョブは再開しない）。T37a: ログインの状態の鍵が
 *   なくなった切れは、詳しい理由 `endReasonDetail` に `session-key` を持つ。
 * - `SERVICE_REQUEST_LIMIT_REACHED`（T37a）: 承認したサービスの Origin への要求の上限に届いた（残りの画面は読まない。Run Status は `PARTIAL`）。
 * - `SITE_UNAVAILABLE`（DEF-136）: サイトの不調（読み取りの監査と同じ判定）が、1 回の確かめ直しの後も続いた（残りの画面は読まない。Run Status は
 *   `PARTIAL`。サイトが戻ってから始め直す）。
 * - `SAFETY_VIOLATION`: Safety Ledger に不変条件の違反が記録された（Run Status は `ABORTED_BY_SAFETY`）。
 * - `PREFLIGHT_FAILED`: Run の前の確認（PREFLIGHT）が失敗し、画面を 1 つも読まなかった。
 */
export const DISCOVERY_END_REASONS = Object.freeze([
  'COMPLETED',
  'MAX_PAGES_REACHED',
  'MAX_RUNTIME_REACHED',
  'STOPPED',
  'AUTH_SESSION_LOST',
  'SERVICE_REQUEST_LIMIT_REACHED',
  'SITE_UNAVAILABLE',
  'SAFETY_VIOLATION',
  'PREFLIGHT_FAILED',
] as const);
export type DiscoveryEndReason = (typeof DISCOVERY_END_REASONS)[number];

/**
 * 読まなかった画面の理由（閉じた一覧）。
 * - `EXCLUDED`: 認証の設定の読まないパス・読む範囲の外・既定の危険な語、またはセッションの切れの path（ログインの画面）に当たるリンク。
 * - `MAX_DEPTH_REACHED`: 深さが `crawl.maxDepth` を超えた。
 * - `NAVIGATION_FAILED`: 読み込みが失敗した（Context と page を作れなかった場合を含む）。
 * - `HTTP_ERROR_STATUS`（DEF-136）: 画面の文書の応答が 4xx・5xx（サイトの不調の 4 つの状態を除く）だった。候補もリンクも拾わない。
 * - ほかは、巡回の終わり方（`DISCOVERY_END_REASONS` の同じ名前）で、残った画面を読まなかった。DEF-136: `SITE_UNAVAILABLE` は、不調で捨てた画面にも付く。
 */
export const DISCOVERY_UNREAD_REASONS = Object.freeze([
  'EXCLUDED',
  'MAX_DEPTH_REACHED',
  'NAVIGATION_FAILED',
  'HTTP_ERROR_STATUS',
  'MAX_PAGES_REACHED',
  'MAX_RUNTIME_REACHED',
  'STOPPED',
  'AUTH_SESSION_LOST',
  'SERVICE_REQUEST_LIMIT_REACHED',
  'SITE_UNAVAILABLE',
  'SAFETY_VIOLATION',
  'PREFLIGHT_FAILED',
] as const);
export type DiscoveryUnreadReason = (typeof DISCOVERY_UNREAD_REASONS)[number];

/** 画面の状態（読んだ・読まなかった）。 */
export const DISCOVERY_PAGE_STATES = Object.freeze(['READ', 'NOT_READ'] as const);
export type DiscoveryPageState = (typeof DISCOVERY_PAGE_STATES)[number];

/** 成果物に書く、読まなかった画面の最大の件数（超えた分は `omittedUnreadPages` に件数だけ持つ）。 */
export const MAX_DISCOVERY_UNREAD_PAGE_ENTRIES = 1_000;

/**
 * 索引の更新に渡す、読んだ画面の path の最大の件数（管理データの版 5 の `discovery_jobs.read_page_paths` の上限と同じ）。超えた分は渡さない
 * （その画面の候補は `MISSING` ではなく `NOT_REVISITED` になる。消えたと言い過ぎない向き）。
 */
export const MAX_DISCOVERY_READ_PAGE_PATHS = 10_000;

/**
 * 候補が消えたと言えない画面の、読み切れなかった理由（落ち着きの時間切れ、凍結の条件、読み取りの失敗、上限）。この理由のある画面は、読んだ画面の
 * path に入れない。枠の中（iframe・closed な shadow root）は読まない決まり（設計書 4.2）なので、`INCOMPLETE_FRAME_OR_CLOSED_SHADOW` は入れない。
 * T37a: サービスの読み取りが届かなかった画面（`SERVICE_READ_REFUSED`。上限で断った要求か 401。画面がデータを描けなかったかもしれない）も入れる
 * （入れないと、索引が候補を誤って `MISSING` にする）。
 */
const UNRELIABLE_INCOMPLETE_REASONS: ReadonlySet<IncompleteReason> = new Set<IncompleteReason>([
  'INCOMPLETE_SETTLE_TIMEOUT',
  'INCOMPLETE_FREEZE_UNAVAILABLE',
  'INCOMPLETE_READ_FAILED',
  'INCOMPLETE_LIMIT_REACHED',
  // DEF-129: ページが始めた main frame の読み込みを上限で止めた画面（落ち着かず、読んだ内容が途中のものかもしれない）。
  PAGE_NAVIGATION_LIMIT_REASON,
  // DEF-130-fix: ページが出す文書でない要求を上限で止めた画面（画面がデータを描き切れなかったかもしれない）。
  PAGE_SUBRESOURCE_LIMIT_REASON,
  SERVICE_READ_REFUSED_REASON,
]);

/** Run Status を `COMPLETE` のままにする、読まなかった理由（設定どおりに読まなかった）。 */
const EXPECTED_UNREAD_REASONS: ReadonlySet<DiscoveryUnreadReason> = new Set<DiscoveryUnreadReason>(['EXCLUDED']);

/** 1 画面分の記録（発見の入口 `src/discovery/discover-page.ts` の `discoverPageCandidates` が返す形。CC-070 (a)）。 */
export interface DiscoveryReadPageRecord {
  /** 画面の Origin と path（読んだ時点の page の URL。http(s) でなければ null）。 */
  readonly location: CandidateLocation | null;
  /** 読み切れなかった理由（重複なし、`INCOMPLETE_REASONS` の順。読み切れたら空）。 */
  readonly incompleteReasons: readonly IncompleteReason[];
  /** 候補（probe の順: form（送信ボタンごと）、form の外のボタン）。 */
  readonly candidates: readonly DiscoveryCandidate[];
}

/** 成果物の画面 1 件（巡回の URL は、ArtifactWriter が書くときに伏せ字を通す）。 */
export type DiscoveryPageEntry =
  | {
    readonly url: string;
    readonly state: Extract<DiscoveryPageState, 'READ'>;
    readonly record: DiscoveryReadPageRecord;
    /** その画面の Context で、Guard が止めて記録した要求の数（ページ自身が出した送信。発見の操作とは別に数える）。 */
    readonly blockedRequests: number;
    /**
     * DEF-129: その画面の Context で、Guard が通した（サーバへ送った）main frame の文書の要求の数（BeakSight 自身の読み込み、リダイレクトの続き、ページが
     * 始めた読み込みを含む）。今の書き手は必ず書く。前の書き手の成果物にはない。
     */
    readonly documentRequests?: number;
    /** T37R2-fix: 同じ Context で、Guard が通した子の frame の文書の要求の数（別の数）。今の書き手は必ず書く。前の書き手の成果物にはない。 */
    readonly childFrameDocumentRequests?: number;
    /** DEF-130-fix: 同じ Context で、Guard が通した文書でない要求の数（別の数）。今の書き手は必ず書く。前の書き手の成果物にはない。 */
    readonly subresourceRequests?: number;
    /**
     * DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.2）: probe の押下で外部スキームへの移動の違反が起きた画面の、違反の中身（起きた順。
     * 読み込み直しの前と後で 2 件まで）。発見は止めずに続けた。なければ持たない。
     */
    readonly safetyViolations?: readonly JobSafetyViolation[];
    /** DEF-144: 残りの候補を押すために、この画面を読み込み直した（1 画面 1 回まで）。読み込み直していなければ持たない。 */
    readonly reloadedForProbe?: true;
  }
  | {
    readonly url: string;
    readonly state: Extract<DiscoveryPageState, 'NOT_READ'>;
    readonly reason: DiscoveryUnreadReason;
  };

/** 成果物 `discovery.json` の形。日時は UTC の 14 桁。 */
export interface DiscoveryDocument {
  /** 版（書き手は `DISCOVERY_ARTIFACT_SCHEMA_VERSION` を書く）。 */
  readonly schemaVersion: DiscoveryArtifactSchemaVersion;
  readonly jobId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runStatus: RunStatus;
  readonly endReason: DiscoveryEndReason;
  /** 設定の `crawl.maxPages`。 */
  readonly maxPages: number;
  /** 画面（読んだ画面は読んだ順、読まなかった画面はその後に見つけた順）。 */
  readonly pages: readonly DiscoveryPageEntry[];
  /** `MAX_DISCOVERY_UNREAD_PAGE_ENTRIES` を超えて書かなかった、読まなかった画面の件数。 */
  readonly omittedUnreadPages: number;
  /** 終わり方の詳しい理由（T37a。鍵の消失によるセッションの切れのときだけ。ほかは持たない）。 */
  readonly endReasonDetail?: JobEndReasonDetail;
  /** 監査の段の数（T37a。`run.json` の `authentication` と同じ形。認証の指定に監査の段の口があるジョブだけ。数だけで、URL・値を持たない）。 */
  readonly authentication?: RunAuthenticationSummary;
  /** DEF-138: セッションの切れの証拠（終わり方が `AUTH_SESSION_LOST` で、組み立てられたときだけ。`run.json` の `authentication.sessionLoss` と同じ形）。 */
  readonly sessionLoss?: SessionLossEvidence;
  /**
   * AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.3）: 実効の監査の段の送信の扱い（新しい成果物は必ず持つ。持たない古い成果物は `READ_ONLY` と
   * 読む）。
   */
  readonly auditSendPolicy?: AuditSendPolicyName;
  /** DEF-144: 違反で止まったときの違反の中身（終わり方が `SAFETY_VIOLATION` のときだけ。値を持たない。組み立ては `src/safety/job-safety-violation.ts`）。 */
  readonly safetyViolation?: JobSafetyViolation;
  /**
   * DEF-144（設計書 2.3）: 外部スキームで押さなかった候補の数（probe の理由が `EXTERNAL_SCHEME`）と、読み込み直した画面の数（`externalSchemeProbesOf` で
   * 画面の一覧から求める）。今の書き手は必ず書く。前の書き手の成果物にはない。
   */
  readonly externalSchemeProbes?: DiscoveryExternalSchemeProbes;
  /**
   * T44c（Task 44 の設計書 P1-3）: 押す数の上限で押せなかった、登録・更新の語の候補の数（`pressLimitProbesOf` で画面の一覧から求める）。今の書き手は必ず
   * 書く。前の書き手の成果物にはない。
   */
  readonly pressLimitProbes?: DiscoveryPressLimitProbes;
}

/** T44c: 押す数の上限で押せなかった、登録・更新の語の候補の数。 */
export interface DiscoveryPressLimitProbes {
  readonly priorityNotPressed: number;
}

/**
 * T44c: 押す数の上限で押せなかった、登録・更新の語の候補の数（読んだ画面の記録から数える。純粋）。probe の理由が `PRESS_LIMIT_REACHED` で、送信ボタンの
 * 語に登録・更新の語（`hasSubmissionProbePriorityWord`）のある候補を数える（見えない候補は、押す数を数える前に `TARGET_NOT_FOUND` になるので数えない）。
 */
export const pressLimitProbesOf = (pages: readonly DiscoveryPageEntry[]): DiscoveryPressLimitProbes => {
  let priorityNotPressed = 0;
  for (const page of pages) {
    if (page.state !== 'READ') continue;
    priorityNotPressed += page.record.candidates.filter((candidate) => candidate.submissionProbe?.reason === PRESS_LIMIT_REASON
      && hasSubmissionProbePriorityWord(candidate.submitterWords)).length;
  }
  return Object.freeze({ priorityNotPressed });
};

/**
 * DEF-144: 外部スキームで押さなかった候補の数と、読み込み直した画面の数。
 * T44g（Task 44 の設計書 P4-7）: `reloadedPages` は、probe を続けるために 1 回だけ読み込み直した画面の数。外部スキームへの移動の違反（DEF-144）に加えて、
 * probe の段の読み取りの移動の取り消し（DEF-145 の `READ_NAVIGATION_CANCELED`）で読み込み直した画面も数える（どちらも `reloadedForProbe`）。成果物と画面の
 * 互換のため、名前は変えない（`doc/spec/discovery-and-read-check.md`）。
 */
export interface DiscoveryExternalSchemeProbes {
  readonly notPressed: number;
  readonly reloadedPages: number;
}

/** DEF-144: 外部スキームで押さなかった候補の数と、読み込み直した画面の数（読んだ画面の記録から数える。純粋）。 */
export const externalSchemeProbesOf = (pages: readonly DiscoveryPageEntry[]): DiscoveryExternalSchemeProbes => {
  let notPressed = 0;
  let reloadedPages = 0;
  for (const page of pages) {
    if (page.state !== 'READ') continue;
    if (page.reloadedForProbe === true) reloadedPages += 1;
    notPressed += page.record.candidates.filter((candidate) => candidate.submissionProbe?.reason === EXTERNAL_SCHEME_REASON).length;
  }
  return Object.freeze({ notPressed, reloadedPages });
};

/** 件数の要約（IPC の `FINISHED` で送る値。候補を載せない）。 */
export interface DiscoverySummary {
  readonly pagesRead: number;
  /** 読まなかった画面の件数（書かなかった分を含む）。 */
  readonly pagesNotRead: number;
  /** 読んだ画面の候補の件数（まとめる前）。 */
  readonly candidates: number;
  /** 監査の段の数（T37a。成果物にあるときだけ。成果物と同じ値）。 */
  readonly authentication?: RunAuthenticationSummary;
  /** DEF-144: 違反の中身（成果物にあるときだけ。成果物と同じ値）。 */
  readonly safetyViolation?: JobSafetyViolation;
}

/** DEF-144: 違反の中身を、要約に写す（成果物にあるときだけ。発見と READ の確かめが共有する）。 */
export const safetyViolationSummaryPartOf = (
  document: { readonly safetyViolation?: JobSafetyViolation },
): { readonly safetyViolation?: JobSafetyViolation } =>
  (document.safetyViolation === undefined ? {} : { safetyViolation: document.safetyViolation });

/**
 * 監査の段の数が同じか（T37a。どちらもないか、5 つの項目がすべて同じ）。ジョブの管理が、IPC の要約と成果物を照らし合わせるときに使う（発見と READ の
 * 確かめの両方）。
 */
export const sameJobAuthenticationSummary = (
  left: RunAuthenticationSummary | undefined,
  right: RunAuthenticationSummary | undefined,
): boolean => {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.registeredReadRequestsAllowed === right.registeredReadRequestsAllowed
    && left.tokenRefreshBlocked === right.tokenRefreshBlocked
    && left.otherNonReadBlocked === right.otherNonReadBlocked
    && left.serviceUnauthorizedResponses === right.serviceUnauthorizedResponses
    && left.serviceRequestLimitReached === right.serviceRequestLimitReached
    // T37R-fix-B2: 任意の数も同じ（どちらもないか、同じ数）。
    && left.allowedOriginDataRequestsBlocked === right.allowedOriginDataRequestsBlocked
    // DEF-141: 1 分あたりの上限で待った回数と時間も同じ（どちらもないか、同じ数）。
    && left.serviceRequestPacingWaits === right.serviceRequestPacingWaits
    && left.serviceRequestPacingWaitMs === right.serviceRequestPacingWaitMs;
};

/** 監査の段の数を、要約に写す（成果物にあるときだけ）。 */
export const authenticationSummaryPartOf = (
  document: { readonly authentication?: RunAuthenticationSummary },
): { readonly authentication?: RunAuthenticationSummary } =>
  (document.authentication === undefined ? {} : { authentication: document.authentication });

/** 理由を、重複なく、閉じた一覧（`INCOMPLETE_REASONS`）の順に並べる。 */
const orderedIncompleteReasons = (reasons: readonly IncompleteReason[]): readonly IncompleteReason[] =>
  Object.freeze(INCOMPLETE_REASONS.filter((reason) => reasons.includes(reason)));

/**
 * サービスの読み取りが届かなかった画面の印を付けた記録（T37a。純粋。入力を変えない）。画面と、その画面のどの候補にも `SERVICE_READ_REFUSED` を
 * 足す（発見の入口と同じく、画面の理由を候補にも同じく付ける。識別と規則の digest は変えない）。すでにあれば同じ値。
 */
export const withServiceReadRefused = (record: DiscoveryReadPageRecord): DiscoveryReadPageRecord =>
  withIncompleteReason(record, SERVICE_READ_REFUSED_REASON);

/**
 * 画面を閉じた後に分かった、読み切れなかった理由を足した記録（T37a の `withServiceReadRefused` を DEF-129 で一般にした。純粋。入力を変えない）。画面と、
 * その画面のどの候補にも、理由を閉じた一覧の順に 1 回だけ足す（識別と規則の digest は変えない）。
 */
export const withIncompleteReason = (record: DiscoveryReadPageRecord, reason: IncompleteReason): DiscoveryReadPageRecord => Object.freeze({
  location: record.location,
  incompleteReasons: orderedIncompleteReasons([...record.incompleteReasons, reason]),
  candidates: Object.freeze(record.candidates.map((candidate) => Object.freeze({
    ...candidate,
    incompleteReasons: orderedIncompleteReasons([...candidate.incompleteReasons, reason]),
  }))),
});

/**
 * 読み切れたか（`isDiscoveryPageReadInFull` の結果）に、その画面の Context でサービスの読み取りが届かなかった事実（`withServiceReadRefused` の印に
 * あたる）を重ねた値（T37a。READ の確かめの対象の画面の読み取りが、候補が見つからないときに消えたと言わないために使う。理由が読み切れなかったことに
 * なるかは `UNRELIABLE_INCOMPLETE_REASONS` に任せる）。T37R-fix-B（T37R の M-2）: 2 つ目の引数は、描けなかった画面かの判定
 * （`src/orchestration/audit-stage-run.ts` の `isAuditStageReadObstructed`。発見と共有する 1 か所）の結果。
 */
export const readInFullAfterServiceRefusal = (readInFull: boolean, obstructed: boolean): boolean =>
  readInFullAfterIncompleteReasons(readInFull, obstructed ? [SERVICE_READ_REFUSED_REASON] : []);

/**
 * 読み切れたか（`isDiscoveryPageReadInFull` の結果）に、画面を閉じた後に分かった理由（DEF-129 の `INCOMPLETE_PAGE_NAVIGATION_LIMIT` など）を重ねた値。
 * 理由が読み切れなかったことになるかは `UNRELIABLE_INCOMPLETE_REASONS` に任せる（READ の確かめの対象の画面の読み取りが使う）。
 */
export const readInFullAfterIncompleteReasons = (readInFull: boolean, reasons: readonly IncompleteReason[]): boolean =>
  readInFull && !reasons.some((reason) => UNRELIABLE_INCOMPLETE_REASONS.has(reason));

/** 読んだ画面の記録の一覧。 */
const readRecordsOf = (pages: readonly DiscoveryPageEntry[]): readonly DiscoveryReadPageRecord[] =>
  pages.flatMap((page) => (page.state === 'READ' ? [page.record] : []));

/** 候補の、索引に入る中身（規則の digest・分類・理由のコード・状態の欄の印）が同じか。識別に入る項目は、識別の digest が同じなら同じ。 */
const sameContents = (left: DiscoveryCandidate, right: DiscoveryCandidate): boolean =>
  left.ruleDigest === right.ruleDigest
  && left.classification === right.classification
  && left.reasonCode === right.reasonCode
  && left.hasStateField === right.hasStateField;

/**
 * 同じ識別の候補のまとめ（中身の違う候補が 2 件以上）。並び順に依らない値にするため、規則の digest の最も小さい候補（同じなら、その中で
 * 分類と理由のコードの並びの最も小さい候補）を元にし、分類と理由と状態の欄の印だけを替える。
 */
const conflictOf = (group: readonly DiscoveryCandidate[]): DiscoveryCandidate => {
  const keyOf = (candidate: DiscoveryCandidate): string => `${candidate.ruleDigest} ${candidate.classification} ${candidate.reasonCode}`;
  const [base] = [...group].sort((left, right) => compareCodeUnits(keyOf(left), keyOf(right)));
  if (base === undefined) {
    throw new RangeError('a conflict needs at least one candidate');
  }
  return Object.freeze({
    ...base,
    classification: CANDIDATE_REASON_CLASSIFICATIONS[DUPLICATE_IDENTITY_CONFLICT_REASON],
    reasonCode: DUPLICATE_IDENTITY_CONFLICT_REASON,
    hasStateField: group.some((candidate) => candidate.hasStateField),
  });
};

/** probe の型の鍵（型の digest。型がない・probe がない候補は同じ鍵 null）。 */
const shapeKeyOf = (candidate: DiscoveryCandidate): string | null => candidate.submissionProbe?.shapeDigest ?? null;

/** 書き込みの probe（結果が `API_CREATE`・`API_UPDATE`。`submissionProbeWriteOf`）を持つ候補か。 */
const hasWriteProbe = (candidate: DiscoveryCandidate): boolean =>
  candidate.submissionProbe !== undefined && submissionProbeWriteOf(candidate.submissionProbe.result) !== null;

/**
 * 型の鍵ごとの 1 件（型の鍵の最初に現れた順）。ふつうは最初に現れた候補。T38R2-fix の R2-I-1（Task 38 の設計書 7 章の最後の行）: 同じ型の鍵に、
 * 書き込みの probe の候補と書き込みでない probe の候補（2 つの要求を送った probe の最初の型など）があれば、並びの順に依らず、最初に現れた書き込みでない
 * 候補にする（止める側）。索引の型の digest（書き込みの probe の型だけ）、型で引く口（`candidateOfDiscoveryDocumentByShape`）、画面の API の行は、
 * まとめた後の行を使うので、その型を書き込みに使わない。
 */
const firstOfEachShape = (group: readonly DiscoveryCandidate[]): readonly DiscoveryCandidate[] => {
  const byShape = new Map<string | null, DiscoveryCandidate>();
  for (const candidate of group) {
    const key = shapeKeyOf(candidate);
    const kept = byShape.get(key);
    // `Map` の `set` は、すでにある鍵の位置を変えない（行の並びは型の鍵の最初に現れた順のまま）。
    if (kept === undefined || (hasWriteProbe(kept) && !hasWriteProbe(candidate))) {
      byShape.set(key, candidate);
    }
  }
  return [...byShape.values()];
};

/** 候補に、まとめた中身を当て、probe の結果だけを元の候補のものにする（probe がなければ持たない）。 */
const withMergedContents = (merged: DiscoveryCandidate, row: DiscoveryCandidate): DiscoveryCandidate => {
  const { submissionProbe: _ignored, ...contents } = merged;
  return Object.freeze(row.submissionProbe === undefined ? contents : { ...contents, submissionProbe: row.submissionProbe });
};

/**
 * 同じジョブの候補を、識別の digest ごとに 1 件にまとめる（純粋。入力を変えない）。並びは、最初に現れた順。中身の同じ重複は最初の 1 件、
 * 中身の違う重複は `conflictOf`（`DISPLAY_ONLY`・`DUPLICATE_IDENTITY_CONFLICT`、規則の digest は最小のもの、状態の欄の印はどれかにあれば真）。
 * T37c（Task 37 の設計書 3.4）: 同じ識別の digest で、送らずに観察する probe の型（型の digest）が違えば、型ごとに別の行として残す（同じボタンで型が
 * 違うのは、画面の状態で送り方が変わる印）。行は型ごとに最初に現れた候補で、索引に入る中身（規則の digest・分類・理由のコード・状態の欄の印）は、
 * 識別の digest の全体でまとめた値を、どの行にも同じく当てる（索引は識別の digest で 1 件にまとめ、違う中身を拒むため）。型のない候補（probe の
 * 対象でない、観察しなかった、要求がなかった）は 1 つの鍵として扱う。
 */
export const mergeDiscoveryCandidates = (candidates: readonly DiscoveryCandidate[]): readonly DiscoveryCandidate[] => {
  const groups = new Map<string, DiscoveryCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.identityDigest);
    if (group === undefined) {
      groups.set(candidate.identityDigest, [candidate]);
    } else {
      group.push(candidate);
    }
  }
  return Object.freeze([...groups.values()].flatMap((group) => {
    const [first] = group;
    if (first === undefined) {
      throw new RangeError('a candidate group is never empty');
    }
    const rows = firstOfEachShape(group);
    if (group.every((candidate) => sameContents(first, candidate))) {
      return rows;
    }
    const conflict = conflictOf(group);
    return rows.map((row) => withMergedContents(conflict, row));
  }));
};

/** 成果物の、読んだ画面のすべての候補（読んだ順。まとめる前）。 */
export const discoveryCandidatesOf = (document: Pick<DiscoveryDocument, 'pages'>): readonly DiscoveryCandidate[] =>
  Object.freeze(readRecordsOf(document.pages).flatMap((record) => record.candidates));

/**
 * この画面の記録は読み切れたか（候補が見つからなければ、消えたと言える画面か）。画面の場所があり、`UNRELIABLE_INCOMPLETE_REASONS` の理由が
 * ないもの。判定の唯一の owner（CCX-10）: 読んだ画面の path（`discoveryReadPagePaths`）と、READ の確かめの対象の画面の読み取り
 * （`src/discovery/read-executor.ts` の `readCandidatePage`）が、ここを使う（`tests/architecture/read-check-ssot.test.ts`）。
 */
export const isDiscoveryPageReadInFull = (record: DiscoveryReadPageRecord): record is DiscoveryReadPageRecord & { readonly location: CandidateLocation } =>
  record.location !== null && !record.incompleteReasons.some((reason) => UNRELIABLE_INCOMPLETE_REASONS.has(reason));

/**
 * 候補が消えたと言える、読み切れた画面の path（重複なし、UTF-16 のコード単位の順。上限 `MAX_DISCOVERY_READ_PAGE_PATHS`）。読んだ画面のうち、
 * 読み切れたもの（`isDiscoveryPageReadInFull`）だけ。索引の更新は、ここにある path の候補で今回ないものを `MISSING`、ほかの今回ない候補を
 * `NOT_REVISITED` にする。
 */
export const discoveryReadPagePaths = (document: Pick<DiscoveryDocument, 'pages'>): readonly string[] => {
  const paths = new Set<string>();
  for (const record of readRecordsOf(document.pages)) {
    if (isDiscoveryPageReadInFull(record)) {
      paths.add(record.location.path);
    }
  }
  return Object.freeze([...paths].sort(compareCodeUnits).slice(0, MAX_DISCOVERY_READ_PAGE_PATHS));
};

/** 件数の要約（読んだ画面、読まなかった画面（書かなかった分を含む）、候補（まとめる前））。 */
export const discoverySummaryOf = (
  document: Pick<DiscoveryDocument, 'pages' | 'omittedUnreadPages' | 'authentication' | 'safetyViolation'>,
): DiscoverySummary => {
  const records = readRecordsOf(document.pages);
  return Object.freeze({
    pagesRead: records.length,
    pagesNotRead: document.pages.length - records.length + document.omittedUnreadPages,
    candidates: records.reduce((total, record) => total + record.candidates.length, 0),
    ...authenticationSummaryPartOf(document),
    ...safetyViolationSummaryPartOf(document),
  });
};

/** 巡回の上限による終わり方（Run Status の入力の `crawlLimitReached`）。 */
const CRAWL_LIMIT_END_REASONS: ReadonlySet<DiscoveryEndReason> = new Set<DiscoveryEndReason>(['MAX_PAGES_REACHED', 'MAX_RUNTIME_REACHED']);

/**
 * 発見の Run Status（成果物の `runStatus`。ワーカーの終了コードと、ジョブの行の Run の状態になる）。判定は、Run Status の唯一の owner
 * `deriveRunStatus` に任せ、ここでは発見の事実を、その入力に写すだけにする（GATE-ARCH05）。
 * - 違反（終わり方 `SAFETY_VIOLATION`）→ 違反の件数。PREFLIGHT の失敗 → `preflightFailed`。
 * - 上限（読んだ画面の数、実行の時間、深さ）と、書かなかった読まなかった画面 → `crawlLimitReached`。
 * - 止める要求とセッションの切れ（読み切る前に止まった）→ `executionComplete` が偽。
 * - 読まなかった画面（設定どおりの除外 `EXCLUDED` を除く）→ `skippedRequiredWork`、読み込みの失敗 → `failedRequiredWork`、読み切れなかった
 *   画面 → `incompleteCollectorCount`。
 * 結果: 違反は `ABORTED_BY_SAFETY`、PREFLIGHT の失敗は `FAILED`、すべて読み切れて除外のほかに読まなかった画面がなければ `COMPLETE`、ほかは
 * `PARTIAL`。
 */
export const discoveryRunStatusOf = (
  input: Pick<DiscoveryDocument, 'endReason' | 'pages' | 'omittedUnreadPages'>,
): RunStatus => {
  const records = readRecordsOf(input.pages);
  const unreadReasons = input.pages.flatMap((page) => (page.state === 'NOT_READ' ? [page.reason] : []));
  return deriveRunStatus({
    preflightFailed: input.endReason === 'PREFLIGHT_FAILED',
    safetyInvariantViolations: input.endReason === 'SAFETY_VIOLATION' ? 1 : 0,
    safetyLedgerTruncated: false,
    incompleteReasons: [],
    unhandledFailures: 0,
    crawlLimitReached: CRAWL_LIMIT_END_REASONS.has(input.endReason)
      || unreadReasons.includes('MAX_DEPTH_REACHED')
      || input.omittedUnreadPages > 0,
    requiredArtifactsValid: true,
    executionComplete: input.endReason === 'COMPLETED' || CRAWL_LIMIT_END_REASONS.has(input.endReason),
    skippedRequiredWork: unreadReasons.filter((reason) => !EXPECTED_UNREAD_REASONS.has(reason)).length,
    blockedRequiredWork: 0,
    timedOutRequiredWork: 0,
    notObservedRequiredWork: 0,
    notVerifiedRequiredWork: 0,
    // DEF-136: エラーの状態の画面も、読み込みの失敗と同じく失敗した仕事に数える。
    failedRequiredWork: unreadReasons.filter((reason) => reason === 'NAVIGATION_FAILED' || reason === 'HTTP_ERROR_STATUS').length,
    incompleteCollectorCount: records.filter((record) => record.incompleteReasons.length > 0).length,
  });
};

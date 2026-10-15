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
//   （`tests/architecture/discovery-boundary.test.ts` の (x)）。そのため、画面の記録の形（`DiscoveryPageRecord`。`discover-page.ts`）は、
//   同じ形の型（`DiscoveryReadPageRecord`）をここに置き、ワーカーの側で `satisfies` で一致を確かめる。
import type { RunStatus } from '../core/contracts.js';
import { deriveRunStatus } from '../core/status.js';
import { compareCodeUnits } from '../core/text.js';
import {
  CANDIDATE_REASON_CLASSIFICATIONS,
  type CandidateLocation,
  type CandidateReasonCode,
  type DiscoveryCandidate,
  type IncompleteReason,
} from './candidate-contracts.js';

/** 成果物の版（スキーマの `schemaVersion` の const）。 */
export const DISCOVERY_ARTIFACT_SCHEMA_VERSION = 'discovery-schema/1.0';

/** 同じ識別の digest で中身の違う候補を 1 件にまとめたときの理由のコード（分類は `DISPLAY_ONLY`）。 */
export const DUPLICATE_IDENTITY_CONFLICT_REASON = 'DUPLICATE_IDENTITY_CONFLICT' satisfies CandidateReasonCode;

/**
 * 巡回の終わり方（閉じた一覧）。
 * - `COMPLETED`: 待ち行列が空になった（読める画面をすべて読んだ）。
 * - `MAX_PAGES_REACHED`: 読んだ画面の数が `crawl.maxPages` に達した（残りは読まない）。
 * - `MAX_RUNTIME_REACHED`: 実行の時間が `crawl.maxRuntimeMs` に達した。
 * - `STOPPED`: 止める要求を受けた（今の画面を終えてから止まった）。
 * - `AUTH_SESSION_LOST`: セッションの切れを見つけた（Task 25 の `AUTH_SESSION_LOST`。発見のジョブは再開しない）。
 * - `SAFETY_VIOLATION`: Safety Ledger に不変条件の違反が記録された（Run Status は `ABORTED_BY_SAFETY`）。
 * - `PREFLIGHT_FAILED`: Run の前の確認（PREFLIGHT）が失敗し、画面を 1 つも読まなかった。
 */
export const DISCOVERY_END_REASONS = Object.freeze([
  'COMPLETED',
  'MAX_PAGES_REACHED',
  'MAX_RUNTIME_REACHED',
  'STOPPED',
  'AUTH_SESSION_LOST',
  'SAFETY_VIOLATION',
  'PREFLIGHT_FAILED',
] as const);
export type DiscoveryEndReason = (typeof DISCOVERY_END_REASONS)[number];

/**
 * 読まなかった画面の理由（閉じた一覧）。
 * - `EXCLUDED`: 認証の設定の読まないパス・読む範囲の外・既定の危険な語、またはセッションの切れの path（ログインの画面）に当たるリンク。
 * - `MAX_DEPTH_REACHED`: 深さが `crawl.maxDepth` を超えた。
 * - `NAVIGATION_FAILED`: 読み込みが失敗した（Context と page を作れなかった場合を含む）。
 * - ほかは、巡回の終わり方（`DISCOVERY_END_REASONS` の同じ名前）で、残った画面を読まなかった。
 */
export const DISCOVERY_UNREAD_REASONS = Object.freeze([
  'EXCLUDED',
  'MAX_DEPTH_REACHED',
  'NAVIGATION_FAILED',
  'MAX_PAGES_REACHED',
  'MAX_RUNTIME_REACHED',
  'STOPPED',
  'AUTH_SESSION_LOST',
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
 */
const UNRELIABLE_INCOMPLETE_REASONS: ReadonlySet<IncompleteReason> = new Set<IncompleteReason>([
  'INCOMPLETE_SETTLE_TIMEOUT',
  'INCOMPLETE_FREEZE_UNAVAILABLE',
  'INCOMPLETE_READ_FAILED',
  'INCOMPLETE_LIMIT_REACHED',
]);

/** Run Status を `COMPLETE` のままにする、読まなかった理由（設定どおりに読まなかった）。 */
const EXPECTED_UNREAD_REASONS: ReadonlySet<DiscoveryUnreadReason> = new Set<DiscoveryUnreadReason>(['EXCLUDED']);

/** 1 画面分の記録（`src/discovery/discover-page.ts` の `DiscoveryPageRecord` と同じ形）。 */
export interface DiscoveryReadPageRecord {
  readonly location: CandidateLocation | null;
  readonly incompleteReasons: readonly IncompleteReason[];
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
  }
  | {
    readonly url: string;
    readonly state: Extract<DiscoveryPageState, 'NOT_READ'>;
    readonly reason: DiscoveryUnreadReason;
  };

/** 成果物 `discovery.json` の形。日時は UTC の 14 桁。 */
export interface DiscoveryDocument {
  readonly schemaVersion: typeof DISCOVERY_ARTIFACT_SCHEMA_VERSION;
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
}

/** 件数の要約（IPC の `FINISHED` で送る値。候補を載せない）。 */
export interface DiscoverySummary {
  readonly pagesRead: number;
  /** 読まなかった画面の件数（書かなかった分を含む）。 */
  readonly pagesNotRead: number;
  /** 読んだ画面の候補の件数（まとめる前）。 */
  readonly candidates: number;
}

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

/**
 * 同じジョブの候補を、識別の digest ごとに 1 件にまとめる（純粋。入力を変えない）。並びは、最初に現れた順。中身の同じ重複は最初の 1 件、
 * 中身の違う重複は `conflictOf`（`DISPLAY_ONLY`・`DUPLICATE_IDENTITY_CONFLICT`、規則の digest は最小のもの、状態の欄の印はどれかにあれば真）。
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
  return Object.freeze([...groups.values()].map((group) => {
    const [first] = group;
    if (first === undefined) {
      throw new RangeError('a candidate group is never empty');
    }
    return group.every((candidate) => sameContents(first, candidate)) ? first : conflictOf(group);
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
export const discoverySummaryOf = (document: Pick<DiscoveryDocument, 'pages' | 'omittedUnreadPages'>): DiscoverySummary => {
  const records = readRecordsOf(document.pages);
  return Object.freeze({
    pagesRead: records.length,
    pagesNotRead: document.pages.length - records.length + document.omittedUnreadPages,
    candidates: records.reduce((total, record) => total + record.candidates.length, 0),
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
    failedRequiredWork: unreadReasons.filter((reason) => reason === 'NAVIGATION_FAILED').length,
    incompleteCollectorCount: records.filter((record) => record.incompleteReasons.length > 0).length,
  });
};

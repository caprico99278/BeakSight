// READ の確かめ（`READ_CHECK` のジョブ）の、純粋な部品と、成果物 `read-evidence.json` の形の SSOT（Task 27 の設計書 3 章、4.5、4.8、変更履歴の
// 「T27a の報告」の (6)。T27e）。
// - 候補の確かめ（`confirmReadTarget`）: 今の画面の候補を、同じジョブの発見と同じ規則でまとめ（`mergeDiscoveryCandidates`）、識別の digest が定義の
//   ものと同じ候補が 1 つあり、その今の分類が `READ` であることを確かめる（違えば `READ_CANDIDATE_DRIFTED`・`READ_CANDIDATE_NOT_READ`）。
// - URL の組み立て（`buildReadCheckUrl`）: 候補の送信先（Origin と path）に、定義の送る値（名前 → 値）だけを、form の GET と同じ符号化
//   （`application/x-www-form-urlencoded`）で付ける。巡回の正規化（`normalizeUrl`）は通さない。送信先の query（GET の form は送るときに置き換える）、
//   CSRF のトークン、hidden の値は入れない。秘密に見える名前（`isSecretUrlQueryParameterName`。owner は `src/core/secret-query-names.ts`）は、保存の
//   ときに拒んでいるが、ここでも確かめ直す（fail-closed。当たれば組み立てない）。送る値の名前と値が、発見の分類の危険な語（日本語を含む。
//   owner は `classify.ts` の `readParametersHaveDestructiveWord`）に当たれば、組み立てない（T27R-fix-1。DEF-088 の (b)。保存のときも同じ判定で
//   拒むが、保存の後に候補が変わらないまま残った定義も、実行の前に止める）。
// - 照らす（`evaluateReadExpectations`、`readCheckResultOf`）: ページの構造（`ReadPageStructure`。`read-executor.ts` が isolated world の 1 回の
//   読み取り（`readInIsolatedWorld`。DEF-087）で読む）と
//   期待を照らす。規則はファイルの中の各関数の説明のとおり。
// - 成果物の形（`ReadEvidenceDocument`）、件数の要約（IPC の `FINISHED` で送る値）、Run Status（唯一の判定 `deriveRunStatus` に任せる）。
//   JSON Schema（`schemas/read-evidence.schema.json`）の enum と上限は、ここの一覧と定数に一致する（`tests/unit/read-check-evaluation.test.ts`、
//   `tests/unit/schema-enum-consistency.test.ts`）。成果物は、表の全体を写さない（件数と、照らした項目だけ。設計書 4.8）。
// - 純粋な定義と関数だけのファイル。Playwright、ブラウザ、`node:fs`、`src/control/`、監査エンジン、発見のブラウザの部品を import しない
//   （`tests/architecture/discovery-boundary.test.ts` の (x)）。ワーカーとジョブの管理の両方から使う。
import type { RunStatus } from '../core/contracts.js';
import { MAX_URL_LENGTH } from '../core/limits.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { deriveRunStatus } from '../core/status.js';
import { normalizeWhitespace } from '../core/text.js';
import type { CandidateLocation, DiscoveryCandidate } from './candidate-contracts.js';
import { readParametersHaveDestructiveWord } from './classify.js';
import { mergeDiscoveryCandidates } from './discovery-result.js';
import type { ReadCheckExpectation, ReadCheckParameters, ReadCheckResult } from './read-check-contracts.js';

/** 成果物の版（スキーマの `schemaVersion` の const）。 */
export const READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION = 'read-evidence-schema/1.0';

/** READ の確かめで読む分類（今の分類がこれでなければ読まない）。 */
const READ_CLASSIFICATION = 'READ' satisfies DiscoveryCandidate['classification'];

// ---------------------------------------------------------------------------------------------------------------
// 閉じた一覧
// ---------------------------------------------------------------------------------------------------------------

/**
 * ジョブの終わり方（閉じた一覧）。
 * - `COMPLETED`: すべての定義を確かめた（結果の種類は問わない）。
 * - `MAX_RUNTIME_REACHED`: 実行の時間が `crawl.maxRuntimeMs` に達した（残りの定義は確かめない）。
 * - `STOPPED`: 止める要求を受けた（今の定義を終えてから止まった）。
 * - `AUTH_SESSION_LOST`: セッションの切れを見つけた（Task 25 の判定。止まる。再開しない）。
 * - `SAFETY_VIOLATION`: Safety Ledger に不変条件の違反が記録された（Run Status は `ABORTED_BY_SAFETY`）。
 * - `PREFLIGHT_FAILED`: Run の前の確認が失敗し、どの定義も確かめなかった。
 */
export const READ_CHECK_END_REASONS = Object.freeze([
  'COMPLETED',
  'MAX_RUNTIME_REACHED',
  'STOPPED',
  'AUTH_SESSION_LOST',
  'SAFETY_VIOLATION',
  'PREFLIGHT_FAILED',
] as const);
export type ReadCheckEndReason = (typeof READ_CHECK_END_REASONS)[number];

/** 確かめなかった定義の理由（`COMPLETED` を除く、ジョブの終わり方）。 */
export const READ_CHECK_NOT_EXECUTED_REASONS = Object.freeze(
  READ_CHECK_END_REASONS.filter((reason) => reason !== 'COMPLETED') as readonly Exclude<ReadCheckEndReason, 'COMPLETED'>[],
);
export type ReadCheckNotExecutedReason = Exclude<ReadCheckEndReason, 'COMPLETED'>;

/** 定義の状態（確かめた・確かめなかった）。 */
export const READ_CHECK_EVIDENCE_STATES = Object.freeze(['EXECUTED', 'NOT_EXECUTED'] as const);
export type ReadCheckEvidenceState = (typeof READ_CHECK_EVIDENCE_STATES)[number];

/**
 * 確かめた定義の結果の詳しい理由（閉じた一覧。結果の種類との対応は `READ_CHECK_DETAIL_RESULTS`）。
 * - `EXPECTATIONS_EVALUATED`: 読んで、期待と照らした（`MATCHED`・`NOT_MATCHED`・`UNDETERMINED`）。
 * - `TARGET_PAGE_UNKNOWN`: 対象の候補の画面が分からない（親が、候補を最後に見た発見の成果物から画面を決められなかった）→ `READ_CANDIDATE_DRIFTED`。
 * - `TARGET_PAGE_UNREADABLE`: 対象の候補の画面を読めない（読み込みの失敗、HTTP の 4xx・5xx、凍結の条件、読み取りの失敗、落ち着かない）→
 *   `UNDETERMINED`。
 * - `CANDIDATE_NOT_FOUND`: 画面を読めたが、識別の digest が同じ候補がない → `READ_CANDIDATE_DRIFTED`。
 * - `CANDIDATE_NOT_READ`: 候補の今の分類が `READ` でない → `READ_CANDIDATE_NOT_READ`。
 * - `SECRET_LIKE_PARAMETER`: 送る値に秘密に見える名前がある（確かめ直し。fail-closed）→ `READ_BLOCKED_BY_POLICY`。
 * - `PARAMETER_DANGEROUS_WORD`（T27R-fix-1。DEF-088）: 送る値の名前か値が、発見の分類の危険な語（日本語を含む）に当たる（実行の前の確かめ。
 *   fail-closed）→ `READ_BLOCKED_BY_POLICY`。
 * - `PARAMETER_NOT_SENDABLE`: 送る値の名前が、今の候補の送れる欄（`isSendableReadCheckParameter`。名前があり、見えていて、readonly でも
 *   disabled でもない）でない（保存の後に欄が変わった。確かめ直し。fail-closed。CCX-10）→ `READ_BLOCKED_BY_POLICY`。
 * - `URL_NOT_BUILT`: URL を組み立てられない（送信先が候補の Origin の外になる、長さの上限）→ `READ_BLOCKED_BY_POLICY`。
 * - `REQUEST_POLICY`: 要求の判定（読まないパス、危険な語、許可 Origin、ログインの画面）で止めた → `READ_BLOCKED_BY_POLICY`。
 * - `NAVIGATION_FAILED`: READ の URL の読み込みが失敗した（時間切れ、接続の失敗、外部への移動の遮断）→ `UNDETERMINED`。
 * - `HTTP_ERROR_STATUS`: READ の URL の応答が HTTP の 4xx・5xx → `UNDETERMINED`（期待と照らさない）。
 * - `RESULT_PAGE_UNREADABLE`: READ の URL は読み込めたが、構造を読めなかった（読み取りの失敗、時間切れ）→ `UNDETERMINED`。
 * - `SESSION_LOST`: READ の URL の読み込みで、セッションの切れを見つけた → `UNDETERMINED`（ジョブは止まる）。
 */
export const READ_CHECK_DETAILS = Object.freeze([
  'EXPECTATIONS_EVALUATED',
  'TARGET_PAGE_UNKNOWN',
  'TARGET_PAGE_UNREADABLE',
  'CANDIDATE_NOT_FOUND',
  'CANDIDATE_NOT_READ',
  'SECRET_LIKE_PARAMETER',
  'PARAMETER_DANGEROUS_WORD',
  'PARAMETER_NOT_SENDABLE',
  'URL_NOT_BUILT',
  'REQUEST_POLICY',
  'NAVIGATION_FAILED',
  'HTTP_ERROR_STATUS',
  'RESULT_PAGE_UNREADABLE',
  'SESSION_LOST',
] as const);
export type ReadCheckDetail = (typeof READ_CHECK_DETAILS)[number];

/** 詳しい理由ごとの結果（`EXPECTATIONS_EVALUATED` は、期待と照らした結果。ここでは null）。 */
export const READ_CHECK_DETAIL_RESULTS: Readonly<Record<ReadCheckDetail, ReadCheckResult | null>> = Object.freeze({
  EXPECTATIONS_EVALUATED: null,
  TARGET_PAGE_UNKNOWN: 'READ_CANDIDATE_DRIFTED',
  TARGET_PAGE_UNREADABLE: 'UNDETERMINED',
  CANDIDATE_NOT_FOUND: 'READ_CANDIDATE_DRIFTED',
  CANDIDATE_NOT_READ: 'READ_CANDIDATE_NOT_READ',
  SECRET_LIKE_PARAMETER: 'READ_BLOCKED_BY_POLICY',
  PARAMETER_DANGEROUS_WORD: 'READ_BLOCKED_BY_POLICY',
  PARAMETER_NOT_SENDABLE: 'READ_BLOCKED_BY_POLICY',
  URL_NOT_BUILT: 'READ_BLOCKED_BY_POLICY',
  REQUEST_POLICY: 'READ_BLOCKED_BY_POLICY',
  NAVIGATION_FAILED: 'UNDETERMINED',
  HTTP_ERROR_STATUS: 'UNDETERMINED',
  RESULT_PAGE_UNREADABLE: 'UNDETERMINED',
  SESSION_LOST: 'UNDETERMINED',
});

/** 期待 1 件と照らした結果（閉じた一覧。定義全体の結果の一覧 `READ_CHECK_RESULTS` の一部）。 */
export const READ_EXPECTATION_RESULTS = Object.freeze(['MATCHED', 'NOT_MATCHED', 'UNDETERMINED'] as const satisfies readonly ReadCheckResult[]);
export type ReadExpectationResult = (typeof READ_EXPECTATION_RESULTS)[number];

/**
 * 期待と照らせなかった理由（`UNDETERMINED` のときだけ）。
 * - `STRUCTURE_NOT_FOUND`: 数える構造（表・一覧）や詳細（`dl`）が、主な領域にない。
 * - `STRUCTURE_AMBIGUOUS`: 数える構造が 2 つ以上ある、または同じ名前の詳細の項目が 2 つ以上ある（どれを照らすか決められない）。
 * - `STRUCTURE_LIMIT_REACHED`: 読む上限（要素の数、構造の数、文字の長さ）に達し、読み切れなかった。
 * - `PAGE_NOT_SETTLED`: 落ち着きの待ちの上限（発見と同じ `DISCOVERY_SETTLE_POLICY`）までに、画面が落ち着かなかった（後から描画が変わりうる）。
 */
export const READ_EXPECTATION_UNDETERMINED_REASONS = Object.freeze([
  'STRUCTURE_NOT_FOUND',
  'STRUCTURE_AMBIGUOUS',
  'STRUCTURE_LIMIT_REACHED',
  'PAGE_NOT_SETTLED',
] as const);
export type ReadExpectationUndeterminedReason = (typeof READ_EXPECTATION_UNDETERMINED_REASONS)[number];

/** 主な領域（`main` の要素がちょうど 1 つあればそれ、なければ `body`）。 */
export const READ_PAGE_REGIONS = Object.freeze(['MAIN', 'BODY'] as const);
export type ReadPageRegion = (typeof READ_PAGE_REGIONS)[number];

/** 行を数えた構造の種類（表が優先。表がなければ一覧）。 */
export const READ_ROW_SOURCES = Object.freeze(['TABLE', 'LIST'] as const);
export type ReadRowSource = (typeof READ_ROW_SOURCES)[number];

// ---------------------------------------------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------------------------------------------

/** 成果物に書く、構造ごとの行の数の一覧の最大の件数（表と一覧のそれぞれ。超えた分は書かない。構造の数は `tables`・`lists` が持つ）。 */
export const MAX_READ_EVIDENCE_STRUCTURE_COUNTS = 50;

/** 成果物に書く、照らした詳細の項目の取れた値の最大長（UTF-16 のコード単位）。期待の値の上限と同じ。 */
export const MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH = 256;

// ---------------------------------------------------------------------------------------------------------------
// ページの構造（`read-executor.ts` が読む）
// ---------------------------------------------------------------------------------------------------------------

/** 詳細の項目 1 件（`dl` の `dt` と、その後の最初の `dd`。空白をまとめた見えている文字）。 */
export interface ReadDetailEntry {
  readonly term: string;
  readonly value: string;
}

/**
 * READ の結果のページの構造（主な領域の中だけ。`nav`・`header`・`footer`・`aside` の中は数えない）。値は、ページの中で読んだ後に、空白を
 * まとめてある。上限に達したら `limitReached`（照らせない期待は `STRUCTURE_LIMIT_REACHED`）。
 */
export interface ReadPageStructure {
  readonly region: ReadPageRegion;
  /** 表（`table`。ほかの表の中の表は数えない）ごとの、データの行（`tbody` の `tr` で、`td` を 1 つ以上持つもの）の数。 */
  readonly tableRowCounts: readonly number[];
  /** 一覧（`ul`・`ol`。ほかの一覧と表の中のものは数えない）ごとの、子の `li` の数。 */
  readonly listItemCounts: readonly number[];
  /** 詳細の項目（`dl` の `dt` → 次の `dd`）。 */
  readonly detailEntries: readonly ReadDetailEntry[];
  /** 主な領域の見えている文字（`innerText`。空白をまとめた）。 */
  readonly text: string;
  /** 読む上限に達した（構造か文字を読み切れなかった）。 */
  readonly limitReached: boolean;
  /** 落ち着きの待ちの上限までに、画面が落ち着いた（偽なら、見つかった文字のほかは判定しない）。 */
  readonly settled: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// 成果物の形
// ---------------------------------------------------------------------------------------------------------------

/** 構造の要約（件数だけ。表の中身は持たない）。 */
export interface ReadStructureSummary {
  readonly region: ReadPageRegion;
  /** 表の数。 */
  readonly tables: number;
  /** 表ごとのデータの行の数（`MAX_READ_EVIDENCE_STRUCTURE_COUNTS` 件まで）。 */
  readonly tableRowCounts: readonly number[];
  /** 一覧の数。 */
  readonly lists: number;
  /** 一覧ごとの項目の数（`MAX_READ_EVIDENCE_STRUCTURE_COUNTS` 件まで）。 */
  readonly listItemCounts: readonly number[];
  /** 詳細の項目の数。 */
  readonly detailFields: number;
  /** 主な領域の見えている文字の長さ（UTF-16 のコード単位。空白をまとめた後）。 */
  readonly textLength: number;
  readonly limitReached: boolean;
  readonly settled: boolean;
}

/** 期待 1 件と照らした結果（照らした項目だけ。表の全体は持たない）。 */
export type ReadExpectationEvidence =
  | {
    readonly expectation: Extract<ReadCheckExpectation, { readonly kind: 'ROW_COUNT_EQUALS' | 'ROW_COUNT_AT_LEAST' }>;
    readonly result: ReadExpectationResult;
    readonly undeterminedReason: ReadExpectationUndeterminedReason | null;
    /** 数えた構造（数えられなければ null）。 */
    readonly rowSource: ReadRowSource | null;
    /** 数えた行の数（数えられなければ null）。 */
    readonly observedRowCount: number | null;
  }
  | {
    readonly expectation: Extract<ReadCheckExpectation, { readonly kind: 'TEXT_CONTAINS' }>;
    readonly result: ReadExpectationResult;
    readonly undeterminedReason: ReadExpectationUndeterminedReason | null;
    /** 見えている文字に含まれていたか（判定できなければ null。ページの文字そのものは持たない）。 */
    readonly found: boolean | null;
  }
  | {
    readonly expectation: Extract<ReadCheckExpectation, { readonly kind: 'DETAIL_FIELD_EQUALS' }>;
    readonly result: ReadExpectationResult;
    readonly undeterminedReason: ReadExpectationUndeterminedReason | null;
    /** その項目の取れた値（`MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH` で切る。項目がない・判定できなければ null）。 */
    readonly observedValue: string | null;
  };

/** 確かめた定義 1 件。 */
export interface ReadCheckExecutedEvidence {
  readonly readCheckId: string;
  readonly readCheckRevision: number;
  readonly targetIdentityDigest: string;
  readonly state: Extract<ReadCheckEvidenceState, 'EXECUTED'>;
  readonly result: ReadCheckResult;
  readonly detail: ReadCheckDetail;
  /** READ の URL（組み立てた後。組み立てなかったら null。ArtifactWriter が書くときに伏せ字を通す）。 */
  readonly url: string | null;
  /** READ の URL の応答の HTTP の状態（読まなかった、応答がなかったら null）。 */
  readonly httpStatus: number | null;
  /** READ の URL の読み込みで、Guard が止めて記録した要求の数（ページ自身が出した送信）。 */
  readonly blockedRequests: number;
  /** 構造の要約（読んで照らしたときだけ）。 */
  readonly structure: ReadStructureSummary | null;
  /** 期待ごとの結果（読んで照らしたときだけ。定義の順）。 */
  readonly expectations: readonly ReadExpectationEvidence[];
}

/** 確かめなかった定義 1 件（止まった後の残り）。 */
export interface ReadCheckNotExecutedEvidence {
  readonly readCheckId: string;
  readonly readCheckRevision: number;
  readonly targetIdentityDigest: string;
  readonly state: Extract<ReadCheckEvidenceState, 'NOT_EXECUTED'>;
  readonly reason: ReadCheckNotExecutedReason;
}

export type ReadCheckEvidence = ReadCheckExecutedEvidence | ReadCheckNotExecutedEvidence;

/** 成果物 `read-evidence.json` の形。日時は UTC の 14 桁。 */
export interface ReadEvidenceDocument {
  readonly schemaVersion: typeof READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION;
  readonly jobId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runStatus: RunStatus;
  readonly endReason: ReadCheckEndReason;
  /** 定義（`START` の順）。 */
  readonly checks: readonly ReadCheckEvidence[];
}

/** 件数の要約（IPC の `FINISHED` で送る値。結果を載せない）。 */
export interface ReadEvidenceSummary {
  /** 定義の数。 */
  readonly checks: number;
  /** 確かめた定義の数。 */
  readonly executed: number;
}

// ---------------------------------------------------------------------------------------------------------------
// 候補の確かめ
// ---------------------------------------------------------------------------------------------------------------

/** 候補の確かめの結果。 */
export type ReadTargetConfirmation =
  | { readonly kind: 'CONFIRMED'; readonly candidate: DiscoveryCandidate }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_READ'; readonly candidate: DiscoveryCandidate };

/**
 * 今の画面の候補から、定義の対象を確かめる（純粋）。発見のジョブと同じく、同じ識別の digest の候補をまとめてから（中身の違う重複は
 * `DISPLAY_ONLY`。READ の対象にしない）、識別の digest で探す。ない → `NOT_FOUND`、今の分類が `READ` でない → `NOT_READ`。
 */
export const confirmReadTarget = (candidates: readonly DiscoveryCandidate[], identityDigest: string): ReadTargetConfirmation => {
  const candidate = mergeDiscoveryCandidates(candidates).find((merged) => merged.identityDigest === identityDigest);
  if (candidate === undefined) {
    return Object.freeze({ kind: 'NOT_FOUND' });
  }
  return Object.freeze(candidate.classification === READ_CLASSIFICATION ? { kind: 'CONFIRMED', candidate } : { kind: 'NOT_READ', candidate });
};

/** 候補の確かめの結果（画面を読み切れず、候補が見つからない `UNREADABLE` を含む）。 */
export type ReadCandidateConfirmation = ReadTargetConfirmation | { readonly kind: 'UNREADABLE' };

/**
 * 読んだ対象の画面で、定義の対象を確かめる（純粋）。候補が見つからず、画面を読み切れていない（`reliable` が偽）ときは、消えたと言わずに
 * `UNREADABLE`（`UNDETERMINED`）。ほかは `confirmReadTarget` のとおり。
 */
export const confirmReadTargetOnPage = (
  page: { readonly candidates: readonly DiscoveryCandidate[]; readonly reliable: boolean },
  identityDigest: string,
): ReadCandidateConfirmation => {
  const confirmation = confirmReadTarget(page.candidates, identityDigest);
  return confirmation.kind === 'NOT_FOUND' && !page.reliable ? Object.freeze({ kind: 'UNREADABLE' }) : confirmation;
};

// ---------------------------------------------------------------------------------------------------------------
// URL の組み立て
// ---------------------------------------------------------------------------------------------------------------

/** URL の組み立ての結果。 */
export type ReadCheckUrlBuild =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly detail: Extract<ReadCheckDetail, 'SECRET_LIKE_PARAMETER' | 'PARAMETER_DANGEROUS_WORD' | 'URL_NOT_BUILT'> };

/**
 * READ の URL を組み立てる（純粋）。候補の送信先（Origin と path）に、送る値（定義の順）を `URLSearchParams` の符号化で付ける。送信先の query の
 * 名前は使わない（GET の form は、送るときに送信先の query を置き換える）。
 * - 秘密に見える名前があれば、組み立てない（`SECRET_LIKE_PARAMETER`）。
 * - 名前か値が、発見の分類の危険な語に当たれば、組み立てない（`PARAMETER_DANGEROUS_WORD`。T27R-fix-1。DEF-088 の (b)）。
 * - 組み立てた URL の Origin と path が送信先と違う（path が `//` で始まるなど）、http(s) でない、長さが `MAX_URL_LENGTH` を超える → `URL_NOT_BUILT`。
 */
export const buildReadCheckUrl = (action: CandidateLocation, parameters: ReadCheckParameters): ReadCheckUrlBuild => {
  const names = Object.keys(parameters);
  if (names.some(isSecretUrlQueryParameterName)) {
    return Object.freeze({ ok: false, detail: 'SECRET_LIKE_PARAMETER' });
  }
  if (readParametersHaveDestructiveWord(parameters)) {
    return Object.freeze({ ok: false, detail: 'PARAMETER_DANGEROUS_WORD' });
  }
  let url: URL;
  try {
    url = new URL(action.origin);
    url.pathname = action.path;
  } catch {
    return Object.freeze({ ok: false, detail: 'URL_NOT_BUILT' });
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== action.origin || url.pathname !== action.path) {
    return Object.freeze({ ok: false, detail: 'URL_NOT_BUILT' });
  }
  const search = new URLSearchParams();
  for (const name of names) {
    search.append(name, parameters[name] ?? '');
  }
  const query = search.toString();
  const built = `${url.origin}${url.pathname}${query.length > 0 ? `?${query}` : ''}`;
  return built.length > MAX_URL_LENGTH ? Object.freeze({ ok: false, detail: 'URL_NOT_BUILT' }) : Object.freeze({ ok: true, url: built });
};

// ---------------------------------------------------------------------------------------------------------------
// 照らす
// ---------------------------------------------------------------------------------------------------------------

/** 比べる形（空白をまとめる。大文字と小文字は区別する）。期待の値とページの値の両方に使う。 */
export const readTextForComparison = (value: string): string => normalizeWhitespace(value);

/** 行を数える構造（表があれば表、なければ一覧）。1 つでなければ数えない。 */
const rowCountOf = (structure: ReadPageStructure):
  | { readonly ok: true; readonly source: ReadRowSource; readonly count: number }
  | { readonly ok: false; readonly reason: ReadExpectationUndeterminedReason } => {
  if (structure.limitReached) {
    return { ok: false, reason: 'STRUCTURE_LIMIT_REACHED' };
  }
  const [source, counts]: readonly [ReadRowSource, readonly number[]] = structure.tableRowCounts.length > 0
    ? ['TABLE', structure.tableRowCounts]
    : ['LIST', structure.listItemCounts];
  const [count] = counts;
  if (count === undefined) {
    return { ok: false, reason: 'STRUCTURE_NOT_FOUND' };
  }
  return counts.length === 1 ? { ok: true, source, count } : { ok: false, reason: 'STRUCTURE_AMBIGUOUS' };
};

const matchedOf = (matched: boolean): ReadExpectationResult => (matched ? 'MATCHED' : 'NOT_MATCHED');

/**
 * 期待 1 件と照らす（純粋）。規則:
 * - `ROW_COUNT_EQUALS`・`ROW_COUNT_AT_LEAST`: 主な領域に表があれば表、なければ一覧の、ただ 1 つの構造の行の数（表は `tbody` の `td` を持つ `tr`、
 *   一覧は子の `li`）。構造がない → `STRUCTURE_NOT_FOUND`、2 つ以上 → `STRUCTURE_AMBIGUOUS`、上限 → `STRUCTURE_LIMIT_REACHED`（どれも
 *   `UNDETERMINED`）。
 * - `TEXT_CONTAINS`: 主な領域の見えている文字（空白をまとめた）が、期待の文（空白をまとめた）を含む。含まず、文字を読み切れていない（上限）→
 *   `UNDETERMINED`。
 * - `DETAIL_FIELD_EQUALS`: 詳細（`dl`）の `dt` の文字が `field` と同じ項目が、ちょうど 1 つあり、その `dd` の文字が `value` と同じ（どちらも空白を
 *   まとめて比べる）。詳細がない → `STRUCTURE_NOT_FOUND`、同じ名前の項目が 2 つ以上 → `STRUCTURE_AMBIGUOUS`、詳細はあるが項目がない →
 *   `NOT_MATCHED`（上限に達していれば `UNDETERMINED`）。
 * - 落ち着きの待ちの上限までに画面が落ち着かなかった（`settled` が偽）: 見つかった文字（`TEXT_CONTAINS` の `MATCHED`）のほかは、`UNDETERMINED`
 *   （`PAGE_NOT_SETTLED`）。
 */
export const evaluateReadExpectation = (structure: ReadPageStructure, expectation: ReadCheckExpectation): ReadExpectationEvidence => {
  const evidence = evaluateSettledReadExpectation(structure, expectation);
  // 落ち着かなかった画面: 見つかった文字（後から消えても、一度は見えていた）のほかは、判定しない。
  if (structure.settled || evidence.result === 'UNDETERMINED' || (evidence.expectation.kind === 'TEXT_CONTAINS' && evidence.result === 'MATCHED')) {
    return evidence;
  }
  switch (evidence.expectation.kind) {
    case 'ROW_COUNT_EQUALS':
    case 'ROW_COUNT_AT_LEAST':
      return Object.freeze({ expectation: evidence.expectation, ...NOT_SETTLED, rowSource: null, observedRowCount: null });
    case 'TEXT_CONTAINS':
      return Object.freeze({ expectation: evidence.expectation, ...NOT_SETTLED, found: null });
    case 'DETAIL_FIELD_EQUALS':
      return Object.freeze({ expectation: evidence.expectation, ...NOT_SETTLED, observedValue: null });
  }
};

/** 落ち着かなかった画面の、判定しない結果。 */
const NOT_SETTLED = Object.freeze({ result: 'UNDETERMINED', undeterminedReason: 'PAGE_NOT_SETTLED' } as const);

/** 期待 1 件と照らす（落ち着いた画面として。`evaluateReadExpectation` の規則）。 */
const evaluateSettledReadExpectation = (structure: ReadPageStructure, expectation: ReadCheckExpectation): ReadExpectationEvidence => {
  switch (expectation.kind) {
    case 'ROW_COUNT_EQUALS':
    case 'ROW_COUNT_AT_LEAST': {
      const rows = rowCountOf(structure);
      if (!rows.ok) {
        return Object.freeze({ expectation, result: 'UNDETERMINED', undeterminedReason: rows.reason, rowSource: null, observedRowCount: null });
      }
      const matched = expectation.kind === 'ROW_COUNT_EQUALS' ? rows.count === expectation.count : rows.count >= expectation.count;
      return Object.freeze({ expectation, result: matchedOf(matched), undeterminedReason: null, rowSource: rows.source, observedRowCount: rows.count });
    }
    case 'TEXT_CONTAINS': {
      const found = readTextForComparison(structure.text).includes(readTextForComparison(expectation.text));
      if (!found && structure.limitReached) {
        return Object.freeze({ expectation, result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_LIMIT_REACHED', found: null });
      }
      return Object.freeze({ expectation, result: matchedOf(found), undeterminedReason: null, found });
    }
    case 'DETAIL_FIELD_EQUALS': {
      const field = readTextForComparison(expectation.field);
      const entries = structure.detailEntries.filter((entry) => readTextForComparison(entry.term) === field);
      const [entry] = entries;
      if (entry === undefined) {
        const reason: ReadExpectationUndeterminedReason | null = structure.limitReached
          ? 'STRUCTURE_LIMIT_REACHED'
          : (structure.detailEntries.length === 0 ? 'STRUCTURE_NOT_FOUND' : null);
        return Object.freeze({ expectation, result: reason === null ? 'NOT_MATCHED' : 'UNDETERMINED', undeterminedReason: reason, observedValue: null });
      }
      if (entries.length > 1) {
        return Object.freeze({ expectation, result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_AMBIGUOUS', observedValue: null });
      }
      const observed = readTextForComparison(entry.value);
      return Object.freeze({
        expectation,
        result: matchedOf(observed === readTextForComparison(expectation.value)),
        undeterminedReason: null,
        observedValue: observed.slice(0, MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH).toWellFormed(),
      });
    }
  }
};

/** 期待のすべてと照らす（定義の順）。 */
export const evaluateReadExpectations = (
  structure: ReadPageStructure,
  expectations: readonly ReadCheckExpectation[],
): readonly ReadExpectationEvidence[] => Object.freeze(expectations.map((expectation) => evaluateReadExpectation(structure, expectation)));

/**
 * 期待ごとの結果から、定義の結果を決める（純粋）。1 つでも `NOT_MATCHED` なら `NOT_MATCHED`（はっきり違う）、そうでなく 1 つでも `UNDETERMINED`
 * なら `UNDETERMINED`、すべて `MATCHED` なら `MATCHED`。期待が 0 件（契約で起きない）なら `UNDETERMINED`。
 */
export const readCheckResultOf = (evidence: readonly ReadExpectationEvidence[]): ReadExpectationResult => {
  if (evidence.some(({ result }) => result === 'NOT_MATCHED')) {
    return 'NOT_MATCHED';
  }
  return evidence.length > 0 && evidence.every(({ result }) => result === 'MATCHED') ? 'MATCHED' : 'UNDETERMINED';
};

/** 構造の要約（件数だけ）。 */
export const readStructureSummaryOf = (structure: ReadPageStructure): ReadStructureSummary => Object.freeze({
  region: structure.region,
  tables: structure.tableRowCounts.length,
  tableRowCounts: Object.freeze(structure.tableRowCounts.slice(0, MAX_READ_EVIDENCE_STRUCTURE_COUNTS)),
  lists: structure.listItemCounts.length,
  listItemCounts: Object.freeze(structure.listItemCounts.slice(0, MAX_READ_EVIDENCE_STRUCTURE_COUNTS)),
  detailFields: structure.detailEntries.length,
  textLength: readTextForComparison(structure.text).length,
  limitReached: structure.limitReached,
  settled: structure.settled,
});

// ---------------------------------------------------------------------------------------------------------------
// 件数の要約と Run Status
// ---------------------------------------------------------------------------------------------------------------

/** 件数の要約（定義の数と、確かめた数）。 */
export const readEvidenceSummaryOf = (document: Pick<ReadEvidenceDocument, 'checks'>): ReadEvidenceSummary => Object.freeze({
  checks: document.checks.length,
  executed: document.checks.filter(({ state }) => state === 'EXECUTED').length,
});

/**
 * READ の確かめの Run Status（成果物の `runStatus`。ワーカーの終了コードと、ジョブの行の Run の状態になる）。判定は、Run Status の唯一の owner
 * `deriveRunStatus` に任せ、ここでは事実を、その入力に写すだけにする（GATE-ARCH05）。
 * - 違反（終わり方 `SAFETY_VIOLATION`）→ 違反の件数。PREFLIGHT の失敗 → `preflightFailed`。実行の時間の上限 → `crawlLimitReached`。
 * - 止める要求とセッションの切れ（すべてを確かめる前に止まった）→ `executionComplete` が偽。
 * - 確かめなかった定義 → `skippedRequiredWork`、判定できなかった定義（`UNDETERMINED`）→ `notVerifiedRequiredWork`。
 * 結果: 違反は `ABORTED_BY_SAFETY`、PREFLIGHT の失敗は `FAILED`、すべてを確かめて `UNDETERMINED` がなければ `COMPLETE`（`NOT_MATCHED` などの
 * 結果は、確かめた結果として `COMPLETE` のまま）、ほかは `PARTIAL`。
 */
export const readEvidenceRunStatusOf = (input: Pick<ReadEvidenceDocument, 'endReason' | 'checks'>): RunStatus => deriveRunStatus({
  preflightFailed: input.endReason === 'PREFLIGHT_FAILED',
  safetyInvariantViolations: input.endReason === 'SAFETY_VIOLATION' ? 1 : 0,
  safetyLedgerTruncated: false,
  incompleteReasons: [],
  unhandledFailures: 0,
  crawlLimitReached: input.endReason === 'MAX_RUNTIME_REACHED',
  requiredArtifactsValid: true,
  executionComplete: input.endReason === 'COMPLETED' || input.endReason === 'MAX_RUNTIME_REACHED',
  skippedRequiredWork: input.checks.filter(({ state }) => state === 'NOT_EXECUTED').length,
  blockedRequiredWork: 0,
  timedOutRequiredWork: 0,
  notObservedRequiredWork: 0,
  notVerifiedRequiredWork: input.checks.filter((check) => check.state === 'EXECUTED' && check.result === 'UNDETERMINED').length,
  failedRequiredWork: 0,
  incompleteCollectorCount: 0,
});

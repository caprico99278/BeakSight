/**
 * BN-c（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.3・3.4）: BeakSight の遮断と指摘の関係の語彙の唯一の owner。
 * - 区分（`BEAKSIGHT_BLOCK_RELATIONS`）、理由のコード（`BEAKSIGHT_BLOCK_RELATION_REASONS`。閉じた一覧）、遮断の種類（`BEAKSIGHT_BLOCK_KINDS`）と、要求の種類から
 *   遮断の種類への対応（`beaksightBlockKindOf`）と、先読みの遮断の見分け（`isSpeculativeBlockRecord`）を置く。
 * - 判定（どの指摘をどの区分にするか）は、表示用モデルの組み立ての 1 か所（`src/report/beaksight-block-relation.ts`。呼ぶのは `src/report/view-model.ts` だけ）が行う。
 *   Rule ごとの「結果が変わりうる遮断の種類の集まり」は、Rule の定義の owner の表（`src/audit/rule-block-sensitivity.ts`）が持つ。
 * - 表示（ラベル・色・順）は、表示カタログ（`src/presentation/catalog.ts` の `BEAKSIGHT_BLOCK_RELATION_CATALOG`）が持つ。理由の説明は `messages.ts`。
 */
import type { BlockedAuditExclusionEvent, BlockedClosingRequestEvent, BlockedRequestEvent } from './evidence-types.js';

/**
 * 指摘と BeakSight の遮断の関係の区分（設計書 3.3）。SAFETY の指摘は、この区分の外（区分を持たない）。
 * - `CAUSED`: 遮断が原因（確実なものだけ）。
 * - `POSSIBLE`: 遮断の影響の可能性。
 * - `NONE`: 遮断と結び付かない（真のバグの候補）。
 */
export const BEAKSIGHT_BLOCK_RELATIONS = Object.freeze(['CAUSED', 'POSSIBLE', 'NONE'] as const);
export type BeakSightBlockRelation = (typeof BEAKSIGHT_BLOCK_RELATIONS)[number];

/**
 * 区分の理由のコードの閉じた一覧（設計書 3.3）。どの理由がどの区分かは `BEAKSIGHT_BLOCK_RELATION_OF_REASON` の 1 か所で決める。
 * - `TARGET_REQUEST_BLOCKED`（`CAUSED`）: 指摘の対象の要求（読み込みに失敗した script・stylesheet・画像）を、BeakSight が止めた（その URL の失敗が、どれも BeakSight の
 *   遮断）。
 * - `TARGET_NAVIGATION_BLOCKED`（`CAUSED`）: 行き先の移動の失敗の詳細が、BeakSight の遮断（`ERR_BLOCKED_BY_CLIENT`）。
 * - `MAIN_FRAME_NAVIGATION_BLOCKED`（`CAUSED`。BN-R1 の I-1・N-1）: 結び付く読み込みで、BeakSight が main frame の移動（ページ自身が始めた移動を含む）を止め、指摘の
 *   Evidence が測ったのが止めた後の Chromium のエラーの画面だと、記録から分かる（パフォーマンスの Evidence の navigation timing の URL が止めた移動の行き先で、
 *   指摘の Evidence がその後に測ったもの）。測った画面で結果が変わりうる Rule の指摘だけ。
 * - `MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED`（`POSSIBLE`。BN-R1 の N-1）: 結び付く読み込みで、BeakSight が main frame の移動を止めたが、指摘の Evidence が
 *   エラーの画面を測ったかは、記録から分からない（移動を止めたのが、測った後のこともある）。
 * - `TARGET_REQUEST_PARTLY_BLOCKED`（`POSSIBLE`）: 指摘の対象の要求の失敗の一部だけが、BeakSight の遮断。
 * - `FETCH_FAILED_WITH_DATA_BLOCK`（`POSSIBLE`）: 捕まえない `Failed to fetch` で、同じ読み込みで BeakSight がデータの要求（fetch・xhr）を止めた（どの呼び出しかの記録は
 *   ないので、原因とは言い切らない）。
 * - `DISABLED_FEATURE`（`POSSIBLE`）: BeakSight が起動の引数で無効にした機能（SharedWorker）を、ページが呼んだ例外。
 * - `SENSITIVE_KIND_BLOCKED`（`POSSIBLE`）: 同じ読み込みの間（閉じ始める前。時点 `LOAD`。測りの後も含む）に、その Rule の結果を変えうる種類の要求を、BeakSight が止めた。
 * - `NO_BLOCK_IN_LOAD`（`NONE`）: 結び付く読み込みの間（閉じ始める前）に、見える種類の遮断がない。
 * - `RULE_NOT_SENSITIVE`（`NONE`）: 遮断はあるが、その Rule の結果を変えうる種類ではない。
 */
export const BEAKSIGHT_BLOCK_RELATION_REASONS = Object.freeze([
  'TARGET_REQUEST_BLOCKED',
  'TARGET_NAVIGATION_BLOCKED',
  'MAIN_FRAME_NAVIGATION_BLOCKED',
  'MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED',
  'TARGET_REQUEST_PARTLY_BLOCKED',
  'FETCH_FAILED_WITH_DATA_BLOCK',
  'DISABLED_FEATURE',
  'SENSITIVE_KIND_BLOCKED',
  'NO_BLOCK_IN_LOAD',
  'RULE_NOT_SENSITIVE',
] as const);
export type BeakSightBlockRelationReason = (typeof BEAKSIGHT_BLOCK_RELATION_REASONS)[number];

/** 理由のコードごとの区分（書き漏れは型のエラーになる）。 */
export const BEAKSIGHT_BLOCK_RELATION_OF_REASON = Object.freeze({
  TARGET_REQUEST_BLOCKED: 'CAUSED',
  TARGET_NAVIGATION_BLOCKED: 'CAUSED',
  MAIN_FRAME_NAVIGATION_BLOCKED: 'CAUSED',
  MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED: 'POSSIBLE',
  TARGET_REQUEST_PARTLY_BLOCKED: 'POSSIBLE',
  FETCH_FAILED_WITH_DATA_BLOCK: 'POSSIBLE',
  DISABLED_FEATURE: 'POSSIBLE',
  SENSITIVE_KIND_BLOCKED: 'POSSIBLE',
  NO_BLOCK_IN_LOAD: 'NONE',
  RULE_NOT_SENSITIVE: 'NONE',
} as const satisfies Record<BeakSightBlockRelationReason, BeakSightBlockRelation>);

/**
 * ページの JS と測りから見える遮断の種類の閉じた一覧（設計書 3.3 の「見える種類」）。`DATA` は、ページのデータの要求（fetch・xhr）。`ping`（sendBeacon・
 * `<a ping>`）とそのほかの種類は、見える種類に入れない（遮断の種類を持たない）。
 */
export const BEAKSIGHT_BLOCK_KINDS = Object.freeze(['SCRIPT', 'STYLESHEET', 'FONT', 'IMAGE', 'DATA', 'DOCUMENT', 'WEBSOCKET'] as const);
export type BeakSightBlockKind = (typeof BEAKSIGHT_BLOCK_KINDS)[number];

/**
 * 遮断の種類が定まらないことの印（BN-R0 の M-1）。Guard の記録の種類は CDP の Fetch の値で、ページから見た種類とずれる（`<link rel=prefetch>` が `fetch`、Worker の
 * script が `other`）。記録だけでは種類が定まらないときと、記録の間で種類が合わないときに使う。敏感な Rule（変わりうる種類が空でない Rule）の判定では、
 * 「変わりうる」の側に倒す（`POSSIBLE` の元にする）。
 */
export const BEAKSIGHT_UNCERTAIN_BLOCK_KIND = 'UNCERTAIN';
/** 結び付いた遮断の参照の、要求の種類（見える種類か、定まらない印）。 */
export type BeakSightBlockRefKind = BeakSightBlockKind | typeof BEAKSIGHT_UNCERTAIN_BLOCK_KIND;

/**
 * 遮断の記録の出どころ。
 * - `GUARD`: Guard の記録（safety の Evidence の `resourceType`。CDP の Fetch の値）。
 * - `PAGE`: network の Evidence（Playwright の `Request.resourceType()`。ページから見た種類）。
 */
export const BEAKSIGHT_BLOCK_RECORD_SOURCES = Object.freeze(['GUARD', 'PAGE'] as const);
export type BeakSightBlockRecordSource = (typeof BEAKSIGHT_BLOCK_RECORD_SOURCES)[number];

/**
 * 要求の種類（小文字）から、遮断の種類への対応（出どころごと。唯一の置き場所。BN-c の設計者の判断 1 と、BN-R0 の M-1）。
 * - Guard の記録は、ページの fetch を `xhr` と残す。`fetch` は `<link rel=prefetch>` のこともあり、`other` は Worker の script のこともあるので、定まらない印にする。
 * - network の Evidence は、ページの fetch を `fetch` と残す（`xhr` も同じ `DATA`）。
 * - 表にない種類（`ping`・`prefetch`・`manifest` など）は、ページの JS と測りから見えないので、遮断の種類を持たない（`null`）。
 * 鍵は、要求の種類の閉じた一覧（`src/safety/request-policy.ts` の `REQUEST_RESOURCE_TYPES`）の値（一致は `tests/unit/beaksight-block-relation.test.ts`）。
 */
const RESOURCE_TYPE_BLOCK_KINDS = Object.freeze({
  GUARD: Object.freeze({
    script: 'SCRIPT',
    stylesheet: 'STYLESHEET',
    font: 'FONT',
    image: 'IMAGE',
    xhr: 'DATA',
    // 鍵は引用符で書く（送る口の参照の検査が、`fetch` の名前の参照と取り違えないため）。
    'fetch': BEAKSIGHT_UNCERTAIN_BLOCK_KIND,
    other: BEAKSIGHT_UNCERTAIN_BLOCK_KIND,
    document: 'DOCUMENT',
    websocket: 'WEBSOCKET',
  }),
  PAGE: Object.freeze({
    script: 'SCRIPT',
    stylesheet: 'STYLESHEET',
    font: 'FONT',
    image: 'IMAGE',
    'fetch': 'DATA',
    xhr: 'DATA',
    document: 'DOCUMENT',
    websocket: 'WEBSOCKET',
  }),
} as const satisfies Record<BeakSightBlockRecordSource, Readonly<Record<string, BeakSightBlockRefKind>>>);

/**
 * 記録の要求の種類から、遮断の種類を引く（大文字と小文字を区別しない）。見える種類でない値は `null`。LG-4: 記録は種類を必ず持つ（種類のない前の版の
 * 記録は読まない）。
 */
export function beaksightBlockKindOf(resourceType: string, source: BeakSightBlockRecordSource): BeakSightBlockRefKind | null {
  const table: Readonly<Record<string, BeakSightBlockRefKind>> = RESOURCE_TYPE_BLOCK_KINDS[source];
  const lower = resourceType.toLowerCase();
  return Object.hasOwn(table, lower) ? (table[lower] ?? null) : null;
}

/**
 * 同じ要求（同じ読み込み・時点・method・URL）の、記録ごとの種類を 1 つにする（BN-R0 の M-1。結び付けは URL と method で行い、種類は補助）。
 * - 見える種類が 1 つだけで、見えない種類（`null`）の記録がなければ、その種類。
 * - 見える種類が 2 つ以上か、見える種類と見えない種類が混ざれば（種類が合わない）、定まらない印。
 * - 見える種類がなければ、定まらない印の記録があればそれ、なければ `null`（遮断の種類を持たない）。
 */
export function reconcileBeakSightBlockKinds(kinds: readonly (BeakSightBlockRefKind | null)[]): BeakSightBlockRefKind | null {
  const visible = new Set(kinds.filter((kind): kind is BeakSightBlockKind => kind !== null && kind !== BEAKSIGHT_UNCERTAIN_BLOCK_KIND));
  const hasInvisible = kinds.includes(null);
  if (visible.size === 0) {
    return kinds.includes(BEAKSIGHT_UNCERTAIN_BLOCK_KIND) ? BEAKSIGHT_UNCERTAIN_BLOCK_KIND : null;
  }
  const [only] = visible;
  return visible.size === 1 && !hasInvisible && only !== undefined ? only : BEAKSIGHT_UNCERTAIN_BLOCK_KIND;
}

/**
 * BN-R1 の M-2: 先読み（`<link rel=prefetch>`・prerender。次の移動のために取りに行く要求）の遮断は、今の画面の描画に効かないので、区分の判定では見えない種類と
 * して扱う（`POSSIBLE` の元にしない）。
 * - Guard の記録の先読みの印の項目の名前（`speculative: true`。止めた要求 `BlockedRequestEvent`・監査の段の除外 `BlockedAuditExclusionEvent`・閉じる途中の記録
 *   `BlockedClosingRequestEvent` の事象。印を付けるのは Guard の側）。印のない記録（前の版と、印を付ける前の記録）は、今どおり種類の対応で読む（Guard の `fetch` は
 *   定まらない印）。
 * - 要求の種類が先読みのもの（`prefetch`・`signedexchange`。どちらの出どころでも）。
 */
export const BEAKSIGHT_BLOCK_SPECULATIVE_MARK = 'speculative' as const satisfies keyof BlockedRequestEvent & keyof BlockedAuditExclusionEvent & keyof BlockedClosingRequestEvent;
const SPECULATIVE_RESOURCE_TYPES: ReadonlySet<string> = new Set(['prefetch', 'signedexchange']);

/** 先読みの印を持ちうる、止めた要求の記録（network の Evidence の失敗のように、印を持たない記録も渡せる）。 */
export type SpeculativeMarkFact = Partial<Pick<BlockedRequestEvent, typeof BEAKSIGHT_BLOCK_SPECULATIVE_MARK>>;

/** 止めた要求の記録が、先読みの遮断か（記録の印か、要求の種類で見分ける）。 */
export function isSpeculativeBlockRecord(record: SpeculativeMarkFact, resourceType: string | null | undefined): boolean {
  return record[BEAKSIGHT_BLOCK_SPECULATIVE_MARK] === true
    || (typeof resourceType === 'string' && SPECULATIVE_RESOURCE_TYPES.has(resourceType.toLowerCase()));
}

/** 対応の表の鍵（要求の種類。テストが `REQUEST_RESOURCE_TYPES` と照らすため）。 */
export const BEAKSIGHT_BLOCK_KIND_RESOURCE_TYPES: readonly string[] = Object.freeze([
  ...new Set(BEAKSIGHT_BLOCK_RECORD_SOURCES.flatMap((source) => Object.keys(RESOURCE_TYPE_BLOCK_KINDS[source]))),
]);

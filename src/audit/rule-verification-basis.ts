/**
 * AUD-6a（設計書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md`）: Rule ごとの「検証の根拠」（その Rule の指摘を、何で確かめたか）の唯一の表
 * （Rule の定義の owner の 1 か所）。
 * - 鍵は、Rule の定義の `ruleId`（page rule の `RULE_CATALOG`、Cross-page rule の `CROSS_PAGE_RULES`）と、評価のたびに ruleId を作る Rule の `ruleIdPrefix`。
 *   表と Rule の一覧の一致（書き漏れと余分）は `tests/unit/rule-verification.test.ts` が確かめる（このファイルは Rule の一覧を import しない。表示用モデルが
 *   import できるようにするため。`RULE_CATALOG` を読めるのは登録先と Rule Engine だけ。ARCH07。先例は `rule-block-sensitivity.ts`）。
 * - 指摘ごとの判定（欠けがあれば `UNVERIFIED`）は、表示用モデル（`src/report/view-model.ts`）が 1 回だけ行う。このファイルは表だけ。
 */

/**
 * 検証の根拠の閉じた一覧（弱い順）。
 * - `STATIC_CANDIDATE`: 文書の構造から見た候補（axe の多く、DOM の欄の欠け、ページ間の比べなど）。
 * - `RENDERED`: 描いた画面で確かめた（layout・色の差など）。
 * - `NAVIGATION_OBSERVED`: 読み込み・移動の結果で確かめた（HTTP の応答、資源の読み込み、リンクの行き先を開いた結果、性能の計測）。
 * - `INTERACTION_REPRODUCED`: 操作で再現した（操作への応答を測る INP だけ。INP は操作がないと観測されないので、今はほぼ 0 件）。
 */
export const RULE_VERIFICATION_BASES = Object.freeze(['STATIC_CANDIDATE', 'RENDERED', 'NAVIGATION_OBSERVED', 'INTERACTION_REPRODUCED'] as const);
export type RuleVerificationBasis = (typeof RULE_VERIFICATION_BASES)[number];

/** 表の 1 行（`ruleId` か `ruleIdPrefix` のどちらか 1 つ）。 */
export interface RuleVerificationBasisEntry {
  readonly ruleId?: string;
  readonly ruleIdPrefix?: string;
  readonly basis: RuleVerificationBasis;
}

const [STATIC_CANDIDATE, RENDERED, NAVIGATION_OBSERVED, INTERACTION_REPRODUCED] = RULE_VERIFICATION_BASES;

const id = (ruleId: string, basis: RuleVerificationBasis): RuleVerificationBasisEntry => Object.freeze({ ruleId, basis });

/** Rule ごとの検証の根拠の表（判断の根拠は各まとまりの注記）。 */
export const RULE_VERIFICATION_BASIS_TABLE: readonly RuleVerificationBasisEntry[] = Object.freeze([
  // --- HTTP（main frame の文書の応答を観測した） ---
  id('HTTP_4XX', NAVIGATION_OBSERVED),
  id('HTTP_5XX', NAVIGATION_OBSERVED),
  id('REDIRECT_LOOP', NAVIGATION_OBSERVED),
  id('EMPTY_HTTP_RESPONSE', NAVIGATION_OBSERVED),
  // --- LINK（DOM の href の形から見た候補。開いてはいない） ---
  id('INVALID_INTERNAL_URL', STATIC_CANDIDATE),
  // --- RESOURCE・JAVASCRIPT（読み込みの最中に観測した応答・失敗・例外） ---
  id('RESOURCE_4XX', NAVIGATION_OBSERVED),
  id('RESOURCE_5XX', NAVIGATION_OBSERVED),
  id('SCRIPT_LOAD_FAILED', NAVIGATION_OBSERVED),
  id('STYLESHEET_LOAD_FAILED', NAVIGATION_OBSERVED),
  id('IMAGE_LOAD_FAILED', NAVIGATION_OBSERVED),
  id('PAGE_ERROR', NAVIGATION_OBSERVED),
  // --- DOM・FORM（文書の構造から見た候補） ---
  id('MISSING_TITLE', STATIC_CANDIDATE),
  id('EMPTY_TITLE', STATIC_CANDIDATE),
  id('MISSING_HTML_LANG', STATIC_CANDIDATE),
  id('INVALID_CANONICAL_URL', STATIC_CANDIDATE),
  id('DUPLICATE_ELEMENT_ID', STATIC_CANDIDATE),
  id('FORM_WITHOUT_ACTION', STATIC_CANDIDATE),
  id('UNLABELED_REQUIRED_CONTROL', STATIC_CANDIDATE),
  // 見える文字（描いた画面の可視テキスト）で確かめる。
  id('EMPTY_VISIBLE_CONTENT', RENDERED),
  // --- LAYOUT（描いた画面の配置で確かめた） ---
  id('DOCUMENT_HORIZONTAL_OVERFLOW', RENDERED),
  id('ELEMENT_OUTSIDE_VIEWPORT', RENDERED),
  id('ELEMENT_OVERLAP', RENDERED),
  id('TEXT_CLIPPING', RENDERED),
  id('FIXED_ELEMENT_OCCLUSION', RENDERED),
  id('ZERO_SIZE_INTERACTIVE_ELEMENT', RENDERED),
  id('CONTENT_COLLISION', RENDERED),
  id('OVERSIZED_FIXED_ELEMENT', RENDERED),
  id('DYNAMIC_LAYOUT_SHIFT', RENDERED),
  id('NOTIFICATION_NOT_DISMISSIBLE', RENDERED),
  id('NOTIFICATION_HANDLED_BEFORE_AUDIT', RENDERED),
  // --- ACCESSIBILITY（色の差は描いた画面で測る。ほかの axe の Rule は文書の構造から見た候補） ---
  id('COLOR_CONTRAST_VIOLATION', RENDERED),
  // AUD-4d: フォーカスを当てた描いた画面（矩形・見えるか・hit-test）で確かめた。
  id('FOCUSED_CONTROL_HIDDEN', RENDERED),
  // FRET: キーボードで押して閉じる操作で再現した。
  id('DIALOG_FOCUS_NOT_RETURNED', INTERACTION_REPRODUCED),
  id('DIALOG_FOCUS_NOT_MOVED', INTERACTION_REPRODUCED),
  id('DIALOG_NOT_CLOSABLE_BY_KEYBOARD', INTERACTION_REPRODUCED),
  Object.freeze({ ruleIdPrefix: 'A11Y_', basis: STATIC_CANDIDATE }),
  // --- PERFORMANCE（読み込みの計測。INP だけは操作への応答） ---
  id('POOR_LCP', NAVIGATION_OBSERVED),
  id('POOR_FCP', NAVIGATION_OBSERVED),
  id('POOR_CLS', NAVIGATION_OBSERVED),
  id('POOR_TTFB', NAVIGATION_OBSERVED),
  id('POOR_INP', INTERACTION_REPRODUCED),
  // --- SAFETY（読み込み・移動の間に、BeakSight が止めた事実を観測した。候補の除外は DOM から見た判断） ---
  id('SAFETY_NON_READ_REQUEST_BLOCKED', NAVIGATION_OBSERVED),
  id('SAFETY_EXTERNAL_NAVIGATION_BLOCKED', NAVIGATION_OBSERVED),
  id('SAFETY_EXTERNAL_ACTION_BLOCKED', NAVIGATION_OBSERVED),
  id('SAFETY_DOWNLOAD_BLOCKED', NAVIGATION_OBSERVED),
  id('SAFETY_POPUP_BLOCKED', NAVIGATION_OBSERVED),
  id('SAFETY_WEBSOCKET_BLOCKED', NAVIGATION_OBSERVED),
  id('SAFETY_INTERACTION_CANDIDATE_EXCLUDED', STATIC_CANDIDATE),
  id('SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED', NAVIGATION_OBSERVED),
  id('SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED', NAVIGATION_OBSERVED),
  // --- Cross-page ---
  // 内部リンクは押さず、行き先の URL をクロールで開いた結果で確かめる（`cross-page-rules.ts`）。canonical の行き先も、開いた結果の応答で確かめる。
  id('BROKEN_INTERNAL_LINK', NAVIGATION_OBSERVED),
  id('TARGET_NAVIGATION_FAILED', NAVIGATION_OBSERVED),
  id('CANONICAL_TARGET_NOT_FOUND', NAVIGATION_OBSERVED),
  id('NAVIGATION_TIMEOUT', NAVIGATION_OBSERVED),
  id('UNEXPECTED_ORIGIN_REDIRECT', NAVIGATION_OBSERVED),
  // ページ間の文書の欄の比べと、sitemap の一覧との比べ（文書の構造から見た候補）。
  id('DUPLICATE_PAGE_TITLE', STATIC_CANDIDATE),
  id('DUPLICATE_CANONICAL', STATIC_CANDIDATE),
  id('MULTIPLE_URLS_SAME_CANONICAL', STATIC_CANDIDATE),
  id('INCONSISTENT_ORIGIN', STATIC_CANDIDATE),
  id('SITEMAP_URL_NOT_DISCOVERED', STATIC_CANDIDATE),
  id('DISCOVERED_URL_NOT_IN_SITEMAP', STATIC_CANDIDATE),
]);

/** 表にない ruleId（前の版の Rule・テストの仮の Rule など）の根拠: いちばん弱い候補の側にする（確かめたと言い過ぎないため）。 */
const UNLISTED_RULE_VERIFICATION_BASIS: RuleVerificationBasis = STATIC_CANDIDATE;

const BY_RULE_ID: ReadonlyMap<string, RuleVerificationBasis> = new Map(
  RULE_VERIFICATION_BASIS_TABLE.flatMap((entry) => (entry.ruleId === undefined ? [] : [[entry.ruleId, entry.basis] as const])),
);
const BY_PREFIX: readonly RuleVerificationBasisEntry[] = RULE_VERIFICATION_BASIS_TABLE.filter((entry) => entry.ruleIdPrefix !== undefined);

/** Finding の ruleId の検証の根拠（同じ ruleId の行、なければ接頭辞の行、どちらもなければ候補）。 */
export function ruleVerificationBasisOf(ruleId: string): RuleVerificationBasis {
  return BY_RULE_ID.get(ruleId)
    ?? BY_PREFIX.find((entry) => entry.ruleIdPrefix !== undefined && ruleId.startsWith(entry.ruleIdPrefix))?.basis
    ?? UNLISTED_RULE_VERIFICATION_BASIS;
}

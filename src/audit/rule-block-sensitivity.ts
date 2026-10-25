/**
 * BN-c（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.4）: Rule ごとの「結果が変わりうる BeakSight の遮断の種類の集まり」と、
 * 遮断が原因の指摘（`CAUSED`）の対象の見つけ方の、唯一の表（Rule の定義の owner の 1 か所）。
 * - 鍵は、Rule の定義の `ruleId`（page rule の `RULE_CATALOG`、Cross-page rule の `CROSS_PAGE_RULES`）と、評価のたびに ruleId を作る Rule の `ruleIdPrefix`。
 *   表と Rule の一覧の一致（書き漏れと余分）は `tests/unit/rule-block-sensitivity.test.ts` が確かめる（このファイルは Rule の一覧を import しない。表示用モデルが
 *   import できるようにするため。`RULE_CATALOG` を読めるのは登録先と Rule Engine だけ。ARCH07）。
 * - 迷う Rule は「変わりうる」の側にする（ノイズを減らす向き。設計書 3.4）。迷った Rule は、`doubtful: true` を付ける（報告と見直しのため）。
 * - SAFETY の Rule は、区分の外（表示用モデルが severity で外す）。表には空の集まりで置く（一致の確かめのため）。
 * - 判定は `src/report/beaksight-block-relation.ts` が行う（このファイルは表だけ）。
 */
import { BEAKSIGHT_BLOCK_KINDS, type BeakSightBlockKind } from '../core/beaksight-block-relation.js';

/**
 * 遮断が原因の指摘（`CAUSED`）の、対象の見つけ方の閉じた一覧。
 * - `LOAD_FAILURE`: 参照する network の Evidence の、要求の種類が `resourceType` の失敗のうち、URL が指摘の文にあるもの（`domImages` が真なら、参照する DOM の
 *   Evidence の、読み込めなかった画像の `resolvedUrl` も）。その URL の失敗が、どれも BeakSight の遮断なら `CAUSED`、一部なら `POSSIBLE`。
 * - `TARGET_NAVIGATION`: 指摘の文にある行き先のページの、移動の失敗の詳細が BeakSight の遮断なら `CAUSED`。
 * - `PAGE_ERROR`: 捕まえない例外。BeakSight が無効にした機能の例外は `POSSIBLE`（`DISABLED_FEATURE`）、`Failed to fetch` は同じ読み込みでデータの要求を止めていれば
 *   `POSSIBLE`（`FETCH_FAILED_WITH_DATA_BLOCK`）。
 */
export type RuleBlockTarget =
  | { readonly kind: 'LOAD_FAILURE'; readonly resourceType: string; readonly domImages: boolean }
  | { readonly kind: 'TARGET_NAVIGATION' }
  | { readonly kind: 'PAGE_ERROR' };

/** 1 つの Rule の、遮断との関係の性質。 */
export interface RuleBlockSensitivity {
  /** 結果が変わりうる遮断の種類の集まり（`POSSIBLE` の元。`BEAKSIGHT_BLOCK_KINDS` の順）。変わりようのない Rule は空。 */
  readonly kinds: readonly BeakSightBlockKind[];
  /** 遮断が原因の指摘の、対象の見つけ方。持たない Rule は `null`。 */
  readonly target: RuleBlockTarget | null;
  /** 決めるのに迷った Rule（「変わりうる」の側に倒した、または空にした理由が弱いもの）。 */
  readonly doubtful: boolean;
  /**
   * BN-R0 の M-3: SAFETY の Rule が数える、時点（`phase`）を持つ止めた事象の一覧。持たない Rule は `null`。表示用モデルが、その指摘の事象の時点の別の件数（閉じる
   * 途中の遮断か）を出すのに使う。Rule が数える事象と一致することは `tests/unit/rule-block-sensitivity.test.ts` が SAFETY の Rule を評価して確かめる。
   */
  readonly safetyPhaseEvents: SafetyPhaseEvents | null;
}

/**
 * 時点を持つ止めた事象の一覧（safety の Evidence の項目）。
 * - `NON_READ_REQUESTS`: 止めた要求（`blockedRequests`）のうち、読み取りでない method のもの。
 * - `NAVIGATIONS`: 止めた main frame の移動（`blockedNavigations`）。
 * - `WEBSOCKETS`: 止めた WebSocket（`blockedWebSockets`）。
 */
export type SafetyPhaseEvents = 'NON_READ_REQUESTS' | 'NAVIGATIONS' | 'WEBSOCKETS';

/** 表の 1 行（`ruleId` か `ruleIdPrefix` のどちらか 1 つ）。 */
export interface RuleBlockSensitivityEntry extends RuleBlockSensitivity {
  readonly ruleId?: string;
  readonly ruleIdPrefix?: string;
}

// 種類の短い名前（表を読みやすくするため）。
const [SCRIPT, STYLESHEET, FONT, IMAGE, DATA, DOCUMENT, WEBSOCKET] = BEAKSIGHT_BLOCK_KINDS;
/** すべての見える種類。 */
const ALL_KINDS: readonly BeakSightBlockKind[] = BEAKSIGHT_BLOCK_KINDS;
/**
 * ページのスクリプトとデータ（JS が組む DOM・文書の欄）。BN-R1 の M-3: 「欠けの指摘」（題・本文・lang・canonical の欠け、ページ間の題と canonical、axe の題・lang・
 * main の目印・最上位の見出し・繰り返しを飛ばす手段の欠け）は、データ（fetch・xhr。読み取りでも読み取りでない送信でも）の遮断で起きうる（例外の `PAGE_ERROR` は
 * これに文書と WebSocket を足す）。`RESOURCE_4XX`・`5XX` は、サーバが返した応答の事実として、変わりうる種類を持たない（設計者の判断）。
 */
const SCRIPT_AND_DATA: readonly BeakSightBlockKind[] = [SCRIPT, DATA];
/**
 * BN-R1 の M-3: 表示された要素の欠陥（レイアウト・色のコントラスト・axe・重なった id・label のない必須の欄・action のない form）は、表示された部分の本当の欠陥。
 * データの遮断では変わらないとし、表示を作る script・stylesheet・font・image（BN-R1 の N-2。画像の大きさで配置と重なりが変わる）・子の文書（iframe）の遮断のとき
 * だけ、変わりうるとする。
 */
const DISPLAYED_ELEMENT: readonly BeakSightBlockKind[] = [SCRIPT, STYLESHEET, FONT, IMAGE, DOCUMENT];
/** 描画（CSS・字形・画像・スクリプト・データ・子の文書）。 */
const RENDERING: readonly BeakSightBlockKind[] = [SCRIPT, STYLESHEET, FONT, IMAGE, DATA, DOCUMENT];
const NOTHING: readonly BeakSightBlockKind[] = [];

/** 読み込みの失敗の Rule の、Playwright の要求の種類（`technical-rules.ts` の Rule と同じ値）。 */
const SCRIPT_RESOURCE_TYPE = 'script';
const STYLESHEET_RESOURCE_TYPE = 'stylesheet';
const IMAGE_RESOURCE_TYPE = 'image';

const row = (
  key: { readonly ruleId: string } | { readonly ruleIdPrefix: string },
  kinds: readonly BeakSightBlockKind[],
  options: { readonly target?: RuleBlockTarget; readonly doubtful?: boolean; readonly safetyPhaseEvents?: SafetyPhaseEvents } = {},
): RuleBlockSensitivityEntry =>
  Object.freeze({
    ...key,
    // 表示と比べやすいよう、`BEAKSIGHT_BLOCK_KINDS` の順に並べる。
    kinds: Object.freeze(BEAKSIGHT_BLOCK_KINDS.filter((kind) => kinds.includes(kind))),
    target: options.target ?? null,
    doubtful: options.doubtful ?? false,
    safetyPhaseEvents: options.safetyPhaseEvents ?? null,
  });

/**
 * Rule ごとの性質の表（設計書 3.4。判断の根拠は各行の注記）。
 * 迷った Rule（`doubtful`）は、BN-c の報告に一覧を貼る。
 */
export const RULE_BLOCK_SENSITIVITIES: readonly RuleBlockSensitivityEntry[] = Object.freeze([
  // --- HTTP（main frame の文書の応答。サーバが決める） ---
  row({ ruleId: 'HTTP_4XX' }, NOTHING),
  row({ ruleId: 'HTTP_5XX' }, NOTHING),
  row({ ruleId: 'REDIRECT_LOOP' }, NOTHING),
  row({ ruleId: 'EMPTY_HTTP_RESPONSE' }, NOTHING),
  // --- LINK（DOM のリンク。JS とデータが組むことがある） ---
  // 組み立ての途中の href（置き換えられなかった雛形など）が、スクリプトとデータの遮断で残りうる。
  row({ ruleId: 'INVALID_INTERNAL_URL' }, SCRIPT_AND_DATA),
  // 特殊な scheme のリンクは、遮断で生まれにくい（迷った）。
  row({ ruleId: 'UNSUPPORTED_URL_SCHEME' }, NOTHING, { doubtful: true }),
  // --- RESOURCE ---
  // サーバが返した応答の事実（`HTTP_4XX` と同じ。設計者の判断。`IMAGE_LOAD_FAILED` の扱いと合わせる）。
  row({ ruleId: 'RESOURCE_4XX' }, NOTHING),
  row({ ruleId: 'RESOURCE_5XX' }, NOTHING),
  // 読み込みの失敗は、その要求自身の事実。ほかの遮断では生まれない（自身の遮断は `CAUSED`）。
  row({ ruleId: 'SCRIPT_LOAD_FAILED' }, NOTHING, { target: { kind: 'LOAD_FAILURE', resourceType: SCRIPT_RESOURCE_TYPE, domImages: false } }),
  row({ ruleId: 'STYLESHEET_LOAD_FAILED' }, NOTHING, {
    target: { kind: 'LOAD_FAILURE', resourceType: STYLESHEET_RESOURCE_TYPE, domImages: false },
  }),
  // BN-R1 の M-3: 表示された画像の失敗は、表示された部分の本当の欠陥（データの遮断では外さない。表示を作る種類の遮断だけ。迷った）。
  row({ ruleId: 'IMAGE_LOAD_FAILED' }, DISPLAYED_ELEMENT, {
    target: { kind: 'LOAD_FAILURE', resourceType: IMAGE_RESOURCE_TYPE, domImages: true },
    doubtful: true,
  }),
  // --- JAVASCRIPT ---
  // 止めた script に頼る処理、止めたデータの要求・WebSocket・子の文書の扱いで、例外が出うる。
  row({ ruleId: 'PAGE_ERROR' }, [SCRIPT, DATA, DOCUMENT, WEBSOCKET], { target: { kind: 'PAGE_ERROR' } }),
  // --- DOM ---
  // 欠けの指摘（BN-R1 の M-3。JS とデータが組む文書の欄）。
  row({ ruleId: 'MISSING_TITLE' }, SCRIPT_AND_DATA),
  row({ ruleId: 'EMPTY_TITLE' }, SCRIPT_AND_DATA),
  row({ ruleId: 'MISSING_HTML_LANG' }, SCRIPT_AND_DATA),
  // 読み込みまで本文を隠す CSS もあるので、stylesheet も含める。
  row({ ruleId: 'EMPTY_VISIBLE_CONTENT' }, [SCRIPT, STYLESHEET, DATA]),
  row({ ruleId: 'INVALID_CANONICAL_URL' }, SCRIPT_AND_DATA),
  // 表示された要素の欠陥（BN-R1 の M-3）。
  row({ ruleId: 'DUPLICATE_ELEMENT_ID' }, DISPLAYED_ELEMENT),
  // --- FORM（表示された要素の欠陥。BN-R1 の M-3） ---
  row({ ruleId: 'FORM_WITHOUT_ACTION' }, DISPLAYED_ELEMENT),
  row({ ruleId: 'UNLABELED_REQUIRED_CONTROL' }, DISPLAYED_ELEMENT),
  // --- LAYOUT（表示された要素の欠陥。BN-R1 の M-3） ---
  row({ ruleId: 'DOCUMENT_HORIZONTAL_OVERFLOW' }, DISPLAYED_ELEMENT),
  row({ ruleId: 'ELEMENT_OUTSIDE_VIEWPORT' }, DISPLAYED_ELEMENT),
  row({ ruleId: 'ELEMENT_OVERLAP' }, DISPLAYED_ELEMENT),
  row({ ruleId: 'TEXT_CLIPPING' }, DISPLAYED_ELEMENT),
  row({ ruleId: 'FIXED_ELEMENT_OCCLUSION' }, DISPLAYED_ELEMENT),
  row({ ruleId: 'ZERO_SIZE_INTERACTIVE_ELEMENT' }, DISPLAYED_ELEMENT),
  row({ ruleId: 'CONTENT_COLLISION' }, DISPLAYED_ELEMENT),
  row({ ruleId: 'OVERSIZED_FIXED_ELEMENT' }, DISPLAYED_ELEMENT),
  row({ ruleId: 'DYNAMIC_LAYOUT_SHIFT' }, DISPLAYED_ELEMENT),
  // --- ACCESSIBILITY（表示された要素の欠陥。BN-R1 の M-3） ---
  row({ ruleId: 'COLOR_CONTRAST_VIOLATION' }, DISPLAYED_ELEMENT),
  // axe の Rule のうち、意味の上で欠けの指摘のもの（題・lang・main の目印・最上位の見出し・繰り返しを飛ばす手段の欠け）は、`MISSING_TITLE` などと同じ欠けの
  // 指摘のまとまりにする（設計者の判断。同じ欠けが別の区分に分かれないため）。接頭辞の行より先に引く（`ruleBlockSensitivityOf` は同じ ruleId の行を先に見る）。
  // ruleId は、axe のルールの ID を大文字の snake case にした形（`accessibility-rules.ts` の接頭辞 `A11Y_` の後ろ）。
  row({ ruleId: 'A11Y_DOCUMENT_TITLE' }, SCRIPT_AND_DATA),
  row({ ruleId: 'A11Y_HTML_HAS_LANG' }, SCRIPT_AND_DATA),
  row({ ruleId: 'A11Y_LANDMARK_ONE_MAIN' }, SCRIPT_AND_DATA),
  row({ ruleId: 'A11Y_PAGE_HAS_HEADING_ONE' }, SCRIPT_AND_DATA),
  row({ ruleId: 'A11Y_BYPASS' }, SCRIPT_AND_DATA),
  // ほかの axe の Rule は、表示された要素の欠陥（迷った）。
  row({ ruleIdPrefix: 'A11Y_' }, DISPLAYED_ELEMENT, { doubtful: true }),
  // --- PERFORMANCE ---
  row({ ruleId: 'POOR_LCP' }, RENDERING),
  row({ ruleId: 'POOR_FCP' }, [SCRIPT, STYLESHEET, FONT, IMAGE, DATA]),
  row({ ruleId: 'POOR_CLS' }, RENDERING),
  // main frame の文書の応答の時間（サーバが決める）。
  row({ ruleId: 'POOR_TTFB' }, NOTHING),
  // 操作への応答は、スクリプトとデータの扱いで変わりうる（迷った）。
  row({ ruleId: 'POOR_INP' }, SCRIPT_AND_DATA, { doubtful: true }),
  // --- SAFETY（区分の外） ---
  row({ ruleId: 'SAFETY_NON_READ_REQUEST_BLOCKED' }, NOTHING, { safetyPhaseEvents: 'NON_READ_REQUESTS' }),
  row({ ruleId: 'SAFETY_EXTERNAL_NAVIGATION_BLOCKED' }, NOTHING, { safetyPhaseEvents: 'NAVIGATIONS' }),
  row({ ruleId: 'SAFETY_EXTERNAL_ACTION_BLOCKED' }, NOTHING),
  row({ ruleId: 'SAFETY_DOWNLOAD_BLOCKED' }, NOTHING),
  row({ ruleId: 'SAFETY_POPUP_BLOCKED' }, NOTHING),
  row({ ruleId: 'SAFETY_WEBSOCKET_BLOCKED' }, NOTHING, { safetyPhaseEvents: 'WEBSOCKETS' }),
  row({ ruleId: 'SAFETY_INTERACTION_CANDIDATE_EXCLUDED' }, NOTHING),
  row({ ruleId: 'SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED' }, NOTHING),
  row({ ruleId: 'SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED' }, NOTHING),
  // --- Cross-page（結び付ける読み込みは、参照する Evidence のページとビューポート） ---
  // リンクは JS とデータが組むことがある（迷った）。行き先の移動の遮断は `CAUSED`。
  row({ ruleId: 'BROKEN_INTERNAL_LINK' }, SCRIPT_AND_DATA, { doubtful: true }),
  row({ ruleId: 'TARGET_NAVIGATION_FAILED' }, SCRIPT_AND_DATA, { target: { kind: 'TARGET_NAVIGATION' }, doubtful: true }),
  row({ ruleId: 'DUPLICATE_PAGE_TITLE' }, SCRIPT_AND_DATA),
  row({ ruleId: 'DUPLICATE_CANONICAL' }, SCRIPT_AND_DATA),
  row({ ruleId: 'MULTIPLE_URLS_SAME_CANONICAL' }, SCRIPT_AND_DATA),
  row({ ruleId: 'CANONICAL_TARGET_NOT_FOUND' }, SCRIPT_AND_DATA),
  row({ ruleId: 'INCONSISTENT_ORIGIN' }, SCRIPT_AND_DATA),
  // sitemap の Evidence だけを参照する（読み込みと結び付かない。迷った）。
  row({ ruleId: 'SITEMAP_URL_NOT_DISCOVERED' }, NOTHING, { doubtful: true }),
  row({ ruleId: 'DISCOVERED_URL_NOT_IN_SITEMAP' }, NOTHING),
  // 移動の期限と行き先の Origin は、BeakSight 自身の移動とサーバが決める。
  row({ ruleId: 'NAVIGATION_TIMEOUT' }, NOTHING),
  row({ ruleId: 'UNEXPECTED_ORIGIN_REDIRECT' }, NOTHING),
]);

/** 表にない ruleId（テストの仮の Rule など）の性質: 迷う側（すべての見える種類で変わりうる）。 */
const UNLISTED_RULE_SENSITIVITY: RuleBlockSensitivity = Object.freeze({ kinds: ALL_KINDS, target: null, doubtful: true, safetyPhaseEvents: null });

const BY_RULE_ID: ReadonlyMap<string, RuleBlockSensitivity> = new Map(
  RULE_BLOCK_SENSITIVITIES.flatMap((entry) => (entry.ruleId === undefined ? [] : [[entry.ruleId, entry] as const])),
);
const BY_PREFIX: readonly RuleBlockSensitivityEntry[] = RULE_BLOCK_SENSITIVITIES.filter((entry) => entry.ruleIdPrefix !== undefined);

/** Finding の ruleId の性質（同じ ruleId の行、なければ接頭辞の行、どちらもなければ迷う側）。 */
export function ruleBlockSensitivityOf(ruleId: string): RuleBlockSensitivity {
  const exact = BY_RULE_ID.get(ruleId);
  if (exact !== undefined) {
    return exact;
  }
  return BY_PREFIX.find((entry) => entry.ruleIdPrefix !== undefined && ruleId.startsWith(entry.ruleIdPrefix)) ?? UNLISTED_RULE_SENSITIVITY;
}

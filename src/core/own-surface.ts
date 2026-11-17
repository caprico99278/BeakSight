// 要素そのものが描く面があるかの判定（DEF-204。設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.5）。純粋な定義だけのファイル。
// - ページの中では、要素の計算値（背景・枠線・輪郭・影・背後のぼかし）と、自分の文字・疑似要素の内容があるかを、事実として読む（`OwnSurfaceFacts`）。
//   読むのは、固定の要素の収集（`src/evidence/layout-collector.ts`）と、通知の枠の読み取り（`src/interaction/notification-overlay.ts`）。
//   ページの中の関数は外の値を参照できないので、読み方はそれぞれの関数の中に書く（読む項目は、この型が決める）。
// - 描く面があるかは、Node の側で、この関数（`paintsOwnSurfaceOf`）だけが決める（判定の owner）。
// - 決められない値（読めない色の書き方など）は、描く面があるものとして扱う（今までどおり数える側に寄せる）。

/** 描く面の判定に読む、要素の計算値と事実（値は、ページの中の `getComputedStyle` の文字列のまま）。 */
export interface OwnSurfaceFacts {
  readonly backgroundColor: string;
  readonly backgroundImage: string;
  /** 上・右・下・左の枠線の、幅・線の種類・色。 */
  readonly borderWidths: readonly string[];
  readonly borderStyles: readonly string[];
  readonly borderColors: readonly string[];
  readonly outlineWidth: string;
  readonly outlineStyle: string;
  readonly outlineColor: string;
  readonly boxShadow: string;
  readonly backdropFilter: string;
  /** 子のテキストのノードに、空白でない文字があるか（走査の上限に達したときは true）。 */
  readonly hasOwnText: boolean;
  /** `::before`・`::after` に内容（`content` が `none`・`normal` でない）があるか。 */
  readonly hasPseudoContent: boolean;
  /** 画像・埋め込み・入力の欄など、要素そのものが中身を描く種類か。 */
  readonly replacedContent: boolean;
}

/** 線を描かない線の種類。 */
const NO_LINE_STYLES: ReadonlySet<string> = new Set(['none', 'hidden']);

/** 計算値の長さ（`0px` など）が 0 より大きいか。読めない値は、大きいものとして扱う。 */
const positiveLength = (value: string): boolean => {
  const parsed = Number.parseFloat(value);
  return !Number.isFinite(parsed) || parsed > 0;
};

/**
 * 計算値の色が、完全に透明か。`transparent` と、不透明度の成分が 0 の色（色の関数の成分が 4 つで、最後の成分が 0 の書き方）だけを透明とする。
 * 成分が 3 つの色と、読めない書き方は、透明でない。
 */
export const isTransparentColor = (value: string): boolean => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'transparent') {
    return true;
  }
  const inner = /^[a-z-]+\((.*)\)$/u.exec(trimmed)?.[1];
  if (inner === undefined) {
    return false;
  }
  const components = inner.split(/[\s,/]+/u).filter((component) => component.length > 0);
  const alpha = components.length === 4 || (inner.includes('/') && components.length >= 4) ? components.at(-1) : undefined;
  if (alpha === undefined) {
    return false;
  }
  const parsed = Number.parseFloat(alpha);
  return Number.isFinite(parsed) && parsed === 0;
};

/**
 * AUD-3c: 計算値の色の不透明度（0〜1）。`transparent` は 0、成分が 3 つの色は 1、4 つ目の成分（または `/` の後ろ）は数か百分率で読む。読めない書き方は `null`。
 */
export const colorAlphaOf = (value: string): number | null => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'transparent') {
    return 0;
  }
  const match = /^([a-z-]+)\((.*)\)$/u.exec(trimmed);
  const inner = match?.[2];
  if (match === null || inner === undefined) {
    return null;
  }
  const slash = inner.lastIndexOf('/');
  // `color()` の最初の成分は色の空間の名前（成分に数えない）。
  const components = inner.split(/[\s,/]+/u).filter((component) => component.length > 0).slice(match[1] === 'color' ? 1 : 0);
  const alphaText = slash >= 0 ? inner.slice(slash + 1).trim() : components.length === 4 ? components[3] : undefined;
  if (alphaText === undefined) {
    return 1;
  }
  const parsed = Number.parseFloat(alphaText);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.min(1, Math.max(0, alphaText.endsWith('%') ? parsed / 100 : parsed));
};

/** 線（枠線・輪郭）が見えるか（線の種類があり、幅が 0 より大きく、色が透明でない）。 */
const visibleLine = (width: string, style: string, color: string): boolean =>
  !NO_LINE_STYLES.has(style.trim().toLowerCase()) && positiveLength(width) && !isTransparentColor(color);

/** 要素そのものが描く面があるか（DEF-204。設計書 3.5）。 */
export const paintsOwnSurfaceOf = (facts: OwnSurfaceFacts): boolean => {
  if (facts.replacedContent || facts.hasOwnText || facts.hasPseudoContent) {
    return true;
  }
  if (!isTransparentColor(facts.backgroundColor) || facts.backgroundImage.trim().toLowerCase() !== 'none') {
    return true;
  }
  if (facts.boxShadow.trim().toLowerCase() !== 'none' || facts.backdropFilter.trim().toLowerCase() !== 'none') {
    return true;
  }
  if (visibleLine(facts.outlineWidth, facts.outlineStyle, facts.outlineColor)) {
    return true;
  }
  // 4 辺のどれかが読めない（並びが欠けた）ときは、描く面があるものとして扱う。
  if (facts.borderWidths.length !== 4 || facts.borderStyles.length !== 4 || facts.borderColors.length !== 4) {
    return true;
  }
  return facts.borderWidths.some((width, side) =>
    visibleLine(width, facts.borderStyles[side] ?? 'solid', facts.borderColors[side] ?? ''));
};

/** `pointer-events` の、要素が押下を受けない値。 */
export const POINTER_EVENTS_NONE = 'none';

/**
 * DEF-204: 描く面がなく、押下も受けない（`pointer-events: none`）、中の子だけが見える入れ物か。固定の要素の面積と覆いの規則は、この入れ物を数えない。
 * 記録のない項目（前の Evidence）は、入れ物でないものとして扱う（今までどおり数える）。
 */
export const isPassThroughContainer = (element: {
  readonly paintsOwnSurface?: boolean | undefined;
  readonly pointerEvents?: string | undefined;
}): boolean => element.paintsOwnSurface === false && element.pointerEvents === POINTER_EVENTS_NONE;

// L14（設計書 `doc/design/2026-11-09-beaksight-remove-limits-design.md` 6 の L14、網羅の設計書 3.3、INV-LIMITS の表 A の N6）: 幅の走査に足す、
// CSS の media query の境目の両側の幅。
// - 読み取り（`readMediaQueryConditionTexts`）: ページの CSS（`document.styleSheets` の規則の `@media`・`@import` の media と、`<link>`・`<style>` の
//   `media` の属性）から、media query の条件の文を集める。読めない stylesheet（別の Origin の CSS など、規則を読ませないもの）は飛ばす（限界）。
//   読み取りに失敗したら空（決まった幅だけで走査する）。ページの通信は出さない（読むだけ）。
// - 幅の求め方（`breakpointSideWidthsOf`。純粋な関数）: 幅の条件（`min-width`・`max-width`・範囲の書き方 `width >= 600px` など）の境目ごとに、当たる側と
//   当たらない側の幅（CSS ピクセルの整数）を 2 つ返す。単位は px・em・rem（em と rem は 16px で数える。ページの文字の大きさの指定は読まない）。
//   幅に依らない条件（`print`・`orientation`・`min-height` など）と、読めない単位（vw など）は使わない。数に上限は置かない（サイトの CSS に合わせる）。
// - 幅の走査に足すのは Page Auditor（`src/orchestration/page-auditor.ts` の幅の決め方）。読み込みの数は幅の数だけ増える（読み込みの間隔は今までどおり守る）。
import type { Page } from 'playwright';

/** em・rem を CSS ピクセルに直す値（ブラウザの既定の文字の大きさ）。 */
const CSS_PIXELS_PER_EM = 16;

/** 幅の値（数と単位）。 */
const LENGTH_SOURCE = String.raw`(-?\d+(?:\.\d+)?|-?\.\d+)\s*(px|em|rem)`;

/** `(min-width: 600px)`・`(max-width: 40em)` の形。 */
const MIN_MAX_WIDTH_PATTERN = new RegExp(String.raw`\(\s*(min|max)-width\s*:\s*${LENGTH_SOURCE}\s*\)`, 'giu');
/** `(width >= 600px)` の形（幅が左）。 */
const WIDTH_FIRST_RANGE_PATTERN = new RegExp(String.raw`(?<![-\w])width\s*(<=|>=|<|>)\s*${LENGTH_SOURCE}`, 'giu');
/** `(600px < width)` の形（幅が右）。 */
const WIDTH_LAST_RANGE_PATTERN = new RegExp(String.raw`${LENGTH_SOURCE}\s*(<=|>=|<|>)\s*width(?![-\w])`, 'giu');

/** 数と単位を CSS ピクセルに直す（読めなければ `undefined`）。 */
const pixelsOf = (value: string, unit: string): number | undefined => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return undefined;
  }
  return unit.toLowerCase() === 'px' ? number : number * CSS_PIXELS_PER_EM;
};

/**
 * 境目の両側の幅。`atLeast` が真なら「幅が `pixels` 以上で当たる」境目（当たらない最大の整数の幅と、当たる最小の整数の幅）、偽なら「幅が `pixels` 以下で
 * 当たる」境目（当たる最大の整数の幅と、当たらない最小の整数の幅）。`exclusive` は等号を含まない比べ方（`<`・`>`）。
 */
const sidesOf = (pixels: number, atLeast: boolean, exclusive: boolean): readonly number[] => {
  if (atLeast) {
    // 幅 >= p（または > p）で当たる。当たる最小の整数の幅。
    const firstMatching = exclusive ? Math.floor(pixels) + 1 : Math.ceil(pixels);
    return [firstMatching - 1, firstMatching];
  }
  // 幅 <= p（または < p）で当たる。当たる最大の整数の幅。
  const lastMatching = exclusive ? Math.ceil(pixels) - 1 : Math.floor(pixels);
  return [lastMatching, lastMatching + 1];
};

/** 範囲の書き方の比べ方の記号を、幅が左にある形の向きに直す（`600px < width` は `width > 600px`）。 */
const flippedOperator = (operator: string): string => ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=' })[operator] ?? operator;

/** 1 つの条件の文から、境目の両側の幅を集める。 */
const sideWidthsOfCondition = (condition: string): number[] => {
  const widths: number[] = [];
  for (const match of condition.matchAll(MIN_MAX_WIDTH_PATTERN)) {
    const pixels = pixelsOf(match[2] ?? '', match[3] ?? '');
    if (pixels !== undefined) {
      widths.push(...sidesOf(pixels, (match[1] ?? '').toLowerCase() === 'min', false));
    }
  }
  const range = (operator: string, pixels: number | undefined): void => {
    if (pixels !== undefined) {
      widths.push(...sidesOf(pixels, operator.startsWith('>'), !operator.endsWith('=')));
    }
  };
  for (const match of condition.matchAll(WIDTH_FIRST_RANGE_PATTERN)) {
    range(match[1] ?? '', pixelsOf(match[2] ?? '', match[3] ?? ''));
  }
  for (const match of condition.matchAll(WIDTH_LAST_RANGE_PATTERN)) {
    range(flippedOperator(match[3] ?? ''), pixelsOf(match[1] ?? '', match[2] ?? ''));
  }
  return widths;
};

/**
 * media query の条件の文の一覧から、境目の両側の幅（正の整数。重なりを除き、小さい順）を返す。
 */
export const breakpointSideWidthsOf = (conditions: readonly string[]): readonly number[] => {
  const widths = new Set<number>();
  for (const condition of conditions) {
    for (const width of sideWidthsOfCondition(condition)) {
      if (Number.isSafeInteger(width) && width > 0) {
        widths.add(width);
      }
    }
  }
  return Object.freeze([...widths].sort((left, right) => left - right));
};

/**
 * ページの CSS の media query の条件の文を集める（ブラウザの中で読むだけ）。読めない stylesheet は飛ばす。失敗したら空。
 */
export const readMediaQueryConditionTexts = async (page: Page): Promise<readonly string[]> => {
  try {
    return await page.evaluate(() => {
      const texts: string[] = [];
      const visited = new Set<CSSStyleSheet>();
      const visitRules = (rules: CSSRuleList): void => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSMediaRule) {
            texts.push(rule.media.mediaText);
          }
          if (rule instanceof CSSImportRule) {
            texts.push(rule.media.mediaText);
            if (rule.styleSheet !== null) {
              visitSheet(rule.styleSheet);
            }
          }
          if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) {
            visitRules(rule.cssRules);
          }
        }
      };
      const visitSheet = (sheet: CSSStyleSheet): void => {
        if (visited.has(sheet)) {
          return;
        }
        visited.add(sheet);
        texts.push(sheet.media.mediaText);
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          return;
        }
        visitRules(rules);
      };
      for (const sheet of Array.from(document.styleSheets)) {
        visitSheet(sheet);
      }
      for (const element of Array.from(document.querySelectorAll('link[media], style[media]'))) {
        texts.push(element.getAttribute('media') ?? '');
      }
      return texts.filter((text) => text.length > 0);
    });
  } catch {
    return [];
  }
};

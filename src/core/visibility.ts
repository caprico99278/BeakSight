/**
 * 「目に見えるか」の判定で `Element.checkVisibility()` に渡すオプション。
 * 各collectorは、この値を `page.evaluate` の引数として渡し、ブラウザ内で同じオプションを使う。
 * 祖先の `display: none` と `opacity: 0`、要素自身の `visibility` を不可視として扱う。
 * `content-visibility: auto` で描画が省かれている、ビューポートの外の区画は、スクロールすれば見えるので、不可視として扱わない。
 */
export const VISIBILITY_CHECK_OPTIONS = Object.freeze({
  opacityProperty: true,
  visibilityProperty: true,
  contentVisibilityAuto: false,
} as const) satisfies CheckVisibilityOptions;

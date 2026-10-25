// 入口の確かめ（Task 43 の設計書 4.3。T43c）の、ログインの画面の要素を指す一意な CSS の組み立て。純粋な部品
// （`tests/architecture/discovery-boundary.test.ts` の `PURE_DISCOVERY_FILES`）。ページを操作しない・読まない（Gate (w)）。
// - ワーカー（`src/worker/entry-check-page.ts`）が、isolated world で読んだ要素の事実（名前・id・name・type の属性。値は読まない）をここに渡し、
//   候補の CSS の並びを受け取る。候補ごとに、その文書の中で当たる数と、当たった要素が読んだ要素かを isolated world で数え、その結果をここに
//   渡して、ちょうど 1 つに当たる最初の候補を選ぶ（組み立てた CSS がその文書でちょうど 1 つに当たることを確かめる）。
// - 候補の順: `#id`（識別子の escape）→ `tag[name="…"]` → `tag[type="…"]`。空の属性は使わない。同じ候補を重ねない。
// - escape は CSSOM の「識別子の直列化」（`CSS.escape` と同じ形）と、引用符で囲んだ文字列の書き方。どちらも標準の CSS の書き方だけを作る
//   （Playwright 独自の書き方は作らない）。認証の設定として受けるか（形と長さ）は、使う側が認証の設定の owner の判定で確かめる。
// - 欄の候補がちょうど 1 つでなければ（0 か 2 つ以上）、その欄の案は出さない（`entryFieldSelectorOf`）。
// - FM2R の Minor 14: 秘密に見える `id`・`name`（`isValueLikeText`）は候補にしない（入口の確かめと、手動のログインの段の欄の検出が共用するので、両方に効く）。

import { isUuidText, isValueLikeText } from '../core/url-path-redaction.js';

/** 1 つの要素の、CSS の組み立てに使う事実（属性の値そのもの。ないときは空文字列）。欄の値は持たない。 */
export interface EntryElementFacts {
  /** 要素の名前（`localName`。小文字）。 */
  readonly tag: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

/** 1 つの候補の CSS を、その文書で数えた結果。 */
export interface EntrySelectorCheck {
  readonly selector: string;
  /** 文書と open な shadow root の中で当たった要素の数。 */
  readonly matches: number;
  /** ちょうど 1 つに当たったとき、それが読んだ要素か（ほかは偽）。 */
  readonly matchesElement: boolean;
}

/** 要素の数（ちょうど 1 つ）。 */
const ONE = 1;
/** NUL の置き換え（CSSOM と同じ）。 */
const REPLACEMENT_CHARACTER = '�';
const HYPHEN = '-';
const ESCAPE = '\\';

/** 16 進のコードの escape（`\` と 16 進と空白）。 */
const codePointEscapeOf = (codePoint: number): string => `${ESCAPE}${codePoint.toString(16)} `;

/** 制御文字（U+0001〜U+001F、U+007F）か。 */
const isControlCodePoint = (codePoint: number): boolean => (codePoint >= 0x1 && codePoint <= 0x1f) || codePoint === 0x7f;
const isDigitCodePoint = (codePoint: number): boolean => codePoint >= 0x30 && codePoint <= 0x39;
/** そのまま書ける文字（U+0080 以上、`-`、`_`、ASCII の英数字）か。 */
const isPlainIdentifierCodePoint = (codePoint: number): boolean =>
  codePoint >= 0x80
  || codePoint === 0x2d
  || codePoint === 0x5f
  || isDigitCodePoint(codePoint)
  || (codePoint >= 0x41 && codePoint <= 0x5a)
  || (codePoint >= 0x61 && codePoint <= 0x7a);

/** CSS の識別子として書く（CSSOM の「識別子の直列化」。`CSS.escape` と同じ形）。 */
export const cssIdentifierOf = (value: string): string => {
  const characters = [...value];
  const first = characters[0];
  return characters.map((character, index) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0) {
      return REPLACEMENT_CHARACTER;
    }
    if (isControlCodePoint(codePoint) || (index === 0 && isDigitCodePoint(codePoint))
      || (index === 1 && isDigitCodePoint(codePoint) && first === HYPHEN)) {
      return codePointEscapeOf(codePoint);
    }
    if (index === 0 && character === HYPHEN && characters.length === 1) {
      return `${ESCAPE}${character}`;
    }
    return isPlainIdentifierCodePoint(codePoint) ? character : `${ESCAPE}${character}`;
  }).join('');
};

/** CSS の文字列として書く（二重引用符で囲む。`"` と `\` を escape し、制御文字を 16 進で書き、NUL を置き換える）。 */
export const cssStringOf = (value: string): string => {
  const body = [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0) {
      return REPLACEMENT_CHARACTER;
    }
    if (isControlCodePoint(codePoint)) {
      return codePointEscapeOf(codePoint);
    }
    return character === '"' || character === ESCAPE ? `${ESCAPE}${character}` : character;
  }).join('');
  return `"${body}"`;
};

/** Playwright の `css=` の解析が受けない escape（`-` だけの識別子の escape `\-`。T43R の確かめの 23 通りで、これだけが解析の誤りになった）。 */
const PLAYWRIGHT_UNPARSED_ESCAPE = `${ESCAPE}${HYPHEN}`;

/**
 * T43R-fix の M-4: Playwright の `css=` の locator（認証の設定のセレクタを引く `loginStageLocator`）でも解釈できる形か（`\-` の escape を含まない）。
 * 解釈できるかは `tests/integration/entry-selector-playwright.test.ts` で、両方の Chromium の locator で確かめる。
 */
export const isPlaywrightCssShape = (selector: string): boolean => !selector.includes(PLAYWRIGHT_UNPARSED_ESCAPE);

/**
 * 属性の値を部分に分ける区切り（秘密に見える部分を探すため。`isValueLikeText` は `;`・`=`・`,` で分けるので、名前によくある区切りと、FM2R の確かめ直しの
 * R-2 で足した角括弧（`login[<値>]` の形）をここで足す）。
 */
const ATTRIBUTE_PART_SEPARATORS = /[-_.:[\]]/u;

/**
 * セレクタの案に固有の決まり（FM2R の確かめ直しの R-2。共通の判定 `isValueLikeText` は URL の path の伏せ字でも使うので、その意味は変えず、ここだけで
 * 狭く足す）: この桁数以上の 16 進だけの部分と、この桁数以上の数字の連なりを含む部分は、案に使わない。
 */
export const MIN_SELECTOR_SECRET_HEX_LENGTH = 16;
export const MIN_SELECTOR_SECRET_DIGIT_RUN_LENGTH = 10;
const SELECTOR_SECRET_HEX = new RegExp(`^[0-9A-Fa-f]{${String(MIN_SELECTOR_SECRET_HEX_LENGTH)},}$`, 'u');
const SELECTOR_SECRET_DIGIT_RUN = new RegExp(`[0-9]{${String(MIN_SELECTOR_SECRET_DIGIT_RUN_LENGTH)},}`, 'u');

/** 区切りで分けた 1 つの部分が、セレクタの案に使えない値か（共通の判定と、UUID と、セレクタの案に固有の決まり）。 */
const isSecretLikeAttributePart = (part: string): boolean =>
  isValueLikeText(part) || isUuidText(part) || SELECTOR_SECRET_HEX.test(part) || SELECTOR_SECRET_DIGIT_RUN.test(part);

/**
 * FM2R の Minor 14 と確かめ直しの R-2: 属性の値（`id`・`name`）が、セレクタの案に使えない秘密に見える値か（唯一の判定）。値の全体と、区切り（`-`・`_`・
 * `.`・`:`・`[`・`]`）で分けた部分のどれかが、共通の判定（`isValueLikeText`。長い 16 進、token・JWT・base64 の形、メールアドレスの形など）、UUID
 * （`isUuidText`）、セレクタの案に固有の決まり（16 桁以上の 16 進、10 桁以上の数字の連なり）に当たれば真。秘密に見える値は、案の CSS に入れない。
 */
const isSecretLikeAttributeValue = (value: string): boolean =>
  isSecretLikeAttributePart(value) || value.split(ATTRIBUTE_PART_SEPARATORS).some(isSecretLikeAttributePart);

/**
 * 1 つの要素の事実から、候補の CSS の並び（`#id` → `tag[name="…"]` → `tag[type="…"]`。重ねない）。名前がなければ空。FM2R の Minor 14: 秘密に見える
 * `id`・`name` は使わない（ほかの形の候補が残れば、それで数える。なければ案なし）。
 */
export const entrySelectorCandidatesOf = ({ tag, id, name, type }: EntryElementFacts): readonly string[] => {
  if (tag.length === 0) {
    return [];
  }
  const element = cssIdentifierOf(tag);
  const candidates = [
    ...(id.length === 0 || isSecretLikeAttributeValue(id) ? [] : [`#${cssIdentifierOf(id)}`]),
    ...(name.length === 0 || isSecretLikeAttributeValue(name) ? [] : [`${element}[name=${cssStringOf(name)}]`]),
    ...(type.length === 0 ? [] : [`${element}[type=${cssStringOf(type)}]`]),
  ];
  // T43R-fix の M-4: Playwright の `css=` が解釈できない形は案にしない。
  return [...new Set(candidates)].filter(isPlaywrightCssShape);
};

/** 数えた結果のうち、ちょうど 1 つに当たり、それが読んだ要素である最初の CSS（なければ `null`）。 */
export const uniqueEntrySelectorOf = (checks: readonly EntrySelectorCheck[]): string | null =>
  checks.find(({ matches, matchesElement }) => matches === ONE && matchesElement)?.selector ?? null;

/** 欄の CSS の案（欄の候補がちょうど 1 つのときだけ、その一意な CSS。ほかは `null`）。 */
export const entryFieldSelectorOf = (candidates: number, checks: readonly EntrySelectorCheck[]): string | null =>
  candidates === ONE ? uniqueEntrySelectorOf(checks) : null;

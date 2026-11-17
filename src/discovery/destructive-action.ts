// 削除に関する操作の、操作の前の判定（SD-1。設計書 `doc/design/2026-11-16-beaksight-action-based-delete-guard-design.md` 2.2・2.3）。純粋な関数だけのファイル
// （ページを操作しない・読まない）。
// - 判定の唯一の owner。巡回の移動（URL とリンクの文字）、知らせの枠を閉じる押下、Interaction の押下、発見の押下が、押す前・移る前にここを通す。
// - 語の一覧の置き場所は `classification-words.ts` の 1 か所（設計者の判断 2026-11-16）。操作の名前・送り先・選んだ選択肢・枠の文には、危険な語
//   （`DISCOVERY_DESTRUCTIVE_WORDS`）と足す語（`DESTRUCTIVE_ACTION_EXTRA_WORDS`）の和（`DESTRUCTIVE_ACTION_WORDS`）を当てる。巡回の移る先の URL には、広げすぎない
//   ように、既定の除外の語（`DEFAULT_EXCLUDED_URL_WORDS`）と `DESTRUCTIVE_ACTION_URL_EXTRA_WORDS` だけを当てる（`CRAWL_DESTRUCTIVE_URL_WORDS`）。リンクの文字には、
//   その狭い一覧と日本語の動きの語（`DESTRUCTIVE_LINK_TEXT_JA_WORDS`）だけを、名詞の続く語（`DESTRUCTIVE_WORD_NOUN_SUFFIXES`）を除いて当てる（REV-SD の M-2）。
// - 比べ方は `classify.ts` の `textsHaveBoundedWord`（REV-SD の I-5: 英語の語は語の境界、日本語の語は部分一致。percent-encode を外した形も）。分類の危険な語の
//   比べ（候補の `submitterWords` と識別の digest）は変えない。
// - 要素の事実はページの中の部品（`src/browser/in-page-readers.ts` の `destructiveActionFactsOf`）が読み、この形（`DestructiveActionFacts`）で渡す。
import { DEFAULT_EXCLUDED_URL_WORDS } from '../core/default-excluded-url-words.js';
import { foldNfkcCase } from '../core/text.js';
import { isRecord } from '../core/guards.js';
import {
  CRAWL_URL_EXTRA_NOUN_WORDS,
  CRAWL_URL_NOUN_GUIDE_WORDS,
  DESTRUCTIVE_ACTION_EXTRA_WORDS,
  DESTRUCTIVE_ACTION_LOGOFF_WORDS,
  DESTRUCTIVE_ACTION_URL_EXTRA_WORDS,
  DESTRUCTIVE_CLOSE_CANCEL_WORDS,
  DESTRUCTIVE_LINK_TEXT_JA_WORDS,
  DESTRUCTIVE_WORD_NOUN_SUFFIXES,
  DISCOVERY_DESTRUCTIVE_WORDS,
  NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS,
  NOTIFICATION_CLOSE_SYMBOLS,
} from './classification-words.js';
import { fieldNameWordsOf, isAsciiWord, textsHaveBoundedWord } from './classify.js';

/** 操作の前の判定の語（危険な語と、操作の前の判定だけが足す語の和）。 */
export const DESTRUCTIVE_ACTION_WORDS: readonly string[] = Object.freeze([...DISCOVERY_DESTRUCTIVE_WORDS, ...DESTRUCTIVE_ACTION_EXTRA_WORDS]);

/**
 * 巡回の移る先の URL に当てる語（既定の除外の語と、区切りが `_` のログアウトの語・ログオフの語。REV-SD2 の M-7: URL にだけ、削除・取り消しの名詞も足す）。
 */
export const CRAWL_DESTRUCTIVE_URL_WORDS: readonly string[] = Object.freeze([
  ...DEFAULT_EXCLUDED_URL_WORDS, ...DESTRUCTIVE_ACTION_URL_EXTRA_WORDS, ...DESTRUCTIVE_ACTION_LOGOFF_WORDS, ...CRAWL_URL_EXTRA_NOUN_WORDS,
]);

/** REV-SD の M-2: リンクの文字に当てる語（巡回の URL の狭い一覧から URL だけの名詞を除いたものと、日本語の動きの語）。 */
export const DESTRUCTIVE_LINK_TEXT_WORDS: readonly string[] = Object.freeze([
  ...DEFAULT_EXCLUDED_URL_WORDS, ...DESTRUCTIVE_ACTION_URL_EXTRA_WORDS, ...DESTRUCTIVE_ACTION_LOGOFF_WORDS, ...DESTRUCTIVE_LINK_TEXT_JA_WORDS,
]);

/** 文字（名前・送り先・選択肢・枠の文）が、操作の前の判定の語に当たるか。 */
export const textsHaveDestructiveActionWord = (texts: readonly string[]): boolean => textsHaveBoundedWord(texts, DESTRUCTIVE_ACTION_WORDS);
const textsHaveDestructiveWord = textsHaveDestructiveActionWord;

/** 削除の method（form の `method`・`formmethod`・`_method` の値・`data-method`。大文字小文字を問わない）。 */
export const DESTRUCTIVE_HTTP_METHOD = 'delete';

/**
 * 操作の前に読む、要素の事実（ページの中の部品が読む。値は書かれたまま）。
 * - `names`: 見える文字・`aria-label`・`aria-labelledby` の文字・`title`・`value`・`alt`（自分と中の画像）。
 * - `methods`: `formmethod`・属する form の `method` の属性・form の中の `_method` の欄の値・`data-method`（自分か祖先）。
 * - `htmxDelete`: `hx-delete`・`data-hx-delete` の属性があるか。
 * - `urls`: `href`（自分か祖先のリンク）・`formaction`・属する form の `action`・`hx-get` などの送り先の属性。
 * - `chosenTexts`: 押す要素の範囲（属する form、なければ同じ枠か、select・radio のある最も近い祖先の区画の、form に属さない欄）の、選ばれた select の選択肢の
 *   文字と値、選ばれた radio の値とラベル（REV-SD の I-4 (b)）。
 * - `inRow`: 祖先の行（`tr`・`li`・`row`・`listitem`・`article`）の中にあるか（その行が枠の外にあるか、枠の中にあるとき）。
 * - `frame`: 枠（dialog・alertdialog・`aria-modal`・region・popover）の閉じる場所にあるとき（行の中でないとき）、枠の名前と、枠の本文（押せる要素と入力の欄の
 *   文字を除く。REV-SD の I-2。前の読み取りの値にはない）。ないときは null。
 * - `confirmText`: いちばん近い dialog・alertdialog の文（押せる要素と入力の欄の文字を除く）。ないときは null。
 */
export interface DestructiveActionFacts {
  readonly names: readonly string[];
  readonly methods: readonly string[];
  readonly htmxDelete: boolean;
  readonly urls: readonly string[];
  readonly baseUrl: string;
  readonly chosenTexts: readonly string[];
  readonly inRow: boolean;
  readonly frame: { readonly names: readonly string[]; readonly text?: string } | null;
  readonly confirmText: string | null;
}

/** 名前だけの事実（名前のほかを読めない呼び出し・前の読み取りの値のため）。 */
export const destructiveActionFactsOfNames = (names: readonly string[]): DestructiveActionFacts => Object.freeze({
  names, methods: [], htmxDelete: false, urls: [], baseUrl: '', chosenTexts: [], inRow: false, frame: null, confirmText: null,
});

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** ページから受け取った値を、事実の形に確かめる（形が違えば null）。 */
export const destructiveActionFactsFrom = (value: unknown): DestructiveActionFacts | null => {
  if (!isRecord(value)) return null;
  const { names, methods, htmxDelete, urls, baseUrl, chosenTexts, inRow, frame, confirmText } = value;
  if (!isStringArray(names) || !isStringArray(methods) || typeof htmxDelete !== 'boolean' || !isStringArray(urls) || typeof baseUrl !== 'string'
    || !isStringArray(chosenTexts) || typeof inRow !== 'boolean' || !(confirmText === null || typeof confirmText === 'string')) {
    return null;
  }
  if (!(frame === null || (isRecord(frame) && isStringArray(frame['names']) && (frame['text'] === undefined || typeof frame['text'] === 'string')))) return null;
  return Object.freeze({
    names: [...names], methods: [...methods], htmxDelete, urls: [...urls], baseUrl, chosenTexts: [...chosenTexts], inRow,
    frame: frame === null ? null : Object.freeze({
      names: [...(frame['names'] as readonly string[])], ...(typeof frame['text'] === 'string' ? { text: frame['text'] } : {}),
    }),
    confirmText,
  });
};

/** 比べる形（畳み込み・空白を詰める）。 */
const comparable = (value: string): string => foldNfkcCase(value).replace(/\s+/gu, ' ').trim();

/** 名前が、空白を除いて閉じる記号（×・✕・✖）だけからなるか。 */
const isCloseSymbolOnly = (name: string): boolean => {
  const compact = [...comparable(name).replace(/\s+/gu, '')];
  return compact.length > 0 && compact.every((character) => (NOTIFICATION_CLOSE_SYMBOLS as readonly string[]).includes(character));
};

/** 名前が、「キャンセル」の語だけ（記号と空白を除いて）か。 */
const isCancelOnly = (name: string): boolean => {
  const compact = comparable(name).replace(/[^\p{L}\p{N}]+/gu, '');
  return (DESTRUCTIVE_CLOSE_CANCEL_WORDS as readonly string[]).includes(compact);
};

/** 枠の名前が、壊す操作の目的語（予約・注文など。英語は語か複数形、日本語は部分一致）を持つか。 */
const namesDestructiveObject = (frameName: string): boolean => {
  const folded = comparable(frameName);
  const words = new Set(fieldNameWordsOf(frameName));
  return NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS.some((word) => (isAsciiWord(word) ? words.has(word) || words.has(`${word}s`) : folded.includes(word)));
};

/**
 * 「キャンセル」が枠を閉じる操作か（設計書 2.2）: 名前の全部が「キャンセル」の語だけで、枠の閉じる場所にあり（行の中でない）、枠の名前と枠の本文（REV-SD の
 * I-2）が壊す操作の目的語（予約・注文など）でも削除の語でもなく、確かめの枠の文に削除の語がないとき。「閉じる」「×」などは、この判定を通らない（本文を見ない）。
 */
export const isFrameClosingCancel = (facts: DestructiveActionFacts): boolean => {
  const named = facts.names.filter((name) => comparable(name) !== '');
  const frameTexts = facts.frame === null ? [] : [...facts.frame.names, ...(facts.frame.text === undefined ? [] : [facts.frame.text])];
  return named.length > 0
    && named.every(isCancelOnly)
    && facts.frame !== null
    && !facts.inRow
    && !frameTexts.some((text) => namesDestructiveObject(text) || textsHaveDestructiveWord([text]))
    && (facts.confirmText === null || !textsHaveDestructiveWord([facts.confirmText]));
};

/** URL（解けなければ書かれたまま）の、比べる形（path と query。percent-encode は比べる側が外す）。 */
const urlFormsOf = (url: string, baseUrl: string): readonly string[] => {
  try {
    const parsed = baseUrl === '' ? new URL(url) : new URL(url, baseUrl);
    return [`${parsed.pathname}${parsed.search}`];
  } catch {
    return [url];
  }
};

/**
 * 要素の送り先の URL が、操作の前の判定の語に当たるか（path と query）。解けない URL は、書かれたままの文字で比べる。
 */
export const urlHasDestructiveWord = (url: string, baseUrl = ''): boolean => textsHaveDestructiveWord(urlFormsOf(url, baseUrl));

/**
 * 巡回の移る先の URL が、巡回の語（`CRAWL_DESTRUCTIVE_URL_WORDS`）に当たるか（path と query。設計者の判断 2026-11-16: ブログのアーカイブ・パスワードの再設定の
 * 案内などを読まなくならないよう、操作の前の判定の語の全部は当てない）。
 */
export const crawlUrlHasDestructiveWord = (url: string): boolean => {
  const forms = urlFormsOf(url, '');
  // REV-EV12 の M-3: URL だけの名詞は、直後が案内の語（`CRAWL_URL_NOUN_GUIDE_WORDS`）なら当てない。ほかの語は、その決まりなしに当てる。
  return textsHaveBoundedWord(forms, CRAWL_DESTRUCTIVE_URL_WORDS.filter((word) => !NOUN_WORDS.has(word)))
    || textsHaveBoundedWord(forms, CRAWL_URL_EXTRA_NOUN_WORDS, [], CRAWL_URL_NOUN_GUIDE_WORDS);
};

/** 巡回の URL だけの名詞（`CRAWL_URL_EXTRA_NOUN_WORDS`）の集合。 */
const NOUN_WORDS: ReadonlySet<string> = new Set(CRAWL_URL_EXTRA_NOUN_WORDS);

/**
 * リンクの文字（見える文字・`aria-label`・`title`・中の画像の `alt`。REV-SD の M-1）が、リンクの文字の語（`DESTRUCTIVE_LINK_TEXT_WORDS`）に当たるか（巡回の移動。
 * 設計書 2.3。REV-SD の M-2: 日本語の語の直後が名詞の続く語なら当てない）。
 */
export const linkTextHasDestructiveWord = (link: {
  readonly anchorText: string;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  readonly imageAlts?: readonly string[];
}): boolean => textsHaveBoundedWord(
  [link.anchorText, link.ariaLabel ?? '', link.title ?? '', ...(link.imageAlts ?? [])].filter((text) => text !== ''),
  DESTRUCTIVE_LINK_TEXT_WORDS,
  DESTRUCTIVE_WORD_NOUN_SUFFIXES,
);

/**
 * 削除に関する操作か（設計書 2.2。どれかに当たれば真。押さない・送らない）。
 * - method が削除（`DESTRUCTIVE_HTTP_METHOD`）か、`hx-delete` がある。
 * - 送り先の URL（href・formaction・form の action・hx の送り先）が削除の語に当たる。
 * - いちばん近い dialog・alertdialog の文に削除の語がある（削除の確かめの枠の中のボタン）。
 * - 属する form の選ばれた選択肢が削除の語に当たる。
 * - 名前が閉じる記号だけで、行の中にある（行の ×）。
 * - 名前が削除の語に当たる（枠を閉じる「キャンセル」（`isFrameClosingCancel`）は除く）。
 */
export const isDestructiveAction = (facts: DestructiveActionFacts): boolean => {
  if (facts.htmxDelete || facts.methods.some((method) => comparable(method) === DESTRUCTIVE_HTTP_METHOD)) return true;
  // 空と `#` で始まる送り先は、同じ画面にとどまるので見ない（画面の URL の語で、画面の中の全部のボタンを止めない）。
  if (facts.urls.some((url) => url.trim() !== '' && !url.trim().startsWith('#') && urlHasDestructiveWord(url, facts.baseUrl))) return true;
  if (facts.confirmText !== null && textsHaveDestructiveWord([facts.confirmText])) return true;
  if (textsHaveDestructiveWord(facts.chosenTexts)) return true;
  if (facts.inRow && facts.names.some(isCloseSymbolOnly)) return true;
  return textsHaveDestructiveWord(facts.names) && !isFrameClosingCancel(facts);
};

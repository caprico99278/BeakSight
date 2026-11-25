/**
 * BS-2（設計書 `doc/design/2026-11-20-beaksight-key-action-positions-design.md` 2.1・2.2）: 主要な行動の候補の閉じた一覧と、押せる要素の事実から種類を決める
 * 純粋な関数の唯一の置き場所。
 * - 一覧は汎用の語・行き先の型・メッセージのサービスのホストだけ。業種に固有の語と、点検の対象のサイトの語は書かない。当たらない要素は候補にしない（推測で
 *   「大事」と決めない）。
 * - layout の collector（記録する候補を選ぶ）と、表示用モデル（`src/report/key-actions.ts`。種類を付けて集計する）の両方が、この一覧と関数を使う。
 * - 語の比べ方: 日本語の語（ASCII でない語）は、互換の正規化と大文字小文字の畳み込み（`foldNfkcCase`）の後の部分一致。英語の語は語の境界（文字と数字以外で
 *   分けた語の並びに、語の並びがそのまま現れる。最後の語は複数形の `s` も）。
 * - 個人の値（電話番号・メールアドレスに見える文字）は、`maskContactValues` で伏せる（行き先の番号・宛先は、もともと記録しない）。
 */
import { separatedWordsOf, sequenceHasBoundedWord } from './bounded-words.js';
import { REDACTED } from './redaction.js';
import { foldNfkcCase } from './text.js';

/** 主要な行動の候補の種類の閉じた一覧。 */
export const KEY_ACTION_KINDS = Object.freeze(['PHONE', 'EMAIL', 'MESSAGE', 'BOOKING', 'CONTACT', 'PURCHASE', 'OTHER'] as const);
export type KeyActionKind = (typeof KEY_ACTION_KINDS)[number];

/** 押せる要素（リンク・ボタン・`role=button|link`）の selector（ページの中の読み取りが使う）。 */
export const KEY_ACTION_ELEMENT_SELECTOR = 'a[href], button, input[type="button"], input[type="submit"], [role="button"], [role="link"]';

/** 行き先の型（URL の scheme。`:` を除いた小文字）ごとの種類。 */
export const KEY_ACTION_HREF_SCHEME_KINDS: Readonly<Record<string, KeyActionKind>> = Object.freeze({ tel: 'PHONE', mailto: 'EMAIL' });

/** メッセージのサービスのホスト（そのホストか、その下のホスト）の閉じた一覧。 */
export const KEY_ACTION_MESSAGE_HOSTS = Object.freeze(['line.me', 'lin.ee', 'wa.me', 'whatsapp.com', 'm.me', 'messenger.com', 't.me'] as const);

/** 名前の語の一覧（種類ごと。上から順に当てはめる）。 */
export const KEY_ACTION_WORDS: Readonly<Record<Exclude<KeyActionKind, 'EMAIL' | 'MESSAGE'>, readonly string[]>> = Object.freeze({
  PHONE: Object.freeze(['電話する', '電話で', 'お電話', 'call us', 'call now']),
  BOOKING: Object.freeze(['予約', '来店', 'reserve', 'reservation', 'booking', 'book now']),
  CONTACT: Object.freeze(['問い合わせ', '問合せ', '相談', 'contact', 'inquiry', 'enquiry']),
  PURCHASE: Object.freeze(['購入', 'カート', '買い物かご', 'buy', 'purchase', 'cart', 'checkout']),
  OTHER: Object.freeze(['申し込み', '申込', '資料請求', '見積', 'apply', 'estimate', 'quote']),
});

/** 名前の語を当てはめる種類の順。 */
const WORD_KIND_ORDER = Object.freeze(['PHONE', 'BOOKING', 'CONTACT', 'PURCHASE', 'OTHER'] as const);

/** 表示用モデルに残す名前の長さの上限（文字）。 */
export const KEY_ACTION_NAME_MAX_LENGTH = 80;

/** 種類を決めるのに読む、押せる要素の事実（行き先は scheme とホストだけ。番号・宛先・path は持たない）。 */
export interface KeyActionFacts {
  readonly text: string;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  /** 行き先の scheme（`:` を除いた小文字）。行き先がなければ `null`。 */
  readonly hrefScheme: string | null;
  /** 行き先のホスト（http・https のときだけ。小文字）。 */
  readonly hrefHost: string | null;
}

const isAsciiWord = (word: string): boolean => /^[\x20-\x7e]+$/u.test(word);

const FOLDED_WORDS = Object.freeze(WORD_KIND_ORDER.map((kind) => Object.freeze({
  kind,
  words: KEY_ACTION_WORDS[kind].map((word) => (isAsciiWord(word) ? { ascii: separatedWordsOf(word), folded: '' } : { ascii: null, folded: foldNfkcCase(word) })),
})));

const hasWord = (texts: readonly string[], word: { readonly ascii: readonly string[] | null; readonly folded: string }): boolean => {
  if (word.ascii === null) {
    return texts.some((text) => foldNfkcCase(text).includes(word.folded));
  }
  const parts = word.ascii;
  // CC-136: 語の境界の比べは、発見の分類と同じ部品（`sequenceHasBoundedWord`）。語の分け方は区切りだけ（camelCase・文字と数字の境では分けない）。
  return texts.map(separatedWordsOf).some((tokens) => sequenceHasBoundedWord(tokens, parts));
};

const isMessageHost = (host: string): boolean => KEY_ACTION_MESSAGE_HOSTS.some((listed) => host === listed || host.endsWith(`.${listed}`));

/** 押せる要素の種類（行き先の型、メッセージのホスト、名前の語の順に当てはめる。当たらなければ `null`）。 */
export function keyActionKindOf(facts: KeyActionFacts): KeyActionKind | null {
  const byScheme = facts.hrefScheme === null ? undefined : KEY_ACTION_HREF_SCHEME_KINDS[facts.hrefScheme];
  if (byScheme !== undefined) {
    return byScheme;
  }
  if (facts.hrefHost !== null && isMessageHost(facts.hrefHost)) {
    return 'MESSAGE';
  }
  const texts = [facts.text, facts.ariaLabel ?? '', facts.title ?? ''].filter((text) => text.length > 0);
  return FOLDED_WORDS.find(({ words }) => words.some((word) => hasWord(texts, word)))?.kind ?? null;
}

/** 行き先（絶対の URL）の scheme と、http・https のときのホスト（読めなければどちらも `null`）。番号・宛先・path は返さない。 */
export function keyActionHrefTargetOf(href: string | null): { readonly hrefScheme: string | null; readonly hrefHost: string | null } {
  if (href === null) {
    return { hrefScheme: null, hrefHost: null };
  }
  try {
    const url = new URL(href);
    const hrefScheme = url.protocol.slice(0, -1).toLowerCase();
    // ホストは URL の解析で小文字になっている（http・https）。
    return { hrefScheme, hrefHost: hrefScheme === 'http' || hrefScheme === 'https' ? url.hostname : null };
  } catch {
    return { hrefScheme: null, hrefHost: null };
  }
}

/** メールアドレスに見える文字。 */
const EMAIL_LIKE = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/gu;
/** 電話番号に見える文字（数字が 7 つ以上、区切り（ハイフン・括弧・空白・点）を挟んでもよい）。 */
const PHONE_LIKE = /\+?\p{Nd}(?:[\s\-‐－−ー().（）]*\p{Nd}){6,}/gu;

/** 電話番号とメールアドレスに見える文字を伏せ字にする。 */
export const maskContactValues = (text: string): string => text.replace(EMAIL_LIKE, REDACTED).replace(PHONE_LIKE, REDACTED);

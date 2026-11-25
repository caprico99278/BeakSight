/**
 * CC-136: 英語の語の境界の比べの 1 か所（純粋）。語の並び（畳み込んだ語の一覧）に、語を分けた並びがそのまま続けて現れるか（最後の語は複数形の `s` も）。
 * 文字をどう語に分けるかは使う側が決める（発見の分類 `src/discovery/classify.ts` の `textsHaveBoundedWord` は欄の名前の語の分け方、主要な行動の候補
 * `src/core/key-actions.ts` は区切りだけの分け方 `separatedWordsOf`）。
 */
import { foldNfkcCase } from './text.js';

/** 英語の語の複数形として、語の境界の比べで同じとみなす接尾辞。 */
export const PLURAL_SUFFIX = 's';

/** 区切り（文字と数字以外）で分けた語の一覧（畳み込んだ形）。 */
export const separatedWordsOf = (text: string): readonly string[] =>
  foldNfkcCase(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);

/**
 * 語の並び `sequence` に、語の並び `parts` がそのまま続けて現れる所があるか（最後の語は `s` を付けた形も）。`excludedFollowers` を渡すと、すぐ後の語が
 * その一覧の語である所では当てない。`parts` が空なら当たらない。
 */
export const sequenceHasBoundedWord = (
  sequence: readonly string[],
  parts: readonly string[],
  excludedFollowers: readonly string[] = [],
): boolean => {
  const last = parts.length - 1;
  return parts.length > 0 && sequence.some((_token, start) => parts.every((part, offset) => {
    const token = sequence[start + offset];
    return token === part || (offset === last && token === `${part}${PLURAL_SUFFIX}`);
  }) && !excludedFollowers.includes(sequence[start + parts.length] ?? ''));
};

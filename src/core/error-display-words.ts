/**
 * AUD-7（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-7）: 画面の誤りの表示の手がかりにする、汎用の語の唯一の一覧。
 * - 設計者の判断（2026-11-10）: 汎用の語だけにする（サイトに固有の文言を入れない）。「できませんでした」は「できません」に含める。
 * - 語は手がかりの 1 つ。画面の誤りの表示と言えるのは、語が role=alert・aria-live=assertive・見出し・aria-invalid の欄の近くの文字のどれかにあるとき
 *   だけ（決めるのは DOM の collector の読み取りの所。本文のどこかに語があるだけでは、誤りの表示としない）。
 * - 比べ方は、互換の正規化と大文字小文字の畳み込み（`foldNfkcCase`）の後の部分一致。
 */
import { foldNfkcCase } from './text.js';

export const ERROR_DISPLAY_WORDS = Object.freeze([
  'エラー',
  '失敗',
  '見つかりません',
  '存在しません',
  '権限がありません',
  'ログインしてください',
  '期限が切れ',
  'できません',
  'お試しください',
  'error',
  'failed',
  'not found',
  'unauthorized',
  'forbidden',
  'expired',
  'invalid',
  'denied',
] as const);
export type ErrorDisplayWord = (typeof ERROR_DISPLAY_WORDS)[number];

const FOLDED_WORDS: readonly (readonly [ErrorDisplayWord, string])[] = Object.freeze(ERROR_DISPLAY_WORDS.map((word) => [word, foldNfkcCase(word)] as const));

/** 文の中にある誤りの語（一覧の順。重なりなし）。 */
export function errorDisplayWordsIn(text: string): readonly ErrorDisplayWord[] {
  const folded = foldNfkcCase(text);
  return FOLDED_WORDS.filter(([, word]) => folded.includes(word)).map(([word]) => word);
}

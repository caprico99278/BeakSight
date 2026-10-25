/**
 * フォームの入力の部品の共通の値（T30c。ログインの入力の部品 `login-form-submitter.ts` と、書き込みの入力の部品 `write-form-submitter.ts` が
 * 共用する。Node の側の値だけ。ページの中で動く関数は外の値を参照できないので、ページの中の読み方はそれぞれの部品が持つ）。
 */

/** フォームを読む・値を入れる・送る、それぞれの時間の上限（ms）。 */
export const FORM_STEP_TIMEOUT_MS = 10_000;

/** 受ける method（ブラウザの `method`・`formMethod` のプロパティは小文字）。 */
export const FORM_POST_METHOD = 'post';

/** 同じ page を表す送信の先（空は既定の `_self`）。 */
export const FORM_SELF_TARGETS: ReadonlySet<string> = new Set(['', '_self']);

/** 改行の比べのための形（textarea の値は LF。CR LF と CR を LF にする）。 */
export const lineFeedForm = (text: string): string => text.split('\r\n').join('\n').split('\r').join('\n');

/**
 * 2 つの値が同じか（完全な一致。改行だけ CR LF・CR・LF を同じと見なす。Task 31 の設計書 3 章の「値の照らし方」。null は null とだけ同じ）。
 * 入力の前の確かめと、更新の後の照合（T31g-2）と、API の書き込みの入力の読み直し（T39d。`api-write-submitter.ts`）が使う唯一の比べ方。T39d で
 * `write-form-submitter.ts` から移した（`write-form-submitter.ts` は公開し直す）。
 */
export const sameValue = (left: string | null, right: string | null): boolean =>
  (left === null || right === null ? left === right : lineFeedForm(left) === lineFeedForm(right));

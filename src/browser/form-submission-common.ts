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

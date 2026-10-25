/**
 * DEF-137（DEF-128 と同じ揺らぎ）: 保存の知らせと画面の中身を合わせる部品。保存の後に、同じ画面へ URL の search で知らせを付けて移る画面（`router.invalidate()` の
 * 後に `navigate`）では、ルータが読み直したデータを反映し終える前に、新しい search と古い loader のデータで一度描くことがある。そのため、保存した改訂も
 * search（`savedRevision`）に載せ、画面の値の改訂がその改訂に届いたときだけ知らせを出す。改訂を持たない知らせ（search に改訂がない）は、今のまま出す。
 * 判定だけの純粋な部品（画面のサーバにもブラウザにも入る）。
 */

/** search の保存した改訂（正の安全な整数だけ。ほかは、改訂を持たない知らせとして扱う）。 */
export const savedRevisionOf = (value: unknown): number | undefined =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined);

/** 知らせを出すか（保存した改訂がない、または画面の値の改訂がそれに届いた）。 */
export const isSavedNoticeCurrent = (savedRevision: number | undefined, currentRevision: number): boolean =>
  savedRevision === undefined || currentRevision >= savedRevision;

/**
 * JSON Pointer（RFC 6901）の区切りの書き方と戻し方の唯一の owner（CCX-25。CC-087 の前半）。
 * - import を持たない純粋な部品（ブラウザと Node の両方で使う。画面のブラウザと共用の部品 `apps/local-ui/src/server/auth-setup-errors.ts`
 *   からも読む。Gate `local-ui-boundary` の (i)）。
 * - 書き方: 区切りの中の `~` を `~0`、`/` を `~1` にする（`~` を先に置き換える）。戻し方: `~1` を `/`、`~0` を `~` に戻す（`~1` を先に戻す）。
 * - 同じ処理をほかの場所に書かない（Gate `core-small-parts-ownership` の (g)）。
 */

/** JSON Pointer の区切り。 */
export const JSON_POINTER_SEPARATOR = '/';

/** 区切りの中の `~` と、その書き方。 */
const TILDE = '~';
const ESCAPED_TILDE = '~0';
/** 区切りの中の `/` の書き方。 */
const ESCAPED_SEPARATOR = '~1';

/** JSON Pointer の区切り 1 つの書き方（`~` を `~0`、`/` を `~1` にする。`~` を先に置き換える）。 */
export const escapeJsonPointerSegment = (segment: string): string =>
  segment.split(TILDE).join(ESCAPED_TILDE).split(JSON_POINTER_SEPARATOR).join(ESCAPED_SEPARATOR);

/** JSON Pointer の区切り 1 つの戻し方（`~1` を `/`、`~0` を `~` に戻す。`~1` を先に戻す）。 */
export const unescapeJsonPointerSegment = (segment: string): string =>
  segment.split(ESCAPED_SEPARATOR).join(JSON_POINTER_SEPARATOR).split(ESCAPED_TILDE).join(TILDE);

/** 区切りの並び（戻した形）の JSON Pointer。空の並びは、文書の全体（`''`）。 */
export const jsonPointerOf = (segments: readonly string[]): string =>
  segments.map((segment) => `${JSON_POINTER_SEPARATOR}${escapeJsonPointerSegment(segment)}`).join('');

/**
 * JSON Pointer の区切りの並び（戻した形）。文書の全体（`''`）は空の並び。先頭の 1 文字（`/`）を除いて区切る（形の確かめはしない。
 * 位置は、検証の部品が作った値だけを受ける）。
 */
export const jsonPointerSegmentsOf = (pointer: string): readonly string[] =>
  pointer === '' ? [] : pointer.slice(JSON_POINTER_SEPARATOR.length).split(JSON_POINTER_SEPARATOR).map(unescapeJsonPointerSegment);

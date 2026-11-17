/**
 * artifact の JSON の書式の唯一の owner（Task 14〜17 の設計書 6.1.1、6.1.9。CC-026。T32R2 M-2 で `src/report/` から `src/core/` に移した。書き込みの
 * バンドルを組み立て直して照らす親（`src/control/job/write-report-check.ts`）も、同じ書式で目録を作るため）。
 * - 書式は、字下げなし（`JSON.stringify` の既定の、空白のない形）、末尾に LF を1つ、UTF-8（BOM なし）である。T44f（Task 44 の設計書 P3-1。ユーザーの判断
 *   2026-10-21）: 字下げ 2 文字（Task 14〜17 の設計書 6.1.1）を、字下げなしに置き換えた（成果物の大きさを減らすため。中身と schema は変えない。読む側は
 *   JSON として読む）。
 * - `JSON.stringify` は、文字列の中の改行（CR、LF）をエスケープするので、書式の中に CR は現れない。
 * - `ArtifactWriter`（run.json、audit.json、page.json、保存）と ChatGPT 用バンドル・書き込みのバンドル（ZIP の中の JSON）が、どれもここを使う。
 *   ほかの場所で、artifact の JSON の書式を組み立てない。
 */

const utf8Encoder = new TextEncoder();

/** artifact の JSON の文字列（字下げなし。末尾に LF を1つ付ける）。 */
export const serializeArtifactJson = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** MEM-1: 断片に分けて書く JSON のオブジェクトの項目（`value` は 1 つの値、`items` は配列の項目を 1 つずつ渡すもの）。 */
export type ArtifactJsonStreamField =
  | { readonly name: string; readonly value: unknown }
  | { readonly name: string; readonly items: Iterable<unknown> };

/**
 * MEM-1（DEF-266）: 項目（`fields`。この順）を持つオブジェクトの `serializeArtifactJson` と同じ文字列を、断片に分けて返す（つなぐと同じ文字列。文字列の長さの
 * 上限を超える文書を、ファイルに書き足して書くため）。1 つの断片は、区切りと 1 つの項目か、配列の 1 つの項目の JSON（`JSON.stringify` の決まりのまま:
 * JSON にならない値の項目は書かず、配列の項目は `null`）。
 */
export async function* artifactJsonObjectChunks(fields: readonly ArtifactJsonStreamField[]): AsyncGenerator<string, void, undefined> {
  let separator = '{';
  for (const field of fields) {
    if ('items' in field) {
      yield `${separator}${JSON.stringify(field.name)}:[`;
      let itemSeparator = '';
      for (const item of field.items) {
        yield `${itemSeparator}${JSON.stringify(item) ?? 'null'}`;
        itemSeparator = ',';
      }
      yield ']';
    } else {
      const json: string | undefined = JSON.stringify(field.value);
      if (json === undefined) {
        continue;
      }
      yield `${separator}${JSON.stringify(field.name)}:${json}`;
    }
    separator = ',';
  }
  yield separator === '{' ? '{}\n' : '}\n';
}

/** artifact の JSON のバイト列（`serializeArtifactJson` の文字列を、UTF-8（BOM なし）にしたもの）。 */
export const artifactJsonBytes = (value: unknown): Uint8Array => utf8Encoder.encode(serializeArtifactJson(value));

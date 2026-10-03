/**
 * artifact の JSON の書式の唯一の owner（Task 14〜17 の設計書 6.1.1、6.1.9。CC-026）。
 * - 書式は、字下げ2文字、末尾に LF を1つ、UTF-8（BOM なし）である。
 * - `JSON.stringify` は、文字列の中の改行（CR、LF）をエスケープするので、書式の中に CR は現れない。
 * - `ArtifactWriter`（run.json、audit.json、page.json）と ChatGPT 用バンドル（ZIP の中の JSON）が、どちらもここを使う。
 *   ほかの場所で、artifact の JSON の書式を組み立てない。
 */

const utf8Encoder = new TextEncoder();

/** artifact の JSON の文字列（字下げ2文字。末尾に LF を1つ付ける）。 */
export const serializeArtifactJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** artifact の JSON のバイト列（`serializeArtifactJson` の文字列を、UTF-8（BOM なし）にしたもの）。 */
export const artifactJsonBytes = (value: unknown): Uint8Array => utf8Encoder.encode(serializeArtifactJson(value));

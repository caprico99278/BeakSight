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

/** artifact の JSON のバイト列（`serializeArtifactJson` の文字列を、UTF-8（BOM なし）にしたもの）。 */
export const artifactJsonBytes = (value: unknown): Uint8Array => utf8Encoder.encode(serializeArtifactJson(value));

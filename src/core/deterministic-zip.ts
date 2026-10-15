/**
 * 決定論の ZIP の唯一の組み立て（Task 32 の設計書 4.1 の「決定論の ZIP」、6 章の共通部品。T32f で `chatgpt-bundle.ts` から出し、T32R2 M-2 で
 * `src/report/` から `src/core/` に移した）。監査のバンドル（`src/report/chatgpt-bundle.ts`）と書き込みのバンドル（`action-bundle-bytes.ts`）が使う。
 * 書き込みのバンドルを組み立て直して照らす親（`src/control/job/write-report-check.ts`）も、ここを通る。ファイルは書かない（書くのは ArtifactWriter
 * だけ。ARCH08）。
 * - fflate の `zipSync` を使い、各項目の時刻を固定の値にする。同じ入力からは、時計と時間帯によらず、同じバイト列を作る。
 * - 項目は、渡した順に並べる（fflate は、オブジェクトの鍵の順に並べる。鍵は文字列のパスなので、挿入の順のまま）。同じパスを 2 回渡すと、後の項目で
 *   前の項目を黙って置き換えないよう、`RangeError` を投げる。パスが安全な形かどうかは、呼び出し側が確かめる。
 * - 目録の 1 件（パス、バイト数、sha256）は `zipFileRecordsOf` で求める（sha256 の書式は `createSha256FingerprintOfBytes`）。
 */
import { zipSync, type Zippable } from 'fflate';
import { createSha256FingerprintOfBytes } from './ids.js';

/** ZIP の項目 1 つ（ZIP の中のパスと中身）。 */
export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** 目録の 1 件（ZIP の中のパス、バイト数、sha256）。 */
export interface ZipFileRecord {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * ZIP の各項目の時刻（固定）。fflate は、時刻を実行環境の地方時で DOS の日時に変えるので、時差の表記のない日時の文字列
 * （地方時として解釈される）にして、どの時間帯でも同じバイト列にする。DOS の日時で表せる最も早い日時である。テストの偽のワーカーが同じバイト列の
 * バンドルを作るために、この値を埋め込む（値を書き写さない）。
 */
export const ZIP_ENTRY_MODIFIED_AT = '1980-01-01T00:00:00';

/** 項目を渡した順に並べた、決定論の ZIP のバイト列。同じパスが 2 回あれば `RangeError`。 */
export const deterministicZipOf = (entries: readonly ZipEntry[]): Uint8Array => {
  const zippable: Zippable = {};
  for (const { path, bytes } of entries) {
    if (Object.hasOwn(zippable, path)) {
      throw new RangeError(`a ZIP entry path is given twice: ${JSON.stringify(path)}`);
    }
    zippable[path] = bytes;
  }
  return zipSync(zippable, { mtime: ZIP_ENTRY_MODIFIED_AT });
};

/** 目録の一覧（項目ごとのパス、バイト数、sha256。渡した順）。 */
export const zipFileRecordsOf = (entries: readonly ZipEntry[]): readonly ZipFileRecord[] =>
  entries.map(({ path, bytes }) => ({ path, byteLength: bytes.byteLength, sha256: createSha256FingerprintOfBytes(bytes) }));

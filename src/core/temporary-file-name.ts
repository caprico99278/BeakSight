/**
 * 書き出しの途中の一時ファイルの名前の決まり（`.<名前>.<UUID>.tmp`。中断した Run の再開の設計書 4.3、4.5。T24h-3 で
 * `src/report/artifact-writer.ts` から移した）。`ArtifactWriter` の一時ファイルと、古いロックを動かす先の名前（`src/core/lock-file.ts`）が
 * 同じ形を使う。そのため、どちらも、再開のときの後始末（`ArtifactWriter.cleanUpForResume`）が `isTemporaryFileName` で見分けて消す。
 */
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** 書き出しの途中の一時ファイルの名前（`<接頭辞><名前><区切り><UUID><接尾辞>`。`.<名前>.<UUID>.tmp`）の部品。 */
export const TEMPORARY_FILE_PREFIX = '.';
export const TEMPORARY_FILE_UUID_SEPARATOR = '.';
export const TEMPORARY_FILE_SUFFIX = '.tmp';
/** `randomUUID` が作る UUID の形（小文字の16進数の 8-4-4-4-12 桁）。 */
const RANDOM_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** `path` と同じディレクトリの、書き出しの途中の一時ファイルのパス。 */
export const temporaryPathFor = (path: string): string =>
  join(dirname(path), `${TEMPORARY_FILE_PREFIX}${basename(path)}${TEMPORARY_FILE_UUID_SEPARATOR}${randomUUID()}${TEMPORARY_FILE_SUFFIX}`);

/**
 * 書き出しの途中の一時ファイルの名前（`temporaryPathFor` が作る形。名前の部分は1文字以上）か。再開のときの後始末で、この形の名前
 * だけを消す。
 */
export const isTemporaryFileName = (fileName: string): boolean => {
  if (!fileName.startsWith(TEMPORARY_FILE_PREFIX) || !fileName.endsWith(TEMPORARY_FILE_SUFFIX)) {
    return false;
  }
  const inner = fileName.slice(TEMPORARY_FILE_PREFIX.length, fileName.length - TEMPORARY_FILE_SUFFIX.length);
  const separator = inner.lastIndexOf(TEMPORARY_FILE_UUID_SEPARATOR);
  return separator > 0 && RANDOM_UUID_PATTERN.test(inner.slice(separator + TEMPORARY_FILE_UUID_SEPARATOR.length));
};

/**
 * ファイルの名前の変更（rename）のやり直しの決まりの唯一の owner（CC-062。CCX-11）。成果物の書き出し（`src/report/artifact-writer.ts`。
 * 中断した Run の再開の設計書 4.10。RR の Minor-5）と、資格情報のファイル（`src/control/credentials/credential-store.ts`）の両方が使う。
 * - 一時的な失敗（`RENAME_RETRY_ERROR_CODES`）のときだけ、`RENAME_RETRY_DELAY_MS` 待ってやり直す。試みは、最初の 1 回を含めて最大
 *   `RENAME_MAX_ATTEMPTS` 回。最後まで失敗したら、最後の失敗をそのまま投げる。ほかの失敗（`ENOENT` など）は、やり直さずにすぐ投げる。
 * - 失敗の扱い（一時ファイルを消す、`ENOENT` を移すものがないとみなす、呼び出し側の誤りの形にする）は、呼び出し側が行う。
 */
import { errorCodeOf } from './errors.js';

/**
 * 名前の変更の一時的な失敗とみなす、失敗のコード。Windows で、ウイルス対策や同期のソフト（ほかのプログラム）が一時的にファイルを
 * 開いていると、名前の変更がこれらで失敗する。ほかの失敗（`ENOENT` など）は、やり直しても変わらないので、やり直さない。
 */
export const RENAME_RETRY_ERROR_CODES = Object.freeze(['EPERM', 'EBUSY', 'EACCES'] as const);
const RENAME_RETRY_ERROR_CODE_SET: ReadonlySet<string> = new Set(RENAME_RETRY_ERROR_CODES);

/**
 * 名前の変更を試みる最大の回数（最初の1回を含む）。一時的にファイルを開くソフトは、ふつう短い間に閉じるので、数回で足りる。続けて
 * 失敗する場合（本当に権限がないなど）に、書き出しを長く止めないよう、少なくする。
 */
export const RENAME_MAX_ATTEMPTS = 5;

/**
 * 名前の変更をやり直す前の待ち（ミリ秒）。一時的にファイルを開くソフトが閉じるのを待てる長さにする。最後まで失敗しても、待ちの合計は
 * `(RENAME_MAX_ATTEMPTS - 1) * RENAME_RETRY_DELAY_MS` で、ページの監査の長さに比べて短い。
 */
export const RENAME_RETRY_DELAY_MS = 100;

/** 名前の変更（`node:fs/promises` の `rename` の形。テストの差し替え口）。 */
export type RenameOperation = (oldPath: string, newPath: string) => Promise<void>;

/** やり直す前の待ち（`src/core/deadline.ts` の `wait` の形。テストの差し替え口）。 */
export type WaitBeforeRenameRetry = (delayMs: number) => Promise<void>;

/**
 * 名前の変更を、`renameFile` で行う。失敗のコードが `RENAME_RETRY_ERROR_CODES` のどれかなら、`waitBeforeRetry(RENAME_RETRY_DELAY_MS)` の後に
 * やり直す（最初の 1 回を含めて最大 `RENAME_MAX_ATTEMPTS` 回）。最後まで失敗したら、最後の失敗をそのまま投げる。ほかの失敗は、やり直さずに
 * すぐにそのまま投げる。
 */
export async function renameWithRetry(
  renameFile: RenameOperation,
  waitBeforeRetry: WaitBeforeRenameRetry,
  oldPath: string,
  newPath: string,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFile(oldPath, newPath);
      return;
    } catch (error) {
      const code = errorCodeOf(error);
      if (attempt >= RENAME_MAX_ATTEMPTS || code === null || !RENAME_RETRY_ERROR_CODE_SET.has(code)) {
        throw error;
      }
    }
    await waitBeforeRetry(RENAME_RETRY_DELAY_MS);
  }
}

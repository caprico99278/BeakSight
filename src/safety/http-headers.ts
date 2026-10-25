// HTTP のヘッダの名前と、大文字と小文字を区別しないヘッダの読み方の唯一の部品（T36R-fix。T36R の M-5）。
// - Guard（`passive-request-guard.ts`。要求のヘッダ）、token の送信の応答の観測（`token-response-observation.ts`。応答のヘッダ）、ワーカーの
//   自動ログイン（`src/worker/automated-login.ts`。`Retry-After` の名前）が使う。
// - 値は持たない（読むだけ）。CDP のヘッダ（`Record<string, string>`。名前の大文字と小文字はサーバとブラウザのまま）を、名前の大文字と小文字を
//   区別せずに読む。最初に当たった文字列の値を返す。
import { isRecord } from '../core/guards.js';

/** `Retry-After` のヘッダの名前（429 の応答。読み方は `src/control/auth/automated-login-timing.ts`）。 */
export const RETRY_AFTER_HEADER = 'retry-after';

/** ヘッダの値（名前の大文字と小文字を区別しない。最初に当たった文字列の値。ヘッダの組でないか、なければ `undefined`）。 */
export function headerValueOf(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

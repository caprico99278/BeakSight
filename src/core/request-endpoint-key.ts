/**
 * 要求の口の鍵の唯一の作り方（AUD-7・AUD-2b。設計者の判断 2026-11-10）。口は、メソッドと Origin と path（query と fragment は見ない）。
 * - 使う所: 誤りの応答の回復・やり直しの照らし合わせ（`src/audit/http-error-classes.ts`）と、落ち着きの判定のデータの静まり（network の collector が
 *   `dataRequestActivity` の口ごとの事実に入れ、`src/browser/page-settling.ts` が読む）。
 * - 比べるためだけの鍵で、URL を作り直さない（正規化・受け入れの判定ではない）。解析できない URL は、query と fragment の前までの文字で鍵にする。
 */
export function requestEndpointKeyOf(method: string | null, url: string): string {
  try {
    const parsed = new URL(url);
    return JSON.stringify([method, parsed.origin, parsed.pathname]);
  } catch {
    return JSON.stringify([method, url.split(/[?#]/u)[0] ?? url]);
  }
}

/**
 * QUIET-3: 口の鍵（`requestEndpointKeyOf` の形）から、メソッドと Origin と path を読む（鍵の形を知るのはこのファイルだけ）。解析できなかった URL の鍵・
 * 形の違う文字は null。
 */
export function requestEndpointPartsOf(key: string): { readonly method: string; readonly origin: string; readonly pathname: string } | null {
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 3 || !parts.every((part) => typeof part === 'string')) return null;
    const [method, origin, pathname] = parts as [string, string, string];
    return { method, origin, pathname };
  } catch {
    return null;
  }
}

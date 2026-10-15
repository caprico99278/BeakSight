import { createRouter } from '@tanstack/react-router';
import { getGlobalStartContext } from '@tanstack/react-start';
import { routeTree } from './routeTree.gen';

/** 画面の Router を作る（TanStack Start が要求ごとに呼ぶ）。 */
export function getRouter() {
  // 要求ごとの CSP の nonce（サーバだけ。`src/start.ts` の middleware が context に入れたもの。T23e）。SSR の inline の script に付ける。
  // ブラウザの側では `getGlobalStartContext()` は `undefined` を返す。
  const nonce = getGlobalStartContext()?.cspNonce;
  return createRouter({
    routeTree,
    scrollRestoration: true,
    ...(nonce === undefined ? {} : { ssr: { nonce } }),
  });
}

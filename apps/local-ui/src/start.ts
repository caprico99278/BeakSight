/**
 * TanStack Start の設定（Task 23 設計書 4.4。T23b、T23e）。
 * - `src/start.ts` を置くと Start の既定の CSRF の保護が外れるため、CSRF の middleware を明示で付ける。
 *   Server Function の要求は、`Sec-Fetch-Site: same-origin`（なければ `Origin`）が一致しなければ 403 になる。
 * - 要求の守りの部品（`launcher/request-guard.ts`）が要求の header に入れた CSP の nonce を、要求の context（`cspNonce`）に移す。
 *   `src/router.tsx` が、SSR の inline の script に付ける。守りの部品は、外から来た同じ名前の header を必ず消してから入れる。
 *   （`@tanstack/react-start/server` の `getRequestHeader` は、その型の宣言（`session.d.ts`）が `skipLibCheck:false` で誤りになるため使わない。）
 */
import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start';
import { CSP_NONCE_REQUEST_HEADER } from './security/csp-nonce';

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
});

const cspNonceMiddleware = createMiddleware().server(({ request, next }) =>
  next({ context: { cspNonce: request.headers.get(CSP_NONCE_REQUEST_HEADER) ?? undefined } }),
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, cspNonceMiddleware],
}));

/**
 * CSP の nonce を、要求の守りの部品（`launcher/request-guard.ts`）から SSR（`src/router.tsx`）へ渡す要求の header の名前（T23e）。
 * - 守りの部品は、外から来た同じ名前の header を必ず消してから、要求ごとの nonce を入れる（外から nonce を指定させない）。
 * - 本番の起動の部品と、開発のサーバ（Vite の middleware）の両方で、同じ渡し方をする（開発のサーバの TanStack の middleware は
 *   `fetch(request)` に context を渡さないため、header で渡す）。
 * - このファイルは、ブラウザの bundle にも入る。Node の部品を import しない。
 */
export const CSP_NONCE_REQUEST_HEADER = 'x-beaksight-csp-nonce';

/**
 * 画面とサーバのテストの vitest の設定（Task 23 設計書 4.8。T23e）。ルートの `vitest.config.ts`（`tests/**`）とは別。
 * 実行: `npx vitest run --config apps/local-ui/vitest.config.ts`（先に `npm run build:ui` が要る）。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** 子の process（サーバ、Chromium）を起動するテストの上限（ミリ秒）。 */
const SERVER_TEST_TIMEOUT_MS = 90_000;

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: SERVER_TEST_TIMEOUT_MS,
    hookTimeout: SERVER_TEST_TIMEOUT_MS,
    restoreMocks: true,
    fileParallelism: false,
  },
});

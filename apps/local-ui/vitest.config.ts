/**
 * 画面とサーバのテストの vitest の設定（Task 23 設計書 4.8。T23e）。ルートの `vitest.config.ts`（`tests/**`）とは別。
 * 実行: `npx vitest run --config apps/local-ui/vitest.config.ts`（先に `npm run build:ui` が要る）。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** 子の process（サーバ、Chromium）を起動するテストの上限（ミリ秒）。 */
const SERVER_TEST_TIMEOUT_MS = 90_000;

/**
 * 画面のテストのファイルを同時に流す数（TS-e。設計書 `doc/design/2026-10-24-beaksight-test-suite-tiers-design.md` 3.5）。前は直列
 * （`fileParallelism: false`。T23e で最初からそうしていて、理由の記録はなかった）。ファイルの間で共有しているものは、もうファイルごとに分かれている:
 * - 一時の root（管理データ、画面のサーバのロック、出力、資格情報のフォルダ）は、ファイルごとに OS の一時のフォルダに作る（`createTemporaryUiRoot`）。
 * - port は、127.0.0.1 の 0 で空きを得る（`findFreePort`）。4317（製品の既定）を使うテストはない。
 * - process の残りの検査は、自分が起動した画面のサーバの子孫だけを数える（`descendantsOf`）。Ctrl+C は、専用のコンソールの中だけに送る。
 * - リポジトリの `node_modules/.vite`（Vitest の `vitest/` を除く）と `local-data/` の様子の検査は、どの画面のテストもそこに書かないので、同時に流しても
 *   変わらない（書いたら、それは検査が見つけるべき誤り）。`dist/` と `apps/local-ui/dist/` は、一時の root に写して読むだけ。
 * 3 にした測り（2026-10-24。並行の担当の結合のテストが動いている下）: 直列の前の測り 1,585 秒（ファイルの時間の和）に対して、3 並列 706 秒と 625 秒、
 * 2 並列 1,003 秒。どの回も 75 ファイル 642 件が通り（再実行なし）、ファイルごとの時間は直列の 0.9〜1.9 倍に収まった。揺らぎが増えたら、ここを下げるか、
 * 揺れたファイルだけを直列の組にする（組の一覧は `tests/suites.ts` に置く）。
 */
const UI_MAX_WORKERS = 3;

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: SERVER_TEST_TIMEOUT_MS,
    hookTimeout: SERVER_TEST_TIMEOUT_MS,
    restoreMocks: true,
    maxWorkers: UI_MAX_WORKERS,
  },
});

/**
 * RB-7: 画面のテストのデータの根（一時のフォルダ）の中の、監査のワーカーの入口の場所（`ui-test-launcher.ts` と `local-server.ts` が使う 1 か所。
 * 偽のワーカー・ログインのワーカーのテストは、ここに入口を書き換える）。拡張子は `.mjs`（一時のフォルダに package.json がなくても ESM で読む）。
 */
export const TEST_WORKER_ENTRY = 'test-worker/audit-worker.mjs';

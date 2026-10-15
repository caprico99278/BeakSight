/**
 * 画面のサーバが使うリポジトリの root を、このモジュール自身の場所から決める（Task 23 設計書 4.3、4.6。T23f）。
 * - 開発のサーバでは `apps/local-ui/src/server/…`、ビルドした画面のサーバでは `apps/local-ui/dist/server/…` にある。どちらも、パスの
 *   最後の `/apps/local-ui/` より前がリポジトリの root。
 * - データの場所を変える引数や環境変数は作らない（場所は `resolveControlDatabasePath(root)` だけで決まる）。テストは、画面の起動に要るものを
 *   一時のフォルダの `apps/local-ui/` に置いて起動するので、その一時のフォルダが root になる。
 */
import { fileURLToPath } from 'node:url';

/** リポジトリの root からの、画面のフォルダ（区切りは `/`）。 */
const APP_DIRECTORY_MARKER = '/apps/local-ui/';

/** モジュールの URL から、リポジトリの root（絶対パス。区切りは `/`）を求める。見つからなければ誤り（fail-closed）。 */
export const repositoryRootOf = (moduleUrl: string): string => {
  const path = fileURLToPath(moduleUrl).replaceAll('\\', '/');
  const index = path.lastIndexOf(APP_DIRECTORY_MARKER);
  if (index <= 0) {
    throw new Error(`the local UI module is not under ${APP_DIRECTORY_MARKER}: ${path}`);
  }
  return path.slice(0, index);
};

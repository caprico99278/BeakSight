// 管理データのファイルの場所の唯一の owner（Task 23 の設計書 4.3、4.6。T23a）。
// - 場所は `<リポジトリの根>/local-data/beaksight-control.sqlite`。`local-data/` は `.gitignore` で Git の管理の外にする
//   （`tests/architecture/control-store-boundary.test.ts` で確かめる）。
// - 本番の入口（`npm run setup:local`、`npm run ui`）は、必ずこの関数で場所を決める。開く部品（`openControlDatabase`）は場所を引数で受ける
//   （テストは一時のフォルダを渡す）。
import { isAbsolute, join } from 'node:path';

/** 管理データを置くフォルダの名前（リポジトリの根の直下）。 */
export const CONTROL_DATA_DIRECTORY_NAME = 'local-data';

/** 管理データのファイルの名前。 */
export const CONTROL_DATABASE_FILE_NAME = 'beaksight-control.sqlite';

/** DEF-146: 画面のサーバが終わったときの記録のファイルを置く、管理データのフォルダの下のフォルダの名前と、ファイルの名前。 */
export const UI_SERVER_LOG_DIRECTORY_NAME = 'logs';
export const UI_SERVER_LOG_FILE_NAME = 'ui-server.log';

/** DEF-146: 画面のサーバが終わったときの記録のファイルの場所（`<リポジトリの根>/local-data/logs/ui-server.log`。絶対パス）。 */
export const resolveUiServerLogPath = (repoRoot: string): string => {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0 || !isAbsolute(repoRoot)) {
    throw new RangeError('the repository root for the UI server log must be an absolute path');
  }
  return join(repoRoot, CONTROL_DATA_DIRECTORY_NAME, UI_SERVER_LOG_DIRECTORY_NAME, UI_SERVER_LOG_FILE_NAME);
};

/** 管理データのファイルの場所（絶対パス）。`repoRoot` は絶対パスで渡す（今の作業フォルダに依存させない）。 */
export const resolveControlDatabasePath = (repoRoot: string): string => {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0 || !isAbsolute(repoRoot)) {
    throw new RangeError('the repository root for the control database must be an absolute path');
  }
  return join(repoRoot, CONTROL_DATA_DIRECTORY_NAME, CONTROL_DATABASE_FILE_NAME);
};

/**
 * 対象の設定のファイル（ターゲット JSON）の置き場所の唯一の owner（T43b fix round 1。共通化）。純粋な定数だけ（何も import しない。画面の
 * ブラウザ側も読む）。
 * - プロファイルが参照してよいフォルダは、Git の管理の対象の `config/targets/` と、Git の管理の外の `local/targets/`（リポジトリの root からの
 *   相対。区切りは `/`。末尾の `/` を含む）。拡張子は `.json`。
 * - 使う所: パスの判定（`profile-policy.ts` の `isAcceptedTargetConfigPath`）、画面の設定のファイルの候補（`profile-functions.ts`）、開始の URL から
 *   作るファイルの場所（画面の `display/start-url-draft.ts` と `server/target-config-writer.ts`。作るのは `local/targets/` だけ）。
 * - CLI の既定の置き場所（`src/config/load-config.ts` の `config/targets/`）は、CLI が `src/control/` を読み込まない決まりのため、ここを使わない。
 */

/** Git の管理の対象の置き場所。 */
export const CANONICAL_TARGET_CONFIG_DIRECTORY = 'config/targets/';

/** Git の管理の外の置き場所（開始の URL から作るファイルも、ここに置く）。 */
export const LOCAL_TARGET_CONFIG_DIRECTORY = 'local/targets/';

/** プロファイルが参照してよい置き場所（この順で候補を並べる）。 */
export const TARGET_CONFIG_DIRECTORIES: readonly string[] = Object.freeze([CANONICAL_TARGET_CONFIG_DIRECTORY, LOCAL_TARGET_CONFIG_DIRECTORY]);

/** 対象の設定のファイルの拡張子。 */
export const TARGET_CONFIG_EXTENSION = '.json';

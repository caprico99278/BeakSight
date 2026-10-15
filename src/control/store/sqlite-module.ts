// `node:sqlite` を読み込む唯一の場所（Task 23 の設計書 4.3、4.5。T23a）。
// - 静的な import をしない（型だけの import は実行時に消える）。`node:sqlite` がない Node（`--no-experimental-sqlite` など）でも、
//   このファイルを読み込んだだけでは落ちず、環境の確かめ（`src/control/environment/`）が分かりやすい理由で止められる。
// - 読み込みは `process.getBuiltinModule` で行う。使えなければ `undefined` を返す（投げない）。
// - Architecture Gate（`tests/architecture/control-store-boundary.test.ts`）: `node:sqlite` を参照するのは `src/control/store/` の中だけ、
//   `getBuiltinModule` を呼ぶのはこのファイルだけ。
import type * as NodeSqlite from 'node:sqlite';

/** `node:sqlite` のモジュールの型。 */
export type NodeSqliteModule = typeof NodeSqlite;

/** SQLite の接続（`node:sqlite` の `DatabaseSync`）。 */
export type SqliteConnection = NodeSqlite.DatabaseSync;

/** 読み込むモジュールの識別子（`node:` の接頭辞が必須のモジュール）。 */
const NODE_SQLITE_MODULE_ID = 'node:sqlite';

/** `node:sqlite` を読み込む。この Node で使えなければ `undefined`。 */
export const loadNodeSqlite = (): NodeSqliteModule | undefined => {
  // 古い Node（`process.getBuiltinModule` がない版）でも投げない。
  if (typeof process.getBuiltinModule !== 'function') {
    return undefined;
  }
  const loaded: NodeSqliteModule | undefined = process.getBuiltinModule(NODE_SQLITE_MODULE_ID);
  return loaded;
};

/**
 * 画面のサーバの依存の置き場所（RB-7。テストの再構築の設計書 2 章 6、plan の 6 章 C）。サーバだけで使う。
 * - 画面のサーバの process の中の、データの根（管理データ・資格情報・ターゲット設定・出力の根。ワーカーの cwd）と、監査のワーカーの入口を、ここ 1 か所で決める。
 *   管理データの接続（`control-store`）、ジョブの管理（`audit-jobs`）、資格情報の部品（`credential-runtime`）は、ここから読む。
 * - 本番の値は `productionLocalUiRuntimeOptions` だけが作る（データの根は、このモジュールの場所から決めたリポジトリの root。ワーカーは
 *   `<root>/dist/worker/audit-worker.js`）。本番の起動の部品と開発のサーバは、何も入れずに使う（最初に読んだときに本番の値になる）。
 * - テストだけが `installLocalUiRuntime` で別の根と入口を入れる（最初に読む前だけ。後からは入れ替えられない）。資格情報の部品は、いつも入れた根の本物
 *   （`createCredentialStore(<根>)`。差し替えの口を作らない。秘密の目印の確かめを本物の暗号化のまま行うため）。
 * - 利用者が触れる口（環境変数・引数・設定）からは変えられない（このファイルは `process.env`・`process.argv` を読まない）。本番のコードが
 *   `installLocalUiRuntime` を呼ばないことは、Gate `local-ui-runtime-boundary` が確かめる。
 */
import { isAbsolute, join } from 'node:path';
import { repositoryRootOf } from './repository-root';

/** 画面のサーバの依存。 */
export interface LocalUiRuntimeOptions {
  /** データの根（絶対パス）。 */
  readonly dataRoot: string;
  /** 監査のワーカーの入口（絶対パス）。 */
  readonly workerPath: string;
}

/** リポジトリの root からの、監査のワーカーの入口（`npm run build` の出力）。 */
const WORKER_ENTRY_SEGMENTS = Object.freeze(['dist', 'worker', 'audit-worker.js'] as const);

let options: LocalUiRuntimeOptions | null = null;

/** 本番の値（リポジトリの root と、そのビルドのワーカー）。 */
export const productionLocalUiRuntimeOptions = (): LocalUiRuntimeOptions => {
  const root = repositoryRootOf(import.meta.url);
  return Object.freeze({ dataRoot: root, workerPath: join(root, ...WORKER_ENTRY_SEGMENTS) });
};

/** この process の依存（入れていなければ、本番の値に決める）。 */
export const localUiRuntimeOptions = (): LocalUiRuntimeOptions => {
  options ??= productionLocalUiRuntimeOptions();
  return options;
};

/** テストだけ: 別の根と入口を入れる。もう決まっていれば（読んだ後・2 回目）、絶対パスでなければ、誤り（fail-closed）。 */
export const installLocalUiRuntime = (installed: LocalUiRuntimeOptions): void => {
  if (options !== null) {
    throw new Error('the local UI runtime is already decided');
  }
  if (!isAbsolute(installed.dataRoot) || !isAbsolute(installed.workerPath)) {
    throw new Error('the local UI runtime paths must be absolute');
  }
  options = Object.freeze({ dataRoot: installed.dataRoot.replaceAll('\\', '/'), workerPath: installed.workerPath });
};

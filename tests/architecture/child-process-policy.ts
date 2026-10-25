/**
 * `node:child_process`（子 process を起動するモジュール）を参照してよいファイルの決まり（PRE42-CC の組 G。調べの「新 Gate」の 12）。
 * `credential-boundary.test.ts` の (r) と `write-stage-boundary.test.ts` の (e3) が共用する（同じ一覧を 2 か所に書かない）。テストのファイルではない
 * （テストを持たない）。
 * - 共通の一覧は、実行時に子 process を起動するファイル（ワーカーを起動するジョブの管理と、DPAPI の子 process を起動する資格情報の保護）。
 * - 許す範囲は、2 つの Gate の和にしない。各 Gate は、共通の一覧に Gate ごとの追加を足して読む（credential の (r) は、資格情報のファイルの部品
 *   `credential-store.ts` も許す。(e3) は、共通の一覧とちょうど同じことを確かめる）。
 * - 子 process からサイトへ送る口を作らないため（`write-stage-boundary.test.ts` の (e3)）と、資格情報の部品の外で子 process・PowerShell を
 *   起動しないため（`credential-boundary.test.ts` の (r)）。
 */
import { modulePattern } from './source-scan.js';

/** 子 process を起動するモジュール（`node:` の有無を問わない。`source-scan.ts` の最も広い形）。 */
export const CHILD_PROCESS_MODULE = modulePattern(['child_process']);

/** 実行時に `node:child_process` を参照してよいファイル（閉じた一覧）。 */
export const CHILD_PROCESS_RUNTIME_FILES: readonly string[] = Object.freeze([
  'src/control/job/audit-job-manager.ts',
  'src/control/credentials/dpapi-protector.ts',
]);

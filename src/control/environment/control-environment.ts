// 管理データの部品を使う前の、環境の確かめの唯一の owner（Task 23 の設計書 4.5、4.6。T23a）。
// - Node の版が下限（`MIN_CONTROL_NODE_VERSION`。`package.json` の `engines` の下限と一致することをテストで固定する）以上か。
// - `node:sqlite` が使えるか（読み込みは `src/control/store/sqlite-module.ts` の 1 か所。`node:sqlite` を参照するのは
//   `src/control/store/` の中だけ、という Architecture Gate のため、ここでは読み込みの部品を呼ぶだけにする）。
// - 結果は合否と、閉じた一覧の理由の値（日本語の説明は表示の部品 `src/presentation/` が T23d で持つ）。
// - 今の CLI の監査のコマンドは、このファイルを読み込まない（影響させない）。
import { loadNodeSqlite } from '../store/sqlite-module.js';

/** 管理データの部品が求める Node の版の下限（`node:sqlite` が Release candidate になり、警告が出なくなった版）。 */
export const MIN_CONTROL_NODE_VERSION = '24.15.0';

/** 環境の確かめで止める理由（閉じた一覧。確かめる順）。 */
export const CONTROL_ENVIRONMENT_FAILURE_REASONS = Object.freeze(['NODE_VERSION_UNSUPPORTED', 'NODE_SQLITE_UNAVAILABLE'] as const);
export type ControlEnvironmentFailureReason = (typeof CONTROL_ENVIRONMENT_FAILURE_REASONS)[number];

/** 確かめに使う事実（`checkControlEnvironment` は今の process から集める。テストは値を渡す）。 */
export interface ControlEnvironmentFacts {
  /** Node の版（`process.versions.node` の形。先頭の `v` があってもよい）。 */
  readonly nodeVersion: string;
  /** `node:sqlite` を読み込めたか。 */
  readonly sqliteAvailable: boolean;
}

/** 環境の確かめの結果（凍結した値）。 */
export type ControlEnvironmentResult =
  | { readonly ok: true; readonly nodeVersion: string }
  | { readonly ok: false; readonly nodeVersion: string; readonly reason: ControlEnvironmentFailureReason };

/** 版の文字列の形（`X.Y.Z`。先頭の `v` は任意。前後の空白や 4 つ目の部分は受けない）。 */
const NODE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/u;

/** 版の文字列を、数の 3 つ組にする。形が違えば `null`。 */
const parseNodeVersion = (version: string): readonly [number, number, number] | null => {
  const match = NODE_VERSION_PATTERN.exec(version);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * `version` が `minimum` 以上か（各部分を数として比べる）。どちらかの形が `X.Y.Z` でなければ `false`（fail-closed）。
 */
export const isNodeVersionAtLeast = (version: string, minimum: string): boolean => {
  const actual = parseNodeVersion(version);
  const required = parseNodeVersion(minimum);
  if (actual === null || required === null) {
    return false;
  }
  for (let index = 0; index < actual.length; index += 1) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
};

/** 結果を凍結して返す（平らなオブジェクト）。 */
const frozen = (result: ControlEnvironmentResult): ControlEnvironmentResult => Object.freeze(result);

/** 事実から、環境の確かめの結果を決める。版が足りなければ、SQLite の有無より先に版を理由にする（Node の更新で両方が直る）。 */
export const evaluateControlEnvironment = (facts: ControlEnvironmentFacts): ControlEnvironmentResult => {
  const { nodeVersion } = facts;
  if (!isNodeVersionAtLeast(nodeVersion, MIN_CONTROL_NODE_VERSION)) {
    return frozen({ ok: false, nodeVersion, reason: 'NODE_VERSION_UNSUPPORTED' });
  }
  if (!facts.sqliteAvailable) {
    return frozen({ ok: false, nodeVersion, reason: 'NODE_SQLITE_UNAVAILABLE' });
  }
  return frozen({ ok: true, nodeVersion });
};

/**
 * 今の process の環境を確かめる。版が足りないときは、`node:sqlite` を読み込まない（古い Node の実験の警告を出さないため）。
 */
export const checkControlEnvironment = (): ControlEnvironmentResult => {
  const nodeVersion = process.versions.node;
  if (!isNodeVersionAtLeast(nodeVersion, MIN_CONTROL_NODE_VERSION)) {
    return evaluateControlEnvironment({ nodeVersion, sqliteAvailable: false });
  }
  return evaluateControlEnvironment({ nodeVersion, sqliteAvailable: loadNodeSqlite() !== undefined });
};

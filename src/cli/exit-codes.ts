/**
 * CLI の終了コードの唯一の表（Task 14〜17 の設計書 第7章、UI追補設計書 第4章、上位の設計書 第28章）。
 * - 終了コードは、最終の Run Status と、設定のエラー（`CONFIG_ERROR`）だけから決める。サイトの ERROR の Finding の件数では決めない。
 * - CLI の分岐とテストは、この表から値を取る。ほかの場所に終了コードの数値を書かない。
 * - このファイルは、GATE-UI01 の対象から除く（状態の値を、表の鍵として書くため）。
 */
import { RUN_STATUSES, type RunStatus } from '../core/contracts.js';
import { deepFreeze } from '../core/immutable.js';

/** Run の外で決まる結果（設定のエラー）。 */
export const CONFIG_ERROR_OUTCOME = 'CONFIG_ERROR';

/** 終了コードを決める結果の一覧（Run Status のすべてと、`CONFIG_ERROR`）。 */
export const EXIT_OUTCOMES = Object.freeze([...RUN_STATUSES, CONFIG_ERROR_OUTCOME] as const);
export type ExitOutcome = (typeof EXIT_OUTCOMES)[number];

/** 結果から終了コードへの対応表。書き漏れは、型のエラーになる。 */
export const EXIT_CODES = deepFreeze({
  COMPLETE: 0,
  FAILED: 1,
  PARTIAL: 2,
  ABORTED_BY_SAFETY: 3,
  CONFIG_ERROR: 4,
} as const satisfies Record<ExitOutcome, number>);

/** 設定のエラー（設定のファイル、JSON、検証、CLI の引数の誤り）の終了コード。 */
export const CONFIG_ERROR_EXIT_CODE = EXIT_CODES[CONFIG_ERROR_OUTCOME];

/**
 * Run の外の失敗（artifact の書き出しの入出力の失敗と、予期しない例外）の終了コード。FAILED と同じ（設計書 6.1.1）。
 */
export const FAILURE_EXIT_CODE = EXIT_CODES.FAILED;

/** Run を行わないコマンド（`validate-config`）と、使い方の表示（`--help`）の成功の終了コード。COMPLETE と同じ。 */
export const SUCCESS_EXIT_CODE = EXIT_CODES.COMPLETE;

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);

/** 最終の Run Status の終了コード。Run Status でない値は、呼び出し側の誤りとして `RangeError` を投げる。 */
export const exitCodeForRunStatus = (status: RunStatus): number => {
  if (!RUN_STATUS_SET.has(status)) {
    throw new RangeError(`not a Run Status: ${String(status)}`);
  }
  return EXIT_CODES[status];
};

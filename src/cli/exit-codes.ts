/**
 * CLI の終了コードの唯一の表（Task 14〜17 の設計書 第7章、UI追補設計書 第4章、上位の設計書 第28章、中断した Run の再開の設計書 4.7、4.7.1）。
 * - 終了コードは、最終の Run Status と、Run の外で決まる結果（設定のエラー `CONFIG_ERROR`、Run を始められない `RUN_UNAVAILABLE`、
 *   中断 `INTERRUPTED`）だけから決める。サイトの ERROR の Finding の件数では決めない。
 * - CLI の分岐とテストは、この表から値を取る。ほかの場所に終了コードの数値を書かない。
 * - このファイルは、GATE-UI01 の対象から除く（状態の値を、表の鍵として書くため）。
 */
import { RUN_STATUSES, type RunStatus } from '../core/contracts.js';
import { deepFreeze } from '../core/immutable.js';

/** Run の外で決まる結果（設定のエラー）。 */
export const CONFIG_ERROR_OUTCOME = 'CONFIG_ERROR';

/**
 * Run の外で決まる結果（Run を始められない。中断した Run の再開の設計書 4.7.1）。出力先で別の Run が実行中である、途中の Run の版が違う、
 * 再開のときにロックを別のプロセスが持っている・同時に作り直された、再開のための保存を読み書きできない、の場合である。
 */
export const RUN_UNAVAILABLE_OUTCOME = 'RUN_UNAVAILABLE';

/**
 * Run の外で決まる結果（中断。中断した Run の再開の設計書 4.7、4.7.1）。2回目のシグナル（SIGINT・SIGTERM・SIGHUP）を受けて、最後の処理
 * （出力の書き出し）をせずに、すぐに終えた場合である。再開のための保存は、最後に監査を終えたページまで残る。1回目のシグナルで、今のページを
 * 終えてから止まった Run は、この結果ではなく、その Run の Run Status で終える。
 */
export const INTERRUPTED_OUTCOME = 'INTERRUPTED';

/** 終了コードを決める結果の一覧（Run Status のすべてと、`CONFIG_ERROR`、`RUN_UNAVAILABLE`、`INTERRUPTED`）。 */
export const EXIT_OUTCOMES = Object.freeze([...RUN_STATUSES, CONFIG_ERROR_OUTCOME, RUN_UNAVAILABLE_OUTCOME, INTERRUPTED_OUTCOME] as const);
export type ExitOutcome = (typeof EXIT_OUTCOMES)[number];

/**
 * 結果から終了コードへの対応表。書き漏れは、型のエラーになる。
 * `RUN_UNAVAILABLE` は、設計どおり `CONFIG_ERROR` と同じ 4 である（設計書 4.7.1。どちらも、Run を行わずに終えた結果）。2つの結果が同じ値を
 * 持つのは、この組だけである（終了コードのテストで確かめる）。`INTERRUPTED` の 5 は、ほかのどの結果とも違う値である。
 */
export const EXIT_CODES = deepFreeze({
  COMPLETE: 0,
  FAILED: 1,
  PARTIAL: 2,
  ABORTED_BY_SAFETY: 3,
  CONFIG_ERROR: 4,
  RUN_UNAVAILABLE: 4,
  INTERRUPTED: 5,
} as const satisfies Record<ExitOutcome, number>);

/** 設定のエラー（設定のファイル、JSON、検証、CLI の引数の誤り）の終了コード。 */
export const CONFIG_ERROR_EXIT_CODE = EXIT_CODES[CONFIG_ERROR_OUTCOME];

/** Run を始められない場合（`RUN_UNAVAILABLE_OUTCOME`）の終了コード。 */
export const RUN_UNAVAILABLE_EXIT_CODE = EXIT_CODES[RUN_UNAVAILABLE_OUTCOME];

/** 中断（`INTERRUPTED_OUTCOME`。2回目のシグナルで、最後の処理をせずにすぐに終えた）の終了コード。 */
export const INTERRUPTED_EXIT_CODE = EXIT_CODES[INTERRUPTED_OUTCOME];

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

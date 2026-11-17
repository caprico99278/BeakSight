/**
 * フォームの入力の部品の共通の値（T30c。ログインの入力の部品 `login-form-submitter.ts` と、書き込みの入力の部品 `write-form-submitter.ts` が
 * 共用する。Node の側の値だけ。ページの中で動く関数は外の値を参照できないので、ページの中の読み方はそれぞれの部品が持つ）。
 */

import type { Page } from 'playwright';
import { PROGRESS_WATCH_QUIET_LIMIT_MS, watchProgress } from '../core/progress-watch.js';
import { observationWindowsOrProduction, type ObservationWindows } from '../core/observation-windows.js';
import { openEndedStageDeadline } from '../orchestration/stage-deadline.js';
import { attachPageProgressSignals } from './page-progress-signals.js';
import { waitForPageSettled, type DataActivity } from './page-settling.js';

/**
 * ログインのフォームを読む・値を入れる・送る、それぞれの時間の上限（ms）。L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2 の判断 7）: ログインの
 * 群（自動ログインの間隔と回数）のまま、ログインの側だけが使う（書き込みの側は `WRITE_STEP_TIMEOUT_MS`）。
 */
export const FORM_STEP_TIMEOUT_MS = 10_000;

/**
 * L12b（設計書 6.2。T23）: 書き込みの入力の部品（form と API）の、1 手（読む・入れる・押す）を待つ長さ（ms）。期限ではなく、L0 の進みの見張りの反応なしの長さ
 * （`PROGRESS_WATCH_QUIET_LIMIT_MS`）と同じにする（1 回のブラウザの呼び出しが、この長さの間、全く返らないときだけ見放す。前の 10 秒の上限は撤廃した）。
 */
export const WRITE_STEP_TIMEOUT_MS = PROGRESS_WATCH_QUIET_LIMIT_MS;

/**
 * L12b（L12a の限界 3・4。T24）: 押した後のページの送信と画面の変化が静まるまで待つ（書き込みの段の唯一の部品。form と API の入力の部品と書き込みの流れが使う）。
 * 期限を置かない（全く反応がないとき・静まらないときは、L0 の進みの見張り `watchProgress` が終える）。`until` が真になったら、静まりを待たずに終える。静まりの判定は、
 * 落ち着きの待ちの唯一の部品 `waitForPageSettled`（作りの印・高さ・読み込みの段・データの途中の数）に任せる。静まりの窓は、開いたままのデータの要求を届いたと
 * みなす長さ（`OPEN_DATA_REQUEST_QUIET_MS`）にする（押した後に少し遅れて出るページの送信を待つため。これより遅れて出る送信は見落としうる。限界）。
 * TEST-TIME-B・RB-2: 窓の長さ（`afterPress.pressQuietWindowMs`）と確かめの間隔（`pageSettle.pollIntervalMs`）は、呼ぶ側が渡す観察の窓の一式
 * （`observationWindows`）でだけ替わる（テストだけ。利用者が触れる口からは渡せない）。省略すると本番の値。
 */
export async function waitForPageQuietAfterPress(
  page: Page,
  options: {
    readonly dataActivity?: (() => DataActivity) | undefined;
    readonly until?: (() => boolean) | undefined;
    readonly observationWindows?: ObservationWindows | undefined;
  } = {},
): Promise<void> {
  const windows = observationWindowsOrProduction(options.observationWindows);
  const quietWindowMs = windows.afterPress.pressQuietWindowMs;
  const { pollIntervalMs } = windows.pageSettle;
  if (page.isClosed()) {
    return;
  }
  await watchProgress(async (signals) => {
    const detach = attachPageProgressSignals(page, signals);
    const stop = new AbortController();
    const until = options.until;
    // `until` が真になったら、静まりの待ちをやめる（見張りの終わりと同じ口で止める）。
    const watchUntil = until === undefined ? undefined : (async (): Promise<void> => {
      while (!stop.signal.aborted && !signals.signal.aborted) {
        if (until()) {
          stop.abort();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    })();
    const progress = {
      mark: signals.mark,
      get signal(): AbortSignal {
        return stop.signal.aborted ? stop.signal : signals.signal;
      },
    };
    try {
      await waitForPageSettled(page, {
        // 期限の数を必ず受け取る部品なので、切らない値（L1 の共通の部品 `openEndedStageDeadline`）を渡す。
        deadlineAtMs: openEndedStageDeadline(Date.now()),
        pollIntervalMs,
        stableWindowMs: quietWindowMs,
        openDataRequestQuietMs: quietWindowMs,
        progress,
        ...(options.dataActivity === undefined ? {} : { dataActivity: options.dataActivity }),
      });
    } finally {
      stop.abort();
      await watchUntil;
      detach();
    }
  });
}

/** 受ける method（ブラウザの `method`・`formMethod` のプロパティは小文字）。 */
export const FORM_POST_METHOD = 'post';

/** 同じ page を表す送信の先（空は既定の `_self`）。 */
export const FORM_SELF_TARGETS: ReadonlySet<string> = new Set(['', '_self']);

/** 改行の比べのための形（textarea の値は LF。CR LF と CR を LF にする）。 */
export const lineFeedForm = (text: string): string => text.split('\r\n').join('\n').split('\r').join('\n');

/**
 * 2 つの値が同じか（完全な一致。改行だけ CR LF・CR・LF を同じと見なす。Task 31 の設計書 3 章の「値の照らし方」。null は null とだけ同じ）。
 * 入力の前の確かめと、更新の後の照合（T31g-2）と、API の書き込みの入力の読み直し（T39d。`api-write-submitter.ts`）が使う唯一の比べ方。T39d で
 * `write-form-submitter.ts` から移した（`write-form-submitter.ts` は公開し直す）。
 */
export const sameValue = (left: string | null, right: string | null): boolean =>
  (left === null || right === null ? left === right : lineFeedForm(left) === lineFeedForm(right));

// ---------------------------------------------------------------------------------------------------------------
// OP-O（O1）: 書き込みの段で、確かめ・入力・押す操作が失敗したときの記録の形（値と、値の長さは持たない）。API の入力の部品（`api-write-submitter.ts`）と
// form の入力の部品（`write-form-submitter.ts`）が共用する。記録の契約（`src/control/actions/action-contracts.ts` の `WRITE_INPUT_FAILURE_*`）は control に
// あり、browser を読み込めないので、そこに書き写す（一致は `tests/unit/write-input-failure.test.ts`）。
// ---------------------------------------------------------------------------------------------------------------

/** 失敗した段（入力の前の確かめ、値の入力、押す操作）。 */
export const WRITE_INPUT_FAILURE_STAGES = Object.freeze(['INSPECT', 'FILL', 'SUBMIT'] as const);
export type WriteInputFailureStage = (typeof WRITE_INPUT_FAILURE_STAGES)[number];

/** 有無を記録する欄の属性（値は記録しない）。 */
export const WRITE_INPUT_FIELD_ATTRIBUTES = Object.freeze(['readonly', 'disabled', 'maxlength', 'pattern', 'min', 'max', 'step'] as const);
export type WriteInputFieldAttribute = (typeof WRITE_INPUT_FIELD_ATTRIBUTES)[number];

/**
 * 入れた値と読み直した値の、変わり方の区分（値は記録しない）。判定の順は一覧の順。
 * - `EMPTIED`: 空になった。`SURROUNDING_WHITESPACE`: 前後の空白だけが違う。`DIGIT_GROUPING`: 桁の区切り（`,`・空白など）だけが違う。
 * - `NUMBER_FORMAT`: 数として同じで、形だけが違う（先頭の 0、小数の末尾の 0、指数の表記など）。`OTHER`: そのほか。
 */
export const WRITE_INPUT_VALUE_CHANGES = Object.freeze(['EMPTIED', 'SURROUNDING_WHITESPACE', 'DIGIT_GROUPING', 'NUMBER_FORMAT', 'OTHER'] as const);
export type WriteInputValueChange = (typeof WRITE_INPUT_VALUE_CHANGES)[number];

/** 桁の区切りに使われる文字（`,`、全角の `，`、空白、ノーブレークスペース、細い空白、`'`、`_`）。 */
const DIGIT_GROUPING_CHARACTERS = /[,，\s  '_]/gu;
/** 10 進の数の形（符号、整数部か小数部、指数の表記）。 */
const DECIMAL_NUMBER_SHAPE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;
const DIGIT = /\d/u;

const numberOfText = (text: string): number | null => (DECIMAL_NUMBER_SHAPE.test(text) ? Number(text) : null);

/**
 * 入れた値（`expected`）から読み直した値（`actual`）への変わり方の区分（純粋。値は返さない）。改行の違い（CR LF・CR・LF）は、呼ぶ側の比べ（`sameValue`）が
 * 同じとみなすので、ここには来ない。
 */
export const valueChangeKindOf = (expected: string, actual: string): WriteInputValueChange => {
  if (actual === '' && expected !== '') {
    return 'EMPTIED';
  }
  if (actual.trim() === expected.trim()) {
    return 'SURROUNDING_WHITESPACE';
  }
  if (DIGIT.test(expected) && actual.replace(DIGIT_GROUPING_CHARACTERS, '') === expected.replace(DIGIT_GROUPING_CHARACTERS, '')) {
    return 'DIGIT_GROUPING';
  }
  const expectedNumber = numberOfText(expected.trim());
  const actualNumber = numberOfText(actual.trim());
  return expectedNumber !== null && actualNumber !== null && Number.isFinite(expectedNumber) && expectedNumber === actualNumber ? 'NUMBER_FORMAT' : 'OTHER';
};

/** 欄の事実（種類と属性の有無。値は持たない）。種類は、候補の欄の型の一覧（`CANDIDATE_FIELD_TYPES`）の値か、分からなければ null。 */
export interface WriteInputFieldFacts {
  readonly type: string | null;
  readonly attributes: readonly WriteInputFieldAttribute[] | null;
}

/**
 * 失敗の記録（値と、値の長さは持たない）。`reason` は、それぞれの部品の理由の語（`API_WRITE_INPUT_REASONS`・`WRITE_FORM_REASONS`）。
 * `fieldPosition` は、入れる欄の順（API は指定の `fields`、form は送る欄の名前）の 0 から。分からなければ null。
 */
export interface WriteInputFailure {
  readonly stage: WriteInputFailureStage;
  readonly reason: string;
  readonly fieldPosition: number | null;
  readonly fieldType: string | null;
  readonly fieldAttributes: readonly WriteInputFieldAttribute[] | null;
  readonly valueChange: WriteInputValueChange | null;
}

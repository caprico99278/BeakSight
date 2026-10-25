import { isNonNegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../core/guards.js';
import { saturatingIncrement } from '../core/saturating-count.js';
import { LOAD_PEAK_WINDOW_MS } from './load-meter.js';

/**
 * 承認したサービスの Origin への要求の上限を数える部品（T35b。Task 35 の設計書 3.4。この意味の owner）。実行ごとに 1 つを作り（T35c）、factory の指定
 * （`BrowserContextFactoryOptions.serviceRequestBudget`）で、どの役割の Context の Guard にも渡す（T35R-fix の C-1。幅の走査と Interaction の Context は
 * サービスの Origin へ送らないが、数える側にも置いて守りを重ねる。T44b: 送信の扱い `PASS_EXCEPT_DELETE` の幅の走査は送り、ここで数える）。Guard は、承認した
 * サービスの Origin への要求を、CDP の層で通す前に `tryConsume` で数える（送る前に数える）。
 * - T35R-fix（T35R の I-3。ユーザーの判断「1 回の Run で 600 件」）: `perRun` は Run の全体の上限。前の実行までに数えた数（`initialAdmitted`。保存から）
 *   から数える。直近の 1 分の窓は実行ごと（前の実行の時刻は持たない）。
 * - DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md` 2.2、2.3）: 断るのは、数えた要求が `perRun` に届いた後だけ（偽を返す。
 *   数えない）。Guard は、断った要求を `SERVICE_REQUEST_LIMIT_REACHED` で止めて記録する。1 分あたりの上限（`perMinute`）では断らない（ページの読み込みの
 *   途中で要求を断るのは、不自然な遮断になる）。代わりに、次の読み込みの前に待つ時間（`waitBeforeNextLoadMs`）を返す。
 * - 待つ時間: 直近の 1 分（`LOAD_PEAK_WINDOW_MS`。負荷の部品の 1 分あたりの最大と同じ窓）に数えた要求が `perMinute` 以上なら、窓の中の数が `perMinute`
 *   を下回るまで（新しい方から `perMinute` 番目の要求が 1 分を過ぎるまで。最大で 60 秒）。下回っていれば 0。
 * - 上限に届いたか（`isLimitReached`）: 断った要求があるか、`perRun` まで数えたか（次の要求を送れない）。Run が次のページを始めない判断に使う。
 * - 時計が戻った場合は、戻る前の最後の時刻に数えたものとして扱う（負荷の部品と同じ。持つ時刻を古い順に保つ）。待つ時間も、戻る前の最後の時刻から数える。
 * 上限の値の範囲（1〜600、1〜10,000。DEF-141）は、認証の設定の契約が確かめる（ここでは 1 以上の安全な整数だけを受ける）。
 */
export interface ServiceRequestBudget {
  /** 要求を 1 つ数える。`perRun` の中なら真（数えた）、`perRun` に届いていれば偽（断った。数えない）。 */
  tryConsume(): boolean;
  /** DEF-141: 次の読み込みを始める前に待つ時間（ms。0 以上 `LOAD_PEAK_WINDOW_MS` 以下の整数。待たなくてよければ 0）。 */
  waitBeforeNextLoadMs(): number;
  /** 上限に届いたか。 */
  isLimitReached(): boolean;
  /** 数えた要求の数、断った要求の数、上限に届いたか（JSON にできる、凍結した値）。 */
  snapshot(): ServiceRequestBudgetSnapshot;
  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: 直近の 1 分の窓に数えた要求の時刻（古い順。凍結した配列）。まとめて実行の
   * 次の段の部品に、`initialWindowTimesMs` で渡す（メモリの中だけ。成果物と保存に書かない）。
   */
  windowTimesMs(): readonly number[];
}

export interface ServiceRequestBudgetSnapshot {
  readonly admitted: number;
  readonly refused: number;
  readonly limitReached: boolean;
}

/** `createServiceRequestBudget` の入力。 */
export interface ServiceRequestBudgetOptions {
  /** 直近の 1 分あたりの上限（1 以上の安全な整数）。 */
  readonly perMinute: number;
  /** 1 回の Run あたりの上限（1 以上の安全な整数。T35R-fix: 再開をまたいで数える）。 */
  readonly perRun: number;
  /** 前の実行までに数えた要求の数（0 以上の安全な整数。省略は 0。T35R-fix）。 */
  readonly initialAdmitted?: number;
  /** 現在の時刻（エポックからの ms。0 以上の安全な整数）。 */
  readonly now: () => number;
  /**
   * FM2d: 前の段から持ち越す 1 分の窓の時刻（`windowTimesMs()` の値。古い順の 0 以上の安全な整数。省略は空）。窓の判定（待つ時間）には入れ、実行の上限
   * （`perRun`）には数えない（実行の上限は段ごと）。窓を出た時刻は、最初の判定で捨てる。
   */
  readonly initialWindowTimesMs?: readonly number[];
}

/** 持ち越す窓の時刻の形を確かめる（古い順の 0 以上の安全な整数）。 */
const carriedWindowTimesOf = (value: unknown): number[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError('ServiceRequestBudget initial window times must be an array');
  }
  const times: number[] = [];
  for (const time of value) {
    if (!isNonNegativeSafeInteger(time) || (times.length > 0 && time < (times[times.length - 1] ?? 0))) {
      throw new RangeError('ServiceRequestBudget initial window times must be non-negative safe integers in ascending order');
    }
    times.push(time);
  }
  return times;
};

/** `ServiceRequestBudget` を作る。上限が 1 以上の安全な整数でなければ `RangeError`、入力の形が違えば `TypeError`。 */
export function createServiceRequestBudget(options: ServiceRequestBudgetOptions): ServiceRequestBudget {
  if (!isRecord(options) || typeof options.now !== 'function') {
    throw new TypeError('ServiceRequestBudget requires limits and a current time function');
  }
  const { perMinute, perRun, now } = options;
  if (!isPositiveSafeInteger(perMinute) || !isPositiveSafeInteger(perRun)) {
    throw new RangeError('ServiceRequestBudget limits must be positive safe integers');
  }
  const initialAdmitted = options.initialAdmitted ?? 0;
  if (!isNonNegativeSafeInteger(initialAdmitted)) {
    throw new RangeError('ServiceRequestBudget initial admitted count must be a non-negative safe integer');
  }
  /**
   * 直近の 1 分に数えた要求の時刻（古い順。この実行の分だけ）。待つ時間に要るのは新しい方から `perMinute` 件だけなので、それより古いものは捨てる
   * （持つ数は `perMinute` 以下）。
   */
  // FM2d: 持ち越した窓は、新しい方から `perMinute` 件だけ持つ（持つ数の決まりは同じ）。最後の時刻は、時計が戻ったときの基準にする。
  const windowTimesMs: number[] = carriedWindowTimesOf(options.initialWindowTimesMs).slice(-perMinute);
  let admitted = initialAdmitted;
  let refused = 0;
  let lastTimeMs: number | null = windowTimesMs.length === 0 ? null : (windowTimesMs[windowTimesMs.length - 1] ?? null);

  /** 今の時刻（戻る前の最後の時刻より前には戻さない）を記録して返し、窓を出た時刻を捨てる。 */
  const advanceWindow = (): number => {
    const value = now();
    if (!isNonNegativeSafeInteger(value)) {
      throw new RangeError('ServiceRequestBudget current time must be a non-negative safe integer of milliseconds');
    }
    const nowMs = lastTimeMs === null ? value : Math.max(value, lastTimeMs);
    lastTimeMs = nowMs;
    while (windowTimesMs.length > 0 && nowMs - (windowTimesMs[0] ?? nowMs) >= LOAD_PEAK_WINDOW_MS) {
      windowTimesMs.shift();
    }
    return nowMs;
  };

  return Object.freeze({
    tryConsume(): boolean {
      const nowMs = advanceWindow();
      if (admitted >= perRun) {
        refused = saturatingIncrement(refused);
        return false;
      }
      windowTimesMs.push(nowMs);
      if (windowTimesMs.length > perMinute) {
        windowTimesMs.shift();
      }
      admitted += 1;
      return true;
    },
    waitBeforeNextLoadMs(): number {
      const nowMs = advanceWindow();
      const oldest = windowTimesMs[0];
      // 持つ数は `perMinute` 以下なので、`perMinute` 件あれば、最も古いもの（新しい方から `perMinute` 番目）が窓を出るまで待つ。
      return windowTimesMs.length < perMinute || oldest === undefined ? 0 : oldest + LOAD_PEAK_WINDOW_MS - nowMs;
    },
    isLimitReached(): boolean {
      return refused > 0 || admitted >= perRun;
    },
    snapshot(): ServiceRequestBudgetSnapshot {
      return Object.freeze({ admitted, refused, limitReached: refused > 0 || admitted >= perRun });
    },
    windowTimesMs(): readonly number[] {
      advanceWindow();
      return Object.freeze([...windowTimesMs]);
    },
  });
}

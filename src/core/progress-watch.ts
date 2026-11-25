// L0 進みの見張り（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1・6 の L0。作業記録の INV-LIMITS の「大事な点」2）。
// 段（読み込み・収集・押下・落ち着きの待ちなど）を包み、進みの印を受ける、唯一の部品。期限の代わりに「全く反応がない」ときだけ段を終える。
// - 進みの印は 2 つに分ける（閉じた一覧 `PROGRESS_SIGNAL_KINDS`）。
//   - 段の中身の進み（`CONTENT_PROGRESS_SIGNAL_KINDS`）: ブラウザからの応答（CDP・Playwright の呼び出しが返った。`track`）と、分けて読む回が
//     進んだ（`readInParts` の 1 回。`withReadPartSignals`）。落ち着きの待ちのように同じ読み取りを繰り返す段は、新しい値を読んだときだけ印を付ける
//     （周期的な変化は進みと見なさない）。
//   - ページの自発の変化: ページの通信（要求・応答）と、画面の変化（DOM の変化）。印は `src/browser/page-progress-signals.ts` が付ける。
// - 最後の中身の進みから、反応なしの長さ（`PROGRESS_WATCH_QUIET_LIMIT_MS`）が過ぎたら、段を終える。その間に印が 1 つもなければ「応答しなかった」
//   （`STAGE_UNRESPONSIVE`）、ページの自発の変化が窓の後半にも続いていれば「静まらない」（`STAGE_NEVER_QUIET`。QUIET-2）。進みが続く間は、何分でも待つ。
// - Run の時間の上限（利用者の `maxRuntimeMs`。`runDeadlineAtMs`）は、指定したときだけ、段の途中でも効かせる（`RUN_TIME_LIMIT`）。
// - 終えた段の処理は待たない（見放す）。段には `signal`（終えたら abort）を渡すので、段は繰り返しを止められる。段がそれまでに集めた記録は、段が
//   呼び出し側の入れ物に入れておけば残る。見放した処理の、遅れて返る値や reject は封じ込める（`awaitBeforeDeadline` と同じ）。
// - この見張りは BeakSight 自身の処理の守り（INV-LIMITS の表 D）で、網羅の上限ではない。
import { collectorIncompleteReason } from './status.js';
import { resolveTimeoutMs } from './deadline.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from './observation-windows.js';
import type { IncompleteReason, IncompleteReasonCode, PageAuditStage } from './contracts.js';

/**
 * 反応なしの長さ（ms）。最後の中身の進みから、この長さの間に中身の進みがなければ段を終える。
 * 3 分にした理由: ブラウザの 1 回の呼び出し（大きな DOM の axe・layout の走査など、分けて読めない読み取り）は、その間ページの main thread を使い、
 * 外から見ると固まったページと区別できない。1 回の呼び出しが数十秒かかるページでも見放さないよう、数十秒より十分に長くする。固まったページで待つのは
 * 1 段あたりこの長さだけで、Run は次の段・次のページへ進む。RB-2: 値は観察の窓の一式（`watch.quietLimitMs`）の本番の値。
 */
export const PROGRESS_WATCH_QUIET_LIMIT_MS = PRODUCTION_OBSERVATION_WINDOWS.watch.quietLimitMs;

/** 進みの印の閉じた一覧。 */
export const PROGRESS_SIGNAL_KINDS = Object.freeze(['BROWSER_RESPONSE', 'READ_PART', 'PAGE_NETWORK', 'DOM_CHANGE'] as const);
export type ProgressSignalKind = (typeof PROGRESS_SIGNAL_KINDS)[number];

/** 段の中身の進みの印（ほかはページの自発の変化）。 */
export const CONTENT_PROGRESS_SIGNAL_KINDS: readonly ProgressSignalKind[] = Object.freeze(['BROWSER_RESPONSE', 'READ_PART']);

/** 見張りが段を終える理由（`RUN_TIME_LIMIT` は Run の時間の上限）。 */
export type ProgressWatchEnd = 'STAGE_UNRESPONSIVE' | 'STAGE_NEVER_QUIET' | 'RUN_TIME_LIMIT';

/** 応答しなかった段・静まらなかった段の、未完了の理由のコード（閉じた一覧。`INCOMPLETE_REASON_CODES` にある）。 */
export const PROGRESS_WATCH_END_REASON_CODES = Object.freeze(['STAGE_UNRESPONSIVE', 'STAGE_NEVER_QUIET'] as const) satisfies readonly IncompleteReasonCode[];

/** Run の時間の上限で終えた段の理由（`COLLECTOR_INCOMPLETE` の `<段>:<これ>`）。 */
const RUN_TIME_LIMIT_STAGE_REASON: Extract<IncompleteReasonCode, 'MAX_RUNTIME_REACHED'> = 'MAX_RUNTIME_REACHED';

/** 段に渡す、進みの印の口。 */
export interface ProgressSignals {
  /** 見張りが段を終えたら abort する（段は繰り返しを止める）。 */
  readonly signal: AbortSignal;
  /** 進みの印を付ける。 */
  mark(kind: ProgressSignalKind): void;
  /** ブラウザの呼び出しを待ち、返ったら（成功でも失敗でも）ブラウザからの応答の印を付ける。値と reject はそのまま返す。 */
  track<T>(call: PromiseLike<T>): Promise<T>;
  /**
   * REV-DQF の Important-B: 見張りが段を終えるまでの残りの長さ（ms。最後の中身の進みから、反応なしの長さまで）。段が、自分で待ちを切り上げてから終えられる
   * ように読む（見張りに終えられると、それまでの読み取りの記録が残らない）。省略できる（見張りでない口）。
   */
  remainingMs?(): number;
}

export interface ProgressWatchOptions {
  /** 反応なしの長さ（ms。正の安全な整数）。省略すると `PROGRESS_WATCH_QUIET_LIMIT_MS`。 */
  readonly quietLimitMs?: number | undefined;
  /** Run の時間の上限の時刻（`Date.now()` と同じ基準）。`null`・省略は上限なし（利用者が指定したときだけ効く）。 */
  readonly runDeadlineAtMs?: number | null | undefined;
  /** 今の時刻（省略すると `Date.now()`）。 */
  readonly now?: (() => number) | undefined;
  /**
   * L1: 中身の進みに数える印（省略すると `CONTENT_PROGRESS_SIGNAL_KINDS`）。読み込み（goto）の段は、通信と画面の変化そのものが進みなので、全部の印
   * （`PROGRESS_SIGNAL_KINDS`）を渡す（通信の続く遅い読み込みを見放さない）。
   */
  readonly contentKinds?: readonly ProgressSignalKind[] | undefined;
}

/** 見張った段の結果（例外を投げない）。 */
export type WatchedOutcome<T> =
  | Readonly<{ status: 'FULFILLED'; value: T }>
  | Readonly<{ status: 'REJECTED'; reason: unknown }>
  | Readonly<{ status: 'ENDED'; end: ProgressWatchEnd }>;

/**
 * `work` を見張りながら待つ。`work` には進みの印の口を渡す。進みが続く間は終わりを待ち、反応がなくなったら（または Run の時間の上限で）段を終える。
 */
export async function watchProgress<T>(
  work: (signals: ProgressSignals) => PromiseLike<T>,
  options: ProgressWatchOptions = {},
): Promise<WatchedOutcome<T>> {
  const quietLimitMs = resolveTimeoutMs(options.quietLimitMs, PROGRESS_WATCH_QUIET_LIMIT_MS);
  const now = options.now ?? ((): number => Date.now());
  const runDeadlineAtMs = options.runDeadlineAtMs ?? null;
  const contentKinds = options.contentKinds ?? CONTENT_PROGRESS_SIGNAL_KINDS;
  const controller = new AbortController();
  const startedAtMs = now();
  let lastContentAtMs = startedAtMs;
  let lastAnyAtMs = startedAtMs;
  const mark = (kind: ProgressSignalKind): void => {
    if (controller.signal.aborted) {
      return;
    }
    const at = now();
    lastAnyAtMs = Math.max(lastAnyAtMs, at);
    if (contentKinds.includes(kind)) {
      lastContentAtMs = Math.max(lastContentAtMs, at);
    }
  };
  const signals: ProgressSignals = Object.freeze({
    signal: controller.signal,
    mark,
    track: <U>(call: PromiseLike<U>): Promise<U> => Promise.resolve(call).finally(() => mark('BROWSER_RESPONSE')),
    remainingMs: (): number => Math.min(lastContentAtMs + quietLimitMs, runDeadlineAtMs ?? Number.POSITIVE_INFINITY) - now(),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  // L1b: 見張りが段を終えた理由（`signal` の abort の理由にする。段が、それまでの記録に理由を付けて返せるように）。
  let endedWith: ProgressWatchEnd | undefined;
  const ended = new Promise<WatchedOutcome<T>>((resolve) => {
    const check = (): void => {
      const at = now();
      if (runDeadlineAtMs !== null && at >= runDeadlineAtMs) {
        endedWith = 'RUN_TIME_LIMIT';
        resolve(Object.freeze({ status: 'ENDED', end: 'RUN_TIME_LIMIT' }));
        return;
      }
      if (at - lastContentAtMs >= quietLimitMs) {
        // 中身の進みがない。QUIET-2（設計書 `2026-11-24-beaksight-discovery-stuck-step-design.md` 2.2）: ページの自発の変化が窓の後半にも続いていれば
        // 「静まらない」、窓の後半になければ「応答しなかった」（最後の中身の進みの直後に 1 回だけ付いた印では、静まらないとしない）。
        const end: ProgressWatchEnd = at - lastAnyAtMs >= quietLimitMs / 2 ? 'STAGE_UNRESPONSIVE' : 'STAGE_NEVER_QUIET';
        endedWith = end;
        resolve(Object.freeze({ status: 'ENDED', end }));
        return;
      }
      const nextAtMs = Math.min(lastContentAtMs + quietLimitMs, runDeadlineAtMs ?? Number.POSITIVE_INFINITY);
      timer = setTimeout(check, Math.max(0, nextAtMs - at));
    };
    check();
  });

  let running: Promise<WatchedOutcome<T>>;
  try {
    running = Promise.resolve(work(signals)).then<WatchedOutcome<T>, WatchedOutcome<T>>(
      (value) => Object.freeze({ status: 'FULFILLED', value }),
      (reason: unknown) => Object.freeze({ status: 'REJECTED', reason }),
    );
  } catch (reason) {
    running = Promise.resolve(Object.freeze({ status: 'REJECTED', reason }));
  }
  try {
    return await Promise.race([running, ended]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // L1b: 見張りが終えたときは、その理由（`ProgressWatchEnd`）を abort の理由にする（段が終わったときは理由なし）。
    controller.abort(endedWith);
  }
}

/**
 * L1b: 見張りの `signal` の abort の理由から、見張りが段を終えた理由を読む（`watchProgress` が終えたときだけ。段が終わった後の abort や、ほかの
 * abort は `null`）。
 */
export const progressWatchEndOf = (signal: AbortSignal): ProgressWatchEnd | null => {
  const reason: unknown = signal.aborted ? signal.reason : undefined;
  return reason === 'STAGE_UNRESPONSIVE' || reason === 'STAGE_NEVER_QUIET' || reason === 'RUN_TIME_LIMIT' ? reason : null;
}

/** 分けて読む 1 回（`readInParts` の `readPart`）を包み、読み終えるたびに分けて読む回の印を付ける。 */
export const withReadPartSignals = <C, R>(
  readPart: (cursor: C) => Promise<R>,
  signals: Pick<ProgressSignals, 'mark'>,
): ((cursor: C) => Promise<R>) =>
  async (cursor) => {
    const read = await readPart(cursor);
    signals.mark('READ_PART');
    return read;
  };

/**
 * 見張りが終えた段の、未完了の理由（凍結）。応答しなかった段・静まらなかった段は閉じた一覧の理由（`detail` は段の名前）、Run の時間の上限は
 * 段の理由 `COLLECTOR_INCOMPLETE`（`<段>:MAX_RUNTIME_REACHED`）。
 */
export const progressWatchEndReason = (stage: PageAuditStage, end: ProgressWatchEnd): IncompleteReason =>
  end === 'RUN_TIME_LIMIT'
    ? collectorIncompleteReason(stage, RUN_TIME_LIMIT_STAGE_REASON)
    : Object.freeze({ code: end, detail: stage });

// L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1、6 の L3・L6）: 操作さがしの 1 画面の見張り。ブラウザの部品
// （`tests/architecture/discovery-boundary.test.ts` の `BROWSER_DISCOVERY_FILES`）。
// - 1 画面の発見と押す輪を、1 つの進みの見張り（L0 の `watchProgress`）で包む（`watchDiscoveryScreen`）。ページの通信と画面の変化の印は
//   `attachPageProgressSignals` が付ける。
// - 見張りの口は、page ごとに置く（`screenWatchOf`）。この画面の中の読み取りと押す操作（isolated world の読み取り・JS の結び付きの読み取り・Playwright の
//   1 手）は、口があれば `trackOnScreen` を通す（ブラウザからの応答を進みとみなす）。口を多くの関数の引数に回さないため、page を鍵にする。
// - 入れ子の部品（`watchedPageRead`・選んだ後の落ち着きの待ち）は、口があれば自分では見張らず、その口を使う。
// - 見張りが画面を終えたら（全く反応がない・静まらない）、口の `signal` は abort する。見放した処理は、`screenWatchEnded` を見て、押す前に止まる。
//   page に残る口は終えたままにする（見放した処理が、後から押さないように）。
// この見張りは BeakSight 自身の処理の守りで、網羅の上限ではない。
// - ページの画面の変化の見回り（`attachPageProgressSignals` の isolated world の読み取り）は、BeakSight の段の中身の進みではない。見回りの読み取りは
//   `pageChangePollerReads` の中で動かし、CDP の命令の印（`cdp-session.ts`）を付けない（付けると、見回りが続くだけで画面を終えず、押す 1 手が返らない
//   ときに待ち続ける）。
// DTIME: 1 画面の時間の内訳を測る口（`PageTimeRecorder`）も、page ごとに置く（`attachScreenTiming`。深い部品は `timedOnScreen` で待ちを測る。口がなければ、
// そのまま待つ）。見張りが画面を終えたら、最後の中身の進みから終わりまでを、見張りの終わりで失った時間にする。
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Page } from 'playwright';
import { attachPageProgressSignals } from '../browser/page-progress-signals.js';
import { CONTENT_PROGRESS_SIGNAL_KINDS, watchProgress, type ProgressSignals, type WatchedOutcome } from '../core/progress-watch.js';
import type { PageTimePart, PageTimeRecorder, ScreenNote } from './page-time-breakdown.js';

const screenWatches = new WeakMap<Page, ProgressSignals>();
/** DTIME: page ごとの、1 画面の時間の内訳を測る口。 */
const screenTimings = new WeakMap<Page, PageTimeRecorder>();

/** DTIME: この page に、時間の内訳を測る口を置く（返す関数で外す）。 */
export const attachScreenTiming = (page: Page, timing: PageTimeRecorder): (() => void) => {
  screenTimings.set(page, timing);
  return () => {
    if (screenTimings.get(page) === timing) screenTimings.delete(page);
  };
};

/** DTIME: この page の口があれば、`work` を区分 `part` として測る（値と例外はそのまま。口がなければ、そのまま待つ）。 */
export const timedOnScreen = <T>(page: Page, part: PageTimePart, work: () => PromiseLike<T>, timedOut?: (value: T) => boolean): Promise<T> => {
  const timing = screenTimings.get(page);
  return timing === undefined ? Promise.resolve(work()) : timing.measure(part, work, timedOut);
};

/**
 * DBG-1: この page の口があれば、押下の 1 つの点（押下・状態の作り直し・読み直し）を測りの記録にだけ足す（口は測りの記録が入のときだけ置かれる。なければ、
 * そのまま待つ）。
 */
export const pointOnScreen = <T>(page: Page, point: Parameters<PageTimeRecorder['point']>[0], work: () => PromiseLike<T>): Promise<T> => {
  const timing = screenTimings.get(page);
  return timing === undefined ? Promise.resolve(work()) : timing.point(point, work);
};

/**
 * SLIM（DBG-1。設計書 `2026-11-25-beaksight-discovery-input-check-slim-design.md` 2.3）: この page に、記録だけ足す口があるか（測りの記録が入のときだけ真）。
 * 偽なら、呼ぶ側は時計も読まず、記録の材料も集めない（DBG-1 の切の決まり）。
 */
export const notingOnScreen = (page: Page): boolean => screenTimings.get(page)?.noting === true;

/**
 * SLIM（DBG-1）: この page の口があれば、測りの記録にだけ 1 行足す（唯一の口。PREADY の `DISCOVERY_READINESS`、SLIM の `DISCOVERY_PRESS_REACTION`・
 * `DISCOVERY_INPUT_CHECK`、QUIET-4 の見張りの終わり。口がなければ何もしない）。
 */
export const noteOnScreen = (page: Page, entry: ScreenNote): void => {
  screenTimings.get(page)?.note(entry);
};

/** QUIET-4: 待っている 1 手の操作と役割（閉じた一覧。測りの記録の語）。 */
export const PENDING_STEP_ACTIONS = Object.freeze(['fill', 'inputValue', 'isDisabled', 'click', 'selectOption'] as const);
export const PENDING_STEP_ROLES = Object.freeze(['FIELD', 'SUBMITTER', 'OPTION'] as const);

/** QUIET-4: 待っている 1 手の印（`locatorCount` は、見張りが画面を終えた時点の locator の数を読む）。 */
export interface PendingStep {
  readonly action: (typeof PENDING_STEP_ACTIONS)[number];
  readonly role: (typeof PENDING_STEP_ROLES)[number];
  readonly locatorCount: () => Promise<number>;
}

/** QUIET-4: page ごとの、待っている 1 手（測りの記録が入のときだけ置く）。 */
const pendingSteps = new WeakMap<Page, Set<PendingStep & { readonly startedAt: number }>>();

/**
 * QUIET-4: 期限なしの 1 手（`work`）を、待つ間だけ、待っている 1 手として置く（測りの記録が入のときだけ。値と例外はそのまま返す）。見張りが画面を終えたときに、
 * まだ待っていれば、その操作と役割と locator の数を測りの記録に書く。
 */
export const pendingStepOnScreen = <T>(page: Page, step: PendingStep, work: PromiseLike<T>): Promise<T> => {
  if (!screenTimings.has(page)) return Promise.resolve(work);
  let steps = pendingSteps.get(page);
  if (steps === undefined) {
    steps = new Set();
    pendingSteps.set(page, steps);
  }
  const entry = { ...step, startedAt: Date.now() };
  const held = steps;
  held.add(entry);
  return Promise.resolve(work).finally(() => held.delete(entry));
};

/** QUIET-4: 1 画面の見張りの、最後の中身の進みと最後のページの印（測りの記録が入のときだけ数える）。 */
interface ScreenSignalFacts {
  lastContentAt: number;
  lastPageSignal: { readonly kind: string; readonly at: number } | null;
}

/** DTIME: 見張りの口を包み、中身の進み（ブラウザからの応答・分けて読む回）を、時間の内訳の口にも知らせる。 */
const withTimingProgress = (signals: ProgressSignals, timing: PageTimeRecorder | undefined, facts: ScreenSignalFacts): ProgressSignals => {
  if (timing === undefined) return signals;
  const note = (): void => {
    if (!signals.signal.aborted) {
      timing.noteProgress();
      facts.lastContentAt = Date.now();
    }
  };
  return Object.freeze({
    signal: signals.signal,
    mark: (kind: Parameters<ProgressSignals['mark']>[0]): void => {
      if (CONTENT_PROGRESS_SIGNAL_KINDS.includes(kind)) {
        note();
      } else if (!signals.signal.aborted) {
        facts.lastPageSignal = { kind, at: Date.now() };
      }
      signals.mark(kind);
    },
    track: <U>(call: PromiseLike<U>): Promise<U> => signals.track(call).finally(note),
    ...(signals.remainingMs === undefined ? {} : { remainingMs: (): number => signals.remainingMs?.() ?? 0 }),
  });
};
/** 1 画面の見張りの反応なしの長さ（指定したときだけ。子の見張り（落ち着きの待ち）に同じ長さを渡す）。 */
const screenWatchQuietLimits = new WeakMap<Page, number>();

/** この page の 1 画面の見張りの反応なしの長さ（見張りの外か、指定がなければ `undefined`。`undefined` は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。 */
export const screenWatchQuietLimitOf = (page: Page): number | undefined => screenWatches.has(page) ? screenWatchQuietLimits.get(page) : undefined;

/** 画面の変化の見回りの読み取り（この中で始めた非同期の処理は、BeakSight の段の進みに数えない）。 */
const pageChangePollerReads = new AsyncLocalStorage<true>();

/** この page の 1 画面の見張りの口（見張りの外なら `undefined`）。 */
export const screenWatchOf = (page: Page): ProgressSignals | undefined => screenWatches.get(page);

/**
 * CDP の命令の印を付ける、この page の見張りの口（見張りの外か、画面の変化の見回りの読み取りの中なら `undefined`）。`cdp-session.ts` だけが使う。
 */
export const screenWatchForBrowserResponses = (page: Page): ProgressSignals | undefined =>
  pageChangePollerReads.getStore() === true ? undefined : screenWatches.get(page);

/**
 * REV-DQF の Important-1: 返らない 1 手を待つ間の確かめの読み取り（的の要素が別の要素に替わったか）を、段の中身の進みに数えずに動かす（数えると、確かめが
 * 続くだけで見張りが画面を終えない）。画面の変化の見回りと同じ扱い。
 */
export const untrackedOnScreen = <T>(read: () => Promise<T>): Promise<T> => pageChangePollerReads.run(true, read);

/** この page の 1 画面の見張りが、画面を終えたか（見張りの外なら偽）。 */
export const screenWatchEnded = (page: Page): boolean => screenWatches.get(page)?.signal.aborted === true;

/** ブラウザの呼び出しを、この page の見張りの口があれば `track` に通す（返ったら進みの印）。口がなければ、そのまま待つ。 */
export const trackOnScreen = <T>(page: Page, call: PromiseLike<T>): Promise<T> => {
  const signals = screenWatches.get(page);
  return signals === undefined ? Promise.resolve(call) : signals.track(call);
};

/** 1 画面の見張りの指定（テストが反応なしの長さを短くする。省略は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。 */
export interface ScreenWatchOptions {
  readonly quietLimitMs?: number | undefined;
}

/**
 * 1 画面の発見と押す輪（`work`）を、1 つの進みの見張りで包む（例外を投げない。結果は `watchProgress` の形）。見張りの間、page に口を置く。
 */
export async function watchDiscoveryScreen<T>(
  page: Page,
  work: (signals: ProgressSignals) => Promise<T>,
  options: ScreenWatchOptions = {},
): Promise<WatchedOutcome<T>> {
  const timing = screenTimings.get(page);
  const facts: ScreenSignalFacts = { lastContentAt: Date.now(), lastPageSignal: null };
  const watched = await watchProgress(async (watchSignals) => {
    // DTIME: 中身の進みを、時間の内訳の口にも知らせる（口がなければ、今の口のまま）。
    const signals = withTimingProgress(watchSignals, timing, facts);
    // 見張りが画面を終えたら（abort）、印の受け口は `attachPageProgressSignals` が自分で外す。
    const detach = pageChangePollerReads.run(true, () => attachPageProgressSignals(page, signals));
    screenWatches.set(page, signals);
    if (options.quietLimitMs === undefined) {
      screenWatchQuietLimits.delete(page);
    } else {
      screenWatchQuietLimits.set(page, options.quietLimitMs);
    }
    try {
      return await work(signals);
    } finally {
      detach();
      // 画面を終えずに終わったときだけ口を外す（終えたときは、見放した処理が後から押さないように、終えた口を残す）。
      if (!signals.signal.aborted && screenWatches.get(page) === signals) screenWatches.delete(page);
    }
  }, { quietLimitMs: options.quietLimitMs });
  // DTIME: 見張りが画面を終えたら、最後の中身の進みから終わりまでを、見張りの終わりで失った時間にする。
  if (watched.status === 'ENDED' && timing !== undefined) {
    timing.endStage();
    noteStageEndOf(page, timing, watched.end, facts);
  }
  return watched;
}

/**
 * QUIET-4: 見張りが画面を終えた事実を、測りの記録に書く（終わりの理由と、最後の中身の進み・ページの印からの長さは、すぐ。待っていた 1 手は、locator の数を
 * 読んでから。読めない数は書かない。待たずに戻る）。
 */
const noteStageEndOf = (page: Page, timing: PageTimeRecorder, end: string, facts: ScreenSignalFacts): void => {
  const at = Date.now();
  const steps = [...(pendingSteps.get(page) ?? [])];
  pendingSteps.delete(page);
  timing.note({
    point: 'DISCOVERY_STAGE_END', part: `${end}:${facts.lastPageSignal?.kind ?? 'NONE'}`,
    counts: { sinceContentMs: at - facts.lastContentAt, ...(facts.lastPageSignal === null ? {} : { sincePageSignalMs: at - facts.lastPageSignal.at }) },
  });
  if (steps.length === 0) return;
  void Promise.all(steps.map(async (step) => {
    const locatorCount = await step.locatorCount().catch(() => null);
    timing.note({
      point: 'DISCOVERY_PENDING_STEP', part: `${step.action}:${step.role}`,
      counts: { waitedMs: at - step.startedAt, ...(locatorCount === null ? {} : { locatorCount }) },
    });
  }));
};

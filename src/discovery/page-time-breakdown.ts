// DTIME（2026-11-20 の設計者の指示）: 操作さがしの 1 画面の時間の内訳（純粋。ページを操作しない・読まない）。
// - 測るだけで、振る舞いと待ちの長さを変えない。時計は呼ぶ側が差し込む（`DiscoveryRunRequest.now`。テストは偽の時計を入れる）。秒の値を持たない。
// - 区分ごとの時間は、いちばん外の 1 つの測りだけに数える（入れ子の測りの時間は、外の区分に入る）。区分の時間は重ならないので、足し合わせは全体を超えない。
//   全体から区分の和を引いた残りが「そのほか」。数（読み込み・押下・準備の確かめの「だめ」）は、入れ子でも数える。
// - 見張りが画面を終えた（`STAGE_*`）ときは、最後の中身の進みから終わりまでを「見張りの終わりで失った時間」に数え、その画面の見放した処理の測りは数えない。
// - 記録の形は成果物（`discovery.json` の読んだ画面の `timeBreakdown`）の形。数は ms と回数だけ（URL・値を持たない）。
// - DBG-1（設計書 `2026-11-20-beaksight-discovery-skip-and-debug-timing-design.md` 2.2）: この口は、測りの記録（`src/core/debug-timing.ts`）が入のときだけ作る
//   （切なら作らず、`timeBreakdown` も書かない）。入なら、測りの記録にも行を足す（`PageTimeDebug`）。
import type { DebugTimingLog, DebugTimingPoint } from '../core/debug-timing.js';

/** 測る区分の閉じた一覧（時間を数える区分）。 */
export const PAGE_TIME_PARTS = Object.freeze([
  /** 読み込みの間隔の待ち（`NavigationPacer`。閉じる前に画面を見せたまま待つ分を含む）。 */
  'PACING_WAIT',
  /** 読み込みそのもの（初回・読み込み直し・凍結の中のたどりの読み込み）。 */
  'LOAD',
  /** 落ち着きの待ち（発見の落ち着き・欄に入れた後の落ち着き）。 */
  'SETTLE',
  /** 押下ごとの見届けの窓（押した後の最短の観察と落ち着き）。 */
  'AFTER_PRESS_WINDOW',
  /** 押す前の準備の確かめ。 */
  'PRESS_READINESS',
  /** 選択肢の確かめ・打つだけの欄・検索のきっかけの記録。 */
  'INPUT_CHECKS',
] as const);
export type PageTimePart = (typeof PAGE_TIME_PARTS)[number];

/** 1 画面の時間の内訳（ms と回数。成果物の形）。区分の時間と `stageEndMs`・`otherMs` の和が `totalMs`。 */
export interface DiscoveryPageTimeBreakdown {
  /** 画面全体（読み始めから記録まで）。 */
  readonly totalMs: number;
  readonly pacingWaitMs: number;
  readonly loadMs: number;
  /** 読み込みの回数（初回・読み込み直し・凍結の中のたどりの読み込み）。 */
  readonly loads: number;
  /** 残りの候補を押すための読み込み直しの回数。 */
  readonly reloads: number;
  readonly settleMs: number;
  readonly afterPressWindowMs: number;
  /** 見届けの窓を待った押下の数。 */
  readonly presses: number;
  readonly pressReadinessMs: number;
  /** 準備の確かめが窓の長さまで待って済まなかった数。 */
  readonly pressReadinessTimeouts: number;
  readonly inputChecksMs: number;
  /** 見張りが画面を終えた（`STAGE_*`）ときに、最後の中身の進みから終わりまでに失った時間。 */
  readonly stageEndMs: number;
  /** そのほか（全体から上の時間を引いた残り）。 */
  readonly otherMs: number;
}

/**
 * DBG-1（設計書 `2026-11-20-beaksight-discovery-skip-and-debug-timing-design.md` 2.2）: 測りの記録の口と、この画面の状態の ID（記録の画面の印）。口を渡すと、区分の
 * 測りごと（`DISCOVERY_PART`）・押下の点ごと（`point`）・締めた内訳（`DISCOVERY_PAGE`）を、測りの記録にも足す。この口（と内訳の口そのもの）は、測りの記録が入の
 * ときだけ作る（呼ぶ側の `discovery-run.ts`）。
 */
export interface PageTimeDebug {
  readonly log: DebugTimingLog;
  readonly stateId: string;
}

/** 1 画面（待ち行列の 1 つの状態）の時間を測る口。 */
export interface PageTimeRecorder {
  /** DBG-1: 押下の 1 つの点（押下・状態の作り直し・読み直し）を、測りの記録にだけ足す（内訳は変えない。値と例外はそのまま返す）。 */
  point<T>(point: Extract<DebugTimingPoint, 'PRESS' | 'STATE_REBUILD' | 'REREAD'>, work: () => PromiseLike<T>): Promise<T>;
  /** `work` を区分 `part` として測る（値と例外はそのまま返す）。`timedOut` は、準備の確かめが窓の長さまで待って済まなかったかを値から決める。 */
  measure<T>(part: PageTimePart, work: () => PromiseLike<T>, timedOut?: (value: T) => boolean): Promise<T>;
  /** 中身の進み（ブラウザからの応答・分けて読む回）を見た（見張りの終わりで失った時間の起点）。 */
  noteProgress(): void;
  /** 見張りがこの画面を終えた（それより前の進みから今までを失った時間にし、見放した処理の測りを数えない）。 */
  endStage(): void;
  /** SLIM: 記録だけ足す口があるか（測りの記録の口を受けて作ったときだけ真。偽なら `note` は何もしない）。 */
  readonly noting: boolean;
  /**
   * SLIM（設計書 `2026-11-25-beaksight-discovery-input-check-slim-design.md` 2.3）: 測りの記録にだけ 1 行足す唯一の口（この画面の状態の ID を付ける。内訳は
   * 変えない）。QUIET-4 の見張りの終わり・待っていた 1 手、PREADY の準備の確かめ、SLIM の押した後の反応・入力の確かめが使う。
   */
  note(entry: ScreenNote): void;
  /** 残りの候補を押すために読み込み直した。 */
  countReload(): void;
  /** 記録を締める（締めた後の測りは数えない）。 */
  finish(): DiscoveryPageTimeBreakdown;
}

/** SLIM: 記録だけ足す点（内訳を変えない点の閉じた一覧）。 */
export type ScreenNotePoint = Extract<DebugTimingPoint,
  'DISCOVERY_STAGE_END' | 'DISCOVERY_PENDING_STEP' | 'DISCOVERY_READINESS' | 'DISCOVERY_PRESS_REACTION' | 'DISCOVERY_INPUT_CHECK'>;

/** SLIM: 記録だけ足す 1 行（`part` は閉じた語を `:` でつないだもの。`counts` は数だけ。URL・値は持たない）。 */
export interface ScreenNote {
  readonly point: ScreenNotePoint;
  readonly part: string;
  readonly counts: Readonly<Record<string, number>>;
}

type Counts = { -readonly [K in keyof DiscoveryPageTimeBreakdown]: number };

const MS_KEYS: Readonly<Record<PageTimePart, 'pacingWaitMs' | 'loadMs' | 'settleMs' | 'afterPressWindowMs' | 'pressReadinessMs' | 'inputChecksMs'>> = Object.freeze({
  PACING_WAIT: 'pacingWaitMs',
  LOAD: 'loadMs',
  SETTLE: 'settleMs',
  AFTER_PRESS_WINDOW: 'afterPressWindowMs',
  PRESS_READINESS: 'pressReadinessMs',
  INPUT_CHECKS: 'inputChecksMs',
});

/** 1 画面の時間を測る口を作る（`now` は差し込める時計。`debug` は測りの記録の口。DBG-1）。 */
export function createPageTimeRecorder(now: () => number, debug: PageTimeDebug | null = null): PageTimeRecorder {
  const startedAt = now();
  const totals: Counts = {
    totalMs: 0, pacingWaitMs: 0, loadMs: 0, loads: 0, reloads: 0, settleMs: 0, afterPressWindowMs: 0, presses: 0,
    pressReadinessMs: 0, pressReadinessTimeouts: 0, inputChecksMs: 0, stageEndMs: 0, otherMs: 0,
  };
  let finished = false;
  /** 見張りが画面を終えるたびに進める（前の世代の見放した測りを数えない）。 */
  let generation = 0;
  /** 今の世代の入れ子の深さと、いちばん外の測り（時間を数えるもの）。 */
  let depth = 0;
  let open: { readonly part: PageTimePart; readonly startAt: number } | null = null;
  /** 最後に締めた区分の終わりと、最後の中身の進み。 */
  let lastClosedAt = startedAt;
  let lastProgressAt = startedAt;

  const counted = (): boolean => !finished;
  const add = (part: PageTimePart, ms: number): void => {
    totals[MS_KEYS[part]] += Math.max(0, ms);
  };

  /** DBG-1: 区分の測りごとの 1 行（入れ子も 1 行ずつ）。 */
  const debugPart = <T>(part: PageTimePart, work: () => PromiseLike<T>): (() => PromiseLike<T>) => (debug === null
    ? work
    : () => debug.log.measure('DISCOVERY_PART', () => ({ stateId: debug.stateId, part }), work));

  return {
    point<T>(point: Extract<DebugTimingPoint, 'PRESS' | 'STATE_REBUILD' | 'REREAD'>, work: () => PromiseLike<T>): Promise<T> {
      return debug === null ? Promise.resolve(work()) : debug.log.measure(point, () => ({ stateId: debug.stateId }), work);
    },
    async measure<T>(part: PageTimePart, measured: () => PromiseLike<T>, timedOut?: (value: T) => boolean): Promise<T> {
      const work = debugPart(part, measured);
      if (!counted()) return work();
      const myGeneration = generation;
      depth += 1;
      const segment = depth === 1 && open === null ? { part, startAt: now() } : null;
      if (segment !== null) open = segment;
      if (part === 'LOAD') totals.loads += 1;
      if (part === 'AFTER_PRESS_WINDOW') totals.presses += 1;
      let value: T;
      try {
        value = await work();
      } finally {
        if (counted() && myGeneration === generation) {
          depth -= 1;
          if (segment !== null && open === segment) {
            const at = now();
            add(part, at - segment.startAt);
            lastClosedAt = at;
            open = null;
          }
        }
      }
      if (counted() && myGeneration === generation && timedOut?.(value) === true) totals.pressReadinessTimeouts += 1;
      return value;
    },
    noteProgress(): void {
      if (counted()) lastProgressAt = now();
    },
    endStage(): void {
      if (!counted()) return;
      const at = now();
      const lostFrom = Math.max(lastProgressAt, lastClosedAt);
      if (open !== null) {
        // 開いたままの測りは、失った時間の起点まで、その区分に数える。
        add(open.part, Math.min(at, lostFrom) - open.startAt);
        totals.stageEndMs += Math.max(0, at - Math.max(lostFrom, open.startAt));
      } else {
        totals.stageEndMs += Math.max(0, at - lostFrom);
      }
      open = null;
      depth = 0;
      lastClosedAt = at;
      generation += 1;
    },
    noting: debug !== null,
    note(entry: ScreenNote): void {
      if (debug === null) return;
      debug.log.record(() => ({ point: entry.point, stateId: debug.stateId, part: entry.part, counts: { ...entry.counts } }));
    },
    countReload(): void {
      if (counted()) totals.reloads += 1;
    },
    finish(): DiscoveryPageTimeBreakdown {
      if (!finished) {
        finished = true;
        totals.totalMs = Math.max(0, now() - startedAt);
        const parts = PAGE_TIME_PARTS.reduce((sum, part) => sum + totals[MS_KEYS[part]], 0) + totals.stageEndMs;
        totals.otherMs = Math.max(0, totals.totalMs - parts);
        // DBG-1: 締めた内訳を、測りの記録にも 1 行足す。
        debug?.log.record(() => ({ point: 'DISCOVERY_PAGE', stateId: debug.stateId, counts: { ...totals } }));
      }
      return Object.freeze({ ...totals });
    },
  };
}

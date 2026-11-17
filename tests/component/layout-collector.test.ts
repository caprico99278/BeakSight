import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import { wait } from '../../src/core/deadline.js';
import {
  VISUALLY_HIDDEN_MAX_DIMENSION_PX,
  type LayoutCollectionResult,
  type LayoutEvidence,
} from '../../src/core/evidence-types.js';
import {
  LAYOUT_COLLECTION_PART_SIZE,
  LAYOUT_THRESHOLDS,
  STRESS_VIEWPORT_HEIGHT,
  collectLayoutEvidence,
  collectStressLayout,
  type PassiveStressSession,
  type PassiveStressSessionFactory,
  type StressLayoutOptions,
} from '../../src/evidence/layout-collector.js';
import { fakePlaywrightRequest } from '../helpers/fake-playwright-request.js';
import { NO_PACING_WAIT, NO_SETTLING_WAIT } from '../helpers/navigation-pacer.js';
import { TIMER_CLOCK_GRANULARITY_MS } from '../helpers/timer-clock.js';

/** テストの幅の走査に渡す、1 幅あたりの期限（ms。幅の走査の期限は、呼び出し側の Page Auditor が決める）。 */
const STRESS_TEST_WIDTH_TIMEOUT_MS = 10_000;

function rawLayout(width: number, height: number) {
  return {
    scrollPosition: { scrollX: 0, scrollY: 0 },
    document: {
      viewportWidth: width,
      viewportHeight: height,
      documentElementClientWidth: width,
      documentElementClientHeight: height,
      documentElementScrollWidth: width,
      documentElementScrollHeight: height,
      bodyScrollWidth: width,
      bodyScrollHeight: height,
      bodyClientWidth: width,
      bodyClientHeight: height,
      horizontalOverflowPx: 0,
      viewportHorizontalClip: 'NONE',
    },
    boxesOutsideViewport: [],
    zeroSizeInteractive: [],
    clippedText: [],
    fixedHeadingOverlaps: [],
    elementOverlaps: [],
    fixedElements: [],
    // COV-6: 一覧ごとの次に読む位置（どれも null なら、1 回で読み終える）。
    next: {
      boxesOutsideViewport: null as number | null,
      zeroSizeInteractive: null as number | null,
      clippedText: null as number | null,
      fixedHeadingOverlaps: null as number | null,
      elementOverlaps: null as number | null,
      fixedElements: null as number | null,
    },
    truncation: {
      overlapComparisonLimitReached: false,
      clippedTextNodeScanLimitReachedCount: 0,
      renderedDescendantScanLimitReachedCount: 0,
    },
    incompleteReason: null,
  };
}

function rect(left: number, top: number, width: number, height: number) {
  return { x: left, y: top, top, right: left + width, bottom: top + height, left, width, height };
}

const visibleFacts = {
  visible: true,
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  hiddenAttribute: false,
  ariaHidden: false,
  clientRectCount: 1,
};

function outsideCandidate(selector: string, box: ReturnType<typeof rect>, overrides: Record<string, unknown> = {}) {
  return {
    selector,
    kind: 'image',
    rect: box,
    visibility: visibleFacts,
    position: 'static',
    zIndex: 'auto',
    overflowX: 'visible',
    overflowY: 'visible',
    horizontalClipAncestor: 'NONE',
    nearestListedAncestorIndex: null,
    outside: { left: false, right: true, top: false, bottom: false },
    truncated: false,
    ...overrides,
  };
}

function clippedCandidate(selector: string, overrides: Record<string, unknown> = {}) {
  return {
    selector,
    text: 'Clipped text',
    rect: rect(0, 0, 100, 20),
    visibility: visibleFacts,
    overflowX: 'hidden',
    overflowY: 'hidden',
    position: 'static',
    zIndex: 'auto',
    clientWidth: 100,
    clientHeight: 20,
    scrollWidth: 180,
    scrollHeight: 20,
    widthClipped: true,
    heightClipped: false,
    partiallyClippedText: true,
    truncated: false,
    // AUD-4a: 意図した省略を見分けるための事実（ブラウザが返す形）。
    clippingStyle: {
      textOverflow: 'clip',
      whiteSpace: 'nowrap',
      webkitLineClamp: 'none',
      lineClamp: '',
      display: 'block',
      webkitBoxOrient: 'horizontal',
      maxHeight: 'none',
    },
    lineHeightPx: 20,
    visibleLineCount: 1,
    collapsedByControl: false,
    ...overrides,
  };
}

function completeLayout(result: LayoutCollectionResult): LayoutEvidence {
  expect(result.status).toBe('COMPLETE');
  if (result.status !== 'COMPLETE') {
    throw new Error('layout collection was not complete');
  }
  return result.layout;
}

function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** 間隔を確かめないテストの、幅の走査の引数。期限は、呼び出し時点から、幅の数 × `defaultTimeoutMs` 後。 */
function unpacedStressOptions(widths: readonly number[]): StressLayoutOptions {
  return {
    deadlineAtMs: Date.now() + STRESS_TEST_WIDTH_TIMEOUT_MS * widths.length,
    beforeNavigation: NO_PACING_WAIT,
    settleBeforeLayout: NO_SETTLING_WAIT,
  };
}

function sessionFactory(events: string[]): PassiveStressSessionFactory {
  let serial = 0;
  return async (viewport): Promise<PassiveStressSession> => {
    serial += 1;
    const id = serial;
    events.push(`create:${id}:${viewport.width}x${viewport.height}`);
    const page = {
      goto: async (url: string) => { events.push(`goto:${id}:${url}`); },
      evaluate: async () => rawLayout(viewport.width, viewport.height),
    } as unknown as Page;
    return {
      page,
      close: async () => { events.push(`close:${id}`); },
    };
  };
}

describe('responsive layout stress lifecycle', () => {
  it('clamps a document narrower than the viewport to zero horizontal overflow', async () => {
    const page = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        document: {
          ...rawLayout(320, STRESS_VIEWPORT_HEIGHT).document,
          documentElementClientWidth: 300,
          documentElementScrollWidth: 300,
          bodyScrollWidth: 300,
          horizontalOverflowPx: -20,
        },
      }),
    } as unknown as Page;

    const result = completeLayout(await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT }));

    expect(result.document.horizontalOverflowPx).toBe(0);
  });

  it('keeps the collection scroll position and rejects a non-finite one', async () => {
    const scrolledPage = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        scrollPosition: { scrollX: -12, scrollY: 1_050 },
      }),
    } as unknown as Page;
    const invalidPage = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        scrollPosition: { scrollX: 0, scrollY: Number.NaN },
      }),
    } as unknown as Page;

    const scrolled = completeLayout(
      await collectLayoutEvidence(scrolledPage, { width: 320, height: STRESS_VIEWPORT_HEIGHT }),
    );

    expect(scrolled.scrollPosition).toEqual({ scrollX: -12, scrollY: 1_050 });
    expect(Object.isFrozen(scrolled.scrollPosition)).toBe(true);
    await expect(collectLayoutEvidence(invalidPage, { width: 320, height: STRESS_VIEWPORT_HEIGHT })).rejects.toThrow(
      'scrollPosition.scrollY',
    );
  });

  // T44 P1-5（ユーザーの判断「待ってから測る」）: 幅の走査も、読み込みの後に、最初の読み込みと同じ落ち着きの待ち（`settleBeforeLayout`。Page Auditor が
  // `waitForPageSettled` と `PAGE_SETTLING_PACING` を渡す）を待ってから形を測る。待ちには、その幅の読み込みの期限を渡す。
  it('waits for the page to settle after each load and before measuring the layout (P1-5)', async () => {
    const events: string[] = [];
    let serial = 0;
    const factory: PassiveStressSessionFactory = async (viewport) => {
      serial += 1;
      const id = serial;
      const page = {
        goto: async () => { events.push(`goto:${id}`); },
        evaluate: async () => {
          events.push(`measure:${id}`);
          return rawLayout(viewport.width, viewport.height);
        },
      } as unknown as Page;
      return { page, close: async () => { events.push(`close:${id}`); } };
    };
    const options = unpacedStressOptions([320, 768]);
    const deadlines: number[] = [];
    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320, 768], {
      ...options,
      settleBeforeLayout: async (_page, deadlineAtMs) => {
        deadlines.push(deadlineAtMs);
        events.push(`settle:${serial}`);
      },
    });
    expect(result.map((entry) => entry.status)).toEqual(['COMPLETE', 'COMPLETE']);
    expect(events).toEqual(['goto:1', 'settle:1', 'measure:1', 'close:1', 'goto:2', 'settle:2', 'measure:2', 'close:2']);
    expect(deadlines).toEqual([options.deadlineAtMs, options.deadlineAtMs]);
  });

  it('is an error to sweep with a settleBeforeLayout that is not a function, before creating a session (P1-5)', async () => {
    const events: string[] = [];
    await expect(collectStressLayout(sessionFactory(events), 'https://fixture.test/page', [320], {
      ...unpacedStressOptions([320]),
      settleBeforeLayout: 'wait' as unknown as StressLayoutOptions['settleBeforeLayout'],
    })).rejects.toThrow('settleBeforeLayout');
    expect(events).toEqual([]);
  });

  it('preserves input order while using a fresh owner-closed session for each width', async () => {
    const events: string[] = [];

    const result = await collectStressLayout(sessionFactory(events), 'https://fixture.test/page', [390, 320], unpacedStressOptions([390, 320]));

    expect(result.map((entry) => entry.width)).toEqual([390, 320]);
    expect(result.map((entry) => entry.status)).toEqual(['COMPLETE', 'COMPLETE']);
    expect(events).toEqual([
      `create:1:390x${STRESS_VIEWPORT_HEIGHT}`,
      'goto:1:https://fixture.test/page',
      'close:1',
      `create:2:320x${STRESS_VIEWPORT_HEIGHT}`,
      'goto:2:https://fixture.test/page',
      'close:2',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]?.layout?.document)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid width %s before creating a session',
    async (width) => {
      let creations = 0;
      const factory: PassiveStressSessionFactory = async () => {
        creations += 1;
        throw new Error('must not create');
      };

      await expect(collectStressLayout(factory, 'https://fixture.test/page', [320, width], unpacedStressOptions([320, width]))).rejects.toThrow(
        'positive finite integers',
      );
      expect(creations).toBe(0);
    },
  );

  it('keeps earlier widths and records a width whose collection failed, with the reason (V8)', async () => {
    // レビュー V8 の再現条件: 1つの幅が失敗すると、それまでの幅の結果もすべて失っていた。
    const events: string[] = [];
    let serial = 0;
    const factory: PassiveStressSessionFactory = async (viewport) => {
      serial += 1;
      const id = serial;
      return {
        page: {
          goto: async () => undefined,
          evaluate: async () => {
            if (id === 2) {
              throw new Error('collection failed');
            }
            return rawLayout(viewport.width, viewport.height);
          },
          isClosed: () => false,
        } as unknown as Page,
        close: async () => { events.push(`close:${id}`); },
      };
    };

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [390, 320, 768], unpacedStressOptions([390, 320, 768]));

    expect(result.map((entry) => [entry.width, entry.status])).toEqual([
      [390, 'COMPLETE'],
      [320, 'FAILED'],
      [768, 'COMPLETE'],
    ]);
    expect(result[0]?.layout?.document.viewportWidth).toBe(390);
    expect(result[1]).toEqual({
      width: 320,
      height: STRESS_VIEWPORT_HEIGHT,
      status: 'FAILED',
      stage: 'COLLECTION',
      reason: 'EVALUATION_FAILED',
      message: 'collection failed',
      layout: null,
    });
    expect(events).toEqual(['close:1', 'close:2', 'close:3']);
    expect(Object.isFrozen(result[1])).toBe(true);
  });

  it('records a width whose navigation failed and continues with the next width (V8)', async () => {
    let serial = 0;
    const factory: PassiveStressSessionFactory = async (viewport) => {
      serial += 1;
      const id = serial;
      return {
        page: {
          goto: async () => {
            if (id === 1) {
              throw new Error('navigation failed');
            }
          },
          evaluate: async () => rawLayout(viewport.width, viewport.height),
          isClosed: () => false,
        } as unknown as Page,
        close: async () => undefined,
      };
    };

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320, 390], unpacedStressOptions([320, 390]));

    expect(result[0]).toMatchObject({
      width: 320,
      status: 'FAILED',
      stage: 'NAVIGATION',
      reason: 'NAVIGATION_FAILED',
      message: 'navigation failed',
      layout: null,
    });
    expect(result[1]).toMatchObject({ width: 390, status: 'COMPLETE' });
  });

  it('records a closed page as the reason of a failed width (V8)', async () => {
    const factory: PassiveStressSessionFactory = async () => ({
      page: {
        goto: async () => undefined,
        evaluate: async () => { throw new Error('Target page, context or browser has been closed'); },
        isClosed: () => true,
      } as unknown as Page,
      close: async () => undefined,
    });

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320], unpacedStressOptions([320]));

    expect(result[0]).toMatchObject({ status: 'FAILED', stage: 'COLLECTION', reason: 'PAGE_CLOSED' });
  });

  it('records widths that could not start before the stress deadline without creating sessions (V8)', async () => {
    let creations = 0;
    const factory: PassiveStressSessionFactory = async () => {
      creations += 1;
      throw new Error('must not create');
    };

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320, 390], {
      deadlineAtMs: Date.now() - 1,
      beforeNavigation: NO_PACING_WAIT,
      settleBeforeLayout: NO_SETTLING_WAIT,
    });

    expect(creations).toBe(0);
    expect(result).toEqual([
      {
        width: 320,
        height: STRESS_VIEWPORT_HEIGHT,
        status: 'FAILED',
        stage: 'NOT_STARTED',
        reason: 'DEADLINE_EXCEEDED',
        message: null,
        layout: null,
      },
      {
        width: 390,
        height: STRESS_VIEWPORT_HEIGHT,
        status: 'FAILED',
        stage: 'NOT_STARTED',
        reason: 'DEADLINE_EXCEEDED',
        message: null,
        layout: null,
      },
    ]);
  });

  it('records a navigation that outlives the stress deadline as a deadline failure and still closes (V8)', async () => {
    let closes = 0;
    const factory: PassiveStressSessionFactory = async () => ({
      page: {
        goto: neverSettles,
        evaluate: async () => { throw new Error('must not collect'); },
        isClosed: () => false,
      } as unknown as Page,
      close: async () => { closes += 1; },
    });

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320], {
      deadlineAtMs: Date.now() + 50,
      beforeNavigation: NO_PACING_WAIT,
      settleBeforeLayout: NO_SETTLING_WAIT,
    });

    expect(result[0]).toMatchObject({
      status: 'FAILED',
      stage: 'NAVIGATION',
      reason: 'DEADLINE_EXCEEDED',
      layout: null,
    });
    expect(closes).toBe(1);
  });

  it('passes a partial layout of a width through with its reason (V8)', async () => {
    const factory: PassiveStressSessionFactory = async (viewport) => ({
      page: {
        goto: async () => undefined,
        evaluate: async () => ({ ...rawLayout(viewport.width, viewport.height), incompleteReason: 'DEADLINE_EXCEEDED' }),
        isClosed: () => false,
      } as unknown as Page,
      close: async () => undefined,
    });

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320], unpacedStressOptions([320]));

    expect(result[0]).toMatchObject({ width: 320, status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(result[0]?.layout?.document.viewportWidth).toBe(320);
  });

  it('preserves both work and close failures', async () => {
    const workError = new Error('navigation failed');
    const closeError = new Error('owner close failed');
    const factory: PassiveStressSessionFactory = async () => ({
      page: { goto: async () => { throw workError; } } as unknown as Page,
      close: async () => { throw closeError; },
    });

    const rejection = await collectStressLayout(factory, 'https://fixture.test/page', [320], unpacedStressOptions([320])).catch(
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([workError, closeError]);
  });
});

// L2（サイトへの負荷の制御の設計書 4.1、4.4）: 幅の走査は、各幅の読み込み（`page.goto`）の直前に、ページの読み込みの間隔の待ち
// （`beforeNavigation`）を呼び、待った時間の分だけ、自分の期限を延ばす。
describe('responsive layout stress navigation pacing (load control design 4.1, 4.4)', () => {
  // DEF-209: 待ってから、その幅のセッション（Context と空の page）を作る（待つ間に、空の page の窓を出さない）。
  it('waits before the session of each width is created, and navigates right after it', async () => {
    const events: string[] = [];
    let paced = 0;

    const result = await collectStressLayout(sessionFactory(events), 'https://fixture.test/page', [390, 320], {
      deadlineAtMs: Date.now() + STRESS_TEST_WIDTH_TIMEOUT_MS,
      settleBeforeLayout: NO_SETTLING_WAIT,
      beforeNavigation: async () => {
        paced += 1;
        events.push(`pace:${paced}`);
        return 0;
      },
    });

    expect(result.map((entry) => entry.status)).toEqual(['COMPLETE', 'COMPLETE']);
    expect(events).toEqual([
      'pace:1',
      `create:1:390x${STRESS_VIEWPORT_HEIGHT}`,
      'goto:1:https://fixture.test/page',
      'close:1',
      'pace:2',
      `create:2:320x${STRESS_VIEWPORT_HEIGHT}`,
      'goto:2:https://fixture.test/page',
      'close:2',
    ]);
  });

  it('extends its deadline by the time waited, so that the wait does not use up the stress deadline', async () => {
    // 期限は 100ms 後。各幅の前に 200ms 待つ。待った時間の分だけ期限を延ばさないと、1つ目の幅の読み込みは期限切れになり、
    // 2つ目の幅は始められない。
    const waitedMs = 200;
    const events: string[] = [];
    let waits = 0;

    const result = await collectStressLayout(sessionFactory(events), 'https://fixture.test/page', [390, 320], {
      deadlineAtMs: Date.now() + 100,
      settleBeforeLayout: NO_SETTLING_WAIT,
      beforeNavigation: async () => {
        waits += 1;
        await wait(waitedMs);
        return waitedMs;
      },
    });

    expect(waits).toBe(2);
    expect(result.map((entry) => [entry.width, entry.status])).toEqual([[390, 'COMPLETE'], [320, 'COMPLETE']]);
    expect(events.filter((event) => event.startsWith('goto:'))).toHaveLength(2);
  });

  it('extends its deadline by exactly the time each wait returned, not more, for the width and the next widths', async () => {
    // RL-fix（RL の Minor-4 (a)）: 延長の量そのものを確かめる。待ちは実際には待たず、待った時間として決めた値を返す。各幅の収集が
    // page に渡す走査の期限（`scanDeadlineAtMs` = 走査の期限 − `partialResultReserveMs`）は、待ちが返した時間の合計だけ後ろに延びる。
    // 延ばし過ぎ（例: 待った時間の2倍）と延ばし忘れは、この値の違いで分かる（上のテストは、延ばし過ぎを見分けられない）。
    const returnedWaitsMs = [700, 300] as const;
    const deadlineAtMs = Date.now() + STRESS_TEST_WIDTH_TIMEOUT_MS;
    const scanDeadlines: number[] = [];
    const factory: PassiveStressSessionFactory = async (viewport) => ({
      page: {
        goto: async () => undefined,
        evaluate: async (_collect: unknown, argument: { readonly scanDeadlineAtMs: number }) => {
          scanDeadlines.push(argument.scanDeadlineAtMs);
          return rawLayout(viewport.width, viewport.height);
        },
        isClosed: () => false,
      } as unknown as Page,
      close: async () => undefined,
    });
    let waits = 0;

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [390, 320], {
      deadlineAtMs,
      settleBeforeLayout: NO_SETTLING_WAIT,
      beforeNavigation: async () => {
        const returnedMs = returnedWaitsMs[waits] ?? 0;
        waits += 1;
        return returnedMs;
      },
    });

    expect(result.map((entry) => entry.status)).toEqual(['COMPLETE', 'COMPLETE']);
    const [firstWaitMs, secondWaitMs] = returnedWaitsMs;
    expect(scanDeadlines).toEqual([
      deadlineAtMs + firstWaitMs - LAYOUT_THRESHOLDS.partialResultReserveMs,
      deadlineAtMs + firstWaitMs + secondWaitMs - LAYOUT_THRESHOLDS.partialResultReserveMs,
    ]);
  });

  // RL-fix（RL の Minor-5）: 間隔の待ちは、省略できない引数である（Page Auditor の pacer と同じ）。渡し忘れると間隔を空けずに
  // 読み込む、という形を残さない。待たない呼び出し側は、それを明示する関数（`async () => 0`）を渡す。
  it('is a type error and an error to sweep without beforeNavigation, before creating a session', async () => {
    let creations = 0;
    const factory: PassiveStressSessionFactory = async () => {
      creations += 1;
      throw new Error('must not create');
    };

    // @ts-expect-error: ページの読み込みの間隔の待ち（`beforeNavigation`）を渡さないと、型のエラーになる。
    await expect(collectStressLayout(factory, 'https://fixture.test/page', [320], {
      deadlineAtMs: Date.now() + STRESS_TEST_WIDTH_TIMEOUT_MS,
    })).rejects.toThrow('beforeNavigation');
    // @ts-expect-error: 期限と間隔の待ちの引数そのものを省略すると、型のエラーになる。
    await expect(collectStressLayout(factory, 'https://fixture.test/page', [320])).rejects.toThrow('beforeNavigation');
    expect(creations).toBe(0);
  });

  it('rejects a beforeNavigation that is not a function before creating a session', async () => {
    let creations = 0;
    const factory: PassiveStressSessionFactory = async () => {
      creations += 1;
      throw new Error('must not create');
    };

    await expect(collectStressLayout(factory, 'https://fixture.test/page', [320], {
      deadlineAtMs: Date.now() + STRESS_TEST_WIDTH_TIMEOUT_MS,
      beforeNavigation: 'wait' as unknown as () => Promise<number>,
      settleBeforeLayout: NO_SETTLING_WAIT,
    })).rejects.toThrow('beforeNavigation');
    expect(creations).toBe(0);
  });
});

// SU2b（サイトが応答しないときに Run を止める設計書 2.1）: 幅の走査は、各幅の読み込み（`page.goto`）の観測を、注入された受け口
// （`afterNavigation`）に渡す。観測は `src/browser/main-frame-load.ts` の部品で作り、collector は判定をしない。偽の page は、
// 本物の page と同じく、要求と応答の事象を出す（main frame の文書の要求を追う部品が、事象の受け口を付けて外すことも確かめる）。

/** 偽の page の読み込みの振る舞い。 */
type FakeLoad =
  /** main frame の文書の要求を出し、`status` の応答を返して、読み込みを終える。 */
  | { readonly kind: 'ANSWER'; readonly status: number }
  /** main frame の文書の要求を出すが、応答を返さず、読み込みも終わらない（応答のない時間切れ）。 */
  | { readonly kind: 'NO_RESPONSE' }
  /** main frame の文書の要求を出し、応答を返さずに、`message` の例外で読み込みが失敗する。 */
  | { readonly kind: 'REJECT'; readonly message: string };

const FAKE_STATUS_OK = 200;
const FAKE_STATUS_SERVICE_UNAVAILABLE = 503;

/**
 * 事象の受け口の数を記録する、偽の page を持つセッションの factory。n 番目の幅の読み込みは `loads[n - 1]` のとおりに振る舞う。
 */
function eventEmittingSessionFactory(
  loads: readonly FakeLoad[],
  events: string[],
): PassiveStressSessionFactory {
  let serial = 0;
  return async (viewport): Promise<PassiveStressSession> => {
    const load = loads[serial];
    serial += 1;
    const id = serial;
    if (load === undefined) {
      throw new Error(`no fake load for the session ${id}`);
    }
    const mainFrame = Object.freeze({});
    const emitter = new EventEmitter();
    const listeners = (): string => `request=${emitter.listenerCount('request')},response=${emitter.listenerCount('response')}`;
    const page = Object.assign(emitter, {
      mainFrame: () => mainFrame,
      isClosed: () => false,
      evaluate: async () => rawLayout(viewport.width, viewport.height),
      goto: async (url: string) => {
        events.push(`goto:${id}:${url}:${listeners()}`);
        const request = fakePlaywrightRequest({ navigation: true, frame: mainFrame });
        emitter.emit('request', request);
        switch (load.kind) {
          case 'ANSWER': {
            const response = { request: () => request, status: () => load.status };
            emitter.emit('response', response);
            return response;
          }
          case 'NO_RESPONSE':
            return neverSettles();
          case 'REJECT':
            throw new Error(load.message);
        }
      },
    });
    return {
      page: page as unknown as Page,
      close: async () => { events.push(`close:${id}:${listeners()}`); },
    };
  };
}

describe('responsive layout stress main frame load observation (site unavailability design 2.1)', () => {
  it('passes the observation of the load of each width to afterNavigation (200, 503 and a failure), tracking only during the load', async () => {
    const events: string[] = [];
    const observations: MainFrameLoadObservation[] = [];
    const failureMessage = 'page.goto: net::ERR_CONNECTION_REFUSED at https://fixture.test/page';

    const result = await collectStressLayout(
      eventEmittingSessionFactory([
        { kind: 'ANSWER', status: FAKE_STATUS_OK },
        { kind: 'ANSWER', status: FAKE_STATUS_SERVICE_UNAVAILABLE },
        { kind: 'REJECT', message: failureMessage },
      ], events),
      'https://fixture.test/page',
      [390, 320, 768],
      {
        ...unpacedStressOptions([390, 320, 768]),
        afterNavigation: (observation) => {
          observations.push(observation);
        },
      },
    );

    expect(observations).toEqual([
      { navigationOutcome: 'OK', httpStatus: FAKE_STATUS_OK, failureDetail: null },
      { navigationOutcome: 'OK', httpStatus: FAKE_STATUS_SERVICE_UNAVAILABLE, failureDetail: null },
      { navigationOutcome: 'FAILED', httpStatus: null, failureDetail: failureMessage },
    ]);
    expect(observations.every((observation) => Object.isFrozen(observation))).toBe(true);
    // 観測を渡しても、幅の結果は今までどおりである（collector は判定をしない）。
    expect(result.map((entry) => [entry.width, entry.status])).toEqual([[390, 'COMPLETE'], [320, 'COMPLETE'], [768, 'FAILED']]);
    expect(result[2]).toMatchObject({ stage: 'NAVIGATION', reason: 'NAVIGATION_FAILED', message: failureMessage });
    // 事象の受け口は、読み込みの前に付け、セッションを閉じる前に外す。
    expect(events).toEqual([
      'goto:1:https://fixture.test/page:request=1,response=1',
      'close:1:request=0,response=0',
      'goto:2:https://fixture.test/page:request=1,response=1',
      'close:2:request=0,response=0',
      'goto:3:https://fixture.test/page:request=1,response=1',
      'close:3:request=0,response=0',
    ]);
  });

  it('passes a TIMEOUT without an HTTP status when the load of a width gets no response before the stress deadline', async () => {
    const events: string[] = [];
    const observations: MainFrameLoadObservation[] = [];

    const result = await collectStressLayout(
      eventEmittingSessionFactory([{ kind: 'NO_RESPONSE' }], events),
      'https://fixture.test/page',
      [320],
      {
        deadlineAtMs: Date.now() + 50,
        beforeNavigation: NO_PACING_WAIT,
        settleBeforeLayout: NO_SETTLING_WAIT,
        afterNavigation: (observation) => {
          observations.push(observation);
        },
      },
    );

    expect(observations).toEqual([{ navigationOutcome: 'TIMEOUT', httpStatus: null, failureDetail: null }]);
    expect(result[0]).toMatchObject({ width: 320, status: 'FAILED', stage: 'NAVIGATION', reason: 'DEADLINE_EXCEEDED' });
    expect(events).toEqual([
      'goto:1:https://fixture.test/page:request=1,response=1',
      'close:1:request=0,response=0',
    ]);
  });

  it('does not call afterNavigation for widths that could not start before the stress deadline', async () => {
    let creations = 0;
    let calls = 0;
    const factory: PassiveStressSessionFactory = async () => {
      creations += 1;
      throw new Error('must not create');
    };

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320, 390], {
      deadlineAtMs: Date.now() - 1,
      beforeNavigation: NO_PACING_WAIT,
      settleBeforeLayout: NO_SETTLING_WAIT,
      afterNavigation: () => {
        calls += 1;
      },
    });

    expect(result.map((entry) => entry.status === 'FAILED' ? entry.stage : entry.status)).toEqual(['NOT_STARTED', 'NOT_STARTED']);
    expect(creations).toBe(0);
    expect(calls).toBe(0);
  });

  it('works as before without afterNavigation, without listening to the events of the page nor observing its requests', async () => {
    // 受け口を省略した呼び出し（既存の呼び出し）の振る舞いは変えない。事象の受け口も付けず、ページ本体の要求の観察（CDP の session）も
    // 始めない（D3。事象の受け口も Context も持たない偽の page でも動く）。
    const events: string[] = [];
    const factory = sessionFactory(events);
    const listening: PassiveStressSessionFactory = async (viewport) => {
      const session = await factory(viewport);
      return {
        ...session,
        page: Object.assign(session.page, {
          on: () => {
            throw new Error('must not listen to the page events');
          },
          context: () => {
            throw new Error('must not open a CDP session');
          },
        }),
      };
    };

    const result = await collectStressLayout(listening, 'https://fixture.test/page', [390, 320], unpacedStressOptions([390, 320]));

    expect(result.map((entry) => entry.status)).toEqual(['COMPLETE', 'COMPLETE']);
    expect(events.filter((event) => event.startsWith('goto:'))).toHaveLength(2);
  });

  it('rejects an afterNavigation that is not a function before creating a session', async () => {
    let creations = 0;
    const factory: PassiveStressSessionFactory = async () => {
      creations += 1;
      throw new Error('must not create');
    };

    await expect(collectStressLayout(factory, 'https://fixture.test/page', [320], {
      ...unpacedStressOptions([320]),
      afterNavigation: 'observe' as unknown as (observation: MainFrameLoadObservation) => void,
    })).rejects.toThrow('afterNavigation');
    expect(creations).toBe(0);
  });
});

describe('layout collection deadline (V8)', () => {
  it('returns a partial result with the reason when the browser evaluation outlives the deadline', async () => {
    const page = { evaluate: neverSettles } as unknown as Page;
    const startedAt = Date.now();

    const result = await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT }, {
      deadlineAtMs: Date.now() + 50,
    });

    expect(result).toEqual({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED', layout: null });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects an unknown incomplete reason from the browser', async () => {
    const page = {
      evaluate: async () => ({ ...rawLayout(320, STRESS_VIEWPORT_HEIGHT), incompleteReason: 'SOMETHING_ELSE' }),
    } as unknown as Page;

    await expect(collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT })).rejects.toThrow(
      'incompleteReason',
    );
  });
});

describe('layout overlap and truncation evidence (V5, V9)', () => {
  it('derives the viewport area ratio of a fixed element from its rectangle', async () => {
    const page = {
      evaluate: async () => ({
        ...rawLayout(400, 300),
        fixedElements: [{
          selector: '#half-outside',
          kind: 'other',
          rect: rect(200, 150, 400, 300),
          visibility: visibleFacts,
          position: 'fixed',
          zIndex: '10',
          overflowX: 'visible',
          overflowY: 'visible',
          fixedOrStickyAncestor: false,
          truncated: false,
          // DEF-204: 描く面の事実（何も描かない入れ物）と pointer-events。
          surface: {
            backgroundColor: 'rgba(0, 0, 0, 0)',
            backgroundImage: 'none',
            borderWidths: ['0px', '0px', '0px', '0px'],
            borderStyles: ['none', 'none', 'none', 'none'],
            borderColors: ['rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)'],
            outlineWidth: '0px',
            outlineStyle: 'none',
            outlineColor: 'rgb(0, 0, 0)',
            boxShadow: 'none',
            backdropFilter: 'none',
            hasOwnText: false,
            hasPseudoContent: false,
            replacedContent: false,
          },
          pointerEvents: 'none',
        }],
      }),
    } as unknown as Page;

    const layout = completeLayout(await collectLayoutEvidence(page, { width: 400, height: 300 }));

    expect(layout.fixedElements[0]).toMatchObject({
      area: 400 * 300,
      viewportIntersectionArea: 200 * 150,
      viewportArea: 400 * 300,
      viewportAreaRatio: 0.25,
      paintsOwnSurface: false,
      pointerEvents: 'none',
    });
    expect(Object.isFrozen(layout.fixedElements[0])).toBe(true);
  });

  it('collects every candidate in parts of LAYOUT_COLLECTION_PART_SIZE from the cursor, without an omitted count (COV-6)', async () => {
    const total = LAYOUT_COLLECTION_PART_SIZE * 2 + 3;
    const candidates = Array.from({ length: total }, (_, index) => ({
      selector: `#zero-${index}`,
      tagName: 'button',
      role: null,
      rect: rect(0, 0, 0, 0),
      visibility: visibleFacts,
      position: 'static',
      zIndex: 'auto',
      overflowX: 'visible',
      overflowY: 'visible',
      hasRenderedDescendant: false,
      truncated: false,
    }));
    const cursors: Record<string, number | null>[] = [];
    const page = {
      evaluate: async (_collect: unknown, argument: { readonly cursor: Record<string, number | null>; readonly partSize: number }) => {
        cursors.push(argument.cursor);
        const start = argument.cursor.zeroSizeInteractive;
        const base = rawLayout(320, STRESS_VIEWPORT_HEIGHT);
        const after = start === null || start === undefined ? null : start + argument.partSize;
        return {
          ...base,
          zeroSizeInteractive: start === null || start === undefined ? [] : candidates.slice(start, start + argument.partSize),
          next: { ...base.next, zeroSizeInteractive: after !== null && after < total ? after : null },
          truncation: { ...base.truncation, renderedDescendantScanLimitReachedCount: 1 },
        };
      },
    } as unknown as Page;

    const layout = completeLayout(await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT }));

    expect(layout.zeroSizeInteractive.map((candidate) => candidate.selector)).toEqual(candidates.map((candidate) => candidate.selector));
    expect(layout.collectedInParts).toBe(3);
    expect(cursors.map((cursor) => cursor.zeroSizeInteractive)).toEqual([
      0,
      LAYOUT_COLLECTION_PART_SIZE,
      LAYOUT_COLLECTION_PART_SIZE * 2,
    ]);
    // 1 回目で読み終えた一覧は、次の回から null（ブラウザは作業を省く）。
    expect(cursors[1]?.clippedText).toBeNull();
    expect(layout.truncation).toMatchObject({
      omittedZeroSizeInteractiveCount: 0,
      omittedOutsideViewportCount: 0,
      omittedClippedTextCount: 0,
      omittedFixedHeadingOverlapCount: 0,
      omittedElementOverlapCount: 0,
      omittedFixedElementCount: 0,
      renderedDescendantScanLimitReachedCount: 3,
    });
    expect(Object.isFrozen(layout.truncation)).toBe(true);
  });

  it('keeps the facts of the earlier parts as PARTIAL when a later part outlives the deadline (COV-6)', async () => {
    const candidate = clippedCandidate('#clipped');
    let calls = 0;
    const page = {
      evaluate: async (_collect: unknown, argument: { readonly partSize: number }) => {
        calls += 1;
        if (calls > 1) {
          return neverSettles();
        }
        const base = rawLayout(320, STRESS_VIEWPORT_HEIGHT);
        return {
          ...base,
          clippedText: Array.from({ length: argument.partSize }, () => candidate),
          next: { ...base.next, clippedText: argument.partSize },
        };
      },
    } as unknown as Page;

    const result = await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT }, { deadlineAtMs: Date.now() + 300 });

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(result.layout?.clippedText).toHaveLength(LAYOUT_COLLECTION_PART_SIZE);
    expect(result.layout?.collectedInParts).toBe(1);
  });

  describe('no deadline of its own (COV-6, the decision of the user on 2026-11-09)', () => {
    /** 前の collector の期限の既定（10 秒）。いまは期限を持たないことを、これより長い時間で確かめる。 */
    const FORMER_DEFAULT_TIMEOUT_MS = 10_000;

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps reading to the end without a deadline from the caller, however long the parts take', async () => {
      vi.useFakeTimers();
      const candidate = clippedCandidate('#clipped');
      const partCount = 3;
      let calls = 0;
      const page = {
        evaluate: async (_collect: unknown, argument: { readonly partSize: number; readonly scanDeadlineAtMs: number | null }) => {
          calls += 1;
          // ブラウザ内の走査にも、止める時刻を渡さない。
          expect(argument.scanDeadlineAtMs).toBeNull();
          // 1 回ごとに、前の期限の既定より長い時間がかかる。
          vi.setSystemTime(Date.now() + FORMER_DEFAULT_TIMEOUT_MS * 2);
          const base = rawLayout(320, STRESS_VIEWPORT_HEIGHT);
          return {
            ...base,
            clippedText: Array.from({ length: argument.partSize }, () => candidate),
            next: { ...base.next, clippedText: calls < partCount ? argument.partSize * calls : null },
          };
        },
      } as unknown as Page;

      const layout = completeLayout(await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT }));

      expect(layout.collectedInParts).toBe(partCount);
      expect(layout.clippedText).toHaveLength(LAYOUT_COLLECTION_PART_SIZE * partCount);
    });

    it('does not stop on its own while a part has not returned, without a deadline from the caller', async () => {
      vi.useFakeTimers();
      const candidate = clippedCandidate('#clipped');
      let calls = 0;
      const page = {
        evaluate: async (_collect: unknown, argument: { readonly partSize: number }) => {
          calls += 1;
          if (calls > 1) {
            return neverSettles();
          }
          const base = rawLayout(320, STRESS_VIEWPORT_HEIGHT);
          return {
            ...base,
            clippedText: Array.from({ length: argument.partSize }, () => candidate),
            next: { ...base.next, clippedText: argument.partSize },
          };
        },
      } as unknown as Page;

      let settled = false;
      void collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(FORMER_DEFAULT_TIMEOUT_MS * 6 + TIMER_CLOCK_GRANULARITY_MS);

      // 時間で打ち切らない（ページが応答しないときに戻る守りは、呼び出し側の期限が持つ）。
      expect(calls).toBe(2);
      expect(settled).toBe(false);
    });
  });

  it('rejects a part with more candidates than LAYOUT_COLLECTION_PART_SIZE, and candidates of a list already read (COV-6)', async () => {
    const candidate = clippedCandidate('#clipped');
    const tooMany = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        clippedText: Array.from({ length: LAYOUT_COLLECTION_PART_SIZE + 1 }, () => candidate),
      }),
    } as unknown as Page;
    await expect(collectLayoutEvidence(tooMany, { width: 320, height: STRESS_VIEWPORT_HEIGHT })).rejects.toThrow(
      'Unbounded browser layout list: clippedText',
    );

    let calls = 0;
    const afterRead = {
      evaluate: async () => {
        calls += 1;
        const base = rawLayout(320, STRESS_VIEWPORT_HEIGHT);
        return calls === 1
          ? { ...base, clippedText: [candidate], next: { ...base.next, clippedText: 1 } }
          : { ...base, clippedText: [candidate], boxesOutsideViewport: [outsideCandidate('#late', rect(0, 0, 10, 10))] };
      },
    } as unknown as Page;
    await expect(collectLayoutEvidence(afterRead, { width: 320, height: STRESS_VIEWPORT_HEIGHT })).rejects.toThrow(
      'Unexpected browser layout list after it was read: boxesOutsideViewport',
    );
  });

  it.each([
    'clippedTextNodeScanLimitReachedCount',
    'renderedDescendantScanLimitReachedCount',
  ] as const)('rejects an invalid count in truncation.%s from the browser', async (name) => {
    for (const count of [-1, 1.5, Number.NaN]) {
      const page = {
        evaluate: async () => ({
          ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
          truncation: { ...rawLayout(320, STRESS_VIEWPORT_HEIGHT).truncation, [name]: count },
        }),
      } as unknown as Page;

      await expect(collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT })).rejects.toThrow(
        `truncation.${name}`,
      );
    }
  });

  it.each([-1, 0, 1.5, Number.NaN])('rejects a next position %s that does not move forward from the browser (COV-6)', async (position) => {
    const page = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        next: { ...rawLayout(320, STRESS_VIEWPORT_HEIGHT).next, elementOverlaps: position },
      }),
    } as unknown as Page;

    await expect(collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT })).rejects.toThrow(
      'next.elementOverlaps',
    );
  });
});

describe('layout evidence that avoids false positives (RT12 I1, I2, I3)', () => {
  const layoutWith = (overrides: Record<string, unknown>): Page => ({
    evaluate: async () => ({ ...rawLayout(320, STRESS_VIEWPORT_HEIGHT), ...overrides }),
  }) as unknown as Page;
  const collect = (page: Page) => collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT });

  it('keeps the kind, the horizontal clipping ancestor, and the nearest listed ancestor of an outside candidate', async () => {
    const layout = completeLayout(await collect(layoutWith({
      boxesOutsideViewport: [
        outsideCandidate('#table', rect(0, 0, 900, 40), { kind: 'other', horizontalClipAncestor: 'SCROLLABLE' }),
        outsideCandidate('#cell-link', rect(300, 0, 280, 20), {
          kind: 'link',
          horizontalClipAncestor: 'SCROLLABLE',
          nearestListedAncestorIndex: 0,
        }),
      ],
    })));

    expect(layout.boxesOutsideViewport.map((box) => [box.kind, box.horizontalClipAncestor, box.nearestListedAncestorIndex]))
      .toEqual([['other', 'SCROLLABLE', null], ['link', 'SCROLLABLE', 0]]);
    expect(Object.isFrozen(layout.boxesOutsideViewport[1])).toBe(true);
  });

  it('keeps the table and media kinds of primary elements (RT12r N3)', async () => {
    const layout = completeLayout(await collect(layoutWith({
      boxesOutsideViewport: [
        outsideCandidate('#wide-table', rect(0, 0, 900, 40), { kind: 'table' }),
        outsideCandidate('#wide-frame', rect(0, 60, 600, 40), { kind: 'media' }),
      ],
    })));

    expect(layout.boxesOutsideViewport.map((box) => box.kind)).toEqual(['table', 'media']);
  });

  it('shares the visually hidden size with the rules as the limit of an unrendered descendant (RT12r N5)', () => {
    expect(LAYOUT_THRESHOLDS.maxUnrenderedDescendantDimensionPx).toBe(VISUALLY_HIDDEN_MAX_DIMENSION_PX);
    expect(LAYOUT_THRESHOLDS.clippedTextLineMinOutsideRatio).toBe(0.25);
  });

  it('uses a fixed number of pixels, not the ratio, as the horizontal threshold of a clipped text line (RT12e)', () => {
    expect(LAYOUT_THRESHOLDS.clippedTextLineMaxIgnoredHorizontalOverflowPx).toBe(2);
  });

  it.each([
    ['an unknown horizontal clipping ancestor', { horizontalClipAncestor: 'HIDDEN' }, 'horizontalClipAncestor'],
    ['an unknown kind', { kind: 'carousel' }, 'kind'],
    ['an ancestor index outside the list', { nearestListedAncestorIndex: 1 }, 'nearestListedAncestorIndex'],
    ['an ancestor index of itself', { nearestListedAncestorIndex: 0 }, 'nearestListedAncestorIndex'],
    ['a fractional ancestor index', { nearestListedAncestorIndex: 0.5 }, 'nearestListedAncestorIndex'],
  ])('rejects %s from the browser', async (_name, overrides, message) => {
    await expect(collect(layoutWith({
      boxesOutsideViewport: [outsideCandidate('#box', rect(0, 0, 900, 40), overrides)],
    }))).rejects.toThrow(message);
  });

  it('keeps the horizontal overflow kind of the viewport, and rejects an unknown one (RT12c)', async () => {
    const document = rawLayout(320, STRESS_VIEWPORT_HEIGHT).document;
    for (const viewportHorizontalClip of ['NONE', 'CLIPPED', 'SCROLLABLE'] as const) {
      const layout = completeLayout(await collect(layoutWith({ document: { ...document, viewportHorizontalClip } })));
      expect(layout.document.viewportHorizontalClip).toBe(viewportHorizontalClip);
    }
    for (const invalid of ['hidden', undefined, 0]) {
      await expect(collect(layoutWith({ document: { ...document, viewportHorizontalClip: invalid } })))
        .rejects.toThrow('viewportHorizontalClip');
    }
  });

  it('keeps partiallyClippedText and hasRenderedDescendant, and rejects values that are not booleans', async () => {
    const layout = completeLayout(await collect(layoutWith({
      clippedText: [clippedCandidate('#carousel', { partiallyClippedText: false })],
      zeroSizeInteractive: [{
        selector: '#float-image-link',
        tagName: 'a',
        role: null,
        rect: rect(0, 0, 0, 18),
        visibility: visibleFacts,
        position: 'static',
        zIndex: 'auto',
        overflowX: 'visible',
        overflowY: 'visible',
        hasRenderedDescendant: true,
        truncated: false,
      }],
    })));

    expect(layout.clippedText[0]?.partiallyClippedText).toBe(false);
    expect(layout.zeroSizeInteractive[0]?.hasRenderedDescendant).toBe(true);
    await expect(collect(layoutWith({
      clippedText: [clippedCandidate('#carousel', { partiallyClippedText: 'no' })],
    }))).rejects.toThrow('partiallyClippedText');
    await expect(collect(layoutWith({
      zeroSizeInteractive: [{ ...layout.zeroSizeInteractive[0], hasRenderedDescendant: undefined }],
    }))).rejects.toThrow('hasRenderedDescendant');
  });

  it('keeps clippedToZeroArea of the visibility facts, and rejects a value that is not a boolean (DEF-205)', async () => {
    const hidden = { ...visibleFacts, clippedToZeroArea: true };
    const layout = completeLayout(await collect(layoutWith({
      clippedText: [clippedCandidate('#skip-link', { visibility: hidden })],
    })));

    expect(layout.clippedText[0]?.visibility.clippedToZeroArea).toBe(true);
    await expect(collect(layoutWith({
      clippedText: [clippedCandidate('#skip-link', { visibility: { ...visibleFacts, clippedToZeroArea: 'yes' } })],
    }))).rejects.toThrow('clippedToZeroArea');
  });
});

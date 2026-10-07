import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import { NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE } from '../../src/browser/navigation-diagnostics.js';
import type { NavigationDiagnostics } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import {
  VISUALLY_HIDDEN_MAX_DIMENSION_PX,
  type LayoutCollectionResult,
  type LayoutEvidence,
} from '../../src/core/evidence-types.js';
import {
  LAYOUT_THRESHOLDS,
  STRESS_VIEWPORT_HEIGHT,
  collectLayoutEvidence,
  collectStressLayout,
  type PassiveStressSession,
  type PassiveStressSessionFactory,
  type StressLayoutOptions,
} from '../../src/evidence/layout-collector.js';

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
    truncation: {
      omittedOutsideViewportCount: 0,
      omittedZeroSizeInteractiveCount: 0,
      omittedClippedTextCount: 0,
      omittedFixedHeadingOverlapCount: 0,
      omittedElementOverlapCount: 0,
      omittedFixedElementCount: 0,
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

/**
 * 待たない、ページの読み込みの間隔の待ち（RL-fix。RL の Minor-5）。幅の走査の間隔の待ちは省略できないので、間隔を確かめない
 * テストは、待たないことを、この関数で明示して渡す。
 */
const NO_PACING_WAIT = async (): Promise<number> => 0;

/** 間隔を確かめないテストの、幅の走査の引数。期限は、呼び出し時点から、幅の数 × `defaultTimeoutMs` 後。 */
function unpacedStressOptions(widths: readonly number[]): StressLayoutOptions {
  return { deadlineAtMs: Date.now() + LAYOUT_THRESHOLDS.defaultTimeoutMs * widths.length, beforeNavigation: NO_PACING_WAIT };
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
  it('waits right before the navigation of each width, after its session is created', async () => {
    const events: string[] = [];
    let paced = 0;

    const result = await collectStressLayout(sessionFactory(events), 'https://fixture.test/page', [390, 320], {
      deadlineAtMs: Date.now() + LAYOUT_THRESHOLDS.defaultTimeoutMs,
      beforeNavigation: async () => {
        paced += 1;
        events.push(`pace:${paced}`);
        return 0;
      },
    });

    expect(result.map((entry) => entry.status)).toEqual(['COMPLETE', 'COMPLETE']);
    expect(events).toEqual([
      `create:1:390x${STRESS_VIEWPORT_HEIGHT}`,
      'pace:1',
      'goto:1:https://fixture.test/page',
      'close:1',
      `create:2:320x${STRESS_VIEWPORT_HEIGHT}`,
      'pace:2',
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
    const deadlineAtMs = Date.now() + LAYOUT_THRESHOLDS.defaultTimeoutMs;
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
      deadlineAtMs: Date.now() + LAYOUT_THRESHOLDS.defaultTimeoutMs,
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
      deadlineAtMs: Date.now() + LAYOUT_THRESHOLDS.defaultTimeoutMs,
      beforeNavigation: 'wait' as unknown as () => Promise<number>,
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
 * 偽の page の Context が、CDP の session を開く求めを断るときのメッセージ（D3。診断の記録の設計書 2.2）。偽の page には CDP の session が
 * ないので、ページ本体の要求の観察は始められず、受け口には `NOT_OBSERVED`（理由はこのメッセージ）が渡る。
 */
const FAKE_NO_CDP_SESSION_MESSAGE = 'the fake page has no CDP session';

/**
 * 偽の page の Context が、CDP の session を開く求め（ページ本体の要求の観察の開始）にどう振る舞うか。
 * `REFUSED` は `FAKE_NO_CDP_SESSION_MESSAGE` で断る。`NEVER_OPENS` は、いつまでも開かない（観察の開始の期限の確かめに使う）。
 */
type FakeCdpSession = 'REFUSED' | 'NEVER_OPENS';

/**
 * 事象の受け口の数を記録する、偽の page を持つセッションの factory。n 番目の幅の読み込みは `loads[n - 1]` のとおりに振る舞う。
 * 偽の page の Context は、CDP の session を開く求め（ページ本体の要求の観察の開始。D3）に `cdp:<n>` を記録し、`cdpSession` の
 * とおりに振る舞う（既定は断る）。
 */
function eventEmittingSessionFactory(
  loads: readonly FakeLoad[],
  events: string[],
  cdpSession: FakeCdpSession = 'REFUSED',
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
    const context = {
      newCDPSession: async (): Promise<never> => {
        events.push(`cdp:${id}`);
        if (cdpSession === 'NEVER_OPENS') {
          return neverSettles();
        }
        throw new Error(FAKE_NO_CDP_SESSION_MESSAGE);
      },
    };
    const page = Object.assign(emitter, {
      mainFrame: () => mainFrame,
      isClosed: () => false,
      context: () => context,
      evaluate: async () => rawLayout(viewport.width, viewport.height),
      goto: async (url: string) => {
        events.push(`goto:${id}:${url}:${listeners()}`);
        const request = { isNavigationRequest: () => true, frame: () => mainFrame };
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

/** 偽の page（CDP の session がない）での、ページ本体の要求の観察の結果（D3）。 */
const NOT_OBSERVED_IN_FAKE_PAGE: NavigationDiagnostics = Object.freeze({ status: 'NOT_OBSERVED', reason: FAKE_NO_CDP_SESSION_MESSAGE });

describe('responsive layout stress main frame load observation (site unavailability design 2.1)', () => {
  // D3（診断の記録の設計書 2.2 の 2026-10-07 の改訂）: 受け口には、観測に加えて、各幅の読み込みの間のページ本体の要求の観察の結果を渡す。
  // 観察は、各幅の `goto` の直前に始め（偽の page では CDP の session を開けないので `NOT_OBSERVED`）、`goto` の直後に、結果によらず止める。
  it('passes the observation of the load of each width to afterNavigation (200, 503 and a failure), tracking only during the load', async () => {
    const events: string[] = [];
    const observations: MainFrameLoadObservation[] = [];
    const diagnostics: NavigationDiagnostics[] = [];
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
        afterNavigation: (observation, navigationDiagnostics) => {
          observations.push(observation);
          diagnostics.push(navigationDiagnostics);
        },
      },
    );

    expect(observations).toEqual([
      { navigationOutcome: 'OK', httpStatus: FAKE_STATUS_OK, failureDetail: null },
      { navigationOutcome: 'OK', httpStatus: FAKE_STATUS_SERVICE_UNAVAILABLE, failureDetail: null },
      { navigationOutcome: 'FAILED', httpStatus: null, failureDetail: failureMessage },
    ]);
    expect(observations.every((observation) => Object.isFrozen(observation))).toBe(true);
    // D3: 各幅の読み込み（応答した幅も、失敗した幅も）の観察の結果が渡る。偽の page では観察を始められない。
    expect(diagnostics).toEqual([NOT_OBSERVED_IN_FAKE_PAGE, NOT_OBSERVED_IN_FAKE_PAGE, NOT_OBSERVED_IN_FAKE_PAGE]);
    expect(diagnostics.every((entry) => Object.isFrozen(entry))).toBe(true);
    // 観測を渡しても、幅の結果は今までどおりである（collector は判定をしない）。
    expect(result.map((entry) => [entry.width, entry.status])).toEqual([[390, 'COMPLETE'], [320, 'COMPLETE'], [768, 'FAILED']]);
    expect(result[2]).toMatchObject({ stage: 'NAVIGATION', reason: 'NAVIGATION_FAILED', message: failureMessage });
    // 事象の受け口は、読み込みの前に付け、セッションを閉じる前に外す。観察（CDP の session を開く求め）は、各幅の読み込みの前に始める。
    expect(events).toEqual([
      'cdp:1',
      'goto:1:https://fixture.test/page:request=1,response=1',
      'close:1:request=0,response=0',
      'cdp:2',
      'goto:2:https://fixture.test/page:request=1,response=1',
      'close:2:request=0,response=0',
      'cdp:3',
      'goto:3:https://fixture.test/page:request=1,response=1',
      'close:3:request=0,response=0',
    ]);
  });

  it('passes a TIMEOUT without an HTTP status when the load of a width gets no response before the stress deadline', async () => {
    const events: string[] = [];
    const observations: MainFrameLoadObservation[] = [];
    const diagnostics: NavigationDiagnostics[] = [];

    const result = await collectStressLayout(
      eventEmittingSessionFactory([{ kind: 'NO_RESPONSE' }], events),
      'https://fixture.test/page',
      [320],
      {
        deadlineAtMs: Date.now() + 50,
        beforeNavigation: NO_PACING_WAIT,
        afterNavigation: (observation, navigationDiagnostics) => {
          observations.push(observation);
          diagnostics.push(navigationDiagnostics);
        },
      },
    );

    expect(observations).toEqual([{ navigationOutcome: 'TIMEOUT', httpStatus: null, failureDetail: null }]);
    // D3: 期限切れの幅でも、観察の結果（偽の page では `NOT_OBSERVED`）が渡る。
    expect(diagnostics).toEqual([NOT_OBSERVED_IN_FAKE_PAGE]);
    expect(result[0]).toMatchObject({ width: 320, status: 'FAILED', stage: 'NAVIGATION', reason: 'DEADLINE_EXCEEDED' });
    expect(events).toEqual([
      'cdp:1',
      'goto:1:https://fixture.test/page:request=1,response=1',
      'close:1:request=0,response=0',
    ]);
  });

  // D3R の Minor-1（診断の記録の設計書 2.2「長く待たない」）: 観察の開始は、幅の読み込みの期限と、今から `sessionOpenTimeoutMs` 後の早い方
  // までしか待たない（Passive の観察と同じ）。読み込みの期限は変えない（観察を始められなくても、読み込みは期限まで行う）。
  describe('the deadline of the start of the navigation diagnostics (D3R Minor-1)', () => {
    /** 注入する、観察の開始を待つ上限（ms）。 */
    const SHORT_SESSION_OPEN_TIMEOUT_MS = 50;
    /** 幅の読み込みの期限（ms）。観察の開始がこの期限まで待ってしまう場合に、それと分かるよう、戻るまでの上限より十分に長くする。 */
    const LONG_STRESS_DEADLINE_MS = 3_000;
    /** 観察の開始の期限を過ぎてから戻るまでの余裕を含めた、戻るまでの上限（ms）。 */
    const RETURN_LIMIT_MS = 1_000;

    it('gives up starting the observation sessionOpenTimeoutMs after now, and loads the width as without it', async () => {
      const events: string[] = [];
      const observations: MainFrameLoadObservation[] = [];
      const diagnostics: NavigationDiagnostics[] = [];
      const startedAtMs = Date.now();

      const result = await collectStressLayout(
        eventEmittingSessionFactory([{ kind: 'ANSWER', status: FAKE_STATUS_OK }], events, 'NEVER_OPENS'),
        'https://fixture.test/page',
        [320],
        {
          deadlineAtMs: startedAtMs + LONG_STRESS_DEADLINE_MS,
          beforeNavigation: NO_PACING_WAIT,
          sessionOpenTimeoutMs: SHORT_SESSION_OPEN_TIMEOUT_MS,
          afterNavigation: (observation, navigationDiagnostics) => {
            observations.push(observation);
            diagnostics.push(navigationDiagnostics);
          },
        },
      );
      const elapsedMs = Date.now() - startedAtMs;

      expect(elapsedMs).toBeGreaterThanOrEqual(SHORT_SESSION_OPEN_TIMEOUT_MS);
      expect(elapsedMs).toBeLessThan(RETURN_LIMIT_MS);
      expect(diagnostics).toEqual([{ status: 'NOT_OBSERVED', reason: NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE }]);
      // 読み込みと、幅の結果は、観察を始められなくても今までどおりである。
      expect(observations).toEqual([{ navigationOutcome: 'OK', httpStatus: FAKE_STATUS_OK, failureDetail: null }]);
      expect(result.map((entry) => [entry.width, entry.status])).toEqual([[320, 'COMPLETE']]);
      expect(events).toEqual([
        'cdp:1',
        'goto:1:https://fixture.test/page:request=1,response=1',
        'close:1:request=0,response=0',
      ]);
    });

    it('rejects a sessionOpenTimeoutMs that is not a positive integer before creating a session', async () => {
      let creations = 0;
      const factory: PassiveStressSessionFactory = async () => {
        creations += 1;
        throw new Error('must not create');
      };

      await expect(collectStressLayout(factory, 'https://fixture.test/page', [320], {
        ...unpacedStressOptions([320]),
        sessionOpenTimeoutMs: 0,
        afterNavigation: () => undefined,
      })).rejects.toThrow(RangeError);
      expect(creations).toBe(0);
    });
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

  it('does not start the browser evaluation after the deadline', async () => {
    let evaluations = 0;
    const page = {
      evaluate: async () => {
        evaluations += 1;
        return rawLayout(320, STRESS_VIEWPORT_HEIGHT);
      },
    } as unknown as Page;

    const result = await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT }, {
      deadlineAtMs: Date.now() - 1,
    });

    expect(result).toEqual({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED', layout: null });
    expect(evaluations).toBe(0);
  });

  it('keeps the facts that the browser gathered before stopping at the deadline', async () => {
    const page = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        boxesOutsideViewport: [outsideCandidate('#late', rect(0, 1_000, 100, 20), {
          outside: { left: false, right: false, top: false, bottom: true },
        })],
        incompleteReason: 'DEADLINE_EXCEEDED',
      }),
    } as unknown as Page;

    const result = await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT });

    expect(result.status).toBe('PARTIAL');
    expect(result.status === 'PARTIAL' ? result.reason : undefined).toBe('DEADLINE_EXCEEDED');
    expect(result.layout?.boxesOutsideViewport.map((candidate) => candidate.selector)).toEqual(['#late']);
  });

  it('returns PARTIAL with the facts when the overlap scan reached the comparison limit (R4 M2)', async () => {
    const page = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        truncation: { ...rawLayout(320, STRESS_VIEWPORT_HEIGHT).truncation, overlapComparisonLimitReached: true },
      }),
    } as unknown as Page;

    const result = await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT });

    expect(result.status).toBe('PARTIAL');
    expect(result.status === 'PARTIAL' ? result.reason : undefined).toBe('LAYOUT_COMPARISON_LIMIT_REACHED');
    expect(result.layout?.truncation.overlapComparisonLimitReached).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('keeps the deadline as the reason when the scan also reached the comparison limit (R4 M2)', async () => {
    const page = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        truncation: { ...rawLayout(320, STRESS_VIEWPORT_HEIGHT).truncation, overlapComparisonLimitReached: true },
        incompleteReason: 'DEADLINE_EXCEEDED',
      }),
    } as unknown as Page;

    const result = await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT });

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(result.layout?.truncation.overlapComparisonLimitReached).toBe(true);
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
        }],
      }),
    } as unknown as Page;

    const layout = completeLayout(await collectLayoutEvidence(page, { width: 400, height: 300 }));

    expect(layout.fixedElements[0]).toMatchObject({
      area: 400 * 300,
      viewportIntersectionArea: 200 * 150,
      viewportArea: 400 * 300,
      viewportAreaRatio: 0.25,
    });
    expect(Object.isFrozen(layout.fixedElements[0])).toBe(true);
  });

  it('adds candidates beyond the limit to the omitted count instead of dropping them silently', async () => {
    const extra = 3;
    const candidate = {
      selector: '#zero',
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
    };
    const page = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        zeroSizeInteractive: Array.from(
          { length: LAYOUT_THRESHOLDS.maxZeroSizeInteractiveCandidates + extra },
          () => candidate,
        ),
        truncation: {
          ...rawLayout(320, STRESS_VIEWPORT_HEIGHT).truncation,
          omittedZeroSizeInteractiveCount: 4,
        },
      }),
    } as unknown as Page;

    const layout = completeLayout(await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT }));

    expect(layout.zeroSizeInteractive).toHaveLength(LAYOUT_THRESHOLDS.maxZeroSizeInteractiveCandidates);
    expect(layout.truncation.omittedZeroSizeInteractiveCount).toBe(4 + extra);
    expect(Object.isFrozen(layout.truncation)).toBe(true);
  });

  it.each([
    'omittedElementOverlapCount',
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

  it.each([-1, 1.5, Number.NaN])('rejects an invalid omitted count %s from the browser', async (count) => {
    const page = {
      evaluate: async () => ({
        ...rawLayout(320, STRESS_VIEWPORT_HEIGHT),
        truncation: { ...rawLayout(320, STRESS_VIEWPORT_HEIGHT).truncation, omittedElementOverlapCount: count },
      }),
    } as unknown as Page;

    await expect(collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT })).rejects.toThrow(
      'truncation.omittedElementOverlapCount',
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
});

import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
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

    const result = await collectStressLayout(sessionFactory(events), 'https://fixture.test/page', [390, 320]);

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

      await expect(collectStressLayout(factory, 'https://fixture.test/page', [320, width])).rejects.toThrow(
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

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [390, 320, 768]);

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

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320, 390]);

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

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320]);

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

    const result = await collectStressLayout(factory, 'https://fixture.test/page', [320]);

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

    const rejection = await collectStressLayout(factory, 'https://fixture.test/page', [320]).catch(
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([workError, closeError]);
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

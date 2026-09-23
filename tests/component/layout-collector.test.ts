import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  STRESS_VIEWPORT_HEIGHT,
  collectLayoutEvidence,
  collectStressLayout,
  type PassiveStressSession,
  type PassiveStressSessionFactory,
} from '../../src/evidence/layout-collector.js';

function rawLayout(width: number, height: number) {
  return {
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
    },
    boxesOutsideViewport: [],
    zeroSizeInteractive: [],
    clippedText: [],
    fixedHeadingOverlaps: [],
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

    const result = await collectLayoutEvidence(page, { width: 320, height: STRESS_VIEWPORT_HEIGHT });

    expect(result.document.horizontalOverflowPx).toBe(0);
  });

  it('preserves input order while using a fresh owner-closed session for each width', async () => {
    const events: string[] = [];

    const result = await collectStressLayout(sessionFactory(events), 'https://fixture.test/page', [390, 320]);

    expect(result.map((entry) => entry.width)).toEqual([390, 320]);
    expect(events).toEqual([
      `create:1:390x${STRESS_VIEWPORT_HEIGHT}`,
      'goto:1:https://fixture.test/page',
      'close:1',
      `create:2:320x${STRESS_VIEWPORT_HEIGHT}`,
      'goto:2:https://fixture.test/page',
      'close:2',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0]?.layout.document)).toBe(true);
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

  it('closes once and propagates collection failure without claiming partial success', async () => {
    let closes = 0;
    const factory: PassiveStressSessionFactory = async () => ({
      page: {
        goto: async () => undefined,
        evaluate: async () => { throw new Error('collection failed'); },
      } as unknown as Page,
      close: async () => { closes += 1; },
    });

    await expect(collectStressLayout(factory, 'https://fixture.test/page', [320])).rejects.toThrow(
      'collection failed',
    );
    expect(closes).toBe(1);
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

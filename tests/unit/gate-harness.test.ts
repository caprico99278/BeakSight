// RC18 の M4（C18p）: `withGuardedPassivePage` の `expectNoViolations` の指定。
// - 指定すると、`run` が終わった後（page と Context を閉じる前）に、Safety Ledger の違反が0件であることを確かめる。違反があれば、
//   違反の内容が分かる形で失敗する。閉じる処理は、失敗しても必ず行う。
// - 既定（指定しない）は、確かめない（違反を確かめるテストが、この補助を使うため）。
// ブラウザを使わず、偽の factory で確かめる。
import type { BrowserContext, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';

const VIEWPORT: Viewport = Object.freeze({ width: 800, height: 600 });
const VIOLATION = Object.freeze({ code: 'FRAME_CLASSIFICATION_FAILED', message: 'fake violation for the helper test' });

interface FakeFactory {
  readonly factory: BrowserContextFactory;
  readonly ledger: SafetyLedger;
  /** 偽の factory に届いた呼び出し（届いた順）。 */
  readonly events: string[];
}

/**
 * page と Context を作る処理と閉じる処理を記録する、偽の factory。`onClose` を渡すと、Context を閉じる処理の中で呼ぶ。
 */
function createFakeFactory(onClose?: (ledger: SafetyLedger) => void): FakeFactory {
  const events: string[] = [];
  const ledger = new SafetyLedger();
  let pageClosed = false;
  let contextOpen = true;
  const page = { isClosed: () => pageClosed } as unknown as Page;
  const context = { browser: () => (contextOpen ? {} : null) } as unknown as BrowserContext;
  const factory = {
    createPassiveContext: async () => {
      events.push('createPassiveContext');
      return context;
    },
    createPassivePage: async () => {
      events.push('createPassivePage');
      return page;
    },
    getSafetyLedger: () => ledger,
    closePassivePage: async () => {
      events.push('closePassivePage');
      pageClosed = true;
    },
    closePassiveContext: async () => {
      events.push('closePassiveContext');
      onClose?.(ledger);
      contextOpen = false;
    },
  } as unknown as BrowserContextFactory;
  return { factory, ledger, events };
}

const OPEN_AND_CLOSE = ['createPassiveContext', 'createPassivePage', 'run', 'closePassivePage', 'closePassiveContext'];

describe('withGuardedPassivePage expectNoViolations', () => {
  it('fails with the violation details when the Safety Ledger has a violation, and still closes the page and the Context', async () => {
    const fake = createFakeFactory();

    const outcome = withGuardedPassivePage(fake.factory, VIEWPORT, async (_page, _context, ledger) => {
      fake.events.push('run');
      ledger.recordInvariantViolation(VIOLATION);
      return 'value';
    }, { expectNoViolations: true });

    await expect(outcome).rejects.toThrow(VIOLATION.code);
    await expect(outcome).rejects.toThrow(VIOLATION.message);
    expect(fake.events).toEqual(OPEN_AND_CLOSE);
  });

  it('passes and returns the result of run when the Safety Ledger has no violation', async () => {
    const fake = createFakeFactory();

    const result = await withGuardedPassivePage(fake.factory, VIEWPORT, async () => {
      fake.events.push('run');
      return 'value';
    }, { expectNoViolations: true });

    expect(result).toBe('value');
    expect(fake.events).toEqual(OPEN_AND_CLOSE);
  });

  it('checks before closing: a violation recorded while closing is not counted', async () => {
    const fake = createFakeFactory((ledger) => ledger.recordInvariantViolation(VIOLATION));

    const result = await withGuardedPassivePage(fake.factory, VIEWPORT, async () => {
      fake.events.push('run');
      return 'value';
    }, { expectNoViolations: true });

    expect(result).toBe('value');
    expect(fake.events).toEqual(OPEN_AND_CLOSE);
    expect(fake.ledger.snapshot().invariantViolationCount).toBe(1);
  });

  it('does not check the violations by default, because tests that expect violations use this helper', async () => {
    const fake = createFakeFactory();

    const result = await withGuardedPassivePage(fake.factory, VIEWPORT, async (_page, _context, ledger) => {
      fake.events.push('run');
      ledger.recordInvariantViolation(VIOLATION);
      return 'value';
    });

    expect(result).toBe('value');
    expect(fake.events).toEqual(OPEN_AND_CLOSE);
    expect(fake.ledger.snapshot().invariantViolations).toEqual([VIOLATION]);
  });
});

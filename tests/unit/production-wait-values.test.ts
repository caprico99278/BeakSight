// TEST-TIME-B（条件 3）・RB-2: 観察の窓の一式（`src/core/observation-windows.ts`）の本番の値。差し込む口は部品を作るときの引数（`observationWindows`）だけで、
// 省略すると本番の値になる。本番の入口が口を渡さないことは `tests/architecture/worker-login-hooks.test.ts` の (n)・(p)、一式の外に決め打ちの待ちを
// 置かないことは `tests/architecture/observation-windows-owner.test.ts`。
import { describe, expect, it } from 'vitest';
import { PRODUCTION_OBSERVATION_WINDOWS, observationWindowsOf } from '../../src/core/observation-windows.js';

/** 本番の値の表（ms）。値を変えるときは、設計者の判断と、この表の書き換えが要る。 */
const PRODUCTION_TABLE = {
  pageSettle: { pollIntervalMs: 100, stableWindowMs: 500, openDataRequestQuietMs: 5_000 },
  scroll: { stepWaitMs: 250, stableWindowMs: 500 },
  discoverySettle: { timeoutMs: 5_000, networkQuietMs: 500, pollIntervalMs: 50, probeIntervalMs: 250, responseBodyGraceMs: 2_000, busyTimeoutMs: 3_000 },
  screenHeading: { waitMs: 2_000, pollMs: 100 },
  notification: { dismissWaitMs: 1_000, dismissPollIntervalMs: 100, discoveryBudgetMs: 15_000 },
  afterPress: { probeQuietWaitMs: 2_000, pressQuietWindowMs: 5_000 },
  beforeClose: { auditSendCloseSettleMs: 1_000 },
  write: { submissionWindowSettleMs: 300, resultPollIntervalMs: 250, apiValueSettleIntervalMs: 500, apiInputAppearPollMs: 100 },
  login: { submissionWindowSettleMs: 300, automatedPollIntervalMs: 250, manualPollIntervalMs: 500, fieldsPollMs: 100 },
  watch: { quietLimitMs: 180_000, domPollIntervalMs: 1_000, pacingMarkIntervalMs: 1_000 },
};

describe('RB-2: the production values of the observation windows', () => {
  it('keeps the production windows at the table and uses them when nothing is injected', () => {
    expect(PRODUCTION_OBSERVATION_WINDOWS).toStrictEqual(PRODUCTION_TABLE);
    expect(Object.isFrozen(PRODUCTION_OBSERVATION_WINDOWS.afterPress)).toBe(true);
    expect(observationWindowsOf(undefined)).toBe(PRODUCTION_OBSERVATION_WINDOWS);
  });

  it('replaces only the injected windows and rejects a value or a name that is not a window', () => {
    const windows = observationWindowsOf({ afterPress: { pressQuietWindowMs: 300 } });
    expect(windows.afterPress).toStrictEqual({ probeQuietWaitMs: 2_000, pressQuietWindowMs: 300 });
    expect(windows.beforeClose).toStrictEqual(PRODUCTION_TABLE.beforeClose);
    for (const overrides of [{ afterPress: { pressQuietWindowMs: 0 } }, { afterPress: { pressQuietWindowMs: 1.5 } }, { afterPress: { pressQuietMs: 300 } }, { other: {} }]) {
      expect(() => observationWindowsOf(overrides as never), JSON.stringify(overrides)).toThrow(RangeError);
    }
  });
});

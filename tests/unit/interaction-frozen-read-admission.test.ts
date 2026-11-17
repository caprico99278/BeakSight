import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { guardFrozenReadOptionOf } from '../../src/browser/context-factory.js';
import { admitsFrozenReads, installPassiveRequestGuard } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { SubmissionObservation } from '../../src/safety/submission-observation.js';

const createSubmissionObservation = (): SubmissionObservation =>
  new SubmissionObservation({ approvedApiOrigins: [], approvedTestOrigins: [], allowedOrigins: ['https://example.test'] });

/**
 * L10 の後の安全の側の設計の変更（設計者の判断）: Isolated Interaction Context でも、凍結の段で、凍結の読み取りの判定（`isFrozenReadAdmissible`）に当たる
 * 読み取り（GET・HEAD。main frame の移動でない。許可 Origin。資格情報・危険な語なし）を、監査の段と同じ判定にかけて通す。書き込み・削除・資格情報・
 * main frame の移動は、今どおり凍結で止める（判定の部品は変えない）。押した後に fetch でデータが届いて開く部品を、確かめられるようにする。
 */
describe('frozen reads in the Isolated Interaction Context', () => {
  it('admits frozen reads for the Interaction Context guard and the observing PRIMARY guard only', () => {
    expect(admitsFrozenReads({ admitFrozenReads: true })).toBe(true);
    expect(admitsFrozenReads({ submissionObservation: createSubmissionObservation() })).toBe(true);
    expect(admitsFrozenReads({})).toBe(false);
  });

  it('asks the guard of the Interaction Context, and no other context, to admit frozen reads', () => {
    expect(guardFrozenReadOptionOf('INTERACTION')).toEqual({ admitFrozenReads: true });
    expect(guardFrozenReadOptionOf('PASSIVE')).toEqual({});
  });

  it('does not combine the frozen read admission with the login stage or the write stage', async () => {
    const context = {} as BrowserContext;
    await expect(installPassiveRequestGuard(context, new SafetyLedger(), new Set(['https://example.test']), {
      admitFrozenReads: true,
      loginStage: { loginPostEndpoints: [], remainingPosts: 1 },
    } as never)).rejects.toThrow(/frozen read admission/u);
  });
});

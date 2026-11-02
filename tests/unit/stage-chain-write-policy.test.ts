// OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'・D8'、4.1.2 の R2）: まとめて実行の最後の書き込みの段の決まり
// （`src/control/job/stage-chain-policy.ts`）。
// - 対象: 承認した（チェックした）登録のシナリオと、その台帳に結ぶ承認した更新のシナリオ。
// - 順: 画面ごとに登録 →（登録が照合まで済んで番号が取れたら）更新。1 つの画面につき登録 1 件と更新 1 件まで。
// - 止める: 結果が分からない、安全の違反、ログインの切れ（ログインし直さない）、止める要求、改訂の変化。照合できなかった・送らなかった画面の後は次へ。
import { describe, expect, it } from 'vitest';
import {
  CHAIN_STOP_REASONS,
  chainWriteAdvanceDecisionOf,
  chainWriteTargetsOf,
  nextChainWriteStepOf,
  type ChainWriteAdvanceInput,
} from '../../src/control/job/stage-chain-policy.js';

const fact = (scenarioId: string, kind: 'CREATE' | 'UPDATE', approved: boolean, ledgerScenarioId: string | null = null) =>
  ({ scenarioId, kind, approved, ledgerScenarioId });

describe('OP-2: the targets and the order of the write stages', () => {
  it('takes the approved creates with the approved update bound to each, in the scenario order', () => {
    expect(chainWriteTargetsOf([
      fact('c1', 'CREATE', true), fact('u1', 'UPDATE', true, 'c1'), fact('c2', 'CREATE', false), fact('u2', 'UPDATE', true, 'c2'),
      fact('c3', 'CREATE', true), fact('u3', 'UPDATE', false, 'c3'),
    ])).toEqual([{ createScenarioId: 'c1', updateScenarioId: 'u1' }, { createScenarioId: 'c3', updateScenarioId: null }]);
    expect(chainWriteTargetsOf([fact('u1', 'UPDATE', true, 'c1')])).toEqual([]);
  });

  it('creates then updates each screen once, and skips the update when the create gave no record id', () => {
    const targets = [{ createScenarioId: 'c1', updateScenarioId: 'u1' }, { createScenarioId: 'c2', updateScenarioId: null }];
    const first = nextChainWriteStepOf(targets, null);
    expect(first).toEqual({ targetIndex: 0, kind: 'CREATE' });
    expect(nextChainWriteStepOf(targets, { step: { targetIndex: 0, kind: 'CREATE' }, createRecordId: '1002' })).toEqual({ targetIndex: 0, kind: 'UPDATE' });
    expect(nextChainWriteStepOf(targets, { step: { targetIndex: 0, kind: 'CREATE' }, createRecordId: null })).toEqual({ targetIndex: 1, kind: 'CREATE' });
    expect(nextChainWriteStepOf(targets, { step: { targetIndex: 0, kind: 'UPDATE' }, createRecordId: null })).toEqual({ targetIndex: 1, kind: 'CREATE' });
    expect(nextChainWriteStepOf(targets, { step: { targetIndex: 1, kind: 'CREATE' }, createRecordId: '1003' })).toBeNull();
    expect(nextChainWriteStepOf([], null)).toBeNull();
  });
});

describe('OP-2: whether the remaining writes continue after a write stage', () => {
  const input = (overrides: Partial<ChainWriteAdvanceInput> = {}): ChainWriteAdvanceInput => ({
    stopRequested: false, result: 'VERIFIED', stageRunStatus: 'COMPLETE', sessionLost: false, profileRevisionUnchanged: true, ...overrides,
  });

  it('continues after a verified, a blocked, a failed or a partial result', () => {
    for (const result of ['VERIFIED', 'BLOCKED', 'FAILED', 'PARTIAL']) {
      expect(chainWriteAdvanceDecisionOf(input({ result })), result).toEqual({ kind: 'CONTINUE' });
    }
  });

  it('stops the remaining writes on an unknown result, a safety violation, a lost login, a stop or a changed revision', () => {
    expect(CHAIN_STOP_REASONS).toContain('WRITE_RESULT_UNKNOWN');
    expect(chainWriteAdvanceDecisionOf(input({ result: 'UNKNOWN' }))).toEqual({ kind: 'STOP', reason: 'WRITE_RESULT_UNKNOWN' });
    expect(chainWriteAdvanceDecisionOf(input({ result: null }))).toEqual({ kind: 'STOP', reason: 'WRITE_RESULT_UNKNOWN' });
    expect(chainWriteAdvanceDecisionOf(input({ stageRunStatus: 'ABORTED_BY_SAFETY' }))).toEqual({ kind: 'STOP', reason: 'SAFETY_VIOLATION' });
    expect(chainWriteAdvanceDecisionOf(input({ sessionLost: true }))).toEqual({ kind: 'STOP', reason: 'SESSION_LOST' });
    expect(chainWriteAdvanceDecisionOf(input({ stopRequested: true }))).toEqual({ kind: 'STOP', reason: 'USER_STOPPED' });
    expect(chainWriteAdvanceDecisionOf(input({ profileRevisionUnchanged: false }))).toEqual({ kind: 'STOP', reason: 'PROFILE_REVISION_CHANGED' });
  });
});

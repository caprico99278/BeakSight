// FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1、5 章の 2026-10-22 の FM2d の Blocker の行）: まとめて実行の決まり
// （`src/control/job/stage-chain-policy.ts`。純粋な関数と閉じた一覧だけ）。
// - 段の並びはモードで決める（`TEST_AUTH_PASSIVE`: 監査 → 発見 → READ、`TEST_APPROVED_WRITE`: 発見 → READ、公開の監査: なし）。
// - 次の段へ進むか: 進むのは `COMPLETE` と、止める理由のない `PARTIAL`（ページ・時間の上限、ページ単位の理由）。止める理由は閉じた一覧（利用者の停止、Safety の
//   違反、サイトの不調、セッションの切れ、`FAILED`、サービスの要求の上限、改訂の変化）。
// - READ の確かめは、定義が 1 件以上のときだけ。0 件なら「行わなかった」（失敗にしない）。
import { describe, expect, it } from 'vitest';
import { INCOMPLETE_REASON_CODES } from '../../src/core/contracts.js';
import {
  CHAIN_REASON_CODE_DECISIONS,
  CHAIN_STOP_REASONS,
  chainAdvanceDecisionOf,
  chainReadCheckDecisionOf,
  chainStagesOfMode,
  type ChainAdvanceInput,
} from '../../src/control/job/stage-chain-policy.js';

const ran = (overrides: Partial<ChainAdvanceInput> = {}): ChainAdvanceInput => ({
  stopRequested: false,
  outcomeRan: true,
  stageResultValid: true,
  stageRunStatus:'COMPLETE',
  incompleteReasonCodes: [],
  sessionLost: false,
  profileRevisionUnchanged: true,
  ...overrides,
});

describe('FM2d: the stages of the chained run by the mode', () => {
  it('chains the audit, the discovery and the READ check in TEST_AUTH_PASSIVE, and the discovery and the READ check in TEST_APPROVED_WRITE', () => {
    expect(chainStagesOfMode('TEST_AUTH_PASSIVE')).toEqual(['AUDIT', 'DISCOVERY', 'READ_CHECK']);
    expect(chainStagesOfMode('TEST_APPROVED_WRITE')).toEqual(['DISCOVERY', 'READ_CHECK']);
    expect(chainStagesOfMode('PUBLIC_PASSIVE')).toBeNull();
  });
});

describe('FM2d: whether the chained run goes to the next stage', () => {
  it('continues after COMPLETE, and after PARTIAL by the page or the time limit and by page level reasons', () => {
    expect(chainAdvanceDecisionOf(ran())).toEqual({ kind: 'CONTINUE' });
    for (const codes of [['MAX_PAGES_REACHED'], ['MAX_RUNTIME_REACHED'], ['MAX_DEPTH_REACHED'], ['NAVIGATION_FAILED', 'COLLECTOR_INCOMPLETE']] as const) {
      expect(chainAdvanceDecisionOf(ran({ stageRunStatus:'PARTIAL', incompleteReasonCodes: codes })), codes.join()).toEqual({ kind: 'CONTINUE' });
    }
  });

  it.each([
    ['the user stop', ran({ stopRequested: true }), 'USER_STOPPED'],
    ['the run interrupted', ran({ stageRunStatus:'PARTIAL', incompleteReasonCodes: ['RUN_INTERRUPTED'] }), 'USER_STOPPED'],
    ['the safety violation', ran({ stageRunStatus:'ABORTED_BY_SAFETY', incompleteReasonCodes: ['SAFETY_INVARIANT_VIOLATION'] }), 'SAFETY_VIOLATION'],
    ['the safety violation abort', ran({ stageRunStatus:'PARTIAL', incompleteReasonCodes: ['SAFETY_VIOLATION_ABORT'] }), 'SAFETY_VIOLATION'],
    ['the aborted by safety status', ran({ stageRunStatus:'ABORTED_BY_SAFETY' }), 'SAFETY_VIOLATION'],
    ['the site unavailable', ran({ stageRunStatus:'PARTIAL', incompleteReasonCodes: ['SITE_UNAVAILABLE'] }), 'SITE_UNAVAILABLE'],
    ['the session lost', ran({ stageRunStatus:'PARTIAL', incompleteReasonCodes: ['AUTH_SESSION_LOST'] }), 'SESSION_LOST'],
    ['the session lost state', ran({ stageRunStatus:'PARTIAL', sessionLost: true }), 'SESSION_LOST'],
    ['the service request limit', ran({ stageRunStatus:'PARTIAL', incompleteReasonCodes: ['MAX_PAGES_REACHED', 'SERVICE_REQUEST_LIMIT_REACHED'] }),
      'SERVICE_REQUEST_LIMIT_REACHED'],
    ['FAILED', ran({ stageRunStatus:'FAILED', incompleteReasonCodes: ['PREFLIGHT_FAILED'] }), 'STAGE_FAILED'],
    ['the stage that did not run', ran({ outcomeRan: false, stageRunStatus:null }), 'STAGE_FAILED'],
    ['the stage result that cannot be read', ran({ stageResultValid: false }), 'STAGE_FAILED'],
    ['the profile revision changed', ran({ profileRevisionUnchanged: false }), 'PROFILE_REVISION_CHANGED'],
  ] as const)('stops by %s', (_case, input, reason) => {
    expect(chainAdvanceDecisionOf(input)).toEqual({ kind: 'STOP', reason });
    expect(CHAIN_STOP_REASONS).toContain(reason);
  });

  // FM2R の I-4: 一覧にない理由で「進む」に倒れない。すべての理由のコードを、止める理由か「進む」に分ける（型で強制）。Run 単位の理由は止める。
  it.each([
    ['CHECKPOINT_WRITE_FAILED'], ['SAFETY_LEDGER_TRUNCATED'], ['UNHANDLED_FAILURE'], ['EXECUTION_INCOMPLETE'], ['REQUIRED_ARTIFACT_INVALID'],
    ['PREFLIGHT_FAILED'], ['RUN_DIRECTORY_UNAVAILABLE'],
    ['REQUIRED_WORK_SKIPPED'], ['REQUIRED_WORK_BLOCKED'], ['REQUIRED_WORK_TIMED_OUT'], ['REQUIRED_WORK_NOT_OBSERVED'], ['REQUIRED_WORK_NOT_VERIFIED'],
    ['REQUIRED_WORK_FAILED'],
  ] as const)('stops by the run level reason %s (the stage failed)', (code) => {
    expect(chainAdvanceDecisionOf(ran({ stageRunStatus: 'PARTIAL', incompleteReasonCodes: [code] }))).toEqual({ kind: 'STOP', reason: 'STAGE_FAILED' });
  });

  it('classifies every incomplete reason code (no code falls back to continue unnoticed)', () => {
    expect(Object.keys(CHAIN_REASON_CODE_DECISIONS).sort()).toEqual([...INCOMPLETE_REASON_CODES].sort());
    const continuing = INCOMPLETE_REASON_CODES.filter((code) => CHAIN_REASON_CODE_DECISIONS[code] === 'CONTINUE');
    expect(continuing).toEqual([
      'DEADLINE_EXCEEDED', 'EVALUATION_FAILED', 'PAGE_CLOSED', 'NAVIGATION_FAILED', 'DOM_READINESS_FAILED', 'SCROLL_TARGET_UNRESOLVED', 'SCROLL_NOT_ADVANCED',
      'INNER_SCROLL_CONTAINER_NOT_TRAVERSED', 'INNER_SCROLL_SCAN_LIMIT_REACHED', 'SCROLL_TARGET_UNSTABLE', 'POSITION_NOT_AT_ORIGIN', 'LAYOUT_COMPARISON_LIMIT_REACHED',
      'RESOURCE_LIMIT_REACHED', 'INVALID_BROWSER_DATA', 'PAGE_NAVIGATION_LIMIT_REACHED', 'PAGE_SUBRESOURCE_LIMIT_REACHED', 'MAX_PAGES_REACHED', 'MAX_DEPTH_REACHED',
      'MAX_RUNTIME_REACHED', 'COLLECTOR_INCOMPLETE', 'RULE_EVALUATION_FAILED', 'PAGE_CRASHED',
    ]);
    // 一覧にない値（型の外から来たもの）は、止める側に倒す。
    expect(chainAdvanceDecisionOf(ran({ stageRunStatus: 'PARTIAL', incompleteReasonCodes: ['NOT_A_CODE' as never] })))
      .toEqual({ kind: 'STOP', reason: 'STAGE_FAILED' });
  });

  it('puts the user stop and the safety violation before the other reasons', () => {
    expect(chainAdvanceDecisionOf(ran({ stopRequested: true, stageRunStatus:'ABORTED_BY_SAFETY' }))).toEqual({ kind: 'STOP', reason: 'USER_STOPPED' });
    expect(chainAdvanceDecisionOf(ran({ stageRunStatus:'ABORTED_BY_SAFETY', sessionLost: true, profileRevisionUnchanged: false })))
      .toEqual({ kind: 'STOP', reason: 'SAFETY_VIOLATION' });
  });

  it('has the closed list of the stop reasons', () => {
    expect(CHAIN_STOP_REASONS).toEqual([
      'USER_STOPPED',
      'SAFETY_VIOLATION',
      'SESSION_LOST',
      'SITE_UNAVAILABLE',
      'SERVICE_REQUEST_LIMIT_REACHED',
      'STAGE_FAILED',
      'PROFILE_REVISION_CHANGED',
      'NEXT_STAGE_REJECTED',
    ]);
  });
});

describe('FM2d: the READ check stage needs a definition', () => {
  it('runs the READ check with one or more definitions, and does not run it (not a failure) with none', () => {
    expect(chainReadCheckDecisionOf(1)).toBe('RUN');
    expect(chainReadCheckDecisionOf(0)).toBe('NOT_NEEDED');
  });
});

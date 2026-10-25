/**
 * T44e（Task 44 の設計書 P2-7）: ジョブの画面の「次にできること」のカタログ（`LOCAL_UI_JOB_NEXT_STEPS`）。網羅は `catalog-coverage.ts` が型で確かめ、ここでは
 * 測りの記録（`T44a-baseline.md` の 3.3）の区分 B の 13 の終わり方と、区分 A の Run の理由に、次にできることがあることを確かめる。
 * - 区分 B: 監査の `ABORTED_BY_SAFETY`（Run の状態）・`RUN_DIRECTORY_UNAVAILABLE`・`RESUME_UNAVAILABLE`（終わり方）、入口の確かめの 5 つの終わり方、発見の上限の 3 つ、
 *   READ の確かめの上限の 2 つ。
 * - 区分 A: 監査の 1 回の実行の終わり方（時間の上限、サイトの不調、サービスへの要求の上限など）と、Run の理由（ページの上限、始める前の確認など）。
 * - 利用者が自分で止めたもの以外の、成功でない終わり方には、文がある。成功の終わり方には、文がない（`null`）。
 */
import { describe, expect, it } from 'vitest';
import { DISCOVERY_END_REASONS, READ_CHECK_END_REASONS } from '../../../src/control/discovery-view.js';
import { ENTRY_CHECK_END_REASONS } from '../../../src/control/entry-check.js';
import { WORKER_OUTCOME_KINDS } from '../../../src/control/worker-protocol.js';
import { INCOMPLETE_REASON_CODES, RUN_EXECUTION_END_REASONS, RUN_STATUSES } from '../../../src/core/contracts.js';
import { INCOMPLETE_REASON_NEXT_STEPS, LOCAL_UI_JOB_NEXT_STEPS } from '../../../src/presentation/messages.js';
import { runReasonNextStepOf } from '../src/display/labels';

const steps = LOCAL_UI_JOB_NEXT_STEPS;

/** 文があるか（空でない文字列）。 */
const hasText = (value: string | null | undefined): boolean => typeof value === 'string' && value.length > 0;

describe('T44e: the next steps on the job screen', () => {
  it('has the next steps of the 13 endings without them (B of the baseline 3.3)', () => {
    const b: readonly (string | null | undefined)[] = [
      steps.runStatuses.ABORTED_BY_SAFETY,
      steps.endKinds.RUN_DIRECTORY_UNAVAILABLE,
      steps.endKinds.RESUME_UNAVAILABLE,
      steps.entryCheckEndReasons.LEFT_ALLOWED_ORIGINS,
      steps.entryCheckEndReasons.READ_FAILED,
      steps.entryCheckEndReasons.NAVIGATION_FAILED,
      steps.entryCheckEndReasons.PREFLIGHT_FAILED,
      steps.entryCheckEndReasons.SAFETY_VIOLATION,
      steps.discoveryEndReasons.MAX_PAGES_REACHED,
      steps.discoveryEndReasons.MAX_RUNTIME_REACHED,
      steps.discoveryEndReasons.SERVICE_REQUEST_LIMIT_REACHED,
      steps.readCheckEndReasons.MAX_RUNTIME_REACHED,
      steps.readCheckEndReasons.SERVICE_REQUEST_LIMIT_REACHED,
    ];
    expect(b).toHaveLength(13);
    expect(b.every(hasText)).toBe(true);
  });

  it('has the next steps of the run endings and the run reasons the screen did not show (A of the baseline 3.3)', () => {
    for (const reason of ['STOPPED_BY_RUNTIME_LIMIT', 'STOPPED_BY_SITE_UNAVAILABLE', 'STOPPED_BY_SERVICE_REQUEST_LIMIT', 'STOPPED_BY_SAFETY_VIOLATION'] as const) {
      expect(hasText(steps.runExecutionEndReasons[reason]), reason).toBe(true);
    }
    for (const reason of ['MAX_PAGES_REACHED', 'MAX_RUNTIME_REACHED', 'SITE_UNAVAILABLE', 'SERVICE_REQUEST_LIMIT_REACHED', 'PREFLIGHT_FAILED'] as const) {
      expect(hasText(steps.runReasons[reason]), reason).toBe(true);
    }
    expect(hasText(steps.discoveryEndReasons.PREFLIGHT_FAILED)).toBe(true);
    expect(hasText(steps.readCheckEndReasons.PREFLIGHT_FAILED)).toBe(true);
    // ページの上限と時間の上限は、画面の「監査の負荷」へ導く（P2-1）。
    expect(steps.runReasons.MAX_PAGES_REACHED).toContain('監査の負荷');
    expect(steps.runExecutionEndReasons.STOPPED_BY_RUNTIME_LIMIT).toContain('監査の負荷');
    expect(steps.runExecutionEndReasons.STOPPED_BY_RUNTIME_LIMIT).toContain('前回の続きから再開する');
  });

  it('has an entry for every code, with no text for the successful endings', () => {
    expect(Object.keys(steps.runExecutionEndReasons).sort()).toEqual([...RUN_EXECUTION_END_REASONS].sort());
    expect(Object.keys(steps.runStatuses).sort()).toEqual([...RUN_STATUSES].sort());
    expect(Object.keys(steps.endKinds).sort()).toEqual([...WORKER_OUTCOME_KINDS].sort());
    expect(Object.keys(steps.discoveryEndReasons).sort()).toEqual([...DISCOVERY_END_REASONS].sort());
    expect(Object.keys(steps.readCheckEndReasons).sort()).toEqual([...READ_CHECK_END_REASONS].sort());
    expect(Object.keys(steps.entryCheckEndReasons).sort()).toEqual([...ENTRY_CHECK_END_REASONS].sort());
    expect(steps.runExecutionEndReasons.COMPLETED).toBeNull();
    expect(steps.runStatuses.COMPLETE).toBeNull();
    expect(steps.endKinds.RAN).toBeNull();
    expect(steps.discoveryEndReasons.COMPLETED).toBeNull();
    expect(steps.readCheckEndReasons.COMPLETED).toBeNull();
    expect(steps.entryCheckEndReasons.READ).toBeNull();
  });
});

// T44h の判断 (1)（Task 44 の設計書の履歴の「T44h の測りとユーザーの判断」の行）: ジョブの画面の Run の理由は、閉じた一覧の外の理由（`UNHANDLED_FAILURE` など）を
// 含め、どれも次にできることを出す。閉じた一覧の理由は画面の文（画面の操作を書く）、ほかは HTML レポートと同じ文。
describe('T44h (1): the next steps of every run reason on the job screen', () => {
  it('gives a next step to every reason, the screen text for the closed list and the report text for the others', () => {
    const screenReasons = steps.runReasons as Partial<Record<string, string>>;
    for (const code of INCOMPLETE_REASON_CODES) {
      const next = runReasonNextStepOf(code);
      expect(hasText(next), code).toBe(true);
      expect(next, code).toBe(screenReasons[code] ?? INCOMPLETE_REASON_NEXT_STEPS[code]);
    }
    for (const code of ['UNHANDLED_FAILURE', 'REQUIRED_ARTIFACT_INVALID', 'EXECUTION_INCOMPLETE', 'SAFETY_LEDGER_TRUNCATED', 'SAFETY_INVARIANT_VIOLATION'] as const) {
      expect(runReasonNextStepOf(code), code).toBe(INCOMPLETE_REASON_NEXT_STEPS[code]);
    }
    expect(runReasonNextStepOf('MAX_PAGES_REACHED')).toBe(steps.runReasons.MAX_PAGES_REACHED);
  });
});

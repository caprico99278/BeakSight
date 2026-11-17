// L5（INV-LIMITS の表 A の T11・T21。設計者の判断 2026-11-10）: 見るだけの点検の操作の期限を、L0 の進みの見張りに替える。ブラウザを使わない。
// - 見張りが終えた候補は `NOT_VERIFIABLE` で、理由は `STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`（Interaction の理由の閉じた一覧とスキーマに足す）。
// - 後片付けの期限は、利用者が `interactionTimeoutMs` を指定していないとき、操作の期限から切り離した自前の定数にする（BeakSight 自身の処理の守り）。
import { describe, expect, it } from 'vitest';
import {
  INTERACTION_LEGACY_NOT_VERIFIABLE_REASON_CODES,
  INTERACTION_NOT_VERIFIABLE_REASON_CODES,
  INTERACTION_REASON_CODES,
} from '../../src/core/evidence-types.js';
import {
  INTERACTION_NOT_VERIFIABLE_REASONS as INTERACTION_NOT_VERIFIABLE_KIND_BY_REASON,
  interactionFreezeEventRecorded,
  interactionStageEndReasonOf,
} from '../../src/interaction/isolated-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { INTERACTION_CLEANUP_TIMEOUT_MS, interactionTimeoutsOf } from '../../src/orchestration/page-auditor.js';
import { INTERACTION_REASON_DESCRIPTIONS } from '../../src/presentation/messages.js';
import { createTestConfig } from '../helpers/test-config.js';

describe('L5: the interaction ends by the progress watch', () => {
  it('has the two reasons of the progress watch end in the closed list of the interaction reasons', () => {
    expect(INTERACTION_NOT_VERIFIABLE_REASON_CODES).toEqual(expect.arrayContaining(['STAGE_UNRESPONSIVE', 'STAGE_NEVER_QUIET']));
    expect(INTERACTION_REASON_CODES).toEqual(expect.arrayContaining(['STAGE_UNRESPONSIVE', 'STAGE_NEVER_QUIET']));
    expect(INTERACTION_NOT_VERIFIABLE_KIND_BY_REASON.STAGE_UNRESPONSIVE).toBe('CHECK_NOT_COMPLETED');
    expect(INTERACTION_NOT_VERIFIABLE_KIND_BY_REASON.STAGE_NEVER_QUIET).toBe('CHECK_NOT_COMPLETED');
    expect(typeof INTERACTION_REASON_DESCRIPTIONS.STAGE_UNRESPONSIVE).toBe('string');
  });

  it('turns the end of the watch into the interaction reason, and nothing else', () => {
    const ended = (reason: unknown): AbortSignal => {
      const controller = new AbortController();
      controller.abort(reason);
      return controller.signal;
    };
    expect(interactionStageEndReasonOf(ended('STAGE_UNRESPONSIVE'))).toBe('STAGE_UNRESPONSIVE');
    expect(interactionStageEndReasonOf(ended('STAGE_NEVER_QUIET'))).toBe('STAGE_NEVER_QUIET');
    expect(interactionStageEndReasonOf(new AbortController().signal)).toBeNull();
    expect(interactionStageEndReasonOf(undefined)).toBeNull();
  });

  it('cuts the cleanup timeout off the interaction timeout unless the user gave one', () => {
    const unspecified = interactionTimeoutsOf(createTestConfig('http://127.0.0.1:1', '/'));
    expect(unspecified).toMatchObject({ openEnded: true, cleanupTimeoutMs: INTERACTION_CLEANUP_TIMEOUT_MS });
    const specified = interactionTimeoutsOf(createTestConfig('http://127.0.0.1:1', '/', { crawl: { interactionTimeoutMs: 4_000, navigationTimeoutMs: 9_000 } }));
    expect(specified).toEqual({ openEnded: false, navigationTimeoutMs: 9_000, timeoutMs: 4_000, cleanupTimeoutMs: 4_000 });
  });
});

// SPEC-5（設計書 2026-11-14 5.1）: 押した後の確かめを 1 回の観察で決める。NOT_VERIFIABLE の理由は、今の版が書くコードと、前の版だけが書いた
// 読むだけのコード（中断した Run の再開と前の記録を読むため）の和。今の版は、読むだけのコードを書かない。
describe('SPEC-5: the written and the read-only reasons of NOT_VERIFIABLE', () => {
  it('writes no read-only code, and reads every code', () => {
    const readOnly: readonly string[] = INTERACTION_LEGACY_NOT_VERIFIABLE_REASON_CODES;
    const written = Object.keys(INTERACTION_NOT_VERIFIABLE_KIND_BY_REASON);
    expect(written.filter((code) => readOnly.includes(code))).toEqual([]);
    expect([...written, ...readOnly].sort()).toEqual([...INTERACTION_NOT_VERIFIABLE_REASON_CODES].sort());
    expect(readOnly).toEqual(expect.arrayContaining(['PERSISTENCE_CHECK_DEADLINE', 'GEOMETRY_ONLY_CHANGED', 'RETAINED_INSPECTION_DOM_WORK_EXHAUSTED']));
  });
});

// SAFE-2 の 4 の後: 凍結の後の `window.open` の外部スキームは、frame の判定の失敗（`frameClassificationFailures`）にだけ残る。押下の結果を決めるときに、凍結の後の
// その記録も、凍結の後の作用として見る（BLOCKED_BY_SAFETY）。凍結の前の記録は見ない。
describe('the frame classification failure after the freeze blocks the press', () => {
  it('counts only the failures after the freeze', () => {
    const after = new SafetyLedger();
    after.recordFrameClassificationFailure({ url: 'mailto:a@example.test', phase: 'INTERACTION' });
    const before = new SafetyLedger();
    before.recordFrameClassificationFailure({ url: 'mailto:a@example.test', phase: 'PASSIVE' });
    expect(interactionFreezeEventRecorded(after.snapshot())).toBe(true);
    expect(interactionFreezeEventRecorded(before.snapshot())).toBe(false);
  });
});

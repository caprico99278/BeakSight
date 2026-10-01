// U17a（Task 14〜17 の設計書 第7章、UI追補設計書 第4章）: 終了コードの表は、`src/cli/exit-codes.ts` の1つだけである。
// R5a（中断した Run の再開の設計書 4.7.1）: 終了コード 4 に、Run を始められない結果（`RUN_UNAVAILABLE`）を加えた。値は、設定のエラーと
// 同じ 4 である（設計書のとおり。2つの結果が同じ値を持つのは、この組だけで、テストの中で明示する）。
// R5b（設計書 4.7、4.7.1）: 終了コード 5 に、中断の結果（`INTERRUPTED`。2回目のシグナルで、最後の処理をせずにすぐに終えた）を加えた。
// ほかのどの結果とも違う値である（同じ値を持つ組の例外には加えない）。
import { describe, expect, it } from 'vitest';
import {
  CONFIG_ERROR_EXIT_CODE,
  CONFIG_ERROR_OUTCOME,
  EXIT_CODES,
  EXIT_OUTCOMES,
  FAILURE_EXIT_CODE,
  INTERRUPTED_EXIT_CODE,
  INTERRUPTED_OUTCOME,
  RUN_UNAVAILABLE_EXIT_CODE,
  RUN_UNAVAILABLE_OUTCOME,
  SUCCESS_EXIT_CODE,
  exitCodeForRunStatus,
  type ExitOutcome,
} from '../../src/cli/exit-codes.js';
import { RUN_STATUSES } from '../../src/core/contracts.js';

/**
 * 設計どおりに、ほかの結果と同じ値を持つ結果と、その相手（設計書 4.7.1: Run を始められない結果は、設定のエラーと同じ 4）。
 * 「違う結果には違う終了コード」の例外は、この組だけである。
 */
const SHARED_CODE_OUTCOMES: ReadonlyMap<ExitOutcome, ExitOutcome> = new Map([['RUN_UNAVAILABLE', 'CONFIG_ERROR']]);

describe('exit codes', () => {
  it('has an exit code for every Run Status, for CONFIG_ERROR, for RUN_UNAVAILABLE and for INTERRUPTED, and nothing else', () => {
    expect([...EXIT_OUTCOMES].sort()).toEqual([...RUN_STATUSES, 'CONFIG_ERROR', 'RUN_UNAVAILABLE', 'INTERRUPTED'].sort());
    expect(Object.keys(EXIT_CODES).sort()).toEqual([...EXIT_OUTCOMES].sort());
  });

  it('maps the outcomes to the codes of the design (COMPLETE 0, FAILED 1, PARTIAL 2, ABORTED_BY_SAFETY 3, CONFIG_ERROR 4, RUN_UNAVAILABLE 4, INTERRUPTED 5)', () => {
    expect(EXIT_CODES).toEqual({
      COMPLETE: 0,
      FAILED: 1,
      PARTIAL: 2,
      ABORTED_BY_SAFETY: 3,
      CONFIG_ERROR: 4,
      RUN_UNAVAILABLE: 4,
      INTERRUPTED: 5,
    });
    for (const status of RUN_STATUSES) {
      expect(exitCodeForRunStatus(status), status).toBe(EXIT_CODES[status]);
    }
    expect(CONFIG_ERROR_EXIT_CODE).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(RUN_UNAVAILABLE_EXIT_CODE).toBe(EXIT_CODES.RUN_UNAVAILABLE);
    expect(INTERRUPTED_EXIT_CODE).toBe(EXIT_CODES.INTERRUPTED);
  });

  it('uses the FAILED code for failures outside the Run (artifact writing and unexpected errors)', () => {
    expect(FAILURE_EXIT_CODE).toBe(EXIT_CODES.FAILED);
  });

  it('uses the COMPLETE code for the success of a command without a Run (validate-config and --help)', () => {
    expect(SUCCESS_EXIT_CODE).toBe(EXIT_CODES.COMPLETE);
    expect(SUCCESS_EXIT_CODE).toBe(0);
  });

  it('names the CONFIG_ERROR outcome in the list of outcomes', () => {
    expect(EXIT_OUTCOMES).toContain(CONFIG_ERROR_OUTCOME);
    expect(EXIT_CODES[CONFIG_ERROR_OUTCOME]).toBe(4);
  });

  // R5a（設計書 4.7.1）: 実行中の Run がある、版が違う、ロックを同時に作り直された、保存を始められない場合の結果。
  it('names the RUN_UNAVAILABLE outcome in the list of outcomes, with the exit code 4', () => {
    expect(RUN_UNAVAILABLE_OUTCOME).toBe('RUN_UNAVAILABLE');
    expect(EXIT_OUTCOMES).toContain(RUN_UNAVAILABLE_OUTCOME);
    expect(EXIT_CODES[RUN_UNAVAILABLE_OUTCOME]).toBe(4);
    expect(RUN_UNAVAILABLE_EXIT_CODE).toBe(4);
  });

  // R5b（設計書 4.7、4.7.1）: 2回目のシグナルで、最後の処理をせずにすぐに終えた結果。
  it('names the INTERRUPTED outcome in the list of outcomes, with the exit code 5 that no other outcome has', () => {
    expect(INTERRUPTED_OUTCOME).toBe('INTERRUPTED');
    expect(EXIT_OUTCOMES).toContain(INTERRUPTED_OUTCOME);
    expect(EXIT_CODES[INTERRUPTED_OUTCOME]).toBe(5);
    expect(INTERRUPTED_EXIT_CODE).toBe(5);
    // 同じ値を持つ組の例外ではない。
    expect(SHARED_CODE_OUTCOMES.has(INTERRUPTED_OUTCOME)).toBe(false);
    expect([...SHARED_CODE_OUTCOMES.values()]).not.toContain(INTERRUPTED_OUTCOME);
    const others = EXIT_OUTCOMES.filter((outcome) => outcome !== INTERRUPTED_OUTCOME);
    expect(others).toHaveLength(EXIT_OUTCOMES.length - 1);
    expect(others.map((outcome) => EXIT_CODES[outcome])).not.toContain(INTERRUPTED_EXIT_CODE);
  });

  it('gives different outcomes different codes, except RUN_UNAVAILABLE that shares the code of CONFIG_ERROR, and only COMPLETE exits with 0', () => {
    // 例外の組は、設計どおり同じ値である。
    for (const [outcome, sharedWith] of SHARED_CODE_OUTCOMES) {
      expect(EXIT_CODES[outcome], `${outcome} and ${sharedWith}`).toBe(EXIT_CODES[sharedWith]);
    }
    // 例外の結果を除くと、すべて違う値である。
    const distinctOutcomes = EXIT_OUTCOMES.filter((outcome) => !SHARED_CODE_OUTCOMES.has(outcome));
    expect(distinctOutcomes).toHaveLength(EXIT_OUTCOMES.length - SHARED_CODE_OUTCOMES.size);
    const codes = distinctOutcomes.map((outcome) => EXIT_CODES[outcome]);
    expect(new Set(codes).size).toBe(codes.length);
    expect(EXIT_OUTCOMES.filter((outcome) => EXIT_CODES[outcome] === 0)).toEqual(['COMPLETE']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(EXIT_CODES)).toBe(true);
    expect(Object.isFrozen(EXIT_OUTCOMES)).toBe(true);
  });

  it('rejects a value that is not a Run Status', () => {
    expect(() => exitCodeForRunStatus('CONFIG_ERROR' as never)).toThrow(RangeError);
    expect(() => exitCodeForRunStatus('RUN_UNAVAILABLE' as never)).toThrow(RangeError);
    expect(() => exitCodeForRunStatus('INTERRUPTED' as never)).toThrow(RangeError);
    expect(() => exitCodeForRunStatus('UNKNOWN' as never)).toThrow(RangeError);
  });
});

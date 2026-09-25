// U17a（Task 14〜17 の設計書 第7章、UI追補設計書 第4章）: 終了コードの表は、`src/cli/exit-codes.ts` の1つだけである。
import { describe, expect, it } from 'vitest';
import {
  CONFIG_ERROR_EXIT_CODE,
  CONFIG_ERROR_OUTCOME,
  EXIT_CODES,
  EXIT_OUTCOMES,
  FAILURE_EXIT_CODE,
  SUCCESS_EXIT_CODE,
  exitCodeForRunStatus,
} from '../../src/cli/exit-codes.js';
import { RUN_STATUSES } from '../../src/core/contracts.js';

describe('exit codes', () => {
  it('has an exit code for every Run Status and for CONFIG_ERROR, and nothing else', () => {
    expect([...EXIT_OUTCOMES].sort()).toEqual([...RUN_STATUSES, 'CONFIG_ERROR'].sort());
    expect(Object.keys(EXIT_CODES).sort()).toEqual([...EXIT_OUTCOMES].sort());
  });

  it('maps the outcomes to the codes of the design (COMPLETE 0, FAILED 1, PARTIAL 2, ABORTED_BY_SAFETY 3, CONFIG_ERROR 4)', () => {
    expect(EXIT_CODES).toEqual({ COMPLETE: 0, FAILED: 1, PARTIAL: 2, ABORTED_BY_SAFETY: 3, CONFIG_ERROR: 4 });
    for (const status of RUN_STATUSES) {
      expect(exitCodeForRunStatus(status), status).toBe(EXIT_CODES[status]);
    }
    expect(CONFIG_ERROR_EXIT_CODE).toBe(EXIT_CODES.CONFIG_ERROR);
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

  it('gives different outcomes different codes, and only COMPLETE exits with 0', () => {
    const codes = EXIT_OUTCOMES.map((outcome) => EXIT_CODES[outcome]);
    expect(new Set(codes).size).toBe(codes.length);
    expect(EXIT_OUTCOMES.filter((outcome) => EXIT_CODES[outcome] === 0)).toEqual(['COMPLETE']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(EXIT_CODES)).toBe(true);
    expect(Object.isFrozen(EXIT_OUTCOMES)).toBe(true);
  });

  it('rejects a value that is not a Run Status', () => {
    expect(() => exitCodeForRunStatus('CONFIG_ERROR' as never)).toThrow(RangeError);
    expect(() => exitCodeForRunStatus('UNKNOWN' as never)).toThrow(RangeError);
  });
});

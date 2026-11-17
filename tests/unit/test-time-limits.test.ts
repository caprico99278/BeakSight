/**
 * 場面ごとの時間の見張り（RB-0。設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md` 2 章 8）の、上限の表の形と判定。
 * 見張りの本体（`tests/helpers/test-time-limit-setup.ts`）は、ここの判定を、場面ごとの経った時間に当てるだけ。
 * 上限の値はテストに書かないので、ここでは表の形だけを持つ見本（単位は `UNIT` の倍数）で確かめる。
 */
import { describe, expect, it } from 'vitest';
import {
  fileTimeLimitsOf,
  judgeSceneTime,
  maxLimitMsOf,
  testTimeLimitsShapeErrorsOf,
  unusedFileTimeLimitsOf,
  type TestTimeLimits,
} from '../helpers/test-time-limits.js';

const UNIT = 10;
const NAMED_FILE = 'tests/integration/named.test.ts';
const MIGRATING_FILE = 'tests/integration/migrating.test.ts';
const PLAIN_FILE = 'tests/unit/plain.test.ts';
const SAMPLE: TestTimeLimits = {
  defaultLimitMs: UNIT,
  exceptions: [{ file: NAMED_FILE, test: 'flow > runs end to end', limitMs: 3 * UNIT, reason: 'the user flow', kind: 'E2E' }],
  migrating: [{ file: MIGRATING_FILE, count: 2, limitMs: 5 * UNIT, reason: 'not yet on the fake port' }],
  migratingTimeoutOptions: { reason: 'moves to the table', files: { [MIGRATING_FILE]: 1 } },
};
const scene = (fullName: string): { readonly fullName: string; readonly name: string } =>
  ({ fullName, name: fullName.split(' > ').at(-1) ?? fullName });

describe('RB-0: the shape of the time limit table', () => {
  it('accepts a table with the default limit, the named exceptions and the migrating list', () => {
    expect(testTimeLimitsShapeErrorsOf(SAMPLE)).toEqual([]);
  });

  it('rejects rows without a reason, an unknown kind, a limit not above the default, a count below 1 and duplicated rows', () => {
    const broken = {
      ...SAMPLE,
      exceptions: [
        { ...SAMPLE.exceptions[0], reason: '' },
        { ...SAMPLE.exceptions[0], test: 'flow > second', kind: 'MIGRATING' },
        { ...SAMPLE.exceptions[0], test: 'flow > third', limitMs: UNIT },
        { ...SAMPLE.exceptions[0], test: 'flow > third' },
      ],
      migrating: [{ ...SAMPLE.migrating[0], count: 0 }, { ...SAMPLE.migrating[0] }],
    };
    expect(testTimeLimitsShapeErrorsOf(broken)).toHaveLength(6);
    expect(testTimeLimitsShapeErrorsOf({ defaultLimitMs: 0 })).not.toEqual([]);
  });

  it('the largest limit is the default or the largest exception', () => {
    expect(maxLimitMsOf(SAMPLE)).toBe(5 * UNIT);
    expect(fileTimeLimitsOf(SAMPLE, PLAIN_FILE).maxLimitMs).toBe(UNIT);
    expect(fileTimeLimitsOf(SAMPLE, NAMED_FILE).maxLimitMs).toBe(3 * UNIT);
  });
});

describe('RB-0: the judgement of one scene', () => {
  it('passes a scene within the default limit and fails a scene over it outside the table', () => {
    const limits = fileTimeLimitsOf(SAMPLE, PLAIN_FILE);
    expect(judgeSceneTime(limits, scene('a > quick'), UNIT, new Set()).error).toBeUndefined();
    expect(judgeSceneTime(limits, scene('a > slow'), UNIT + 1, new Set()).error).toMatch(/tests\/test-time-limits\.json/u);
  });

  it('a named exception allows its own limit and nothing more', () => {
    const limits = fileTimeLimitsOf(SAMPLE, NAMED_FILE);
    expect(judgeSceneTime(limits, scene('flow > runs end to end'), 3 * UNIT, new Set()).error).toBeUndefined();
    expect(judgeSceneTime(limits, scene('flow > runs end to end'), 3 * UNIT + 1, new Set()).error).toBeDefined();
    expect(judgeSceneTime(limits, scene('flow > another'), UNIT + 1, new Set()).error).toBeDefined();
  });

  it('a migrating file allows up to its count of distinct scenes over the default, each within its limit', () => {
    const limits = fileTimeLimitsOf(SAMPLE, MIGRATING_FILE);
    const over = new Set<string>();
    for (const name of ['CLI > first', 'TEST_DEFAULT > first', 'CLI > second']) {
      const verdict = judgeSceneTime(limits, scene(name), 2 * UNIT, over);
      expect(verdict.error).toBeUndefined();
      if (verdict.overDefault !== undefined) over.add(verdict.overDefault);
    }
    expect(judgeSceneTime(limits, scene('CLI > third'), 2 * UNIT, over).error).toMatch(/count/u);
    expect(judgeSceneTime(limits, scene('CLI > first'), 5 * UNIT + 1, over).error).toBeDefined();
  });
});

describe('RB-0: unused rows are errors', () => {
  it('reports a named exception whose scene is not in the file and a count above the distinct scenes of the file', () => {
    expect(unusedFileTimeLimitsOf(fileTimeLimitsOf(SAMPLE, NAMED_FILE), [scene('flow > renamed')])).toHaveLength(1);
    expect(unusedFileTimeLimitsOf(fileTimeLimitsOf(SAMPLE, NAMED_FILE), [scene('flow > runs end to end')])).toEqual([]);
    expect(unusedFileTimeLimitsOf(fileTimeLimitsOf(SAMPLE, MIGRATING_FILE), [scene('CLI > first'), scene('TEST_DEFAULT > first')])).toHaveLength(1);
    expect(unusedFileTimeLimitsOf(fileTimeLimitsOf(SAMPLE, MIGRATING_FILE), [scene('a > first'), scene('a > second')])).toEqual([]);
  });
});

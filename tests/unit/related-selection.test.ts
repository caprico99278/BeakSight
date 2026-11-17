// SLIM-1: 流すテストを選ぶ判断（台帳・通る部品の印・速い組と遅い組）。
import { describe, expect, it } from 'vitest';
import { builtProductTestsFor, coversOf, ledgerSelectionOf, splitByGroup } from '../related-selection.js';

const LEDGER = [
  { component: 'src/safety/redact.ts', tests: ['tests/unit/redact.test.ts', 'tests/integration/secrets.test.ts'] },
  { component: 'src/presentation/', tests: ['tests/unit/messages.test.ts'] },
];

describe('SLIM-1: the selection of the related tests', () => {
  it('a changed file in the ledger selects only the tests of its row (a file or everything under a folder)', () => {
    expect(ledgerSelectionOf(['src/safety/redact.ts', 'src/presentation/messages.ts', 'src/core/deadline.ts'], LEDGER)).toEqual({
      matched: ['src/safety/redact.ts', 'src/presentation/messages.ts'],
      tests: ['tests/integration/secrets.test.ts', 'tests/unit/messages.test.ts', 'tests/unit/redact.test.ts'],
    });
    expect(ledgerSelectionOf(['src/safety/redact-more.ts'], LEDGER)).toEqual({ matched: [], tests: [] });
  });

  it('reads the covers mark of a test file', () => {
    expect(coversOf('// header\n// covers: src/discovery/, src/control/job/\nimport x;')).toEqual(['src/discovery/', 'src/control/job/']);
    expect(coversOf('// no mark here\n')).toBeUndefined();
  });

  it('selects a built product test by its covers mark, or by the entry when it has no mark', () => {
    const candidates = [
      { path: 'tests/integration/a-fork.test.ts', covers: ['src/discovery/'], touchesEntry: true },
      { path: 'tests/integration/b-fork.test.ts', covers: ['src/control/job/'], touchesEntry: true },
      { path: 'tests/integration/c-fork.test.ts', covers: undefined, touchesEntry: true },
      { path: 'tests/integration/d-fork.test.ts', covers: undefined, touchesEntry: false },
    ];
    expect(builtProductTestsFor(['src/discovery/probe.ts'], candidates)).toEqual(['tests/integration/a-fork.test.ts', 'tests/integration/c-fork.test.ts']);
  });

  it('splits the tests into the fast and slow groups by the slow list', () => {
    expect(splitByGroup(['b.test.ts', 'a.test.ts', 'b.test.ts', 'c.test.ts'], ['c.test.ts'])).toEqual({ fast: ['a.test.ts', 'b.test.ts'], slow: ['c.test.ts'] });
  });
});

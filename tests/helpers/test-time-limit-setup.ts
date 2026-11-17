/**
 * 場面ごとの時間の見張り（RB-0。設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md` 2 章 8）。ルートと画面の Vitest の設定の
 * setupFiles に、この 1 つだけを置く（各テストのファイルに書かない）。
 * - 場面の時間は、最初の beforeEach から最後の afterEach まで（この setup の hook は、ファイルの hook より先に始まり、後に終わる）。
 *   beforeAll（Browser や画面のサーバの起動）は入らない。
 * - 上限は `tests/test-time-limits.json` の 1 か所（`test-time-limits.ts`）。超えた場面は、afterEach で誤りにする（その場面が落ちる）。
 *   既に落ちた場面は、時間で重ねて落とさない。
 * - Vitest の `testTimeout` を、このファイルの最大の上限にする（固まった場面を、上限で止める。`it(…, <数>)` を書いた場面は、その数のまま）。
 * - ファイルの終わりに、使われない行（名前つきの例外の場面がない、移る途中の件数が場面の数より多い）を誤りにする。
 */
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';
import {
  fileTimeLimitsOf,
  judgeSceneTime,
  TEST_TIME_LIMITS,
  unusedFileTimeLimitsOf,
  type TimedScene,
} from './test-time-limits.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Vitest の場面と組の、ここで読む所。 */
interface TaskShape {
  readonly type: string;
  readonly name: string;
  readonly fullTestName?: string;
  readonly tasks?: readonly TaskShape[];
}

const sceneOf = (task: TaskShape): TimedScene => ({ fullName: task.fullTestName ?? task.name, name: task.name });
const scenesUnder = (task: TaskShape): readonly TimedScene[] =>
  task.type === 'test' ? [sceneOf(task)] : (task.tasks ?? []).flatMap((child) => scenesUnder(child));

const { testPath } = expect.getState();
if (testPath === undefined) {
  throw new Error('the time limit setup runs only as a Vitest setup file');
}
const limits = fileTimeLimitsOf(TEST_TIME_LIMITS, relative(REPOSITORY_ROOT, testPath).replaceAll('\\', '/'));
vi.setConfig({ testTimeout: limits.maxLimitMs });

const startedAt = new WeakMap<object, number>();
const overDefault = new Set<string>();

beforeEach(({ task }) => {
  startedAt.set(task, performance.now());
});

afterEach(({ task }) => {
  const started = startedAt.get(task);
  if (started === undefined || task.result?.state === 'fail') {
    return;
  }
  const verdict = judgeSceneTime(limits, sceneOf(task), performance.now() - started, overDefault);
  if (verdict.overDefault !== undefined) {
    overDefault.add(verdict.overDefault);
  }
  if (verdict.error !== undefined) {
    throw new Error(verdict.error);
  }
});

// Vitest は、1 つ目の引数に分割の形を求める（組は 2 つ目の引数）。
afterAll(({}, file) => {
  const unused = unusedFileTimeLimitsOf(limits, scenesUnder(file));
  if (unused.length > 0) {
    throw new Error(`unused rows in tests/test-time-limits.json: ${unused.join('; ')}`);
  }
});

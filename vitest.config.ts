import { configDefaults, defineConfig } from 'vitest/config';
import {
  HEAVY_PROJECT_NAME,
  HEAVY_TEST_FILES,
  INTEGRATION_PROJECT_INCLUDE,
  INTEGRATION_PROJECT_NAME,
  UNIT_PROJECT_INCLUDE,
  UNIT_PROJECT_NAME,
} from './tests/suites.js';

/**
 * 結合（integration と heavy の project）の並列の数（TS-a。設計書 `2026-10-24-beaksight-test-suite-tiers-design.md` 3.1）。
 * 単体の系（unit の project）は、結合より先に、Vitest の既定の並列の数で流す（`sequence.groupOrder`）。単体の時間の検査と、ブラウザを使う結合が
 * CPU を取り合わないようにするため。値は仮の 6（混雑に強い側）: 2026-10-24 の測りは、8 並列の 1 回（並行の作業の混雑の下でルートの全部が 2,454 秒）と、
 * 組み直しの前の 15 並列の 1 回（1,830 秒）だけで、決めきれなかった。最後の全体の検証（承認の後の 1 回）で時間を測って見直す。
 */
const INTEGRATION_MAX_WORKERS = 6;

/** 組の順（小さい方から流す）。 */
const UNIT_GROUP_ORDER = 0;
const INTEGRATION_GROUP_ORDER = 1;

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    // 組の一覧は `tests/suites.ts` にだけ書く（ここにファイルの名前を書かない）。
    projects: [
      {
        extends: true,
        test: { name: UNIT_PROJECT_NAME, include: [...UNIT_PROJECT_INCLUDE], sequence: { groupOrder: UNIT_GROUP_ORDER } },
      },
      {
        extends: true,
        test: {
          name: INTEGRATION_PROJECT_NAME,
          include: [...INTEGRATION_PROJECT_INCLUDE],
          exclude: [...configDefaults.exclude, ...HEAVY_TEST_FILES],
          maxWorkers: INTEGRATION_MAX_WORKERS,
          sequence: { groupOrder: INTEGRATION_GROUP_ORDER },
        },
      },
      {
        extends: true,
        test: {
          name: HEAVY_PROJECT_NAME,
          include: [...HEAVY_TEST_FILES],
          maxWorkers: INTEGRATION_MAX_WORKERS,
          sequence: { groupOrder: INTEGRATION_GROUP_ORDER },
        },
      },
    ],
  },
});

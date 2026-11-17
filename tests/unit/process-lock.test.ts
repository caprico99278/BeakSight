// process のロックの部品の置き場所と、一時ファイルの名前の決まり。
// - `src/core/` のロックの部品（監査中の印 `run-exclusion.ts`、process の部品 `process-lock.ts`）が、`src/orchestration/`・`src/report/`・
//   `src/control/` を import しないこと。
// - 一時ファイルの名前の決まり（`temporaryPathFor`・`isTemporaryFileName`）。
// 監査中の印の振る舞い（本物のパイプ）と、版をまたぐ守りは `tests/unit/output-start-lock.test.ts`。
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as temporaryFileName from '../../src/core/temporary-file-name.js';

describe('the lock parts in src/core', () => {
  it('do not import src/orchestration, src/report or src/control', () => {
    for (const file of ['src/core/process-lock.ts', 'src/core/run-exclusion.ts', 'src/core/temporary-file-name.ts']) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/^import[^;]*from '([^']+)';/gmu)].map((match) => match[1] ?? '');
      expect(imports.filter((specifier) => /\/(?:orchestration|report|control)\//u.test(specifier)), file).toEqual([]);
    }
  });
});

describe('the temporary file names', () => {
  it('tells the names made by temporaryPathFor from other names', () => {
    expect(temporaryFileName.isTemporaryFileName(basename(temporaryFileName.temporaryPathFor(join('a', 'state.json'))))).toBe(true);
    for (const name of ['state.json', '.state.json.tmp', '.state.json.not-a-uuid.tmp', '..00000000-0000-0000-0000-000000000000.tmp']) {
      expect(temporaryFileName.isTemporaryFileName(name), name).toBe(false);
    }
  });
});

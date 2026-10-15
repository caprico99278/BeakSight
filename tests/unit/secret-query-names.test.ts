// T27c（Task 27 の設計書の変更履歴「Blocker: T27c」の行の (1)）: 秘密に見える query の名前の一覧と判定の owner は `src/core/secret-query-names.ts`。
// `src/safety/redact.ts` は、そこから import して今の名前のまま公開し直す（振る舞いは変えない）。`src/control/` は `src/safety/` を import できない
// （`control-boundary.test.ts` の (b)）ので、READ の定義の検証は `src/core/` の判定を直接使う。
import { describe, expect, it } from 'vitest';
import {
  SECRET_URL_QUERY_PARAMETER_NAMES as CORE_NAMES,
  isSecretUrlQueryParameterName as coreIsSecret,
} from '../../src/core/secret-query-names.js';
import { SECRET_URL_QUERY_PARAMETER_NAMES, isSecretUrlQueryParameterName } from '../../src/safety/redact.js';

describe('secret query names owner (T27c)', () => {
  it('is the same list and the same function that redact.ts exports (one owner)', () => {
    expect(SECRET_URL_QUERY_PARAMETER_NAMES).toBe(CORE_NAMES);
    expect(isSecretUrlQueryParameterName).toBe(coreIsSecret);
    expect(Object.isFrozen(CORE_NAMES)).toBe(true);
  });

  it.each([
    ['state', true],
    ['code', true],
    ['key', true],
    ['API-Key', true],
    ['csrf%5Ftoken', true],
    ['keyword', false],
    ['author', false],
    ['q', false],
    ['', false],
  ])('judges %s as %s', (name, expected) => {
    expect(coreIsSecret(name)).toBe(expected);
  });
});

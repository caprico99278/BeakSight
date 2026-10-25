// T40a-fix（Task 40 の設計書 7 章の「T40a の報告（API の検証の指定）」の設計者の判断）: API のシナリオの検証の指定で求める項目は、照合の READ と
// ID の取り方だけ（`API_SCENARIO_VERIFICATION_ITEMS`）。ID の取り方は、`api.recordId`（応答の本文の鍵）か、検証の指定の `recordId`（保存の後の画面の
// URL・要素）のどちらかがあればよい。成否の条件と入力の誤りの条件は、API では求めない（使わない。下書きに入っていても拒まない）。form のシナリオ
// （送り方の項目のない前の文書を含む）は、今のまま 4 項目を求める。判定は `missingVerificationItemsOf` の 1 か所（許可の発行、詳細の画面、開始の
// 画面が使う）。
import { describe, expect, it } from 'vitest';
import {
  API_SCENARIO_VERIFICATION_ITEMS,
  SCENARIO_VERIFICATION_ITEMS,
  UNSPECIFIED_VERIFICATION,
  type ScenarioApiSpec,
  type ScenarioVerification,
} from '../../src/control/approval/scenario-contracts.js';
import { missingVerificationItemsOf, requiredVerificationItemsOf } from '../../src/control/approval/scenario-policy.js';
import { FULL_VERIFICATION } from './approval-samples.js';

/** API の指定（ID の取り方だけを変える。ほかの項目は判定に使わない）。 */
const apiOf = (recordId: ScenarioApiSpec['recordId']): ScenarioApiSpec => ({
  shapeDigest: `sha256:${'f'.repeat(64)}`,
  request: { method: 'POST', origin: 'http://127.0.0.2:4174', pathShape: '/rest/v1/members', queryNames: ['select'], contentType: 'application/json', prefer: [] },
  keyFields: [],
  pageKeys: [],
  headerNames: [],
  filterName: null,
  recordId,
  ledger: null,
} as unknown as ScenarioApiSpec);

const RESPONSE_KEY = apiOf({ source: 'RESPONSE_BODY_KEY', key: 'id' });
const NO_RESPONSE_KEY = apiOf(null);
const WITHOUT_CONDITIONS: ScenarioVerification = { ...FULL_VERIFICATION, successCondition: null, inputErrorCondition: null };

describe('T40a-fix: the items of the verification spec an API scenario needs', () => {
  it('names the items of an API scenario (the record id and the READ verification), in the order of the closed list', () => {
    expect(API_SCENARIO_VERIFICATION_ITEMS).toEqual(['recordId', 'readVerification']);
    expect(Object.isFrozen(API_SCENARIO_VERIFICATION_ITEMS)).toBe(true);
    expect(API_SCENARIO_VERIFICATION_ITEMS.every((item) => (SCENARIO_VERIFICATION_ITEMS as readonly string[]).includes(item))).toBe(true);
    expect(requiredVerificationItemsOf({ transport: 'API' })).toEqual(API_SCENARIO_VERIFICATION_ITEMS);
    expect(requiredVerificationItemsOf({ transport: 'FORM' })).toEqual(SCENARIO_VERIFICATION_ITEMS);
    expect(requiredVerificationItemsOf({})).toEqual(SCENARIO_VERIFICATION_ITEMS);
  });

  it.each<readonly [string, ScenarioVerification, Parameters<typeof missingVerificationItemsOf>[1], readonly string[]]>([
    // API: 成否の条件と入力の誤りの条件は求めない。
    ['an API scenario without the two conditions (the response body key)', WITHOUT_CONDITIONS, { transport: 'API', api: RESPONSE_KEY }, []],
    ['an API scenario with the two conditions (they are not used)', FULL_VERIFICATION, { transport: 'API', api: RESPONSE_KEY }, []],
    // API: ID の取り方はどちらか 1 つ。
    ['an API scenario with the record id of the verification spec only', WITHOUT_CONDITIONS, { transport: 'API', api: NO_RESPONSE_KEY }, []],
    ['an API scenario with the response body key only', { ...WITHOUT_CONDITIONS, recordId: null }, { transport: 'API', api: RESPONSE_KEY }, []],
    ['an API scenario without any way to take the record id', { ...WITHOUT_CONDITIONS, recordId: null }, { transport: 'API', api: NO_RESPONSE_KEY }, ['recordId']],
    ['an API scenario without the API spec and the record id', { ...WITHOUT_CONDITIONS, recordId: null }, { transport: 'API' }, ['recordId']],
    // API: 照合の READ は求める。
    ['an API scenario without the READ verification', { ...WITHOUT_CONDITIONS, readVerification: null }, { transport: 'API', api: RESPONSE_KEY }, ['readVerification']],
    ['an API scenario with nothing', UNSPECIFIED_VERIFICATION, { transport: 'API', api: NO_RESPONSE_KEY }, ['recordId', 'readVerification']],
    // FORM（送り方の項目なし・FORM）: 今のまま 4 項目。API の指定は見ない。
    ['a FORM scenario without the two conditions', WITHOUT_CONDITIONS, { transport: 'FORM' }, ['successCondition', 'inputErrorCondition']],
    ['a scenario without the transport and the two conditions', WITHOUT_CONDITIONS, {}, ['successCondition', 'inputErrorCondition']],
    ['a FORM scenario without the record id and an API spec', { ...FULL_VERIFICATION, recordId: null }, { transport: 'FORM', api: RESPONSE_KEY }, ['recordId']],
    ['a FORM scenario with all four', FULL_VERIFICATION, { transport: 'FORM' }, []],
    ['a FORM scenario with nothing', UNSPECIFIED_VERIFICATION, {}, SCENARIO_VERIFICATION_ITEMS],
  ])('judges %s', (_label, verification, scenario, missing) => {
    expect(missingVerificationItemsOf(verification, scenario)).toEqual(missing);
  });

  // T41e-2（T41b の申し送り。Task 41 の設計書 3.4 の 3）: API の更新（台帳の参照 `api.ledger` を持つ）の登録の ID は対象の ID なので、ID の取り方は求めず、
  // 画面に出す項目（`requiredVerificationItemsOf`）も照合の READ だけ。不足の判定（`missingVerificationItemsOf`）と同じ一覧から決める。
  it('names only the READ verification for an API update, the same as the judgement of the missing items', () => {
    const update = { ...NO_RESPONSE_KEY, ledger: { targetCreateScenarioId: 'scenario-create', formPathTemplate: '/admin/members/{id}/edit' } } as ScenarioApiSpec;
    expect(requiredVerificationItemsOf({ transport: 'API', api: update })).toEqual(['readVerification']);
    expect(requiredVerificationItemsOf({ transport: 'API', api: NO_RESPONSE_KEY })).toEqual(API_SCENARIO_VERIFICATION_ITEMS);
    expect(missingVerificationItemsOf({ ...WITHOUT_CONDITIONS, recordId: null }, { transport: 'API', api: update })).toEqual([]);
    expect(missingVerificationItemsOf(UNSPECIFIED_VERIFICATION, { transport: 'API', api: update })).toEqual(['readVerification']);
  });

  it('keeps the judgement of a FORM scenario when the transport is not given (fail-closed)', () => {
    expect(missingVerificationItemsOf(WITHOUT_CONDITIONS)).toEqual(['successCondition', 'inputErrorCondition']);
    expect(missingVerificationItemsOf(FULL_VERIFICATION)).toEqual([]);
  });
});

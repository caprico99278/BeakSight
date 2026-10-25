// CC-102: API のシナリオの欄の識別の契約は `src/core/api-field-identity.ts` の 1 か所にあり、シナリオの契約と書き込みの入力の部品は、そこを公開し直す。
// PRE42-CC の組 2（CC-102 の気づき）: 欄の識別から値（名前か CSS）を取り出す形も core の `apiFieldIdentityValueOf` の 1 か所にし、承認の digest
// （`approval-digest.ts` の鍵と欄の対応・ページが決める鍵）と、鍵と欄の対応の digest（`scenario-contracts.ts` の `apiKeyFieldsDigestOf`）が使う。
// 寄せる前の値で digest を固定し、寄せた後も同じ値であることを確かめる（承認の記録が確かめ直しで変わらない）。
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ApiWriteFieldIdentity } from '../../src/browser/api-write-submitter.js';
import { approvalDigestEntriesOf, computeApprovalDigest, type ApprovalDigestFacts } from '../../src/control/approval/approval-digest.js';
import {
  SCENARIO_API_FIELD_IDENTITY_KINDS,
  apiKeyFieldsDigestOf,
  type ScenarioApiFieldIdentity,
  type ScenarioApiSpec,
  type ScenarioRevision,
} from '../../src/control/approval/scenario-contracts.js';
import { API_FIELD_IDENTITY_KINDS, apiFieldIdentityValueOf, type ApiFieldIdentity } from '../../src/core/api-field-identity.js';
import { AUTH_SETUP_DIGEST, FULL_VERIFICATION, TARGET_CONFIG_DIGEST, sampleScenario } from './approval-samples.js';

const SHAPE = `sha256:${'a'.repeat(64)}`;

/** 鍵と欄の対応とページが決める鍵に、名前と CSS の両方の識別を持つ API の指定（UPDATE の欄の識別を持つ鍵も含む）。 */
const API_SPEC: ScenarioApiSpec = Object.freeze({
  shapeDigest: SHAPE,
  request: {
    method: 'POST', origin: 'https://api.example.invalid', pathShape: '/rest/v1/members', queryNames: ['select'], contentType: 'application/json',
    prefer: ['return=representation'],
  },
  keyFields: [
    { key: 'email', type: 'string', field: { kind: 'NAME', name: 'email' }, fieldType: 'email' },
    { key: 'note', type: 'number', field: { kind: 'SELECTOR', selector: '#note' }, fieldType: 'number' },
  ],
  pageKeys: [
    { key: 'tenant_id', type: 'string' },
    { key: 'owner', type: 'string', field: { kind: 'NAME', name: 'owner' } },
    { key: 'team', type: 'string', field: { kind: 'SELECTOR', selector: '#team' } },
  ],
  headerNames: ['authorization', 'content-type', 'prefer'],
  filterName: null,
  recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
  ledger: null,
} satisfies ScenarioApiSpec);

const API_SCENARIO: ScenarioRevision = {
  ...sampleScenario(),
  candidate: { identityDigest: `sha256:${'c'.repeat(64)}`, ruleDigest: `sha256:${'d'.repeat(64)}` },
  transport: 'API',
  request: null,
  api: API_SPEC,
  fieldNames: ['email', 'note'],
  verification: { ...FULL_VERIFICATION, readVerification: null },
};

const DIGEST_FACTS: ApprovalDigestFacts = Object.freeze({ profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST });

/** 寄せる前（PRE42-CC の組 2 の前）のコードで求めた値。 */
const KEY_FIELDS_DIGEST_BEFORE = 'sha256:10b44edc134dddf381bceddd75f54c0a60d1c6210407f7f11a921a24682021f0';
const APPROVAL_DIGEST_BEFORE = 'sha256:1e0d8aaddb89088549503c3897860d0bb9274a65761a9140430c051825591639';

describe('CC-102: the one owner of the field identity of the API scenario', () => {
  it('keeps the closed list in the core and the scenario contract re-exports the same frozen list', () => {
    expect(API_FIELD_IDENTITY_KINDS).toEqual(['NAME', 'SELECTOR']);
    expect(Object.isFrozen(API_FIELD_IDENTITY_KINDS)).toBe(true);
    expect(SCENARIO_API_FIELD_IDENTITY_KINDS).toBe(API_FIELD_IDENTITY_KINDS);
  });

  it('makes the scenario and the write input types the core type', () => {
    expectTypeOf<ScenarioApiFieldIdentity>().toEqualTypeOf<ApiFieldIdentity>();
    expectTypeOf<ApiWriteFieldIdentity>().toEqualTypeOf<ApiFieldIdentity>();
  });

  it('gives the name of a NAME identity and the CSS of a SELECTOR identity (PRE42-CC group 2)', () => {
    expect(apiFieldIdentityValueOf({ kind: 'NAME', name: 'email' })).toBe('email');
    expect(apiFieldIdentityValueOf({ kind: 'SELECTOR', selector: '#note' })).toBe('#note');
  });

  it('keeps the key field digest and the approval digest as they were before the owner function (PRE42-CC group 2)', () => {
    expect(apiKeyFieldsDigestOf(SHAPE, API_SPEC.keyFields)).toBe(KEY_FIELDS_DIGEST_BEFORE);
    const entries = approvalDigestEntriesOf(API_SCENARIO, DIGEST_FACTS);
    expect(entries.apiKeyFields).toEqual([
      JSON.stringify(['email', 'string', 'NAME', 'email', 'email']),
      JSON.stringify(['note', 'number', 'SELECTOR', '#note', 'number']),
    ]);
    expect(entries.apiPageKeys).toEqual([
      JSON.stringify(['owner', 'string', 'NAME', 'owner']),
      JSON.stringify(['team', 'string', 'SELECTOR', '#team']),
      JSON.stringify(['tenant_id', 'string']),
    ]);
    expect(computeApprovalDigest(API_SCENARIO, DIGEST_FACTS)).toBe(APPROVAL_DIGEST_BEFORE);
  });
});

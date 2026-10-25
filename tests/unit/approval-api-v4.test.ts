// T38c（Task 38 の設計書 3.3、5 章の 2、7 章の履歴）: 承認の digest v4（`approval-digest.ts`）と、API のシナリオの承認の有効性（`approval-validity.ts`）。
// - digest v4: 印 `beaksight-approval/4`。API のシナリオは、送り方・型の digest・要求の型・鍵と欄の対応・ページが決める鍵・許すヘッダの名前・filter の名前・
//   登録の ID の取り方・台帳の参照を項目に持つ（FORM のシナリオは送り方 `FORM` で、API の項目は null）。どの項目が変わっても digest が変わり、差分の
//   項目に出る（再承認の条件）。v3 の承認の記録は、印が違うので確かめ直しで `SCENARIO_REVISION_CHANGED`（再承認が要る）。
// - 有効性: API のシナリオは、分類と kind の一致の代わりに、索引の候補の型の digest の一覧（`candidateShapeDigestsOf`）にシナリオの `shapeDigest` が
//   含まれることを見る（含まれない・型のない候補 → `CANDIDATE_SHAPE_CHANGED`、一覧がない（版 13 の前の行）→ `CANDIDATE_SHAPES_UNAVAILABLE`）。
//   候補の識別・`MISSING`・`NOT_REVISITED`・規則の digest は FORM と同じ扱い。API の UPDATE も同じ分岐（型にした識別の digest を持たない）。
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DIGEST_FORMAT,
  APPROVAL_DIGEST_ITEMS,
  approvalDigestDifferencesOf,
  approvalDigestEntriesOf,
  computeApprovalDigest,
  type ApprovalDigestFacts,
} from '../../src/control/approval/approval-digest.js';
import {
  APPROVAL_INVALIDITY_REASONS,
  evaluateApprovalValidity,
  type ApprovalCurrentFacts,
  type ApprovalValidityInput,
} from '../../src/control/approval/approval-validity.js';
import { apiKeyFieldsDigestOf, type ScenarioApiSpec, type ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import {
  AUTH_SETUP_DIGEST,
  FULL_VERIFICATION,
  INPUT_RULES,
  PROFILE_ID,
  READ_CHECK_FACTS,
  TARGET_CONFIG_DIGEST,
  sampleApproval,
  sampleScenario,
} from './approval-samples.js';

const API_ORIGIN = 'https://api.example.invalid';
const SHAPE_A = `sha256:${'a'.repeat(64)}`;
const SHAPE_B = `sha256:${'b'.repeat(64)}`;
const IDENTITY = `sha256:${'c'.repeat(64)}`;
const RULE = `sha256:${'d'.repeat(64)}`;

const API_SPEC: ScenarioApiSpec = Object.freeze({
  shapeDigest: SHAPE_A,
  request: {
    method: 'POST', origin: API_ORIGIN, pathShape: '/rest/v1/members', queryNames: ['select'], contentType: 'application/json', prefer: ['return=representation'],
  },
  keyFields: [
    { key: 'email', type: 'string', field: { kind: 'NAME', name: 'email' }, fieldType: 'email' },
    { key: 'note', type: 'number', field: { kind: 'SELECTOR', selector: '#note' }, fieldType: 'number' },
  ],
  pageKeys: [{ key: 'tenant_id', type: 'string' }],
  headerNames: ['authorization', 'content-type', 'prefer'],
  filterName: null,
  recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
  ledger: null,
} satisfies ScenarioApiSpec);

/** API のシナリオの版（要求の形は null。送る欄は送る本文の鍵）。 */
const apiScenario = (api: Partial<ScenarioApiSpec> = {}, overrides: Partial<ScenarioRevision> = {}): ScenarioRevision => ({
  ...sampleScenario(),
  candidate: { identityDigest: IDENTITY, ruleDigest: RULE },
  transport: 'API',
  request: null,
  api: { ...API_SPEC, ...api },
  fieldNames: ['email', 'note'],
  verification: { ...FULL_VERIFICATION, readVerification: null },
  ...overrides,
});

const DIGEST_FACTS: ApprovalDigestFacts = Object.freeze({ profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST });

/** T38c で足した項目（一覧の末尾。この順）。T41a: 保つ鍵（`apiKeptKeys`）を末尾に足した（v4 は未公開）。 */
const API_ITEMS = [
  'transport', 'apiShapeDigest', 'apiRequest', 'apiKeyFields', 'apiPageKeys', 'apiHeaderNames', 'apiFilterName', 'apiRecordId', 'apiLedger', 'apiKeptKeys',
] as const;

/** v3 の印で固定した、FORM の見本の承認の digest（`approval-digest-differences.test.ts` で T31b が固定した値）。 */
const FORM_V3_DIGEST = 'sha256:f1d363c24e761a844bd54a540f2d39769201813176a94b484b91410eb0f269c0';

describe('T38c: the approval digest v4', () => {
  it('has the format beaksight-approval/4 and the API items at the end of the items', () => {
    expect(APPROVAL_DIGEST_FORMAT).toBe('beaksight-approval/4');
    expect(APPROVAL_DIGEST_ITEMS.slice(-API_ITEMS.length)).toEqual([...API_ITEMS]);
    expect(APPROVAL_DIGEST_ITEMS.slice(0, -API_ITEMS.length)).toContain('updateTemplatedIdentityDigest');
  });

  it('keeps the FORM items as they are, with the transport FORM and no API item, and recomputes the digest with the v4 format', () => {
    const entries = approvalDigestEntriesOf(sampleScenario(), DIGEST_FACTS);
    expect(entries.transport).toBe('FORM');
    for (const item of API_ITEMS.slice(1)) {
      expect(entries[item], item).toBeNull();
    }
    expect(entries.request).not.toBeNull();
    expect(computeApprovalDigest(sampleScenario(), DIGEST_FACTS)).not.toBe(FORM_V3_DIGEST);
  });

  it('gives the API items as values without any value of a field (sorted where the order does not matter)', () => {
    const entries = approvalDigestEntriesOf(apiScenario({
      headerNames: ['prefer', 'authorization', 'content-type'],
      keyFields: [...API_SPEC.keyFields].reverse(),
    }), DIGEST_FACTS);
    expect(entries.transport).toBe('API');
    expect(entries.request).toBeNull();
    expect(entries.apiShapeDigest).toBe(SHAPE_A);
    expect(entries.apiRequest).toEqual(['POST', API_ORIGIN, '/rest/v1/members', ['select'], 'application/json', ['return=representation']]);
    // T38R2-fix（M-2）: 最後は欄の型。
    expect(entries.apiKeyFields).toEqual(['["email","string","NAME","email","email"]', '["note","number","SELECTOR","#note","number"]']);
    expect(entries.apiPageKeys).toEqual(['["tenant_id","string"]']);
    expect(entries.apiHeaderNames).toEqual(['authorization', 'content-type', 'prefer']);
    expect(entries.apiFilterName).toBeNull();
    expect(entries.apiRecordId).toEqual(['RESPONSE_BODY_KEY', 'id']);
    expect(entries.apiLedger).toBeNull();
    expect(Object.isFrozen(entries.apiKeyFields)).toBe(true);
    expect(computeApprovalDigest(apiScenario({ headerNames: ['prefer', 'authorization', 'content-type'] }), DIGEST_FACTS))
      .toBe(computeApprovalDigest(apiScenario(), DIGEST_FACTS));
  });

  // LG-3（2026-10-24 の設計 3.7.2）: シナリオの版の前の形を捨てる前のコードで求めた、API の登録と更新の見本の値（捨てた後も変わらない）。
  it('keeps the digest values of the API CREATE and the API UPDATE samples (fixed values, LG-3)', () => {
    expect(computeApprovalDigest(apiScenario(), DIGEST_FACTS)).toBe('sha256:48c194c26e2df556662352849bdd783255c6f751ca507fbfb77b8b730a2c703d');
    const update = apiScenario({
      request: { ...API_SPEC.request, method: 'PATCH' }, filterName: 'id', recordId: null,
      ledger: { targetCreateScenarioId: 'scenario-ledger', formPathTemplate: '/admin/members/{id}/edit' }, keptKeys: [API_SPEC.keyFields[1] as never],
      templatedIdentityDigest: `sha256:${'e'.repeat(64)}`,
    }, { kind: 'UPDATE', update: null, fieldNames: ['email'] });
    expect(computeApprovalDigest(update, DIGEST_FACTS)).toBe('sha256:2c28aa37ab3645515dee74bbf397c6e105db9cd2124b51902e6ae6ccb330437b');
  });

  const UPDATE_LEDGER = { targetCreateScenarioId: 'scenario-ledger', formPathTemplate: '/admin/members/{id}/edit' };
  it.each<readonly [string, Partial<ScenarioApiSpec>, string]>([
    ['the shape digest', { shapeDigest: SHAPE_B }, 'apiShapeDigest'],
    ['the method', { request: { ...API_SPEC.request, method: 'PATCH' } }, 'apiRequest'],
    ['the origin', { request: { ...API_SPEC.request, origin: 'https://other.example.invalid' } }, 'apiRequest'],
    ['the path shape', { request: { ...API_SPEC.request, pathShape: '/rest/v1/users' } }, 'apiRequest'],
    ['the query names', { request: { ...API_SPEC.request, queryNames: [] } }, 'apiRequest'],
    ['the media type', { request: { ...API_SPEC.request, contentType: null } }, 'apiRequest'],
    ['the Prefer values', { request: { ...API_SPEC.request, prefer: [] } }, 'apiRequest'],
    ['a key', { keyFields: [{ key: 'mail', type: 'string', field: { kind: 'NAME', name: 'email' }, fieldType: 'email' }, API_SPEC.keyFields[1] as never] }, 'apiKeyFields'],
    ['a field', { keyFields: [{ key: 'email', type: 'string', field: { kind: 'SELECTOR', selector: '#email' }, fieldType: 'email' }, API_SPEC.keyFields[1] as never] },
      'apiKeyFields'],
    ['a JSON type', { keyFields: [API_SPEC.keyFields[0] as never, { key: 'note', type: 'string', field: { kind: 'SELECTOR', selector: '#note' }, fieldType: 'number' }] },
      'apiKeyFields'],
    // T38R2-fix（M-2）: 欄の型。
    ['a field type', { keyFields: [{ key: 'email', type: 'string', field: { kind: 'NAME', name: 'email' }, fieldType: 'text' }, API_SPEC.keyFields[1] as never] },
      'apiKeyFields'],
    ['a page key', { pageKeys: [{ key: 'org_id', type: 'string' }] }, 'apiPageKeys'],
    ['a header name', { headerNames: ['authorization', 'content-type', 'prefer', 'x-client'] }, 'apiHeaderNames'],
    ['the filter name', { filterName: 'id' }, 'apiFilterName'],
    ['the record id', { recordId: null }, 'apiRecordId'],
    ['the ledger', { ledger: UPDATE_LEDGER }, 'apiLedger'],
  ])('changes the digest and shows the item when %s changes', (_label, change, item) => {
    const before = apiScenario();
    const after = apiScenario(change);
    expect(computeApprovalDigest(after, DIGEST_FACTS)).not.toBe(computeApprovalDigest(before, DIGEST_FACTS));
    expect(approvalDigestDifferencesOf({ scenario: before, facts: DIGEST_FACTS }, { scenario: after, facts: DIGEST_FACTS }).map((difference) => difference.item))
      .toEqual([item]);
  });

  it('shows the transport and every API item as a difference between a FORM and an API scenario, and the profile revision as its own item', () => {
    const items = approvalDigestDifferencesOf({ scenario: sampleScenario(), facts: DIGEST_FACTS }, { scenario: apiScenario(), facts: DIGEST_FACTS })
      .map(({ item }) => item);
    expect(items).toEqual(expect.arrayContaining(['transport', 'apiShapeDigest', 'apiRequest', 'apiKeyFields', 'request']));
    expect(approvalDigestDifferencesOf({ scenario: apiScenario(), facts: DIGEST_FACTS }, { scenario: apiScenario(), facts: { ...DIGEST_FACTS, profileRevision: 5 } }))
      .toEqual([{ item: 'profileRevision', previous: 4, current: 5 }]);
  });
});

const API_FACTS: ApprovalCurrentFacts = Object.freeze<ApprovalCurrentFacts>({
  profile: { profileId: PROFILE_ID, revision: 4, status: 'ACTIVE', mode: 'TEST_APPROVED_WRITE', approvedServiceOrigins: [API_ORIGIN] },
  authSetupDigest: AUTH_SETUP_DIGEST,
  targetConfigDigest: TARGET_CONFIG_DIGEST,
  // API の候補は probe の対象（分類は `NEEDS_BINDING`。kind とは比べない）。
  candidate: { identityDigest: IDENTITY, ruleDigest: RULE, classification: 'NEEDS_BINDING', drift: 'UNCHANGED' },
  candidateShapeDigests: [SHAPE_A, SHAPE_B],
  // T38R-fix: 鍵と欄の対応の digest（見本のシナリオの対応）、型の Origin の番号、最新の発見の改訂（今の改訂と同じ）。
  candidateKeyFieldDigests: [apiKeyFieldsDigestOf(SHAPE_A, API_SPEC.keyFields)],
  apiShapeOriginIndex: 0,
  latestDiscoveryProfileRevision: 4,
  templatedCandidates: null,
  inputRuleReference: INPUT_RULES,
  readChecks: READ_CHECK_FACTS,
});

const digestOf = (scenario: ScenarioRevision, facts: ApprovalCurrentFacts = API_FACTS): string => computeApprovalDigest(scenario, {
  profileRevision: facts.profile.revision, authSetupDigest: facts.authSetupDigest, targetConfigDigest: facts.targetConfigDigest,
});
const NOW = new Date(Date.parse('2026-10-13T02:00:00Z'));

const apiInput = (scenario: ScenarioRevision = apiScenario(), facts: Partial<ApprovalCurrentFacts> = {}): ApprovalValidityInput => ({
  scenario,
  facts: { ...API_FACTS, ...facts },
  lastApproval: sampleApproval(digestOf(scenario), {
    bound: { ...sampleApproval('x').bound, candidateIdentityDigest: IDENTITY, candidateRuleDigest: RULE },
  }),
  lastRevocation: null,
  now: NOW,
});

const reasonsOf = (input: ApprovalValidityInput): readonly string[] => {
  const validity = evaluateApprovalValidity(input);
  return validity.approved ? [] : validity.reasons;
};

describe('T38c: the approval validity of an API scenario', () => {
  it('has the two reasons of the shapes after the reasons of the templates in the closed list', () => {
    const index = APPROVAL_INVALIDITY_REASONS.indexOf('CANDIDATE_TEMPLATES_UNAVAILABLE');
    expect(APPROVAL_INVALIDITY_REASONS.slice(index + 1, index + 3)).toEqual(['CANDIDATE_SHAPE_CHANGED', 'CANDIDATE_SHAPES_UNAVAILABLE']);
  });

  it('is approved when the shape digest of the scenario is in the shapes of the candidate (the classification is not compared with the kind)', () => {
    expect(evaluateApprovalValidity(apiInput())).toMatchObject({ approved: true });
    // drift CHANGED・NEW でも、digest と型が同じなら受ける（FORM と同じ）。
    expect(evaluateApprovalValidity(apiInput(apiScenario(), { candidate: { ...API_FACTS.candidate, drift: 'CHANGED' } as ApprovalCurrentFacts['candidate'] })))
      .toMatchObject({ approved: true });
  });

  it.each<readonly [string, Partial<ApprovalCurrentFacts>, readonly string[]]>([
    ['the shape is not in the shapes of the candidate', { candidateShapeDigests: [SHAPE_B] }, ['CANDIDATE_SHAPE_CHANGED']],
    ['the candidate has no shape (no probe or a probe without the input fields)', { candidateShapeDigests: [] }, ['CANDIDATE_SHAPE_CHANGED']],
    ['the index row was written before version 13 (no shapes)', { candidateShapeDigests: null }, ['CANDIDATE_SHAPES_UNAVAILABLE']],
    ['no candidate in the index', { candidate: null, candidateShapeDigests: null }, ['CANDIDATE_MISSING']],
    ['a MISSING candidate', { candidate: { ...API_FACTS.candidate, drift: 'MISSING' } as ApprovalCurrentFacts['candidate'] }, ['CANDIDATE_MISSING']],
    ['a NOT_REVISITED candidate', { candidate: { ...API_FACTS.candidate, drift: 'NOT_REVISITED' } as ApprovalCurrentFacts['candidate'] }, ['CANDIDATE_MISSING']],
    ['another rule digest', { candidate: { ...API_FACTS.candidate, ruleDigest: SHAPE_B } as ApprovalCurrentFacts['candidate'] }, ['CANDIDATE_CHANGED']],
    ['another rule digest and another shape', {
      candidate: { ...API_FACTS.candidate, ruleDigest: SHAPE_B } as ApprovalCurrentFacts['candidate'], candidateShapeDigests: [SHAPE_B],
    }, ['CANDIDATE_CHANGED', 'CANDIDATE_SHAPE_CHANGED']],
  ])('needs a new approval when %s', (_label, facts, reasons) => {
    expect(reasonsOf(apiInput(apiScenario(), facts))).toEqual(reasons);
    // 承認がなくても同じ理由（承認の前の判定）。
    expect(reasonsOf({ ...apiInput(apiScenario(), facts), lastApproval: null })).toEqual([...reasons, 'NOT_APPROVED']);
  });

  // T41a（Task 41 の設計書 3.1）: API の UPDATE は、画面の path を型にした識別の digest で見つけた索引の候補の型を照らす（意図した変化。表は
  // `scenario-api-update-contract.test.ts`）。
  it('checks an API UPDATE scenario by the shapes too (it has no UPDATE spec of a form)', () => {
    const templated = `sha256:${'e'.repeat(64)}`;
    const update = apiScenario({
      request: { ...API_SPEC.request, method: 'PATCH' }, filterName: 'id', recordId: null,
      ledger: { targetCreateScenarioId: 'scenario-ledger', formPathTemplate: '/admin/members/{id}/edit' }, keptKeys: [], templatedIdentityDigest: templated,
    }, { kind: 'UPDATE', update: null });
    const templatedFact = {
      templatedIdentityDigests: [templated], ruleDigest: RULE, classification: 'NEEDS_BINDING' as const, drift: 'UNCHANGED' as const,
      shapeDigests: [SHAPE_A, SHAPE_B], keyFieldDigests: [apiKeyFieldsDigestOf(SHAPE_A, API_SPEC.keyFields)],
    };
    expect(evaluateApprovalValidity(apiInput(update, { templatedCandidates: [templatedFact] }))).toMatchObject({ approved: true });
    expect(reasonsOf(apiInput(update, { templatedCandidates: [{ ...templatedFact, shapeDigests: [SHAPE_B] }] }))).toEqual(['CANDIDATE_SHAPE_CHANGED']);
  });

  // LG-3（O5）: v3 の承認の digest の記録が `SCENARIO_REVISION_CHANGED` になる確かめは、一般の判定の `approval-validity.test.ts` にまとめた。

  it('keeps the FORM scenarios on the classification and the kind (the shapes are not looked at)', () => {
    const form = sampleScenario();
    const facts: ApprovalCurrentFacts = {
      ...API_FACTS,
      candidate: { identityDigest: form.candidate.identityDigest, ruleDigest: form.candidate.ruleDigest, classification: 'NEEDS_BINDING', drift: 'UNCHANGED' },
      candidateShapeDigests: null,
    };
    expect(reasonsOf({ scenario: form, facts, lastApproval: sampleApproval(digestOf(form, facts)), lastRevocation: null, now: NOW }))
      .toEqual(['CANDIDATE_CHANGED']);
  });
});

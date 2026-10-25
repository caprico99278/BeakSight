// T41a（Task 41 の設計書 3.1、3.3 のページが決める鍵、4 章、8 章のユーザーの判断 2）: API の更新（UPDATE）の契約と承認。
// - 下書きの表: 保つ鍵（`api.keptKeys`。省けば、目印の付いた欄の鍵のうち変える鍵でないものをすべて保つ）、変える鍵 0 の拒否、更新の画面の欄として
//   識別できないページが決める鍵の拒否（`SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE`。登録は今のまま）、台帳の画面の path の型の `{id}` が画面の path の
//   最後の ID の区切りであること、台帳の ID と filter の結び付け（`apiUpdateLedgerBindingRejectionOf`。保存と発行の確かめ直しが共用する）。
// - digest の表: 画面の path の最後の ID を `{id}` にした識別の digest（`pagePathTemplatedIdentityDigestOf`）は、ID だけが違う 2 つの画面で同じ、
//   構造が違えば違う。索引の型にした digest の一覧（版 14 のまま。印で分けて共用）に入る。
// - 有効性: API の UPDATE は、この digest が最新の索引にあることで判定する（probe したレコードの画面を読み直さなくても `CANDIDATE_MISSING` にしない）。
// - 承認の digest v4: 保つ鍵の一覧（`apiKeptKeys`）と、受けたページが決める鍵の欄の識別を項目に持つ。
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DIGEST_ITEMS,
  approvalDigestDifferencesOf,
  approvalDigestEntriesOf,
  computeApprovalDigest,
  type ApprovalDigestFacts,
} from '../../src/control/approval/approval-digest.js';
import { evaluateApprovalValidity, type ApprovalCurrentFacts, type ApprovalValidityInput } from '../../src/control/approval/approval-validity.js';
import {
  apiKeyFieldsDigestOf,
  scenarioApiMarkedKeyFieldsOf,
  type ScenarioApiSpec,
  type ScenarioKindFact,
  type ScenarioRevision,
} from '../../src/control/approval/scenario-contracts.js';
import {
  SCENARIO_DRAFT_REJECTION_REASONS,
  apiScenarioShapeRejectionOf,
  apiUpdateLedgerBindingRejectionOf,
  assertStorableScenarioRevision,
  storedScenarioRevisionOf,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { discoveryIndexEntryOf } from '../../src/control/job/discovery-index-store.js';
import { apiRequestShapeOf, lastRecordIdLikePathSegmentIndexOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  CANDIDATE_PAGE_TEMPLATE_IDENTITY_DIGEST_FORMAT,
  CANDIDATE_TEMPLATE_IDENTITY_DIGEST_FORMAT,
  pagePathTemplatedIdentityDigestOf,
  templatedIdentityDigestsOf,
} from '../../src/discovery/fingerprint.js';
import { usableRecordIdOf } from '../../src/control/actions/action-outcome.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField, type SubmissionProbeRecord } from '../../src/discovery/submission-probe-contracts.js';
import {
  ALL_CONFIRMED,
  AUTH_SETUP_DIGEST,
  FULL_VERIFICATION,
  INPUT_RULES,
  PROFILE_ID,
  READ_CHECK_FACTS,
  TARGET_CONFIG_DIGEST,
  candidateOf,
  sampleApproval,
  sampleScenario,
} from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton, sampleField, sampleForm } from './discovery-candidate-samples.js';

const API = 'https://api.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const LEDGER_ID = 'scenario-ledger';
const NEW_PATH = '/admin/members/new';
const EDIT_PATH = '/admin/members/1/edit';
const TEMPLATE = '/admin/members/{id}/edit';

/** 押す前に入れた欄（名前・メールアドレスは名前、備考は名前のない number の欄）。テナントは選んだ欄（目印なし）。 */
const MARKED_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#note', type: 'number', marker: 2 },
];
const TENANT_SELECT: SubmissionProbeInputField = { name: 'tenant_id', selector: '#tenant', type: 'select-one', marker: null };

const shapeOf = (pagePath: string, method: string, url: string, body: Readonly<Record<string, unknown>>): ApiRequestShape => apiRequestShapeOf({
  method,
  resourceType: 'fetch',
  url,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation', authorization: 'Bearer x' },
  body: { kind: 'TEXT', text: JSON.stringify(body) },
}, { pagePath, markers: MARKERS });

const MEMBER_BODY = { name: MARKERS[0], email: MARKERS[1], note: Number(MARKERS[2]) };

const probeOf = (shape: ApiRequestShape, inputFields: readonly SubmissionProbeInputField[]): SubmissionProbeRecord =>
  observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
    { filledFieldCount: inputFields.length, skippedFieldCount: 0 }, inputFields);

const buttonOf = (pagePath: string, probe: SubmissionProbeRecord | undefined, submitterText = '保存'): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: pagePath }, submitterText, jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  ...(probe === undefined ? {} : { submissionProbe: probe }),
});

/** 更新の画面の保存（`id=eq.<最後の ID>` の PATCH）の候補。 */
const updateButtonOf = (
  pagePath = EDIT_PATH,
  body: Readonly<Record<string, unknown>> = MEMBER_BODY,
  inputFields: readonly SubmissionProbeInputField[] = MARKED_FIELDS,
  id = '1',
): DiscoveryCandidate => buttonOf(pagePath, probeOf(shapeOf(pagePath, 'PATCH', `${API}/rest/v1/members?id=eq.${id}&select=*`, body), inputFields));

const UPDATE_CANDIDATE = updateButtonOf();
const CREATE_CANDIDATE = buttonOf(NEW_PATH, probeOf(shapeOf(NEW_PATH, 'POST', `${API}/rest/v1/members?select=*`,
  { ...MEMBER_BODY, tenant_id: 'tenant-1' }), MARKED_FIELDS));

/** T41R-fix-B: 台帳は同じ表（同じ API の Origin と path の型）の API の登録。 */
const MEMBERS_REQUEST = Object.freeze({ origin: API, pathShape: '/rest/v1/members' });

const CONTEXT: ScenarioDraftContext = {
  scenarioId: null,
  scenarios: [{ scenarioId: LEDGER_ID, profileId: PROFILE_ID, kind: 'CREATE', apiRequest: MEMBERS_REQUEST }],
  approvedServiceOrigins: [API],
  profileRevisions: { discoveryJob: 2, current: 2 },
};

const contextWithLedger = (ledger: Partial<ScenarioKindFact>): ScenarioDraftContext => ({
  ...CONTEXT,
  scenarios: [{ scenarioId: LEDGER_ID, profileId: PROFILE_ID, kind: 'CREATE', apiRequest: MEMBERS_REQUEST, ...ledger }],
});

const draftOf = (
  candidate: DiscoveryCandidate,
  fieldNames: readonly string[],
  api: Record<string, unknown> = {},
): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames,
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  api: {
    shapeDigest: candidate.submissionProbe?.shapeDigest,
    pageKeys: [],
    filterName: 'id',
    recordId: null,
    ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: TEMPLATE },
    ...api,
  },
});

const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
const validate = (draft: unknown, candidate: DiscoveryCandidate, context: ScenarioDraftContext = CONTEXT): ScenarioDraftValidationResult =>
  validateScenarioDraft(draft, candidate, [], context);

const NAME_FIELD = { key: 'name', type: 'string', field: { kind: 'NAME', name: 'name' }, fieldType: 'text' } as const;
const EMAIL_FIELD = { key: 'email', type: 'string', field: { kind: 'NAME', name: 'email' }, fieldType: 'email' } as const;
const NOTE_FIELD = { key: 'note', type: 'number', field: { kind: 'SELECTOR', selector: '#note' }, fieldType: 'number' } as const;

describe('T41a: the kept keys of an API UPDATE draft', () => {
  it('accepts the changed keys and the kept keys, sends only the changed keys, and keeps the field of each kept key (no value)', () => {
    const result = validate(draftOf(UPDATE_CANDIDATE, ['name'], { keptKeys: ['email', 'note'] }), UPDATE_CANDIDATE);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    // 保つ鍵には生成した値を作らない（送る欄 `fieldNames` は変える鍵だけ）。
    expect(result.content.fieldNames).toEqual(['name']);
    expect(result.content.api?.keyFields).toEqual([NAME_FIELD]);
    expect(result.content.api?.keptKeys).toEqual([EMAIL_FIELD, NOTE_FIELD]);
    expect(scenarioApiMarkedKeyFieldsOf(result.content.api as ScenarioApiSpec)).toEqual([EMAIL_FIELD, NAME_FIELD, NOTE_FIELD]);
    expect(JSON.stringify(result.content)).not.toContain('bsprobe');
    expect(validateControlDocument('scenario', { ...sampleScenario(), ...result.content, inputRuleReference: null }).ok).toBe(true);
  });

  it('keeps every marked key that is not changed when the kept keys are left out (the default is to keep, the e-mail too)', () => {
    const result = validate(draftOf(UPDATE_CANDIDATE, ['note']), UPDATE_CANDIDATE);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.keyFields).toEqual([NOTE_FIELD]);
    expect(result.content.api?.keptKeys).toEqual([EMAIL_FIELD, NAME_FIELD]);
  });

  it('gives a CREATE no kept keys (every marked key is sent, as before)', () => {
    const result = validate(draftOf(CREATE_CANDIDATE, ['email', 'name', 'note'], { pageKeys: ['tenant_id'], filterName: null, ledger: null }), CREATE_CANDIDATE);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.keptKeys).toBeUndefined();
    expect(result.content.api?.templatedIdentityDigest).toBeUndefined();
    expect(result.content.api?.pageKeys).toEqual([{ key: 'tenant_id', type: 'string' }]);
  });

  it.each<readonly [string, () => readonly [Record<string, unknown>, DiscoveryCandidate], readonly string[]]>([
    ['no changed key', () => [draftOf(UPDATE_CANDIDATE, [], { keptKeys: ['email', 'name', 'note'] }), UPDATE_CANDIDATE], ['SCENARIO_UPDATE_NO_CHANGED_FIELD']],
    ['no changed key (the default keeps every key)', () => [draftOf(UPDATE_CANDIDATE, []), UPDATE_CANDIDATE], ['SCENARIO_UPDATE_NO_CHANGED_FIELD']],
    ['a key that is both changed and kept', () => [draftOf(UPDATE_CANDIDATE, ['name'], { keptKeys: ['email', 'name', 'note'] }), UPDATE_CANDIDATE],
      ['SCENARIO_UPDATE_FIELD_ROLE_OVERLAP']],
    ['a marked key that is neither changed nor kept', () => [draftOf(UPDATE_CANDIDATE, ['name'], { keptKeys: ['email'] }), UPDATE_CANDIDATE],
      ['SCENARIO_UPDATE_FIELD_ROLE_MISSING']],
    ['a kept key that is not a key with an input field', () => [draftOf(UPDATE_CANDIDATE, ['name'], { keptKeys: ['email', 'note', 'other'] }), UPDATE_CANDIDATE],
      ['SCENARIO_API_FIELD_KEY_MISMATCH']],
    ['kept keys in a CREATE', () => [draftOf(CREATE_CANDIDATE, ['email', 'name', 'note'], {
      pageKeys: ['tenant_id'], filterName: null, ledger: null, keptKeys: ['email'],
    }), CREATE_CANDIDATE], ['SCENARIO_API_FIELD_KEY_MISMATCH']],
    ['a kept key that looks like a secret', () => {
      const candidate = updateButtonOf(EDIT_PATH, { name: MARKERS[0], pin: MARKERS[1] }, [
        { name: 'name', selector: '#name', type: 'text', marker: 0 },
        { name: 'pin', selector: '#pin', type: 'text', marker: 1 },
      ]);
      return [draftOf(candidate, ['name'], { keptKeys: ['pin'] }), candidate];
    }, ['SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD']],
  ])('rejects %s', (_label, make, codes) => {
    const [draft, candidate] = make();
    expect(codesOf(validate(draft, candidate))).toEqual(codes);
  });

  it('rejects a kept key list of the wrong shape as an invalid input', () => {
    for (const keptKeys of [null, 'email', [''], ['email', 'email'], [1]]) {
      expect(codesOf(validate(draftOf(UPDATE_CANDIDATE, ['name'], { keptKeys }), UPDATE_CANDIDATE))).toEqual(['SCENARIO_INPUT_INVALID']);
    }
  });
});

describe('T41a: the keys decided by the page of an API UPDATE (the user decision 2)', () => {
  const body = { ...MEMBER_BODY, tenant_id: 'tenant-1' };

  it('has the two reasons of T41a at the end of the closed list', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS.slice(-2)).toEqual(['SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE', 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID']);
  });

  it('accepts a page key that is a field of the update page (a selected field of the same name), with its field identity', () => {
    const candidate = updateButtonOf(EDIT_PATH, body, [...MARKED_FIELDS, TENANT_SELECT]);
    const result = validate(draftOf(candidate, ['name'], { pageKeys: ['tenant_id'] }), candidate);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.pageKeys).toEqual([{ key: 'tenant_id', type: 'string', field: { kind: 'NAME', name: 'tenant_id' } }]);
    expect(validateControlDocument('scenario', { ...sampleScenario(), ...result.content, inputRuleReference: null }).ok).toBe(true);
  });

  it('rejects a page key that cannot be identified as a field of the update page', () => {
    const candidate = updateButtonOf(EDIT_PATH, body);
    expect(codesOf(validate(draftOf(candidate, ['name'], { pageKeys: ['tenant_id'] }), candidate))).toEqual(['SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE']);
    // 同じ名前の選んだ欄が 2 つあれば、どちらか決められない。
    const twice = updateButtonOf(EDIT_PATH, body, [...MARKED_FIELDS, TENANT_SELECT, { ...TENANT_SELECT, selector: '#tenant-2' }]);
    expect(codesOf(validate(draftOf(twice, ['name'], { pageKeys: ['tenant_id'] }), twice))).toEqual(['SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE']);
  });

  it('keeps the page keys of a CREATE as they are (no field identity is needed)', () => {
    expect(codesOf(validate(draftOf(CREATE_CANDIDATE, ['email', 'name', 'note'], { pageKeys: ['tenant_id'], filterName: null, ledger: null }),
      CREATE_CANDIDATE))).toEqual([]);
  });
});

describe('T41a: the place of {id} in the form path template of the ledger', () => {
  const nestedPath = '/admin/orgs/7/members/1/edit';
  const nested = updateButtonOf(nestedPath);

  it('finds the last record id segment of a page path (the position in the split by slash)', () => {
    expect(lastRecordIdLikePathSegmentIndexOf(nestedPath)).toBe(5);
    expect(lastRecordIdLikePathSegmentIndexOf(EDIT_PATH)).toBe(3);
    expect(lastRecordIdLikePathSegmentIndexOf('/admin/members/new')).toBeNull();
  });

  it('accepts {id} at the last record id segment of the page path, and rejects it at another record id segment', () => {
    expect(codesOf(validate(draftOf(nested, ['name'], { ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: '/admin/orgs/7/members/{id}/edit' } }),
      nested))).toEqual([]);
    expect(codesOf(validate(draftOf(nested, ['name'], { ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: '/admin/orgs/{id}/members/1/edit' } }),
      nested))).toEqual(['SCENARIO_UPDATE_PATH_MISMATCH']);
  });

  it('carries the templated identity digest of the page path in the content', () => {
    const result = validate(draftOf(UPDATE_CANDIDATE, ['name']), UPDATE_CANDIDATE);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.api?.templatedIdentityDigest).toBe(pagePathTemplatedIdentityDigestOf(UPDATE_CANDIDATE));
    expect(result.content.api?.templatedIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});

describe('T41a: the binding of the ledger id to the filter', () => {
  it.each<readonly [string, Partial<ScenarioKindFact>, readonly string[]]>([
    ['an API CREATE ledger that takes the id from the response key of the filter name', { apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' } }, []],
    ['an API CREATE ledger that takes the id from another response key', { apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'member_id' } },
      ['SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID']],
    ['a ledger whose URL pattern has the same segments around {id}', { recordId: { source: 'URL_PATH_PATTERN', pathPattern: TEMPLATE } }, []],
    // T41b（設計者の判断 (1)）: `{id}` の位置と前の区切りが同じことだけを求める（後ろは違ってよい。位置が違えば結び付かない）。
    ['a ledger whose URL pattern has {id} at another position', { recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}/edit' } },
      ['SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID']],
    ['a ledger whose URL pattern has other segments after {id}', { recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}' } }, []],
    ['a ledger whose URL pattern has other segments before {id}', { recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/admin/groups/{id}/edit' } },
      ['SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID']],
    ['a ledger with no way to take the id (nothing to bind; the grant stops with no verified record)', {}, []],
  ])('checks %s', (_label, ledger, codes) => {
    expect(codesOf(validate(draftOf(UPDATE_CANDIDATE, ['name']), UPDATE_CANDIDATE, contextWithLedger(ledger)))).toEqual(codes);
  });

  it('is one part for the save and for the check again at the issue (the response key comes before the URL pattern)', () => {
    // T41R-fix-B: 更新と台帳は同じ表（同じ表でない組の表は `api-update-grant-start.test.ts`）。
    const update = { filterName: 'id', formPathTemplate: TEMPLATE, ...MEMBERS_REQUEST };
    const ledger = { apiRequest: MEMBERS_REQUEST };
    expect(apiUpdateLedgerBindingRejectionOf(update, { ...ledger, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' }, recordId: null })).toBeNull();
    expect(apiUpdateLedgerBindingRejectionOf(update, {
      ...ledger, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' }, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/other/{id}' },
    })).toBeNull();
    expect(apiUpdateLedgerBindingRejectionOf(update, { ...ledger, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'uuid' }, recordId: null }))
      .toBe('SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID');
    expect(apiUpdateLedgerBindingRejectionOf(update, { ...ledger, apiRecordId: null, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/x/{id}' } }))
      .toBe('SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID');
    expect(apiUpdateLedgerBindingRejectionOf({ ...update, filterName: null }, { ...ledger, apiRecordId: { source: 'RESPONSE_BODY_KEY', key: 'id' }, recordId: null }))
      .toBe('SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID');
  });
});

describe('T41a: the templated identity digest of the page path (a candidate without a form)', () => {
  const pageButton = (path: string, submitterText = '保存'): DiscoveryCandidate => buttonOf(path, undefined, submitterText);

  it('is the same for two pages that differ only by the last id, and differs when the structure differs', () => {
    const first = pagePathTemplatedIdentityDigestOf(pageButton('/admin/members/1/edit'));
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(pagePathTemplatedIdentityDigestOf(pageButton('/admin/members/2/edit'))).toBe(first);
    expect(pagePathTemplatedIdentityDigestOf(pageButton('/admin/members/0b7c1c9e-2f43-4a7e-9a52-3c0f5d1e8a10/edit'))).toBe(first);
    for (const other of [
      pagePathTemplatedIdentityDigestOf(pageButton('/admin/groups/1/edit')),
      pagePathTemplatedIdentityDigestOf(pageButton('/admin/members/1/view')),
      pagePathTemplatedIdentityDigestOf(pageButton('/admin/members/1/edit', '送信')),
    ]) {
      expect(other).not.toBe(first);
    }
    // ほかの ID の区切り（組織の ID）が違えば、構造の違いとして違う digest（最後の ID だけを `{id}` にする）。
    expect(pagePathTemplatedIdentityDigestOf(pageButton('/admin/orgs/7/members/1/edit')))
      .not.toBe(pagePathTemplatedIdentityDigestOf(pageButton('/admin/orgs/8/members/1/edit')));
    expect(pagePathTemplatedIdentityDigestOf(pageButton('/admin/orgs/7/members/1/edit')))
      .toBe(pagePathTemplatedIdentityDigestOf(pageButton('/admin/orgs/7/members/2/edit')));
  });

  it('is null for a candidate with a form, and for a page path without an id', () => {
    expect(pagePathTemplatedIdentityDigestOf(candidateOf(sampleForm({ page: { origin: SAMPLE_ORIGIN, path: '/admin/members/1/edit' } })))).toBeNull();
    expect(pagePathTemplatedIdentityDigestOf(pageButton('/admin/members/new'))).toBeNull();
  });

  it('has its own format mark, apart from the templated identity digest of a form', () => {
    expect(CANDIDATE_PAGE_TEMPLATE_IDENTITY_DIGEST_FORMAT).not.toBe(CANDIDATE_TEMPLATE_IDENTITY_DIGEST_FORMAT);
    expect(CANDIDATE_PAGE_TEMPLATE_IDENTITY_DIGEST_FORMAT).toBe('beaksight-candidate-page-template-identity/1');
  });

  it('is written in the templated identity digests of the index entry (the same column, version 14), and a form entry keeps its own digests', () => {
    const entry = discoveryIndexEntryOf(UPDATE_CANDIDATE);
    expect(entry.templatedIdentityDigests).toEqual([pagePathTemplatedIdentityDigestOf(UPDATE_CANDIDATE)]);
    expect(discoveryIndexEntryOf(buttonOf('/admin/members/new', undefined)).templatedIdentityDigests).toEqual([]);
    const form = candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/members/1/edit' },
      action: { origin: SAMPLE_ORIGIN, path: '/members/1', queryNames: [] },
      fields: [sampleField('name')],
    }));
    expect(pagePathTemplatedIdentityDigestOf(form)).toBeNull();
    expect(discoveryIndexEntryOf(form).templatedIdentityDigests).toEqual(templatedIdentityDigestsOf(form, (value) => usableRecordIdOf(value) !== null));
    expect(discoveryIndexEntryOf(form).templatedIdentityDigests.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 承認の digest と有効性
// ---------------------------------------------------------------------------------------------------------------

const SHAPE_A = `sha256:${'a'.repeat(64)}`;
const SHAPE_B = `sha256:${'b'.repeat(64)}`;
const IDENTITY = `sha256:${'c'.repeat(64)}`;
const RULE = `sha256:${'d'.repeat(64)}`;
const TEMPLATED = `sha256:${'e'.repeat(64)}`;
const OTHER_TEMPLATED = `sha256:${'f'.repeat(64)}`;

const UPDATE_SPEC: ScenarioApiSpec = Object.freeze({
  shapeDigest: SHAPE_A,
  request: { method: 'PATCH', origin: API, pathShape: '/rest/v1/members', queryNames: ['select'], contentType: 'application/json', prefer: [] },
  keyFields: [NAME_FIELD],
  keptKeys: [EMAIL_FIELD, NOTE_FIELD],
  pageKeys: [{ key: 'tenant_id', type: 'string', field: { kind: 'NAME', name: 'tenant_id' } }],
  headerNames: ['authorization', 'content-type'],
  filterName: 'id',
  recordId: null,
  ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: TEMPLATE },
  templatedIdentityDigest: TEMPLATED,
} satisfies ScenarioApiSpec);

const updateScenario = (api: Partial<ScenarioApiSpec> = {}, spec: ScenarioApiSpec = UPDATE_SPEC): ScenarioRevision => ({
  ...sampleScenario(),
  kind: 'UPDATE',
  candidate: { identityDigest: IDENTITY, ruleDigest: RULE },
  transport: 'API',
  request: null,
  api: { ...spec, ...api },
  fieldNames: ['name'],
  verification: { ...FULL_VERIFICATION, readVerification: null },
  update: null,
});

const DIGEST_FACTS: ApprovalDigestFacts = Object.freeze({ profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST });

describe('T41a: the approval digest v4 of an API UPDATE', () => {
  it('has the kept keys as the last item, and gives the field identity of an accepted page key', () => {
    expect(APPROVAL_DIGEST_ITEMS.at(-1)).toBe('apiKeptKeys');
    const entries = approvalDigestEntriesOf(updateScenario(), DIGEST_FACTS);
    expect(entries.apiKeptKeys).toEqual(['["email","string","NAME","email","email"]', '["note","number","SELECTOR","#note","number"]']);
    expect(entries.apiPageKeys).toEqual(['["tenant_id","string","NAME","tenant_id"]']);
    expect(entries.apiKeyFields).toEqual(['["name","string","NAME","name","text"]']);
    // FORM のシナリオと、保つ鍵のない API の登録は null と空でない（登録は null）。
    expect(approvalDigestEntriesOf(sampleScenario(), DIGEST_FACTS).apiKeptKeys).toBeNull();
    const { keptKeys: _kept, ...createSpec } = UPDATE_SPEC;
    expect(approvalDigestEntriesOf({ ...updateScenario(), kind: 'CREATE', api: createSpec }, DIGEST_FACTS).apiKeptKeys).toBeNull();
  });

  it.each<readonly [string, Partial<ScenarioApiSpec>, string]>([
    ['a kept key', { keptKeys: [EMAIL_FIELD] }, 'apiKeptKeys'],
    ['the field of a kept key', { keptKeys: [EMAIL_FIELD, { ...NOTE_FIELD, field: { kind: 'SELECTOR', selector: '#memo' } }] }, 'apiKeptKeys'],
    ['the field of a page key', { pageKeys: [{ key: 'tenant_id', type: 'string', field: { kind: 'SELECTOR', selector: '#tenant' } }] }, 'apiPageKeys'],
    ['the templated identity digest', { templatedIdentityDigest: OTHER_TEMPLATED }, 'apiLedger'],
  ])('changes the digest and shows the item when %s changes', (_label, change, item) => {
    const before = updateScenario();
    const after = updateScenario(change);
    expect(computeApprovalDigest(after, DIGEST_FACTS)).not.toBe(computeApprovalDigest(before, DIGEST_FACTS));
    expect(approvalDigestDifferencesOf({ scenario: before, facts: DIGEST_FACTS }, { scenario: after, facts: DIGEST_FACTS }).map((difference) => difference.item))
      .toEqual([item]);
  });

  it('does not depend on the order of the kept keys', () => {
    expect(computeApprovalDigest(updateScenario({ keptKeys: [NOTE_FIELD, EMAIL_FIELD] }), DIGEST_FACTS))
      .toBe(computeApprovalDigest(updateScenario(), DIGEST_FACTS));
  });
});

const KEY_FIELDS_DIGEST = apiKeyFieldsDigestOf(SHAPE_A, [NAME_FIELD, EMAIL_FIELD, NOTE_FIELD]);
const TEMPLATED_FACT = Object.freeze({
  templatedIdentityDigests: [TEMPLATED], ruleDigest: RULE, classification: 'NEEDS_BINDING' as const, drift: 'NEW' as const,
  shapeDigests: [SHAPE_A], keyFieldDigests: [KEY_FIELDS_DIGEST],
});

const UPDATE_FACTS: ApprovalCurrentFacts = Object.freeze<ApprovalCurrentFacts>({
  profile: { profileId: PROFILE_ID, revision: 4, status: 'ACTIVE', mode: 'TEST_APPROVED_WRITE', approvedServiceOrigins: [API] },
  authSetupDigest: AUTH_SETUP_DIGEST,
  targetConfigDigest: TARGET_CONFIG_DIGEST,
  // probe したレコードの画面は、次の発見で読み直さない（索引に同じ識別の digest の候補がない）。
  candidate: null,
  candidateShapeDigests: null,
  candidateKeyFieldDigests: null,
  apiShapeOriginIndex: 0,
  latestDiscoveryProfileRevision: 4,
  templatedCandidates: [TEMPLATED_FACT],
  inputRuleReference: INPUT_RULES,
  readChecks: READ_CHECK_FACTS,
});

const NOW = new Date(Date.parse('2026-10-13T02:00:00Z'));
const inputOf = (scenario: ScenarioRevision = updateScenario(), facts: Partial<ApprovalCurrentFacts> = {}): ApprovalValidityInput => ({
  scenario,
  facts: { ...UPDATE_FACTS, ...facts },
  lastApproval: sampleApproval(computeApprovalDigest(scenario, DIGEST_FACTS), {
    bound: { ...sampleApproval('x').bound, candidateIdentityDigest: IDENTITY, candidateRuleDigest: RULE },
  }),
  lastRevocation: null,
  now: NOW,
});
const reasonsOf = (input: ApprovalValidityInput): readonly string[] => {
  const validity = evaluateApprovalValidity(input);
  return validity.approved ? [] : validity.reasons;
};

describe('T41a: the approval validity of an API UPDATE by the templated identity digest of the page path', () => {
  it('is approved when the digest is in the latest index, even when the probed record page was not read again', () => {
    expect(evaluateApprovalValidity(inputOf())).toMatchObject({ approved: true });
    // 別のレコードの画面の候補（同じ型にした識別）でも受ける。
    expect(evaluateApprovalValidity(inputOf(updateScenario(), {
      templatedCandidates: [{ ...TEMPLATED_FACT, templatedIdentityDigests: [OTHER_TEMPLATED] }, TEMPLATED_FACT],
    }))).toMatchObject({ approved: true });
  });

  it.each<readonly [string, ScenarioRevision, Partial<ApprovalCurrentFacts>, readonly string[]]>([
    ['the digest is in no candidate of the index', updateScenario(), { templatedCandidates: [{ ...TEMPLATED_FACT, templatedIdentityDigests: [OTHER_TEMPLATED] }] },
      ['CANDIDATE_MISSING']],
    ['the candidate of the digest is MISSING', updateScenario(), { templatedCandidates: [{ ...TEMPLATED_FACT, drift: 'MISSING' }] }, ['CANDIDATE_MISSING']],
    ['the index has no templated digests yet', updateScenario(), { templatedCandidates: null }, ['CANDIDATE_TEMPLATES_UNAVAILABLE']],
    ['the rule digest changed', updateScenario(), { templatedCandidates: [{ ...TEMPLATED_FACT, ruleDigest: SHAPE_B }] }, ['CANDIDATE_CHANGED']],
    ['the shape changed', updateScenario(), { templatedCandidates: [{ ...TEMPLATED_FACT, shapeDigests: [SHAPE_B] }] }, ['CANDIDATE_SHAPE_CHANGED']],
    ['the candidate row has no shapes', updateScenario(), { templatedCandidates: [{ ...TEMPLATED_FACT, shapeDigests: null }] }, ['CANDIDATE_SHAPES_UNAVAILABLE']],
    ['the fields of the keys changed', updateScenario(), {
      templatedCandidates: [{ ...TEMPLATED_FACT, keyFieldDigests: [apiKeyFieldsDigestOf(SHAPE_A, [NAME_FIELD])] }],
    }, ['CANDIDATE_FIELDS_CHANGED']],
  ])('needs a new approval when %s', (_label, scenario, facts, reasons) => {
    expect(reasonsOf(inputOf(scenario, facts))).toEqual(reasons);
  });

  // LG-3（2026-10-24 の設計 3.7.2）: T41a の前に保存した API の更新（型にした識別の digest・保つ鍵・台帳の参照がない）は、スキーマで誤りにする（保存の
  // 部品は読まずに `DATABASE_INTEGRITY_FAILED` で止まる）。判定に渡されたら呼び出し側の誤り（理由 `UPDATE_SPEC_MISSING` は捨てた）。
  it('never approves an API UPDATE without the templated digest (a caller error, LG-3)', () => {
    const { templatedIdentityDigest: _digest, ...before } = UPDATE_SPEC;
    expect(() => evaluateApprovalValidity(inputOf(updateScenario({}, before)))).toThrow(RangeError);
  });
});

describe('LG-3: the scenario schema of an API UPDATE has the contract of T41a', () => {
  const documentOf = (scenario: ScenarioRevision): unknown => JSON.parse(JSON.stringify(scenario)) as unknown;
  const { templatedIdentityDigest: _digest, ...withoutDigest } = UPDATE_SPEC;
  const { keptKeys: _kept, ...withoutKept } = UPDATE_SPEC;

  it('accepts an API UPDATE with the kept keys, the templated identity digest and the ledger', () => {
    expect(validateControlDocument('scenario', documentOf(updateScenario()))).toEqual({ ok: true });
  });

  it.each<readonly [string, ScenarioApiSpec]>([
    ['without the templated identity digest', withoutDigest],
    ['without the kept keys', withoutKept],
    ['with a null ledger', { ...UPDATE_SPEC, ledger: null }],
  ])('rejects an API UPDATE %s (saved before T41a)', (_label, spec) => {
    expect(validateControlDocument('scenario', documentOf(updateScenario({}, spec))).ok).toBe(false);
    // 保存（`assertStorableScenarioRevision`）と読み出し（`storedScenarioRevisionOf`。保存の部品は `DATABASE_INTEGRITY_FAILED`）の両方で止まる。
    expect(() => assertStorableScenarioRevision(updateScenario({}, spec))).toThrow(RangeError);
    expect(() => storedScenarioRevisionOf(documentOf(updateScenario({}, spec)))).toThrow(RangeError);
  });

  it('keeps an API CREATE without the kept keys, the templated identity digest and the ledger', () => {
    const { keptKeys: _k, templatedIdentityDigest: _t, ...create } = UPDATE_SPEC;
    expect(validateControlDocument('scenario', documentOf({ ...updateScenario({}, { ...create, ledger: null, filterName: null }), kind: 'CREATE' }))).toEqual({ ok: true });
  });
});

// T41e-2（発見事項 1 の設計者の判断）: 欄として識別できないページが決める鍵を持つ更新の型は、その鍵を許しても外しても保存できない。候補の一覧（API の
// シナリオを作る入口）で、理由つきで示す。判定は下書きの確かめと同じ部品（ページが決める鍵の欄の識別）。
describe('T41e-2: the shape that cannot become an API update scenario', () => {
  const tenantBody = { ...MEMBER_BODY, tenant_id: 'tenant-1' };

  it('names the reason for an update shape with a page key that is not a field of the update page, the same as the draft', () => {
    const candidate = updateButtonOf(EDIT_PATH, tenantBody);
    expect(apiScenarioShapeRejectionOf(candidate.submissionProbe as SubmissionProbeRecord)).toBe('SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE');
    // 下書きも、その鍵を許すと NOT_IDENTIFIABLE、外すと KEY_NOT_ALLOWED で、どちらも保存できない。
    expect(codesOf(validate(draftOf(candidate, ['name'], { pageKeys: ['tenant_id'] }), candidate))).toEqual(['SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE']);
    expect(codesOf(validate(draftOf(candidate, ['name']), candidate))).toEqual(['SCENARIO_API_KEY_NOT_ALLOWED']);
  });

  it('names no reason for an update shape whose page keys are fields of the update page, without page keys, or for a create shape', () => {
    expect(apiScenarioShapeRejectionOf(updateButtonOf(EDIT_PATH, tenantBody, [...MARKED_FIELDS, TENANT_SELECT]).submissionProbe as SubmissionProbeRecord)).toBeNull();
    expect(apiScenarioShapeRejectionOf(UPDATE_CANDIDATE.submissionProbe as SubmissionProbeRecord)).toBeNull();
    expect(apiScenarioShapeRejectionOf(CREATE_CANDIDATE.submissionProbe as SubmissionProbeRecord)).toBeNull();
  });
});

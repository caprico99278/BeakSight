// FM2b（手を減らす段 2 の設計書 3A.2、5 章の 2026-10-22 の FM2b の Blocker の判断（案 2））: シナリオの下書きをボタン 1 回で作るときの純粋な部品
// （`src/control/approval/api-scenario-autodraft.ts`）。
// - 作る順（登録の下書きが先、更新は後。更新は保存せず、作成の画面へ案内する）、`recordId.key` の推し、台帳の結び付けの判定（更新の画面を前もって
//   選ぶ値）、照合の READ の `{id}` の画面の型と期待の欄の推し、既にあるものの判定、推測の印と根拠、表示のときの求め直しを確かめる。
// - 副作用の確認の 4 項目は、必ず偽で作る（3A 章の共通の決まり）。管理データ・ファイル・画面に依らない（同じ入力に同じ出力）。
import { describe, expect, it } from 'vitest';
import {
  AUTO_DRAFT_EXPECTATION_OUTCOMES,
  AUTO_DRAFT_SCENARIO_ID_PREFIX,
  autoDraftExpectationStepOf,
  autoDraftScenarioIdOf,
  AUTO_DRAFT_BLOCKERS,
  AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS,
  autoDraftBlockerOf,
  autoDraftReadCheckChoiceOf,
  apiAutoDraftPlanOf,
  apiAutoDraftRowsOf,
  apiUpdateDraftPresetOf,
  autoDraftInferredItemsOf,
  autoDraftReadCheckDefinitionOf,
  autoDraftReadVerificationOf,
  inferredReadExpectationOf,
  inferredReadPageTemplateOf,
  inferredRecordIdKeyOf,
  isAutoDraftDiscoveryStale,
  type AutoDraftScenarioFact,
} from '../../src/control/approval/api-scenario-autodraft.js';
import { apiScenarioFormOf, type ApiScenarioFormProposal } from '../../src/control/approval/api-scenario-draft.js';
import {
  APPROVAL_TTL_DAYS,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  SIDE_EFFECT_CONFIRMATIONS,
  type ScenarioApiSpec,
  type ScenarioKindFact,
} from '../../src/control/approval/scenario-contracts.js';
import { DRAFT_VALUE_ORIGINS } from '../../src/control/approval/draft-value-origin.js';
import { validateScenarioDraft, type ScenarioDraftContext } from '../../src/control/approval/scenario-policy.js';
import { DRAFT_VALUE_ORIGIN_CATALOG } from '../../src/presentation/catalog.js';
import { apiRequestShapeOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField, type SubmissionProbeRecord } from '../../src/discovery/submission-probe-contracts.js';
import { PROFILE_ID, candidateOf } from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'https://api.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid'];
const NEW_PATH = '/admin/members/new';
const EDIT_PATH = '/admin/members/1/edit';
const MEMBERS = '/rest/v1/members';

const MARKED_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
];
const MEMBER_BODY = { name: MARKERS[0], email: MARKERS[1] };

const shapeOf = (pagePath: string, method: string, url: string, body: Readonly<Record<string, unknown>>): ApiRequestShape => apiRequestShapeOf({
  method,
  resourceType: 'fetch',
  url,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation' },
  body: { kind: 'TEXT', text: JSON.stringify(body) },
}, { pagePath, markers: MARKERS });

const probeOf = (shape: ApiRequestShape): SubmissionProbeRecord =>
  observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
    { filledFieldCount: MARKED_FIELDS.length, skippedFieldCount: 0 }, MARKED_FIELDS);

const buttonOf = (pagePath: string, probe: SubmissionProbeRecord | undefined): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: pagePath }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  ...(probe === undefined ? {} : { submissionProbe: probe }),
});

/** 登録（会員の表。`tenant_id` は欄に対応しない鍵）。 */
const CREATE = buttonOf(NEW_PATH, probeOf(shapeOf(NEW_PATH, 'POST', `${API}${MEMBERS}?select=*`, { ...MEMBER_BODY, tenant_id: 'tenant-1' })));
/** 更新（会員の表。filter は `id`）。 */
const UPDATE = buttonOf(EDIT_PATH, probeOf(shapeOf(EDIT_PATH, 'PATCH', `${API}${MEMBERS}?id=eq.1&select=*`, MEMBER_BODY)));
/** 別の表の更新（filter は `code`。会員の表の登録の鍵の推しに使わない）。 */
const GROUP_UPDATE = buttonOf('/admin/groups/2/edit', probeOf(shapeOf('/admin/groups/2/edit', 'PATCH', `${API}/rest/v1/groups?code=eq.2&select=*`, MEMBER_BODY)));
/** 同じ表で filter の名前が違う更新（`uid`）。 */
const OTHER_FILTER_UPDATE = buttonOf('/admin/members/3/settings', probeOf(shapeOf('/admin/members/3/settings', 'PATCH',
  `${API}${MEMBERS}?uid=eq.3&select=*`, MEMBER_BODY)));
/** probe のない候補（API の行でない）。 */
const PLAIN = buttonOf('/admin/other', undefined);

const CONTEXT: ScenarioDraftContext = Object.freeze({
  scenarioId: null,
  scenarios: Object.freeze([]),
  approvedServiceOrigins: Object.freeze([API]),
  profileRevisions: Object.freeze({ discoveryJob: 2, current: 2 }),
}) as ScenarioDraftContext;

const NOTHING_CONFIRMED = Object.fromEntries(SIDE_EFFECT_CONFIRMATIONS.map((item) => [item, false]));
const shapeDigestOf = (candidate: DiscoveryCandidate): string => candidate.submissionProbe?.shapeDigest ?? '';

const planOf = (candidates: readonly DiscoveryCandidate[], scenarios: readonly AutoDraftScenarioFact[] = [], context = CONTEXT) =>
  apiAutoDraftPlanOf({ profileId: PROFILE_ID, candidates, context, scenarios });

/** 登録のシナリオの事実（台帳の結び付けに要る項目）。 */
const ledgerFactOf = (scenarioId: string, recordIdKey: string | null, pathShape = MEMBERS): ScenarioKindFact => ({
  scenarioId,
  profileId: PROFILE_ID,
  kind: 'CREATE',
  recordId: null,
  apiRecordId: recordIdKey === null ? null : { source: 'RESPONSE_BODY_KEY', key: recordIdKey },
  apiRequest: { origin: API, pathShape },
});

const updateFormOf = (scenarios: readonly ScenarioKindFact[]): ApiScenarioFormProposal => {
  const { form } = apiScenarioFormOf({
    profileId: PROFILE_ID,
    candidate: UPDATE,
    context: { ...CONTEXT, scenarios },
    scenarios: scenarios.map(({ scenarioId, kind }) => ({ scenarioId, kind, pagePath: NEW_PATH })),
  });
  if (form === null) {
    throw new Error('the update has no form');
  }
  return form;
};

describe('FM2b: the order and the rows of the automatic drafts', () => {
  it('takes the API rows only, the creates first and the updates after, without duplicates', () => {
    const rows = apiAutoDraftRowsOf([UPDATE, PLAIN, CREATE, UPDATE, GROUP_UPDATE]);
    expect(rows.map(({ kind, candidate }) => [kind, candidate.page.path])).toEqual([
      ['CREATE', NEW_PATH],
      ['UPDATE', EDIT_PATH],
      ['UPDATE', '/admin/groups/2/edit'],
    ]);
    expect(rows.map(({ shapeDigest }) => shapeDigest)).toEqual([shapeDigestOf(CREATE), shapeDigestOf(UPDATE), shapeDigestOf(GROUP_UPDATE)]);
  });

  it('tells a stale discovery (the profile revision of the discovery job is not the current one)', () => {
    expect(isAutoDraftDiscoveryStale(CONTEXT)).toBe(false);
    expect(isAutoDraftDiscoveryStale({ ...CONTEXT, profileRevisions: { discoveryJob: 1, current: 2 } })).toBe(true);
    expect(isAutoDraftDiscoveryStale({ ...CONTEXT, profileRevisions: { discoveryJob: null, current: 2 } })).toBe(true);
    const { profileRevisions: _omitted, ...withoutRevisions } = CONTEXT;
    expect(isAutoDraftDiscoveryStale(withoutRevisions)).toBe(true);
  });
});

describe('FM2b: the record id key of a create, inferred from the filter of an update of the same table', () => {
  it('infers the key from the only filter name of the updates of the same origin and path shape (an inferred value with the ground)', () => {
    const [createRow] = apiAutoDraftRowsOf([CREATE]);
    const rows = apiAutoDraftRowsOf([CREATE, UPDATE, GROUP_UPDATE]);
    expect(createRow).toBeDefined();
    expect(inferredRecordIdKeyOf(createRow?.candidate as DiscoveryCandidate, rows, [API]))
      .toEqual({ value: 'id', origin: 'INFERRED', ground: 'RECORD_ID_KEY_FROM_UPDATE_FILTER' });
  });

  it('infers nothing without an update of the same table, or with two filter names', () => {
    expect(inferredRecordIdKeyOf(CREATE, apiAutoDraftRowsOf([CREATE, GROUP_UPDATE]), [API])).toBeNull();
    expect(inferredRecordIdKeyOf(CREATE, apiAutoDraftRowsOf([CREATE, UPDATE, OTHER_FILTER_UPDATE]), [API])).toBeNull();
    // 承認したサービスの Origin の外の型は、同じ表と言えない。
    expect(inferredRecordIdKeyOf(CREATE, apiAutoDraftRowsOf([CREATE, UPDATE]), [])).toBeNull();
  });
});

describe('FM2b: the plan of the automatic drafts', () => {
  it('makes a create draft with every key of a field, every selectable page key, the defaults, the inferred record id key and no side effect confirmed', () => {
    const plan = planOf([CREATE, UPDATE]);
    expect(plan.creates).toHaveLength(1);
    const [create] = plan.creates;
    if (create?.status !== 'NEW') {
      throw new Error(`the create is ${create?.status}`);
    }
    expect(create.draft).toEqual({
      profileId: PROFILE_ID,
      candidateIdentityDigest: CREATE.identityDigest,
      transport: 'API',
      fieldNames: ['email', 'name'],
      readChecks: [],
      sideEffectConfirmations: NOTHING_CONFIRMED,
      limits: { maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN, maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES },
      approvalTtlDays: APPROVAL_TTL_DAYS,
      api: { shapeDigest: shapeDigestOf(CREATE), pageKeys: ['tenant_id'], filterName: null, recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' }, ledger: null },
    });
    // 副作用の確認の 4 項目は、必ず偽。
    expect(Object.values(create.draft['sideEffectConfirmations'] as Record<string, boolean>).every((value) => value === false)).toBe(true);
    expect(create.recordIdKey).toEqual({ value: 'id', origin: 'INFERRED', ground: 'RECORD_ID_KEY_FROM_UPDATE_FILTER' });
    // 推測でない項目の根拠（送る鍵・ページが決める鍵・既定・副作用の確認）。
    expect(create.values.map(({ ground, origin }) => [ground, origin])).toEqual([
      ['API_FIELDED_KEYS', 'DETERMINED'],
      ['API_UNFIELDED_KEYS', 'DETERMINED'],
      ['CONTRACT_DEFAULTS', 'DETERMINED'],
      ['SIDE_EFFECTS_UNCONFIRMED', 'DETERMINED'],
      ['RECORD_ID_KEY_FROM_UPDATE_FILTER', 'INFERRED'],
    ]);
    // 下書きは、今の下書きの確かめ（保存の口と同じ）を通る。
    expect(validateScenarioDraft(create.draft, CREATE, [], CONTEXT).ok).toBe(true);
    // 更新は保存しない（変える欄は人が必ず選ぶ）。
    expect(plan.updates.map(({ status }) => status)).toEqual(['NEEDS_CHANGED_FIELDS']);
  });

  it('leaves the record id key empty without an inference (the draft still passes the check)', () => {
    const [create] = planOf([CREATE]).creates;
    if (create?.status !== 'NEW') {
      throw new Error(`the create is ${create?.status}`);
    }
    expect(create.recordIdKey).toBeNull();
    expect((create.draft['api'] as Record<string, unknown>)['recordId']).toBeNull();
    expect(validateScenarioDraft(create.draft, CREATE, [], CONTEXT).ok).toBe(true);
  });

  it('does not make a draft of a row that already has a scenario (a draft, an approved one or a revoked one), and lists it as existing', () => {
    for (const state of ['DRAFT', 'APPROVED', 'REVOKED'] as const) {
      const plan = planOf([CREATE, UPDATE], [
        { scenarioId: 'scenario-create', kind: 'CREATE', state, candidateIdentityDigest: CREATE.identityDigest, shapeDigest: shapeDigestOf(CREATE) },
        { scenarioId: 'scenario-update', kind: 'UPDATE', state, candidateIdentityDigest: UPDATE.identityDigest, shapeDigest: shapeDigestOf(UPDATE) },
      ]);
      expect(plan.creates, state).toEqual([{ status: 'EXISTING', row: expect.objectContaining({ kind: 'CREATE' }), scenarioId: 'scenario-create' }]);
      expect(plan.updates, state).toEqual([{ status: 'EXISTING', row: expect.objectContaining({ kind: 'UPDATE' }), scenarioId: 'scenario-update' }]);
    }
    // 同じ候補でも型が違えば、別の行（作る）。
    const other = planOf([CREATE], [{ scenarioId: 'scenario-x', kind: 'CREATE', state: 'DRAFT', candidateIdentityDigest: CREATE.identityDigest, shapeDigest: null }]);
    expect(other.creates.map(({ status }) => status)).toEqual(['NEW']);
  });

  it('rejects every row with a stale discovery (the drafts would not pass the check)', () => {
    const plan = planOf([CREATE, UPDATE], [], { ...CONTEXT, profileRevisions: { discoveryJob: 1, current: 2 } });
    expect(plan.creates).toEqual([{ status: 'REJECTED', row: expect.objectContaining({ kind: 'CREATE' }), reason: 'SCENARIO_API_DISCOVERY_PROFILE_STALE' }]);
    expect(plan.updates).toEqual([{ status: 'REJECTED', row: expect.objectContaining({ kind: 'UPDATE' }), reason: 'SCENARIO_API_DISCOVERY_PROFILE_STALE' }]);
  });
});

describe('FM2b: the values chosen beforehand for an update (the ledger and the update page template)', () => {
  it('chooses the ledger only when exactly one create is bound (0, 1 and 2 ledgers)', () => {
    // 0: 結び付く登録がない（`recordId.key` が filter と違う登録は結び付かない）。
    expect(apiUpdateDraftPresetOf(updateFormOf([ledgerFactOf('scenario-a', 'uid')]))).toMatchObject({ ledger: null, ledgerOptionCount: 0 });
    // 1: その登録を、根拠つきで選ぶ。
    expect(apiUpdateDraftPresetOf(updateFormOf([ledgerFactOf('scenario-a', 'id'), ledgerFactOf('scenario-b', 'id', '/rest/v1/groups')])))
      .toMatchObject({ ledger: { value: 'scenario-a', origin: 'DETERMINED', ground: 'SINGLE_BOUND_LEDGER' }, ledgerOptionCount: 1 });
    // 2: 人が選ぶ（選ばない）。
    expect(apiUpdateDraftPresetOf(updateFormOf([ledgerFactOf('scenario-a', 'id'), ledgerFactOf('scenario-b', 'id')])))
      .toMatchObject({ ledger: null, ledgerOptionCount: 2 });
  });

  it('binds an update without a ledger to the create drafted in the same operation (the create first, its key inferred from the filter)', () => {
    const plan = planOf([UPDATE, CREATE]);
    const [create] = plan.creates;
    if (create?.status !== 'NEW') {
      throw new Error(`the create is ${create?.status}`);
    }
    // 作る順: 登録を先に保存したことを、その登録の事実で表す（保存の部品が文脈に足す事実と同じ項目）。
    const saved = ledgerFactOf('scenario-created', (create.draft['api'] as { recordId: { key: string } }).recordId.key);
    expect(apiUpdateDraftPresetOf(updateFormOf([saved])).ledger).toEqual({ value: 'scenario-created', origin: 'DETERMINED', ground: 'SINGLE_BOUND_LEDGER' });
  });

  it('marks the first update page template as inferred only when there are two or more', () => {
    const form = updateFormOf([]);
    expect(form.formPathTemplates).toEqual(['/admin/members/{id}/edit']);
    expect(apiUpdateDraftPresetOf(form).formPathTemplate).toEqual({ value: '/admin/members/{id}/edit', origin: 'DETERMINED', ground: 'ONLY_FORM_PATH_TEMPLATE' });
    const two = { ...form, formPathTemplates: ['/a/{id}/edit', '/{id}/x/edit'] };
    expect(apiUpdateDraftPresetOf(two).formPathTemplate).toEqual({ value: '/a/{id}/edit', origin: 'INFERRED', ground: 'FIRST_FORM_PATH_TEMPLATE' });
    expect(apiUpdateDraftPresetOf({ ...form, formPathTemplates: [] }).formPathTemplate).toBeNull();
  });
});

describe('FM2b: the READ of the verification of a create draft', () => {
  const READ_PATHS = ['/admin', '/admin/members', '/admin/members/new', '/admin/members/import', '/admin/members/12', '/admin/members/12/edit'];

  it('infers the {id} page template from a read page path below the table (an inferred value with the ground)', () => {
    expect(inferredReadPageTemplateOf(NEW_PATH, READ_PATHS))
      .toEqual({ value: '/admin/members/{id}', origin: 'INFERRED', ground: 'READ_PAGE_TEMPLATE_FROM_READ_PATH' });
    // 一覧の画面の登録（同じ path の下の画面）。
    expect(inferredReadPageTemplateOf('/admin/members', READ_PATHS)?.value).toBe('/admin/members/{id}');
    // ID に見える区切り（数字を含む）がなければ推さない（`new`・`import` は ID にしない）。
    expect(inferredReadPageTemplateOf(NEW_PATH, ['/admin/members/new', '/admin/members/import'])).toBeNull();
    // 固定の区切りのない型（`/{id}`）は作らない。
    expect(inferredReadPageTemplateOf('/new', ['/12'])).toBeNull();
  });

  it('makes the definition with the placeholder expectation, and the verification with the expectation inferred from a varying field', () => {
    expect(autoDraftReadCheckDefinitionOf('/admin/members/{id}'))
      .toEqual({ targetPagePath: '/admin/members/{id}', parameters: {}, expectations: AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS });
    expect(AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS).toHaveLength(1);
    expect(inferredReadExpectationOf(['email', 'name'], ['name']))
      .toEqual({ value: { kind: 'TEXT_CONTAINS', fieldName: 'name' }, origin: 'INFERRED', ground: 'READ_EXPECTATION_FROM_VARYING_FIELD' });
    expect(inferredReadExpectationOf(['email', 'name'], ['email', 'name'])?.value).toEqual({ kind: 'TEXT_CONTAINS', fieldName: 'email' });
    expect(inferredReadExpectationOf(['email', 'name'], [])).toBeNull();
    expect(autoDraftReadVerificationOf({ readCheckId: 'read-1', revision: 1 }, { kind: 'TEXT_CONTAINS', fieldName: 'name' }))
      .toEqual({ readCheckId: 'read-1', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }] });
  });
});

describe('FM2b: the display of the origins of the draft values', () => {
  // CC-107（FM2e の片づけ。意図して直した期待）: 名前の文はカタログの 1 か所だけ（`messages.ts` の写しを消したので、写しとの一致の確かめも外した）。
  it('keeps the names, the order and the tones in the display catalog', () => {
    expect(Object.keys(DRAFT_VALUE_ORIGIN_CATALOG)).toEqual([...DRAFT_VALUE_ORIGINS]);
    expect(DRAFT_VALUE_ORIGINS.map((origin) => DRAFT_VALUE_ORIGIN_CATALOG[origin].order)).toEqual([1, 2, 3]);
    expect(DRAFT_VALUE_ORIGIN_CATALOG.INFERRED.tone).toBe('caution');
  });
});

describe('FM2b: the button blockers and the choice of the READ definition', () => {
  it('blocks the button in the order of the reasons', () => {
    const base = { editable: true, discoveryRead: true, context: CONTEXT, candidates: [CREATE] };
    expect(autoDraftBlockerOf(base)).toBeNull();
    expect(autoDraftBlockerOf({ ...base, editable: false, discoveryRead: false })).toBe('PROFILE_NOT_EDITABLE');
    expect(autoDraftBlockerOf({ ...base, discoveryRead: false })).toBe('DISCOVERY_MISSING');
    expect(autoDraftBlockerOf({ ...base, context: null })).toBe('DISCOVERY_MISSING');
    expect(autoDraftBlockerOf({ ...base, context: { ...CONTEXT, profileRevisions: { discoveryJob: 1, current: 2 } } })).toBe('DISCOVERY_STALE');
    expect(autoDraftBlockerOf({ ...base, candidates: [PLAIN] })).toBe('NO_API_ROWS');
    expect(AUTO_DRAFT_BLOCKERS).toEqual(['PROFILE_NOT_EDITABLE', 'DISCOVERY_MISSING', 'DISCOVERY_STALE', 'NO_API_ROWS', 'PREVIEW_OUTDATED']);
  });

  it('uses an existing definition of the same template, stops at the limit, and creates one otherwise', () => {
    const input = { createPagePath: NEW_PATH, readPagePaths: ['/admin/members/12'], definitions: [], maxDefinitions: 2 };
    expect(autoDraftReadCheckChoiceOf(input)).toEqual({
      kind: 'CREATE',
      template: { value: '/admin/members/{id}', origin: 'INFERRED', ground: 'READ_PAGE_TEMPLATE_FROM_READ_PATH' },
      definition: autoDraftReadCheckDefinitionOf('/admin/members/{id}'),
    });
    const existing = { readCheckId: 'read-1', revision: 3, targetPagePath: '/admin/members/{id}' };
    expect(autoDraftReadCheckChoiceOf({ ...input, definitions: [existing, existing] }))
      .toMatchObject({ kind: 'EXISTING', reference: { readCheckId: 'read-1', revision: 3 } });
    const other = { readCheckId: 'read-2', revision: 1, targetPagePath: null };
    expect(autoDraftReadCheckChoiceOf({ ...input, definitions: [other, { ...other, readCheckId: 'read-3' }] })).toMatchObject({ kind: 'LIMIT_REACHED' });
    expect(autoDraftReadCheckChoiceOf({ ...input, readPagePaths: [] })).toEqual({ kind: 'NOT_INFERRED' });
  });
});

describe('FM2b: the inferred items computed again at display time (the marks are not bound to the approval)', () => {
  const [created] = planOf([CREATE, UPDATE]).creates;
  const createDraft = created?.status === 'NEW' ? created.draft : {};
  const validated = validateScenarioDraft(createDraft, CREATE, [], CONTEXT);
  if (!validated.ok) {
    throw new Error('the create draft is not valid');
  }
  const content = validated.content;
  const facts = {
    candidates: [CREATE, UPDATE],
    approvedServiceOrigins: [API],
    readPagePaths: ['/admin/members/12'],
    varyingFieldNames: ['name'],
    updateFormPathTemplates: [],
    defaultRangeFieldNames: [],
  };
  const AUTO_ID = autoDraftScenarioIdOf('00000000-0000-4000-8000-000000000001');
  const linked = {
    ...content,
    verification: { ...content.verification, readVerification: { readCheckId: 'read-1', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS' as const, fieldName: 'name' }] } },
  };
  // 自動の下書きの作る順の版（登録 → 規則を付けた版 → 照合の READ を結んだ版）。
  const autoHistory = [content, content, linked];

  it('lists the inferred items the automatic draft still has, with the grounds', () => {
    expect(AUTO_ID.startsWith(AUTO_DRAFT_SCENARIO_ID_PREFIX)).toBe(true);
    expect(autoDraftInferredItemsOf({ scenarioId: AUTO_ID, scenario: linked, history: autoHistory, evidence: CREATE, readVerificationPagePath: '/admin/members/{id}', ...facts }))
      .toEqual([
        { item: 'RECORD_ID_KEY', value: 'id', origin: 'INFERRED', ground: 'RECORD_ID_KEY_FROM_UPDATE_FILTER' },
        { item: 'READ_PAGE_TEMPLATE', value: '/admin/members/{id}', origin: 'INFERRED', ground: 'READ_PAGE_TEMPLATE_FROM_READ_PATH' },
        { item: 'READ_EXPECTATION', value: 'name', origin: 'INFERRED', ground: 'READ_EXPECTATION_FROM_VARYING_FIELD' },
      ]);
    // 副作用の確認で変わる欄が増えても（メールも変わる欄になる）、比べる欄が変わる欄のままなら、推測の項目として残る。人が副作用だけを確かめて版を
    // 上げても（値は変わらない）、残る。
    expect(autoDraftInferredItemsOf({
      scenarioId: AUTO_ID, scenario: linked, history: [...autoHistory, linked], evidence: CREATE, readVerificationPagePath: null, ...facts,
      varyingFieldNames: ['email', 'name'],
    }).map(({ item }) => item)).toEqual(['RECORD_ID_KEY', 'READ_EXPECTATION']);
  });

  it('does not mark the values a person entered, even when they equal the inferred values (FM2R Minor 9)', () => {
    // 人が作ったシナリオ（自動の下書きの id でない）に、人が推しと同じ値を入れた。
    expect(autoDraftInferredItemsOf({
      scenarioId: 'scenario-by-person', scenario: linked, history: [linked], evidence: CREATE, readVerificationPagePath: '/admin/members/{id}', ...facts,
    })).toEqual([]);
    // 自動の下書きの値を、人が一度変えて、推しと同じ値に戻した。
    const changedKey = { ...linked, api: { ...linked.api, recordId: { source: 'RESPONSE_BODY_KEY' as const, key: 'member_id' } } } as typeof linked;
    const changedRead = {
      ...linked,
      verification: { ...linked.verification, readVerification: { readCheckId: 'read-2', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS' as const, fieldName: 'name' }] } },
    };
    expect(autoDraftInferredItemsOf({
      scenarioId: AUTO_ID, scenario: linked, history: [...autoHistory, changedKey, changedRead, linked], evidence: CREATE,
      readVerificationPagePath: '/admin/members/{id}', ...facts,
    })).toEqual([]);
  });

  it('lists nothing when a person changed the values (or the scenario is not an API create)', () => {
    const changed = {
      ...content,
      api: { ...content.api, recordId: { source: 'RESPONSE_BODY_KEY' as const, key: 'member_id' } },
      verification: { ...content.verification, readVerification: { readCheckId: 'read-1', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS' as const, fieldName: 'email' }] } },
    } as typeof content;
    expect(autoDraftInferredItemsOf({
      scenarioId: AUTO_ID, scenario: changed, history: [content, changed], evidence: CREATE, readVerificationPagePath: '/admin/members/{id}/show', ...facts,
    })).toEqual([]);
    expect(autoDraftInferredItemsOf({
      scenarioId: AUTO_ID, scenario: { ...content, kind: 'UPDATE' }, history: [content], evidence: CREATE, readVerificationPagePath: null, ...facts,
    })).toEqual([]);
  });

  it('lists the update page template chosen first of two or more, and the fields with the default range (FM2R Minor 11)', () => {
    const api = content.api as ScenarioApiSpec;
    const update = { ...content, kind: 'UPDATE' as const, api: { ...api, ledger: { targetCreateScenarioId: 'scenario-a', formPathTemplate: '/a/{id}/edit' } } };
    const base = { scenarioId: 'scenario-update', scenario: update, history: [update], evidence: UPDATE, readVerificationPagePath: null, ...facts };
    expect(autoDraftInferredItemsOf({ ...base, updateFormPathTemplates: ['/a/{id}/edit', '/{id}/x/edit'], defaultRangeFieldNames: ['joined_on'] })).toEqual([
      { item: 'UPDATE_FORM_PATH_TEMPLATE', value: '/a/{id}/edit', origin: 'INFERRED', ground: 'FIRST_FORM_PATH_TEMPLATE' },
      { item: 'DEFAULT_RANGE_FIELD', value: 'joined_on', origin: 'INFERRED', ground: 'DEFAULT_RANGE_WITHOUT_HINT' },
    ]);
    // 選べる型が 1 つ（推測でない）、人が先頭でない型を選んだときは出さない。
    expect(autoDraftInferredItemsOf({ ...base, updateFormPathTemplates: ['/a/{id}/edit'] })).toEqual([]);
    expect(autoDraftInferredItemsOf({ ...base, updateFormPathTemplates: ['/{id}/x/edit', '/a/{id}/edit'] })).toEqual([]);
  });
});

describe('FM2b: the step of the READ expectation (FM2R Minor 10)', () => {
  const create = { kind: 'CREATE' as const, template: { value: '/admin/members/{id}', origin: 'INFERRED' as const, ground: 'READ_PAGE_TEMPLATE_FROM_READ_PATH' as const },
    definition: autoDraftReadCheckDefinitionOf('/admin/members/{id}') };

  it('tells the true reason, in the order of the steps', () => {
    const base = { rulesAttached: true, readCheck: create, fieldNames: ['email', 'name'], varyingFieldNames: ['name'] };
    expect(autoDraftExpectationStepOf(base)).toEqual({
      kind: 'LINK', expectation: { value: { kind: 'TEXT_CONTAINS', fieldName: 'name' }, origin: 'INFERRED', ground: 'READ_EXPECTATION_FROM_VARYING_FIELD' },
    });
    expect(autoDraftExpectationStepOf({ ...base, rulesAttached: false })).toEqual({ kind: 'SKIP', outcome: 'RULES_NOT_ATTACHED' });
    expect(autoDraftExpectationStepOf({ ...base, readCheck: { kind: 'NOT_INFERRED' } })).toEqual({ kind: 'SKIP', outcome: 'NO_READ_CHECK' });
    expect(autoDraftExpectationStepOf({ ...base, readCheck: { kind: 'LIMIT_REACHED', template: create.template } }))
      .toEqual({ kind: 'SKIP', outcome: 'NO_READ_CHECK' });
    expect(autoDraftExpectationStepOf({ ...base, varyingFieldNames: [] })).toEqual({ kind: 'SKIP', outcome: 'NO_VARYING_FIELD' });
    expect(AUTO_DRAFT_EXPECTATION_OUTCOMES).toEqual(['LINKED', 'RULES_NOT_ATTACHED', 'NO_READ_CHECK', 'NO_VARYING_FIELD', 'LINK_FAILED']);
  });
});

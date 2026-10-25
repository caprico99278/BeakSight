// FM2a（手を減らす段 2 の設計書 3A.2 の「共通化」）: API のシナリオの下書きの入力と案を作る純粋な部品（`src/control/approval/api-scenario-draft.ts`）と、
// 案の出どころの印（`src/control/approval/draft-value-origin.ts`）。
// - 部品は、作成の画面のサーバ（`apps/local-ui/src/server/scenario-functions.ts`）にあった `apiProbeDraftOf`・`apiFormOf` を移したもの。画面の振る舞いを
//   変えないことを、移す前の振る舞い（作成の画面のテスト T38f・T41e・T41e-3 の見る値）でここに固定する。
// - 入力は probe の記録（候補）・発見の Run の情報（下書きの確かめの文脈）・既にあるシナリオの一覧。出力は下書きの入力と案。管理データ・ファイル・
//   画面に依らない（同じ入力に同じ出力。入力を変えない）。
// - 副作用の確認の 4 項目は、必ず偽で作る（3A 章の共通の決まり）。
import { describe, expect, it } from 'vitest';
import {
  SCENARIO_UPDATE_INPUT_REASONS,
  UNCONFIRMED_SIDE_EFFECTS,
  DRAFT_PROBE_LEDGER_SCENARIO_ID,
  DRAFT_PROBE_PATH_TEMPLATE,
  apiScenarioDraftInputOf,
  apiScenarioFormOf,
  isUsableRecordIdSegment,
  type ApiScenarioExistingScenario,
} from '../../src/control/approval/api-scenario-draft.js';
import {
  DRAFT_VALUE_GROUNDS,
  DRAFT_VALUE_GROUND_ORIGINS,
  DRAFT_VALUE_ORIGINS,
  draftValueOf,
} from '../../src/control/approval/draft-value-origin.js';
import {
  APPROVAL_TTL_DAYS,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  RECORD_ID_PLACEHOLDER,
  SIDE_EFFECT_CONFIRMATIONS,
} from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft, type ScenarioDraftContext } from '../../src/control/approval/scenario-policy.js';
import { apiRequestShapeOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField, type SubmissionProbeRecord } from '../../src/discovery/submission-probe-contracts.js';
import { DRAFT_VALUE_ORIGIN_CATALOG } from '../../src/presentation/catalog.js';
import { DRAFT_VALUE_TEXT } from '../../src/presentation/messages.js';
import { PROFILE_ID, candidateOf } from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'https://api.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const LEDGER_ID = 'scenario-ledger';
const OTHER_TABLE_LEDGER_ID = 'scenario-other-table';
const NO_FACT_LEDGER_ID = 'scenario-no-fact';
const UPDATE_SCENARIO_ID = 'scenario-update';
const NEW_PATH = '/admin/members/new';
const EDIT_PATH = '/admin/members/1/edit';

/** 押す前に入れた欄（名前・メールアドレスは名前、備考は名前のない number の欄）。テナントは選んだ欄（目印なし）。 */
const MARKED_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#note', type: 'number', marker: 2 },
];
const TENANT_SELECT: SubmissionProbeInputField = { name: 'tenant_id', selector: '#tenant', type: 'select-one', marker: null };
const MEMBER_BODY = { name: MARKERS[0], email: MARKERS[1], note: Number(MARKERS[2]) };

const shapeOf = (pagePath: string, method: string, url: string, body: Readonly<Record<string, unknown>>): ApiRequestShape => apiRequestShapeOf({
  method,
  resourceType: 'fetch',
  url,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation', authorization: 'Bearer x', 'sec-fetch-mode': 'cors' },
  body: { kind: 'TEXT', text: JSON.stringify(body) },
}, { pagePath, markers: MARKERS });

const probeOf = (shape: ApiRequestShape, inputFields: readonly SubmissionProbeInputField[]): SubmissionProbeRecord =>
  observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
    { filledFieldCount: inputFields.length, skippedFieldCount: 0 }, inputFields);

const buttonOf = (pagePath: string, probe: SubmissionProbeRecord | undefined): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: pagePath }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  ...(probe === undefined ? {} : { submissionProbe: probe }),
});

/** 登録の画面の保存（POST。テナントは欄に対応しない鍵）。 */
const CREATE_CANDIDATE = buttonOf(NEW_PATH, probeOf(shapeOf(NEW_PATH, 'POST', `${API}/rest/v1/members?select=*`, { ...MEMBER_BODY, tenant_id: 'tenant-1' }),
  [...MARKED_FIELDS, TENANT_SELECT]));
/** 更新の画面の保存（`id=eq.<最後の ID>` の PATCH）。 */
const UPDATE_CANDIDATE = buttonOf(EDIT_PATH, probeOf(shapeOf(EDIT_PATH, 'PATCH', `${API}/rest/v1/members?id=eq.1&select=*`, MEMBER_BODY), MARKED_FIELDS));

const MEMBERS_REQUEST = Object.freeze({ origin: API, pathShape: '/rest/v1/members' });

/** 発見の Run の情報（承認したサービスの Origin、発見の時と今の改訂）と、台帳の事実（同じ表の API の登録・別の表の API の登録）。 */
const CONTEXT: ScenarioDraftContext = Object.freeze({
  scenarioId: null,
  scenarios: Object.freeze([
    { scenarioId: LEDGER_ID, profileId: PROFILE_ID, kind: 'CREATE', apiRequest: MEMBERS_REQUEST },
    { scenarioId: OTHER_TABLE_LEDGER_ID, profileId: PROFILE_ID, kind: 'CREATE', apiRequest: { origin: API, pathShape: '/rest/v1/groups' } },
    { scenarioId: UPDATE_SCENARIO_ID, profileId: PROFILE_ID, kind: 'UPDATE', apiRequest: MEMBERS_REQUEST },
  ]),
  approvedServiceOrigins: Object.freeze([API]),
  profileRevisions: Object.freeze({ discoveryJob: 2, current: 2 }),
}) as ScenarioDraftContext;

/** 既にあるシナリオの一覧（同じプロファイル。事実のない登録は台帳にできない）。 */
const SCENARIOS: readonly ApiScenarioExistingScenario[] = Object.freeze([
  { scenarioId: LEDGER_ID, kind: 'CREATE', pagePath: NEW_PATH },
  { scenarioId: OTHER_TABLE_LEDGER_ID, kind: 'CREATE', pagePath: '/admin/groups/new' },
  { scenarioId: NO_FACT_LEDGER_ID, kind: 'CREATE', pagePath: '/admin/members/new' },
  { scenarioId: UPDATE_SCENARIO_ID, kind: 'UPDATE', pagePath: EDIT_PATH },
]);

const formOf = (candidate: DiscoveryCandidate, context: ScenarioDraftContext = CONTEXT, scenarios = SCENARIOS) =>
  apiScenarioFormOf({ profileId: PROFILE_ID, candidate, context, scenarios });

const NOTHING_CONFIRMED = Object.fromEntries(SIDE_EFFECT_CONFIRMATIONS.map((item) => [item, false]));

describe('FM2a: the draft input of an API scenario', () => {
  it('makes the draft input from the probe with the defaults, and confirms no side effect', () => {
    const probe = CREATE_CANDIDATE.submissionProbe as SubmissionProbeRecord;
    expect(UNCONFIRMED_SIDE_EFFECTS).toEqual(NOTHING_CONFIRMED);
    expect(Object.isFrozen(UNCONFIRMED_SIDE_EFFECTS)).toBe(true);
    expect(apiScenarioDraftInputOf(PROFILE_ID, CREATE_CANDIDATE, probe, { fieldNames: ['email', 'name'], pageKeys: ['tenant_id'], formPathTemplate: '/x/{id}' }))
      .toEqual({
        profileId: PROFILE_ID,
        candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
        transport: 'API',
        fieldNames: ['email', 'name'],
        readChecks: [],
        sideEffectConfirmations: NOTHING_CONFIRMED,
        limits: { maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN, maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES },
        approvalTtlDays: APPROVAL_TTL_DAYS,
        // 登録は filter と台帳を持たない（画面の型は使わない）。
        api: { shapeDigest: probe.shapeDigest, pageKeys: ['tenant_id'], filterName: null, recordId: null, ledger: null },
      });
  });

  it('gives an UPDATE draft input the filter of the shape and the ledger reference for the check', () => {
    const probe = UPDATE_CANDIDATE.submissionProbe as SubmissionProbeRecord;
    const draft = apiScenarioDraftInputOf(PROFILE_ID, UPDATE_CANDIDATE, probe, { fieldNames: ['name'], pageKeys: [], formPathTemplate: '/admin/members/{id}/edit' });
    expect(draft['api']).toEqual({
      shapeDigest: probe.shapeDigest,
      pageKeys: [],
      filterName: 'id',
      recordId: null,
      ledger: { targetCreateScenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID, formPathTemplate: '/admin/members/{id}/edit' },
    });
    expect(DRAFT_PROBE_PATH_TEMPLATE).toBe(`/${RECORD_ID_PLACEHOLDER}`);
  });
});

describe('FM2a: the proposal of an API scenario (the behaviour of the create screen before the move)', () => {
  it('proposes a CREATE with all the fielded keys and the selectable page keys, accepted by the draft check', () => {
    const { form, rejection } = formOf(CREATE_CANDIDATE);
    expect(rejection).toBeNull();
    expect(form).not.toBeNull();
    if (form === null) return;
    expect(form.shapeDigest).toBe(CREATE_CANDIDATE.submissionProbe?.shapeDigest);
    expect(form.kind).toBe('CREATE');
    expect(form.keyFields).toEqual([
      { key: 'email', type: 'string', field: { kind: 'NAME', name: 'email' }, fieldType: 'email', rejection: null },
      { key: 'name', type: 'string', field: { kind: 'NAME', name: 'name' }, fieldType: 'text', rejection: null },
      { key: 'note', type: 'number', field: { kind: 'SELECTOR', selector: '#note' }, fieldType: 'number', rejection: null },
    ]);
    expect(form.pageKeys).toEqual([{ key: 'tenant_id', type: 'string', rejection: null }]);
    expect(form.publicationStateKeys).toEqual([]);
    expect(form.filterName).toBeNull();
    // 登録は台帳と更新の画面の型を出さない。
    expect(form.ledgerOptions).toEqual([]);
    expect(form.formPathTemplates).toEqual([]);
    // 案は、下書きの確かめの owner が作った API の指定（ブラウザが付けるヘッダの名前を除く。値は持たない）。
    expect(form.proposal).toMatchObject({
      shapeDigest: CREATE_CANDIDATE.submissionProbe?.shapeDigest,
      request: { method: 'POST', origin: API, pathShape: '/rest/v1/members' },
      pageKeys: [{ key: 'tenant_id', type: 'string' }],
      headerNames: ['authorization', 'content-type', 'prefer'],
      filterName: null,
      recordId: null,
      ledger: null,
    });
    expect(JSON.stringify(form)).not.toContain('bsprobe');
    expect(JSON.stringify(form)).not.toContain('tenant-1');
  });

  it('proposes an UPDATE with the filter, the last id segment template, and only the ledgers of the same table that have the facts', () => {
    const { form, rejection } = formOf(UPDATE_CANDIDATE);
    expect(rejection).toBeNull();
    if (form === null) throw new Error('no form');
    expect(form.kind).toBe('UPDATE');
    expect(form.filterName).toBe('id');
    expect(form.formPathTemplates).toEqual(['/admin/members/{id}/edit']);
    // 同じ表の API の登録だけ（別の表、事実のない登録、更新のシナリオは出さない）。
    expect(form.ledgerOptions).toEqual([{ scenarioId: LEDGER_ID, pagePath: NEW_PATH }]);
    expect(form.proposal).toMatchObject({
      request: { method: 'PATCH', pathShape: '/rest/v1/members' },
      filterName: 'id',
      // 確かめのためだけの台帳の参照（本当の台帳は人が選ぶ）。
      ledger: { targetCreateScenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID, formPathTemplate: '/admin/members/{id}/edit' },
    });
  });

  it('offers no ledger when no scenario exists, and still proposes the UPDATE', () => {
    const { form, rejection } = formOf(UPDATE_CANDIDATE, { ...CONTEXT, scenarios: [] }, []);
    expect(rejection).toBeNull();
    expect(form?.ledgerOptions).toEqual([]);
    expect(form?.proposal).not.toBeNull();
  });

  it('returns the reason without a form for a candidate that has no API shape', () => {
    expect(formOf(buttonOf(NEW_PATH, undefined))).toEqual({ form: null, rejection: 'SCENARIO_API_CANDIDATE_NOT_API' });
  });

  it('returns the reason of the candidate, and no proposal, when the shape origin is not approved', () => {
    const { form, rejection } = formOf(CREATE_CANDIDATE, { ...CONTEXT, approvedServiceOrigins: [] });
    expect(rejection).not.toBeNull();
    expect(form?.proposal).toBeNull();
    // 拒む理由は、下書きの確かめの owner の候補の誤り（同じ文脈の保存の下書きと同じ）。
    const probe = CREATE_CANDIDATE.submissionProbe as SubmissionProbeRecord;
    const saved = validateScenarioDraft(apiScenarioDraftInputOf(PROFILE_ID, CREATE_CANDIDATE, probe, {
      fieldNames: ['email', 'name', 'note'], pageKeys: ['tenant_id'], formPathTemplate: DRAFT_PROBE_PATH_TEMPLATE,
    }), CREATE_CANDIDATE, [], { ...CONTEXT, approvedServiceOrigins: [] });
    expect(saved.ok ? [] : saved.errors.map(({ code }) => code)).toContain(rejection);
  });

  it('returns the reason when the profile changed after the discovery (fail closed)', () => {
    const { rejection } = formOf(CREATE_CANDIDATE, { ...CONTEXT, profileRevisions: { discoveryJob: 1, current: 2 } });
    expect(rejection).toBe('SCENARIO_API_DISCOVERY_PROFILE_STALE');
  });

  it('keeps an UPDATE page key that is not identified as a field of the update page unselectable, and proposes no shape', () => {
    const candidate = buttonOf(EDIT_PATH, probeOf(shapeOf(EDIT_PATH, 'PATCH', `${API}/rest/v1/members?id=eq.1&select=*`, { ...MEMBER_BODY, tenant_id: 't' }),
      MARKED_FIELDS));
    const { form, rejection } = formOf(candidate);
    expect(rejection).toBeNull();
    expect(form?.pageKeys).toEqual([{ key: 'tenant_id', type: 'string', rejection: 'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE' }]);
    // 案は作れない（その鍵を許さない下書きは、フォームの入力で直せる誤りで拒まれる。候補を作れない理由にはしない）。
    expect(form?.proposal).toBeNull();
    const probe = candidate.submissionProbe as SubmissionProbeRecord;
    const checked = validateScenarioDraft(apiScenarioDraftInputOf(PROFILE_ID, candidate, probe, {
      fieldNames: ['email', 'name', 'note'], pageKeys: [], formPathTemplate: '/admin/members/{id}/edit',
    }), candidate, [], {
      ...CONTEXT,
      scenarios: [...CONTEXT.scenarios, { scenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID, profileId: PROFILE_ID, kind: 'CREATE', apiRequest: MEMBERS_REQUEST }],
    });
    expect(checked.ok ? [] : checked.errors.map(({ code }) => code)).toEqual(['SCENARIO_API_KEY_NOT_ALLOWED']);
  });

  it('is pure: the same input gives the same output, and the input does not change', () => {
    const before = JSON.stringify([CREATE_CANDIDATE, UPDATE_CANDIDATE, CONTEXT, SCENARIOS]);
    expect(formOf(UPDATE_CANDIDATE)).toEqual(formOf(UPDATE_CANDIDATE));
    expect(formOf(CREATE_CANDIDATE)).toEqual(formOf(CREATE_CANDIDATE));
    expect(JSON.stringify([CREATE_CANDIDATE, UPDATE_CANDIDATE, CONTEXT, SCENARIOS])).toBe(before);
  });

  it('shares the record id segment judgement and the UPDATE input reasons with the screen', () => {
    expect(isUsableRecordIdSegment('1')).toBe(true);
    expect(isUsableRecordIdSegment('')).toBe(false);
    expect([...SCENARIO_UPDATE_INPUT_REASONS]).toEqual([
      'SCENARIO_UPDATE_TARGET_NOT_FOUND',
      'SCENARIO_UPDATE_TARGET_NOT_CREATE',
      'SCENARIO_UPDATE_PATH_MISMATCH',
      'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
      'SCENARIO_UPDATE_NO_CHANGED_FIELD',
    ]);
  });
});

describe('FM2a: the origin mark of a draft value', () => {
  it('has the closed lists, one origin by ground, and the texts of every origin and ground', () => {
    expect(DRAFT_VALUE_ORIGINS).toEqual(['DETERMINED', 'INFERRED', 'HUMAN']);
    expect(Object.isFrozen(DRAFT_VALUE_ORIGINS)).toBe(true);
    expect(Object.isFrozen(DRAFT_VALUE_GROUNDS)).toBe(true);
    expect(DRAFT_VALUE_GROUNDS).toEqual(Object.keys(DRAFT_VALUE_GROUND_ORIGINS));
    for (const ground of DRAFT_VALUE_GROUNDS) {
      expect(DRAFT_VALUE_ORIGINS).toContain(DRAFT_VALUE_GROUND_ORIGINS[ground]);
    }
    // 設計書 3A.2 の推測の印の項目（`recordId.key`、照合の READ の `{id}` の画面の型）は推測。変える鍵は人。
    expect(DRAFT_VALUE_GROUND_ORIGINS.RECORD_ID_KEY_FROM_UPDATE_FILTER).toBe('INFERRED');
    expect(DRAFT_VALUE_GROUND_ORIGINS.READ_PAGE_TEMPLATE_FROM_READ_PATH).toBe('INFERRED');
    expect(DRAFT_VALUE_GROUND_ORIGINS.HUMAN_CHOICE).toBe('HUMAN');
    // 書き漏れと余分がない（出どころの名前は表示カタログ `catalog.ts`、根拠の文は `messages.ts`。CC-107 で出どころの名前の写しを消した）。
    expect(Object.keys(DRAFT_VALUE_ORIGIN_CATALOG)).toEqual([...DRAFT_VALUE_ORIGINS]);
    expect(Object.keys(DRAFT_VALUE_TEXT.grounds)).toEqual([...DRAFT_VALUE_GROUNDS]);
  });

  it('marks a value with its ground and the origin of the ground', () => {
    const value = draftValueOf('id', 'RECORD_ID_KEY_FROM_UPDATE_FILTER');
    expect(value).toEqual({ value: 'id', origin: 'INFERRED', ground: 'RECORD_ID_KEY_FROM_UPDATE_FILTER' });
    expect(Object.isFrozen(value)).toBe(true);
    expect(draftValueOf(['email'], 'HUMAN_CHOICE').origin).toBe('HUMAN');
  });
});

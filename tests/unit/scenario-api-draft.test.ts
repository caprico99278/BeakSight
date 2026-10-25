// T38b（Task 38 の設計書 3.2、4 章、7 章の履歴のユーザーの判断）: API の候補のシナリオの契約と下書きの確かめ。
// - 契約: 送り方（`FORM`・`API`）。API のシナリオは、型の digest、要求の型（method・Origin の文字列・path の型・`select` だけの query・媒体の型・
//   `Prefer`）、鍵と欄の対応、ページが決める鍵（承認で名前を示したもの）、許すヘッダの名前（ブラウザが付ける名前を除く）、UPDATE の filter の名前、
//   登録の ID の取り方を持つ。上限は名前つきの定数で、Schema と一致する。前の FORM のシナリオの文書（送り方の項目なし）は、今のまま読める。
// - 下書きの確かめ: probe の結果が `API_CREATE`・`API_UPDATE` で欄の範囲（`inputFields`）を持つ候補を、型の digest で受ける。拒むもの（理由ごと）は
//   下の表のとおり。I21 の項目は、probe の分類とは別に、ここでもう一度照らす。Origin がプロファイルの承認したサービスの Origin にない場合も拒む。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_SUPPLIED_HEADER_NAMES,
  MAX_SCENARIO_API_FIELD_SELECTOR_LENGTH,
  MAX_SCENARIO_API_HEADER_NAMES,
  MAX_SCENARIO_API_KEY_LENGTH,
  MAX_SCENARIO_API_KEYS,
  MAX_SCENARIO_API_MEDIA_TYPE_LENGTH,
  MAX_SCENARIO_API_PATH_LENGTH,
  SCENARIO_API_FIELD_IDENTITY_KINDS,
  SCENARIO_API_METHODS,
  SCENARIO_API_RECORD_ID_SOURCES,
  SCENARIO_TRANSPORTS,
  scenarioApiPublicationStateKeysOf,
  scenarioTransportOf,
} from '../../src/control/approval/scenario-contracts.js';
import {
  SCENARIO_DRAFT_REJECTION_REASONS,
  storedScenarioRevisionOf,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import {
  MAX_API_SHAPE_BODY_KEYS,
  MAX_API_SHAPE_HEADER_NAMES,
  MAX_API_SHAPE_MEDIA_TYPE_LENGTH,
  MAX_API_SHAPE_NAME_LENGTH,
  MAX_API_SHAPE_PATH_LENGTH,
  apiRequestShapeOf,
  type ApiRequestShape,
} from '../../src/core/api-request-shape.js';
import { apiShapeDigestOf } from '../../src/discovery/api-shape-classification.js';
import { fieldNameHasStateWord } from '../../src/discovery/classify.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH,
  observedSubmissionProbeOf,
  type SubmissionProbeInputField,
  type SubmissionProbeRecord,
} from '../../src/discovery/submission-probe-contracts.js';
import {
  ALL_CONFIRMED,
  CREATE_CANDIDATE as FORM_CREATE_CANDIDATE,
  PROFILE_ID,
  READ_CHECK_FACTS,
  candidateOf,
  sampleDraft,
  sampleScenario,
} from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'https://api.example.invalid';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'];
const LEDGER_ID = 'scenario-ledger';
const NEW_PATH = '/admin/members/new';
const EDIT_PATH = '/admin/members/1/edit';
const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas/control/scenario.schema.json'), 'utf8')) as {
  readonly $defs: Record<string, { readonly properties: Record<string, Record<string, unknown>> }>;
};

/**
 * 押す前に入れた欄（名前・メールアドレスは名前、備考は名前のない number の欄）。T41a: テナントは選んだ欄（目印なし。更新のページが決める鍵
 * `tenant_id` を、更新の画面の欄として識別できる。登録の扱いは変わらない）。
 */
const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
  { name: null, selector: '#note', type: 'number', marker: 2 },
  { name: 'tenant_id', selector: '#tenant', type: 'select-one', marker: null },
];

interface ShapeInput {
  readonly method?: string;
  readonly url?: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly pagePath?: string;
  readonly originIndex?: number;
}

const shapeOf = (input: ShapeInput = {}): ApiRequestShape => apiRequestShapeOf({
  method: input.method ?? 'POST',
  resourceType: 'fetch',
  url: input.url ?? `${API}/rest/v1/members?select=*`,
  origin: { kind: 'APPROVED_API', index: input.originIndex ?? 0 },
  headers: input.headers ?? { 'content-type': 'application/json', prefer: 'return=representation', authorization: 'Bearer x', 'sec-fetch-mode': 'cors' },
  body: { kind: 'TEXT', text: JSON.stringify(input.body ?? { name: MARKERS[0], email: MARKERS[1], note: Number(MARKERS[2]), tenant_id: 'tenant-1' }) },
}, { pagePath: input.pagePath ?? NEW_PATH, markers: MARKERS });

const probeOf = (shape: ApiRequestShape, overrides: Partial<SubmissionProbeRecord> = {}): SubmissionProbeRecord => ({
  ...observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 },
    { filledFieldCount: 3, skippedFieldCount: 0 }, INPUT_FIELDS),
  ...overrides,
});

/** 偽った型（probe の分類を通らない型を、結果だけ `API_CREATE` にする。I21 の確かめ直しの見本）。 */
const forgedProbeOf = (shape: ApiRequestShape, result: SubmissionProbeRecord['result'] = 'API_CREATE'): SubmissionProbeRecord =>
  probeOf(shape, { result, reason: null, shape, shapeDigest: apiShapeDigestOf(shape) });

const buttonOf = (pagePath: string, probe: SubmissionProbeRecord): DiscoveryCandidate => ({
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: pagePath }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: probe,
});

const CREATE_SHAPE = shapeOf();
const CREATE_CANDIDATE = buttonOf(NEW_PATH, probeOf(CREATE_SHAPE));
const UPDATE_SHAPE = shapeOf({ method: 'PATCH', url: `${API}/rest/v1/members?id=eq.1&select=*`, pagePath: EDIT_PATH });
const UPDATE_CANDIDATE = buttonOf(EDIT_PATH, probeOf(UPDATE_SHAPE));

/** T38c: 候補を見つけた発見のジョブのプロファイルの改訂と、今の改訂（同じであること）。 */
const PROFILE_REVISIONS = Object.freeze({ discoveryJob: 2, current: 2 });

const CONTEXT: ScenarioDraftContext = {
  scenarioId: null,
  // T41R-fix-B: API の更新の台帳は、同じ表（同じ API の Origin と path の型）の API の登録。
  scenarios: [{ scenarioId: LEDGER_ID, profileId: PROFILE_ID, kind: 'CREATE', apiRequest: { origin: API, pathShape: '/rest/v1/members' } }],
  approvedServiceOrigins: [API],
  profileRevisions: PROFILE_REVISIONS,
};

const apiOf = (candidate: DiscoveryCandidate, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  shapeDigest: candidate.submissionProbe?.shapeDigest,
  pageKeys: ['tenant_id'],
  filterName: null,
  recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
  ledger: null,
  ...overrides,
});

const draftOf = (candidate: DiscoveryCandidate, overrides: Record<string, unknown> = {}, api: Record<string, unknown> = {}): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: candidate.identityDigest,
  transport: 'API',
  fieldNames: ['name', 'email', 'note'],
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  api: apiOf(candidate, api),
  ...overrides,
});

const UPDATE_API = { filterName: 'id', recordId: null, ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: '/admin/members/{id}/edit' } };

const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
const validate = (draft: unknown, candidate: DiscoveryCandidate | null, context: ScenarioDraftContext = CONTEXT): ScenarioDraftValidationResult =>
  validateScenarioDraft(draft, candidate, [], context);

describe('T38b: the contract of an API scenario', () => {
  it('has the closed lists, and the limits of the schema equal the named constants', () => {
    expect(SCENARIO_TRANSPORTS).toEqual(['FORM', 'API']);
    expect(SCENARIO_API_METHODS).toEqual(['POST', 'PATCH']);
    expect(SCENARIO_API_FIELD_IDENTITY_KINDS).toEqual(['NAME', 'SELECTOR']);
    expect(SCENARIO_API_RECORD_ID_SOURCES).toEqual(['RESPONSE_BODY_KEY']);
    for (const list of [SCENARIO_TRANSPORTS, SCENARIO_API_METHODS, SCENARIO_API_FIELD_IDENTITY_KINDS, SCENARIO_API_RECORD_ID_SOURCES, BROWSER_SUPPLIED_HEADER_NAMES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
    expect(BROWSER_SUPPLIED_HEADER_NAMES).toEqual(expect.arrayContaining(['accept', 'user-agent', 'referer', 'origin']));
    // 上限は probe の型と欄の識別の上限と同じ（型にない長さの値は持たない）。
    expect([MAX_SCENARIO_API_KEYS, MAX_SCENARIO_API_HEADER_NAMES, MAX_SCENARIO_API_KEY_LENGTH, MAX_SCENARIO_API_PATH_LENGTH, MAX_SCENARIO_API_MEDIA_TYPE_LENGTH,
      MAX_SCENARIO_API_FIELD_SELECTOR_LENGTH]).toEqual([MAX_API_SHAPE_BODY_KEYS, MAX_API_SHAPE_HEADER_NAMES, MAX_API_SHAPE_NAME_LENGTH, MAX_API_SHAPE_PATH_LENGTH,
      MAX_API_SHAPE_MEDIA_TYPE_LENGTH, MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH]);
    const api = SCHEMA.$defs['api']?.properties ?? {};
    expect(api['keyFields']).toMatchObject({ maxItems: MAX_SCENARIO_API_KEYS });
    expect(api['pageKeys']).toMatchObject({ maxItems: MAX_SCENARIO_API_KEYS });
    expect(api['headerNames']).toMatchObject({ maxItems: MAX_SCENARIO_API_HEADER_NAMES });
    expect(SCHEMA.$defs['apiKey']).toMatchObject({ maxLength: MAX_SCENARIO_API_KEY_LENGTH });
    expect(SCHEMA.$defs['apiRequest']?.properties['pathShape']).toMatchObject({ maxLength: MAX_SCENARIO_API_PATH_LENGTH });
    expect(SCHEMA.$defs['apiRequest']?.properties['contentType']?.['anyOf']).toEqual([
      { type: 'string', minLength: 1, maxLength: MAX_SCENARIO_API_MEDIA_TYPE_LENGTH }, { type: 'null' },
    ]);
    expect(SCHEMA.$defs['apiFieldSelector']).toMatchObject({ maxLength: MAX_SCENARIO_API_FIELD_SELECTOR_LENGTH });
  });

  it('reads a FORM scenario document of the previous shape (no transport) as it is, as a FORM scenario', () => {
    const previous = JSON.parse(JSON.stringify(sampleScenario())) as Record<string, unknown>;
    expect(Object.hasOwn(previous, 'transport')).toBe(false);
    const read = storedScenarioRevisionOf(previous);
    expect(read).toEqual(sampleScenario());
    expect(scenarioTransportOf(read)).toBe('FORM');
    expect(validateControlDocument('scenario', { ...previous, transport: 'FORM' }).ok).toBe(true);
    // FORM のシナリオは、API の指定を持てない。API のシナリオは、要求の形（form）を持てず、API の指定を持つ。
    expect(validateControlDocument('scenario', { ...previous, api: null }).ok).toBe(false);
  });
});

describe('T38b: the draft of an API scenario', () => {
  it('accepts an API_CREATE candidate selected by its shape, and makes the content from the shape (no value)', () => {
    const result = validate(draftOf(CREATE_CANDIDATE), CREATE_CANDIDATE);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content).toMatchObject({ kind: 'CREATE', transport: 'API', request: null, update: null, fieldNames: ['email', 'name', 'note'] });
    expect(scenarioTransportOf(result.content)).toBe('API');
    expect(result.content.api).toEqual({
      shapeDigest: CREATE_CANDIDATE.submissionProbe?.shapeDigest,
      request: { method: 'POST', origin: API, pathShape: '/rest/v1/members', queryNames: ['select'], contentType: 'application/json', prefer: ['return=representation'] },
      keyFields: [
        // T38R2-fix（M-2）: 欄の型（probe の欄の型）を持つ。
        { key: 'email', type: 'string', field: { kind: 'NAME', name: 'email' }, fieldType: 'email' },
        { key: 'name', type: 'string', field: { kind: 'NAME', name: 'name' }, fieldType: 'text' },
        { key: 'note', type: 'number', field: { kind: 'SELECTOR', selector: '#note' }, fieldType: 'number' },
      ],
      pageKeys: [{ key: 'tenant_id', type: 'string' }],
      // ブラウザが付ける名前（`sec-fetch-mode`）は除く。
      headerNames: ['authorization', 'content-type', 'prefer'],
      filterName: null,
      recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
      // 台帳の参照は UPDATE だけ。
      ledger: null,
    });
    expect(JSON.stringify(result.content)).not.toContain('bsprobe');
    expect(JSON.stringify(result.content)).not.toContain('tenant-1');
    // 保存の形として Schema に通る。
    expect(validateControlDocument('scenario', { ...sampleScenario(), ...result.content, inputRuleReference: null }).ok).toBe(true);
  });

  it('accepts an API_UPDATE candidate with the filter name and the ledger', () => {
    const result = validate(draftOf(UPDATE_CANDIDATE, {}, UPDATE_API), UPDATE_CANDIDATE);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content).toMatchObject({ kind: 'UPDATE', transport: 'API', request: null, update: null });
    expect(result.content.api).toMatchObject({
      // 許す query の名前は `select` だけ（filter の名前は `filterName` に分けて持つ）。
      request: { method: 'PATCH', pathShape: '/rest/v1/members', queryNames: ['select'] },
      filterName: 'id',
      recordId: null,
      ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: '/admin/members/{id}/edit' },
    });
  });

  // DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 2 章）: 公開の状態の鍵（status・is_published・published_at）を持つ登録の型は、論理削除の鍵に
  // しない（下書きを作れる）。論理削除の鍵（deleted_at）は、今どおり `SCENARIO_API_STATE_KEY`。型は本番と同じく、状態の鍵の印を伏せる前の名前で見る。
  const stateShapeOf = (extra: Readonly<Record<string, unknown>>): ApiRequestShape => apiRequestShapeOf({
    method: 'POST',
    resourceType: 'fetch',
    url: `${API}/rest/v1/members?select=*`,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: { kind: 'TEXT', text: JSON.stringify({ name: MARKERS[0], email: MARKERS[1], note: Number(MARKERS[2]), tenant_id: 'tenant-1', ...extra }) },
  }, { pagePath: NEW_PATH, markers: MARKERS, isStateKeyName: fieldNameHasStateWord });

  it('accepts an API_CREATE candidate with the publication state keys as page keys (DEF-147)', () => {
    const shape = stateShapeOf({ status: 'draft', is_published: false, published_at: null });
    expect(shape.body.stateKeyPresent).toBe(true);
    const candidate = buttonOf(NEW_PATH, probeOf(shape));
    expect(candidate.submissionProbe?.result).toBe('API_CREATE');
    const result = validate(draftOf(candidate, {}, { pageKeys: ['tenant_id', 'status', 'is_published', 'published_at'] }), candidate);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok || result.content.api === undefined) return;
    // 承認の画面の注意の印に使う、公開の状態にあたる鍵（鍵の順）。
    expect(scenarioApiPublicationStateKeysOf(result.content.api)).toEqual(['is_published', 'published_at', 'status']);
  });

  it('still rejects an API candidate with a soft delete key (DEF-147)', () => {
    const shape = stateShapeOf({ status: 'draft', deleted_at: null });
    const candidate = forged(shape);
    expect(codesOf(validate(draftOf(candidate, {}, { pageKeys: ['tenant_id', 'status', 'deleted_at'] }), candidate))).toEqual(['SCENARIO_API_STATE_KEY']);
  });

  it('has the reasons of an API draft at the end of the closed list', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS.slice(-17)).toEqual([
      'SCENARIO_API_CANDIDATE_NOT_API',
      'SCENARIO_API_STATE_KEY',
      'SCENARIO_API_METHOD_OVERRIDE',
      'SCENARIO_API_HEADER_METHOD_OVERRIDE',
      'SCENARIO_API_ORIGIN_NOT_APPROVED',
      'SCENARIO_API_SHAPE_NOT_EXECUTABLE',
      'SCENARIO_API_FIELD_KEY_MISMATCH',
      'SCENARIO_API_FIELD_TYPE_MISMATCH',
      'SCENARIO_API_KEY_NOT_ALLOWED',
      'SCENARIO_API_PAGE_KEY_SECRET_LIKE',
      'SCENARIO_API_FILTER_MISMATCH',
      // T38c（T38b の報告の (2)）: 候補を見つけた発見のジョブのプロファイルの改訂が、今の改訂と違う。
      'SCENARIO_API_DISCOVERY_PROFILE_STALE',
      // T38R-fix の I-2: ページが決める鍵が scalar でない、登録の ID の鍵が秘密に見える。
      'SCENARIO_API_PAGE_KEY_NOT_SCALAR',
      'SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE',
      // T40R-fix-B（I-2）: `{id}` の照合の READ の期待が行の数だけ（`scenario-api-save-checks.test.ts`）。T40R2-fix: ID の型の理由は注意に下げた。
      'SCENARIO_API_READ_VERIFICATION_NOT_BOUND',
      // T41a（`scenario-api-update-contract.test.ts`）: API の更新のページが決める鍵、台帳の ID と filter の結び付け。
      'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE',
      'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID',
    ]);
  });

  const NOT_EXECUTABLE = buttonOf(NEW_PATH, probeOf(shapeOf({ method: 'DELETE' })));
  const STATE_SHAPE: ApiRequestShape = { ...CREATE_SHAPE, body: { ...CREATE_SHAPE.body, stateKeyPresent: true } };
  const METHOD_KEY_SHAPE = shapeOf({ body: { name: MARKERS[0], email: MARKERS[1], note: Number(MARKERS[2]), tenant_id: 't', _method: 'DELETE' } });
  const HEADER_SHAPE = shapeOf({ headers: { 'content-type': 'application/json', 'x-http-method-override': 'DELETE' } });
  const UPSERT_SHAPE = shapeOf({ headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates' } });
  const STRING_NOTE_SHAPE = shapeOf({ body: { name: MARKERS[0], email: MARKERS[1], note: MARKERS[2], tenant_id: 't' } });
  const forged = (shape: ApiRequestShape, path = NEW_PATH, result: SubmissionProbeRecord['result'] = 'API_CREATE'): DiscoveryCandidate =>
    buttonOf(path, forgedProbeOf(shape, result));

  it.each<readonly [string, () => readonly [Record<string, unknown>, DiscoveryCandidate | null, ScenarioDraftContext?], readonly string[]]>([
    ['a candidate whose probe is NOT_EXECUTABLE', () => [draftOf(NOT_EXECUTABLE), NOT_EXECUTABLE], ['SCENARIO_API_CANDIDATE_NOT_API']],
    ['a probe without the input fields (before T38a)', () => {
      const { inputFields: _fields, ...old } = probeOf(CREATE_SHAPE);
      const candidate = buttonOf(NEW_PATH, old);
      return [draftOf(candidate), candidate];
    }, ['SCENARIO_API_CANDIDATE_NOT_API']],
    ['another shape digest than the probe', () => [draftOf(CREATE_CANDIDATE, {}, { shapeDigest: `sha256:${'0'.repeat(64)}` }), CREATE_CANDIDATE],
      ['SCENARIO_API_CANDIDATE_NOT_API']],
    ['a state key (stateKeyPresent)', () => [draftOf(forged(STATE_SHAPE)), forged(STATE_SHAPE)], ['SCENARIO_API_STATE_KEY']],
    ['a method override by the _method key', () => [draftOf(forged(METHOD_KEY_SHAPE)), forged(METHOD_KEY_SHAPE)], ['SCENARIO_API_METHOD_OVERRIDE']],
    ['a method override header among the allowed headers', () => [draftOf(forged(HEADER_SHAPE)), forged(HEADER_SHAPE)],
      ['SCENARIO_API_HEADER_METHOD_OVERRIDE']],
    ['an origin that is not an approved service origin of the profile', () => [draftOf(CREATE_CANDIDATE), CREATE_CANDIDATE,
      { ...CONTEXT, approvedServiceOrigins: [] }], ['SCENARIO_API_ORIGIN_NOT_APPROVED']],
    ['an I21 shape forged as API_CREATE (upsert)', () => [draftOf(forged(UPSERT_SHAPE)), forged(UPSERT_SHAPE)], ['SCENARIO_API_SHAPE_NOT_EXECUTABLE']],
    ['an UPDATE shape forged as API_CREATE', () => [draftOf(forged(UPDATE_SHAPE, EDIT_PATH)), forged(UPDATE_SHAPE, EDIT_PATH)],
      ['SCENARIO_API_SHAPE_NOT_EXECUTABLE']],
    ['a sent key without a field (a page key)', () => [draftOf(CREATE_CANDIDATE, { fieldNames: ['name', 'email', 'note', 'tenant_id'] }, { pageKeys: [] }),
      CREATE_CANDIDATE], ['SCENARIO_API_FIELD_KEY_MISMATCH']],
    ['a key with a field that is not sent', () => [draftOf(CREATE_CANDIDATE, { fieldNames: ['name', 'email'] }), CREATE_CANDIDATE],
      ['SCENARIO_API_FIELD_KEY_MISMATCH']],
    ['a sent key that is not a key of the shape', () => [draftOf(CREATE_CANDIDATE, { fieldNames: ['name', 'email', 'note', 'other'] }), CREATE_CANDIDATE],
      ['SCENARIO_API_FIELD_KEY_MISMATCH']],
    ['a number field sent as a JSON string', () => [draftOf(forged(STRING_NOTE_SHAPE)), forged(STRING_NOTE_SHAPE)], ['SCENARIO_API_FIELD_TYPE_MISMATCH']],
    ['a key without a field that is not a page key', () => [draftOf(CREATE_CANDIDATE, {}, { pageKeys: [] }), CREATE_CANDIDATE], ['SCENARIO_API_KEY_NOT_ALLOWED']],
    ['a page key that is not a key of the shape', () => [draftOf(CREATE_CANDIDATE, {}, { pageKeys: ['tenant_id', 'other'] }), CREATE_CANDIDATE],
      ['SCENARIO_API_KEY_NOT_ALLOWED']],
    ['a secret-like page key', () => {
      const shape = shapeOf({ body: { name: MARKERS[0], email: MARKERS[1], note: Number(MARKERS[2]), access_token: 't' } });
      const candidate = forged(shape);
      return [draftOf(candidate, {}, { pageKeys: ['access_token'] }), candidate];
    }, ['SCENARIO_API_PAGE_KEY_SECRET_LIKE']],
    ['a filter name that differs from the filter of the shape', () => [draftOf(UPDATE_CANDIDATE, {}, { ...UPDATE_API, filterName: 'member_id' }),
      UPDATE_CANDIDATE], ['SCENARIO_API_FILTER_MISMATCH']],
    ['a filter name on a CREATE', () => [draftOf(CREATE_CANDIDATE, {}, { filterName: 'id' }), CREATE_CANDIDATE], ['SCENARIO_API_FILTER_MISMATCH']],
    ['an UPDATE without the ledger', () => [draftOf(UPDATE_CANDIDATE, {}, { ...UPDATE_API, ledger: null }), UPDATE_CANDIDATE],
      ['SCENARIO_UPDATE_SPEC_MISSING']],
    ['a ledger on a CREATE', () => [draftOf(CREATE_CANDIDATE, {}, { ledger: UPDATE_API.ledger }), CREATE_CANDIDATE], ['SCENARIO_UPDATE_SPEC_NOT_ALLOWED']],
    ['a ledger that is not a CREATE scenario of the profile', () => [draftOf(UPDATE_CANDIDATE, {}, {
      ...UPDATE_API, ledger: { targetCreateScenarioId: 'scenario-missing', formPathTemplate: '/admin/members/{id}/edit' },
    }), UPDATE_CANDIDATE], ['SCENARIO_UPDATE_TARGET_NOT_FOUND']],
    ['a form path template that does not lead to the page of the candidate', () => [draftOf(UPDATE_CANDIDATE, {}, {
      ...UPDATE_API, ledger: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: '/admin/users/{id}/edit' },
    }), UPDATE_CANDIDATE], ['SCENARIO_UPDATE_PATH_MISMATCH']],
    ['an UPDATE spec of a form on an API draft', () => [draftOf(CREATE_CANDIDATE, {
      update: { targetCreateScenarioId: LEDGER_ID, formPathTemplate: '/a/{id}', actionPathTemplate: '/a/{id}', keepFieldNames: [] },
    }), CREATE_CANDIDATE], ['SCENARIO_UPDATE_SPEC_NOT_ALLOWED']],
    ['a secret-like key to send', () => {
      const shape = shapeOf({ body: { name: MARKERS[0], api_key: MARKERS[1], note: Number(MARKERS[2]) } });
      const candidate = forged(shape);
      return [draftOf(candidate, { fieldNames: ['name', 'api_key', 'note'] }, { pageKeys: [] }), candidate];
    }, ['SCENARIO_FIELD_SECRET_LIKE']],
  ])('rejects %s', (_label, make, codes) => {
    const [draft, candidate, context] = make();
    expect(codesOf(validate(draft, candidate, context ?? CONTEXT))).toEqual(codes);
  });

  it('rejects the shapes outside the contract of an API draft with SCENARIO_INPUT_INVALID only', () => {
    for (const [name, draft] of [
      ['an unknown transport', draftOf(CREATE_CANDIDATE, { transport: 'GRPC' })],
      ['an API draft without the API spec', draftOf(CREATE_CANDIDATE, { api: undefined })],
      ['a FORM draft with the API spec', draftOf(CREATE_CANDIDATE, { transport: 'FORM' })],
      ['a shape digest of another form', draftOf(CREATE_CANDIDATE, {}, { shapeDigest: 'x' })],
      ['an unknown property of the API spec', draftOf(CREATE_CANDIDATE, {}, { headerNames: ['x'] })],
      ['a record id of another source', draftOf(CREATE_CANDIDATE, {}, { recordId: { source: 'HEADER', key: 'id' } })],
      ['too many page keys', draftOf(CREATE_CANDIDATE, {}, { pageKeys: Array.from({ length: MAX_SCENARIO_API_KEYS + 1 }, (_value, index) => `k${index}`) })],
    ] as const) {
      const codes = codesOf(validate(JSON.parse(JSON.stringify(draft)) as unknown, CREATE_CANDIDATE));
      expect(codes.length, name).toBeGreaterThan(0);
      expect([...new Set(codes)], name).toEqual(['SCENARIO_INPUT_INVALID']);
    }
  });

  it('still rejects an API candidate as a FORM draft (not a POST form)', () => {
    const { api: _api, transport: _transport, ...form } = draftOf(CREATE_CANDIDATE);
    expect(codesOf(validate(form, CREATE_CANDIDATE))).toContain('SCENARIO_CANDIDATE_NOT_WRITABLE');
  });
});

// T38c（T38b の報告の (2)）: 型の Origin は probe の時の承認したサービスの Origin の一覧の番号なので、候補を見つけた発見のジョブのプロファイルの改訂が、
// 今の改訂と同じであることを求める（違えば発見のやり直し）。改訂が分からなければ拒む（fail-closed）。FORM の下書きは見ない。
describe('T38c: the profile revision of the discovery job of an API draft', () => {
  it.each<readonly [string, ScenarioDraftContext]>([
    ['another revision than the current one', { ...CONTEXT, profileRevisions: { discoveryJob: 1, current: 2 } }],
    ['an unknown revision of the discovery job', { ...CONTEXT, profileRevisions: { discoveryJob: null, current: 2 } }],
    ['no revisions in the context', { scenarioId: null, scenarios: CONTEXT.scenarios, approvedServiceOrigins: [API] }],
  ])('rejects %s with SCENARIO_API_DISCOVERY_PROFILE_STALE', (_label, context) => {
    expect(codesOf(validate(draftOf(CREATE_CANDIDATE), CREATE_CANDIDATE, context))).toEqual(['SCENARIO_API_DISCOVERY_PROFILE_STALE']);
  });

  it('accepts the same revision, and does not look at the revisions for a FORM draft', () => {
    expect(codesOf(validate(draftOf(CREATE_CANDIDATE), CREATE_CANDIDATE))).toEqual([]);
    expect(codesOf(validateScenarioDraft(sampleDraft(), FORM_CREATE_CANDIDATE, READ_CHECK_FACTS, { ...CONTEXT, profileRevisions: { discoveryJob: 1, current: 2 } })))
      .toEqual([]);
  });
});

// T38c（ユーザーの判断 (3)、T38c の Blocker の判断（案 A））: API のシナリオに限って、`{id}` つきの画面の path の READ の定義を照合の READ に使える
// （送る値がないので結び付けは 0 件）。FORM のシナリオと、型でない画面の path の READ は、今のまま拒む。候補の READ は結び付けが 1 件以上。
describe('T38c: the verification READ of a page path template for an API scenario', () => {
  const TEMPLATE_READ = { readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pageTemplate: true } as const;
  const PAGE_READ = { ...TEMPLATE_READ, readCheckId: 'rc-page-fixed', pageTemplate: false } as const;
  const CANDIDATE_READ = { readCheckId: 'rc-search', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: ['q'], targetKind: 'CANDIDATE' } as const;
  const FACTS = [TEMPLATE_READ, PAGE_READ, CANDIDATE_READ];
  const verificationOf = (readCheckId: string, bindings: readonly Record<string, string>[]): Record<string, unknown> => ({
    successCondition: null, inputErrorCondition: null, recordId: null,
    readVerification: { readCheckId, revision: 1, bindings, expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] },
  });
  const withRead = (readCheckId: string, bindings: readonly Record<string, string>[]): Record<string, unknown> =>
    draftOf(CREATE_CANDIDATE, { verification: verificationOf(readCheckId, bindings) });

  it('accepts a page path template READ without a binding for an API scenario, and keeps it in the content', () => {
    const result = validateScenarioDraft(withRead('rc-page', []), CREATE_CANDIDATE, FACTS, CONTEXT);
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.verification.readVerification).toEqual({ readCheckId: 'rc-page', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] });
    expect(validateControlDocument('scenario', { ...sampleScenario(), ...result.content, inputRuleReference: null }).ok).toBe(true);
  });

  it.each<readonly [string, () => ScenarioDraftValidationResult, readonly string[]]>([
    ['a binding to a page path template READ (it sends no value)',
      () => validateScenarioDraft(withRead('rc-page', [{ parameterName: 'q', fieldName: 'email' }]), CREATE_CANDIDATE, FACTS, CONTEXT),
      ['SCENARIO_VERIFICATION_PARAMETER_UNKNOWN']],
    ['a page path READ that is not a template', () => validateScenarioDraft(withRead('rc-page-fixed', []), CREATE_CANDIDATE, FACTS, CONTEXT),
      ['SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET']],
    ['a READ candidate without a binding', () => validateScenarioDraft(withRead('rc-search', []), CREATE_CANDIDATE, FACTS, CONTEXT), ['SCENARIO_INPUT_INVALID']],
    ['a page path template READ for a FORM scenario', () => validateScenarioDraft(sampleDraft({
      verification: { ...verificationOf('rc-page', [{ parameterName: 'q', fieldName: 'name' }]) },
    }), FORM_CREATE_CANDIDATE, [...READ_CHECK_FACTS, ...FACTS], CONTEXT), ['SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET']],
    ['no binding for a FORM scenario (the shape)', () => validateScenarioDraft(sampleDraft({ verification: verificationOf('rc-page', []) }),
      FORM_CREATE_CANDIDATE, [...READ_CHECK_FACTS, ...FACTS], CONTEXT), ['SCENARIO_INPUT_INVALID']],
  ])('rejects %s', (_label, run, codes) => {
    expect(codesOf(run())).toEqual(codes);
  });
});

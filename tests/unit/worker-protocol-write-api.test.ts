// T40a（Task 40 の設計書 3.2、4 章）: IPC の契約（`src/control/worker-protocol.ts`、`schemas/control/worker-message.schema.json`）の、送り方 API の
// 登録の書き込みの `START`。
// - 書き込みの指定に、送り方 `API` の形（`transport: 'API'`）を足す: 承認した API の指定（シナリオの API の指定の形。照合に要る項目と ID の取り方）、
//   欄に対応する鍵ごとの生成した値、送信の要素の識別の digest、書き込みの画面、検証の指定、照合の READ（`{id}` の型の画面の READ を含む）。
// - 手書きの確かめ: `WRITE_CREATE` だけ（API の更新は Task 41 まで拒む）、POST・filter なし・台帳なし、API の Origin が認証の指定の承認したサービスの
//   Origin、値の鍵が欄に対応する鍵とちょうど同じ（ページが決める鍵の値は持たない）で鍵の JSON の型に変えられる、送信の要素の識別の digest が
//   候補の識別の digest（登録の画面の path で求めたもの）、照合の READ は候補の READ か `{id}` の型の画面の READ（型でない画面の path は拒む）、
//   seed の記録と承認の要約が書き込みの指定のもの。誤りの文に値と名前を入れない。
// - Schema と契約の一致: Schema の `startApiWrite` の項目は、受ける例の項目と同じで、秘密の名前の項目を持たない。API の指定はシナリオの Schema を
//   参照する（書き写さない）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SUBMITTED_VALUE_LENGTH } from '../../src/control/actions/action-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_WRITE_CREATE_JOB_KIND,
  isWorkerStartApiWrite,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  workerAuthenticationDigestOf,
  type WorkerJobKind,
} from '../../src/control/worker-protocol.js';
import { propertyNamesWithWords } from '../helpers/schema-test-support.js';
import { SAMPLE_API_ORIGIN, SAMPLE_API_READ_TEMPLATE_PATH, sampleStartApiWrite, sampleStartWrite } from './worker-write-samples.js';

const ORIGIN = 'http://127.0.0.1:4173';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'9'.repeat(64)}`;
const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as {
  readonly $defs: Record<string, Record<string, unknown>>;
};

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-write',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const apiWrite = (overrides: Record<string, unknown> = {}): Record<string, unknown> => sampleStartApiWrite(ORIGIN, overrides);
const api = (overrides: Record<string, unknown>): Record<string, unknown> => ({ ...(apiWrite()['api'] as Record<string, unknown>), ...overrides });
const apiRequest = (overrides: Record<string, unknown>): Record<string, unknown> =>
  api({ request: { ...((apiWrite()['api'] as Record<string, unknown>)['request'] as Record<string, unknown>), ...overrides } });

const start = (jobKind: WorkerJobKind, write: Record<string, unknown>, serviceOrigins: readonly string[] = [SAMPLE_API_ORIGIN]): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-write',
  jobKind,
  targetConfigPath: 'local/targets/example-write.json',
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    ...(serviceOrigins.length === 0 ? {} : { approvedServiceOrigins: [...serviceOrigins] }),
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind, automatedLogin: null, approvedServiceOrigins: serviceOrigins }),
  },
  write,
});

const errorsOf = (value: unknown): readonly string[] => {
  const checked = validateParentToWorkerMessage(value);
  return checked.ok ? [] : checked.errors;
};

const withApiWrite = (overrides: Record<string, unknown>): Record<string, unknown> => start(WORKER_WRITE_CREATE_JOB_KIND, apiWrite(overrides));

describe('T40a: START of an API write job (the accepted shapes)', () => {
  it('accepts WRITE_CREATE with the API write specification and a page path template READ', () => {
    expect(errorsOf(withApiWrite({}))).toEqual([]);
  });

  it('accepts a READ candidate as the verification READ, values without a value (null), and no record id key (the verification spec takes it)', () => {
    const readCandidate = {
      readCheckId: 'rc-verify', readCheckRevision: 1, targetPage: { origin: ORIGIN, path: '/admin/members' },
      definition: { targetIdentityDigest: DIGEST, parameters: { q: 'サンプル 太郎' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] },
    };
    expect(errorsOf(withApiWrite({ readVerification: readCandidate }))).toEqual([]);
    expect(errorsOf(withApiWrite({ values: { email: 'sample0001@example.invalid', name: null, score: '7' } }))).toEqual([]);
    expect(errorsOf(withApiWrite({ api: api({ recordId: null }) }))).toEqual([]);
  });

  // T40a-fix: API の書き込みの指定の成否の条件と入力の誤りの条件は null。ID の取り方は、API の `recordId` か検証の指定の `recordId` のどちらかがあればよい。
  it('accepts the two conditions as null, and a record id taken by either the response body key or the verification spec', () => {
    const verification = apiWrite()['verification'] as Record<string, unknown>;
    expect(verification).toMatchObject({ successCondition: null, inputErrorCondition: null });
    expect(errorsOf(withApiWrite({ verification: { ...verification, recordId: null } }))).toEqual([]);
    expect(errorsOf(withApiWrite({ api: api({ recordId: null }) }))).toEqual([]);
  });

  it('tells the API write specification from the form one', () => {
    const validated = validateParentToWorkerMessage(withApiWrite({}));
    expect(validated.ok).toBe(true);
    if (!validated.ok || validated.message.type !== 'START' || validated.message.write === undefined) return;
    expect(isWorkerStartApiWrite(validated.message.write)).toBe(true);
    const form = validateParentToWorkerMessage(start(WORKER_WRITE_CREATE_JOB_KIND, sampleStartWrite(ORIGIN), []));
    expect(form.ok && form.message.type === 'START' && form.message.write !== undefined && isWorkerStartApiWrite(form.message.write)).toBe(false);
  });
});

describe('T40a: START of an API write job (the rejected shapes)', () => {
  it('rejects the API write for WRITE_UPDATE (Task 41) and for the other kinds', () => {
    expect(errorsOf(start('WRITE_UPDATE', apiWrite()))).not.toEqual([]);
    expect(errorsOf(start('WRITE_UPDATE', apiWrite({ update: sampleStartWrite(ORIGIN)['update'] })))).not.toEqual([]);
    for (const jobKind of ['AUDIT', 'DISCOVERY', 'LOGIN_CHECK'] as const) {
      expect(errorsOf(start(jobKind, apiWrite())), jobKind).not.toEqual([]);
    }
  });

  it('rejects an API origin that is not an approved service origin of the authentication', () => {
    expect(errorsOf(start(WORKER_WRITE_CREATE_JOB_KIND, apiWrite(), []))).not.toEqual([]);
    expect(errorsOf(start(WORKER_WRITE_CREATE_JOB_KIND, apiWrite(), ['http://127.0.0.3:4175']))).not.toEqual([]);
  });

  it.each<readonly [string, Record<string, unknown>]>([
    // 送り方と形の混ざり（form の項目は持てない。API の項目は form の書き込みの指定に持てない）。
    ['another transport', { transport: 'FORM' }],
    ['a form request', { request: sampleStartWrite(ORIGIN)['request'] }],
    ['candidate fields', { candidateFields: sampleStartWrite(ORIGIN)['candidateFields'] }],
    ['an update block', { update: { targetRecordId: '1', templatedIdentityDigest: DIGEST, changedFieldNames: ['name'], keptFieldNames: [] } }],
    ['no API spec', { api: undefined }],
    ['no submitter digest', { submitterIdentityDigest: undefined }],
    // 要求の型（CREATE は POST、filter なし、台帳なし）。
    ['a PATCH request', { api: apiRequest({ method: 'PATCH' }) }],
    ['a DELETE request', { api: apiRequest({ method: 'DELETE' }) }],
    ['a filter name', { api: api({ filterName: 'id' }) }],
    ['a ledger', { api: api({ ledger: { targetCreateScenarioId: 'scenario-0', formPathTemplate: '/admin/members/{id}/edit' } }) }],
    ['an API origin that is not canonical', { api: apiRequest({ origin: `${SAMPLE_API_ORIGIN}/` }) }],
    ['a bad shape digest', { api: api({ shapeDigest: 'sha256:x' }) }],
    // 値（欄に対応する鍵とちょうど同じ。ページが決める鍵の値は持たない。鍵の JSON の型に変えられる。長さの上限）。
    ['a value of a page key', { values: { email: 'sample0001@example.invalid', name: 'x', score: '7', tenant_id: 'tenant-1' } }],
    ['a value of an unknown key', { values: { email: 'sample0001@example.invalid', name: 'x', score: '7', other: 'y' } }],
    ['a missing value of a key', { values: { email: 'sample0001@example.invalid', name: 'x' } }],
    ['no value to fill', { values: { email: null, name: null, score: null } }],
    ['a number value that is not in the canonical form', { values: { email: 'sample0001@example.invalid', name: 'x', score: '07' } }],
    ['a number value that is not a number', { values: { email: 'sample0001@example.invalid', name: 'x', score: 'seven' } }],
    ['a too long value', { values: { email: 'sample0001@example.invalid', name: 'x'.repeat(MAX_SUBMITTED_VALUE_LENGTH + 1), score: '7' } }],
    ['a duplicate key field', { api: api({ keyFields: [...(api({})['keyFields'] as unknown[]), { key: 'name', type: 'string', field: { kind: 'NAME', name: 'name2' }, fieldType: 'text' }] }) }],
    ['a key that is also a page key', { api: api({ pageKeys: [{ key: 'name', type: 'string' }] }) }],
    ['no key field', { api: api({ keyFields: [] }), values: {} }],
    // 送信の要素と候補（登録の画面の path で求めた識別の digest は、候補の識別の digest）。
    ['a submitter digest of another element', { submitterIdentityDigest: OTHER_DIGEST }],
    ['a bad submitter digest', { submitterIdentityDigest: 'sha256:x' }],
    ['a form page origin that is not canonical', { formPage: { origin: 'HTTP://127.0.0.1:4173', path: '/admin/members/new' } }],
    ['a form page with a template mark', { formPage: { origin: ORIGIN, path: '/admin/members/{id}/edit' } }],
    // 照合の READ（型でない画面の path は拒む。型の対象の画面は定義の型と同じ）。
    ['a verification READ of a page path that is not a template', { readVerification: {
      readCheckId: 'rc-page', readCheckRevision: 1, targetPage: { origin: ORIGIN, path: '/admin/members' },
      definition: { targetPagePath: '/admin/members', parameters: {}, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } }],
    ['a template READ whose target page is another path', { readVerification: {
      readCheckId: 'rc-page', readCheckRevision: 1, targetPage: { origin: ORIGIN, path: '/admin/members/1/edit' },
      definition: { targetPagePath: SAMPLE_API_READ_TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } }],
    ['a template READ without a target page', { readVerification: {
      readCheckId: 'rc-page', readCheckRevision: 1, targetPage: null,
      definition: { targetPagePath: SAMPLE_API_READ_TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } }],
    ['a template READ of another origin', { readVerification: {
      readCheckId: 'rc-page', readCheckRevision: 1, targetPage: { origin: SAMPLE_API_ORIGIN, path: SAMPLE_API_READ_TEMPLATE_PATH },
      definition: { targetPagePath: SAMPLE_API_READ_TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } }],
    ['a verification READ with a secret-like parameter', { readVerification: {
      readCheckId: 'rc-verify', readCheckRevision: 1, targetPage: { origin: ORIGIN, path: '/admin/members' },
      definition: { targetIdentityDigest: DIGEST, parameters: { password: 'x' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } }],
    // seed の記録と承認の要約は、この書き込みの指定のもの。
    ['a seed input of another grant', { seedRecord: { ...(apiWrite()['seedRecord'] as object),
      seedInput: { ...((apiWrite()['seedRecord'] as Record<string, unknown>)['seedInput'] as object), executionGrantId: 'grant-2' } } }],
    ['approval facts of another grant', { grantId: 'grant-2', seedRecord: { ...(apiWrite()['seedRecord'] as object),
      seedInput: { ...((apiWrite()['seedRecord'] as Record<string, unknown>)['seedInput'] as object), executionGrantId: 'grant-2' } } }],
    // 秘密の項目はない。
    ['a cookie property', { cookies: [] }],
    ['a page key value property', { pageKeyValues: { tenant_id: 'tenant-1' } }],
    ['an authorization property', { authorization: 'Bearer x' }],
  ])('rejects an API write specification with %s', (_label, overrides) => {
    expect(errorsOf(withApiWrite(overrides))).not.toEqual([]);
  });

  // 手書きの確かめが、スキーマを通った形を、その規則の文で拒む（スキーマの誤りではなく）。
  it.each<readonly [string, Record<string, unknown>, string]>([
    ['a PATCH request', { api: apiRequest({ method: 'PATCH' }) }, '/write/api must be the spec of a CREATE'],
    ['a filter name', { api: api({ filterName: 'id' }) }, '/write/api must be the spec of a CREATE'],
    ['a ledger', { api: api({ ledger: { targetCreateScenarioId: 'scenario-0', formPathTemplate: '/admin/members/{id}/edit' } }) },
      '/write/api must be the spec of a CREATE'],
    ['an API origin that is not canonical', { api: apiRequest({ origin: `${SAMPLE_API_ORIGIN}/` }) }, '/write/api/request/origin'],
    ['a value of a page key', { values: { email: 'sample0001@example.invalid', name: 'x', score: '7', tenant_id: 'tenant-1' } }, '/write/values must have a value for each key'],
    ['a missing value of a key', { values: { email: 'sample0001@example.invalid', name: 'x' } }, '/write/values must have a value for each key'],
    ['no value to fill', { values: { email: null, name: null, score: null } }, '/write/values must have a value to fill'],
    ['a number value that is not in the canonical form', { values: { email: 'sample0001@example.invalid', name: 'x', score: '07' } },
      '/write/values (key 2) must be convertible'],
    ['a key that is also a page key', { api: api({ pageKeys: [{ key: 'name', type: 'string' }] }) }, '/write/api/keyFields must have one or more keys'],
    ['a submitter digest of another element', { submitterIdentityDigest: OTHER_DIGEST }, '/write/submitterIdentityDigest'],
    ['a form page with a template mark', { formPage: { origin: ORIGIN, path: '/admin/members/{id}/edit' } }, '/write/formPage'],
    ['a verification READ of a page path that is not a template', { readVerification: {
      readCheckId: 'rc-page', readCheckRevision: 1, targetPage: { origin: ORIGIN, path: '/admin/members' },
      definition: { targetPagePath: '/admin/members', parameters: {}, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } },
    '/write/readVerification/definition must target a READ candidate or a page path template'],
    ['a template READ of another origin', { readVerification: {
      readCheckId: 'rc-page', readCheckRevision: 1, targetPage: { origin: SAMPLE_API_ORIGIN, path: SAMPLE_API_READ_TEMPLATE_PATH },
      definition: { targetPagePath: SAMPLE_API_READ_TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } },
    '/write/readVerification/definition must target a READ candidate or a page path template'],
    ['approval facts of another grant', { grantId: 'grant-2', seedRecord: { ...(apiWrite()['seedRecord'] as object),
      seedInput: { ...((apiWrite()['seedRecord'] as Record<string, unknown>)['seedInput'] as object), executionGrantId: 'grant-2' } } },
    '/write/approvalFacts'],
    // T40R-fix-B（I-2 (a)）: `{id}` の型の照合の READ は、生成した値と比べる期待を 1 つ以上持つ（行の数だけは拒む）。
    ['a template READ with a row count only', { readVerification: {
      readCheckId: 'rc-page', readCheckRevision: 1, targetPage: { origin: ORIGIN, path: SAMPLE_API_READ_TEMPLATE_PATH },
      definition: { targetPagePath: SAMPLE_API_READ_TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } },
    '/write/readVerification/definition must have an expectation compared with a generated value'],
    // T40R2-fix（M-1）: `{id}` の型の照合の READ の、生成した値と比べる期待は、比べる値が生成した値のどれか（書き写した文字ではない）。
    ['a template READ whose text is not a generated value', { readVerification: {
      readCheckId: 'rc-page', readCheckRevision: 1, targetPage: { origin: ORIGIN, path: SAMPLE_API_READ_TEMPLATE_PATH },
      definition: { targetPagePath: SAMPLE_API_READ_TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'a fixed text' }] } } },
    '/write/readVerification/definition must have an expectation compared with a generated value'],
    ['a template READ whose detail is a value not made', { values: { email: 'sample0001@example.invalid', name: null, score: '7' }, readVerification: {
      readCheckId: 'rc-page', readCheckRevision: 1, targetPage: { origin: ORIGIN, path: SAMPLE_API_READ_TEMPLATE_PATH },
      definition: { targetPagePath: SAMPLE_API_READ_TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'DETAIL_FIELD_EQUALS', field: '名前', value: 'サンプル 太郎' }] } } },
    '/write/readVerification/definition must have an expectation compared with a generated value'],
  ])('rejects %s by the rule written by hand', (_label, overrides, text) => {
    expect(errorsOf(withApiWrite(overrides)).some((error) => error.startsWith(text))).toBe(true);
  });

  // T40a-fix: ID の取り方が 2 つとも null なら拒む。成否の条件・入力の誤りの条件を持つ API の書き込みの指定は拒む（親は null を入れる）。form の
  // 書き込みの指定は、今のまま null の条件を拒む。
  it('rejects an API write without any way to take the record id, an API write with a condition, and a form write without a condition', () => {
    const verification = apiWrite()['verification'] as Record<string, unknown>;
    expect(errorsOf(withApiWrite({ verification: { ...verification, recordId: null }, api: api({ recordId: null }) }))).toEqual([
      '/write/verification/recordId and /write/api/recordId must not both be null (no way to take the record id)',
    ]);
    expect(errorsOf(withApiWrite({ verification: { ...verification, successCondition: { pathPrefix: '/admin', selector: null } } }))).not.toEqual([]);
    expect(errorsOf(withApiWrite({ verification: { ...verification, inputErrorCondition: { pathPrefix: '/admin', selector: '.error' } } }))).not.toEqual([]);
    const form = sampleStartWrite(ORIGIN);
    const formVerification = form['verification'] as Record<string, unknown>;
    for (const item of ['successCondition', 'inputErrorCondition'] as const) {
      expect(errorsOf(start(WORKER_WRITE_CREATE_JOB_KIND, { ...form, verification: { ...formVerification, [item]: null } }, [])), item).not.toEqual([]);
    }
  });

  // T40R-fix-B: 候補の READ（生成した値を結び付けて送る）は行の数だけでもよい。型に当たらない ID の型と、要素から取る形は受ける。
  it('accepts a READ candidate with a row count only, a pattern of another depth and an element (T40R-fix-B)', () => {
    expect(errorsOf(withApiWrite({ readVerification: {
      readCheckId: 'rc-verify', readCheckRevision: 1, targetPage: { origin: ORIGIN, path: '/admin/members' },
      definition: { targetIdentityDigest: DIGEST, parameters: { q: 'サンプル 太郎' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } }))).toEqual([]);
    // T40R2-fix（使える度合い）: 書き込みの画面に当たる ID の型も受ける（保存と同じく拒まない。注意は画面に出す。ワーカーは押す前の値と比べる）。
    for (const recordId of [{ source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}/edit' }, { source: 'ELEMENT', selector: '#member-id' },
      { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}' }]) {
      expect(errorsOf(withApiWrite({ verification: { successCondition: null, inputErrorCondition: null, recordId } }))).toEqual([]);
    }
  });

  it('rejects an API origin that is not approved and a WRITE_UPDATE by the rules written by hand', () => {
    expect(errorsOf(start(WORKER_WRITE_CREATE_JOB_KIND, apiWrite(), ['http://127.0.0.3:4175']))).toEqual([
      '/write/api/request/origin must be the canonical origin of an approved service origin of the authentication',
    ]);
    // T41b: API の更新の書き込みのジョブは、API の更新の指定（`update`）を必ず持つ（受ける形は `api-update-grant-start.test.ts`）。
    expect(errorsOf(start('WRITE_UPDATE', apiWrite()))).toEqual(['/write/update is required for WRITE_UPDATE and allowed only for it']);
  });

  it('writes no value and no key name into the errors', () => {
    const errors = errorsOf(withApiWrite({ values: { email: 'secret-value-example', name: 'x', score: 'secret-number-example', tenant_id: 'tenant-value-example' } }));
    expect(errors).not.toEqual([]);
    for (const text of ['secret-value-example', 'secret-number-example', 'tenant-value-example', 'tenant_id']) {
      expect(errors.join(' ')).not.toContain(text);
    }
  });
});

describe('T40a: the schema and the contract of the API write specification', () => {
  it('has the same properties in the schema as the accepted example, refers to the API spec of the scenario schema, and has no secret property', () => {
    const startApiWrite = SCHEMA.$defs['startApiWrite'] ?? {};
    // T41b: 項目は受ける例（登録）の項目と、API の更新の指定（`update`。省ける）。
    expect(Object.keys(startApiWrite['properties'] as object).sort()).toEqual([...Object.keys(apiWrite()), 'update'].sort());
    expect([...(startApiWrite['required'] as string[])].sort()).toEqual(Object.keys(apiWrite()).sort());
    expect(startApiWrite['additionalProperties']).toBe(false);
    expect((startApiWrite['properties'] as Record<string, unknown>)['api']).toEqual({ $ref: 'urn:beaksight:schema:control:scenario:1#/$defs/api' });
    const secretWords = ['password', 'credential', 'secret', 'cookie', 'token', 'csrf', 'xsrf', 'storage', 'session', 'username', 'authorization', 'pagekeyvalue'];
    expect(propertyNamesWithWords(startApiWrite, secretWords)).toEqual([]);
  });

  it('has only null for the two conditions of the API verification spec, and the record id of the scenario schema or null (T40a-fix)', () => {
    const verification = ((SCHEMA.$defs['startApiWrite'] ?? {})['properties'] as Record<string, Record<string, unknown>>)['verification'] ?? {};
    expect(verification['additionalProperties']).toBe(false);
    expect([...(verification['required'] as string[])].sort()).toEqual(['inputErrorCondition', 'recordId', 'successCondition']);
    expect(verification['properties']).toEqual({
      successCondition: { type: 'null' },
      inputErrorCondition: { type: 'null' },
      recordId: { anyOf: [{ $ref: 'urn:beaksight:schema:control:scenario:1#/$defs/recordId' }, { type: 'null' }] },
    });
  });

  it('chooses the form or the API write specification by the transport', () => {
    const write = ((SCHEMA.$defs['start'] ?? {})['properties'] as Record<string, unknown>)['write'];
    expect(write).toEqual({ oneOf: [{ $ref: '#/$defs/startWrite' }, { $ref: '#/$defs/startApiWrite' }] });
    expect(((SCHEMA.$defs['startApiWrite'] ?? {})['properties'] as Record<string, unknown>)['transport']).toEqual({ const: 'API' });
  });
});

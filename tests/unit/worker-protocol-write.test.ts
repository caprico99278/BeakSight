// T30e（Task 30 の設計書 3 章の「送る直前の確かめ直し」「予約の締め」、4 章の「IPC」）: IPC の契約（`src/control/worker-protocol.ts`）の、書き込みの
// ジョブ（`WRITE_CREATE`）の部分。
// - 版を `beaksight-worker-message/2` に上げた（書き込みの指定と、確かめ直しの往復と、送信の報告のメッセージを足したため）。
// - `START`: `WRITE_CREATE` は、認証の指定（ログインを使う方式）と、書き込みの指定（`write`）を必ず持つ。ほかの種類は書き込みの指定を持てない。
//   書き込みの指定は、シナリオの id と版、許可の id、承認した候補の要求の形（text/plain は持てない）、書き込みの画面、候補の 2 つの digest、
//   候補の欄（名前・型・readonly・hidden・disabled だけ）、送る値（送る欄の生成した値。送れない欄・秘密に見える名前は拒む）、検証の指定、
//   照合の READ（生成した値を結び付けた後の READ の定義）。資格情報・Cookie・CSRF の値の項目はない（スキーマの `additionalProperties: false`）。
// - 子 → 親 `WRITE_RECHECK_REQUEST`・`WRITE_SUBMISSION`、親 → 子 `WRITE_RECHECK_RESULT`。許すときは理由なし、拒むときは理由つき。`NOT_SENT` だけが
//   止めた理由を持つ。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_BLOCK_REASONS, MAX_SUBMITTED_VALUE_LENGTH, SUBMISSION_STATES } from '../../src/control/actions/action-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  PARENT_TO_WORKER_MESSAGE_TYPES,
  WORKER_PROTOCOL_VERSION,
  WORKER_TO_PARENT_MESSAGE_TYPES,
  WORKER_WRITE_BLOCK_REASONS,
  WORKER_WRITE_CREATE_JOB_KIND,
  WORKER_WRITE_RECHECK_REJECTION_REASONS,
  WORKER_WRITE_RECHECK_TIMEOUT_MS,
  WORKER_WRITE_SUBMISSION_STATES,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerJobKind,
} from '../../src/control/worker-protocol.js';
import { propertyNamesWithWords } from '../helpers/schema-test-support.js';
import { SAMPLE_UPDATE_TARGET_RECORD_ID, sampleStartUpdateWrite, sampleStartWrite, sampleWriteField } from './worker-write-samples.js';

const ORIGIN = 'http://127.0.0.1:4173';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const RULE_DIGEST = `sha256:${'c'.repeat(64)}`;
const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as Record<string, unknown>;

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

const field = sampleWriteField;

/** 書き込みの指定（受ける形）。 */
const write = (overrides: Record<string, unknown> = {}): Record<string, unknown> => sampleStartWrite(ORIGIN, overrides);

const start = (jobKind: WorkerJobKind, extra: Record<string, unknown> = {}, authenticated = true): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-write',
  jobKind,
  targetConfigPath: 'local/targets/example-write.json',
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
  ...(authenticated ? {
    authentication: {
      setup: SETUP,
      approvedTestOrigins: [ORIGIN],
      authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind, automatedLogin: null }),
    },
  } : {}),
  ...extra,
});

const errorsOf = (value: unknown): readonly string[] => {
  const checked = validateParentToWorkerMessage(value);
  return checked.ok ? [] : checked.errors;
};

const workerErrorsOf = (value: unknown): readonly string[] => {
  const checked = validateWorkerToParentMessage(value);
  return checked.ok ? [] : checked.errors;
};

const withWrite = (overrides: Record<string, unknown>): Record<string, unknown> => start(WORKER_WRITE_CREATE_JOB_KIND, { write: write(overrides) });

describe('T30e: the write job messages and lists', () => {
  it('raises the protocol version and adds the message types at the end of each direction', () => {
    expect(WORKER_PROTOCOL_VERSION).toBe('beaksight-worker-message/2');
    // ML-a: 「ログインを終えた」（`LOGIN_CONFIRMED`）を、親 → 子の最後に足した。FM2d: まとめて実行の `NEXT_STAGE`・`CHAIN_END` を、その後に足した。
    expect(PARENT_TO_WORKER_MESSAGE_TYPES).toEqual(['START', 'STOP', 'WRITE_RECHECK_RESULT', 'LOGIN_CONFIRMED', 'NEXT_STAGE', 'CHAIN_END']);
    expect(WORKER_TO_PARENT_MESSAGE_TYPES.slice(-2)).toEqual(['WRITE_RECHECK_REQUEST', 'WRITE_SUBMISSION']);
    expect(WORKER_WRITE_CREATE_JOB_KIND).toBe('WRITE_CREATE');
    expect(WORKER_WRITE_RECHECK_REJECTION_REASONS).toEqual(['GRANT_INVALID', 'FACTS_UNAVAILABLE', 'RECHECK_REPEATED']);
    expect(WORKER_WRITE_SUBMISSION_STATES).toBe(SUBMISSION_STATES);
    expect(WORKER_WRITE_BLOCK_REASONS).toBe(ACTION_BLOCK_REASONS);
    expect(WORKER_WRITE_RECHECK_TIMEOUT_MS).toBe(10_000);
  });

  it('has no property for a credential, a cookie, a CSRF token or a hidden value in the write specification', () => {
    // 共通の語（`SECRET_PROPERTY_WORDS`）は、欄の印の `hidden`（真偽の値で、hidden の値ではない）に当たるので、ここでは前からの語の一覧を使う。
    const secretWords = ['password', 'credential', 'secret', 'cookie', 'token', 'csrf', 'xsrf', 'storage', 'session', 'username'];
    expect(propertyNamesWithWords((SCHEMA.$defs as Record<string, unknown>).startWrite, secretWords)).toEqual([]);
  });
});

describe('T30e: START of a write job', () => {
  it('accepts WRITE_CREATE with the authentication and the write specification', () => {
    expect(errorsOf(start(WORKER_WRITE_CREATE_JOB_KIND, { write: write() }))).toEqual([]);
    expect(errorsOf(withWrite({ request: { ...(write().request as object), methodOverride: 'PATCH', enctype: 'multipart/form-data' } }))).toEqual([]);
    expect(errorsOf(withWrite({ verification: { ...(write().verification as object), recordId: { source: 'ELEMENT', selector: '#id' } } }))).toEqual([]);
  });

  it('requires the write specification and the authentication for WRITE_CREATE, and allows it for no other kind', () => {
    expect(errorsOf(start(WORKER_WRITE_CREATE_JOB_KIND))).not.toEqual([]);
    expect(errorsOf(start(WORKER_WRITE_CREATE_JOB_KIND, { write: write() }, false))).not.toEqual([]);
    for (const jobKind of ['AUDIT', 'DISCOVERY', 'LOGIN_CHECK'] as const) {
      expect(errorsOf(start(jobKind, { write: write() })), jobKind).not.toEqual([]);
    }
    expect(errorsOf(start(WORKER_WRITE_CREATE_JOB_KIND, { write: write(), readChecks: [write().readVerification] }))).not.toEqual([]);
  });

  it.each<readonly [string, Record<string, unknown>]>([
    ['a text/plain enctype', { request: { ...(write().request as object), enctype: 'text/plain' } }],
    ['a GET request', { request: { ...(write().request as object), formMethod: 'GET' } }],
    ['a DELETE override', { request: { ...(write().request as object), methodOverride: 'DELETE' } }],
    ['a request origin that is not canonical', { request: { ...(write().request as object), origin: `${ORIGIN}/` } }],
    ['a request path without "/"', { request: { ...(write().request as object), path: 'members' } }],
    ['a form page origin that is not canonical', { formPage: { origin: 'HTTP://127.0.0.1:4173', path: '/members/new' } }],
    ['a value of a field that the candidate does not have', { values: { name: 'x', other: 'y' } }],
    ['a value of a hidden field', { values: { name: 'x', authenticity_token: 'y' } }],
    ['a value of a readonly field', { values: { name: 'x', kept: 'y' } }],
    ['a value of a file field', { values: { name: 'x', attachment: 'y' } }],
    ['a value of the method override field', { values: { name: 'x', _method: 'DELETE' } }],
    ['a value of a secret-like name', { candidateFields: [field('name'), field('access_token')], values: { name: 'x', access_token: 'y' } }],
    ['a too long value', { values: { name: 'x'.repeat(MAX_SUBMITTED_VALUE_LENGTH + 1) } }],
    ['a bad grant id', { grantId: 'Grant 1' }],
    ['a bad scenario revision', { scenarioRevision: 0 }],
    ['a bad candidate digest', { candidate: { identityDigest: 'sha256:x', ruleDigest: RULE_DIGEST } }],
    ['a missing verification item', { verification: { successCondition: { pathPrefix: '/a', selector: null }, inputErrorCondition: { pathPrefix: '/b', selector: null } } }],
    ['a null verification item', { verification: { ...(write().verification as object), recordId: null } }],
    ['a verification READ with a secret-like parameter', { readVerification: { ...(write().readVerification as object),
      definition: { targetIdentityDigest: DIGEST, parameters: { password: 'x' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } }],
    // T37d（設計者の判断 5）: 書き込みの照合の READ に、画面の path の定義は使わない（対象の画面が path と同じでも拒む）。
    ['a verification READ of a page path', { readVerification: { ...(write().readVerification as object),
      targetPage: { origin: ORIGIN, path: '/members' },
      definition: { targetPagePath: '/members', parameters: {}, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } }],
    // T30f（Blocker 1 の案 A）: プロファイルと seed の記録は必須で、seed の入力のプロファイル・シナリオ・版・許可は、書き込みの指定と同じ。
    ['no profile id', { profileId: undefined }],
    ['a bad profile id', { profileId: 'Profile 1' }],
    ['no seed record', { seedRecord: undefined }],
    ['a seed that is not 64 hex digits', { seedRecord: { ...(write().seedRecord as object), seed: 'x' } }],
    ['a bad base date', { seedRecord: { ...(write().seedRecord as object), baseDate: '2026/10/13' } }],
    ['a too large attempt', { seedRecord: { ...(write().seedRecord as object), attempt: 33 } }],
    ['a seed record with another property', { seedRecord: { ...(write().seedRecord as object), values: {} } }],
    ['a seed input of another profile', { seedRecord: { ...(write().seedRecord as object),
      seedInput: { ...((write().seedRecord as Record<string, unknown>)['seedInput'] as object), profileId: 'profile-2' } } }],
    ['a seed input of another scenario', { seedRecord: { ...(write().seedRecord as object),
      seedInput: { ...((write().seedRecord as Record<string, unknown>)['seedInput'] as object), scenarioId: 'scenario-2' } } }],
    ['a seed input of another revision', { seedRecord: { ...(write().seedRecord as object),
      seedInput: { ...((write().seedRecord as Record<string, unknown>)['seedInput'] as object), scenarioRevision: 2 } } }],
    ['a seed input of another grant', { seedRecord: { ...(write().seedRecord as object),
      seedInput: { ...((write().seedRecord as Record<string, unknown>)['seedInput'] as object), executionGrantId: 'grant-2' } } }],
    ['a cookie property', { cookies: [] }],
    ['a CSRF token property', { csrfToken: 'x' }],
    ['a hidden value property', { hiddenValues: { authenticity_token: 'x' } }],
    ['a candidate field with a value', { candidateFields: [{ ...field('name'), value: 'x' }] }],
  ])('rejects a write specification with %s', (_label, overrides) => {
    expect(errorsOf(withWrite(overrides))).not.toEqual([]);
  });

  // CCX-29（CC-087 の後半）: 照合の READ の規則の誤りは、READ の確かめの定義の一覧と同じ文を、`/write/readVerification` の位置で示す
  // （位置を引数で渡す形に変えても、同じ誤りが出ること）。
  it('reports the rule errors of the verification READ at /write/readVerification, with the texts of the READ check list', () => {
    expect(errorsOf(withWrite({ readVerification: { ...(write().readVerification as object),
      targetPage: { origin: `${ORIGIN}/`, path: '/members' },
      definition: { targetIdentityDigest: DIGEST, parameters: { q: 'x', password: 'y' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] } } }))).toEqual([
      '/write/readVerification/targetPage must be the canonical origin of an http(s) page and an absolute path',
      '/write/readVerification/definition/parameters (parameter 1) looks like a secret and is never sent',
    ]);
  });

  it('writes no value and no name into the errors', () => {
    const errors = errorsOf(withWrite({ candidateFields: [field('name'), field('access_token')], values: { name: 'x', access_token: 'secret-value-example' } }));
    expect(errors.join(' ')).not.toContain('secret-value-example');
    expect(errors.join(' ')).not.toContain('access_token');
  });
});

describe('T30e: the recheck and the submission messages', () => {
  it('accepts the recheck request and the submission reports from the worker', () => {
    expect(workerErrorsOf({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_REQUEST' })).toEqual([]);
    expect(workerErrorsOf({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_SUBMISSION', submission: 'SENT', blockReason: null })).toEqual([]);
    expect(workerErrorsOf({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_SUBMISSION', submission: 'UNKNOWN', blockReason: null })).toEqual([]);
    expect(workerErrorsOf({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_SUBMISSION', submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH' }))
      .toEqual([]);
  });

  it('accepts the recheck result from the parent: allowed without a reason, rejected with a reason', () => {
    expect(errorsOf({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: true, reason: null })).toEqual([]);
    for (const reason of WORKER_WRITE_RECHECK_REJECTION_REASONS) {
      expect(errorsOf({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: false, reason }), reason).toEqual([]);
    }
  });

  it.each<readonly [string, unknown, 'parent' | 'worker']>([
    ['an allowed result with a reason', { type: 'WRITE_RECHECK_RESULT', allowed: true, reason: 'GRANT_INVALID' }, 'parent'],
    ['a rejected result without a reason', { type: 'WRITE_RECHECK_RESULT', allowed: false, reason: null }, 'parent'],
    ['an unknown recheck reason', { type: 'WRITE_RECHECK_RESULT', allowed: false, reason: 'REVOKED' }, 'parent'],
    ['the result from the worker', { type: 'WRITE_RECHECK_RESULT', allowed: true, reason: null }, 'worker'],
    ['the request from the parent', { type: 'WRITE_RECHECK_REQUEST' }, 'parent'],
    ['a NOT_SENT report without a block reason', { type: 'WRITE_SUBMISSION', submission: 'NOT_SENT', blockReason: null }, 'worker'],
    ['a SENT report with a block reason', { type: 'WRITE_SUBMISSION', submission: 'SENT', blockReason: 'PRECHECK_FAILED' }, 'worker'],
    ['an unknown submission state', { type: 'WRITE_SUBMISSION', submission: 'MAYBE', blockReason: null }, 'worker'],
    ['a submission report with values', { type: 'WRITE_SUBMISSION', submission: 'SENT', blockReason: null, values: { name: 'x' } }, 'worker'],
  ])('rejects %s', (_label, message, direction) => {
    const value = { protocol: WORKER_PROTOCOL_VERSION, ...(message as object) };
    expect(direction === 'parent' ? errorsOf(value) : workerErrorsOf(value)).not.toEqual([]);
  });
});

// T31f（Task 31 の設計書 4 章の「IPC」）: 更新の書き込みのジョブ（`WRITE_UPDATE`）の `START`。書き込みの指定は CREATE と同じ形に、UPDATE の指定
// （`update`: 対象の ID、型にした識別の digest、変える欄・保つ欄の名前）を足す。画面の path と送信先の path は、親が型に対象の ID を入れた具体的な
// path（ワーカーは型を扱わない）。送る値は変える欄の新しい値だけ。保つ欄の値と前の値は持たない（ワーカーが読む）。`WRITE_UPDATE` で必須、ほかでは
// 持てない。
describe('T31f: START of an update write job', () => {
  const updateWrite = (overrides: Record<string, unknown> = {}): Record<string, unknown> => sampleStartUpdateWrite(ORIGIN, overrides);
  const updateOf = (overrides: Record<string, unknown>): Record<string, unknown> =>
    ({ ...(updateWrite()['update'] as Record<string, unknown>), ...overrides });
  const withUpdate = (overrides: Record<string, unknown>): Record<string, unknown> => start('WRITE_UPDATE', { write: updateWrite(overrides) });

  it('accepts WRITE_UPDATE with the authentication and the update write specification', () => {
    expect(errorsOf(withUpdate({}))).toEqual([]);
    expect(errorsOf(withUpdate({ update: updateOf({ keptFieldNames: [] }) }))).toEqual([]);
  });

  it('requires the authentication, the write specification and its update block for WRITE_UPDATE, and allows the block for no other kind', () => {
    expect(errorsOf(start('WRITE_UPDATE'))).not.toEqual([]);
    expect(errorsOf(start('WRITE_UPDATE', { write: updateWrite() }, false))).not.toEqual([]);
    expect(errorsOf(start('WRITE_UPDATE', { write: write() }))).not.toEqual([]);
    expect(errorsOf(start(WORKER_WRITE_CREATE_JOB_KIND, { write: updateWrite() }))).not.toEqual([]);
    for (const jobKind of ['AUDIT', 'DISCOVERY', 'LOGIN_CHECK'] as const) {
      expect(errorsOf(start(jobKind, { write: updateWrite() })), jobKind).not.toEqual([]);
    }
  });

  it('has only the target, the templated digest and the field roles in the update block (no value of a kept field, no prior value)', () => {
    const startWrite = (SCHEMA.$defs as Record<string, Record<string, unknown>>)['startWrite'] ?? {};
    const update = ((startWrite['properties'] as Record<string, unknown>)['update'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(update['properties'] as object).sort()).toEqual(['changedFieldNames', 'keptFieldNames', 'targetRecordId', 'templatedIdentityDigest']);
    expect(update['additionalProperties']).toBe(false);
    expect(propertyNamesWithWords(startWrite, ['previous', 'prior', 'before', 'keptvalue', 'currentvalue'])).toEqual([]);
  });

  it.each<readonly [string, Record<string, unknown>]>([
    ['a target that is not a record id', { update: updateOf({ targetRecordId: '4/2' }) }],
    ['an empty target', { update: updateOf({ targetRecordId: '' }) }],
    ['a too long target', { update: updateOf({ targetRecordId: 'a'.repeat(65) }) }],
    ['a bad templated digest', { update: updateOf({ templatedIdentityDigest: 'sha256:x' }) }],
    ['no changed field', { update: updateOf({ changedFieldNames: [] }), values: {} }],
    ['a changed field without a value', { update: updateOf({ changedFieldNames: ['email', 'name', 'newsletter'] }), values: { name: 'x', email: 'y' } }],
    ['a value of a field that is not changed', { update: updateOf({ changedFieldNames: ['name'] }) }],
    ['a value of a kept field', { values: { name: 'x', email: 'y', newsletter: 'on' } }],
    ['a changed field whose new value is not sent', { values: { name: 'x', email: null } }],
    ['a kept field that is also changed', { update: updateOf({ keptFieldNames: ['name'] }) }],
    ['a kept field that the candidate does not have', { update: updateOf({ keptFieldNames: ['other'] }) }],
    ['the method override field as a kept field', { update: updateOf({ keptFieldNames: ['_method'] }) }],
    ['a changed field twice', { update: updateOf({ changedFieldNames: ['email', 'name', 'name'] }) }],
    ['a form page path that is still a template', { formPage: { origin: ORIGIN, path: '/members/{id}/edit' } }],
    ['a request path that is still a template', { request: { ...(updateWrite().request as object), path: '/members/{id}' } }],
    ['a form page path without the target', { formPage: { origin: ORIGIN, path: '/members/43/edit' } }],
    ['a request path without the target', { request: { ...(updateWrite().request as object), path: '/members/43' } }],
    ['the values of the kept fields', { update: updateOf({ keptValues: { newsletter: 'on' } }) }],
    ['the prior values', { update: updateOf({ previousValues: { name: 'x' } }) }],
    ['the prior values beside the update block', { previousValues: { name: 'x' } }],
    ['the path templates', { update: updateOf({ formPathTemplate: '/members/{id}/edit' }) }],
  ])('rejects an update write specification with %s', (_label, overrides) => {
    expect(errorsOf(withUpdate(overrides))).not.toEqual([]);
  });

  it('writes no target and no field name into the errors', () => {
    const errors = errorsOf(withUpdate({ formPage: { origin: ORIGIN, path: '/members/43/edit' }, update: updateOf({ keptFieldNames: ['name'] }) }));
    expect(errors).not.toEqual([]);
    expect(errors.join(' ')).not.toContain(SAMPLE_UPDATE_TARGET_RECORD_ID);
    expect(errors.join(' ')).not.toContain('newsletter');
  });
});

// T32d（Task 32 の設計書 4.1 の「承認の要約の受け渡し」）: 書き込みの指定の承認の要約（`write.approvalFacts`）。親が実行の許可を消費した後に、開始の
// 時点の事実を入れる（ワーカーは照らさずに成果物 `approval-summary.json` に書き写す）。形は成果物のスキーマの事実の形（`approval-summary` の
// `$defs/facts`）を `$ref` で使う（書き写さない）。書き込みの指定のシナリオ・版・許可・プロファイル・種類と食い違う事実は拒む（fail-closed）。
describe('T32d: the approval facts of the write specification', () => {
  const factsOf = (overrides: Record<string, unknown>): Record<string, unknown> =>
    ({ ...(write()['approvalFacts'] as Record<string, unknown>), ...overrides });

  it('shares the shape of the approval facts with the approval-summary artifact schema by $ref', () => {
    const startWrite = (SCHEMA.$defs as Record<string, Record<string, unknown>>)['startWrite'] ?? {};
    const properties = startWrite['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['approvalFacts']).toEqual({ $ref: 'urn:beaksight:schema:approval-summary:1.0#/$defs/facts' });
    expect(startWrite['required']).toContain('approvalFacts');
  });

  it('accepts the approval facts of a CREATE and of an UPDATE', () => {
    expect(errorsOf(withWrite({}))).toEqual([]);
    expect(errorsOf(start('WRITE_UPDATE', { write: sampleStartUpdateWrite(ORIGIN) }))).toEqual([]);
  });

  it.each<readonly [string, Record<string, unknown>]>([
    ['no approval facts', { approvalFacts: undefined }],
    ['approval facts with an unknown property', { approvalFacts: factsOf({ note: 'x' }) }],
    ['approval facts with a password', { approvalFacts: factsOf({ password: 'x' }) }],
    ['approval facts with the document items of the worker', { approvalFacts: factsOf({ jobId: 'job-write' }) }],
    ['approval facts with an approver other than the local operator', { approvalFacts: factsOf({
      approval: { ...((write()['approvalFacts'] as Record<string, unknown>)['approval'] as object), approver: 'someone' } }) }],
    ['approval facts with a cumulative count above the default limit', { approvalFacts: factsOf({ cumulativeAtStart: { used: 21, limit: 20 } }) }],
    ['approval facts with a reservation of two writes', { approvalFacts: factsOf({ reservationAtStart: { count: 2, reservedAt: '20261015000000' } }) }],
    ['approval facts with a bad consumption time', { approvalFacts: factsOf({
      grantAtStart: { ...((write()['approvalFacts'] as Record<string, unknown>)['grantAtStart'] as object), consumedAt: null } }) }],
    ['approval facts of another profile', { approvalFacts: factsOf({ profileId: 'profile-2' }) }],
    ['approval facts of another scenario', { approvalFacts: factsOf({ scenario: { scenarioId: 'scenario-2', revision: 3, kind: 'CREATE' } }) }],
    ['approval facts of another revision', { approvalFacts: factsOf({ scenario: { scenarioId: 'scenario-1', revision: 2, kind: 'CREATE' } }) }],
    ['approval facts of another grant', { approvalFacts: factsOf({
      grantAtStart: { ...((write()['approvalFacts'] as Record<string, unknown>)['grantAtStart'] as object), grantId: 'grant-2' } }) }],
    ['approval facts of an UPDATE for a CREATE write', { approvalFacts: (sampleStartUpdateWrite(ORIGIN)['approvalFacts'] as Record<string, unknown>) }],
  ])('rejects a write specification with %s', (_label, overrides) => {
    expect(errorsOf(withWrite(overrides))).not.toEqual([]);
  });

  it('rejects the approval facts of a CREATE for an UPDATE write', () => {
    expect(errorsOf(start('WRITE_UPDATE', { write: sampleStartUpdateWrite(ORIGIN, { approvalFacts: write()['approvalFacts'] }) }))).not.toEqual([]);
  });
});

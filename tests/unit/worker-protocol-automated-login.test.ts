// T26d-2（Task 26 の設計書 3 章、4.4、4.5、4.7）: 自動ログインの IPC の契約（`src/control/worker-protocol.ts`、
// `schemas/control/worker-message.schema.json`）。
// - `START` の、ジョブの種類（`AUDIT`・`LOGIN_CHECK`）と、自動ログインのときだけの `automatedLogin: { credentialRevision, credentialRoot }`。
//   資格情報の値・暗号文・ユーザー名の項目は、スキーマで拒む（`additionalProperties: false`）。SHA-256 に、ジョブの種類と `automatedLogin` を含める。
// - `AUTH_STATE` の自動ログインの結果（閉じた一覧の結果、送信、`Retry-After` の期限、フォームの確かめの理由のコード）。値・誤りの文・URL を持てない。
// - 値の一覧（ジョブの種類、結果、送信、理由のコード、失敗の理由）が、スキーマと、ほかの owner の一覧と一致する。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。秘密（ユーザー名、パスワード）は契約に現れない。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOGIN_FORM_INVALID_REASONS } from '../../src/browser/login-form-submitter.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  AUTOMATED_LOGIN_FAILURE_RESULTS,
  AUTOMATED_LOGIN_RESULTS,
  AUTOMATED_LOGIN_SUBMISSIONS,
} from '../../src/control/auth/automated-login-results.js';
import { AUDIT_JOB_KINDS } from '../../src/control/job/job-records.js';
import {
  MAX_WORKER_MESSAGE_PATH_LENGTH,
  WORKER_AUTOMATED_LOGIN_FAILED_STATE,
  WORKER_FAILURE_REASONS,
  WORKER_JOB_KINDS,
  WORKER_LOGIN_FAILURE_STATES,
  WORKER_LOGIN_FORM_INVALID_REASONS,
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerAuthenticationBinding,
  type WorkerStartAutomatedLogin,
} from '../../src/control/worker-protocol.js';

const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as Record<string, unknown>;

const pointerValue = (document: unknown, pointer: string): unknown =>
  pointer.split('/').slice(1).reduce<unknown>((value, key) =>
    (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), document);

const ORIGIN = 'http://127.0.0.1:4173';
const SHA256 = targetConfigDigestOf(new TextEncoder().encode('{}'));
/** 資格情報のフォルダを決める根（絶対パス。Windows と POSIX のどちらでも絶対になる形）。 */
const CREDENTIAL_ROOT = resolve(process.cwd(), 'example-root');
const RETRY_AFTER_UNTIL = '20261010120000';

const MANUAL_SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-auto',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const AUTOMATED_SETUP: AuthSetup = Object.freeze({
  ...MANUAL_SETUP,
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  automatedLogin: {
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: '#login-submit',
    failureConditions: {
      invalidCredentials: { pathPrefix: '/login', selector: '.login-error' },
      accountLocked: null,
      mfaRequired: null,
      credentialExpired: null,
    },
  },
});

const AUTOMATED_LOGIN: WorkerStartAutomatedLogin = Object.freeze({ credentialRevision: 3, credentialRoot: CREDENTIAL_ROOT });

const authenticationOf = (
  setup: AuthSetup,
  binding: WorkerAuthenticationBinding,
): Record<string, unknown> => ({
  setup,
  approvedTestOrigins: [ORIGIN],
  authenticationSha256: workerAuthenticationDigestOf(setup, [ORIGIN], binding),
  ...(binding.automatedLogin === null ? {} : { automatedLogin: binding.automatedLogin }),
});

const startOf = (jobKind: string, authentication: unknown): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-0001',
  jobKind,
  targetConfigPath: 'local/targets/example-test.json',
  startNew: false,
  targetConfigSha256: SHA256,
  ...(authentication === undefined ? {} : { authentication }),
});

const automatedStart = (jobKind: 'AUDIT' | 'LOGIN_CHECK', automatedLogin: unknown = AUTOMATED_LOGIN): Record<string, unknown> => ({
  ...startOf(jobKind, {
    ...authenticationOf(AUTOMATED_SETUP, { jobKind, automatedLogin: AUTOMATED_LOGIN }),
    automatedLogin,
  }),
});

const report = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  result: 'SUCCEEDED',
  submitted: 'YES',
  retryAfterUntil: null,
  formInvalidReason: null,
  ...overrides,
});

const authState = (state: string, automatedLogin?: unknown): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'AUTH_STATE',
  state,
  sessionLostUrl: null,
  ...(automatedLogin === undefined ? {} : { automatedLogin }),
});

describe('worker protocol (T26d-2): START of the automated login', () => {
  it.each(['AUDIT', 'LOGIN_CHECK'] as const)('accepts an automated %s START with the credential revision and the credential root', (jobKind) => {
    const message = automatedStart(jobKind);
    const result = validateParentToWorkerMessage(message);
    expect(result).toEqual({ ok: true, message });
    if (result.ok && result.message.type === 'START') {
      expect(Object.isFrozen(result.message.authentication?.automatedLogin)).toBe(true);
    }
  });

  it('accepts the manual and the public START with the job kind AUDIT (no automatedLogin)', () => {
    expect(validateParentToWorkerMessage(startOf('AUDIT', authenticationOf(MANUAL_SETUP, { jobKind: 'AUDIT', automatedLogin: null }))).ok).toBe(true);
    expect(validateParentToWorkerMessage(startOf('AUDIT', undefined)).ok).toBe(true);
  });

  it.each([
    ['no job kind', (() => {
      const message = automatedStart('AUDIT');
      delete message['jobKind'];
      return message;
    })()],
    ['an unknown job kind', { ...automatedStart('AUDIT'), jobKind: 'LOGIN' }],
    ['a LOGIN_CHECK without authentication (public)', startOf('LOGIN_CHECK', undefined)],
    ['a LOGIN_CHECK of the manual login', startOf('LOGIN_CHECK', authenticationOf(MANUAL_SETUP, { jobKind: 'LOGIN_CHECK', automatedLogin: null }))],
    ['an automated setup without automatedLogin', startOf('AUDIT', authenticationOf(AUTOMATED_SETUP, { jobKind: 'AUDIT', automatedLogin: null }))],
    ['a manual setup with automatedLogin', startOf('AUDIT', authenticationOf(MANUAL_SETUP, { jobKind: 'AUDIT', automatedLogin: AUTOMATED_LOGIN }))],
    ['a credential revision of 0', automatedStart('LOGIN_CHECK', { ...AUTOMATED_LOGIN, credentialRevision: 0 })],
    ['a credential revision that is not an integer', automatedStart('LOGIN_CHECK', { ...AUTOMATED_LOGIN, credentialRevision: 1.5 })],
    ['a relative credential root', automatedStart('LOGIN_CHECK', { ...AUTOMATED_LOGIN, credentialRoot: 'local/secrets' })],
    ['an empty credential root', automatedStart('LOGIN_CHECK', { ...AUTOMATED_LOGIN, credentialRoot: '' })],
    ['a credential root that is too long', automatedStart('LOGIN_CHECK', { ...AUTOMATED_LOGIN, credentialRoot: `${CREDENTIAL_ROOT}${'a'.repeat(MAX_WORKER_MESSAGE_PATH_LENGTH)}` })],
    ['a credential root with a line break', automatedStart('LOGIN_CHECK', { ...AUTOMATED_LOGIN, credentialRoot: `${CREDENTIAL_ROOT}\nx` })],
    // 値・暗号文・ユーザー名を足す項目は、スキーマで拒む。
    ['a password', automatedStart('LOGIN_CHECK', { ...AUTOMATED_LOGIN, password: 'x' })],
    ['a username', automatedStart('LOGIN_CHECK', { ...AUTOMATED_LOGIN, username: 'x' })],
    ['a cipher text', automatedStart('LOGIN_CHECK', { ...AUTOMATED_LOGIN, cipherText: 'AQAAANCMnd8B' })],
    ['the credential next to the authentication', { ...automatedStart('LOGIN_CHECK'), credential: { username: 'x', password: 'y' } }],
    ['a password on the authentication', startOf('LOGIN_CHECK', {
      ...authenticationOf(AUTOMATED_SETUP, { jobKind: 'LOGIN_CHECK', automatedLogin: AUTOMATED_LOGIN }),
      password: 'x',
    })],
  ] as const)('rejects a START with %s', (_name, message) => {
    expect(validateParentToWorkerMessage(message).ok).toBe(false);
  });

  it('includes the job kind and automatedLogin in the digest', () => {
    const base: WorkerAuthenticationBinding = { jobKind: 'AUDIT', automatedLogin: AUTOMATED_LOGIN };
    const digest = workerAuthenticationDigestOf(AUTOMATED_SETUP, [ORIGIN], base);
    expect(workerAuthenticationDigestOf(AUTOMATED_SETUP, [ORIGIN], { ...base, jobKind: 'LOGIN_CHECK' })).not.toBe(digest);
    expect(workerAuthenticationDigestOf(AUTOMATED_SETUP, [ORIGIN], { ...base, automatedLogin: { ...AUTOMATED_LOGIN, credentialRevision: 4 } })).not.toBe(digest);
    expect(workerAuthenticationDigestOf(AUTOMATED_SETUP, [ORIGIN], { ...base, automatedLogin: { ...AUTOMATED_LOGIN, credentialRoot: `${CREDENTIAL_ROOT}2` } })).not.toBe(digest);
    expect(workerAuthenticationDigestOf(AUTOMATED_SETUP, [ORIGIN], { ...base, automatedLogin: null })).not.toBe(digest);
    // 鍵の順によらない。
    expect(workerAuthenticationDigestOf(AUTOMATED_SETUP, [ORIGIN], { automatedLogin: { credentialRoot: CREDENTIAL_ROOT, credentialRevision: 3 }, jobKind: 'AUDIT' })).toBe(digest);
  });

  it('has the job kinds and the automatedLogin shape of the schema (no other property)', () => {
    expect(pointerValue(SCHEMA, '/$defs/start/properties/jobKind/enum')).toEqual([...WORKER_JOB_KINDS]);
    expect(pointerValue(SCHEMA, '/$defs/start/required')).toContain('jobKind');
    expect(pointerValue(SCHEMA, '/$defs/startAutomatedLogin/additionalProperties')).toBe(false);
    expect(Object.keys(pointerValue(SCHEMA, '/$defs/startAutomatedLogin/properties') as object).sort()).toEqual(['credentialRevision', 'credentialRoot']);
    expect(pointerValue(SCHEMA, '/$defs/startAutomatedLogin/properties/credentialRoot/$ref')).toBe('#/$defs/path');
    // ジョブの種類の一覧は 1 か所（ジョブの記録の一覧は、契約の一覧そのもの）。
    expect(AUDIT_JOB_KINDS).toBe(WORKER_JOB_KINDS);
  });
});

describe('worker protocol (T26d-2): AUTH_STATE with the automated login result', () => {
  it.each([
    ['AUTHENTICATED (succeeded)', authState('AUTHENTICATED', report())],
    ['UNSUPPORTED_AUTH_STATE (the login succeeded)', authState('UNSUPPORTED_AUTH_STATE', report())],
    ['a failure that was sent', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'INVALID_CREDENTIALS' }))],
    ['a result that may have been sent', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN' }))],
    ['a failure before sending', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'CREDENTIAL_CHANGED', submitted: 'NO' }))],
    ['429 with the Retry-After deadline', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'RATE_LIMITED', retryAfterUntil: RETRY_AFTER_UNTIL }))],
    ['the form check with the reason code', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'LOGIN_FORM_INVALID', submitted: 'NO', formInvalidReason: 'METHOD_NOT_POST' }))],
    ['AUTHENTICATED of the manual login (no result)', authState('AUTHENTICATED')],
  ] as const)('accepts %s', (_name, message) => {
    expect(validateWorkerToParentMessage(message)).toEqual({ ok: true, message });
  });

  it.each([
    ['AUTOMATED_LOGIN_FAILED without a result', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE)],
    ['AUTOMATED_LOGIN_FAILED with SUCCEEDED', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report())],
    ['AUTHENTICATED with a failure', authState('AUTHENTICATED', report({ result: 'INVALID_CREDENTIALS' }))],
    ['a result with AWAITING_LOGIN', authState('AWAITING_LOGIN', report())],
    ['a result with LOGIN_TIMEOUT', authState('LOGIN_TIMEOUT', report({ result: 'AUTH_RESULT_UNKNOWN', submitted: 'NO' }))],
    ['SUCCEEDED that was not sent', authState('AUTHENTICATED', report({ submitted: 'UNKNOWN' }))],
    ['an unknown result', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'LOCKED' }))],
    ['STOPPED as a result', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'STOPPED', submitted: 'NO' }))],
    ['an unknown submission', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'INVALID_CREDENTIALS', submitted: 'MAYBE' }))],
    ['429 without the deadline', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'RATE_LIMITED' }))],
    ['a deadline on another result', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'INVALID_CREDENTIALS', retryAfterUntil: RETRY_AFTER_UNTIL }))],
    ['a deadline that is not 14 digits', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'RATE_LIMITED', retryAfterUntil: '2026-10-10T12:00:00Z' }))],
    ['the form check without the reason code', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'LOGIN_FORM_INVALID', submitted: 'NO' }))],
    ['a reason code on another result', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'INVALID_CREDENTIALS', formInvalidReason: 'METHOD_NOT_POST' }))],
    ['an unknown reason code', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'LOGIN_FORM_INVALID', submitted: 'NO', formInvalidReason: 'BAD' }))],
    // 値・誤りの文・URL を持てない。
    ['an error text', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'LOGIN_FORM_INPUT_FAILED', submitted: 'NO', error: 'fill failed: x' }))],
    ['a username', authState('AUTHENTICATED', report({ username: 'x' }))],
    ['a URL', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'INVALID_CREDENTIALS', url: `${ORIGIN}/login?u=x` }))],
    ['a session lost URL with a result', { ...authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'INVALID_CREDENTIALS' })), sessionLostUrl: `${ORIGIN}/login` }],
    ['a null result', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, null)],
  ] as const)('rejects AUTH_STATE with %s', (_name, message) => {
    expect(validateWorkerToParentMessage(message).ok).toBe(false);
  });

  it('has the value lists of the schema and of the other owners', () => {
    expect(pointerValue(SCHEMA, '/$defs/automatedLoginReport/additionalProperties')).toBe(false);
    expect(pointerValue(SCHEMA, '/$defs/automatedLoginReport/properties/result/enum')).toEqual([...AUTOMATED_LOGIN_RESULTS]);
    expect(pointerValue(SCHEMA, '/$defs/automatedLoginReport/properties/submitted/enum')).toEqual([...AUTOMATED_LOGIN_SUBMISSIONS]);
    expect(pointerValue(SCHEMA, '/$defs/automatedLoginReport/properties/formInvalidReason/anyOf/0/enum')).toEqual([...WORKER_LOGIN_FORM_INVALID_REASONS]);
    // フォームの確かめの理由のコードは、入力の部品（`src/browser/`。`src/control/` から読めない）の一覧の写し。
    expect([...WORKER_LOGIN_FORM_INVALID_REASONS]).toEqual([...LOGIN_FORM_INVALID_REASONS]);
    expect(Object.isFrozen(WORKER_LOGIN_FORM_INVALID_REASONS)).toBe(true);
    // 自動ログインの成功以外の結果は、ワーカーの `FAILED` の理由（ログインの段の終わり方の後ろ）。T27c: その後ろに、まだ対応していない種類の
    // START を拒む理由（`JOB_KIND_NOT_SUPPORTED`）を 1 つだけ足した。
    expect(WORKER_FAILURE_REASONS.slice(-(WORKER_LOGIN_FAILURE_STATES.length + AUTOMATED_LOGIN_FAILURE_RESULTS.length + 1)))
      .toEqual([...WORKER_LOGIN_FAILURE_STATES, ...AUTOMATED_LOGIN_FAILURE_RESULTS, 'JOB_KIND_NOT_SUPPORTED']);
    expect(pointerValue(SCHEMA, '/$defs/failed/properties/reason/enum')).toEqual([...WORKER_FAILURE_REASONS]);
  });
});

// DEF-099 fix round 1: 送った後に応答があったかの印（`responseAfterSubmission`。省略できる真偽。送信 `YES` のときだけ持てる。成功は応答のあった回
// だけなので `false` を持てない）。親は、`false` の回を試し 2 回と数える。
describe('worker protocol (DEF-099 fix round 1): the response after the submission', () => {
  it.each([
    ['an unanswered failure that was sent', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'AUTH_RESULT_UNKNOWN', responseAfterSubmission: false }))],
    ['an answered failure that was sent', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'AUTH_RESULT_UNKNOWN', responseAfterSubmission: true }))],
    ['a success with a response', authState('AUTHENTICATED', report({ responseAfterSubmission: true }))],
  ] as const)('accepts %s', (_name, message) => {
    expect(validateWorkerToParentMessage(message)).toEqual({ ok: true, message });
  });

  it.each([
    ['the mark on a result that was not sent', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'CREDENTIAL_CHANGED', submitted: 'NO', responseAfterSubmission: false }))],
    ['the mark on a result that may have been sent', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN', responseAfterSubmission: false }))],
    ['a success without a response', authState('AUTHENTICATED', report({ responseAfterSubmission: false }))],
    ['a mark that is not a boolean', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, report({ result: 'AUTH_RESULT_UNKNOWN', responseAfterSubmission: 'no' }))],
  ] as const)('rejects %s', (_name, message) => {
    expect(validateWorkerToParentMessage(message).ok).toBe(false);
  });

  it('has the mark in the schema as an optional boolean', () => {
    expect(pointerValue(SCHEMA, '/$defs/automatedLoginReport/properties/responseAfterSubmission')).toEqual({ type: 'boolean' });
    expect(pointerValue(SCHEMA, '/$defs/automatedLoginReport/required')).not.toContain('responseAfterSubmission');
  });
});

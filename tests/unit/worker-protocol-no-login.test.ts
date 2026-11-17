// NL-2（設計書 `2026-11-06-beaksight-no-login-test-site-design.md` 3.2 の 1）: ログインのないテスト用のサイトの `START` の `authentication`
// （`src/control/worker-protocol.ts`、`schemas/control/worker-message.schema.json`）。
// - `setup` が null の形（ログインなし）を受ける。`approvedTestOrigins` と SHA-256 は持ち、承認したサービスの Origin の規則も今のまま当てる。
// - `setup` が null のときは、ログインの規則（`loginStartUrl` の Origin など）を当てない。自動ログインの指定・ログインの直後の登録は持てない。
// - ほかの形（認証の設定のある形、`authentication` のない形）の検証は弱めない。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_PROTOCOL_VERSION,
  nextStageWriteStartOf,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  workerAuthenticationDigestOf,
  type WorkerStartMessage,
} from '../../src/control/worker-protocol.js';
import { sampleStartUpdateWrite, sampleStartWrite } from './worker-write-samples.js';

const ORIGIN = 'http://127.0.0.1:4173';
const OTHER_ORIGIN = 'http://localhost:4173';
const SERVICE_ORIGIN = 'http://127.0.0.1:5173';
const SHA256 = targetConfigDigestOf(new TextEncoder().encode('{}'));

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-no-login',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const READ_CHECKS = Object.freeze([{
  readCheckId: 'read-1',
  readCheckRevision: 3,
  targetPage: { origin: ORIGIN, path: '/members' },
  definition: { targetIdentityDigest: `sha256:${'c'.repeat(64)}`, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
}]);

/** ログインなしの `authentication`（`setup` が null）。 */
const noLoginAuthentication = (
  jobKind: string,
  approvedTestOrigins: readonly string[] = [ORIGIN],
  approvedServiceOrigins: readonly string[] = [],
): Record<string, unknown> => ({
  setup: null,
  approvedTestOrigins,
  ...(approvedServiceOrigins.length === 0 ? {} : { approvedServiceOrigins }),
  authenticationSha256: workerAuthenticationDigestOf(null, approvedTestOrigins, {
    jobKind: jobKind as 'AUDIT', automatedLogin: null, approvedServiceOrigins,
  }),
});

const startOf = (jobKind: string, authentication: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-0001',
  jobKind,
  targetConfigPath: 'local/targets/example-no-login.json',
  startNew: false,
  targetConfigSha256: SHA256,
  ...(authentication === undefined ? {} : { authentication }),
  ...extra,
});

const errorsOf = (value: unknown): readonly string[] => {
  const result = validateParentToWorkerMessage(value);
  return result.ok ? [] : result.errors;
};

describe('NL-2: the START without a login (setup is null)', () => {
  it.each([
    ['AUDIT', {}],
    ['DISCOVERY', {}],
    ['READ_CHECK', { readChecks: READ_CHECKS }],
    ['WRITE_CREATE', { write: sampleStartWrite(ORIGIN) }],
    ['WRITE_UPDATE', { write: sampleStartUpdateWrite(ORIGIN) }],
    ['AUDIT', { chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], writeStages: true, writeScreenCount: 1 } }],
  ] as const)('accepts a %s START whose authentication has no setup', (jobKind, extra) => {
    const message = startOf(jobKind, noLoginAuthentication(jobKind), extra);
    expect(validateParentToWorkerMessage(message)).toEqual({ ok: true, message });
  });

  it('accepts the service origins of the profile as they are, and still checks their rules', () => {
    expect(errorsOf(startOf('AUDIT', noLoginAuthentication('AUDIT', [ORIGIN], [SERVICE_ORIGIN])))).toEqual([]);
    expect(errorsOf(startOf('AUDIT', noLoginAuthentication('AUDIT', [ORIGIN], [`${SERVICE_ORIGIN}/`]))))
      .toContain('/authentication/approvedServiceOrigins/0 must be the canonical serialization of an http(s) origin');
    expect(errorsOf(startOf('AUDIT', noLoginAuthentication('AUDIT', [ORIGIN], [ORIGIN]))))
      .toContain('/authentication/approvedServiceOrigins/0 must not be in approvedTestOrigins');
  });

  it.each([
    ['no approved test origins', { ...noLoginAuthentication('AUDIT'), approvedTestOrigins: [] }],
    ['an approved test origin that is not canonical', noLoginAuthentication('AUDIT', [`${ORIGIN}/`])],
    ['an approved test origin that is not http(s)', noLoginAuthentication('AUDIT', ['ftp://127.0.0.1'])],
    ['no digest', (({ authenticationSha256: _omitted, ...rest }) => rest)(noLoginAuthentication('AUDIT'))],
    ['a digest in upper case', { ...noLoginAuthentication('AUDIT'), authenticationSha256: SHA256.toUpperCase() }],
    ['no setup property', (({ setup: _omitted, ...rest }) => rest)(noLoginAuthentication('AUDIT'))],
    ['an extra property (a cookie)', { ...noLoginAuthentication('AUDIT'), cookies: [] }],
    ['the automated login', { ...noLoginAuthentication('AUDIT'), automatedLogin: { credentialRevision: 1, credentialRoot: resolve(process.cwd(), 'example-root') } }],
  ] as const)('rejects a START without a login with %s', (_name, authentication) => {
    expect(validateParentToWorkerMessage(startOf('AUDIT', authentication)).ok).toBe(false);
  });

  // NL fix round 1（設計書 6.1 の 2。SREV-NL の M-1）: 多重の守り。ログインなしの START は、許可 Origin とサービスの Origin がすべて loopback のときだけ受ける。
  it('rejects a START without a login whose approved test origins or service origins are not all loopback', () => {
    const rule = '/authentication must have only loopback origins without a login setup';
    expect(errorsOf(startOf('AUDIT', noLoginAuthentication('AUDIT', ['https://app.example.invalid'])))).toContain(rule);
    expect(errorsOf(startOf('AUDIT', noLoginAuthentication('AUDIT', [ORIGIN, 'https://app.example.invalid'])))).toContain(rule);
    expect(errorsOf(startOf('AUDIT', noLoginAuthentication('AUDIT', ['http://127.0.0.2:4173'])))).toContain(rule);
    expect(errorsOf(startOf('AUDIT', noLoginAuthentication('AUDIT', [ORIGIN], ['https://api.example.invalid'])))).toContain(rule);
    expect(errorsOf(startOf('WRITE_CREATE', noLoginAuthentication('WRITE_CREATE', ['https://app.example.invalid']), {
      write: sampleStartWrite('https://app.example.invalid'),
    }))).toContain(rule);
    // loopback だけなら受ける（localhost・[::1] を含む）。
    expect(errorsOf(startOf('AUDIT', noLoginAuthentication('AUDIT', [ORIGIN, OTHER_ORIGIN, 'http://[::1]:4173'], [SERVICE_ORIGIN])))).toEqual([]);
    // 認証の設定がある START は、今どおり loopback でない Origin を受ける。
    const setup = { ...SETUP, loginStartUrl: 'https://app.example.invalid/login', loginPostEndpoints: [{ origin: 'https://app.example.invalid', path: '/login' }] };
    expect(errorsOf(startOf('AUDIT', {
      setup,
      approvedTestOrigins: ['https://app.example.invalid'],
      authenticationSha256: workerAuthenticationDigestOf(setup, ['https://app.example.invalid'], { jobKind: 'AUDIT', automatedLogin: null }),
    }))).toEqual([]);
  });

  it('rejects the registration right after the login and the login check, which need a login', () => {
    const chain = { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'] };
    expect(errorsOf(startOf('AUDIT', { ...noLoginAuthentication('AUDIT'), loginRegistration: { credentialRoot: null } }, { chain })))
      .toContain('/authentication/loginRegistration is allowed only with a login setup');
    expect(errorsOf(startOf('LOGIN_CHECK', noLoginAuthentication('LOGIN_CHECK'))))
      .toContain('/authentication/automatedLogin is required for LOGIN_CHECK');
    // 入口の確かめは、今どおり認証の指定を持てない。
    expect(errorsOf(startOf('ENTRY_CHECK', noLoginAuthentication('ENTRY_CHECK'))))
      .toContain('/authentication is not allowed for ENTRY_CHECK');
  });

  it('keeps the checks of the START with a login setup and of the START without authentication', () => {
    const withSetup = (setup: AuthSetup): Record<string, unknown> => ({
      setup,
      approvedTestOrigins: [ORIGIN],
      authenticationSha256: workerAuthenticationDigestOf(setup, [ORIGIN], { jobKind: 'AUDIT', automatedLogin: null }),
    });
    expect(errorsOf(startOf('AUDIT', withSetup(SETUP)))).toEqual([]);
    expect(errorsOf(startOf('AUDIT', withSetup({ ...SETUP, loginStartUrl: `${OTHER_ORIGIN}/login` }))))
      .toContain('/authentication/setup/loginStartUrl must be on an origin in approvedTestOrigins');
    // 発見・READ の確かめ・書き込みは、今どおり `authentication` を必ず持つ。
    expect(errorsOf(startOf('DISCOVERY', undefined))).toContain('/authentication is required for DISCOVERY');
    expect(errorsOf(startOf('WRITE_CREATE', undefined, { write: sampleStartWrite(ORIGIN) }))).toContain('/authentication is required for WRITE_CREATE');
  });

  it('computes a digest of a START without a login that differs from the digests with a setup and depends on the kind and the origins', () => {
    const binding = { jobKind: 'AUDIT', automatedLogin: null } as const;
    const digest = workerAuthenticationDigestOf(null, [ORIGIN], binding);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).toBe(workerAuthenticationDigestOf(null, [ORIGIN], binding));
    expect(digest).not.toBe(workerAuthenticationDigestOf(SETUP, [ORIGIN], binding));
    expect(digest).not.toBe(workerAuthenticationDigestOf(null, [ORIGIN], { ...binding, jobKind: 'DISCOVERY' }));
    expect(digest).not.toBe(workerAuthenticationDigestOf(null, [ORIGIN, OTHER_ORIGIN], binding));
  });

  it('makes the START of a write stage of the chained run without a login that passes the checks of START', () => {
    const start = startOf('AUDIT', noLoginAuthentication('AUDIT'), {
      chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], writeStages: true, writeScreenCount: 1 },
    }) as unknown as WorkerStartMessage;
    const writeStart = nextStageWriteStartOf(start, {
      protocol: WORKER_PROTOCOL_VERSION, type: 'NEXT_STAGE', jobId: 'job-write', jobKind: 'WRITE_CREATE', write: sampleStartWrite(ORIGIN),
    } as never);
    expect(writeStart?.authentication?.setup).toBeNull();
    expect(validateParentToWorkerMessage(writeStart).ok).toBe(true);
  });
});

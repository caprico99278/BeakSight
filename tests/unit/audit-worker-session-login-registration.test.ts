// OP-1（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3）: ワーカーの、ログインの直後の登録の往復を、偽の IPC の口と偽のログインの段で確かめる。
// - `START` の `loginRegistration` があるときだけ、手動のログインの成功の後に親の返事を待つ。受け取りの根があるときだけ、ログインの段に受け取りを頼む。
// - 成功の知らせに、値のない受け取りのメタデータ（`credentialCapture`）を載せる。
// - 親の `CREDENTIAL_SAVE_ALLOWED` を受けたときだけ、受け取った値を保存の口で書き、`CREDENTIAL_SAVED`（改訂だけ）を送る。
// - `LOGIN_REGISTERED` の新しい設定を、SHA-256 を求め直して確かめてから、点検の段に使う。違えば `FAILED`（`AUTH_SETUP_CHANGED`）。
// - `LOGIN_REGISTRATION_SKIPPED` と待つ上限では、今の設定のまま点検を続ける（値は書かない）。
// - ログインを待つ知らせに、BeakSight がログインの終わりを判定できるかの印（`loginEndDetection`）を載せる。
// - 値（ユーザー名・パスワード）は、IPC のどのメッセージにも出ない。
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRunDependencies, AuditRunOutcome } from '../../src/cli/audit-run.js';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  workerAuthenticationDigestOf,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import type { RunId } from '../../src/core/contracts.js';
import type { RunSummaryView } from '../../src/report/view-model.js';
import { startAuditWorker, type AuditWorker, type WorkerChannel, type WorkerCredentialSaveRequest } from '../../src/worker/audit-worker-session.js';
import type { LoginStageRequest, LoginStageResult } from '../../src/worker/authenticated-login.js';
import { CapturedLoginCredential } from '../../src/worker/login-credential-capture.js';
import { createTestConfig } from '../helpers/test-config.js';
import { CredentialStoreError } from '../../src/control/credentials/credential-store.js';
import { CredentialProtectionError } from '../../src/control/credentials/dpapi-protector.js';

const ORIGIN = 'http://127.0.0.1:4173';
const ROOT = process.platform === 'win32' ? 'C:\\example\\credentials' : '/example/credentials';
const TARGET_CONFIG_PATH = 'local/targets/example-reg.json';
const TARGET_CONFIG_BYTES = new TextEncoder().encode('{"target":{"id":"example-reg"}}');
const OUTPUT_DIRECTORY = resolve('worker-session-registration-output');
const AUDIT_RUN = 'RUN-20261027010000' as RunId;
/** 人が入れた値の目印（IPC に出ないことを確かめる）。 */
const USERNAME = 'reg-user-marker-1';
const PASSWORD = 'reg-pass-marker-2';

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-reg',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '', selector: null },
  sessionLostCondition: { pathPrefix: '/login' },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});
/** 親が登録で作る新しい設定（成功の画面の path を観察から埋め、自動ログインへ切り替えたもの）。 */
const REGISTERED_SETUP: AuthSetup = Object.freeze({
  ...SETUP,
  profileRevision: 2,
  successCondition: { pathPrefix: '/admin', selector: null },
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 1,
  automatedLogin: {
    usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#go',
    failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
});
const REGISTERED_DIGEST = workerAuthenticationDigestOf(REGISTERED_SETUP, [ORIGIN], { jobKind: 'AUDIT', automatedLogin: null, approvedServiceOrigins: [] });

const start = (loginRegistration: { readonly credentialRoot: string | null } | undefined): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-audit',
  jobKind: 'AUDIT',
  targetConfigPath: TARGET_CONFIG_PATH,
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(TARGET_CONFIG_BYTES),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: 'AUDIT', automatedLogin: null }),
    ...(loginRegistration === undefined ? {} : { loginRegistration }),
  },
  chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'] },
});

const STATE = Object.freeze({
  cookies: [{ name: 'sid', value: 'state-marker', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' as const }],
  origins: [],
});

const auditOutcome: AuditRunOutcome = {
  kind: 'RAN',
  runId: AUDIT_RUN,
  runDirectory: resolve(OUTPUT_DIRECTORY, AUDIT_RUN),
  runStatus: 'COMPLETE',
  exitCode: EXIT_CODES.COMPLETE,
  resumeDecision: { kind: 'NEW_RUN' },
  notices: [],
  summary: { incompleteReasons: [] } as unknown as RunSummaryView,
  checkpointWarnings: [],
};

const message = (type: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ protocol: WORKER_PROTOCOL_VERSION, type, ...fields });
const ALLOW = message('CREDENTIAL_SAVE_ALLOWED', { loginOrigin: ORIGIN });
const REGISTERED = message('LOGIN_REGISTERED', { setup: REGISTERED_SETUP, approvedServiceOrigins: [], authenticationSha256: REGISTERED_DIGEST });
const SKIPPED = message('LOGIN_REGISTRATION_SKIPPED');

/** 親の振る舞い（ワーカーの知らせに返すメッセージ。`null` は返さない）。 */
type ParentReply = (sent: WorkerToParentMessage) => Record<string, unknown> | null;

interface Run {
  readonly sent: readonly WorkerToParentMessage[];
  readonly exitCode: number;
  readonly loginRequests: readonly LoginStageRequest[];
  readonly saves: readonly WorkerCredentialSaveRequest[];
  readonly auditDependencies: readonly AuditRunDependencies[];
}

const workers: AuditWorker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
});

async function runWorker(options: {
  readonly loginRegistration: { readonly credentialRoot: string | null } | undefined;
  readonly reply: ParentReply;
  readonly captured?: boolean;
  readonly loginEndDetection?: boolean;
  readonly loginRegistrationTimeoutMs?: number;
  /** OP-L L2: 保存の口の振る舞い（省略は改訂 1 を返す。`'MISSING'` は口を渡さない）。 */
  readonly save?: ((request: WorkerCredentialSaveRequest) => Promise<number | null>) | 'MISSING';
}): Promise<Run> {
  const { save } = options;
  const sent: WorkerToParentMessage[] = [];
  const listeners: ((value: unknown) => void)[] = [];
  const emit = (value: unknown): void => listeners.forEach((listener) => listener(value));
  const loginRequests: LoginStageRequest[] = [];
  const saves: WorkerCredentialSaveRequest[] = [];
  const auditDependencies: AuditRunDependencies[] = [];
  const channel: WorkerChannel = {
    send: (sentMessage) => {
      sent.push(sentMessage);
      // まとめて実行は、監査の段の後に止める（この確かめは監査の段まで）。
      const reply = sentMessage.type === 'FINISHED' ? message('CHAIN_END') : options.reply(sentMessage);
      if (reply !== null) {
        setImmediate(() => emit(reply));
      }
      return Promise.resolve(true);
    },
    onMessage: (listener) => {
      listeners.push(listener);
    },
    onDisconnect: () => undefined,
  };
  const config = { ...createTestConfig(ORIGIN, '/admin'), output: { directory: OUTPUT_DIRECTORY } };
  const worker = startAuditWorker({
    channel,
    stderr: { write: () => Promise.resolve() },
    exit: () => undefined,
    loadConfig: () => Promise.resolve(config),
    readTargetConfig: () => Promise.resolve(TARGET_CONFIG_BYTES),
    executeAuditRun: async (_config, dependencies, _options, observer) => {
      auditDependencies.push(dependencies);
      observer.onRunStarted?.({ runId: AUDIT_RUN, runDirectory: resolve(OUTPUT_DIRECTORY, AUDIT_RUN), resumeDecision: { kind: 'NEW_RUN' } });
      dependencies.stageCarry?.record({ latestState: STATE, serviceRequestWindowMs: [], navigation: { lastNavigationStartedAtMs: Date.now(), stageEndedAtMs: Date.now(), minIntervalMs: 0 } });
      return auditOutcome;
    },
    runDependencies: { launchBrowser: () => Promise.reject(new Error('not used')), clock: () => new Date(), now: () => Date.now() },
    runLoginStage: (request) => {
      loginRequests.push(request);
      request.onAwaitingLogin(options.loginEndDetection ?? false);
      const result: LoginStageResult = options.captured === true && request.captureCredential === true
        ? { kind: 'AUTHENTICATED', state: STATE, capturedCredential: new CapturedLoginCredential(USERNAME, PASSWORD, { origin: ORIGIN, path: '/login' }) }
        : { kind: 'AUTHENTICATED', state: STATE };
      return Promise.resolve(result);
    },
    // まとめて実行の段の流れ（この確かめは監査の段の後に止めるので、呼ばれない）。
    executeDiscovery: () => Promise.reject(new Error('not used')),
    executeReadCheck: () => Promise.reject(new Error('not used')),
    ...(save === 'MISSING' ? {} : {
      saveCapturedCredential: (request: WorkerCredentialSaveRequest) => {
        saves.push(request);
        return save === undefined ? Promise.resolve(1) : save(request);
      },
    }),
    startTimeoutMs: 2_000,
    heartbeatIntervalMs: 1_000,
    ...(options.loginRegistrationTimeoutMs === undefined ? {} : { loginRegistrationTimeoutMs: options.loginRegistrationTimeoutMs }),
  });
  workers.push(worker);
  emit(start(options.loginRegistration));
  const exitCode = await worker.exited;
  return { sent, exitCode, loginRequests, saves, auditDependencies };
}

/** 登録を進める親（成功の知らせに許し、保存の知らせに登録の結果）。 */
const registeringParent: ParentReply = (sent) => {
  if (sent.type === 'AUTH_STATE' && sent.state === 'AUTHENTICATED') {
    return sent.credentialCapture?.captured === true ? ALLOW : REGISTERED;
  }
  return sent.type === 'CREDENTIAL_SAVED' ? REGISTERED : null;
};

const authStates = (run: Run): readonly Extract<WorkerToParentMessage, { readonly type: 'AUTH_STATE' }>[] =>
  run.sent.filter((sent): sent is Extract<WorkerToParentMessage, { readonly type: 'AUTH_STATE' }> => sent.type === 'AUTH_STATE');

const expectNoValuesInIpc = (run: Run): void => {
  const text = JSON.stringify(run.sent);
  expect(text.includes(USERNAME)).toBe(false);
  expect(text.includes(PASSWORD)).toBe(false);
};

describe('audit worker session (OP-1): the registration right after the manual login', () => {
  it('asks the login stage to receive, writes the value only after the permission, and audits with the registered setup', async () => {
    const run = await runWorker({ loginRegistration: { credentialRoot: ROOT }, reply: registeringParent, captured: true });
    expect(run.loginRequests.map((request) => request.captureCredential)).toEqual([true]);
    const authenticated = authStates(run).find(({ state }) => state === 'AUTHENTICATED');
    expect(authenticated?.credentialCapture).toEqual({ captured: true, carriedBy: { origin: ORIGIN, path: '/login' } });
    expect(run.saves.map(({ credentialRoot, profileId, loginOrigin }) => ({ credentialRoot, profileId, loginOrigin })))
      .toEqual([{ credentialRoot: ROOT, profileId: SETUP.profileId, loginOrigin: ORIGIN }]);
    expect(run.sent.filter(({ type }) => type === 'CREDENTIAL_SAVED')).toEqual([
      { protocol: WORKER_PROTOCOL_VERSION, type: 'CREDENTIAL_SAVED', saved: true, credentialRevision: 1, failureCode: null },
    ]);
    // 点検の段は、登録の後の設定（読む範囲のパス）で行う。
    expect(run.auditDependencies[0]?.authentication?.auditExclusions.auditPathPrefixes).toEqual(['/admin']);
    expect(run.sent.some(({ type }) => type === 'FAILED')).toBe(false);
    expectNoValuesInIpc(run);
  });

  it.each([
    ['a store error code', () => Promise.reject(new CredentialStoreError('CREDENTIAL_STORAGE_UNSAFE')), 'CREDENTIAL_STORAGE_UNSAFE'],
    ['a protection error code', () => Promise.reject(new CredentialProtectionError('PROTECTION_FAILED')), 'PROTECTION_FAILED'],
    ['another error (its text is not used)', () => Promise.reject(new Error(`${USERNAME} ${PASSWORD}`)), 'CREDENTIAL_SAVE_FAILED'],
    ['no revision', () => Promise.resolve(null), 'CREDENTIAL_SAVE_FAILED'],
    ['no saver', 'MISSING', 'CREDENTIAL_SAVE_UNAVAILABLE'],
  ] as const)('OP-L L2: tells the closed failure code (no value) when it could not write: %s', async (_name, save, failureCode) => {
    const run = await runWorker({ loginRegistration: { credentialRoot: ROOT }, reply: registeringParent, captured: true, save });
    expect(run.sent.filter(({ type }) => type === 'CREDENTIAL_SAVED')).toEqual([
      { protocol: WORKER_PROTOCOL_VERSION, type: 'CREDENTIAL_SAVED', saved: false, credentialRevision: null, failureCode },
    ]);
    expectNoValuesInIpc(run);
  });

  it('does not receive when the parent does not allow it, and audits with the registered setup', async () => {
    const run = await runWorker({ loginRegistration: { credentialRoot: null }, reply: registeringParent, captured: true });
    expect(run.loginRequests.map((request) => request.captureCredential)).toEqual([false]);
    expect(authStates(run).find(({ state }) => state === 'AUTHENTICATED')?.credentialCapture).toEqual({ captured: false, carriedBy: null });
    expect(run.saves).toEqual([]);
    expect(run.auditDependencies[0]?.authentication?.auditExclusions.auditPathPrefixes).toEqual(['/admin']);
  });

  it('goes on with the current setup and writes nothing when the parent skips the registration', async () => {
    const run = await runWorker({
      loginRegistration: { credentialRoot: ROOT },
      reply: (sent) => (sent.type === 'AUTH_STATE' && sent.state === 'AUTHENTICATED' ? SKIPPED : null),
      captured: true,
    });
    expect(run.saves).toEqual([]);
    expect(run.sent.some(({ type }) => type === 'CREDENTIAL_SAVED')).toBe(false);
    expect(run.auditDependencies[0]?.authentication?.auditExclusions.auditPathPrefixes).toEqual([]);
    expectNoValuesInIpc(run);
  });

  it('goes on with the current setup when the parent does not answer within the limit', async () => {
    const run = await runWorker({ loginRegistration: { credentialRoot: ROOT }, reply: () => null, captured: true, loginRegistrationTimeoutMs: 200 });
    expect(run.saves).toEqual([]);
    expect(run.auditDependencies.length).toBe(1);
    expect(run.auditDependencies[0]?.authentication?.auditExclusions.auditPathPrefixes).toEqual([]);
  });

  it('fails without the audit when the registered setup does not match its SHA-256', async () => {
    const run = await runWorker({
      loginRegistration: { credentialRoot: null },
      reply: (sent) => (sent.type === 'AUTH_STATE' && sent.state === 'AUTHENTICATED'
        ? { ...REGISTERED, authenticationSha256: 'b'.repeat(64) }
        : null),
    });
    expect(run.auditDependencies).toEqual([]);
    expect(run.sent.find(({ type }) => type === 'FAILED')).toMatchObject({ reason: 'AUTH_SETUP_CHANGED' });
  });

  it('does not wait and does not receive without the login registration (the chained run as before)', async () => {
    const run = await runWorker({ loginRegistration: undefined, reply: () => null, captured: true });
    expect(run.loginRequests.map((request) => request.captureCredential === true)).toEqual([false]);
    expect(authStates(run).find(({ state }) => state === 'AUTHENTICATED')?.credentialCapture).toBeUndefined();
    expect(run.auditDependencies.length).toBe(1);
  });

  it('marks whether BeakSight detects the end of the login while awaiting it', async () => {
    const detected = await runWorker({ loginRegistration: undefined, reply: () => null, loginEndDetection: true });
    expect(authStates(detected).find(({ state }) => state === 'AWAITING_LOGIN')?.loginEndDetection).toBe(true);
    const notDetected = await runWorker({ loginRegistration: undefined, reply: () => null, loginEndDetection: false });
    expect(authStates(notDetected).find(({ state }) => state === 'AWAITING_LOGIN')?.loginEndDetection).toBe(false);
  });
});

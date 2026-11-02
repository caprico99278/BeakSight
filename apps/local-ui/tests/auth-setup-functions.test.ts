/**
 * 認証の設定の Server Functions と、認証つきの監査の開始の確かめを、ビルドした画面のサーバ（一時の root）に HTTP で直接送って確かめる
 * （Task 25 の設計書 4.1、4.5、4.6。T25e）。
 * - 入力の検証（`schemas/control/ui-profile-key`、`ui-auth-setup-save`）: 合わない入力は 400 で、保存しない。
 * - CSRF: cross-site の POST と、Origin の違う POST は 403 のままで、保存しない。
 * - 保存（`saveAuthSetup` で検証）、検証の誤りの項目ごとの値（コードと項目と行だけ。英語の詳細を返さない）、秘密の項目は受けない。
 * - `CURRENT`・`STALE`（プロファイルの改訂が変わった）と、開始の画面の要点（ログインの画面の URL、読む範囲、新しさ）と開始できない理由
 *   （`AUTH_SETUP_STALE`）。開始の拒否では、ジョブを作らない。
 * 管理データ、ターゲット設定は、一時の root の中だけ。fixture のサイトは 127.0.0.1 で、このテストでは要求を送らない（監査を始めない）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../../src/control/auth/auth-setup-contracts.js';
import { START_PATH, publicProfileDocument, startTimedSite, writeAuditTargetConfig, type TimedSite } from './helpers/audit-site.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';
import { callServerFunction, encodeServerFunctionPayload, readServerFunctionIds, type ServerFunctionCall } from './helpers/server-functions.ts';

/** HTTP の状態。 */
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403 });
/** テストの値（匿名）。 */
const AUTH_PROFILE = 't25e-auth';
const PUBLIC_PROFILE = 't25e-public';
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
/** 誤りの英語の詳細（`validateAuthSetup` の文）の一部。画面への応答に出ないこと。 */
const ENGLISH_DETAIL_FRAGMENTS = Object.freeze(['must start with', 'must not match', 'additional properties']);

let root: TemporaryUiRoot | undefined;
let site: TimedSite | undefined;
let server: StartedServer | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
let authConfig = '';

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};

const origin = (): string => site?.origin ?? '';

const call = (name: string, method: 'GET' | 'POST', data?: unknown): Promise<ServerFunctionCall> =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(STATUS.OK);
  return result.value as T;
};

/** 正しい認証の設定（改訂 `revision` に結びつく）。 */
const setupFor = (revision: number, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: AUTH_PROFILE,
  profileRevision: revision,
  loginStartUrl: `${origin()}/login`,
  loginPostEndpoints: [{ origin: origin(), path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
  ...overrides,
} satisfies Record<Exclude<keyof AuthSetup, 'auditReadRequests' | 'serviceRequestLimits'>, unknown>);

const authProfileDocument = (revision: number): Record<string, unknown> => ({
  ...publicProfileDocument(AUTH_PROFILE, authConfig),
  revision,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [origin()],
  environmentEvidenceRef: 't25e-evidence',
});

interface PageView {
  readonly profile: { readonly profileId: string; readonly revision: number };
  readonly eligible: boolean;
  readonly stored: { readonly freshness: string; readonly setup: Record<string, unknown>; readonly updatedAt: string } | null;
}

const getPage = (profileId: string): Promise<PageView | null> => valueOf<PageView | null>('getAuthSetupFn', 'GET', { profileId });
const listJobs = (): Promise<readonly unknown[]> => valueOf<readonly unknown[]>('listAuditJobsFn', 'GET');

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startTimedSite();
  authConfig = writeAuditTargetConfig(root.root, AUTH_PROFILE, site.origin, { minNavigationIntervalMs: 0, screenshots: false });
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  expect(await valueOf('createProfileFn', 'POST', { profile: authProfileDocument(FIRST_REVISION) })).toMatchObject({ ok: true });
  expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PUBLIC_PROFILE, authConfig) })).toMatchObject({ ok: true });
});

afterAll(async () => {
  await stopServer(server);
  await site?.close();
  root?.remove();
});

describe('auth setup Server Functions: registration, input validation and CSRF', () => {
  it('lists the auth setup Server Functions by name', () => {
    expect([...ids.keys()]).toEqual(expect.arrayContaining(['getAuthSetupFn', 'saveAuthSetupFn']));
  });

  it('returns the page values: the profile, whether it uses an auth setup, and no stored setup yet', async () => {
    expect(await getPage(AUTH_PROFILE)).toEqual({
      profile: {
        profileId: AUTH_PROFILE,
        revision: FIRST_REVISION,
        mode: 'TEST_AUTH_PASSIVE',
        auth: 'MANUAL_SESSION',
        status: 'ACTIVE',
        approvedTestOrigins: [origin()],
        // T34d で画面の値に足した項目（プロファイルに項目がなければ空。T34R2-fix で期待を直した）。
        approvedServiceOrigins: [],
      },
      eligible: true,
      stored: null,
      // T43b（Task 43 の設計書 4.2）で画面の値に足した項目: 新しい認証の設定の案に使う、対象の設定の開始の URL の path。
      startUrlPath: START_PATH,
    });
    expect(await getPage(PUBLIC_PROFILE)).toMatchObject({ eligible: false, stored: null });
    expect(await getPage('not-there')).toBeNull();
  });

  it('rejects inputs that do not match the schemas with 400, and saves nothing', async () => {
    const rejected: readonly [string, 'GET' | 'POST', unknown][] = [
      ['saveAuthSetupFn', 'POST', {}],
      ['saveAuthSetupFn', 'POST', { setup: 'text' }],
      ['saveAuthSetupFn', 'POST', { setup: [] }],
      ['saveAuthSetupFn', 'POST', { setup: setupFor(FIRST_REVISION), password: 'not-a-secret' }],
      ['getAuthSetupFn', 'GET', { profileId: 1 }],
      ['getAuthSetupFn', 'GET', { profileId: '../x' }],
    ];
    for (const [name, method, data] of rejected) {
      const result = await call(name, method, data);
      expect(result.response.status, `${name} ${JSON.stringify(data)}`).toBe(STATUS.BAD_REQUEST);
    }
    expect((await getPage(AUTH_PROFILE))?.stored).toBeNull();
  });

  it('keeps the CSRF protection: a cross-site or other-origin POST is 403, and saves nothing', async () => {
    const id = ids.get('saveAuthSetupFn') ?? '';
    const body = encodeServerFunctionPayload({ setup: setupFor(FIRST_REVISION) });
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: started().origin },
      { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1' },
      { origin: 'http://attacker.invalid' },
    ]) {
      const response = await rawRequest(started().port, `/_serverFn/${id}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', ...headers },
        body,
      });
      expect(response.status, JSON.stringify(headers)).toBe(STATUS.FORBIDDEN);
    }
    expect((await getPage(AUTH_PROFILE))?.stored).toBeNull();
  });
});

describe('auth setup Server Functions: save, errors by field, CURRENT and STALE, and the start screen', () => {
  it('returns the validation errors by field (code, field, line only), and saves nothing', async () => {
    const result = await call('saveAuthSetupFn', 'POST', {
      setup: setupFor(FIRST_REVISION, {
        successCondition: { pathPrefix: '/', selector: null },
        excludedPaths: ['/admin/logout', 'admin'],
      }),
    });
    expect(result.response.status).toBe(STATUS.OK);
    expect(result.value).toEqual({
      ok: false,
      reason: 'AUTH_SETUP_INVALID',
      errors: [
        { code: 'AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS', field: 'successPathPrefix', line: null },
        { code: 'AUTH_SETUP_PATH_INVALID', field: 'excludedPaths', line: 2 },
      ],
    });
    for (const fragment of ENGLISH_DETAIL_FRAGMENTS) {
      expect(result.response.body).not.toContain(fragment);
    }
    expect((await getPage(AUTH_PROFILE))?.stored).toBeNull();
  });

  it('does not accept a secret-like item in the setup (no password field), and saves nothing', async () => {
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...setupFor(FIRST_REVISION), password: 'not-a-secret' } })).toEqual({
      ok: false,
      reason: 'AUTH_SETUP_INVALID',
      errors: [{ code: 'AUTH_SETUP_SCHEMA_INVALID', field: null, line: null }],
    });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: setupFor(FIRST_REVISION, { loginStartUrl: `${origin()}/login?password=x` }) }))
      .toMatchObject({ ok: false, reason: 'AUTH_SETUP_INVALID', errors: [{ code: 'AUTH_SETUP_SECRET_LIKE_VALUE', field: 'loginStartUrl', line: null }] });
    expect((await getPage(AUTH_PROFILE))?.stored).toBeNull();
  });

  it('rejects a setup for a profile that does not use one, and for an unknown profile', async () => {
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...setupFor(FIRST_REVISION), profileId: PUBLIC_PROFILE } }))
      .toMatchObject({ ok: false, reason: 'AUTH_SETUP_INVALID', errors: expect.arrayContaining([{ code: 'AUTH_SETUP_MODE_UNSUPPORTED', field: null, line: null }]) });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...setupFor(FIRST_REVISION), profileId: 'not-there' } }))
      .toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND', errors: [] });
  });

  it('saves a valid setup as CURRENT, and the start screen shows the login summary without a blocker', async () => {
    // MI-F5（設計書 4.7.1 の 6）: 画面の最初の保存は、送信先（ログインの画面の URL のほかのフォームの送信先）が入口の確かめの案と同じときだけ受ける。この
    // プロファイルには入口の確かめがないので、フォームの送信先のある設定の最初の保存は拒む。送信先は入口の確かめと手動のログインの観察からだけ入るので、テストの
    // 準備では、観察の後の形の設定を保存の部品で直接保存し、画面の保存は、送信先を変えない保存し直しで確かめる。
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: setupFor(FIRST_REVISION) }))
      .toMatchObject({ ok: false, reason: 'CREDENTIAL_DESTINATION_OBSERVED_ONLY' });
    expect(await saveAuthSetupRequestInStore(root, { setup: setupFor(FIRST_REVISION) })).toMatchObject({ ok: true });
    const saved = await valueOf<{ ok: boolean; stored: { freshness: string; setup: unknown; updatedAt: string } }>(
      'saveAuthSetupFn',
      'POST',
      { setup: setupFor(FIRST_REVISION) },
    );
    expect(saved).toMatchObject({ ok: true, stored: { freshness: 'CURRENT', setup: setupFor(FIRST_REVISION) } });
    expect(saved.stored.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    expect((await getPage(AUTH_PROFILE))?.stored).toMatchObject({ freshness: 'CURRENT', setup: setupFor(FIRST_REVISION) });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: AUTH_PROFILE })).toMatchObject({
      mode: 'TEST_AUTH_PASSIVE',
      blocker: null,
      authRequired: true,
      authSetup: { loginStartUrl: `${origin()}/login`, auditPathPrefixes: ['/admin'], freshness: 'CURRENT' },
      authSetupErrors: [],
    });
  });

  it('shows STALE after the profile revision changes, and the start is rejected with AUTH_SETUP_STALE (no job)', async () => {
    expect(await valueOf('updateProfileFn', 'POST', { profile: authProfileDocument(SECOND_REVISION), expectedRevision: FIRST_REVISION }))
      .toMatchObject({ ok: true });
    expect((await getPage(AUTH_PROFILE))?.stored).toMatchObject({ freshness: 'STALE' });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: AUTH_PROFILE })).toMatchObject({
      revision: SECOND_REVISION,
      blocker: 'AUTH_SETUP_STALE',
      authSetup: { freshness: 'STALE' },
      authSetupErrors: [],
    });
    expect(await valueOf('startAuditJobFn', 'POST', { profileId: AUTH_PROFILE, expectedRevision: SECOND_REVISION, startNew: true }))
      .toEqual({ ok: false, reason: 'AUTH_SETUP_STALE', errorCodes: [], authSetupErrors: [] });
    // 古い改訂のまま保存し直すことはできない（改訂の違い）。今の改訂で保存し直すと CURRENT に戻る。
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: setupFor(FIRST_REVISION) })).toEqual({
      ok: false,
      reason: 'AUTH_SETUP_INVALID',
      errors: [{ code: 'AUTH_SETUP_PROFILE_REVISION_MISMATCH', field: null, line: null }],
    });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: setupFor(SECOND_REVISION) })).toMatchObject({ ok: true, stored: { freshness: 'CURRENT' } });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: AUTH_PROFILE })).toMatchObject({ blocker: null });
    expect(await listJobs()).toEqual([]);
  });

  // 保存の後に今の決まりで通らなくなった認証の設定（`AUTH_SETUP_INVALID`）は、画面の操作では作れず、このテストからは管理データを直接書き換え
  // られない（Gate (g)）。開始の画面の確かめは `audit-start-check.test.ts` で、ジョブの管理の拒否は
  // `tests/integration/control-audit-jobs-auth.test.ts` で確かめる。
  it('creates no job and sends nothing to the fixture site through these checks', async () => {
    expect(await listJobs()).toEqual([]);
    expect(site?.requests()).toEqual([]);
  });
});

// MI-F3（独立レビュー MI-R の Minor 5。設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 監査の開始の画面の「読まないパス」の保存は、
// サーバが今保存してある認証の設定を読み、読まないパスだけを替えて、今の保存の部品で保存する（画面が読んだ時の設定の全体を送り直さない。別のタブで保存した
// 変更を古い値に戻さない）。画面が読んだ改訂の照合は保つ。
describe('MI-F3: saving only the excluded paths of the stored auth setup (the audit start screen)', () => {
  /** 上の場面の後の、保存してある設定（改訂 2 に結びつく）。 */
  const storedSetup = async (): Promise<Record<string, unknown> | undefined> => (await getPage(AUTH_PROFILE))?.stored?.setup;

  it('lists the Server Function by name, and rejects inputs that do not match its schema with 400 (saves nothing)', async () => {
    expect([...ids.keys()]).toContain('saveExcludedPathsFn');
    const before = await storedSetup();
    for (const data of [
      {},
      { profileId: AUTH_PROFILE, expectedRevision: SECOND_REVISION },
      { profileId: AUTH_PROFILE, expectedRevision: SECOND_REVISION, excludedPaths: '/admin/logout' },
      { profileId: AUTH_PROFILE, expectedRevision: SECOND_REVISION, excludedPaths: [1] },
      { profileId: AUTH_PROFILE, expectedRevision: SECOND_REVISION, excludedPaths: [], setup: setupFor(SECOND_REVISION) },
      { profileId: '../x', expectedRevision: SECOND_REVISION, excludedPaths: [] },
    ]) {
      const result = await call('saveExcludedPathsFn', 'POST', data);
      expect(result.response.status, JSON.stringify(data)).toBe(STATUS.BAD_REQUEST);
    }
    expect(await storedSetup()).toEqual(before);
  });

  it('replaces only the excluded paths, and keeps a change saved in another tab (the audit path prefixes)', async () => {
    // 別のタブ（認証の設定の画面）で、読む範囲のパスを変えて保存した。
    const elsewhere = setupFor(SECOND_REVISION, { auditPathPrefixes: ['/admin/reports'] });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: elsewhere })).toMatchObject({ ok: true });
    const saved = await valueOf('saveExcludedPathsFn', 'POST', {
      profileId: AUTH_PROFILE,
      expectedRevision: SECOND_REVISION,
      excludedPaths: ['/admin/logout', '/admin/exit'],
    });
    const expected = { ...elsewhere, excludedPaths: ['/admin/logout', '/admin/exit'] };
    expect(saved).toMatchObject({ ok: true, stored: { freshness: 'CURRENT', setup: expected } });
    expect(await storedSetup()).toEqual(expected);
  });

  it('returns the validation errors of the save by field, and saves nothing', async () => {
    const before = await storedSetup();
    expect(await valueOf('saveExcludedPathsFn', 'POST', { profileId: AUTH_PROFILE, expectedRevision: SECOND_REVISION, excludedPaths: ['/admin/logout', 'admin'] }))
      .toEqual({ ok: false, reason: 'AUTH_SETUP_INVALID', errors: [{ code: 'AUTH_SETUP_PATH_INVALID', field: 'excludedPaths', line: 2 }] });
    expect(await storedSetup()).toEqual(before);
  });

  it('rejects a revision the screen did not read, an unknown profile and a profile without an auth setup, and saves nothing', async () => {
    const before = await storedSetup();
    expect(await valueOf('saveExcludedPathsFn', 'POST', { profileId: AUTH_PROFILE, expectedRevision: FIRST_REVISION, excludedPaths: [] }))
      .toEqual({ ok: false, reason: 'PROFILE_REVISION_CONFLICT', errors: [] });
    expect(await valueOf('saveExcludedPathsFn', 'POST', { profileId: 'not-there', expectedRevision: FIRST_REVISION, excludedPaths: [] }))
      .toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND', errors: [] });
    expect(await valueOf('saveExcludedPathsFn', 'POST', { profileId: PUBLIC_PROFILE, expectedRevision: FIRST_REVISION, excludedPaths: [] }))
      .toEqual({ ok: false, reason: 'AUTH_SETUP_NOT_FOUND', errors: [] });
    expect(await storedSetup()).toEqual(before);
    expect(await getPage(PUBLIC_PROFILE)).toMatchObject({ stored: null });
    expect(await listJobs()).toEqual([]);
  });
});

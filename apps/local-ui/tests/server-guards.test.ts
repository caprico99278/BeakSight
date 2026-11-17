/**
 * 束 S1（SLIM-GROUP の UI-2）: 画面のサーバ（ビルドした画面と本番の起動の部品）の守りを、1 つの一時の root と 1 つのサーバで確かめる。
 * 元のファイル（設計者が消す）: launcher-server・server-function-contract・artifact-routes・single-instance（本番の起動の部品の場面）・
 * start-failures（本番の起動の部品の場面）と、消したファイルの 2 場面（server-functions の「管理データが SQLite でないと起動しない」、
 * credential-destination-functions の C-1）。開発のサーバの場面は S2（`dev-server.test.ts`）。
 * - 順: Server Function の作り（ジョブ 0 を確かめるので最初）→ 待ち受け・Host・token・cookie・CSP・Server Function の CSRF（画面から作成）→ C-1 →
 *   成果物の Server Routes → 起動の失敗（管理データ・`--port`）→ 同時に 1 つ（共有のサーバを止めるので最後）。
 * - artifact-routes: 前は本物の監査を 1 回動かして成果物を作っていた。守りの対象はパスの判定（許可の一覧・404・401・符号化・Windows の別名・junction・
 *   report.html の CSP）で、成果物の作り方によらないので、ジョブの行と Run のディレクトリの成果物をテストだけの操作で書く。
 *   確かめなくなること: 本物のジョブが作った成果物を配ること、ワーカーの子孫の process が残らないこと。別の所: full-flow（report.html を開き、ZIP を落とす）と
 *   audit-ui-flows（本物のワーカーのジョブ）。
 * - credential-destination-functions: C-1 の 1 場面だけ（Server Function の口が守りの選択肢を渡すことの確かめ）。ほかの場面の別の所: 単体
 *   `tests/unit/credential-destination.test.ts`、結合 `tests/integration/credential-destination-lock.test.ts`・`credential-destination-observed-only.test.ts`。
 * - server-function-contract: 消した scenario-autodraft-ui の「スキーマに合わない入力を拒む」の 2 行と、名前の確かめ（`scenarioAutoDraftPreviewFn` があり、
 *   `attachAutoDraftRulesFn` がない）を表に足した。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Browser, Request as PlaywrightRequest } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load-config.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../../src/control/auth/auth-setup-contracts.js';
import { MAX_CREDENTIAL_VALUE_LENGTH } from '../../../src/control/credentials/credential-store.js';
import { createStartingJob, recordFinished, recordRunStarted } from '../../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile } from '../../../src/control/store/profile-store.js';
import { PAGES_ARTIFACT_DIRECTORY, RUN_ARTIFACT_FILE_NAMES, SCREENSHOT_FILE_NAMES } from '../../../src/core/artifact-layout.js';
import { DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES } from '../../../src/core/contained-artifact-file.js';
import { createPageId, createRunId } from '../../../src/core/ids.js';
import {
  CONTROL_STORE_FAILURE_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_START_FAILURE_TEXT,
  LOCAL_UI_TEXT,
} from '../../../src/presentation/messages.js';
import { buildArtifactContentSecurityPolicy, sessionCookieName } from '../launcher/request-guard.ts';
import { outputDirectoryOf, publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import {
  LOOPBACK_HOST,
  REPO_ROOT,
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  runLauncherUntilExit,
  runLauncherWithArgumentsUntilExit,
  startLauncher,
  stopServer,
  type ExitedProcess,
  type RawResponse,
  type StartedServer,
} from './helpers/local-server.ts';
import { createProfileOnScreen } from './helpers/profile-form.ts';
import { encodeServerFunctionPayload } from './helpers/server-functions.ts';
import { cspViolationsOf, recordCspViolations } from './helpers/ui-page.ts';
import { createUiServerKit } from './helpers/ui-server.ts';

/** 準備と、サーバを起動し直す場面の上限（ms）。 */
const SCENARIO_TIMEOUT_MS = 120_000;
/** 起動できないときの終了コード（起動の失敗と、管理データの準備の失敗）。 */
const START_FAILED_EXIT_CODE = 1;
const PREPARATION_FAILED_EXIT_CODE = 1;
const startFailureText = LOCAL_UI_START_FAILURE_TEXT;

/** 束の 1 つのサーバ（一時の root、起動の部品、Chromium、Cookie）。 */
const serverKit = createUiServerKit();
const { started, rootOf, idsOf, cookieOf, call, valueOf } = serverKit;

/** 共有の Chromium（共有の context の持ち主。場面ごとに新しい context を作る）。 */
const browserOf = (): Browser => {
  const browser = serverKit.contextOf()?.browser();
  if (browser === null || browser === undefined) {
    throw new Error('Chromium が起動していない');
  }
  return browser;
};

beforeAll(() => serverKit.setUp(), SCENARIO_TIMEOUT_MS);
afterAll(() => serverKit.tearDown());

describe('server-function-contract: the names, the CSRF protection and the input schemas (one server)', () => {
  /** HTTP の状態。 */
  const STATUS = Object.freeze({ BAD_REQUEST: 400, FORBIDDEN: 403 });
  /** 画面のサーバの Server Function の定義の置き場。 */
  const SERVER_FUNCTION_SOURCES = `${REPO_ROOT}/apps/local-ui/src/server`;
  /** POST の Server Function の定義（`export const <名前> = createServerFn({ method: 'POST' })`）。 */
  const POST_DEFINITION_PATTERN = /export const ([A-Za-z0-9_$]+)\s*=\s*createServerFn\(\{\s*method:\s*'POST'\s*\}\)/gu;

  /** テストの値（匿名。形だけ合う。サーバには、どのプロファイルもシナリオも作らない）。 */
  const PROFILE = 'contract-profile';
  const DIGEST = `sha256:${'0'.repeat(64)}`;
  /** 実行ごとの資格情報の目印（値を出力しない。比べるときは真偽だけを見る）。 */
  const RUN = randomUUID();
  const USER_MARK = `contract-user-${RUN}`;
  const PASS_MARK = `contract-pass-${RUN}`;
  const MARKERS = Object.freeze([USER_MARK, PASS_MARK]);
  const leaks = (text: string): boolean => MARKERS.some((marker) => text.includes(marker));

  /** READ の確かめの定義（中身は保存の部品が確かめる。入力の形では object であればよい）。 */
  const READ_CHECK_DEFINITION = { targetIdentityDigest: DIGEST, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] };
  /** 認証の設定（中身は保存の部品が確かめる。入力の形では object であればよい）。 */
  const AUTH_SETUP = { profileId: PROFILE, profileRevision: 1 };

  /** CSRF の保護で 403 になる header の組（前の各ファイルと同じ 3 つ）。 */
  const csrfHeaderSets = (origin: string): readonly (readonly [string, Readonly<Record<string, string>>])[] => [
    ['cross-site', { 'sec-fetch-site': 'cross-site', origin }],
    ['same-site from another origin', { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1' }],
    ['another origin without Sec-Fetch-Site', { origin: 'http://attacker.invalid' }],
  ];

  /** スキーマに合わない入力（関数の名前、method、入力）。前の各ファイルの 400 の場面から写した。 */
  const SCHEMA_REJECTED: readonly (readonly [string, 'GET' | 'POST', unknown])[] = [
    // 監査のジョブ（前は audit-job-functions.test.ts）。
    ['startAuditJobFn', 'POST', { profileId: PROFILE, expectedRevision: 1 }],
    ['startAuditJobFn', 'POST', { profileId: 'NOT VALID', expectedRevision: 1, startNew: true }],
    ['startAuditJobFn', 'POST', { profileId: PROFILE, expectedRevision: 0, startNew: true }],
    ['startAuditJobFn', 'POST', { profileId: PROFILE, expectedRevision: '1', startNew: true }],
    ['startAuditJobFn', 'POST', { profileId: PROFILE, expectedRevision: 1, startNew: 'yes' }],
    ['startAuditJobFn', 'POST', { profileId: PROFILE, expectedRevision: 1, startNew: true, minNavigationIntervalMs: 0 }],
    ['stopAuditJobFn', 'POST', { jobId: 'NOT-A-JOB', force: false }],
    ['stopAuditJobFn', 'POST', { jobId: 'job-1' }],
    ['stopAuditJobFn', 'POST', { jobId: 'job-1', force: 'true' }],
    ['getAuditJobFn', 'GET', { jobId: '' }],
    ['getAuditJobFn', 'GET', { jobId: '../job' }],
    ['auditStartSummaryFn', 'GET', { profileId: 1 }],
    // 認証の設定（前は auth-setup-functions.test.ts）。
    ['saveAuthSetupFn', 'POST', {}],
    ['saveAuthSetupFn', 'POST', { setup: 'text' }],
    ['saveAuthSetupFn', 'POST', { setup: [] }],
    ['saveAuthSetupFn', 'POST', { setup: AUTH_SETUP, password: 'not-a-secret' }],
    ['getAuthSetupFn', 'GET', { profileId: 1 }],
    ['getAuthSetupFn', 'GET', { profileId: '../x' }],
    ['saveExcludedPathsFn', 'POST', {}],
    ['saveExcludedPathsFn', 'POST', { profileId: PROFILE, expectedRevision: 2 }],
    ['saveExcludedPathsFn', 'POST', { profileId: PROFILE, expectedRevision: 2, excludedPaths: '/admin/logout' }],
    ['saveExcludedPathsFn', 'POST', { profileId: PROFILE, expectedRevision: 2, excludedPaths: [1] }],
    ['saveExcludedPathsFn', 'POST', { profileId: PROFILE, expectedRevision: 2, excludedPaths: [], setup: AUTH_SETUP }],
    ['saveExcludedPathsFn', 'POST', { profileId: '../x', expectedRevision: 2, excludedPaths: [] }],
    // 資格情報（前は credential-ui-flows.test.ts。目印の値を入れて送り、応答に出ないことも確かめる）。
    ['registerCredentialFn', 'POST', { profileId: PROFILE, username: 'a'.repeat(MAX_CREDENTIAL_VALUE_LENGTH + 1), password: PASS_MARK, passwordConfirmation: PASS_MARK }],
    ['registerCredentialFn', 'POST', { profileId: PROFILE, username: USER_MARK, password: PASS_MARK }],
    ['registerCredentialFn', 'POST', { profileId: PROFILE, username: USER_MARK, password: PASS_MARK, passwordConfirmation: PASS_MARK, extra: 1 }],
    ['changeCredentialFn', 'POST', { profileId: PROFILE, username: USER_MARK, password: null, passwordConfirmation: null }],
    ['replaceCredentialFn', 'POST', { profileId: PROFILE, username: 1, password: PASS_MARK, passwordConfirmation: PASS_MARK, clearHold: false }],
    ['startLoginCheckFn', 'POST', { profileId: PROFILE, expectedRevision: 0 }],
    // 発見と READ の確かめ（前は discovery-functions.test.ts）。
    ['discoveryPageFn', 'GET', { profileId: 1 }],
    ['startDiscoveryFn', 'POST', { profileId: PROFILE }],
    ['startDiscoveryFn', 'POST', { profileId: PROFILE, expectedRevision: 1, startNew: true }],
    ['startReadCheckFn', 'POST', { profileId: 'NOT VALID', expectedRevision: 1 }],
    ['createReadCheckFn', 'POST', { profileId: PROFILE }],
    ['createReadCheckFn', 'POST', { profileId: PROFILE, definition: READ_CHECK_DEFINITION, extra: true }],
    ['createReadCheckFn', 'POST', { profileId: PROFILE, definition: 'not an object' }],
    ['updateReadCheckFn', 'POST', { readCheckId: '../x', expectedRevision: 1, definition: READ_CHECK_DEFINITION }],
    ['updateReadCheckFn', 'POST', { readCheckId: 'read-1', expectedRevision: 0, definition: READ_CHECK_DEFINITION }],
    ['cancelReadCheckFn', 'POST', { readCheckId: 'read-1' }],
    ['readCheckPageFn', 'GET', { profileId: '' }],
    // 手動のログインの「ログインを終えた」（前は manual-login-ui.test.ts）。
    ['confirmManualLoginFn', 'POST', { jobId: 'job-contract', extra: true }],
    ['confirmManualLoginFn', 'POST', { jobId: '' }],
    ['confirmManualLoginFn', 'POST', {}],
    // 一覧でチェックの自動の下書き（前は scenario-autodraft-ui.test.ts。発見のジョブの ID がない・改訂が 0）。
    ['createScenarioAutoDraftsFn', 'POST', { profileId: PROFILE, expectedRevision: 1 }],
    ['createScenarioAutoDraftsFn', 'POST', { profileId: PROFILE, expectedRevision: 0, discoveryJobId: 'job-x' }],
  ];

  /** 前の各ファイルの CSRF の場面が確かめていた POST の Server Function（新しい表が、これらを必ず含む）。 */
  const FORMERLY_CHECKED_POSTS = Object.freeze([
    'startAuditJobFn',
    'saveAuthSetupFn',
    'registerCredentialFn',
    'changeCredentialFn',
    'replaceCredentialFn',
    'removeCredentialFn',
    'clearAutoLoginHoldFn',
    'startLoginCheckFn',
    'startDiscoveryFn',
    'startReadCheckFn',
    'createReadCheckFn',
    'cancelReadCheckFn',
    'confirmManualLoginFn',
  ]);

  /** POST の Server Function の名前（定義のファイルから読む。名前の順）。 */
  const POST_FUNCTION_NAMES: readonly string[] = readdirSync(SERVER_FUNCTION_SOURCES)
    .filter((name) => name.endsWith('.ts'))
    .flatMap((name) => [...readFileSync(`${SERVER_FUNCTION_SOURCES}/${name}`, 'utf8').matchAll(POST_DEFINITION_PATTERN)].map((match) => match[1] ?? ''))
    .sort();

  /** 拒んだ要求の応答の本文（最後に目印がないことを確かめる）。 */
  const responseBodies: string[] = [];

  it('lists the Server Functions by name, and every POST Server Function of the sources is in the build', () => {
    const ids = idsOf();
    expect([...ids.keys()]).toEqual(expect.arrayContaining([
      // 前は audit-job-functions・auth-setup-functions・discovery-functions・scenario-autodraft-ui の名前の一覧の場面。
      'auditStartSummaryFn',
      'getAuditJobFn',
      'listAuditJobsFn',
      'startAuditJobFn',
      'stopAuditJobFn',
      'getAuthSetupFn',
      'saveAuthSetupFn',
      'saveExcludedPathsFn',
      'discoveryPageFn',
      'startDiscoveryFn',
      'readCheckPageFn',
      'createReadCheckFn',
      'updateReadCheckFn',
      'cancelReadCheckFn',
      'startReadCheckFn',
      'scenarioAutoDraftPreviewFn',
      'createScenarioAutoDraftsFn',
    ]));
    // PL-5 の修正の 1 回目: 規則を付ける口は、保存の口がすべての保存で付けるので捨てた（前は scenario-autodraft-ui.test.ts）。
    expect(ids.has('attachAutoDraftRulesFn')).toBe(false);
    expect(POST_FUNCTION_NAMES).toEqual(expect.arrayContaining([...FORMERLY_CHECKED_POSTS]));
    expect([...ids.keys()]).toEqual(expect.arrayContaining([...POST_FUNCTION_NAMES]));
  });

  it.each([0, 1, 2])('keeps the CSRF protection: every POST Server Function is 403 with the header set %i', async (index) => {
    const [label, headers] = csrfHeaderSets(started().origin)[index] ?? ['', {}];
    // 資格情報の目印を入れた本文（CSRF の保護が外れていれば、各関数の処理まで届く）。
    const body = encodeServerFunctionPayload({ profileId: PROFILE, username: USER_MARK, password: PASS_MARK, passwordConfirmation: PASS_MARK });
    const statuses: (readonly [string, number])[] = [];
    for (const name of POST_FUNCTION_NAMES) {
      const response = await rawRequest(started().port, `/_serverFn/${idsOf().get(name) ?? ''}`, {
        method: 'POST',
        headers: { cookie: cookieOf(), 'content-type': 'application/json', 'x-tsr-serverfn': 'true', ...headers },
        body,
      });
      responseBodies.push(response.body);
      statuses.push([name, response.status]);
    }
    expect(statuses.filter(([, status]) => status !== STATUS.FORBIDDEN), label).toEqual([]);
  });

  it('rejects inputs that do not match the schemas with 400', async () => {
    const statuses: (readonly [string, number])[] = [];
    for (const [name, method, data] of SCHEMA_REJECTED) {
      const result = await call(name, method, data);
      responseBodies.push(result.response.body);
      statuses.push([`${name} ${JSON.stringify(data).replaceAll(USER_MARK, '<user>').replaceAll(PASS_MARK, '<pass>')}`, result.response.status]);
    }
    expect(statuses.filter(([, status]) => status !== STATUS.BAD_REQUEST)).toEqual([]);
  });

  it('created no job, and the values are not in the responses nor in the server output', async () => {
    expect(await valueOf('listAuditJobsFn', 'GET')).toEqual([]);
    expect(responseBodies.length).toBe(POST_FUNCTION_NAMES.length * csrfHeaderSets('').length + SCHEMA_REJECTED.length);
    expect(responseBodies.filter(leaks).length).toBe(0);
    expect(leaks(started().output())).toBe(false);
  });
});

describe('launcher-server: the listening address, Host, token, cookie, CSP and the Server Function CSRF', () => {
  /** すべての応答に付く header（値まで確かめるもの）。 */
  const FIXED_SECURITY_HEADERS = Object.freeze({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
  });
  /** CSP の nonce。 */
  const CSP_NONCE_PATTERN = /'nonce-([A-Za-z0-9+/=]+)'/u;
  /** 接続の試みを待つ上限（ミリ秒）。 */
  const CONNECT_TIMEOUT_MS = 2_000;
  /** Server Function の呼び出しを待つ上限（ミリ秒）。 */
  const SERVER_FN_TIMEOUT_MS = 10_000;
  /** OP-1 修正の 2 回目: 作成の画面が始めた下調べが終わり、サイトの画面へ移るまでを待つ上限（ms。`start-url-onboarding-ui.test.ts` と同じ）。 */
  const ENTRY_CHECK_TIMEOUT_MS = 60_000;

  const expectSecurityHeaders = (response: RawResponse, label: string): string => {
    for (const [name, value] of Object.entries(FIXED_SECURITY_HEADERS)) {
      expect(response.headers[name], `${label}: ${name}`).toBe(value);
    }
    const csp = response.headers['content-security-policy'];
    expect(typeof csp, `${label}: content-security-policy`).toBe('string');
    const cspText = String(csp);
    expect(cspText).toContain("default-src 'self'");
    expect(cspText).toContain("frame-ancestors 'none'");
    expect(cspText).not.toMatch(/unsafe-/u);
    return CSP_NONCE_PATTERN.exec(cspText)?.[1] ?? '';
  };

  /** `host:port` へ TCP で繋げるか（繋がらなければ誤りの code）。 */
  const tryConnect = (host: string, port: number): Promise<string> =>
    new Promise((resolveResult) => {
      const socket = connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolveResult('TIMEOUT');
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolveResult('CONNECTED');
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolveResult(error.code ?? 'ERROR');
      });
    });

  /** ブラウザが送った Server Function の要求（再送の確かめに使う）。 */
  let serverFnCall: { readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: string } | undefined;

  it('listens on 127.0.0.1 only (::1 and LAN addresses do not connect)', async () => {
    const { port } = started();
    expect(await tryConnect('127.0.0.1', port)).toBe('CONNECTED');
    expect(await tryConnect('::1', port)).not.toBe('CONNECTED');
    const lanAddresses = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => !entry.internal)
      .map((entry) => entry.address);
    const results = await Promise.all(lanAddresses.map(async (address) => [address, await tryConnect(address, port)] as const));
    for (const [address, result] of results) {
      expect(result, address).not.toBe('CONNECTED');
    }
  });

  it('rejects localhost, other hosts and other ports with 421 (with the security headers)', async () => {
    const { port } = started();
    for (const host of [`localhost:${port}`, 'attacker.invalid', `attacker.invalid:${port}`, `127.0.0.1:${port + 1}`]) {
      const response = await rawRequest(port, '/', { host, headers: { cookie: cookieOf() } });
      expect(response.status, host).toBe(421);
      expectSecurityHeaders(response, `421 ${host}`);
    }
  });

  it('rejects requests without the cookie, and with a wrong token, with 401', async () => {
    const { port } = started();
    for (const path of ['/', '/assets/index.js', '/_serverFn/abc', '/?token=wrong']) {
      const response = await rawRequest(port, path, path.startsWith('/_serverFn') ? { method: 'POST', body: '{}' } : {});
      expect(response.status, path).toBe(401);
      expectSecurityHeaders(response, `401 ${path}`);
    }
    const wrongCookie = await rawRequest(port, '/', { headers: { cookie: `${sessionCookieName(port)}=wrong` } });
    expect(wrongCookie.status).toBe(401);
  });

  it('exchanges the console token for an HttpOnly, SameSite=Strict, Path=/ cookie and redirects with 303 without the token', async () => {
    const { port, tokenUrl } = started();
    const response = await rawRequest(port, `${tokenUrl.pathname}${tokenUrl.search}`);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/');
    expectSecurityHeaders(response, '303');
    const setCookie = parseSetCookie(response.headers['set-cookie']);
    expect(setCookie?.pair.startsWith(`${sessionCookieName(port)}=`)).toBe(true);
    expect(setCookie?.attributes).toEqual(['HttpOnly', 'SameSite=Strict', 'Path=/']);
    expect(cookieOf()).toBe(setCookie?.pair);
  });

  it('serves the page with the cookie; the CSP nonce changes per request and matches every inline script', async () => {
    const { port } = started();
    const cookie = cookieOf();
    const first = await rawRequest(port, '/', { headers: { cookie, accept: 'text/html' } });
    const second = await rawRequest(port, '/', { headers: { cookie, accept: 'text/html' } });
    expect(first.status).toBe(200);
    const firstNonce = expectSecurityHeaders(first, '200');
    const secondNonce = expectSecurityHeaders(second, '200');
    expect(firstNonce).not.toBe('');
    expect(secondNonce).not.toBe(firstNonce);
    expect(first.body).toContain(LOCAL_UI_TEXT.pages.profiles);
    const scripts = [...first.body.matchAll(/<script\b([^>]*)>/gu)].map((match) => match[1] ?? '');
    const inlineScripts = scripts.filter((attributes) => !/\bsrc=/u.test(attributes));
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const attributes of scripts) {
      expect(attributes, attributes).toContain(`nonce="${firstNonce}"`);
    }
  });

  it('serves static files only with the cookie, and refuses paths outside dist/client', async () => {
    const { port } = started();
    const cookie = cookieOf();
    const page = await rawRequest(port, '/', { headers: { cookie, accept: 'text/html' } });
    const asset = /src="(\/assets\/[^"]+\.js)"/u.exec(page.body)?.[1] ?? /href="(\/assets\/[^"]+\.js)"/u.exec(page.body)?.[1];
    expect(asset).toBeDefined();
    const withCookie = await rawRequest(port, asset ?? '/', { headers: { cookie } });
    expect(withCookie.status).toBe(200);
    expectSecurityHeaders(withCookie, 'static');
    expect((await rawRequest(port, asset ?? '/')).status).toBe(401);
    for (const path of ['/assets/..%2f..%2fserver%2fserver.js', '/..%2fserver%2fserver.js', '/assets/%2e%2e/%2e%2e/server/server.js']) {
      const response = await rawRequest(port, path, { headers: { cookie, accept: 'text/html' } });
      expect(response.status, path).toBe(404);
      expect(response.body).not.toContain('createServerEntry');
      expectSecurityHeaders(response, `404 ${path}`);
    }
  });

  it('opens from the token URL in headless Chromium: the page renders, no CSP violation, no external request', async () => {
    const { origin, tokenUrl } = started();
    const context = await browserOf().newContext();
    try {
      const requests: string[] = [];
      context.on('request', (request) => requests.push(request.url()));
      const page = await context.newPage();
      await page.addInitScript(recordCspViolations);
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });
      page.on('pageerror', (error) => consoleErrors.push(String(error)));
      await page.goto(tokenUrl.href, { waitUntil: 'networkidle' });
      expect(page.url()).toBe(`${origin}/`);
      expect(await page.locator('h1').textContent()).toBe(LOCAL_UI_TEXT.pages.profiles);

      const cookies = await context.cookies(origin);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });

      // 画面からプロファイルを登録し、そのときの Server Function（POST）の要求を記録する。
      // T43a: 左のメニューにも同じ名前のリンクがあるので、本文（一覧の上の帯）のリンクを選ぶ。
      await page.getByRole('main').getByRole('link', { name: LOCAL_UI_TEXT.profileList.newProfile }).click();
      // MI-1（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: 使い方は「公開の画面だけ」（保存の POST は作成の 1 つだけ）。名前と設定の
      // ファイルは、たたんだ詳しい設定の中。T43b: この流れは、すでにある設定のファイルを選ぶ。
      // PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 見える入力は開始のアドレス・使い方・保存だけ。一時の root の設定のファイル
      // （`config/targets/example.json`）の開始のアドレスを入れると、そのファイルを使い、名前は開始のアドレスから決まる。
      const serverFnPost = page.waitForRequest(
        (request: PlaywrightRequest) => request.url().includes('/_serverFn/') && request.method() === 'POST',
        { timeout: SERVER_FN_TIMEOUT_MS },
      );
      // OP-1 修正の 2 回目（OP 設計書 4.1.3 の 3。設計者の判断「公開のサイトも点検を始める 1 つ」）: 作成の画面の「点検を始める」は、保存に続けて下調べを始め、下調べは
      // 開始のページを実際に読みに行く。そのため、開始のアドレスは、どこにも接続しない予約の名前にした（前は `https://example.com/` で、保存の後にサイトの画面へ
      // 移り、保存の知らせを出した）。記録するのは、最初の POST（作成）。
      await createProfileOnScreen(page, { startUrl: 'https://launcher.example.test/', usage: 'PUBLIC' }, SERVER_FN_TIMEOUT_MS);
      const sent = await serverFnPost;
      // 保存に続けて、下調べの作業の画面へ移る。下調べは開始のページを開けないので、点検を始めず、作業の画面がサイトの画面へ移す（作業が終わったことの確かめ）。
      await page.waitForURL(/\/jobs\/[^/]+$/u, { timeout: SERVER_FN_TIMEOUT_MS });
      await page.waitForURL(/\/profiles\/launcher-example-test\?/u, { timeout: ENTRY_CHECK_TIMEOUT_MS });
      const sentHeaders = await sent.allHeaders();
      serverFnCall = {
        path: new URL(sent.url()).pathname + new URL(sent.url()).search,
        headers: Object.fromEntries(Object.entries(sentHeaders).filter(([name]) => ['content-type', 'accept', 'x-tsr-serverfn'].includes(name))),
        body: sent.postData() ?? '',
      };

      // 記録がなければ（init script が動かなかった文書）誤りにする。
      expect(await cspViolationsOf(page, true)).toEqual([]);
      expect(consoleErrors.filter((text) => /Content Security Policy/iu.test(text))).toEqual([]);
      expect(requests.filter((url) => !url.startsWith(`${origin}/`))).toEqual([]);
    } finally {
      await context.close();
    }
  }, SCENARIO_TIMEOUT_MS);

  it('Server Function: 200 from the same origin; 403 for cross-site, a different Origin, or neither (even with the cookie)', async () => {
    const { port, origin } = started();
    const cookie = cookieOf();
    if (serverFnCall === undefined) {
      throw new Error('ブラウザの Server Function の要求を記録できていない');
    }
    const send = (extra: Readonly<Record<string, string>>): Promise<RawResponse> =>
      rawRequest(port, serverFnCall?.path ?? '/', { method: 'POST', headers: { ...serverFnCall?.headers, cookie, ...extra }, body: serverFnCall?.body ?? '' });

    const sameOrigin = await send({ 'sec-fetch-site': 'same-origin', origin });
    expect(sameOrigin.status).toBe(200);
    // CSRF の確かめを通って、作成の処理まで届いた（PL-1: 作成の画面は名前を送らないので、同じ登録の 2 回目は、名前に -2 を付けたサイトとして保存する。
    // 前は名前を送っていたので「既にある」で拒まれていた）。OP-1 修正の 2 回目: 名前は、作成の画面で入れた開始のアドレス（予約の名前）から決まる。
    expect(sameOrigin.body).toContain('launcher-example-test-2');
    expectSecurityHeaders(sameOrigin, 'serverFn 200');
    expect((await send({ origin })).status).toBe(200);

    for (const [label, extra] of [
      ['cross-site', { 'sec-fetch-site': 'cross-site', origin }],
      ['same-site', { 'sec-fetch-site': 'same-site', origin: `http://127.0.0.1:${port + 1}` }],
      ['origin mismatch', { origin: `http://127.0.0.1:${port + 1}` }],
      ['origin localhost', { origin: `http://localhost:${port}` }],
      ['neither', {}],
    ] as const) {
      const response = await send(extra);
      expect(response.status, label).toBe(403);
      expectSecurityHeaders(response, `serverFn 403 ${label}`);
    }
    const withoutCookie = await rawRequest(port, serverFnCall.path, { method: 'POST', headers: { ...serverFnCall.headers, 'sec-fetch-site': 'same-origin', origin }, body: serverFnCall.body });
    expect(withoutCookie.status).toBe(401);
  });
});

/**
 * MI-F1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1。独立レビュー MI-R の Critical C-1）: 前は credential-destination-functions.test.ts。
 * 自動ログインのプロファイルを、編集で手動に戻して観察していない Origin X を足し、編集で自動ログインに戻し、認証の設定の保存で token の送信先を X に
 * する道。どの段も、何も保存せずに拒む（Server Function の口が守りの選択肢を渡すことの確かめ）。値は匿名（`example.invalid` とループバック）。
 */
describe('credential-destination C-1: the path (manual and back to automated, then the token target to an unobserved origin) is closed', () => {
  const MAX_PAGES = 4; // L14: 3 は前の既定と同じ値（読むときに捨てられる）なので 4。
  const TEST_ORIGIN = 'http://127.0.0.1:4173';
  const SERVICE_ORIGIN = 'https://service.example.invalid';
  const UNOBSERVED_ORIGIN = 'https://unobserved.example.invalid';
  const AUTO_PROFILE = 'mif1-auto';
  const TOKEN_PATH = '/auth/v1/token';
  const REASONS = Object.freeze({ notObserved: 'SERVICE_ORIGIN_ADD_NOT_OBSERVED', switchOnly: 'AUTOMATED_LOGIN_SWITCH_REQUIRED' });

  interface PageProfile {
    readonly profileId: string;
    readonly revision: number;
    readonly auth: string;
    readonly approvedServiceOrigins?: readonly string[];
    readonly [key: string]: unknown;
  }
  const profileOf = async (profileId: string): Promise<PageProfile> =>
    (await valueOf<{ readonly profile: PageProfile }>('getProfileFn', 'GET', { profileId })).profile;
  const setupOf = async (profileId: string): Promise<Record<string, unknown>> =>
    (await valueOf<{ readonly stored: { readonly setup: Record<string, unknown> } }>('getAuthSetupFn', 'GET', { profileId })).stored.setup;

  const AUTOMATED_LOGIN = Object.freeze({
    usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
    failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
  });

  /** 自動ログインのスクリプトの認証の設定（token の送信先は `SERVICE_ORIGIN`）。 */
  const scriptSetupOf = (profileId: string) => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileId,
    profileRevision: 1,
    loginStartUrl: `${TEST_ORIGIN}/auth`,
    loginPostEndpoints: [],
    successCondition: { pathPrefix: '/admin', selector: null },
    sessionLostCondition: { pathPrefix: '/auth' },
    excludedPaths: ['/auth/logout'],
    auditPathPrefixes: [],
    maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
    allowedIdpOrigins: [],
    automatedLogin: AUTOMATED_LOGIN,
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    loginSideRequests: [],
    successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
  });

  beforeAll(async () => {
    writeAuthTargetConfig(rootOf().root, AUTO_PROFILE, TEST_ORIGIN, '/admin', MAX_PAGES);
    // テストの準備（管理データの保存の部品を直接呼ぶ。作成と切り替えの口の守りは画面のサーバ。設計書 4.7.1 の 4）。
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      const profile = {
        schemaVersion: 'beaksight-profile/1', profileId: AUTO_PROFILE, revision: 1, targetConfigPath: `config/targets/${AUTO_PROFILE}.json`, environment: 'TEST',
        mode: 'TEST_AUTH_PASSIVE', auth: 'AUTOMATED_LOGIN', approvedTestOrigins: [TEST_ORIGIN], approvedServiceOrigins: [SERVICE_ORIGIN],
        environmentEvidenceRef: `${AUTO_PROFILE}-evidence`,
      };
      const targetConfig = await loadConfig(`${rootOf().root}/${profile.targetConfigPath}`);
      const resolveContext = () => ({ targetConfig });
      expect(createProfile(database, profile, { resolveContext }).ok).toBe(true);
      expect(saveAuthSetup(database, scriptSetupOf(AUTO_PROFILE), { resolveContext })).toMatchObject({ ok: true });
    } finally {
      closeControlDatabase(database);
    }
  }, SCENARIO_TIMEOUT_MS);

  it('rejects every step and keeps the token target', async () => {
    const before = await profileOf(AUTO_PROFILE);
    const setupBefore = await setupOf(AUTO_PROFILE);
    // 1. 手動のログインに戻すと同時に、観察していない Origin X を足す（方式によらず、足す保存を拒む）。
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...before, revision: before.revision + 1, auth: 'MANUAL_SESSION', approvedServiceOrigins: [SERVICE_ORIGIN, UNOBSERVED_ORIGIN] },
      expectedRevision: before.revision,
    })).toMatchObject({ ok: false, reason: REASONS.notObserved });
    // 2. 編集で自動ログインへ（切り替えだけで入る）。手動へ戻すのは受けるので、先に戻してから確かめる。
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...before, revision: before.revision + 1, auth: 'MANUAL_SESSION' },
      expectedRevision: before.revision,
    })).toMatchObject({ ok: true });
    const manual = await profileOf(AUTO_PROFILE);
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...manual, revision: manual.revision + 1, auth: 'AUTOMATED_LOGIN' },
      expectedRevision: manual.revision,
    })).toMatchObject({ ok: false, reason: REASONS.switchOnly });
    expect((await profileOf(AUTO_PROFILE)).auth).toBe('MANUAL_SESSION');
    expect((await profileOf(AUTO_PROFILE)).approvedServiceOrigins).toEqual([SERVICE_ORIGIN]);
    expect((await setupOf(AUTO_PROFILE))['scriptLogin']).toEqual(setupBefore['scriptLogin']);
  });
});

/**
 * 監査のジョブの成果物の Server Routes（GET）を確かめる（Task 24 の設計書 4.5、7 章「成果物」。T24f。前は artifact-routes.test.ts）。
 * - 終わった監査のジョブの行と、その Run のディレクトリの成果物（`run.json`、`audit.json`、`report.html`、バンドルの ZIP、`audit.json` が参照する
 *   `page.json` とスクリーンショット）を、テストだけの操作で書く（ワーカーは起動しない。サイトへは接続しない）。
 * - 許可の一覧のファイルは配られ、JSON と ZIP は `Content-Disposition: attachment`（ASCII の決まった名前。PRE42-BN: 日本語などの名前のバンドルは
 *   `filename*` も）、`report.html` は script を動かさない CSP。
 * - 一覧の外（`checkpoint/` の中、参照されていないファイル、`..`、符号化、Windows の別名とデバイス名、junction）は 404。cookie なしは 401。
 * - Chromium（headless）で `report.html` を開くと、書き足した script も事象の属性も動かず、style は動き、レポートの中の相対のリンク
 *   （スクリーンショット）は同じ Server Routes で開ける。外部への要求は 0。
 */
describe('artifact-routes: the artifacts of a finished audit job', () => {
  /** HTTP の状態。 */
  const STATUS = Object.freeze({ OK: 200, UNAUTHORIZED: 401, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405 });
  /** テストの値（匿名）。 */
  const PROFILE_ID = 't24f-artifacts';
  const JOB_ID = 'job-t24f-artifacts';
  const RUN_ID = createRunId(20261114000001);
  const PAGE_ID = createPageId(1);
  const JOB_CREATED_AT = '20261114010000';
  const JOB_FINISHED_AT = '20261114010500';
  /** バンドルの日時（14 桁）。 */
  const BUNDLE_DIGITS = '20261114010500';
  /** ダウンロードのファイル名の形（ASCII の英数字、`.`、`_`、`-` だけ）。 */
  const ASCII_ATTACHMENT = /^attachment; filename="[A-Za-z0-9._-]+"$/u;
  /** レポートに書き足す、動いてはいけない script（title と window の印を変える）と、事象の属性。 */
  const INJECTED_SCRIPT_MARK = 't24f-script-ran';
  const INJECTED_HTML = `<script>document.title='${INJECTED_SCRIPT_MARK}';window.t24fRan=true;</script>`
    + `<img src="data:," onerror="document.title='${INJECTED_SCRIPT_MARK}'">`;
  /** 1×1 の PNG（スクリーンショットの代わり）。 */
  const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const screenshotPath = `${PAGES_ARTIFACT_DIRECTORY}/${PAGE_ID}/desktop/${SCREENSHOT_FILE_NAMES.VIEWPORT}`;
  const pageJsonPath = `${PAGES_ARTIFACT_DIRECTORY}/${PAGE_ID}/page.json`;
  const bundleName = `beaksight-audit-bundle_${PROFILE_ID}_${BUNDLE_DIGITS}.zip`;
  const junctions: string[] = [];
  let runDirectory = '';

  const artifactUrlPath = (path: string): string => `/artifacts/${JOB_ID}/${path}`;
  const getArtifact = (path: string, withCookie = true): Promise<RawResponse> =>
    rawRequest(started().port, artifactUrlPath(path), withCookie ? { headers: { cookie: cookieOf() } } : {});
  const expectNotFound = async (path: string): Promise<void> => {
    const response = await rawRequest(started().port, path, { headers: { cookie: cookieOf() } });
    expect(response.status, path).toBe(STATUS.NOT_FOUND);
    expect(response.body, path).not.toContain('"schemaVersion"');
  };

  interface JobDetail {
    readonly artifacts: readonly {
      readonly kind: string;
      readonly relativePath: string;
      readonly part?: { readonly partNumber: number; readonly partCount: number };
    }[];
  }
  const jobDetail = (): Promise<JobDetail> => valueOf<JobDetail>('getAuditJobFn', 'GET', { jobId: JOB_ID });

  /** テストだけの操作: Run のディレクトリに、監査の成果物を書く（ワーカーの代わり。中身は配り方の確かめに足りる形だけ）。 */
  const writeRunArtifacts = (): void => {
    mkdirSync(`${runDirectory}/${PAGES_ARTIFACT_DIRECTORY}/${PAGE_ID}/desktop`, { recursive: true });
    writeFileSync(`${runDirectory}/${RUN_ARTIFACT_FILE_NAMES.run}`, `${JSON.stringify({ schemaVersion: 't24f-run', runId: RUN_ID })}\n`, 'utf8');
    writeFileSync(`${runDirectory}/${RUN_ARTIFACT_FILE_NAMES.audit}`, `${JSON.stringify({ schemaVersion: 't24f-audit', runId: RUN_ID, pages: [pageJsonPath] })}\n`, 'utf8');
    writeFileSync(`${runDirectory}/${pageJsonPath}`, `${JSON.stringify({
      schemaVersion: 't24f-page',
      pageId: PAGE_ID,
      evidence: [{ type: 'screenshot', payload: { relativePath: screenshotPath } }],
    })}\n`, 'utf8');
    writeFileSync(`${runDirectory}/${screenshotPath}`, PNG_1X1);
    const link = screenshotPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    writeFileSync(`${runDirectory}/${RUN_ARTIFACT_FILE_NAMES.report}`, '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>t24f report</title>'
      + '<style>body{font-family:sans-serif;color:#123456}</style></head>'
      + `<body><main><h1>t24f</h1><a href="${link}">screenshot</a></main></body></html>\n`, 'utf8');
    writeFileSync(`${runDirectory}/${bundleName}`, Buffer.from('PK\u0005\u0006'.padEnd(22, '\u0000'), 'binary'));
  };

  beforeAll(async () => {
    const targetConfigPath = writeAuditTargetConfig(rootOf().root, PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: true });
    expect(await valueOf('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, targetConfigPath) })).toMatchObject({ ok: true });
    runDirectory = `${rootOf().root}/${outputDirectoryOf(PROFILE_ID)}/${RUN_ID}`;
    writeRunArtifacts();
    // テストだけの操作: 終わった監査のジョブの行（Run の ID と Run のディレクトリつき）を書く。
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      expect(createStartingJob(database, { jobId: JOB_ID, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: 1, startNew: true, createdAt: JOB_CREATED_AT }, () => null))
        .toEqual({ ok: true });
      expect(recordRunStarted(database, JOB_ID, { runId: RUN_ID, runDirectory: RUN_ID, startedAt: JOB_CREATED_AT })).toBe(true);
      expect(recordFinished(database, JOB_ID, { kind: 'RAN', exitCode: 0, runId: RUN_ID, runDirectory: RUN_ID, runStatus: 'COMPLETE' }, JOB_FINISHED_AT)).toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  }, SCENARIO_TIMEOUT_MS);

  afterAll(() => {
    for (const junction of junctions) {
      if (existsSync(junction) && lstatSync(junction).isSymbolicLink()) {
        unlinkSync(junction);
      }
    }
  });

  it('lists the artifacts of the finished job in its detail', async () => {
    expect((await jobDetail()).artifacts.map((artifact) => artifact.kind)).toEqual(['REPORT', 'RUN_JSON', 'AUDIT_JSON', 'BUNDLE']);
  });

  it('serves run.json and audit.json as ASCII-named attachments, byte for byte', async () => {
    for (const name of [RUN_ARTIFACT_FILE_NAMES.run, RUN_ARTIFACT_FILE_NAMES.audit]) {
      const response = await getArtifact(name);
      expect(response.status, name).toBe(STATUS.OK);
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(response.headers['content-disposition']).toMatch(ASCII_ATTACHMENT);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toBe(readFileSync(`${runDirectory}/${name}`, 'utf8'));
    }
  });

  it('serves report.html inline with the CSP that runs no script and allows only its own style by hash', async () => {
    const response = await getArtifact(RUN_ARTIFACT_FILE_NAMES.report);
    expect(response.status).toBe(STATUS.OK);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['content-disposition']).toBeUndefined();
    const html = readFileSync(`${runDirectory}/${RUN_ARTIFACT_FILE_NAMES.report}`, 'utf8');
    const style = /<style>([\s\S]*?)<\/style>/u.exec(html.slice(0, html.indexOf('</head>')))?.[1] ?? '';
    const hash = createHash('sha256').update(style, 'utf8').digest('base64');
    expect(response.headers['content-security-policy']).toBe(buildArtifactContentSecurityPolicy([hash]));
    expect(String(response.headers['content-security-policy'])).not.toMatch(/unsafe-|allow-scripts|script-src/u);
    expect(response.headers['x-beaksight-artifact-style-sha256']).toBeUndefined();
  });

  it('serves the bundle ZIP as an attachment under its own name, with the profile name in it (PRE42-BN)', async () => {
    const response = await getArtifact(bundleName);
    expect(response.status).toBe(STATUS.OK);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${bundleName}"`);
    expect((await jobDetail()).artifacts.find((artifact) => artifact.kind === 'BUNDLE')?.relativePath).toBe(bundleName);
  });

  // PRE42-BN: 日本語などの名前のバンドルは、`filename*`（UTF-8 の percent-encode。RFC 5987 の attr-char の外の `'()` も符号化）で名前を渡し、
  // `filename` には ASCII の代わりの名前を置く。一覧は、名前の順ではなく、日時の新しい順の最初を示す。
  it('serves a bundle with a Japanese name with filename* in UTF-8, and lists the newest bundle by its time', async () => {
    const olderDigits = String(Number(BUNDLE_DIGITS.slice(0, 4)) - 1) + BUNDLE_DIGITS.slice(4);
    const japanese = `beaksight-audit-bundle_管理画面 (1)_${olderDigits}.zip`;
    const sortsLast = `beaksight-audit-bundle_zzz_${olderDigits}.zip`;
    const bytes = readFileSync(`${runDirectory}/${bundleName}`);
    writeFileSync(`${runDirectory}/${japanese}`, bytes);
    writeFileSync(`${runDirectory}/${sortsLast}`, bytes);
    try {
      const response = await getArtifact(encodeURIComponent(japanese));
      expect(response.status).toBe(STATUS.OK);
      expect(response.headers['content-type']).toBe('application/zip');
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="beaksight-audit-bundle_______1__${olderDigits}.zip"; `
        + `filename*=UTF-8''beaksight-audit-bundle_%E7%AE%A1%E7%90%86%E7%94%BB%E9%9D%A2%20%281%29_${olderDigits}.zip`,
      );
      expect(response.body.length).toBeGreaterThan(0);
      expect((await jobDetail()).artifacts.find((artifact) => artifact.kind === 'BUNDLE')?.relativePath).toBe(bundleName);
    } finally {
      unlinkSync(`${runDirectory}/${japanese}`);
      unlinkSync(`${runDirectory}/${sortsLast}`);
    }
  });

  // AUD-1d（ユーザーの判断 2026-11-09。設計者の判断の案 3）: 部に分けたバンドルは、全部の部が一覧に出る（番号と数つき）。部は、画面の読み取りの上限（256MiB）を
  // 当てずに、読みながら送る。大きい部は、中身を書かずに大きさだけを伸ばしたファイルで作る（受け取る側も、数えるだけでためない）。
  it('lists every part of a bundle in parts, and streams a part larger than the reading limit', async () => {
    const newerDigits = String(Number(BUNDLE_DIGITS.slice(0, 4)) + 1) + BUNDLE_DIGITS.slice(4);
    const part1 = `beaksight-audit-bundle_${PROFILE_ID}_${newerDigits}_part1.zip`;
    const part2 = `beaksight-audit-bundle_${PROFILE_ID}_${newerDigits}_part2.zip`;
    const hugeSize = DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES + 1024 * 1024;
    writeFileSync(`${runDirectory}/${part1}`, readFileSync(`${runDirectory}/${bundleName}`));
    const handle = openSync(`${runDirectory}/${part2}`, 'w');
    try {
      ftruncateSync(handle, hugeSize);
    } finally {
      closeSync(handle);
    }
    try {
      const bundles = (await jobDetail()).artifacts.filter((artifact) => artifact.kind === 'BUNDLE');
      expect(bundles.map(({ relativePath, part }) => [relativePath, part])).toEqual([
        [part1, { partNumber: 1, partCount: 2 }],
        [part2, { partNumber: 2, partCount: 2 }],
      ]);
      // 大きい部を、数えるだけで受け取る（256MiB を超えても 404 にならない）。
      const received = await new Promise<{ readonly status: number; readonly length: string | undefined; readonly bytes: number }>((resolveBytes, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: started().port, path: artifactUrlPath(part2), headers: { cookie: cookieOf(), host: `127.0.0.1:${started().port}` } },
          (res) => {
            let bytes = 0;
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.byteLength;
            });
            res.on('end', () => resolveBytes({ status: res.statusCode ?? 0, length: res.headers['content-length'], bytes }));
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(received).toEqual({ status: STATUS.OK, length: String(hugeSize), bytes: hugeSize });
    } finally {
      unlinkSync(`${runDirectory}/${part1}`);
      unlinkSync(`${runDirectory}/${part2}`);
    }
  });

  it('serves a screenshot and a page.json that audit.json refers to', async () => {
    const screenshot = await getArtifact(screenshotPath);
    expect(screenshot.status).toBe(STATUS.OK);
    expect(screenshot.headers['content-type']).toBe('image/png');
    const pageJson = await getArtifact(pageJsonPath);
    expect(pageJson.status).toBe(STATUS.OK);
    expect(pageJson.headers['content-disposition']).toMatch(ASCII_ATTACHMENT);
  });

  it('does not serve files in checkpoint/, files that are not referred to, or unknown jobs', async () => {
    mkdirSync(`${runDirectory}/checkpoint/pages`, { recursive: true });
    writeFileSync(`${runDirectory}/checkpoint/state.json`, '{"schemaVersion":"t24f"}\n');
    writeFileSync(`${runDirectory}/checkpoint/pages/PAGE-000001.json`, '{"schemaVersion":"t24f"}\n');
    writeFileSync(`${runDirectory}/notes.json`, '{"schemaVersion":"t24f"}\n');
    mkdirSync(`${runDirectory}/pages/PAGE-999999`, { recursive: true });
    writeFileSync(`${runDirectory}/pages/PAGE-999999/page.json`, '{"schemaVersion":"t24f"}\n');
    for (const path of ['checkpoint/state.json', 'checkpoint/pages/PAGE-000001.json', 'notes.json', 'pages/PAGE-999999/page.json',
      'pages', 'checkpoint']) {
      await expectNotFound(artifactUrlPath(path));
    }
    await expectNotFound(`/artifacts/no-such-job/${RUN_ARTIFACT_FILE_NAMES.run}`);
    await expectNotFound(`/artifacts/NOT_A_JOB/${RUN_ARTIFACT_FILE_NAMES.run}`);
    await expectNotFound(`/artifacts/${JOB_ID}/`);
  });

  it('rejects dot segments and encoded separators', async () => {
    for (const path of [
      `/artifacts/${JOB_ID}/pages/..%2F..%2F${RUN_ARTIFACT_FILE_NAMES.run}`,
      `/artifacts/${JOB_ID}/..%2f${JOB_ID}%2frun.json`,
      `/artifacts/${JOB_ID}/%252e%252e/${RUN_ARTIFACT_FILE_NAMES.run}`,
      `/artifacts/${JOB_ID}/${RUN_ARTIFACT_FILE_NAMES.run}%00`,
      `/artifacts/${JOB_ID}/${RUN_ARTIFACT_FILE_NAMES.run}%2F`,
      `/artifacts/${JOB_ID}/pages%5C..%5C${RUN_ARTIFACT_FILE_NAMES.run}`,
      `/artifacts/${JOB_ID}/checkpoint%2Fstate.json`,
    ]) {
      await expectNotFound(path);
    }
    // URL の構文で正規化されて Run のディレクトリの外へ出る（`..`）要求は、成果物の route に来ない（成果物を配らない）。
    // 符号化の壊れた要求も、成果物を配らない（Router が 400 で拒む）。
    for (const path of [`/artifacts/${JOB_ID}/../../package.json`, `/artifacts/${JOB_ID}/%2e%2e/%2e%2e/package.json`, `/artifacts/${JOB_ID}/%E0%A4%A`]) {
      const response = await rawRequest(started().port, path, { headers: { cookie: cookieOf() } });
      expect(response.status, path).not.toBe(STATUS.OK);
      expect(response.body, path).not.toContain('"devDependencies"');
    }
  });

  it('rejects Windows aliases and device names', async () => {
    for (const path of [
      'RUN.JSON',
      'Report.html',
      `${RUN_ARTIFACT_FILE_NAMES.run}.`,
      `${RUN_ARTIFACT_FILE_NAMES.run}%20`,
      `${RUN_ARTIFACT_FILE_NAMES.run}::$DATA`,
      `${RUN_ARTIFACT_FILE_NAMES.run}%3A%3A%24DATA`,
      'REPORT~1.HTM',
      'CON',
      'nul.json',
      'aux.png',
      `${screenshotPath.slice(0, screenshotPath.lastIndexOf('/'))}/COM1.png`,
    ]) {
      await expectNotFound(artifactUrlPath(path));
    }
  });

  it('does not follow a junction even for a referenced screenshot', async () => {
    const directory = `${runDirectory}/${screenshotPath.slice(0, screenshotPath.lastIndexOf('/'))}`;
    const real = `${directory}-real`;
    renameSync(directory, real);
    symlinkSync(real, directory, 'junction');
    junctions.push(directory);
    try {
      await expectNotFound(artifactUrlPath(screenshotPath));
    } finally {
      unlinkSync(directory);
      renameSync(real, directory);
    }
    expect((await getArtifact(screenshotPath)).status).toBe(STATUS.OK);
  });

  it('answers 401 without the cookie, and serves nothing for other methods', async () => {
    const response = await getArtifact(RUN_ARTIFACT_FILE_NAMES.run, false);
    expect(response.status).toBe(STATUS.UNAUTHORIZED);
    expect(response.body).not.toContain('"schemaVersion"');
    const post = await rawRequest(started().port, artifactUrlPath(RUN_ARTIFACT_FILE_NAMES.run), {
      method: 'POST',
      headers: { cookie: cookieOf(), origin: started().origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(post.status).toBe(STATUS.METHOD_NOT_ALLOWED);
    expect(post.body).toBe('');
  });

  it('answers the 404 with the Japanese short text, under the artifact CSP', async () => {
    const response = await getArtifact('notes.json');
    expect(response.body).toBe(LOCAL_UI_AUDIT_TEXT.artifactNotFound);
    expect(response.headers['content-security-policy']).toBe(buildArtifactContentSecurityPolicy([]));
  });

  it('report.html in Chromium: runs no script (even one written into the report), applies the style, and opens the relative screenshot link', async () => {
    const reportPath = `${runDirectory}/${RUN_ARTIFACT_FILE_NAMES.report}`;
    const original = readFileSync(reportPath, 'utf8');
    const originalTitle = /<title>([^<]*)<\/title>/u.exec(original)?.[1] ?? '';
    writeFileSync(reportPath, original.replace('<main>', `<main>${INJECTED_HTML}`), 'utf8');
    const context = await browserOf().newContext();
    try {
      const page = await context.newPage();
      const consoleMessages: string[] = [];
      const externalRequests: string[] = [];
      page.on('console', (message) => consoleMessages.push(message.text()));
      page.on('request', (request) => {
        if (!request.url().startsWith(`${started().origin}/`) && !request.url().startsWith('data:')) {
          externalRequests.push(request.url());
        }
      });
      await page.goto(started().tokenUrl.href, { waitUntil: 'networkidle' });
      const response = await page.goto(`${started().origin}${artifactUrlPath(RUN_ARTIFACT_FILE_NAMES.report)}`, { waitUntil: 'networkidle' });
      expect(response?.status()).toBe(STATUS.OK);
      expect(await page.title()).toBe(originalTitle);
      expect(await page.evaluate(() => (window as unknown as { t24fRan?: boolean }).t24fRan)).toBeUndefined();
      expect(consoleMessages.some((message) => /Blocked script execution|Refused to execute/u.test(message))).toBe(true);
      expect(consoleMessages.filter((message) => /Refused to apply inline style|style-src/u.test(message))).toEqual([]);
      // レポートの `<style>` が CSP で止められずに、スタイルシートとして読まれている（止められると `sheet` がない）。
      expect(await page.evaluate(() => document.querySelector('head style') instanceof HTMLStyleElement
        && (document.querySelector('head style') as HTMLStyleElement).sheet !== null)).toBe(true);

      const link = page.locator(`a[href="${screenshotPath.split('/').map((segment) => encodeURIComponent(segment)).join('/')}"]`).first();
      const [navigation] = await Promise.all([page.waitForNavigation(), link.click()]);
      expect(navigation?.status()).toBe(STATUS.OK);
      expect(navigation?.headers()['content-type']).toBe('image/png');
      expect(externalRequests).toEqual([]);
    } finally {
      await context.close();
      writeFileSync(reportPath, original, 'utf8');
    }
  }, SCENARIO_TIMEOUT_MS);
});

/** 起動の失敗の説明の確かめ（日本語の説明・次の段・0 でない終了コード・token の URL を出さない・stack を出さない）。 */
const expectStopped = (result: ExitedProcess, description: string, action: string): void => {
  expect(result.status, result.output).toBe(START_FAILED_EXIT_CODE);
  expect(result.output).toContain(startFailureText.heading);
  expect(result.output).toContain(description);
  expect(result.output).toContain(action);
  expect(result.output).not.toMatch(/token=/u);
  expect(result.output).not.toMatch(/\n\s+at /u);
};

describe('start failures of the launcher (T23h M2, T23f)', () => {
  /** 管理データの場所（一時の root からの相対）。 */
  const DATABASE_LOCATION = 'local-data/beaksight-control.sqlite';

  // 前は server-functions.test.ts。管理データの準備の失敗は、ほかの一時の root で確かめる（束のサーバの管理データは壊さない）。
  it('does not listen and exits non-zero with the setup:local explanation when the database is not a SQLite file', async () => {
    const broken = createTemporaryUiRoot('built');
    try {
      mkdirSync(`${broken.root}/local-data`);
      const databasePath = `${broken.root}/${DATABASE_LOCATION}`;
      writeFileSync(databasePath, 'a note that the user saved here\n');
      const before = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
      const result = runLauncherUntilExit(broken, await findFreePort());
      expect(result.status).toBe(PREPARATION_FAILED_EXIT_CODE);
      expect(result.output).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS.NOT_A_SQLITE_FILE.description);
      expect(result.output).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS.NOT_A_SQLITE_FILE.action);
      // PL-2（PL-W の持ち越し。設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 2）: 理由の行は日本語の説明だけで、英大文字の理由のコードを入れない
      // （理由のコードは「詳細」の行の英語の詳しいことに残る）。
      const reasonLine = result.output.split(/\r?\n/u).find((line) => line.includes(CONTROL_STORE_FAILURE_DESCRIPTIONS.NOT_A_SQLITE_FILE.description));
      expect(reasonLine).toBeDefined();
      expect(reasonLine).not.toContain('NOT_A_SQLITE_FILE');
      expect(result.output).toContain(DATABASE_LOCATION);
      expect(result.output).not.toMatch(/token=/u);
      expect(createHash('sha256').update(readFileSync(databasePath)).digest('hex')).toBe(before);
    } finally {
      broken.remove();
    }
  }, SCENARIO_TIMEOUT_MS);

  // 前は start-failures.test.ts。`--port` の値は、管理データとロックより前に読むので、束のサーバが動いている一時の root で確かめる。
  it.each([['abc'], ['0'], ['65536'], ['1.5']])('launcher: --port %s is not a port number', (value) => {
    const result = runLauncherWithArgumentsUntilExit(rootOf(), ['--port', value]);
    expectStopped(result, startFailureText.portInvalid(value), startFailureText.portInvalidAction);
  });

  it('launcher: --port without a value', () => {
    const result = runLauncherWithArgumentsUntilExit(rootOf(), ['--port']);
    expectStopped(result, startFailureText.portInvalid(''), startFailureText.portInvalidAction);
  });
});

/**
 * 画面のサーバは同時に 1 つだけ（独立レビュー T24R の C1、DEF-061。前は single-instance.test.ts の本番の起動の部品の場面）と、port の使用中
 * （前は start-failures.test.ts）。束のサーバを止めるので、束の最後に置く。開発のサーバとの組は S2（`dev-server.test.ts`）。
 */
describe('only one local UI server runs at a time (DEF-061), and the port in use', () => {
  /** 2 つ目の画面のサーバが、1 つ目（`holder`）を示して、待ち受けずに止まった。 */
  const expectRefused = (result: ExitedProcess, holder: StartedServer): void => {
    expect(result.status, result.output).toBe(START_FAILED_EXIT_CODE);
    expect(result.output).toContain(startFailureText.heading);
    expect(result.output).toContain(startFailureText.alreadyRunning(holder.child.pid ?? 0, startFailureText.alreadyRunningPort(holder.port)));
    expect(result.output).toContain(startFailureText.alreadyRunningAction);
    expect(result.output).not.toMatch(/token=/u);
    expect(result.output).not.toMatch(/\n\s+at /u);
  };

  /** 1 つ目は動き続けている（応答を返す）。 */
  const expectStillServing = async (server: StartedServer): Promise<void> => {
    expect(server.child.exitCode).toBeNull();
    const response = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
    expect(response.status).toBeLessThan(500);
  };

  /** 127.0.0.1 の port を、ほかのプログラムとして使っておく。 */
  const occupyPort = async (): Promise<{ readonly port: number; readonly server: Server }> => {
    const port = await findFreePort();
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen({ host: LOOPBACK_HOST, port }, () => resolveListen()));
    return { port, server };
  };

  let next: StartedServer | undefined;

  afterAll(async () => {
    await stopServer(next);
  });

  it('refuses a second production launcher with another --port, explains the port in use, and takes the stale lock over', async () => {
    const first = started();
    expectRefused(runLauncherUntilExit(rootOf(), await findFreePort()), first);
    await expectStillServing(first);

    // 1 つ目を強制終了した後（ロックの持ち主の process が死んでいる）。
    await stopServer(first);
    // port の使用中は、日本語の説明で止まる（古いロックを取り直した後、待ち受けで止まる）。
    const { port, server } = await occupyPort();
    try {
      const result = runLauncherWithArgumentsUntilExit(rootOf(), ['--port', String(port)]);
      expectStopped(result, startFailureText.portInUse(port), startFailureText.portInUseAction);
    } finally {
      server.close();
    }
    // 古いロック（死んだ持ち主）を取り直して起動する。
    next = await startLauncher(rootOf(), await findFreePort());
    await expectStillServing(next);
  }, SCENARIO_TIMEOUT_MS);
});

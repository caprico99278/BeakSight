/**
 * FM2d（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: 開始の画面の「まとめて実行する」の欄と、開始の Server Function
 * （`startStageChainFn`）を、ビルドした画面のサーバ（一時の root）と headless の Chromium で確かめる。ワーカーは起動しない（どの場面も、開始の前の確かめで
 * 拒まれる）。サイトへは接続しない。値は匿名（ループバック）。
 * - 欄は、まとめて実行のできるモードだけに出る（`TEST_AUTH_PASSIVE` は監査 → 発見 → READ の確かめ、`TEST_APPROVED_WRITE` は発見 → READ の確かめ）。
 *   公開の監査には出ない。始められない理由（認証の設定がない）を、今の理由の説明で出す。
 * - 開始の Server Function: 入力の形が違えば 400。公開の監査は `MODE_NOT_EXECUTABLE`、認証の設定がなければ `AUTH_SETUP_MISSING`。拒んだらジョブを作らない。
 */
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createReadCheck } from '../../../src/control/job/read-check-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { AUDIT_JOB_KIND_CATALOG } from '../../../src/presentation/catalog.js';
import { AUDIT_JOB_START_REJECTION_DESCRIPTIONS, LOCAL_UI_STAGE_CHAIN_TEXT } from '../../../src/presentation/messages.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
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
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const UI_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_TAB_PRESSES = 80;
const PUBLIC_PROFILE = 'fm2d-public';
const AUTH_PROFILE = 'fm2d-auth';
const WRITE_PROFILE = 'fm2d-write';
/** FM2R の I-1: 認証の設定を保存した、始められるプロファイル（READ の定義 0 件と 1 件）。 */
const READY_PROFILE = 'fm2d-ready';
const ORIGIN = 'http://127.0.0.1:9';
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400 });

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();

const started = (): StartedServer => {
  if (server === undefined) throw new Error('サーバが起動していない');
  return server;
};

const { openPage, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  screenshotDirectory: process.env['FM2D_SCREENSHOT_DIR'],
});

const call = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, name).toBe(STATUS.OK);
  return result.value as T;
};

const testProfile = (profileId: string, targetConfigPath: string, mode: 'TEST_AUTH_PASSIVE' | 'TEST_APPROVED_WRITE'): Record<string, unknown> => ({
  ...publicProfileDocument(profileId, targetConfigPath),
  environment: 'TEST',
  mode,
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [ORIGIN],
  environmentEvidenceRef: 'fm2d-evidence',
});

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  const config = writeAuditTargetConfig(root.root, PUBLIC_PROFILE, ORIGIN, { minNavigationIntervalMs: 0, screenshots: false });
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  for (const document of [
    publicProfileDocument(PUBLIC_PROFILE, config),
    testProfile(AUTH_PROFILE, config, 'TEST_AUTH_PASSIVE'),
    testProfile(WRITE_PROFILE, config, 'TEST_APPROVED_WRITE'),
    testProfile(READY_PROFILE, config, 'TEST_AUTH_PASSIVE'),
  ]) {
    expect(await valueOf('createProfileFn', 'POST', { profile: document })).toMatchObject({ ok: true });
  }
  expect(await valueOf('saveAuthSetupFn', 'POST', { setup: authSetupOf(READY_PROFILE) })).toMatchObject({ ok: true });
}, SCENARIO_TIMEOUT_MS);

/** FM2R の I-1: 始められるプロファイルの認証の設定（手動のログイン。値は匿名）。 */
function authSetupOf(profileId: string): Record<string, unknown> {
  return {
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId,
    profileRevision: 1,
    loginStartUrl: `${ORIGIN}/login`,
    loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
    successCondition: { pathPrefix: '/admin', selector: null },
    sessionLostCondition: { pathPrefix: null },
    excludedPaths: ['/admin/logout'],
    auditPathPrefixes: ['/admin'],
    maxLoginAttempts: 1,
    allowedIdpOrigins: [],
    automatedLogin: null,
  };
}

/** テストだけの操作: 画面の path の READ の確かめの定義を 1 つ、管理データに書く（候補の要らない形）。 */
function writeReadCheckDefinition(profileId: string): void {
  const database = openControlDatabase(resolveControlDatabasePath(root?.root ?? ''));
  try {
    expect(createReadCheck(database, {
      readCheckId: 'fm2d-read-1', profileId, at: '20261023000000',
      definition: { targetPagePath: '/admin/search', parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    }).ok).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
}

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

const label = (kind: keyof typeof AUDIT_JOB_KIND_CATALOG): string => AUDIT_JOB_KIND_CATALOG[kind].label;

describe('FM2d: the chained run on the start screen', () => {
  it('shows the stages for the test modes (and not for the public audit), with the reason why it cannot start yet', async () => {
    const auth = await openPage(`/start/${AUTH_PROFILE}`);
    const panel = auth.getByTestId('start-stage-chain');
    await panel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await panel.getByRole('heading', { name: LOCAL_UI_STAGE_CHAIN_TEXT.start.heading }).count()).toBe(1);
    expect(await panel.getByTestId('start-stage-chain-stages').locator('li').allTextContents())
      .toEqual([label('AUDIT'), label('DISCOVERY'), label('READ_CHECK')]);
    // 認証の設定がないので、始められない理由を出し、開始のボタンを出さない。
    expect(await panel.getByText(LOCAL_UI_STAGE_CHAIN_TEXT.start.cannotStartHeading).count()).toBe(1);
    expect(await panel.getByTestId('start-stage-chain-submit').count()).toBe(0);
    // 上の開始の欄と同じ理由（認証の設定がない）なので、理由の本文とリンクを繰り返さず、短い文だけを出す（印と説明とリンクは画面に 1 つずつ）。
    expect(await auth.getByTestId('start-reason').count()).toBe(1);
    expect(await panel.getByTestId('start-reason').count()).toBe(0);
    expect(await panel.getByTestId('start-stage-chain-reason').count()).toBe(0);
    expect(await panel.getByTestId('start-stage-chain-same-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await panel.getByTestId('start-stage-chain-same-reason').textContent()).toBe(LOCAL_UI_STAGE_CHAIN_TEXT.start.sameReasonAsAbove);
    expect(await auth.getByText(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_MISSING.description).count()).toBe(1);
    expect(await auth.getByTestId('start-open-auth-setup').count()).toBe(1);
    expect(await panel.getByTestId('start-stage-chain-open-auth-setup').count()).toBe(0);

    // 書き込みのモードは、上の欄（監査）と連鎖の欄（発見から）の理由が違うので、連鎖の欄に、別の印の理由とリンクを出す。
    const write = await openPage(`/start/${WRITE_PROFILE}`);
    const writePanel = write.getByTestId('start-stage-chain');
    await writePanel.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await writePanel.getByTestId('start-stage-chain-stages').locator('li').allTextContents()).toEqual([label('DISCOVERY'), label('READ_CHECK')]);
    expect(await write.getByTestId('start-reason').getAttribute('data-reason')).toBe('MODE_NOT_EXECUTABLE');
    expect(await writePanel.getByTestId('start-stage-chain-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await writePanel.getByTestId('start-stage-chain-same-reason').count()).toBe(0);
    expect(await writePanel.getByTestId('start-stage-chain-open-auth-setup').count()).toBe(1);
    expect(await write.getByTestId('start-open-auth-setup').count()).toBe(0);

    const publicPage = await openPage(`/start/${PUBLIC_PROFILE}`);
    await publicPage.getByTestId('start-profile').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await publicPage.getByTestId('start-stage-chain').count()).toBe(0);
  }, SCENARIO_TIMEOUT_MS);

  it('returns the chain of the start summary, and rejects the start without making a job', async () => {
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: AUTH_PROFILE })).toMatchObject({
      chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], blocker: 'AUTH_SETUP_MISSING' },
    });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: WRITE_PROFILE })).toMatchObject({
      chain: { stages: ['DISCOVERY', 'READ_CHECK'], blocker: 'AUTH_SETUP_MISSING' },
    });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: PUBLIC_PROFILE })).toMatchObject({ chain: null });

    expect(await valueOf('startStageChainFn', 'POST', { profileId: PUBLIC_PROFILE, expectedRevision: 1, startNew: false }))
      .toMatchObject({ ok: false, reason: 'MODE_NOT_EXECUTABLE' });
    expect(await valueOf('startStageChainFn', 'POST', { profileId: AUTH_PROFILE, expectedRevision: 1, startNew: true }))
      .toMatchObject({ ok: false, reason: 'AUTH_SETUP_MISSING' });
    expect((await call('startStageChainFn', 'POST', { profileId: AUTH_PROFILE, expectedRevision: 1 })).response.status).toBe(STATUS.BAD_REQUEST);
    expect(await valueOf('listAuditJobsFn', 'GET')).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  // FM2R の I-1: READ の段の定義の件数は、まとめて実行の開始の確かめに入れない（0 件は「行わなかった」で、止める理由にしない）。開始のボタンは押さない
  // （押すと、本物のログインの段が始まる）。
  it('can start the chain of a ready profile with no READ definition and with one', async () => {
    for (const definitions of [0, 1]) {
      if (definitions === 1) {
        writeReadCheckDefinition(READY_PROFILE);
      }
      expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: READY_PROFILE }), `${definitions} definitions`)
        .toMatchObject({ blocker: null, chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], blocker: null } });
      const page = await openPage(`/start/${READY_PROFILE}`);
      const panel = page.getByTestId('start-stage-chain');
      await panel.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await panel.getByTestId('start-stage-chain-submit').isEnabled(), `${definitions} definitions`).toBe(true);
      expect(await panel.getByText(LOCAL_UI_STAGE_CHAIN_TEXT.start.cannotStartHeading).count()).toBe(0);
    }
  }, SCENARIO_TIMEOUT_MS);
});

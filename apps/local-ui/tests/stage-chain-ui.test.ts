/**
 * FM2d（設計書 `doc/design/2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: 開始の画面のまとめて実行と、開始の Server Function
 * （`startStageChainFn`）を、ビルドした画面のサーバ（一時の root）と headless の Chromium で確かめる。ワーカーは起動しない（どの場面も、開始の前の確かめで
 * 拒まれるか、開始のボタンを押さない）。サイトへは接続しない。値は匿名（ループバック）。
 * - PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 3、3 章の 1、4 章の 4）: 開始の画面は、要点のパネル（何が起きるかの 1〜2 行、主のボタン
 *   「点検を始める」1 つ）と、詳しい内容 1 つ。まとめて実行のできるモード（`TEST_AUTH_PASSIVE` と `TEST_APPROVED_WRITE`。どちらも監査 → 発見 → READ の
 *   確かめ）では、主のボタンがまとめて実行を始める（前は「監査を始める」と「まとめて実行する」の 2 つのボタン）。公開の監査は点検だけ。ステップの並びは
 *   詳しい内容に出す。始められない理由（認証の設定がない）は、要点に 1 回だけ出し、主のボタンを出さない。主のボタンの数と axe の違反 0 を確かめる。
 * - 開始の Server Function: 入力の形が違えば 400。公開の監査は `MODE_NOT_EXECUTABLE`、認証の設定がなければ `AUTH_SETUP_MISSING`。拒んだらジョブを作らない。
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createReadCheck } from '../../../src/control/job/read-check-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { AUDIT_JOB_KIND_CATALOG } from '../../../src/presentation/catalog.js';
import { AUDIT_JOB_START_REJECTION_DESCRIPTIONS, LOCAL_UI_AUDIT_TEXT, LOCAL_UI_TEXT } from '../../../src/presentation/messages.js';
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
import { saveAuthSetupRequestInStore } from './helpers/profile-store-setup.ts';
import { axeViolationsOf, expectAtMostOnePrimaryButton, primaryButtonLabelsInMain } from './helpers/screen-shape.ts';

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
  expect(await saveAuthSetupRequestInStore(root, { setup: authSetupOf(READY_PROFILE) })).toMatchObject({ ok: true });
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
  /** 開始の画面の主のボタン（要点のパネルの「点検を始める」。始めるものは `data-kind`）。 */
  const submitOf = (page: Page) => page.getByTestId('start-summary').getByTestId('start-submit');

  // PL-3（判断 3、3 章の 1）: 主のボタンは「点検を始める」1 つで、まとめて実行を始める。ステップの並びは詳しい内容。始められない理由は要点に 1 回だけ。
  it('shows one start of the chain for the test modes (and the audit only for the public audit), with the reason why it cannot start yet', async () => {
    const auth = await openPage(`/start/${AUTH_PROFILE}`);
    const summary = auth.getByTestId('start-summary');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await summary.getAttribute('data-start-kind')).toBe('STAGE_CHAIN');
    expect(await auth.getByTestId('start-what-happens').textContent()).toBe(LOCAL_UI_AUDIT_TEXT.start.whatHappens.STAGE_CHAIN);
    // ステップの並びは、たたんだ詳しい内容の中（1 つだけ）。
    expect(await auth.locator('main details').count()).toBe(1);
    expect(await auth.getByTestId('start-advanced-settings').locator('summary').textContent()).toBe(LOCAL_UI_TEXT.advancedSettings.summary);
    expect(await auth.getByTestId('start-advanced-settings').getByTestId('start-stage-chain-stages').locator('li').allTextContents())
      .toEqual([label('AUDIT'), label('DISCOVERY'), label('READ_CHECK')]);
    // 認証の設定がないので、始められない理由を要点に 1 回だけ出し、主のボタンを出さない（前の 2 つ目の欄「まとめて実行する」はない）。
    expect(await submitOf(auth).count()).toBe(0);
    expect(await auth.getByTestId('start-reason').count()).toBe(1);
    expect(await summary.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await auth.getByText(AUDIT_JOB_START_REJECTION_DESCRIPTIONS.AUTH_SETUP_MISSING.description).count()).toBe(1);
    expect(await auth.getByTestId('start-open-auth-setup').count()).toBe(1);
    expect(await auth.getByTestId('start-stage-chain').count()).toBe(0);
    expect(await auth.getByTestId('start-stage-chain-reason').count()).toBe(0);
    // 直す道のリンクは二次の見た目（主のボタンは出さない）。
    expect(await primaryButtonLabelsInMain(auth)).toEqual([]);
    expect(await axeViolationsOf(auth)).toEqual([]);

    // MI-5: 書き込みのモードも、監査から始める連鎖。
    const write = await openPage(`/start/${WRITE_PROFILE}`);
    await write.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await write.getByTestId('start-summary').getAttribute('data-start-kind')).toBe('STAGE_CHAIN');
    expect(await write.getByTestId('start-stage-chain-stages').locator('li').allTextContents())
      .toEqual([label('AUDIT'), label('DISCOVERY'), label('READ_CHECK')]);
    expect(await write.getByTestId('start-reason').count()).toBe(1);
    expect(await write.getByTestId('start-reason').getAttribute('data-reason')).toBe('AUTH_SETUP_MISSING');
    expect(await write.getByTestId('start-open-auth-setup').count()).toBe(1);
    expect(await axeViolationsOf(write)).toEqual([]);

    // 公開の画面だけのサイトは、まとめて実行の段がないので点検だけ（ステップの並びも出さない）。
    const publicPage = await openPage(`/start/${PUBLIC_PROFILE}`);
    await publicPage.getByTestId('start-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await publicPage.getByTestId('start-summary').getAttribute('data-start-kind')).toBe('AUDIT_ONLY');
    expect(await publicPage.getByTestId('start-what-happens').textContent()).toBe(LOCAL_UI_AUDIT_TEXT.start.whatHappens.AUDIT_ONLY);
    expect(await publicPage.getByTestId('start-stage-chain-stages').count()).toBe(0);
    expect(await submitOf(publicPage).getAttribute('data-kind')).toBe('AUDIT_ONLY');
    expect(await primaryButtonLabelsInMain(publicPage)).toEqual([LOCAL_UI_AUDIT_TEXT.start.submit]);
    // まだ点検していないので、始め方（続きから・新しく）の選択を出さない（4 章の 4）。
    expect(await publicPage.locator('input[name="start-mode"]').count()).toBe(0);
    expect(await axeViolationsOf(publicPage)).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  it('returns the chain of the start summary, and rejects the start without making a job', async () => {
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: AUTH_PROFILE })).toMatchObject({
      chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], blocker: 'AUTH_SETUP_MISSING' },
    });
    // MI-5: 書き込みのモードも、監査 → 発見 → READ の確かめ。
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: WRITE_PROFILE })).toMatchObject({
      chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], blocker: 'AUTH_SETUP_MISSING' },
    });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: PUBLIC_PROFILE })).toMatchObject({ chain: null, primaryStart: { kind: 'AUDIT_ONLY', blocker: null } });

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
      expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: READY_PROFILE }), `${definitions} definitions`).toMatchObject({
        blocker: null,
        chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'], blocker: null },
        primaryStart: { kind: 'STAGE_CHAIN', blocker: null },
      });
      const page = await openPage(`/start/${READY_PROFILE}`);
      const submit = submitOf(page);
      await submit.waitFor({ timeout: UI_TIMEOUT_MS });
      // PL-3（判断 3）: 主のボタン「点検を始める」1 つが、まとめて実行を始める。
      expect(await submit.isEnabled(), `${definitions} definitions`).toBe(true);
      expect(await submit.getAttribute('data-kind'), `${definitions} definitions`).toBe('STAGE_CHAIN');
      expect(await page.getByText(LOCAL_UI_AUDIT_TEXT.start.cannotStartHeading).count()).toBe(0);
      expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_AUDIT_TEXT.start.submit]);
      await expectAtMostOnePrimaryButton(page);
      expect(await axeViolationsOf(page)).toEqual([]);
    }
  }, SCENARIO_TIMEOUT_MS);
});

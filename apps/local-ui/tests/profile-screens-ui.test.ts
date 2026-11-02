/**
 * PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、4 章の 1・7、6 章の 1〜6 の段、13 章の 12）: サイトの一覧・作成・詳細の画面の形を、
 * ビルドした画面のサーバ（一時の root）と headless の Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。
 * - どの状態でも、main の主のボタンは 1 つまで（`expectAtMostOnePrimaryButton`）、アクセシビリティの違反 0（`axeViolationsOf`）。
 * - 詳細: 見える塊は要点のパネルと詳しい内容の 2 つ（詳しい内容は閉じている）。主のボタンは段で決まる（入口の確かめの前・後、手でのログインの点検の後、
 *   自動ログインの後、間隔の中、停止、書き込みのモード、公開の画面）。ログインの確かめの画面への入口は、停止のときだけ。
 * - 一覧: 空のときは要点の 1 行の直下に主のボタン「サイトを足す」。行があるときも主のボタンは 1 つで、行のボタンは「続ける」（詳細と同じ段の文）。
 * - 作成: 見える入力は開始のアドレス・使い方・保存の 3 つ（隔離の扱いの 2 択と、たたんだ詳しい設定はない）。
 * 状態は、テストだけの操作で管理データに書く（プロファイル・認証の設定は保存の部品、ジョブの行と自動ログインの試しはジョブの管理の部品。ワーカーは起動しない。
 * サイトへは接続しない）。自動ログインの状態は、資格情報を本物の DPAPI で保存するので Windows だけ。値は匿名（ループバック）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../../src/control/auth/auth-setup-contracts.js';
import { createCredentialStore } from '../../../src/control/credentials/credential-store.js';
import { recordAutoLoginResult } from '../../../src/control/job/auto-login-store.js';
import { createStartingJob, recordFinished, recordRunStarted } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_JOB_SUMMARY_TEXT, LOCAL_UI_NEXT_STEP_TEXT, LOCAL_UI_TEXT } from '../../../src/presentation/messages.js';

/** OP-1: 「書き込みも試す」のボタンは、確認のダイアログ（変えずに戻る・書き込みにも使う）と一緒に要点の欄に置かれる。 */
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { outputDirectoryOf, publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import { createTemporaryUiRoot, findFreePort, startLauncher, stopServer, type StartedServer, type TemporaryUiRoot } from './helpers/local-server.ts';
import { createProfileInStore, saveAuthSetupInStore } from './helpers/profile-store-setup.ts';
import { chooseProfileUsage } from './helpers/profile-form.ts';
import { axeViolationsOf, expectAtMostOnePrimaryButton, primaryButtonLabelsInMain } from './helpers/screen-shape.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

const IS_WINDOWS = process.platform === 'win32';
const SKIP_REASON = 'the automated login states save the credential with the real DPAPI, which exists only on Windows';
const UI_TIMEOUT_MS = 20_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const MAX_PAGES = 3;
const FIRST_REVISION = 1;
const TEST_ORIGIN = 'http://127.0.0.1:9';
const ADMIN_PATH = '/admin';

/** 状態ごとのプロファイル（名前は状態の短い名前）。 */
const PROFILES = Object.freeze({
  entry: 'pl1-entry',
  audit: 'pl1-audit',
  after: 'pl1-after',
  write: 'pl1-write',
  public: 'pl1-public',
  automated: 'pl1-automated',
  wait: 'pl1-wait',
  held: 'pl1-held',
  resultManual: 'plu-result-manual',
  resultPublic: 'plu-result-public',
});

const text = LOCAL_UI_NEXT_STEP_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;

const started = (): StartedServer => {
  if (server === undefined) throw new Error('サーバが起動していない');
  return server;
};
const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) throw new Error('一時の root がない');
  return root;
};

const { openPage, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
});

/** 管理データを開いて 1 回書く（テストだけの操作）。 */
const withDatabase = <T>(write: (database: ReturnType<typeof openControlDatabase>) => T): T => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    return write(database);
  } finally {
    closeControlDatabase(database);
  }
};

const now = (): string => formatCompactUtcTimestamp(new Date(), 'test job time');

/**
 * 終わった点検のジョブの行を書く（ワーカーの代わり）。`autoLogin` があれば、自動ログインの試しを、その結果で記録する（成功なら間隔の中、送った失敗なら停止）。
 */
const writeFinishedAudit = (
  profileId: string,
  autoLogin: { readonly result: 'SUCCEEDED' | 'INVALID_CREDENTIALS' } | null,
  /** PL-U: 点検の報告（`report.html`）を置く、設定の出力先のフォルダ（一時の root からの相対）。省けば報告はない。 */
  reportOutputDirectory?: string,
): string => {
  const jobId = `job-${profileId}-${randomUUID().slice(0, 8)}`;
  const runId = 'RUN-20261026000000';
  withDatabase((database) => {
    const createdAt = now();
    expect(createStartingJob(database, {
      jobId, jobKind: 'AUDIT', profileId, profileRevision: FIRST_REVISION, startNew: true, createdAt,
      ...(autoLogin === null ? {} : { autoLoginAttempt: { credentialRevision: 1 } }),
    }, () => null)).toEqual({ ok: true });
    if (autoLogin !== null) {
      expect(recordAutoLoginResult(database, { jobId, result: autoLogin.result, submitted: 'YES', retryAfterUntil: null, at: createdAt }))
        .toMatchObject({ recorded: true });
    }
    expect(recordRunStarted(database, jobId, { runId: runId as never, runDirectory: runId, startedAt: createdAt })).toBe(true);
    expect(recordFinished(database, jobId, { kind: 'RAN', exitCode: 0, runId: runId as never, runDirectory: runId, runStatus: 'COMPLETE' }, now()))
      .toBe(true);
  });
  if (reportOutputDirectory !== undefined) {
    const runDirectory = join(rootOf().root, reportOutputDirectory, runId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, 'report.html'), '<!doctype html><html lang="ja"><head><title>r</title></head><body></body></html>', 'utf8');
  }
  return jobId;
};

/** テスト用のサイトのプロファイル（手でログイン・自動ログイン・書き込みのモード）。 */
const testProfileOf = (profileId: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  schemaVersion: 'beaksight-profile/1', profileId, revision: FIRST_REVISION, targetConfigPath: `config/targets/${profileId}.json`,
  environment: 'TEST', mode: 'TEST_AUTH_PASSIVE', auth: 'MANUAL_SESSION', approvedTestOrigins: [TEST_ORIGIN], environmentEvidenceRef: `${profileId}-evidence`,
  ...overrides,
});

/** フォームで送るログインの認証の設定（入口の確かめの後に、BeakSight が案で保存した形）。`automated` なら自動ログインのセレクタも。 */
const formSetupOf = (profileId: string, automated: boolean): Record<string, unknown> => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/auth`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
  successCondition: { pathPrefix: ADMIN_PATH, selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/auth/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 1,
  allowedIdpOrigins: [],
  automatedLogin: automated
    ? {
      usernameSelector: '#email',
      passwordSelector: '#password',
      submitSelector: '#login',
      failureConditions: { invalidCredentials: { pathPrefix: '/auth', selector: null }, accountLocked: null, mfaRequired: null, credentialExpired: null },
    }
    : null,
});

/** テスト用のサイトのプロファイルを作り、認証の設定を保存する（`setup` が偽なら、入口の確かめの前で設定はない）。 */
const createTestProfile = async (profileId: string, options: { readonly setup: boolean; readonly overrides?: Readonly<Record<string, unknown>> }): Promise<void> => {
  writeAuthTargetConfig(rootOf().root, profileId, TEST_ORIGIN, ADMIN_PATH, MAX_PAGES);
  expect(await createProfileInStore(rootOf().root, testProfileOf(profileId, options.overrides))).toMatchObject({ ok: true });
  if (options.setup) {
    const automated = options.overrides?.['auth'] === 'AUTOMATED_LOGIN';
    expect(await saveAuthSetupInStore(rootOf().root, formSetupOf(profileId, automated))).toMatchObject({ ok: true });
  }
};

/** サイトの画面を開き、要点のパネルを待つ。 */
const openProfile = async (profileId: string): Promise<Page> => {
  const page = await openPage(`/profiles/${profileId}`);
  await page.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
};

/** 3 章の形の共通の確かめ（主のボタン 1 つまで、axe の違反 0、見える塊は要点と詳しい内容の 2 つで、詳しい内容は閉じている）。 */
const expectScreenShape = async (page: Page, label: string): Promise<void> => {
  await expectAtMostOnePrimaryButton(page);
  expect(await axeViolationsOf(page), label).toEqual([]);
  expect(await page.locator('main > section:visible').count(), label).toBe(2);
  expect(await page.getByTestId('profile-edit-advanced-settings').evaluate((element) => (element as HTMLDetailsElement).open), label).toBe(false);
};

/** 要点のパネルの段と、見えているボタンの名前（主のボタン → 二次のボタン）。 */
const summaryOf = async (page: Page): Promise<{ readonly stage: string | null; readonly buttons: readonly string[]; readonly primary: readonly string[] }> => {
  const summary = page.getByTestId('profile-summary');
  return {
    stage: await summary.getAttribute('data-stage'),
    buttons: (await summary.locator('[data-testid="profile-summary-actions"] .button').allTextContents()).map((label) => label.trim()),
    primary: await primaryButtonLabelsInMain(page),
  };
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('PL-1: the site list and the create screen', () => {
  it('empty list: one line of what the tool does, and the primary button right below it (13 の 12)', async () => {
    const page = await openPage('/');
    const summary = page.getByTestId('profile-list-summary');
    await summary.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await summary.locator('p').first().textContent()).toBe(LOCAL_UI_TEXT.profileList.intro);
    expect(await page.getByTestId('profile-list-empty').textContent()).toBe(LOCAL_UI_TEXT.profileList.empty);
    expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_TEXT.profileList.newProfile]);
    expect(await page.getByTestId('profile-list').count()).toBe(0);
    expect(await axeViolationsOf(page)).toEqual([]);
  });

  it('create: the visible inputs are the start address, the usage and the save button only (no isolation choice, no folded settings)', async () => {
    const page = await openPage('/profiles/new');
    const form = page.getByRole('main').locator('form');
    await form.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await form.locator('input:visible:not([type="radio"]), select:visible, textarea:visible').evaluateAll((items) => items.map((item) => item.getAttribute('name'))))
      .toEqual(['startUrl']);
    expect(await form.locator('input[type="radio"]:visible').evaluateAll((items) => [...new Set(items.map((item) => item.getAttribute('name')))]))
      .toEqual(['usage']);
    expect(await form.locator('button:visible').allTextContents()).toEqual([LOCAL_UI_TEXT.profileForm.saveAndCheckEntry]);
    expect(await form.locator('details').count()).toBe(0);
    expect(await page.getByTestId('profile-isolation').count()).toBe(0);
    await expectAtMostOnePrimaryButton(page);
    expect(await axeViolationsOf(page)).toEqual([]);
    // OP-1 修正の 2 回目（OP 設計書 4.1.3 の 3。設計者の判断「公開のサイトも点検を始める 1 つ」。前は「保存する」）: ログインしなくても見られるサイトを選んでも、
    // ボタンは「点検を始める」1 つで、主のボタン。
    await chooseProfileUsage(page, 'PUBLIC', UI_TIMEOUT_MS);
    await expect.poll(() => page.getByTestId('profile-save-entry-check-note').textContent(), { timeout: UI_TIMEOUT_MS })
      .toBe(LOCAL_UI_TEXT.profileForm.saveAndCheckEntryNotePublic);
    expect(await form.locator('button:visible').allTextContents()).toEqual([LOCAL_UI_TEXT.profileForm.saveAndCheckEntry]);
    await expectAtMostOnePrimaryButton(page);
    expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_TEXT.profileForm.saveAndCheckEntry]);
    expect(await axeViolationsOf(page)).toEqual([]);
  });
});

describe('PL-1: the site screen follows the stage', () => {
  beforeAll(async () => {
    await createTestProfile(PROFILES.entry, { setup: false });
    await createTestProfile(PROFILES.audit, { setup: true });
    await createTestProfile(PROFILES.after, { setup: true });
    writeFinishedAudit(PROFILES.after, null);
    await createTestProfile(PROFILES.write, { setup: true, overrides: { mode: 'TEST_APPROVED_WRITE' } });
    const publicPath = writeAuditTargetConfig(rootOf().root, PROFILES.public, TEST_ORIGIN, { minNavigationIntervalMs: 0, screenshots: false });
    expect(await createProfileInStore(rootOf().root, publicProfileDocument(PROFILES.public, publicPath))).toMatchObject({ ok: true });
  }, SCENARIO_TIMEOUT_MS);

  it('before the entry check: re-check the entry is the only primary button, no audit and no login check', async () => {
    const page = await openProfile(PROFILES.entry);
    expect(await summaryOf(page)).toEqual({ stage: 'ENTRY_NOT_CHECKED', buttons: [text.actions.RECHECK_ENTRY], primary: [text.actions.RECHECK_ENTRY] });
    expect(await page.getByTestId('profile-stage').textContent()).toBe(text.stages.ENTRY_NOT_CHECKED);
    expect(await page.getByRole('main').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(0);
    expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
    await expectScreenShape(page, PROFILES.entry);
  });

  it('after the entry check: start the audit, and neither the automated login nor the write mode yet (4 の 1)', async () => {
    const page = await openProfile(PROFILES.audit);
    expect(await summaryOf(page)).toEqual({
      stage: 'AUDIT_MANUAL_LOGIN', buttons: [text.actions.AUDIT_START], primary: [text.actions.AUDIT_START],
    });
    // 同じ行き先の重なりがない（点検を始めるは 1 か所）。自動ログインと書き込みの入口は、詳しい内容にもまだない。
    expect(await page.locator('main a[href$="/start/pl1-audit"]').count()).toBe(1);
    expect(await page.locator('main [data-action="AUTOMATED_LOGIN_SETUP"], main [data-action="WRITE_MODE_SWITCH"]').count()).toBe(0);
    expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
    await expectScreenShape(page, PROFILES.audit);
  });

  // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5。08 の指摘）: 「次から自動でログインする」はなくした。ID とパスワードの画面は、詳しい内容の中の
  // 直す道。OP-2（4.1.1 の D7'）: 「書き込みも試す」もなくした（書き込みは「登録・更新を試せる画面」の一覧のチェック）。手でログインした点検の後は、点検の段のまま。
  it('after a manual audit: the audit is the primary button (no "write too"), the credential screen is in the details', async () => {
    const page = await openProfile(PROFILES.after);
    expect(await summaryOf(page)).toEqual({
      stage: 'AUDIT_AGAIN',
      buttons: [text.actions.AUDIT_START],
      primary: [text.actions.AUDIT_START],
    });
    expect(await page.getByTestId('profile-detail-actions').locator('[data-action="CREDENTIAL"]').count()).toBe(1);
    await expectScreenShape(page, PROFILES.after);
    // 詳しい内容を開いても、主のボタンは 1 つのまま（中のボタンは二次の見た目）。
    await page.getByTestId('profile-edit-advanced-settings').locator('summary').click();
    await expectAtMostOnePrimaryButton(page);
  });

  // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'）: 書き込みの手順の画面は、ふだんの流れから外した（詳しい内容の直す道）。書き込みの
  // モードのサイトも、ほかのサイトと同じ点検の段（点検がまだなら、点検を始める）。
  it('write mode: the same audit stage as the other sites (the write scenarios are in the details)', async () => {
    const page = await openProfile(PROFILES.write);
    expect(await summaryOf(page)).toEqual({
      stage: 'AUDIT_MANUAL_LOGIN', buttons: [text.actions.AUDIT_START], primary: [text.actions.AUDIT_START],
    });
    expect(await page.getByTestId('profile-detail-actions').locator('[data-action="SCENARIOS"]').count()).toBe(1);
    await expectScreenShape(page, PROFILES.write);
  });

  it('public site: start the audit', async () => {
    const page = await openProfile(PROFILES.public);
    expect(await summaryOf(page)).toEqual({ stage: 'AUDIT_PUBLIC', buttons: [text.actions.AUDIT_START], primary: [text.actions.AUDIT_START] });
    await expectScreenShape(page, PROFILES.public);
  });

  it('the list: the only primary button is "add a site", each row has "continue" with the same stage as the site screen', async () => {
    const page = await openPage('/');
    await page.getByTestId('profile-list').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await primaryButtonLabelsInMain(page)).toEqual([LOCAL_UI_TEXT.profileList.newProfile]);
    const expected: Readonly<Record<string, string>> = {
      [PROFILES.entry]: 'ENTRY_NOT_CHECKED',
      [PROFILES.audit]: 'AUDIT_MANUAL_LOGIN',
      // OP-1（D5）: 「次から自動でログインする」の段はなくした。
      // OP-2: 「書き込みも試す」と「書き込みの手順へ」の段もなくした。
      [PROFILES.after]: 'AUDIT_AGAIN',
      [PROFILES.write]: 'AUDIT_MANUAL_LOGIN',
      [PROFILES.public]: 'AUDIT_PUBLIC',
    };
    for (const [profileId, stage] of Object.entries(expected)) {
      const row = page.locator(`tr[data-profile-id="${profileId}"]`);
      expect(await row.getByTestId('profile-row-next').getAttribute('data-stage'), profileId).toBe(stage);
      expect(await row.getByRole('link', { name: text.continue }).getAttribute('href'), profileId).toBe(`/profiles/${profileId}`);
      // 行に点検の開始やログインの確かめへの直接のボタンはない。
      expect(await row.locator('a[href*="/start/"], a[href*="/login-check/"]').count(), profileId).toBe(0);
    }
    expect(await axeViolationsOf(page)).toEqual([]);
  });

  // OP-I（I3。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5、`2026-10-26-beaksight-plain-ui-design.md` 13 章の 5）: サイトの一覧の表は、幅 1280 でも
  // 390 でも、本文の幅に収まる（横のスクロールが出ない）。「次にすること」の列の文は切れない（折り返して全部見える）。
  it.each([[1280, 800], [390, 844]] as const)('the list: the table fits in the content at the width %i, and the next step text is not cut', async (width, height) => {
    const page = await openPage('/');
    await page.setViewportSize({ width, height });
    await page.getByTestId('profile-list').waitFor({ timeout: UI_TIMEOUT_MS });
    const measured = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="profile-list"]') as HTMLElement;
      const wrap = table.parentElement as HTMLElement;
      const content = table.closest('main') as HTMLElement;
      const nextTexts = [...document.querySelectorAll('[data-testid="profile-row-next"] p')] as HTMLElement[];
      return {
        tableWidth: table.getBoundingClientRect().width,
        wrapWidth: wrap.clientWidth,
        wrapScrollWidth: wrap.scrollWidth,
        contentRight: content.getBoundingClientRect().right,
        tableRight: table.getBoundingClientRect().right,
        pageScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        cutTexts: nextTexts.filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.textContent),
        nextTextCount: nextTexts.length,
      };
    });
    expect(measured.nextTextCount).toBeGreaterThan(0);
    expect(measured.wrapScrollWidth, JSON.stringify(measured)).toBeLessThanOrEqual(measured.wrapWidth);
    expect(measured.tableWidth, JSON.stringify(measured)).toBeLessThanOrEqual(measured.wrapWidth + 1);
    expect(measured.tableRight, JSON.stringify(measured)).toBeLessThanOrEqual(measured.contentRight + 1);
    expect(measured.pageScrollWidth, JSON.stringify(measured)).toBeLessThanOrEqual(measured.viewportWidth);
    expect(measured.cutTexts).toEqual([]);
    expect(await axeViolationsOf(page)).toEqual([]);
  });
});

// PL-U（設計書 14.1 の U2、13 章の 13）: 点検を終えたばかりで移ってきたときと、最新の点検の結果があって次の段の操作がないときは、主のボタンを「結果を
// 見る」にする。次の段の操作は二次のボタンにし、押し出された二次のボタンは詳しい内容に移す（ボタンは増やさない）。
describe('PL-U: the result of the audit on the site screen', () => {
  let arrivedJobId = '';

  beforeAll(async () => {
    await createTestProfile(PROFILES.resultManual, { setup: true });
    arrivedJobId = writeFinishedAudit(PROFILES.resultManual, null, `t25e-output-${PROFILES.resultManual}`);
    const publicPath = writeAuditTargetConfig(rootOf().root, PROFILES.resultPublic, TEST_ORIGIN, { minNavigationIntervalMs: 0, screenshots: false });
    expect(await createProfileInStore(rootOf().root, publicProfileDocument(PROFILES.resultPublic, publicPath))).toMatchObject({ ok: true });
    writeFinishedAudit(PROFILES.resultPublic, null, outputDirectoryOf(PROFILES.resultPublic));
  }, SCENARIO_TIMEOUT_MS);

  it('right after the audit: "see the result" is the primary button, the next stage is the secondary one, the audit start is in the details', async () => {
    const page = await openPage(`/profiles/${PROFILES.resultManual}?arrived=auto&fromJob=${arrivedJobId}`);
    await page.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    // OP-2: 次の段の操作（前の「書き込みも試す」）はなくしたので、二次のボタンは点検を始める。
    expect(await summaryOf(page)).toEqual({
      stage: 'AUDIT_AGAIN',
      buttons: [text.actions.AUDIT_RESULT, text.actions.AUDIT_START],
      primary: [text.actions.AUDIT_RESULT],
    });
    const result = page.getByTestId('profile-summary').locator('[data-action="AUDIT_RESULT"]');
    expect(await result.getAttribute('href')).toMatch(/report\.html$/u);
    expect(await result.getAttribute('target')).toBe('_blank');
    // 要点の 1 行目は、移ってきた点検の結果の 1 行。
    expect(await page.getByTestId('profile-arrival').textContent()).toBe(LOCAL_UI_JOB_SUMMARY_TEXT.finished.AUDIT_COMPLETE);
    // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 「点検が終わりました」を 2 行続けて出さない（段の文は、次にすることだけ）。
    expect((await page.getByTestId('profile-summary').textContent() ?? '').split('終わりました').length - 1).toBe(1);
    expect(await page.getByTestId('profile-stage').textContent()).toBe(text.afterAuditArrival.AUDIT_AGAIN);
    const details = page.getByTestId('profile-detail-actions');
    expect(await details.locator('[data-action="AUDIT_START"]').count()).toBe(0);
    expect(await page.locator('main [data-action="WRITE_MODE_SWITCH"]').count()).toBe(0);
    await expectScreenShape(page, `${PROFILES.resultManual} arrived`);
    // 移ってきた印がなければ、今どおり次の段の操作が主のボタン（結果を見るは出さない）。
    const plain = await openProfile(PROFILES.resultManual);
    expect(await summaryOf(plain)).toEqual({
      stage: 'AUDIT_AGAIN',
      buttons: [text.actions.AUDIT_RESULT, text.actions.AUDIT_START],
      primary: [text.actions.AUDIT_RESULT],
    });
    // 移ってきた印がなければ、段の文は前回の点検が終わったことから言う。
    expect(await plain.getByTestId('profile-stage').textContent()).toBe(text.stages.AUDIT_AGAIN);
  });

  it('nothing next: "see the result" is the primary button and the audit start the secondary one', async () => {
    const page = await openProfile(PROFILES.resultPublic);
    expect(await summaryOf(page)).toEqual({
      stage: 'AUDIT_AGAIN',
      buttons: [text.actions.AUDIT_RESULT, text.actions.AUDIT_START],
      primary: [text.actions.AUDIT_RESULT],
    });
    await expectScreenShape(page, PROFILES.resultPublic);
  });
});

describe('PL-1: the automated login states (the login check is out of the flow)', () => {
  beforeAll(async () => {
    if (!IS_WINDOWS) return;
    const credentials = createCredentialStore(rootOf().root);
    for (const profileId of [PROFILES.automated, PROFILES.wait, PROFILES.held]) {
      await createTestProfile(profileId, { setup: true, overrides: { auth: 'AUTOMATED_LOGIN' } });
      await credentials.register({ profileId, loginOrigin: TEST_ORIGIN, username: `pl1-user-${randomUUID()}`, password: `pl1-pass-${randomUUID()}` });
    }
    // 切り替えの前の、手でのログインの点検（自動ログインの試しの記録はない）。
    writeFinishedAudit(PROFILES.automated, null);
    // 自動ログインの点検が成功した直後（5 分の間隔の中）と、送った後に失敗した（止めた）点検。
    writeFinishedAudit(PROFILES.wait, { result: 'SUCCEEDED' });
    writeFinishedAudit(PROFILES.held, { result: 'INVALID_CREDENTIALS' });
  }, SCENARIO_TIMEOUT_MS);

  it.skipIf(!IS_WINDOWS)(`after the switch: start the audit (no login check step) (${SKIP_REASON} otherwise)`, async () => {
    const page = await openProfile(PROFILES.automated);
    expect(await summaryOf(page)).toEqual({
      stage: 'AUDIT_AUTOMATED_LOGIN', buttons: [text.actions.AUDIT_START], primary: [text.actions.AUDIT_START],
    });
    expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
    await expectScreenShape(page, PROFILES.automated);
  });

  it.skipIf(!IS_WINDOWS)(`within the interval: no primary button, and the summary says when it can start (${SKIP_REASON} otherwise)`, async () => {
    const page = await openProfile(PROFILES.wait);
    expect(await summaryOf(page)).toEqual({ stage: 'AUTO_LOGIN_WAIT', buttons: [], primary: [] });
    const when = page.getByTestId('profile-next-allowed-at');
    expect(await when.getAttribute('data-next-allowed-at')).not.toBe('');
    // この場面には報告がない（`writeFinishedAudit` の報告の出力先を省いた）ので、OP-G の「報告があれば待ちの間も『結果を見る』を主のボタンにする」には
    // 当たらず、主のボタンはないまま（上の確かめ）。
    const whenText = (await when.textContent()) ?? '';
    expect(whenText).toMatch(/から始められます。$/u);
    // OP-G（意図して直した期待）: 待ちの文と始められる時刻を 1 行にまとめた（カタログの `autoLoginWaitUntil`）。前と後ろはカタログの文と同じ。
    const [waitHead = '', waitTail = ''] = text.autoLoginWaitUntil('\u0000').split('\u0000');
    expect(waitHead.length).toBeGreaterThan(0);
    expect(waitTail).toBe(' から始められます。');
    expect(whenText.startsWith(waitHead)).toBe(true);
    expect(whenText.endsWith(waitTail)).toBe(true);
    // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 時刻は「10 月 27 日 15:30」の形（年・秒・JST を書かない）。
    expect(whenText.slice(waitHead.length, whenText.length - waitTail.length)).toMatch(/^\d{1,2} 月 \d{1,2} 日 \d{1,2}:\d{2}$/u);
    expect(await page.locator('main a[href*="/login-check/"]').count()).toBe(0);
    await expectScreenShape(page, PROFILES.wait);
  });

  it.skipIf(!IS_WINDOWS)(`held: no primary button, the reason, and the way to clear the hold (${SKIP_REASON} otherwise)`, async () => {
    const page = await openProfile(PROFILES.held);
    expect(await summaryOf(page)).toEqual({ stage: 'AUTO_LOGIN_HELD', buttons: [text.actions.CLEAR_HOLD], primary: [] });
    expect(await page.getByTestId('profile-stage').textContent()).toBe(text.stages.AUTO_LOGIN_HELD);
    expect(await page.locator('main a[href$="/login-check/pl1-held"]').count()).toBe(1);
    await expectScreenShape(page, PROFILES.held);
  });
});

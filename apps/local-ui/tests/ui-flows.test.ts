/**
 * 画面の操作の確かめ（Task 23 設計書 4.7、7 章「画面」。T23f）。ビルドした画面を一時の root の起動の部品で起動し、Playwright の headless の
 * Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。
 * - 一覧が空の表示、キーボードだけでの登録、一覧での表示、誤りの表示（画面の確かめ、Task 22 の検証）、更新、改訂の衝突、
 *   キーボードだけでの取り消し（ダイアログ。フォーカスの閉じ込めと戻り）、画面のサーバを起動し直しても残っていること。
 * - すべてのページで、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。
 * - 管理データは一時の root の `local-data/` にだけできる。設定のファイルは `config/targets/example.json` の写しだけ（`local/` を使わない）。
 */
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_MODE_CATALOG, PROFILE_STATUS_CATALOG } from '../../../src/presentation/catalog.js';
import {
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_TEXT,
  PROFILE_STORE_REJECTION_DESCRIPTIONS,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import {
  EXAMPLE_TARGET_CONFIG,
  createTemporaryUiRoot,
  findFreePort,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 40;
/** テストの値（匿名）。 */
const PROFILE_ID = 'example-keyboard';

const text = LOCAL_UI_TEXT;

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};

/** 記録つきのページ（CSP の違反、console の誤り、外部への要求。CCX-16 の共通の補助）と、Tab だけのフォーカスの移動。 */
const { records, openPage, tabTo, expectCleanAndClosePages } = createUiPageKit({
  contextOf: () => context,
  originOf: () => started().origin,
  maxTabPresses: MAX_TAB_PRESSES,
  requireCspRecord: true,
});

const startServerOnRoot = async (): Promise<void> => {
  if (root === undefined || browser === undefined) {
    throw new Error('準備ができていない');
  }
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  // token の URL から開いて cookie を受け取る（303 で token のない URL へ移る）。
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  expect(page.url()).toBe(`${server.origin}/`);
  await page.close();
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  browser = await launchHeadlessChromium();
  await startServerOnRoot();
});

afterEach(async () => {
  await expectCleanAndClosePages();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('local UI: profiles', () => {
  it('shows the empty list and the menu (T24f: with the run history)', async () => {
    const page = await openPage('/');
    expect(await page.locator('h1').textContent()).toBe(text.pages.profiles);
    await page.getByTestId('profile-list-empty').waitFor();
    expect(await page.getByTestId('profile-list-empty').textContent()).toBe(text.profileList.empty);
    expect(await page.getByRole('navigation', { name: text.navigationLabel }).getByRole('link').allTextContents())
      .toEqual([text.pages.profiles, LOCAL_UI_AUDIT_TEXT.pages.jobs, text.pages.environment]);
  });

  it('registers a profile with the keyboard only, after a client-side error, and lists it', async () => {
    const page = await openPage('/');
    await tabTo(page, page.getByRole('link', { name: text.profileList.newProfile }));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/profiles\/new$/u);
    await page.getByLabel(text.profileForm.profileId).waitFor();

    // 名前の形の誤り（画面の側の補助の確かめ）。
    await tabTo(page, page.getByLabel(text.profileForm.profileId));
    await page.keyboard.type('Not Valid');
    await tabTo(page, page.getByLabel(text.profileForm.targetConfigPath));
    await page.keyboard.press('ArrowDown');
    await page.getByText(text.profileForm.configOk).waitFor({ timeout: UI_TIMEOUT_MS });
    await tabTo(page, page.getByRole('button', { name: text.profileForm.save }));
    await page.keyboard.press('Enter');
    await page.getByText(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_ID_INVALID).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByLabel(text.profileForm.profileId).getAttribute('aria-invalid')).toBe('true');

    await tabTo(page, page.getByLabel(text.profileForm.profileId));
    await page.keyboard.press('Control+A');
    await page.keyboard.type(PROFILE_ID);
    expect(await page.getByLabel(text.profileForm.targetConfigPath).inputValue()).toBe(EXAMPLE_TARGET_CONFIG);
    await tabTo(page, page.getByRole('button', { name: text.profileForm.save }));
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/profiles/${PROFILE_ID}`, 'u'), { timeout: UI_TIMEOUT_MS });
    await page.getByText(text.profileForm.created).waitFor();
    expect(await page.getByTestId('profile-revision').textContent()).toBe(text.profileForm.revisionText(1));

    const list = await openPage('/');
    const row = list.locator(`tr[data-profile-id="${PROFILE_ID}"]`);
    await row.waitFor();
    expect(await row.textContent()).toContain(AUDIT_MODE_CATALOG.PUBLIC_PASSIVE.label);
    expect(await row.textContent()).toContain(PROFILE_STATUS_CATALOG.ACTIVE.label);
    // T24f: 「最後の Run」の欄は、まだジョブがないことを示し、実行できるプロファイルには「監査を始める」を置く。
    expect(await row.getByTestId('last-run').textContent()).toContain(LOCAL_UI_AUDIT_TEXT.profileList.lastRunNone);
    expect(await row.getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(1);
  });

  // T25e（T25d の申し送り 1）: 認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）は、認証の設定があれば開始できるモードになった。選ぶと、認証の
  // 設定を作ってから始める案内を出す（今は実行できないという案内は出さない）。承認した書き込みの監査は、今も実行できないという案内を出す。
  it('shows the Task 22 error on the field, the auth setup notice for TEST_AUTH_PASSIVE and the not-yet-executable notice for TEST_APPROVED_WRITE', async () => {
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    await page.getByLabel(text.profileForm.mode).selectOption('TEST_APPROVED_WRITE');
    await page.getByText(text.profileForm.testModeNotice).waitFor();
    // T28b（Task 28 の設計書 4.5）: 書き込みのモードも、発見と READ の確かめのために認証の設定を使うので、認証の設定の案内も出す。
    expect(await page.getByTestId('profile-auth-setup-notice').textContent()).toBe(LOCAL_UI_AUTH_TEXT.profileFormNotice);
    await page.getByLabel(text.profileForm.mode).selectOption('TEST_AUTH_PASSIVE');
    await page.getByTestId('profile-auth-setup-notice').waitFor();
    expect(await page.getByTestId('profile-auth-setup-notice').textContent()).toBe(LOCAL_UI_AUTH_TEXT.profileFormNotice);
    expect(await page.getByText(text.profileForm.testModeNotice).count()).toBe(0);
    await page.getByRole('button', { name: text.profileForm.save }).click();
    await page.getByText(PROFILE_STORE_REJECTION_DESCRIPTIONS.PROFILE_INVALID.description).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByText(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_MODE_ENVIRONMENT_MISMATCH).waitFor();
    expect(await page.getByLabel(text.profileForm.mode).getAttribute('aria-invalid')).toBe('true');
    expect(await page.getByTestId('profile-revision').textContent()).toBe(text.profileForm.revisionText(1));
  });

  it('updates the profile, and explains a revision conflict with a reload', async () => {
    const first = await openPage(`/profiles/${PROFILE_ID}`);
    const second = await openPage(`/profiles/${PROFILE_ID}`);
    await first.getByRole('button', { name: text.profileForm.save }).click();
    await first.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await first.getByTestId('profile-revision').textContent()).toBe(text.profileForm.revisionText(2));

    await second.getByRole('button', { name: text.profileForm.save }).click();
    await second.getByText(PROFILE_STORE_REJECTION_DESCRIPTIONS.PROFILE_REVISION_CONFLICT.description).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await second.getByTestId('profile-revision').textContent()).toBe(text.profileForm.revisionText(1));
    await second.getByRole('button', { name: text.reload }).click();
    await second.getByTestId('profile-revision').filter({ hasText: text.profileForm.revisionText(2) }).waitFor({ timeout: UI_TIMEOUT_MS });
  });

  it('retires the profile with the keyboard only through the confirmation dialog (focus is trapped and returned)', async () => {
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    const opener = page.getByRole('button', { name: text.retireDialog.open });
    await tabTo(page, opener);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: text.retireDialog.title });
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain(text.retireDialog.body);
    // 開いたときは「やめる」にフォーカス。Escape で閉じると、開いたボタンにフォーカスが戻る。
    expect(await dialog.getByRole('button', { name: text.retireDialog.cancel }).evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);

    await page.keyboard.press('Enter');
    await dialog.waitFor();
    // フォーカスはダイアログの中に閉じ込められる（Tab を何回押しても外に出ない）。
    for (let count = 0; count < 4; count += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await tabTo(page, dialog.getByRole('button', { name: text.retireDialog.confirm }));
    await page.keyboard.press('Enter');
    await page.getByText(text.retireDialog.done).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByTestId('profile-status').filter({ hasText: PROFILE_STATUS_CATALOG.RETIRED.label }).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByTestId('profile-revision').textContent()).toBe(text.profileForm.revisionText(3));
    await page.getByText(text.profileForm.retiredNotice).waitFor();
    expect(await page.getByRole('button', { name: text.profileForm.save }).count()).toBe(0);
  });

  it('keeps the profiles after the server restarts', async () => {
    await context?.close();
    await stopServer(server);
    await startServerOnRoot();
    const page = await openPage('/');
    const row = page.locator(`tr[data-profile-id="${PROFILE_ID}"]`);
    await row.waitFor();
    expect(await row.textContent()).toContain(PROFILE_STATUS_CATALOG.RETIRED.label);
  });

  it('shows the environment status', async () => {
    const page = await openPage('/environment');
    const status = await page.getByTestId('environment-status').textContent();
    expect(status).toContain('local-data/beaksight-control.sqlite');
    expect(status).toContain(text.environmentStatus.listeningValue);
    expect(status).toContain(text.environmentStatus.quickCheckOk);
  });

  it('shows the not-found page inside the shell (the document itself answers 404)', async () => {
    const page = await openPage('/does-not-exist');
    expect(await page.locator('h1').textContent()).toBe(text.notFound.title);
    expect(await page.getByRole('navigation', { name: text.navigationLabel }).count()).toBe(1);
    // 文書そのものの 404 は、ブラウザが console に出す（画面の誤りではない）。それ以外の誤りはないこと。
    const record = records.at(-1);
    const notFoundMessages = record?.consoleErrors.filter((message) => /status of 404/u.test(message)) ?? [];
    expect(notFoundMessages).toHaveLength(1);
    record?.consoleErrors.splice(0, record.consoleErrors.length, ...record.consoleErrors.filter((message) => !/status of 404/u.test(message)));
  });
});

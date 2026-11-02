/**
 * 画面の操作の確かめ（Task 23 設計書 4.7、7 章「画面」。T23f）。ビルドした画面を一時の root の起動の部品で起動し、Playwright の headless の
 * Chromium（`tests/helpers/chromium.ts` の既定）で、token の URL から開く。
 * - 一覧が空の表示、キーボードだけでの登録、一覧での表示、誤りの表示（画面の確かめ、Task 22 の検証）、更新、改訂の衝突、
 *   キーボードだけでの取り消し（ダイアログ。フォーカスの閉じ込めと戻り）、画面のサーバを起動し直しても残っていること。
 * - すべてのページで、CSP の違反と console の誤りが 0 件、外部への要求が 0 件。
 * - 管理データは一時の root の `local-data/` にだけできる。設定のファイルは、一時の root に置いたものだけ（`local/` を使わない）。
 */
import { writeFileSync } from 'node:fs';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_MODE_CATALOG } from '../../../src/presentation/catalog.js';
import {
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_TEXT,
  PROFILE_STORE_REJECTION_DESCRIPTIONS,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  TARGET_SITE_PROBLEM_DESCRIPTIONS,
} from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import {
  createTemporaryUiRoot,
  findFreePort,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { auditJobStateDisplay } from '../src/display/labels';
import { openProfileAdvancedSettings } from './helpers/profile-form.ts';
import { readProfileInStore } from './helpers/profile-store-setup.ts';
import { createUiPageKit } from './helpers/ui-page.ts';

/** 画面の操作を待つ上限（ミリ秒）。 */
const UI_TIMEOUT_MS = 15_000;
/** OP-1 修正の 2 回目: 作成の画面が始めた下調べが終わり、サイトの画面へ移るまでを待つ上限（ミリ秒。`start-url-onboarding-ui.test.ts` と同じ）。 */
const JOB_TIMEOUT_MS = 60_000;
/** フォーカスを Tab で動かす回数の上限。 */
const MAX_TAB_PRESSES = 40;
/**
 * テストの値（匿名）。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面に名前の欄はなく、名前は開始のアドレスから決まる。一時の root の
 * 設定のファイルの開始のアドレスを入れると、そのファイルを使い、名前はホスト名からの案になる。OP-1 修正の 2 回目（OP 設計書 4.1.3 の 3。設計者の判断「公開のサイトも
 * 点検を始める 1 つ」）: 作成の画面の「点検を始める」で、下調べが実際に開始のページを読みに行くので、どこにも接続しない予約の名前の設定のファイルを、一時の root の
 * `config/targets/` に置いて使う（前は `config/targets/example.json` の `https://example.com/` だった）。
 */
const START_URL = 'https://ui-flows.example.test/';
const PROFILE_ID = 'ui-flows-example-test';
const EXAMPLE_TARGET_CONFIG = 'config/targets/ui-flows.json';

/** 管理データのプロファイルの改訂（PL-1: サイトの画面に改訂を出さなくなったので、管理データから読む）。 */
const revisionOf = (): number | undefined => readProfileInStore(root, PROFILE_ID)?.profile.revision;

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
  writeFileSync(`${root.root}/${EXAMPLE_TARGET_CONFIG}`, `${JSON.stringify({ target: { id: 'ui-flows' }, site: { startUrl: START_URL, allowedOrigins: [new URL(START_URL).origin] } })}
`, 'utf8');
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
  it('shows the empty list and the menu (T24f: with the run history. T43a: with "new profile")', async () => {
    const page = await openPage('/');
    expect(await page.locator('h1').textContent()).toBe(text.pages.profiles);
    await page.getByTestId('profile-list-empty').waitFor();
    expect(await page.getByTestId('profile-list-empty').textContent()).toBe(text.profileList.empty);
    // T43a（Task 43 の設計書 4.1。ユーザーの確認）: 左のメニューに「新しいプロファイル」を足した（意図した期待の変更）。
    // PL-V（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 14）: メニューは 3 つ。環境の状態は、問題があるときだけ出す（意図した期待の変更）。
    expect(await page.getByRole('navigation', { name: text.navigationLabel }).getByRole('link').allTextContents())
      .toEqual([text.pages.profiles, text.pages.newProfile, LOCAL_UI_AUDIT_TEXT.pages.jobs]);
  });

  it('registers a profile with the keyboard only, after a client-side error, and lists it', async () => {
    const page = await openPage('/');
    // T43a: 左のメニューにも同じ名前のリンクがあるので、本文（一覧の上の帯）のリンクを選ぶ。
    await tabTo(page, page.getByRole('main').getByRole('link', { name: text.profileList.newProfile }));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/profiles\/new$/u);
    await page.getByLabel(text.profileForm.startUrl, { exact: true }).waitFor();

    // MI-1（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: 使い方は「公開の画面だけ」にする（キーボードだけ: 使い方の radio で下の
    // 矢印を押す。既定は「ログインして読む」）。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面の見える入力は、開始のアドレス・
    // 使い方・保存の 3 つだけ（名前と選び方の欄は消した。前はたたんだ詳しい設定で名前の形の誤りを確かめていたので、開始のアドレスの形の誤りで確かめる）。
    await tabTo(page, page.getByLabel(text.profileForm.usageTestAuth, { exact: true }));
    await page.keyboard.press('ArrowDown');
    expect(await page.getByLabel(text.profileForm.usagePublic, { exact: true }).isChecked()).toBe(true);

    // 開始のアドレスの形の誤り（画面の側の補助の確かめ）。
    await tabTo(page, page.getByLabel(text.profileForm.startUrl, { exact: true }));
    await page.keyboard.type('not a url');
    // OP-1 修正の 2 回目（前は「保存する」）: ログインしなくても見られるサイトも、作成の画面のボタンは「点検を始める」1 つ。
    await tabTo(page, page.getByRole('button', { name: text.profileForm.saveAndCheckEntry }));
    await page.keyboard.press('Enter');
    await page.getByText(TARGET_SITE_PROBLEM_DESCRIPTIONS.START_URL_INVALID).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await page.getByLabel(text.profileForm.startUrl, { exact: true }).getAttribute('aria-invalid')).toBe('true');

    // 一時の root の設定のファイルの開始のアドレスを入れると、そのファイルを使い、名前は開始のアドレスから決まる。
    await tabTo(page, page.getByLabel(text.profileForm.startUrl, { exact: true }));
    await page.keyboard.press('Control+A');
    await page.keyboard.type(START_URL);
    await tabTo(page, page.getByRole('button', { name: text.profileForm.saveAndCheckEntry }));
    await page.keyboard.press('Enter');
    // OP-1 修正の 2 回目（前は、保存だけでサイトの画面へ移り、保存の知らせを出した）: 保存に続けて下調べの作業の画面へ移る。下調べは開始のページを開けない（予約の
    // 名前）ので、ジョブの管理は点検を始めず、作業の画面がサイトの画面へ移す。
    await page.waitForURL(/\/jobs\/[^/]+$/u, { timeout: UI_TIMEOUT_MS });
    const entryJobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    await page.waitForURL(new RegExp(`/profiles/${PROFILE_ID}\?`, 'u'), { timeout: JOB_TIMEOUT_MS });
    expect(readProfileInStore(root, PROFILE_ID)?.profile).toMatchObject({ revision: 1, targetConfigPath: EXAMPLE_TARGET_CONFIG });

    const list = await openPage('/');
    const row = list.locator(`tr[data-profile-id="${PROFILE_ID}"]`);
    await row.waitFor();
    expect(await row.textContent()).toContain(AUDIT_MODE_CATALOG.PUBLIC_PASSIVE.label);
    // T24f: 「前回の点検」の欄は、最後の作業を示す（OP-1 修正の 2 回目: 前は、まだジョブがないこと。今は、作成の画面の押下で始めた下調べの作業。その作業の状態と、
    // その作業へのリンク）。PL-1（設計書 3 章、4 章の 1）: 行のボタンは「続ける」1 つ（行き先はサイトの画面。点検を始めるは、サイトの画面の主のボタンの 1 か所）。
    // 状態の列は出さない（取り消した行は段の文で分かる）。
    expect(await row.getByTestId('last-run').textContent()).not.toContain(LOCAL_UI_AUDIT_TEXT.profileList.lastRunNone);
    expect(await row.getByTestId('last-run-state').textContent()).toBe(auditJobStateDisplay('FINISHED').label);
    expect(await row.getByTestId('last-run').getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.lastRunDetail }).getAttribute('href'))
      .toBe(`/jobs/${entryJobId}`);
    expect(await row.getByTestId('profile-row-next').getAttribute('data-stage')).toBe('AUDIT_PUBLIC');
    expect(await row.getByRole('link', { name: LOCAL_UI_NEXT_STEP_TEXT.continue }).count()).toBe(1);
    expect(await row.getByRole('link', { name: LOCAL_UI_AUDIT_TEXT.profileList.startAudit }).count()).toBe(0);
  });

  // T25e（T25d の申し送り 1）: 認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）は、認証の設定があれば開始できるモードになった。選ぶと、認証の
  // 設定を作ってから始める案内を出す（今は実行できないという案内は出さない）。MI-5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.5）:
  // 承認した書き込みのモードも監査を始められるようになったので、今は実行できないという案内は、どのモードでも出さない（前は書き込みのモードで出した）。
  it('shows the Task 22 error on the field, and the auth setup notice for TEST_AUTH_PASSIVE and TEST_APPROVED_WRITE without the not-yet-executable notice', async () => {
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    // MI-1: 編集の欄は、プロファイルの詳細のたたんだ「詳しい設定」の中にある。
    await openProfileAdvancedSettings(page, UI_TIMEOUT_MS);
    await page.getByLabel(text.profileForm.mode).selectOption('TEST_APPROVED_WRITE');
    // T28b（Task 28 の設計書 4.5）: 書き込みのモードも、発見と READ の確かめのために認証の設定を使うので、認証の設定の案内も出す。MI-1 の D: 「今は
    // 実行できない」の案内は、文言ごとカタログから消した（`auth-display.test.ts`）。
    await page.getByTestId('profile-auth-setup-notice').waitFor();
    expect(await page.getByTestId('profile-auth-setup-notice').textContent()).toBe(LOCAL_UI_AUTH_TEXT.profileFormNotice);
    await page.getByLabel(text.profileForm.mode).selectOption('TEST_AUTH_PASSIVE');
    await page.getByTestId('profile-auth-setup-notice').waitFor();
    expect(await page.getByTestId('profile-auth-setup-notice').textContent()).toBe(LOCAL_UI_AUTH_TEXT.profileFormNotice);
    // T43a fix round 1（Task 43 の設計書 4.1）: モードを選ぶと、環境は組み合わせの表の初めの値（テスト環境）に合う。利用者が公開の環境に戻して
    // 保存すると、保存の検証（Task 22）が組み合わせの誤りで止める（意図した手順の変更。期待は変えない）。
    // 「環境」は「テスト環境の Origin」などにも部分一致するので、ラベルは完全一致で選ぶ。
    expect(await page.getByLabel(text.profileForm.environment, { exact: true }).inputValue()).toBe('TEST');
    await page.getByLabel(text.profileForm.environment, { exact: true }).selectOption('PUBLIC');
    await page.getByRole('button', { name: text.profileForm.save }).click();
    await page.getByText(PROFILE_STORE_REJECTION_DESCRIPTIONS.PROFILE_INVALID.description).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.getByText(PROFILE_VALIDATION_ERROR_DESCRIPTIONS.PROFILE_MODE_ENVIRONMENT_MISMATCH).waitFor();
    expect(await page.getByLabel(text.profileForm.mode).getAttribute('aria-invalid')).toBe('true');
    expect(revisionOf()).toBe(1);
  });

  it('updates the profile, and explains a revision conflict with a reload', async () => {
    const first = await openPage(`/profiles/${PROFILE_ID}`);
    const second = await openPage(`/profiles/${PROFILE_ID}`);
    await openProfileAdvancedSettings(first, UI_TIMEOUT_MS);
    await openProfileAdvancedSettings(second, UI_TIMEOUT_MS);
    await first.getByRole('button', { name: text.profileForm.save }).click();
    await first.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(revisionOf()).toBe(2);

    await second.getByRole('button', { name: text.profileForm.save }).click();
    await second.getByText(PROFILE_STORE_REJECTION_DESCRIPTIONS.PROFILE_REVISION_CONFLICT.description).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(revisionOf()).toBe(2);
    // PL-1: 改訂は画面に出さないので、読み込み直した後は、今の改訂の内容で保存し直せることで確かめる（拒否の知らせが消え、保存すると次の改訂になる）。
    await second.getByRole('button', { name: text.reload }).click();
    await second.getByText(PROFILE_STORE_REJECTION_DESCRIPTIONS.PROFILE_REVISION_CONFLICT.description).waitFor({ state: 'detached', timeout: UI_TIMEOUT_MS });
    await openProfileAdvancedSettings(second, UI_TIMEOUT_MS);
    await second.getByRole('button', { name: text.profileForm.save }).click();
    await second.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
    expect(revisionOf()).toBe(3);
  });

  // DEF-137（DEF-128 と同じ揺らぎ）: 保存の知らせは、画面の改訂が保存した改訂（search の `savedRevision`）に届いたときだけ出す（古い値のまま「更新しました」を
  // 出さない）。改訂がまだ届いていない URL では知らせを出さず、届いた URL では出す。
  it('shows the saved notice only when the revision on the screen reached the saved revision', async () => {
    const ahead = await openPage(`/profiles/${PROFILE_ID}?saved=updated&savedRevision=1000`);
    await ahead.getByTestId('profile-summary').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await ahead.getByText(text.profileForm.updated).count()).toBe(0);
    const reached = await openPage(`/profiles/${PROFILE_ID}?saved=updated&savedRevision=1`);
    await reached.getByText(text.profileForm.updated).waitFor({ timeout: UI_TIMEOUT_MS });
  });

  it('retires the profile with the keyboard only through the confirmation dialog (focus is trapped and returned)', async () => {
    const page = await openPage(`/profiles/${PROFILE_ID}`);
    // PL-1（設計書 3 章の 1）: 取り消しは、サイトの画面の詳しい内容の中（キーボードだけ: 見出しで Enter を押して開く）。
    await tabTo(page, page.getByTestId('profile-edit-advanced-settings').locator('summary'));
    await page.keyboard.press('Enter');
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
    await page.locator('[data-testid="profile-summary"][data-stage="SITE_RETIRED"]').waitFor({ timeout: UI_TIMEOUT_MS });
    expect(readProfileInStore(root, PROFILE_ID)).toMatchObject({ status: 'RETIRED', profile: { revision: 4 } });
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
    expect(await row.getByTestId('profile-row-next').getAttribute('data-stage')).toBe('SITE_RETIRED');
    expect(await row.textContent()).toContain(LOCAL_UI_NEXT_STEP_TEXT.listStages.SITE_RETIRED);
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

/**
 * 画面のテストの補助: サイトの作成の画面と、サイトの画面の詳しい内容（T43b で作り、MI-1・PL-1 で直した）。
 * - MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: プロファイルの詳細の編集の欄は、たたんだ「詳しい設定」の中にある。
 * - PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 6 章の 1）: 作成の画面の見える入力は、開始のアドレス・使い方・保存の 3 つだけになった
 *   （隔離の扱いの 2 択と、たたんだ詳しい設定の名前・選び方・設定のファイルなどの欄は消した）。名前は開始のアドレスから決まり、設定のファイルは、開始のアドレスと
 *   同じ設定のファイルが 1 つあればそれを使う。決まらないときだけ、保存の拒否の知らせの中で、使うファイルか新しく作るかを選ぶ（`createProfileOnScreen`）。
 *   サイトの画面の詳しい内容（要点のパネルの下の 1 つ）も、同じ「詳しい設定」の部品。
 */
import type { Page } from 'playwright';
import { LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';
import { openAdvancedSettings } from './advanced-settings.ts';

/** サイトの画面の詳しい内容（たたんだ「詳しい設定」）の目印。 */
const PROFILE_ADVANCED_SETTINGS = Object.freeze(['profile-edit-advanced-settings']);

/**
 * サイトの画面で、たたんだ詳しい内容を開く（開いていれば何もしない）。MI-C: 開き方は共通の補助 `advanced-settings.ts` の `openAdvancedSettings`（ここは
 * 目印を渡すだけ）。
 */
export const openProfileAdvancedSettings = (page: Page, timeoutMs: number): Promise<void> =>
  openAdvancedSettings(page, PROFILE_ADVANCED_SETTINGS, timeoutMs);

/** MI-1: 作成の画面の使い方の 2 択を選ぶ（既定は「ログインして読む（テスト環境）」）。 */
export const chooseProfileUsage = async (page: Page, usage: 'TEST_AUTH' | 'PUBLIC', timeoutMs: number): Promise<void> => {
  const text = LOCAL_UI_TEXT.profileForm;
  await page.getByLabel(usage === 'PUBLIC' ? text.usagePublic : text.usageTestAuth, { exact: true }).check({ timeout: timeoutMs });
};

/** 作成の画面の入力。 */
export interface ProfileOnScreen {
  readonly startUrl: string;
  readonly usage: 'TEST_AUTH' | 'PUBLIC';
  /**
   * 同じサイトの設定のファイルが決まらなかったとき（保存の拒否の知らせの中の選択）に選ぶ設定のファイル（省略は、選択が出たら止める）。
   */
  readonly targetConfigPath?: string;
}

/**
 * PL-1: 作成の画面で、開始のアドレスと使い方を入れて保存する（保存のボタンの名前は使い方で変わる）。保存の拒否の知らせに対象の設定の選択が出たら、
 * `targetConfigPath` を選んで保存し直す。保存の後の画面（サイトの画面か、入口の確かめの作業の画面）への移りは、呼び出し側が待つ。
 */
export const createProfileOnScreen = async (page: Page, input: ProfileOnScreen, timeoutMs: number): Promise<void> => {
  const text = LOCAL_UI_TEXT.profileForm;
  await page.getByLabel(text.startUrl, { exact: true }).fill(input.startUrl, { timeout: timeoutMs });
  await chooseProfileUsage(page, input.usage, timeoutMs);
  const save = page.getByRole('main').locator('form button[type="submit"]');
  const startPath = new URL(page.url()).pathname;
  await save.click({ timeout: timeoutMs });
  if (input.targetConfigPath === undefined) {
    return;
  }
  // 保存の後に画面が移るか、拒否の知らせの選択が出るかを待つ。
  const choice = page.getByTestId('profile-target-choice');
  await Promise.race([
    choice.waitFor({ timeout: timeoutMs }),
    page.waitForURL((url) => url.pathname !== startPath, { timeout: timeoutMs }),
  ]);
  if (new URL(page.url()).pathname !== startPath) {
    return;
  }
  await choice.locator(`input[value="${input.targetConfigPath}"]`).check({ timeout: timeoutMs });
  await save.click({ timeout: timeoutMs });
};

/** 今の画面の URL の、サイトの画面のサイトの名前（`/profiles/<名前>`。サイトの画面でなければ止める）。 */
export const profileIdOfPage = (page: Page): string => {
  const match = /^\/profiles\/([^/]+)$/u.exec(new URL(page.url()).pathname);
  if (match?.[1] === undefined) {
    throw new Error(`not a site screen: ${page.url()}`);
  }
  return decodeURIComponent(match[1]);
};

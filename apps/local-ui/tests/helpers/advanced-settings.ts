/**
 * 画面のテストの補助（MI-6。設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.6）: たたんだ「詳しい設定」（共通の部品
 * `components/AdvancedSettings.tsx`）を、画面の目印（`data-testid`）で選んで開く（開いていれば何もしない）。SPEC-4: シナリオの作成と入力の規則の画面は
 * 外した。MI-C（MI-6 の報告の片付け）: 開き方はここの 1 か所だけにした。プロファイルの画面
 * （`profile-form.ts` の `openProfileAdvancedSettings`）と認証の設定の画面（`auth-setup-page.ts`）は、目印を渡してこれを呼ぶだけ。
 */
import type { Page } from 'playwright';
import { LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';

/**
 * 目印 `testId` の、たたんだ「詳しい設定」を開く（開いていれば何もしない）。目印を複数渡すと、画面にある最初のものを開く（作成の画面と詳細の編集のように、
 * どちらか一方だけが画面にあるとき）。
 */
export const openAdvancedSettings = async (page: Page, testId: string | readonly string[], timeoutMs: number): Promise<void> => {
  const details = typeof testId === 'string'
    ? page.getByTestId(testId)
    : page.locator(testId.map((id) => `[data-testid="${id}"]`).join(', ')).first();
  await details.waitFor({ state: 'attached', timeout: timeoutMs });
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await details.getByText(LOCAL_UI_TEXT.advancedSettings.summary, { exact: true }).first().click({ timeout: timeoutMs });
  }
};

/** PL-5 の修正の 1 回目: 見るだけの確かめの一覧と定義の画面の、たたんだ「詳しい内容」の目印。 */
export const READ_CHECK_ADVANCED_SETTINGS = 'read-check-advanced';
/**
 * 画面のテストの補助（T43b。Task 43 の設計書 4.2）: プロファイルの作成の画面で「すでにある設定のファイルを使う」を選び、設定のファイルを選ぶ。
 * T43b で作成の画面の最初の欄が「開始の URL」になったので、今までの「設定のファイルを選ぶ」流れのテストは、この補助で選び方を切り替える
 * （同じ手順を各テストに書かない）。
 */
import type { Page } from 'playwright';
import { LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';

/** 「すでにある設定のファイルを使う」を選び、設定のファイル `targetConfigPath` を選ぶ（選んだファイルの確かめは呼び出し側が待つ）。 */
export const chooseExistingTargetConfig = async (page: Page, targetConfigPath: string, timeoutMs: number): Promise<void> => {
  const text = LOCAL_UI_TEXT.profileForm;
  await page.getByLabel(text.targetSourceExisting, { exact: true }).check({ timeout: timeoutMs });
  const select = page.getByLabel(text.targetConfigPath, { exact: true });
  await select.waitFor({ timeout: timeoutMs });
  await select.selectOption(targetConfigPath);
};

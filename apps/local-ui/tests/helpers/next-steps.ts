/**
 * 画面のテストの補助（T43a fix round 1。発見事項 3(c)）: プロファイルの詳細の「次にすること」の欄を読む。`onboarding-ui-flows.test.ts` と
 * `credential-ui-flows.test.ts` が共用する（同じ読み方を 2 か所に書かない）。
 */
import type { Page } from 'playwright';

/** 「次にすること」の欄の、手順の順（認証の設定、資格情報、ログインの確かめ、監査の開始）の状態（`data-state` の値）。欄が出るまで待つ。 */
export const nextStepStatesOf = async (page: Page, timeoutMs: number): Promise<readonly (string | null)[]> => {
  const panel = page.getByTestId('profile-next-steps');
  await panel.waitFor({ timeout: timeoutMs });
  return panel.locator('[data-testid="next-step-state"]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-state')));
};

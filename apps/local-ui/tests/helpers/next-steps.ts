/**
 * 画面のテストの補助（T43a fix round 1 で作り、PL-1 で置き換えた）: サイトの画面の要点のパネルの段を読む。前の「次にすること」の表（手順ごとの状態）は、
 * PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）で、要点＋主のボタン 1 つに置き換えた。段の値は `display/next-steps.ts` の
 * `PROFILE_STAGES`。`onboarding-ui-flows.test.ts`・`credential-ui-flows.test.ts`・`entry-check-ui.test.ts` が共用する（同じ読み方を 2 か所に書かない）。
 */
import type { Page } from 'playwright';

/** サイトの画面の要点のパネルの段（`data-stage` の値）。パネルが出るまで待つ。 */
export const profileStageOf = async (page: Page, timeoutMs: number): Promise<string | null> => {
  const summary = page.getByTestId('profile-summary');
  await summary.waitFor({ timeout: timeoutMs });
  return summary.getAttribute('data-stage');
};

/** サイトの画面の要点のパネルの、見えているボタンとリンクの行き先（`data-action`。主のボタンが先）。 */
export const profileSummaryActionsOf = async (page: Page, timeoutMs: number): Promise<readonly (string | null)[]> => {
  const summary = page.getByTestId('profile-summary');
  await summary.waitFor({ timeout: timeoutMs });
  return summary.locator('[data-testid="profile-summary-actions"] [data-action]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-action')));
};

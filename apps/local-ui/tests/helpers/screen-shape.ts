/**
 * 画面の形の確かめの補助（PL-V。設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、13 章の 3 と最後の段落）。
 * PL-1〜4（画面の作り直し）の画面のテストが使う。
 * - 主のボタン（`.button--primary`）: 本文（`main`）の中で、見えている主のボタンは 1 つまで（`primaryButtonLabelsInMain` で見えているものの名前を
 *   取り、`expectAtMostOnePrimaryButton` で確かめる）。閉じたダイアログの中のボタンは見えないので数えない（開いたダイアログの確定のボタンは数える）。
 * - アクセシビリティの検査（axe。`@axe-core/playwright`。依存パッケージは製品の収集の部品 `src/evidence/accessibility-collector.ts` と同じもので、
 *   足していない）: 設計書 13 章の最後の段落の基準（wcag2a・wcag2aa・wcag22aa）の違反を、規則の ID と要素の HTML の一覧で返す。
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import { expect } from 'vitest';

/** 画面の主のボタンの class（`apps/local-ui/src/styles/app.css` の `.button--primary`）。 */
const PRIMARY_BUTTON_SELECTOR = 'main .button--primary';

/** 画面のアクセシビリティの検査の基準（設計書 13 章の最後の段落）。 */
/**
 * OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D6）: 前の隔離の注意（「このテスト用のサイトが本物のデータと分かれているか、まだ確かめて
 * いません」）の、文の一部。カタログからは消したので、画面に戻っていないことを、この語で確かめる。
 */
export const ISOLATION_NOTICE_FRAGMENT = '本物のデータと分かれているか';

export const SCREEN_AXE_TAGS: readonly string[] = Object.freeze(['wcag2a', 'wcag2aa', 'wcag22aa']);

/**
 * 前に各画面の一番下にあった戻るボタンの名前の形（「一覧に戻る」「サイトの画面に戻る」など。PL-V で今どこにいるかの 1 行へ移し、PL-T で語をカタログから
 * 消した）。本文（`main`）に、この形のリンクがないことを確かめる。
 */
const BACK_LINK_NAME = /に戻る$/;

/** 本文（`main`）の中の、前の戻るボタンの形のリンクの数（0 であるべき）。 */
export const backLinkCountInMain = async (page: Page): Promise<number> => page.getByRole('main').getByRole('link', { name: BACK_LINK_NAME }).count();

/** 開いている確認のダイアログ（modal）。 */
const OPEN_DIALOG_SELECTOR = 'main dialog[open]';

/**
 * 本文（`main`）の中で見えている主のボタンの名前（文字。上から順）。確認のダイアログが開いている間は、ダイアログの中だけを数える（後ろの画面は
 * 押せないため）。
 */
export const primaryButtonLabelsInMain = async (page: Page): Promise<readonly string[]> => {
  const openDialog = page.locator(OPEN_DIALOG_SELECTOR);
  const buttons = await openDialog.count() > 0 ? openDialog.locator('.button--primary') : page.locator(PRIMARY_BUTTON_SELECTOR);
  const labels: string[] = [];
  for (const button of await buttons.all()) {
    if (await button.isVisible()) {
      labels.push(((await button.textContent()) ?? '').trim());
    }
  }
  return labels;
};

/** 本文の中で見えている主のボタンが 1 つまで（3 章の 1）。超えたときは、見えているボタンの名前を出して失敗する。 */
export const expectAtMostOnePrimaryButton = async (page: Page): Promise<void> => {
  const labels = await primaryButtonLabelsInMain(page);
  expect(labels.length, `primary buttons in main: ${JSON.stringify(labels)}`).toBeLessThanOrEqual(1);
};

/** 画面のアクセシビリティの検査の違反（`<規則の ID>: <要素の HTML>` の一覧。違反がなければ空）。 */
export const axeViolationsOf = async (page: Page): Promise<readonly string[]> => {
  const results = await new AxeBuilder({ page }).withTags([...SCREEN_AXE_TAGS]).analyze();
  return results.violations.flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.html}`));
};

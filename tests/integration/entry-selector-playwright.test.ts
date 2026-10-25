// T43R-fix の M-4（Task 43 の設計書 7 章の T43R の行）: 入口の確かめの一意な CSS の部品（`entrySelectorCandidatesOf`）と、成功の画面のセレクタの案の部品
// （`successSelectorCandidatesOf`）が作る CSS は、認証の設定の欄として受ける形（`isAcceptedEntrySelector`）で、Playwright の `css=` の locator（自動ログインと
// 成功の確かめが使う `loginStageLocator` と同じ引き方）でも解釈でき、読んだ要素だけにちょうど 1 つ当たる。解釈できない形（`#\-` など）は案にしない。
// 23 通りの属性の値（レビュー T43R の確かめと同じ）を、テストの既定の Chromium と CLI の Chromium の両方で確かめる。
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAcceptedEntrySelector } from '../../src/control/entry-check.js';
import { entrySelectorCandidatesOf } from '../../src/discovery/entry-check-selectors.js';
import { successSelectorCandidatesOf } from '../../src/discovery/login-observation.js';
import { loginStageLocator } from '../../src/worker/login-stage-checks.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;

/** id の値（18 通り）と name の値（5 通り）。 */
const IDS = ['1st', 'p"w', '-9', 'a b', 'a:b', 'é', 'a\\b', '--x', '_', '😀', 'a]b', '-', 'x\u0001y', "a'b", 'a\tb', 'ünï', '#x', '.y'];
const NAMES = ['a"b', 'login[password]', 'a\\"b', "it's", 'x\ny'];
/** ログアウトの要素の属性の値（成功の画面のセレクタの案）。 */
const LOGOUT_IDS = ['logout', 'logout-btn', 'btnLogout', 'sign-out-link', '-logout', 'logout:button'];

describe.each(LAUNCHERS)('T43R-fix M-4: the CSS of the proposals works with the Playwright css= locator (%s)', (_label, launch) => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await launch();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  it('builds only CSS that the auth setup accepts and that the locator resolves to the read element only', async () => {
    const page = await (browser as Browser).newPage();
    try {
      await page.setContent('<div id="root"></div>');
      const cases = [
        ...IDS.map((value) => ({ attribute: 'id', value, build: () => entrySelectorCandidatesOf({ tag: 'input', id: value, name: '', type: '' }) })),
        ...NAMES.map((value) => ({ attribute: 'name', value, build: () => entrySelectorCandidatesOf({ tag: 'input', id: '', name: value, type: '' }) })),
        ...LOGOUT_IDS.map((value) => ({
          attribute: 'id', value, build: () => successSelectorCandidatesOf({ tag: 'input', id: value, name: '', type: '', href: '' }),
        })),
      ];
      expect(IDS.length + NAMES.length).toBe(23);
      const failures: string[] = [];
      let resolved = 0;
      for (const { attribute, value, build } of cases) {
        await page.evaluate(({ attribute: name, value: text }) => {
          const root = document.getElementById('root') as HTMLElement;
          root.innerHTML = '';
          const target = document.createElement('input');
          target.setAttribute(name, text);
          target.setAttribute('data-target', '1');
          root.appendChild(target);
          const decoy = document.createElement('input');
          decoy.setAttribute(name, `${text}x`);
          root.appendChild(decoy);
        }, { attribute, value });
        for (const selector of build().filter(isAcceptedEntrySelector)) {
          try {
            const locator = loginStageLocator(page, selector);
            const count = await locator.count();
            const target = count === 1 ? await locator.getAttribute('data-target') : null;
            if (count !== 1 || target !== '1') failures.push(`${JSON.stringify(value)} ${selector}: ${String(count)}`);
            else resolved += 1;
          } catch (error) {
            failures.push(`${JSON.stringify(value)} ${selector}: ${String(error).slice(0, 80)}`);
          }
        }
      }
      expect(failures).toEqual([]);
      expect(resolved).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});

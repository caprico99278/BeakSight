// TS-g（設計書 `2026-10-24-beaksight-test-suite-tiers-design.md` 6 章の TS-g の行。ユーザーの指示「テストでheadedで動作させているものはheadlessに
// 変えてもいい。監査本体はheadedのままで」）: テストの Chromium を headless にしても、製品の起動の既定は変えない。ワーカーの process の組み立ての本番の
// ログイン用の Browser の起動が渡す起動の設定を、起動の部品の差し替え（`vi.spyOn` の `chromium.launchPersistentContext`。本物の Browser は起動しない）で確かめる。
// - 手動のログインの段（`PRODUCTION_LOGIN_STAGE_DEPENDENCIES`）: 人が操作するので headed（`LOGIN_BROWSER_HEADLESS` は偽。Task 25 の設計書 4.4）。
// - 自動ログインの段（`PRODUCTION_AUTOMATED_LOGIN_STAGE_DEPENDENCIES`）: 人が操作しないので headless（Task 26 の設計書 4.4）。
// どちらも CLI の起動の設定（`chromiumLaunchOptions`）の値そのもの。ジョブのブラウザの表示（headed）の既定は、`worker-show-browser.test.ts`（`START` の
// `showJobBrowser`）と `control-store-display-settings-table.test.ts`（プロファイルの表示の設定の既定）が確かめる。
// EL-12: どちらも、外部のアプリの起動を止める起動の部品（`launchChromium`）で、一時のプロファイル（Preferences つき）を使って起動する。
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHROMIUM_PROFILE_DIRECTORY_PREFIX,
  CHROMIUM_PROFILE_PREFERENCES_PATH,
  chromiumLaunchOptions,
  externalLaunchBlockPreferences,
} from '../../src/browser/chromium-launch.js';
import {
  AUTOMATED_LOGIN_BROWSER_HEADLESS,
  PRODUCTION_AUTOMATED_LOGIN_STAGE_DEPENDENCIES,
  PRODUCTION_LOGIN_STAGE_DEPENDENCIES,
} from '../../src/worker/audit-worker-process.js';
import { LOGIN_BROWSER_HEADLESS } from '../../src/worker/authenticated-login.js';
import { fakePersistentChromium } from '../helpers/fake-persistent-chromium.js';

describe('TS-g: the production login browsers keep their launch settings (the tests run headless, the product does not change)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['the manual login stage (headed: a person operates the login page)', () => PRODUCTION_LOGIN_STAGE_DEPENDENCIES.launchLoginBrowser(), false],
    ['the automated login stage (headless: nobody operates it)', () => PRODUCTION_AUTOMATED_LOGIN_STAGE_DEPENDENCIES.launchAutomatedLoginBrowser(), true],
  ] as const)('launches %s with the CLI launch settings in a temporary profile', async (_label, launchLoginBrowser, headless) => {
    const fake = fakePersistentChromium();
    let preferences: unknown;
    const launch = vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async (directory) => {
      preferences = JSON.parse(readFileSync(join(String(directory), ...CHROMIUM_PROFILE_PREFERENCES_PATH), 'utf8'));
      return fake.context;
    });

    await expect(launchLoginBrowser()).resolves.toBe(fake.browser);

    expect(launch).toHaveBeenCalledTimes(1);
    const [directory, options] = launch.mock.calls[0] ?? [];
    expect(options).toEqual(chromiumLaunchOptions({ headless }));
    expect(options?.headless).toBe(headless);
    expect(String(directory).startsWith(join(tmpdir(), CHROMIUM_PROFILE_DIRECTORY_PREFIX))).toBe(true);
    expect(preferences).toEqual(externalLaunchBlockPreferences());
    // headed は既定の頁を残して最小化し、headless は閉じる。
    expect(fake.calls.includes('cdp:Browser.setWindowBounds:minimized')).toBe(!headless);
    expect(fake.calls.includes('page.close[0]')).toBe(headless);
    // 閉じたら、一時のプロファイルを消す。
    await fake.browser.close();
    await vi.waitFor(() => expect(existsSync(String(directory))).toBe(false));
  });

  it('names the defaults: the manual login browser is headed, the automated login browser is headless', () => {
    expect(LOGIN_BROWSER_HEADLESS).toBe(false);
    expect(AUTOMATED_LOGIN_BROWSER_HEADLESS).toBe(true);
  });
});

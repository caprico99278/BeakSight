/**
 * 画面のテストの補助（MI-3。設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 認証の設定の画面は、今の欄を全部、たたんだ「詳しい設定」
 * （`AdvancedSettings`。目印 `auth-setup-advanced-settings`）に入れた。欄に入れる・保存する前に、これで開く（開いていれば何もしない。開き方は共通の補助
 * `advanced-settings.ts` の `openAdvancedSettings`）。
 */
import type { Page } from 'playwright';
import { openAdvancedSettings } from './advanced-settings.ts';

/** 認証の設定の画面の、たたんだ「詳しい設定」の目印。 */
export const AUTH_SETUP_ADVANCED_SETTINGS = 'auth-setup-advanced-settings';

/** 認証の設定の画面の、たたんだ「詳しい設定」を開く（開いていれば何もしない）。 */
export const openAuthSetupAdvancedSettings = (page: Page, timeoutMs: number): Promise<void> =>
  openAdvancedSettings(page, AUTH_SETUP_ADVANCED_SETTINGS, timeoutMs);

/**
 * プロファイルの詳細の、認証の設定の入り口（「ログインの設定を開く」）を中に置く「詳しい設定」の目印。PL-1（設計書
 * `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1）: サイトの画面の詳しい内容は 1 つにまとめたので、その目印（前は認証の設定の欄の中の別の
 * 「詳しい設定」）。
 */
export const PROFILE_AUTH_SETUP_ADVANCED_SETTINGS = 'profile-edit-advanced-settings';

/** プロファイルの詳細の、認証の設定の入り口のある「詳しい設定」を開く（開いていれば何もしない）。 */
export const openProfileAuthSetupAdvancedSettings = (page: Page, timeoutMs: number): Promise<void> =>
  openAdvancedSettings(page, PROFILE_AUTH_SETUP_ADVANCED_SETTINGS, timeoutMs);

/**
 * OP-DEF の 5: 前の認証の設定の画面にあった、token の送信の必須の query とログインに伴う送信を足すボタンの名前（文言はカタログから消した。入るのは手動の
 * ログインの観察からだけ）。画面のテストは、この名前のボタンが出ないことを今も確かめる。
 */
export const REMOVED_ADD_BUTTON_LABELS: readonly string[] = Object.freeze(['組を足す', '送信を足す']);

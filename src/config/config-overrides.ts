/**
 * 名前のある設定の上書きの唯一の owner（CC-058。CCX-11）。
 * - `HEADLESS_CONFIG_OVERRIDES`: CLI の `--headless`（`src/cli/arguments.ts`）と、画面のサーバから起動するワーカーの設定の上書き
 *   （`src/worker/audit-worker-session.ts` の `WORKER_CONFIG_OVERRIDES`。ブラウザのウィンドウを開かない。Task 24 の設計書 3 章）の両方が使う。
 */
import { deepFreeze } from '../core/immutable.js';
import type { AuditConfigOverrides } from './types.js';

/** ブラウザを headless で起動する上書き（`browser.headed` を偽にする）。変えられない値。 */
export const HEADLESS_CONFIG_OVERRIDES: AuditConfigOverrides = deepFreeze({ browser: { headed: false } });

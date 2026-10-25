/**
 * 名前のある設定の上書きの唯一の owner（CC-058。CCX-11）。
 * - `HEADLESS_CONFIG_OVERRIDES`: CLI の `--headless`（`src/cli/arguments.ts`）と、画面のサーバから起動するワーカーの設定の上書き
 *   （`src/worker/audit-worker-session.ts` の `WORKER_CONFIG_OVERRIDES`。ブラウザのウィンドウを開かない。Task 24 の設計書 3 章）の両方が使う。
 */
import type { AuditSendPolicyName } from '../core/audit-send-policy.js';
import { deepFreeze } from '../core/immutable.js';
import type { AuditConfigOverrides } from './types.js';

/** ブラウザを headless で起動する上書き（`browser.headed` を偽にする）。変えられない値。 */
export const HEADLESS_CONFIG_OVERRIDES: AuditConfigOverrides = deepFreeze({ browser: { headed: false } });

/**
 * FM-2（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.2）: ブラウザを表示（headed）で起動する上書き（`browser.headed` を真にする）。画面のサーバ
 * から起動するワーカーが、プロファイルの表示の設定でジョブのブラウザを表示するときに使う（`src/worker/audit-worker-session.ts` の
 * `WORKER_SHOWN_BROWSER_CONFIG_OVERRIDES`）。変えられない値。
 */
export const HEADED_CONFIG_OVERRIDES: AuditConfigOverrides = deepFreeze({ browser: { headed: true } });

/**
 * AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1）: 上書きに、監査の段の送信の扱い（`audit.sendPolicy`）を足した上書き（変えられない値）。
 * 画面のサーバから起動するワーカーが、`START` の `auditSendPolicy`（なければ `READ_ONLY`）を、実効の設定の上書きとして当てるときに使う
 * （`src/worker/audit-worker-session.ts`）。元の上書きは変えない。
 */
export const withAuditSendPolicyOverride = (overrides: AuditConfigOverrides, sendPolicy: AuditSendPolicyName): AuditConfigOverrides =>
  deepFreeze({ ...structuredClone(overrides), audit: { ...structuredClone(overrides.audit), sendPolicy } });

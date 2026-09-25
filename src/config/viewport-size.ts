import type { ViewportProfile } from '../core/contracts.js';
import type { AuditConfig, Viewport } from './types.js';

/** ビューポートの種類ごとの、設定の主要なビューポートの項目の名前。 */
const PRIMARY_VIEWPORT_KEYS = Object.freeze({
  desktop: 'primaryDesktop',
  mobile: 'primaryMobile',
} as const satisfies Readonly<Record<ViewportProfile, keyof AuditConfig['viewports']>>);

/**
 * ビューポートの種類（`VIEWPORT_PROFILES`）に対応する、設定の主要なビューポートの大きさ（CC-020）。
 * Desktop は `viewports.primaryDesktop`、Mobile は `viewports.primaryMobile`。この対応づけは、ここだけで行う
 * （Page Auditor、環境の事実、Run Coordinator が使う）。閉じた一覧にない種類は、推測せずに `RangeError` を投げる。
 */
export function viewportSizeFor(config: Pick<AuditConfig, 'viewports'>, profile: ViewportProfile): Viewport {
  if (!Object.hasOwn(PRIMARY_VIEWPORT_KEYS, profile)) {
    throw new RangeError(`unsupported viewport profile: ${String(profile)}`);
  }
  return config.viewports[PRIMARY_VIEWPORT_KEYS[profile]];
}

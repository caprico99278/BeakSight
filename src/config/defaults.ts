import { DEFAULT_CONFIG_AUDIT_SEND_POLICY } from '../core/audit-send-policy.js';
import type { AuditConfigDefaults } from './types.js';

export const DEFAULT_CONFIG: AuditConfigDefaults = {
  site: {
    startUrl: '',
    allowedOrigins: [],
  },
  crawl: {
    // L14（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.1）: 既定の上限・期限（ページの数・Run の時間・深さ・1 ページの操作の数・読み込みなどの期限）は
    // 置かない。利用者が設定のファイルに書いたときだけ効く。前の既定と同じ値は、読むときに捨てる（`load-config.ts` の `withoutOldHiddenDefaults`）。
    minNavigationIntervalMs: 5_000,
    // L14: 空は「残す名前を選んでいない」（query を残す。`normalize-url.ts`）。
    allowedQueryParameters: [],
  },
  browser: {
    headed: false,
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
  },
  viewports: {
    primaryDesktop: { width: 1440, height: 900 },
    primaryMobile: { width: 390, height: 844 },
    stressWidths: [320, 390, 768, 1024, 1440],
  },
  audit: {
    performance: true,
    accessibility: true,
    interactions: true,
    screenshots: true,
    // AS-b: 監査の段の送信の扱い。L14（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 2）: 既定は削除のほかを通す。
    sendPolicy: DEFAULT_CONFIG_AUDIT_SEND_POLICY,
  },
  output: {
    directory: 'artifacts',
  },
};

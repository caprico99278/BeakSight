import type { AuditConfig } from './types.js';

export const DEFAULT_CONFIG: AuditConfig = {
  site: {
    startUrl: '',
    allowedOrigins: [],
  },
  crawl: {
    maxPages: 500,
    maxDepth: 20,
    maxRuntimeMs: 3_600_000,
    navigationTimeoutMs: 30_000,
    overallPageTimeoutMs: 60_000,
    resourceSettlingTimeoutMs: 5_000,
    interactionTimeoutMs: 3_000,
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
  },
  output: {
    directory: 'artifacts',
  },
};

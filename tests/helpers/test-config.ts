import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AuditConfig } from '../../src/config/types.js';

/** `site` 以外の各セクションを、項目単位で上書きする指定。上書きの値はそのまま使う（複製しない）。 */
export type TestConfigOverrides = {
  readonly [Section in Exclude<keyof AuditConfig, 'site'>]?: Partial<AuditConfig[Section]>;
};

/**
 * `DEFAULT_CONFIG` を元に、テスト用の `AuditConfig` を作る。
 *
 * - `target.id` は `test-target` にする（`overrides.target` で上書きできる）。
 * - `site` は `origin` だけを許可し、開始URLを `${origin}${startPath}` にする。
 * - ページの読み込みの最小の間隔（`crawl.minNavigationIntervalMs`）は 0 にする（`overrides.crawl` で上書きできる）。
 *   テストで読み込むのは、ループバックの fixture のサーバだけであり、既定の間隔で待つとテストが遅くなるため
 *   （サイトへの負荷の制御の設計書 4.2）。ループバックでない `origin` の設定を `validateConfig` に通すテストは、
 *   `src/config/validate-config.ts` の下限以上の値（例: 既定値）を `overrides.crawl` で指定する。
 * - ブラウザは常に headless（`browser.headed: false`）にする。
 * - `DEFAULT_CONFIG` の配列やオブジェクトは複製するので、結果を凍結しても `DEFAULT_CONFIG` に影響しない。
 * - `overrides` はセクションごとに浅く上書きする。
 */
export function createTestConfig(
  origin: string,
  startPath = '/',
  overrides: TestConfigOverrides = {},
): AuditConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  return {
    target: { id: 'test-target', ...overrides.target },
    site: { startUrl: `${origin}${startPath}`, allowedOrigins: [origin] },
    crawl: { ...base.crawl, minNavigationIntervalMs: 0, ...overrides.crawl },
    browser: { ...base.browser, headed: false, ...overrides.browser },
    viewports: { ...base.viewports, ...overrides.viewports },
    audit: { ...base.audit, ...overrides.audit },
    output: { ...base.output, ...overrides.output },
  };
}

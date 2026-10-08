import type { BrowserContextFactoryOptions } from '../../src/browser/context-factory.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { EgressUpstreamPolicy } from '../../src/safety/egress-proxy.js';

/**
 * テストの Interaction の Context の出口の中継（`src/safety/egress-proxy.ts`）が、上流として許す host（URL の hostname の形）。
 * loopback だけである（実在の外部のサイトにアクセスしない決まり。DEF-039・DEF-040 の設計書 2.1.1）。`localhost` は、別のサイトの
 * iframe（OOPIF）の fixture が、同じ fixture のサーバを別のホスト名で読むために要る（`tests/helpers/external-scheme-fixture.ts`）。
 */
const LOOPBACK_EGRESS_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** テストの出口の中継の上流の方針: loopback だけを許す。production の方針（すべて許す）は、テストの factory には渡さない。 */
export const LOOPBACK_EGRESS_UPSTREAM_POLICY: EgressUpstreamPolicy = (host) => LOOPBACK_EGRESS_HOSTS.has(host);

/**
 * テストの `BrowserContextFactory` の構築の指定。Interaction の session を作る factory は、必ずこれ（かこれを含む指定）で作り、
 * 出口の中継が loopback 以外へ中継しないようにする。
 */
export const TEST_FACTORY_OPTIONS: BrowserContextFactoryOptions = Object.freeze({
  egressUpstreamPolicy: LOOPBACK_EGRESS_UPSTREAM_POLICY,
});

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

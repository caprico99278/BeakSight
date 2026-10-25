// T27R2（I3 と C1 のテストの補助）: 発見の fixture のサイト（`discovery-site-fixture.ts`）で、発見のジョブの流れ（`executeDiscoveryRun`）を、
// 同じ process の中で 1 回動かし、成果物 `discovery.json` を読む。ログインの段は通さず、fixture が作ったセッションを、認証つきの Run の指定
// （メモリの状態）で渡す（`discovery-run.test.ts` の組み立てと同じ形）。出力先は呼ぶ側の一時のフォルダ。サーバは 127.0.0.1 だけ。
import { readFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun, type DiscoveryRunOutcome } from '../../src/worker/discovery-run.js';
import {
  DISCOVERY_SITE_LOCAL_STORAGE_ITEM,
  DISCOVERY_SITE_PATHS,
  DISCOVERY_SITE_SESSION_COOKIE,
  type DiscoverySite,
} from './discovery-site-fixture.js';
import { createTestNavigationPacer } from './navigation-pacer.js';
import { createTestConfig } from './test-config.js';

/** 発見の 1 回の入力。 */
export interface DiscoverySiteRunOptions {
  readonly site: DiscoverySite;
  /** 巡回の開始の path（管理画面の下）。 */
  readonly startPath: string;
  readonly outputDirectory: string;
  readonly launchBrowser: () => Promise<Browser>;
  readonly maxPages: number;
  readonly minNavigationIntervalMs: number;
  readonly jobId: string;
}

/** 発見の 1 回の結果（成果物は、Run が動いたときだけ）。成果物の本文（目印の検索に使う）も返す。 */
export interface DiscoverySiteRun {
  readonly outcome: DiscoveryRunOutcome;
  readonly document: DiscoveryDocument | null;
  readonly documentText: string | null;
}

/** fixture のサイトのセッションを持つ、認証つきの Run の指定（読まないパスはログアウト、読む範囲は管理画面の下、既定の危険な語）。 */
export const discoverySiteAuthentication = (site: DiscoverySite): RunAuthentication => ({
  initialState: {
    cookies: [{
      name: DISCOVERY_SITE_SESSION_COOKIE,
      value: site.issueSession(),
      domain: new URL(site.origin).hostname,
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    }],
    origins: [{ origin: site.origin, localStorage: [{ name: DISCOVERY_SITE_LOCAL_STORAGE_ITEM, value: 'seed' }] }],
  },
  approvedTestOrigins: [site.origin],
  auditExclusions: {
    excludedPathPrefixes: [DISCOVERY_SITE_PATHS.logout],
    auditPathPrefixes: [DISCOVERY_SITE_PATHS.admin],
    dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
  },
  sessionLostPathPrefix: DISCOVERY_SITE_PATHS.login,
  filterState: filterAuthenticatedState,
});

/** 発見のジョブの流れを 1 回動かし、`discovery.json` を読む。 */
export async function runDiscoveryOnSite(options: DiscoverySiteRunOptions): Promise<DiscoverySiteRun> {
  const config = createTestConfig(options.site.origin, options.startPath, {
    crawl: { maxPages: options.maxPages, minNavigationIntervalMs: options.minNavigationIntervalMs },
    audit: { screenshots: false },
    output: { directory: options.outputDirectory },
  });
  const outcome = await executeDiscoveryRun({
    config,
    jobId: options.jobId,
    authentication: discoverySiteAuthentication(options.site),
    launchBrowser: options.launchBrowser,
    clock: () => new Date(),
    now: () => Date.now(),
    stopSignal: new AbortController().signal,
    navigationPacer: createTestNavigationPacer(config),
  }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
  const documentText = outcome.kind === 'RAN' ? readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8') : null;
  return { outcome, document: documentText === null ? null : JSON.parse(documentText) as DiscoveryDocument, documentText };
}

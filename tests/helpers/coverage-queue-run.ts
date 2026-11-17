// COV-2（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.2・3.3）: 網羅の待ち行列の結合テスト（`discovery-coverage-queue.test.ts`）が使う、
// 仮のサイト（`coverage-site.ts`）で本物の発見の流れ（`executeDiscoveryRun`）を 1 回動かす補助（SLIM BD-4 で、元のファイルから移した。RB-8: 再開の場面は
// 偽の巡回の口の単体 `tests/unit/discovery-crawl.test.ts` へ移した）。
import { readFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import { expect } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import type { DiscoveryDocument, DiscoveryPageEntry } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun, type DiscoveryCheckpointOptions, type DiscoveryRunOutcome } from '../../src/worker/discovery-run.js';
import { createTestConfig } from './test-config.js';
import { probeQuietWindowsOf } from './test-waits.js';

export const COVERAGE_QUEUE_TEST_TIMEOUT_MS = 480_000;
/** 押した後に静まるまで待つ時間（ms。テストの値）。 */
const QUIET_WAIT_MS = 300;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 200;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
export const COVERAGE_QUEUE_LATE_DELIVERY_SETTLE_MS = 1_000;
/** ページの上限（利用者が選ぶ上限。仮のサイトの全部より大きい）。 */
const MAX_PAGES = 80;

const authenticationOf = (origin: string): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
});

export type CoverageReadPage = Extract<DiscoveryPageEntry, { readonly state: 'READ' }>;

export const coverageReadPages = (document: DiscoveryDocument): readonly CoverageReadPage[] =>
  document.pages.flatMap((page) => (page.state === 'READ' ? [page] : []));
export const coveragePathOf = (url: string): string => new URL(url).pathname;
export const coverageReadOf = (document: DiscoveryDocument, path: string): readonly CoverageReadPage[] =>
  coverageReadPages(document).filter((page) => coveragePathOf(page.url) === path);
/** 押した（押す部品が押しにかかった）候補か。 */
export const coveragePressed = (candidate: DiscoveryCandidate): boolean => {
  const probe = candidate.submissionProbe;
  return probe !== undefined && (probe.result !== 'NOT_OBSERVED' || probe.reason === 'PRESS_FAILED');
};

export interface CoverageSiteRun {
  readonly outcome: DiscoveryRunOutcome;
  readonly document: DiscoveryDocument;
  readonly elapsedMs: number;
}

/** 仮のサイトで発見を 1 回動かす（`checkpoint`・`stopAfterPages` は再開の確かめだけ）。 */
export const discoverCoverageSite = async (
  launch: () => Promise<Browser>,
  origin: string,
  directory: string,
  options: { readonly jobId: string; readonly checkpoint?: DiscoveryCheckpointOptions; readonly stopAfterPages?: number },
): Promise<CoverageSiteRun> => {
  const config = createTestConfig(origin, '/', {
    crawl: { maxPages: MAX_PAGES, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    audit: { screenshots: false }, output: { directory },
  });
  const stop = new AbortController();
  const startedAt = Date.now();
  const outcome = await executeDiscoveryRun({
    config, jobId: options.jobId, authentication: authenticationOf(origin), launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
    stopSignal: stop.signal, observationWindows: probeQuietWindowsOf(QUIET_WAIT_MS), ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
  }, {
    onRunStarted: () => undefined,
    onSessionLost: () => undefined,
    onProgress: (report) => {
      if (options.stopAfterPages !== undefined && report.pagesFinished >= options.stopAfterPages) stop.abort();
    },
  });
  const elapsedMs = Date.now() - startedAt;
  if (outcome.kind !== 'RAN') {
    throw new Error(`the discovery did not run: ${outcome.kind}`);
  }
  const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
  const validation = await validateArtifact('discovery', document);
  expect(validation.ok ? [] : validation.errors).toEqual([]);
  return { outcome, document, elapsedMs };
};

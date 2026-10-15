// T27R2 の C1: ページの JS が一定の間隔で同じ Origin へ GET を送る（ポーリング）画面を、発見のジョブの流れ（`executeDiscoveryRun`）で読み、
// Guard が許した普通の要求が、遮断として数えられないことを確かめる。本物の Chromium（headless だけ。テストの既定と、CLI の起動の設定の両方）と
// 127.0.0.1 の fixture のサーバ（`discovery-site-fixture.ts` の `pollingPages`。`DISCOVERY_SITE_POLLING_INTERVAL_MS` ごとの GET）。
// - 成果物 `discovery.json` の安全の記録: 読んだどの画面も `blockedRequests` が 0（ポーリングのほかに、ページが止められる送信をしない画面だけ）。
// - ジョブの記録（流れの結果）: Run は動き、安全の違反で止まらない（`ABORTED_BY_SAFETY`・`SAFETY_VIOLATION` でない）。
// - 前提の確かめ: ポーリングの GET が、実際にサーバに届いている（形が空振りしていない）。サイトへの要求は GET（と HEAD）だけ。
// このテストは `discovery.json` の `blockedRequests`（Guard が止めた読み取り以外の要求の数）を見るので、出口の中継の拒否の数え違い（閉じるときの
// 中継の凍結で、進行中のポーリングが `blockedInteractionRequests` に数えられる。T27R2 の C1）は捕まえない（DEF-090）。C1 の退行は、
// `tests/integration/egress-close-freeze-run.test.ts`（本物の CLI の `run.json` の `safety.blockedActions.requests`）が捕まえる。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  DISCOVERY_SITE_EXTRA_PATHS,
  DISCOVERY_SITE_POLLING_PAGES,
  startDiscoverySite,
  type DiscoverySite,
} from '../helpers/discovery-site-fixture.js';
import { runDiscoveryOnSite } from '../helpers/discovery-site-run.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const TEST_TIMEOUT_MS = 180_000;
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
/** 読む画面の数より大きい上限。 */
const ENOUGH_PAGES = 10;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 400;
const NO_BLOCKED_REQUESTS = 0;

describe.each(LAUNCHERS)('T27R2 C1: a page polling its own origin does not count the allowed GETs as blocked (%s)', (_name, launch) => {
  let site: DiscoverySite;
  let outputDirectory: string;

  beforeEach(async () => {
    site = await startDiscoverySite({ pollingPages: true });
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-polling-'));
  });

  afterEach(async () => {
    await site.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  it('records no blocked request in discovery.json and finishes the run without a safety stop', async () => {
    const [startPath = ''] = DISCOVERY_SITE_POLLING_PAGES;
    const run = await runDiscoveryOnSite({
      site,
      startPath,
      outputDirectory,
      launchBrowser: launch,
      maxPages: ENOUGH_PAGES,
      minNavigationIntervalMs: NAVIGATION_INTERVAL_MS,
      jobId: 'job-discovery-polling',
    });
    if (run.outcome.kind !== 'RAN' || run.document === null) {
      throw new Error(`the discovery did not run: ${run.outcome.kind}`);
    }
    expect((await validateArtifact('discovery', run.document)).ok).toBe(true);
    const readPages = run.document.pages.flatMap((page) => (page.state === 'READ' ? [page] : []));
    // 前提: ポーリングの画面をすべて読み、ポーリングの GET がサーバに届いた。
    expect(readPages.map(({ url }) => new URL(url).pathname).sort()).toEqual([...DISCOVERY_SITE_POLLING_PAGES].sort());
    expect(site.requests.filter(({ path }) => path === DISCOVERY_SITE_EXTRA_PATHS.pollApi).length).toBeGreaterThan(0);
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    // ジョブの記録: 安全の違反で止まらない。
    expect(run.document.endReason).not.toBe('SAFETY_VIOLATION');
    expect(run.outcome.runStatus).not.toBe('ABORTED_BY_SAFETY');
    // `discovery.json` の安全の記録: どの画面も、遮断の数が 0。
    expect(readPages.map(({ url, blockedRequests }) => [new URL(url).pathname, blockedRequests]).sort())
      .toEqual([...DISCOVERY_SITE_POLLING_PAGES].sort().map((path) => [path, NO_BLOCKED_REQUESTS]));
  }, TEST_TIMEOUT_MS);
});

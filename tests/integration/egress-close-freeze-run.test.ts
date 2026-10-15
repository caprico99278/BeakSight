// DEF-085 fix round 3（2 回目の独立レビュー T27R2 の C1）: Guard が Context を閉じる直前に出口の中継を凍結した後に、中継が拒んだ要求
// （Guard が許した普通の要求）を、Safety Ledger の遮断の記録に数えないことを、本物の CLI（一時ディレクトリにビルドした `dist/cli/index.js`
// の `run`。127.0.0.1 の fixture のサーバだけ）で確かめる。
// - ページ（`fixtures/site/poll-fetch.html`）は、5 ms ごとに、同じ Origin への fetch と、別の Origin（同じ port の localhost の https。
//   CONNECT が中継を通る）への fetch を続ける。Guard は何も止めない（GET だけ）。
// - 確かめること: `run.json` の `safety.blockedActions.requests` が 0、`blockedRequestsByMethod` が空、違反が 0。ページが実際に何度も
//   fetch したこと（サーバの記録）。修正の前は、閉じるときの凍結の拒否が数えられた（T27R2 で 8 件と 23 件）。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { RUN_ARTIFACT_FILE_NAMES } from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { onlyRunDirectory, runCliProcess, type CliProcessResult } from '../helpers/cli-process.js';
import { readJson } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';

/** ビルドと、CLI の 1 回の Run を含む `beforeAll` の上限（ms）。 */
const SUITE_TIMEOUT_MS = 300_000;
const TARGET_ID = 'egress-close-freeze-run';
const POLL_PAGE = '/poll-fetch.html';
const POLL_TARGET = '/poll-target.txt';
/** ページが実際に fetch を続けたとみなす、同じ Origin への要求の数の下限（5 ms ごとの fetch なので、ふつうは数百件）。 */
const MIN_POLL_REQUESTS = 10;

let server: FixtureServer;
let build: TemporaryBuild;
let workDirectory: string;
let result: CliProcessResult;
let run: RunSummary;
let pollRequests = 0;

beforeAll(async () => {
  server = await startFixtureServer();
  build = await buildIntoTemporaryDirectory();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-egress-close-freeze-'));
  const outputDirectory = join(workDirectory, 'output');
  const configPath = join(workDirectory, 'config.json');
  // 製品の既定値のまま、`site` と、ページの読み込みの最小の間隔（0。対象はループバックの fixture のサーバ）だけを変える。
  await writeFile(configPath, JSON.stringify({
    target: { id: TARGET_ID },
    site: { startUrl: `${server.origin}${POLL_PAGE}`, allowedOrigins: [server.origin] },
    crawl: { minNavigationIntervalMs: 0 },
  }), 'utf8');
  server.resetRequestObservations();
  // 厳守事項: Chromium は headless だけで起動する（`--headless` を必ず付ける）。
  result = await runCliProcess(build, workDirectory, ['run', '--config', configPath, '--output', outputDirectory, '--headless']);
  pollRequests = server.getRequestObservations().filter(({ pathname }) => pathname === POLL_TARGET).length;
  run = (await readJson(join(await onlyRunDirectory(outputDirectory), RUN_ARTIFACT_FILE_NAMES.run))) as RunSummary;
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await build?.remove();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

describe('DEF-085 fix round 3: the close freeze of the egress proxy does not count ordinary requests as blocked (T27R2 C1)', () => {
  it('runs the polling page to the end, and the page kept fetching', () => {
    console.info(`DEF-085 C1 CLI run: ${JSON.stringify({ status: result.status, runStatus: run.runStatus, pollRequests, safety: run.safety })}`);
    expect(result.killedByLimit).toBe(false);
    expect(pollRequests).toBeGreaterThanOrEqual(MIN_POLL_REQUESTS);
  });

  it('counts no blocked request, no blocked request by method, and no invariant violation in run.json', () => {
    expect(run.safety.blockedActions.requests).toBe(0);
    expect(run.safety.blockedRequestsByMethod).toEqual({});
    expect(run.safety.invariantViolationCount).toBe(0);
  });
});

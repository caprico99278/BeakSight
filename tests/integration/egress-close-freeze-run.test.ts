// DEF-085 fix round 3（2 回目の独立レビュー T27R2 の C1）: Guard が Context を閉じる直前に出口の中継を凍結した後に、中継が拒んだ要求
// （Guard が許した普通の要求）を、Safety Ledger の遮断の記録に数えないことを、本物の CLI（一時ディレクトリにビルドした `dist/cli/index.js`
// の `run`。127.0.0.1 の fixture のサーバだけ）で確かめる。
// - ページ（`fixtures/site/poll-fetch.html`）は、5 ms ごとに、同じ Origin への fetch と、別の Origin（同じ port の localhost の https。
//   CONNECT が中継を通る）への fetch を続ける。Guard は何も止めない（GET だけ）。
// - 確かめること: 閉じるときの凍結の拒否（中継の拒否は `blockedInteractionRequests` に記録される）が 0 件、違反が 0。ページが実際に何度も
//   fetch したこと（サーバの記録）。修正の前は、閉じるときの凍結の拒否が数えられた（T27R2 で 8 件と 23 件）。
// - DEF-132-fix: DEF-130-fix から、1 画面の読み込みあたりの文書でない要求に上限（1,000 件）がある。5 ms ごとに 2 件を出すこのページは上限に当たり、
//   超えた分を Guard が `PAGE_SUBRESOURCE_LIMIT_REACHED` で止めて記録する（意図どおり）。そのため、止めた要求の数 0 の期待を、「止めた要求は
//   すべて上限で止めた fetch の GET で、ほかの理由（閉じるときの凍結など）で止めた要求は 0」に替えた（ページの間隔は変えない。上限に当たる場面の
//   確かめも、ここで兼ねる）。
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { PAGES_ARTIFACT_DIRECTORY, RUN_ARTIFACT_FILE_NAMES } from '../../src/core/artifact-layout.js';
import type { PageAuditResult, RunSummary } from '../../src/core/contracts.js';
import type { SafetyEventsEvidence } from '../../src/core/evidence-types.js';
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
/** DEF-132-fix: Run のすべての `page.json`。 */
let pages: readonly PageAuditResult[] = [];

/** DEF-132-fix: Run のディレクトリの、すべての `page.json`。 */
const pagesOf = (runDirectory: string): readonly PageAuditResult[] => {
  const pagesDirectory = join(runDirectory, PAGES_ARTIFACT_DIRECTORY);
  return readdirSync(pagesDirectory).map((pageId) => JSON.parse(readFileSync(join(pagesDirectory, pageId, 'page.json'), 'utf8')) as PageAuditResult);
};

/** DEF-132-fix: ページの Safety の Evidence。 */
const safetyEvidenceOf = (page: PageAuditResult): readonly SafetyEventsEvidence[] =>
  page.evidence.flatMap((record) => (record.type === 'safety' ? [record.payload as SafetyEventsEvidence] : []));

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
  const runDirectory = await onlyRunDirectory(outputDirectory);
  run = (await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run))) as RunSummary;
  pages = pagesOf(runDirectory);
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

  // DEF-132-fix: 止めた要求の数は、上限で止めた fetch の GET の数だけ（`blockedActions.requests` は、メソッドごとの数と、中継の拒否を含む
  // Interaction の遮断したリクエストの記録の数の和。後者が 0 なら、閉じるときの凍結の拒否は数えられていない）。
  it('counts only the GET requests blocked by the subresource limit in run.json, no other blocked request, and no invariant violation', () => {
    expect(Object.keys(run.safety.blockedRequestsByMethod)).toEqual(['GET']);
    expect(run.safety.blockedActions.requests).toBe(run.safety.blockedRequestsByMethod['GET']);
    expect(run.safety.invariantViolationCount).toBe(0);
  });

  it('records the blocked requests only with PAGE_SUBRESOURCE_LIMIT_REACHED, and no blocked Interaction or egress request, in every page', () => {
    expect(pages.length).toBeGreaterThan(0);
    const safety = pages.flatMap(safetyEvidenceOf);
    expect(safety.length).toBeGreaterThan(0);
    const blocked = safety.flatMap((evidence) => evidence.blockedRequests);
    expect(blocked.length).toBeGreaterThan(0);
    expect(new Set(blocked.map(({ method, reason }) => `${method} ${reason}`))).toEqual(new Set(['GET PAGE_SUBRESOURCE_LIMIT_REACHED']));
    // 閉じるときの凍結の拒否（中継の拒否）は、どの理由でも記録しない。
    expect(safety.flatMap((evidence) => evidence.blockedInteractionRequests)).toEqual([]);
    // 上限に当たった画面は、読み切れない（ビューポートの `PAGE_SUBRESOURCE_LIMIT_REACHED`）。
    expect(pages.some((page) => Object.values(page.viewports)
      .some((viewport) => viewport.incompleteReasons.some(({ code }) => code === 'PAGE_SUBRESOURCE_LIMIT_REACHED')))).toBe(true);
  });
});

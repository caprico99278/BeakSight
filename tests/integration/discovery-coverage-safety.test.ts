// COV-2c（SREV-COV の指摘の直し。網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md`）: 操作さがしの網羅の終わり方と記録を、本物の発見の流れ
// （`executeDiscoveryRun`。factory・Guard・凍結・押す部品）と、127.0.0.1 の仮のサイト（`tests/helpers/coverage-safety-site.ts`。一般の文言）で確かめる。
// 押して出させた書き込み（読み取りでない要求）の到着は、どの場面でも 0（サーバの記録。遅れて届く要求も待ってから数える）。
// - I-1: 押すたびに見出しが増える・同じ作りのボタンが増える画面で、有限の回数で終わる（同じ作りが増えただけなら新しい状態とみなさず、鎖を閉じて
//   `NO_NEW_STRUCTURE` を記録する）。新しい作りの区画が押下で出る画面では、その区画の中のボタンも押す。止める印と Run の時間の上限は、押す輪の中でも効く。
// - I-2: 押す時点の確かめで止めた（押していない）押下は、押した組に入れない（番号だけ違う同じ作りの画面で、もう一度押しにかかる）。
// - I-3: 同じ文書のまま変わった URL（SPA の辺）の目印の値は、成果物と checkpoint に伏せずに残らない。
// - I-4: 押下の移り先（伏せた状態）のある checkpoint から再開でき、移り先を押下のたどり直しで作り直して読む。
// - C-1: 押下から生まれた移り先（文書の移動・popup・frame）を、読み込みの最初から凍結した Context で読む。移り先の画面が読み込みのときに出す POST と beacon は
//   届かない。移り先の画面は読まれ、記録が残る。
// - fix round 2〜4: 開き手の押下の目印がサーバに届かない（1 つの場面に集めた）。fix round 5: 凍結の中の子孫の目印を伏せ、2 段目の途中から再開できる。
// - DEF-236（待ち行列が空になる最後の画面の後は、間隔を見せたまま待たない）は、RB-8 で偽の巡回の口の単体（`tests/unit/discovery-crawl.test.ts`）へ移した。
// SLIM BD-2: 送信の扱いは本番の既定の PASS_EXCEPT_DELETE だけ（発見の凍結の中は扱いによらず何も送らない。READ_ONLY の回は外した）。両方の Chromium に広げるのは
// fix round 2〜4 の「目印がサーバに届かない」の 1 場面（`BOTH_CHROMIUM_LAUNCHERS`。遅い組では CLI の起動の設定の 1 つ）。ほかは組の先頭の回だけで、Browser を
// 発見の流れどうしで共有する（`useSharedRunBrowser`）。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, DISCOVERY_CHECKPOINT_RELATIVE_PATH, artifactFilePath } from '../../src/core/artifact-layout.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE } from '../../src/core/audit-send-policy.js';
import { wait } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import type { DiscoveryDocument, DiscoveryPageEntry } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import type { NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { executeDiscoveryRun, type DiscoveryCheckpointOptions, type DiscoveryRunOutcome } from '../../src/worker/discovery-run.js';
import { BOTH_CHROMIUM_LAUNCHERS, useSharedRunBrowser } from '../helpers/chromium.js';
import { COVERAGE_SAFETY_MANY_BUTTONS, coverageSafetySiteHandler, type CoverageSafetyArrival } from '../helpers/coverage-safety-site.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig } from '../helpers/test-config.js';
import { probeQuietWindowsOf } from '../helpers/test-waits.js';

const TEST_TIMEOUT_MS = 300_000;
/** 押した後に静まるまで待つ時間（ms。テストの値）。 */
const QUIET_WAIT_MS = 300;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 200;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_000;
/** 終わらない場面の見張り（ms。過ぎたら止める印を立て、ブラウザを閉じる。テストは失敗にする）。 */
const WATCHDOG_MS = 120_000;
/** 押下の目印の書き出し（`submissionProbeMarkerOf` の先頭）。 */
const MARKER_PATTERN = /bsprobe/u;
const IDENTITY = Object.freeze({ authenticationSha256: 'a'.repeat(64), targetConfigSha256: 'b'.repeat(64) });
/** 1 回だけ流す場面の Chromium（組の先頭の回。`chromiumRunsOf` の決まり）。 */
const [ONCE_LABEL, launchOnce] = BOTH_CHROMIUM_LAUNCHERS[0] ?? ['', () => Promise.reject(new Error('no Chromium run'))];

const authenticationOf = (origin: string): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
});

type ReadPage = Extract<DiscoveryPageEntry, { readonly state: 'READ' }>;

const readPages = (document: DiscoveryDocument): readonly ReadPage[] =>
  document.pages.flatMap((page) => (page.state === 'READ' ? [page] : []));
const pathOf = (url: string): string => new URL(url).pathname;
const readOf = (document: DiscoveryDocument, path: string): readonly ReadPage[] => readPages(document).filter((page) => pathOf(page.url) === path);
/** 押した（押す部品が押しにかかった）候補か。 */
const pressed = (candidate: DiscoveryCandidate): boolean => {
  const probe = candidate.submissionProbe;
  return probe !== undefined && (probe.result !== 'NOT_OBSERVED' || probe.reason === 'PRESS_FAILED');
};
const nonReads = (arrivals: readonly CoverageSafetyArrival[]): readonly string[] =>
  arrivals.filter(({ method }) => !READ_METHODS.has(method)).map(({ method, path, search }) => `${method} ${path}${search}`);
const pingsOf = (arrivals: readonly CoverageSafetyArrival[], prefix: string): number => arrivals.filter(({ path }) => path.startsWith(prefix)).length;
/** 目印の値が、要求の URL・本文・Referer・Cookie に乗っているか。 */
const carriesMarker = ({ search, body, referer, cookie }: CoverageSafetyArrival): boolean =>
  [decodeURIComponent(search), body, decodeURIComponent(referer), decodeURIComponent(cookie)].some((text) => MARKER_PATTERN.test(text));

interface SiteRun {
  readonly outcome: DiscoveryRunOutcome;
  readonly document: DiscoveryDocument | null;
  readonly checkpointText: string | null;
  readonly watchdogFired: boolean;
  readonly stopAt: number | null;
}

interface DiscoverOptions {
  readonly jobId: string;
  readonly startPath: string;
  readonly checkpoint?: DiscoveryCheckpointOptions;
  readonly stopAfterPages?: number;
  /** 届いた要求を見て、真になったら止める印を立てる。 */
  readonly stopWhen?: (arrivals: readonly CoverageSafetyArrival[]) => boolean;
  readonly maxRuntimeMs?: number;
  /** DEF-236: 読み込みの間隔の部品（待った時間を数える。省略すると設定の間隔で作る）。 */
  readonly navigationPacer?: NavigationPacer;
}

/** 仮のサイトで発見を 1 回動かす（終わらなければ見張りが止める）。送信の扱いは本番の既定の `PASS_EXCEPT_DELETE`。 */
const discover = async (
  launch: () => Promise<Browser>,
  origin: string,
  directory: string,
  arrivals: readonly CoverageSafetyArrival[],
  options: DiscoverOptions,
): Promise<SiteRun> => {
  const config = createTestConfig(origin, options.startPath, {
    crawl: {
      maxPages: 60, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS, ...(options.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: options.maxRuntimeMs }),
    },
    audit: { screenshots: false, sendPolicy: AUDIT_SEND_PASS_EXCEPT_DELETE }, output: { directory },
  });
  const browsers: Browser[] = [];
  const stop = new AbortController();
  let watchdogFired = false;
  let stopAt: number | null = null;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    stop.abort();
    for (const browser of browsers) void browser.close().catch(() => undefined);
  }, WATCHDOG_MS);
  const poll = options.stopWhen === undefined ? null : setInterval(() => {
    if (stopAt === null && options.stopWhen?.(arrivals) === true) {
      stopAt = Date.now();
      stop.abort();
    }
  }, 10);
  let outcome: DiscoveryRunOutcome;
  try {
    outcome = await executeDiscoveryRun({
      config, jobId: options.jobId, authentication: authenticationOf(origin),
      launchBrowser: async () => {
        const browser = await launch();
        browsers.push(browser);
        return browser;
      },
      clock: () => new Date(), now: () => Date.now(), stopSignal: stop.signal, observationWindows: probeQuietWindowsOf(QUIET_WAIT_MS),
      ...(options.navigationPacer === undefined ? {} : { navigationPacer: options.navigationPacer }),
      ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
    }, {
      onRunStarted: () => undefined,
      onSessionLost: () => undefined,
      onProgress: (report) => {
        if (options.stopAfterPages !== undefined && report.pagesFinished >= options.stopAfterPages) stop.abort();
      },
    });
  } finally {
    clearTimeout(watchdog);
    if (poll !== null) clearInterval(poll);
    for (const browser of browsers) await browser.close().catch(() => undefined);
  }
  if (outcome.kind !== 'RAN') {
    return { outcome, document: null, checkpointText: null, watchdogFired, stopAt };
  }
  const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
  const validation = await validateArtifact('discovery', document);
  expect(validation.ok ? [] : validation.errors).toEqual([]);
  const checkpointFile = artifactFilePath(outcome.runDirectory, DISCOVERY_CHECKPOINT_RELATIVE_PATH);
  const checkpointText = existsSync(checkpointFile) ? readFileSync(checkpointFile, 'utf8') : null;
  return { outcome, document, checkpointText, watchdogFired, stopAt };
};

/** 仮のサイトを立て、終わったら閉じる。 */
const withSite = async (prefix: string, body: (origin: string, directory: string, arrivals: CoverageSafetyArrival[]) => Promise<void>): Promise<void> => {
  const arrivals: CoverageSafetyArrival[] = [];
  const server = await startLoopbackHttpServer(coverageSafetySiteHandler(arrivals));
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await body(server.origin, directory, arrivals);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
};

/** 場面の発見を 1 回動かし、終わり方・書き込みの到着・目印の残りを確かめて、成果物を返す（fix round 2〜5 の共通の確かめ）。 */
const runMarkerScene = async (
  launch: () => Promise<Browser>,
  startPath: string,
  jobId: string,
  check: (document: DiscoveryDocument, arrivals: readonly CoverageSafetyArrival[]) => void,
  /** 凍結の外の画面が読み込みのときに目印のない書き込み（自動の保存）を送る場面は false（その書き込みは PASS_EXCEPT_DELETE で通る）。 */
  noNonReadAtAll = true,
): Promise<void> => {
  await withSite(`beaksight-${jobId}-`, async (origin, directory, arrivals) => {
    const run = await discover(launch, origin, directory, arrivals, { jobId, startPath, checkpoint: { identity: IDENTITY } });
    await wait(LATE_DELIVERY_SETTLE_MS);
    const document = run.document;
    if (document === null) throw new Error(`no discovery document of ${startPath}`);
    expect(document.endReason, startPath).toBe('COMPLETED');
    // 目印の値は、書き込みに乗って届かない（URL・本文・Referer・Cookie。beacon も本文で見る）。押下の書き込み（PATCH）も届かない。
    expect(arrivals.filter((arrival) => !READ_METHODS.has(arrival.method) && carriesMarker(arrival))
      .map(({ method, path, search }) => `${method} ${path}${search}`), startPath).toEqual([]);
    expect(arrivals.filter(({ method }) => method === 'PATCH' || method === 'DELETE').map(({ method, path }) => `${method} ${path}`), startPath).toEqual([]);
    if (noNonReadAtAll) expect(nonReads(arrivals), startPath).toEqual([]);
    // 記録と checkpoint に目印の値は残らない。
    expect(JSON.stringify(document), startPath).not.toMatch(MARKER_PATTERN);
    expect(run.checkpointText ?? '', startPath).not.toMatch(MARKER_PATTERN);
    check(document, arrivals);
  });
};

// ---------- 両方の Chromium に広げる 1 場面（遅い組では CLI の起動の設定の 1 つ） ----------

// COV-2c fix round 2〜4（SREV-COV の 2〜3 回目）: 開き手（「編集」）の押下の前に欄に目印を入れない（前の押下で入れた目印は元の値に戻す）。開き手は目印を一度も
// 入れていない文書で押し、目印を入れた後にしか出ない開き手は読み込み直して押す。押下から生まれた状態は凍結の外で一度も読み込まない。どの場面でも目印の値は
// サーバに届かず、記録と checkpoint に残らず、開き手の先の画面は読む。
describe.each(BOTH_CHROMIUM_LAUNCHERS)('COV-2c fix rounds 2 to 4: no marker value reaches the server through an opener (%s)', (_name, launch) => {
  const shared = useSharedRunBrowser(launch);

  it('round 2 opener, round 3 g, h and k, round 4 two, chain and kd', async () => {
    await runMarkerScene(shared, '/opener/', 'job-cov2c-opener', (document, arrivals) => {
      // サーバに目印の値は 1 回も届かない（URL と本文）。
      expect(arrivals.filter(({ search, body }) => MARKER_PATTERN.test(decodeURIComponent(search)) || MARKER_PATTERN.test(body))
        .map(({ method, path, search }) => `${method} ${path}${search}`)).toEqual([]);
      // 「表示」で入れた目印は、「編集」の前に元の値に戻っている（移り先の URL は元の値）。
      const editGets = arrivals.filter(({ method, path }) => method === 'GET' && path === '/opener/list/7');
      expect(editGets.length).toBeGreaterThan(0);
      for (const { search } of editGets) expect(new URLSearchParams(search).get('q')).toBe('初期');
      const [list] = readOf(document, '/opener/list');
      const show = list?.record.candidates.find((candidate) => candidate.submitterWords.length === 0 || !candidate.submitterWords.includes('編集'));
      expect(show !== undefined && pressed(show)).toBe(true);
      expect(list?.record.candidates.find((candidate) => candidate.submitterWords.includes('編集'))?.submissionProbe?.filledFieldCount).toBe(0);
      // 開き手の先の form は、今どおり凍結の中で確かめられる（保存の PATCH は届かない）。
      const save = readOf(document, '/opener/list/7')[0]?.record.candidates.find((candidate) => candidate.submitterWords.includes('保存'));
      expect(save !== undefined && pressed(save)).toBe(true);
      expect(arrivals.filter(({ path }) => path === '/opener/api/items/7')).toEqual([]);
    }, false);
    for (const scene of ['g', 'h']) {
      await runMarkerScene(shared, `/op/${scene}/items`, `job-cov2c-op-${scene}`, (document, arrivals) => {
        // 目印の値は、URL・本文・Referer・Cookie のどれにも乗って届かない（読み取りも）。
        expect(arrivals.filter(carriesMarker).map(({ method, path, search }) => `${method} ${path}${search}`)).toEqual([]);
        expect(readOf(document, `/op/${scene}/items/1`)).toHaveLength(1);
        const save = readOf(document, `/op/${scene}/items`)[0]?.record.candidates.find((candidate) => candidate.submitterWords.includes('保存'));
        expect(save !== undefined && pressed(save)).toBe(true);
      }, false);
    }
    await runMarkerScene(shared, '/op/k/items', 'job-cov2c-op-k', (document, arrivals) => {
      const [list] = readOf(document, '/op/k/items');
      // 「編集」は、最初の読み込みでは押さずに残し、読み込み直した後に押した。移り先は凍結の中で読む。
      expect(list?.reloadedForProbe).toBe(true);
      expect(list?.record.candidates.find((candidate) => candidate.submitterWords.includes('編集'))?.submissionProbe?.filledFieldCount).toBe(0);
      expect(readOf(document, '/op/k/items/1')).toHaveLength(1);
      // 一覧の画面の読み込み: 最初の読み込み、「編集」を押すための読み込み直し、移り先を凍結の中で読むための読み込みの 3 回。
      expect(arrivals.filter(({ method, path }) => method === 'GET' && path === '/op/k/items')).toHaveLength(3);
    });
    await runMarkerScene(shared, '/r3/two/items', 'job-cov2c-r3two', (document) => {
      expect(readOf(document, '/r3/two/items/1')).toHaveLength(1);
      expect(readOf(document, '/r3/two/items/1/2')).toHaveLength(1);
    });
    await runMarkerScene(shared, '/chain/', 'job-cov2c-chain', (document) => {
      for (const path of ['/chain/r1', '/chain/r2', '/chain/r3']) expect(readOf(document, path), path).toHaveLength(1);
    });
    await runMarkerScene(shared, '/r3/kd/items', 'job-cov2c-r3kd', (document) => {
      expect(readOf(document, '/r3/kd/items/1')).toHaveLength(1);
    });
  }, TEST_TIMEOUT_MS);
});

// ---------- 1 回だけの場面（組の先頭の回） ----------

/** 入口の画面が読み込みのときに送る、目印のない POST（凍結の外の読み込みのたびに届く。読み込みの回数を数えるのに使う）。 */
const rootHellos = (arrivals: readonly CoverageSafetyArrival[], scene: string): number =>
  arrivals.filter(({ method, path }) => method === 'POST' && path === `/r4/${scene}/api/hello`).length;
const nonReadsBut = (arrivals: readonly CoverageSafetyArrival[], scene: string): readonly string[] =>
  nonReads(arrivals).filter((line) => line !== `POST /r4/${scene}/api/hello`);

describe(`COV-2c: the ends, the records and the resume of the coverage presses (${ONCE_LABEL})`, () => {
  const launch = useSharedRunBrowser(launchOnce);

  it('I-1: ends in a finite number of presses, closes the chain with NO_NEW_STRUCTURE, presses inside a new region, and delivers no write', async () => {
    await withSite('beaksight-cov2c-endless-', async (origin, directory, arrivals) => {
      const run = await discover(launch, origin, directory, arrivals, { jobId: 'job-cov2c-endless', startPath: '/endless/' });
      await wait(LATE_DELIVERY_SETTLE_MS);
      expect(run.watchdogFired).toBe(false);
      const document = run.document;
      expect(document?.endReason).toBe('COMPLETED');
      if (document === null) throw new Error('no discovery document');
      // 有限の回数（同じ作りが増えただけの押下で鎖を閉じる）。
      expect(pingsOf(arrivals, '/es/ping')).toBeLessThanOrEqual(3);
      expect(pingsOf(arrivals, '/eb/ping-named')).toBeLessThanOrEqual(2);
      expect(pingsOf(arrivals, '/eb/ping-plain')).toBeLessThanOrEqual(2);
      for (const path of ['/eb/named', '/eb/plain']) {
        const [entry] = readOf(document, path);
        expect(entry?.record.candidates.some((candidate) => candidate.submissionProbe?.chainEnd === 'NO_NEW_STRUCTURE'), path).toBe(true);
      }
      // 新しい作りの区画が押下で出る画面では、その区画の中のボタンも押す（書き込みは届けない）。
      const save = readOf(document, '/esr/page')[0]?.record.candidates.find((candidate) => candidate.submitterWords.includes('登録'));
      expect(save !== undefined && pressed(save)).toBe(true);
      expect(nonReads(arrivals)).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  // TEST-TIME-A: 押す流れの制御（止める合図・時間の上限・押す時点の確かめの数え方）は、ブラウザの違いに左右されない BeakSight の側の判定。
  it('I-1: stops pressing soon after the stop signal', async () => {
    await withSite('beaksight-cov2c-stop-', async (origin, directory, arrivals) => {
      const run = await discover(launch, origin, directory, arrivals, {
        jobId: 'job-cov2c-stop', startPath: '/many/', stopWhen: (seen) => pingsOf(seen, '/many/ping') > 0,
      });
      await wait(LATE_DELIVERY_SETTLE_MS);
      const stopAt = run.stopAt ?? Number.POSITIVE_INFINITY;
      expect(run.watchdogFired).toBe(false);
      expect(run.document?.endReason).toBe('STOPPED');
      expect(arrivals.filter(({ path, at }) => path.startsWith('/many/ping') && at > stopAt).length).toBeLessThanOrEqual(1);
      expect(nonReads(arrivals)).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  it('I-1: stops pressing at the run time limit', async () => {
    await withSite('beaksight-cov2c-runtime-', async (origin, directory, arrivals) => {
      const run = await discover(launch, origin, directory, arrivals, { jobId: 'job-cov2c-runtime', startPath: '/many/', maxRuntimeMs: 5_000 });
      await wait(LATE_DELIVERY_SETTLE_MS);
      expect(run.watchdogFired).toBe(false);
      expect(run.document?.endReason).toBe('MAX_RUNTIME_REACHED');
      expect(pingsOf(arrivals, '/many/ping')).toBeLessThan(COVERAGE_SAFETY_MANY_BUTTONS);
      expect(nonReads(arrivals)).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  it('I-2: a press stopped at the press-time check is not a pressed pair, and the same button on the second page is pressed', async () => {
    await withSite('beaksight-cov2c-presstime-', async (origin, directory, arrivals) => {
      const run = await discover(launch, origin, directory, arrivals, { jobId: 'job-cov2c-presstime', startPath: '/stop/' });
      await wait(LATE_DELIVERY_SETTLE_MS);
      const document = run.document;
      if (document === null) throw new Error('no discovery document');
      const saveOf = (path: string): DiscoveryCandidate | undefined =>
        readOf(document, path)[0]?.record.candidates.find((candidate) => candidate.submitterWords.includes('保存'));
      // 1 つ目の画面: 押す時点の確かめが止めた。DEF-242（L10）の後は、移した先のボタンの押下で、移した先の form の送信の型が記録される（届かない）。
      const first = saveOf('/stop/items/1')?.submissionProbe;
      if (first?.reason === 'NON_JSON_BODY') {
        expect(first).toMatchObject({ shape: { method: 'POST', pathShape: '/stop/api/items' } });
      } else {
        expect(['PRESS_FAILED', 'PAGE_CHANGED']).toContain(first?.reason);
      }
      // 2 つ目の画面: 押していない押下は押した組に入らないので、同じボタンにもう一度押しにかかる（`SAME_STATE_PRESSED` にならない）。
      expect(saveOf('/stop/items/2')?.submissionProbe?.reason).toBe('PRESS_FAILED');
      expect(nonReads(arrivals)).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  it('I-3: keeps no marker value of the SPA edge in the artifact and the checkpoint', async () => {
    await withSite('beaksight-cov2c-spaq-', async (origin, directory, arrivals) => {
      const run = await discover(launch, origin, directory, arrivals, { jobId: 'job-cov2c-spaq', startPath: '/spaq/', checkpoint: { identity: IDENTITY } });
      await wait(LATE_DELIVERY_SETTLE_MS);
      const document = run.document;
      if (document === null) throw new Error('no discovery document');
      expect(document.endReason).toBe('COMPLETED');
      expect(new URL(readOf(document, '/spaq/results')[0]?.url ?? 'http://x/').searchParams.get('q')).toContain('REDACTED');
      expect(JSON.stringify(document)).not.toMatch(MARKER_PATTERN);
      expect(run.checkpointText).not.toBeNull();
      expect(run.checkpointText ?? '').not.toMatch(MARKER_PATTERN);
      expect(nonReads(arrivals)).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  it('I-4: resumes from a checkpoint with a redacted moved page, and reads the moved page again by replaying the press', async () => {
    await withSite('beaksight-cov2c-resume-', async (origin, directory, arrivals) => {
      const first = await discover(launch, origin, directory, arrivals, {
        jobId: 'job-cov2c-resume-1', startPath: '/resume/', checkpoint: { identity: IDENTITY }, stopAfterPages: 3,
      });
      expect(first.document?.endReason).toBe('STOPPED');
      if (first.outcome.kind !== 'RAN') throw new Error('the first discovery did not run');
      expect(first.checkpointText ?? '').not.toMatch(MARKER_PATTERN);
      // 1 回目は、移り先（結果の画面）をまだ読んでいない。
      expect(readOf(first.document as DiscoveryDocument, '/resume/results')).toHaveLength(0);
      await wait(LATE_DELIVERY_SETTLE_MS);
      const second = await discover(launch, origin, directory, arrivals, {
        jobId: 'job-cov2c-resume-2', startPath: '/resume/',
        checkpoint: { identity: IDENTITY, resume: { runDirectory: first.outcome.runDirectory, previousJobId: 'job-cov2c-resume-1' } },
      });
      await wait(LATE_DELIVERY_SETTLE_MS);
      expect(second.outcome.kind).toBe('RAN');
      const document = second.document;
      if (document === null) throw new Error('no discovery document');
      expect(document.endReason).toBe('COMPLETED');
      expect(new URL(readOf(document, '/resume/results')[0]?.url ?? 'http://x/').searchParams.get('q')).toContain('REDACTED');
      expect(JSON.stringify(document)).not.toMatch(MARKER_PATTERN);
      expect(second.checkpointText ?? '').not.toMatch(MARKER_PATTERN);
      expect(nonReads(arrivals)).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  it.each(['/moved/', '/pop/'])('C-1: reads the moved pages of %s frozen from the start and their automatic writes never reach the server', async (startPath) => {
    await withSite('beaksight-cov2c-frozenmove-', async (origin, directory, arrivals) => {
      const run = await discover(launch, origin, directory, arrivals, { jobId: 'job-cov2c-frozenmove', startPath });
      await wait(LATE_DELIVERY_SETTLE_MS);
      const document = run.document;
      if (document === null) throw new Error('no discovery document');
      expect(document.endReason).toBe('COMPLETED');
      // 移り先の画面は読まれ、記録が残る（記録の URL の目印の値は伏せてある）。
      for (const path of startPath === '/moved/' ? ['/moved/confirm', '/moved/items/1'] : ['/pop/child']) {
        const [moved] = readOf(document, path);
        expect(moved, path).toBeDefined();
        expect(new URL(moved?.url ?? 'http://x/').search, path).toContain('REDACTED');
        if (path === '/pop/child') {
          // 子の画面は、読み込みの 50 ms 後に自分で form を POST する。凍結の Guard がその移動を止めるので、文書は誤りの画面に替わる。
          expect(moved?.record.location === null || moved?.record.location.path === path, path).toBe(true);
        } else {
          expect(moved?.record.location?.path, path).toBe(path);
        }
      }
      expect(JSON.stringify(document)).not.toMatch(MARKER_PATTERN);
      expect(nonReads(arrivals)).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  // COV-2c fix round 5（SREV-COV 4 回目の I-1・I-2・M-1・M-3）: 凍結の中の子孫の目印を値で伏せる。2 段目の途中から再開できる。凍結の中で順に読み込む途中の
  // 文書が移る・開くを試みても、その文書を読み、先へ進む。
  it('round 5 anc: hides the marker on another query name, and loads the root outside the freeze only once', async () => {
    await withSite('beaksight-cov2c-r4anc-', async (origin, directory, arrivals) => {
      const run = await discover(launch, origin, directory, arrivals, { jobId: 'job-cov2c-r4anc', startPath: '/r4/anc/find', checkpoint: { identity: IDENTITY } });
      await wait(LATE_DELIVERY_SETTLE_MS);
      const document = run.document;
      if (document === null) throw new Error('no discovery document');
      expect(document.endReason).toBe('COMPLETED');
      for (const path of ['/r4/anc/r1', '/r4/anc/r2', '/r4/anc/detail', '/r4/anc/plain']) expect(readOf(document, path), path).toHaveLength(1);
      expect(JSON.stringify(document)).not.toMatch(MARKER_PATTERN);
      expect(run.checkpointText ?? '').not.toMatch(MARKER_PATTERN);
      expect(nonReadsBut(arrivals, 'anc')).toEqual([]);
      // M-1: 祖先（入口の画面）を凍結の外で読み込むのは最初の 1 回だけ。入口の画面の自動の POST は、通す扱いでも 1 回だけ届く。
      expect(rootHellos(arrivals, 'anc')).toBe(1);
    });
  }, TEST_TIMEOUT_MS);

  // M-3: r1 の候補を読み r2 へ進むことは、設計の判断を待つ。今は安全だけを確かめる。
  it('round 5 hop: keeps the move to another origin and the popup of r1 stopped', async () => {
    await withSite('beaksight-cov2c-r4hop-', async (origin, directory, arrivals) => {
      const run = await discover(launch, origin, directory, arrivals, { jobId: 'job-cov2c-r4hop', startPath: '/r4/hop/find' });
      await wait(LATE_DELIVERY_SETTLE_MS);
      const document = run.document;
      if (document === null) throw new Error('no discovery document');
      expect(readOf(document, '/r4/hop/r1')).toHaveLength(1);
      expect(JSON.stringify(document)).not.toMatch(MARKER_PATTERN);
      expect(arrivals.filter(({ path }) => path === '/r4/hop/x' || path === '/r4/hop/pop')).toEqual([]);
      expect(nonReadsBut(arrivals, 'hop')).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  it('round 5 anc resume: reads the second stage after a stop in the middle of it', async () => {
    await withSite('beaksight-cov2c-r4resume-', async (origin, directory, arrivals) => {
      const first = await discover(launch, origin, directory, arrivals, {
        jobId: 'job-cov2c-r4resume-1', startPath: '/r4/anc/find', checkpoint: { identity: IDENTITY }, stopAfterPages: 2,
      });
      expect(first.document?.endReason).toBe('STOPPED');
      if (first.outcome.kind !== 'RAN') throw new Error('the first discovery did not run');
      await wait(LATE_DELIVERY_SETTLE_MS);
      const second = await discover(launch, origin, directory, arrivals, {
        jobId: 'job-cov2c-r4resume-2', startPath: '/r4/anc/find',
        checkpoint: { identity: IDENTITY, resume: { runDirectory: first.outcome.runDirectory, previousJobId: 'job-cov2c-r4resume-1' } },
      });
      await wait(LATE_DELIVERY_SETTLE_MS);
      const document = second.document;
      if (document === null) throw new Error('no discovery document');
      expect(document.endReason).toBe('COMPLETED');
      for (const path of ['/r4/anc/r2', '/r4/anc/detail', '/r4/anc/plain']) expect(readOf(document, path), path).toHaveLength(1);
      expect(document.pages.filter((page) => page.state === 'NOT_READ' && page.reason !== 'EXCLUDED')).toEqual([]);
      expect(JSON.stringify(document)).not.toMatch(MARKER_PATTERN);
      expect(second.checkpointText ?? '').not.toMatch(MARKER_PATTERN);
      expect(nonReadsBut(arrivals, 'anc')).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);
});

// RB-8（再構築の設計書 2 章 1・3、INV-REBUILD の plan 2 章の 5・6）: 発見の巡回の輪（`executeDiscoveryRun` の `crawl`）を、偽の巡回の口（`crawlPorts`）で、
// ブラウザなしに確かめる。1 画面の読み込みの中身（読み取り・押下・Guard）は口の向こうにあり、ここでは口の答えを前提として信じる（決まり 3）。
// - 終わり方: 全部読む・ページの上限・セッションの切れ・止める印・時間の上限・押す輪の途中の停止・Run の前の確認の失敗・違反。
// - 辺: 除外の記録、先に読む登録の画面（点検の段の成果物から）とその一覧、その後に最初から入れる点検の段の画面（DSEED）、移った先の編集の画面（上限に数えない）、最後の画面の後は間隔を待たない（DEF-236）。
// - 凍結の中でだけ読む状態: たどり方（根）を渡す、根を凍結の外で読み込むのは最初の 1 回だけ（M-1）と戻し、目印の値を記録と checkpoint に残さない、続きでは
//   祖先の押し直しで作り直す。
// - 続き: 読んだ画面を読み直さず同じ Run で続ける。使えない保存は、口を開かずに止める。
// - 凍結の中のたどり方の順（`walkFrozenPath`）と、残りの候補の読み込み直し（`reprobeRemaining`）の単体。
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, DISCOVERY_CHECKPOINT_RELATIVE_PATH, artifactFilePath } from '../../src/core/artifact-layout.js';
import type { RunProgressReport } from '../../src/core/contracts.js';
import { DEBUG_TIMING_FILE_NAME } from '../../src/core/debug-timing.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { createSha256Fingerprint } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import type { DiscoveryDocument, DiscoveryReadPageRecord } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import {
  executeDiscoveryRun,
  reprobeRemaining,
  walkFrozenPath,
  type DiscoveryCheckpointOptions,
  type DiscoveryCrawlPorts,
  type DiscoveryPageVisit,
  type DiscoveryRunOutcome,
  type DiscoveryVisitOptions,
} from '../../src/worker/discovery-run.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4173';
const MARKER = 'bsprobe0123456789ab';
const IDENTITY = Object.freeze({ authenticationSha256: 'a'.repeat(64), targetConfigSha256: 'b'.repeat(64) });
const TRAIL = Object.freeze([{ index: 0, matchKey: 'save', ordinal: 0 }]);

type ReadVisit = Extract<DiscoveryPageVisit, { readonly kind: 'READ' }>;

const authentication: RunAuthentication = Object.freeze({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [ORIGIN],
  auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
});

const url = (path: string): string => `${ORIGIN}${path}`;
const pathOf = (value: string): string => { const parsed = new URL(value); return `${parsed.pathname}${parsed.search}`; };

/** 読めた画面の答え（候補なし。辺と事実は `facts` で足す）。 */
const readVisit = (visitedUrl: string, facts: Partial<ReadVisit> = {}): ReadVisit => ({
  kind: 'READ',
  record: { location: { origin: ORIGIN, path: new URL(visitedUrl).pathname }, incompleteReasons: [], candidates: [] },
  links: [], preferredLinks: new Set(), frames: [], structureKey: createSha256Fingerprint(pathOf(visitedUrl)),
  openedEditPages: [], spaRoutePages: [], movedPages: [], replayedMove: null,
  blockedRequests: 0, frozenReads: { passed: 0, carryingMarker: 0, tokenRefreshes: 0 },
  probe: { culprit: null, continuation: null, pressed: 0, leftBehind: new Map(), candidateKeys: undefined, optionStages: [] },
  violation: false, safetyViolation: null,
  ...facts,
});

/** 偽の口に頼んだ 1 回の読み込み。 */
interface VisitCall {
  readonly path: string;
  readonly options: DiscoveryVisitOptions;
}

/** 偽の口（`answer` が 1 回の読み込みの答えを決める。省略は、リンクの表 `links` のとおりに読めた画面）。 */
const fakePorts = (
  answer: (call: VisitCall, calls: readonly VisitCall[]) => DiscoveryPageVisit | Promise<DiscoveryPageVisit>,
  opened = true,
): { readonly ports: DiscoveryCrawlPorts; readonly calls: VisitCall[]; readonly opens: number[] } => {
  const calls: VisitCall[] = [];
  const opens: number[] = [];
  const ports: DiscoveryCrawlPorts = {
    open: async () => {
      opens.push(opens.length);
      return opened ? {
        visit: async (visited, options) => {
          const call = { path: pathOf(visited), options };
          calls.push(call);
          return answer(call, calls);
        },
        carry: { latestAuthenticatedState: () => null },
        close: async () => undefined,
      } : null;
    },
  };
  return { ports, calls, opens };
};

/** リンクの表のとおりに読めた画面を返す答え。 */
const byLinks = (links: Readonly<Record<string, readonly string[]>>) => ({ path }: VisitCall): DiscoveryPageVisit =>
  readVisit(url(path), { links: (links[path] ?? []).map(url) });

describe('RB-8: the discovery crawl loop on a fake crawl port', () => {
  let directory = '';
  let runs = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-crawl-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  interface CrawlRun {
    readonly outcome: DiscoveryRunOutcome;
    readonly document: DiscoveryDocument | null;
    readonly checkpointText: string | null;
    readonly sessionLost: readonly string[];
  }

  const run = async (
    ports: DiscoveryCrawlPorts,
    options: {
      readonly maxPages?: number;
      readonly maxRuntimeMs?: number;
      readonly stop?: AbortController;
      readonly now?: () => number;
      readonly checkpoint?: DiscoveryCheckpointOptions;
      readonly chainedAuditRunDirectory?: string;
      readonly jobId?: string;
      readonly startPath?: string;
      readonly onProgress?: (report: RunProgressReport) => void;
      /** SLIM: Run のディレクトリを受ける（省略は受けない）。 */
      readonly onRunStarted?: (runDirectory: string) => void;
      /** DBG-1: 測りの記録の入切（省略は切）。 */
      readonly debugTiming?: boolean;
      /** 出力先（Run の ID は秒の単位なので、同じ場面の Run ごとに分ける。続きは前の Run と同じ出力先）。 */
      readonly output?: string;
    } = {},
  ): Promise<CrawlRun> => {
    runs += 1;
    const config = createTestConfig(ORIGIN, options.startPath ?? '/admin', {
      crawl: {
        minNavigationIntervalMs: 1_000,
        ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
        ...(options.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: options.maxRuntimeMs }),
      },
      audit: { screenshots: false },
      output: { directory: options.output ?? join(directory, `run-${String(runs)}`) },
    });
    const sessionLost: string[] = [];
    const outcome = await executeDiscoveryRun({
      config, jobId: options.jobId ?? 'job-crawl', authentication,
      launchBrowser: () => Promise.reject(new Error('the fake crawl port starts no browser')),
      clock: () => new Date(), now: options.now ?? (() => Date.now()), sleep: async () => undefined,
      stopSignal: (options.stop ?? new AbortController()).signal,
      crawlPorts: ports,
      ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
      ...(options.chainedAuditRunDirectory === undefined ? {} : { chainedAuditRunDirectory: options.chainedAuditRunDirectory }),
      ...(options.debugTiming === undefined ? {} : { debugTimingSwitch: async () => options.debugTiming === true }),
    }, {
      onRunStarted: ({ runDirectory }) => options.onRunStarted?.(runDirectory), onSessionLost: (lost) => sessionLost.push(lost),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    if (outcome.kind !== 'RAN') {
      return { outcome, document: null, checkpointText: null, sessionLost };
    }
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    const validation = await validateArtifact('discovery', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    let checkpointText: string | null = null;
    try {
      checkpointText = readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_CHECKPOINT_RELATIVE_PATH), 'utf8');
    } catch {
      checkpointText = null;
    }
    return { outcome, document, checkpointText, sessionLost };
  };

  const readPaths = (document: DiscoveryDocument | null): readonly string[] =>
    (document?.pages ?? []).flatMap((page) => (page.state === 'READ' ? [pathOf(page.url)] : []));
  const notRead = (document: DiscoveryDocument | null): readonly string[] =>
    (document?.pages ?? []).flatMap((page) => (page.state === 'NOT_READ' ? [`${pathOf(page.url)} ${page.reason}`] : []));

  const SITE = Object.freeze({
    '/admin': ['/admin/list', '/admin/new', '/logout', '/admin/delete-all'],
    '/admin/list': ['/admin/list/1', '/admin'],
    '/admin/new': [],
    '/admin/list/1': [],
  });

  it('reads every linked page once, records the excluded links, and does not wait for the interval after the last page (DEF-236)', async () => {
    const fake = fakePorts(byLinks(SITE));
    const result = await run(fake.ports);
    expect(result.outcome).toMatchObject({ kind: 'RAN', runStatus: 'COMPLETE', endReason: 'COMPLETED' });
    expect(readPaths(result.document)).toEqual(['/admin', '/admin/list', '/admin/new', '/admin/list/1']);
    expect([...notRead(result.document)].sort()).toEqual(['/admin/delete-all EXCLUDED', '/logout EXCLUDED']);
    // 待ち行列に次の画面が残る間は、見せたまま間隔を待つ。最後の画面の後は待たない。
    expect(fake.calls.map(({ options }) => options.pacingWaitBeforeClose).slice(1)).toEqual([true, true, false]);
  });

  it('stops at the page limit, a lost session, the stop signal, the run time limit and a stop inside the press loop, leaving the rest unread', async () => {
    const limited = await run(fakePorts(byLinks(SITE)).ports, { maxPages: 2 });
    expect(limited.outcome).toMatchObject({ runStatus: 'PARTIAL', endReason: 'MAX_PAGES_REACHED' });
    expect(readPaths(limited.document)).toEqual(['/admin', '/admin/list']);
    expect(notRead(limited.document)).toContain('/admin/new MAX_PAGES_REACHED');

    const lost = await run(fakePorts((call) => (call.path === '/admin/list'
      ? { kind: 'SESSION_LOST', url: url('/login?token=secret'), detail: null, sessionLoss: null, violation: false, safetyViolation: null }
      : byLinks(SITE)(call))).ports);
    expect(lost.document?.endReason).toBe('AUTH_SESSION_LOST');
    expect(readPaths(lost.document)).toEqual(['/admin']);
    expect(lost.sessionLost).toHaveLength(1);
    expect(lost.sessionLost[0]).not.toContain('secret');

    const stop = new AbortController();
    const stopped = await run(fakePorts((call) => {
      stop.abort();
      return byLinks(SITE)(call);
    }).ports, { stop });
    expect(stopped.document?.endReason).toBe('STOPPED');
    expect(readPaths(stopped.document)).toEqual(['/admin']);

    let nowMs = 0;
    const timed = await run(fakePorts((call) => {
      nowMs += 1_000;
      return byLinks(SITE)(call);
    }).ports, { maxRuntimeMs: 1_500, now: () => nowMs });
    expect(timed.document?.endReason).toBe('MAX_RUNTIME_REACHED');
    expect(readPaths(timed.document)).toEqual(['/admin', '/admin/list']);

    // COV-2c（I-1 の 3）: 押す輪が停止を見て途中で止めたら、その画面の後に止める。
    const cutStop = new AbortController();
    const cut = await run(fakePorts((call) => {
      cutStop.abort();
      expect(call.options.shouldStop?.()).toBe(true);
      return byLinks(SITE)(call);
    }).ports, { stop: cutStop });
    expect(cut.document?.endReason).toBe('STOPPED');
  });

  it('ends with PREFLIGHT_FAILED without a visit, and stops at a safety violation', async () => {
    const failed = fakePorts(byLinks(SITE), false);
    const preflight = await run(failed.ports);
    expect(preflight.document?.endReason).toBe('PREFLIGHT_FAILED');
    expect(failed.calls).toEqual([]);

    const violated = await run(fakePorts((call) => readVisit(url(call.path), { links: (SITE[call.path as keyof typeof SITE] ?? []).map(url), violation: call.path === '/admin/list' })).ports);
    expect(violated.outcome).toMatchObject({ kind: 'RAN', endReason: 'SAFETY_VIOLATION' });
    expect(readPaths(violated.document)).toEqual(['/admin', '/admin/list']);
  });

  it('reads the create pages and their list page found by the audit stage first, without counting them in the page limit (OP-J, OP-R)', async () => {
    const audit = join(directory, 'audit-run');
    await mkdir(join(audit, 'pages', 'PAGE-000001'), { recursive: true });
    const linkOf = (path: string, anchorText: string): Record<string, unknown> => ({
      anchorText, ariaLabel: null, title: null, normalized: { ok: true, url: url(path) }, admission: { kind: 'INTERNAL_NAVIGABLE' },
    });
    await writeFile(join(audit, 'pages', 'PAGE-000001', 'page.json'), JSON.stringify({ evidence: [{ type: 'link', viewport: 'desktop', payload: { links: [
      linkOf('/admin/entries/form', '新規登録'), linkOf('/admin/items/new', '品目'), linkOf('/admin/items', '品目の一覧'), linkOf('/logout/new', '新規'),
    ] } }] }), 'utf8');
    const result = await run(fakePorts(byLinks(SITE)).ports, { maxPages: 1, chainedAuditRunDirectory: audit });
    expect(readPaths(result.document)).toEqual(['/admin/entries/form', '/admin/items/new', '/admin/items', '/admin']);
    expect(result.document).toMatchObject({ endReason: 'MAX_PAGES_REACHED', maxPages: 4 });
  });

  it('DSEED: queues every page the audit stage read from the start, after the create pages, and reads each once without the pages outside the audit scope', async () => {
    const audit = join(directory, 'audit-run');
    const pages: readonly (readonly [string, Record<string, unknown>])[] = [
      ['/admin', { evidence: [{ type: 'link', viewport: 'desktop', payload: { links: [
        { anchorText: '新規登録', ariaLabel: null, title: null, normalized: { ok: true, url: url('/admin/entries/form') }, admission: { kind: 'INTERNAL_NAVIGABLE' } },
      ] } }] }],
      ['/admin/list', {}], ['/admin/list/1', {}], ['/admin/hidden', {}],
      ['/admin/broken', { status: 'FAILED', incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: null }] }],
      ['/admin/away', { status: 'FAILED', incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: 'BLOCKED_EXTERNAL_REDIRECT' }] }],
    ];
    for (const [index, [path, record]] of pages.entries()) {
      const pageId = `PAGE-${String(index + 1).padStart(6, '0')}`;
      await mkdir(join(audit, 'pages', pageId), { recursive: true });
      await writeFile(join(audit, 'pages', pageId, 'page.json'), JSON.stringify({ pageUrl: url(path), status: 'AUDITED', incompleteReasons: [], ...record }), 'utf8');
    }
    const reports: RunProgressReport[] = [];
    const fake = fakePorts(byLinks({ '/admin': ['/admin/list', '/admin/fresh'], '/admin/list': ['/admin/list/1', '/admin'] }));
    const result = await run(fake.ports, { chainedAuditRunDirectory: audit, onProgress: (report) => reports.push(report) });
    expect(fake.calls.map(({ path }) => path)).toEqual(['/admin/entries/form', '/admin', '/admin/list', '/admin/list/1', '/admin/hidden', '/admin/broken', '/admin/fresh']);
    expect(result.document?.endReason).toBe('COMPLETED');
    expect(reports[0]?.pagesDiscovered).toBeGreaterThanOrEqual(6);
    // DSEED2: 見つけた画面を、点検から引き継いだ画面（点検で読んだ 5）と新しく見つけた画面（登録の画面と、押して出た画面）に分けて送り、成果物にも残す。
    expect(reports.at(-1)).toMatchObject({ pagesDiscovered: 7, pagesDiscoveredSplit: { fromAuditStage: 5, newlyFound: 2 } });
    expect(result.document?.pagesDiscoveredSplit).toEqual({ fromAuditStage: 5, newlyFound: 2 });
  });

  it('SKIP-1: does not load an audit-stage page whose both viewports have no pressable element, and keeps it as a page not read', async () => {
    const audit = join(directory, 'audit-run');
    const dom = (viewport: string, count?: number): Record<string, unknown> =>
      ({ type: 'dom', viewport, payload: count === undefined ? {} : { discoveryCandidateCount: count } });
    const pages: readonly (readonly [string, readonly unknown[]])[] = [
      ['/admin', [dom('desktop', 3), dom('mobile', 3)]],
      ['/admin/plain', [dom('desktop', 0), dom('mobile', 0)]],
      ['/admin/narrow', [dom('desktop', 0), dom('mobile', 1)]],
      ['/admin/older', [dom('desktop'), dom('mobile')]],
    ];
    for (const [index, [path, evidence]] of pages.entries()) {
      const pageId = `PAGE-${String(index + 1).padStart(6, '0')}`;
      await mkdir(join(audit, 'pages', pageId), { recursive: true });
      await writeFile(join(audit, 'pages', pageId, 'page.json'), JSON.stringify({ pageUrl: url(path), status: 'AUDITED', incompleteReasons: [], evidence }), 'utf8');
    }
    const fake = fakePorts(byLinks({}));
    const result = await run(fake.ports, { chainedAuditRunDirectory: audit });
    expect(fake.calls.map(({ path }) => path)).toEqual(['/admin', '/admin/narrow', '/admin/older']);
    expect(notRead(result.document)).toEqual(['/admin/plain NO_PRESSABLE_ELEMENTS']);
    expect(result.outcome).toMatchObject({ runStatus: 'COMPLETE', endReason: 'COMPLETED' });
  });

  it('DSEED2: carries the number of pages from the audit stage over to the continuation', async () => {
    const audit = join(directory, 'audit-run');
    for (const [index, path] of ['/admin', '/admin/list'].entries()) {
      const pageId = `PAGE-${String(index + 1).padStart(6, '0')}`;
      await mkdir(join(audit, 'pages', pageId), { recursive: true });
      await writeFile(join(audit, 'pages', pageId, 'page.json'), JSON.stringify({ pageUrl: url(path), status: 'AUDITED', incompleteReasons: [] }), 'utf8');
    }
    const stop = new AbortController();
    const output = join(directory, 'resume-chained');
    const site = byLinks({ '/admin': ['/admin/list', '/admin/fresh'] });
    const first = await run(fakePorts((call) => { stop.abort(); return site(call); }).ports, {
      chainedAuditRunDirectory: audit, checkpoint: { identity: IDENTITY }, stop, jobId: 'job-first', output,
    });
    if (first.outcome.kind !== 'RAN') throw new Error('the first crawl did not run');
    const reports: RunProgressReport[] = [];
    const resume = { runDirectory: first.outcome.runDirectory, previousJobId: 'job-first' };
    const second = await run(fakePorts(site).ports, {
      chainedAuditRunDirectory: audit, checkpoint: { identity: IDENTITY, resume }, jobId: 'job-second', output, onProgress: (report) => reports.push(report),
    });
    expect(second.document?.endReason).toBe('COMPLETED');
    expect(reports.at(-1)).toMatchObject({ pagesDiscovered: 3, pagesDiscoveredSplit: { fromAuditStage: 2, newlyFound: 1 } });
  });

  it('reads every edit page that an opener moved to first, without counting it in the page limit (DEF-190)', async () => {
    const opened = (path: string) => ({ url: url(path) as never, templatePath: '/admin/list/{id}', markerQueryNames: [], trail: [], markedDocument: false, markerValues: [] });
    const result = await run(fakePorts((call) => (call.path === '/admin/list'
      ? readVisit(url(call.path), { links: [url('/admin/new')], openedEditPages: [opened('/admin/list/a1b2c3d4e5'), opened('/admin/list/a1b2c3d4e59')] })
      : byLinks(SITE)(call))).ports, { maxPages: 2 });
    expect(readPaths(result.document)).toEqual(['/admin', '/admin/list', '/admin/list/a1b2c3d4e5', '/admin/list/a1b2c3d4e59']);
    expect(result.document?.maxPages).toBe(4);
  });

  /** 押下の移り先（目印の値を query に持つ）を出す入口の画面と、その移り先の画面。 */
  const pressedSite = (marker: string, frozenAnswer?: (call: VisitCall) => DiscoveryPageVisit) => (call: VisitCall): DiscoveryPageVisit => {
    if (call.path === '/find') {
      if (call.options.replayMove !== undefined) {
        return readVisit(url('/find'), { replayedMove: { url: url(`/results?q=${marker}2`), markerQueryNames: ['q'], markerValues: [`${marker}2`] } });
      }
      if (call.options.linksOnly === true) {
        // 作り直しの読み直しは押さない（リンクだけ）。
        return readVisit(url('/find'), { links: [url('/plain')] });
      }
      return readVisit(url('/find'), {
        links: [url('/plain')],
        movedPages: [{ url: url(`/results?q=${marker}`), markerQueryNames: ['q'], trail: TRAIL, markerValues: [marker] }],
      });
    }
    if (call.path.startsWith('/results') && frozenAnswer !== undefined) {
      return frozenAnswer(call);
    }
    return readVisit(url(call.path), call.path === '/plain' ? { links: [url('/find')] } : {});
  };

  it('reads a press-born page through its frozen path, loads the root outside the freeze only once, and keeps no marker value (COV-2c)', async () => {
    const fake = fakePorts(pressedSite(MARKER));
    const result = await run(fake.ports, { startPath: '/find', checkpoint: { identity: IDENTITY } });
    expect(result.document?.endReason).toBe('COMPLETED');
    const moved = fake.calls.find(({ path }) => path.startsWith('/results'));
    // 移り先は、押下を経ていない祖先（入口の画面）からたどって凍結の中で読む。祖先はもう凍結の外で読み込んだので、最初から凍結して読む（M-1）。
    expect(moved?.path).toBe(`/results?q=${MARKER}`);
    expect(moved?.options.frozenPath?.rootUrl).toBe(url('/find'));
    expect(moved?.options.frozenFromStart).toBe(true);
    expect(new URL(result.document?.pages.find((page) => page.url.includes('/results'))?.url ?? url('/')).searchParams.get('q')).toContain('REDACTED');
    expect(JSON.stringify(result.document)).not.toContain(MARKER);
    expect(result.checkpointText).not.toBeNull();
    expect(result.checkpointText ?? '').not.toContain(MARKER);

    // 最初から凍結して読めなかったときは、今の形に戻して読み、戻した回数を残す。
    const fallback = fakePorts(pressedSite(MARKER, (call) => (call.options.frozenFromStart === true
      ? { kind: 'NAVIGATION_FAILED', violation: false, safetyViolation: null }
      : readVisit(url('/results')))));
    const fellBack = await run(fallback.ports, { startPath: '/find', jobId: 'job-fallback' });
    expect(fallback.calls.filter(({ path }) => path.startsWith('/results')).map(({ options }) => options.frozenFromStart === true)).toEqual([true, false]);
    expect(fellBack.document?.frozenStartFallbacks).toBe(1);
  });

  it('continues the same Run from the checkpoint without reading the read pages again, and rebuilds a redacted page by replaying its press', async () => {
    const stop = new AbortController();
    const first = fakePorts((call) => {
      stop.abort();
      return pressedSite(MARKER)(call);
    });
    const output = join(directory, 'resume');
    const firstRun = await run(first.ports, { startPath: '/find', checkpoint: { identity: IDENTITY }, stop, jobId: 'job-first', output });
    expect(firstRun.document?.endReason).toBe('STOPPED');
    if (firstRun.outcome.kind !== 'RAN') throw new Error('the first crawl did not run');
    expect(firstRun.checkpointText ?? '').not.toContain(MARKER);

    const second = fakePorts(pressedSite(MARKER));
    const resume = { runDirectory: firstRun.outcome.runDirectory, previousJobId: 'job-first' };
    const secondRun = await run(second.ports, { startPath: '/find', checkpoint: { identity: IDENTITY, resume }, jobId: 'job-second', output });
    expect(secondRun.outcome).toMatchObject({ kind: 'RAN', runId: firstRun.outcome.runId });
    expect(secondRun.document?.endReason).toBe('COMPLETED');
    // 入口の画面は、伏せた移り先を作り直すために読み直して押し直すだけ（記録は前の実行のまま）。
    expect(second.calls.map(({ path, options }) => `${path}${options.replayMove === undefined ? '' : ' replay'}`))
      .toEqual(['/find', '/find replay', '/plain', `/results?q=${MARKER}2`]);
    expect(readPaths(secondRun.document).map((path) => path.split('?')[0])).toEqual(['/find', '/plain', '/results']);
    expect(JSON.stringify(secondRun.document)).not.toContain(MARKER);
    expect(secondRun.checkpointText ?? '').not.toContain(MARKER);

    // 別のジョブ・別の設定の保存、壊れた保存は、口を開かずに止める（新しい Run を始めない）。
    for (const checkpoint of [
      { identity: IDENTITY, resume: { ...resume, previousJobId: 'job-other' } },
      { identity: { ...IDENTITY, targetConfigSha256: 'c'.repeat(64) }, resume },
      { identity: { ...IDENTITY, authenticationSha256: 'd'.repeat(64) }, resume },
    ]) {
      const refused = fakePorts(pressedSite(MARKER));
      expect((await run(refused.ports, { startPath: '/find', checkpoint, jobId: 'job-third', output })).outcome.kind).toBe('RESUME_UNAVAILABLE');
      expect(refused.opens).toEqual([]);
    }
    // 待ち行列の状態の URL が場所の鍵と合わない保存（スキーマには通る）も、口を開かずに止める（SFIX-1104-2）。
    const checkpointFile = artifactFilePath(firstRun.outcome.runDirectory, DISCOVERY_CHECKPOINT_RELATIVE_PATH);
    const saved = JSON.parse(readFileSync(checkpointFile, 'utf8')) as { coverage: { states: { url: string }[] } };
    const [state] = saved.coverage.states;
    if (state === undefined) throw new Error('the checkpoint has no state');
    state.url = `${state.url}?changed=1`;
    expect((await validateArtifact('discovery-checkpoint', saved)).ok).toBe(true);
    await writeFile(checkpointFile, JSON.stringify(saved), 'utf8');
    const mismatched = fakePorts(pressedSite(MARKER));
    expect((await run(mismatched.ports, { startPath: '/find', checkpoint: { identity: IDENTITY, resume }, jobId: 'job-fifth', output })).outcome.kind)
      .toBe('RESUME_UNAVAILABLE');
    expect(mismatched.opens).toEqual([]);
    await writeFile(checkpointFile, '{ broken', 'utf8');
    const broken = fakePorts(pressedSite(MARKER));
    expect((await run(broken.ports, { startPath: '/find', checkpoint: { identity: IDENTITY, resume }, jobId: 'job-fourth', output })).outcome.kind).toBe('RESUME_UNAVAILABLE');
    expect(broken.opens).toEqual([]);
  });

  it('reloads the page for the candidates left behind and records that it reloaded (COV-2)', async () => {
    const left = { submissionProbe: { reason: 'PAGE_CHANGED' } } as unknown as DiscoveryCandidate;
    const record: DiscoveryReadPageRecord = { location: { origin: ORIGIN, path: '/admin/new' }, incompleteReasons: [], candidates: [left] };
    const fake = fakePorts((call) => (call.path === '/admin/new' && call.options.reprobe === undefined
      ? readVisit(url(call.path), { record, probe: { culprit: null, continuation: null, pressed: 1, leftBehind: new Map([[0, TRAIL]]), candidateKeys: undefined, optionStages: [] } })
      : byLinks(SITE)(call)));
    const config = createTestConfig(ORIGIN, '/admin/new', { audit: { screenshots: false }, output: { directory } });
    const outcome = await executeDiscoveryRun({
      config, jobId: 'job-reprobe', authentication, launchBrowser: () => Promise.reject(new Error('no browser')),
      clock: () => new Date(), now: () => Date.now(), sleep: async () => undefined, stopSignal: new AbortController().signal, crawlPorts: fake.ports,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error('the crawl did not run');
    expect(fake.calls.map(({ path, options }) => [path, [...(options.reprobe?.candidates ?? [])], options.reprobe?.replay])).toEqual([
      ['/admin/new', [], undefined],
      ['/admin/new', [0], TRAIL],
    ]);
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    expect(document.pages.find((page) => page.state === 'READ')).toMatchObject({ reloadedForProbe: true });
  });

  it('DTIME (DBG-1): records the time breakdown of a read page only when the debug timing is on, also in the debug timing file', async () => {
    let clock = 0;
    const left = { submissionProbe: { reason: 'PAGE_CHANGED' } } as unknown as DiscoveryCandidate;
    const record: DiscoveryReadPageRecord = { location: { origin: ORIGIN, path: '/admin/new' }, incompleteReasons: [], candidates: [left] };
    const ports = () => fakePorts(async (call) => {
      // 口の向こうの 1 回の読み込み（100 ms）と、測らない処理（10 ms）。
      await call.options.timing?.measure('LOAD', async () => { clock += 100; });
      clock += 10;
      return call.options.reprobe === undefined
        ? readVisit(url(call.path), { record, probe: { culprit: null, continuation: null, pressed: 1, leftBehind: new Map([[0, TRAIL]]), candidateKeys: undefined, optionStages: [] } })
        : readVisit(url(call.path));
    }).ports;
    const debugFileOf = (outcome: DiscoveryRunOutcome): string | null => {
      if (outcome.kind !== 'RAN') return null;
      try {
        return readFileSync(artifactFilePath(outcome.runDirectory, DEBUG_TIMING_FILE_NAME), 'utf8');
      } catch {
        return null;
      }
    };
    // SLIM（設計書 2.3 (a)）: 画面を終えるたびに書き出す（進み具合を送る時点で、その画面の行がファイルにある）。
    let runDirectory = '';
    const writtenAtProgress: string[] = [];
    const on = await run(ports(), {
      startPath: '/admin/new?token=secret-value', now: () => clock, debugTiming: true,
      onRunStarted: (directory) => { runDirectory = directory; },
      onProgress: () => {
        try {
          writtenAtProgress.push(readFileSync(artifactFilePath(runDirectory, DEBUG_TIMING_FILE_NAME), 'utf8'));
        } catch {
          writtenAtProgress.push('');
        }
      },
    });
    const page = on.document?.pages.find((entry) => entry.state === 'READ');
    expect(page?.state === 'READ' ? page.timeBreakdown : null).toMatchObject({ totalMs: 220, loadMs: 200, loads: 2, reloads: 1, otherMs: 20, stageEndMs: 0 });
    const text = debugFileOf(on.outcome) ?? '';
    expect(text).toContain('"point":"DISCOVERY_PAGE"');
    expect(writtenAtProgress.some((written) => written.includes('"point":"DISCOVERY_PAGE"'))).toBe(true);
    expect(text).not.toContain('secret-value');

    const off = await run(ports(), { startPath: '/admin/new', now: () => clock });
    const offPage = off.document?.pages.find((entry) => entry.state === 'READ');
    expect(offPage?.state === 'READ' ? offPage.timeBreakdown : null).toBeUndefined();
    expect(debugFileOf(off.outcome)).toBeNull();
  });

  it('DPROG (a): counts a page left unread outside the freeze as checked, so the progress reaches the found pages', async () => {
    // 入口の画面のリンクの 1 つが、押下で入れた目印の値を持つ（凍結の外では読まない画面になる）。
    const site = (call: VisitCall): DiscoveryPageVisit => (call.path === '/find' && call.options.replayMove === undefined && call.options.linksOnly !== true
      ? readVisit(url('/find'), {
        links: [url(`/echo?v=${MARKER}`)],
        movedPages: [{ url: url(`/results?q=${MARKER}`), markerQueryNames: ['q'], trail: TRAIL, markerValues: [MARKER] }],
      })
      : readVisit(url(call.path)));
    const fake = fakePorts(site);
    const reports: RunProgressReport[] = [];
    const config = createTestConfig(ORIGIN, '/find', { audit: { screenshots: false }, output: { directory } });
    const outcome = await executeDiscoveryRun({
      config, jobId: 'job-dprog-a', authentication, launchBrowser: () => Promise.reject(new Error('no browser')),
      clock: () => new Date(), now: () => Date.now(), sleep: async () => undefined, stopSignal: new AbortController().signal, crawlPorts: fake.ports,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined, onProgress: (report) => { reports.push(report); } });
    if (outcome.kind !== 'RAN') throw new Error('the crawl did not run');
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    expect(notRead(document)).toHaveLength(1);
    expect(reports.at(-1)).toMatchObject({ pagesFinished: 3, pagesDiscovered: 3 });
    // DSEED2: 連鎖でない操作さがし（点検の段がない）は、見つけた画面を分けない（今のまま）。
    expect(reports.some((report) => report.pagesDiscoveredSplit !== undefined)).toBe(false);
    expect(document.pagesDiscoveredSplit).toBeUndefined();
  });
});

describe('RB-8 (S4): the order of a frozen path (walkFrozenPath)', () => {
  const steps = (frozen: boolean, verdicts: Readonly<Record<string, 'READABLE' | 'NAVIGATION_FAILED' | 'HTTP_ERROR_STATUS'>> = {}) => {
    const events: string[] = [];
    return {
      events,
      steps: {
        freezeRoot: async () => { events.push('freeze'); return frozen; },
        loadHop: async (hop: string) => { events.push(`load ${hop}`); return verdicts[hop] ?? 'READABLE'; },
        afterStep: () => { events.push('check'); },
      },
    };
  };

  it('freezes the root before loading the hops in order, and loads no hop when the root cannot be frozen', async () => {
    const readable = steps(true);
    expect(await walkFrozenPath(['/r1', '/r2'], readable.steps)).toEqual({ kind: 'READABLE' });
    expect(readable.events).toEqual(['freeze', 'check', 'load /r1', 'check', 'load /r2', 'check']);

    const unfrozen = steps(false);
    // REV-RB8911 M-1: 凍結できない根は、読み込みの失敗ではなく、凍結できない意味の結果（呼ぶ側は `INCOMPLETE_FREEZE_UNAVAILABLE` の画面にする）。
    expect(await walkFrozenPath(['/r1', '/r2'], unfrozen.steps)).toEqual({ kind: 'FREEZE_UNAVAILABLE', afterRoot: false });
    expect(unfrozen.events).toEqual(['freeze', 'check']);
  });

  it('stops at the first hop that cannot be read, as a failure after the root', async () => {
    const failing = steps(true, { '/r1': 'HTTP_ERROR_STATUS' });
    expect(await walkFrozenPath(['/r1', '/r2'], failing.steps)).toEqual({ kind: 'HTTP_ERROR_STATUS', afterRoot: true });
    expect(failing.events).toEqual(['freeze', 'check', 'load /r1']);
  });
});

describe('RB-8: reloading for the remaining candidates (reprobeRemaining)', () => {
  const candidateWith = (reason: string | null): DiscoveryCandidate =>
    ({ submissionProbe: reason === null ? { result: 'NO_REQUEST', reason: null } : { result: 'NOT_OBSERVED', reason } }) as unknown as DiscoveryCandidate;
  const pageWith = (reasons: readonly (string | null)[], leftBehind: ReadonlyMap<number, typeof TRAIL>): ReadVisit => readVisit(url('/page'), {
    record: { location: { origin: ORIGIN, path: '/page' }, incompleteReasons: [], candidates: reasons.map(candidateWith) },
    probe: { culprit: null, continuation: null, pressed: 1, leftBehind, candidateKeys: undefined, optionStages: [] },
  });

  it('reloads once per replay group, gives up a candidate that made no progress, and needs no reload for a page without remains', async () => {
    expect(await reprobeRemaining(pageWith([null], new Map()), () => Promise.reject(new Error('no reload')), () => false)).toBeNull();
    const reloads: number[][] = [];
    const continued = await reprobeRemaining(pageWith(['PAGE_CHANGED', 'PAGE_CHANGED'], new Map([[0, TRAIL], [1, TRAIL]])), async (reprobe) => {
      reloads.push([...reprobe.candidates]);
      // 押せずに、同じ候補が残ったまま（進みがない）。
      return pageWith(['PAGE_CHANGED', 'PAGE_CHANGED'], new Map([[0, TRAIL], [1, TRAIL]]));
    }, () => false);
    expect(reloads).toEqual([[0, 1]]);
    expect(continued).toMatchObject({ reloaded: true, stop: null });
  });

  it('stops reloading at a lost session or at the stop signal', async () => {
    const lost: DiscoveryPageVisit = { kind: 'SESSION_LOST', url: url('/login'), detail: null, sessionLoss: null, violation: false, safetyViolation: null };
    const page = pageWith(['PAGE_CHANGED'], new Map([[0, TRAIL]]));
    expect((await reprobeRemaining(page, async () => lost, () => false))?.stop).toEqual(lost);
    let reloaded = false;
    expect(await reprobeRemaining(page, async () => { reloaded = true; return lost; }, () => true)).toMatchObject({ reloaded: false, stop: null });
    expect(reloaded).toBe(false);
  });
});

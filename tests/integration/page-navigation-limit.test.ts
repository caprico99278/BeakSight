// DEF-129（2026-10-17 T43R の I-1。設計者の方針）: ページ自身の main frame の読み込み直しと移動の回数の上限。Context ごとに、BeakSight 自身の
// 読み込みの後に、ページが始めた main frame の読み込み（JS の `location.reload()`・`location.href`、meta の転送）を、名前つきの上限
// （`PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME`。2 回）まで通し、超えたら Guard が止めて記録する。判定は Guard の 1 か所。
// - `setTimeout(() => location.reload(), 80)` の画面で、入口の確かめ・発見・画面の READ・監査の 1 画面について、サーバに届いた文書の要求は、BeakSight
//   自身の読み込み 1 回につき上限＋1 以下（前は 40 回あまり届いた）。その画面は読み切れない（入口の確かめは `READ_FAILED`、発見は
//   `INCOMPLETE_PAGE_NAVIGATION_LIMIT`、READ は落ち着いていない画面として照らす（`PAGE_NOT_SETTLED`）、監査はビューポートの `PAGE_NAVIGATION_LIMIT_REACHED`）。
//   届いた文書の要求の数を成果物に残す（`documentRequests`）。
// - 1 回の JS の転送と 1 回の meta の転送の画面は、今どおり読める（移った先の画面を読む）。
// - T37R2-fix: 子の frame の読み込み直しと移動も、frame ごとに同じ上限。
// - DEF-130-fix（ユーザーの判断）: 1 画面の読み込みあたり、ページが出す文書でない要求（画像・fetch・xhr など。Guard が通したもの）の数の上限
//   （`PAGE_SUBRESOURCE_REQUEST_LIMIT`。1,000 件）。`fetch` と画像を出し続ける画面で、届いた数は上限以下になり、その画面は読み切れない（入口の確かめは
//   `READ_FAILED`、発見は `INCOMPLETE_PAGE_SUBRESOURCE_LIMIT`、READ は `PAGE_NOT_SETTLED`、監査はビューポートの `PAGE_SUBRESOURCE_LIMIT_REACHED`）。
//   届いた数を成果物に残す（`subresourceRequests`）。少しの要求を出す画面は、今どおり読める。
// 自前の 127.0.0.1 のサーバ。Chromium はテストの既定の headless と、CLI の起動の設定の両方。全部の後に、名前つきの時間だけ待ってから数え直す。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { EntryCheckDocument } from '../../src/control/entry-check.js';
import { ENTRY_CHECK_ARTIFACT_FILE_NAME, PAGES_ARTIFACT_DIRECTORY, artifactFilePath } from '../../src/core/artifact-layout.js';
import type { PageAuditResult } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import { DISCOVERY_SETTLE_POLICY, type DiscoverySettlePolicy } from '../../src/discovery/settle.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME, PAGE_SUBRESOURCE_REQUEST_LIMIT } from '../../src/safety/passive-request-guard.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { executeEntryCheckRun } from '../../src/worker/entry-check-run.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { LOADED_DEADLINE_FACTOR, LOADED_RESOURCE_SETTLING_TIMEOUT_MS } from '../helpers/loaded-deadline.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer, forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { fastRunConfig } from '../helpers/run-harness.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 240_000;
/**
 * TS-c: 落ち着きの待ちの上限（ms）。この画面たちの多くは落ち着かない（読み込み直し・移動・要求を出し続ける）ので、どの段も上限まで待つ。入口の確かめ・
 * 発見・画面の READ には、本番の上限（`DISCOVERY_SETTLE_TIMEOUT_MS`。5 秒）の代わりに、この上限の指定（`SETTLE_POLICY`）を注入し、監査の段には、
 * 設定の `crawl.resourceSettlingTimeoutMs`（既定 5 秒）にこの値を入れる。期限そのものは、落ち着きの待ちの単体テスト（`tests/unit/discovery-settle.test.ts`）と
 * 発見の probe の結合テスト（`tests/integration/discovery-probe.test.ts`）が確かめる。要求を出し続ける画面は、1 秒ほどで上限（1,000 件）に届くので、
 * 混雑の下の余裕を見て 3 秒にする。
 */
const SETTLE_TIMEOUT_MS = 3_000;
const SETTLE_POLICY: DiscoverySettlePolicy = Object.freeze({ ...DISCOVERY_SETTLE_POLICY, timeoutMs: SETTLE_TIMEOUT_MS });
/**
 * DEF-174: 落ち着くことを確かめる場面（落ち着かない理由が付かない、COMPLETE、READ・NOT_MATCHED になる）の落ち着きの待ちの指定。短い上限
 * （`SETTLE_POLICY`）では、混雑の下で落ち着く前に切れて `INCOMPLETE_SETTLE_TIMEOUT` になったので、本番の上限に混雑の倍率（`loaded-deadline.ts`）を
 * 掛ける。落ち着く画面は上限より前に終わるので、ふだんの時間は変わらない。監査の段の期限は `LOADED_RESOURCE_SETTLING_TIMEOUT_MS`。
 */
const SETTLING_POLICY: DiscoverySettlePolicy = Object.freeze({
  ...DISCOVERY_SETTLE_POLICY, timeoutMs: DISCOVERY_SETTLE_POLICY.timeoutMs * LOADED_DEADLINE_FACTOR,
});
/** 場面の画面が落ち着くか（`SETTLING`: 落ち着くことを確かめる。`NOT_SETTLING`: 落ち着かず、短い上限で切れることを確かめる）。 */
type SettleMode = 'SETTLING' | 'NOT_SETTLING';
const settlePolicyOf = (mode: SettleMode): DiscoverySettlePolicy => (mode === 'SETTLING' ? SETTLING_POLICY : SETTLE_POLICY);
/** 各ジョブの後に、遅れて届く要求を待つ時間（ms。読み込み直しが続いていれば、その間にも届く）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
/** 画面の READ の期待の、どの画面にもない文字。 */
const ABSENT_TEXT = '画面にない文字';

const PATHS = Object.freeze({
  reload: '/reload',
  jsRedirect: '/js-redirect',
  meta: '/meta',
  landing: '/landing',
  // T37R2-fix（T37R2 の I-1）: 子の frame の読み込み直しと移動。
  iframeReload: '/iframe-reload',
  frameReload: '/frame-reload',
  iframeNavigation: '/iframe-navigation',
  frameTarget: '/frame-target',
  iframeForward: '/iframe-forward',
  frameForward: '/frame-forward',
  // DEF-130-fix: 文書でない要求を出し続ける画面と、少しだけ出す画面。
  fetchLoop: '/fetch-loop',
  imageLoop: '/image-loop',
  fewRequests: '/few-requests',
} as const);

/** DEF-130-fix: ページの JS が出す、文書でない要求の path（サーバは 200 で応え、数える）。 */
const SUBRESOURCE_PATHS: ReadonlySet<string> = new Set(['/api/ping', '/px']);
/** DEF-130-fix: 少しだけ出す画面の要求の数。 */
const FEW_REQUESTS = 30;
/** DEF-130-fix: ブラウザ自身が出す favicon の要求（CLI の起動の設定の Chromium は出す。Guard が通す文書でない要求に数える）の最大の数。 */
const BROWSER_FAVICON_REQUESTS = 1;

const pageOf = (body: string, head = ''): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8">${head}<title>画面</title></head><body><main>${body}</main></body></html>`;
const LOGIN_FORM = '<form method="post" action="/session"><label>ユーザー <input id="u" name="u" type="text"></label>'
  + '<label>パスワード <input id="p" name="p" type="password"></label><button id="s" type="submit">ログイン</button></form>';

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  [PATHS.reload]: pageOf(`${LOGIN_FORM}<form method="get" action="/search"><input name="q"><button type="submit">検索</button></form>`
    + '<script>setTimeout(() => location.reload(), 80);</script>'),
  [PATHS.jsRedirect]: pageOf(`<p>移ります</p><script>setTimeout(() => { location.href = '${PATHS.landing}'; }, 50);</script>`),
  [PATHS.meta]: pageOf('<p>移ります</p>', `<meta http-equiv="refresh" content="0;url=${PATHS.landing}">`),
  [PATHS.landing]: pageOf(`${LOGIN_FORM}<form method="get" action="/search"><input name="q"><button type="submit">検索</button></form>`),
  // T37R2-fix: 子の frame が自分を読み込み直す画面、親が子の frame を移し続ける画面、子の frame が 1 回だけ転送する画面。
  [PATHS.iframeReload]: pageOf(`${LOGIN_FORM}<iframe src="${PATHS.frameReload}" title="子" style="width:10px;height:10px"></iframe>`),
  [PATHS.frameReload]: pageOf('<p>子</p><script>setTimeout(() => location.reload(), 80);</script>'),
  [PATHS.iframeNavigation]: pageOf(`${LOGIN_FORM}<iframe src="${PATHS.frameTarget}" title="子" style="width:10px;height:10px"></iframe>`
    + `<script>let n = 0; setInterval(() => { n += 1; window.frames[0].location.href = '${PATHS.frameTarget}?n=' + n; }, 60);</script>`),
  [PATHS.frameTarget]: pageOf('<p>子</p>'),
  [PATHS.iframeForward]: pageOf(`${LOGIN_FORM}<iframe src="${PATHS.frameForward}" title="子" style="width:10px;height:10px"></iframe>`),
  [PATHS.frameForward]: pageOf(`<p>移ります</p><script>setTimeout(() => { location.href = '${PATHS.frameTarget}'; }, 50);</script>`),
  // DEF-130-fix: 20 ms ごとに 20 件の `fetch`（または画像）を出し続ける画面（1 秒に約 1,000 件）と、30 件の `fetch` を 1 回だけ出す画面。
  [PATHS.fetchLoop]: pageOf(`${LOGIN_FORM}<script>setInterval(() => { for (let i = 0; i < 20; i += 1) `
    + "fetch('/api/ping?t=' + Math.random()).catch(() => 0); }, 20);</script>"),
  [PATHS.imageLoop]: pageOf(`${LOGIN_FORM}<script>setInterval(() => { for (let i = 0; i < 20; i += 1) `
    + "new Image().src = '/px?t=' + Math.random(); }, 20);</script>"),
  [PATHS.fewRequests]: pageOf(`${LOGIN_FORM}<script>for (let i = 0; i < ${FEW_REQUESTS}; i += 1) `
    + "fetch('/api/ping?i=' + i).catch(() => 0);</script>"),
});

describe.each(LAUNCHERS)('DEF-129: the main frame loads started by the page itself with %s', (_label, launch) => {
  let site: LoopbackHttpServer;
  let workDirectory = '';
  let runCount = 0;
  const documents: string[] = [];
  /** DEF-130-fix: サーバに届いた、文書でない要求の数。 */
  let subresources = 0;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-page-navigation-limit-'));
    site = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const pathname = new URL(request.url ?? '/', 'http://x').pathname;
      if (SUBRESOURCE_PATHS.has(pathname)) {
        subresources += 1;
        response.writeHead(HTTP_OK, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('ok');
        return;
      }
      const body = PAGES[pathname];
      if (request.method === 'GET' && body !== undefined) {
        documents.push(pathname);
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
        return;
      }
      response.writeHead(HTTP_NOT_FOUND, { 'content-type': 'text/plain' }).end('nf');
    });
  });

  afterAll(async () => {
    await site?.close();
    await rm(workDirectory, { recursive: true, force: true });
  });

  const configOf = (path: string, mode: SettleMode = 'NOT_SETTLING'): AuditConfig => {
    runCount += 1;
    return fastRunConfig(site.origin, path, {
      target: { id: `navigation-limit-${runCount}` }, output: { directory: join(workDirectory, `run-${runCount}`) },
      crawl: { maxPages: 1, resourceSettlingTimeoutMs: mode === 'SETTLING' ? LOADED_RESOURCE_SETTLING_TIMEOUT_MS : SETTLE_TIMEOUT_MS },
    });
  };

  /** この流れの間に、`path` の文書の要求がサーバに届いた数（全部の後に待って数え直す）。 */
  const documentsSince = async (start: number, path: string): Promise<number> => {
    await wait(LATE_REQUEST_WAIT_MS);
    return documents.slice(start).filter((reached) => reached === path).length;
  };

  const entryCheck = async (
    path: string,
    mode: SettleMode = 'NOT_SETTLING',
  ): Promise<{ readonly document: EntryCheckDocument; readonly reached: number; readonly own: number }> => {
    const config = configOf(path, mode);
    const pacer = createTestNavigationPacer(config);
    let own = 0;
    const start = documents.length;
    const outcome = await executeEntryCheckRun({
      config, jobId: `job-entry-${runCount}`, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      settlePolicy: settlePolicyOf(mode),
      navigationPacer: forwardingNavigationPacer(pacer, async () => {
        own += 1;
        return pacer.beforeNavigation();
      }),
    }, { onRunStarted: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the entry check did not run: ${outcome.kind}`);
    }
    const reached = await documentsSince(start, path);
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ENTRY_CHECK_ARTIFACT_FILE_NAME), 'utf8')) as EntryCheckDocument;
    return { document, reached, own };
  };

  const discover = async (
    path: string,
    mode: SettleMode = 'NOT_SETTLING',
  ): Promise<{ readonly document: DiscoveryDocument; readonly reached: number }> => {
    const config = configOf(path, mode);
    const start = documents.length;
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-discovery-${runCount}`, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal, settlePolicy: settlePolicyOf(mode),
      authentication: {
        initialState: { cookies: [], origins: [] },
        approvedTestOrigins: [site.origin],
        auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: '/login-page',
        filterState: filterAuthenticatedState,
      },
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    const reached = await documentsSince(start, path);
    return { document: JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument, reached };
  };

  it('keeps the document requests of a reloading page within the limit in the entry check, and does not read it', async () => {
    const { document, reached, own } = await entryCheck(PATHS.reload);
    expect(own).toBe(1);
    expect(reached).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);
    expect(document.endReason).toBe('READ_FAILED');
    expect(document.documentRequests).toBe(reached);
  }, TEST_TIMEOUT_MS);

  it('keeps the document requests of a reloading page within the limit in the discovery, and marks the page as not read in full', async () => {
    const { document, reached } = await discover(PATHS.reload);
    expect(reached).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);
    const [page] = document.pages;
    expect(page?.state).toBe('READ');
    expect(page?.state === 'READ' ? page.record.incompleteReasons : []).toContain('INCOMPLETE_PAGE_NAVIGATION_LIMIT');
    expect(page?.state === 'READ' ? page.documentRequests : null).toBe(reached);
    expect(document.runStatus).toBe('PARTIAL');
  }, TEST_TIMEOUT_MS);

  it('keeps the document requests of a reloading page within the limit for each load of BeakSight in the audit', async () => {
    const config = configOf(PATHS.reload);
    const pacer = createTestNavigationPacer(config);
    let own = 0;
    const start = documents.length;
    const outcome = await executeAuditRun(config, {
      launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      navigationPacer: forwardingNavigationPacer(pacer, async () => {
        own += 1;
        return pacer.beforeNavigation();
      }),
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    const reached = await documentsSince(start, PATHS.reload);
    expect(own).toBeGreaterThan(0);
    expect(reached).toBeLessThanOrEqual(own * (PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1));
    // 成果物: ビューポートは読み切れない（`PAGE_NAVIGATION_LIMIT_REACHED`）。届いた文書の要求の数を残す。
    const [pageId] = readdirSync(join(outcome.runDirectory, PAGES_ARTIFACT_DIRECTORY));
    const page = JSON.parse(readFileSync(join(outcome.runDirectory, PAGES_ARTIFACT_DIRECTORY, pageId ?? '', 'page.json'), 'utf8')) as PageAuditResult;
    const desktop = page.viewports.desktop;
    expect(desktop.incompleteReasons.map(({ code }) => code)).toContain('PAGE_NAVIGATION_LIMIT_REACHED');
    expect(desktop.status).toBe('PARTIAL');
    expect(desktop.documentRequests).toBeGreaterThan(1);
    expect(desktop.documentRequests).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);
  }, TEST_TIMEOUT_MS);

  /** 画面の path の READ の確かめ（期待は、画面にない文字）。 */
  const pageReadCheck = async (
    path: string,
    mode: SettleMode = 'NOT_SETTLING',
  ): Promise<{ readonly document: ReadEvidenceDocument; readonly reached: number }> => {
    const config = configOf(path, mode);
    const start = documents.length;
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-${runCount}`, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      settlePolicy: settlePolicyOf(mode),
      authentication: {
        initialState: { cookies: [], origins: [] },
        approvedTestOrigins: [site.origin],
        auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: '/login-page',
        filterState: filterAuthenticatedState,
      },
      readChecks: [{
        readCheckId: 'read-1', readCheckRevision: 1, targetPage: { origin: site.origin, path },
        definition: { targetPagePath: path, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: ABSENT_TEXT }] },
      }],
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    const reached = await documentsSince(start, path);
    return { document: JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument, reached };
  };

  it('keeps the document requests of a reloading page within the limit in the page READ, and does not judge the page that did not settle', async () => {
    const { document, reached } = await pageReadCheck(PATHS.reload);
    expect(reached).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);
    const [check] = document.checks;
    expect(check?.state === 'EXECUTED' ? [check.result, check.expectations[0]?.undeterminedReason, check.documentRequests] : null)
      .toEqual(['UNDETERMINED', 'PAGE_NOT_SETTLED', reached]);
  }, TEST_TIMEOUT_MS);

  it('judges the page READ after one JS forward as before', async () => {
    const { document } = await pageReadCheck(PATHS.jsRedirect, 'SETTLING');
    const [check] = document.checks;
    expect(check?.state === 'EXECUTED' ? check.result : null).toBe('NOT_MATCHED');
  }, TEST_TIMEOUT_MS);

  it.each([PATHS.jsRedirect, PATHS.meta])('still reads the page after one forward (%s)', async (path) => {
    const entry = await entryCheck(path, 'SETTLING');
    expect(entry.document.endReason).toBe('READ');
    expect(entry.document.landing?.path).toBe(PATHS.landing);
    const { document } = await discover(path, 'SETTLING');
    const [page] = document.pages;
    expect(page?.state === 'READ' ? [page.record.location?.path, page.record.incompleteReasons] : null).toEqual([PATHS.landing, []]);
    expect(document.runStatus).toBe('COMPLETE');
  }, TEST_TIMEOUT_MS);

  // T37R2-fix（T37R2 の I-1。設計書 8 章の最後の行）: 子の frame の、ページが始めた文書の読み込みも、frame ごとに上限（2 回）まで。数え方は main frame と
  // 同じ（各 frame の最初の文書の後から数える。転送の続きは数えない。判定が通した後だけ数える）。超えたら Guard が止めて記録し、その画面を読み切れない
  // 画面にする（main frame と同じ扱い）。子の frame の文書の要求の数を、別の数（`childFrameDocumentRequests`）として成果物に残す。
  const audit = async (path: string): Promise<{ readonly own: number; readonly start: number; readonly page: PageAuditResult }> => {
    const config = configOf(path);
    const pacer = createTestNavigationPacer(config);
    let own = 0;
    const start = documents.length;
    const outcome = await executeAuditRun(config, {
      launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      navigationPacer: forwardingNavigationPacer(pacer, async () => {
        own += 1;
        return pacer.beforeNavigation();
      }),
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    const [pageId] = readdirSync(join(outcome.runDirectory, PAGES_ARTIFACT_DIRECTORY));
    const page = JSON.parse(readFileSync(join(outcome.runDirectory, PAGES_ARTIFACT_DIRECTORY, pageId ?? '', 'page.json'), 'utf8')) as PageAuditResult;
    return { own, start, page };
  };

  it.each([
    { name: 'reloading itself', path: PATHS.iframeReload, frame: PATHS.frameReload },
    { name: 'moved again and again by the parent', path: PATHS.iframeNavigation, frame: PATHS.frameTarget },
  ])('keeps the document requests of a child frame $name within the limit in the entry check, the discovery, the page READ and the audit', async ({ path, frame }) => {
    let start = documents.length;
    const entry = await entryCheck(path);
    const entryFrames = await documentsSince(start, frame);
    expect(entry.own).toBe(1);
    expect(entryFrames).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);
    expect(entry.document.endReason).toBe('READ_FAILED');
    expect(entry.document.childFrameDocumentRequests).toBeGreaterThan(1);
    expect(entry.document.childFrameDocumentRequests).toBeLessThanOrEqual(entryFrames);

    start = documents.length;
    const discovery = await discover(path);
    expect(await documentsSince(start, frame)).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);
    const [page] = discovery.document.pages;
    expect(page?.state === 'READ' ? page.record.incompleteReasons : []).toContain('INCOMPLETE_PAGE_NAVIGATION_LIMIT');
    expect(page?.state === 'READ' ? page.childFrameDocumentRequests : null).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);
    expect(discovery.document.runStatus).toBe('PARTIAL');

    start = documents.length;
    const read = await pageReadCheck(path);
    expect(await documentsSince(start, frame)).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);
    const [check] = read.document.checks;
    expect(check?.state === 'EXECUTED' ? [check.result, check.expectations[0]?.undeterminedReason] : null).toEqual(['UNDETERMINED', 'PAGE_NOT_SETTLED']);
    expect(check?.state === 'EXECUTED' ? check.childFrameDocumentRequests : null).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);

    const audited = await audit(path);
    expect(audited.own).toBeGreaterThan(0);
    expect(await documentsSince(audited.start, frame)).toBeLessThanOrEqual(audited.own * (PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1));
    const desktop = audited.page.viewports.desktop;
    expect(desktop.incompleteReasons.map(({ code }) => code)).toContain('PAGE_NAVIGATION_LIMIT_REACHED');
    expect(desktop.childFrameDocumentRequests).toBeGreaterThan(1);
    expect(desktop.childFrameDocumentRequests).toBeLessThanOrEqual(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME + 1);
  }, TEST_TIMEOUT_MS);

  it('still reads the page whose child frame forwards once', async () => {
    const entry = await entryCheck(PATHS.iframeForward, 'SETTLING');
    expect(entry.document.endReason).toBe('READ');
    expect(entry.document.childFrameDocumentRequests).toBe(2);
    const { document } = await discover(PATHS.iframeForward, 'SETTLING');
    const [page] = document.pages;
    // 子の frame のある画面は、今どおり子の frame を読まない印（`INCOMPLETE_FRAME_OR_CLOSED_SHADOW`）が付く。上限の印は付かない。
    expect(page?.state === 'READ' ? page.record.incompleteReasons : null).toEqual(['INCOMPLETE_FRAME_OR_CLOSED_SHADOW']);
    expect(page?.state === 'READ' ? page.childFrameDocumentRequests : null).toBe(2);
    const read = await pageReadCheck(PATHS.iframeForward, 'SETTLING');
    const [check] = read.document.checks;
    expect(check?.state === 'EXECUTED' ? check.result : null).toBe('NOT_MATCHED');
  }, TEST_TIMEOUT_MS);

  // DEF-130-fix: 文書でない要求の数の上限（1 画面の読み込みあたり。数え始めは BeakSight 自身の読み込みか、その Context の最初の文書）。
  /** 全部の後に待って、`start` からサーバに届いた文書でない要求の数を数え直す。 */
  const subresourcesSince = async (start: number): Promise<number> => {
    await wait(LATE_REQUEST_WAIT_MS);
    return subresources - start;
  };

  it.each([
    { name: 'fetch', path: PATHS.fetchLoop },
    { name: 'image', path: PATHS.imageLoop },
  ])('keeps the $name requests of a page within the limit in the entry check, the discovery, the page READ and the audit', async ({ path }) => {
    let start = subresources;
    const entry = await entryCheck(path);
    expect(await subresourcesSince(start)).toBeLessThanOrEqual(PAGE_SUBRESOURCE_REQUEST_LIMIT);
    expect(entry.document.endReason).toBe('READ_FAILED');
    expect(entry.document.subresourceRequests).toBe(PAGE_SUBRESOURCE_REQUEST_LIMIT);

    start = subresources;
    const discovery = await discover(path);
    expect(await subresourcesSince(start)).toBeLessThanOrEqual(PAGE_SUBRESOURCE_REQUEST_LIMIT);
    const [page] = discovery.document.pages;
    expect(page?.state === 'READ' ? page.record.incompleteReasons : []).toContain('INCOMPLETE_PAGE_SUBRESOURCE_LIMIT');
    expect(page?.state === 'READ' ? page.subresourceRequests : null).toBe(PAGE_SUBRESOURCE_REQUEST_LIMIT);
    expect(discovery.document.runStatus).toBe('PARTIAL');

    start = subresources;
    const read = await pageReadCheck(path);
    expect(await subresourcesSince(start)).toBeLessThanOrEqual(PAGE_SUBRESOURCE_REQUEST_LIMIT);
    const [check] = read.document.checks;
    expect(check?.state === 'EXECUTED' ? [check.result, check.expectations[0]?.undeterminedReason, check.subresourceRequests] : null)
      .toEqual(['UNDETERMINED', 'PAGE_NOT_SETTLED', PAGE_SUBRESOURCE_REQUEST_LIMIT]);

    start = subresources;
    const audited = await audit(path);
    expect(audited.own).toBeGreaterThan(0);
    expect(await subresourcesSince(start)).toBeLessThanOrEqual(audited.own * PAGE_SUBRESOURCE_REQUEST_LIMIT);
    const desktop = audited.page.viewports.desktop;
    expect(desktop.incompleteReasons.map(({ code }) => code)).toContain('PAGE_SUBRESOURCE_LIMIT_REACHED');
    expect(desktop.status).toBe('PARTIAL');
    expect(desktop.subresourceRequests).toBeGreaterThan(0);
    expect(desktop.subresourceRequests).toBeLessThanOrEqual(PAGE_SUBRESOURCE_REQUEST_LIMIT);
  }, TEST_TIMEOUT_MS);

  it('still reads the page that sends a few requests, and keeps their number', async () => {
    /** 成果物の数が、ページの要求の数（と、ブラウザ自身の favicon）であること。 */
    const expectFewRequests = (count: number | undefined): void => {
      expect(count).toBeGreaterThanOrEqual(FEW_REQUESTS);
      expect(count).toBeLessThanOrEqual(FEW_REQUESTS + BROWSER_FAVICON_REQUESTS);
    };
    const entry = await entryCheck(PATHS.fewRequests, 'SETTLING');
    expect(entry.document.endReason).toBe('READ');
    expectFewRequests(entry.document.subresourceRequests);
    const { document } = await discover(PATHS.fewRequests, 'SETTLING');
    const [page] = document.pages;
    expect(page?.state === 'READ' ? page.record.incompleteReasons : null).toEqual([]);
    expectFewRequests(page?.state === 'READ' ? page.subresourceRequests : undefined);
    expect(document.runStatus).toBe('COMPLETE');
    const read = await pageReadCheck(PATHS.fewRequests, 'SETTLING');
    const [check] = read.document.checks;
    expect(check?.state === 'EXECUTED' ? check.result : null).toBe('NOT_MATCHED');
    expectFewRequests(check?.state === 'EXECUTED' ? check.subresourceRequests : undefined);
  }, TEST_TIMEOUT_MS);
});

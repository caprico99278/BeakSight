// L6/L3-1（設計書 `doc/design/2026-11-09-beaksight-remove-limits-design.md` 5 の 1、6 の L3・L6）: 操作さがしの読み取りと押す部品の期限を外し、1 画面の
// 発見と押す輪を 1 つの進みの見張り（L0 の `watchProgress`）で包む。本物の factory・Guard・凍結・probe と、127.0.0.1 の仮のサイト（一般の文言）で確かめる。
// - 読み取りに 15 秒かかる画面（前の読み取りの期限 10 秒を超える）: 打ち切らずに読む。
// - 押す呼び出しに 8 秒かかる画面（押した後の受け手がページを 8 秒ふさぐ。前の 1 手の期限 5 秒を超える）: 待って、送信の型を記録する。
// - 全く反応のない画面（押した後の受け手がページを長くふさぐ）: 見張りの長さ（テストで短く注入する）で「応答しなかった」として、その画面を終える。前に押した
//   候補の記録は残り、残りの候補と画面の記録に `STAGE_UNRESPONSIVE` が付く。発見は次へ進み、終わる。
// - どの場面でも、サーバに届いた読み取りでない要求は 0（名前つきの時間だけ待ってから数える）。
// Chromium はテストの既定だけ（TEST-POLICY の 3）。監査の段の送信の扱いは PASS_EXCEPT_DELETE（本番の既定）と READ_ONLY。順に動かす（同時には動かさない）。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { wait } from '../../src/core/deadline.js';
import { PROGRESS_WATCH_QUIET_LIMIT_MS } from '../../src/core/progress-watch.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { discoverPageCandidates, settleAndFreezePage } from '../../src/discovery/discover-page.js';
import { discoveryCandidatesOf, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { InFlightRequestCounter, type DiscoverySettlePolicy } from '../../src/discovery/settle.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { probeQuietWindowsOf } from '../helpers/test-waits.js';

const TEST_TIMEOUT_MS = 240_000;
/** 押した後に静まるまで待つ時間（ms。テストの値）。 */
const SHORT_QUIET_WAIT_MS = 500;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 200;
/** 遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 2_000;
/** 前の読み取りの期限（`DISCOVERY_READ_TIMEOUT_MS`・`SUBMISSION_PROBE_READ_TIMEOUT_MS`）と、前の 1 手の期限（`SUBMISSION_PROBE_STEP_TIMEOUT_MS`）。 */
const FORMER_READ_LIMIT_MS = 10_000;
const FORMER_STEP_LIMIT_MS = 5_000;
/** 読み取りをふさぐ長さ（前の読み取りの期限を超える）と、押す呼び出しをふさぐ長さ（前の 1 手の期限を超える）。 */
const SLOW_READ_BLOCK_MS = 15_000;
const SLOW_PRESS_BLOCK_MS = 8_000;
/** テストで注入する、見張りの反応なしの長さ（前の期限と遅れより長い）。 */
const INJECTED_QUIET_LIMIT_MS = 25_000;
/** 全く反応のない画面の場面で注入する、見張りの反応なしの長さと、ページをふさぐ長さ（見張りの長さより十分に長い）。 */
const UNRESPONSIVE_QUIET_LIMIT_MS = 8_000;
const UNRESPONSIVE_BLOCK_MS = 40_000;
/** 落ち着きの待ち（テストの値。ふさいだ画面では読めないので短くして、読み取りの期限の場面に早く入る）。 */
const SHORT_SETTLE_POLICY: DiscoverySettlePolicy = Object.freeze({ timeoutMs: 500, networkQuietMs: 100, pollIntervalMs: 50, probeIntervalMs: 100 });
const IDENTITY_API_PATH = '/api/items';

// TEST-POLICY の 3: 2 つの Chromium で流すのは安全の漏れの確かめだけなので、この振る舞いの場面は既定の Chromium だけで流す。
const CASES = DEFAULT_CHROMIUM_LAUNCHERS.flatMap(([label, launch]) =>
  (['PASS_EXCEPT_DELETE', 'READ_ONLY'] as const).map((sendPolicy) => [`${label}, ${sendPolicy}`, launch, sendPolicy] as const));

const htmlOf = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>`
  + `<link rel="icon" href="data:,"></head><body>${body}</body></html>`;
/** ページをふさぐ受け手（同期の繰り返しで main thread を使い続ける）。 */
const blockFor = (ms: number): string => `const end = Date.now() + ${String(ms)}; while (Date.now() < end) { /* ふさぐ */ }`;
const SAVE_FETCH = `fetch('${IDENTITY_API_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('name').value }) }).catch(() => {});`;

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  // 読み取りの場面: テストが凍結の後にふさぐ（ページの作りは普通の登録の画面）。
  '/slow-read': htmlOf('read', `<main><h1>登録</h1><form method="post" action="/items"><label>名前 <input name="name"></label><button type="submit">登録</button></form></main>`),
  // 押す呼び出しに 8 秒かかる画面: 保存の受け手が 8 秒ふさいでから送る。
  '/slow-press': htmlOf('press', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></main>
<script>document.getElementById('save').addEventListener('click', () => { ${blockFor(SLOW_PRESS_BLOCK_MS)} ${SAVE_FETCH} });</script>`),
  // 全く反応のない画面: 保存は普通に送る。登録は押すとページを長くふさぐ（保存の後に押す。同じ段の中は文書の順）。
  '/stuck': htmlOf('stuck', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button>
<button type="button" id="create">登録</button></main>
<script>document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });
document.getElementById('create').addEventListener('click', () => { ${blockFor(UNRESPONSIVE_BLOCK_MS)} });</script>`),
  // 押す 1 手が返らない画面（ページは応答する）: 保存を押すと、画面全体を覆う枠が出て、次の登録の押下は的に届かない（Playwright の押す 1 手が待ち続ける）。
  '/covered': htmlOf('covered', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button>
<button type="button" id="create">登録</button></main>
<script>document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH}
  const cover = document.createElement('div'); cover.style.cssText = 'position:fixed;inset:0;z-index:99;background:transparent'; document.body.append(cover); });
document.getElementById('create').addEventListener('click', () => {});</script>`),
  // L6/L3-1 の続き（A1）: 一覧の「編集」でモーダルの窓が開き、窓の中の「保存」で送る画面。窓が開いた後の段で、窓の後ろの「編集」は覆われていて押せない。
  '/modal': htmlOf('modal', `<main><h1>一覧</h1><table><tr><td>行</td><td><button type="button" id="edit">編集</button></td></tr></table>
<dialog id="dlg"><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></dialog></main>
<script>document.getElementById('edit').addEventListener('click', () => { document.getElementById('dlg').showModal(); });
document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} document.getElementById('dlg').close(); });</script>`),
  // L6/L3-1 の続き（A1）: 保存のボタンの中心だけを、小さな印の表示が覆う画面（四隅は押せる）。
  '/partly-covered': htmlOf('partly', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label>
<div style="position:relative;display:inline-block"><button type="button" id="save" style="width:160px;height:48px">保存</button>
<span style="position:absolute;left:70px;top:14px;width:20px;height:20px;background:#c00;border-radius:10px"></span></div></main>
<script>document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
});

/** 認証の指定（状態なし。ログインのない形）。 */
const authenticationOf = (origin: string): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: null,
  filterState: filterAuthenticatedState,
});

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('L6/L3-1: the discovery reads a slow page without the former read limit (%s)', (_label, launch) => {
  let browser: Browser;
  let server: LoopbackHttpServer;

  beforeAll(async () => {
    browser = await launch();
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const page = PAGES[new URL(request.url ?? '/', 'http://127.0.0.1').pathname];
      response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page ?? '');
    });
  });

  afterAll(async () => {
    await server?.close();
    await browser?.close();
  });

  it(`reads the candidates of a page whose read takes ${String(SLOW_READ_BLOCK_MS)} ms (more than the former ${String(FORMER_READ_LIMIT_MS)} ms)`, async () => {
    const config = createTestConfig(server.origin);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    try {
      const page = await factory.createPassivePage(context);
      const counter = new InFlightRequestCounter(page);
      await page.goto(`${server.origin}/slow-read`);
      expect((await settleAndFreezePage(page, { requestCounter: counter, settlePolicy: SHORT_SETTLE_POLICY })).status).toBe('FROZEN');
      // 凍結の後に、ページを 15 秒ふさぐ（次の読み取りは、ふさぎが終わるまで返らない）。
      await page.evaluate(`setTimeout(() => { ${blockFor(SLOW_READ_BLOCK_MS)} }, 0)`);
      const startedAt = Date.now();
      const record = await discoverPageCandidates(page, {
        classificationPolicy: { allowedOrigins: new Set([server.origin]) }, requestCounter: counter, settlePolicy: SHORT_SETTLE_POLICY, alreadyFrozen: true,
      });
      counter.dispose();
      // 読み取りは、前の期限を超えて待った。
      expect(Date.now() - startedAt).toBeGreaterThan(FORMER_READ_LIMIT_MS);
      expect(record.incompleteReasons).not.toContain('INCOMPLETE_READ_FAILED');
      expect(record.candidates.filter((candidate) => candidate.kind === 'FORM')).toHaveLength(1);
    } finally {
      await closePassiveResources({ factory, context });
      await factory.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe.each(CASES)('L6/L3-1: one progress watch per page in the discovery run (%s)', (_label, launch, sendPolicy) => {
  let server: LoopbackHttpServer;
  let directory = '';
  const seen: { readonly method: string; readonly path: string }[] = [];

  beforeAll(async () => {
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      seen.push({ method: request.method ?? '', path: url.pathname });
      request.resume();
      const page = PAGES[url.pathname];
      response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page ?? '');
    });
    directory = await mkdtemp(join(tmpdir(), 'beaksight-screen-watch-'));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
    if (directory !== '') await rm(directory, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  let runNumber = 0;
  const run = async (startPath: string, quietLimitMs: number): Promise<DiscoveryDocument> => {
    runNumber += 1;
    const config = createTestConfig(server.origin, startPath, {
      crawl: { maxPages: 1, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
      audit: { screenshots: false, sendPolicy },
      output: { directory: join(directory, `run-${String(runNumber)}`) },
    });
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-screen-watch-${String(runNumber)}`, authentication: authenticationOf(server.origin),
      launchBrowser: launch, clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      observationWindows: probeQuietWindowsOf(SHORT_QUIET_WAIT_MS), progressQuietLimitMs: quietLimitMs,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    const validation = await validateArtifact('discovery', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    return document;
  };
  const probeOf = (document: DiscoveryDocument, word: string) =>
    mergeDiscoveryCandidates(discoveryCandidatesOf(document)).find((candidate) => candidate.submitterWords.includes(word))?.submissionProbe;
  const nonReadsSince = async (since: number): Promise<readonly string[]> => {
    await wait(LATE_REQUEST_WAIT_MS);
    return seen.slice(since).filter(({ method }) => !READ_METHODS.has(method)).map(({ method, path }) => `${method} ${path}`);
  };

  it(`waits for a press call that takes ${String(SLOW_PRESS_BLOCK_MS)} ms (more than the former ${String(FORMER_STEP_LIMIT_MS)} ms) and records the shape`, async () => {
    const since = seen.length;
    const document = await run('/slow-press', INJECTED_QUIET_LIMIT_MS);
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('ends a page that does not respond at all as STAGE_UNRESPONSIVE, keeps the earlier press, and finishes the run', async () => {
    const since = seen.length;
    const startedAt = Date.now();
    const document = await run('/stuck', UNRESPONSIVE_QUIET_LIMIT_MS);
    // 見張りの長さで終えた（ページのふさぎが終わるのを待たない）。
    expect(Date.now() - startedAt).toBeLessThan(UNRESPONSIVE_BLOCK_MS);
    expect(document.endReason).toBe('COMPLETED');
    const page = document.pages.find((entry) => entry.state === 'READ');
    expect(page?.state === 'READ' ? page.record.incompleteReasons : []).toContain('STAGE_UNRESPONSIVE');
    // 前に押した保存の記録は残る。押しにかかった登録は「応答しなかった」。
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(probeOf(document, '登録')).toMatchObject({ result: 'NOT_OBSERVED', reason: 'STAGE_UNRESPONSIVE' });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // L6/L3-1 の続き（設計者の判断 A の案 A1）: モーダルの窓の後ろの「編集」は、押す前の hit-test で覆われていると分かるので押さず（待ち続けない）、窓の中の
  // 「保存」を押して型を取る。見張りの長さは本番の既定のまま（前は、窓の後ろの「編集」の押す 1 手が返らず、見張りの長さで画面を終えていた）。
  it('does not press the button behind a modal dialog and presses the save in the dialog without waiting for the watch', async () => {
    const since = seen.length;
    const startedAt = Date.now();
    const document = await run('/modal', PROGRESS_WATCH_QUIET_LIMIT_MS);
    expect(Date.now() - startedAt).toBeLessThan(PROGRESS_WATCH_QUIET_LIMIT_MS);
    expect(document.endReason).toBe('COMPLETED');
    const page = document.pages.find((entry) => entry.state === 'READ');
    expect(page?.state === 'READ' ? page.record.incompleteReasons : ['NOT_READ']).not.toContain('STAGE_UNRESPONSIVE');
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // L6/L3-1 の続き（A1）: 中心だけが覆われたボタンは、届く四隅の点を押して型を取る（中心の 1 点だけで判定すると、押さなくなる）。
  it('presses a save button whose centre only is covered, at a corner that the press reaches', async () => {
    const since = seen.length;
    const document = await run('/partly-covered', PROGRESS_WATCH_QUIET_LIMIT_MS);
    expect(document.endReason).toBe('COMPLETED');
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // 押す的が覆われた画面（ページは応答する）を、待ち続けずに終える。L6/L3-1 では、見張りの長さで終えることを確かめた（見回りを進みに数えると、待ち続けた）。
  // 案 A1 の後は、押す前の hit-test が覆われた的を押さないので、見張りの長さを待たずに終える。
  it('does not wait forever on a page whose press target is covered while the page itself keeps answering', async () => {
    const since = seen.length;
    const startedAt = Date.now();
    const document = await run('/covered', UNRESPONSIVE_QUIET_LIMIT_MS);
    expect(Date.now() - startedAt).toBeLessThan(UNRESPONSIVE_BLOCK_MS);
    expect(document.endReason).toBe('COMPLETED');
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    // 設計者の判断 A の案 A1 の後: 覆われた「登録」は、押す前の hit-test で覆われていると分かるので、押さずに次へ進む（押す 1 手を待ち続けない）。見回りを
    // 進みに数えない直しそのものは、単体テスト（`tests/unit/discovery-screen-watch.test.ts`）で確かめる。
    expect(probeOf(document, '登録')).toMatchObject({ result: 'NOT_OBSERVED', reason: 'COVERED_BY_OTHER' });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

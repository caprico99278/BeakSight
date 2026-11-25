// RCA-2・RCA-3（検索の確かめの設計書 `doc/design/2026-11-18-beaksight-search-check-design.md` 2.1）: 操作さがし（本物の `executeDiscoveryRun`）が、自分で起こした
// データの読み取りを、きっかけごとに形と状態で記録する。127.0.0.1 の仮のサイト（一般の文言）で確かめる。
// - 選ぶと取りに行く一覧: 選択肢ごとのきっかけ（`OPTION`）と状態（作り込んだ 500 を含む）。
// - JS で動く検索ボタン: 押下のきっかけ（`PRESS`）と、欄に入れた目印を運んだ query の名前。
// - 打つだけで動く検索（form もボタンもない欄）: 入力のきっかけ（`TYPED`）と、目印を運んだ query の名前。
// - サーバに届くのは読み取りだけ。成果物に URL の値・目印は残らず、スキーマに通る。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { beforeAll, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE } from '../../src/core/audit-send-policy.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryDocument, DiscoveryReadPageRecord } from '../../src/discovery/discovery-result.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig } from '../helpers/test-config.js';
import { observationWindowsOf } from '../../src/core/observation-windows.js';

/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 200;
/** ループバックの fixture の要求は数 ms で終わるので、画面の落ち着きと押した後の最短の観察を短くする（テストの値）。 */
const SHORT_WINDOWS = observationWindowsOf({
  discoverySettle: { networkQuietMs: 100, pollIntervalMs: 20, probeIntervalMs: 50 },
  afterPress: { probeQuietWaitMs: 150 },
});

const list = "fetch('/api/items?' + q).then((r) => r.json()).then((d) => { document.getElementById('out').innerHTML = d.items.map((i) => '<li>' + i + '</li>').join(''); })";
/** 1 画面に 3 つの形（打つだけの欄、JS で動く検索ボタン、選ぶと取りに行く select）を置く。 */
const PAGE = `<main><h1>一覧</h1>
  <input id="kw" name="kw" type="search">
  <input id="w" name="word" type="text"><button id="go" type="button">検索</button>
  <select id="st" name="status"><option value="">すべて</option><option value="open">受付</option><option value="closed">終了</option></select>
  <ul id="out"></ul></main>
  <script>
    document.getElementById('kw').addEventListener('input', (e) => { const q = 'q=' + encodeURIComponent(e.target.value); ${list}; });
    document.getElementById('go').addEventListener('click', () => { const q = 'word=' + encodeURIComponent(document.getElementById('w').value); ${list}; });
    document.getElementById('st').addEventListener('change', (e) => { const q = 'status=' + encodeURIComponent(e.target.value); ${list}; });
  </script>`;

const triggersOf = (document: DiscoveryDocument): NonNullable<DiscoveryReadPageRecord['searchTriggers']> =>
  document.pages.flatMap((page) => (page.state === 'READ' ? page.record.searchTriggers ?? [] : []));

/** 1 回の操作さがしの結果（beforeAll で 1 回だけ流す）。 */
let text = '';
let document: DiscoveryDocument | null = null;
const arrivals: { method: string; path: string }[] = [];

beforeAll(async () => {
  const server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    arrivals.push({ method: request.method ?? '', path: url.pathname });
    if (url.pathname === '/api/items') {
      response.statusCode = url.searchParams.get('status') === 'closed' ? 500 : 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ items: ['one', 'two'] }));
      return;
    }
    const found = url.pathname === '/';
    response.statusCode = found ? 200 : 404;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(found ? `<!doctype html><html lang="ja"><head><title>仮</title></head><body>${PAGE}</body></html>` : '');
  });
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-search-reads-'));
  const browsers: Browser[] = [];
  try {
    const config = createTestConfig(server.origin, '/', {
      crawl: { maxPages: 10, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
      audit: { screenshots: false, sendPolicy: AUDIT_SEND_PASS_EXCEPT_DELETE }, output: { directory },
    });
    const outcome = await executeDiscoveryRun({
      config, jobId: 'job-search-reads',
      authentication: {
        initialState: { cookies: [], origins: [] }, approvedTestOrigins: [server.origin],
        auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: '/login', filterState: filterAuthenticatedState,
      },
      launchBrowser: async () => {
        const browser = await launchHeadlessChromium();
        browsers.push(browser);
        return browser;
      },
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, observationWindows: SHORT_WINDOWS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined, onProgress: () => undefined });
    if (outcome.kind === 'RAN') {
      text = readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8');
      document = JSON.parse(text) as DiscoveryDocument;
    }
  } finally {
    for (const browser of browsers) await browser.close().catch(() => undefined);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('the data reads the discovery caused (RCA-2, RCA-3)', () => {
  const readsOf = (kind: string) => triggersOf(document as DiscoveryDocument)
    .filter(({ trigger }) => trigger.kind === kind).flatMap(({ reads }) => reads);

  it('records each choice of the select with the status of its read, the error 500 included', async () => {
    expect(document).not.toBeNull();
    const validation = await validateArtifact('discovery', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    expect(readsOf('OPTION').map(({ pathShape, queryNames, status }) => ({ pathShape, queryNames, status })))
      .toEqual(expect.arrayContaining([{ pathShape: '/api/items', queryNames: ['status'], status: 500 }, { pathShape: '/api/items', queryNames: ['status'], status: 200 }]));
  });

  it('records the press of the script search button and the input into the lone field, with the query names that carried the marker', () => {
    expect(readsOf('PRESS').map(({ markerQueryNames }) => markerQueryNames)).toContainEqual(['word']);
    expect(triggersOf(document as DiscoveryDocument).flatMap(({ trigger }) => (trigger.kind === 'TYPED' ? [trigger.field.name] : []))).toContain('kw');
    expect(readsOf('TYPED').map(({ markerQueryNames }) => markerQueryNames)).toContainEqual(['q']);
  });

  it('keeps no URL value or marker in the artifact, and the site receives reads only', () => {
    expect(text).not.toMatch(/bsprobe|status=closed|\/api\/items\?/u);
    expect(arrivals.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  });
});

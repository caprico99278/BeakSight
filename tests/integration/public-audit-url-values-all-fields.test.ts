// T44R の C-1（Task 44 の設計書の履歴の「T44R …と設計者の判断」の行）: 記録した要求の URL の値が、同じ値を持つ別の項目に残らない。独立レビューの実験
// （redact.exp.ts）の形を、確かめの形にした。公開の監査（CLI の Run。書き手の選び方は製品と同じ）で、ページが次の要求と項目に目印の値を入れる。
// - network・resource timing・server timing・telemetry の header と候補（fetch の query、trace の header つき、計測の語の path）
// - 画像の `src`・`resolvedUrl`（相対の `src`）、CSS の背景の画像、iframe、script の `src`
// - console の位置の URL と、ページの誤りの stack の中の URL（query つきの script が出す）
// - 応答の header の `location`（302 と 200）、リダイレクトの先
// - 止めた要求（beacon の POST）と止めた WebSocket の URL（Finding の本文にも入る）、失敗した要求（接続できない宛先）
// - T44R3 の I-1: 2 ページ目（`/form`）が自動で送る form の POST（止めた main frame のナビゲーション。Finding の本文と navigation timing にも入る）
// Run のディレクトリのすべてのファイル（page.json・audit.json・run.json・report.html・バンドルの中身・保存）に、どの目印も出ない。Chromium はテストの既定と
// CLI の起動の設定の両方。判定（リダイレクトの連鎖、Finding の identity）は伏せる前の値で行う（伏せるのは書き手の記録の前だけ）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { cliTargetConfig, findTextOccurrences, readRunArtifactFiles, runCliInProcess } from '../helpers/run-harness.js';

const TEST_TIMEOUT_MS = 240_000;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** 目印（項目ごとに 1 つ。値は query の値に入る）。 */
const MARKS = Object.freeze({
  telemetry: 'MKTELEM01', serverTiming: 'MKSRVTM02', image: 'MKLCPIM04', redirectFrom: 'MKREDIR05', redirectTo: 'MKREDIR06',
  beacon: 'MKBLOCK07', frame: 'MKFRAME08', network: 'MKNETWK09', script: 'MKSCRPT10', trace: 'MKTRACE11', cssBackground: 'MKCSSBG12',
  webSocket: 'MKWSOCK13', failed: 'MKFAILD14', headerLocation: 'MKHDRLC16', form: 'MKFORM21',
});

/** T44R3 の I-1: 読み込みの後に、form を POST で自動で送るページ（Guard が止める）。 */
const FORM_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>form</title></head>
<body><main><h1>form</h1><p>本文</p><form id="f" method="post" action="/submit?order=${MARKS.form}"><input name="a" value="b"></form></main>
<script>setTimeout(() => document.getElementById('f').submit(), 300);</script></body></html>`;

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>redact</title>
<link rel="icon" href="data:,">
<style>.bg { background-image: url('/bg.png?mk=${MARKS.cssBackground}'); width: 50px; height: 50px; }</style>
<script src="/s.js?mk=${MARKS.script}"></script>
</head><body><h1>redact</h1><main>
<img src="/hero.png?mk=${MARKS.image}" width="900" height="600" alt="hero">
<img src="/r302?mk=${MARKS.redirectFrom}" width="10" height="10" alt="r">
<div class="bg"></div>
<iframe src="/frame?mk=${MARKS.frame}" title="f"></iframe>
<p>text</p><a href="/form">form</a></main>
<script>
fetch('/api/collect?cid=${MARKS.telemetry}').catch(()=>0);
fetch('/api/st?mk=${MARKS.serverTiming}').catch(()=>0);
fetch('/api/data?mk=${MARKS.network}').catch(()=>0);
fetch('/api/trace?mk=${MARKS.trace}', { headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' } }).catch(()=>0);
fetch('http://127.0.0.1:9/fail?mk=${MARKS.failed}').catch(()=>0);
navigator.sendBeacon('/api/b?mk=${MARKS.beacon}', 'x');
try { new WebSocket('ws://' + location.host + '/ws?mk=${MARKS.webSocket}'); } catch (e) {}
</script></body></html>`;

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];

describe.each(LAUNCHERS)('T44R C-1: no recorded request URL value remains in another item of the public audit artifacts with %s', (_label, launch) => {
  let server: LoopbackHttpServer;
  let directory: string;
  const received: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-t44r-c1-'));
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        received.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`);
        if (url.pathname === '/') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
        } else if (url.pathname === '/form') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(FORM_PAGE);
        } else if (url.pathname === '/s.js') {
          response.writeHead(200, { 'content-type': 'text/javascript' })
            .end("console.error('script error'); setTimeout(() => { throw new Error('boom'); }, 0);");
        } else if (url.pathname === '/frame') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>f</title></head><body><p>f</p></body></html>');
        } else if (url.pathname === '/r302') {
          response.writeHead(302, { location: `/img.png?mk=${MARKS.redirectTo}` }).end();
        } else if (url.pathname.endsWith('.png')) {
          response.writeHead(200, { 'content-type': 'image/png', 'timing-allow-origin': '*', 'server-timing': 'db;dur=12' }).end(PNG);
        } else if (url.pathname === '/api/st') {
          response.writeHead(200, { 'content-type': 'application/json', 'server-timing': 'app;dur=3', 'timing-allow-origin': '*' }).end('{}');
        } else if (url.pathname === '/api/data') {
          response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'abc', location: `/x?mk=${MARKS.headerLocation}` }).end('{}');
        } else {
          response.writeHead(200, { 'content-type': 'application/json', 'server-timing': 'x;dur=1' }).end('{}');
        }
      });
    });
  });

  afterAll(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('writes no marker anywhere in the Run directory, while the requests reached the server with the values', async () => {
    const outcome = await runCliInProcess({
      directory,
      name: 't44r-c1',
      config: cliTargetConfig('t44r-c1', server.origin, '/', {
        audit: { screenshots: false, performance: true, accessibility: true, interactions: false },
        crawl: { minNavigationIntervalMs: 0, maxPages: 2 },
      }),
      launchBrowser: () => launch(),
    });
    // 送信と判定は値ごと（サーバには目印つきで届いた）。
    expect(received).toContain(`GET /api/data?mk=${MARKS.network}`);
    expect(received).toContain(`GET /img.png?mk=${MARKS.redirectTo}`);
    // T44R3 の I-1: 2 ページ目を読み、その form の POST は Guard が止めた（サーバに届いていない）。
    expect(received).toContain('GET /form');
    expect(received.filter((line) => line.startsWith('POST /submit'))).toEqual([]);
    const files = await readRunArtifactFiles(outcome.runDirectory);
    expect(files.some(({ path }) => path.endsWith('report.html'))).toBe(true);
    expect(findTextOccurrences(files, Object.values(MARKS))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

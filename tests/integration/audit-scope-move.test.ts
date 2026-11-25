// REV-SD の I-1（設計書 `doc/design/2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 読み込みの後に、ページの script が main frame を点検の範囲の外
// （許可 Origin の外・同じ Origin の危険な語の画面）へ移したら、BeakSight は移った画面で押さず（知らせの枠を閉じる押下・Interaction の押下）、その画面を点検しない
// 記録（`BLOCKED_EXTERNAL_REDIRECT`）にする（本物の Chromium の代表。両方の Chromium）。移る時機は、落ち着きの待ちの間・知らせの枠の前後・収集の間の 3 つ。
// ワーカーの 1 画面の読み込み（操作さがし・READ の確かめ）も、probe の段に入る前に止め、その画面を読めなかった（`FAILED`）とする。
// 仮のサイトは 127.0.0.1 のサーバで、一般の文言だけを使う。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { wait } from '../../src/core/deadline.js';
import { createNavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { visitGuardedPage } from '../../src/worker/worker-run-session.js';
import { BOTH_CHROMIUM_LAUNCHERS, useSharedRunBrowser } from '../helpers/chromium.js';
import { settleLateDeliveries, startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig, runWithCoordinator } from '../helpers/run-harness.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_500;

const html = (body: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>t</title></head><body><main><h1>点検</h1><p>本文です。</p></main>${body}</body></html>`;
/** 移った先: 知らせの枠（閉じる）と、押すと POST を出すボタン。 */
const MOVED_TO = html(`<section id="notice" role="region" aria-label="お知らせ" style="position: fixed; top: 16px; right: 16px; width: 320px; height: 160px; background: #f0f;">
<p>一般の文です。</p><button type="button" id="close">閉じる</button></section>
<button type="button" id="act" aria-expanded="false">詳しく見る</button>
<script>document.getElementById('close').addEventListener('click',function(){fetch('/api/close-pressed',{method:'POST',body:'x'}).catch(function(){});document.getElementById('notice').remove();});
document.getElementById('act').addEventListener('click',function(){this.setAttribute('aria-expanded','true');fetch('/api/act-pressed',{method:'POST',body:'x'}).catch(function(){});});</script>`);
/** 読み込みの後、`delayMs` の後に `to` へ移る画面。 */
const movingPage = (to: string, delayMs: number): string =>
  html(`<p>移ります</p><script>setTimeout(function(){location.href=${JSON.stringify(to)};},${delayMs});</script>`);
/** 移る画面の path と、移るまでの時間（ms）。`/to-scope` は同じ Origin の危険な語の画面へ移る。 */
const MOVES: readonly (readonly [string, number])[] = [['/to-ext-300', 300], ['/to-ext-800', 800], ['/to-ext-1500', 1_500], ['/to-scope', 300]];
/**
 * DEF-304（設計書 `2026-11-20-beaksight-audit-precision-and-scope-design.md` 2.1）: 読み込みの後に `history.replaceState` で URL を書き換える画面（移動はしない）。
 * `/self-query` は query だけを足す（危険な語を含む。点検する）。`/self-path` は path を危険な語の path に変える（範囲の外）。
 */
const REPLACES: readonly (readonly [string, string, string])[] = [
  ['/self-query', '?state_cancelled=1&from=delete', 'OK'],
  ['/self-path', '/x/delete', 'BLOCKED_EXTERNAL_REDIRECT'],
];
const replacingPage = (to: string): string =>
  html(`<p>書き換えます</p><script>setTimeout(function(){history.replaceState(null,'',${JSON.stringify(to)});},300);</script>`);

const own: string[] = [];
const outside: string[] = [];
let site: LoopbackHttpServer;
let outer: LoopbackHttpServer;

beforeAll(async () => {
  outer = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      outside.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(MOVED_TO);
    });
  });
  site = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      own.push(`${request.method ?? ''} ${path}`);
      const move = MOVES.find(([movePath]) => movePath === path);
      const replace = REPLACES.find(([replacePath]) => replacePath === path);
      const page = path === '/start'
        ? html([...MOVES, ...REPLACES].map(([movePath], index) => `<a href="${movePath}">案内 ${index + 1}</a>`).join(''))
        : path === '/account/delete-confirm'
          ? MOVED_TO
          : replace !== undefined
            ? replacingPage(replace[1])
            : move === undefined
              ? undefined
              : movingPage(path === '/to-scope' ? '/account/delete-confirm' : `${outer.origin}/ext`, move[1]);
      if (page === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
    });
  });
});

afterAll(async () => {
  await site?.close();
  await outer?.close();
});

describe.each(BOTH_CHROMIUM_LAUNCHERS)('REV-SD I-1: a page that moves itself out of the audit scope after the load (%s)', (_name, launch) => {
  const sharedBrowser = useSharedRunBrowser(launch);

  it('presses nothing on the moved screen, no press POST arrives, and the moved screen is recorded as not audited', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-scope-move-'));
    try {
      own.length = 0;
      outside.length = 0;
      const config = fastRunConfig(site.origin, '/start', {
        crawl: { maxPages: 10 },
        audit: { performance: false, accessibility: false, interactions: true, sendPolicy: 'PASS_EXCEPT_DELETE' },
        output: { directory: outputDirectory },
      });
      const result = await runWithCoordinator({ config, launchBrowser: sharedBrowser, outputDirectory });
      await settleLateDeliveries(LATE_REQUEST_WAIT_MS, site, outer);

      expect(outside.filter((line) => !line.startsWith('GET ')), 'press POSTs on the outside server').toEqual([]);
      expect(own.filter((line) => line.startsWith('POST ')), 'press POSTs on the own server').toEqual([]);
      const pathOf = (url: string): string => new URL(url).pathname;
      const start = result.pages.find((page) => pathOf(page.pageUrl) === '/start');
      expect(start?.viewports.desktop.navigationOutcome).toBe('OK');
      for (const [path] of MOVES) {
        const page = result.pages.find((candidate) => pathOf(candidate.pageUrl) === path);
        expect([page?.viewports.desktop.navigationOutcome, page?.viewports.mobile.navigationOutcome], path)
          .toEqual(['BLOCKED_EXTERNAL_REDIRECT', 'BLOCKED_EXTERNAL_REDIRECT']);
        expect(page?.evidence.filter((record) => record.type === 'dom' || record.type === 'interaction'), path).toEqual([]);
      }
      for (const [path, , outcome] of REPLACES) {
        const page = result.pages.find((candidate) => pathOf(candidate.pageUrl) === path);
        expect([page?.viewports.desktop.navigationOutcome, page?.viewports.mobile.navigationOutcome], path).toEqual([outcome, outcome]);
      }
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('a one-screen load of the worker stops before the probe once the page has moved out, and the screen is not read', async () => {
    const config = createTestConfig(site.origin, '/start');
    const factory = new BrowserContextFactory(await sharedBrowser(), config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const pacer = createNavigationPacer({ minIntervalMs: 0, now: () => Date.now(), sleep: wait });
    let probed = false;
    const visit = await visitGuardedPage(factory, pacer, `${site.origin}/to-ext-300`, {
      config, allowedQueryParameters: new Set<string>(), pacingWaitBeforeClose: false,
    }, async ({ page, enterSubmissionProbe }) => {
      await page.waitForURL(`${outer.origin}/ext`);
      enterSubmissionProbe(null);
      probed = true;
    });
    expect([visit.kind, probed]).toEqual(['FAILED', false]);
  });
});

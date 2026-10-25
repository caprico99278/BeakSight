// T44R2 の I-1（Task 44 の設計書の履歴の 2026-10-22 の行）: 記録した要求の URL を値で照らす段が、ページの URL を書き換えない（再開が壊れない）。独立レビューの
// 実験（resume.exp.ts）の形を、確かめの形にした。ページ `/news?id=10` が、文書でない要求 `/news?id=1`（ページの URL の前の部分）を出す。1 ページで止めた後に
// 同じ設定で続けると、同じ Run の再開（`RESUME`）になる（前は、保存のページの URL が `id=[REDACTED]0` になり、保存を読めずに `NEW_RUN` になった）。
// T44R3 の M-2: ページ `/news?id=10` は、あとで監査するページ `/news?id=11` の URL も fetch で読む。保存のページを書く時点では、そのページの文書が値の木に
// ないので、巡回が知っている URL（待ち行列と、監査したページの URL）も照らさない値に入れる。保存と、再開して終えた Run のページ A のリンクは伏せない（続けて
// 終えた Run と同じ）。
// 本物の Run Coordinator と、127.0.0.1 の自前のサーバ。Chromium はテストの既定と CLI の起動の設定の両方。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditRun, type AuditRunDependencies } from '../../src/cli/audit-run.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';

const TEST_TIMEOUT_MS = 240_000;
const START_PATH = '/news?id=10';
/** 1 回目の Run を止める、終えたページの数。 */
const STOP_AFTER_PAGES = 1;

const newsPage = (id: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>news ${id}</title></head>
<body><main><h1>news ${id}</h1><p>本文</p><a href="/news?id=10">10</a> <a href="/news?id=11">11</a> <a href="/news?id=12">12</a></main>
<script>fetch('/news?id=1').catch(() => 0); fetch('/news?id=11').catch(() => 0);</script></body></html>`;
/** T44R3 の M-2: ページ A の、あとで監査するページへのリンクの記録（伏せない）。 */
const LATER_PAGE_LINK = '"rawHref":"/news?id=11"';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];

describe.each(LAUNCHERS)('T44R2 I-1: the value matching keeps the page URL, so the stopped Run resumes, with %s', (_label, launch) => {
  let server: LoopbackHttpServer;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-t44r2-resume-'));
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/news') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(newsPage(url.searchParams.get('id') ?? ''));
        } else if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') {
          response.writeHead(404).end();
        } else {
          response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        }
      });
    });
  });

  afterAll(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps the checkpoint page URL and resumes the same Run', async () => {
    const config = fastRunConfig(server.origin, START_PATH, {
      output: { directory },
      crawl: { allowedQueryParameters: ['id'], maxPages: 3, minNavigationIntervalMs: 0 },
    });
    const base: AuditRunDependencies = { launchBrowser: () => launch(), clock: () => new Date(), now: () => Date.now() };
    const controller = new AbortController();
    const first = await executeAuditRun(config, {
      ...base,
      stopSignal: controller.signal,
      createRunCoordinator: (dependencies) => new RunCoordinator({
        ...dependencies,
        onProgress: (report) => {
          dependencies.onProgress?.(report);
          if (report.pagesFinished === STOP_AFTER_PAGES) controller.abort();
        },
      }),
    }, { startNew: false }, {});
    expect(first.kind).toBe('RAN');
    if (first.kind !== 'RAN') return;
    const checkpointText = await readFile(join(first.runDirectory, 'checkpoint', 'pages', 'PAGE-000001.json'), 'utf8');
    const checkpointPage = JSON.parse(checkpointText) as {
      readonly url: string;
      readonly result: { readonly pageUrl: string };
    };
    expect(checkpointPage.url).toBe(`${server.origin}${START_PATH}`);
    expect(checkpointPage.result.pageUrl).toBe(`${server.origin}${START_PATH}`);
    expect(checkpointText).toContain(LATER_PAGE_LINK);

    const second = await executeAuditRun(config, base, { startNew: false }, {});
    expect(second.kind).toBe('RAN');
    if (second.kind !== 'RAN') return;
    expect(second.resumeDecision.kind).toBe('RESUME');
    expect(second.runDirectory).toBe(first.runDirectory);
    const firstPage = await readFile(join(second.runDirectory, 'pages', 'PAGE-000001', 'page.json'), 'utf8');
    expect(firstPage).toContain(LATER_PAGE_LINK);
  }, TEST_TIMEOUT_MS);
});

// T44R4 の I-1: 開始の URL が `/news?id=1.`（文書でない要求 `/news?id=1` に、末尾の `.` が続く形）でも、末尾を外して引く形がページの identity を書き換えない。
// 保存のページの URL と状態の巡回の URL が揃い、2 回目は同じ Run の再開（`RESUME`）になり、監査を終えたページの文書を読み直さない（要求が増えない）。
const DOTTED_START_PATH = '/news?id=1.';
const dottedPage = (id: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>news ${id}</title></head>
<body><main><h1>news ${id}</h1><p>本文</p><a href="/news?id=2">2</a></main>
<script>fetch('/news?id=1').catch(() => 0);</script></body></html>`;

describe.each(LAUNCHERS)('T44R4 I-1: the stripped forms keep the start URL, so the stopped Run resumes, with %s', (_label, launch) => {
  let server: LoopbackHttpServer;
  let directory: string;
  const documents: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-t44r4-resume-'));
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/news') {
          const id = url.searchParams.get('id') ?? '';
          if (request.headers['sec-fetch-dest'] === 'document') {
            documents.push(`${url.pathname}${url.search}`);
          }
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(dottedPage(id));
        } else if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') {
          response.writeHead(404).end();
        } else {
          response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        }
      });
    });
  });

  afterAll(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps the checkpoint page URL, resumes the same Run and does not read the finished page again', async () => {
    const startUrl = `${server.origin}${DOTTED_START_PATH}`;
    const config = fastRunConfig(server.origin, DOTTED_START_PATH, {
      output: { directory },
      crawl: { allowedQueryParameters: ['id'], maxPages: 2, minNavigationIntervalMs: 0 },
    });
    const base: AuditRunDependencies = { launchBrowser: () => launch(), clock: () => new Date(), now: () => Date.now() };
    const controller = new AbortController();
    const first = await executeAuditRun(config, {
      ...base,
      stopSignal: controller.signal,
      createRunCoordinator: (dependencies) => new RunCoordinator({
        ...dependencies,
        onProgress: (report) => {
          dependencies.onProgress?.(report);
          if (report.pagesFinished === STOP_AFTER_PAGES) controller.abort();
        },
      }),
    }, { startNew: false }, {});
    expect(first.kind).toBe('RAN');
    if (first.kind !== 'RAN') return;
    const checkpointPage = JSON.parse(await readFile(join(first.runDirectory, 'checkpoint', 'pages', 'PAGE-000001.json'), 'utf8')) as {
      readonly url: string;
      readonly result: { readonly pageUrl: string };
    };
    expect(checkpointPage.url).toBe(startUrl);
    expect(checkpointPage.result.pageUrl).toBe(startUrl);
    const startDocumentsAfterFirst = documents.filter((path) => path === DOTTED_START_PATH).length;
    expect(startDocumentsAfterFirst).toBeGreaterThan(0);

    const second = await executeAuditRun(config, base, { startNew: false }, {});
    expect(second.kind).toBe('RAN');
    if (second.kind !== 'RAN') return;
    expect(second.resumeDecision.kind).toBe('RESUME');
    expect(second.runDirectory).toBe(first.runDirectory);
    expect(documents.filter((path) => path === DOTTED_START_PATH)).toHaveLength(startDocumentsAfterFirst);
    const run = JSON.parse(await readFile(join(second.runDirectory, 'run.json'), 'utf8')) as { readonly startUrl?: string; readonly config?: unknown };
    expect(JSON.stringify(run)).toContain(JSON.stringify(startUrl));
  }, TEST_TIMEOUT_MS);
});

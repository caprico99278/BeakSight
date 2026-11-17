// OP-I（I2。設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5）: 操作さがしの段では、見つけたリンクのうち登録の画面らしいもの（リンクの
// 文字が「新規登録」など）を先に読む。ページの上限（3）の中で、入口から文書の順で遠い登録の画面を読み、登録の形が見つかる。
// - 読むページの数・間隔・読む範囲は変えない（読んだページは上限の 3 つ。サイトへの要求は GET と HEAD だけ。読まないパスと範囲の外は 0 件）。
// - 読む順の変更なので、テストの既定の Chromium（`tests/helpers/chromium.ts`）だけで確かめる（指示書の I2）。
// サーバは 127.0.0.1 だけで待ち受ける。出力先は一時のフォルダだけ。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 180_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 400;
/** ページの上限（Task 42 の段 C で、登録の画面に届かなかった値）。 */
const MAX_PAGES = 3;

const PATHS = Object.freeze({
  admin: '/admin',
  notices: '/admin/notices',
  list: '/admin/list',
  settings: '/admin/settings',
  help: '/admin/help',
  /** 登録の画面（path に登録の語はない。リンクの文字で見分ける）。 */
  entryForm: '/admin/entries/form',
  logout: '/admin/logout',
  login: '/login',
});

interface SiteRequest {
  readonly method: string;
  readonly path: string;
}

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head><body>${body}</body></html>`;

/** 入口から、文書の順で、登録の画面へのリンクを最後に置く。 */
const BODIES: Readonly<Record<string, string>> = {
  [PATHS.admin]: '<h1>管理</h1><ul>'
    + `<li><a href="${PATHS.notices}">お知らせ</a></li>`
    + `<li><a href="${PATHS.list}">一覧</a></li>`
    + `<li><a href="${PATHS.settings}">設定</a></li>`
    + `<li><a href="${PATHS.help}">ヘルプ</a></li>`
    + `<li><a href="${PATHS.logout}">ログアウト</a></li>`
    + `<li><a href="${PATHS.entryForm}">新規登録</a></li>`
    + '</ul>',
  [PATHS.notices]: `<h1>お知らせ</h1><p><a href="${PATHS.admin}">戻る</a></p>`,
  [PATHS.list]: `<h1>一覧</h1><p><a href="${PATHS.admin}">戻る</a></p>`,
  [PATHS.settings]: `<h1>設定</h1><p><a href="${PATHS.admin}">戻る</a></p>`,
  [PATHS.help]: `<h1>ヘルプ</h1><p><a href="${PATHS.admin}">戻る</a></p>`,
  [PATHS.entryForm]: '<h1>登録</h1>'
    + '<form id="entry" method="post" action="/admin/entries">'
    + '<label>名前 <input type="text" name="name" required></label>'
    + '<button type="submit">登録</button>'
    + '</form>',
};

describe('OP-I (I2): the discovery reads the create page first', () => {
  let server: LoopbackHttpServer | undefined;
  let origin = '';
  let outputDirectory = '';
  const requests: SiteRequest[] = [];

  beforeEach(async () => {
    requests.length = 0;
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-create-order-'));
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      requests.push({ method: request.method ?? '', path });
      const body = READ_METHODS.has(request.method ?? '') ? BODIES[path] : undefined;
      if (body === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page(path, body));
    });
    origin = server.origin;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(outputDirectory, { recursive: true, force: true });
  });

  it('reads the far create page within the page limit of 3, finds the create form, and sends only reads', async () => {
    const config = createTestConfig(origin, PATHS.admin, {
      crawl: { maxPages: MAX_PAGES, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
      audit: { screenshots: false },
      output: { directory: outputDirectory },
    });
    const outcome = await executeDiscoveryRun({
      config,
      jobId: 'job-discovery-create-order',
      authentication: {
        initialState: { cookies: [], origins: [] },
        approvedTestOrigins: [origin],
        auditExclusions: { excludedPathPrefixes: [PATHS.logout], auditPathPrefixes: [PATHS.admin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: PATHS.login,
        filterState: filterAuthenticatedState,
      },
      launchBrowser: () => launchHeadlessChromium(),
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
      navigationPacer: createTestNavigationPacer(config),
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${JSON.stringify(outcome)}`);
    }
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    const readPaths = document.pages.flatMap((entry) => (entry.state === 'READ' ? [new URL(entry.url).pathname] : []));
    // 上限は変わらない（3 ページ）。入口の次に、登録の画面を読む（その後は、見つけた順）。
    expect(document.endReason).toBe('MAX_PAGES_REACHED');
    expect(readPaths).toEqual([PATHS.admin, PATHS.entryForm, PATHS.notices]);
    const classifications = document.pages.flatMap((entry) => (entry.state === 'READ' && new URL(entry.url).pathname === PATHS.entryForm
      ? entry.record.candidates.map((candidate) => candidate.classification)
      : []));
    expect(classifications).toContain('CREATE');
    // サイトへの要求は読み取りだけ。読んだ管理画面の文書は 3 つ。読まないパス（ログアウト）は 0 件。
    expect(requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    expect(requests.filter(({ path }) => Object.hasOwn(BODIES, path)).map(({ path }) => path)).toEqual(readPaths);
    expect(requests.filter(({ path }) => path === PATHS.logout)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

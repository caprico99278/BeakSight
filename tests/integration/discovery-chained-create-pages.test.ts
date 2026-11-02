// OP-J（J1。設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.6。設計者の判断 (b)）: まとめて実行の連鎖の操作さがしの段は、直前の点検の段が
// 見つけたリンクのうち、登録の画面らしいもの（I2 の語の一覧）を最大 `MAX_CHAINED_CREATE_PAGE_READS` ページ先に読み、続けて今どおり入口からページの上限まで読む。
// - 点検の段（本物の Run。ページの上限 3）は、入口から遠い 3 ページ目で登録の画面へのリンクを見つける。操作さがしの段は、その成果物から登録の画面を直接読み、
//   登録の形が見つかる（画面の一覧の行になる候補）。
// - 読んだ数は上限以下で、サイトへの要求は GET と HEAD だけ。読まないパスに当たる登録の画面らしいリンクは読まない。
// - 直前の点検の段の成果物に登録の画面らしいリンクがなければ、今どおり入口から読む。
// - 読む先の変更なので、テストの既定の Chromium（`tests/helpers/chromium.ts`）だけで確かめる（指示書の J1）。
// サーバは 127.0.0.1 だけで待ち受ける。出力先は一時のフォルダだけ。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { MAX_CHAINED_CREATE_PAGE_READS, executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { fastRunConfig } from '../helpers/run-harness.js';

const TEST_TIMEOUT_MS = 240_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
/** 点検の段のページの上限（Task 42 の段 C で、登録の画面に届かなかった値）。 */
const MAX_PAGES = 3;

const PATHS = Object.freeze({
  admin: '/admin',
  notices: '/admin/notices',
  list: '/admin/list',
  settings: '/admin/settings',
  help: '/admin/help',
  /** 登録の画面（path に登録の語はない。リンクの文字で見分ける）。 */
  entryForm: '/admin/entries/form',
  /** 2 つ目の登録の画面（path の語 `new` で見分ける）。 */
  itemNew: '/admin/items/new',
  /** OP-R（R2）: 2 つ目の登録の画面の 1 つ上の一覧の画面（`withListLink` のとき、点検の段のリンクにある）。 */
  items: '/admin/items',
  /** 読まないパスの中の、登録の画面らしいリンク（読まない）。 */
  excludedNew: '/admin/logout/new',
  logout: '/admin/logout',
  login: '/login',
});

interface SiteRequest {
  readonly method: string;
  readonly path: string;
}

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head><body>${body}</body></html>`;

const form = (id: string, action: string): string => `<h1>登録</h1><form id="${id}" method="post" action="${action}">`
  + '<label>名前 <input type="text" name="name" required></label><button type="submit">登録</button></form>';

/** 入口には登録の画面へのリンクがない。点検の段が 3 ページ目に読む一覧の画面に、登録の画面へのリンクがある。 */
const bodiesWith = (withCreateLinks: boolean, withListLink = false): Readonly<Record<string, string>> => ({
  [PATHS.admin]: '<h1>管理</h1><ul>'
    + `<li><a href="${PATHS.notices}">お知らせ</a></li>`
    + `<li><a href="${PATHS.list}">一覧</a></li>`
    + `<li><a href="${PATHS.settings}">設定</a></li>`
    + `<li><a href="${PATHS.help}">ヘルプ</a></li>`
    + `<li><a href="${PATHS.logout}">ログアウト</a></li>`
    + '</ul>',
  [PATHS.notices]: `<h1>お知らせ</h1><p><a href="${PATHS.admin}">戻る</a></p>`,
  [PATHS.list]: `<h1>一覧</h1><p><a href="${PATHS.admin}">戻る</a></p>`
    + (withCreateLinks
      ? `<p><a href="${PATHS.entryForm}">新規登録</a></p><p><a href="${PATHS.itemNew}">品目</a></p><p><a href="${PATHS.excludedNew}">新規</a></p>`
      : '')
    + (withListLink ? `<p><a href="${PATHS.items}">品目の一覧</a></p>` : ''),
  [PATHS.items]: `<h1>品目の一覧</h1><p><a href="${PATHS.itemNew}">品目の登録</a></p>`,
  [PATHS.settings]: `<h1>設定</h1><p><a href="${PATHS.admin}">戻る</a></p>`,
  [PATHS.help]: `<h1>ヘルプ</h1><p><a href="${PATHS.admin}">戻る</a></p>`,
  [PATHS.entryForm]: form('entry', '/admin/entries'),
  [PATHS.itemNew]: form('item', '/admin/items'),
  [PATHS.excludedNew]: form('excluded', '/admin/logout/items'),
});

describe('OP-J (J1): the chained discovery reads the create pages that the audit stage found', () => {
  let server: LoopbackHttpServer | undefined;
  let origin = '';
  let outputDirectory = '';
  let bodies: Readonly<Record<string, string>> = {};
  const requests: SiteRequest[] = [];

  beforeEach(async () => {
    requests.length = 0;
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-chained-create-'));
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      requests.push({ method: request.method ?? '', path });
      const body = READ_METHODS.has(request.method ?? '') ? bodies[path] : undefined;
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

  const authenticationFor = (): RunAuthentication => ({
    initialState: { cookies: [], origins: [] },
    approvedTestOrigins: [origin],
    auditExclusions: { excludedPathPrefixes: [PATHS.logout], auditPathPrefixes: [PATHS.admin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    sessionLostPathPrefix: PATHS.login,
    filterState: filterAuthenticatedState,
  });

  /** 点検の段（本物の Run）と、その成果物を渡した操作さがしの段を、順に 1 組ずつ行う。 */
  const runChain = async (): Promise<{ readonly document: DiscoveryDocument; readonly auditRequests: number }> => {
    const config: AuditConfig = fastRunConfig(origin, PATHS.admin, {
      crawl: { maxPages: MAX_PAGES, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
      output: { directory: outputDirectory },
    });
    const authentication = authenticationFor();
    const audit = await executeAuditRun(config, {
      launchBrowser: () => launchHeadlessChromium(),
      clock: () => new Date(),
      now: () => Date.now(),
      authentication,
    }, { startNew: true });
    if (audit.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${JSON.stringify(audit)}`);
    }
    const auditRequests = requests.length;
    const outcome = await executeDiscoveryRun({
      config,
      jobId: 'job-discovery-chained-create',
      authentication,
      launchBrowser: () => launchHeadlessChromium(),
      clock: () => new Date(),
      now: () => Date.now(),
      stopSignal: new AbortController().signal,
      navigationPacer: createTestNavigationPacer(config),
      chainedAuditRunDirectory: audit.runDirectory,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${JSON.stringify(outcome)}`);
    }
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    return { document, auditRequests };
  };

  const readPathsOf = (document: DiscoveryDocument): readonly string[] =>
    document.pages.flatMap((entry) => (entry.state === 'READ' ? [new URL(entry.url).pathname] : []));

  it('reads the create pages found by the audit stage first, then from the start URL within the page limit (reads only, no re-read), and finds the create forms', async () => {
    bodies = bodiesWith(true);
    const { document, auditRequests } = await runChain();
    // 点検の段は上限の 3 ページ（入口・お知らせ・一覧）だけを読み、登録の画面は読んでいない。
    expect(requests.slice(0, auditRequests).filter(({ path }) => path === PATHS.entryForm || path === PATHS.itemNew)).toEqual([]);
    const readPaths = readPathsOf(document);
    // 操作さがしの段は、点検の段が見つけた登録の画面を先に読み（読まないパスの中の登録の画面らしいリンクは読まない）、続けて今どおり入口からページの上限
    // （3）まで読む。登録の画面の数はページの上限に数えない。すでに読んだ登録の画面は読み直さない。
    expect(readPaths).toEqual([PATHS.entryForm, PATHS.itemNew, PATHS.admin, PATHS.notices, PATHS.list]);
    expect(readPaths.length).toBeLessThanOrEqual(MAX_CHAINED_CREATE_PAGE_READS + MAX_PAGES);
    expect(document.maxPages).toBe(2 + MAX_PAGES);
    expect(document.endReason).toBe('MAX_PAGES_REACHED');
    const createPaths = document.pages.flatMap((entry) => (entry.state === 'READ' && entry.record.candidates.some((candidate) => candidate.classification === 'CREATE')
      ? [new URL(entry.url).pathname]
      : []));
    expect(createPaths).toEqual([PATHS.entryForm, PATHS.itemNew]);
    // 操作さがしの段の、サイトへの要求は読み取りだけ。読んだ文書は読んだ画面と同じ（どれも 1 回だけ）。読まないパスは 0 件。
    const discoveryRequests = requests.slice(auditRequests);
    expect(discoveryRequests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    expect(discoveryRequests.filter(({ path }) => Object.hasOwn(bodies, path)).map(({ path }) => path)).toEqual(readPaths);
    expect(requests.filter(({ path }) => path.startsWith(PATHS.logout))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // OP-R（設計書 4.1.9 の R2）: 登録の画面の 1 つ上の一覧の画面も、点検の段のリンクにあるときだけ、登録の画面の直後に読む（上限 10 の中に数える。ページの上限には
  // 数えない）。点検の段のリンクにない一覧の画面（`/admin/entries`）は読まない。読むのは GET だけ。
  it('reads the list page one above a create page when the audit stage found it, within the same limit (OP-R R2)', async () => {
    bodies = bodiesWith(true, true);
    const { document, auditRequests } = await runChain();
    const readPaths = readPathsOf(document);
    expect(readPaths).toEqual([PATHS.entryForm, PATHS.itemNew, PATHS.items, PATHS.admin, PATHS.notices, PATHS.list]);
    expect(document.maxPages).toBe(3 + MAX_PAGES);
    const discoveryRequests = requests.slice(auditRequests);
    expect(discoveryRequests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    expect(discoveryRequests.filter(({ path }) => path === '/admin/entries')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('reads from the start URL within the page limit as before when the audit stage found no create page', async () => {
    bodies = bodiesWith(false);
    const { document } = await runChain();
    expect(readPathsOf(document)).toEqual([PATHS.admin, PATHS.notices, PATHS.list]);
    expect(document.maxPages).toBe(MAX_PAGES);
    expect(document.endReason).toBe('MAX_PAGES_REACHED');
  }, TEST_TIMEOUT_MS);
});

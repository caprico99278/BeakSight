/**
 * 開発のサーバ（`vite dev apps/local-ui`）の守りを確かめる（Task 23 設計書 4.4、11 章の T23b の発見の行。T23e、T23f）。
 * - T23f: 開発のサーバは、待ち受けを始めたときに管理データを準備するので、一時の root（`createTemporaryUiRoot('source')`）に
 *   ソースを写して起動する（リポジトリの `local-data/` を作らない）。
 * - `/@fs/` の確かめは、一時の root に置いた中身のないファイル（と、起動に要るために写したファイル）の名前と、存在しないファイルの名前を
 *   使う。リポジトリの `local/`、`artifacts/` は、存在しないファイルの名前だけを要求し、応答の状態だけを見る。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_UI_TEXT } from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import {
  REPO_ROOT,
  createTemporaryUiRoot,
  snapshotRepositoryViteCache,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startDevServer,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';

/** websocket の upgrade の要求を送り、応答の状態（101 なら upgrade した）を返す。 */
const upgradeStatus = (port: number, host: string, cookieHeader: string | undefined): Promise<number> =>
  new Promise((resolveStatus, rejectStatus) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: {
        host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-protocol': 'vite-hmr',
        ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
      },
    });
    req.once('upgrade', (res, socket) => {
      socket.destroy();
      resolveStatus(res.statusCode ?? 0);
    });
    req.once('response', (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.once('error', rejectStatus);
    req.end();
  });

/** 存在しないファイルの名前（`/@fs/` の確かめ用）。 */
const MISSING_FILE_NAME = '__t23e_missing_probe__.txt';

/** 一時の root に置く、中身のないファイル（`/@fs/` で配られないことの確かめ用）。 */
const PLACEHOLDER_FILES = Object.freeze(['doc/placeholder.md', '.claude/settings.json', '.superpowers/placeholder.md', '.git/HEAD'] as const);

/** 接続の試みを待つ上限（ミリ秒）。 */
const CONNECT_TIMEOUT_MS = 2_000;

/** 画面の描画と Server Function を待つ上限（ミリ秒）。 */
const PAGE_TIMEOUT_MS = 30_000;

/** HTTP の状態。 */
const STATUS = Object.freeze({ OK: 200, SEE_OTHER: 303, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, MISDIRECTED: 421 });

let root: TemporaryUiRoot | undefined;
/** リポジトリの `node_modules/.vite` の、テストの前の様子（T23h の M4）。 */
let viteCacheBefore = '';
let server: StartedServer | undefined;
let browser: Browser | undefined;
let cookie = '';

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('開発のサーバが起動していない');
  }
  return server;
};

const rootPath = (): string => {
  if (root === undefined) {
    throw new Error('一時の root がない');
  }
  return root.root;
};

beforeAll(async () => {
  viteCacheBefore = snapshotRepositoryViteCache();
  root = createTemporaryUiRoot('source');
  for (const file of PLACEHOLDER_FILES) {
    mkdirSync(`${root.root}/${file.slice(0, file.lastIndexOf('/'))}`, { recursive: true });
    writeFileSync(`${root.root}/${file}`, '');
  }
  server = await startDevServer(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  expect(exchange.status).toBe(STATUS.SEE_OTHER);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  browser = await launchHeadlessChromium();
  // T23h（M4）: Vite の deps の cache は一時の root の中にできるので、毎回空から始まる。最初の画面の読み込みで Vite が依存を見つけて
  // 作り直すと、古い依存の要求に 504（Outdated Optimize Dep）を返して画面を読み込み直す。ブラウザの確かめの前に、画面を一通り開いて
  // cache を温めておく（ここでの console の出力は確かめに数えない。確かめは、下のテストの新しい context で行う）。
  const warmUp = await browser.newContext();
  try {
    const page = await warmUp.newPage();
    await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS });
    for (const path of ['/environment', '/profiles/new', '/']) {
      await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS });
    }
  } finally {
    await warmUp.close();
  }
});

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('dev server: listening and the guard', () => {
  it('listens on 127.0.0.1 only', async () => {
    const { port } = started();
    const result = await new Promise<string>((resolveResult) => {
      const socket = connect({ host: '::1', port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolveResult('TIMEOUT');
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolveResult('CONNECTED');
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolveResult(error.code ?? 'ERROR');
      });
    });
    expect(result).not.toBe('CONNECTED');
  });

  it('prepares the control database under the temporary root before serving (not in the repository)', async () => {
    const { port } = started();
    const page = await rawRequest(port, '/environment', { headers: { cookie, accept: 'text/html' } });
    expect(page.status).toBe(STATUS.OK);
    expect(page.body).toContain('local-data/beaksight-control.sqlite');
  });

  it('applies the same guard: 421 for other hosts, 401 without the cookie, 200 with it, headers on every response', async () => {
    const { port } = started();
    for (const host of [`localhost:${port}`, `attacker.invalid:${port}`]) {
      expect((await rawRequest(port, '/', { host, headers: { cookie } })).status, host).toBe(STATUS.MISDIRECTED);
    }
    for (const path of ['/', '/@vite/client', `/@fs/${rootPath()}/apps/local-ui/src/start.ts`, '/?token=wrong']) {
      const response = await rawRequest(port, path);
      expect(response.status, path).toBe(STATUS.UNAUTHORIZED);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const page = await rawRequest(port, '/', { headers: { cookie, accept: 'text/html' } });
    expect(page.status).toBe(STATUS.OK);
    expect(page.body).toContain(LOCAL_UI_TEXT.pages.profiles);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(String(page.headers['content-security-policy'])).toMatch(/script-src 'self' 'nonce-/u);
    expect(String(page.headers['content-security-policy'])).not.toMatch(/unsafe-/u);
    const client = await rawRequest(port, '/@vite/client', { headers: { cookie } });
    expect(client.status).toBe(STATUS.OK);
    expect(client.headers['cache-control']).toBe('no-store');
  });

  it('guards the HMR websocket upgrade too: 401 without the cookie, 421 for another Host', async () => {
    const { port } = started();
    expect(await upgradeStatus(port, `127.0.0.1:${port}`, undefined)).toBe(STATUS.UNAUTHORIZED);
    expect(await upgradeStatus(port, `127.0.0.1:${port}`, `${cookie.split('=')[0] ?? ''}=wrong`)).toBe(STATUS.UNAUTHORIZED);
    expect(await upgradeStatus(port, `localhost:${port}`, cookie)).toBe(STATUS.MISDIRECTED);
  });

  it('uses the same CSP as production (no websocket relaxation)', async () => {
    const { port } = started();
    const page = await rawRequest(port, '/', { headers: { cookie, accept: 'text/html' } });
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toMatch(/connect-src 'self'; /u);
    expect(csp).not.toMatch(/unsafe-|ws:/u);
  });

  it('does not serve files outside fs.allow through /@fs/ (existing files in the root, including the control database)', async () => {
    const { port } = started();
    const targets = [
      'package.json',
      'config/targets/example.json',
      ...PLACEHOLDER_FILES,
      'local-data/beaksight-control.sqlite',
      'src/safety/passive-request-guard.ts',
      // 画面が読み込まない src/ のファイル（src/config/ の部品はサーバの側で読み込まれ、Vite はそれを配ってよいものとして扱うので、ここに入れない）。
      'src/cli/main.ts',
      'schemas/control/profile.schema.json',
    ];
    for (const path of targets) {
      const response = await rawRequest(port, `/@fs/${rootPath()}/${path}`, { headers: { cookie } });
      expect(response.status, path).toBe(STATUS.FORBIDDEN);
    }
    // リポジトリの本体のファイルも配らない（一時の root の外）。
    expect((await rawRequest(port, `/@fs/${REPO_ROOT}/package.json`, { headers: { cookie } })).status).toBe(STATUS.FORBIDDEN);
  });

  it('does not serve local/, artifacts/ or local-data/ (missing file names only)', async () => {
    const { port } = started();
    for (const base of [rootPath(), REPO_ROOT]) {
      for (const directory of ['local', 'artifacts', 'local-data']) {
        const response = await rawRequest(port, `/@fs/${base}/${directory}/${MISSING_FILE_NAME}`, { headers: { cookie, accept: 'text/html' } });
        expect([STATUS.FORBIDDEN, STATUS.NOT_FOUND], `${base === REPO_ROOT ? 'repository' : 'root'} ${directory}`).toContain(response.status);
      }
    }
  });

  it('still serves what the page imports from src/ (src/presentation, src/core, src/control)', async () => {
    const { port } = started();
    for (const path of ['src/presentation/format.ts', 'src/core/immutable.ts', 'src/control/contracts.ts']) {
      const response = await rawRequest(port, `/@fs/${rootPath()}/${path}`, { headers: { cookie } });
      expect(response.status, path).toBe(STATUS.OK);
    }
  });

  it('opens in headless Chromium from the token URL: renders the empty list, hydrates, no CSP violation', async () => {
    const { origin, tokenUrl } = started();
    if (browser === undefined) {
      throw new Error('Chromium が起動していない');
    }
    const context = await browser.newContext();
    try {
      const requests: string[] = [];
      context.on('request', (request) => requests.push(request.url()));
      const page = await context.newPage();
      let hmrFrames = 0;
      page.on('websocket', (socket) => socket.on('framereceived', () => {
        hmrFrames += 1;
      }));
      await page.addInitScript(() => {
        const violations: string[] = [];
        Object.defineProperty(window, '__cspViolations', { value: violations });
        document.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));
      });
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });
      await page.goto(tokenUrl.href, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS });
      expect(page.url()).toBe(`${origin}/`);
      await page.getByTestId('profile-list-empty').waitFor({ timeout: PAGE_TIMEOUT_MS });
      // hydrate した後の画面の移動（loader の Server Function の GET を通る）。
      await page.getByRole('link', { name: LOCAL_UI_TEXT.pages.environment }).click();
      await page.getByTestId('environment-status').waitFor({ timeout: PAGE_TIMEOUT_MS });
      const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
      expect(violations).toEqual([]);
      expect(consoleErrors).toEqual([]);
      // HMR の websocket が、cookie つきで繋がった（Vite から 'connected' などの frame を受けた）。
      expect(hmrFrames).toBeGreaterThan(0);
      expect(requests.filter((url) => !url.startsWith(`${origin}/`) && !url.startsWith(`ws://127.0.0.1:${started().port}/`))).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('dev server: the test does not write into the repository (T23h, M4)', () => {
  it('keeps the Vite cache in the temporary root, and leaves node_modules/.vite of the repository unchanged', () => {
    expect(snapshotRepositoryViteCache()).toBe(viteCacheBefore);
  });
});

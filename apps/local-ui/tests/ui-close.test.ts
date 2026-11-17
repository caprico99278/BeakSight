/**
 * UI-close（設計書 `doc/design/2026-10-19-beaksight-ui-close-stops-server-design.md` の 4 章の受け入れ条件 1〜5）: 管理画面のブラウザを閉じたら、
 * 画面のサーバ（ビルドした画面を、一時の root の起動の部品 `launcher/serve.ts` で起動する）も止まることを、headless の Chromium で確かめる。
 * 猶予と途絶えの上限と、確かめの間隔は、起動の引数で注入して短くする（ページの知らせの間隔は製品のまま）。
 * SLIM-GROUP UI-7: 受け入れ条件 1・2・5 を本物のサーバで確かめる。3（開かなければ止めない）・4（ジョブの間は止めない）・途絶え（OP-P）は、止める判定の
 * 1 か所（`launcher/presence.ts` の `createPresenceMonitor`）を偽の時計で確かめる `ui-presence-monitor.test.ts` と、終わりの記録の形の
 * `tests/unit/ui-server-log.test.ts`（速い組）で確かめる。
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait as sleep } from '../../../src/core/deadline.js';
import { resolveUiServerLogPath } from '../../../src/control/store/database-path.js';
import { LOCAL_UI_CONSOLE_TEXT } from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { UI_PRESENCE_ALIVE_PATH, UI_PRESENCE_CLOSED_PATH, UI_PRESENCE_INTERVAL_MS } from '../src/security/ui-presence.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncherWithArguments,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';

/** 注入する猶予（閉じた知らせの後）。読み込み直しが戻るのに足りる長さ。 */
const CLOSED_GRACE_MS = 3_000;
/** 注入する途絶えの上限（ページの知らせの間隔より長くする。ページが開いている間に途絶えたと見なさない）。 */
const SILENCE_LIMIT_MS = UI_PRESENCE_INTERVAL_MS * 2;
/** 注入する確かめの間隔。 */
const CHECK_INTERVAL_MS = 100;
/** 止まったと見なすまでの上限（猶予より長く、途絶えの上限より短い。閉じた知らせで止まったことを見分ける）。 */
const STOP_LIMIT_MS = CLOSED_GRACE_MS + 4_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const WAIT_STEP_MS = 100;
const STATUS = Object.freeze({ UNAUTHORIZED: 401, FORBIDDEN: 403 });

let root: TemporaryUiRoot | undefined;
let browser: Browser | undefined;
const servers: StartedServer[] = [];
const contexts: BrowserContext[] = [];

const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) throw new Error('一時の root がない');
  return root;
};
const browserOf = (): Browser => {
  if (browser === undefined) throw new Error('ブラウザがない');
  return browser;
};

/** 猶予と途絶えの上限を注入して、画面のサーバを起動する。 */
const startServer = async (): Promise<StartedServer> => {
  const server = await startLauncherWithArguments(rootOf(), await findFreePort(), [
    '--ui-close-grace-ms', String(CLOSED_GRACE_MS),
    '--ui-silence-limit-ms', String(SILENCE_LIMIT_MS),
    '--ui-presence-check-ms', String(CHECK_INTERVAL_MS),
  ]);
  servers.push(server);
  return server;
};

const isRunning = (server: StartedServer): boolean => server.child.exitCode === null && server.child.signalCode === null;

/** 画面のサーバが自分で止まるまで待つ（上限を超えたら誤り）。止まるまでの時間（ms）を返す。 */
const waitForExit = async (server: StartedServer, limitMs: number): Promise<number> => {
  const started = Date.now();
  while (isRunning(server)) {
    if (Date.now() - started > limitMs) {
      throw new Error(`画面のサーバが止まらなかった: ${server.output()}`);
    }
    await sleep(WAIT_STEP_MS);
  }
  return Date.now() - started;
};

/** port が空いたか（同じ port で待ち受けられる）。 */
const isPortFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve(true)));
  });

/** token の URL で管理画面を開く（cookie を受けてから、画面を描く）。 */
const openUi = async (context: BrowserContext, server: StartedServer): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  return page;
};

const newContext = async (): Promise<BrowserContext> => {
  const context = await browserOf().newContext();
  contexts.push(context);
  return context;
};

const cookieOf = async (server: StartedServer): Promise<string> => {
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  return parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  browser = await launchHeadlessChromium();
}, SCENARIO_TIMEOUT_MS);

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.close();
  }
  for (const server of servers.splice(0)) {
    await stopServer(server);
  }
});

afterAll(async () => {
  await browser?.close();
  rootOf().remove();
});

describe('UI-close: closing the local UI stops the server', () => {
  it('keeps running on a reload and while another tab is open, and stops after the grace when the last page is closed (1, 2, 5)', async () => {
    const server = await startServer();
    // DEF-146: cookie の値（終わりの記録のファイルに書かない値）。
    const cookie = await cookieOf(server);
    const cookieValue = cookie.split('=').slice(1).join('=');
    // 5: token のない知らせ、別の Origin・cross-site の知らせ、GET の知らせは受けない。
    for (const path of [UI_PRESENCE_ALIVE_PATH, UI_PRESENCE_CLOSED_PATH]) {
      const target = `${path}?page=probe`;
      expect((await rawRequest(server.port, target, { method: 'POST' })).status, path).toBe(STATUS.UNAUTHORIZED);
      expect((await rawRequest(server.port, target, { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:1' } })).status, path)
        .toBe(STATUS.FORBIDDEN);
      expect((await rawRequest(server.port, target, { method: 'POST', headers: { cookie, origin: server.origin, 'sec-fetch-site': 'cross-site' } })).status, path)
        .toBe(STATUS.FORBIDDEN);
      expect((await rawRequest(server.port, target, { method: 'GET', headers: { cookie, origin: server.origin } })).status, path).toBe(STATUS.FORBIDDEN);
    }
    const context = await newContext();
    const first = await openUi(context, server);
    // 読み込み直し: 閉じた知らせの後、猶予の中に新しいページの知らせが来るので、止まらない。
    await first.reload({ waitUntil: 'networkidle' });
    await sleep(CLOSED_GRACE_MS * 2);
    expect(isRunning(server)).toBe(true);
    // 2 つ目のタブが開いている間は、1 つ目を閉じても止まらない。
    const second = await openUi(context, server);
    await first.close({ runBeforeUnload: true });
    await sleep(CLOSED_GRACE_MS * 2);
    expect(isRunning(server)).toBe(true);
    // 最後のページを閉じると、猶予の後に止まり、port が空く。止めたことをターミナルに出す。
    await second.close({ runBeforeUnload: true });
    expect(await waitForExit(server, STOP_LIMIT_MS)).toBeLessThan(STOP_LIMIT_MS);
    expect(await isPortFree(server.port)).toBe(true);
    expect(server.output()).toContain(LOCAL_UI_CONSOLE_TEXT.closedByUi);
    // DEF-146: 終わりの記録のファイル（一時の root の `local-data/logs/ui-server.log`）に、画面を閉じた終わりを 1 行書く。token と cookie の値は書かない。
    const logText = readFileSync(resolveUiServerLogPath(rootOf().root), 'utf8');
    const lines = logText.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({ kind: 'SHUTDOWN', reason: 'UI_CLOSED', immediate: false, runningJobs: 0 });
    // OP-P（P3）: 起動の行と、止める決まりを受けた行（終わりの処理の前）も書く。
    expect(lines.map((line) => line['kind'])).toEqual(['START', 'STOP_REQUESTED', 'SHUTDOWN']);
    expect(lines.at(-2)).toMatchObject({ kind: 'STOP_REQUESTED', reason: 'UI_CLOSED', runningJobs: 0 });
    expect(typeof lines.at(-1)?.['at']).toBe('string');
    expect(lines.filter((line) => line['kind'] === 'EXIT')).toEqual([]);
    const token = server.tokenUrl.searchParams.get('token') ?? '';
    expect(token.length).toBeGreaterThan(0);
    expect(logText).not.toContain(token);
    expect(cookieValue.length).toBeGreaterThan(0);
    expect(logText).not.toContain(cookieValue);
  }, SCENARIO_TIMEOUT_MS);

});

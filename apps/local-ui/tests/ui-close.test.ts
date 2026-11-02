/**
 * UI-close（設計書 `doc/design/2026-10-19-beaksight-ui-close-stops-server-design.md` の 4 章の受け入れ条件 1〜5）: 管理画面のブラウザを閉じたら、
 * 画面のサーバ（ビルドした画面を、一時の root の起動の部品 `launcher/serve.ts` で起動する）も止まることを、headless の Chromium で確かめる。
 * 猶予と途絶えの上限と、確かめの間隔は、起動の引数で注入して短くする（ページの知らせの間隔は製品のまま）。
 * 監査のジョブは、一時の root の入口を偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `hold`。サイトに接続しない）に替えて動かす。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait as sleep } from '../../../src/core/deadline.js';
import { resolveUiServerLogPath } from '../../../src/control/store/database-path.js';
import { LOCAL_UI_CONSOLE_TEXT } from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { writeFakeWorker } from '../../../tests/helpers/fake-audit-worker.js';
import { fakeWorkerValuesOf } from '../../../tests/helpers/job-test-support.js';
import { UI_PRESENCE_ALIVE_PATH, UI_PRESENCE_CLOSED_PATH, UI_PRESENCE_INTERVAL_MS } from '../src/security/ui-presence.ts';
import { publicProfileDocument, writeAuditTargetConfig } from './helpers/audit-site.ts';
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
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';
import { waitForJobViaServerFunctions } from './helpers/server-function-job-wait.ts';

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
const JOB_WAIT_LIMIT_MS = 30_000;
const STATUS = Object.freeze({ OK: 200, NO_CONTENT: 204, UNAUTHORIZED: 401, FORBIDDEN: 403 });
const PROFILE_ID = 'ui-close-public';
const WORKER_ENTRY = 'dist/worker/audit-worker.js';
const FAKE_HEARTBEAT_INTERVAL_MS = 200;

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

/** OP-P: 終わりの記録のファイルの行（一時の root。記録は、同じ root の画面のサーバが足していく）。 */
const logLines = (): readonly Record<string, unknown>[] => {
  let text = '';
  try {
    text = readFileSync(resolveUiServerLogPath(rootOf().root), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
};

/** OP-P: 偽のワーカー（`hold`。止める要求まで動く）で、プロファイルを作ってジョブを始める。 */
const startHeldJob = async (server: StartedServer, profileId: string) => {
  const directory = `${rootOf().root}/fake-workers/${profileId}`;
  mkdirSync(directory, { recursive: true });
  const worker = writeFakeWorker(directory, 'hold', fakeWorkerValuesOf({ runId: 'RUN-20261102000000', otherRunId: 'RUN-20261102000999' }, {
    heartbeatIntervalMs: FAKE_HEARTBEAT_INTERVAL_MS,
  }));
  writeFileSync(`${rootOf().root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
  const targetConfigPath = writeAuditTargetConfig(rootOf().root, profileId, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false });
  const cookie = await cookieOf(server);
  const ids = readServerFunctionIds(`${rootOf().root}/apps/local-ui/dist/server/server.js`);
  const call = async <T>(name: string, method: 'GET' | 'POST', data: unknown): Promise<T> => {
    const result = await callServerFunction({ port: server.port, origin: server.origin, cookie, ids }, name, method, data);
    expect(result.response.status, name).toBe(STATUS.OK);
    return result.value as T;
  };
  expect(await call('createProfileFn', 'POST', { profile: publicProfileDocument(profileId, targetConfigPath) })).toMatchObject({ ok: true });
  const start = await call<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId, expectedRevision: 1, startNew: true });
  expect(start.ok, JSON.stringify(start)).toBe(true);
  return {
    /** ジョブを終える（止める要求。偽のワーカーは結果を返して終わる）。 */
    end: async (): Promise<void> => {
      expect(await call('stopAuditJobFn', 'POST', { jobId: start.jobId, force: false })).toMatchObject({ ok: true });
    },
    /** ジョブが終わるのを待つ。 */
    waitEnded: async (): Promise<void> => {
      await waitForJobViaServerFunctions((jobId) => call<{ active: boolean }>('getAuditJobFn', 'GET', { jobId }), start.jobId, (job) => !job.active, {
        limitMs: JOB_WAIT_LIMIT_MS,
        stepMs: WAIT_STEP_MS,
      });
    },
  };
};

describe('UI-close: closing the local UI stops the server', () => {
  it('keeps running on a reload and while another tab is open, and stops after the grace when the last page is closed (1, 2)', async () => {
    const server = await startServer();
    // DEF-146: cookie の値（終わりの記録のファイルに書かない値）。
    const cookieValue = (await cookieOf(server)).split('=').slice(1).join('=');
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

  it('keeps running when the UI was never opened, and does not take notices without the token or from another origin (3, 5)', async () => {
    const server = await startServer();
    const cookie = await cookieOf(server);
    for (const path of [UI_PRESENCE_ALIVE_PATH, UI_PRESENCE_CLOSED_PATH]) {
      const target = `${path}?page=probe`;
      expect((await rawRequest(server.port, target, { method: 'POST' })).status, path).toBe(STATUS.UNAUTHORIZED);
      expect((await rawRequest(server.port, target, { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:1' } })).status, path)
        .toBe(STATUS.FORBIDDEN);
      expect((await rawRequest(server.port, target, { method: 'POST', headers: { cookie, origin: server.origin, 'sec-fetch-site': 'cross-site' } })).status, path)
        .toBe(STATUS.FORBIDDEN);
      expect((await rawRequest(server.port, target, { method: 'GET', headers: { cookie, origin: server.origin } })).status, path).toBe(STATUS.FORBIDDEN);
    }
    // 受けなかった知らせは数えない（受けていれば、途絶えの上限の後に止まる）。画面を開いていないので、止まらない。
    await sleep(SILENCE_LIMIT_MS + CLOSED_GRACE_MS);
    expect(isRunning(server)).toBe(true);
    expect((await rawRequest(server.port, '/', { headers: { cookie } })).status).toBe(STATUS.OK);
  }, SCENARIO_TIMEOUT_MS);

  // OP-P（P3。本物のテスト環境の事実の再現）: ジョブが終わったときに、開いている管理画面のページがあれば、画面のサーバは止まらない。
  it('keeps running when a job ends while the page stays open (OP-P)', async () => {
    const before = logLines().length;
    const server = await startServer();
    const context = await newContext();
    await openUi(context, server);
    const job = await startHeldJob(server, 'op-p-open-page');
    await job.end();
    await job.waitEnded();
    await sleep(CLOSED_GRACE_MS * 2);
    expect(isRunning(server), server.output()).toBe(true);
    expect(logLines().slice(before).filter((line) => line['kind'] === 'STOP_REQUESTED' || line['kind'] === 'SHUTDOWN')).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  // OP-P（P3）: ジョブの間にページの知らせが途絶えた（隠れたタブの凍結など。知らせの要求を止めて作る）ときは、ジョブが終わったときに止まり、終わり方は途絶え
  // （`UI_SILENT`）として、止める決まりを受けた行と終わりの行に残る。前の起動の終わりの記録がないこと（テストの強制の終わり）も、起動のときに残る。
  it('stops at the end of a job with the silence reason when the page went silent during the job, and records the unrecorded previous end (OP-P)', async () => {
    // 前の起動を、終わりの記録のないまま強制で終わらせる（テストの片付けと同じ終わらせ方）。
    const previous = await startServer();
    await stopServer(previous);
    const before = logLines().length;
    const server = await startServer();
    const context = await newContext();
    const page = await openUi(context, server);
    const job = await startHeldJob(server, 'op-p-frozen-page');
    // ページの知らせを、画面のサーバに届かないようにする（隠れたタブの凍結などで、知らせが途絶えた形）。ページは開いたまま。
    await page.route(`**${UI_PRESENCE_ALIVE_PATH}*`, (route) => route.abort());
    // 途絶えの上限を過ぎても、ジョブが動いている間は止まらない。
    await sleep(SILENCE_LIMIT_MS + CLOSED_GRACE_MS);
    expect(isRunning(server)).toBe(true);
    await job.end();
    await waitForExit(server, JOB_WAIT_LIMIT_MS);
    const lines = logLines().slice(before);
    expect(lines[0]).toMatchObject({ kind: 'PREVIOUS_END_UNRECORDED' });
    expect(typeof lines[0]?.['previousStartedAt']).toBe('string');
    expect(lines.map((line) => line['kind'])).toEqual(['PREVIOUS_END_UNRECORDED', 'START', 'STOP_REQUESTED', 'SHUTDOWN']);
    expect(lines.at(-2)).toMatchObject({ reason: 'UI_SILENT', runningJobs: 0 });
    expect(lines.at(-1)).toMatchObject({ reason: 'UI_SILENT', immediate: false, runningJobs: 0 });
  }, SCENARIO_TIMEOUT_MS);

  it('does not stop while a job runs, and stops after the job ends (4)', async () => {
    const directory = `${rootOf().root}/fake-workers/ui-close`;
    mkdirSync(directory, { recursive: true });
    const worker = writeFakeWorker(directory, 'hold', fakeWorkerValuesOf({ runId: 'RUN-20261019000000', otherRunId: 'RUN-20261019000999' }, {
      heartbeatIntervalMs: FAKE_HEARTBEAT_INTERVAL_MS,
    }));
    writeFileSync(`${rootOf().root}/${WORKER_ENTRY}`, readFileSync(worker.path, 'utf8'), 'utf8');
    const targetConfigPath = writeAuditTargetConfig(rootOf().root, PROFILE_ID, 'http://127.0.0.1:9', { minNavigationIntervalMs: 0, screenshots: false });
    const server = await startServer();
    const cookie = await cookieOf(server);
    const ids = readServerFunctionIds(`${rootOf().root}/apps/local-ui/dist/server/server.js`);
    const call = async <T>(name: string, method: 'GET' | 'POST', data: unknown): Promise<T> => {
      const result = await callServerFunction({ port: server.port, origin: server.origin, cookie, ids }, name, method, data);
      expect(result.response.status, name).toBe(STATUS.OK);
      return result.value as T;
    };
    expect(await call('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, targetConfigPath) })).toMatchObject({ ok: true });
    const start = await call<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 1, startNew: true });
    expect(start.ok, JSON.stringify(start)).toBe(true);
    const context = await newContext();
    const page = await openUi(context, server);
    await page.close({ runBeforeUnload: true });
    // ジョブが動いている間は、猶予の後も止まらない。
    await sleep(CLOSED_GRACE_MS * 2);
    expect(isRunning(server)).toBe(true);
    expect(await call<{ active: boolean }>('getAuditJobFn', 'GET', { jobId: start.jobId })).toMatchObject({ active: true });
    // ジョブが終わったら、確かめ直して止まる。
    expect(await call('stopAuditJobFn', 'POST', { jobId: start.jobId, force: false })).toMatchObject({ ok: true });
    await waitForExit(server, JOB_WAIT_LIMIT_MS);
    expect(await isPortFree(server.port)).toBe(true);
    expect(server.output()).toContain(LOCAL_UI_CONSOLE_TEXT.closedByUi);
  }, SCENARIO_TIMEOUT_MS);
});

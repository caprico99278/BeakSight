/**
 * 監査のジョブの成果物の Server Routes（GET）を確かめる（Task 24 の設計書 4.5、7 章「成果物」。T24f）。
 * - 画面から（Server Function で）監査を 1 回動かし（スクリーンショットあり。127.0.0.1 の fixture のサイト）、その Run のディレクトリの成果物を、
 *   ビルドした画面のサーバ（一時の root）から取り出す。
 * - 許可の一覧のファイル（`run.json`、`audit.json`、`report.html`、バンドルの ZIP、`audit.json` が参照する `page.json` とスクリーンショット）は
 *   配られ、JSON と ZIP は `Content-Disposition: attachment`（ASCII の決まった名前）、`report.html` は script を動かさない CSP。
 * - 一覧の外（`checkpoint/` の中、参照されていないファイル、`..`、符号化、Windows の別名とデバイス名、junction）は 404。cookie なしは 401。
 * - Chromium（headless）で `report.html` を開くと、書き足した script も事象の属性も動かず、style は動き、レポートの中の相対のリンク
 *   （スクリーンショット）は同じ Server Routes で開ける。外部への要求は 0。
 * 管理データ、ターゲット設定、出力先は、一時の root の中だけ。junction は、消す前に外す。
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES } from '../../../src/core/artifact-layout.js';
import { LOCAL_UI_AUDIT_TEXT } from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import { buildArtifactContentSecurityPolicy } from '../launcher/request-guard.ts';
import { outputDirectoryOf, publicProfileDocument, startTimedSite, writeAuditTargetConfig, type TimedSite } from './helpers/audit-site.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type RawResponse,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';

/** HTTP の状態。 */
const STATUS = Object.freeze({ OK: 200, UNAUTHORIZED: 401, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405 });
/** 状態が変わるのを待つ上限と、読み直す間隔（ms）。 */
const WAIT_LIMIT_MS = 120_000;
const WAIT_POLL_MS = 250;
/** process が消えるのを待つ上限（ms）。 */
const PROCESS_EXIT_LIMIT_MS = 20_000;
/** テストの値（匿名）。 */
const PROFILE_ID = 't24f-artifacts';
/** ページの読み込みの最小の間隔（ms。ループバックの fixture なので 0）。 */
const NO_INTERVAL_MS = 0;
/** ダウンロードのファイル名の形（ASCII の英数字、`.`、`_`、`-` だけ）。 */
const ASCII_ATTACHMENT = /^attachment; filename="[A-Za-z0-9._-]+"$/u;
/** レポートに書き足す、動いてはいけない script（title と window の印を変える）と、事象の属性。 */
const INJECTED_SCRIPT_MARK = 't24f-script-ran';
const INJECTED_HTML = `<script>document.title='${INJECTED_SCRIPT_MARK}';window.t24fRan=true;</script>`
  + `<img src="data:," onerror="document.title='${INJECTED_SCRIPT_MARK}'">`;

let root: TemporaryUiRoot | undefined;
let site: TimedSite | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let cookie = '';
let jobId = '';
let runDirectory = '';
let screenshotPath = '';
let pageJsonPath = '';
const descendants: ProcessIdentity[] = [];
const junctions: string[] = [];

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};

const artifactUrlPath = (path: string): string => `/artifacts/${jobId}/${path}`;
const getArtifact = (path: string, withCookie = true): Promise<RawResponse> =>
  rawRequest(started().port, artifactUrlPath(path), withCookie ? { headers: { cookie } } : {});

interface JobDetail {
  readonly state: string;
  readonly active: boolean;
  readonly runId: string | null;
  readonly artifacts: readonly { readonly kind: string; readonly relativePath: string }[];
}

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startTimedSite();
  const targetConfigPath = writeAuditTargetConfig(root.root, PROFILE_ID, site.origin, { minNavigationIntervalMs: NO_INTERVAL_MS, screenshots: true });
  const ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  const call = (name: string, method: 'GET' | 'POST', data: unknown) =>
    callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect((await call('createProfileFn', 'POST', { profile: publicProfileDocument(PROFILE_ID, targetConfigPath) })).value).toMatchObject({ ok: true });
  const start = (await call('startAuditJobFn', 'POST', { profileId: PROFILE_ID, expectedRevision: 1, startNew: true })).value as { jobId: string };
  jobId = start.jobId;
  const deadline = Date.now() + WAIT_LIMIT_MS;
  let job: JobDetail | null = null;
  for (;;) {
    job = (await call('getAuditJobFn', 'GET', { jobId })).value as JobDetail | null;
    if (job?.active === true) {
      descendants.push(...descendantsOf(started().child.pid ?? 0, await listProcesses()));
    }
    if (job !== null && !job.active) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`監査が終わらなかった: ${JSON.stringify(job)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, WAIT_POLL_MS));
  }
  expect(job.state).toBe('FINISHED');
  runDirectory = `${root.root}/${outputDirectoryOf(PROFILE_ID)}/${job.runId ?? ''}`;
  // audit.json が参照するスクリーンショットと page.json を 1 つずつ選ぶ。
  const audit = JSON.parse(readFileSync(`${runDirectory}/${RUN_ARTIFACT_FILE_NAMES.audit}`, 'utf8')) as {
    pages: { pageId: string; evidence: { type: string; payload: { relativePath?: string } }[] }[];
  };
  const page = audit.pages.find((candidate) => candidate.evidence.some((record) => record.type === 'screenshot'));
  screenshotPath = page?.evidence.find((record) => record.type === 'screenshot')?.payload.relativePath ?? '';
  pageJsonPath = `pages/${page?.pageId ?? ''}/page.json`;
  expect(screenshotPath).toMatch(/^pages\/PAGE-\d+\/(?:desktop|mobile)\/(?:viewport|full-page)\.png$/u);
  browser = await launchHeadlessChromium();
});

afterAll(async () => {
  for (const junction of junctions) {
    if (existsSync(junction) && lstatSync(junction).isSymbolicLink()) {
      unlinkSync(junction);
    }
  }
  await browser?.close();
  await stopServer(server);
  expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
  await site?.close();
  root?.remove();
});

describe('artifact routes: the allowed files', () => {
  it('lists the artifacts of the finished job in its detail', async () => {
    const ids = readServerFunctionIds(`${root?.root ?? ''}/apps/local-ui/dist/server/server.js`);
    const detail = (await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, 'getAuditJobFn', 'GET', { jobId }))
      .value as JobDetail;
    expect(detail.artifacts.map((artifact) => artifact.kind)).toEqual(['REPORT', 'RUN_JSON', 'AUDIT_JSON', 'BUNDLE']);
  });

  it('serves run.json and audit.json as ASCII-named attachments, byte for byte', async () => {
    for (const name of [RUN_ARTIFACT_FILE_NAMES.run, RUN_ARTIFACT_FILE_NAMES.audit]) {
      const response = await getArtifact(name);
      expect(response.status, name).toBe(STATUS.OK);
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(response.headers['content-disposition']).toMatch(ASCII_ATTACHMENT);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toBe(readFileSync(`${runDirectory}/${name}`, 'utf8'));
    }
  });

  it('serves report.html inline with the CSP that runs no script and allows only its own style by hash', async () => {
    const response = await getArtifact(RUN_ARTIFACT_FILE_NAMES.report);
    expect(response.status).toBe(STATUS.OK);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['content-disposition']).toBeUndefined();
    const html = readFileSync(`${runDirectory}/${RUN_ARTIFACT_FILE_NAMES.report}`, 'utf8');
    const style = /<style>([\s\S]*?)<\/style>/u.exec(html.slice(0, html.indexOf('</head>')))?.[1] ?? '';
    const hash = createHash('sha256').update(style, 'utf8').digest('base64');
    expect(response.headers['content-security-policy']).toBe(buildArtifactContentSecurityPolicy([hash]));
    expect(String(response.headers['content-security-policy'])).not.toMatch(/unsafe-|allow-scripts|script-src/u);
    expect(response.headers['x-beaksight-artifact-style-sha256']).toBeUndefined();
  });

  it('serves the bundle ZIP as an attachment under its own ASCII name', async () => {
    const bundle = readdirSync(runDirectory).find((name) => name.endsWith('.zip')) ?? '';
    expect(bundle).toMatch(/^beaksight-audit-bundle_\d{14}\.zip$/u);
    const response = await getArtifact(bundle);
    expect(response.status).toBe(STATUS.OK);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${bundle}"`);
  });

  it('serves a screenshot and a page.json that audit.json refers to', async () => {
    const screenshot = await getArtifact(screenshotPath);
    expect(screenshot.status).toBe(STATUS.OK);
    expect(screenshot.headers['content-type']).toBe('image/png');
    const pageJson = await getArtifact(pageJsonPath);
    expect(pageJson.status).toBe(STATUS.OK);
    expect(pageJson.headers['content-disposition']).toMatch(ASCII_ATTACHMENT);
  });
});

describe('artifact routes: everything outside the allowed list is 404', () => {
  const expectNotFound = async (path: string): Promise<void> => {
    const response = await rawRequest(started().port, path, { headers: { cookie } });
    expect(response.status, path).toBe(STATUS.NOT_FOUND);
    expect(response.body, path).not.toContain('"schemaVersion"');
  };

  it('does not serve files in checkpoint/, files that are not referred to, or unknown jobs', async () => {
    mkdirSync(`${runDirectory}/checkpoint/pages`, { recursive: true });
    writeFileSync(`${runDirectory}/checkpoint/state.json`, '{"schemaVersion":"t24f"}\n');
    writeFileSync(`${runDirectory}/checkpoint/pages/PAGE-000001.json`, '{"schemaVersion":"t24f"}\n');
    writeFileSync(`${runDirectory}/notes.json`, '{"schemaVersion":"t24f"}\n');
    mkdirSync(`${runDirectory}/pages/PAGE-999999`, { recursive: true });
    writeFileSync(`${runDirectory}/pages/PAGE-999999/page.json`, '{"schemaVersion":"t24f"}\n');
    for (const path of ['checkpoint/state.json', 'checkpoint/pages/PAGE-000001.json', 'notes.json', 'pages/PAGE-999999/page.json',
      'pages', 'checkpoint']) {
      await expectNotFound(artifactUrlPath(path));
    }
    await expectNotFound(`/artifacts/no-such-job/${RUN_ARTIFACT_FILE_NAMES.run}`);
    await expectNotFound(`/artifacts/NOT_A_JOB/${RUN_ARTIFACT_FILE_NAMES.run}`);
    await expectNotFound(`/artifacts/${jobId}/`);
  });

  it('rejects dot segments and encoded separators', async () => {
    for (const path of [
      `/artifacts/${jobId}/pages/..%2F..%2F${RUN_ARTIFACT_FILE_NAMES.run}`,
      `/artifacts/${jobId}/..%2f${jobId}%2frun.json`,
      `/artifacts/${jobId}/%252e%252e/${RUN_ARTIFACT_FILE_NAMES.run}`,
      `/artifacts/${jobId}/${RUN_ARTIFACT_FILE_NAMES.run}%00`,
      `/artifacts/${jobId}/${RUN_ARTIFACT_FILE_NAMES.run}%2F`,
      `/artifacts/${jobId}/pages%5C..%5C${RUN_ARTIFACT_FILE_NAMES.run}`,
      `/artifacts/${jobId}/checkpoint%2Fstate.json`,
    ]) {
      await expectNotFound(path);
    }
    // URL の構文で正規化されて Run のディレクトリの外へ出る（`..`）要求は、成果物の route に来ない（成果物を配らない）。
    // 符号化の壊れた要求も、成果物を配らない（Router が 400 で拒む）。
    for (const path of [`/artifacts/${jobId}/../../package.json`, `/artifacts/${jobId}/%2e%2e/%2e%2e/package.json`, `/artifacts/${jobId}/%E0%A4%A`]) {
      const response = await rawRequest(started().port, path, { headers: { cookie } });
      expect(response.status, path).not.toBe(STATUS.OK);
      expect(response.body, path).not.toContain('"devDependencies"');
    }
  });

  it('rejects Windows aliases and device names', async () => {
    for (const path of [
      'RUN.JSON',
      'Report.html',
      `${RUN_ARTIFACT_FILE_NAMES.run}.`,
      `${RUN_ARTIFACT_FILE_NAMES.run}%20`,
      `${RUN_ARTIFACT_FILE_NAMES.run}::$DATA`,
      `${RUN_ARTIFACT_FILE_NAMES.run}%3A%3A%24DATA`,
      'REPORT~1.HTM',
      'CON',
      'nul.json',
      'aux.png',
      `${screenshotPath.slice(0, screenshotPath.lastIndexOf('/'))}/COM1.png`,
    ]) {
      await expectNotFound(artifactUrlPath(path));
    }
  });

  it('does not follow a junction even for a referenced screenshot', async () => {
    const directory = `${runDirectory}/${screenshotPath.slice(0, screenshotPath.lastIndexOf('/'))}`;
    const real = `${directory}-real`;
    renameSync(directory, real);
    symlinkSync(real, directory, 'junction');
    junctions.push(directory);
    try {
      await expectNotFound(artifactUrlPath(screenshotPath));
    } finally {
      unlinkSync(directory);
      renameSync(real, directory);
    }
    expect((await getArtifact(screenshotPath)).status).toBe(STATUS.OK);
  });

  it('answers 401 without the cookie, and serves nothing for other methods', async () => {
    const response = await getArtifact(RUN_ARTIFACT_FILE_NAMES.run, false);
    expect(response.status).toBe(STATUS.UNAUTHORIZED);
    expect(response.body).not.toContain('"schemaVersion"');
    const post = await rawRequest(started().port, artifactUrlPath(RUN_ARTIFACT_FILE_NAMES.run), {
      method: 'POST',
      headers: { cookie, origin: started().origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(post.status).toBe(STATUS.METHOD_NOT_ALLOWED);
    expect(post.body).toBe('');
  });

  it('answers the 404 with the Japanese short text, under the artifact CSP', async () => {
    const response = await getArtifact('notes.json');
    expect(response.body).toBe(LOCAL_UI_AUDIT_TEXT.artifactNotFound);
    expect(response.headers['content-security-policy']).toBe(buildArtifactContentSecurityPolicy([]));
  });
});

describe('artifact routes: report.html in Chromium', () => {
  it('runs no script (even one written into the report), applies the style, and opens the relative screenshot link', async () => {
    if (browser === undefined) {
      throw new Error('Chromium がない');
    }
    const reportPath = `${runDirectory}/${RUN_ARTIFACT_FILE_NAMES.report}`;
    const original = readFileSync(reportPath, 'utf8');
    const originalTitle = /<title>([^<]*)<\/title>/u.exec(original)?.[1] ?? '';
    writeFileSync(reportPath, original.replace('<main>', `<main>${INJECTED_HTML}`), 'utf8');
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const consoleMessages: string[] = [];
      const externalRequests: string[] = [];
      page.on('console', (message) => consoleMessages.push(message.text()));
      page.on('request', (request) => {
        if (!request.url().startsWith(`${started().origin}/`) && !request.url().startsWith('data:')) {
          externalRequests.push(request.url());
        }
      });
      await page.goto(started().tokenUrl.href, { waitUntil: 'networkidle' });
      const response = await page.goto(`${started().origin}${artifactUrlPath(RUN_ARTIFACT_FILE_NAMES.report)}`, { waitUntil: 'networkidle' });
      expect(response?.status()).toBe(STATUS.OK);
      expect(await page.title()).toBe(originalTitle);
      expect(await page.evaluate(() => (window as unknown as { t24fRan?: boolean }).t24fRan)).toBeUndefined();
      expect(consoleMessages.some((message) => /Blocked script execution|Refused to execute/u.test(message))).toBe(true);
      expect(consoleMessages.filter((message) => /Refused to apply inline style|style-src/u.test(message))).toEqual([]);
      // レポートの `<style>` が CSP で止められずに、スタイルシートとして読まれている（止められると `sheet` がない）。
      expect(await page.evaluate(() => document.querySelector('head style') instanceof HTMLStyleElement
        && (document.querySelector('head style') as HTMLStyleElement).sheet !== null)).toBe(true);

      const link = page.locator(`a[href="${screenshotPath.split('/').map((segment) => encodeURIComponent(segment)).join('/')}"]`).first();
      const [navigation] = await Promise.all([page.waitForNavigation(), link.click()]);
      expect(navigation?.status()).toBe(STATUS.OK);
      expect(navigation?.headers()['content-type']).toBe('image/png');
      expect(externalRequests).toEqual([]);
    } finally {
      await context.close();
      writeFileSync(reportPath, original, 'utf8');
    }
  });
});

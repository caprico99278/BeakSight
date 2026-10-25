// T35R-fix（T35R の C-1・I-1・I-2。Task 35 の設計書の履歴の T35R の行）: スクリプトで送るログインの監査の Run（`executeAuditRun` に、監査の段の口つきの
// 認証の指定を渡す。ワーカーと同じ形）を、幅の走査ありで流す。自前の 127.0.0.1 のサーバ 2 つ（アプリと、承認したサービスの Origin）。Chromium はテストの
// 既定の headless と、CLI の起動の設定の両方。レビュー担当の実験（T35R の `run.t35r.test.ts`）を写して、確かめの形にした。
// - C-1: 管理画面は、サービスの Origin の iframe（sub frame の文書）と fetch を出す。幅の走査と Interaction（`REVISIT`）の読み込みでは、サービスの Origin
//   に何も届かない（届くのは、Desktop と Mobile の最初の読み込みの分だけ）。止めた理由 `SERVICE_ORIGIN_REVISIT` が成果物に残る。小さな上限
//   （`perRun: 2`）では、届いた数が上限を超えない。
// - I-2: 上限で止めた要求が 1 つでもあれば、残りのページがなくても Run は PARTIAL で、未完了の理由 `SERVICE_REQUEST_LIMIT_REACHED` が残る（実行の終わり方
//   は、残りのページがないので `COMPLETED`）。
// - I-1・M-2・M-3: 文の中の前置きつきの URL（`url=`・`next=`・`(`・`[`・`{url:`・`x,`）、サービスのホストへの WebSocket の URL、fragment、iframe と
//   リンクの query の値が、成果物（ZIP の中身を含む）に出ない。
// 届いた数は、サーバの記録で数える（事前確認を除く）。各 Run の後に、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { RunSummary } from '../../src/core/contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { filesUnder, placesWithMarkers } from '../helpers/leak-places.js';
import { LOADED_RESOURCE_SETTLING_TIMEOUT_MS } from '../helpers/loaded-deadline.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 240_000;
/** 各 Run の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
/** 幅の走査の幅（空にしない。3 つの読み込み直し）。 */
const STRESS_WIDTHS = Object.freeze([320, 768, 1024]);
/** 1 ページの最初の読み込み（Desktop と Mobile）の数。 */
const PRIMARY_LOADS_PER_PAGE = 2;
/** 管理画面の 1 回の読み込みが、サービスの Origin に送る要求の数（iframe の文書と fetch）。 */
const SERVICE_REQUESTS_PER_LOAD = 2;
const MAX_PAGES = 1;
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const SMALL_LIMITS = Object.freeze({ perMinute: 120, perRun: 2 });
const STORAGE_KEY = 'fixture-auth-token';
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
const ADMIN_PATH = '/admin';
const AUTH_PATH = '/auth';
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;

/** 成果物に出てはいけない目印（秘密ではないテストの文字列）。 */
const MARKERS = Object.freeze({
  linkQuery: 'lmark.dave@example.invalid',
  iframeQuery: 'imark.carol@example.invalid',
  consoleParen: 'cmarkparen@example.invalid',
  consoleEq: 'cmarkeq@example.invalid',
  errorBracket: 'bracketmark.g@example.invalid',
  errorBrace: 'bracemark.h@example.invalid',
  errorComma: 'commamark.j@example.invalid',
  warnNext: 'warnmark.k@example.invalid',
  wsTenant: 'wsmarktenant',
  fragment: 'hmarkfrag',
});

type PageMode = 'limit' | 'leak';

interface ServerRecord {
  readonly server: 'app' | 'service';
  readonly method: string;
  readonly path: string;
  readonly preflight: boolean;
}

/** 管理画面の HTML（`limit`: サービスの Origin の iframe と fetch。`leak`: 加えて、目印を入れた URL を文とリンクと WebSocket に出す）。 */
const adminHtml = (mode: PageMode, service: string): string => {
  const ws = `ws://${new URL(service).host}`;
  const limitBody = `<iframe title="svc" src="${service}/frame.html"></iframe>
<script>fetch('${service}/rest/v1/members').catch(() => 0);</script>`;
  const leakBody = `<a href="${service}/rest/v1/members?email=eq.${MARKERS.linkQuery}">リンク</a>
<iframe title="svc" src="${service}/frame.html?email=${MARKERS.iframeQuery}"></iframe>
<script>
fetch('${service}/rest/v1/q#x=${MARKERS.fragment}').catch(() => 0);
console.log('loading (${service}/rest/v1/members?email=eq.${MARKERS.consoleParen})');
console.error('url=${service}/rest/v1/x?email=eq.${MARKERS.consoleEq}');
console.error('[${service}/rest/v1/b?email=eq.${MARKERS.errorBracket}]');
console.error('{url:${service}/rest/v1/c?email=eq.${MARKERS.errorBrace}}');
console.error('x,${service}/rest/v1/e?email=eq.${MARKERS.errorComma}');
console.warn('next=${service}/rest/v1/w?email=eq.${MARKERS.warnNext}');
try { new WebSocket('${ws}/realtime/v1/websocket?tenant=${MARKERS.wsTenant}'); } catch (error) { console.error(String(error)); }
</script>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>管理</title></head><body><h1>管理</h1><main><p>一覧</p>
${mode === 'limit' ? limitBody : leakBody}</main></body></html>`;
};

describe.each(LAUNCHERS)('T35R-fix: the service origin requests on the width scan with %s', (_label, launch) => {
  let app: LoopbackHttpServer;
  let service: LoopbackHttpServer;
  let workDirectory = '';
  let mode: PageMode = 'limit';
  let runCount = 0;
  const records: ServerRecord[] = [];

  const listenerOf = (server: ServerRecord['server']) => (request: IncomingMessage, response: ServerResponse): void => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const preflight = request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      records.push({ server, method: request.method ?? '', path: url.pathname, preflight });
      const cors = {
        'access-control-allow-origin': typeof request.headers.origin === 'string' ? request.headers.origin : '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(HTTP_NO_CONTENT, cors).end();
      } else if (server === 'app' && url.pathname.startsWith(ADMIN_PATH)) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(adminHtml(mode, service.origin));
      } else if (server === 'app') {
        response.writeHead(HTTP_NOT_FOUND, { 'content-type': 'text/plain' }).end('not found');
      } else if (url.pathname.endsWith('.html')) {
        response.writeHead(HTTP_OK, { ...cors, 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>f</title><p>frame</p>');
      } else {
        response.writeHead(HTTP_OK, { ...cors, 'content-type': 'application/json' }).end('{"n":1}');
      }
    });
  };

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-spa-audit-revisit-'));
    service = await startLoopbackHttpServer(listenerOf('service'));
    app = await startLoopbackHttpServer(listenerOf('app'));
  });

  afterAll(async () => {
    await Promise.all([app?.close(), service?.close()]);
    await rm(workDirectory, { recursive: true, force: true });
  });

  /** 幅の走査ありで、管理画面だけを監査する。届いた要求（この Run の分）と `run.json` を返す。 */
  const audit = async (pageMode: PageMode, limits: { readonly perMinute: number; readonly perRun: number }) => {
    mode = pageMode;
    runCount += 1;
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [service.origin],
      auditReadRequests: [],
      scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      serviceRequestLimits: limits,
    };
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: app.origin, localStorage: [{ name: STORAGE_KEY, value: 'stored-session' }] }] },
      approvedTestOrigins: [app.origin],
      auditExclusions: { excludedPathPrefixes: ['/auth/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: AUTH_PATH,
      filterState: filterAuthenticatedState,
      auditStage,
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: app.origin, ...FIXTURE_KEY }),
    };
    const base = fastRunConfig(app.origin, ADMIN_PATH, {
      target: { id: `revisit-${runCount}` },
      output: { directory: join(workDirectory, `run-${runCount}`) },
      // DF-2b（DEF-151）: 幅の走査の場面が混雑の下で PARTIAL になった回があったので、判定に関わらない DOM の準備の期限は混雑の倍率を掛けた値にする。
      crawl: { maxPages: MAX_PAGES, resourceSettlingTimeoutMs: LOADED_RESOURCE_SETTLING_TIMEOUT_MS },
      viewports: { stressWidths: [...STRESS_WIDTHS] },
      audit: { screenshots: pageMode === 'leak' },
    });
    const config: AuditConfig = { ...base, site: { startUrl: `${app.origin}${ADMIN_PATH}`, allowedOrigins: [app.origin] } };
    const start = records.length;
    const outcome = await executeAuditRun(config, {
      launchBrowser: () => launch(), clock: () => new Date(), now: () => Date.now(), authentication,
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    const arrived = records.slice(start).filter((record) => !record.preflight);
    const run = JSON.parse(readFileSync(join(outcome.runDirectory, 'run.json'), 'utf8')) as RunSummary;
    return { arrived, run, runDirectory: outcome.runDirectory };
  };

  it('sends nothing to the service origin on the width scan loads, and records the reason', async () => {
    const { arrived, run, runDirectory } = await audit('limit', DEFAULT_LIMITS);
    // 幅の走査の読み込み直しがあった（アプリの管理画面を、最初の読み込みより多く読んだ）。
    expect(arrived.filter(({ server, path }) => server === 'app' && path === ADMIN_PATH).length).toBeGreaterThan(PRIMARY_LOADS_PER_PAGE);
    // サービスの Origin に届いたのは、Desktop と Mobile の最初の読み込みの分だけ。
    expect(arrived.filter(({ server }) => server === 'service')).toHaveLength(PRIMARY_LOADS_PER_PAGE * SERVICE_REQUESTS_PER_LOAD);
    expect(run.runStatus).toBe('COMPLETE');
    expect(placesWithMarkers(filesUnder(runDirectory), ['SERVICE_ORIGIN_REVISIT']).length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it('keeps the arrivals within perRun, and ends PARTIAL with the reason even without a remaining page', async () => {
    const { arrived, run } = await audit('limit', SMALL_LIMITS);
    expect(arrived.filter(({ server }) => server === 'service').length).toBeLessThanOrEqual(SMALL_LIMITS.perRun);
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.incompleteReasons.map(({ code }) => code)).toContain('SERVICE_REQUEST_LIMIT_REACHED');
    expect(run.authentication?.serviceRequestLimitReached).toBe(true);
    // 残りのページがない（1 ページだけ）ので、実行の終わり方は COMPLETED。
    expect(run.executions.at(-1)?.endReason).toBe('COMPLETED');
  }, TEST_TIMEOUT_MS);

  it('leaks no service origin URL value after a prefix, of a WebSocket, or in a fragment to the artifacts', async () => {
    const { runDirectory } = await audit('leak', DEFAULT_LIMITS);
    const markers = Object.values(MARKERS).flatMap((marker) => [marker, encodeURIComponent(marker)]);
    expect(placesWithMarkers(filesUnder(runDirectory), markers)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

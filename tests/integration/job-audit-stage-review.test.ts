// T37R-fix-B（Task 37 の設計書 8 章の T37R の行。独立レビュー T37R の I-1・M-2・M-5）: 監査の段の口のある発見と READ の確かめのジョブ（本物の factory と
// Guard）。自前の 127.0.0.1 のサーバ 2 つ（アプリと、承認したサービスの Origin）。Chromium はテストの既定の headless（probe の目印が届かない場面だけ、
// CLI の起動の設定でも）。
// - I-1: 送らずに観察する probe の押下でページが書き換えた localStorage（token を消す `tokenClear`、下書きを保存する `storageDraft`）を、次の Context へ
//   受け継がない（閉じるときに渡す状態と鍵の消失の判定は、押す前に読んだ状態）。ジョブは COMPLETE のまま、probe の目印はサーバへ届かない。
// - M-2: 登録した読み取りの手続きの呼び出しを回数の上限で止めた画面は、読み切れなかった画面（`SERVICE_READ_REFUSED`）になり、その候補は `MISSING` にならず、
//   候補の READ は `READ_CANDIDATE_DRIFTED` にならない（判定は `audit-stage-run.ts` の 1 か所）。
// - M-5（T37R-fix-B2 で設計者の既定を取り下げ）: 許可 Origin への `fetch`・`xhr` の読み取りでない要求を止めた数は、成果物（`authentication`）に残すが、
//   描けなかった画面の判定には使わない。同じ Origin の POST でデータを取る画面は `NOT_MATCHED` になりうる（限界）。`sendBeacon` の計測の送信は数えない。
// 届いた要求は、サーバの記録で数える。各ジョブの後に、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。値は出力しない。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { BOTH_CHROMIUM_LAUNCHERS, DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { settleLateDeliveries, startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';

const TEST_TIMEOUT_MS = 240_000;
/** 各ジョブの後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const MAX_PAGES = 4;
/** ログインの状態の鍵の名前と値（匿名の仮の値）。 */
const TOKEN_KEY = 'auth-token';
const TOKEN_VALUE = 'token-value-example';
/** probe が text の欄に入れる目印の始まり（`submission-probe-contracts.ts` の目印の形）。 */
const PROBE_MARKER_PREFIX = 'bsprobe';
const LIST_RPC_PATH = '/rpc/list_members';
/** I-2: 本文を遅らせる一覧の API と、その行（匿名の値）。 */
const SLOW_LIST_API_PATH = '/members/slow';
const SLOW_LIST_ROWS = Object.freeze([{ id: 1, name: '既存花子' }, { id: 2, name: '既存太郎' }]);
/** I-2（DEF-265 で猶予を戻した）: 猶予（`DISCOVERY_RESPONSE_BODY_GRACE_MS`。2 秒）の中の本文の遅れと、猶予を超える遅れ（ms）。 */
const BODY_DELAYS_WITHIN_GRACE: readonly number[] = [0, 400, 1_500];
const BODY_DELAY_BEYOND_GRACE = 3_000;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;

/** 押したときにページの JS が行うこと（`API`・`input` が使える）。 */
const ON_CLICK: Readonly<Record<string, string>> = Object.freeze({
  tokenClear: `fetch(API + '/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: input.value }) })
    .catch(() => localStorage.removeItem('${TOKEN_KEY}'));`,
  storageDraft: `localStorage.setItem('draft', input.value);
    fetch(API + '/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: input.value }) });`,
  // DEF-233 fix round 1: 押下で、ログインの成功の鍵（token の鍵）の値を、欄の値（目印）を含む値に書き換える（A2 の重ねで、次の画面へ渡してはいけない）。
  tokenOverwrite: `localStorage.setItem('${TOKEN_KEY}', 'tok-' + input.value);
    fetch(API + '/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: input.value }) });`,
});

/** 読み込みのときにページの JS が行うこと（`API`・`APP` が使える）。 */
const ON_LOAD: Readonly<Record<string, string>> = Object.freeze({
  // 登録した手続きの呼び出しを 2 回送る（1 回の読み込みあたりの上限は 1。2 回目は Guard が止める）。
  rpcTwice: `fetch(API + '${LIST_RPC_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())
      .then(() => fetch(API + '${LIST_RPC_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).catch(() => 0);`,
  // 同じ Origin の fetch の POST でデータを取る（Guard が止める）。
  // 一覧の行を、同じ Origin の fetch の POST の結果で描く（Guard が止めるので、行は描かれない）。
  sameOriginFetchPost: `document.getElementById('rows').innerHTML = '<tr><td>読み込み中</td></tr>';
    fetch(APP + '/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())
      .then((rows) => { document.getElementById('rows').innerHTML = rows.map((row) => '<tr><td>' + row.name + '</td></tr>').join(''); }).catch(() => 0);`,
  // 計測の送信（sendBeacon）だけ。
  beaconOnly: `navigator.sendBeacon(APP + '/rum', 'event=load');`,
  // DEF-233 fix round 1: 読み込みのときに、token の鍵の値を API へ送る（次の画面へ渡った値がサーバに届くかを数える）。
  tokenOverwrite: `fetch(API + '/members?token=' + encodeURIComponent(localStorage.getItem('${TOKEN_KEY}') ?? '')).catch(() => undefined);`,
});
/**
 * DEF-239（DEF-208-4 の後の直し）: 2 画面目の path。1 画面目（`/s/<場面>/1/edit`）と同じ型にならない path にする（同じ型の画面は 1 つだけ読む決まりで、
 * 2 画面目を読まなくなるため）。
 */
const secondPagePathOf = (scenario: string): string => `/s/${scenario}/next`;

interface Logged {
  readonly server: 'app' | 'api';
  readonly method: string;
  readonly url: string;
}
const noObserver = { onRunStarted: (): void => undefined, onSessionLost: (): void => undefined };

/** 場面の支度（2 つのサーバと作業のフォルダ）と、場面が使う道具（describe の中で呼ぶ）。 */
const useReviewJobs = (launch: () => Promise<Browser>) => {
  let app: LoopbackHttpServer;
  let api: LoopbackHttpServer;
  let workDirectory = '';
  let runCount = 0;
  const log: Logged[] = [];

  const pageHtml = (scenario: string, page: number): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>編集</title></head><body>
<main><h1>編集</h1><table><tbody id="rows"><tr><td>既存花子</td></tr></tbody></table>
<div id="box"><label>名前 <input type="text" id="name" aria-label="名前"></label><button type="button" id="save">保存</button></div>
${page === 1 ? `<a href="${secondPagePathOf(scenario)}">次</a>` : ''}</main>
<script>
const API = ${JSON.stringify(api.origin)};
const APP = ${JSON.stringify(app.origin)};
const input = document.getElementById('name');
fetch(API + '/members?select=id').then((r) => r.text()).catch(() => undefined);
const draft = localStorage.getItem('draft');
if (draft !== null) fetch(API + '/members?name=eq.' + encodeURIComponent(draft)).catch(() => undefined);
${ON_LOAD[scenario] ?? ''}
document.getElementById('save').addEventListener('click', () => { ${ON_CLICK[scenario] ?? ''} });
</script></body></html>`;

  /** I-2: データを後から API で描く一覧の画面（API の本文を `delayMs` 遅らせる）。 */
  const slowListHtml = (delayMs: number): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>一覧</title></head><body>
<main><h1>会員の一覧</h1><table><thead><tr><th>ID</th><th>名前</th></tr></thead><tbody id="rows"><tr><td colspan="2">読み込み中</td></tr></tbody></table></main>
<script>fetch(${JSON.stringify(api.origin)} + '${SLOW_LIST_API_PATH}?d=${String(delayMs)}').then((r) => r.json()).then((rows) => {
  document.getElementById('rows').innerHTML = rows.map((row) => '<tr><td>' + row.id + '</td><td>' + row.name + '</td></tr>').join('');
});</script></body></html>`;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-job-audit-stage-review-'));
    api = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const cors = {
        'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(HTTP_NO_CONTENT, cors).end();
        return;
      }
      log.push({ server: 'api', method: request.method ?? '', url: request.url ?? '' });
      const url = new URL(request.url ?? '/', 'http://x');
      if (url.pathname === SLOW_LIST_API_PATH) {
        // I-2: ヘッダを先に返し、本文を遅らせる。
        response.writeHead(HTTP_OK, { ...cors, 'content-type': 'application/json' });
        response.flushHeaders();
        setTimeout(() => response.end(JSON.stringify(SLOW_LIST_ROWS)), Number(url.searchParams.get('d') ?? '0'));
        return;
      }
      response.writeHead(HTTP_OK, { ...cors, 'content-type': 'application/json' }).end('[]');
    });
    app = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      log.push({ server: 'app', method: request.method ?? '', url: request.url ?? '' });
      const pathname = new URL(request.url ?? '/', 'http://x').pathname;
      const match = /^\/s\/([A-Za-z]+)\/(?:(1)\/edit|next)$/u.exec(pathname);
      if (match !== null && request.method === 'GET') {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml(match[1] ?? '', match[2] === '1' ? 1 : 2));
        return;
      }
      const slow = /^\/list\/([0-9]+)$/u.exec(pathname);
      if (slow !== null && request.method === 'GET') {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(slowListHtml(Number(slow[1])));
        return;
      }
      response.writeHead(HTTP_NOT_FOUND, { 'content-type': 'text/plain' }).end('nf');
    });
  });

  afterAll(async () => {
    await Promise.all([app?.close(), api?.close()]);
    await rm(workDirectory, { recursive: true, force: true });
  });

  const setup = (scenario: string, reads: readonly string[] = []): { readonly config: AuditConfig; readonly authentication: RunAuthentication } => {
    runCount += 1;
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [api.origin],
      auditReadRequests: reads.map((path) => ({ origin: api.origin, path, method: 'POST', maxPerPageLoad: 1 })),
      scriptLogin: { origin: api.origin, path: '/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },    };
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: app.origin, localStorage: [{ name: TOKEN_KEY, value: TOKEN_VALUE }] }] },
      approvedTestOrigins: [app.origin],
      auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: '/login',
      filterState: filterAuthenticatedState,
      auditStage,
      sessionKeyPresent: (state) => state.origins.some((origin) => origin.localStorage.some((item) => item.name === TOKEN_KEY)),
      // DEF-233: 成功の鍵の名前の判定（A2 の重ねを働かせる。ワーカーと同じく、鍵の形があるプロファイル）。
      sessionKeyName: (_origin, name) => name === TOKEN_KEY,
    };
    const path = `/s/${scenario}/1/edit`;
    const base = fastRunConfig(app.origin, path, {
      target: { id: `review-${runCount}` }, output: { directory: join(workDirectory, `job-${runCount}`) }, crawl: { maxPages: MAX_PAGES },
    });
    return { config: { ...base, site: { startUrl: `${app.origin}${path}`, allowedOrigins: [app.origin] } }, authentication };
  };

  const discover = async (scenario: string, reads: readonly string[] = []): Promise<DiscoveryDocument> => {
    const { config, authentication } = setup(scenario, reads);
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-discovery-${runCount}`, authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      // SLIM-2（X2）: probe の観察はテストの短い値（本番の値は `production-wait-values` と Gate (n)(p)）。
      stopSignal: new AbortController().signal, observationWindows: TEST_OBSERVATION_WINDOWS,
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    // SLIM-2（X1）: 流れは Browser を閉じて終わる。閉じた後の待ちは、サーバが静まるまで。
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, app, api);
    return JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
  };

  const pageReadCheck = async (scenario: string): Promise<ReadEvidenceDocument> => {
    const { config, authentication } = setup(scenario);
    const path = `/s/${scenario}/1/edit`;
    const definition: WorkerStartReadCheck = {
      readCheckId: 'read-1',
      readCheckRevision: 1,
      targetPage: { origin: app.origin, path },
      definition: { targetPagePath: path, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: '既存花子' }] },
    };
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-${runCount}`, authentication, readChecks: [definition], launchBrowser: launch,
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, app, api);
    return JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument;
  };

  /** I-2: 本文を遅らせた一覧の画面の READ（画面の path の定義。期待は行の名前と行の数）。 */
  const slowListReadCheck = async (delayMs: number): Promise<ReadEvidenceDocument> => {
    const { config, authentication } = setup('slow');
    const path = `/list/${String(delayMs)}`;
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-${runCount}`, authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal,
      readChecks: [{
        readCheckId: 'read-1', readCheckRevision: 1, targetPage: { origin: app.origin, path },
        definition: {
          targetPagePath: path, parameters: {},
          expectations: [{ kind: 'TEXT_CONTAINS', text: SLOW_LIST_ROWS[0]?.name ?? '' }, { kind: 'ROW_COUNT_AT_LEAST', count: SLOW_LIST_ROWS.length }],
        },
      }],
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    return JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument;
  };
  const resultsOf = (document: ReadEvidenceDocument): readonly string[] =>
    document.checks.map((check) => (check.state === 'EXECUTED' ? check.result : check.state));

  const readPaths = (document: DiscoveryDocument): readonly string[] =>
    document.pages.flatMap((page) => (page.state === 'READ' ? [new URL(page.url).pathname] : []));
  const reasonsOf = (document: DiscoveryDocument, path: string): readonly string[] => {
    const page = document.pages.find((entry) => entry.state === 'READ' && new URL(entry.url).pathname === path);
    return page?.state === 'READ' ? page.record.incompleteReasons : [];
  };

  return { log, discover, pageReadCheck, slowListReadCheck, resultsOf, readPaths, reasonsOf };
};

// TEST-SLIM M4: probe の押下で書いた目印と、読み取りでない要求がサーバに届かない場面は、2 つの Chromium で流す（安全の漏れの確かめ）。
describe.each(BOTH_CHROMIUM_LAUNCHERS)('T37R-fix-B: the audit stage of the jobs (the probe press leaks nothing) with %s', (_label, launch) => {
  const { log, discover, readPaths } = useReviewJobs(launch);

  // DEF-233 fix round 1: `tokenOverwrite` は、押下で成功の鍵の値を目印を含む値に書き換える場面（A2 の重ねでも渡さない）。
  it.each(['tokenClear', 'storageDraft', 'tokenOverwrite'])('does not carry over what the probe press wrote (%s): COMPLETE, no marker at the server', async (scenario) => {
    const start = log.length;
    const document = await discover(scenario);
    expect(document.endReason).toBe('COMPLETED');
    expect(document.endReasonDetail).toBeUndefined();
    expect(readPaths(document)).toEqual([`/s/${scenario}/1/edit`, secondPagePathOf(scenario)]);
    expect(document.runStatus).toBe('COMPLETE');
    await wait(LATE_REQUEST_WAIT_MS);
    const reached = log.slice(start);
    expect(reached.filter(({ url }) => url.includes(PROBE_MARKER_PREFIX))).toEqual([]);
    if (scenario === 'tokenOverwrite') {
      // 2 画面目も、押す前の token の値で読んだ（1 画面目と 2 画面目の読み込みで、押す前の値がサーバに届いた）。
      expect(reached.filter(({ url }) => url.includes(`token=${TOKEN_VALUE}`)).length).toBe(2);
    }
    expect(reached.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('T37R-fix-B: the audit stage of the jobs (the review findings) with %s', (_label, launch) => {
  const { discover, pageReadCheck, slowListReadCheck, resultsOf, reasonsOf } = useReviewJobs(launch);

  it.each(BODY_DELAYS_WITHIN_GRACE)('waits for a body %i ms late within the grace, and the page READ is MATCHED (I-2)', async (delayMs) => {
    const evidence = await slowListReadCheck(delayMs);
    expect(resultsOf(evidence)).toEqual(['MATCHED']);
  }, TEST_TIMEOUT_MS);

  // 限界（Task 37 の設計書 8 章の T37R の行）: 猶予を超えて本文が遅い応答は、描かれる前に読みうる。今の振る舞い（行がまだ描かれていない画面を照らす）を固定する。
  it('reads before a body later than the grace (the known limit, I-2)', async () => {
    const evidence = await slowListReadCheck(BODY_DELAY_BEYOND_GRACE);
    expect(resultsOf(evidence)).toEqual(['NOT_MATCHED']);
  }, TEST_TIMEOUT_MS);

  // M-2 は、1 回の読み込みで登録した呼び出しの回数の上限を超えた画面の印だった。L11（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4）で
  // 読み込みあたりの回数を数えなくなったので、同じ読み込みの 2 回目の呼び出しも通り、その画面は読み切れたものとする。
  it('passes the second registered call of the same load, and does not mark the page as not read in full (M-2 after L11)', async () => {
    const document = await discover('rpcTwice', [LIST_RPC_PATH]);
    expect(reasonsOf(document, '/s/rpcTwice/1/edit')).not.toContain('SERVICE_READ_REFUSED');
    expect(document.authentication?.registeredReadRequestsAllowed).toBeGreaterThan(1);
  }, TEST_TIMEOUT_MS);

  // T37R-fix-B2（設計書 8 章の最後の行。M-5 の既定の取り下げ）: 許可 Origin への `fetch`・`xhr` の読み取りでない要求を止めた数は、成果物に残すが、
  // 描けなかった画面の判定には使わない（`fetch` で送る計測の送信と見分けられない）。同じ Origin の POST でデータを取る画面は、行が描かれないまま照らされ、
  // `NOT_MATCHED` になりうる（限界。今の振る舞いを固定する）。`sendBeacon` の計測の送信は数えない。
  it('records a blocked same origin fetch POST without the decision; such a page can be NOT_MATCHED (M-5 withdrawn)', async () => {
    const blocked = await discover('sameOriginFetchPost');
    expect(reasonsOf(blocked, '/s/sameOriginFetchPost/1/edit')).not.toContain('SERVICE_READ_REFUSED');
    expect(blocked.authentication?.allowedOriginDataRequestsBlocked).toBeGreaterThan(0);
    const beacon = await discover('beaconOnly');
    expect(reasonsOf(beacon, '/s/beaconOnly/1/edit')).not.toContain('SERVICE_READ_REFUSED');
    expect(beacon.authentication?.allowedOriginDataRequestsBlocked).toBe(0);
    const evidence = await pageReadCheck('sameOriginFetchPost');
    expect(evidence.checks.map((check) => (check.state === 'EXECUTED' ? check.result : check.state))).toEqual(['NOT_MATCHED']);
    expect(evidence.authentication?.allowedOriginDataRequestsBlocked).toBeGreaterThan(0);
    const beaconEvidence = await pageReadCheck('beaconOnly');
    expect(beaconEvidence.checks.map((check) => (check.state === 'EXECUTED' ? check.result : check.state))).toEqual(['MATCHED']);
  }, TEST_TIMEOUT_MS);
});

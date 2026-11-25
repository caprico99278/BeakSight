// RCA-7（検索の確かめの設計書 2.2・2.3、RCA-7 の Blocker の判断）: 見るだけの確かめの段（本物の `executeReadCheckRun`）が、最新の操作さがし（本物の
// `executeDiscoveryRun`）の記録から作った組（`searchCheckPlanOf`）を確かめる。127.0.0.1 の仮のサイト（一般の文言）。
// - GET の検索フォームの組: 定義の READ と同じ手順で読み、5xx は誤り、4xx は誤りにしない。
// - 打つだけの欄の組（決まった値を打つ）: 5xx を返す値は誤り。押すと欄が埋まるので、ほかのボタンと別の画面に置く。
// - JS の検索ボタンの組（決まった値を入れて押す）: 「詳しく」を押して出るボタンなので、記録した押下をたどり直してから押す。5xx を返す値は誤り。
// - 進み具合は 0 / M から組ごとに N / M。サーバに届くのは読み取りだけ（ボタンが出す保存の POST は凍結が届けない）。安全の場面なので両方の Chromium で流す。
// 操作さがしは 1 回（片方の Chromium）。確かめは、計画の組から場面に要る組だけを選んで流す（組ごとに画面を読むので、全部は流さない）。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, READ_EVIDENCE_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE } from '../../src/core/audit-send-policy.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { observationWindowsOf } from '../../src/core/observation-windows.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { WorkerStartSearchCheck } from '../../src/control/worker-protocol.js';
import { discoveryCandidatesOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { searchCheckEvidenceBaseOf, type ReadEvidenceDocument, type SearchCheckTrigger } from '../../src/discovery/read-check-evaluation.js';
import { searchCheckPlanOf, type SearchCheckCombo } from '../../src/discovery/search-check-plan.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey, isSuccessStorageKeyName } from '../../src/worker/login-stage-checks.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { BOTH_CHROMIUM_LAUNCHERS, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS, nonReadRequestsOf } from '../helpers/leak-places.js';
import { settleLateDeliveries, startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import { TOKEN_REFRESH_KEY_SHAPE, TOKEN_REFRESH_PATHS, TOKEN_REFRESH_STORAGE_KEY, startTokenRefreshSite } from '../helpers/token-refresh-site.js';

/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 200;
/** ループバックの fixture の要求は数 ms で終わるので、画面の落ち着きと押した後の最短の観察を短くする（テストの値）。 */
const SHORT_WINDOWS = observationWindowsOf({
  discoverySettle: { networkQuietMs: 100, pollIntervalMs: 20, probeIntervalMs: 50 },
  afterPress: { probeQuietWaitMs: 150 },
});

const draw = "then((r) => r.json()).then((d) => { document.getElementById('out').innerHTML = d.items.map((i) => '<li>' + i + '</li>').join(''); }).catch(() => {})";
const PAGES: Readonly<Record<string, string>> = {
  '/': '<main><h1>入口</h1><a href="/find">さがす</a> <a href="/hid">隠し</a> <a href="/ops">操作</a> <a href="/typed">打つ</a> <a href="/staged">詳しく</a></main>',
  // GET の検索フォーム（半角の目印は 500、全角の目印は 422）。
  '/find': '<main><h1>さがす</h1><form method="get" action="/found"><input name="q" type="search"><button type="submit">表示</button></form></main>',
  // REV-RCA の I-1: トークンでない hidden の欄のある GET の検索フォーム（hidden の欄がないと 500）。
  '/hid': '<main><h1>隠し</h1><form method="get" action="/list"><input type="hidden" name="section" value="x1"><input name="q" type="search"><button type="submit">表示</button></form></main>',
  // REV-RCA の I-3: 選択肢の表示の文字が削除の語の GET のフォーム（値は数字）。
  '/ops': '<main><h1>操作</h1><form method="get" action="/run"><select name="op"><option value="1">表示</option><option value="2">削除</option></select><button type="submit">実行</button></form></main>',
  // 打つだけの欄（入れた値で取りに行く。REV-RCA の I-2: 空なら取りに行かない）。
  '/typed': `<main><h1>打つ</h1><input id="kw" name="kw" type="search"><ul id="out"></ul></main><script>
    document.getElementById('kw').addEventListener('input', (e) => { if (e.target.value !== '') fetch('/api/typed?q=' + encodeURIComponent(e.target.value)).${draw}; });</script>`,
  // 「詳しく」を押すと出る JS の検索ボタン（押すと保存の POST も出す）。
  '/staged': `<main><h1>詳しく</h1><button id="open" type="button">詳しく</button><div id="box"></div><ul id="out"></ul></main><script>
    document.getElementById('open').addEventListener('click', () => {
      if (document.getElementById('panel') !== null) return;
      document.getElementById('box').innerHTML = '<section id="panel" aria-label="さがす"><h2>さがす</h2><input id="s" name="s" type="text"><button id="sgo" type="button">検索</button></section>';
      document.getElementById('sgo').addEventListener('click', () => {
        fetch('/api/staged?s=' + encodeURIComponent(document.getElementById('s').value)).${draw};
        fetch('/api/save', { method: 'POST', body: 'x' }).catch(() => {});
      });
    });</script>`,
};

/**
 * REV-RCA fix round 2: 値の形（組ごとに作る目印）。半角は操作さがしの目印と同じ形、全角は仮名の並び。サイトは形で状態を決める（値そのものは決まらない）。
 * 操作さがしの目印も半角の形なので、操作さがしの記録は半角で 5xx を返さない画面で作る。
 */
const shapeOf = (value: string): 'EMPTY' | 'HALF_WIDTH' | 'FULL_WIDTH' | 'OTHER' => {
  if (value === '') return 'EMPTY';
  if (/^bsprobe[0-9a-f]{12}$/u.test(value)) return 'HALF_WIDTH';
  return /^[ぁ-ゖ]{12,}$/u.test(value) ? 'FULL_WIDTH' : 'OTHER';
};

/** 値の形ごとの API の状態（ほかは 200）。 */
const apiStatusOf = (path: string, value: string): number => {
  if (path === '/api/typed') return shapeOf(value) === 'FULL_WIDTH' ? 500 : 200;
  if (path === '/api/staged') return shapeOf(value) === 'EMPTY' ? 500 : 200;
  return 200;
};

/** 確かめる組（きっかけ・画面・値の種類）と、期待する詳しい理由。 */
const SCENES: readonly { readonly trigger: SearchCheckTrigger; readonly pagePath: string; readonly text: string; readonly detail: string }[] = [
  { trigger: 'FORM', pagePath: '/find', text: 'HALF_WIDTH', detail: 'SERVER_ERROR' },
  { trigger: 'FORM', pagePath: '/find', text: 'FULL_WIDTH', detail: 'CLIENT_ERROR_STATUS' },
  { trigger: 'FORM', pagePath: '/hid', text: 'HALF_WIDTH', detail: 'UNSENT_HIDDEN_FIELDS' },
  { trigger: 'TYPED', pagePath: '/typed', text: 'FULL_WIDTH', detail: 'SERVER_ERROR' },
  { trigger: 'TYPED', pagePath: '/typed', text: 'EMPTY', detail: 'EMPTY_NOT_SEARCHED' },
  { trigger: 'PRESS', pagePath: '/staged', text: 'EMPTY', detail: 'SERVER_ERROR' },
  { trigger: 'PRESS', pagePath: '/staged', text: 'FULL_WIDTH', detail: 'OPENED' },
];

const sceneOf = (combo: SearchCheckCombo) => {
  const { trigger, pagePath, how } = searchCheckEvidenceBaseOf(combo);
  return SCENES.find((scene) => scene.trigger === trigger && scene.pagePath === pagePath && how.kind === 'TEXT' && how.text === scene.text);
};

const arrivals: { method: string; path: string }[] = [];
const server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  arrivals.push({ method: request.method ?? '', path: url.pathname });
  if (url.pathname.startsWith('/api/')) {
    response.statusCode = apiStatusOf(url.pathname, [...url.searchParams.values()][0] ?? '');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: ['one'] }));
    return;
  }
  if (url.pathname === '/found' || url.pathname === '/list' || url.pathname === '/run') {
    const q = url.searchParams.get('q') ?? '';
    response.statusCode = (url.pathname === '/list' && !url.searchParams.has('section')) || (url.pathname === '/found' && shapeOf(q) === 'HALF_WIDTH') ? 500
      : url.pathname === '/found' && shapeOf(q) === 'FULL_WIDTH' ? 422 : 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="ja"><head><title>結果</title></head><body><main><h1>結果</h1></main></body></html>');
    return;
  }
  const page = PAGES[url.pathname];
  response.statusCode = page === undefined ? 404 : 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(page === undefined ? '' : `<!doctype html><html lang="ja"><head><title>仮</title></head><body>${page}</body></html>`);
});
const directory = await mkdtemp(join(tmpdir(), 'beaksight-search-checks-'));
const config = createTestConfig(server.origin, '/', {
  crawl: { maxPages: 10, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
  audit: { screenshots: false, sendPolicy: AUDIT_SEND_PASS_EXCEPT_DELETE }, output: { directory },
});
const authentication = {
  initialState: { cookies: [], origins: [] }, approvedTestOrigins: [server.origin],
  auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login', filterState: filterAuthenticatedState,
};
const browsers: Browser[] = [];
const launchingWith = (launch: () => Promise<Browser>) => async (): Promise<Browser> => {
  const browser = await launch();
  browsers.push(browser);
  return browser;
};
const run = { clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, observationWindows: SHORT_WINDOWS };

/** 操作さがしの記録から選んだ組（1 回だけ流す）と、選択肢の表示の文字が削除の語のフォームの組（REV-RCA の I-3）。 */
let combos: readonly SearchCheckCombo[] = [];
let opsCombos: readonly SearchCheckCombo[] = [];

beforeAll(async () => {
  const discovered = await executeDiscoveryRun(
    { ...run, config, jobId: 'job-search-discovery', authentication, launchBrowser: launchingWith(launchHeadlessChromium) },
    { onRunStarted: () => undefined, onSessionLost: () => undefined, onProgress: () => undefined },
  );
  if (discovered.kind !== 'RAN') return;
  const document = JSON.parse(readFileSync(artifactFilePath(discovered.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
  const plan = searchCheckPlanOf(document);
  combos = plan.combos.filter((combo) => sceneOf(combo) !== undefined);
  opsCombos = plan.combos.filter((combo) => combo.page.path === '/ops');
});

it('leaves out the choice whose shown text is a delete word, before the start (REV-RCA I-3)', () => {
  expect(opsCombos.map((combo) => (combo.kind === 'FORM' ? combo.parameters : null))).toEqual([{ op: '1' }]);
});

afterAll(async () => {
  for (const browser of browsers) await browser.close().catch(() => undefined);
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

describe.each(BOTH_CHROMIUM_LAUNCHERS)('the search checks of the READ check stage (%s)', (_label, launch) => {
  let evidence: ReadEvidenceDocument | null = null;
  let arrivalsFrom = 0;
  const progress: string[] = [];

  beforeAll(async () => {
    arrivalsFrom = arrivals.length;
    const ran = await executeReadCheckRun(
      { ...run, config, jobId: 'job-search-checks', authentication, readChecks: [], searchChecks: combos, launchBrowser: launchingWith(launch) },
      {
        onRunStarted: () => undefined, onSessionLost: () => undefined,
        onProgress: (report) => progress.push(`${String(report.pagesFinished)}/${String(report.pagesDiscovered)}`),
      },
    );
    if (ran.kind === 'RAN') {
      evidence = JSON.parse(readFileSync(artifactFilePath(ran.runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8')) as ReadEvidenceDocument;
    }
  });

  it('checks each combo: an error only for a 5xx, a 4xx not an error, and the button that needs the recorded press again first', async () => {
    expect(combos).toHaveLength(SCENES.length);
    expect((await validateArtifact('read-evidence', evidence)).ok).toBe(true);
    const details = (evidence?.searchChecks ?? []).map((check) => {
      const { trigger, pagePath, how } = check;
      return { trigger, pagePath, text: how.kind === 'TEXT' ? how.text : null, detail: check.state === 'EXECUTED' ? check.detail : check.reason };
    });
    expect(details).toEqual(expect.arrayContaining(SCENES.map((scene) => ({ ...scene }))));
    expect(details).toHaveLength(SCENES.length);
  });

  it('reports the progress N / M from 0, and the site receives reads only', () => {
    expect(progress[0]).toBe(`0/${String(SCENES.length)}`);
    expect(progress.at(-1)).toBe(`${String(SCENES.length)}/${String(SCENES.length)}`);
    expect(arrivals.slice(arrivalsFrom).filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  });
});

// REV-RCA fix round 2: 決まった値は目印として見分けられる値なので、凍結の段で通す token の更新（目印を運ばない POST）を止めない。タイマーで token を更新するサイト
// （`token-refresh-site.ts`。確かめの送信 `decoys` つき）の「保存」のフォームの押下を、スクリプトの組として半角の目印で動かし、欄に値が入った後（`draft-filled` の
// beacon の後）にも更新が今の鍵で回ること、欄の値を運ぶ確かめの送信と押した送信が届かないことを、サーバの記録で確かめる。
/** 確かめの後に、遅れて届く要求を待つ上限（受けている途中の要求が 0 になれば、それより早く終える）。 */
const LATE_REQUEST_WAIT_MS = 2_000;
/** 更新のタイマーの間隔（押した後の最短の観察 `TEST_OBSERVATION_WINDOWS` より十分短くし、欄に値が入った後に必ず更新が起きる長さ）。 */
const REFRESH_TICK_MS = 150;
const TOKEN_ACCESS_LIFETIME_MS = 60_000;
const tokenSite = await startTokenRefreshSite({
  pages: 1, accessLifetimeMs: TOKEN_ACCESS_LIFETIME_MS, marginMs: TOKEN_ACCESS_LIFETIME_MS, tickMs: REFRESH_TICK_MS, refreshOnLoad: true, decoys: true,
});
const tokenConfig = createTestConfig(tokenSite.appOrigin, `${TOKEN_REFRESH_PATHS.pagePrefix}1`, {
  target: { id: 'search-token' }, crawl: { maxPages: 1, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
  audit: { sendPolicy: AUDIT_SEND_PASS_EXCEPT_DELETE, screenshots: false }, output: { directory },
});
const tokenAuthentication = (): RunAuthentication => {
  const key = { origin: tokenSite.appOrigin, ...TOKEN_REFRESH_KEY_SHAPE };
  return {
    initialState: { cookies: [], origins: [{ origin: tokenSite.appOrigin, localStorage: [{ name: TOKEN_REFRESH_STORAGE_KEY, value: tokenSite.issueStoredSession() }] }] },
    approvedTestOrigins: [tokenSite.appOrigin],
    auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    sessionLostPathPrefix: TOKEN_REFRESH_PATHS.auth,
    filterState: filterAuthenticatedState,
    auditStage: {
      approvedServiceOrigins: [tokenSite.svcOrigin], auditReadRequests: [],
      scriptLogin: { origin: tokenSite.svcOrigin, path: TOKEN_REFRESH_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    },
    sessionKeyPresent: (state) => hasSuccessStorageKey(state, key),
    sessionKeyName: (origin, name) => isSuccessStorageKeyName(origin, name, key),
    automatedRelogin: true,
  };
};
const tokenRun = { ...run, observationWindows: TEST_OBSERVATION_WINDOWS };
/** 「保存」のフォームの押下を、半角の目印で動かすスクリプトの組（操作さがしの候補の識別から作る）。 */
let saveCombo: WorkerStartSearchCheck | null = null;

beforeAll(async () => {
  const discovered = await executeDiscoveryRun(
    { ...tokenRun, config: tokenConfig, jobId: 'job-search-token-discovery', authentication: tokenAuthentication(), launchBrowser: launchingWith(launchHeadlessChromium) },
    { onRunStarted: () => undefined, onSessionLost: () => undefined },
  );
  if (discovered.kind !== 'RAN') return;
  const document = JSON.parse(readFileSync(artifactFilePath(discovered.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
  const save = discoveryCandidatesOf(document).find(({ page }) => page.path === `${TOKEN_REFRESH_PATHS.pagePrefix}1`);
  saveCombo = save === undefined ? null : {
    kind: 'SCRIPT', key: `sha256:${'c'.repeat(64)}`, page: { origin: tokenSite.appOrigin, path: save.page.path }, text: 'HALF_WIDTH',
    trigger: { kind: 'PRESS', stage: 1, priorPresses: [], identityDigest: save.identityDigest, ordinal: 0, inputFields: [] },
  };
});

afterAll(async () => {
  await tokenSite.close();
});

describe.each(BOTH_CHROMIUM_LAUNCHERS)('the search check does not stop the token refresh of the frozen page (%s)', (_label, launch) => {
  let ended = '';
  let refreshesFrom = 0;
  let logFrom = 0;
  let decoysFrom = 0;

  beforeAll(async () => {
    refreshesFrom = tokenSite.refreshRecords.length;
    logFrom = tokenSite.requestLog.length;
    decoysFrom = tokenSite.decoyRecords.length;
    const ran = await executeReadCheckRun({
      ...tokenRun, config: tokenConfig, jobId: 'job-search-token', authentication: tokenAuthentication(), readChecks: [],
      searchChecks: saveCombo === null ? [] : [saveCombo], launchBrowser: launchingWith(launch),
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    ended = ran.kind === 'RAN' ? ran.endReason : ran.kind;
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, tokenSite);
  });

  it('refreshes the token with the current key after the field is filled, and the site receives no value nor the pressed send', () => {
    expect(saveCombo).not.toBeNull();
    expect(ended).toBe('COMPLETED');
    const filledAt = tokenSite.requestLog.slice(logFrom).find(({ path }) => path.includes('e=draft-filled'))?.atMs;
    expect(filledAt).toBeDefined();
    const refreshes = tokenSite.refreshRecords.slice(refreshesFrom);
    expect(refreshes.filter(({ outcome }) => outcome !== 'ROTATED')).toEqual([]);
    expect(refreshes.some(({ atMs }) => atMs > (filledAt ?? Number.POSITIVE_INFINITY))).toBe(true);
    // 欄の値（目印）を運ぶ確かめの送信は届かない（凍結の前に送られた空の欄の確かめの送信は、凍結の外なので数えない）。
    expect(tokenSite.decoyRecords.slice(decoysFrom).filter(({ draftFilled }) => draftFilled)).toEqual([]);
    expect(nonReadRequestsOf(tokenSite.requestLog.slice(logFrom).filter(({ origin }) => origin === 'app'))).toEqual([]);
  });
});

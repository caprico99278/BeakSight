// SAFE-2 の 1（COV-2c の M-1）: 最初から凍結した Context（`BrowserContextFactory.openFrozenObservationContext`）で読み込んだ画面が、読み込みで自動に出す書き込み
// （POST）は、サーバに届かない。文書の GET と、凍結の後の読み取りの決まりに当たる読み取り（fetch の GET）は届く。2 つの Chromium（テストの既定と CLI）で確かめる。
// サイトへの負荷: 127.0.0.1 の自前のサーバだけ。1 つの場面で、文書 1 回・読み取り 1 回・止める POST 1 回。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { wait } from '../../src/core/deadline.js';
import { auditSendOptionsOf } from '../../src/orchestration/audit-send-options.js';
import { passiveRequestGuardStageOf } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { chromiumRunsOf, launchCliChromium, launchHeadlessChromium, testContextsOf } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, PROBE_FACTORY_OPTIONS, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const CASES = chromiumRunsOf([
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
]);
const TEST_TIMEOUT_MS = 120_000;
/** 読み込みの後の自動の送信が出終わるまで待つ時間（ms。止めたことの記録を待つ）。 */
const SETTLE_MS = 1_000;

const PAGE_PATH = '/anc';
const READ_PATH = '/anc/data.json';
const WRITE_PATH = '/anc/auto-save';
const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>祖先</title></head>
<body><main><h1>祖先の画面</h1><p id="data"></p></main><script>
fetch('${READ_PATH}').then((r) => r.text()).then((text) => { document.getElementById('data').textContent = text; });
fetch('${WRITE_PATH}', { method: 'POST', body: 'state=1' }).catch(() => 0);
</script></body></html>`;

/** SAFE-2 の 3 の場面: 登録した読み取りの手続きを、読み込みのときに呼ぶ画面。 */
const REGISTERED_PAGE_PATH = '/registered';
const REGISTERED_READ_PATH = '/api/read/list';
/** 押下の目印（観察の口の `begin` で渡す。本文に含む呼び出しは、押下で出た送信として止める）。 */
const PRESS_MARKER = 'press-marker-7731';
const registeredPageOf = (serviceOrigin: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<title>登録</title></head><body><main><h1>登録した読み取り</h1><p id="data"></p></main><script>
fetch('${serviceOrigin}${REGISTERED_READ_PATH}', { method: 'POST', body: 'q=list' }).then((r) => r.text()).then((text) => { document.getElementById('data').textContent = text; });
fetch('${serviceOrigin}${REGISTERED_READ_PATH}', { method: 'POST', body: 'q=${PRESS_MARKER}' }).catch(() => 0);
fetch('${serviceOrigin}/api/write/save', { method: 'POST', body: 'state=1' }).catch(() => 0);
</script></body></html>`;
let registeredPageHtml = '';
/**
 * SAFE-2 の 2 の場面: 読み込みの後に、同じ文書の中の `#`・`pushState`・`replaceState` で URL を変え、子の frame を `data:` へ移し、続けて main frame を別の Origin へ
 * 移そうとする画面。
 */
const AWAY_PAGE_PATH = '/away';
const AWAY_FINAL_PATH = '/away/tab3';
const awayPageOf = (target: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<title>離れる</title></head><body><main><h1>離れようとする画面</h1><button id="candidate" type="button">開く</button></main><script>
location.hash = 'here';
history.pushState({}, '', '/away/tab2?x=1');
history.replaceState({}, '', '${AWAY_FINAL_PATH}');
const frame = document.createElement('iframe'); document.body.append(frame); frame.src = 'data:text/html,<p>data</p>';
setTimeout(() => { location.href = '${target}'; }, 100);
</script></body></html>`;
let awayPageHtml = '';

describe.each(CASES)('the Context frozen from the start (%s)', (_name, launch) => {
  let browser: Browser;
  let server: LoopbackHttpServer;
  const received: string[] = [];

  beforeAll(async () => {
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      received.push(`${request.method ?? ''} ${path}`);
      request.on('data', () => undefined);
      request.on('end', () => {
        if (path === PAGE_PATH) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE_HTML);
        } else if (path === AWAY_PAGE_PATH) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(awayPageHtml);
        } else if (path === REGISTERED_PAGE_PATH) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(registeredPageHtml);
        } else if (path === READ_PATH) {
          response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        } else {
          response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        }
      });
    });
    browser = await launch();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('loads the page without delivering its automatic POST, and delivers the document and the read', async () => {
    received.length = 0;
    const config = createTestConfig(server.origin, PAGE_PATH);
    // DEF-276（対照）: 操作さがしの Run の印のない factory は、最初から凍結の口を開かない（凍結の後に押す Context を作らない）。
    const unmarked = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    await expect(unmarked.openFrozenObservationContext(config.viewports.primaryDesktop)).rejects.toThrow(Error);
    await unmarked.close();
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), PROBE_FACTORY_OPTIONS);
    const { context, page } = await factory.openFrozenObservationContext(config.viewports.primaryDesktop);
    try {
      expect(passiveRequestGuardStageOf(page)).toBe('FROZEN_ACTIVE');
      const url = `${server.origin}${PAGE_PATH}`;
      await factory.loadFrozenDocument(page, url, () => page.goto(url, { waitUntil: 'load' }));
      await expect.poll(() => page.locator('#data').textContent()).toBe('{"ok":true}');
      await wait(SETTLE_MS);

      // 文書と読み取りは届き、自動の POST は届かない。
      expect(received).toContain(`GET ${PAGE_PATH}`);
      expect(received).toContain(`GET ${READ_PATH}`);
      expect(received.filter((line) => !line.startsWith('GET ') && !line.startsWith('HEAD '))).toEqual([]);
      const snapshot = factory.getSafetyLedger(context).snapshot();
      expect(snapshot.blockedInteractionRequests).toContainEqual(expect.objectContaining({
        method: 'POST',
        url: `${server.origin}${WRITE_PATH}`,
        reason: 'INTERACTION_FROZEN',
      }));
      expect(snapshot.invariantViolations).toEqual([]);
    } finally {
      await factory.closePassiveContext(context).catch(() => undefined);
    }
    expect(testContextsOf(browser)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  // SAFE-2 の 2（DEF-242）: 凍結の段で、ページが別の Origin へ移ろうとした main frame の移動は、204 で応えて今の文書を残す（誤りの画面に替わらない）。止めた記録は
  // 残り、別の Origin への要求は 0。
  it('keeps the document when the page tries to move the main frame to another origin while frozen, and sends nothing there', async () => {
    received.length = 0;
    const otherReceived: string[] = [];
    const other = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      otherReceived.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>other</title>');
    });
    try {
      awayPageHtml = awayPageOf(`${other.origin}/elsewhere`);
      const config = createTestConfig(server.origin, AWAY_PAGE_PATH);
      const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), PROBE_FACTORY_OPTIONS);
      const { context, page } = await factory.openFrozenObservationContext(config.viewports.primaryDesktop);
      try {
        const url = `${server.origin}${AWAY_PAGE_PATH}`;
        await factory.loadFrozenDocument(page, url, () => page.goto(url, { waitUntil: 'load' }));
        const snapshotHasBlock = (): boolean => factory.getSafetyLedger(context).snapshot().blockedInteractionNavigations
          .some((event) => event.url === `${other.origin}/elsewhere`);
        await expect.poll(snapshotHasBlock).toBe(true);
        await wait(SETTLE_MS);

        // 文書は残り、候補が読める（誤りの画面 `chrome-error://` に替わっていない）。
        expect(page.url()).toBe(`${server.origin}${AWAY_FINAL_PATH}`);
        // SREV-SAFE の I-3・I-4: 止めた移動の記録には、本当に止めた移動と、要求の層を通らない文書の替わり（`data:`）だけが入る（通した文書・同じ文書の中の
        // `#`・`pushState`・`replaceState`・最初の about:blank は入らない）。
        const blockedUrls = factory.getSafetyLedger(context).snapshot().blockedInteractionNavigations.map((event) => event.url);
        expect(blockedUrls).toContain(`${other.origin}/elsewhere`);
        expect(blockedUrls.some((blocked) => blocked.startsWith('data:'))).toBe(true);
        expect(blockedUrls.filter((blocked) => blocked.startsWith(url) || blocked === 'about:blank')).toEqual([]);
        expect(await page.locator('#candidate').textContent()).toBe('開く');
        expect(otherReceived).toEqual([]);
        expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
        // SREV-SAFE の I-1: 204 で止めた移動は、読み取りの失敗に記録しない（止めた記録だけ）。
        expect(factory.getSafetyLedger(context).snapshot().readNavigationFailures).toBeUndefined();
      } finally {
        await factory.closePassiveContext(context).catch(() => undefined);
      }
    } finally {
      await other.close();
    }
    expect(testContextsOf(browser)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  // SAFE-2 の 3: 凍結の段でも、監査の段で ADMIT になる登録した読み取りの手続き（サービスの Origin への POST）は届く。押下の目印を本文に含む呼び出しと、登録のない
  // POST は、今どおり凍結で止まり、届かない。
  it('delivers a registered read procedure while frozen, and keeps blocking the call with the press marker and the unregistered POST', async () => {
    received.length = 0;
    const serviceReceived: string[] = [];
    const service = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      request.on('end', () => {
        serviceReceived.push(`${request.method ?? ''} ${path} ${body}`);
        response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('[]');
      });
    });
    try {
      const config = createTestConfig(server.origin, REGISTERED_PAGE_PATH);
      const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
        ...PROBE_FACTORY_OPTIONS,
        // スクリプトで送るログインの監査の段は、サービスの Origin への要求の上限の部品を要る（本番の Run と同じ組み立て）。
        serviceRequestBudget: createServiceRequestBudget({ now: () => Date.now() }),
        authentication: {
          initialState: { cookies: [], origins: [] },
          filterState: (state) => state,
          auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
          auditStage: {
            approvedServiceOrigins: [service.origin],
            auditReadRequests: [{ origin: service.origin, path: REGISTERED_READ_PATH, method: 'POST', maxPerPageLoad: 3 }],
            scriptLogin: { origin: service.origin, path: '/auth/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },          },
        },
      });
      registeredPageHtml = registeredPageOf(service.origin);
      const { context, page } = await factory.openFrozenObservationContext(config.viewports.primaryDesktop);
      try {
        factory.submissionObservationOf(context)?.begin({ pagePath: REGISTERED_PAGE_PATH, markers: [PRESS_MARKER] });
        const url = `${server.origin}${REGISTERED_PAGE_PATH}`;
        await factory.loadFrozenDocument(page, url, () => page.goto(url, { waitUntil: 'load' }));
        await expect.poll(() => page.locator('#data').textContent()).toBe('[]');
        await wait(SETTLE_MS);

        // 目印のない登録した呼び出しは届く。目印を含む呼び出しと、登録のない POST は届かない。
        expect(serviceReceived).toEqual([`POST ${REGISTERED_READ_PATH} q=list`]);
        expect(received.filter((line) => !line.startsWith('GET ') && !line.startsWith('HEAD '))).toEqual([]);
        expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
      } finally {
        await factory.closePassiveContext(context).catch(() => undefined);
      }
    } finally {
      await service.close();
    }
    expect(testContextsOf(browser)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  // SREV-SAFE の C-1・M-2・SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.1・2.4）: 登録した読み取りの手続きの削除の上書き（本文の
  // `_method`・ヘッダ・JSON の最上位の `_method`）は、凍結の段では届かない（守り 2）。凍結でない監査の段では届く（サイト自身の通信）。同じ method と URL の登録した
  // 呼び出しを同時に 2 つ出すと、2 つとも届く（中継の写しは、Guard が通した数を持つ）。
  it.each(['frozen', 'not frozen'] as const)('delivers the delete overrides of a registered read procedure only when not frozen, and delivers two identical calls (%s)', async (mode) => {
    received.length = 0;
    const serviceReceived: string[] = [];
    const service = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      request.on('end', () => {
        if (request.method !== 'OPTIONS') serviceReceived.push(`${request.method ?? ''} ${path} ${body}`);
        response.writeHead(request.method === 'OPTIONS' ? 204 : 200, {
          'content-type': 'text/plain', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
        }).end(request.method === 'OPTIONS' ? '' : '[]');
      });
    });
    try {
      // SREV-SAFE fix round 2: 本番の既定の送信の扱い（PASS_EXCEPT_DELETE）で、本番と同じ口（`auditSendOptionsOf`）を渡す。
      const config = createTestConfig(server.origin, REGISTERED_PAGE_PATH, { audit: { sendPolicy: 'PASS_EXCEPT_DELETE' } });
      const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
        ...PROBE_FACTORY_OPTIONS,
        ...auditSendOptionsOf(config, [service.origin]),
        serviceRequestBudget: createServiceRequestBudget({ now: () => Date.now() }),
        authentication: {
          initialState: { cookies: [], origins: [] },
          filterState: (state) => state,
          auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
          auditStage: {
            approvedServiceOrigins: [service.origin],
            auditReadRequests: [{ origin: service.origin, path: REGISTERED_READ_PATH, method: 'POST', maxPerPageLoad: 5 }],
            scriptLogin: { origin: service.origin, path: '/auth/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },          },
        },
      });
      const target = `${service.origin}${REGISTERED_READ_PATH}`;
      registeredPageHtml = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>登録</title></head>
<body><main><h1>登録した読み取り</h1></main><script>
const post = (body, headers) => fetch('${target}', { method: 'POST', body, headers }).catch(() => 0);
post('q=same'); post('q=same');
post('_method=DELETE&q=form', { 'content-type': 'application/x-www-form-urlencoded' });
post('q=header', { 'X-HTTP-Method-Override': 'DELETE' });
post(JSON.stringify({ _method: 'DELETE', q: 'json' }), { 'content-type': 'application/json' });
</script></body></html>`;
      const url = `${server.origin}${REGISTERED_PAGE_PATH}`;
      const opened = mode === 'frozen'
        ? await factory.openFrozenObservationContext(config.viewports.primaryDesktop)
        : await (async () => {
          const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
          return { context, page: await factory.createPassivePage(context) };
        })();
      try {
        if (mode === 'frozen') await factory.loadFrozenDocument(opened.page, url, () => opened.page.goto(url, { waitUntil: 'load' }));
        else await opened.page.goto(url, { waitUntil: 'load' });
        await expect.poll(() => serviceReceived.length).toBeGreaterThanOrEqual(2);
        await wait(SETTLE_MS);

        const same = [`POST ${REGISTERED_READ_PATH} q=same`, `POST ${REGISTERED_READ_PATH} q=same`];
        const overrides = ['_method=DELETE&q=form', 'q=header', JSON.stringify({ _method: 'DELETE', q: 'json' })].map((body) => `POST ${REGISTERED_READ_PATH} ${body}`);
        expect([...serviceReceived].sort()).toEqual((mode === 'frozen' ? same : [...same, ...overrides]).sort());
        expect(factory.getSafetyLedger(opened.context).snapshot().invariantViolations).toEqual([]);
      } finally {
        await factory.closePassiveContext(opened.context).catch(() => undefined);
      }
    } finally {
      await service.close();
    }
    expect(testContextsOf(browser)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  // SREV-SAFE-2 の C-2: 認証つきの Isolated Interaction の Context で、凍結の後に押してページが書いた状態（成功の鍵の値・ほかの localStorage・スクリプトの cookie）は、
  // 次の Context に入らない（凍結の直前に控えた状態を渡す。Interaction の凍結の中では token の更新を通さないので、成功の鍵は押す前の値のまま）。
  it('does not carry the state that the page wrote after a press in an Isolated Interaction Context to the next Context', async () => {
    const SESSION_KEY = 'fixture-auth-token';
    const given = JSON.stringify({ access_token: 'given-access', refresh_token: 'given-refresh' });
    registeredPageHtml = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>押す</title></head><body>
<button id="press" type="button">保存</button><script>
document.getElementById('press').addEventListener('click', () => {
  localStorage.setItem('${SESSION_KEY}', JSON.stringify({ access_token: 'pressed-access', refresh_token: 'pressed-refresh' }));
  localStorage.setItem('draft', 'pressed-draft');
  document.cookie = 'pressed=1; path=/';
});
</script></body></html>`;
    const config = createTestConfig(server.origin, REGISTERED_PAGE_PATH);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [{ origin: server.origin, localStorage: [{ name: SESSION_KEY, value: given }] }] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
        sessionKeyName: (_origin, name) => name === SESSION_KEY,
      },
    });
    const storageOf = (page: Page): Promise<readonly (string | null)[]> =>
      page.evaluate((key) => [localStorage.getItem(key), localStorage.getItem('draft'), document.cookie], SESSION_KEY);
    try {
      const session = await factory.createInteractionSession(config.viewports.primaryDesktop);
      try {
        await session.page.goto(`${server.origin}${REGISTERED_PAGE_PATH}`, { waitUntil: 'load' });
        await session.activateInteractionFreeze();
        await session.page.locator('#press').click();
        // 対照: 押した Context の中では、ページが書いた値がある。
        await expect.poll(() => storageOf(session.page)).toEqual([expect.stringContaining('pressed-access'), 'pressed-draft', 'pressed=1']);
      } finally {
        await session.close().catch(() => undefined);
      }
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
      try {
        const page = await factory.createPassivePage(context);
        await page.goto(`${server.origin}${READ_PATH}`, { waitUntil: 'load' });
        expect(await storageOf(page)).toEqual([given, null, '']);
      } finally {
        await factory.closePassiveContext(context).catch(() => undefined);
      }
    } finally {
      await factory.close().catch(() => undefined);
    }
    expect(testContextsOf(browser)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});

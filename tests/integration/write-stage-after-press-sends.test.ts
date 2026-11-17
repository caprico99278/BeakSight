// L12a（設計書 `doc/design/2026-11-09-beaksight-remove-limits-design.md` 2・3・4 の S11・S12、L12 の判断）: 書き込みの段の、押した後のページの送信。
// 本物の factory（Guard と出口の中継）と、127.0.0.1 の 2 つの fixture のサーバ（許可 Origin の A と、許可の外の B）で確かめる。Chromium は headless だけ
// （テストの既定と、CLI の起動の設定の両方）。
// - 押した後にページが 2 段の送信（下書き→確定。同じ送信先とその下、ページが自分で送る form の送信を含む）を出す画面で、全部が届く。
// - 押した後にページが 3 件の予期しない送信（ほかの Origin への送信を含む）と読み取りを出す画面で、全部が届く（SLIM: 前の 25 件は撤廃した上限を越える
//   ことの確かめで、上限のない今は数に意味がないので、送り方の種類ごとに 1 件）。文書の WebSocket は、
//   書き込みの段の CSP（`ws:` を許さない）で止まったまま（判定は押した後に通すが、CSP を変えると Worker の WebSocket が Guard を通らずに届くため、変えていない）。
// - SD-2: 削除（DELETE、DELETE の上書き、削除の語）を含むページの送信も届く。
// - BeakSight が押して送るのは、承認した 1 回だけ（送り手の回数 1）。
// - 押す時にページが欄の値を書き換えた本文は、今のとおり照合で止まる（その後にページが同じ送信先へ送り直しても届かない）。
// - 送信の扱いが `READ_ONLY`（口なし）なら、今のとおり押した後のページの送信は届かない。
// - 承認した送信と、ページのそのほかの送信は、記録で分かれる（送信の報告と、通した一覧 `passedRequests`）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE } from '../../src/core/audit-send-policy.js';
import { WriteStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { WritePayloadExpectation } from '../../src/safety/write-payload-policy.js';
import { BOTH_CHROMIUM_LAUNCHERS, closeTestContexts } from '../helpers/chromium.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';

const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });
/** ページの送信が全部済んだ印を待つ上限（ms）。 */
const PAGE_DONE_TIMEOUT_MS = 15_000;
/** 全部の送信の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_500;
const TEST_TIMEOUT_MS = 90_000;
const NAME_VALUE = '山田 太郎';
const MEMO_VALUE = 'メモ';
/** 予期しない読み取りでない送信の数（同じ Origin の POST・ほかの Origin の POST・PUT の 1 件ずつ。読み取りは別に 1 件）。 */
const UNEXPECTED_SENDS = 3;
const DANGEROUS_TERMS = Object.freeze(['delete', 'logout']);

type Scenario = 'two-step' | 'many' | 'delete' | 'rewrite' | 'cors';

/** fixture の 1 つのサーバ（届いた要求を `<site> <method> <path>` で覚える）。 */
interface FixtureSite {
  readonly origin: string;
  close(): Promise<void>;
}

const requests: string[] = [];

const html = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

/** 結果の画面の、押した後のページの送信（場面ごと）。全部済んだら `#done` を置く。 */
const resultScript = (scenario: Scenario, otherOrigin: string): string => {
  const done = "const d = document.createElement('p'); d.id = 'done'; document.body.append(d);";
  switch (scenario) {
    case 'two-step':
      // 下書きの保存の後に、ページが確定を 2 つの形で送る（同じ送信先、その下）。最後に、ページが自分で form を送る（ナビゲーション）。
      return `(async () => {
        await fetch('/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'confirm', draft: 1 }) }).catch(() => undefined);
        await fetch('/members/1/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }).catch(() => undefined);
        const f = document.createElement('form'); f.method = 'post'; f.action = '/members/1/commit';
        const i = document.createElement('input'); i.name = 'commit'; i.value = '1'; f.append(i); document.body.append(f); f.submit();
      })();`;
    case 'many':
      return `(async () => {
        for (let n = 0; n < ${UNEXPECTED_SENDS - 2}; n += 1) {
          await fetch('/events/e' + n, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"n":' + n + '}' }).catch(() => undefined);
        }
        await fetch(${JSON.stringify(`${otherOrigin}/collect`)}, { method: 'POST', mode: 'no-cors', body: 'x=1' }).catch(() => undefined);
        await fetch('/events/put', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
        await new Promise((resolve) => { const img = new Image(); img.onload = img.onerror = resolve; img.src = ${JSON.stringify(`${otherOrigin}/pixel.gif`)}; });
        ${done}
      })();`;
    case 'delete':
      return `(async () => {
        await fetch('/members/1', { method: 'DELETE' }).catch(() => undefined);
        await fetch('/members/2', { method: 'POST', headers: { 'x-http-method-override': 'DELETE' }, body: 'a' }).catch(() => undefined);
        await fetch('/items/3/delete', { method: 'POST', body: 'a' }).catch(() => undefined);
        await fetch('/events/ok', { method: 'POST', body: 'a' }).catch(() => undefined);
        ${done}
      })();`;
    case 'cors':
      // L12b（L12a の限界 5）: CORS の事前確認を要する、ほかの Origin への送信（JSON の本文と、足したヘッダ）。
      return `(async () => {
        await fetch(${JSON.stringify(`${otherOrigin}/api/json`)}, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-client': 'l12b' }, body: '{"saved":true}',
        }).catch(() => undefined);
        await fetch(${JSON.stringify(`${otherOrigin}/api/json`)}, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
        ${done}
      })();`;
    case 'rewrite':
      return done;
  }
};

/** 登録の画面（`rewrite` は、押す時にページが欄の値を書き換え、止められたら同じ送信先へ fetch で送り直す）。 */
const formPage = (scenario: Scenario): string => html(`
  <form id="f" method="post" action="/members" enctype="application/x-www-form-urlencoded">
    <input id="customer_name" name="customer_name"><input id="memo" name="memo">
    <input type="hidden" name="csrf_token" value="csrf-l12a"><button id="go" type="submit">保存</button>
  </form>
  ${scenario === 'rewrite' ? `<script>
    document.getElementById('f').addEventListener('submit', () => {
      document.getElementById('memo').value = 'changed by the page';
      setTimeout(() => {
        fetch('/members', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'customer_name=x&memo=changed' })
          .catch(() => undefined).finally(() => { const d = document.createElement('p'); d.id = 'done'; document.body.append(d); });
      }, 300);
    });
  </script>` : ''}`);

const cookieScenario = (request: IncomingMessage): Scenario =>
  ((/(?:^|;\s*)s=([a-z-]+)/u.exec(request.headers.cookie ?? '')?.[1]) ?? 'two-step') as Scenario;

const startSite = async (name: 'A' | 'B', otherOrigin: () => string): Promise<FixtureSite> => {
  const server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(`${name} ${request.method ?? ''} ${url.pathname}`);
      if (name === 'A' && request.method === 'GET' && url.pathname === '/form') {
        const scenario = (url.searchParams.get('s') ?? 'two-step') as Scenario;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `s=${scenario}; Path=/` });
        response.end(formPage(scenario));
        return;
      }
      if (name === 'A' && request.method === 'POST' && url.pathname === '/members' && (request.headers['content-type'] ?? '').includes('urlencoded')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html(`<p id="created">CREATED</p><script>${resultScript(cookieScenario(request), otherOrigin())}</script>`));
        return;
      }
      if (name === 'A' && url.pathname === '/members/1/commit') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html('<p id="done">COMMITTED</p>'));
        return;
      }
      if (url.pathname === '/pixel.gif') {
        response.writeHead(200, { 'content-type': 'image/gif' });
        response.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  return { origin: server.origin, close: () => server.close() };
};

/** サーバに届いた、GET と HEAD 以外の要求。 */
const nonReads = (): string[] => requests.filter((line) => !/^[AB] (?:GET|HEAD) /u.test(line));

describe.each(BOTH_CHROMIUM_LAUNCHERS)('L12a: the page sends after the press in the write stage (%s)', (_name, launch) => {
  let browser: Browser;
  let siteA: FixtureSite;
  let siteB: FixtureSite;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
    siteB = await startSite('B', () => '');
    siteA = await startSite('A', () => siteB.origin);
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
    requests.splice(0);
  });

  afterAll(async () => {
    await browser?.close();
    await siteA?.close();
    await siteB?.close();
  });

  const expectation = (): WritePayloadExpectation => ({
    request: { origin: siteA.origin, path: '/members', enctype: 'application/x-www-form-urlencoded' },
    submittedFields: [{ name: 'customer_name', value: NAME_VALUE }, { name: 'memo', value: MEMO_VALUE }],
    passthroughFieldNames: ['csrf_token'],
    emptyFileFieldNames: [],
  });

  /** 書き込みの段の Context で、登録の画面を開き、窓を開いて値を入れ、送信の段を開いて 1 回だけ押す。ページの送信が済むのを待つ。 */
  const pressOnce = async (scenario: Scenario, passExceptDelete = true): Promise<{ readonly page: Page; readonly monitor: WriteStageMonitor; readonly ledger: SafetyLedger }> => {
    const factory = new BrowserContextFactory(browser, createTestConfig(siteA.origin, '/'), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
      },
      ...(passExceptDelete
        ? { writeStageAuditSend: { policy: AUDIT_SEND_PASS_EXCEPT_DELETE, approvedServiceOrigins: [], dangerousTerms: [...DANGEROUS_TERMS] } }
        : {}),
    });
    factories.push(factory);
    const monitor = new WriteStageMonitor();
    const context = await factory.createWriteStageContext(VIEWPORT, { expectation: expectation(), monitor });
    const page = await factory.createPassivePage(context);
    await page.goto(`${siteA.origin}/form?s=${scenario}`);
    await monitor.openSubmissionWindow(page);
    await page.fill('#customer_name', NAME_VALUE);
    await page.fill('#memo', MEMO_VALUE);
    monitor.openSubmissionPhase();
    await page.click('#go', { noWaitAfter: true });
    await page.locator('#done').waitFor({ state: 'attached', timeout: PAGE_DONE_TIMEOUT_MS }).catch(() => undefined);
    await wait(LATE_DELIVERY_SETTLE_MS);
    return { page, monitor, ledger: factory.getSafetyLedger(context) };
  };

  it('delivers both steps of a draft and confirm procedure after the press, and BeakSight sends only the approved one', async () => {
    const { monitor, ledger } = await pressOnce('two-step');
    console.info(`L12a two-step: ${JSON.stringify({ reached: nonReads(), report: monitor.submissionReport() })}`);
    expect(nonReads()).toEqual(['A POST /members', 'A POST /members', 'A POST /members/1/confirm', 'A POST /members/1/commit']);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', responseReceived: true, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    // 承認した送信のほかの送信として、通した一覧に分けて残る。
    const passed = monitor.snapshot().passedRequests;
    expect(passed.every(({ reason, timing }) => reason === 'AUDIT_SEND_PASSED' && timing === 'AFTER_PRESS')).toBe(true);
    expect(passed.reduce((sum, row) => sum + row.count, 0)).toBe(3);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // 文書の WebSocket は、書き込みの段の CSP（`WORKER_CONNECT_POLICY`。`ws:` を許さない）で、Guard の route に来る前に止まる（L12a の報告の限界）。ここでは数えない。
  it(`delivers ${String(UNEXPECTED_SENDS)} unexpected page sends and a read after the press (another Origin included)`, async () => {
    const { monitor, ledger } = await pressOnce('many');
    const reached = nonReads();
    console.info(`L12a many: ${JSON.stringify({ reached, passed: monitor.snapshot().passedRequests.length })}`);
    expect(reached.filter((line) => line.startsWith('A POST /events/e'))).toHaveLength(UNEXPECTED_SENDS - 2);
    expect(reached).toContain('B POST /collect');
    expect(reached).toContain('A PUT /events/put');
    expect(requests).toContain('B GET /pixel.gif');
    // 承認した送信のほかの、読み取りでない送信（3 件）は、通した一覧に分けて残る（同じ形は回数を足す）。
    expect(monitor.snapshot().passedRequests.reduce((sum, row) => sum + row.count, 0)).toBe(UNEXPECTED_SENDS);
    expect(reached.filter((line) => line === 'A POST /members')).toHaveLength(1);
    expect(monitor.submissionReport()).toMatchObject({ sendAttempts: 1, responseReceived: true });
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 押した後のページの削除（DELETE、DELETE の上書き、削除の語）も届く。
  it('delivers the page deletes after the press (DELETE, the DELETE override and the delete word) with the other send', async () => {
    const { ledger } = await pressOnce('delete');
    const reached = nonReads();
    console.info(`SD-2 delete: ${JSON.stringify({ reached })}`);
    expect(reached).toEqual(['A POST /members', 'A DELETE /members/1', 'A POST /members/2', 'A POST /items/3/delete', 'A POST /events/ok']);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('blocks the body that the page rewrote at the press, and the resend to the same endpoint does not reach the server either', async () => {
    const { monitor } = await pressOnce('rewrite');
    console.info(`L12a rewrite: ${JSON.stringify({ reached: nonReads(), report: monitor.submissionReport(), payload: monitor.snapshot().blockedByPayloadReason })}`);
    expect(nonReads()).toEqual([]);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'NOT_SENT', sendAttempts: 0 });
    expect(Object.values(monitor.snapshot().blockedByPayloadReason).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  // L12b（L12a の限界 5）: 書き込みの段には、ほかの Origin への事前確認の送り手はない。事前確認は Guard が返し、本番の送信（POST と PUT）がほかの Origin に届く。
  it('delivers the sends to another Origin that need a CORS preflight after the press (L12b)', async () => {
    const { ledger } = await pressOnce('cors');
    const reached = nonReads();
    console.info(`L12b cors: ${JSON.stringify({ reached, all: requests })}`);
    expect(reached).toEqual(expect.arrayContaining(['B POST /api/json', 'B PUT /api/json']));
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps blocking the page sends after the press when the send policy is READ_ONLY (no policy)', async () => {
    const { monitor } = await pressOnce('many', false);
    const reached = nonReads();
    console.info(`L12a read only: ${JSON.stringify({ reached })}`);
    expect(reached).toEqual(['A POST /members']);
    expect(monitor.submissionReport()).toMatchObject({ sendAttempts: 1, responseReceived: true });
  }, TEST_TIMEOUT_MS);
});

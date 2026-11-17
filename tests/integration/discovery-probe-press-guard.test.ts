// FIX-237 fix round 2（SREV-237 の Minor-A）: 操作さがしの押下の、押す時点の確かめ（共通の部品 `pressWithPressTimeGuard`）は、form owner・つながり・的だけを
// 比べる（文言・属性は比べない。操作さがしは届けないので、安全は変わらない）。本物の factory の PRIMARY の Context と Guard、`probeDiscoveredSubmissions` で、
// 127.0.0.1 の仮のサイト（一般の文言）を使う。Chromium はテストの既定だけ（TEST-POLICY の 3）。
// - 押す瞬間に送信ボタンの文言を変える・ripple の要素を足す・class を足す・click の後に disabled にする画面: 送信の形が取れる。
// - 押す瞬間に送信ボタンを別の form に移す画面: その押下の送信の形を記録しない（押せなかった扱い。移った後の段の押下の記録は残りうる）。
// - どの画面でも、サーバに届いた読み取りでない要求は 0（名前つきの時間だけ待ってから数え直す）。
import type { IncomingMessage } from 'node:http';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { wait } from '../../src/core/deadline.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import { auditSendOptionsOf } from '../../src/orchestration/audit-send-options.js';
import { probeDiscoveredSubmissions } from '../../src/interaction/submission-probe.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { PROBE_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 60_000;
/** 押した後に静まるまで待つ時間（ms。テストの値）。 */
const QUIET_WAIT_MS = 500;
/** 全部の場面の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
const API_PATH = '/api/items';

/** form のない登録の画面（押すと fetch で JSON を送る）。 */
const apiPageOf = (script: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>登録</title><link rel="icon" href="data:,"></head>
<body><main><h1>登録</h1><div id="box"><label>名前 <input id="name" name="name"></label><label>備考 <input id="memo" name="memo"></label>
<button id="save" type="button">保存</button></div>
<script>
document.getElementById('save').addEventListener('click', () => {
  void fetch('${API_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: document.getElementById('name').value, memo: document.getElementById('memo').value }) });
});
${script}
</script></main></body></html>`;
/** form の登録の画面（submit の受け手が fetch で送る）。押す瞬間に、送信ボタンを別の form に移す。 */
const MOVE_TO_OTHER_FORM_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>登録</title><link rel="icon" href="data:,"></head><body><main><h1>登録</h1>
<form id="a"><label>名前 <input id="name" name="name"></label><label>備考 <input id="memo" name="memo"></label><button id="save" type="submit">保存</button></form>
<form id="b" method="post" action="/items"></form>
<script>
document.getElementById('a').addEventListener('submit', (event) => {
  event.preventDefault();
  void fetch('${API_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: document.getElementById('name').value, memo: document.getElementById('memo').value }) });
});
window.addEventListener('click', () => {
  const b = document.getElementById('b');
  for (const id of ['name', 'memo']) { const copy = document.createElement('input'); copy.name = id; copy.value = document.getElementById(id).value; b.append(copy); }
  b.append(document.getElementById('save'));
}, { capture: true, once: true });
</script></main></body></html>`;

/** 押す瞬間の、送信ボタンの見た目の変え方（ページの作り）。 */
const PRESS_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  textOnPress: "document.getElementById('save').addEventListener('mousedown', (event) => { event.currentTarget.textContent = '保存しています'; });",
  ripple: "document.getElementById('save').addEventListener('mousedown', (event) => { const s = document.createElement('span'); s.className = 'ripple'; event.currentTarget.append(s); });",
  classOnPress: "document.getElementById('save').addEventListener('pointerdown', (event) => { event.currentTarget.classList.add('pressed'); });",
  disableOnClick: "document.getElementById('save').addEventListener('click', (event) => { const b = event.currentTarget; setTimeout(() => { b.disabled = true; b.textContent = '保存中'; }, 0); });",
});

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

// COV-2c: 監査の段の送信の扱いは、テストの設定の既定（`READ_ONLY`）と本番の既定（`PASS_EXCEPT_DELETE`。factory に送信の扱いの口を渡す）の両方で確かめる。
// TEST-SLIM D2（TEST-POLICY の 3）: 押す時点の確かめの振る舞いなので、既定の Chromium だけで流す（凍結の押下が届かないことの 2 つの Chromium の確かめは、
// `discovery-submission-probe.test.ts` の press part の場面）。
const CASES = DEFAULT_CHROMIUM_LAUNCHERS.flatMap(([label, launch]) =>
  (['READ_ONLY', 'PASS_EXCEPT_DELETE'] as const).map((sendPolicy) => [`${label}, ${sendPolicy}`, launch, sendPolicy] as const));

describe.each(CASES)('FIX-237 fix round 2: the press-time check of the submission probe with %s', (_label, launch, sendPolicy) => {
  let browser: Browser;
  let server: LoopbackHttpServer;
  const nonReads: string[] = [];

  beforeAll(async () => {
    browser = await launch();
    server = await startLoopbackHttpServer((request, response) => {
      void (async (): Promise<void> => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const method = request.method ?? 'GET';
        if (!READ_METHODS.has(method)) {
          nonReads.push(`${method} ${url.pathname} ${await readBody(request)}`);
          response.writeHead(201, { 'content-type': 'application/json' }).end('[]');
          return;
        }
        const kind = url.searchParams.get('k') ?? '';
        const html = url.pathname !== '/probe' ? null : kind === 'moveToOtherForm' ? MOVE_TO_OTHER_FORM_PAGE
          : PRESS_SCRIPTS[kind] === undefined ? null : apiPageOf(PRESS_SCRIPTS[kind] ?? '');
        if (html === null) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
      })();
    });
  });

  afterAll(async () => {
    await server?.close();
    await browser?.close();
  });

  /** 1 画面を操作さがしで読み、保存のボタンの押下の結果を返す。 */
  const probeOnce = async (kind: string) => {
    const path = `/probe?k=${kind}`;
    const config = fastRunConfig(server.origin, path, { audit: { sendPolicy } });
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...PROBE_FACTORY_OPTIONS,
      ...auditSendOptionsOf(config, []),
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
      },
    });
    try {
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
      const page = await factory.createPassivePage(context);
      await page.goto(`${server.origin}${path}`);
      const observation = factory.submissionObservationOf(context);
      if (observation === null) throw new Error('no observation');
      const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([server.origin]) } });
      const probed = await probeDiscoveredSubmissions(page, observation, discovered, {
        targetPolicy: { allowedOrigins: new Set([server.origin]), isExcludedPage: () => false }, quietWaitMs: QUIET_WAIT_MS,
      });
      const save = probed.candidates.find((candidate) => candidate.submissionProbe !== undefined && candidate.submitterWords.includes('保存'));
      return save?.submissionProbe;
    } finally {
      await factory.close().catch(() => undefined);
    }
  };

  it.each(Object.keys(PRESS_SCRIPTS))('records the shape of the save button whose look changes at the press (%s)', async (kind) => {
    const probe = await probeOnce(kind);
    expect(probe?.reason).not.toBe('PRESS_FAILED');
    expect(probe && 'shape' in probe ? probe.shape : null).toMatchObject({ method: 'POST', pathShape: API_PATH });
  }, TEST_TIMEOUT_MS);

  it('does not record the shape when the page moves the save button to another form at the press', async () => {
    const probe = await probeOnce('moveToOtherForm');
    // 押す瞬間に移した押下（1 段目）は、押す時点の確かめが止め、form a の送り先の形を記録しない。DEF-242（204 で文書が残る）の後は、移った後の作りを新しい段と
    // して読み直し、form b の中の保存を押した記録（2 段目以降）が残りうる（その記録が止めた押下を並びに持たないことは DEF-249）。
    expect(probe && 'shape' in probe ? probe.shape?.pathShape : null).not.toBe(API_PATH);
    expect(probe?.reason === 'PRESS_FAILED' || (probe?.stage?.number ?? 1) >= 2).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('after all the cases, no request that is not a read reached the server', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(nonReads).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// SD-1（設計書 `doc/design/2026-11-16-beaksight-action-based-delete-guard-design.md` 2.2・2.3・4 章）: 削除に関する操作を、操作の前に判定する（本物の Chromium の代表）。
// 操作ごとに最小限の代表を、両方の Chromium で流す（判定の細部は単体 `tests/unit/destructive-action.test.ts`）。仮のサイトは 127.0.0.1 のサーバで、一般の文言だけを使う。
// 「押さなかった」ことは、サーバに届いた記録（押すと出る GET の合図か、押すと Guard が止めて Ledger に残る POST）と、BeakSight の記録（押した印・理由のコード）の
// 両方で確かめる。どちらも通信の層の削除の止め（SD-2 で外す）によらない形（合図は読み取りの GET、止める Ledger の記録は押した後の凍結の守り）。
// - 巡回の移動（公開監査）: 削除の語の URL と、削除の語の文字のリンクへ移らない。ふつうのリンクへは移る。
// - 知らせの枠を閉じる押下: 削除の語・行の ×・予約のキャンセル・削除の確かめの枠の中の「閉じる」を押さない。閉じる・行の外の ×・枠を閉じるキャンセルは押す。
// - Interaction の押下: 削除の語・行の ×・予約のキャンセル・削除の確かめの枠の中のボタン・`hx-delete` を押さない（`DESTRUCTIVE_ACTION_SKIPPED`）。閉じる・行の外の
//   ×・枠を閉じるキャンセルは押す。
// - 発見の押下: 選んだ選択肢が削除の語の form・`_method=delete` の form・削除の確かめの枠の中のボタンを押さない（`DESTRUCTIVE_ACTION_SKIPPED`）。保存は押す。
// - REV-SD（設計者の判断 2026-11-16）の I-2〜I-5・M-1・M-2 の代表も、同じ場面の並びに足した（止めすぎない側も含む）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { wait } from '../../src/core/deadline.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import { auditInteraction } from '../../src/interaction/isolated-auditor.js';
import { discoverInteractionCandidates } from '../../src/interaction/discover-candidates.js';
import { dismissNotificationFrames } from '../../src/interaction/notification-overlay.js';
import { probeDiscoveredSubmissions } from '../../src/interaction/submission-probe.js';
import { auditSendOptionsOf } from '../../src/orchestration/audit-send-options.js';
import { AuditStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BOTH_CHROMIUM_LAUNCHERS, useSharedRunBrowser } from '../helpers/chromium.js';
import { GATE_INTERACTION_TIMING } from '../helpers/gate-harness.js';
import { settleLateDeliveries, startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig, runWithCoordinator } from '../helpers/run-harness.js';
import { PROBE_FACTORY_OPTIONS, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** 押した後と全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 押下の期限（ms）。 */
const PRESS_DEADLINE_MS = 15_000;
/** 発見の押下の、押した後に静まるまで待つ時間（ms。テストの値）。 */
const PROBE_QUIET_WAIT_MS = 500;

const html = (body: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>t</title></head><body><main><h1>点検</h1><p>本文です。</p></main>${body}</body></html>`;

/** 押すと、合図の GET（`/beacon?<id>`）と、書き込みの POST（`/api/press-<id>`）を出す。 */
const pressScript = (id: string): string =>
  `(function(){var b=document.getElementById(${JSON.stringify(id)});b.addEventListener('click',function(e){e.preventDefault();new Image().src='/beacon?${id}';`
  + `fetch('/api/press-${id}',{method:'POST',body:'x'}).catch(function(){});var n=document.getElementById('notice');if(n)n.remove();});})();`;

// ---------- 巡回 ----------
// 巡回の URL には既定の除外の語と `sign_out`・`log_out` だけを、語の境界で当てる（設計者の判断 2026-11-16・REV-SD の I-5）ので、アーカイブ・Presets の画面へは
// 移る。リンクの文字には、狭い一覧と日本語の動きの語だけを当て（REV-SD の M-2。「削除済みの項目」には当てない）、中の画像の alt も見る（M-1）。
const CRAWL_START = html(`<nav><a href="/about">会社の案内</a><a href="/blog/archive">記事の一覧</a><a href="/presets">Presets</a>
<a href="/items-deleted">削除済みの項目</a><a href="/items/1/delete">一覧の項目</a><a href="/items/2">削除</a>
<a href="/items/3"><img alt="削除" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"></a><a href="/account/sign_out">アカウント</a>
<a href="/a/1">ログオフ</a><a href="/Account/LogOff">こちら</a><a href="/a/2">Sign off</a><a href="/help/1">削除の手順の説明</a></nav>`);
// REV-SD2 の I-2: ログオフ・サインオフの文字と URL へも移らない。M-6: 「削除の手順の説明」へは移る。
const CRAWL_FOLLOWED = ['/about', '/blog/archive', '/presets', '/items-deleted', '/help/1'];
const CRAWL_NOT_FOLLOWED = ['/items/1/delete', '/items/2', '/items/3', '/account/sign_out', '/a/1', '/Account/LogOff', '/a/2'];

// ---------- 知らせの枠 ----------
/** 枠の形: 隅の region（`aria-label` は枠の名前）か、確かめの dialog。押す要素は `#b`。 */
const noticeHtml = (frameLabel: string | null, inner: string, role = 'region'): string => html(`
<section id="notice" role="${role}"${frameLabel === null ? '' : ` aria-label="${frameLabel}"`} style="position: fixed; top: 16px; right: 16px; width: 320px; height: 160px; background: #f0f; border: 1px solid #333;">
${inner}</section><script>${pressScript('b')}</script>`);
/** [id, ページ, 押すか]。 */
const NOTICES: readonly (readonly [string, string, boolean])[] = [
  ['delete', noticeHtml('お知らせ', '<p>一般の文です。</p><button type="button" id="b" aria-label="削除">✕</button>'), false],
  ['row-x', noticeHtml('お知らせ', '<ul><li>項目 A <button type="button" id="b">×</button></li></ul>'), false],
  ['reserve-cancel', noticeHtml('予約の確認', '<p>明日の予約です。</p><button type="button" id="b">キャンセル</button>'), false],
  ['confirm', noticeHtml('確認', '<p>この項目を削除しますか？</p><button type="button" id="b">閉じる</button>', 'dialog'), false],
  // REV-SD の I-2: 枠の名前がなくても、本文の目的語（予約・注文）があれば「キャンセル」を押さない。
  ['noname-reserve', noticeHtml(null, '<p>ご予約: 明日 10:00</p><button type="button" id="b">キャンセル</button>'), false],
  ['body-order', noticeHtml('お知らせ', '<p>ご注文を受け付けました。</p><button type="button" id="b">キャンセル</button>'), false],
  ['close', noticeHtml('お知らせ', '<p>一般の文です。</p><button type="button" id="b">閉じる</button>'), true],
  ['dismiss', noticeHtml('Notice', '<p>Your order has shipped.</p><button type="button" id="b">Dismiss</button>'), true],
  ['x', noticeHtml('お知らせ', '<p>一般の文です。</p><button type="button" id="b">×</button>'), true],
  ['frame-cancel', noticeHtml('お知らせ', '<p>一般の文です。</p><button type="button" id="b">キャンセル</button>'), true],
];

// ---------- Interaction ----------
/** [id, 押す要素の HTML（id は id）, 押すか]。どれもフォームの外の `type="button"`。 */
const INTERACTIONS: readonly (readonly [string, string, boolean])[] = [
  ['i-delete', '<button type="button" id="i-delete">削除</button>', false],
  ['i-row-x', '<ul><li>項目 B <button type="button" id="i-row-x">×</button></li></ul>', false],
  ['i-reserve', '<div role="dialog" aria-label="予約の確認"><button type="button" id="i-reserve">キャンセル</button></div>', false],
  ['i-confirm', '<div role="dialog"><p>この項目を削除しますか？</p><button type="button" id="i-confirm">OK</button></div>', false],
  ['i-htmx', '<button type="button" id="i-htmx" hx-delete="/api/items/3">実行</button>', false],
  // REV-SD の I-3・I-4 (b)・(c): 足した語、form の外で選ばれた削除の選択肢、祖先の `hx-delete`（form の中のボタンは Interaction では前から押さない）。
  ['i-hide', '<button type="button" id="i-hide">非表示にする</button>', false],
  ['i-unlink', '<button type="button" id="i-unlink">連携を解除</button>', false],
  ['i-close-account', '<button type="button" id="i-close-account">Close account</button>', false],
  ['i-select-noform', '<select><option>一括操作</option><option selected>削除</option></select><button type="button" id="i-select-noform">実行</button>', false],
  ['i-parent-hx', '<div hx-delete="/api/items/3"><button type="button" id="i-parent-hx">実行</button></div>', false],
  // REV-SD の I-5: 英語の語は語の境界で比べる（`Presets` に `reset` は当たらない）。
  ['i-preset', '<button type="button" id="i-preset">Presets</button>', true],
  // REV-SD2 の I-1: 別の区画の select・radio（一括操作・停止中・アーカイブ）で、関係のないボタンを削除と判定しない。
  ['i-other-bulk', '<section><button type="button" id="i-other-bulk" aria-expanded="false">詳しく見る</button></section>'
    + '<div><select aria-label="操作"><option selected>一括操作</option><option>削除</option></select><button type="button">適用</button></div>', true],
  ['i-other-status', '<section><button type="button" id="i-other-status" aria-expanded="false">詳しく見る</button></section>'
    + '<div><label>状態 <select><option selected>停止中</option><option>有効</option></select></label></div>', true],
  ['i-other-archive', '<section><button type="button" id="i-other-archive" aria-expanded="false">詳しく見る</button></section>'
    + '<fieldset><legend>表示</legend><label><input type="radio" name="v" value="all">すべて</label><label><input type="radio" name="v" value="archive" checked>アーカイブ</label></fieldset>', true],
  ['i-close', '<div role="dialog" aria-label="お知らせ"><button type="button" id="i-close">閉じる</button></div>', true],
  ['i-x', '<button type="button" id="i-x">×</button>', true],
  ['i-cancel', '<div role="dialog" aria-label="お知らせ"><button type="button" id="i-cancel">キャンセル</button></div>', true],
];
const interactionPage = (id: string, element: string): string => html(`${element}<script>${pressScript(id)}</script>`);

// ---------- 発見 ----------
/** JS の結び付きの form（送る前に止めて、書き込みの POST を出す）。 */
const PROBE_PAGE = html(`
<form id="f-save"><label>題 <input name="title"></label><button type="submit" id="p-save">保存</button></form>
<form id="f-bulk"><select name="op"><option value="">選んでください</option><option value="remove">一括で消す</option></select><button type="submit" id="p-bulk">実行</button></form>
<form id="f-method"><input type="hidden" name="_method" value="delete"><button type="submit" id="p-method">送る</button></form>
<div role="dialog"><p>この項目を削除しますか？</p><form id="f-confirm"><button type="submit" id="p-confirm">OK</button></form></div>
<form id="f-sel"><select name="op"><option value="">選んでください</option><option value="trash">ゴミ箱へ移動</option><option value="keep">残す</option></select><button type="submit" id="p-sel">適用</button></form>
<form id="f-radio"><label><input type="radio" name="op" value="erase">消す</label><label><input type="radio" name="op" value="keep">残す</label><button type="submit" id="p-radio">適用</button></form>
<form id="f-hx" hx-delete="/api/items/3"><label>題 <input name="t1"></label><button type="submit" id="p-hx">実行</button></form>
<div id="d-nf"><select id="op-nf"><option value="">選んでください</option><option value="delete">削除</option></select><button type="button" id="p-nf">実行</button></div>
<script>${['save', 'bulk', 'method', 'confirm', 'sel', 'radio', 'hx'].map((name) => `document.getElementById('f-${name}').addEventListener('submit',function(e){e.preventDefault();`
  + `fetch('/api/press-p-${name}',{method:'POST',body:'x'}).catch(function(){});});`).join('')}
document.getElementById('p-nf').addEventListener('click',function(){fetch('/api/press-p-nf',{method:'POST',body:'x'}).catch(function(){});});</script>`);
/** 押す押下（REV-SD の I-4 (a): 削除の語の選択肢を避けて、安全な選択肢を選んで押す）。 */
const PROBE_PRESSED = ['p-radio', 'p-save', 'p-sel'];
/**
 * 押す前の判定で止める押下（`p-method` は分類で対象から外れる）。REV-SD の I-4: 選択肢が削除の語だけの form（`p-bulk`）と form の外の欄（`p-nf`）、
 * form の `hx-delete`（`p-hx`）。
 */
const PROBE_JUDGED_AT_PRESS = ['p-bulk', 'p-confirm', 'p-hx', 'p-nf'];

const requests: string[] = [];
let server: LoopbackHttpServer;

beforeAll(async () => {
  server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push(`${request.method ?? ''} ${url.pathname}${url.search}`);
      const page = url.pathname === '/crawl' ? CRAWL_START
        : [...CRAWL_FOLLOWED, ...CRAWL_NOT_FOLLOWED].includes(url.pathname) ? html('<p>別の画面です。</p>')
          : url.pathname.startsWith('/notice/') ? NOTICES.find(([id]) => url.pathname === `/notice/${id}`)?.[1]
            : url.pathname.startsWith('/interaction/') ? (() => {
              const found = INTERACTIONS.find(([id]) => url.pathname === `/interaction/${id}`);
              return found === undefined ? undefined : interactionPage(found[0], found[1]);
            })()
              : url.pathname === '/probe' ? PROBE_PAGE : undefined;
      if (page === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
    });
  });
});

afterAll(async () => {
  await server?.close();
});

/** 届いた読み取りでない要求。 */
const nonReads = (): readonly string[] => requests.filter((line) => !line.startsWith('GET ') && !line.startsWith('HEAD '));

describe.each(BOTH_CHROMIUM_LAUNCHERS)('SD-1: destructive actions are judged before the operation (%s)', (_label, launch) => {
  const sharedBrowser = useSharedRunBrowser(launch);
  const factories: BrowserContextFactory[] = [];

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
  });

  it('the crawl of a public audit does not follow links whose URL or text has a destructive word', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-sd1-crawl-'));
    try {
      requests.length = 0;
      const config = fastRunConfig(server.origin, '/crawl', {
        crawl: { maxPages: 10 },
        audit: { performance: false, accessibility: false, interactions: false },
        output: { directory: outputDirectory },
      });
      const result = await runWithCoordinator({ config, launchBrowser: sharedBrowser, outputDirectory });
      await settleLateDeliveries(LATE_REQUEST_WAIT_MS, server);
      const audited = result.pages.map((page) => new URL(page.pageUrl).pathname);
      expect(audited).toEqual(expect.arrayContaining(['/crawl', ...CRAWL_FOLLOWED]));
      expect(audited.filter((path) => CRAWL_NOT_FOLLOWED.includes(path))).toEqual([]);
      expect(requests.filter((line) => CRAWL_NOT_FOLLOWED.some((path) => line.startsWith(`GET ${path}`)))).toEqual([]);
      expect(CRAWL_FOLLOWED.filter((path) => !requests.some((line) => line.startsWith(`GET ${path}`)))).toEqual([]);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it.each(NOTICES)('the notification close press of %s', async (id, _page, expected) => {
    const config = fastRunConfig(server.origin, `/notice/${id}`, { audit: { sendPolicy: 'PASS_EXCEPT_DELETE' } });
    const factory = new BrowserContextFactory(await sharedBrowser(), config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS, pageAuditRun: true, ...auditSendOptionsOf(config, []),
    });
    factories.push(factory);
    requests.length = 0;
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY', { pageAuditLoad: true });
    const page = await factory.createPassivePage(context);
    await page.goto(`${server.origin}/notice/${id}`);
    const overlay = await dismissNotificationFrames(page, { deadlineAtMs: Date.now() + PRESS_DEADLINE_MS, pressMode: 'AUDIT' });
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, server);
    // BeakSight の記録（押した印）と、サーバに届いた押下の合図が、どちらも押すかどうかと合う。
    expect([overlay.frames.some((frame) => frame.pressed), requests.includes('GET /beacon?b')]).toEqual([expected, expected]);
  });

  it.each(INTERACTIONS)('the Interaction press of %s', async (id, _element, expected) => {
    const browser = await sharedBrowser();
    const config = fastRunConfig(server.origin, `/interaction/${id}`);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const viewport = config.viewports.primaryDesktop;
    requests.length = 0;
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    await page.goto(`${server.origin}/interaction/${id}`, { waitUntil: 'load' });
    const { candidates } = await discoverInteractionCandidates(page);
    await factory.closePassiveContext(context);
    const candidate = candidates.find((found) => found.tagName === 'button');
    if (candidate === undefined) throw new Error(`missing interaction candidate: ${id}`);
    const result = await auditInteraction({
      sessionFactory: (sessionViewport) => factory.createInteractionSession(sessionViewport),
      targetUrl: `${server.origin}/interaction/${id}`,
      candidate,
      viewport,
      navigationTimeoutMs: GATE_INTERACTION_TIMING.navigationTimeoutMs,
      timeoutMs: GATE_INTERACTION_TIMING.timeoutMs,
      deadlineAtMs: Date.now() + GATE_INTERACTION_TIMING.overallMs,
    });
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, server);
    // 押すと、凍結の中で Guard が書き込みの POST を止めて記録する（押した証拠。BLOCKED_BY_SAFETY）。押さなければ理由のコードが残り、止めた記録はない。
    const blockedPress = result.safety.blockedInteractionRequests.some(({ url }) => new URL(url).pathname === `/api/press-${id}`);
    expect([result.status, result.reason, blockedPress]).toEqual(expected
      ? ['BLOCKED_BY_SAFETY', 'SAFETY_FREEZE_BLOCKED', true]
      : ['REJECTED_UNSAFE', 'DESTRUCTIVE_ACTION_SKIPPED', false]);
    // サーバ: 押さなかったボタンの合図（読み取りの GET）は届かない。読み取りでない要求は、どの場面でも届かない（押したボタンの POST は凍結で止まる）。
    if (!expected) {
      expect(requests.filter((line) => line.startsWith('GET /beacon'))).toEqual([]);
    }
    expect(nonReads()).toEqual([]);
  });

  it('the discovery press records DESTRUCTIVE_ACTION_SKIPPED for a destructive choice and a delete confirmation, and presses save', async () => {
    const browser = await sharedBrowser();
    const base = fastRunConfig(server.origin, '/probe', { audit: { sendPolicy: 'PASS_EXCEPT_DELETE' } });
    const config: AuditConfig = { ...base, site: { startUrl: `${server.origin}/probe`, allowedOrigins: [server.origin] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...PROBE_FACTORY_OPTIONS,
      ...auditSendOptionsOf(config, []),
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => filterAuthenticatedState(state, [server.origin]),
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        auditStage: { approvedServiceOrigins: [], auditReadRequests: [], scriptLogin: { origin: server.origin, path: '/token', requiredQuery: [] } },
      },
      serviceRequestBudget: createServiceRequestBudget({ now: () => Date.now() }),
      auditStageMonitor: new AuditStageMonitor(),
    });
    factories.push(factory);
    requests.length = 0;
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
    const page = await factory.createPassivePage(context);
    await page.goto(`${server.origin}/probe`);
    const observation = factory.submissionObservationOf(context);
    if (observation === null) throw new Error('the PRIMARY Context has no submission observation');
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([server.origin]) } });
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, {
      targetPolicy: { allowedOrigins: new Set([server.origin]), isExcludedPage: () => false },
      quietWaitMs: PROBE_QUIET_WAIT_MS,
    });
    await wait(LATE_REQUEST_WAIT_MS);
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, server);
    const blocked = factory.getSafetyLedger(context).snapshot().blockedInteractionRequests.map(({ url }) => new URL(url).pathname);
    // Guard が止めた押下の POST（押した証拠）は、保存だけ。
    expect(blocked.filter((path) => path.startsWith('/api/press-')).sort()).toEqual(PROBE_PRESSED.map((id) => `/api/press-${id}`));
    // BeakSight の記録: 押す前の判定に届いた削除に関する操作（選んだ選択肢・確かめの枠）は、押さなかった理由 `DESTRUCTIVE_ACTION_SKIPPED`。`_method=delete` の form は、
    // その前の分類（`DESTRUCTIVE`）で対象にならない。
    const reasons = probed.candidates.flatMap((candidate) => (candidate.submissionProbe?.result === 'NOT_OBSERVED' ? [candidate.submissionProbe.reason] : []));
    expect(reasons.filter((reason) => reason === 'DESTRUCTIVE_ACTION_SKIPPED')).toHaveLength(PROBE_JUDGED_AT_PRESS.length);
    // サーバ: 読み取りでない要求は 0。
    expect(nonReads()).toEqual([]);
  });
});

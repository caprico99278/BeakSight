// 通知の枠の設計書（`doc/design/2026-11-06-beaksight-notification-overlay-design.md`）3.2 の、操作さがしの結合テスト（本物の発見の流れ `executeDiscoveryRun`）。
// 仮のサイト（一般の文言だけ）の画面の先頭に、隅の通知の枠（透明な入れ物の中の `section role="region"`。`header` に最小化と閉じるボタン）があり、本文に
// 文字のあるボタンが 3 つある。操作さがしは、読み取りの前に枠を閉じ、閉じる押下を押す数（1 画面 3 回）に数えない（本文の 3 つを押す）。枠のボタンは候補に
// ならない。押して出た送信はサーバに届かない（今の操作さがしの決まり）。
// fix round 2（SREV-1106 の C-1）: 閉じる押下が出す POST・DELETE・遅れて出す POST（1.5 秒後）も、サーバに届かない（押す直前から凍結まで、凍結の読み取りの決まり）。
// SLIM BD-3: 既定の Chromium だけ（閉じる押下の部品と Guard は監査と発見で同じ。両方の Chromium の閉じる押下は、notification-dismissal を両方の Chromium で流して
// 確かめる。RB-14a）。
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { wait } from '../../src/core/deadline.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { runDiscoveryOnPlainSite } from '../helpers/plain-discovery-site-run.js';

const TEST_TIMEOUT_MS = 180_000;
const PAGE_PATH = '/n/p1';

const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ページ</title><link rel="icon" href="data:,"></head><body>
<div id="notice-layer" style="position: fixed; inset: 0; z-index: 40; pointer-events: none;">
  <section id="notice" role="region" aria-labelledby="notice-title" aria-live="polite"
    style="position: fixed; right: 16px; bottom: 16px; width: 300px; height: 180px; pointer-events: auto; background: #fff; border: 1px solid #333;">
    <header>
      <h2 id="notice-title">お知らせ</h2>
      <button type="button" id="notice-minimize" aria-expanded="true" aria-controls="notice-body" aria-label="お知らせを最小化">−</button>
      <button type="button" id="notice-close" aria-label="お知らせを閉じる">✕</button>
    </header>
    <div id="notice-body"><p>一般のお知らせの文です。</p></div>
  </section>
</div>
<main><h1>ページ</h1>
<button type="button" class="body">本文の操作 1</button><button type="button" class="body">本文の操作 2</button><button type="button" class="body">本文の操作 3</button></main>
<script>
document.getElementById('notice-minimize').addEventListener('click', () => { document.getElementById('notice-body').hidden = true; });
document.getElementById('notice-close').addEventListener('click', () => {
  fetch('/api/disc-close-post', { method: 'POST', body: 'x' }).catch(() => {});
  fetch('/api/disc-close-delete', { method: 'DELETE' }).catch(() => {});
  setTimeout(() => { fetch('/api/disc-close-late', { method: 'POST', body: 'x' }).catch(() => {}); }, 1500);
  document.getElementById('notice').remove();
});
for (const button of document.querySelectorAll('.body')) button.addEventListener('click', () => { button.dataset.on = '1'; });
</script></body></html>`;

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('NO-2: the discovery closes the notification frame before it reads and presses (%s)', (_label, launch) => {
  it('does not use the presses of the page for the close press, and presses the three body buttons', async () => {
    const run = await runDiscoveryOnPlainSite(launch, (path) => (path === PAGE_PATH ? PAGE_HTML : null), PAGE_PATH, 1, 'job-no2-discovery', {
      sendPolicy: 'PASS_EXCEPT_DELETE',
    });
    const page = run.document.pages.find((entry) => entry.state === 'READ' && new URL(entry.url).pathname === PAGE_PATH);
    if (page?.state !== 'READ') throw new Error('the page was not read');
    const lines = page.record.candidates.map((candidate) => `${String(candidate.submissionProbe?.result)} ${String(candidate.submissionProbe?.reason)}`);
    // 枠のボタン（最小化と閉じる）は、閉じた後なので候補にならない。本文の 3 つは、どれも押した（押す数を閉じる押下に使っていない）。
    // fix round 2: 閉じる押下が 1.5 秒後に出す POST は、本文のボタンを押している間に出ることがある（そのときは、その押下の観察した送信に数えられ、結果が
    // `NO_REQUEST` でなくなる）。押したこと（押す数の上限で止めていない、観察できなかったのでない）だけを確かめる。
    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith('NOT_OBSERVED ') || line.includes('PRESS_LIMIT_REACHED'))).toEqual([]);
    expect(run.seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('fix round 3 (R-C2, R-I2, R-I4): hides, moves and popups of the close press do not deliver sends, do not stop the discovery, and keep reading the pages', async () => {
    const other: string[] = [];
    const otherServer = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'OPTIONS') other.push(`${request.method ?? 'GET'} ${new URL(request.url ?? '/', 'http://127.0.0.1').pathname}`);
      request.resume();
      response.writeHead(request.method === 'OPTIONS' ? 204 : 200, { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' });
      response.end('ok');
    });
    try {
      const run = await runDiscoveryOnPlainSite(launch, (path) => scenePageOf(path, otherServer.origin), SCENE_PATHS[0], SCENE_PATHS.length, 'job-no2-discovery-r3', {
        sendPolicy: 'PASS_EXCEPT_DELETE',
      });
      await wait(LATE_ARRIVAL_WAIT_MS);
      // どの画面も読み（違反で止めない）、発見は最後まで続く。
      const read = run.document.pages.flatMap((entry) => (entry.state === 'READ' ? [new URL(entry.url).pathname] : []));
      expect([...read].sort()).toEqual([...SCENE_PATHS].sort());
      expect(run.document.endReason).not.toBe('SAFETY_VIOLATION');
      // 隠しを見たページの送信・押下の後の移動とポップアップ・許可の外への送信は、どれも届かない。
      expect(run.seen.filter(({ method, path }) => !READ_METHODS.has(method) || path === '/moved' || path === '/popup-page')).toEqual([]);
      expect(other).toEqual([]);
    } finally {
      await otherServer.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('NO-2 fix round 4 (N-I3): pages whose close press tried to move are recorded with the reason (%s)', (_label, launch) => {
  it('records the pages whose move was stopped in the press period as not read with the reason, and keeps same-document moves as read', async () => {
    // 始めの画面は、リンクだけの画面（移動を止めた画面からはリンクを拾わないため）。
    const run = await runDiscoveryOnPlainSite(launch, movedScenePageOf, MOVED_SCENE_INDEX_PATH, MOVED_SCENE_PATHS.length + 1, 'job-no2-discovery-r4', {
      sendPolicy: 'PASS_EXCEPT_DELETE',
    });
    await wait(LATE_ARRIVAL_WAIT_MS);
    const reasonsOf = (path: string): readonly string[] | null => {
      const entry = run.document.pages.find((page) => new URL(page.url).pathname === path);
      return entry?.state === 'READ' ? entry.record.incompleteReasons : null;
    };
    for (const path of ['/d3/nav', '/d3/detach', '/d3/busy', '/d3/hash-nav'] as const) {
      expect(reasonsOf(path), path).toContain('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED');
    }
    for (const path of ['/d3/hash-close', '/d3/push-state'] as const) {
      expect(reasonsOf(path), path).not.toBeNull();
      expect(reasonsOf(path), path).not.toContain('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED');
    }
    // 止めた移動は届かず、読み取りでない要求も届かない。
    expect(run.seen.filter(({ method, path }) => !READ_METHODS.has(method) || path === '/moved')).toEqual([]);
  }, BUSY_TEST_TIMEOUT_MS);
});

/** fix round 4: 長く止まる画面を含むテストの時間の上限（ms）。 */
const BUSY_TEST_TIMEOUT_MS = 180_000;
/** fix round 4: 閉じる押下の後にページが止まる時間（ms）。SLIM BD-3: 前の 17 秒は、撤廃した 15 秒の上限（L1）を越える名残なので短くした。 */
const BUSY_PAGE_MS = 2_000;

/** fix round 4（SREV-1106 の 3 回目の場面を一般の文言で写した）: 押下で移動を試みる画面と、同じ文書の中だけで移る画面。 */
const MOVED_SCENE_PATHS = ['/d3/nav', '/d3/detach', '/d3/busy', '/d3/hash-nav', '/d3/hash-close', '/d3/push-state'] as const;

/** fix round 4: リンクだけの始めの画面。 */
const MOVED_SCENE_INDEX_PATH = '/d3/index';

function movedScenePageOf(path: string): string | null {
  const links = MOVED_SCENE_PATHS.map((link) => `<a href="${link}">${link}</a>`).join(' ');
  if (path === MOVED_SCENE_INDEX_PATH) {
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>一覧</title><link rel="icon" href="data:,"></head><body><main><h1>一覧</h1><p>${links}</p></main></body></html>`;
  }
  const page = (closeHtml: string, script: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>画面</title><link rel="icon" href="data:,"></head><body>
<main><h1>画面</h1><p>${links}</p><button type="button" class="body">本文の操作</button></main>
<div id="layer" style="position: fixed; inset: 0; z-index: 40; pointer-events: none;">
<section role="region" style="position: fixed; right: 16px; bottom: 16px; width: 240px; height: 120px; pointer-events: auto; background: #fff; border: 1px solid #333;">
<p>一般のお知らせの文です。</p>${closeHtml}</section></div><script>${script}</script></body></html>`;
  const button = '<button type="button" id="scene-close">閉じる</button>';
  const onClose = (body: string): string => `document.getElementById('scene-close').addEventListener('click', (event) => { ${body} });`;
  switch (path) {
    case '/d3/nav':
      return page(button, onClose("location.href = '/moved';"));
    case '/d3/detach':
      return page(button, `document.getElementById('scene-close').addEventListener('pointerdown', () => { document.getElementById('layer').remove();
  setTimeout(() => { location.href = '/moved'; }, 600); });`);
    case '/d3/busy':
      return page(button, onClose(`setTimeout(() => { const t = Date.now(); while (Date.now() - t < ${String(BUSY_PAGE_MS)}) {} location.href = '/moved'; }, 50);`));
    case '/d3/hash-nav':
      return page('<a id="scene-close" href="#">閉じる</a>', onClose("event.preventDefault(); location.href = '/moved';"));
    case '/d3/hash-close':
      return page('<a id="scene-close" href="#close">×</a>', onClose("document.getElementById('layer').remove();"));
    case '/d3/push-state':
      return page(button, onClose("history.pushState({}, '', '/d3/pushed'); document.getElementById('layer').remove();"));
    case '/moved':
      return page('', '');
    default:
      return null;
  }
}

/** fix round 3: 押した後に遅れて出る要求を待ってから数える時間（ms）。 */
const LATE_ARRIVAL_WAIT_MS = 2_000;

/** fix round 3（SREV-1106 の再レビューの場面を一般の文言で写した）: 操作さがしの画面（どの画面も、ほかの画面へのリンクを持つ）。 */
const SCENE_PATHS = ['/d/hide', '/d/move', '/d/popup', '/d/detach'] as const;

const sceneNotice = (closeHtml: string): string => `<div id="layer" style="position: fixed; inset: 0; z-index: 40; pointer-events: none;">
<section id="scene-notice" role="region" style="position: fixed; right: 16px; bottom: 16px; width: 240px; height: 120px; pointer-events: auto; background: #fff; border: 1px solid #333;">
<p>一般のお知らせの文です。</p>${closeHtml}</section></div>`;

function scenePageOf(path: string, other: string): string | null {
  const links = SCENE_PATHS.map((link) => `<a href="${link}">${link}</a>`).join(' ');
  const post = (url: string): string => `fetch('${url}', { method: 'POST', body: 'x' }).catch(() => {});`;
  const page = (body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>画面</title><link rel="icon" href="data:,"></head><body>
<main><h1>画面</h1><p>${links}</p></main>${body}</body></html>`;
  switch (path) {
    case '/d/hide':
      // 閉じるボタンのない大きな枠。隠されたのを見て、送信して戻す。
      return page(`<div id="big" style="position: fixed; left: 0; right: 0; bottom: 0; height: 70vh; z-index: 30; background: #eef;"><p>一般の案内の文です。</p></div>
<script>const big = document.getElementById('big'); new MutationObserver(() => { if (big.style.visibility === 'hidden') {
  fetch('/api/hidden-delete', { method: 'DELETE' }).catch(() => {}); ${post('/api/hidden-post')} ${post(`${other}/v/hidden`)}
  big.style.visibility = 'visible'; } }).observe(big, { attributes: true, attributeFilter: ['style'] });</script>`);
    case '/d/move':
      return page(`${sceneNotice('<button type="button" id="scene-close">閉じる</button>')}
<script>document.getElementById('scene-close').addEventListener('click', () => { location.href = '/moved'; });</script>`);
    case '/d/popup':
      return page(`${sceneNotice('<button type="button" id="scene-close">閉じる</button>')}
<script>document.getElementById('scene-close').addEventListener('click', () => { document.getElementById('layer').remove();
  window.open('/popup-page'); window.open('${other}/v/popup'); });</script>`);
    case '/d/detach':
      return page(`${sceneNotice('<button type="button" id="scene-close">閉じる</button>')}
<script>document.getElementById('scene-close').addEventListener('pointerdown', () => { document.getElementById('layer').remove();
  setTimeout(() => { ${post(`${other}/v/detach-300`)} }, 300); setTimeout(() => { location.href = '/moved'; }, 600); });</script>`);
    case '/moved':
    case '/popup-page':
      return page('');
    default:
      return null;
  }
}

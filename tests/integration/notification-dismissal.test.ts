// 通知の枠の設計書（`doc/design/2026-11-06-beaksight-notification-overlay-design.md`）の NO-2 の結合テスト（本物の Page Auditor・factory・Guard）。
// 仮のサイトは 127.0.0.1 のサーバで、一般の文言だけを使う。受けた要求を `<method> <path>` で記録する。
// - 3.2・3.3: 隅の通知の枠（透明な入れ物の中の `section role="region"`。`header` の中に最小化と閉じるボタン）が 3 ページに出る。どのページでも閉じてから
//   測る（写しに枠が写らない）。覆いの指摘は 1 ページ目だけに出る。
// - 3.4: 押しても消えない枠と、閉じるボタンのない大きな枠で、`NOTIFICATION_NOT_DISMISSIBLE` と CSS の隠しが働く。
// - 閉じると画面が移る枠（RB-14a: 同じ Origin の移動は止めない）: 読み込み直さず、移った画面を測らない。資格情報の URL の送信は届かない。
// 両方の Chromium（既定の headless shell と、環境変数 `BEAKSIGHT_TEST_DEFAULT_CHROMIUM=cli` の CLI の Chromium）で確かめる。
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { BEFORE_HIDE_SCREENSHOT_DIRECTORY } from '../../src/core/artifact-layout.js';
import type { EvidenceRecordFor, PageAuditOutcome } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import type { NotificationOverlayEvidence } from '../../src/core/evidence-types.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { auditSendOptionsOf } from '../../src/orchestration/audit-send-options.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BROWSER_DEFAULT_FAVICON_PATH } from '../../src/safety/request-policy.js';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import { EVIDENCE_SUFFICIENCY_TEXT, NOTIFICATION_OVERLAY_TEXT } from '../../src/presentation/messages.js';
import { launchTestDefaultChromium, useHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig, findTextOccurrences, readRunArtifactFiles } from '../helpers/run-harness.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { countRgbPixels } from '../helpers/png-pixels.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 180_000;
/** 閉じた後に遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 通知の枠の背景の色（写しの中で数える。ほかの所に使わない色）。 */
const NOTICE_COLOR = { red: 255, green: 0, blue: 255 } as const;
const NOTICE_COLOR_CSS = 'rgb(255, 0, 255)';

let browser: Browser;
let server: LoopbackHttpServer;
const requests: string[] = [];
/** fix round 2: 許可の外の Origin のサーバ（受けた要求を `<method> <path>` で記録する）。 */
let otherServer: LoopbackHttpServer;
const otherRequests: string[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

/** 閉じるボタンを押したときの動き（JS の本文）。 */
type CloseBehavior = 'remove' | 'stay' | 'move';

const closeScript = (behavior: CloseBehavior): string => {
  switch (behavior) {
    case 'remove':
      return "document.getElementById('notice').remove();";
    case 'stay':
      return '';
    case 'move':
      return "location.href = '/moved';";
  }
};

/**
 * 隅の通知の枠（本来のサイトの一般の形）: 全面の透明な入れ物（`position: fixed`・`inset: 0`・`z-index: 40`・`pointer-events: none`）の中の、`section role="region"`
 * （`position: fixed`・背景・枠線・影）。枠の中の `header` に、最小化のボタンと、閉じるボタン（`aria-label` だけ。見える文字はアイコン）。
 */
const noticeHtml = (behavior: CloseBehavior): string => `
<div id="notice-layer" style="position: fixed; inset: 0; z-index: 40; pointer-events: none;">
  <section id="notice" role="region" aria-labelledby="notice-title" aria-live="polite"
    style="position: fixed; top: 16px; right: 16px; width: 300px; height: 180px; pointer-events: auto; background: ${NOTICE_COLOR_CSS}; border: 1px solid #333; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);">
    <header style="display: flex; gap: 8px;">
      <h2 id="notice-title" style="margin: 0; font-size: 16px;">お知らせ</h2>
      <button type="button" id="notice-minimize" aria-expanded="true" aria-controls="notice-body" aria-label="お知らせを最小化">−</button>
      <button type="button" id="notice-close" aria-label="お知らせを閉じる"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M1 1L11 11M11 1L1 11" stroke="#000" stroke-width="2"/></svg></button>
    </header>
    <div id="notice-body"><p>一般のお知らせの文です。</p></div>
  </section>
</div>
<script>
document.getElementById('notice-minimize').addEventListener('click', () => { document.getElementById('notice-body').hidden = true; });
document.getElementById('notice-close').addEventListener('click', () => { ${closeScript(behavior)} });
</script>`;

/** 閉じるボタンのない、画面の大きな部分を覆う固定の枠。 */
const BIG_PANEL_HTML = `<div id="big-panel" style="position: fixed; left: 0; right: 0; bottom: 0; height: 70vh; z-index: 30; background: ${NOTICE_COLOR_CSS};"><p>一般の案内の文です。</p></div>`;

/**
 * fix round 1: 閉じるボタンのある全面のモーダル（描く面がビューポートの 80% ほど。背景を描く固定の枠で、閉じるボタンは `aria-label` の「閉じる」）。
 * `remove` は押すと消え、`stay` は押しても残る。
 */
const modalHtml = (behavior: 'remove' | 'stay'): string => `
<div id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"
  style="position: fixed; left: 5vw; top: 5vh; width: 90vw; height: 90vh; z-index: 50; background: ${NOTICE_COLOR_CSS};">
  <h2 id="modal-title">ご案内</h2>
  <p>一般の案内の文です。</p>
  <button type="button" id="modal-close" aria-label="ご案内を閉じる">✕</button>
</div>
<script>
document.getElementById('modal-close').addEventListener('click', () => { ${behavior === 'remove' ? "document.getElementById('modal').remove();" : ''} });
</script>`;

/**
 * AUD-2: 閉じる語のない操作用のモーダルの小窓（`aria-modal`。暗転の要素は小窓の外の別の要素）。背景のボタンは暗転に塞がれ、小窓の中のボタンは小窓の中の固定の
 * 要素に覆われる。
 */
const MODAL_OPEN_HTML = `
<button type="button" id="bg-button" style="position: absolute; left: 24px; top: 160px; width: 160px; height: 40px;">背景のボタン</button>
<div id="backdrop" style="position: fixed; inset: 0; z-index: 40; background: rgba(0, 0, 0, 0.5);"></div>
<div id="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"
  style="position: fixed; left: 20vw; top: 20vh; width: 60vw; height: 60vh; z-index: 50; background: rgb(255, 255, 255);">
  <h2 id="dialog-title">予定の詳しい内容</h2>
  <p>一般の案内の文です。</p>
  <button type="button" id="dialog-action" style="position: absolute; left: 16px; bottom: 16px; width: 120px; height: 40px;">次へ</button>
  <div id="cover" style="position: fixed; left: calc(20vw + 8px); bottom: calc(20vh + 8px); width: 160px; height: 56px; z-index: 60; background: rgb(0, 128, 0);"></div>
</div>`;

/** AUD-2: 名前が中の画像の alt だけの閉じるボタンの、隅の小さな通知の枠。 */
const ICON_CLOSE_HTML = `<div id="icon-layer" style="position: fixed; inset: 0; z-index: 40; pointer-events: none;">
<section id="icon-notice" role="region" style="position: fixed; top: 16px; right: 16px; width: 200px; height: 80px; pointer-events: auto; background: #fee;">
<p>一般のお知らせの文です。</p><button type="button" id="icon-close"><img alt="閉じる" width="12" height="12" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button></section></div>
<script>document.getElementById('icon-close').addEventListener('click', () => { document.getElementById('icon-layer').remove(); });</script>`;

const pageHtml = (title: string, extra: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<title>${title}</title><style>body { margin: 0; font-family: sans-serif; } main { padding: 24px; }</style></head><body>
<main><h1>${title}</h1>
<p id="corner-text" style="width: 260px; height: 60px; margin: 0 24px 0 auto;">右上に置いた、一般の文です。</p>
<p>ページの本文の、一般の文です。</p></main>${extra}</body></html>`;

/**
 * fix round 2（SREV-1106 の場面を一般の文言で写した）: 隅の小さな通知の枠（透明な入れ物の中の region）。`index` で位置をずらす。`closeHtml` は枠の中の押せる要素。
 * 見出し（`heading`）を渡すと、枠の中の最初の見出しにする。
 */
const smallNotice = (index: number, closeHtml: string, heading = ''): string => `
<div id="layer${String(index)}" style="position: fixed; inset: 0; z-index: ${String(40 + index)}; pointer-events: none;">
<section id="n${String(index)}" role="region"
  style="position: fixed; top: ${String(8 + (index % 5) * 70)}px; right: ${String(8 + Math.floor(index / 5) * 160)}px; width: 150px; height: 60px; pointer-events: auto; background: #fee; border: 1px solid #333;">
${heading === '' ? '' : `<h2 style="margin: 0; font-size: 12px;">${heading}</h2>`}<div>${closeHtml}</div></section></div>`;

/** fix round 2: 閉じると、許可の外の Origin と、資格情報の名前の query つきの URL と、同じ Origin へ送る枠。 */
const sendNoticeHtml = (other: string): string => `${smallNotice(0, '<button type="button" id="send-close">閉じる</button>')}
<script>document.getElementById('send-close').addEventListener('click', () => {
  fetch('${other}/v/notice', { method: 'POST', body: 'x' }).catch(() => {});
  try { navigator.sendBeacon('${other}/v/beacon', 'x'); } catch {}
  fetch('${other}/v/keepalive', { method: 'POST', body: 'x', keepalive: true }).catch(() => {});
  fetch('/api/notice-token?access_token=abc', { method: 'POST', body: 'x' }).catch(() => {});
  fetch('/api/notice-ok', { method: 'POST', body: 'x' }).catch(() => {});
  document.getElementById('layer0').remove(); });</script>`;

/** fix round 2: 閉じると画面を移す枠（`script` は押したときの JS）。 */
const movingNoticeHtml = (script: string): string => `${smallNotice(0, '<button type="button" id="move-close">閉じる</button>')}
<script>document.getElementById('move-close').addEventListener('click', () => { ${script} });</script>`;

/** path ごとの文書（ほかの path は 404）。fix round 2 の、許可の外の Origin を使う文書は、サーバを起動した後に作る（`pageOf`）。 */
const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/reload': pageHtml('読み込み直す枠', movingNoticeHtml('location.reload();')),
  '/late-submit': pageHtml('遅れて送る枠', movingNoticeHtml(`document.getElementById('layer0').remove(); setTimeout(() => {
    const f = document.createElement('form'); f.method = 'post'; f.action = '/api/late-form'; document.body.append(f); f.submit(); }, 400);`)),
  '/next': pageHtml('別の画面', ''),
  '/popup-page': pageHtml('開いた窓', ''),
  '/notice/1': pageHtml('ページ 1', noticeHtml('remove')),
  '/notice/2': pageHtml('ページ 2', noticeHtml('remove')),
  '/notice/3': pageHtml('ページ 3', noticeHtml('remove')),
  '/stuck': pageHtml('残る枠', noticeHtml('stay') + BIG_PANEL_HTML),
  '/move': pageHtml('移る枠', noticeHtml('move')),
  '/moved': pageHtml('移った先', ''),
  '/modal': pageHtml('全面のモーダル', modalHtml('remove')),
  '/modal-stuck': pageHtml('残る全面のモーダル', modalHtml('stay')),
  '/modal-open': pageHtml('操作用の小窓', MODAL_OPEN_HTML),
  '/icon-close': pageHtml('画像の閉じるボタン', ICON_CLOSE_HTML),
});

beforeAll(async () => {
  otherServer = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path !== BROWSER_DEFAULT_FAVICON_PATH && request.method !== 'OPTIONS') otherRequests.push(`${request.method ?? 'GET'} ${path}`);
    request.resume();
    response.writeHead(request.method === 'OPTIONS' ? 204 : 200, {
      'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*', 'content-type': 'text/plain',
    });
    response.end('ok');
  });
  server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path !== BROWSER_DEFAULT_FAVICON_PATH) requests.push(`${request.method ?? 'GET'} ${path}`);
    request.resume();
    const html = pageOf(path);
    if (html !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }
    if (path.startsWith('/api/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
});

afterAll(async () => {
  await server.close();
  await otherServer.close();
});

/** 失敗の文に添える、テストを始めた時刻（ms）。 */
let testStartedAtMs = Date.now();
beforeEach(() => {
  testStartedAtMs = Date.now();
});

/** 安全の比べの失敗の文（サーバの記録の一覧と、テストを始めてからの所要の時間）。比べそのものは変えない。 */
const recordsText = (label = ''): string =>
  `${label} app(${server.origin}): ${JSON.stringify(requests)} other(${otherServer.origin}): ${JSON.stringify(otherRequests)} elapsed: ${String(Date.now() - testStartedAtMs)}ms`;

/** 同じ Origin への普通の POST が届いた数（主の読み込み 2 つと幅の走査の 1 つで、1 回以上 3 回以下。読み込みの数は別の比べで確かめる）。 */
const expectSameOriginPosts = (line: string): void => {
  const count = requests.filter((recorded) => recorded === line).length;
  expect(count, recordsText(line)).toBeGreaterThanOrEqual(1);
  expect(count, recordsText(line)).toBeLessThanOrEqual(3);
};

/** fix round 3: 閉じる押下の後に、`script` を動かす枠（`script` は押したときの JS。枠は押した時に消す）。 */
const laterNoticeHtml = (script: string): string => `${smallNotice(0, '<button type="button" id="later-close">閉じる</button>')}
<script>document.getElementById('later-close').addEventListener('click', () => { document.getElementById('layer0').remove(); ${script} });</script>`;

/** fix round 3（SREV-1106 の再レビューの場面を一般の文言で写した）: 許可の外の Origin を使う文書。 */
function laterPageOf(path: string, other: string): string | undefined {
  const post = (url: string): string => `fetch('${url}', { method: 'POST', body: 'x' }).catch(() => {});`;
  switch (path) {
    case '/later-move-other':
      return pageHtml('遅れて外へ移る枠', laterNoticeHtml(`setTimeout(() => { location.href = '${other}/v/later-nav'; }, 1500);`));
    case '/hash-post':
      return pageHtml('# の枠', `${smallNotice(0, '<a id="hash-close" href="#close">×</a>')}
<script>document.getElementById('hash-close').addEventListener('click', () => { ${post(`${other}/v/hash-post`)} ${post('/api/hash-ok')}
  document.getElementById('layer0').remove(); });</script>`);
    case '/push-state':
      return pageHtml('履歴を変える枠', laterNoticeHtml(`history.pushState({}, '', '/pushed-state'); ${post('/api/after-push')}`));
    case '/detach':
      return pageHtml('外れる枠', `${smallNotice(0, '<button type="button" id="detach-close">閉じる</button>')}
<script>document.getElementById('detach-close').addEventListener('pointerdown', () => { document.getElementById('layer0').remove();
  setTimeout(() => { ${post(`${other}/v/detach-300`)} }, 300); setTimeout(() => { location.href = '/moved'; }, 600); });</script>`);
    case '/popup':
      return pageHtml('窓を開く枠', laterNoticeHtml(`window.open('/popup-page'); window.open('${other}/v/popup');`));
    case '/dialog-form':
      return pageHtml('ダイアログの form の枠', `<dialog open id="dialog-frame" style="position: fixed; top: 16px; right: 16px; margin: 0; width: 240px;">
<p>一般のお知らせの文です。</p><form method="dialog"><button id="dialog-close">閉じる</button></form></dialog>`);
    case '/later-other-login':
      return pageHtml('遅れて外のログインへ移る枠', laterNoticeHtml(`setTimeout(() => { location.href = '${other}/login'; }, 1500);`));
    case '/dialog-post':
      // fix round 5（SREV-1106 の 4 回目の F4-I1。レビューの場面 dlgpost）: dialog の form の中の、送るボタン（formmethod が dialog でない・formaction がある）。
      return pageHtml('ダイアログの form の送るボタン', `
<dialog open style="position: fixed; right: 8px; top: 8px; width: 220px; height: 90px; margin: 0;"><form method="dialog"><button formmethod="post" formaction="${other}/v/dlg-other">閉じる</button></form></dialog>
<dialog open style="position: fixed; right: 8px; top: 120px; width: 220px; height: 90px; margin: 0;"><form method="dialog"><button formmethod="post" formaction="/api/dlg-post">閉じる</button></form></dialog>
<dialog open style="position: fixed; right: 8px; top: 232px; width: 220px; height: 90px; margin: 0;"><form method="dialog"><button formmethod="get" formaction="/api/dlg-get">閉じる</button></form></dialog>`);
    case '/dialog-post-ok':
      // fix round 5（レビューの場面 dlgpostok）: 隅の通知の枠の中の、dialog の form の送るボタン。
      return pageHtml('枠の中の dialog の form の送るボタン', smallNotice(0, '<form method="dialog"><button formmethod="post" formaction="/api/dlg-ok">閉じる</button></form>'));
    case '/dialog-post-more':
      // fix round 5: formaction だけのボタンと、form 属性のあるボタン。
      return pageHtml('dialog の form のほかの送るボタン', `${smallNotice(0, '<form method="dialog"><button formaction="/api/dlg-action">閉じる</button></form>')}
<form id="outside-form" method="post" action="/api/dlg-form-attribute"></form>${smallNotice(1, '<form method="dialog"><button form="outside-form">閉じる</button></form>')}`);
    case '/dialog-method-spaced':
      // fix round 7（SREV-1106 の 5 回目の F5-I1）: 空白と大文字を混ぜた method（ブラウザは dialog と見ず、GET で送る）。
      return pageHtml('dialog と読めない method', `${smallNotice(0, '<form method="dialog" action="/api/dlg-spaced"><button formmethod=" DIALOG ">閉じる</button></form>')}
${smallNotice(1, '<form method=" DIALOG " action="/api/dlg-form-spaced"><button>閉じる</button></form>')}`);
    case '/dialog-method-ok':
      // fix round 7: formmethod が dialog のボタン（ブラウザが dialog と決める）。押して閉じる。
      return pageHtml('dialog の formmethod の枠', `<dialog open style="position: fixed; top: 16px; right: 16px; margin: 0; width: 240px;">
<p>一般のお知らせの文です。</p><form method="DIALOG" action="/api/dlg-method-ok"><button formmethod="dialog">閉じる</button></form></dialog>`);
    case '/later-login':
      return pageHtml('遅れてログインへ移る枠', laterNoticeHtml("setTimeout(() => { location.href = '/login'; }, 1500);"));
    default:
      return undefined;
  }
}

/** path の文書（許可の外の Origin を使う文書は、両方のサーバを起動した後に作る）。 */
function pageOf(path: string): string | undefined {
  const later = laterPageOf(path, otherServer.origin);
  if (later !== undefined) return later;
  switch (path) {
    case '/send':
      return pageHtml('送り先を確かめる枠', sendNoticeHtml(otherServer.origin));
    default:
      return PAGES[path];
  }
}

/** ビューポートの理由のコード（ビューポートの順）。 */
const reasonCodesOf = (outcome: PageAuditOutcome): readonly (readonly string[])[] =>
  Object.values(outcome.result.viewports).map((viewport) => viewport.incompleteReasons.map((reason) => reason.code));

/** 1 つの Page Auditor（1 つの Run に当たる。見た枠の digest を、ページをまたいで持つ）。 */
interface AuditSession {
  readonly audit: (path: string) => Promise<{ readonly outcome: PageAuditOutcome; readonly screenshots: readonly string[] }>;
  readonly close: () => Promise<void>;
}

async function openAuditSession(options: { readonly sessionLostPathPrefix?: string } = {}): Promise<AuditSession> {
  const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-notification-'));
  const config = createTestConfig(server.origin, '/notice/1', {
    crawl: { minNavigationIntervalMs: 200 },
    viewports: { stressWidths: [360] },
    audit: { performance: false, accessibility: false, screenshots: true, interactions: false, sendPolicy: 'PASS_EXCEPT_DELETE' },
  });
  const navigationPacer = createTestNavigationPacer(config);
  const allocator = new IdAllocator();
  const auditor = new PageAuditor({
    contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS, navigationPacer, ...auditSendOptionsOf(config, []),
    }),
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory,
    navigationPacer,
    safetyViolationRecorded: () => false,
    ...(options.sessionLostPathPrefix === undefined ? {} : { sessionLostPathPrefix: options.sessionLostPathPrefix }),
  });
  return {
    audit: async (path) => {
      const normalized = normalizeUrl(`${server.origin}${path}`, `${server.origin}${path}`, new Set());
      if (!normalized.ok) throw new Error('the page URL must normalize');
      const pageId = allocator.allocatePageId();
      const outcome = await auditor.audit(normalized.url, pageId);
      const directory = join(screenshotRootDirectory, 'pages', pageId);
      const screenshots = listPngFiles(directory);
      return { outcome, screenshots };
    },
    close: async () => {
      await rm(screenshotRootDirectory, { recursive: true, force: true });
    },
  };
}

/** フォルダの中の PNG（入れ子を含む）。 */
function listPngFiles(directory: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listPngFiles(path);
    return entry.name.endsWith('.png') ? [path] : [];
  });
}

/** AUD-2: 通知の枠を隠す前に撮った画像のファイルか（置き場は配置の owner の 1 か所）。 */
const isBeforeHideFile = (file: string): boolean => file.split(/[\\/]/u).includes(BEFORE_HIDE_SCREENSHOT_DIRECTORY);

/** PNG の、指定の色の画素の数（画素の読み方は、テストの補助 `tests/helpers/png-pixels.ts` の 1 か所）。 */
const countColorPixels = (file: string, color: typeof NOTICE_COLOR): number => countRgbPixels(file, [color.red, color.green, color.blue]);

/** layout の Evidence（ビューポートごと）。AUD-2e: 落ち着いた後の確かめ直し（段 `recheck`）で集め直した主の layout は除く（通知の枠の事実は 1 回目だけが持つ）。 */
const layoutsOf = (outcome: PageAuditOutcome): readonly EvidenceRecordFor<'layout'>[] =>
  outcome.result.evidence.filter((record): record is EvidenceRecordFor<'layout'> => record.type === 'layout' && record.capture?.phase !== 'recheck');

/** 主の読み込みの通知の枠の事実（ビューポートの順）。 */
const overlaysOf = (outcome: PageAuditOutcome): readonly (NotificationOverlayEvidence | undefined)[] =>
  layoutsOf(outcome).map((record) => record.payload.notificationOverlay);

/** Finding の Rule の ID と、ビューポート。 */
const findingsOf = (outcome: PageAuditOutcome, ruleId: string): readonly string[] =>
  outcome.result.findings.filter((finding) => finding.ruleId === ruleId).map((finding) => String(finding.viewport));

describe('NO-2: the new Rules show in the report without changing the report code', () => {
  it('writes the not dismissible frame and the notice of closing (hiding) to the artifacts of a CLI Run', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-notification-run-'));
    try {
      const config = fastRunConfig(server.origin, '/stuck', {
        crawl: { maxPages: 1, minNavigationIntervalMs: 200 },
        audit: { performance: false, accessibility: false, interactions: false, sendPolicy: 'PASS_EXCEPT_DELETE' },
        output: { directory: outputDirectory },
      });
      const outcome = await executeAuditRun(config, {
        launchBrowser: () => launchTestDefaultChromium(), clock: () => new Date(), now: () => Date.now(),
      }, { startNew: true }, {});
      expect(outcome.kind).toBe('RAN');
      if (outcome.kind !== 'RAN') return;
      const files = await readRunArtifactFiles(outcome.runDirectory);
      const found = findTextOccurrences(files, [
        'NOTIFICATION_NOT_DISMISSIBLE', NOTIFICATION_OVERLAY_TEXT.hidden, '通知の枠の閉じるボタンを押しましたが、枠が残りました。', EVIDENCE_SUFFICIENCY_TEXT.operationRecordLabel,
      ]);
      // 表示面（HTML のレポート）に、Rule の ID と文が出る。S-12: 閉じた（隠した）知らせは操作の記録として、指摘に並べず数だけを出す。
      expect(found.filter((line) => line.startsWith('report.html: '))).toEqual([
        'report.html: NOTIFICATION_NOT_DISMISSIBLE',
        'report.html: 通知の枠の閉じるボタンを押しましたが、枠が残りました。',
        `report.html: ${EVIDENCE_SUFFICIENCY_TEXT.operationRecordLabel}`,
      ]);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

describe('NO-2: closing notification frames before the audit', () => {
  it('closes the corner notice on every page, reports its occlusion only on the first page, and keeps it out of the screenshots', async () => {
    const session = await openAuditSession();
    try {
      const audited = [];
      for (const path of ['/notice/1', '/notice/2', '/notice/3']) {
        audited.push({ path, ...await session.audit(path) });
      }
      for (const [index, { outcome, screenshots }] of audited.entries()) {
        // どのビューポートでも、閉じるボタン（最小化のボタンでない）を 1 回押して閉じた。
        for (const overlay of overlaysOf(outcome)) {
          expect(overlay).toMatchObject({ readStatus: 'READ', pressCount: 1, navigated: false });
          expect(overlay?.frames.map(({ status, pressed, dismissed, hidden, firstSeen }) => ({ status, pressed, dismissed, hidden, firstSeen })))
            .toEqual([{ status: 'DISMISSIBLE', pressed: true, dismissed: true, hidden: false, firstSeen: index === 0 }]);
        }
        // 幅の走査の幅でも閉じた。
        expect(layoutsOf(outcome).flatMap((record) => record.payload.stressNotificationOverlays ?? [])
          .map(({ width, overlay }) => [width, overlay.frames.map((frame) => frame.dismissed)])).toEqual([[360, [true]]]);
        // 閉じる前の layout は、初めてのページだけ。覆いの指摘も、初めてのページだけ（ビューポートごとに 1 件）。
        expect(layoutsOf(outcome).map((record) => record.payload.beforeNotificationDismissal !== undefined)).toEqual(index === 0 ? [true, true] : [false, false]);
        expect(findingsOf(outcome, 'FIXED_ELEMENT_OCCLUSION')).toEqual(index === 0 ? ['desktop', 'mobile'] : []);
        expect(findingsOf(outcome, 'NOTIFICATION_HANDLED_BEFORE_AUDIT')).toEqual(['desktop', 'mobile']);
        expect(findingsOf(outcome, 'NOTIFICATION_NOT_DISMISSIBLE')).toEqual([]);
        // 写しに枠が写らない。
        expect(screenshots.length).toBeGreaterThan(0);
        expect(screenshots.map((file) => countColorPixels(file, NOTICE_COLOR))).toEqual(screenshots.map(() => 0));
      }
      // 同じ枠は、どのページでも同じ digest。
      const digests = audited.map(({ outcome }) => overlaysOf(outcome)[0]?.frames[0]?.digest);
      expect(new Set(digests).size).toBe(1);
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  it('reports and hides a frame that stays after the press and a large frame without a close button', async () => {
    const session = await openAuditSession();
    try {
      const { outcome, screenshots } = await session.audit('/stuck');
      for (const overlay of overlaysOf(outcome)) {
        expect(overlay?.frames.map(({ status, pressed, dismissed, hidden, hiddenReason }) => ({ status, pressed, dismissed, hidden, hiddenReason })))
          .toEqual(expect.arrayContaining([
            { status: 'DISMISSIBLE', pressed: true, dismissed: false, hidden: true, hiddenReason: 'NOT_DISMISSED' },
            { status: 'NO_CLOSE_BUTTON', pressed: false, dismissed: false, hidden: true, hiddenReason: 'NO_CLOSE_BUTTON' },
          ]));
        // AUD-2（5.2）: 隠した枠は、そのときの幅とスクロールを残す。
        expect(overlay?.frames.every((frame) => frame.hiddenAt !== undefined && frame.hiddenAt.viewportWidth > 0)).toBe(true);
      }
      expect(findingsOf(outcome, 'NOTIFICATION_NOT_DISMISSIBLE')).toEqual(['desktop', 'desktop', 'mobile', 'mobile']);
      expect(findingsOf(outcome, 'NOTIFICATION_HANDLED_BEFORE_AUDIT')).toEqual(['desktop', 'mobile']);
      // 隠した枠は、測った layout と写しに入らない。
      for (const record of layoutsOf(outcome)) {
        const selectors = record.payload.primary.layout?.fixedElements.map((element) => element.selector) ?? [];
        expect(selectors.filter((selector) => selector === '#notice' || selector === '#big-panel')).toEqual([]);
      }
      // AUD-2（5.2）: 隠す前の画面の画像を、主の読み込みと幅ごとに 1 枚ずつ撮り（枠が写る）、ほかの写しには枠が写らない。
      const beforeHide = screenshots.filter(isBeforeHideFile);
      expect(beforeHide).toHaveLength(3);
      expect(beforeHide.every((file) => countColorPixels(file, NOTICE_COLOR) > 0)).toBe(true);
      const states = screenshots.filter((file) => !isBeforeHideFile(file));
      expect(states.map((file) => countColorPixels(file, NOTICE_COLOR))).toEqual(states.map(() => 0));
      expect(outcome.result.evidence.filter((record) => record.type === 'screenshot' && record.payload.beforeNotificationHide === true)).toHaveLength(3);
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  it('fix round 1: presses the close button of a full modal too, and AUD-2: reports a full modal that stays after the press but keeps it open', async () => {
    const session = await openAuditSession();
    try {
      const closed = await session.audit('/modal');
      for (const overlay of overlaysOf(closed.outcome)) {
        expect(overlay?.frames.map(({ status, pressed, dismissed, hidden, hiddenReason }) => ({ status, pressed, dismissed, hidden, hiddenReason })))
          .toEqual([{ status: 'TOO_LARGE', pressed: true, dismissed: true, hidden: false, hiddenReason: null }]);
      }
      expect(findingsOf(closed.outcome, 'NOTIFICATION_NOT_DISMISSIBLE')).toEqual([]);
      expect(findingsOf(closed.outcome, 'NOTIFICATION_HANDLED_BEFORE_AUDIT')).toEqual(['desktop', 'mobile']);
      expect(closed.screenshots.map((file) => countColorPixels(file, NOTICE_COLOR))).toEqual(closed.screenshots.map(() => 0));

      const stuck = await session.audit('/modal-stuck');
      for (const overlay of overlaysOf(stuck.outcome)) {
        expect(overlay?.frames.map(({ status, pressed, dismissed, hidden, hiddenReason, keptOpen }) => ({ status, pressed, dismissed, hidden, hiddenReason, keptOpen })))
          .toEqual([{ status: 'TOO_LARGE', pressed: true, dismissed: false, hidden: false, hiddenReason: 'NOT_DISMISSED', keptOpen: true }]);
      }
      expect(findingsOf(stuck.outcome, 'NOTIFICATION_NOT_DISMISSIBLE')).toEqual(['desktop', 'mobile']);
      // AUD-2: 隠さないので「隠しました」の文はなく、隠す前の画像も撮らない。
      expect(stuck.outcome.result.findings.filter((finding) => finding.message.includes('隠しました'))).toEqual([]);
      expect(stuck.screenshots.filter(isBeforeHideFile)).toEqual([]);
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  it('AUD-2: audits a modal dialog without a close word open, does not report its blocked background, and reports a cover inside the dialog', async () => {
    const session = await openAuditSession();
    try {
      const { outcome, screenshots } = await session.audit('/modal-open');
      for (const overlay of overlaysOf(outcome)) {
        expect(overlay?.frames.length).toBeGreaterThan(0);
        expect(overlay?.frames.map(({ hidden, hiddenReason, keptOpen }) => ({ hidden, hiddenReason, keptOpen })))
          .toEqual(overlay?.frames.map(() => ({ hidden: false, hiddenReason: null, keptOpen: true })));
      }
      expect(findingsOf(outcome, 'NOTIFICATION_NOT_DISMISSIBLE')).toEqual([]);
      expect(screenshots.filter(isBeforeHideFile)).toEqual([]);
      // 背景が暗転と小窓に塞がれるのは指摘にならず、小窓の中のボタンを覆う要素は指摘になる。
      const occlusions = outcome.result.findings.filter((finding) => finding.ruleId === 'FIXED_ELEMENT_OCCLUSION' || finding.ruleId === 'OVERSIZED_FIXED_ELEMENT');
      expect(occlusions.filter((finding) => /固定要素 #(?:backdrop|dialog)（/u.test(finding.message))).toEqual([]);
      expect(occlusions.filter((finding) => finding.ruleId === 'FIXED_ELEMENT_OCCLUSION' && finding.message.includes('#cover'))
        .map((finding) => finding.viewport)).toEqual(expect.arrayContaining(['desktop', 'mobile']));
    } finally {
      await session.close();
    }
  });

  it('AUD-2: takes a button whose name is only the alt of its image as the close button', async () => {
    const session = await openAuditSession();
    try {
      const { outcome } = await session.audit('/icon-close');
      for (const overlay of overlaysOf(outcome)) {
        expect(overlay?.frames.map(({ status, pressed, dismissed }) => ({ status, pressed, dismissed })))
          .toEqual([{ status: 'DISMISSIBLE', pressed: true, dismissed: true }]);
      }
    } finally {
      await session.close();
    }
  });

  it('RB-14a (X11): lets the move of a close press reach the site, and does not measure the moved page (PARTIAL with the reason)', async () => {
    const session = await openAuditSession();
    try {
      for (const [path, moved] of [['/move', 'GET /moved'], ['/late-submit', 'POST /api/late-form'], ['/detach', 'GET /moved'], ['/reload', null]] as const) {
        requests.length = 0;
        const { outcome } = await session.audit(path);
        await wait(LATE_REQUEST_WAIT_MS);
        // 押した後の同じ Origin の移動は止めない。移った画面は測らない（どのビューポートも PARTIAL で理由が残り、layout の Evidence と配置の指摘がない）。
        if (moved !== null) expect(requests.filter((line) => line === moved).length, recordsText(path)).toBeGreaterThanOrEqual(1);
        expect(outcome.safety.invariantViolationCount, `${JSON.stringify(outcome.safety.invariantViolations)} ${recordsText(path)}`).toBe(0);
        expect(Object.values(outcome.result.viewports).map((viewport) => viewport.status), path).toEqual(['PARTIAL', 'PARTIAL']);
        expect(reasonCodesOf(outcome).map((codes) => codes.includes('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED')), path).toEqual([true, true]);
        expect(layoutsOf(outcome), path).toEqual([]);
        expect(outcome.result.findings.filter((finding) => finding.category === 'LAYOUT'), path).toEqual([]);
      }
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  it('RB-14a (X11): sends of a close press go to the current rules, and a send with a credential in the URL does not reach the site', async () => {
    const session = await openAuditSession();
    try {
      requests.length = 0;
      otherRequests.length = 0;
      const { outcome } = await session.audit('/send');
      await wait(LATE_REQUEST_WAIT_MS);
      for (const overlay of overlaysOf(outcome)) {
        expect(overlay?.frames.map(({ pressed, dismissed }) => ({ pressed, dismissed }))).toEqual([{ pressed: true, dismissed: true }]);
      }
      // 資格情報の名前の query つきの POST は届かない。許可の外の Origin への POST と、同じ Origin の普通の POST は届く。
      expect(requests.filter((line) => line === 'POST /api/notice-token'), recordsText()).toEqual([]);
      expect(otherRequests.filter((line) => line === 'POST /v/notice').length, recordsText()).toBeGreaterThanOrEqual(1);
      expectSameOriginPosts('POST /api/notice-ok');
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  // RB-9: 押す名前とリンクの見分け（fix round 2 の I-1〜I-5・M-3、fix round 3 の R-I1、fix round 4 の N-I2）は、notification-overlay の結合の読み取りの
  // 場面と、見分けの単体で確かめる。押した後の輪（fix round 2 の I-7、fix round 6）は、偽の口の単体（notification-dismissal-steps）で確かめる。
  // RB-14a（X11）: 押す期間の決まりは、資格情報の URL の送信を止めるだけになった。SD-2: ページ自身の削除は、押す期間の外と同じく届く（止めない）。
  // ずれの確かめ（tests/contract/pass-through-paths）と、押す期間の判定の単体（notification-press-policy）で確かめる。知らせの枠が削除に関する操作を
  // 押さないことは `destructive-action-guard` が確かめる。
  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 許可の外への main frame の移動は届く（止めない）。移った画面は測らない。
  it('fix round 3 (R-C1, R-I4): a late move to another Origin arrives and popups are stopped without violations, and the page is not measured', async () => {
    const session = await openAuditSession();
    try {
      for (const path of ['/later-move-other', '/popup'] as const) {
        requests.length = 0;
        otherRequests.length = 0;
        const { outcome } = await session.audit(path);
        await wait(LATE_REQUEST_WAIT_MS);
        // 違反はなく、ポップアップは届かない。許可の外への移動は届く（ビューポートごとに 1 回）。読み込みは主の 2 つだけ（読み込み直しも、幅の走査もしない）。
        expect(outcome.safety.invariantViolationCount, `${JSON.stringify(outcome.safety.invariantViolations)} ${recordsText(path)}`).toBe(0);
        expect(requests.filter((line) => line === 'GET /popup-page'), recordsText(path)).toEqual([]);
        expect(otherRequests, recordsText(path)).toEqual(path === '/later-move-other' ? ['GET /v/later-nav', 'GET /v/later-nav'] : []);
        expect(requests.filter((line) => line === `GET ${path}`), path).toHaveLength(2);
        expect(reasonCodesOf(outcome).map((codes) => codes.includes('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED')), path).toEqual([true, true]);
        expect(layoutsOf(outcome), path).toEqual([]);
      }
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  it('fix round 3 (R-M1, R-M3): moves in the same document are not counted, and a close button in a dialog form is pressed without sends', async () => {
    const session = await openAuditSession();
    try {
      requests.length = 0;
      otherRequests.length = 0;
      for (const path of ['/hash-post', '/push-state', '/dialog-form'] as const) {
        const { outcome } = await session.audit(path);
        expect(reasonCodesOf(outcome).flat().includes('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED'), path).toBe(false);
        expect(overlaysOf(outcome).map((overlay) => overlay?.frames.filter((frame) => frame.pressed).map((frame) => frame.dismissed)), path)
          .toEqual([[true], [true]]);
      }
      await wait(LATE_REQUEST_WAIT_MS);
      // 同じ Origin の普通の POST は届く。dialog の form の閉じるボタンは、何も送らない。
      expectSameOriginPosts('POST /api/hash-ok');
      expectSameOriginPosts('POST /api/after-push');
      expect(requests.filter((line) => !line.startsWith('GET ') && !['POST /api/hash-ok', 'POST /api/after-push'].includes(line))).toEqual([]);
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  it('fix round 4 (N-I1): a late move to the login page in the press period is judged as the end of the session', async () => {
    const session = await openAuditSession({ sessionLostPathPrefix: '/login' });
    try {
      const { outcome } = await session.audit('/later-login');
      await wait(LATE_REQUEST_WAIT_MS);
      expect(outcome.authSessionLostDetail ?? null).not.toBeNull();
      expect(outcome.safety.invariantViolationCount, `${JSON.stringify(outcome.safety.invariantViolations)} ${recordsText()}`).toBe(0);
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  it('fix round 5 (F4-M2): a late move to the login page of another Origin in the press period is not judged as the end of the session', async () => {
    const session = await openAuditSession({ sessionLostPathPrefix: '/login' });
    try {
      otherRequests.length = 0;
      const { outcome } = await session.audit('/later-other-login');
      await wait(LATE_REQUEST_WAIT_MS);
      expect(outcome.authSessionLostDetail ?? null).toBeNull();
      // SD-2: 許可の外への移動は届く（ビューポートごとに 1 回）。ほかの Origin のログインの画面は、セッションの切れにしない。
      expect(otherRequests, recordsText()).toEqual(['GET /login', 'GET /login']);
      expect(reasonCodesOf(outcome).map((codes) => codes.includes('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED'))).toEqual([true, true]);
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  it('fix round 5 (F4-I1): does not press the sending buttons in a dialog form, and does not count them as moves', async () => {
    const session = await openAuditSession();
    try {
      requests.length = 0;
      otherRequests.length = 0;
      for (const path of ['/dialog-post', '/dialog-post-ok', '/dialog-post-more'] as const) {
        const { outcome } = await session.audit(path);
        // 送るボタンは押さない（閉じるボタンのない枠として扱う）。押さないので、移動を止めた PARTIAL にもならない。
        expect(overlaysOf(outcome).map((overlay) => overlay?.pressCount), path).toEqual([0, 0]);
        expect(overlaysOf(outcome).flatMap((overlay) => overlay?.frames.map((frame) => frame.status) ?? []).includes('DISMISSIBLE'), path).toBe(false);
        expect(reasonCodesOf(outcome).flat().includes('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED'), path).toBe(false);
      }
      await wait(LATE_REQUEST_WAIT_MS);
      expect(requests.filter((line) => line.includes('/api/dlg-'))).toEqual([]);
      expect(otherRequests, recordsText()).toEqual([]);
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);

  it('fix round 7 (F5-I1): decides a dialog form by the method the browser decides, not by the attribute text', async () => {
    const session = await openAuditSession();
    try {
      requests.length = 0;
      otherRequests.length = 0;
      const spaced = await session.audit('/dialog-method-spaced');
      // 空白を含む method は dialog でない（GET で送る）ので、送るボタンとして押さない。押さないので、移動を止めた PARTIAL にもならない。
      expect(overlaysOf(spaced.outcome).map((overlay) => overlay?.pressCount)).toEqual([0, 0]);
      expect(reasonCodesOf(spaced.outcome).flat().includes('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED')).toBe(false);
      const dialog = await session.audit('/dialog-method-ok');
      expect(overlaysOf(dialog.outcome).map((overlay) => overlay?.frames.filter((frame) => frame.pressed).map((frame) => frame.dismissed)))
        .toEqual([[true], [true]]);
      await wait(LATE_REQUEST_WAIT_MS);
      expect(requests.filter((line) => line.includes('/api/dlg-')), recordsText()).toEqual([]);
      expect(otherRequests, recordsText()).toEqual([]);
    } finally {
      await session.close();
    }
  }, TEST_TIMEOUT_MS);
});

// AUD-4d・4c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4c・4d）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// - 画面の外に置いた、フォーカスできる要素に、ほかの証拠を集め終えた後でフォーカスを当て、矩形・見えるか・押せるかを読む（段 `focus-check` の Evidence）。
//   - フォーカスで現れるスキップリンク: 指摘にしない（数だけ残す）。
//   - フォーカスしても現れないスキップリンク: `FOCUSED_CONTROL_HIDDEN` の指摘。フォーカスを当てたままの viewport の画像を撮り、指摘はその画像を参照する。
//   - 幅の走査の幅でも、同じ読み取りをする。
// - tel: のリンクは、指摘にしない（リンクの記録は消さない）。
// - AUD-3（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 6.2 の 1〜3）: 小窓の端の大きさのない守りの部品は `GUARD`、スキップリンクとボタンは
//   `CONTROL`。守りの部品の指摘は文が分かれ、確信度が下がる（重さは同じ）。同じ selector に当たる 2 つのボタンの指摘は、それぞれ自分の項目の番号を根拠にする。
// - AUD-3（6.2 の 4・5）: 直の focus で隠れたままの項目がある画面だけ、文書の先頭から Tab を押す。Tab で届いて見える項目は確信度が下がり、届かない項目は文に
//   その事実が出る。候補のない画面では Tab を押さない（ページが keydown で送る目印がサーバに届かない）。
// - AUDR2: 小窓の外の、小窓の直前と直後の兄弟の守りの部品も `GUARD`。通常の Tab の確かめの結果（走らなかった・確かめられなかった理由）を記録に残す。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { AuditRunResult, Finding, PageAuditOutcome } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { findingImageRegionIndexOf } from '../../src/core/finding-image-regions.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { FOCUSED_CONTROL_HIDDEN_TEXT } from '../../src/presentation/messages.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { auditRun } from '../helpers/audit-run-fixture.js';
import { TEST_RUN_PROGRESS_QUIET_LIMIT_MS } from '../helpers/run-harness.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 3 * 60_000;
const STRESS_WIDTH = 800;

const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>skip links</title>'
  + '<style>html, body { margin: 0; } .skip { position: absolute; left: -9999px; top: 0; } .skip:focus { left: 8px; top: 8px; background: #fff; }</style>'
  + '</head><body>'
  // 正常なスキップリンク（フォーカスで現れる）。
  + '<a id="skip" class="skip" href="#main">本文へ</a>'
  // フォーカスしても現れないスキップリンク。
  + '<a id="broken" href="#main" style="position: absolute; left: -9999px; top: 0">メニューへ</a>'
  + '<main id="main"><h1>見出し</h1><p>本文です。</p><a id="tel" href="tel:0120000000">電話する</a></main>'
  + '</body></html>';

/** 祖先を 7 段重ねた中の、画面の外のボタン（selector の段の数を超える所だけが違う、同じ作りの 2 つ）。 */
const deepButton = (top: number): string => `<section>${'<div>'.repeat(7)}`
  + `<button type="button" style="position: absolute; left: -9999px; top: ${top}px">押す</button>${'</div>'.repeat(7)}</section>`;
/** 小窓の始めと終わりの、名前のない大きさのない守りの部品。 */
const GUARD = '<span tabindex="0" style="display: block; width: 0; height: 0; overflow: hidden"></span>';
const GUARDS_PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>guards</title>'
  // AUDR2: body の直下の、小窓の兄弟でない同じ形の部品は、守りの部品と決めない。
  + `<style>html, body { margin: 0; }</style></head><body>${GUARD}`
  + '<a id="skip-hidden" href="#main" style="position: absolute; left: -9999px; top: 0">本文へ</a>'
  // REV-AUD3 の M-1: 小窓の外の、名前のない大きさのない部品は、守りの部品と決めない。
  + `<main id="main"><h1>見出し</h1><p>本文です。<span tabindex="0" style="display: inline-block; width: 0; height: 0"></span></p>${deepButton(40)}${deepButton(80)}</main>`
  // AUDR2: 小窓の外の、小窓の直前と直後の兄弟に置いた守りの部品（body の直下）。
  + `${GUARD}<div role="dialog" aria-modal="true" aria-label="案内" style="position: fixed; left: 20px; top: 120px; width: 300px; height: 160px; background: #fff">`
  + `${GUARD}<p>案内の文です。</p><button type="button">次へ</button>${GUARD}</div>${GUARD}`
  + '</body></html>';

/** Tab を押すたびに、ページが送る読み取りの目印（BeakSight が Tab を押したかを、サーバで見る）。 */
const KEY_MARK = '/key-pressed';
const KEY_MARK_SCRIPT = `<script>let marks = 0; addEventListener("keydown", () => { marks += 1; new Image().src = "${KEY_MARK}?" + marks; }, true);</script>`;
/** サーバに届いた Tab の目印の数。 */
const keyMarks = (): number => received.filter((url) => url.startsWith(`${KEY_MARK}?`)).length;
/**
 * 通常の Tab の確かめの画面。Tab のキーで印を付けたときだけ出るスキップリンク（直の focus では隠れたまま）、Tab を止めるボタン（キーボードの罠）と、その後の
 * 画面の外のリンク（Tab では届かない）。
 */
const TAB_PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>tab</title>'
  + '<style>html, body { margin: 0; } #kbd-skip { position: absolute; left: -9999px; top: 0; } .kbd #kbd-skip:focus { left: 8px; top: 8px; background: #fff; }</style>'
  + `<script>addEventListener("keydown", (e) => { if (e.key === "Tab") document.documentElement.classList.add("kbd"); }, true);</script>${KEY_MARK_SCRIPT}`
  + '</head><body><a id="kbd-skip" href="#main">本文へ</a>'
  + '<main id="main"><h1>見出し</h1><button type="button" id="trap">止める</button>'
  + '<a id="after-trap" href="#main" style="position: absolute; left: -9999px; top: 40px">次へ</a></main>'
  + '<script>document.getElementById("trap").addEventListener("keydown", (e) => { if (e.key === "Tab") e.preventDefault(); });</script>'
  + '</body></html>';
/** 候補のない画面（フォーカスで現れるスキップリンクだけ）。 */
const NO_CANDIDATE_PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>none</title>'
  + `<style>html, body { margin: 0; } #skip { position: absolute; left: -9999px; top: 0; } #skip:focus { left: 8px; top: 8px; background: #fff; }</style>${KEY_MARK_SCRIPT}`
  + '</head><body><a id="skip" href="#main">本文へ</a><main id="main"><h1>見出し</h1><button type="button">押す</button></main></body></html>';
/** REV-AUD3 の形の画面の頭（Tab の目印つき）。 */
const markedHead = (title: string): string => '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,">'
  + `<title>${title}</title><style>html, body { margin: 0; }</style>${KEY_MARK_SCRIPT}</head><body>`;
/** 画面の外の、直の focus で隠れたままのリンク。 */
const hiddenLink = (id: string, top: number): string => `<a id="${id}" href="#main" style="position: absolute; left: -9999px; top: ${top}px">本文へ</a>`;
const hiddenHead = (title: string, id: string): string => `${markedHead(title)}${hiddenLink(id, 0)}`;
/** REV-AUD3 の I-1: 先頭の隠れたリンク、枠（iframe）、枠の後の隠れたリンク。 */
const IFRAME_PAGE = `${hiddenHead('iframe', 'first')}<main id="main"><button type="button">前</button>`
  + `<iframe src="/frame" style="width: 200px; height: 80px"></iframe>${hiddenLink('after-frame', 200)}<button type="button">後</button></main></body></html>`;
const FRAME = '<!doctype html><html><body><button type="button">中1</button><button type="button">中2</button></body></html>';
/** REV-AUD3 の I-4: 最後のリンクにフォーカスが来るたびに、リンクを 1 つ足す画面。 */
const GROW_PAGE = `${hiddenHead('grow', 'skip')}<main id="main"><a href="#1">1</a></main><script>let n = 1;`
  + 'document.addEventListener("focusin", (e) => { const m = document.getElementById("main"); if (e.target === m.lastElementChild && n < 1500) {'
  + ' n += 1; const a = document.createElement("a"); a.href = "#" + n; a.textContent = String(n); m.append(a); } });</script></body></html>';
/** REV-AUD3 の 2 回目の I-A: 隠れたリンクの祖先が、ずっと横に流れ続ける（位置が落ち着かない）画面。 */
const SPIN_PAGE = `${markedHead('spin')}<main id="main"><div id="band" style="width: 300px; overflow: hidden; white-space: nowrap">`
  + '<span style="display: inline-block; width: 3000px">流れる帯</span><a href="#x" style="position: relative; left: -99999px">隠れ</a></div></main>'
  + '<script>setInterval(() => { const b = document.getElementById("band"); b.scrollLeft = (b.scrollLeft + 7) % 2000; }, 10);</script></body></html>';
/**
 * AUDR2: 管理画面の形。body の直下の守りの部品（フォーカスが来ると、根の中の端の要素へ移す）、フォーカスを受ける SPA の根、横のメニュー、内側の入れ物が
 * スクロールする本文（中に、直の focus で隠れたままのリンク）。
 */
const appShellPage = (endGuardMoves: boolean): string => `${markedHead('shell')}${GUARD}<div id="root" tabindex="-1" style="display: flex; height: 100vh">`
  + '<nav style="width: 160px"><a href="#a">メニュー1</a><a href="#b">メニュー2</a></nav>'
  + '<div id="scroller" style="flex: 1; overflow: auto; height: 100vh"><main id="main"><h1>見出し</h1><p style="height: 3000px">本文</p>'
  + `${hiddenLink('hidden', 40)}<button type="button">押す</button></main></div></div>${GUARD}`
  + '<script>const root = document.getElementById("root"); const [first, last] = document.querySelectorAll("body > span");'
  + ' const inner = () => [...root.querySelectorAll("a[href], button")];'
  + ` first.addEventListener("focus", () => inner().at(-1).focus());${endGuardMoves ? ' last.addEventListener("focus", () => inner()[0].focus());' : ''}`
  + ' root.focus();</script></body></html>';
const APP_SHELL_PAGE = appShellPage(true);
/** REV-AUD3 の I-2: 押すと、本文の隠れたリンクより前に、隠れたリンクを足すメニュー（開いた状態の点検で、同じ隠れたリンクを読み直す）。 */
const MENU_PAGE = `${markedHead('menu')}<header id="h"><button type="button" id="mb" aria-expanded="false">メニュー</button></header>`
  + `<main id="main"><h1>見出し</h1>${hiddenLink('broken', 40)}<p>本文</p></main>`
  + '<script>document.getElementById("mb").addEventListener("click", (e) => { e.target.setAttribute("aria-expanded", "true");'
  + ' const a = document.createElement("a"); a.href = "#m"; a.textContent = "メニューの隠れ"; a.style.cssText = "position: absolute; left: -9999px; top: 0";'
  + ' document.getElementById("h").append(a); });</script></body></html>';

/**
 * RVP-1・RVP-2: 右半分に開いたままの前面の窓（大きな role="dialog"。モーダルの印も暗転もない）と、左上の固定の帯。フォーカスで窓の下へ出るリンクと、帯の下へ
 * 出るリンク。`trap` なら、窓の最後のボタンで Tab を窓の先頭へ戻す（Tab で背後へ抜けない）。
 */
const sheetPage = (trap: boolean): string => `${markedHead(trap ? 'sheet trap' : 'sheet')}`
  + '<style>.skip { position: absolute; left: -9999px; top: 40px; } #behind:focus { left: 60%; } #under-banner:focus { left: 8px; top: 8px; }</style>'
  + '<a id="behind" class="skip" href="#main">一覧へ</a><a id="under-banner" class="skip" href="#main">本文へ</a>'
  + '<div id="banner" style="position: fixed; left: 0; top: 0; width: 40%; height: 80px; background: #eee; z-index: 5">お知らせ</div>'
  + '<main id="main"><h1>一覧</h1><p style="margin-left: 55%">行の説明です。</p></main>'
  + '<div id="sheet" role="dialog" aria-label="詳しい内容" style="position: fixed; top: 0; right: 0; width: 50%; height: 100%; background: #fff; z-index: 10">'
  + '<h2>詳しい内容</h2><button type="button" id="sheet-first">前へ</button><button type="button" id="sheet-last">次へ</button></div>'
  + '<script>const first = document.getElementById("sheet-first"); first.focus();'
  + (trap ? ' document.getElementById("sheet-last").addEventListener("keydown", (e) => { if (e.key === "Tab") { e.preventDefault(); first.focus(); } });' : '')
  + '</script></body></html>';

/**
 * FRET: 窓（モーダルの印つきの role="dialog"）を開くボタンの画面の終わり。`modes` は、押したボタンの id ごとの窓の振る舞い（`return`: Esc で閉じてボタンへ戻す、
 * `body`: Esc で閉じて戻さない（body に落ちる）、`stay`: 開いてもフォーカスを移さない、`button`: Esc では閉じず閉じるボタンで閉じて戻す、`gone`: 開くとボタンを消す、
 * `stuck`: 閉じない、`move`: path を変える、`confirm`: 削除の確かめの窓（Esc では閉じず、閉じるボタンは押すと削除を送る））。開くと、読み取りでない送信を出す。
 */
const dialogScript = (modes: Readonly<Record<string, string>>): string => '<div id="w" role="dialog" aria-modal="true" aria-label="窓" hidden '
  + 'style="position: fixed; left: 10%; top: 10%; width: 80%; height: 60%; background: #fff"><p>中身</p><button type="button" id="inner">中</button>'
  + '<button type="button" id="close" hidden>閉じる</button></div><script>const w = document.getElementById("w"); const close = document.getElementById("close");'
  + ` const modes = ${JSON.stringify(modes)}; let mode = null; let opener = null;`
  + ' const shut = () => { w.hidden = true; if (["return", "stay", "button"].includes(mode)) opener.focus(); mode = null; };'
  + ' for (const [id, m] of Object.entries(modes)) { const b = document.getElementById(id); b.addEventListener("click", (e) => { e.preventDefault();'
  + ' if (m === "move") { history.pushState({}, "", "/moved"); return; } mode = m; opener = b; w.hidden = false; close.hidden = m !== "button" && m !== "confirm";'
  + ' w.querySelector("p").textContent = m === "confirm" ? "この項目を削除しますか？" : "中身"; fetch("/api/opened", { method: "POST", body: m }).catch(() => {});'
  + ' if (m !== "stay") document.getElementById("inner").focus(); if (m === "gone") b.remove(); }); }'
  + ' document.addEventListener("keydown", (e) => { if (e.key === "Escape" && mode !== null && !["button", "stuck", "confirm"].includes(mode)) shut(); });'
  + ' close.addEventListener("click", () => { if (mode === "confirm") fetch("/api/confirm-delete", { method: "DELETE" }).catch(() => {}); shut(); });</script></body></html>';
/**
 * FRET: 確かめる物と押さない物（メニューの印・送信の要素・削除とログアウトの名前・削除の送り先の印・AI の名前）。閉じない窓（削除の確かめの窓）は最後。
 */
const DIALOG_PAGE = `${markedHead('dialogs')}<main id="main"><h1>窓</h1>`
  + ['return', 'body', 'stay', 'button', 'gone'].map((id) => `<button type="button" id="${id}" aria-haspopup="dialog">${id}</button>`).join('')
  + '<button type="button" id="menu" aria-haspopup="menu">メニュー</button><form><button id="submit" aria-haspopup="dialog">送る</button></form>'
  + '<button type="button" id="danger" aria-haspopup="dialog">削除</button><button type="button" id="logout" aria-haspopup="dialog">ログアウト</button>'
  + '<button type="button" id="hx" aria-haspopup="dialog" hx-delete="/api/items/9">開く</button>'
  + '<button type="button" id="method" aria-haspopup="dialog" data-method="delete">開く</button>'
  + '<button type="button" id="ai" aria-haspopup="dialog">AIで要約</button><button type="button" id="confirm" aria-haspopup="dialog">確かめ</button></main>'
  + dialogScript({
    return: 'return', body: 'body', stay: 'stay', button: 'button', gone: 'gone', menu: 'return', submit: 'return', danger: 'return', logout: 'return', hx: 'return',
    method: 'return', ai: 'return', confirm: 'confirm',
  });
/** FRETWS: 窓を開くと、ページが新しい WebSocket を開く画面（ほかの送信は出さない。Esc で閉じてボタンへ戻す）。 */
const WEBSOCKET_DIALOG_PAGE = `${markedHead('ws dialog')}<main id="main"><h1>窓</h1><button type="button" id="live" aria-haspopup="dialog">お知らせ</button></main>`
  + '<div id="w" role="dialog" aria-modal="true" aria-label="窓" hidden style="position: fixed; left: 10%; top: 10%; width: 80%; height: 60%; background: #fff">'
  + '<p>中身</p><button type="button" id="inner">中</button></div><script>const w = document.getElementById("w"); const live = document.getElementById("live");'
  + ' live.addEventListener("click", () => { w.hidden = false; document.getElementById("inner").focus();'
  + ' try { new WebSocket("ws://" + location.host + "/ws/dialog"); } catch { /* 止められた */ } });'
  + ' document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !w.hidden) { w.hidden = true; live.focus(); } });</script></body></html>';
/** FRET: 同じ型の画面（共通の枠の中の物と、本文の物と、path を変える物）。 */
const ITEM_PAGE = `${markedHead('item')}<header><nav><button type="button" id="help" aria-haspopup="dialog">ヘルプ</button></nav></header>`
  + '<main id="main"><h1>項目</h1><button type="button" id="detail" aria-haspopup="dialog">詳しく</button>'
  + '<button type="button" id="next" aria-haspopup="dialog">次へ</button></main>' + dialogScript({ help: 'return', detail: 'return', next: 'move' });

const received: string[] = [];
let browser: Browser;
let server: LoopbackHttpServer | undefined;
const temporaryDirectories: string[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  const leftover = testContextsOf(browser);
  for (const context of leftover) {
    await context.close();
  }
  await server?.close();
  server = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftover, 'Contexts left in the browser after the test').toHaveLength(0);
});

const normalized = (url: string, config: AuditConfig): NormalizedHttpUrlEvidence => {
  const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
  if (!result.ok) {
    throw new Error(`fixture URL must normalize: ${url}`);
  }
  return result.url;
};

/** 1 つの画面を監査する（画像あり。axe・性能・操作の点検なし）。page.json の形も確かめる。 */
async function auditPage(
  path: string,
  html: string,
  stressWidths: readonly number[],
  options: {
    readonly frames?: Readonly<Record<string, string>>;
    readonly interactions?: boolean;
    readonly quietLimitMs?: number;
    /** FRET: 同じ Page Auditor（同じ Run）で続けて監査する path（中身は `frames`）と、その結果を入れる所。 */
    readonly next?: { readonly paths: readonly string[]; readonly outcomes: PageAuditOutcome[] };
  } = {},
): Promise<PageAuditOutcome> {
  received.length = 0;
  server = await startLoopbackHttpServer((request, response) => {
    received.push(request.url ?? '');
    const body = request.url === path ? html : options.frames?.[request.url ?? ''];
    if (body !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
      return;
    }
    response.writeHead(404).end();
  });
  // FRETWS: サーバに届いた WebSocket の接続の求めも数える（つながない）。
  server.server.on('upgrade', (request: { readonly url?: string }, socket: { destroy: () => void }) => {
    received.push(`UPGRADE ${request.url ?? ''}`);
    socket.destroy();
  });
  const { origin } = server;
  const config = createTestConfig(origin, '/', {
    viewports: { stressWidths: [...stressWidths] },
    audit: { interactions: options.interactions ?? false, performance: false, screenshots: true, accessibility: false },
  });
  const allocator = new IdAllocator();
  const root = await mkdtemp(join(tmpdir(), 'beaksight-focus-'));
  temporaryDirectories.push(root);
  const auditor = new PageAuditor({
    contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory: root,
    navigationPacer: createTestNavigationPacer(config),
    safetyViolationRecorded: () => false,
    ...(options.quietLimitMs === undefined ? {} : { progressWatchQuietLimitMs: options.quietLimitMs }),
  });
  const outcome = await auditor.audit(normalized(`${origin}${path}`, config), allocator.allocatePageId());
  await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });
  for (const next of options.next?.paths ?? []) {
    options.next?.outcomes.push(await auditor.audit(normalized(`${origin}${next}`, config), allocator.allocatePageId()));
  }
  return outcome;
}

describe('AUD-4d: the controls hidden until focus', () => {
  it('reads the focus at the end of the collection, reports only the control that does not appear, and points it at the focused image', async () => {
    const outcome = await auditPage('/skip-links', PAGE, [STRESS_WIDTH]);

    for (const viewport of ['desktop', 'mobile'] as const) {
      const focus = outcome.result.evidence.filter((record) => record.type === 'focus' && record.viewport === viewport);
      const main = focus.find((record) => record.type === 'focus' && record.payload.stressWidth === undefined);
      expect(main, viewport).toMatchObject({ capture: { phase: 'focus-check' } });
      const selectors = main?.type === 'focus' ? main.payload.items.map(({ selector }) => selector) : [];
      expect([...selectors].sort(), viewport).toEqual(['#broken', '#skip']);
      const findings = outcome.result.findings.filter((finding) => finding.viewport === viewport && finding.ruleId === 'FOCUSED_CONTROL_HIDDEN'
        && !finding.groupingKeys?.some(({ name }) => name === 'stressWidth'));
      expect(findings.map((finding) => finding.groupingKeys?.find(({ name }) => name === 'selector')?.value), viewport).toEqual(['#broken']);
      // 指摘は、フォーカスを当てたままの画像（段 `focus-check`）を参照する。
      const shot = outcome.result.evidence.find((record) => record.type === 'screenshot' && findings[0]?.evidenceRefs.includes(record.evidenceId));
      expect(shot, viewport).toMatchObject({ capture: { phase: 'focus-check' }, payload: { captureType: 'VIEWPORT' } });
      // 指摘の画像の参照（AUD-3d）も、その画像と、フォーカスを当てた後の要素の矩形。
      const region = findings[0] === undefined ? null : findingImageRegionIndexOf({ pages: [outcome.result] } as unknown as AuditRunResult)(findings[0]);
      expect(region, viewport).toMatchObject({ screenshotEvidenceId: shot?.evidenceId, reason: null, regions: [{ role: 'TARGET', selector: '#broken' }] });
    }
    // 幅の走査の幅でも、同じ読み取りと指摘がある。
    const stressFocus = outcome.result.evidence.find((record) => record.type === 'focus' && record.payload.stressWidth === STRESS_WIDTH);
    expect(stressFocus).toMatchObject({ viewport: 'desktop', capture: { phase: 'focus-check' } });
    // REV-AUD3: 通常の Tab の確かめは主の読み込みだけ（幅の走査の幅ではしない）。
    expect(stressFocus?.type === 'focus' ? stressFocus.payload.items.filter((item) => item.sequentialTab !== undefined) : null).toEqual([]);
    expect(outcome.result.findings.some((finding) => finding.ruleId === 'FOCUSED_CONTROL_HIDDEN'
      && finding.groupingKeys?.some(({ name, value }) => name === 'stressWidth' && value === String(STRESS_WIDTH)))).toBe(true);

    // AUD-4c: tel: のリンクは指摘にしない。リンクの記録は残る。
    expect(outcome.result.findings.some((finding) => finding.ruleId === 'UNSUPPORTED_URL_SCHEME')).toBe(false);
    const links = outcome.result.evidence.find((record) => record.type === 'link');
    expect(links?.type === 'link' ? links.payload.links.some((link) => link.admission.kind === 'SPECIAL_SCHEME_RECORD_ONLY') : false).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('AUD-3: the kinds of the focus items and the findings tied to their own items', () => {
  it('tells the guards of a dialog from the real controls, and ties each finding, its image and its region to its own item', async () => {
    const outcome = await auditPage('/guards', GUARDS_PAGE, []);
    const focus = outcome.result.evidence.find((record) => record.type === 'focus' && record.viewport === 'desktop');
    const items = focus?.type === 'focus' ? focus.payload.items : [];
    expect(items.map(({ tagName, kind }) => [tagName, kind]).sort()).toEqual([
      ['a', 'CONTROL'], ['button', 'CONTROL'], ['button', 'CONTROL'], ['span', 'GUARD'], ['span', 'GUARD'], ['span', 'GUARD'], ['span', 'GUARD'],
      ['span', 'UNKNOWN'], ['span', 'UNKNOWN'],
    ]);
    const findings = outcome.result.findings.filter((finding) => finding.viewport === 'desktop' && finding.ruleId === 'FOCUSED_CONTROL_HIDDEN');
    const itemOf = (finding: Finding) => items[Number(finding.groupingKeys?.find(({ name }) => name === 'focusItem')?.value)];
    // 指摘は項目ごとに 1 つ（同じ selector の 2 つのボタンも分かれる）。重さはどれも同じ。REV-AUD3 の I-2: 2 つのボタンの指摘は、同じ候補群にまとまる。
    expect(findings.map(itemOf).filter((value) => value !== undefined)).toHaveLength(items.length);
    expect(new Set(findings.map((finding) => finding.severity))).toEqual(new Set(['WARN']));
    for (const finding of findings) {
      const own = itemOf(finding);
      expect(finding.message.includes(FOCUSED_CONTROL_HIDDEN_TEXT.guardNote), own?.tagName).toBe(own?.kind === 'GUARD');
    }
    const buttons = findings.filter((finding) => itemOf(finding)?.tagName === 'button');
    expect(new Set(buttons.map((finding) => itemOf(finding)?.selector)).size).toBe(1);
    const regionOf = findingImageRegionIndexOf({ pages: [outcome.result] } as unknown as AuditRunResult);
    for (const finding of buttons) {
      expect(regionOf(finding)).toMatchObject({
        screenshotEvidenceId: itemOf(finding)?.screenshotEvidenceId,
        regions: [{ role: 'TARGET', rect: { y: itemOf(finding)?.afterRect?.top } }],
      });
    }
    // 守りの部品の指摘の候補群だけ、確信度が下がる。
    const model = buildReportViewModel(auditRun({ pages: [outcome.result] }));
    const confidences = (kind: string) => new Set(findings.filter((finding) => itemOf(finding)?.kind === kind)
      .map((finding) => model.findingGroups.find((group) => group.findingIds.includes(finding.findingId))?.confidence));
    expect([...confidences('GUARD')]).toEqual(['MEDIUM']);
    expect([...confidences('CONTROL')]).toEqual(['HIGH']);
    expect(new Set(buttons.map((finding) => model.findingGroups.find((group) => group.findingIds.includes(finding.findingId))?.groupId)).size).toBe(1);
  });

  it('REV-AUD3: does not report again in the open state a hidden link already reported on the page', async () => {
    const outcome = await auditPage('/menu', MENU_PAGE, [], { interactions: true });
    const broken = outcome.result.findings.filter((finding) => finding.viewport === 'desktop' && finding.ruleId === 'FOCUSED_CONTROL_HIDDEN'
      && finding.groupingKeys?.some(({ name, value }) => name === 'selector' && value === '#broken'));
    expect(broken).toHaveLength(1);
  });
});

describe('RVP-1・RVP-2: a control behind an open front window', () => {
  /** desktop の指摘の、Rule と目印の値の組。 */
  const reportedOf = (outcome: PageAuditOutcome): readonly string[] => outcome.result.findings
    .filter((finding) => finding.viewport === 'desktop' && (finding.ruleId === 'FOCUSED_CONTROL_HIDDEN' || finding.ruleId === 'FIXED_ELEMENT_OCCLUSION'))
    .map((finding) => `${finding.ruleId} ${finding.groupingKeys?.find(({ name }) => name === 'selector' || name === 'overlaySelector')?.value ?? ''}`);

  it('reports the control behind the window only when Tab moves there, and still reports the control under a plain fixed band', async () => {
    const escape = await auditPage('/sheet', sheetPage(false), []);
    expect([...reportedOf(escape)].sort()).toEqual(['FIXED_ELEMENT_OCCLUSION #banner', 'FOCUSED_CONTROL_HIDDEN #behind', 'FOCUSED_CONTROL_HIDDEN #under-banner']);
    const behind = escape.result.findings.find((finding) => finding.viewport === 'desktop' && finding.message.includes('#behind'));
    expect(behind?.message).toContain(FOCUSED_CONTROL_HIDDEN_TEXT.frontWindowTabNote);

    const trapped = await auditPage('/sheet-trap', sheetPage(true), []);
    expect([...reportedOf(trapped)].sort()).toEqual(['FIXED_ELEMENT_OCCLUSION #banner', 'FOCUSED_CONTROL_HIDDEN #under-banner']);
    // Tab の確かめのない指摘は、「押せません」と言い切らない。
    const banner = trapped.result.findings.find((finding) => finding.viewport === 'desktop' && finding.message.includes('#under-banner'));
    expect(banner?.message).toContain(FOCUSED_CONTROL_HIDDEN_TEXT.tabUncheckedNote);
  });
});

/** AUDR2: 主の読み込みのフォーカスの記録ごとの、通常の Tab の確かめの結果（走らなかった・確かめられなかった理由）。 */
const tabOutcomesOf = (outcome: PageAuditOutcome): readonly unknown[] => outcome.result.evidence.flatMap((record) =>
  (record.type === 'focus' && record.payload.stressWidth === undefined ? [record.payload.sequentialTabOutcome] : []));

describe('AUD-3: the sequential Tab from the top of the document', () => {
  it('lowers the confidence of the item that Tab shows, and says so for the item Tab does not reach', async () => {
    const outcome = await auditPage('/tab', TAB_PAGE, []);
    expect(keyMarks()).toBeGreaterThan(0);
    expect(tabOutcomesOf(outcome)).toEqual(['CHECKED', 'CHECKED']);
    const model = buildReportViewModel(auditRun({ pages: [outcome.result] }));
    for (const viewport of ['desktop', 'mobile'] as const) {
      const focus = outcome.result.evidence.find((record) => record.type === 'focus' && record.viewport === viewport);
      const items = focus?.type === 'focus' ? focus.payload.items : [];
      const findingOf = (selector: string) => outcome.result.findings.find((finding) => finding.viewport === viewport
        && finding.ruleId === 'FOCUSED_CONTROL_HIDDEN' && finding.groupingKeys?.some(({ name, value }) => name === 'selector' && value === selector));
      const shown = findingOf('#kbd-skip');
      const unreached = findingOf('#after-trap');
      expect(items.find(({ selector }) => selector === '#kbd-skip')?.sequentialTab, viewport).toMatchObject({ operation: 'SEQUENTIAL_TAB', reached: true });
      expect(items.find(({ selector }) => selector === '#after-trap')?.sequentialTab, viewport).toMatchObject({ operation: 'SEQUENTIAL_TAB', reached: false });
      expect(shown?.message, viewport).toContain(FOCUSED_CONTROL_HIDDEN_TEXT.tabShownNote);
      expect(unreached?.message, viewport).toContain(FOCUSED_CONTROL_HIDDEN_TEXT.tabUnreachedNote);
      const confidenceOf = (finding: Finding | undefined) => model.findingGroups.find((group) => group.findingIds.includes(finding?.findingId ?? ('' as never)))?.confidence;
      expect([confidenceOf(shown), confidenceOf(unreached)], viewport).toEqual(['MEDIUM', 'HIGH']);
    }
  });

  it('REV-AUD3: leaves the items unjudged when Tab goes into a frame, instead of calling an item reachable from the top unreached', async () => {
    const outcome = await auditPage('/iframe', IFRAME_PAGE, [], { frames: { '/frame': FRAME } });
    const items = outcome.result.evidence.flatMap((record) => (record.type === 'focus' ? record.payload.items : []));
    // 枠の後のリンクも、文書の先頭からなら枠を抜けて届く（確かめられないので「届かない」と決めない）。
    expect(items.map(({ sequentialTab }) => sequentialTab?.reached)).not.toContain(false);
    // AUDR2: 確かめられなかった理由を残す。
    expect(tabOutcomesOf(outcome)).toEqual(['FRAME', 'FRAME']);
    // AUDR2 の調べ: 管理画面の形では、守りの部品がフォーカスを根の中の端へ戻すので、Tab が文書の外へ出ず、始めを作れない。
    expect(tabOutcomesOf(await auditPage('/shell', APP_SHELL_PAGE, []))).toEqual(['NO_START', 'NO_START']);
    // 始めの守りの部品だけがフォーカスを移す形も、先頭から届くリンクを「届かない」と決めず、始めを作れないとして記録を変えない。
    const startGuardOnly = await auditPage('/shell-start', appShellPage(false), []);
    expect(tabOutcomesOf(startGuardOnly)).toEqual(['NO_START', 'NO_START']);
    expect(startGuardOnly.result.evidence.flatMap((record) => (record.type === 'focus' ? record.payload.items : [])).map(({ sequentialTab }) => sequentialTab?.reached))
      .not.toContain(false);
  });

  it('REV-AUD3: stops Tab on a screen that adds a focusable element on each move, and leaves the items unjudged', async () => {
    const outcome = await auditPage('/grow', GROW_PAGE, []);
    const items = outcome.result.evidence.flatMap((record) => (record.type === 'focus' ? record.payload.items : []));
    expect(items.map(({ sequentialTab }) => sequentialTab)).toEqual(items.map(() => undefined));
    expect(tabOutcomesOf(outcome)).toEqual(['NEW_ELEMENT', 'NEW_ELEMENT']);
    // 押すたびに要素が増え続けても、押し続けない（画面の要素の上限まで押さない）。
    expect(keyMarks()).toBeLessThan(10);
  });

  it('REV-AUD3: ends the check on a screen whose position never settles, keeps the item as unsettled, and goes on', async () => {
    const outcome = await auditPage('/spin', SPIN_PAGE, [], { quietLimitMs: TEST_RUN_PROGRESS_QUIET_LIMIT_MS });
    const items = outcome.result.evidence.flatMap((record) => (record.type === 'focus' && record.viewport === 'desktop' ? record.payload.items : []));
    expect(items.map(({ unsettled }) => unsettled)).toEqual([true]);
    // 見張りで終わるのは直の focus の段だけ（Tab の確かめを始めず、反応なしの待ちを重ねない）。
    expect(outcome.result.viewports.desktop.incompleteReasons.filter(({ detail }) => detail === 'focus-check')).toHaveLength(1);
    // AUDR2: 見張りで終わって走らなかったことを残す。
    expect(tabOutcomesOf(outcome)[0]).toBe('WATCH_ENDED');
  });

  it('FRET: presses only the buttons that open a window, records where the focus goes after closing it, and presses the same one once in a run', async () => {
    const outcome = await auditPage('/dialogs', DIALOG_PAGE, []);
    const dialogOf = (result: PageAuditOutcome, viewport: string) => result.result.evidence
      .flatMap((record) => (record.type === 'focus' && record.viewport === viewport && record.payload.stressWidth === undefined ? [record.payload.dialogFocus] : []))[0];
    for (const viewport of ['desktop', 'mobile'] as const) {
      const dialog = dialogOf(outcome, viewport);
      expect(dialog?.status, viewport).toBe('NOT_CLOSABLE');
      expect(dialog?.items.map(({ selector, outcome: result, focusMovedIntoWindow, closedBy, focusAfterClose }) =>
        [selector, result, focusMovedIntoWindow, closedBy, focusAfterClose]), viewport).toEqual([
        ['#return', 'CHECKED', true, 'ESCAPE', 'TRIGGER'],
        ['#body', 'CHECKED', true, 'ESCAPE', 'BODY'],
        ['#stay', 'CHECKED', false, 'ESCAPE', 'TRIGGER'],
        ['#button', 'CHECKED', true, 'CLOSE_BUTTON', 'TRIGGER'],
        ['#gone', 'CHECKED', true, 'ESCAPE', 'TRIGGER_GONE'],
        ['#confirm', 'CHECKED', true, 'NOT_CLOSABLE', null],
      ]);
      expect(outcome.result.findings.filter((finding) => finding.viewport === viewport && finding.ruleId.startsWith('DIALOG_'))
        .map((finding) => `${finding.ruleId} ${finding.groupingKeys?.find(({ name }) => name === 'selector')?.value ?? ''}`).sort(), viewport).toEqual([
        'DIALOG_FOCUS_NOT_MOVED #stay', 'DIALOG_FOCUS_NOT_RETURNED #body', 'DIALOG_NOT_CLOSABLE_BY_KEYBOARD #confirm',
      ]);
    }
    // 押す期間に窓を開いた画面が出した送信も、削除の確かめの窓の閉じるボタンの削除も、サイトに届かない。
    expect(received.filter((url) => url.startsWith('/api/'))).toEqual([]);

    const next: PageAuditOutcome[] = [];
    const first = await auditPage('/items/1', ITEM_PAGE, [], { frames: { '/items/2': ITEM_PAGE }, next: { paths: ['/items/2'], outcomes: next } });
    expect(dialogOf(first, 'desktop')).toMatchObject({ status: 'NAVIGATED', pressableCount: 3, alreadyCheckedCount: 0 });
    expect(dialogOf(first, 'desktop')?.items.map(({ selector, outcome: result }) => `${selector} ${result}`)).toEqual(['#help CHECKED', '#detail CHECKED', '#next NAVIGATED']);
    // 同じ型の 2 枚目の画面では、共通の枠の中の物も本文の物も、押さない。
    expect(next[0] === undefined ? null : dialogOf(next[0], 'desktop')).toEqual({ status: 'COMPLETE', pressableCount: 3, alreadyCheckedCount: 3, items: [] });
  });

  // FRETWS（設計書 `2026-11-25-beaksight-discovery-sibling-press-design.md` 2.2）: 押す期間に止めた接続は、押下の記録で、安全の指摘にしない。
  it('FRETWS: records a WebSocket opened in the press period as a press block, counts it on the item, and makes no safety finding of it', async () => {
    const outcome = await auditPage('/ws-dialog', WEBSOCKET_DIALOG_PAGE, []);
    const items = outcome.result.evidence.flatMap((record) => (record.type === 'focus' && record.payload.stressWidth === undefined
      ? record.payload.dialogFocus?.items ?? [] : []));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.guardBlockedCount ?? 0, item.selector).toBeGreaterThanOrEqual(1);
    const blocked = outcome.result.evidence.flatMap((record) => (record.type === 'safety' ? record.payload.blockedWebSockets : []));
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.filter(({ reason }) => reason !== 'SCROLL_KEY_PRESS_RESTRICTED')).toEqual([]);
    expect(outcome.result.findings.filter((finding) => finding.ruleId === 'SAFETY_WEBSOCKET_BLOCKED')).toEqual([]);
    expect(received.filter((url) => url.startsWith('UPGRADE') || url.startsWith('/api/'))).toEqual([]);
  });

  it('does not press Tab on a screen without an item that stays hidden on focus', async () => {
    const outcome = await auditPage('/none', NO_CANDIDATE_PAGE, []);
    expect(outcome.result.findings.filter((finding) => finding.ruleId === 'FOCUSED_CONTROL_HIDDEN')).toEqual([]);
    expect(keyMarks()).toBe(0);
    expect(tabOutcomesOf(outcome)).toEqual(['NO_CANDIDATES', 'NO_CANDIDATES']);
  });
});

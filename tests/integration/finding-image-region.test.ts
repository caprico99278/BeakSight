// AUD-3d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-3d）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// 幅の走査の各幅で viewport の画像を撮り、その幅で見つかった覆いの指摘に、その幅の画像の参照と、画像の座標の矩形が付く。矩形が画像の上の要素の位置と合う。
// EV-2（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 画面の下の方と内側の領域の中の、重なり・フォーカスの指摘は、対象まで動かして
// 撮った画像を参照し、対象が画像に入る。固定の枠の覆いは、末尾でも隠れる覆いと、初めの位置だけの覆いを分けて文にする。
// EV-4（同じ設計書 3.4）: 見切れた文字と横にスクロールする領域の指摘も、対象まで動かして撮った画像を参照する。領域は、Tab で届くか・矢印のキーで動くかを試し、
// 前と後の位置を記録して元へ戻す。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { artifactFilePath } from '../../src/core/artifact-layout.js';
import type { AuditRunResult, Finding } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence, RevealCaptureEvidence, RevealTargetSpec } from '../../src/core/evidence-types.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../../src/core/observation-windows.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { checkScrollableRegions, revealAndCapture } from '../../src/evidence/reveal-and-capture.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { FIXED_OCCLUSION_REVEAL_TEXT, FIXED_OVERLAP_TEXT } from '../../src/presentation/messages.js';
import { findingImageRegionIndexOf } from '../../src/core/finding-image-regions.js';
import { scrollKeyPressGuardOf } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { readPngPixels } from '../helpers/png-pixels.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 3 * 60_000;
const STRESS_WIDTH = 800;
/** 覆いの色（画像の上で見分ける）。 */
const RED: readonly [number, number, number] = [255, 0, 0];

// 固定のヘッダの landmark（通知の枠に数えないので隠されない）が、内容を覆う。
const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>red header</title>'
  + '<style>html, body { margin: 0; background: #fff; } main { padding: 8px; }</style></head><body>'
  + '<header id="cover" style="position: fixed; top: 0; left: 0; width: 100%; height: 300px; background: rgb(255, 0, 0); z-index: 10"><p>ヘッダです。</p></header>'
  + '<main><h1 id="title">見出し</h1><p>本文です。</p><p id="wide" style="width: 1000px">幅の走査の幅でだけ、はみ出す段落です。</p></main></body></html>';

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

// AUD-3d の続き: 代替の文のない画像（axe の違反）を、決まった位置に置く。
const MISSING_ALT_PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>missing alt</title>'
  + '<style>html, body { margin: 0; background: #fff; }</style></head><body><main><h1>見出し</h1>'
  + '<img id="no-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==" width="50" height="40"'
  + ' style="position: absolute; left: 100px; top: 120px"></main></body></html>';

// EV-2: 重なる 2 つの画像（青の下半分に緑が重なる）。透明な 1 px の画像を広げ、背景の色で見分ける。
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const GREEN: readonly [number, number, number] = [0, 128, 0];
const MAGENTA: readonly [number, number, number] = [255, 0, 255];
const pairOf = (prefix: string): string => `<img id="${prefix}-a" alt="" src="${PIXEL}" style="display: block; width: 200px; height: 100px; background: rgb(0, 0, 255)">`
  + `<img id="${prefix}-b" alt="" src="${PIXEL}" style="display: block; width: 200px; height: 100px; margin-top: -50px; background: rgb(0, 128, 0)">`;
const EV2_HEAD = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>EV-2</title></head>';
// EV-4: 見切れた文字（緑）と、横にスクロールする 3 つの領域（マゼンタ。Tab で届く・届かない・届くが矢印のキーを止める）。前と後にリンク。
// REV-EV4: 矢印のキーを止める handler は、BeakSight の止めより先に付いた window の capture の段（ページの handler は BeakSight の止めの後には届かない）。
const LONG_TEXT = '横に長い文字です。'.repeat(40);
const regionOf = (id: string, attributes: string): string => `<div id="${id}"${attributes} style="width: 300px; height: 40px; overflow-x: auto; overflow-y: hidden;`
  + ` white-space: nowrap; margin-top: 16px; background: rgb(255, 0, 255); color: rgb(255, 0, 255)">${LONG_TEXT}</div>`;
const CLIPPED_AND_SCROLL_REGIONS = '<script>addEventListener("keydown", (e) => { if (e.target.id === "stopped" && e.key.startsWith("Arrow")) e.preventDefault(); }, true);'
  + '</script><a id="before" href="#b">前</a>'
  + `<p id="clip" style="width: 150px; height: 24px; overflow: hidden; white-space: nowrap; margin: 0; background: rgb(0, 128, 0); color: rgb(0, 128, 0)">${LONG_TEXT}</p>`
  + `${regionOf('plain', '')}${regionOf('minus', ' tabindex="-1"')}${regionOf('stopped', '')}`
  + '<a id="after" href="#a">後</a><div style="height: 600px"></div>';
// 文書の下の方の内側の領域（重なりの下半分が領域の端で切れる）と、その中の、覆われた 1 px のリンク。さらに下の重なり（Y が 3,000 px を超える）。
// EV-4: その下に、見切れた文字と横にスクロールする領域。
const DEEP_PAGE = `${EV2_HEAD}<body style="margin: 0"><main><h1>見出し</h1>`
  + '<div id="inner" style="position: relative; height: 300px; overflow: auto; margin-top: 1200px"><div style="height: 220px"></div>'
  + `${pairOf('in')}<div style="height: 600px"></div>`
  + '<div style="height: 40px"><a id="tiny" href="#z" style="display: inline-block; width: 1px; height: 1px; overflow: hidden">x</a></div>'
  + '<div style="position: absolute; left: 0; top: 960px; width: 60px; height: 40px; background: rgb(255, 0, 255)"></div>'
  + '<div style="height: 600px"></div></div>'
  + `<div style="height: 2000px"></div>${pairOf('deep')}<div style="height: 400px"></div>${CLIPPED_AND_SCROLL_REGIONS}</main></body></html>`;
// 動かせない短い文書の、下の固定の帯に隠れたボタン（末尾でも隠れる）。
const FOOTER_PAGE = `${EV2_HEAD}<body style="margin: 0"><main><h1>見出し</h1><div style="height: 680px"></div>`
  + '<button id="buy" type="button" style="display: block; width: 200px; height: 40px">購入</button></main>'
  + '<footer id="foot" style="position: fixed; left: 0; right: 0; bottom: 0; height: 150px; background: rgb(255, 0, 0); z-index: 10">下部</footer></body></html>';
// 動かすと消える上の帯に隠れた見出し（初めの位置だけ）。
const BANNER_PAGE = `${EV2_HEAD}<body style="margin: 0">`
  + '<header id="banner" style="position: fixed; top: 0; left: 0; width: 100%; height: 200px; background: rgb(255, 0, 0); z-index: 10">お知らせ</header>'
  + '<main><h1 id="title" style="margin: 100px 0 0">見出し</h1><div style="height: 3000px"></div></main>'
  + '<script>addEventListener(\'scroll\', () => { document.getElementById(\'banner\').style.display = scrollY > 0 ? \'none\' : \'block\'; });</script>'
  + '</body></html>';
// REV-EV12 の I-2: 固定のヘッダの真下（先頭）の重なりと、overflow: hidden の箱で半分が切られた重なり。
const COVERED_AND_CLIPPED_PAGE = `${EV2_HEAD}<body style="margin: 0">`
  + '<header style="position: fixed; top: 0; left: 0; right: 0; height: 260px; background: rgb(255, 0, 0); z-index: 5">帯</header>'
  + `<main><div style="height: 20px"></div>${pairOf('ft')}<div style="height: 1200px"></div>`
  + `<div style="width: 300px; overflow: hidden"><div style="padding-left: 200px">${pairOf('cl')}</div></div><div style="height: 2000px"></div></main></body></html>`;
// REV-EV12 の I-1: 動かせない短い文書の、下の固定の帯に並んで隠れた 2 つのボタン。
const FOOTER_TWO_PAGE = `${EV2_HEAD}<body style="margin: 0"><main><h1>見出し</h1><div style="height: 680px"></div>`
  + '<button id="buy" type="button" style="width: 200px; height: 40px">購入</button><button id="ask" type="button" style="width: 200px; height: 40px">質問</button></main>'
  + '<footer id="foot" style="position: fixed; left: 0; right: 0; bottom: 0; height: 150px; background: rgb(255, 0, 0); z-index: 10">下部</footer></body></html>';
// 部品を直に流す画面: 下に、入力欄の後ろの領域（入力欄で Tab を止める）を足す。
const SCROLL_REGION_PAGE = `${EV2_HEAD}<body style="margin: 0"><main><h1>見出し</h1><div style="height: 2400px"></div>${CLIPPED_AND_SCROLL_REGIONS}`
  + `<textarea id="note">メモ</textarea>${regionOf('behind-input', '')}</main></body></html>`;
// REV-EV4: 矢印のキーで画面を移すページの JS（文書の handler・先に付いた window の capture の handler・window.open）、Tab で字下げする影の木の入力欄、
// 領域を含むフォーカスできる祖先。
const linkOf = (id: string): string => `<a id="${id}" href="#${id}">${id}</a>`;
// ポップアップは、読み込みの時に控えた window.open で開く（BeakSight のページの中の止めを通らず、Guard が止める）。
const SCROLL_KEY_PAGE = `${EV2_HEAD}<body style="margin: 0"><script>const openSaved = window.open;`
  + 'addEventListener("keydown", (e) => { if (e.key !== "ArrowRight") return; if (e.target.id === "nav-early") location.href = "/moved-early";'
  + ' if (e.target.id === "pop-early") openSaved("/popup"); }, true);</script><main><h1>見出し</h1><div style="height: 1600px"></div>'
  + `${linkOf('l1')}${regionOf('nav-doc', '')}${linkOf('l2')}${regionOf('nav-early', '')}${linkOf('l3')}${regionOf('pop-early', '')}`
  + `${linkOf('l4')}<x-ed id="ed"></x-ed>${regionOf('behind-shadow', '')}${linkOf('l5')}<section id="sec" tabindex="0">${regionOf('in-section', '')}</section>`
  + `${linkOf('l6')}<div style="height: 600px"></div></main><script>`
  + 'document.addEventListener("keydown", (e) => { if (e.key === "ArrowRight" && e.target.id === "nav-doc") location.href = "/moved"; });'
  + 'customElements.define("x-ed", class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "open" });'
  + ' root.innerHTML = "<textarea id=in>t</textarea>"; root.querySelector("textarea").addEventListener("keydown", (e) => {'
  + ' if (e.key === "Tab") { e.preventDefault(); e.target.value += "+"; } }); } });</script></body></html>';
// REV-EV3 の M-1: 200 px より下へ動かすと消える上の告知に、先頭のリンクが隠れる（消える位置ではリンクは画面の外）。
const HIDE_BANNER_PAGE = `${EV2_HEAD}<body style="margin: 0">`
  + '<div id="bn" style="position: fixed; top: 0; left: 0; right: 0; height: 120px; background: rgb(255, 0, 0); z-index: 10">お知らせ</div>'
  + '<main><a id="toplink" href="#x" style="display: block; margin-top: 20px; width: 300px; height: 40px">はじめのリンク</a><div style="height: 3000px"></div></main>'
  + '<script>addEventListener(\'scroll\', () => { document.getElementById(\'bn\').style.display = scrollY > 200 ? \'none\' : \'block\'; });</script></body></html>';
// TII（DEF-285）: 横にスクロールする道具の並びの、ボタン（中に span と svg）と選択の欄の重なり。祖先の overflow が効かない 4 つの形（inline・既定が inline の
// custom element・display: contents・包含ブロックが外にある absolute の入れ物）と、選択の欄が sticky の並び（画面の中で見えている形と、画面の下の端に
// かかる形。並びを動かすと重なりが消える）。
const toolPairOf = (prefix: string, selectStyle = ''): string => `<button id="${prefix}-a" style="flex: none; width: 110px; height: 36px">`
  + `<span>道具</span><svg width="16" height="16"><rect width="16" height="16"></rect></svg></button>`
  + `<select id="${prefix}-b" style="flex: none; width: 120px; height: 36px; margin-left: -40px;${selectStyle}"><option>選ぶ</option></select>`;
const toolBarOf = (inner: string, style = ''): string => `<div style="display: flex; gap: 8px; width: 600px; padding: 8px; overflow-x: auto;${style}">${inner}`
  + `${'<button style="flex: none; width: 110px; height: 36px">他</button>'.repeat(12)}</div>`;
const stickyBarOf = (prefix: string, style: string): string => toolBarOf(
  `<select id="${prefix}-b" style="flex: none; width: 120px; height: 36px; position: sticky; left: 0; z-index: 1"><option>選ぶ</option></select>`
    + `${'<button style="flex: none; width: 110px; height: 36px">他</button>'.repeat(6)}<button id="${prefix}-a" style="flex: none; width: 110px; height: 36px">`
    + '<span>道具</span><svg width="16" height="16"><rect width="16" height="16"></rect></svg></button>',
  style,
).replace('<div ', `<div id="${prefix}-bar" `);
const TOOLBAR_PAGE = `${EV2_HEAD}<body style="margin: 0">`
  + `<span style="overflow: hidden">${toolBarOf(toolPairOf('in'))}</span>`
  + `<x-bar style="overflow-x: hidden">${toolBarOf(toolPairOf('ce'))}</x-bar>`
  + `<div style="display: contents; overflow: hidden">${toolBarOf(toolPairOf('dc'))}</div>`
  + stickyBarOf('sv', '')
  + `<div style="overflow: hidden; height: 0"><div style="position: absolute; left: 0; top: 400px">${toolBarOf(toolPairOf('ab'))}</div></div>`
  + stickyBarOf('fb', ' position: absolute; left: 0; top: 772px')
  + '<div style="height: 3000px"></div><script>for (const id of ["sv", "fb"]) { const bar = document.getElementById(`${id}-bar`);'
  + ' for (let i = 0; i < 3; i += 1) bar.scrollLeft += document.getElementById(`${id}-a`).getBoundingClientRect().left'
  + ' - (document.getElementById(`${id}-b`).getBoundingClientRect().right - 60); }</script></body></html>';
const EV2_PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/deep': DEEP_PAGE, '/footer-end': FOOTER_PAGE, '/banner-initial': BANNER_PAGE, '/hide-banner': HIDE_BANNER_PAGE,
  '/covered-and-clipped': COVERED_AND_CLIPPED_PAGE, '/footer-two': FOOTER_TWO_PAGE, '/scroll-region': SCROLL_REGION_PAGE,
  '/scroll-keys': SCROLL_KEY_PAGE, '/toolbar': TOOLBAR_PAGE,
});
/** サーバが受けた要求の path（REV-EV4: キーで移る先へ届いていないかを見る）。 */
const receivedPaths: string[] = [];

const startPages = async (): Promise<string> => {
  receivedPaths.splice(0);
  server = await startLoopbackHttpServer((request, response) => {
    receivedPaths.push(request.url ?? '');
    const body = request.url === '/red-header' ? PAGE : request.url === '/missing-alt' ? MISSING_ALT_PAGE : EV2_PAGES[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return server.origin;
};

describe('AUD-3d: the rectangle of an axe finding', () => {
  it('records the rectangle of the axe target, and points the finding at the image of the same state with that rectangle', async () => {
    const origin = await startPages();
    const config = createTestConfig(origin, '/', {
      viewports: { stressWidths: [] },
      audit: { interactions: false, performance: false, screenshots: true, accessibility: true },
    });
    const allocator = new IdAllocator();
    const root = await mkdtemp(join(tmpdir(), 'beaksight-image-region-'));
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
    });
    const outcome = await auditor.audit(normalized(`${origin}/missing-alt`, config), allocator.allocatePageId());
    const finding = outcome.result.findings.find((candidate) => candidate.viewport === 'desktop' && candidate.ruleId === 'A11Y_IMAGE_ALT');
    expect(finding).toBeDefined();
    const region = finding === undefined ? null : findingImageRegionIndexOf({ pages: [outcome.result] } as unknown as AuditRunResult)(finding);
    expect(region).toMatchObject({ reason: null, regions: [{ role: 'TARGET', rect: { x: 100, y: 120, width: 50, height: 40 } }] });
    const shot = outcome.result.evidence.find((record) => record.evidenceId === region?.screenshotEvidenceId);
    expect(shot).toMatchObject({ type: 'screenshot', viewport: 'desktop', payload: { captureType: 'VIEWPORT' } });
    expect(shot?.capture?.phase).not.toBe('recheck');
  }, TEST_TIMEOUT_MS);
});

describe('AUD-3d: the image and the region of a finding at a width of the stress sweep', () => {
  it('takes the image of each width, and points the finding of that width at the image with the rectangle of the element', async () => {
    const origin = await startPages();
    const config = createTestConfig(origin, '/', {
      viewports: { stressWidths: [STRESS_WIDTH] },
      audit: { interactions: false, performance: false, screenshots: true, accessibility: false },
    });
    const allocator = new IdAllocator();
    const root = await mkdtemp(join(tmpdir(), 'beaksight-image-region-'));
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
    });
    const outcome = await auditor.audit(normalized(`${origin}/red-header`, config), allocator.allocatePageId());

    // 幅の画像の Evidence（段 `stress-layout`、Desktop の読み込みの状態 ID）。
    const layout = outcome.result.evidence.find((record) => record.viewport === 'desktop' && record.type === 'layout' && record.capture?.phase !== 'recheck');
    const widthShot = outcome.result.evidence.find((record) => record.type === 'screenshot' && record.payload.stressWidth === STRESS_WIDTH);
    expect(widthShot).toMatchObject({
      viewport: 'desktop',
      payload: { captureType: 'VIEWPORT', stressWidth: STRESS_WIDTH },
      capture: { phase: 'stress-layout', stateId: layout?.capture?.stateId },
    });

    // その幅の覆いの指摘は、その幅の画像を参照し、覆う要素の矩形を持つ。
    const finding = outcome.result.findings.find((candidate) => candidate.ruleId === 'FIXED_ELEMENT_OCCLUSION'
      && candidate.groupingKeys?.some(({ name, value }) => name === 'stressWidth' && value === String(STRESS_WIDTH)));
    expect(finding).toBeDefined();
    const region = finding === undefined ? null : findingImageRegionIndexOf({ pages: [outcome.result] } as unknown as AuditRunResult)(finding);
    expect(region).toMatchObject({ screenshotEvidenceId: widthShot?.evidenceId, stressWidth: STRESS_WIDTH, reason: null });
    const overlay = region?.regions.find((entry) => entry.role === 'OVERLAY');
    expect(overlay).toMatchObject({ selector: '#cover', rect: { x: 0, y: 0, width: STRESS_WIDTH, height: 300 } });
    expect(region?.regions.some((entry) => entry.role === 'COVERED' && entry.selector === '#title')).toBe(true);

    // 矩形が、画像の上の要素の位置と合う（矩形の中は覆いの色、矩形のすぐ下は違う色）。
    if (widthShot?.type !== 'screenshot' || overlay === undefined) {
      throw new Error('the width image or the region is missing');
    }
    const image = readPngPixels(artifactFilePath(root, widthShot.payload.relativePath));
    expect(image.width).toBe(STRESS_WIDTH);
    const { x, y, width, height } = overlay.rect;
    expect(image.rgbAt(x + width / 2, y + height / 2)).toEqual(RED);
    expect(image.rgbAt(x + width - 2, y + height - 2)).toEqual(RED);
    expect(image.rgbAt(x + width / 2, y + height + 4)).not.toEqual(RED);

    // AUD-4: 落ち着いた画面では、動かして撮る規則でない指摘（その幅のはみ出し）の layout と画像の両方に状態の印があり、比べたうえで保留にしない。
    const wide = outcome.result.findings.find((candidate) => candidate.ruleId === 'ELEMENT_OUTSIDE_VIEWPORT'
      && candidate.groupingKeys?.some(({ name, value }) => name === 'stressWidth' && value === String(STRESS_WIDTH)));
    const regionOf = findingImageRegionIndexOf({ pages: [outcome.result] } as unknown as AuditRunResult);
    const wideRegion = wide === undefined ? null : regionOf(wide);
    expect(wideRegion).toMatchObject({ screenshotEvidenceId: widthShot.evidenceId, holdReason: null });
    const widthLayout = layout?.type === 'layout' ? layout.payload.stressSweep?.find((entry) => entry.width === STRESS_WIDTH)?.layout : undefined;
    expect([widthLayout?.stateMark?.hiddenNotificationFrameCount, widthShot.payload.stateMark?.hiddenNotificationFrameCount]).toEqual([0, 0]);
    expect(outcome.result.findings.filter((candidate) => regionOf(candidate)?.holdReason === 'EVIDENCE_MISMATCH')).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

describe('EV-2: the image taken after moving to the target', () => {
  /** 1 つの画面を点検し、Run の結果と画像の置き場を返す（性能・操作は流さない。axe は `accessibility` のときだけ）。 */
  const auditPath = async (path: string, stressWidths: readonly number[], accessibility = false) => {
    const origin = await startPages();
    const config = createTestConfig(origin, '/', {
      viewports: { stressWidths: [...stressWidths] },
      audit: { interactions: false, performance: false, screenshots: true, accessibility },
    });
    const allocator = new IdAllocator();
    const root = await mkdtemp(join(tmpdir(), 'beaksight-reveal-'));
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
    });
    const { result } = await auditor.audit(normalized(`${origin}${path}`, config), allocator.allocatePageId());
    return { result, root, regionOf: findingImageRegionIndexOf({ pages: [result] } as unknown as AuditRunResult) };
  };
  const keyOf = (finding: Finding, name: string): string | undefined => finding.groupingKeys?.find((key) => key.name === name)?.value;

  /**
   * 指摘の画像の上の、対象の矩形（重なりは 2 つの矩形の交わり）が画像に入り、その中心が `color` であること。保留にしないこと。`targetInImage` は、ほかの部品の
   * 下に隠れた対象（覆われたままのフォーカスのリンク）では `OUTSIDE`。
   */
  const expectTargetInImage = (
    audited: Awaited<ReturnType<typeof auditPath>>,
    finding: Finding | undefined,
    color: readonly [number, number, number],
    targetInImage: 'INSIDE' | 'OUTSIDE' = 'INSIDE',
  ): void => {
    expect(finding).toBeDefined();
    const region = finding === undefined ? null : audited.regionOf(finding);
    const shot = audited.result.evidence.find((record) => record.evidenceId === region?.screenshotEvidenceId);
    if (region === null || shot?.type !== 'screenshot') {
      throw new Error('the image of the finding is missing');
    }
    const rects = region.regions.filter((entry) => entry.role === 'TARGET').map((entry) => entry.rect);
    const left = Math.max(...rects.map((rect) => rect.x));
    const top = Math.max(...rects.map((rect) => rect.y));
    const right = Math.min(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.min(...rects.map((rect) => rect.y + rect.height));
    const image = readPngPixels(artifactFilePath(audited.root, shot.payload.relativePath));
    const placed = JSON.stringify({ left, top, right, bottom, imageWidth: image.width, imageHeight: image.height });
    expect(left >= 0 && top >= 0 && right <= image.width && bottom <= image.height, `the target is outside the image: ${placed}`).toBe(true);
    expect(image.rgbAt((left + right) / 2, (top + bottom) / 2)).toEqual(color);
    expect(region).toMatchObject({ targetInImage, holdReason: null });
  };

  it('points the overlaps far down the page and in an inner scroll area, the hidden focused link, the clipped text and the scrollable regions,'
    + ' at the images that show them, and records the keyboard checks of the regions', async () => {
    const audited = await auditPath('/deep', [STRESS_WIDTH], true);
    const desktop = audited.result.findings.filter((finding) => finding.viewport === 'desktop');
    const overlapOf = (prefix: string, width: string | undefined): Finding | undefined => desktop.find((finding) => finding.ruleId === 'ELEMENT_OVERLAP'
      && keyOf(finding, 'firstSelector') === `#${prefix}-a` && keyOf(finding, 'stressWidth') === width);
    expectTargetInImage(audited, overlapOf('deep', undefined), GREEN);
    expectTargetInImage(audited, overlapOf('in', undefined), GREEN);
    // 幅の走査の指摘は、その幅の page で撮った画像。
    expectTargetInImage(audited, overlapOf('deep', String(STRESS_WIDTH)), GREEN);
    expect(audited.regionOf(overlapOf('deep', String(STRESS_WIDTH)) as Finding)?.stressWidth).toBe(STRESS_WIDTH);
    // フォーカスしても覆われたままのリンクは、フォーカスの後の位置で撮った画像（覆う色が写る）。
    expectTargetInImage(audited, desktop.find((finding) => finding.ruleId === 'FOCUSED_CONTROL_HIDDEN' && keyOf(finding, 'selector') === '#tiny'
      && keyOf(finding, 'stressWidth') === undefined), MAGENTA, 'OUTSIDE');
    // EV-4: 見切れた文字は、要素の種類を記録し、動かして撮った画像。
    expectTargetInImage(audited, desktop.find((finding) => finding.ruleId === 'TEXT_CLIPPING' && keyOf(finding, 'selector') === '#clip'), GREEN);
    const layout = audited.result.evidence.find((record) => record.type === 'layout' && record.viewport === 'desktop' && record.capture?.phase === 'layout');
    expect(layout?.type === 'layout' ? layout.payload.primary.layout?.clippedText.find(({ selector }) => selector === '#clip') : undefined)
      .toMatchObject({ tagName: 'p', role: null });
    // EV-4: 横にスクロールする領域は、動かして撮った画像と、キーボードの実操作の結果。
    const targets = ['#plain', '#minus', '#stopped'].map((selector) => JSON.stringify([selector]));
    for (const target of targets) {
      expectTargetInImage(audited, desktop.find((finding) => finding.ruleId === 'A11Y_SCROLLABLE_REGION_FOCUSABLE' && keyOf(finding, 'target') === target), MAGENTA);
    }
    const focus = audited.result.evidence.find((record) => record.type === 'focus' && record.viewport === 'desktop' && record.payload.stressWidth === undefined);
    const checks = focus?.type === 'focus' ? focus.payload.scrollableRegions ?? [] : [];
    expect(targets.map((target) => checks.find((check) => JSON.stringify(check.targetSelectors) === target)?.outcome))
      .toEqual(['REACHED_AND_MOVED', 'NOT_REACHED', 'REACHED_NOT_MOVED']);
  }, TEST_TIMEOUT_MS);

  it('separates the cover that hides the target even at the end from the cover only at the first position, and says "cannot press" only for a control', async () => {
    const occlusionOf = async (path: string): Promise<string> => {
      const audited = await auditPath(path, []);
      const finding = audited.result.findings.find((candidate) => candidate.viewport === 'desktop' && candidate.ruleId === 'FIXED_ELEMENT_OCCLUSION');
      return finding?.message ?? 'MISSING';
    };
    const footer = await occlusionOf('/footer-end');
    expect(footer).toContain(FIXED_OCCLUSION_REVEAL_TEXT.HIDDEN_AT_END);
    expect(footer).toContain(FIXED_OVERLAP_TEXT.RENDER_AND_POINTER);
    const banner = await occlusionOf('/banner-initial');
    expect(banner).toContain(FIXED_OCCLUSION_REVEAL_TEXT.INITIAL_ONLY);
    expect(banner).not.toContain(FIXED_OVERLAP_TEXT.RENDER_AND_POINTER);
    // REV-EV3 の M-1: 覆いが消える位置では、リンクが画面の外にあって一度も見えない（初めの位置だけの覆いにしない）。
    const hidden = await occlusionOf('/hide-banner');
    expect(hidden).toContain(FIXED_OCCLUSION_REVEAL_TEXT.HIDDEN_AT_END);
    expect(hidden).toContain(FIXED_OVERLAP_TEXT.RENDER_AND_POINTER);
  }, TEST_TIMEOUT_MS);
});

describe('EV-2 (REV-EV12): the parts that decide what the image shows', () => {
  /** 画面を Guard の付いた page で開き、部品を直に流して、撮る口に渡った記録を返す。 */
  const revealOn = async (path: string, specs: readonly RevealTargetSpec[]): Promise<readonly RevealCaptureEvidence[]> => {
    const origin = await startPages();
    const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    return withGuardedPassivePage(factory, { width: 1280, height: 800 }, async (page) => {
      await page.goto(`${origin}${path}`, { waitUntil: 'load' });
      const captured: RevealCaptureEvidence[] = [];
      await revealAndCapture(page, specs, {
        settleMs: PRODUCTION_OBSERVATION_WINDOWS.scroll.stepWaitMs,
        capture: async (reveal) => {
          captured.push(reveal);
          return null;
        },
      });
      return captured;
    });
  };

  it('does not count a target under a fixed band or cut off by a hidden overflow as inside the image', async () => {
    const captured = await revealOn('/covered-and-clipped', [
      { purpose: 'ELEMENT_OVERLAP', selectors: ['#ft-a', '#ft-b'] },
      { purpose: 'ELEMENT_OVERLAP', selectors: ['#cl-a', '#cl-b'] },
    ]);
    const inclusionOf = (selector: string): string | undefined =>
      captured.flatMap(({ targets }) => targets).find((target) => target.selectors[0] === selector)?.inclusion;
    expect([inclusionOf('#ft-a'), inclusionOf('#cl-a')]).toEqual(['OUTSIDE', 'PARTIAL']);
  }, TEST_TIMEOUT_MS);

  it('TII: counts an overlap on a tool bar as inside the image, taking it where it is when moving the bar would pull the two apart', async () => {
    const ids = ['in', 'ce', 'dc', 'ab', 'sv', 'fb'];
    const captured = await revealOn('/toolbar', ids.map((id) => ({ purpose: 'ELEMENT_OVERLAP', selectors: [`#${id}-a`, `#${id}-b`] })));
    const measuredOf = (id: string) => captured.flatMap(({ targets }) => targets).find((target) => target.selectors[0] === `#${id}-a`);
    // 画面の下の端にかかる重なりは、元の位置（layout と同じ位置関係）で一部だけ入る（保留のまま）。
    expect(ids.map((id) => measuredOf(id)?.inclusion)).toEqual(['INSIDE', 'INSIDE', 'INSIDE', 'INSIDE', 'INSIDE', 'PARTIAL']);
    expect(['sv', 'fb'].map((id) => (measuredOf(id)?.rect?.width ?? 0) > 0)).toEqual([true, true]);
  });

  it('measures the covers of one band once at the end, and takes the covered targets of the same band in one image', async () => {
    const captured = await revealOn('/footer-two', [
      { purpose: 'FIXED_ELEMENT_OCCLUSION', selectors: ['#buy'], overlaySelector: '#foot' },
      { purpose: 'FIXED_ELEMENT_OCCLUSION', selectors: ['#ask'], overlaySelector: '#foot' },
    ]);
    const imagesAt = (position: string): number => captured.filter(({ targets }) => targets.some((target) => target.position === position)).length;
    expect({ target: imagesAt('TARGET'), end: imagesAt('END') }).toEqual({ target: 1, end: 1 });
    expect(captured.flatMap(({ targets }) => targets).filter((target) => target.position === 'END').map(({ selectors }) => selectors[0]).sort()).toEqual(['#ask', '#buy']);
  }, TEST_TIMEOUT_MS);

  it('EV-4: tries Tab and an arrow key on each scrollable region, records the positions before and after, and puts the page back', async () => {
    const origin = await startPages();
    const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    await withGuardedPassivePage(factory, { width: 1280, height: 800 }, async (page) => {
      await page.goto(`${origin}/scroll-region`, { waitUntil: 'load' });
      const stateOf = () => page.evaluate(() => ({
        scrollY: window.scrollY,
        scrollLefts: ['plain', 'minus', 'stopped'].map((id) => document.getElementById(id)?.scrollLeft),
        active: document.activeElement?.tagName,
        note: (document.getElementById('note') as HTMLTextAreaElement | null)?.value,
      }));
      const before = await stateOf();
      // 影の木の中の要素（selector の並び）は、文書の selector で引けないので試さない。入力欄の後ろの領域は、入力欄で Tab を止めて試さない。
      const targets = [
        { targetSelectors: ['#plain'] }, { targetSelectors: ['#minus'] }, { targetSelectors: ['#stopped'] }, { targetSelectors: [['#host', '#inner']] },
        { targetSelectors: ['#behind-input'] },
      ];
      const checks = await checkScrollableRegions(page, targets, {
        settleMs: PRODUCTION_OBSERVATION_WINDOWS.scroll.stepWaitMs, keyPressGuard: scrollKeyPressGuardOf(page),
      });
      expect(checks.map(({ outcome }) => outcome)).toEqual(['REACHED_AND_MOVED', 'NOT_REACHED', 'REACHED_NOT_MOVED', 'NOT_TRIED', 'NOT_TRIED']);
      expect(checks[4]?.keys).toEqual(['Tab']);
      const [plain] = checks;
      expect((plain?.region?.after.scrollLeft ?? 0) > (plain?.region?.before.scrollLeft ?? 0)).toBe(true);
      expect(plain?.scroll?.document.after.scrollY).toBeGreaterThan(0);
      expect(await stateOf()).toEqual(before);
    });
  });

  it('REV-EV4: keeps the page from moving on the arrow keys, stops at an input in a shadow tree, and passes a focusable ancestor of the region', async () => {
    const origin = await startPages();
    const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    await withGuardedPassivePage(factory, { width: 1280, height: 800 }, async (page) => {
      await page.goto(`${origin}/scroll-keys`, { waitUntil: 'load' });
      const ids = ['nav-doc', 'nav-early', 'pop-early', 'behind-shadow', 'in-section'];
      const checks = await checkScrollableRegions(page, ids.map((id) => ({ targetSelectors: [`#${id}`] })), {
        settleMs: PRODUCTION_OBSERVATION_WINDOWS.scroll.stepWaitMs, keyPressGuard: scrollKeyPressGuardOf(page),
      });
      // ページの文書の handler には矢印のキーが届かない。先に付いた handler が起こした移動とポップアップは、止めて結果に残す。
      expect(checks.map(({ outcome }) => outcome)).toEqual(['REACHED_AND_MOVED', 'KEY_TRIGGERED_NAVIGATION', 'KEY_TRIGGERED_NAVIGATION', 'NOT_TRIED', 'REACHED_AND_MOVED']);
      expect(await page.evaluate(() => (document.getElementById('ed')?.shadowRoot?.getElementById('in') as HTMLTextAreaElement | null)?.value)).toBe('t');
      expect(page.url()).toBe(`${origin}/scroll-keys`);
      expect(receivedPaths.filter((path) => path !== '/scroll-keys')).toEqual([]);
      expect(factory.getSafetyLedger(page.context()).snapshot().invariantViolations).toEqual([]);
    });
  });
});

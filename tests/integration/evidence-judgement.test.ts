// EV-1（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 3.1）の結合のテスト（既定の Chromium。CLI の Chromium の回は
// `BEAKSIGHT_TEST_DEFAULT_CHROMIUM=cli` で同じファイルを流す。サーバは 127.0.0.1 だけ）。読み込みを増やさない判定の直しを、本物の画面で確かめる。
// - 内側の領域がスクロールする画面の、スクロールで避けられる固定の帯の覆いは、指摘にしない。
// - 複数行のリンクの、外接矩形だけの重なりは、指摘にしない。
// - 横のスクロールの中のリンクは、フォーカスで画面の中に出る（画面の外としない）。確かめの後に、元の位置へ戻す。
// - コントラストは、axe の版と、色から計算した丸める前の比を残し、文に「比（基準）」で出す。
// - 見えている読み込み中の表示を、その状態の DOM の記録に残す。
// - LCP は、スクロールの前に読んだ値を残す。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESSIBILITY_RULES } from '../../src/audit/accessibility-rules.js';
import { focusCheckOutcomeOf } from '../../src/audit/focus-check.js';
import { LAYOUT_RULES } from '../../src/audit/layout-rules.js';
import type { AuditRule, FindingDraft } from '../../src/audit/rule.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import type { EvidenceRecord } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../../src/core/observation-windows.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import { collectFocusChecks } from '../../src/evidence/focus-check-collector.js';
import { collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { PerformanceCollector } from '../../src/evidence/performance-collector.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });
const head = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>EV-1</title></head>';

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  // 文書は動かず、main が動く。下の固定の帯の下の見出しは、main を動かせば帯の外へ出る。
  '/inner-scroll': '<!doctype html><html lang="ja" style="height: 100%; overflow: hidden"><head><meta charset="utf-8"><link rel="icon" href="data:,">'
    + '<title>EV-1</title></head><body style="margin: 0; height: 100%; overflow: hidden">'
    + '<main id="m" style="height: 100%; overflow: auto"><h2 id="h" style="margin: 0; position: relative; top: 720px">見出し</h2><div style="height: 3000px"></div></main>'
    + '<footer id="f" style="position: fixed; left: 0; right: 0; bottom: 0; height: 120px; background: #fff">固定の下部</footer></body></html>',
  // 複数行のリンクと、その外接矩形の下の端に重なる画像（行ごとの矩形とは重ならない）。
  '/multi-line-link': `${head}<body style="margin: 0; font: 16px/20px sans-serif">`
    + '<p style="width: 300px; margin: 0">あいうえおかきくけこさしすせそ <a id="lnk" href="#x">これは長いリンクの文字で二行目に折り返して続きますこれは長いリンク</a></p>'
    + '<img id="img" alt="" style="display: block; width: 100px; height: 40px; margin-top: -20px; margin-left: 200px; background: #ccc"></body></html>',
  // 横のスクロールの中の、画面の外のリンク。
  '/carousel': `${head}<body style="margin: 0"><div id="c" style="width: 600px; overflow-x: auto; white-space: nowrap">`
    + '<span style="display: inline-block; width: 1500px">x</span><a id="t" href="#y">奥のリンク</a></div></body></html>',
  // 基準 4.5 に届かない灰色の文字（#777 と白の比は 4.477…。axe は 4.48 に丸める）。
  '/contrast': `${head}<body><main><h1>見出し</h1><p id="muted" style="color: #777; background: #fff; font-size: 14px">薄い文字です。</p></main></body></html>`,
  // 見えている読み込み中の表示。
  '/loading': `${head}<body><div role="progressbar" aria-busy="true" aria-label="読み込み中">読み込み中…</div><main aria-busy="true"><p>読み込み中</p></main>`
    + '<progress id="p"></progress></body></html>',
  // EV-3: 文書の範囲の外の表示と、大きさ 0 の表示（利用者に見えない）。
  '/loading-offscreen': `${head}<body><div role="progressbar" aria-label="読み込み" style="position: absolute; left: -9999px">x</div>`
    + '<div aria-busy="true" style="width: 0; height: 0; overflow: hidden"></div><p>本文です。</p></body></html>',
  // REV-SD2 の M-1: 縦は hidden で横だけ auto の main（利用者は縦に動かせない）の、帯の下の見出し。
  '/inner-hidden-y': '<!doctype html><html lang="ja" style="height: 100%; overflow: hidden"><head><meta charset="utf-8"><link rel="icon" href="data:,">'
    + '<title>EV-1</title></head><body style="margin: 0; height: 100%; overflow: hidden">'
    + '<main id="m" style="height: 100%; overflow-x: auto; overflow-y: hidden"><div style="width: 3000px; height: 1px"></div>'
    + '<h2 id="h" style="margin: 0; position: relative; top: 720px">見出し</h2><div style="height: 3000px"></div></main>'
    + '<footer id="f" style="position: fixed; left: 0; right: 0; bottom: 0; height: 120px; background: #fff">固定の下部</footer></body></html>',
  // REV-SD2 の I-3: 押せない飾りの画像（pointer-events: none）が、ボタンに本当に重なる。
  '/overlap-pe-none': `${head}<body style="margin: 0"><button id="b" style="display: block; width: 200px; height: 60px">申し込む</button>`
    + '<img id="i" alt="" style="display: block; margin-top: -50px; margin-left: 20px; width: 160px; height: 40px; background: #c33; pointer-events: none"></body></html>',
  // REV-SD2 の M-2・M-3: smooth のスクロールの横の並びと、overflow: hidden の横の並びの、奥のリンク。
  '/smooth-carousel': `${head}<body style="margin: 0"><div id="c" style="width: 600px; overflow-x: auto; white-space: nowrap; scroll-behavior: smooth">`
    + '<span style="display: inline-block; width: 1500px">x</span><a id="t" href="#y">奥のリンク</a></div></body></html>',
  '/hidden-carousel': `${head}<body style="margin: 0"><div id="c" style="width: 600px; overflow: hidden; white-space: nowrap">`
    + '<span style="display: inline-block; width: 1500px">x</span><a id="t" href="#y">奥のリンク</a></div></body></html>',
  // 先頭の小さな見出しと、ずっと下の大きな塊（スクロールで描かれる）。
  '/lcp': `${head}<body style="margin: 0"><h1 id="top" style="font-size: 16px">見出し</h1><div style="height: 4000px"></div>`
    + '<div id="big" style="width: 1200px; height: 700px; background: #369; color: #fff; font-size: 200px">大きな塊</div></body></html>',
});

let browser: Browser;
let server: LoopbackHttpServer | undefined;

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
  expect(leftover, 'Contexts left in the browser after the test').toHaveLength(0);
});

/** 画面を Guard の付いた Passive の page で開いて、`run` を流す。 */
const onPage = async <T>(path: string, run: (page: Page) => Promise<T>, prepare?: (context: BrowserContext) => Promise<void>): Promise<T> => {
  server = await startLoopbackHttpServer((request, response) => {
    const body = PAGES[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  const { origin } = server;
  const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
  return withGuardedPassivePage(factory, VIEWPORT, async (page, context) => {
    await prepare?.(context);
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    return run(page);
  });
};

const evaluateRule = (rules: readonly AuditRule[], ruleId: string, record: EvidenceRecord): readonly FindingDraft[] => {
  const rule = rules.find((candidate) => candidate.ruleId === ruleId);
  if (rule === undefined) {
    throw new Error(`${ruleId} is not registered`);
  }
  return rule.evaluate({ pageId: createPageId(1), pageUrl: 'http://127.0.0.1/ev-1' as NormalizedHttpUrlEvidence, viewport: 'desktop', evidence: [record] });
};

const layoutDraftsOn = async (path: string, ruleId: string): Promise<readonly FindingDraft[]> => {
  const result = await onPage(path, (page) => collectLayoutEvidence(page, VIEWPORT));
  if (result.status !== 'COMPLETE') {
    throw new Error('layout collection was not complete');
  }
  return evaluateRule(LAYOUT_RULES, ruleId, {
    evidenceId: createEvidenceId('layout', 1), type: 'layout', pageId: createPageId(1), viewport: 'desktop', observedAt: '2026-11-16T00:00:00.000Z',
    payload: { primary: result, stressSweep: null },
  });
};

describe('EV-1: the judgements that do not add a load', () => {
  it('does not report a fixed band that the inner scroll area can move the heading out of', async () => {
    expect(await layoutDraftsOn('/inner-scroll', 'FIXED_ELEMENT_OCCLUSION')).toEqual([]);
  });

  it('does not report a multi-line link whose bounding box alone overlaps the image', async () => {
    expect(await layoutDraftsOn('/multi-line-link', 'ELEMENT_OVERLAP')).toEqual([]);
  });

  it('lets the focus scroll the link in a horizontal scroll area into view, records the positions, and restores them', async () => {
    const { evidence, scrollLeft } = await onPage('/carousel', async (page) => ({
      evidence: await collectFocusChecks(page, { stressWidth: null }),
      scrollLeft: await page.evaluate(() => document.getElementById('c')?.scrollLeft),
    }));
    const item = evidence.items.find((candidate) => candidate.selector === '#t');
    expect(item === undefined ? 'MISSING' : focusCheckOutcomeOf(item, { width: evidence.viewportWidth, height: evidence.viewportHeight })).toBe('APPEARS');
    expect(item?.operation).toBe('DIRECT_FOCUS');
    expect(item?.scroll?.ancestors.map(({ selector, before, after }) => ({ selector, moved: after.scrollLeft > before.scrollLeft }))).toEqual([{ selector: '#c', moved: true }]);
    expect(scrollLeft).toBe(0);
  });

  // REV-SD2 の M-1・I-3: 縦に動かせない祖先は数えず、押せない飾りとの本当の重なりは消さない。
  it('reports a band over a heading whose container cannot scroll vertically, and an overlap with a decoration that ignores the pointer', async () => {
    expect(await layoutDraftsOn('/inner-hidden-y', 'FIXED_ELEMENT_OCCLUSION')).toHaveLength(1);
    expect(await layoutDraftsOn('/overlap-pe-none', 'ELEMENT_OVERLAP')).toHaveLength(1);
  });

  // REV-SD2 の M-2・M-3: smooth のスクロールは落ち着いてから読み、overflow: hidden の並びも、動いた位置を元へ戻す。
  it.each(['/smooth-carousel', '/hidden-carousel'])('reads the link in %s after the scroll settles, and restores the scroll', async (path) => {
    const { evidence, scrollLeft } = await onPage(path, async (page) => {
      const checked = await collectFocusChecks(page, { stressWidth: null });
      // smooth のスクロールが戻した後に動き続けないかを見る（観察の窓のスクロールの待ちの数回分）。
      await wait(PRODUCTION_OBSERVATION_WINDOWS.scroll.stepWaitMs * 3);
      return { evidence: checked, scrollLeft: await page.evaluate(() => document.getElementById('c')?.scrollLeft) };
    });
    const item = evidence.items.find((candidate) => candidate.selector === '#t');
    expect(item === undefined ? 'MISSING' : focusCheckOutcomeOf(item, { width: evidence.viewportWidth, height: evidence.viewportHeight })).toBe('APPEARS');
    expect(scrollLeft).toBe(0);
  });

  it('keeps the axe version and the unrounded ratio of the colors, and writes the ratio with the criterion', async () => {
    const evidence = await onPage('/contrast', (page) => collectAccessibilityEvidence(page));
    expect(evidence.axeVersion).toMatch(/^\d+\.\d+/u);
    const node = evidence.violations.find((rule) => rule.ruleId === 'color-contrast')?.nodes[0];
    expect(node?.computedContrastRatio).toBeCloseTo(4.4776, 3);
    const drafts = evaluateRule(ACCESSIBILITY_RULES, 'COLOR_CONTRAST_VIOLATION', {
      evidenceId: createEvidenceId('accessibility', 1), type: 'accessibility', pageId: createPageId(1), viewport: 'desktop',
      observedAt: '2026-11-16T00:00:00.000Z', payload: evidence,
    });
    expect(drafts[0]?.message).toContain('4.47（基準 4.5）');
  });

  it('records the visible loading indicators of the state', async () => {
    const evidence = await onPage('/loading', (page) => collectDomEvidence(page, createPageId(1)));
    // EV-3: 値のないものは、値のない progress と、aria-valuenow のない role=progressbar。
    expect(evidence.loadingIndicators).toEqual({ ariaBusyCount: 2, progressbarCount: 2, indeterminateProgressCount: 2 });
    // EV-3: 文書の範囲の外と大きさ 0 の表示は数えない。
    const outside = await onPage('/loading-offscreen', (page) => collectDomEvidence(page, createPageId(1)));
    expect(outside.loadingIndicators).toEqual({ ariaBusyCount: 0, progressbarCount: 0, indeterminateProgressCount: 0 });
  });

  it('reads the LCP before the scroll', async () => {
    const collector = new PerformanceCollector();
    const before = await onPage('/lcp', async (page) => {
      // 描画の後に web-vitals が値を渡すまで待つ（スクロールはしない）。
      await expect.poll(async () => (await collector.readLcpBeforeScroll(page))?.status).toBe('OBSERVED');
      return collector.readLcpBeforeScroll(page);
    }, (context) => collector.installBeforeNavigation(context));
    expect(before?.status).toBe('OBSERVED');
    expect(before?.attribution?.target).toContain('top');
  });
});

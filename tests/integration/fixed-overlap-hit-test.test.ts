// AUD-3b・3c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-3b・3c）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// 固定の要素の重なりを、描画と押下の事実（hit-test の点ごとの事実）で区分する。画面を 1 つずつ作り、区分が分かれることを確かめる。
// - 透明で押下を妨げない全画面の外枠: GEOMETRY_ONLY（Finding にしない。数える）。
// - 押下だけを捕まえる透明な覆い: POINTER_ONLY。
// - 不透明な覆い: RENDER_AND_POINTER。
// - 正常なモーダル（`dialog` の showModal）: MODAL（Finding にしない。数える）。
// - `pointer-events: none` の不透明な帯: RENDER_ONLY。
// - スクロールで逃がせる下の帯: SCROLL_REVEALABLE（Finding にしない。数える）。
// - 内容を中に持つ固定の外枠（覆われる要素が覆う要素の子孫）: 覆いと数えない（COVERED を優先）。
// - 幅の走査の幅でも、区分の事実が付く（Page Auditor）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedOverlapOfFinding, fixedOverlapsNotCountedOf } from '../../src/audit/fixed-overlap-classes.js';
import { LAYOUT_RULES } from '../../src/audit/layout-rules.js';
import type { FindingDraft } from '../../src/audit/rule.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import type { EvidencePayloadByType, EvidenceRecord } from '../../src/core/contracts.js';
import type { LayoutEvidence, NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 3 * 60_000;
const VIEWPORT: Viewport = Object.freeze({ width: 400, height: 300 });
const OCCLUSION = 'FIXED_ELEMENT_OCCLUSION';
const OVERSIZED = 'OVERSIZED_FIXED_ELEMENT';

const head = (title: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title>`
  + '<style>html, body { margin: 0; } main { padding: 8px; } h1 { margin: 0 0 8px; } p { margin: 0 0 8px; }</style></head>';
/** 覆われる内容（文書はスクロールしない高さ）。 */
const CONTENT = '<main><h1 id="title">見出し</h1><p id="lead">本文です。本文です。本文です。本文です。</p><p id="more">続きの本文です。</p></main>';
const COVER = 'position: fixed; top: 0; left: 0; width: 100%; height: 70vh; z-index: 10';

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  // 透明で、押下を通す（`pointer-events: none`）全画面の外枠。
  '/transparent-frame': `${head('frame')}<body>${CONTENT}<div id="cover" style="position: fixed; inset: 0; pointer-events: none; z-index: 10"></div></body></html>`,
  // 押下だけを捕まえる透明な覆い。
  '/pointer-only': `${head('pointer only')}<body>${CONTENT}<div id="cover" style="${COVER}"></div></body></html>`,
  // 不透明な覆い。
  '/opaque-cover': `${head('opaque')}<body>${CONTENT}<div id="cover" style="${COVER}; background: #fff"></div></body></html>`,
  // 正常なモーダル（showModal）。
  '/modal': `${head('modal')}<body>${CONTENT}<dialog id="cover" style="width: 80vw; height: 70vh; margin: 0; top: 0; left: 0; padding: 0">`
    + '<p>モーダルの中身です。</p></dialog><script>document.getElementById("cover").showModal();</script></body></html>',
  // 押下を通す（`pointer-events: none`）不透明な帯。
  '/render-only': `${head('render only')}<body>${CONTENT}<div id="cover" style="position: fixed; top: 0; left: 0; width: 100%; height: 40vh; background: #fff; pointer-events: none; z-index: 10"></div></body></html>`,
  // 文書がスクロールできるページの、下の固定の帯（帯の下の内容は、スクロールで帯の外へ出せる）。
  '/scroll-band': `${head('scroll band')}<body><main><h1>見出し</h1><div style="height: 230px"></div><p id="under">帯の下の本文です。</p>`
    + '<div style="height: 1200px"></div></main><div id="cover" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 60px; background: #fff; z-index: 10"></div></body></html>',
  // 内容を中に持つ固定の外枠（覆われる要素は、覆う要素の子孫）。
  '/frame-with-content': `${head('frame with content')}<body><div id="cover" style="position: fixed; inset: 0; overflow: auto; background: #fff">${CONTENT}</div></body></html>`,
  // 幅の走査の幅でも事実が付くことを確かめる画面（固定のヘッダの landmark は通知の枠に数えないので、隠されない）。
  '/opaque-header': `${head('opaque header')}<body><header id="cover" style="${COVER}; background: #fff"><p>ヘッダです。</p></header>${CONTENT}</body></html>`,
});

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

const startServer = async (): Promise<LoopbackHttpServer> => {
  server = await startLoopbackHttpServer((request, response) => {
    const body = PAGES[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return server;
};

/** 画面を Guard の付いた Passive の page で開き、主の layout を集める。 */
const layoutOf = async (path: string): Promise<LayoutEvidence> => {
  const { origin } = await startServer();
  const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
  return withGuardedPassivePage(factory, VIEWPORT, async (page) => {
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    const result = await collectLayoutEvidence(page, VIEWPORT);
    if (result.status !== 'COMPLETE') {
      throw new Error('layout collection was not complete');
    }
    return result.layout;
  });
};

const payloadOf = (layout: LayoutEvidence): EvidencePayloadByType['layout'] => ({ primary: { status: 'COMPLETE', layout }, stressSweep: null });

/** 主の layout から、1 つの layout の Rule の下書きを作る。 */
const draftsOf = (ruleId: string, layout: LayoutEvidence): readonly FindingDraft[] => {
  const rule = LAYOUT_RULES.find((candidate) => candidate.ruleId === ruleId);
  if (rule === undefined) {
    throw new Error(`${ruleId} is not registered`);
  }
  const record: EvidenceRecord = {
    evidenceId: createEvidenceId('layout', 1),
    type: 'layout',
    pageId: createPageId(1),
    viewport: 'desktop',
    observedAt: '2026-11-10T00:00:00.000Z',
    payload: payloadOf(layout),
  };
  return rule.evaluate({ pageId: createPageId(1), pageUrl: 'http://127.0.0.1/cases' as NormalizedHttpUrlEvidence, viewport: 'desktop', evidence: [record] });
};

/** その Rule の、覆う要素 `#cover` の指摘の区分（指摘がなければ `NONE`）。 */
const classOf = (ruleId: string, layout: LayoutEvidence): string => {
  const draft = draftsOf(ruleId, layout).find((candidate) => candidate.identityFields.some(({ value }) => value === '#cover'));
  return draft === undefined ? 'NONE' : fixedOverlapOfFinding({ ruleId, keys: draft.identityFields }, payloadOf(layout))?.overlapClass ?? 'UNKNOWN';
};

/** Finding にしなかった区分の数（Rule ごと）。 */
const notCountedOf = (layout: LayoutEvidence): Readonly<Record<string, number>> =>
  Object.fromEntries(fixedOverlapsNotCountedOf(payloadOf(layout)).map(({ ruleId, overlapClass, count }) => [`${ruleId}:${overlapClass}`, count]));

/** 覆う要素 `#cover` を含む重なりの組の、hit-test の事実。 */
const coverHitTestsOf = (layout: LayoutEvidence) => [
  ...layout.fixedHeadingOverlaps.filter((overlap) => overlap.overlaySelector === '#cover').map((overlap) => overlap.hitTest),
  ...layout.elementOverlaps
    .filter(({ first, second }) => first.selector === '#cover' || second.selector === '#cover')
    .map((overlap) => overlap.hitTest),
];

describe('AUD-3b・3c: the classes of the fixed overlaps from the facts of the paint and the pointer', () => {
  it('does not report a transparent full-screen frame that lets the pointer through, and counts it as GEOMETRY_ONLY', async () => {
    const layout = await layoutOf('/transparent-frame');
    expect(classOf(OCCLUSION, layout)).toBe('NONE');
    expect(classOf(OVERSIZED, layout)).toBe('NONE');
    expect(notCountedOf(layout)[`${OCCLUSION}:GEOMETRY_ONLY`]).toBeGreaterThan(0);
    expect(notCountedOf(layout)[`${OVERSIZED}:GEOMETRY_ONLY`]).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('reports a transparent cover that catches the pointer as POINTER_ONLY, with the facts of each point', async () => {
    const layout = await layoutOf('/pointer-only');
    expect(classOf(OCCLUSION, layout)).toBe('POINTER_ONLY');
    expect(classOf(OVERSIZED, layout)).toBe('POINTER_ONLY');
    const hitTests = coverHitTestsOf(layout);
    expect(hitTests.length).toBeGreaterThan(0);
    for (const hitTest of hitTests) {
      // 点は、交わりの中心と、内側に寄せた四隅の 5 点。
      expect(hitTest?.points).toHaveLength(5);
      expect(hitTest?.points.every((point) => point.topRelation === 'OVERLAY')).toBe(true);
      expect(hitTest?.overlay).toMatchObject({ selector: '#cover', pointerEvents: 'auto', paintsOwnSurface: false, zIndex: '10', position: 'fixed' });
      expect(hitTest?.modal).toEqual({ dialogModal: false, ariaModal: false });
    }
  }, TEST_TIMEOUT_MS);

  it('reports an opaque cover as RENDER_AND_POINTER', async () => {
    const layout = await layoutOf('/opaque-cover');
    expect(classOf(OCCLUSION, layout)).toBe('RENDER_AND_POINTER');
    expect(classOf(OVERSIZED, layout)).toBe('RENDER_AND_POINTER');
    const [hitTest] = coverHitTestsOf(layout);
    expect(hitTest?.points[0]?.layers[0]).toMatchObject({ selector: '#cover', relation: 'OVERLAY', backgroundColor: 'rgb(255, 255, 255)', effectiveOpacity: 1 });
  }, TEST_TIMEOUT_MS);

  it('does not report a normal modal (showModal), and counts it as MODAL', async () => {
    const layout = await layoutOf('/modal');
    expect(classOf(OCCLUSION, layout)).toBe('NONE');
    expect(classOf(OVERSIZED, layout)).toBe('NONE');
    expect(notCountedOf(layout)[`${OCCLUSION}:MODAL`]).toBeGreaterThan(0);
    expect(coverHitTestsOf(layout)[0]?.modal).toMatchObject({ dialogModal: true });
  }, TEST_TIMEOUT_MS);

  it('reports an opaque band with pointer-events: none as RENDER_ONLY', async () => {
    const layout = await layoutOf('/render-only');
    expect(classOf(OCCLUSION, layout)).toBe('RENDER_ONLY');
    expect(classOf(OVERSIZED, layout)).toBe('RENDER_ONLY');
    // hit-test は `pointer-events: none` の帯を返さない（最前面は覆われる内容）。
    expect(coverHitTestsOf(layout)[0]?.points.every((point) => point.topRelation !== 'OVERLAY')).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('does not report the content under a bottom band that the scroll reveals, and counts it as SCROLL_REVEALABLE', async () => {
    const layout = await layoutOf('/scroll-band');
    expect(classOf(OCCLUSION, layout)).toBe('NONE');
    expect(notCountedOf(layout)[`${OCCLUSION}:SCROLL_REVEALABLE`]).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it('prefers COVERED: a fixed frame that holds the content is not a cover', async () => {
    const layout = await layoutOf('/frame-with-content');
    expect(classOf(OCCLUSION, layout)).toBe('NONE');
    expect(classOf(OVERSIZED, layout)).toBe('NONE');
    expect(notCountedOf(layout)[`${OVERSIZED}:GEOMETRY_ONLY`]).toBe(1);
    const frame = layout.fixedElements.find((element) => element.selector === '#cover');
    // 最前面は外枠の中の内容か外枠で、外枠の下には祖先のほかに何もない。
    expect(frame?.hitTest?.points.every((point) => !point.targetFound)).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('AUD-3b・3c: the facts of the classes at a width of the stress sweep', () => {
  const normalized = (url: string, config: AuditConfig): NormalizedHttpUrlEvidence => {
    const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
    if (!result.ok) {
      throw new Error(`fixture URL must normalize: ${url}`);
    }
    return result.url;
  };

  it('records the hit-test facts and the class at the width of the stress sweep too', async () => {
    const { origin } = await startServer();
    const config = createTestConfig(origin, '/', {
      viewports: { stressWidths: [800] },
      audit: { interactions: false, performance: false, screenshots: false, accessibility: false },
    });
    const allocator = new IdAllocator();
    const root = await mkdtemp(join(tmpdir(), 'beaksight-hit-test-'));
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
    const outcome = await auditor.audit(normalized(`${origin}/opaque-header`, config), allocator.allocatePageId());
    const layout = outcome.result.evidence.find((record) => record.viewport === 'desktop' && record.type === 'layout' && record.capture?.phase !== 'recheck');
    if (layout?.type !== 'layout') {
      throw new Error('the desktop layout Evidence is missing');
    }
    const [width] = layout.payload.stressSweep ?? [];
    expect(width?.width).toBe(800);
    const widthLayout = width?.layout ?? null;
    expect(widthLayout === null ? [] : coverHitTestsOf(widthLayout).filter((hitTest) => hitTest !== undefined).length).toBeGreaterThan(0);
    const stressFinding = outcome.result.findings.find((finding) => finding.ruleId === OCCLUSION && finding.groupingKeys?.some(({ name, value }) => name === 'stressWidth' && value === '800'));
    expect(stressFinding).toBeDefined();
    expect(fixedOverlapOfFinding({ ruleId: OCCLUSION, keys: stressFinding?.groupingKeys ?? [] }, layout.payload)?.overlapClass).toBe('RENDER_AND_POINTER');
  }, TEST_TIMEOUT_MS);
});

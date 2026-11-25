// AUD-4（設計書 `doc/design/2026-11-19-beaksight-audit-result-review-fixes-design.md` 7 章）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// layout を読んだときと状態の画像を撮ったときに「状態の印」を記録し、動かして撮る規則でない指摘を画像に重ねる前に比べる。内側のスクロール領域の位置の差だけなら
// 矩形を動かして重ね（見える範囲に入るときだけ）、対象そのものが動いた・消えたら `EVIDENCE_MISMATCH`。対象と関係のない所の変化（後から差し込まれる要素・
// 回るカルーセル）では保留にしない（設計者の判断 2026-11-19）。何も変わらない画面は今どおり。読み込みと要求は増えない。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { EvidenceCapture, EvidenceRecord } from '../../src/core/contracts.js';
import { findingImageRegionIndexOf, type FindingImageRegionView } from '../../src/core/finding-image-regions.js';
import { collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { captureViewportScreenshot } from '../../src/evidence/screenshot-collector.js';
import { stateMarkTargetSelectorsOf } from '../../src/evidence/state-mark.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { PAGE_1, auditRun, finding, idOf, page, record } from '../helpers/audit-run-fixture.js';
import { testContextsOf, useHeadlessChromium, withoutBrowserFaviconRequestLines } from '../helpers/chromium.js';
import { withGuardedPassivePage } from '../helpers/gate-harness.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const VIEWPORT = Object.freeze({ width: 800, height: 600 });
// 内側のスクロール領域（高さ 200 px）の中の、幅 0 のリンク（領域の中の上から 400 px。初めは領域の見える範囲の外）。
const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>inner</title></head>'
  + '<body style="margin: 0"><main id="main"><h1 style="margin: 0; height: 40px">見出し</h1>'
  + '<div id="box" style="height: 200px; overflow-y: auto"><div style="height: 400px"></div>'
  + '<a id="thin" href="#t" style="display: inline-block; width: 0; height: 20px; overflow: hidden">x</a><div style="height: 600px"></div></div>'
  // 横に回るカルーセル（指摘の対象と関係のない所）。
  + '<div id="carousel" style="width: 300px; overflow-x: auto; white-space: nowrap">'
  + `${['1', '2', '3'].map((label) => `<span style="display: inline-block; width: 300px; height: 60px">${label}</span>`).join('')}</div>`
  + '</main></body></html>';

let browser: Browser;
let server: LoopbackHttpServer | undefined;
const received: string[] = [];
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

const capture = (phase: EvidenceCapture['phase']): EvidenceCapture => ({
  stateId: `${PAGE_1}:desktop:1` as EvidenceCapture['stateId'],
  phase,
  startedAt: '2026-11-19T00:00:00.000Z',
  finishedAt: '2026-11-19T00:00:01.000Z',
  url: null,
  scrollPosition: null,
});

/**
 * 画面を開き、`beforeLayout` の後に layout を読み、`between`（サイトが状態を変える代わり）の後に状態の画像を撮って、幅 0 のリンクの指摘の画像の参照と、撮った
 * ときのリンクの矩形と、サーバが受けた要求を返す。
 */
const regionAfter = async (
  beforeLayout: (page: Page) => Promise<unknown>,
  between: (page: Page) => Promise<unknown>,
): Promise<{ readonly region: FindingImageRegionView | null; readonly actual: { readonly x: number; readonly y: number }; readonly requests: readonly string[] }> => {
  received.splice(0);
  await server?.close();
  server = await startLoopbackHttpServer((request, response) => {
    received.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  });
  const origin = server.origin;
  const root = await mkdtemp(join(tmpdir(), 'beaksight-state-mark-'));
  temporaryDirectories.push(root);
  const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
  return withGuardedPassivePage(factory, VIEWPORT, async (opened) => {
    await opened.goto(`${origin}/inner`, { waitUntil: 'load' });
    await beforeLayout(opened);
    const collected = await collectLayoutEvidence(opened, VIEWPORT);
    await between(opened);
    const shot = await captureViewportScreenshot(opened, { outputPath: join(root, 'viewport.png'), relativeArtifactPath: 'viewport.png' }, {
      pageId: PAGE_1, viewport: 'desktop', stressWidth: null, markTargets: collected.layout === null ? [] : stateMarkTargetSelectorsOf(collected.layout),
    });
    const actual = await opened.evaluate(() => {
      const box = document.getElementById('thin')?.getBoundingClientRect();
      return { x: box?.left ?? Number.NaN, y: box?.top ?? Number.NaN };
    });
    const layout = collected.layout;
    const selector = layout?.zeroSizeInteractive.find((item) => item.selector === '#thin')?.selector;
    expect(selector).toBe('#thin');
    const layoutRecord: EvidenceRecord = { ...record('layout', 1, PAGE_1, 'desktop', { primary: collected, stressSweep: null }), capture: capture('layout') };
    const shotRecord: EvidenceRecord = { ...record('screenshot', 2, PAGE_1, 'desktop', shot), capture: capture('screenshot') };
    const thin = finding(1, 'WARN', 'LAYOUT', PAGE_1, [idOf(layoutRecord)], {
      ruleId: 'ZERO_SIZE_INTERACTIVE_ELEMENT', groupingKeys: [{ name: 'selector', value: '#thin' }],
    });
    const run = auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [layoutRecord, shotRecord], [thin])] });
    return { region: findingImageRegionIndexOf(run)(thin), actual, requests: withoutBrowserFaviconRequestLines([...received]) };
  });
};

const scrollBoxTo = (top: number) => (opened: Page) => opened.evaluate((value) => {
  const box = document.getElementById('box');
  if (box !== null) box.scrollTop = value;
}, top);
const nothing = async (): Promise<void> => undefined;

describe('AUD-4: the state marks of the layout and the image', () => {
  it('places the rectangle as it was when nothing changed between the layout and the image', async () => {
    const { region, actual, requests } = await regionAfter(scrollBoxTo(300), nothing);
    expect(region).toMatchObject({ holdReason: null, regions: [{ role: 'TARGET', selector: '#thin' }] });
    expect(region?.regions[0]?.rect.y).toBeCloseTo(actual.y, 0);
    // 読み込みと要求は、画面の 1 回だけ（状態の印の読み取りは要求を出さない）。
    expect(requests).toEqual(['GET /inner']);
  });

  it('moves the rectangle by the scroll of the inner scroll area when the target comes into the visible part of the area', async () => {
    const { region, actual, requests } = await regionAfter(nothing, scrollBoxTo(300));
    expect(region).toMatchObject({ holdReason: null, regions: [{ role: 'TARGET', selector: '#thin' }] });
    expect(region?.regions[0]?.rect.y).toBeCloseTo(actual.y, 0);
    expect(requests).toEqual(['GET /inner']);
  });

  it('holds the finding as EVIDENCE_MISMATCH when the scroll of the area takes the target out of the visible part of the area', async () => {
    const { region } = await regionAfter(scrollBoxTo(300), scrollBoxTo(0));
    expect(region?.holdReason).toBe('EVIDENCE_MISMATCH');
  });

  it('does not hold the finding when an element is put in elsewhere, or the carousel turns, between the layout and the image', async () => {
    const added = await regionAfter(scrollBoxTo(300), (opened) => opened.evaluate(() => {
      const chat = document.createElement('div');
      chat.style.height = '120px';
      document.getElementById('main')?.append(chat);
    }));
    const turned = await regionAfter(scrollBoxTo(300), (opened) => opened.evaluate(() => {
      const carousel = document.getElementById('carousel');
      const first = carousel?.firstElementChild;
      if (carousel === null || first === null || first === undefined) return;
      carousel.append(first);
      carousel.append(document.createElement('span'));
      carousel.scrollLeft = 300;
    }));
    expect([added.region?.holdReason, turned.region?.holdReason]).toEqual([null, null]);
  });

  it('holds the finding as EVIDENCE_MISMATCH when the target itself moved or went away between the layout and the image', async () => {
    const moved = await regionAfter(scrollBoxTo(300), (opened) => opened.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '50px';
      document.getElementById('thin')?.before(spacer);
    }));
    const removed = await regionAfter(scrollBoxTo(300), (opened) => opened.evaluate(() => {
      document.getElementById('thin')?.remove();
    }));
    expect([moved.region?.holdReason, removed.region?.holdReason]).toEqual(['EVIDENCE_MISMATCH', 'EVIDENCE_MISMATCH']);
  });
});

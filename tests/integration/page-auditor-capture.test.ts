// AUD-2a・2c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-2a・2c）: 集めた状態と時刻を Evidence に結ぶ記録と、撮る順。
// - AUD-2a: ビューポートの読み込みごとの状態 ID（`pageId`・ビューポート・試行）を、各 Evidence の `capture` に残す。`capture` は、集めた段（`phase`）・
//   時刻の範囲（`startedAt`・`finishedAt`）・その時の URL と位置も持つ。ビューポートの記録に、安定の判定の結果（`settling`）と通知の枠の扱い
//   （`notificationHandling`）を残す。Desktop の layout は、幅の走査の後に包んでも、測った時刻を残す。
// - AUD-2c: viewport の画像を DOM・layout の直後（色・axe の前）に撮る。full-page の画像は、今の位置（performance の後）のまま撮る。
// 偽の collector（本物を包んで呼んだ順を記録する）と本物の collector の両方で確かめる（既定の Chromium。サーバは 127.0.0.1 だけ）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { type EvidenceRecord, type PageAuditOutcome, type ViewportProfile } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import { collectLayoutEvidence } from '../../src/evidence/layout-collector.js';
import { captureScreenshots } from '../../src/evidence/screenshot-collector.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor, type PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS, type TestConfigOverrides } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 3 * 60_000;

/** 隅の通知の枠（閉じるボタンを押すと消える。一般の文言）。 */
const NOTICE = '<div style="position: fixed; inset: 0; z-index: 40; pointer-events: none;">'
  + '<section id="notice" role="region" aria-labelledby="notice-title" style="position: fixed; top: 16px; right: 16px; width: 300px; height: 180px;'
  + ' pointer-events: auto; background: #fff; border: 1px solid #333;"><header><h2 id="notice-title">お知らせ</h2>'
  + '<button type="button" id="notice-close" aria-label="お知らせを閉じる">✕</button></header><p>一般のお知らせの文です。</p></section></div>'
  + "<script>document.getElementById('notice-close').addEventListener('click', () => { document.getElementById('notice').remove(); });</script>";

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/plain': '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>plain</title></head>'
    + '<body><main><h1>plain</h1><p>一般の文です。</p></main></body></html>',
  '/notice': '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>notice</title></head>'
    + `<body><main><h1>notice</h1><p>一般の文です。</p></main>${NOTICE}</body></html>`,
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

const normalized = (url: string, config: AuditConfig): NormalizedHttpUrlEvidence => {
  const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
  if (!result.ok) {
    throw new Error(`fixture URL must normalize: ${url}`);
  }
  return result.url;
};

const audit = async (
  path: string,
  extra: Partial<Pick<PageAuditorDependencies, 'collectors'>> = {},
  overrides: TestConfigOverrides = {},
): Promise<PageAuditOutcome> => {
  const { origin } = await startServer();
  const config = createTestConfig(origin, '/', {
    viewports: { stressWidths: [] },
    audit: { interactions: false, performance: false },
    ...overrides,
  });
  const allocator = new IdAllocator();
  const root = await mkdtemp(join(tmpdir(), 'beaksight-capture-'));
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
    ...extra,
  });
  return auditor.audit(normalized(`${origin}${path}`, config), allocator.allocatePageId());
};

const viewportEvidence = (outcome: PageAuditOutcome, viewport: ViewportProfile): readonly EvidenceRecord[] =>
  outcome.result.evidence.filter((record) => record.viewport === viewport);

/** 集めた段の Evidence（種類と、画像は撮り方）。AUD-2e: 落ち着いた後の確かめ直し（段 `recheck`）で集め直した Evidence は除く（1 回目の段を見る）。 */
const captureOf = (records: readonly EvidenceRecord[], type: string, captureType?: string) => {
  const record = records.find((candidate) => candidate.type === type && candidate.capture?.phase !== 'recheck'
    && (captureType === undefined || (candidate.payload as { readonly captureType?: string }).captureType === captureType));
  return record?.capture;
};

describe('AUD-2c: the order of the collection with the collectors that record their calls', () => {
  it('takes the viewport image right after the DOM and the layout, before axe, and the full-page image at the end', async () => {
    const calls: string[] = [];
    const outcome = await audit('/plain', {
      collectors: {
        collectDomEvidence: async (page, pageId) => { calls.push('dom'); return collectDomEvidence(page, pageId); },
        collectLayoutEvidence: async (page, viewport) => { calls.push('layout'); return collectLayoutEvidence(page, viewport); },
        collectAccessibilityEvidence: async (page, options) => { calls.push('accessibility'); return collectAccessibilityEvidence(page, options); },
        captureScreenshots: async (page, paths, options) => {
          calls.push(`screenshot:${options?.parts ?? 'BOTH'}`);
          return captureScreenshots(page, paths, options);
        },
      },
    });

    // AUD-2d・2e: 全体の画像の後に、落ち着いた後の確かめ直しで DOM を読み直し、1 回目と同じ設定の axe を流し直し、主の layout を集め直す（1 回目に
    // axe の違反がない画面でも流す）。REC-1: 色（color）は集めない。
    const expectedPerViewport = ['dom', 'layout', 'screenshot:VIEWPORT', 'accessibility', 'screenshot:FULL_PAGE', 'dom', 'accessibility', 'layout'];
    expect(calls).toEqual([...expectedPerViewport, ...expectedPerViewport]);
    for (const viewport of ['desktop', 'mobile'] as const) {
      const screenshots = viewportEvidence(outcome, viewport).filter((record) => record.type === 'screenshot');
      // AUD-3d の続き: 落ち着いた後の確かめ直しの段でも、集め直した layout の直後に viewport の画像を撮る（段 `recheck`）。
      expect(screenshots.map((record) => [(record.payload as { readonly captureType: string }).captureType, record.capture?.phase])).toEqual([
        ['VIEWPORT', 'screenshot'],
        ['FULL_PAGE', 'screenshot'],
        ['VIEWPORT', 'recheck'],
      ]);
    }
  }, TEST_TIMEOUT_MS);
});

describe('AUD-2a: the state and the time range of each Evidence', () => {
  it('gives every Evidence of a load the same state ID, and orders the time ranges as collected', async () => {
    const outcome = await audit('/plain');
    const { pageId } = outcome.result;

    for (const viewport of ['desktop', 'mobile'] as const) {
      const records = viewportEvidence(outcome, viewport);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(record.capture, `${viewport} ${record.type}`).toBeDefined();
        expect(record.capture?.stateId).toBe(`${pageId}:${viewport}:1`);
        expect(Date.parse(record.capture?.startedAt ?? '')).toBeLessThanOrEqual(Date.parse(record.capture?.finishedAt ?? ''));
      }
      // 集めた順（DOM → layout → viewport の画像 → axe → full-page の画像）に、時刻の範囲が並ぶ。Desktop の layout は、幅の走査の後に包んでも、
      // 測った時刻を持つ。
      const ordered = [
        captureOf(records, 'dom'),
        captureOf(records, 'layout'),
        captureOf(records, 'screenshot', 'VIEWPORT'),
        captureOf(records, 'accessibility'),
        captureOf(records, 'screenshot', 'FULL_PAGE'),
      ];
      expect(ordered.map((capture) => capture?.phase)).toEqual(['dom', 'layout', 'screenshot', 'accessibility', 'screenshot']);
      for (let index = 1; index < ordered.length; index += 1) {
        expect(Date.parse(ordered[index - 1]?.finishedAt ?? ''), `${viewport} ${String(index)}`)
          .toBeLessThanOrEqual(Date.parse(ordered[index]?.startedAt ?? ''));
      }
      // その時の URL と位置（画像の前は先頭）。
      expect(captureOf(records, 'dom')?.url).toBe(outcome.result.pageUrl);
      expect(captureOf(records, 'screenshot', 'VIEWPORT')?.scrollPosition).toEqual({ x: 0, y: 0 });
    }
  }, TEST_TIMEOUT_MS);

  // AUD-2b・2d の指示書の 3（AUD-2a の限界）: 幅の走査の各幅の結果にも、集めた状態と時刻を付ける。
  it('gives each width of the stress sweep the state ID of the Desktop load and its own time range', async () => {
    const outcome = await audit('/plain', {}, { viewports: { stressWidths: [800] } });
    const layout = outcome.result.evidence.find((record) => record.viewport === 'desktop' && record.type === 'layout' && record.capture?.phase !== 'recheck');
    const sweep = (layout?.payload as { readonly stressSweep: readonly { readonly width: number; readonly capture?: { readonly stateId: string; readonly phase: string; readonly startedAt: string; readonly finishedAt: string } }[] }).stressSweep;
    expect(sweep.map(({ width }) => width)).toEqual([800]);
    expect(sweep[0]?.capture).toMatchObject({ stateId: `${outcome.result.pageId}:desktop:1`, phase: 'stress-layout' });
    expect(Date.parse(sweep[0]?.capture?.startedAt ?? '')).toBeLessThanOrEqual(Date.parse(sweep[0]?.capture?.finishedAt ?? ''));
    // 主の形の測りより後。
    expect(Date.parse(layout?.capture?.finishedAt ?? '')).toBeLessThanOrEqual(Date.parse(sweep[0]?.capture?.startedAt ?? ''));
  }, TEST_TIMEOUT_MS);

  it('records the result of the settling and the handling of the notification frames in the viewport record', async () => {
    const outcome = await audit('/notice');

    for (const viewport of ['desktop', 'mobile'] as const) {
      const record = outcome.result.viewports[viewport];
      expect(record.stateId).toBe(`${outcome.result.pageId}:${viewport}:1`);
      expect(record.settling).toMatchObject({ status: 'SETTLED', reason: 'DOM_AND_HEIGHT_STABLE', watchEnd: null });
      expect(record.settling?.observationCount).toBeGreaterThan(0);
      expect(record.settling?.lastScrollHeight).toBeGreaterThan(0);
      expect(record.settling?.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(record.notificationHandling).toMatchObject({ dismissedCount: 1, hiddenCount: 0 });
      expect(record.notificationHandling?.digests).toHaveLength(1);
    }
  }, TEST_TIMEOUT_MS);
});

// COV-4 の区切り 3（網羅の設計書 3.2 の 6。設計者の判断 2026-11-10）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// - 見るだけの点検の操作で開いた状態（タブ）に、読み込み直さずに DOM・axe・layout・画像を当て、タブの中の問題（名前のないボタン）が指摘になる。指摘は、その状態の
//   記録（段 `opened-state`、状態 ID `…:state-1`）と、その状態の画像（`…/desktop/state-1/viewport.png`）を参照する。
// - 同じ作りの 2 つ目のタブは、監査しない（`SAME_STRUCTURE_SEEN`）。
// - 開く前の画面と同じ指摘は、除いて数える。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { findingImageRegionIndexOf } from '../../src/core/finding-image-regions.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 300_000;

// 2 つのタブ（同じ作り）。どちらも開くと、名前のないボタンのある区画が出る。
const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>tabs</title></head><body><main><h1>タブ</h1>'
  + '<div role="tablist"><button id="t1" role="tab" type="button" aria-selected="false" aria-controls="p1">一つ目</button>'
  + '<button id="t2" role="tab" type="button" aria-selected="false" aria-controls="p2">二つ目</button></div>'
  + '<section id="p1" role="tabpanel" hidden><h2>一つ目の中身</h2><button type="button"></button></section>'
  + '<section id="p2" role="tabpanel" hidden><h2>二つ目の中身</h2><button type="button"></button></section>'
  + '</main><script>'
  + "for (const [tab, panel] of [['t1', 'p1'], ['t2', 'p2']]) { document.getElementById(tab).addEventListener('click', () => {"
  + " document.getElementById(tab).setAttribute('aria-selected', 'true'); document.getElementById(panel).hidden = false; }); }"
  + '</script></body></html>';

let browser: Browser;
let server: LoopbackHttpServer | undefined;
const directories: string[] = [];

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
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftover, 'Contexts left in the browser after the test').toHaveLength(0);
});

describe('COV-4 part 3: the opened states are audited without reloading', () => {
  it('reports the problem inside an opened tab against the state and its screenshot, and audits the same structure once', async () => {
    server = await startLoopbackHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    });
    const { origin } = server;
    const config = createTestConfig(origin, '/', {
      viewports: { stressWidths: [] },
      audit: { performance: false, accessibility: true, screenshots: true, interactions: true },
    });
    const allocator = new IdAllocator();
    const root = await mkdtemp(join(tmpdir(), 'beaksight-opened-state-'));
    directories.push(root);
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
    const normalized = normalizeUrl(`${origin}/`, `${origin}/`, new Set());
    if (!normalized.ok) {
      throw new Error('fixture URL must normalize');
    }
    const outcome = await auditor.audit(normalized.url, allocator.allocatePageId());
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });

    // 最初の画面から押した候補の開いた状態（入れ子の状態は除く）。
    const opened = outcome.result.evidence.flatMap((record) =>
      (record.type === 'interaction' && record.viewport === 'desktop' && record.payload.pressTrail === undefined && record.payload.openedState !== undefined
        ? [record.payload.openedState] : []));
    expect(opened.map(({ status }) => status)).toEqual(['AUDITED', 'SAME_STRUCTURE_SEEN']);
    // 開いたタブから、もう一つのタブを押した入れ子の状態も、同じ作りなので監査しない。
    const nestedOpened = outcome.result.evidence.flatMap((record) =>
      (record.type === 'interaction' && record.viewport === 'desktop' && record.payload.pressTrail !== undefined && record.payload.openedState !== undefined
        ? [record.payload.openedState] : []));
    expect(nestedOpened.every(({ status }) => status === 'SAME_STRUCTURE_SEEN')).toBe(true);
    const stateId = opened[0]?.stateId ?? '';
    expect(stateId.endsWith(':state-1')).toBe(true);

    // その状態の記録（段 opened-state）と、その状態の画像。
    const stateRecords = outcome.result.evidence.filter((record) => record.capture?.stateId === stateId);
    // その状態の記録は、段 opened-state（DOM・layout・axe・画像）と、その状態の確かめ直し（recheck）・フォーカスの確かめ（focus-check）。
    expect(new Set(stateRecords.map((record) => record.capture?.phase))).toEqual(new Set(['opened-state', 'recheck', 'focus-check']));
    expect(outcome.result.evidence.some((record) => record.type === 'interaction' && record.payload.openedState?.recheck?.status === 'RECHECKED')).toBe(true);
    const shot = stateRecords.find((record) => record.type === 'screenshot' && record.capture?.phase === 'opened-state');
    expect(shot?.type === 'screenshot' ? shot.payload.relativePath : '').toMatch(/\/desktop\/state-1\/viewport\.png$/u);

    // タブの中の名前のないボタンの指摘は、その状態の記録と画像を参照する。
    const stateIds = new Set(stateRecords.map(({ evidenceId }) => evidenceId));
    const inState = outcome.result.findings.filter((finding) => finding.evidenceRefs.some((id) => stateIds.has(id)));
    expect(inState.length).toBeGreaterThan(0);
    const region = findingImageRegionIndexOf({ pages: [outcome.result] } as unknown as AuditRunResult)(inState[0]!);
    expect(region).toMatchObject({ screenshotEvidenceId: shot?.evidenceId });
  }, TEST_TIMEOUT_MS);

  // 入れ子の開いた状態（設計者の判断 2026-11-10）: タブの中の「もっと」を押すと、ラベルのない入力欄のある区画が出る。タブを押し直してから「もっと」を押し、その
  // 状態も監査する。同じ構造に戻る押下では止まる（深さ・回数の上限は置かない）。
  it('presses the trail again to reach a nested opened state, audits it, and ends when no new structure appears', async () => {
    const nestedPage = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>nested</title></head><body><main><h1>入れ子</h1>'
      + '<button id="t1" role="tab" type="button" aria-selected="false" aria-controls="p1">一つ目</button>'
      + '<section id="p1" role="tabpanel" hidden><h2>一つ目の中身</h2><button id="more" type="button" aria-expanded="false" aria-controls="m1">もっと</button>'
      + '<div id="m1" hidden><input type="text" name="q"></div></section>'
      + '</main><script>'
      + "document.getElementById('t1').addEventListener('click', () => { document.getElementById('t1').setAttribute('aria-selected', 'true');"
      + " document.getElementById('p1').hidden = false; });"
      + "document.getElementById('more').addEventListener('click', () => { document.getElementById('more').setAttribute('aria-expanded', 'true');"
      + " document.getElementById('m1').hidden = false; });"
      + '</script></body></html>';
    server = await startLoopbackHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(nestedPage);
    });
    const { origin } = server;
    const config = createTestConfig(origin, '/', {
      viewports: { stressWidths: [] },
      audit: { performance: false, accessibility: true, screenshots: true, interactions: true },
    });
    const allocator = new IdAllocator();
    const root = await mkdtemp(join(tmpdir(), 'beaksight-opened-state-nested-'));
    directories.push(root);
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
    const normalized = normalizeUrl(`${origin}/`, `${origin}/`, new Set());
    if (!normalized.ok) {
      throw new Error('fixture URL must normalize');
    }
    const outcome = await auditor.audit(normalized.url, allocator.allocatePageId());
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });

    const interactions = outcome.result.evidence.flatMap((record) => (record.type === 'interaction' && record.viewport === 'desktop' ? [record.payload] : []));
    const nested = interactions.find((payload) => (payload.pressTrail?.length ?? 0) === 1 && payload.openedState?.status === 'AUDITED');
    expect(nested).toBeDefined();
    // 入れ子の状態の指摘（ラベルのない入力欄）は、その状態の記録を参照する。
    const nestedIds = new Set(outcome.result.evidence.filter((record) => record.capture?.stateId === nested?.openedState?.stateId).map(({ evidenceId }) => evidenceId));
    expect(outcome.result.findings.some((finding) => finding.evidenceRefs.some((id) => nestedIds.has(id)))).toBe(true);
    // サイトの読み込み（隔離した session の読み込み。候補 1 つにつき 1 回）の数を、報告のために残す。
    console.info(`COV-4 nested: desktop interaction loads = ${String(interactions.length)}, nested = ${String(interactions.filter((payload) => payload.pressTrail !== undefined).length)}`);
  }, TEST_TIMEOUT_MS);
});

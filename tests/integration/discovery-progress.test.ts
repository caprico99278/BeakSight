// DEF-195（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 13 章の 11）: 操作さがしのジョブも、監査と同じ形の進み具合（`RunProgressReport`。ワーカーの
// 知らせ `PROGRESS`）を、画面を読み終えるたびに 1 回送る。本物の発見の流れ（`executeDiscoveryRun`）で、127.0.0.1 の仮のサイト（3 つの画面）を巡回する。
// - 読んだ画面ごとに 1 回（読んだ数は 1 ずつ増える）。見つけた画面は読んだ画面以上で、ページの上限は設定の値。
// - 知らせはワーカーの知らせの検証（`validateWorkerToParentMessage`）に通る（新しい形を作らない）。
// - サイトへの要求を増やさない: 各画面の文書の要求は 1 回だけ。
import { describe, expect, it } from 'vitest';
import type { RunProgressReport } from '../../src/core/contracts.js';
import { WORKER_PROTOCOL_VERSION, validateWorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { runDiscoveryOnPlainSite } from '../helpers/plain-discovery-site-run.js';

const TEST_TIMEOUT_MS = 120_000;
const MAX_PAGES = 10;
const PAGES = ['/p/home', '/p/list', '/p/detail'] as const;

const document = (path: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${path}</title>`
  + `<link rel="icon" href="data:,"></head><body><main><h1>${path}</h1>${PAGES.map((link) => `<a href="${link}">${link}</a>`).join('')}</main></body></html>`;

describe('DEF-195: the progress of the discovery job', () => {
  it('reports the same progress as the audit once per read page, without more requests to the site', async () => {
    const reports: RunProgressReport[] = [];
    const run = await runDiscoveryOnPlainSite(
      launchHeadlessChromium, (path) => (PAGES.includes(path as (typeof PAGES)[number]) ? document(path) : null), PAGES[0], MAX_PAGES, 'job-def195-progress',
      // DBG-1: 時間の内訳は、測りの記録が入のときだけ書く。
      {}, (report) => { reports.push(report); }, undefined, true,
    );
    const readPages = run.document.pages.filter((page) => page.state === 'READ').length;
    expect(readPages).toBe(PAGES.length);
    expect(reports.map((report) => report.pagesFinished)).toEqual([1, 2, 3]);
    for (const report of reports) {
      expect(report.pagesDiscovered).toBeGreaterThanOrEqual(report.pagesFinished);
      expect(report.maxPages).toBe(MAX_PAGES);
      expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
      const checked = validateWorkerToParentMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'PROGRESS', report });
      expect(checked.ok ? [] : checked.errors).toEqual([]);
    }
    expect(reports.at(-1)?.pagesDiscovered).toBe(PAGES.length);
    expect(reports.at(-1)?.requests.allowedOrigins.count).toBeGreaterThanOrEqual(PAGES.length);
    // 各画面の文書の要求は 1 回だけ（進み具合のために読み込みを足さない）。
    for (const path of PAGES) {
      expect(run.seen.filter((entry) => entry.method === 'GET' && entry.path === path)).toHaveLength(1);
    }
    // DTIME（DBG-1: 測りの記録が入のとき）: 読んだ画面ごとに時間の内訳が入り、区分・見張りの終わり・そのほかの和が全体と合う（読み込みは 1 回、落ち着きを待った）。
    for (const page of run.document.pages) {
      if (page.state !== 'READ') continue;
      const time = page.timeBreakdown;
      expect(time).toMatchObject({ loads: 1, reloads: 0, presses: 0, stageEndMs: 0 });
      expect(time?.settleMs).toBeGreaterThan(0);
      expect((time?.pacingWaitMs ?? 0) + (time?.loadMs ?? 0) + (time?.settleMs ?? 0) + (time?.afterPressWindowMs ?? 0) + (time?.pressReadinessMs ?? 0)
        + (time?.inputChecksMs ?? 0) + (time?.stageEndMs ?? 0) + (time?.otherMs ?? 0)).toBe(time?.totalMs);
    }
  }, TEST_TIMEOUT_MS);
});

// L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1、INV-LIMITS の表 A の T5）: 撮影の期限（Playwright の既定の 30 秒）を撤廃し、
// 進みの見張りで待つことの確かめ（偽のページと偽の時計）。実際の Chromium での撮影は `tests/integration/screenshot-collector.test.ts`。
import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageId } from '../../src/core/ids.js';
import { ScreenshotWatchEndedError, captureScreenshots, type ScreenshotCapturePaths } from '../../src/evidence/screenshot-collector.js';

const PATHS: ScreenshotCapturePaths = Object.freeze({
  pageId: createPageId(7),
  viewport: 'desktop',
  viewportCapture: { outputPath: 'C:/fixture-out/viewport.png', relativeArtifactPath: 'screenshots/PAGE-000007/desktop/viewport.png' },
  fullPageCapture: { outputPath: 'C:/fixture-out/full.png', relativeArtifactPath: 'screenshots/PAGE-000007/desktop/full.png' },
});

interface ScreenshotCall {
  readonly fullPage: boolean;
  readonly timeout: unknown;
}

/** 偽のページ。スクロール（`evaluate`）は先頭の位置を返し、撮影（`screenshot`）は `shoot` に任せる。進みの見張りの受け口を持つ（事象は出さない）。 */
function fakePage(shoot: (call: ScreenshotCall) => Promise<Buffer>): { readonly page: Page; readonly calls: ScreenshotCall[] } {
  const calls: ScreenshotCall[] = [];
  const page = {
    evaluate: async () => ({ scrollX: 0, scrollY: 0 }),
    screenshot: (options: { readonly fullPage?: boolean; readonly timeout?: unknown }) => {
      const call = { fullPage: options.fullPage === true, timeout: options.timeout };
      calls.push(call);
      return shoot(call);
    },
    on: () => undefined,
    off: () => undefined,
    isClosed: () => false,
  } as unknown as Page;
  return { page, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('captureScreenshots (L2: no deadline, progress watch)', () => {
  it('does not apply the Playwright default timeout to either capture', async () => {
    const { page, calls } = fakePage(async () => Buffer.alloc(0));

    const evidence = await captureScreenshots(page, PATHS);

    expect(evidence.map((item) => item.captureType)).toEqual(['VIEWPORT', 'FULL_PAGE']);
    expect(calls).toEqual([{ fullPage: false, timeout: 0 }, { fullPage: true, timeout: 0 }]);
  });

  it('waits for a full-page capture that takes longer than the former 30 seconds', async () => {
    vi.useFakeTimers();
    const { page } = fakePage(({ fullPage }) => new Promise((resolve) => {
      setTimeout(() => resolve(Buffer.alloc(0)), fullPage ? 120_000 : 0);
    }));

    let settled = false;
    const pending = captureScreenshots(page, PATHS).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toHaveLength(2);
  });

  it('ends only after the quiet limit when the full-page capture never returns, keeping the viewport capture', async () => {
    vi.useFakeTimers();
    const quietLimitMs = 5_000;
    const { page } = fakePage(({ fullPage }) => (fullPage ? new Promise(() => undefined) : Promise.resolve(Buffer.alloc(0))));

    let settled = false;
    const pending = captureScreenshots(page, PATHS, { watch: { quietLimitMs } }).finally(() => {
      settled = true;
    });
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(quietLimitMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await pending.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(ScreenshotWatchEndedError);
    expect((error as ScreenshotWatchEndedError).end).toBe('STAGE_UNRESPONSIVE');
    expect((error as ScreenshotWatchEndedError).captured.map((item) => item.captureType)).toEqual(['VIEWPORT']);
  });
});

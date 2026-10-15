// CCX-7a（共通化の台帳の CC-045）: `page.goto` を包んで読み込みの終わり方（`MainFrameLoadSettlement`）を返す部品
// （`settleMainFrameLoad`、`src/browser/main-frame-load.ts`）の、偽の page での確かめ。待ち方（`waitUntil`）と期限を、そのまま
// `page.goto` に渡すこと、応答は `FULFILLED`、例外（同期の例外を含む）は `REJECTED` にして、例外を投げずに凍結して返すこと。
// 実際の Chromium での表は `tests/integration/main-frame-load-callers.test.ts`。
import type { Page, Response } from 'playwright';
import { describe, expect, it } from 'vitest';
import { settleMainFrameLoad } from '../../src/browser/main-frame-load.js';

const TARGET_URL = 'http://127.0.0.1:9/target.html';
const TIMEOUT_MS = 1_234;

interface GotoCall {
  readonly url: string;
  readonly options: unknown;
}

function fakePage(goto: (url: string, options: unknown) => Promise<Response | null>): { readonly page: Page; readonly calls: GotoCall[] } {
  const calls: GotoCall[] = [];
  const page = {
    goto: (url: string, options: unknown) => {
      calls.push({ url, options });
      return goto(url, options);
    },
  } as unknown as Page;
  return { page, calls };
}

describe('settleMainFrameLoad (CCX-7a)', () => {
  it.each(['load', 'domcontentloaded'] as const)('passes waitUntil: %s and the timeout to page.goto, and returns FULFILLED with the response', async (waitUntil) => {
    const response = { status: () => 0 } as unknown as Response;
    const { page, calls } = fakePage(async () => response);

    const settlement = await settleMainFrameLoad(page, TARGET_URL, { waitUntil, timeoutMs: TIMEOUT_MS });

    expect(calls).toEqual([{ url: TARGET_URL, options: { waitUntil, timeout: TIMEOUT_MS } }]);
    expect(settlement).toEqual({ status: 'FULFILLED', value: response });
    expect(settlement.status === 'FULFILLED' && settlement.value).toBe(response);
    expect(Object.isFrozen(settlement)).toBe(true);
  });

  it('returns FULFILLED with null when page.goto resolves without a response', async () => {
    const { page } = fakePage(async () => null);

    const settlement = await settleMainFrameLoad(page, TARGET_URL, { waitUntil: 'load', timeoutMs: TIMEOUT_MS });

    expect(settlement).toEqual({ status: 'FULFILLED', value: null });
    expect(Object.isFrozen(settlement)).toBe(true);
  });

  it('returns REJECTED with the exception itself, without throwing, when page.goto rejects', async () => {
    const failure = new Error('injected load failure');
    const { page } = fakePage(async () => {
      throw failure;
    });

    const settlement = await settleMainFrameLoad(page, TARGET_URL, { waitUntil: 'domcontentloaded', timeoutMs: TIMEOUT_MS });

    expect(settlement).toEqual({ status: 'REJECTED', reason: failure });
    expect(settlement.status === 'REJECTED' && settlement.reason).toBe(failure);
    expect(Object.isFrozen(settlement)).toBe(true);
  });

  it('returns REJECTED, without throwing, when page.goto throws synchronously', async () => {
    const failure = new Error('injected synchronous failure');
    const page = {
      goto: () => {
        throw failure;
      },
    } as unknown as Page;

    await expect(settleMainFrameLoad(page, TARGET_URL, { waitUntil: 'load', timeoutMs: TIMEOUT_MS }))
      .resolves.toEqual({ status: 'REJECTED', reason: failure });
  });
});

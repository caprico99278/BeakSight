import type { Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as guardModule from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

/**
 * L10（INV-LIMITS の T29 と設計者の判断 E）: Guard の証拠と対応付けの記録は、時間で捨てず、持ち主（page・session）を閉じたときに捨てる。
 * 「閉じるまで持つ」を無限大の期限で表さない（番兵の値を使わない。設計書 6.1）。期限の比べ自体をなくし、閉じたときに捨てる形を確かめる。
 */

/** 前に捨てていた時間（最長は、応答を待つ main frame の文書の 10 分）を十分に超える経過（10 年）。 */
const LONG_AFTER_MS = 10 * 365 * 24 * 60 * 60 * 1_000;
const START_MS = Date.UTC(2026, 10, 10);

const fakePage = (): Page => ({}) as Page;

const {
  ExpectedCdpFailureRegistry,
  PassiveDownloadRegistry,
  CanceledDocumentRegistry,
} = guardModule;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('L10 T29: Guard records live until the owner closes, without a sentinel deadline', () => {
  it('exports no infinite value as a retention length (no sentinel)', () => {
    const infinite = Object.entries(guardModule)
      .filter(([, value]) => typeof value === 'number' && !Number.isFinite(value))
      .map(([name]) => name);

    expect(infinite).toEqual([]);
  });

  it('keeps an expected CDP failure long after it was registered, and discards it when the page closes', () => {
    const registry = new ExpectedCdpFailureRegistry(new SafetyLedger());
    const kept = fakePage();
    const closed = fakePage();
    const request = { method: 'get', url: 'https://example.test/a' };
    const failure = { method: 'GET', url: request.url, errorText: 'net::ERR_BLOCKED_BY_CLIENT' };

    registry.register(kept, request, Date.now());
    registry.register(closed, request, Date.now());
    vi.setSystemTime(START_MS + LONG_AFTER_MS);
    registry.clear(closed);

    expect(registry.consume(kept, failure, Date.now())).toBe(true);
    expect(registry.consume(closed, failure, Date.now())).toBe(false);
  });

  it('keeps a passive download record long after it was recorded, and discards it when the page closes', async () => {
    const registry = new PassiveDownloadRegistry();
    const kept = fakePage();
    const closed = fakePage();
    const url = 'https://example.test/file.zip';

    registry.record(kept, url, Date.now());
    registry.record(closed, url, Date.now());
    vi.setSystemTime(START_MS + LONG_AFTER_MS);
    registry.clear(closed);

    await expect(registry.awaitAndConsume(kept, url, 0)).resolves.toBe(true);
    await expect(registry.awaitAndConsume(closed, url, 0)).resolves.toBe(false);
  });

  it('keeps canceled-document evidence long after it was received, and discards it when the session closes', async () => {
    const registry = new CanceledDocumentRegistry();
    registry.recordLoadingFailed({ requestId: 'network-1', canceled: true, type: 'Document', errorText: 'net::ERR_ABORTED' }, Date.now());
    vi.setSystemTime(START_MS + LONG_AFTER_MS);

    await expect(registry.awaitCancellation('network-1', 0)).resolves.toBe(true);
    registry.clear();
    await expect(registry.awaitCancellation('network-1', 0)).resolves.toBe(false);
  });

  it('keeps a continued main-frame document record long after it was paused, and discards it when the session closes', async () => {
    const paused = (registry: InstanceType<typeof CanceledDocumentRegistry>): void => {
      registry.recordMainFramePaused({
        requestId: 'interception-1',
        networkId: 'network-1',
        frameId: 'main',
        request: { method: 'GET', url: 'https://example.test/next' },
      }, Date.now());
      registry.recordMainFrameContinued('network-1');
    };
    const request = { method: 'GET', url: 'https://example.test/next' };

    const kept = new CanceledDocumentRegistry();
    paused(kept);
    vi.setSystemTime(START_MS + LONG_AFTER_MS);
    kept.recordLoadingFailed({ requestId: 'network-1', canceled: true, type: 'Document', errorText: 'net::ERR_ABORTED' }, Date.now());
    vi.setSystemTime(START_MS + 2 * LONG_AFTER_MS);
    await expect(kept.awaitMainFrameCancellation(request, 0)).resolves.toBe(true);

    vi.setSystemTime(START_MS);
    const closed = new CanceledDocumentRegistry();
    paused(closed);
    vi.setSystemTime(START_MS + LONG_AFTER_MS);
    closed.clear();
    await expect(closed.awaitMainFrameCancellation(request, 0)).resolves.toBe(false);
  });
});

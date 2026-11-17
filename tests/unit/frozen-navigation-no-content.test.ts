// SAFE-2 の 2（DEF-242）: 止めた main frame の移動に、204（No Content）で応えて今の文書を残す場面の判定。設計者の判断で、次の 3 つがそろうときだけ 204 にする
// （ほかは今どおり `ERR_BLOCKED_BY_CLIENT`。BN の遮断の結び付き・network の collector・load-meter・site-availability の前提を変えない）。
// - ページが始めた main frame の移動（BeakSight 自身の読み込みでない）
// - 凍結の段（`FROZEN_ACTIVE`）
// - 観察の口のある Context（操作さがし）
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  blockedMainFrameNavigationResponseOf,
  blockedMainFrameNavigationFailureTextOf,
  ExpectedCdpFailureRegistry,
  type BlockedMainFrameNavigationFacts,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

const noContent: BlockedMainFrameNavigationFacts = Object.freeze({
  phase: 'FROZEN_ACTIVE',
  mainFrame: true,
  ownNavigation: false,
  observing: true,
});

describe('the answer to a blocked main frame navigation', () => {
  it('answers 204 to a page-initiated main frame navigation while frozen in the observing Context', () => {
    expect(blockedMainFrameNavigationResponseOf(noContent)).toBe('NO_CONTENT');
  });

  it.each([
    ['the Passive audit stage', { phase: 'PASSIVE_ACTIVE' }],
    ['a closing guard', { phase: 'FROZEN_CLOSING' }],
    ['an invalidating guard', { phase: 'FROZEN_INVALIDATING' }],
    ['a child frame navigation', { mainFrame: false }],
    ['the own navigation of BeakSight', { ownNavigation: true }],
    ['a Context without the observation (Isolated Interaction)', { observing: false }],
  ] as const)('keeps ERR_BLOCKED_BY_CLIENT in %s', (_label, change) => {
    expect(blockedMainFrameNavigationResponseOf({ ...noContent, ...change } as BlockedMainFrameNavigationFacts)).toBe('BLOCKED_BY_CLIENT');
  });

  // REV-EV4: 監査の段の、横にスクロールする領域のキーの押下の期間に止めた、ページが始めた main frame の移動も、204 で今の文書を残す。
  it('answers 204 to a page-initiated main frame navigation during the key press on a scrollable region in the Passive audit stage', () => {
    const keyPress: BlockedMainFrameNavigationFacts = { phase: 'PASSIVE_ACTIVE', mainFrame: true, ownNavigation: false, observing: false, scrollKeyPress: true };
    expect(blockedMainFrameNavigationResponseOf(keyPress)).toBe('NO_CONTENT');
    expect(blockedMainFrameNavigationResponseOf({ ...keyPress, ownNavigation: true })).toBe('BLOCKED_BY_CLIENT');
  });

  // SREV-SAFE の I-1: 204 で応えた移動の後に Chromium が出す `net::ERR_ABORTED` は、Guard が予期した失敗（読み取りの失敗の記録にしない）。
  it('expects net::ERR_ABORTED after the 204, and net::ERR_BLOCKED_BY_CLIENT otherwise', () => {
    const page = {} as Page;
    const request = { method: 'GET', url: 'https://example.com/elsewhere' };
    const registry = new ExpectedCdpFailureRegistry(new SafetyLedger());
    registry.register(page, request, 0, blockedMainFrameNavigationFailureTextOf('NO_CONTENT'));
    registry.register(page, request, 0, blockedMainFrameNavigationFailureTextOf('BLOCKED_BY_CLIENT'));
    expect(registry.consume(page, { ...request, errorText: 'net::ERR_ABORTED' }, 0)).toBe(true);
    expect(registry.consume(page, { ...request, errorText: 'net::ERR_BLOCKED_BY_CLIENT' }, 0)).toBe(true);
    expect(registry.consume(page, { ...request, errorText: 'net::ERR_ABORTED' }, 0)).toBe(false);
  });
});

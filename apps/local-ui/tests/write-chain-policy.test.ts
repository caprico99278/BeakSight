/**
 * T41g（Task 41 の設計書 3.5.1。ユーザーの判断「1で進めて。明日の検証に必要。」）: 「登録してから更新する」の、続けて更新を始めるかの判定の表
 * （`apps/local-ui/src/server/write-chain-policy.ts`。純粋な関数）と、開始の画面に「登録してから更新する」を出すかの判定。
 * - 登録のジョブの結果が照合済み（`VERIFIED`）で、登録の ID が取れていて、更新の予定の対象（`readPlannedUpdateTarget`）がその ID と同じときだけ、更新を
 *   始める（予定の ID を渡す）。ほかは始めず、理由を返す。
 * - 「登録してから更新する」を出すのは、更新の対象がないときと、最新のレコードで前の更新が照合済みにならずに止まったとき。
 * - 状態と理由の値は閉じた一覧で、表示のカタログがすべてにラベルを持つ。
 */
import { describe, expect, it } from 'vitest';
import { WRITE_CHAIN_STATE_CATALOG, WRITE_CHAIN_STOP_REASON_CATALOG } from '../../../src/presentation/catalog.js';
import { AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../src/control/job/auto-login-limits.js';
import {
  WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS,
  WRITE_CHAIN_OFFER_REASONS,
  WRITE_CHAIN_STATES,
  WRITE_CHAIN_STOP_REASONS,
  writeChainOfferOf,
  writeChainRetryOf,
  writeChainUpdateDecisionOf,
} from '../src/server/write-chain-policy';

describe('T41g: whether to start the update after the create', () => {
  it('starts the update with the record id when the create is verified and the planned target is that record', () => {
    expect(writeChainUpdateDecisionOf({ createResult: 'VERIFIED', createRecordId: 'rec-1', plannedTarget: 'rec-1' }))
      .toEqual({ kind: 'START_UPDATE', targetRecordId: 'rec-1' });
  });

  it.each<readonly [string, Parameters<typeof writeChainUpdateDecisionOf>[0], string]>([
    ['a partial create', { createResult: 'PARTIAL', createRecordId: 'rec-1', plannedTarget: 'rec-1' }, 'CREATE_NOT_VERIFIED'],
    ['an unknown create', { createResult: 'UNKNOWN', createRecordId: null, plannedTarget: null }, 'CREATE_NOT_VERIFIED'],
    ['a blocked create', { createResult: 'BLOCKED', createRecordId: null, plannedTarget: 'rec-0' }, 'CREATE_NOT_VERIFIED'],
    ['a create without a result', { createResult: null, createRecordId: null, plannedTarget: null }, 'CREATE_NOT_VERIFIED'],
    ['a verified create without a record id', { createResult: 'VERIFIED', createRecordId: null, plannedTarget: 'rec-1' }, 'CREATE_RECORD_ID_MISSING'],
    ['a planned target of another record', { createResult: 'VERIFIED', createRecordId: 'rec-1', plannedTarget: 'rec-0' }, 'PLANNED_TARGET_MISMATCH'],
    ['no planned target', { createResult: 'VERIFIED', createRecordId: 'rec-1', plannedTarget: null }, 'PLANNED_TARGET_MISMATCH'],
  ])('does not start the update after %s', (_label, input, reason) => {
    expect(writeChainUpdateDecisionOf(input)).toEqual({ kind: 'STOP', reason });
  });
});

describe('T41g: whether to offer the create then update on the start screen', () => {
  it('offers it when there is no planned target', () => {
    expect(writeChainOfferOf({ plannedTarget: null, lastUpdate: null })).toBe('NO_TARGET');
  });

  it('offers it when the last update of the planned target did not end verified', () => {
    expect(writeChainOfferOf({ plannedTarget: 'rec-1', lastUpdate: { targetRecordId: 'rec-1', result: 'UNKNOWN' } })).toBe('PREVIOUS_UPDATE_STOPPED');
    expect(writeChainOfferOf({ plannedTarget: 'rec-1', lastUpdate: { targetRecordId: 'rec-1', result: 'BLOCKED' } })).toBe('PREVIOUS_UPDATE_STOPPED');
  });

  it('does not offer it when the planned target can be updated as it is', () => {
    expect(writeChainOfferOf({ plannedTarget: 'rec-1', lastUpdate: null })).toBeNull();
    expect(writeChainOfferOf({ plannedTarget: 'rec-1', lastUpdate: { targetRecordId: 'rec-1', result: 'VERIFIED' } })).toBeNull();
    expect(writeChainOfferOf({ plannedTarget: 'rec-2', lastUpdate: { targetRecordId: 'rec-1', result: 'UNKNOWN' } })).toBeNull();
    // 締めていない（結果のない）前の更新は、止まったと言えない。
    expect(writeChainOfferOf({ plannedTarget: 'rec-1', lastUpdate: { targetRecordId: 'rec-1', result: null } })).toBeNull();
  });
});

// T41g-3（Task 41 の設計書 3.5.1 の末尾。T41R5 と RT-prep-5 の報告の設計者の判断）: 自動ログインのプロファイルでは、登録のすぐ後の更新は、自動ログインの
// 最小の間隔で `AUTO_LOGIN_RATE_LIMITED`（次に始められる時刻つき）になる。この理由で、次の時刻が待ちの上限の中のときだけ、その時刻まで待ってから
// 1 回だけやり直す。ほかの理由・時刻がない・上限を超える時刻は、やり直さない。
describe('T41g-3: whether to wait for the interval of the automated login and retry the update once', () => {
  const NOW = new Date('2026-10-18T10:00:00.000Z');
  const rateLimited = (nextAllowedAt: string | null) =>
    ({ ok: false, stage: 'START', reason: 'AUTO_LOGIN_RATE_LIMITED', errorCodes: [], authSetupErrors: [], nextAllowedAt }) as const;

  it('waits until the next allowed time within the limit', () => {
    expect(writeChainRetryOf(rateLimited('2026-10-18T10:05:00.000Z'), NOW, WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS))
      .toEqual({ kind: 'WAIT', until: '2026-10-18T10:05:00.000Z' });
    // 上限ちょうどまでは待つ。
    expect(writeChainRetryOf(rateLimited(new Date(NOW.getTime() + WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS).toISOString()), NOW, WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS).kind)
      .toBe('WAIT');
  });

  // 開始の結果の形のまま渡す（判定が見る項目のほかも持つ）。
  it.each<readonly [string, Parameters<typeof writeChainRetryOf>[0] & Readonly<Record<string, unknown>>]>([
    ['a time over the limit', rateLimited(new Date(NOW.getTime() + WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS + 1).toISOString())],
    ['no next allowed time', rateLimited(null)],
    ['an unreadable time', rateLimited('not a time')],
    ['another start reason', { ok: false, stage: 'START', reason: 'JOB_ALREADY_ACTIVE', errorCodes: [], authSetupErrors: [] }],
    ['a grant rejection', { ok: false, stage: 'GRANT', reason: 'GRANT_APPROVAL_INVALID', invalidityReasons: [] }],
    ['a local rejection', { ok: false, stage: 'LOCAL', reason: 'WRITE_FACTS_UNAVAILABLE' }],
  ])('does not retry after %s', (_label, rejection) => {
    expect(writeChainRetryOf(rejection, NOW, WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS)).toEqual({ kind: 'STOP' });
  });

  it('waits longer than the minimum interval of the automated login (the limit is a named constant over 5 minutes)', () => {
    expect(WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS).toBeGreaterThan(AUTO_LOGIN_MIN_INTERVAL_MS);
    expect(WRITE_CHAIN_STATES).toContain('WAITING_LOGIN_INTERVAL');
  });
});

describe('T41g: the closed lists of the chain and their labels', () => {
  it('has a label for every state, stop reason and offer reason', () => {
    expect(Object.keys(WRITE_CHAIN_STATE_CATALOG).sort()).toEqual([...WRITE_CHAIN_STATES].sort());
    expect(Object.keys(WRITE_CHAIN_STOP_REASON_CATALOG).sort()).toEqual([...WRITE_CHAIN_STOP_REASONS].sort());
    expect(WRITE_CHAIN_OFFER_REASONS).toEqual(['NO_TARGET', 'PREVIOUS_UPDATE_STOPPED']);
  });
});

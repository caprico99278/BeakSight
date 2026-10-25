/**
 * DEF-146（FM-3 の `outcomeOf` と、ジョブの画面の止める・「ログインを終えた」を 1 つにまとめた読み方）: Server Function の呼び出しの結果を、受け付けた・
 * 閉じた一覧の理由で拒まれた・要求が届かなかった（例外、結果の形でない値）の 3 つに読む部品（`apps/local-ui/src/display/server-function-outcome.ts`）を
 * 確かめる。呼び出しが例外で終わっても、読み方は例外を投げない。
 */
import { describe, expect, it } from 'vitest';
import { closedListReason, serverFunctionOutcomeOf, settleServerFunction } from '../src/display/server-function-outcome';

const REASONS = Object.freeze({ JOB_NOT_FOUND: 'x', JOB_NOT_ACTIVE: 'y' });
const isReason = closedListReason(REASONS);

describe('DEF-146: reading the result of a Server Function call', () => {
  it('reads the accepted result, the rejection with a reason of the closed list, and any other value as a request failure', () => {
    expect(serverFunctionOutcomeOf({ ok: true, job: 1 }, isReason)).toEqual({ kind: 'ACCEPTED', result: { ok: true, job: 1 } });
    expect(serverFunctionOutcomeOf({ ok: false, reason: 'JOB_NOT_ACTIVE' }, isReason)).toEqual({ kind: 'REJECTED', reason: 'JOB_NOT_ACTIVE' });
    for (const value of [
      null, undefined, 'x', 1, [], {}, { ok: 'true' }, { ok: false }, { ok: false, reason: 'NOT_IN_THE_LIST' }, { ok: false, reason: 'toString' },
      { ok: false, reason: 1 },
    ]) {
      expect(serverFunctionOutcomeOf(value, isReason), JSON.stringify(value)).toEqual({ kind: 'REQUEST_FAILED' });
    }
  });

  it('asks the caller whether an accepted result has the expected shape', () => {
    const hasSettings = (value: Readonly<Record<string, unknown>>): boolean => 'settings' in value;
    expect(serverFunctionOutcomeOf({ ok: true, settings: {} }, isReason, hasSettings)).toEqual({ kind: 'ACCEPTED', result: { ok: true, settings: {} } });
    expect(serverFunctionOutcomeOf({ ok: true }, isReason, hasSettings)).toEqual({ kind: 'REQUEST_FAILED' });
  });

  it('settles a call that throws as a request failure, without throwing', async () => {
    await expect(settleServerFunction(Promise.reject(new TypeError('Failed to fetch')), isReason)).resolves.toEqual({ kind: 'REQUEST_FAILED' });
    await expect(settleServerFunction(Promise.resolve({ ok: false, reason: 'JOB_NOT_FOUND' }), isReason))
      .resolves.toEqual({ kind: 'REJECTED', reason: 'JOB_NOT_FOUND' });
    await expect(settleServerFunction(Promise.resolve({ ok: true }), isReason)).resolves.toEqual({ kind: 'ACCEPTED', result: { ok: true } });
  });
});

// T30e（Task 30 の設計書 3 章の「送る直前の確かめ直し」、4 章の「IPC」）: ワーカーの側の、書き込みの確かめ直しの往復と送信の報告の部品
// （`src/worker/write-ipc.ts`。T30f の流れが使う）。
// - 確かめ直しの依頼は 1 つのジョブで 1 回だけ送る（2 回目は送らずに拒む）。親の結果を名前つきの上限の時間だけ待ち、来なければ許さない（送らない）。
//   上限の後に届いた結果や、依頼していない結果は受けない（契約の違反として扱えるように偽を返す）。
// - 送信の報告は 1 回だけ送る（2 回目は送らない）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_WRITE_RECHECK_TIMEOUT_MS,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import { createWorkerWriteIpc } from '../../src/worker/write-ipc.js';

const result = (allowed: boolean, reason: 'GRANT_INVALID' | 'FACTS_UNAVAILABLE' | 'RECHECK_REPEATED' | null = null) =>
  ({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed, reason }) as const;

const setup = () => {
  const sent: WorkerToParentMessage[] = [];
  const ipc = createWorkerWriteIpc({ send: (message) => sent.push(message) });
  return { sent, ipc };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('worker write IPC (T30e): the recheck', () => {
  it('sends one request and resolves with the result of the parent', async () => {
    const { sent, ipc } = setup();
    const pending = ipc.requestRecheck();
    expect(sent).toEqual([{ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_REQUEST' }]);
    expect(ipc.receiveRecheckResult(result(true))).toBe(true);
    await expect(pending).resolves.toEqual({ allowed: true });
  });

  it('passes the reason of a rejection', async () => {
    const { ipc } = setup();
    const pending = ipc.requestRecheck();
    expect(ipc.receiveRecheckResult(result(false, 'GRANT_INVALID'))).toBe(true);
    await expect(pending).resolves.toEqual({ allowed: false, reason: 'GRANT_INVALID' });
  });

  it('does not allow the write when no result arrives in WORKER_WRITE_RECHECK_TIMEOUT_MS, and ignores a late result', async () => {
    vi.useFakeTimers();
    const { ipc } = setup();
    const pending = ipc.requestRecheck();
    vi.advanceTimersByTime(WORKER_WRITE_RECHECK_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toEqual({ allowed: false, reason: 'RECHECK_TIMEOUT' });
    expect(ipc.receiveRecheckResult(result(true))).toBe(false);
  });

  it('sends the request once: a second request is rejected without sending', async () => {
    const { sent, ipc } = setup();
    const first = ipc.requestRecheck();
    await expect(ipc.requestRecheck()).resolves.toEqual({ allowed: false, reason: 'RECHECK_ALREADY_REQUESTED' });
    ipc.receiveRecheckResult(result(true));
    await expect(first).resolves.toEqual({ allowed: true });
    await expect(ipc.requestRecheck()).resolves.toEqual({ allowed: false, reason: 'RECHECK_ALREADY_REQUESTED' });
    expect(sent.filter(({ type }) => type === 'WRITE_RECHECK_REQUEST')).toHaveLength(1);
  });

  it('does not accept a result that was not requested, or a second result', async () => {
    const { ipc } = setup();
    expect(ipc.receiveRecheckResult(result(true))).toBe(false);
    const pending = ipc.requestRecheck();
    expect(ipc.receiveRecheckResult(result(false, 'FACTS_UNAVAILABLE'))).toBe(true);
    expect(ipc.receiveRecheckResult(result(true))).toBe(false);
    await expect(pending).resolves.toEqual({ allowed: false, reason: 'FACTS_UNAVAILABLE' });
  });
});

describe('worker write IPC (T30e): the submission report', () => {
  it('sends the report once', () => {
    const { sent, ipc } = setup();
    expect(ipc.reportSubmission({ submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH' })).toBe(true);
    expect(ipc.reportSubmission({ submission: 'SENT', blockReason: null })).toBe(false);
    expect(sent).toEqual([{ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_SUBMISSION', submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH' }]);
  });
});

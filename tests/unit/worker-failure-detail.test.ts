// LZ-2: IPC の `FAILED` の詳細（`toWorkerFailureDetail`）は切り詰めない（前は 1,024 まで）。置き換えの細かい振る舞いは `worker-protocol.test.ts` の
// 「worker protocol: failure detail」。
import { describe, expect, it } from 'vitest';
import { toWorkerFailureDetail, validateWorkerToParentMessage, WORKER_PROTOCOL_VERSION } from '../../src/control/worker-protocol.js';

describe('worker protocol: the failure detail has no length limit (LZ-2)', () => {
  it('keeps a long detail whole and the message with it is accepted', () => {
    const detail = toWorkerFailureDetail('e'.repeat(1_025));
    expect(detail).toBe('e'.repeat(1_025));
    expect(validateWorkerToParentMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'FAILED', reason: 'UNEXPECTED_FAILURE', detail }).ok).toBe(true);
  });

  it('replaces the forbidden characters of long samples without cutting them', () => {
    const samples = [
      'a\r\nb\u0000c d',
      ` \ud83d${'\u0085'.repeat(1_025)}`,
    ];
    for (const sample of samples) {
      const detail = toWorkerFailureDetail(sample);
      expect(detail).toHaveLength(sample.length);
      expect(validateWorkerToParentMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'FAILED', reason: 'UNEXPECTED_FAILURE', detail }).ok).toBe(true);
    }
  });
});

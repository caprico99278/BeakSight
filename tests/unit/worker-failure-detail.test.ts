// PRE42-CC の組 2（台帳の CC-052・053 の残りのうち `worker-protocol.ts` の `toWellFormed()`）: IPC の契約の `toWorkerFailureDetail` は、切って
// U+FFFD にする形を `src/core/text.ts` の `truncateWellFormed`（組 4 の owner）で作る。寄せる前の形
// （`replaceControlOrLineSeparators(…).toWellFormed().slice(0, 上限).toWellFormed()`）と、同じ結果になることを確かめる（IPC の値が変わらない）。
// 置き換えと切り方の細かい振る舞いは `worker-protocol.test.ts` の「worker protocol: failure detail」。
import { describe, expect, it } from 'vitest';
import { MAX_WORKER_FAILURE_DETAIL_LENGTH, toWorkerFailureDetail } from '../../src/control/worker-protocol.js';
import { replaceControlOrLineSeparators } from '../../src/core/text.js';

const MAX = MAX_WORKER_FAILURE_DETAIL_LENGTH;

/** 寄せる前の `toWorkerFailureDetail` の形（比べの見本）。 */
const failureDetailBefore = (text: string): string => replaceControlOrLineSeparators(text, ' ').toWellFormed().slice(0, MAX).toWellFormed();

describe('worker protocol: the failure detail made with the owner of the well formed truncation (PRE42-CC group 2)', () => {
  it('gives the same failure detail as the form before the owner function', () => {
    const samples = [
      '',
      'a\r\nb\u0000c d',
      'x\ud800',
      '\udc00\ud800',
      'e'.repeat(MAX + 10),
      `${'e'.repeat(MAX - 1)}\u{1F600}`,
      `${'e'.repeat(MAX - 1)}𐀀tail`,
      `${'e'.repeat(MAX - 2)}\udc00𐀀`,
      `${'e'.repeat(MAX)}\ud800`,
      '\u{1F600}'.repeat(MAX),
      ` \ud83d${'\u0085'.repeat(MAX)}`,
    ];
    for (const sample of samples) {
      const detail = toWorkerFailureDetail(sample);
      expect(detail).toBe(failureDetailBefore(sample));
      expect(detail.length).toBeLessThanOrEqual(MAX);
      expect(detail.isWellFormed()).toBe(true);
    }
  });
});

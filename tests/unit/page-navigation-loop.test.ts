// L10 の S4（設計者の判断。2026-11-12）: ページが始めた移動の輪は、同じ移り（前の URL → 次の URL の組）が、この読み込みの中で 2 回目に出たときに止める。
// 1 回目の自分への読み込み直し（A→A）や A→B→A は通す。回数の上限ではなく、同じ移りのくり返しという事実で決める。
import { describe, expect, it } from 'vitest';
import { admitFrameNavigationTransition, startFrameNavigationRecord } from '../../src/safety/passive-request-guard.js';

const A = 'https://example.test/a';
const B = 'https://example.test/b';

describe('the loop of page-initiated navigations (L10 S4)', () => {
  it('passes the first reload to itself, and stops the same reload when it repeats', () => {
    const record = startFrameNavigationRecord(A);
    expect(admitFrameNavigationTransition(record, A)).toBe(true);
    expect(admitFrameNavigationTransition(record, A)).toBe(false);
  });

  it('passes A→B→A, and stops A→B when it comes again', () => {
    const record = startFrameNavigationRecord(A);
    expect([B, A, B].map((url) => admitFrameNavigationTransition(record, url))).toEqual([true, true, false]);
  });

  // SPEC-1: 撤廃した回数の上限（前は frame ごとに 2 回）の確かめ（単体 1 つ。結合の page-navigation-limit の「前の上限を超える移動」の場面の代わり）。
  it('does not stop moves to new URLs, beyond the former limit of 2', () => {
    const record = startFrameNavigationRecord(A);
    expect(Array.from({ length: 5 }, (_unused, index) => admitFrameNavigationTransition(record, `${B}?n=${String(index)}`))).toEqual([true, true, true, true, true]);
  });

  it('ignores the fragment, and starts over with a new record', () => {
    const record = startFrameNavigationRecord(`${A}#top`);
    expect(admitFrameNavigationTransition(record, `${A}#again`)).toBe(true);
    expect(admitFrameNavigationTransition(startFrameNavigationRecord(A), A)).toBe(true);
  });
});

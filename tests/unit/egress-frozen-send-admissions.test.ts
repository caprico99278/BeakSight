// SREV-SAFE の M-2: 凍結の段で Guard が通した読み取りでない要求（登録した読み取りの手続きの呼び出しと token の更新）の、中継の写し。同じ method と URL の
// 呼び出しが同時に 2 つあっても、Guard が通した数だけ中継も通す。Guard は 1 つの要求を CDP の層と route の層の両方で知らせるので、数えるのは CDP の層の知らせだけ
// （route の層だけの知らせは数えず、中継が拒む側）。写しのない要求は、今どおり通さない。
import { describe, expect, it } from 'vitest';
import { EgressFrozenSendAdmissions } from '../../src/browser/context-factory.js';

const URL_A = 'http://127.0.0.1:4173/api/read/list';

describe('the copies of the frozen non-read admissions for the egress proxy (SREV-SAFE M-2)', () => {
  it('passes as many identical calls as the Guard admitted, counting the CDP notification of each request once', () => {
    const admissions = new EgressFrozenSendAdmissions();
    admissions.admit('POST', URL_A, 'CDP_REQUEST');
    admissions.admit('POST', URL_A, 'ROUTE');
    admissions.admit('POST', URL_A, 'CDP_REQUEST');
    admissions.admit('POST', URL_A, 'ROUTE');
    expect([admissions.take('POST', URL_A), admissions.take('POST', URL_A), admissions.take('POST', URL_A)]).toEqual([true, true, false]);
  });

  // SREV-SAFE の N-1: CDP の層が数えた後に route の層が止めた要求は、数を 1 つ戻す（写しを残さない）。
  it('withdraws the copy of a request that the route layer blocked after the CDP layer counted it', () => {
    const admissions = new EgressFrozenSendAdmissions();
    admissions.admit('POST', URL_A, 'CDP_REQUEST');
    admissions.withdraw('POST', URL_A);
    admissions.withdraw('POST', URL_A);
    expect(admissions.take('POST', URL_A)).toBe(false);
  });

  it('does not count a notification of the route layer alone, and discards every copy', () => {
    const admissions = new EgressFrozenSendAdmissions();
    admissions.admit('POST', URL_A, 'ROUTE');
    expect(admissions.take('POST', URL_A)).toBe(false);
    admissions.admit('POST', URL_A, 'CDP_REQUEST');
    admissions.discard();
    expect(admissions.take('POST', URL_A)).toBe(false);
  });
});

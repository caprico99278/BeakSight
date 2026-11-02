// OP-REV3（I-2）: 書き込みの段の中継が使う、Guard が通した読み取りでない要求の写し（`src/browser/context-factory.ts` の `EgressSendAdmissions`）。
// - Guard は 1 つの要求を CDP の層と route の層の両方で知らせるが、写しは method と URL ごとに 1 つだけ（2 回知らせても、中継が通すのは 1 回）。
// - 送信の窓を開いたら（受けてよいかが偽になったら）、残っている写しを捨て、以後は受けず、使わせない。
// - 読み取りと、読めない URL は受けない。数は上限（`MAX_EGRESS_SEND_ADMISSIONS`）までで、古いものから捨てる。
// 例の値は、匿名の値（`example.com`）だけを使う。
import { describe, expect, it } from 'vitest';
import { EgressSendAdmissions, MAX_EGRESS_SEND_ADMISSIONS } from '../../src/browser/context-factory.js';

const URL_A = 'https://example.com/rpc/status';
const URL_B = 'https://example.com/rpc/usage';

describe('OP-REV3 (I-2): the copies of the non-read requests that the guard passed in the write stage', () => {
  it('keeps one copy for a request that the guard told twice (the CDP layer and the route layer), and lets the relay use it once', () => {
    const admissions = new EgressSendAdmissions(() => true);
    admissions.admit('POST', URL_A);
    admissions.admit('POST', URL_A);
    expect(admissions.size).toBe(1);
    expect(admissions.take('POST', URL_A)).toBe(true);
    expect(admissions.take('POST', URL_A)).toBe(false);
    expect(admissions.size).toBe(0);
  });

  it('compares the method in another letter case and the URL without the fragment, and does not take another request', () => {
    const admissions = new EgressSendAdmissions(() => true);
    admissions.admit('post', `${URL_A}#x`);
    expect(admissions.take('PUT', URL_A)).toBe(false);
    expect(admissions.take('POST', URL_B)).toBe(false);
    expect(admissions.take('POST', URL_A)).toBe(true);
  });

  it('drops the remaining copies once the submission window is opened, and neither keeps nor gives one after that', () => {
    let windowOpened = false;
    const admissions = new EgressSendAdmissions(() => !windowOpened);
    admissions.admit('POST', URL_A);
    admissions.admit('POST', URL_B);
    expect(admissions.size).toBe(2);
    windowOpened = true;
    expect(admissions.take('POST', URL_A)).toBe(false);
    expect(admissions.size).toBe(0);
    admissions.admit('POST', URL_B);
    expect(admissions.size).toBe(0);
    expect(admissions.take('POST', URL_B)).toBe(false);
  });

  it('treats a gate that throws as closed (fail-closed)', () => {
    const admissions = new EgressSendAdmissions(() => {
      throw new Error('cannot read');
    });
    admissions.admit('POST', URL_A);
    expect(admissions.size).toBe(0);
    expect(admissions.take('POST', URL_A)).toBe(false);
  });

  it('does not keep a read, a missing method or an unreadable URL, and drops the oldest copy over the limit', () => {
    const admissions = new EgressSendAdmissions(() => true);
    admissions.admit('GET', URL_A);
    admissions.admit(undefined, URL_A);
    admissions.admit('POST', 'not a url');
    expect(admissions.size).toBe(0);
    for (let index = 0; index <= MAX_EGRESS_SEND_ADMISSIONS; index += 1) {
      admissions.admit('POST', `${URL_A}?n=${String(index)}`);
    }
    expect(admissions.size).toBe(MAX_EGRESS_SEND_ADMISSIONS);
    expect(admissions.take('POST', `${URL_A}?n=0`)).toBe(false);
    expect(admissions.take('POST', `${URL_A}?n=${String(MAX_EGRESS_SEND_ADMISSIONS)}`)).toBe(true);
  });
});

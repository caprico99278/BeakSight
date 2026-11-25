// DEF-292 の残り（REV-CP の Minor-1・Minor-3）: route の層の「通した」の記録待ちの行は、持ち主の page の行だけを外し、page や Context を閉じたら捨てる。
import { describe, expect, it } from 'vitest';
import { AwaitedRouteAuditSends } from '../../src/safety/passive-request-guard.js';

const POST = { method: 'POST', url: 'http://127.0.0.1:1/same' };

describe('DEF-292 rest: the passed records waiting for the route layer', () => {
  it('takes the row of the page of the request, and a row moved at a detach of another page does not hide it', () => {
    const [pageA, pageB, sessionA, sessionB] = [{}, {}, {}, {}];
    const sends = new AwaitedRouteAuditSends();
    sends.add(sessionA, pageA, POST);
    sends.add(sessionB, pageB, POST);
    expect(sends.takeAtRoute(pageB, POST.method, POST.url)).toBe('AWAITING');
    // A の行は残っているので、A の target が外れたら「通した」へ移す（B の要求に取られていない）。
    expect(sends.moveDetached(sessionA)).toEqual([POST]);
    expect(sends.takeAtRoute(pageB, POST.method, POST.url)).toBeNull();
    // 持ち主の page が分からない要求は、今どおり最初に一致した行を外す。
    expect(sends.takeAtRoute(undefined, POST.method, POST.url)).toBe('MOVED');
  });

  it('drops the rows of a closed page, and every row when the Context closes', () => {
    const [pageA, pageB, sessionA, sessionB] = [{}, {}, {}, {}];
    const sends = new AwaitedRouteAuditSends();
    sends.add(sessionA, pageA, POST);
    sends.add(sessionB, pageB, POST);
    sends.moveDetached(sessionB);
    sends.discardPage(pageA);
    expect(sends.takeAtRoute(pageA, POST.method, POST.url)).toBeNull();
    sends.clear();
    expect(sends.takeAtRoute(pageB, POST.method, POST.url)).toBeNull();
  });
});

// CCX-6（共通化の台帳の CC-070）: 読み込みの後のセッションの切れの判定（Task 25 の設計書 4.3）の表を固定する。Page Auditor と、発見・READ の
// 確かめのワーカーの流れが、同じ部品（`sessionLostUrlOf`）を使う前後で、同じ結果になることを確かめる。
// - main frame の最後の URL（`page.url()`）の path が、セッションの切れの path の前方一致に当たれば、その URL。
// - 当たらなければ、Guard が監査の段の除外で止めた main frame の移動の先（`blockedAuditExclusions` の `mainFrameNavigation` が真の記録）の
//   うち、最初に当たる URL。
// - どれも当たらなければ `null`。
// 例の値は、匿名の値（`example.com`）だけを使う。
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { BlockedAuditExclusionEvent } from '../../src/core/evidence-types.js';
import { sessionLostUrlOf } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

const ORIGIN = 'https://example.com';
const PREFIX = '/login';

/** `url()` だけを持つ偽の page（判定は `page.url()` だけを読む）。 */
const pageAt = (url: string): Page => ({ url: () => url }) as unknown as Page;

/** 監査の段の除外で止めた要求を記録した Ledger。 */
function ledgerWith(events: readonly Pick<BlockedAuditExclusionEvent, 'url' | 'mainFrameNavigation'>[]): SafetyLedger {
  const ledger = new SafetyLedger();
  for (const { url, mainFrameNavigation } of events) {
    ledger.recordBlockedAuditExclusion({ method: 'GET', url, mainFrameNavigation, reason: 'AUDIT_EXCLUDED_URL' });
  }
  return ledger;
}

const cases: readonly {
  readonly name: string;
  readonly pageUrl: string;
  readonly events: readonly Pick<BlockedAuditExclusionEvent, 'url' | 'mainFrameNavigation'>[];
  readonly expected: string | null;
}[] = [
  { name: 'the final URL is on the login path', pageUrl: `${ORIGIN}/login?expired=1`, events: [], expected: `${ORIGIN}/login?expired=1` },
  { name: 'the final URL is under the login path', pageUrl: `${ORIGIN}/login/form`, events: [], expected: `${ORIGIN}/login/form` },
  { name: 'the final URL only has the login path in the query', pageUrl: `${ORIGIN}/admin?next=/login`, events: [], expected: null },
  { name: 'the final URL is not a URL with a path (about:blank)', pageUrl: 'about:blank', events: [], expected: null },
  { name: 'the final URL is an ordinary page', pageUrl: `${ORIGIN}/admin/items`, events: [], expected: null },
  {
    name: 'a main frame navigation to the login path was blocked',
    pageUrl: `${ORIGIN}/admin/items`,
    events: [{ url: `${ORIGIN}/login`, mainFrameNavigation: true }],
    expected: `${ORIGIN}/login`,
  },
  {
    name: 'a subresource request to the login path was blocked (not a main frame navigation)',
    pageUrl: `${ORIGIN}/admin/items`,
    events: [{ url: `${ORIGIN}/login`, mainFrameNavigation: false }],
    expected: null,
  },
  {
    name: 'a main frame navigation to another excluded path was blocked',
    pageUrl: `${ORIGIN}/admin/items`,
    events: [{ url: `${ORIGIN}/admin/logout`, mainFrameNavigation: true }],
    expected: null,
  },
  {
    name: 'several blocked navigations: the first one on the login path',
    pageUrl: `${ORIGIN}/admin/items`,
    events: [
      { url: `${ORIGIN}/login/a`, mainFrameNavigation: false },
      { url: `${ORIGIN}/admin/logout`, mainFrameNavigation: true },
      { url: `${ORIGIN}/login/b`, mainFrameNavigation: true },
      { url: `${ORIGIN}/login/c`, mainFrameNavigation: true },
    ],
    expected: `${ORIGIN}/login/b`,
  },
  {
    name: 'both the final URL and a blocked navigation: the final URL',
    pageUrl: `${ORIGIN}/login/final`,
    events: [{ url: `${ORIGIN}/login/blocked`, mainFrameNavigation: true }],
    expected: `${ORIGIN}/login/final`,
  },
];

describe('sessionLostUrlOf: the session lost judgement after a navigation (fixed before CCX-6)', () => {
  it.each(cases)('$name', ({ pageUrl, events, expected }) => {
    expect(sessionLostUrlOf(pageAt(pageUrl), ledgerWith(events), PREFIX)).toBe(expected);
  });
});

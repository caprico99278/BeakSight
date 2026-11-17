// COV-4（網羅の設計書 3.2）と L5 の N5（Desktop だけのリンクの決まりの見直し）: 見るだけの点検で読んだページの、待ち行列に渡す事実。ブラウザを使わない。
// - 辺は、どのビューポートのリンクの記録からも作る（Mobile にだけある導線も、出た先を辺にする）。重なりは待ち行列が除く。
// - 同じページの両方のビューポートのリンクの記録を、http 以外の scheme のリンクの数で 2 回数えない（Desktop の記録を使い、なければ Mobile）。
import { describe, expect, it } from 'vitest';
import type { LinkEvidence } from '../../src/core/evidence-types.js';
import { auditPageOutcomeOf } from '../../src/orchestration/audit-page-structure.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, fixtureUrl, page, record } from '../helpers/audit-run-fixture.js';

const internal = (path: string): LinkEvidence => {
  const url = fixtureUrl(path);
  return {
    sourcePageId: PAGE_1, anchorText: path, ariaLabel: null, title: null, rawHref: path,
    normalized: { ok: true, url }, admission: { kind: 'INTERNAL_NAVIGABLE', url }, truncated: false,
  };
};
const tel: LinkEvidence = {
  sourcePageId: PAGE_1, anchorText: '電話', ariaLabel: null, title: null, rawHref: 'tel:0120000000',
  normalized: { ok: false, rawUrl: 'tel:0120000000', reason: 'UNSUPPORTED_SCHEME' },
  admission: { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: 'tel:0120000000', scheme: 'tel' }, truncated: false,
};

const pageWithLinks = () => page(PAGE_1, '/', 'AUDITED', [
  record('link', 1, PAGE_1, 'desktop', { links: [internal('/shared'), tel], omittedLinkCount: 0, frames: [fixtureUrl('/frame.html')] }),
  record('link', 2, PAGE_1, 'mobile', { links: [internal('/shared'), internal('/mobile-only'), tel], omittedLinkCount: 0 }),
]);

describe('L5 N5: the links of every viewport become edges', () => {
  it('makes edges from the desktop and the mobile link records', () => {
    expect(auditPageOutcomeOf(pageWithLinks()).edges).toEqual([
      { kind: 'LINK', url: fixtureUrl('/shared') },
      { kind: 'FRAME', url: fixtureUrl('/frame.html') },
      { kind: 'LINK', url: fixtureUrl('/shared') },
      { kind: 'LINK', url: fixtureUrl('/mobile-only') },
    ]);
  });

  it('does not count the same special scheme link twice when both viewports recorded the links', () => {
    expect(buildReportViewModel(auditRun({ pages: [pageWithLinks()] })).summary.specialSchemeLinks.total).toBe(1);
  });
});

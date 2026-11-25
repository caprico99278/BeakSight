// COV-4（網羅の設計書 3.2）と L5 の N5（Desktop だけのリンクの決まりの見直し）: 見るだけの点検で読んだページの、待ち行列に渡す事実。ブラウザを使わない。
// - 辺は、どのビューポートのリンクの記録からも作る（Mobile にだけある導線も、出た先を辺にする）。重なりは待ち行列が除く。
// - 同じページの両方のビューポートのリンクの記録を、http 以外の scheme のリンクの数で 2 回数えない（Desktop の記録を使い、なければ Mobile）。
import { describe, expect, it } from 'vitest';
import type { CollectedDomEvidence, InteractionCandidateEvidence, LayoutEvidence, LinkEvidence } from '../../src/core/evidence-types.js';
import { auditPageContentDigestOf, auditPageOutcomeOf, auditPageTemplateKeyOf } from '../../src/orchestration/audit-page-structure.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { EMPTY_STRESS_LAYOUT } from '../helpers/fake-audit-load-ports.js';
import { PAGE_1, auditRun, dom, fixtureUrl, page, record } from '../helpers/audit-run-fixture.js';

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

// DUP（ユーザーの判断 2026-11-18）: 作りの鍵はデータを抜いた形（名前・文字・番号の違いでは変わらない）。中身の要約は表示の中身で決め、href は入れない。
describe('DUP: the template key and the content digest of a page', () => {
  const customerDom = (name: string, overrides: Partial<CollectedDomEvidence> = {}): CollectedDomEvidence => ({
    ...dom(1, PAGE_1, 'desktop', `顧客 ${name} 戻る`, { headings: [{ level: 1, text: name, truncated: false }] }).payload,
    ...overrides,
  });
  const button = (name: string, href: string | null, overrides: Partial<InteractionCandidateEvidence> = {}): InteractionCandidateEvidence => ({
    candidateId: `interaction-candidate:${name}`, ordinal: 0, tagName: href === null ? 'button' : 'a', role: null, accessibleName: name,
    textFingerprint: `sha256:${name}`, ariaExpanded: null, ariaControls: null, ariaSelected: null, controlledVisible: null, controlledHidden: null,
    formAssociated: false, formMethod: null, formAction: null, href, hrefKind: href === null ? 'NONE' : 'SAME_ORIGIN_HTTP', download: false, type: null,
    disabled: false, visible: true, destructiveAction: false, boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  } as InteractionCandidateEvidence);
  const layout = (scrollHeight: number): LayoutEvidence => ({
    ...EMPTY_STRESS_LAYOUT,
    document: { ...EMPTY_STRESS_LAYOUT.document, documentElementScrollWidth: 1280, documentElementScrollHeight: scrollHeight },
  });

  it('gives the same template key to pages that differ only in their data (names, numbers and the links to their records)', () => {
    const taro = auditPageTemplateKeyOf(customerDom('太郎'), fixtureUrl('/customers/12?returnTo=%2Fcustomers'), [button('太郎を編集', fixtureUrl('/customers/12/edit'))]);
    const hanako = auditPageTemplateKeyOf(customerDom('花子'), fixtureUrl('/customers/13?returnTo=%2Fhome'), [button('花子を編集', fixtureUrl('/customers/13/edit'))]);
    expect(taro).toBe(hanako);
  });

  // REV-DUP の I-2・I-3: path の日付と英数字の番号、電話や外のサイトの行き先、番号や戻り先の query の値はデータとして扱い、語の query の値は作りに入れる。
  it('treats dates, numbered codes, phone or external destinations and returnTo values as data, and keeps word values of the query', () => {
    const keyOf = (path: string, href: string): string => auditPageTemplateKeyOf(customerDom('x'), fixtureUrl(path), [
      button('電話', href, { hrefKind: href.startsWith('tel:') ? 'SPECIAL_SCHEME' : 'EXTERNAL_ORIGIN_HTTP' }),
    ]);
    expect(keyOf('/orders/ORD-00123/2026-11-18?returnTo=%2Fa', 'tel:0120000001')).toBe(keyOf('/orders/ORD-00456/2026-11-19?returnTo=%2Fb', 'tel:0120000002'));
    expect(keyOf('/day?date=2026-11-18', 'https://maps.example.org/1')).toBe(keyOf('/day?date=2026-11-19', 'https://maps.example.org/2'));
    expect(keyOf('/settings?screen=A', 'tel:1')).not.toBe(keyOf('/settings?screen=B', 'tel:1'));
  });

  it('gives another template key to a page that has another kind of control', () => {
    const plain = auditPageTemplateKeyOf(customerDom('太郎'), fixtureUrl('/customers/12'), [button('編集', fixtureUrl('/customers/12/edit'))]);
    const withButton = auditPageTemplateKeyOf(customerDom('花子'), fixtureUrl('/customers/13'), [button('編集', fixtureUrl('/customers/13/edit')), button('取り消す', null)]);
    expect(withButton).not.toBe(plain);
  });

  it('gives the same content digest to pages whose shown content is the same, and another one when the text, the field values or the size differs', () => {
    const base = auditPageContentDigestOf(customerDom('太郎', { fieldValuesDigest: 'sha256:a' }), layout(2000));
    expect(auditPageContentDigestOf(customerDom('太郎', { fieldValuesDigest: 'sha256:a' }), layout(2000))).toBe(base);
    expect(auditPageContentDigestOf(customerDom('花子', { fieldValuesDigest: 'sha256:a' }), layout(2000))).not.toBe(base);
    expect(auditPageContentDigestOf(customerDom('太郎', { fieldValuesDigest: 'sha256:b' }), layout(2000))).not.toBe(base);
    expect(auditPageContentDigestOf(customerDom('太郎', { fieldValuesDigest: 'sha256:a' }), layout(2400))).not.toBe(base);
  });

  it('gives no content digest without the layout (the content cannot be compared)', () => {
    expect(auditPageContentDigestOf(customerDom('太郎'), null)).toBeNull();
  });
});

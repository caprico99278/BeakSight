// R15a（Task 14〜17 の設計書 5.6.3）: 監査しなかった URL の `PageAuditResult`。
import { describe, expect, it } from 'vitest';
import type { IncompleteReason, PageId } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createPageId } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { derivePageAuditStatus } from '../../src/core/status.js';
import { skippedPageResult } from '../../src/orchestration/skipped-page.js';

const URL_ = 'http://127.0.0.1:8080/crawl/deep.html' as NormalizedHttpUrlEvidence;
const PAGE_ID: PageId = createPageId(3);
const REASON: IncompleteReason = { code: 'MAX_PAGES_REACHED', detail: null };

function expectDeeplyFrozen(value: unknown, path = 'result'): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  expect(Object.isFrozen(value), `${path} is frozen`).toBe(true);
  for (const [key, child] of Object.entries(value)) {
    expectDeeplyFrozen(child, `${path}.${key}`);
  }
}

describe('skippedPageResult', () => {
  it('skips both viewports without navigation, identity, Evidence, or Findings, and keeps the reason', () => {
    const result = skippedPageResult(URL_, PAGE_ID, REASON);

    const skippedViewport = {
      requestedUrl: URL_,
      finalUrl: null,
      httpStatus: null,
      status: 'SKIPPED',
      incompleteReasons: [REASON],
      navigationOutcome: null,
    };
    expect(result).toEqual({
      schemaVersion: 'page-schema/1.0',
      pageId: PAGE_ID,
      pageUrl: URL_,
      status: 'SKIPPED',
      viewports: { desktop: skippedViewport, mobile: skippedViewport },
      evidence: [],
      findings: [],
      // ページ全体の理由は、両方のビューポートの同じ理由を1つにまとめたもの（設計書 4.5.5）。
      incompleteReasons: [REASON],
    });
  });

  it('derives the SKIPPED page status from the viewport statuses', () => {
    const result = skippedPageResult(URL_, PAGE_ID, REASON);

    expect(derivePageAuditStatus([result.viewports.desktop.status, result.viewports.mobile.status])).toBe('SKIPPED');
    expect(result.status).toBe(derivePageAuditStatus([result.viewports.desktop.status, result.viewports.mobile.status]));
  });

  it('returns a deeply frozen result that does not share the caller reason object', () => {
    const reason = { code: 'MAX_DEPTH_REACHED', detail: 'depth 4 > maxDepth 3' } as const;
    const result = skippedPageResult(URL_, PAGE_ID, reason);

    expectDeeplyFrozen(result);
    expect(result.incompleteReasons[0]).toEqual(reason);
    expect(result.incompleteReasons[0]).not.toBe(reason);
    expect(Object.isFrozen(reason)).toBe(false);
  });

  it.each([
    { code: 'MAX_PAGES_REACHED', detail: null },
    { code: 'MAX_DEPTH_REACHED', detail: 'depth 4' },
    { code: 'MAX_RUNTIME_REACHED', detail: null },
  ] as const)('matches the page schema for the reason $code', async (reason) => {
    const result = skippedPageResult(URL_, PAGE_ID, reason);

    await expect(validateArtifact('page', JSON.parse(JSON.stringify(result)) as unknown)).resolves.toEqual({ ok: true });
  });

  it.each([
    ['an unknown reason code', { code: 'SOMETHING_ELSE', detail: null }],
    ['a reason without detail', { code: 'MAX_PAGES_REACHED' }],
    ['a numeric detail', { code: 'MAX_PAGES_REACHED', detail: 1 }],
    ['a missing reason', null],
  ])('rejects %s', (_label, reason) => {
    expect(() => skippedPageResult(URL_, PAGE_ID, reason as unknown as IncompleteReason)).toThrow(TypeError);
  });

  it.each([
    ['an empty URL', '', PAGE_ID],
    ['a non-string URL', 1, PAGE_ID],
    ['a non-string page ID', URL_, 1],
    ['an empty page ID', URL_, ''],
  ])('rejects %s', (_label, url, pageId) => {
    expect(() => skippedPageResult(url as NormalizedHttpUrlEvidence, pageId as PageId, REASON)).toThrow(TypeError);
  });
});

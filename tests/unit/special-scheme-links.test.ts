// AUD-4c: http・https 以外の scheme のリンク（tel:・mailto: など）は、不具合として数えない。表示用モデルが件数と事実（ページ・scheme・リンクの文字・href）を
// 数え、バンドルの `summary.json` にだけ出す（指摘にしない。リンクの記録は消さない）。HTML の本文には出さない。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { LinkEvidence } from '../../src/core/evidence-types.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, metadata, page, record } from '../helpers/audit-run-fixture.js';

const special = (rawUrl: string, scheme: string, anchorText: string): LinkEvidence => ({
  sourcePageId: PAGE_1,
  anchorText,
  ariaLabel: null,
  title: null,
  rawHref: rawUrl,
  normalized: { ok: false, rawUrl, reason: 'UNSUPPORTED_SCHEME' },
  admission: { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl, scheme },
  truncated: false,
});

const run = () => auditRun({
  pages: [page(PAGE_1, '/', 'AUDITED', [
    metadata(1, PAGE_1),
    record('link', 20, PAGE_1, 'desktop', {
      links: [special('tel:0120000000', 'tel', '電話する'), special('mailto:info@example.invalid', 'mailto', 'メール'), special('tel:0120000000', 'tel', '電話')],
      omittedLinkCount: 0,
    }),
  ])],
});

describe('AUD-4c: the links with a special scheme are facts, not problems', () => {
  it('counts them by scheme and keeps the facts of each link in the report model', () => {
    expect(buildReportViewModel(run()).summary.specialSchemeLinks).toEqual({
      total: 3,
      byScheme: [{ scheme: 'mailto', count: 1 }, { scheme: 'tel', count: 2 }],
      links: [
        { pageId: PAGE_1, scheme: 'tel', rawUrl: 'tel:0120000000', anchorText: '電話する' },
        { pageId: PAGE_1, scheme: 'mailto', rawUrl: 'mailto:info@example.invalid', anchorText: 'メール' },
        { pageId: PAGE_1, scheme: 'tel', rawUrl: 'tel:0120000000', anchorText: '電話' },
      ],
    });
  });

  it('copies them to summary.json of the bundle with the reading note', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    }
    const entries = unzipSync(await createChatGptBundle(model, result, async (path) => files.get(path) ?? null));
    const summary = JSON.parse(new TextDecoder().decode(entries['summary.json'])) as { readonly specialSchemeLinks: unknown };
    expect(summary.specialSchemeLinks).toEqual(JSON.parse(JSON.stringify(model.summary.specialSchemeLinks)));
    expect(new TextDecoder().decode(entries['README.md'])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.specialSchemeLinksNote);
  });
});

// COV-6: 件数の上限で打ち切らずに分けて集めた新しい形の記録（`collectedInParts` を持ち、リンク 3,000・axe の要素 150 など今までの上限を超える件数）で、
// page の schema、view-model、HTML のレポート、ChatGPT 用のバンドルの組み立てが通ることを、見本 1 本で確かめる。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { COLLECTED_IN_PARTS_SAMPLE_COUNTS, collectedInPartsAuditRun } from '../helpers/audit-run-fixture.js';

const encoder = new TextEncoder();

describe('新しい形の記録（COV-6）でのレポートとバンドルの組み立て', () => {
  const result = collectedInPartsAuditRun();
  const [page] = result.pages;

  it('page の記録が schema に合う（collectedInParts と、上限を超える件数）', async () => {
    expect(page).toBeDefined();
    const validation = await validateArtifact('page', page);
    expect(validation).toEqual({ ok: true });
    const link = page?.evidence.find((evidence) => evidence.type === 'link');
    expect(link?.type === 'link' ? link.payload.links : []).toHaveLength(COLLECTED_IN_PARTS_SAMPLE_COUNTS.links);
  });

  it('view-model と HTML のレポートが組み立てられ、axe の要素ごとの Finding が全部入る', () => {
    const viewModel = buildReportViewModel(result);
    const html = renderHtmlReport(viewModel);
    expect(html).toContain('#image-0');
    expect(html).toContain(`#image-${COLLECTED_IN_PARTS_SAMPLE_COUNTS.axeNodes - 1}`);
    expect(html).not.toContain('件数の上限のため記録しなかった');
  });

  it('ChatGPT 用のバンドルが組み立てられ、page.json に全部の件数が入る', async () => {
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
      for (const evidence of value.evidence) {
        if (evidence.type === 'screenshot') {
          files.set(evidence.payload.relativePath, encoder.encode('png'));
        }
        if (evidence.type === 'dom' && evidence.viewport === 'desktop') {
          files.set(pageArtifactRelativePath(value.pageId, 'visibleText'), encoder.encode(evidence.payload.visibleText.text));
        }
      }
    }
    const bundle = await createChatGptBundle(buildReportViewModel(result), result, async (path) => files.get(path) ?? null);
    const entries = unzipSync(bundle);
    const pageJsonPath = Object.keys(entries).find((path) => path.endsWith(pageArtifactRelativePath(page!.pageId, 'page')));
    expect(pageJsonPath).toBeDefined();
    const bundledPage = JSON.parse(new TextDecoder().decode(entries[pageJsonPath!])) as typeof page;
    const bundledLink = bundledPage?.evidence.find((evidence) => evidence.type === 'link');
    expect(bundledLink?.type === 'link' ? bundledLink.payload : null).toMatchObject({ omittedLinkCount: 0, collectedInParts: 2 });
    expect(bundledLink?.type === 'link' ? bundledLink.payload.links : []).toHaveLength(COLLECTED_IN_PARTS_SAMPLE_COUNTS.links);
  });
});

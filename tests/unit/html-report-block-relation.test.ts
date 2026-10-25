// BN-c・BN-d（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.3・3.5）と BN-R0 の M-3: HTML レポートの、BeakSight の遮断と指摘の
// 関係の印と件数。表示（ラベル・色・順）は表示カタログ、件数は表示用モデルの値のまま。
import { describe, expect, it } from 'vitest';
import { BEAKSIGHT_BLOCK_RELATIONS } from '../../src/core/beaksight-block-relation.js';
import { BEAKSIGHT_BLOCK_RELATION_CATALOG, BLOCKED_EVENT_PHASE_CATALOG, sortByDisplayOrder } from '../../src/presentation/catalog.js';
import { formatCount } from '../../src/presentation/format.js';
import { HTML_REPORT_TEXT, blockedEventPhaseCountText, describeBeakSightBlockRelationReason } from '../../src/presentation/messages.js';
import { escapeHtml, renderBadge, toAnchorId } from '../../src/report/html-components.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { auditRun, beaksightBlockAuditRun } from '../helpers/audit-run-fixture.js';

/** Finding の行（アンカーから次の行の終わりまで）。 */
const findingRowOf = (html: string, findingId: string): string => {
  const start = html.indexOf(`id="${toAnchorId('finding', findingId)}"`);
  expect(start, findingId).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf('</tr>', start));
};

describe('renderHtmlReport: the marks of the relation to the BeakSight blocks (BN-c, BN-d)', () => {
  it('marks the CAUSED and POSSIBLE Findings with the catalog badge and the reason, and leaves the NONE Findings unmarked', () => {
    const model = buildReportViewModel(beaksightBlockAuditRun());
    const html = renderHtmlReport(model);
    for (const view of model.findings) {
      const row = findingRowOf(html, view.finding.findingId);
      const relation = view.beaksightBlockRelation;
      for (const value of BEAKSIGHT_BLOCK_RELATIONS) {
        const badge = renderBadge(BEAKSIGHT_BLOCK_RELATION_CATALOG[value], value).html;
        const expected = relation?.relation === value && BEAKSIGHT_BLOCK_RELATION_CATALOG[value].badgeInFindingRow;
        expect(row.includes(badge), `${view.finding.findingId} ${value}`).toBe(expected);
      }
      if (relation !== null && BEAKSIGHT_BLOCK_RELATION_CATALOG[relation.relation].badgeInFindingRow) {
        expect(row).toContain(escapeHtml(describeBeakSightBlockRelationReason(relation.reason)));
      }
    }
  });

  it('marks a SAFETY Finding of a block while closing with the catalog badge of the phase and the count (BN-R0 M-3)', () => {
    const model = buildReportViewModel(beaksightBlockAuditRun());
    const safetyView = model.findings.find((view) => view.safetyBlockPhaseCounts !== null);
    expect(safetyView?.safetyBlockPhaseCounts).toEqual({ LOAD: 0, CLOSING: 1 });
    const row = findingRowOf(renderHtmlReport(model), safetyView?.finding.findingId ?? '');
    expect(row).toContain(renderBadge(BLOCKED_EVENT_PHASE_CATALOG.CLOSING, 'CLOSING').html);
    expect(row).toContain(escapeHtml(blockedEventPhaseCountText(formatCount(1))));
    expect(row).not.toContain(renderBadge(BLOCKED_EVENT_PHASE_CATALOG.LOAD, 'LOAD').html);
  });

  it('shows the counts of the relations and of the body of the ChatGPT bundle in the summary, from the view model', () => {
    const model = buildReportViewModel(beaksightBlockAuditRun());
    const html = renderHtmlReport(model);
    const counts = model.summary.beaksightBlockRelation;
    expect(html).toContain(escapeHtml(HTML_REPORT_TEXT.summary.blockRelationNote));
    for (const relation of sortByDisplayOrder(BEAKSIGHT_BLOCK_RELATIONS, BEAKSIGHT_BLOCK_RELATION_CATALOG)) {
      expect(html).toContain(escapeHtml(HTML_REPORT_TEXT.summary.blockRelationCount(BEAKSIGHT_BLOCK_RELATION_CATALOG[relation].label)));
    }
    expect(html).toContain(escapeHtml(HTML_REPORT_TEXT.summary.bundleMainFindings));
    expect(counts.byRelation).toEqual({ CAUSED: 1, POSSIBLE: 1, NONE: 2 });
    expect(counts.mainFindingCounts.total).toBe(2);
  });

  it('does not mark a Run without blocks', () => {
    const html = renderHtmlReport(buildReportViewModel(auditRun()));
    for (const relation of BEAKSIGHT_BLOCK_RELATIONS) {
      expect(html.includes(renderBadge(BEAKSIGHT_BLOCK_RELATION_CATALOG[relation], relation).html), relation).toBe(false);
    }
  });
});

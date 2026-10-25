// BN-d（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.5）: CLI の `run` の結果の行に、BeakSight の遮断と結び付く指摘
// （本体から外したサイト品質の指摘）の件数の 1 行を足す。値は表示用モデルの `summary.beaksightBlockRelation` のまま。結び付く指摘がなければ出さない。
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSummaryLines } from '../../src/cli/output.js';
import { BEAKSIGHT_BLOCK_RELATION_CATALOG, SEVERITY_GROUP_CATALOG, SEVERITY_GROUPS, sortByDisplayOrder } from '../../src/presentation/catalog.js';
import { BEAKSIGHT_BLOCK_RELATION_SUMMARY_TEXT, cliCountText, cliFieldText, findingGroupCountsLabelText, listText } from '../../src/presentation/messages.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { auditRun, beaksightBlockAuditRun } from '../helpers/audit-run-fixture.js';

const RUN_DIRECTORY = join('artifacts', 'RUN-20260924000000');

describe('CLI run: the line of the Findings linked to the BeakSight blocks (BN-d)', () => {
  it('shows the counts of CAUSED and POSSIBLE right after the finding counts, from the view model', () => {
    const { summary } = buildReportViewModel(beaksightBlockAuditRun());
    const lines = runSummaryLines(summary, RUN_DIRECTORY);
    const expected = cliFieldText(
      BEAKSIGHT_BLOCK_RELATION_SUMMARY_TEXT.label,
      BEAKSIGHT_BLOCK_RELATION_SUMMARY_TEXT.value(listText([
        cliCountText(BEAKSIGHT_BLOCK_RELATION_CATALOG.CAUSED.label, '1件'),
        cliCountText(BEAKSIGHT_BLOCK_RELATION_CATALOG.POSSIBLE.label, '1件'),
      ])),
    );
    const groupIndexes = sortByDisplayOrder(SEVERITY_GROUPS, SEVERITY_GROUP_CATALOG).map((group) =>
      lines.findIndex((line) => line.startsWith(`${findingGroupCountsLabelText(SEVERITY_GROUP_CATALOG[group].label)}: `)));
    expect(lines.indexOf(expected)).toBe(Math.max(...groupIndexes) + 1);
  });

  it('does not show the line when no Finding is linked to a block', () => {
    const lines = runSummaryLines(buildReportViewModel(auditRun()).summary, RUN_DIRECTORY);
    expect(lines.some((line) => line.startsWith(`${BEAKSIGHT_BLOCK_RELATION_SUMMARY_TEXT.label}: `))).toBe(false);
  });
});

// AUD-8: 色差の「測定できない」（axe の incomplete）の件数と理由を表示用モデルで数え、バンドルの `summary.json` に写す。HTML の本文には出さない。
// 「閾値未満」（violation）とは分ける。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { AccessibilityNodeEvidence, AccessibilityRuleEvidence } from '../../src/core/evidence-types.js';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, metadata, page, record } from '../helpers/audit-run-fixture.js';

const contrastNode = (messageKey: string | null): AccessibilityNodeEvidence => ({
  impact: 'serious',
  targetSelectors: ['#t'],
  failureSummary: null,
  htmlSnippet: '<p id="t">t</p>',
  truncated: false,
  checks: [{ id: 'color-contrast', group: 'any', result: 'UNDETERMINED', messageKey, data: {} }],
  truncations: [],
  disabledFacts: { status: 'NOT_FOUND' },
  countExclusion: null,
});

const rule = (ruleId: string, nodes: readonly AccessibilityNodeEvidence[]): AccessibilityRuleEvidence => ({
  ruleId, impact: 'serious', help: 'help', helpUrl: 'https://rules.test/x', tags: [], nodes, omittedNodeCount: 0,
});

const run = () => {
  const axe = record('accessibility', 30, PAGE_1, 'desktop', {
    status: 'COMPLETE',
    frameScope: 'SAME_ORIGIN_ONLY',
    scrollPosition: { scrollX: 0, scrollY: 0 },
    // 閾値未満（violation）は「測定できない」に数えない。
    violations: [rule('color-contrast', [contrastNode(null)])],
    incomplete: [
      rule('color-contrast', [contrastNode('bgImage'), contrastNode('bgImage'), contrastNode('bgGradient'), contrastNode(null)]),
      // 色差でない incomplete は数えない。
      rule('aria-hidden-focus', [contrastNode('focusable')]),
    ],
  });
  return auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), axe])] });
};

describe('AUD-8: 色差の「測定できない」の数', () => {
  it('表示用モデルが、色差の incomplete の要素の数と、理由（messageKey）ごとの数を数える', () => {
    const model = buildReportViewModel(run());
    expect(model.summary.contrastUnmeasured).toEqual({
      nodeCount: 4,
      byReason: [
        { messageKey: 'bgImage', count: 2 },
        { messageKey: 'bgGradient', count: 1 },
        { messageKey: null, count: 1 },
      ],
    });
  });

  it('バンドルの summary.json に写し、HTML の本文には出さない', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    expect(renderHtmlReport(model)).not.toContain('bgGradient');
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    }
    const entries = unzipSync(await createChatGptBundle(model, result, async (path) => files.get(path) ?? null));
    const summary = JSON.parse(new TextDecoder().decode(entries['summary.json'])) as { readonly contrastUnmeasured: unknown };
    expect(summary.contrastUnmeasured).toEqual(JSON.parse(JSON.stringify(model.summary.contrastUnmeasured)));
    expect(new TextDecoder().decode(entries['README.md'])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.contrastUnmeasuredNote);
  });
});

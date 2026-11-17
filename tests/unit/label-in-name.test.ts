// AUD-4b: 名前の不一致（WCAG 2.5.3 Label in Name）の比べ方の表と、補足の文字の区分。無効の判定の 1 か所（AX の状態を含む）。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { LABEL_IN_NAME_CLASSES, labelInNameOf } from '../../src/audit/label-in-name.js';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import { disabledFactsEvidenceOf } from '../../src/evidence/accessibility-collector.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, finding, idOf, metadata, page, record } from '../helpers/audit-run-fixture.js';
import { bundledFindingsOf } from '../helpers/bundle-findings.js';

describe('the closed list of the label-in-name classes', () => {
  it('has the four classes', () => {
    expect(LABEL_IN_NAME_CLASSES).toEqual(['MAIN_LABEL_MISSING', 'SUPPLEMENT_ONLY_MISSING', 'UNDETERMINED', 'LABEL_IN_NAME']);
  });
});

describe('the table of comparing the visible label with the name', () => {
  const cases = [
    {
      name: 'the main label is not in the name (送信 / button-1)',
      input: { name: 'button-1', segments: ['送信'] },
      expected: { labelClass: 'MAIN_LABEL_MISSING', mainLabel: [], supplements: [], lowersConfidence: false },
    },
    {
      name: 'only the badge of another text is not in the name (設定 + 3 / 設定)',
      input: { name: '設定', segments: ['設定 ', '3'] },
      expected: { labelClass: 'SUPPLEMENT_ONLY_MISSING', mainLabel: ['設定'], supplements: ['3'], lowersConfidence: true },
    },
    {
      name: 'a part of one text is not in the name, so the main label cannot be told (設定 3 / 設定)',
      input: { name: '設定', segments: ['設定 3'] },
      expected: { labelClass: 'UNDETERMINED', mainLabel: [], supplements: [], lowersConfidence: true },
    },
    {
      name: 'the whole visible label is in the name (case and spaces do not matter)',
      input: { name: 'Save  the File now', segments: ['save the ', 'file'] },
      expected: { labelClass: 'LABEL_IN_NAME', mainLabel: ['save the', 'file'], supplements: [], lowersConfidence: true },
    },
    {
      name: 'no name or no visible label cannot be told',
      input: { name: null, segments: ['送信'] },
      expected: { labelClass: 'UNDETERMINED', mainLabel: [], supplements: [], lowersConfidence: true },
    },
  ] as const;
  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(labelInNameOf(input)).toEqual(expected);
    });
  }

  it('does not pass a label only because the main label is contained: a missing main text keeps the finding without lowering', () => {
    // 見える文字の 2 つのかたまりのどちらも名前にない（主なラベルも補足も名前にない）。
    expect(labelInNameOf({ name: 'menu', segments: ['設定', '3'] })).toMatchObject({ labelClass: 'MAIN_LABEL_MISSING', lowersConfidence: false });
  });
});

describe('the label-in-name context of each finding in the report model and the bundle', () => {
  const node = (selector: string, axName: string, labelSegments: readonly string[]) => ({
    impact: 'serious', targetSelectors: [selector], failureSummary: null, htmlSnippet: '<button>', truncated: false,
    nameContext: { status: 'READ', axName, axRole: 'button', axDisabled: false, nameSource: { type: 'attribute', attribute: 'aria-label' }, labelSegments },
  });
  const run = () => {
    const axe = record('accessibility', 30, PAGE_1, 'desktop', {
      status: 'COMPLETE', frameScope: 'SAME_ORIGIN_ONLY', scrollPosition: { scrollX: 0, scrollY: 0 },
      violations: [{
        ruleId: 'label-content-name-mismatch', impact: 'serious', help: 'h', helpUrl: 'https://rules.test/x', tags: [], omittedNodeCount: 0,
        nodes: [node('#badge', '設定', ['設定 ', '3']), node('#wrong', 'button-1', ['送信'])],
      }],
      incomplete: [],
    } as never);
    // 同じ要素の指摘を 2 つずつ（候補群の発生の数を 2 にして、確信度の差だけを見る）。
    const findings = ['#badge', '#badge', '#wrong', '#wrong'].map((selector, index) => finding(70 + index, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(axe)], {
      ruleId: 'A11Y_LABEL_CONTENT_NAME_MISMATCH', groupingKeys: [{ name: 'target', value: JSON.stringify([selector]) }],
    }));
    return auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), axe], findings)] });
  };

  it('puts the class, the AX name and the label pieces on the finding, and lowers the confidence only when the main label is in the name', () => {
    const model = buildReportViewModel(run());
    expect(model.findings[0]?.verification.labelInName).toEqual({
      labelClass: 'SUPPLEMENT_ONLY_MISSING', axName: '設定', nameSource: { type: 'attribute', attribute: 'aria-label' },
      labelSegments: ['設定 ', '3'], mainLabel: ['設定'], supplements: ['3'],
    });
    expect(model.findings[2]?.verification.labelInName).toMatchObject({ labelClass: 'MAIN_LABEL_MISSING', axName: 'button-1' });
    const confidenceOf = (selector: string): string | undefined => model.findingGroups
      .find((group) => group.groupingKeys.some(({ value }) => value === JSON.stringify([selector])))?.confidence;
    expect(confidenceOf('#wrong')).toBe('MEDIUM');
    expect(confidenceOf('#badge')).toBe('LOW');
  });

  it('copies the context to the Finding files of the bundle, and keeps the codes out of the HTML body', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    expect(renderHtmlReport(model)).not.toContain('SUPPLEMENT_ONLY_MISSING');
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    }
    const entries = unzipSync(await createChatGptBundle(model, result, async (path) => files.get(path) ?? null));
    const findings = bundledFindingsOf<{ readonly verification: { readonly labelInName?: unknown } }>(entries);
    expect(findings.map(({ verification }) => verification.labelInName ?? null)).toContainEqual(expect.objectContaining({ labelClass: 'SUPPLEMENT_ONLY_MISSING' }));
    expect(new TextDecoder().decode(entries['README.md'])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.labelInNameNote);
  });
});

describe('the one place of the disabled judgement (with the AX state)', () => {
  const facts = {
    matchesDisabled: false, disabledAttribute: null, ariaDisabled: null, inert: null, pointerEvents: 'auto', cursor: 'auto', tabIndexNegative: false,
  };

  it('treats an element that the accessibility tree marks disabled as disabled for the assistive technology', () => {
    expect(disabledFactsEvidenceOf(facts, true)).toMatchObject({ status: 'READ', axDisabled: true, disabledForAssistiveTech: true });
    expect(disabledFactsEvidenceOf(facts, false)).toMatchObject({ axDisabled: false, disabledForAssistiveTech: false });
    // AX を読めなかったときは、今までどおり DOM の事実だけで決める（`axDisabled` は null）。
    expect(disabledFactsEvidenceOf(facts)).toMatchObject({ axDisabled: null, disabledForAssistiveTech: false });
  });

  it('does not treat a pale look alone as disabled', () => {
    expect(disabledFactsEvidenceOf(facts, false)).toMatchObject({ disabledForAssistiveTech: false, disabledStateNotExposed: false });
  });
});

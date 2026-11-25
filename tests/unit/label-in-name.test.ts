// AUD-4b: 名前の不一致（WCAG 2.5.3 Label in Name）の比べ方の表と、補足の文字の区分。無効の判定の 1 か所（AX の状態を含む）。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ACCESSIBILITY_RULES } from '../../src/audit/accessibility-rules.js';
import { LABEL_IN_NAME_CLASSES, LABEL_IN_NAME_RULE_ID, labelInNameOf } from '../../src/audit/label-in-name.js';
import { RuleEngine } from '../../src/audit/rule-engine.js';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import { disabledFactsEvidenceOf } from '../../src/evidence/accessibility-collector.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, finding, idOf, metadata, page, record } from '../helpers/audit-run-fixture.js';
import { bundledFindingsOf } from '../helpers/bundle-findings.js';

describe('the closed list of the label-in-name classes', () => {
  it('has the five classes', () => {
    expect(LABEL_IN_NAME_CLASSES).toEqual(['MAIN_LABEL_MISSING', 'SUPPLEMENT_ONLY_MISSING', 'UNDETERMINED', 'LABEL_IN_NAME', 'NORMALIZED_MATCH']);
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
      // APS-2: 先頭のかたまりが名前になければ、後のかたまりが名前にあっても違反。
      name: 'the leading text is not in the name, even when a later text is (サイト + 案内 / 案内)',
      input: { name: '案内', segments: ['サイト', '案内'] },
      expected: { labelClass: 'MAIN_LABEL_MISSING', mainLabel: [], supplements: [], lowersConfidence: false },
    },
    {
      name: 'only the texts after the leading text are not in the name (設定 + 3 / 設定)',
      input: { name: '設定', segments: ['設定 ', '3'] },
      expected: { labelClass: 'SUPPLEMENT_ONLY_MISSING', mainLabel: ['設定'], supplements: ['3'], lowersConfidence: true },
    },
    {
      // APS-2: 区切りの記号だけのかたまりは先頭にしない。先頭のかたまりの区切りの記号の違いも見ない。
      name: 'a leading separator and a separator in the leading text do not matter (｜ + 一覧｜ + 詳細 / 一覧の画面)',
      input: { name: '一覧の画面', segments: ['｜', '一覧｜', '詳細'] },
      expected: { labelClass: 'SUPPLEMENT_ONLY_MISSING', mainLabel: ['一覧｜'], supplements: ['詳細'], lowersConfidence: true },
    },
    {
      name: 'the whole visible label is in the name (case and spaces do not matter)',
      input: { name: 'Save  the File now', segments: ['save the ', 'file'] },
      expected: { labelClass: 'LABEL_IN_NAME', mainLabel: ['save the', 'file'], supplements: [], lowersConfidence: true },
    },
    {
      // AUD-5（S-01b）: 日付・曜日の書き方の違いは、数字の並びとして比べる。
      name: 'a date written in another form is a notation difference (11/19(水) / 2026年11月19日 水曜日)',
      input: { name: '2026年11月19日 水曜日', segments: ['11/19(水)'] },
      expected: { labelClass: 'NORMALIZED_MATCH', mainLabel: ['11/19(水)'], supplements: [], lowersConfidence: true },
    },
    {
      name: 'a short date in the label and a long date with more words in the name (3/5(金) / 日付 2027年3月5日（金）。選ぶ)',
      input: { name: '日付 2027年3月5日（金）。選ぶ', segments: ['3/5(金)'] },
      expected: { labelClass: 'NORMALIZED_MATCH', mainLabel: ['3/5(金)'], supplements: [], lowersConfidence: true },
    },
    {
      name: 'full-width digits and separators are a notation difference (１１／１９ / 11月19日)',
      input: { name: '11月19日', segments: ['１１／１９'] },
      expected: { labelClass: 'NORMALIZED_MATCH', mainLabel: ['１１／１９'], supplements: [], lowersConfidence: true },
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
        nodes: [node('#blank', '', ['設定']), node('#wrong', 'button-1', ['送信'])],
      }],
      incomplete: [],
    } as never);
    // 同じ要素の指摘を 2 つずつ（候補群の発生の数を 2 にして、確信度の差だけを見る）。
    const findings = ['#blank', '#blank', '#wrong', '#wrong'].map((selector, index) => finding(70 + index, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(axe)], {
      ruleId: 'A11Y_LABEL_CONTENT_NAME_MISMATCH', groupingKeys: [{ name: 'target', value: JSON.stringify([selector]) }],
    }));
    return auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), axe], findings)] });
  };

  it('puts the class, the AX name and the label pieces on the finding, and lowers the confidence when the class cannot be told', () => {
    const model = buildReportViewModel(run());
    expect(model.findings[0]?.verification.labelInName).toEqual({
      labelClass: 'UNDETERMINED', axName: '', nameSource: { type: 'attribute', attribute: 'aria-label' },
      labelSegments: ['設定'], mainLabel: [], supplements: [],
    });
    expect(model.findings[2]?.verification.labelInName).toMatchObject({ labelClass: 'MAIN_LABEL_MISSING', axName: 'button-1' });
    const confidenceOf = (selector: string): string | undefined => model.findingGroups
      .find((group) => group.groupingKeys.some(({ value }) => value === JSON.stringify([selector])))?.confidence;
    expect(confidenceOf('#wrong')).toBe('MEDIUM');
    expect(confidenceOf('#blank')).toBe('LOW');
  });

  it('copies the context to the Finding files of the bundle, and keeps the codes out of the HTML body', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    expect(renderHtmlReport(model)).not.toContain('MAIN_LABEL_MISSING');
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    }
    const entries = unzipSync(await createChatGptBundle(model, result, async (path) => files.get(path) ?? null));
    const findings = bundledFindingsOf<{ readonly verification: { readonly labelInName?: unknown } }>(entries);
    expect(findings.map(({ verification }) => verification.labelInName ?? null)).toContainEqual(expect.objectContaining({ labelClass: 'UNDETERMINED' }));
    expect(new TextDecoder().decode(entries['README.md'])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.labelInNameNote);
  });
});

// APS-2: 先頭の見えるラベルが名前にない要素と、かたまりを読めない要素だけを指摘にする（axe の違反は証拠に残る）。区分を候補群の鍵に入れ、区分の違う指摘を
// 同じ群にしない。読めない群は確信度を 1 段下げる。
describe('the label-in-name findings and their groups', () => {
  it('makes findings only of the missing leading label and of the unreadable context, in two groups', () => {
    const node = (index: number, label?: { readonly axName: string; readonly segments: readonly string[] }) => ({
      impact: 'serious', targetSelectors: [`li:nth-of-type(${index}) > button`], failureSummary: null, htmlSnippet: '<button class="b">', truncated: false,
      ...(label === undefined ? {} : {
        nameContext: { status: 'READ', axName: label.axName, axRole: 'button', axDisabled: false, nameSource: { type: 'attribute', attribute: 'aria-label' }, labelSegments: label.segments },
      }),
    });
    const axe = record('accessibility', 30, PAGE_1, 'desktop', {
      status: 'COMPLETE', frameScope: 'SAME_ORIGIN_ONLY', scrollPosition: { scrollX: 0, scrollY: 0 },
      violations: [{
        ruleId: 'label-content-name-mismatch', impact: 'serious', help: 'h', helpUrl: 'https://rules.test/x', tags: [], omittedNodeCount: 0,
        nodes: [
          node(1, { axName: '設定', segments: ['設定 ', '3'] }),
          node(2, { axName: 'button-1', segments: ['送信'] }),
          node(3, { axName: 'button-2', segments: ['保存'] }),
          node(4, { axName: '2026年11月19日 水曜日', segments: ['11/19(水)'] }),
          node(5, { axName: 'Save the file', segments: ['save', 'file'] }),
          node(6, { axName: '一覧', segments: ['一覧｜'] }),
          node(7),
          node(8),
        ],
      }],
      incomplete: [],
    } as never);
    const { findings } = new RuleEngine({ targetId: 'aps2', firstFindingSequence: 1, catalog: ACCESSIBILITY_RULES })
      .evaluate({ pageId: PAGE_1, pageUrl: page(PAGE_1, '/').pageUrl, viewport: 'desktop', evidence: [axe] });
    expect(findings.map((finding) => /li:nth-of-type\((\d)\)/u.exec(finding.message)?.[1]).sort()).toEqual(['2', '3', '7', '8']);
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), axe], findings)] }));
    const groups = model.findingGroups.filter((group) => group.ruleId === LABEL_IN_NAME_RULE_ID);
    const confidenceOf = (selector: string) => groups.find((group) => group.findingIds.includes(
      findings.find((finding) => finding.message.includes(selector))?.findingId ?? ('' as never)))?.confidence;
    expect(groups.map((group) => group.occurrenceCount)).toEqual([2, 2]);
    expect(confidenceOf('li:nth-of-type(2)')).toBe('MEDIUM');
    expect(confidenceOf('li:nth-of-type(7)')).toBe('LOW');
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

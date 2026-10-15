// T32f（Task 32 の設計書 4.1 の `action-report.html` の行、UI の共通の決まり）: 書き込みの報告の HTML（`src/report/action-report.ts` の
// `renderActionReport`）。表示用モデルを、`html-components.ts` の部品だけで描く。
// - エスケープ: 送った値・前後の値・READ の文字に `<script>`・`"`・`&` を入れても、そのままの HTML にならない。
// - 先頭の注意: 人の値が入りうるとき（`containsHumanEnteredValues`）と、`UNKNOWN`・`PARTIAL` のとき。
// - バッジ: カタログのラベルと値（`data-value`）。文言は `ACTION_REPORT_TEXT` とカタログから。同じ入力から同じ文字列。
import { describe, expect, it } from 'vitest';
import {
  ACTION_RESULT_CATALOG,
  AUTOMATED_ACTION_CATALOG,
  HUMAN_DECISION_CATALOG,
  SIDE_EFFECT_CONFIRMATION_CATALOG,
} from '../../src/presentation/catalog.js';
import { ACTION_REPORT_TEXT } from '../../src/presentation/messages.js';
import { escapeHtml } from '../../src/report/html-components.js';
import { buildActionViewModel } from '../../src/report/action-view-model.js';
import { renderActionReport } from '../../src/report/action-report.js';
import {
  unknownDocuments,
  verifiedCreateDocuments,
  verifiedUpdateDocuments,
  type ActionReportDocuments,
} from '../helpers/action-report-samples.js';

const htmlOf = (documents: ActionReportDocuments): string => renderActionReport(buildActionViewModel(documents));

const DANGEROUS = '<script>alert("x")</script> & "q"';

/** 結果の節の見出し（見出しの文「結果」は、お知らせの文にも含まれうるので、見出しの要素で探す）。 */
const SUMMARY_HEADING = `>${escapeHtml(ACTION_REPORT_TEXT.sections.summary)}</h2>`;

/** 送った値・前後の値・READ の取れた値と URL に、HTML として意味を持つ文字を入れた UPDATE。 */
const dangerousDocuments = (): ActionReportDocuments => {
  const base = verifiedUpdateDocuments();
  const executed = base.evidence.readVerification as Extract<ActionReportDocuments['evidence']['readVerification'], { readonly state: 'EXECUTED' }>;
  return {
    ...base,
    evidence: {
      ...base.evidence,
      submission: { ...base.evidence.submission, submittedValues: { name: DANGEROUS } },
      update: {
        targetRecordId: '1001',
        updateEvidence: { fields: [{ fieldName: 'name', role: 'CHANGED', previousValue: DANGEROUS, newValue: DANGEROUS, matched: true }] },
      },
      readVerification: {
        ...executed,
        url: `http://127.0.0.1:4173/members?q=${DANGEROUS}`,
        expectations: [{ expectation: { kind: 'DETAIL_FIELD_EQUALS', field: '氏名', value: DANGEROUS }, result: 'MATCHED', undeterminedReason: null, observedValue: DANGEROUS }],
      },
    },
  };
};

describe('action report HTML (T32f)', () => {
  it('is a static document with the title, the result badge and the reason from the catalogs', () => {
    const html = htmlOf(verifiedCreateDocuments());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain(`<title>${escapeHtml(ACTION_REPORT_TEXT.title)}</title>`);
    expect(html).toContain(`data-value="VERIFIED">${escapeHtml(ACTION_RESULT_CATALOG.VERIFIED.label)}</span>`);
    expect(html).toContain('data-value="READ_VERIFICATION_MATCHED"');
    expect(html).toContain(escapeHtml(ACTION_REPORT_TEXT.sections.approval));
    expect(html).toContain(escapeHtml(ACTION_REPORT_TEXT.atStartNote));
    for (const spec of [HUMAN_DECISION_CATALOG.SCENARIO_APPROVAL, AUTOMATED_ACTION_CATALOG.SUBMISSION, SIDE_EFFECT_CONFIRMATION_CATALOG.NOT_DESTRUCTIVE]) {
      expect(html).toContain(escapeHtml(spec.label));
    }
    expect(html).not.toContain(escapeHtml(HUMAN_DECISION_CATALOG.UPDATE_FIELD_ROLES.label));
    expect(html).not.toContain(escapeHtml(ACTION_REPORT_TEXT.humanEnteredValuesHeading));
    expect(htmlOf(verifiedCreateDocuments())).toBe(html);
  });

  it('puts the notice of the values entered by people first, before the result', () => {
    const html = htmlOf(verifiedUpdateDocuments());
    const notice = html.indexOf(escapeHtml(ACTION_REPORT_TEXT.humanEnteredValuesHeading));
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(html.indexOf(SUMMARY_HEADING));
    expect(html).toContain(escapeHtml(ACTION_REPORT_TEXT.humanEnteredValuesBody));
    expect(html).toContain(escapeHtml('前の 名前'));
    expect(html).toContain(escapeHtml(HUMAN_DECISION_CATALOG.UPDATE_FIELD_ROLES.label));
  });

  it('puts the notice of an unknown result first, with the text of the catalog', () => {
    const html = htmlOf(unknownDocuments());
    const { heading, body } = ACTION_REPORT_TEXT.resultNotices.UNKNOWN;
    expect(html.indexOf(escapeHtml(heading))).toBeGreaterThan(0);
    expect(html.indexOf(escapeHtml(heading))).toBeLessThan(html.indexOf(SUMMARY_HEADING));
    expect(html).toContain(escapeHtml(body));
    expect(html).toContain(escapeHtml(ACTION_REPORT_TEXT.readNotExecuted));
  });

  it('escapes the sent values, the prior and new values and the READ texts', () => {
    const html = htmlOf(dangerousDocuments());
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert("x")');
    expect(html).toContain(escapeHtml(DANGEROUS));
    expect(html.split(escapeHtml(DANGEROUS)).length - 1).toBeGreaterThanOrEqual(4);
  });

  it('never makes the READ URL a link (one click must not run a request)', () => {
    const html = htmlOf(verifiedCreateDocuments());
    expect(html).toContain(escapeHtml('http://127.0.0.1:4173/members?q=%E3%82%B5'));
    expect(html).not.toContain('href="http://127.0.0.1:4173/members');
  });
});

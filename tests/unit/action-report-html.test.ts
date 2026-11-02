// T32f（Task 32 の設計書 4.1 の `action-report.html` の行、UI の共通の決まり）: 書き込みの報告の HTML（`src/report/action-report.ts` の
// `renderActionReport`）。表示用モデルを、`html-components.ts` の部品だけで描く。
// - エスケープ: 送った値・前後の値・READ の文字に `<script>`・`"`・`&` を入れても、そのままの HTML にならない。
// - 先頭の注意: 人の値が入りうるとき（`containsHumanEnteredValues`）と、`UNKNOWN`・`PARTIAL` のとき。
// - バッジ: カタログのラベルと値（`data-value`）。文言は `ACTION_REPORT_TEXT` とカタログから。同じ入力から同じ文字列。
import { createHash } from 'node:crypto';
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
  SAMPLE_API_ORIGIN,
  blockedApiDocuments,
  blockedDocuments,
  sampleApiSummary,
  unknownDocuments,
  verifiedApiCreateDocuments,
  verifiedApiUpdateDocuments,
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

// T40d（Task 40 の設計書 3.4、3.5）: API の要約の節の HTML と、FORM の HTML が変わらないこと。
// - FORM の HTML は、T40d の前のコードで描いた文字列の SHA-256 で固定する。PL-W（設計書 `2026-10-26-beaksight-plain-ui-design.md` 5 章）で、画面と共有の
//   表示カタログの言葉（シナリオ → 書き込みの手順、照合 → 答え合わせ など）を変えたので、その後の文字列の SHA-256 に固定し直した（描き方は変えていない）。
//   PL-R（同じ設計書 14 章）で、報告の共通のスタイルシート（`html-tokens.ts`。本文の最大幅 50rem、行の高さ、表の文字、見出しの段）を変えたので、固定し直した。
//   スタイルシートを前のものに置き換えると、前の SHA-256 に一致することを確かめた（中身と描き方は変えていない）。
// - API の節: 見出し、送り方のバッジ、判定の説明、ページが決める鍵の値（null の印、送らなかった回）。値はエスケープし、送り先はリンクにしない。
const sha256Of = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
/** API の節の見出し（見出しの要素で探す）。 */
const apiHeading = (): string => `>${escapeHtml(ACTION_REPORT_TEXT.sections.api)}</h2>`;

describe('action report HTML of an API write, and the unchanged FORM HTML (T40d)', () => {
  it.each<readonly [string, () => ActionReportDocuments, string]>([
    // PL-6a: 判定の表示の文言（カタログの「成功の条件に当たった」など）を構造の判定に合う文に直したので、値を求め直した（描き方は変えていない）。
    // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D11・D12）: 表示カタログの「書き換え」を「更新」に、「SMS」を「メールや電話への知らせ」に
    // そろえたので、値を求め直した。今の文字列のその語だけを前の語に戻すと、前の SHA-256 に一致することを確かめた（中身と描き方は変えていない）。
    ['a verified create', verifiedCreateDocuments, 'sha256:3e9c8773b26444dc8b4ab91987e0495b7ac19f3efb3e93c225f7fe66e6957db0'],
    ['a verified update', verifiedUpdateDocuments, 'sha256:d6e0bdc9eedc0f8690491099b86115d4239c3dfb1ea34f5e4a59bea115eadc28'],
    ['a blocked run', blockedDocuments, 'sha256:2b733e5986c85e4187e78295fe66b4d87e03b45981e45672559bc03a53915e71'],
  ])('keeps the FORM HTML of %s byte for byte', (_label, documents, expected) => {
    expect(sha256Of(htmlOf(documents()))).toBe(expected);
  });

  it('puts the API section with the transport badge, the shape, the keys and the note of the judgement', () => {
    const html = htmlOf(verifiedApiCreateDocuments());
    const apiText = ACTION_REPORT_TEXT.api;
    expect(html).toContain(apiHeading());
    expect(html).toContain('data-value="API"');
    expect(html).toContain(escapeHtml(apiText.judgementNote));
    for (const value of [SAMPLE_API_ORIGIN, '/rest/v1/members', 'tenant_id', '"tenant-1"', 'x-client-info']) {
      expect(html, value).toContain(escapeHtml(value));
    }
    // 送り先はリンクにしない（1 回のクリックで要求を送らせない）。
    expect(html).not.toContain(`href="${SAMPLE_API_ORIGIN}`);
    // FORM の HTML には API の節がない。
    expect(htmlOf(verifiedCreateDocuments())).not.toContain(apiHeading());
  });

  it('shows the cut mark and the run that was not sent with the texts of the catalog', () => {
    const base = verifiedApiCreateDocuments();
    const api = sampleApiSummary({ pageKeyValues: { tenant_id: null } });
    expect(htmlOf({ ...base, actionRun: { ...base.actionRun, api }, evidence: { ...base.evidence, api } }))
      .toContain(escapeHtml(ACTION_REPORT_TEXT.api.pageKeyValueCut));
    expect(htmlOf(blockedApiDocuments())).toContain(escapeHtml(ACTION_REPORT_TEXT.api.pageKeyValuesNotRecorded));
  });

  // T41e: API の更新は、API の節と前後の差分の節を両方置く（API の節は差分の前）。ページが決める鍵の値は、更新では残さない文言で示す。
  it('puts both the API section and the update diff of an API update', () => {
    const html = htmlOf(verifiedApiUpdateDocuments());
    const api = html.indexOf(apiHeading());
    const diff = html.indexOf(`>${escapeHtml(ACTION_REPORT_TEXT.sections.update)}</h2>`);
    expect(api).toBeGreaterThan(0);
    expect(diff).toBeGreaterThan(api);
    expect(html).toContain(`>${escapeHtml('PATCH')}</code>`);
    expect(html).toContain(escapeHtml(ACTION_REPORT_TEXT.api.pageKeyValueNotKeptForUpdate));
    expect(html).toContain(escapeHtml('新しい 名前'));
    expect(html).toContain(escapeHtml(ACTION_REPORT_TEXT.keptDiffHeading));
  });

  it('escapes the page key values and the names of the API summary', () => {
    const base = verifiedApiCreateDocuments();
    const api = sampleApiSummary({ pageKeyNames: [DANGEROUS], pageKeyValues: { [DANGEROUS]: JSON.stringify(DANGEROUS) }, httpFieldNames: [DANGEROUS] });
    const html = htmlOf({ ...base, actionRun: { ...base.actionRun, api }, evidence: { ...base.evidence, api } });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert("x")');
    expect(html).toContain(escapeHtml(JSON.stringify(DANGEROUS)));
    // 鍵の名前（表の行）と、許すヘッダの名前（一覧の文）。値は JSON の文字列なので、上の確かめで見る。
    expect(html.split(escapeHtml(DANGEROUS)).length - 1).toBeGreaterThanOrEqual(2);
  });
});

// T40c（Task 40 の設計書 3.4、4 章、7 章の履歴の「T40a の報告（API の検証の指定）」「設計者の判断（順の入れ替え）」）: 書き込みの記録と報告の版 1.1。
// - 書き手は 1.1 を書き、読み手は 1.1 だけを受ける（LG-4 で前の版 1.0 を捨てた。契約の版の一覧とスキーマの enum の一致は
//   `schema-enum-consistency.test.ts`）。
// - 1.1 は送り方（`transport`）と API の要約（`api`。FORM は null）を持つ。API は成否の条件（`resultConditions`）を持たない（null）。FORM は今のまま
//   必須。この組は、スキーマと手書きの確かめ（`actionRunRuleErrors`）の両方で縛る。
// - API の要約: method、Origin、path の型、型の digest、欄に対応する鍵の名前、ページが決める鍵の名前、許すヘッダの名前（`httpFieldNames`）、ID の鍵、
//   ページが決める鍵の値（JSON の scalar を JSON の文字列にした形。長さが `MAX_SUBMITTED_VALUE_LENGTH` を超えたら値を残さずに null の印）。ヘッダの値・
//   応答の本文・本文の生の値は持たない（I22）。
// - API の応答の判定（`apiResponseJudgementOf`）: 2xx は SUCCESS、429 は RATE_LIMITED、ほかの 4xx は INPUT_ERROR、5xx は SERVER_ERROR、それ以外は
//   NO_CONDITION_MATCHED。ID がない・安全でない 2xx は `actionOutcomeOf` が成功と偽らない。閉じた一覧は増やさない。
// - 親の照らし合わせ（`actionRunMatchesWriteStart`）: 記録の送り方と API の要約が、`START` の API の指定（承認したもの）と同じか。
// - 手書きの確かめの誤りの文に、値と名前を入れない。報告の確かめは、記録と証拠の送り方と要約が同じことも照らす。表示は 1.1 でも壊れない。
// 値は匿名の合成のテストデータだけ。
import { describe, expect, it } from 'vitest';
import {
  ACTION_EVIDENCE_SCHEMA_VERSION,
  ACTION_OUTCOME_REASONS,
  ACTION_RUN_SCHEMA_VERSION,
  MAX_SUBMITTED_VALUE_LENGTH,
  RESPONSE_JUDGEMENTS,
  type ActionEvidenceDocument,
  type ActionRunDocument,
} from '../../src/control/actions/action-contracts.js';
import {
  actionApiSummaryOf,
  actionRunMatchesWriteStart,
  actionRunRuleErrors,
} from '../../src/control/actions/action-api-summary.js';
import { actionOutcomeOf, apiResponseJudgementOf } from '../../src/control/actions/action-outcome.js';
import { SCENARIO_TRANSPORTS, type ScenarioApiSpec } from '../../src/control/approval/scenario-contracts.js';
import { checkWriteReport } from '../../src/control/job/write-report-check.js';
import { actionBundleBytesOf } from '../../src/core/action-bundle-bytes.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  actionBundleFileName,
} from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { ACTION_REPORT_TEXT } from '../../src/presentation/messages.js';
import { renderActionReport } from '../../src/report/action-report.js';
import { buildActionViewModel } from '../../src/report/action-view-model.js';
import {
  SAMPLE_API_ORIGIN,
  SAMPLE_API_PATH,
  SAMPLE_API_SHAPE_DIGEST,
  blockedApiDocuments,
  blockedDocuments,
  sampleApiSummary,
  verifiedApiCreateDocuments,
  verifiedCreateDocuments,
  verifiedUpdateDocuments,
  type ActionReportDocuments,
} from '../helpers/action-report-samples.js';
import { propertyNamesWithWords, readSchemaFile, SECRET_PROPERTY_WORDS } from '../helpers/schema-test-support.js';

const runSchema = readSchemaFile('action-run.schema.json');
const evidenceSchema = readSchemaFile('action-evidence.schema.json');

/** 承認した API の指定の見本（見本の文書の要約と同じ型）。鍵は順を崩して渡す（要約は鍵の順に並べる）。 */
const API_SPEC: ScenarioApiSpec = Object.freeze({
  shapeDigest: SAMPLE_API_SHAPE_DIGEST,
  request: {
    method: 'POST', origin: SAMPLE_API_ORIGIN, pathShape: SAMPLE_API_PATH, queryNames: ['select'], contentType: 'application/json',
    prefer: ['return=representation'],
  },
  keyFields: [
    { key: 'name', type: 'string', field: { kind: 'NAME', name: 'name' }, fieldType: 'text' },
    { key: 'email', type: 'string', field: { kind: 'SELECTOR', selector: '#member-email' }, fieldType: 'email' },
  ],
  pageKeys: [{ key: 'tenant_id', type: 'string' }],
  headerNames: ['x-client-info'],
  filterName: null,
  recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
  ledger: null,
} satisfies ScenarioApiSpec);

/** 秘密の目印（ヘッダの値、応答の本文、送った値。誤りの文と要約に出ないこと）。 */
const HEADER_VALUE_MARKER = 'bsT40cHeaderValue0001';
const RESPONSE_BODY_MARKER = 'bsT40cResponseBody0001';
const VALUE_MARKER = 'bsT40cValue0001';

const apiRun = (overrides: Partial<ActionRunDocument> = {}): ActionRunDocument => ({ ...verifiedApiCreateDocuments().actionRun, ...overrides });
const formRun = (overrides: Partial<ActionRunDocument> = {}): ActionRunDocument => ({ ...verifiedCreateDocuments().actionRun, ...overrides });
const apiEvidence = (overrides: Partial<ActionEvidenceDocument> = {}): ActionEvidenceDocument =>
  ({ ...verifiedApiCreateDocuments().evidence, ...overrides });
const without = (value: object, key: string): unknown => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
/** LG-4: 前の版 1.0 の書き手の形（送り方と API の要約の項目を除き、版の印を 1.0 にする）。今の読み手が受けないことを確かめるためだけに使う。 */
const version10Of = (document: object, schemaVersion: string): unknown =>
  ({ ...Object.fromEntries(Object.entries(document).filter(([name]) => name !== 'transport' && name !== 'api')), schemaVersion });

describe('T40c: the version 1.1 of the write record and report (contracts and schemas)', () => {
  it('writes 1.1 and keeps the artifact ids', () => {
    expect(ACTION_RUN_SCHEMA_VERSION).toBe('action-run-schema/1.1');
    expect(ACTION_EVIDENCE_SCHEMA_VERSION).toBe('action-evidence-schema/1.1');
    // 成果物の id は変えない（版は `schemaVersion` で分ける。`read-evidence` と同じ作り）。
    expect(runSchema.$id).toBe('urn:beaksight:schema:action-run:1.0');
    expect(evidenceSchema.$id).toBe('urn:beaksight:schema:action-evidence:1.0');
  });

  it('lists the transports of the scenario contract, and has no property named like a secret (the header names are httpFieldNames)', () => {
    expect(runSchema.$defs?.['transport']?.enum).toEqual([...SCENARIO_TRANSPORTS]);
    expect(propertyNamesWithWords(runSchema, SECRET_PROPERTY_WORDS)).toEqual([]);
    expect(propertyNamesWithWords(evidenceSchema, SECRET_PROPERTY_WORDS)).toEqual([]);
    const summary = runSchema.$defs?.['apiSummary'];
    expect(summary?.additionalProperties).toBe(false);
    expect(Object.keys(summary?.properties ?? {}).sort()).toEqual([
      'httpFieldNames', 'keyNames', 'method', 'origin', 'pageKeyNames', 'pageKeyValues', 'pathShape', 'recordIdKey', 'shapeDigest',
    ]);
  });

  it.each<readonly [string, unknown]>([
    ['a FORM run of 1.1', formRun()],
    ['a blocked FORM run of 1.1', blockedDocuments().actionRun],
    ['an UPDATE run of 1.1', verifiedUpdateDocuments().actionRun],
    ['a verified API run', apiRun()],
    ['a blocked API run (no value of the page keys)', blockedApiDocuments().actionRun],
    ['an API run whose page key value was too long (the cut mark null)', apiRun({ api: sampleApiSummary({ pageKeyValues: { tenant_id: null } }) })],
    ['an API run with a JSON null page key value', apiRun({ api: sampleApiSummary({ pageKeyValues: { tenant_id: 'null' } }) })],
    ['an API run without a record id key', apiRun({ api: sampleApiSummary({ recordIdKey: null }) })],
    ['an unknown API run (sent, no response)', apiRun({
      httpStatus: null, responseJudgement: null, recordId: null, readVerification: null, reservationState: 'UNKNOWN', result: 'UNKNOWN', reason: 'NO_RESPONSE',
    })],
  ])('accepts %s (action-run)', async (_label, document) => {
    expect(await validateArtifact('action-run', document)).toEqual({ ok: true });
  });

  it.each<readonly [string, unknown]>([
    ['an unknown version', formRun({ schemaVersion: 'action-run-schema/1.2' as never })],
    ['a 1.1 run without the transport', without(formRun(), 'transport')],
    ['a 1.1 run without the API summary', without(formRun(), 'api')],
    ['an unknown transport', formRun({ transport: 'GRAPHQL' as never })],
    ['a FORM run with an API summary', formRun({ api: sampleApiSummary() })],
    ['a FORM run without the result conditions', formRun({ resultConditions: null })],
    ['an API run with the result conditions', apiRun({ resultConditions: formRun().resultConditions })],
    ['an API run without the API summary', apiRun({ api: null })],
    // LG-4: 前の版 1.0 は読まない（1.0 の書き手の形も、今の形に 1.0 の印を付けたものも）。
    ['a FORM run of the previous version 1.0', version10Of(formRun(), 'action-run-schema/1.0')],
    ['a blocked FORM run of the previous version 1.0', version10Of(blockedDocuments().actionRun, 'action-run-schema/1.0')],
    ['a run of the current shape with the version 1.0', formRun({ schemaVersion: 'action-run-schema/1.0' as never })],
    ['a blocked API run with page key values', { ...blockedApiDocuments().actionRun, api: sampleApiSummary() }],
    ['a too long page key value', apiRun({ api: sampleApiSummary({ pageKeyValues: { tenant_id: 'x'.repeat(MAX_SUBMITTED_VALUE_LENGTH + 1) } }) })],
    ['a page key value that is not a string', apiRun({ api: sampleApiSummary({ pageKeyValues: { tenant_id: 1 as never } }) })],
    ['an API summary with a header value', apiRun({ api: { ...sampleApiSummary(), authorization: HEADER_VALUE_MARKER } as never })],
    ['an API summary with the response body', apiRun({ api: { ...sampleApiSummary(), responseBody: RESPONSE_BODY_MARKER } as never })],
    ['an API summary without keys', apiRun({ api: sampleApiSummary({ keyNames: [] }) })],
    ['an API summary with a repeated key', apiRun({ api: sampleApiSummary({ keyNames: ['email', 'email'] }) })],
    ['an API summary with a bad shape digest', apiRun({ api: sampleApiSummary({ shapeDigest: 'sha256:x' }) })],
    ['an API summary with a GET', apiRun({ api: sampleApiSummary({ method: 'GET' as never }) })],
    ['an API summary with a path shape without "/"', apiRun({ api: sampleApiSummary({ pathShape: 'rest/v1/members' }) })],
  ])('rejects %s (action-run)', async (_label, document) => {
    expect((await validateArtifact('action-run', document)).ok).toBe(false);
  });

  it.each<readonly [string, unknown]>([
    ['a FORM evidence of 1.1', verifiedCreateDocuments().evidence],
    ['an API evidence', apiEvidence()],
    ['a blocked API evidence', blockedApiDocuments().evidence],
  ])('accepts %s (action-evidence)', async (_label, document) => {
    expect(await validateArtifact('action-evidence', document)).toEqual({ ok: true });
  });

  it.each<readonly [string, unknown]>([
    ['a 1.1 evidence without the transport', without(verifiedCreateDocuments().evidence, 'transport')],
    ['a 1.1 evidence without the API summary', without(verifiedCreateDocuments().evidence, 'api')],
    ['a FORM evidence with an API summary', { ...verifiedCreateDocuments().evidence, api: sampleApiSummary() }],
    ['an API evidence without the API summary', apiEvidence({ api: null })],
    // LG-4: 前の版 1.0 は読まない。
    ['a FORM evidence of the previous version 1.0', version10Of(verifiedCreateDocuments().evidence, 'action-evidence-schema/1.0')],
    ['an UPDATE evidence of the previous version 1.0', version10Of(verifiedUpdateDocuments().evidence, 'action-evidence-schema/1.0')],
    ['an evidence of the current shape with the version 1.0', { ...verifiedCreateDocuments().evidence, schemaVersion: 'action-evidence-schema/1.0' }],
    ['a blocked API evidence with page key values', { ...blockedApiDocuments().evidence, api: sampleApiSummary() }],
    ['an API evidence with a header value', apiEvidence({ api: { ...sampleApiSummary(), authorization: HEADER_VALUE_MARKER } as never })],
  ])('rejects %s (action-evidence)', async (_label, document) => {
    expect((await validateArtifact('action-evidence', document)).ok).toBe(false);
  });
});

describe('T40c: the API summary (actionApiSummaryOf)', () => {
  it('makes the summary of the approved spec: the names in key order, the record id key, and the page key values as JSON texts', () => {
    expect(actionApiSummaryOf(API_SPEC, { tenant_id: 'tenant-1' })).toEqual(sampleApiSummary());
    expect(actionApiSummaryOf(API_SPEC, null)).toEqual(sampleApiSummary({ pageKeyValues: null }));
    expect(actionApiSummaryOf({ ...API_SPEC, recordId: null }, null).recordIdKey).toBeNull();
  });

  it.each<readonly [string, string | number | boolean | null, string | null]>([
    ['a string', 'tenant-1', '"tenant-1"'],
    ['a number', 7, '7'],
    ['a boolean', true, 'true'],
    ['null', null, 'null'],
    ['a string of the longest JSON text', 'x'.repeat(MAX_SUBMITTED_VALUE_LENGTH - 2), `"${'x'.repeat(MAX_SUBMITTED_VALUE_LENGTH - 2)}"`],
    ['a string one longer (cut: no value, the mark null)', 'x'.repeat(MAX_SUBMITTED_VALUE_LENGTH - 1), null],
  ])('keeps a page key value of %s within the limit, and cuts a longer one', (_label, value, expected) => {
    expect(actionApiSummaryOf(API_SPEC, { tenant_id: value }).pageKeyValues).toEqual({ tenant_id: expected });
  });

  it('keeps only the page keys of the spec, and never a header value, the response body or a value of the fields', () => {
    const pageKeyValues = { tenant_id: 'tenant-1', name: VALUE_MARKER, authorization: HEADER_VALUE_MARKER, body: RESPONSE_BODY_MARKER };
    const summary = actionApiSummaryOf(API_SPEC, pageKeyValues);
    expect(summary.pageKeyValues).toEqual({ tenant_id: '"tenant-1"' });
    const text = JSON.stringify(summary);
    for (const marker of [VALUE_MARKER, HEADER_VALUE_MARKER, RESPONSE_BODY_MARKER, 'application/json', '#member-email']) {
      expect(text, marker).not.toContain(marker);
    }
    expect(Object.isFrozen(summary)).toBe(true);
  });
});

describe('T40c: the judgement of the API response (apiResponseJudgementOf)', () => {
  it.each<readonly [number, string]>([
    [100, 'NO_CONDITION_MATCHED'], [101, 'NO_CONDITION_MATCHED'], [199, 'NO_CONDITION_MATCHED'],
    [200, 'SUCCESS'], [201, 'SUCCESS'], [204, 'SUCCESS'], [299, 'SUCCESS'],
    [300, 'NO_CONDITION_MATCHED'], [302, 'NO_CONDITION_MATCHED'], [399, 'NO_CONDITION_MATCHED'],
    [400, 'INPUT_ERROR'], [409, 'INPUT_ERROR'], [428, 'INPUT_ERROR'], [429, 'RATE_LIMITED'], [430, 'INPUT_ERROR'], [499, 'INPUT_ERROR'],
    [500, 'SERVER_ERROR'], [503, 'SERVER_ERROR'], [599, 'SERVER_ERROR'],
    [600, 'NO_CONDITION_MATCHED'], [999, 'NO_CONDITION_MATCHED'], [0, 'NO_CONDITION_MATCHED'], [99, 'NO_CONDITION_MATCHED'],
    [200.5, 'NO_CONDITION_MATCHED'], [Number.NaN, 'NO_CONDITION_MATCHED'], [-200, 'NO_CONDITION_MATCHED'],
  ])('judges the status %d as %s', (status, expected) => {
    expect(apiResponseJudgementOf(status)).toBe(expected);
    expect(RESPONSE_JUDGEMENTS).toContain(apiResponseJudgementOf(status));
  });

  it('does not add a value to the closed lists', () => {
    expect(RESPONSE_JUDGEMENTS).toHaveLength(9);
    expect(ACTION_OUTCOME_REASONS).toHaveLength(19);
  });

  it.each<readonly [string, number, string | null, string, string]>([
    ['a 2xx with a usable id and a matched READ', 201, '1001', 'VERIFIED', 'READ_VERIFICATION_MATCHED'],
    ['a 2xx without an id (not success)', 201, null, 'PARTIAL', 'RECORD_ID_NOT_FOUND'],
    ['a 2xx with an unsafe id (not success)', 200, '10/01', 'PARTIAL', 'RECORD_ID_UNSAFE'],
    ['a 429', 429, null, 'FAILED', 'RATE_LIMITED'],
    ['a 4xx', 422, null, 'FAILED', 'INPUT_ERROR'],
    ['a 5xx (may have registered)', 503, null, 'UNKNOWN', 'SERVER_ERROR'],
    ['a 3xx', 302, null, 'UNKNOWN', 'NO_CONDITION_MATCHED'],
  ])('leaves %s to actionOutcomeOf', (_label, status, recordId, result, reason) => {
    expect(actionOutcomeOf({ submission: 'SENT', responseJudgement: apiResponseJudgementOf(status), recordId, readVerification: 'MATCHED' }))
      .toEqual({ result, reason });
  });
});

describe('T40c: the parent check of the record against the START (actionRunMatchesWriteStart)', () => {
  it.each<readonly [string, ActionRunDocument, ScenarioApiSpec | null, boolean]>([
    ['a FORM run of 1.1 for a FORM start', formRun(), null, true],
    ['an API run for a FORM start', apiRun(), null, false],
    ['a FORM run for an API start', formRun(), API_SPEC, false],
    ['the same API run', apiRun(), API_SPEC, true],
    ['a blocked API run', blockedApiDocuments().actionRun, API_SPEC, true],
    ['another shape digest', apiRun({ api: sampleApiSummary({ shapeDigest: `sha256:${'c'.repeat(64)}` }) }), API_SPEC, false],
    ['another origin', apiRun({ api: sampleApiSummary({ origin: 'http://127.0.0.3:4174' }) }), API_SPEC, false],
    ['another path shape', apiRun({ api: sampleApiSummary({ pathShape: '/rest/v1/other' }) }), API_SPEC, false],
    ['another method', apiRun({ api: sampleApiSummary({ method: 'PATCH' }) }), API_SPEC, false],
    ['a key more', apiRun({ api: sampleApiSummary({ keyNames: ['email', 'name', 'score'] }) }), API_SPEC, false],
    ['a key less', apiRun({ api: sampleApiSummary({ keyNames: ['name'] }) }), API_SPEC, false],
    ['another page key', apiRun({ api: sampleApiSummary({ pageKeyNames: ['owner_id'], pageKeyValues: { owner_id: '"o"' } }) }), API_SPEC, false],
    ['another header name', apiRun({ api: sampleApiSummary({ httpFieldNames: ['x-other'] }) }), API_SPEC, false],
    ['another record id key', apiRun({ api: sampleApiSummary({ recordIdKey: 'uuid' }) }), API_SPEC, false],
    ['a page key value of a key that is not a page key', apiRun({ api: sampleApiSummary({ pageKeyValues: { tenant_id: '"t"', name: '"x"' } }) }), API_SPEC, false],
    ['a missing page key value', apiRun({ api: sampleApiSummary({ pageKeyValues: {} }) }), API_SPEC, false],
    ['a value of a key that is not a key of a field', apiRun({ submittedValues: { name: 'n', other: 'x' } }), API_SPEC, false],
  ])('%s → %s', (_label, document, start, expected) => {
    expect(actionRunMatchesWriteStart(document, start)).toBe(expected);
  });
});

describe('T40c: the hand-written checks (actionRunRuleErrors)', () => {
  it('has no error for the samples', () => {
    for (const documents of [verifiedCreateDocuments(), blockedDocuments(), verifiedUpdateDocuments(), verifiedApiCreateDocuments(), blockedApiDocuments()]) {
      expect(actionRunRuleErrors(documents.actionRun)).toEqual([]);
    }
  });

  it.each<readonly [string, unknown]>([
    ['a FORM run with an API summary', formRun({ api: sampleApiSummary() })],
    ['a FORM run without the result conditions', formRun({ resultConditions: null })],
    ['an API run with the result conditions', apiRun({ resultConditions: formRun().resultConditions })],
    ['an API run without the summary', apiRun({ api: null })],
    ['a 1.1 run without the transport', without(formRun(), 'transport')],
    ['a blocked API run with page key values', { ...blockedApiDocuments().actionRun, api: sampleApiSummary() }],
    ['keys out of order', apiRun({ api: sampleApiSummary({ keyNames: ['name', 'email'] }) })],
    ['a page key that is a key of a field', apiRun({ api: sampleApiSummary({ pageKeyNames: ['name'], pageKeyValues: { name: '"x"' } }) })],
  ])('finds an error for %s', (_label, document) => {
    expect(actionRunRuleErrors(document as ActionRunDocument).length).toBeGreaterThan(0);
  });

  it('writes no value and no name in the error texts', () => {
    const document = apiRun({
      submittedValues: { name: VALUE_MARKER, [`${VALUE_MARKER}-key`]: VALUE_MARKER },
      api: sampleApiSummary({ pageKeyValues: { tenant_id: `"${VALUE_MARKER}"`, [`${HEADER_VALUE_MARKER}-key`]: `"${RESPONSE_BODY_MARKER}"` } }),
    });
    const errors = actionRunRuleErrors(document);
    expect(errors.length).toBeGreaterThan(0);
    const text = errors.join('\n');
    for (const marker of [VALUE_MARKER, HEADER_VALUE_MARKER, RESPONSE_BODY_MARKER, 'tenant_id', SAMPLE_API_ORIGIN]) {
      expect(text, marker).not.toContain(marker);
    }
  });
});

/** 報告の確かめに渡す、ディスクのファイルの見本（文書の JSON と、同じ部品で組み立てたバンドル）。 */
const reportFilesOf = (documents: ActionReportDocuments, evidence: unknown = documents.evidence): ReadonlyMap<string, Uint8Array> => {
  const encoder = new TextEncoder();
  const bytesOf = (value: unknown): Uint8Array => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
  const files = {
    actionRun: bytesOf(documents.actionRun),
    actionEvidence: bytesOf(evidence),
    approvalSummary: bytesOf(documents.approvalSummary),
    reportHtml: encoder.encode('<!DOCTYPE html>\n<p>report</p>\n'),
  };
  const bundle = actionBundleBytesOf({
    jobId: documents.actionRun.jobId, runId: documents.actionRun.runId, containsHumanEnteredValues: documents.evidence.containsHumanEnteredValues,
    humanEnteredValuesNotice: ACTION_REPORT_TEXT.bundleHumanEnteredValuesNotice, ...files,
  });
  return new Map([
    [ACTION_RUN_ARTIFACT_FILE_NAME, files.actionRun],
    [ACTION_EVIDENCE_ARTIFACT_FILE_NAME, files.actionEvidence],
    [APPROVAL_SUMMARY_ARTIFACT_FILE_NAME, files.approvalSummary],
    [ACTION_REPORT_ARTIFACT_FILE_NAME, files.reportHtml],
    [actionBundleFileName(documents.actionRun.finishedAt), bundle],
  ]);
};

const reportCheckOf = async (documents: ActionReportDocuments, evidence?: unknown): Promise<string> => {
  const files = reportFilesOf(documents, evidence);
  const { schemaVersion: _schemaVersion, jobId: _jobId, runId: _runId, ...approvalFacts } = documents.approvalSummary;
  return checkWriteReport({ actionRun: documents.actionRun, approvalFacts, readFile: (name) => Promise.resolve(files.get(name) ?? null) });
};

describe('T40c: the report check also compares the transport and the API summary of the evidence with the record', () => {
  it.each<readonly [string, ActionReportDocuments]>([
    ['FORM 1.1', verifiedCreateDocuments()],
    ['API 1.1', verifiedApiCreateDocuments()],
    ['blocked API 1.1', blockedApiDocuments()],
  ])('accepts the matching documents of %s', async (_label, documents) => {
    expect(await reportCheckOf(documents)).toBe('VALID');
  });

  it.each<readonly [string, ActionReportDocuments, unknown]>([
    ['an API evidence of another origin', verifiedApiCreateDocuments(),
      apiEvidence({ api: sampleApiSummary({ origin: 'http://127.0.0.3:4174' }) })],
    ['an API evidence of other page key values', verifiedApiCreateDocuments(),
      apiEvidence({ api: sampleApiSummary({ pageKeyValues: { tenant_id: '"tenant-2"' } }) })],
    ['a FORM evidence for an API record', verifiedApiCreateDocuments(), { ...verifiedCreateDocuments().evidence, submission: apiEvidence().submission,
      response: apiEvidence().response }],
  ])('finds a mismatch for %s', async (_label, documents, evidence) => {
    expect(await reportCheckOf(documents, evidence)).toBe('REPORT_MISMATCH');
  });
});

describe('T40c: the report display of 1.1 (the FORM display is not changed; the API summary is shown in T40d)', () => {
  it('builds the view model and the HTML of an API document without a header value or the response body', () => {
    for (const documents of [verifiedApiCreateDocuments(), blockedApiDocuments()]) {
      const html = renderActionReport(buildActionViewModel(documents));
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).not.toContain(HEADER_VALUE_MARKER);
      expect(html).not.toContain(RESPONSE_BODY_MARKER);
    }
  });
});

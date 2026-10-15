// T27e（Task 27 の設計書 4.5、4.8、変更履歴の「T27a の報告」の (6)）: READ の確かめの純粋な部品（`src/discovery/read-check-evaluation.ts`）。
// - 候補の確かめ: 識別の digest が同じ候補が 1 つあり、今の分類が `READ`（違えば `NOT_FOUND`・`NOT_READ`）。同じ digest の中身の違う重複は、発見と
//   同じく `DISPLAY_ONLY` にまとめて `NOT_READ`。画面を読み切れずに見つからなければ `UNREADABLE`。
// - URL の組み立て: 送信先の Origin と path に、定義の送る値だけ（定義の順、form の GET と同じ符号化）。送信先の query の名前は使わない。秘密に
//   見える名前は組み立てない。Origin を変える path、長さの上限は組み立てない。
// - 照らす規則: 表 → 一覧の順にただ 1 つの構造の行の数、見えている文字、詳細の項目。構造がない・2 つ以上・上限・落ち着かない画面の扱い。
// - 定義の結果のまとめ、件数の要約、Run Status（`deriveRunStatus` に任せる）。
// - 成果物のスキーマ（`schemas/read-evidence.schema.json`）: 例がスキーマに通り、形の違う値は通らない。上限が名前つきの定数と一致する。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import { MAX_READ_CHECK_EXPECTATIONS, MAX_READ_CHECKS_PER_JOB, type ReadCheckExpectation } from '../../src/discovery/read-check-contracts.js';
import {
  MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH,
  MAX_READ_EVIDENCE_STRUCTURE_COUNTS,
  READ_CHECK_DETAIL_RESULTS,
  READ_CHECK_DETAILS,
  READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  buildReadCheckUrl,
  confirmReadTarget,
  confirmReadTargetOnPage,
  evaluateReadExpectation,
  readCheckResultOf,
  readEvidenceRunStatusOf,
  readEvidenceSummaryOf,
  readStructureSummaryOf,
  type ReadEvidenceDocument,
  type ReadPageStructure,
} from '../../src/discovery/read-check-evaluation.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';
import { SAMPLE_ALLOWED_ORIGINS, SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm, NO_JS_BINDING } from './discovery-candidate-samples.js';

const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }),
  ...computeCandidateDigests(discovered),
});

/** GET の検索の form（READ）。 */
const searchForm = (overrides: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate => sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/admin/search' },
  formMethod: 'GET',
  action: sampleAction('/admin/list', ['page']),
  fields: [sampleField('q', 'search'), sampleField('status', 'select-one', { options: ['', 'open'] }), sampleField('authenticity_token', 'hidden')],
  submitterText: '検索',
  ...overrides,
});

const structureOf = (overrides: Partial<ReadPageStructure> = {}): ReadPageStructure => ({
  region: 'MAIN',
  tableRowCounts: [],
  listItemCounts: [],
  detailEntries: [],
  text: '',
  limitReached: false,
  settled: true,
  ...overrides,
});

describe('T27e: confirming the target candidate of a READ check', () => {
  it('confirms the READ candidate with the same identity digest, and tells NOT_FOUND and NOT_READ apart', () => {
    const read = candidateOf(searchForm());
    const bound = candidateOf(searchForm({ jsBinding: { ...NO_JS_BINDING, form: ['submit'] } }));
    expect(read.classification).toBe('READ');
    expect(bound.identityDigest).toBe(read.identityDigest);
    expect(bound.classification).toBe('NEEDS_BINDING');

    expect(confirmReadTarget([read], read.identityDigest)).toEqual({ kind: 'CONFIRMED', candidate: read });
    expect(confirmReadTarget([bound], read.identityDigest)).toEqual({ kind: 'NOT_READ', candidate: bound });
    const added = candidateOf(searchForm({ fields: [...searchForm().fields, sampleField('extra')] }));
    expect(confirmReadTarget([added], read.identityDigest)).toEqual({ kind: 'NOT_FOUND' });
    const post = candidateOf(searchForm({ formMethod: 'POST' }));
    expect(confirmReadTarget([post], read.identityDigest)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('does not read a candidate whose identity digest is shared by different contents on the page (merged to DISPLAY_ONLY, like the discovery)', () => {
    const first = candidateOf(searchForm());
    const second = candidateOf(searchForm({ fields: searchForm().fields.map((field) => ({ ...field, required: true })) }));
    expect(second.identityDigest).toBe(first.identityDigest);
    const confirmation = confirmReadTarget([first, second], first.identityDigest);
    expect(confirmation.kind).toBe('NOT_READ');
    expect(confirmation.kind === 'NOT_READ' ? [confirmation.candidate.classification, confirmation.candidate.reasonCode] : [])
      .toEqual(['DISPLAY_ONLY', 'DUPLICATE_IDENTITY_CONFLICT']);
  });

  it('says UNREADABLE instead of drifted when the page was not read completely and the candidate is missing', () => {
    const read = candidateOf(searchForm());
    expect(confirmReadTargetOnPage({ candidates: [], reliable: false }, read.identityDigest)).toEqual({ kind: 'UNREADABLE' });
    expect(confirmReadTargetOnPage({ candidates: [], reliable: true }, read.identityDigest)).toEqual({ kind: 'NOT_FOUND' });
    expect(confirmReadTargetOnPage({ candidates: [read], reliable: false }, read.identityDigest)).toEqual({ kind: 'CONFIRMED', candidate: read });
  });
});

describe('T27e: building the READ URL', () => {
  const action = { origin: SAMPLE_ORIGIN, path: '/admin/list' };

  it('puts only the definition names and values on the action, in the definition order, with the form encoding', () => {
    expect(buildReadCheckUrl(action, { q: 'りんご ジュース', status: 'open' }))
      .toEqual({ ok: true, url: `${SAMPLE_ORIGIN}/admin/list?q=%E3%82%8A%E3%82%93%E3%81%94+%E3%82%B8%E3%83%A5%E3%83%BC%E3%82%B9&status=open` });
    expect(buildReadCheckUrl(action, { status: 'a&b=c', q: '' })).toEqual({ ok: true, url: `${SAMPLE_ORIGIN}/admin/list?status=a%26b%3Dc&q=` });
    expect(buildReadCheckUrl(action, {})).toEqual({ ok: true, url: `${SAMPLE_ORIGIN}/admin/list` });
    expect(buildReadCheckUrl({ origin: SAMPLE_ORIGIN, path: '/admin/%E4%B8%80%E8%A6%A7' }, { q: 'x' }))
      .toEqual({ ok: true, url: `${SAMPLE_ORIGIN}/admin/%E4%B8%80%E8%A6%A7?q=x` });
  });

  it('never builds a URL that sends a secret-like name (re-checked, fail-closed)', () => {
    for (const name of ['token', 'authenticity_token', 'state', 'code', 'api_key', 'Session-Id', 'PASSWORD']) {
      expect(buildReadCheckUrl(action, { q: 'x', [name]: 'v' }), name).toEqual({ ok: false, detail: 'SECRET_LIKE_PARAMETER' });
    }
  });

  it('never builds a URL whose names or values have a dangerous word of the discovery, also a Japanese one (T27R-fix-1, DEF-088)', () => {
    for (const parameters of [
      { q: '削除' },
      { q: 'りんご', status: '取り消し済み' },
      { q: 'ＤＥＬＥＴＥ' },
      { q: 'Sign out' },
      // percent-encode した値（サーバが外しうる）も、外した形で比べる（fail-closed）。
      { q: '%E5%89%8A%E9%99%A4' },
      { '一括': 'x' },
      { bulk_mode: 'x' },
    ]) {
      expect(buildReadCheckUrl(action, parameters), JSON.stringify(parameters)).toEqual({ ok: false, detail: 'PARAMETER_DANGEROUS_WORD' });
    }
    // 秘密に見える名前の確かめが先（同じ定義に両方があれば、秘密に見える名前の理由）。
    expect(buildReadCheckUrl(action, { token: 'x', q: '削除' })).toEqual({ ok: false, detail: 'SECRET_LIKE_PARAMETER' });
    // 危険な語のない名前と値は止まらない。
    expect(buildReadCheckUrl(action, { q: 'りんご', status: 'open' }).ok).toBe(true);
    expect(READ_CHECK_DETAIL_RESULTS.PARAMETER_DANGEROUS_WORD).toBe('READ_BLOCKED_BY_POLICY');
  });

  it('keeps a path that looks like another host on the action origin, and does not build a non-http(s) or too long URL', () => {
    const lookalike = buildReadCheckUrl({ origin: SAMPLE_ORIGIN, path: '//other.example.invalid/x' }, { q: 'x' });
    expect(lookalike.ok ? new URL(lookalike.url).origin : null).toBe(SAMPLE_ORIGIN);
    expect(buildReadCheckUrl({ origin: SAMPLE_ORIGIN, path: 'relative' }, {})).toEqual({ ok: false, detail: 'URL_NOT_BUILT' });
    expect(buildReadCheckUrl({ origin: 'null', path: '/x' }, {})).toEqual({ ok: false, detail: 'URL_NOT_BUILT' });
    expect(buildReadCheckUrl({ origin: 'ftp://127.0.0.1', path: '/x' }, {})).toEqual({ ok: false, detail: 'URL_NOT_BUILT' });
    expect(buildReadCheckUrl(action, { q: 'x'.repeat(MAX_URL_LENGTH) })).toEqual({ ok: false, detail: 'URL_NOT_BUILT' });
  });
});

describe('T27e: comparing a page structure with the expectations', () => {
  const rows = (kind: 'ROW_COUNT_EQUALS' | 'ROW_COUNT_AT_LEAST', count: number): ReadCheckExpectation => ({ kind, count });

  it('counts the rows of the only table (tables before lists), and tells a missing, ambiguous or limited structure as UNDETERMINED', () => {
    expect(evaluateReadExpectation(structureOf({ tableRowCounts: [2], listItemCounts: [5] }), rows('ROW_COUNT_EQUALS', 2)))
      .toMatchObject({ result: 'MATCHED', rowSource: 'TABLE', observedRowCount: 2 });
    expect(evaluateReadExpectation(structureOf({ tableRowCounts: [2] }), rows('ROW_COUNT_EQUALS', 3))).toMatchObject({ result: 'NOT_MATCHED' });
    expect(evaluateReadExpectation(structureOf({ tableRowCounts: [0] }), rows('ROW_COUNT_AT_LEAST', 0))).toMatchObject({ result: 'MATCHED' });
    expect(evaluateReadExpectation(structureOf({ tableRowCounts: [0] }), rows('ROW_COUNT_AT_LEAST', 1))).toMatchObject({ result: 'NOT_MATCHED' });
    expect(evaluateReadExpectation(structureOf({ listItemCounts: [4] }), rows('ROW_COUNT_AT_LEAST', 3)))
      .toMatchObject({ result: 'MATCHED', rowSource: 'LIST', observedRowCount: 4 });
    expect(evaluateReadExpectation(structureOf(), rows('ROW_COUNT_EQUALS', 0)))
      .toEqual({ expectation: rows('ROW_COUNT_EQUALS', 0), result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_NOT_FOUND', rowSource: null, observedRowCount: null });
    expect(evaluateReadExpectation(structureOf({ tableRowCounts: [1, 2] }), rows('ROW_COUNT_EQUALS', 1)))
      .toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_AMBIGUOUS' });
    expect(evaluateReadExpectation(structureOf({ listItemCounts: [1, 2] }), rows('ROW_COUNT_EQUALS', 1)))
      .toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_AMBIGUOUS' });
    expect(evaluateReadExpectation(structureOf({ tableRowCounts: [2], limitReached: true }), rows('ROW_COUNT_EQUALS', 2)))
      .toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_LIMIT_REACHED' });
  });

  it('finds the text in the visible text of the main region (whitespace folded), and never copies the text', () => {
    const structure = structureOf({ text: '注文 りんご ジュース 該当 2 件' });
    expect(evaluateReadExpectation(structure, { kind: 'TEXT_CONTAINS', text: ' りんご\n ジュース ' }))
      .toEqual({ expectation: { kind: 'TEXT_CONTAINS', text: ' りんご\n ジュース ' }, result: 'MATCHED', undeterminedReason: null, found: true });
    expect(evaluateReadExpectation(structure, { kind: 'TEXT_CONTAINS', text: 'みかん' })).toMatchObject({ result: 'NOT_MATCHED', found: false });
    expect(evaluateReadExpectation(structure, { kind: 'TEXT_CONTAINS', text: 'リンゴ' })).toMatchObject({ result: 'NOT_MATCHED' });
    expect(evaluateReadExpectation({ ...structure, limitReached: true }, { kind: 'TEXT_CONTAINS', text: 'みかん' }))
      .toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_LIMIT_REACHED', found: null });
    expect(evaluateReadExpectation({ ...structure, limitReached: true }, { kind: 'TEXT_CONTAINS', text: 'りんご' })).toMatchObject({ result: 'MATCHED' });
  });

  it('compares the only detail field with the same name, and keeps only the observed value of that field', () => {
    const structure = structureOf({ detailEntries: [{ term: '番号', value: 'A-2' }, { term: '名前', value: 'みかん' }, { term: '状態', value: 'open' }] });
    expect(evaluateReadExpectation(structure, { kind: 'DETAIL_FIELD_EQUALS', field: ' 名前 ', value: 'みかん' }))
      .toEqual({ expectation: { kind: 'DETAIL_FIELD_EQUALS', field: ' 名前 ', value: 'みかん' }, result: 'MATCHED', undeterminedReason: null, observedValue: 'みかん' });
    expect(evaluateReadExpectation(structure, { kind: 'DETAIL_FIELD_EQUALS', field: '状態', value: 'closed' }))
      .toMatchObject({ result: 'NOT_MATCHED', observedValue: 'open' });
    expect(evaluateReadExpectation(structure, { kind: 'DETAIL_FIELD_EQUALS', field: '住所', value: 'x' }))
      .toMatchObject({ result: 'NOT_MATCHED', undeterminedReason: null, observedValue: null });
    expect(evaluateReadExpectation(structureOf(), { kind: 'DETAIL_FIELD_EQUALS', field: '住所', value: 'x' }))
      .toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_NOT_FOUND' });
    expect(evaluateReadExpectation({ ...structure, limitReached: true }, { kind: 'DETAIL_FIELD_EQUALS', field: '住所', value: 'x' }))
      .toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_LIMIT_REACHED' });
    const duplicated = structureOf({ detailEntries: [{ term: '名前', value: 'a' }, { term: '名前', value: 'b' }] });
    expect(evaluateReadExpectation(duplicated, { kind: 'DETAIL_FIELD_EQUALS', field: '名前', value: 'a' }))
      .toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'STRUCTURE_AMBIGUOUS' });
    const long = structureOf({ detailEntries: [{ term: '名前', value: 'x'.repeat(MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH * 2) }] });
    const evidence = evaluateReadExpectation(long, { kind: 'DETAIL_FIELD_EQUALS', field: '名前', value: 'x' });
    expect(evidence.expectation.kind === 'DETAIL_FIELD_EQUALS' && 'observedValue' in evidence ? evidence.observedValue?.length : null)
      .toBe(MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH);
  });

  it('does not judge a page that did not settle, except a text that was found', () => {
    const unsettled = structureOf({ tableRowCounts: [2], text: 'りんご', detailEntries: [{ term: '名前', value: 'a' }], settled: false });
    expect(evaluateReadExpectation(unsettled, rows('ROW_COUNT_EQUALS', 2))).toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'PAGE_NOT_SETTLED' });
    expect(evaluateReadExpectation(unsettled, { kind: 'DETAIL_FIELD_EQUALS', field: '名前', value: 'a' }))
      .toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'PAGE_NOT_SETTLED', observedValue: null });
    expect(evaluateReadExpectation(unsettled, { kind: 'TEXT_CONTAINS', text: 'みかん' })).toMatchObject({ result: 'UNDETERMINED', undeterminedReason: 'PAGE_NOT_SETTLED' });
    expect(evaluateReadExpectation(unsettled, { kind: 'TEXT_CONTAINS', text: 'りんご' })).toMatchObject({ result: 'MATCHED' });
  });

  it('makes the result of a definition: NOT_MATCHED wins, then UNDETERMINED, MATCHED only when every expectation matched', () => {
    const matched = evaluateReadExpectation(structureOf({ tableRowCounts: [1] }), rows('ROW_COUNT_EQUALS', 1));
    const notMatched = evaluateReadExpectation(structureOf({ tableRowCounts: [1] }), rows('ROW_COUNT_EQUALS', 2));
    const undetermined = evaluateReadExpectation(structureOf(), rows('ROW_COUNT_EQUALS', 2));
    expect(readCheckResultOf([matched, matched])).toBe('MATCHED');
    expect(readCheckResultOf([matched, undetermined])).toBe('UNDETERMINED');
    expect(readCheckResultOf([undetermined, notMatched, matched])).toBe('NOT_MATCHED');
    expect(readCheckResultOf([])).toBe('UNDETERMINED');
  });

  it('summarizes the structure with counts only', () => {
    const counts = Array.from({ length: MAX_READ_EVIDENCE_STRUCTURE_COUNTS + 3 }, (_, index) => index);
    expect(readStructureSummaryOf(structureOf({ tableRowCounts: counts, listItemCounts: [3], detailEntries: [{ term: 'a', value: 'b' }], text: ' a  b ' })))
      .toEqual({
        region: 'MAIN',
        tables: counts.length,
        tableRowCounts: counts.slice(0, MAX_READ_EVIDENCE_STRUCTURE_COUNTS),
        lists: 1,
        listItemCounts: [3],
        detailFields: 1,
        textLength: 3,
        limitReached: false,
        settled: true,
      });
  });
});

describe('T27e: the read-evidence.json document', () => {
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const sample = (): ReadEvidenceDocument => ({
    schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    jobId: 'job-read-1',
    runId: 'RUN-20261011000000',
    startedAt: '20261011000000',
    finishedAt: '20261011000100',
    runStatus: 'COMPLETE',
    endReason: 'COMPLETED',
    checks: [
      {
        readCheckId: 'read-1',
        readCheckRevision: 2,
        targetIdentityDigest: DIGEST,
        state: 'EXECUTED',
        result: 'MATCHED',
        detail: 'EXPECTATIONS_EVALUATED',
        url: `${SAMPLE_ORIGIN}/admin/list?q=x`,
        httpStatus: 200,
        blockedRequests: 0,
        structure: readStructureSummaryOf(structureOf({ tableRowCounts: [1], text: 'x' })),
        expectations: [
          evaluateReadExpectation(structureOf({ tableRowCounts: [1] }), { kind: 'ROW_COUNT_EQUALS', count: 1 }),
          evaluateReadExpectation(structureOf({ text: 'x' }), { kind: 'TEXT_CONTAINS', text: 'x' }),
          evaluateReadExpectation(structureOf({ detailEntries: [{ term: 'a', value: 'b' }] }), { kind: 'DETAIL_FIELD_EQUALS', field: 'a', value: 'b' }),
        ],
      },
      {
        readCheckId: 'read-2',
        readCheckRevision: 1,
        targetIdentityDigest: DIGEST,
        state: 'EXECUTED',
        result: 'READ_BLOCKED_BY_POLICY',
        detail: 'REQUEST_POLICY',
        url: null,
        httpStatus: null,
        blockedRequests: 0,
        structure: null,
        expectations: [],
      },
    ],
  });

  it('passes the schema, and the schema rejects a wrong shape', async () => {
    expect(await validateArtifact('read-evidence', sample())).toEqual({ ok: true });
    const document = sample();
    const [first] = document.checks;
    for (const [name, value] of [
      ['another schema version', { ...document, schemaVersion: 'read-evidence-schema/0.9' }],
      ['an unknown result', { ...document, checks: [{ ...first, result: 'PASSED' }] }],
      ['an unknown detail', { ...document, checks: [{ ...first, detail: 'OTHER' }] }],
      ['a copied row', { ...document, checks: [{ ...first, rows: [['A-1']] }] }],
      ['too many checks', { ...document, checks: Array.from({ length: MAX_READ_CHECKS_PER_JOB + 1 }, () => first) }],
      ['too many expectations', { ...document, checks: [{ ...first, expectations: Array.from({ length: MAX_READ_CHECK_EXPECTATIONS + 1 }, () => first?.state === 'EXECUTED' ? first.expectations[0] : null) }] }],
      ['a long observed value', { ...document, checks: [{ ...first, expectations: [{ expectation: { kind: 'DETAIL_FIELD_EQUALS', field: 'a', value: 'b' }, result: 'MATCHED', undeterminedReason: null, observedValue: 'x'.repeat(MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH + 1) }] }] }],
      ['a not executed check with a result', { ...document, checks: [{ readCheckId: 'read-3', readCheckRevision: 1, targetIdentityDigest: DIGEST, state: 'NOT_EXECUTED', reason: 'COMPLETED' }] }],
    ] as const) {
      expect((await validateArtifact('read-evidence', JSON.parse(JSON.stringify(value)))).ok, name).toBe(false);
    }
  });

  it('keeps the limits of the schema equal to the named constants', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'read-evidence.schema.json'), 'utf8')) as {
      readonly properties: { readonly checks: { readonly maxItems: number } };
      readonly $defs: {
        readonly executed: { readonly properties: { readonly expectations: { readonly maxItems: number } } };
        readonly structure: { readonly properties: { readonly tableRowCounts: { readonly maxItems: number }; readonly listItemCounts: { readonly maxItems: number } } };
        readonly detailEvidence: { readonly properties: { readonly observedValue: { readonly anyOf: readonly { readonly maxLength?: number }[] } } };
      };
    };
    expect(schema.properties.checks.maxItems).toBe(MAX_READ_CHECKS_PER_JOB);
    expect(schema.$defs.executed.properties.expectations.maxItems).toBe(MAX_READ_CHECK_EXPECTATIONS);
    expect(schema.$defs.structure.properties.tableRowCounts.maxItems).toBe(MAX_READ_EVIDENCE_STRUCTURE_COUNTS);
    expect(schema.$defs.structure.properties.listItemCounts.maxItems).toBe(MAX_READ_EVIDENCE_STRUCTURE_COUNTS);
    expect(schema.$defs.detailEvidence.properties.observedValue.anyOf[0]?.maxLength).toBe(MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH);
  });

  it('blocks by the policy, without reading, a parameter that is no longer a sendable field (CCX-10), and the schema accepts it', async () => {
    expect(READ_CHECK_DETAILS).toContain('PARAMETER_NOT_SENDABLE');
    expect(READ_CHECK_DETAIL_RESULTS.PARAMETER_NOT_SENDABLE).toBe('READ_BLOCKED_BY_POLICY');
    const document = sample();
    const blocked = { ...document, checks: [{ ...document.checks[1], detail: 'PARAMETER_NOT_SENDABLE' }] };
    expect(await validateArtifact('read-evidence', blocked)).toEqual({ ok: true });
  });

  it('blocks by the policy, without reading, a parameter with a dangerous word (T27R-fix-1, DEF-088), and the schema accepts it', async () => {
    expect(READ_CHECK_DETAILS).toContain('PARAMETER_DANGEROUS_WORD');
    const document = sample();
    const blocked = { ...document, checks: [{ ...document.checks[1], detail: 'PARAMETER_DANGEROUS_WORD' }] };
    expect(await validateArtifact('read-evidence', blocked)).toEqual({ ok: true });
  });

  it('maps every detail to its own result, except the evaluated one', () => {
    expect(Object.keys(READ_CHECK_DETAIL_RESULTS)).toEqual([...READ_CHECK_DETAILS]);
    expect(READ_CHECK_DETAILS.filter((detail) => READ_CHECK_DETAIL_RESULTS[detail] === null)).toEqual(['EXPECTATIONS_EVALUATED']);
  });

  it('counts the checks and the executed ones, and leaves the Run Status to deriveRunStatus', () => {
    const document = sample();
    expect(readEvidenceSummaryOf(document)).toEqual({ checks: 2, executed: 2 });
    expect(readEvidenceRunStatusOf(document)).toBe('COMPLETE');
    const [first, second] = document.checks;
    if (first?.state !== 'EXECUTED' || second === undefined) {
      throw new Error('the sample has two checks');
    }
    expect(readEvidenceRunStatusOf({ endReason: 'COMPLETED', checks: [{ ...first, result: 'NOT_MATCHED' }] })).toBe('COMPLETE');
    expect(readEvidenceRunStatusOf({ endReason: 'COMPLETED', checks: [{ ...first, result: 'UNDETERMINED' }] })).toBe('PARTIAL');
    const notExecuted = { readCheckId: 'read-3', readCheckRevision: 1, targetIdentityDigest: DIGEST, state: 'NOT_EXECUTED', reason: 'STOPPED' } as const;
    expect(readEvidenceSummaryOf({ checks: [first, notExecuted] })).toEqual({ checks: 2, executed: 1 });
    expect(readEvidenceRunStatusOf({ endReason: 'STOPPED', checks: [first, notExecuted] })).toBe('PARTIAL');
    expect(readEvidenceRunStatusOf({ endReason: 'AUTH_SESSION_LOST', checks: [first] })).toBe('PARTIAL');
    expect(readEvidenceRunStatusOf({ endReason: 'SAFETY_VIOLATION', checks: [first] })).toBe('ABORTED_BY_SAFETY');
    expect(readEvidenceRunStatusOf({ endReason: 'PREFLIGHT_FAILED', checks: [{ ...notExecuted, reason: 'PREFLIGHT_FAILED' }] })).toBe('FAILED');
    expect(readEvidenceRunStatusOf({ endReason: 'MAX_RUNTIME_REACHED', checks: [first] })).toBe('PARTIAL');
  });
});

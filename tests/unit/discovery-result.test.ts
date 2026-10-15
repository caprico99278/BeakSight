// T27d（Task 27 の設計書 4.2、4.4、4.6 と、変更履歴の「T27b・T27c の報告と T27d の前の判断」「Blocker: T27d」の行）: 発見の成果物
// `discovery.json` の組み立てとまとめの純粋な部品（`src/discovery/discovery-result.ts`）の単体テスト。
// - 同じジョブの中の、同じ識別の digest の候補のまとめ（同じ中身は 1 件、違う中身は `DISPLAY_ONLY`・`DUPLICATE_IDENTITY_CONFLICT` の 1 件）。
// - 読んだ画面の path（ドリフトの `MISSING` と `NOT_REVISITED` を分ける入力）、件数の要約、Run Status。
// - CCX-10: 「この画面の記録は読み切れたか」の唯一の判定（`isDiscoveryPageReadInFull`）。読んだ画面の path と、READ の確かめの対象の画面の
//   読み取り（`src/discovery/read-executor.ts`）の両方が使う。
// - 成果物のスキーマ（`schemas/discovery.schema.json`。候補は `candidate.schema.json` を参照する）に通る。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKER_JOB_ID_PATTERN } from '../../src/control/worker-protocol.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  CANDIDATE_REASON_CLASSIFICATIONS,
  CANDIDATE_REASON_CODES,
  type DiscoveredCandidate,
  type DiscoveryCandidate,
} from '../../src/discovery/candidate-contracts.js';
import { CANDIDATE_CLASSIFICATION_RULES, classifyCandidate } from '../../src/discovery/classify.js';
import type { DiscoveryPageRecord } from '../../src/discovery/discover-page.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  DISCOVERY_END_REASONS,
  DISCOVERY_UNREAD_REASONS,
  DUPLICATE_IDENTITY_CONFLICT_REASON,
  MAX_DISCOVERY_READ_PAGE_PATHS,
  discoveryReadPagePaths,
  discoveryRunStatusOf,
  discoverySummaryOf,
  isDiscoveryPageReadInFull,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
  type DiscoveryPageEntry,
} from '../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import { SAMPLE_ALLOWED_ORIGINS, SAMPLE_ORIGIN, sampleAction, sampleButton, sampleField, sampleForm } from './discovery-candidate-samples.js';

const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }),
  ...computeCandidateDigests(discovered),
});

const SEARCH = candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/admin/items' },
  formMethod: 'GET',
  action: sampleAction('/admin/items'),
  submitterText: '検索',
  fields: [sampleField('q', 'search')],
}));
/** 同じ識別で、規則が違う（必須）。 */
const SEARCH_REQUIRED = candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/admin/items' },
  formMethod: 'GET',
  action: sampleAction('/admin/items'),
  submitterText: '検索',
  fields: [sampleField('q', 'search', { required: true })],
}));
/** 同じ識別で、規則も同じだが、JS の結び付きで分類が違う（`NEEDS_BINDING`）。 */
const SEARCH_BOUND = candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/admin/items' },
  formMethod: 'GET',
  action: sampleAction('/admin/items'),
  submitterText: '検索',
  fields: [sampleField('q', 'search')],
  jsBinding: { form: ['submit'], submitter: [], ancestor: [], document: [], window: [], inlineHandler: false },
}));
const BUTTON = candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: '/admin' } }));

const record = (path: string | null, candidates: readonly DiscoveryCandidate[], incompleteReasons: DiscoveryPageRecord['incompleteReasons'] = []): DiscoveryPageRecord =>
  ({ location: path === null ? null : { origin: SAMPLE_ORIGIN, path }, incompleteReasons, candidates });

const readEntry = (path: string, candidates: readonly DiscoveryCandidate[], incompleteReasons: DiscoveryPageRecord['incompleteReasons'] = []): DiscoveryPageEntry =>
  ({ url: `${SAMPLE_ORIGIN}${path}`, state: 'READ', record: record(path, candidates, incompleteReasons), blockedRequests: 0 });

const unreadEntry = (path: string, reason: (typeof DISCOVERY_UNREAD_REASONS)[number]): DiscoveryPageEntry =>
  ({ url: `${SAMPLE_ORIGIN}${path}`, state: 'NOT_READ', reason });

const documentOf = (pages: readonly DiscoveryPageEntry[], overrides: Partial<DiscoveryDocument> = {}): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-20261011010000',
  startedAt: '20261011010000',
  finishedAt: '20261011010100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages,
  omittedUnreadPages: 0,
  ...overrides,
});

describe('T27d: merging the candidates of one discovery job before the index', () => {
  it('keeps one candidate for the same identity with the same contents', () => {
    expect(mergeDiscoveryCandidates([SEARCH, BUTTON, SEARCH])).toEqual([SEARCH, BUTTON]);
  });

  it('merges different contents under one identity into one DISPLAY_ONLY candidate with DUPLICATE_IDENTITY_CONFLICT', () => {
    expect(SEARCH.identityDigest).toBe(SEARCH_REQUIRED.identityDigest);
    expect(SEARCH.ruleDigest).not.toBe(SEARCH_REQUIRED.ruleDigest);
    const merged = mergeDiscoveryCandidates([SEARCH_REQUIRED, BUTTON, SEARCH]);
    expect(merged).toHaveLength(2);
    const [conflict] = merged;
    expect(conflict).toMatchObject({
      identityDigest: SEARCH.identityDigest,
      classification: 'DISPLAY_ONLY',
      reasonCode: DUPLICATE_IDENTITY_CONFLICT_REASON,
      // 決まった値（並び順に依らない）: 規則の digest は、まとめた中の最小のもの。
      ruleDigest: [SEARCH.ruleDigest, SEARCH_REQUIRED.ruleDigest].sort()[0],
    });
    expect(mergeDiscoveryCandidates([SEARCH, SEARCH_REQUIRED, BUTTON])[0]).toEqual(conflict);
    expect(merged[1]).toEqual(BUTTON);
  });

  it('treats a different classification under the same rule digest as a conflict too (READ is never kept)', () => {
    expect(SEARCH.ruleDigest).toBe(SEARCH_BOUND.ruleDigest);
    expect(SEARCH_BOUND.classification).toBe('NEEDS_BINDING');
    const [merged] = mergeDiscoveryCandidates([SEARCH, SEARCH_BOUND]);
    expect(merged).toMatchObject({ classification: 'DISPLAY_ONLY', reasonCode: DUPLICATE_IDENTITY_CONFLICT_REASON });
  });

  it('leaves two submit buttons of one form with the same classification words to the identity merge (T27R-fix-1, DEF-086)', () => {
    // 表の行ごとの「<行の名前> を編集」のボタン（同じ form の形）: 文言は持たず、語の組（`編集`）が同じなので、同じ識別になる。
    const editOf = (rowText: string, jsBinding = SEARCH.jsBinding): DiscoveryCandidate => candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/admin/items' }, action: sampleAction('/admin/items/edit'), submitterText: `${rowText} を編集`, jsBinding,
    }));
    const first = editOf('山田 太郎');
    const second = editOf('佐藤 花子');
    expect(first.submitterWords).toEqual(['編集']);
    expect(second.identityDigest).toBe(first.identityDigest);
    // 中身も同じなら 1 件にまとまる（分類は変わらない）。
    expect(mergeDiscoveryCandidates([first, second])).toEqual([first]);
    // 中身が違えば（片方のボタンにだけ listener がある）、今までどおり `DUPLICATE_IDENTITY_CONFLICT`（`DISPLAY_ONLY`）の 1 件にまとまる。
    const bound = editOf('鈴木 一郎', { ...SEARCH.jsBinding, submitter: ['click'] });
    expect(bound.identityDigest).toBe(first.identityDigest);
    expect(mergeDiscoveryCandidates([first, bound])).toEqual([
      expect.objectContaining({ identityDigest: first.identityDigest, classification: 'DISPLAY_ONLY', reasonCode: DUPLICATE_IDENTITY_CONFLICT_REASON }),
    ]);
  });

  it('keeps the state field mark when any of the merged candidates has it', () => {
    const withState = candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/admin/items' },
      formMethod: 'GET',
      action: sampleAction('/admin/items'),
      submitterText: '検索',
      fields: [sampleField('q', 'search'), sampleField('status', 'text', { hidden: false })],
    }));
    const withStateRequired = candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/admin/items' },
      formMethod: 'GET',
      action: sampleAction('/admin/items'),
      submitterText: '検索',
      fields: [sampleField('q', 'search'), sampleField('status', 'text', { required: true })],
    }));
    expect(withState.hasStateField).toBe(true);
    expect(mergeDiscoveryCandidates([withState, withStateRequired])[0]?.hasStateField).toBe(true);
  });

  it('adds the merge reason to the closed list, maps it to DISPLAY_ONLY, and keeps it out of the classification table', () => {
    expect(CANDIDATE_REASON_CODES).toContain(DUPLICATE_IDENTITY_CONFLICT_REASON);
    expect(CANDIDATE_REASON_CLASSIFICATIONS[DUPLICATE_IDENTITY_CONFLICT_REASON]).toBe('DISPLAY_ONLY');
    expect(CANDIDATE_CLASSIFICATION_RULES.map((rule) => rule.reasonCode)).not.toContain(DUPLICATE_IDENTITY_CONFLICT_REASON);
  });
});

describe('T27d: the read pages, the summary and the Run Status of a discovery document', () => {
  it('lists the paths of the pages read in full (sorted, without duplicates), not the unread or incompletely read ones', () => {
    const document = documentOf([
      readEntry('/admin/items', [SEARCH]),
      readEntry('/admin', [BUTTON]),
      readEntry('/admin/items', []),
      readEntry('/admin/spa', [], ['INCOMPLETE_SETTLE_TIMEOUT']),
      readEntry('/admin/frames', [], ['INCOMPLETE_FRAME_OR_CLOSED_SHADOW']),
      readEntry('/admin/broken', [], ['INCOMPLETE_READ_FAILED']),
      readEntry('/admin/many', [], ['INCOMPLETE_LIMIT_REACHED']),
      readEntry('/admin/frozen', [], ['INCOMPLETE_FREEZE_UNAVAILABLE']),
      { url: `${SAMPLE_ORIGIN}/blank`, state: 'READ', record: record(null, []), blockedRequests: 0 },
      unreadEntry('/admin/later', 'MAX_PAGES_REACHED'),
      unreadEntry('/admin/logout', 'EXCLUDED'),
    ]);
    // 枠の中（iframe・closed な shadow root）は読まない決まりなので、本体を読み切れた画面として数える。
    expect(discoveryReadPagePaths(document)).toEqual(['/admin', '/admin/frames', '/admin/items']);
  });

  it('tells whether the record of a page was read in full (the only judgement, CCX-10)', () => {
    expect([
      record('/admin/items', [SEARCH]),
      record('/admin', []),
      record('/admin/frames', [], ['INCOMPLETE_FRAME_OR_CLOSED_SHADOW']),
      record('/admin/spa', [], ['INCOMPLETE_SETTLE_TIMEOUT']),
      record('/admin/broken', [], ['INCOMPLETE_READ_FAILED']),
      record('/admin/many', [], ['INCOMPLETE_LIMIT_REACHED']),
      record('/admin/frozen', [], ['INCOMPLETE_FREEZE_UNAVAILABLE']),
      record('/admin/both', [], ['INCOMPLETE_FRAME_OR_CLOSED_SHADOW', 'INCOMPLETE_SETTLE_TIMEOUT']),
      record(null, []),
    ].map(isDiscoveryPageReadInFull)).toEqual([true, true, true, false, false, false, false, false, false]);
  });

  it('caps the read page paths (the rest become NOT_REVISITED, never MISSING)', () => {
    const pages = Array.from({ length: MAX_DISCOVERY_READ_PAGE_PATHS + 2 }, (_value, index) => readEntry(`/p/${String(index).padStart(6, '0')}`, []));
    const paths = discoveryReadPagePaths(documentOf(pages));
    expect(paths).toHaveLength(MAX_DISCOVERY_READ_PAGE_PATHS);
    expect(paths[0]).toBe('/p/000000');
  });

  it('counts the pages read, the pages not read (with the omitted ones) and the candidates', () => {
    const document = documentOf([
      readEntry('/admin', [BUTTON]),
      readEntry('/admin/items', [SEARCH, SEARCH_REQUIRED]),
      unreadEntry('/admin/logout', 'EXCLUDED'),
    ], { omittedUnreadPages: 3 });
    expect(discoverySummaryOf(document)).toEqual({ pagesRead: 2, pagesNotRead: 4, candidates: 3 });
  });

  it('derives the Run Status from the end reason and the pages', () => {
    const complete = [readEntry('/admin', [BUTTON]), unreadEntry('/admin/logout', 'EXCLUDED')];
    expect(discoveryRunStatusOf({ endReason: 'COMPLETED', pages: complete, omittedUnreadPages: 0 })).toBe('COMPLETE');
    expect(discoveryRunStatusOf({ endReason: 'MAX_PAGES_REACHED', pages: complete, omittedUnreadPages: 0 })).toBe('PARTIAL');
    expect(discoveryRunStatusOf({ endReason: 'COMPLETED', pages: [...complete, unreadEntry('/x', 'MAX_DEPTH_REACHED')], omittedUnreadPages: 0 }))
      .toBe('PARTIAL');
    expect(discoveryRunStatusOf({ endReason: 'COMPLETED', pages: [readEntry('/admin', [], ['INCOMPLETE_SETTLE_TIMEOUT'])], omittedUnreadPages: 0 }))
      .toBe('PARTIAL');
    expect(discoveryRunStatusOf({ endReason: 'AUTH_SESSION_LOST', pages: complete, omittedUnreadPages: 0 })).toBe('PARTIAL');
    expect(discoveryRunStatusOf({ endReason: 'STOPPED', pages: complete, omittedUnreadPages: 0 })).toBe('PARTIAL');
    // 開始の画面を読めなかった: 監査と同じく、読み込みの失敗は PARTIAL（FAILED は PREFLIGHT の失敗だけ。判定は deriveRunStatus）。
    expect(discoveryRunStatusOf({ endReason: 'COMPLETED', pages: [unreadEntry('/admin', 'NAVIGATION_FAILED')], omittedUnreadPages: 0 })).toBe('PARTIAL');
    expect(discoveryRunStatusOf({ endReason: 'COMPLETED', pages: complete, omittedUnreadPages: 1 })).toBe('PARTIAL');
    expect(discoveryRunStatusOf({ endReason: 'PREFLIGHT_FAILED', pages: [], omittedUnreadPages: 0 })).toBe('FAILED');
    expect(discoveryRunStatusOf({ endReason: 'SAFETY_VIOLATION', pages: complete, omittedUnreadPages: 0 })).toBe('ABORTED_BY_SAFETY');
    expect(DISCOVERY_END_REASONS).toContain('COMPLETED');
  });
});

describe('T27d: the discovery.json schema (the candidates are the candidate schema, not a copy)', () => {
  it('uses the job id pattern of the IPC contract, the limits of the contracts and the schema version constant', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'discovery.schema.json'), 'utf8')) as {
      properties: { jobId: { pattern: string }; schemaVersion: { const: string } };
      $defs: { url: { maxLength: number } };
    };
    expect(schema.properties.jobId.pattern).toBe(WORKER_JOB_ID_PATTERN.source);
    expect(schema.properties.schemaVersion.const).toBe(DISCOVERY_ARTIFACT_SCHEMA_VERSION);
    expect(schema.$defs.url.maxLength).toBe(MAX_URL_LENGTH);
  });

  it('accepts a document with read and unread pages and candidates', async () => {
    const document = documentOf([
      readEntry('/admin', [BUTTON]),
      readEntry('/admin/items', [SEARCH]),
      unreadEntry('/admin/logout', 'EXCLUDED'),
      { url: `${SAMPLE_ORIGIN}/blank`, state: 'READ', record: record(null, [], ['INCOMPLETE_FREEZE_UNAVAILABLE']), blockedRequests: 2 },
    ]);
    const result = await validateArtifact('discovery', JSON.parse(JSON.stringify(document)));
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it('rejects a candidate that breaks the candidate schema, an unknown reason, a value field and a wrong version', async () => {
    const valid = documentOf([readEntry('/admin', [BUTTON])]);
    const brokenCandidate = documentOf([readEntry('/admin', [{ ...BUTTON, value: 'x' } as unknown as DiscoveryCandidate])]);
    const unknownReason = documentOf([{ url: `${SAMPLE_ORIGIN}/a`, state: 'NOT_READ', reason: 'SOMETHING' } as unknown as DiscoveryPageEntry]);
    const readWithReason = documentOf([{ ...readEntry('/admin', []), reason: 'EXCLUDED' } as unknown as DiscoveryPageEntry]);
    for (const [name, value] of [
      ['a candidate with a value', brokenCandidate],
      ['an unknown unread reason', unknownReason],
      ['a read page with a reason', readWithReason],
      ['another schema version', { ...valid, schemaVersion: 'discovery-schema/0.9' }],
      ['an extra property', { ...valid, cookies: [] }],
      ['an unknown end reason', { ...valid, endReason: 'DONE' }],
    ] as const) {
      expect((await validateArtifact('discovery', JSON.parse(JSON.stringify(value)))).ok, name).toBe(false);
    }
  });
});

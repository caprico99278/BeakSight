// RCA-4（検索の確かめの設計書 `doc/design/2026-11-18-beaksight-search-check-design.md` 2.2・2.3）: 最新の操作さがしの記録から、始める前に検索の確かめの組を作る。
// - GET の検索フォーム: 基準の組（文字の欄は空、select は最初の選択肢）と、1 つずつ変えた組（文字の欄は半角と全角の目印、select・radio は残りの選択肢、checkbox は入れる）。
// - スクリプトのきっかけ: 目印を運ぶ読み取りを出した押下・入力 × 文字の値 3 通り（空・半角の目印・全角の目印）。選択肢のきっかけは繰り返さない。
// - 守り（危険な語・秘密の名前）に当たる組は始める前に除き、数を残す。同じ形のフォーム・きっかけは 1 つにまとめる（数では切らない）。M は組の数。
// - 選択肢の多い select は、値の形の違うものを先に並べる。
import { describe, expect, it } from 'vitest';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { DiscoverySearchTriggerRecord, SearchReadRecord } from '../../src/discovery/search-read-contracts.js';
import { SEARCH_CHECK_TEXT_VALUES, searchCheckPlanOf, type SearchCheckCombo } from '../../src/discovery/search-check-plan.js';
import { candidateOf } from './approval-samples.js';
import { SAMPLE_ORIGIN as ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

const searchForm = (path: string) => candidateOf(sampleForm({
  page: { origin: ORIGIN, path },
  formMethod: 'GET',
  action: sampleAction('/items'),
  submitterText: '表示',
  fields: [
    sampleField('q', 'search'),
    sampleField('status', 'select-one', { options: ['', 'open', 'closed', 'deleted'] }),
    sampleField('mine', 'checkbox', { options: ['on'] }),
    sampleField('sort', 'hidden'),
  ],
}));

const read = (markerQueryNames: readonly string[]): SearchReadRecord => ({
  method: 'GET', resourceType: 'fetch', pathShape: '/api/items', queryNames: ['q'], markerQueryNames, status: 200,
});

const documentOf = (pages: readonly { path: string; candidates: ReturnType<typeof searchForm>[]; triggers?: DiscoverySearchTriggerRecord[] }[]): DiscoveryDocument =>
  ({
    pages: pages.map(({ path, candidates, triggers }) => ({
      url: `${ORIGIN}${path}`, state: 'READ', blockedRequests: 0,
      record: { location: { origin: ORIGIN, path }, incompleteReasons: [], candidates, ...(triggers === undefined ? {} : { searchTriggers: triggers }) },
    })),
  }) as unknown as DiscoveryDocument;

const formCombos = (combos: readonly SearchCheckCombo[]) => combos.flatMap((combo) => (combo.kind === 'FORM' ? [combo] : []));

describe('the combos of a GET search form', () => {
  it('makes the baseline and one change at a time, leaves out a dangerous option, and keeps one of the same forms', () => {
    const plan = searchCheckPlanOf(documentOf([{ path: '/a', candidates: [searchForm('/a')] }, { path: '/b', candidates: [searchForm('/b')] }]));
    // REV-RCA fix round 2: 文字の欄の値（目印）はワーカーが組ごとに作るので、組は空の送る値と、変え方の値の種類を持つ。
    expect(formCombos(plan.combos).map(({ parameters, change }) => [parameters, change.kind === 'TEXT' ? change.text : null])).toEqual([
      [{ q: '', status: '' }, null],
      [{ q: '', status: '' }, 'HALF_WIDTH'],
      [{ q: '', status: '' }, 'FULL_WIDTH'],
      [{ q: '', status: 'open' }, null],
      [{ q: '', status: 'closed' }, null],
      [{ q: '', status: '', mine: 'on' }, null],
    ]);
    expect(new Set(plan.combos.map(({ key }) => key)).size).toBe(plan.combos.length);
    expect(plan.combos).toHaveLength(6);
    expect(plan.excluded).toBe(1);
    expect(formCombos(plan.combos).every(({ page, unsentHiddenFields }) => page.path === '/a' && unsentHiddenFields)).toBe(true);
  });

  it('puts the options of different value shapes first', () => {
    const many = candidateOf(sampleForm({
      page: { origin: ORIGIN, path: '/m' }, formMethod: 'GET', action: sampleAction('/m'), submitterText: '表示',
      fields: [sampleField('k', 'select-one', { options: ['1', '2', '3', 'x', 'y', 'あ'] })],
    }));
    const values = formCombos(searchCheckPlanOf(documentOf([{ path: '/m', candidates: [many] }])).combos).map(({ parameters }) => parameters['k']);
    // 最初の選択肢は基準の組。残りは、形（数字・英字・そのほか）の違うものを先に並べる。
    expect(values).toEqual(['1', '2', 'x', 'あ', '3', 'y']);
  });
});

describe('the combos of a script search', () => {
  const press = (path: string, reads: readonly SearchReadRecord[]): DiscoverySearchTriggerRecord => ({
    trigger: {
      kind: 'PRESS', stage: 1, priorPresses: [], identityDigest: `sha256:${'a'.repeat(64)}`, ordinal: 0,
      inputFields: [{ name: 'word', selector: '#w', type: 'text', marker: 0 }],
    },
    reads,
  });
  const typed: DiscoverySearchTriggerRecord = {
    trigger: { kind: 'TYPED', stage: 1, priorPresses: [], field: { name: 'kw', selector: '#kw', type: 'search' } }, reads: [read(['q'])],
  };
  const option: DiscoverySearchTriggerRecord = {
    trigger: { kind: 'OPTION', stage: 1, priorPresses: [], field: { kind: 'SELECT', name: 'status', ordinal: 0 }, optionIndex: 1 }, reads: [read([])],
  };

  it('makes the three text values for a press or an input whose read carried the marker, once for the same search', () => {
    const plan = searchCheckPlanOf(documentOf([
      { path: '/a', candidates: [], triggers: [press('/a', [read(['word'])]), typed, option] },
      { path: '/b', candidates: [], triggers: [typed, press('/b', [read([])])] },
    ]));
    expect(plan.combos.map((combo) => (combo.kind === 'SCRIPT' ? [combo.trigger.kind, combo.text, combo.page.path] : null))).toEqual([
      ...SEARCH_CHECK_TEXT_VALUES.map((text) => ['PRESS', text, '/a']),
      ...SEARCH_CHECK_TEXT_VALUES.map((text) => ['TYPED', text, '/a']),
    ]);
    expect(new Set(plan.combos.map(({ key }) => key)).size).toBe(plan.combos.length);
    expect(searchCheckPlanOf(documentOf([{ path: '/a', candidates: [], triggers: [typed] }])).combos.map(({ key }) => key))
      .toEqual(plan.combos.slice(3).map(({ key }) => key));
  });

  // AIW: 操作さがしで AI の操作と覚えた候補（記録の印 `aiAction`）の押下と、その押下を前に含むきっかけは、始める前に除く（M は除いた後の数）。
  it('leaves out a trigger that presses an AI action, or follows a press of one, and counts them', () => {
    const AI = `sha256:${'b'.repeat(64)}`;
    const aiCandidate = { ...searchForm('/a'), classification: 'NEEDS_BINDING', identityDigest: AI, submissionProbe: { aiAction: true } } as unknown as ReturnType<typeof searchForm>;
    const pressOf = (identityDigest: string, priorPresses: readonly { stage: number; identityDigest: string; ordinal: number }[]): DiscoverySearchTriggerRecord => ({
      trigger: { kind: 'PRESS', stage: 1, priorPresses, identityDigest, ordinal: 0, inputFields: [{ name: identityDigest === AI ? 'w1' : 'w2', selector: '#w', type: 'text', marker: 0 }] },
      reads: [read(['word'])],
    });
    const plan = searchCheckPlanOf(documentOf([{ path: '/a', candidates: [aiCandidate], triggers: [
      pressOf(AI, []), pressOf(`sha256:${'c'.repeat(64)}`, [{ stage: 1, identityDigest: AI, ordinal: 0 }]), press('/a', [read(['word'])]),
    ] }]));
    expect(plan.combos.map((combo) => (combo.kind === 'SCRIPT' && combo.trigger.kind === 'PRESS' ? combo.trigger.identityDigest : combo.kind)))
      .toEqual(SEARCH_CHECK_TEXT_VALUES.map(() => `sha256:${'a'.repeat(64)}`));
    expect(plan.excluded).toBe(2 * SEARCH_CHECK_TEXT_VALUES.length);
  });

  it('leaves out a trigger that fills a field of a secret-looking name', () => {
    const secret: DiscoverySearchTriggerRecord = {
      trigger: { kind: 'TYPED', stage: 1, priorPresses: [], field: { name: 'api_key', selector: '#k', type: 'text' } }, reads: [read(['q'])],
    };
    const plan = searchCheckPlanOf(documentOf([{ path: '/a', candidates: [], triggers: [secret] }]));
    expect(plan.combos).toEqual([]);
    expect(plan.excluded).toBe(SEARCH_CHECK_TEXT_VALUES.length);
  });
});

// DEF-300（REV-RCA の判断「読まない URL の組は始める前に除く」）: 行き先（GET のフォームの action・きっかけが出す GET の path）が読まない path に当たる組は、
// 始める前に除き、数を残す（M は除いた後の数）。判定は呼ぶ側が渡す（今の 1 か所）。
describe('the combos whose destination is a path not to read', () => {
  it('leaves out the form and the trigger that go to a path not to read, and counts them', () => {
    const toPrivate = { ...read(['q']), pathShape: '/private/api' };
    const typedTo = (name: string, reads: readonly SearchReadRecord[]): DiscoverySearchTriggerRecord => ({
      trigger: { kind: 'TYPED', stage: 1, priorPresses: [], field: { name, selector: `#${name}`, type: 'search' } }, reads,
    });
    const document = documentOf([{ path: '/a', candidates: [searchForm('/a')], triggers: [typedTo('kw', [toPrivate]), typedTo('word', [read(['q'])])] }]);
    const all = searchCheckPlanOf(document);
    const plan = searchCheckPlanOf(document, (path) => path.startsWith('/items') || path.startsWith('/private'));
    expect(plan.combos.map((combo) => (combo.kind === 'SCRIPT' && combo.trigger.kind === 'TYPED' ? combo.trigger.field.name : combo.kind)))
      .toEqual(SEARCH_CHECK_TEXT_VALUES.map(() => 'word'));
    expect(plan.excluded).toBe(all.excluded + all.combos.length - plan.combos.length);
  });
});

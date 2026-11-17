// COV-4 の区切り 3（網羅の設計書 3.2 の 6。設計者の判断 2026-11-10）: 見るだけの点検の操作で開いた状態の監査の、ブラウザを使わない部品。
// - 開いた状態の状態 ID（`<読み込みの状態 ID>:state-<番号>`）と、画像の置き場（`…/<viewport>/state-<番号>/viewport.png`）。
// - 開いた状態の構造の鍵（ページの構造の鍵の入力に、開いた窓・区画と、押した候補の識別を足したもの）。同じ構造の鍵の状態は、Run の全体で 1 回だけ監査する。
//   見た鍵の集合は checkpoint（frontier の書き出し）に残す。前の版の checkpoint は空の集合として読む。
// - 開いた状態の記録だけで評価した指摘のうち、開く前の画面と fingerprint が同じものは除き、除いた数を数える。
// - 操作で文書が替わらずに URL が変わったら、path が変われば SPA_ROUTE、query だけなら QUERY_CHANGE の辺にする。
// - 表示用モデルが、開いた状態の数（監査した・同じ構造で監査しなかった）と、除いた指摘の数を数え、バンドルの summary に出す。
import { describe, expect, it } from 'vitest';
import { screenshotRelativePath } from '../../src/core/artifact-layout.js';
import { EVIDENCE_STATE_ID_PATTERN, evidenceStateIdOf, type Finding } from '../../src/core/contracts.js';
import { INTERACTION_NOT_VERIFIABLE_REASON_CODES, type InteractionEvidence } from '../../src/core/evidence-types.js';
import { INTERACTION_REASON_DESCRIPTIONS } from '../../src/presentation/messages.js';
import { createSha256Fingerprint } from '../../src/core/ids.js';
import { auditPageOutcomeOf, auditPageStructureKeyOf, openedStateStructureKeyOf } from '../../src/orchestration/audit-page-structure.js';
import { CrawlFrontier, type StoredCrawlFrontierSnapshot } from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { findingsNotInBase } from '../../src/orchestration/opened-state.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, dom, finding, fixtureUrl, interaction as interactionRecord, page, record } from '../helpers/audit-run-fixture.js';

/** 操作の記録（見本の `interaction` に、区切り 3 の欄を足したもの）。 */
const interaction = (overrides: Partial<InteractionEvidence>, sequence = 90): InteractionEvidence => ({
  ...interactionRecord(sequence, PAGE_1, 'VERIFIED', null).payload,
  ...overrides,
});

describe('COV-4 part 3: the opened states', () => {
  it('names the opened state and its screenshot place', () => {
    const stateId = evidenceStateIdOf(PAGE_1, 'desktop', 1, 2);
    expect(stateId).toBe(`${PAGE_1}:desktop:1:state-2`);
    expect(EVIDENCE_STATE_ID_PATTERN.test(stateId)).toBe(true);
    expect(EVIDENCE_STATE_ID_PATTERN.test(evidenceStateIdOf(PAGE_1, 'mobile', 1))).toBe(true);
    expect(screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, null, false, null, 2)).toBe(`pages/${PAGE_1}/desktop/state-2/viewport.png`);
  });

  it('keys the opened state by its structure, the opened region and the pressed candidates, not by its text', () => {
    const base = dom(1, PAGE_1, 'desktop', '本文', { headings: [{ level: 1, text: '見出し', truncated: false } as never] });
    const otherText = dom(2, PAGE_1, 'desktop', '別の本文', { headings: [{ level: 1, text: '別の見出し', truncated: false } as never] });
    const url = fixtureUrl('/');
    const opened = openedStateStructureKeyOf(base.payload, url, ['IC-tab']);
    expect(opened).toBe(openedStateStructureKeyOf(otherText.payload, url, ['IC-tab']));
    expect(opened).not.toBe(openedStateStructureKeyOf(base.payload, url, ['IC-menu']));
    expect(opened).not.toBe(auditPageStructureKeyOf(page(PAGE_1, '/', 'AUDITED', [base])));
  });

  it('drops the opened-state findings that the screen before opening already had, and counts them', () => {
    const before = [finding(1, 'ERROR', 'ACCESSIBILITY', PAGE_1, [], { fingerprint: createSha256Fingerprint('same') })];
    const opened: Finding[] = [
      finding(2, 'ERROR', 'ACCESSIBILITY', PAGE_1, [], { fingerprint: createSha256Fingerprint('same') }),
      finding(3, 'ERROR', 'ACCESSIBILITY', PAGE_1, [], { fingerprint: createSha256Fingerprint('new') }),
    ];
    const result = findingsNotInBase(before, opened);
    expect(result.kept.map(({ findingId }) => findingId)).toEqual([opened[1]?.findingId]);
    expect(result.droppedCount).toBe(1);
  });

  it('accepts each opened structure once in the Run, keeps the seen keys in the checkpoint, and reads an earlier checkpoint as empty', () => {
    const frontier = new CrawlFrontier(undefined, new IdAllocator());
    const key = createSha256Fingerprint('opened-structure');
    expect(frontier.acceptOpenedStructure(key)).toBe(true);
    expect(frontier.acceptOpenedStructure(key)).toBe(false);
    const stored = JSON.parse(JSON.stringify(frontier.snapshot())) as StoredCrawlFrontierSnapshot;
    expect(stored.openedStructureKeys).toEqual([key]);
    const options = { maxDepth: undefined, allocator: new IdAllocator(), allowedQueryParameters: new Set<string>(), requeueSkipReasonCodes: new Set<never>() };
    expect(CrawlFrontier.restore(stored, options).acceptOpenedStructure(key)).toBe(false);
    const { openedStructureKeys: _keys, ...earlier } = stored;
    expect(CrawlFrontier.restore(earlier, options).acceptOpenedStructure(key)).toBe(true);
  });

  it('makes SPA_ROUTE and QUERY_CHANGE edges from the URL after an interaction', () => {
    const result = page(PAGE_1, '/list', 'AUDITED', [
      record('interaction', 1, PAGE_1, 'desktop', interaction({ postInteractionUrl: fixtureUrl('/list/detail') })),
      record('interaction', 2, PAGE_1, 'desktop', interaction({ postInteractionUrl: fixtureUrl('/list?tab=2') })),
      record('interaction', 3, PAGE_1, 'desktop', interaction({ postInteractionUrl: fixtureUrl('/list') })),
    ]);
    expect(auditPageOutcomeOf(result).edges).toEqual([
      { kind: 'SPA_ROUTE', url: fixtureUrl('/list/detail') },
      { kind: 'QUERY_CHANGE', url: fixtureUrl('/list?tab=2') },
    ]);
  });

  // 入れ子の開いた状態（設計者の判断 2026-11-10）: 開いた状態の中の候補は、（その状態の構造の鍵、候補の ID、順番）がまだ見ていない組だけを押す。押した組は
  // checkpoint に残し、前の版の checkpoint は空として読む。押し直しが再現しなければ `TRAIL_NOT_REPRODUCED`。
  it('accepts each press of an opened state once, keeps the pressed pairs in the checkpoint, and reads an earlier checkpoint as empty', () => {
    const frontier = new CrawlFrontier(undefined, new IdAllocator());
    const press = { structureKey: createSha256Fingerprint('state'), candidateId: 'IC-tab', ordinal: 0 };
    expect(frontier.acceptOpenedPress(press)).toBe(true);
    expect(frontier.acceptOpenedPress(press)).toBe(false);
    expect(frontier.acceptOpenedPress({ ...press, ordinal: 1 })).toBe(true);
    const stored = JSON.parse(JSON.stringify(frontier.snapshot())) as StoredCrawlFrontierSnapshot;
    expect(stored.openedPresses).toEqual([press, { ...press, ordinal: 1 }]);
    const options = { maxDepth: undefined, allocator: new IdAllocator(), allowedQueryParameters: new Set<string>(), requeueSkipReasonCodes: new Set<never>() };
    expect(CrawlFrontier.restore(stored, options).acceptOpenedPress(press)).toBe(false);
    const { openedPresses: _presses, ...earlier } = stored;
    expect(CrawlFrontier.restore(earlier, options).acceptOpenedPress(press)).toBe(true);
  });

  it('has the reason for a press trail that could not be reproduced, with a plain description', () => {
    expect(INTERACTION_NOT_VERIFIABLE_REASON_CODES).toContain('TRAIL_NOT_REPRODUCED');
    expect(INTERACTION_REASON_DESCRIPTIONS.TRAIL_NOT_REPRODUCED).toBe('前の操作を再現できなかったので、確かめられませんでした。');
  });

  it('keys an opened state by the candidates it shows, so that the same tabs opened one by one are one structure', () => {
    const state = dom(1, PAGE_1, 'desktop', '本文');
    const url = fixtureUrl('/');
    expect(openedStateStructureKeyOf(state.payload, url, ['IC-t1', 'IC-t2'])).toBe(openedStateStructureKeyOf(state.payload, url, ['IC-t2', 'IC-t1']));
  });

  it('keys an opened state by the fields it shows, so that a nested region that shows a hidden field is another structure', () => {
    const field = (visible: boolean) => ({
      type: 'text', name: 'q', required: false, visible, labels: [], hasAriaLabel: false, hasAriaLabelledby: false, hasTitle: false, truncated: false,
    });
    const hidden = dom(1, PAGE_1, 'desktop', '本文', { unassociatedFields: [field(false)] } as never);
    const shown = dom(2, PAGE_1, 'desktop', '本文', { unassociatedFields: [field(true)] } as never);
    const none = dom(3, PAGE_1, 'desktop', '本文');
    const url = fixtureUrl('/');
    expect(openedStateStructureKeyOf(hidden.payload, url, ['IC-more'])).not.toBe(openedStateStructureKeyOf(shown.payload, url, ['IC-more']));
    expect(openedStateStructureKeyOf(hidden.payload, url, ['IC-more'])).toBe(openedStateStructureKeyOf(none.payload, url, ['IC-more']));
  });

  it('reads the recheck mark of an opened-state finding from the recheck table of the opened state', () => {
    const fingerprint = createSha256Fingerprint('opened-finding');
    const stateId = evidenceStateIdOf(PAGE_1, 'desktop', 1, 1);
    const opened = interaction({
      openedState: {
        stateId, structureKey: createSha256Fingerprint('b'), status: 'AUDITED', duplicateFindingCount: 0,
        recheck: {
          status: 'RECHECKED', reason: null, stateId, startedAt: '2026-09-24T00:00:00.000Z', finishedAt: '2026-09-24T00:00:01.000Z', settling: null,
          axeRuleIds: ['button-name'], findings: [{ fingerprint, ruleId: 'A11Y_AXE', state: 'INITIAL_ONLY' }], headings: [],
        },
      },
    });
    const run = auditRun({
      pages: [page(PAGE_1, '/', 'AUDITED', [record('interaction', 1, PAGE_1, 'desktop', opened)], [
        finding(5, 'ERROR', 'ACCESSIBILITY', PAGE_1, [], { fingerprint }),
      ])],
    });
    expect(buildReportViewModel(run).findings[0]?.verification.recheck).toBe('INITIAL_ONLY');
  });

  it('counts the opened states and the dropped findings for the bundle summary', () => {
    const run = auditRun({
      pages: [page(PAGE_1, '/', 'AUDITED', [
        record('interaction', 1, PAGE_1, 'desktop', interaction({
          openedState: { stateId: evidenceStateIdOf(PAGE_1, 'desktop', 1, 1), structureKey: createSha256Fingerprint('a'), status: 'AUDITED', duplicateFindingCount: 2 },
        })),
        record('interaction', 2, PAGE_1, 'desktop', interaction({
          openedState: { stateId: evidenceStateIdOf(PAGE_1, 'desktop', 1, 2), structureKey: createSha256Fingerprint('a'), status: 'SAME_STRUCTURE_SEEN', duplicateFindingCount: 0 },
        })),
      ])],
    });
    expect(buildReportViewModel(run).summary.openedStates).toEqual({ audited: 1, sameStructureSeen: 1, partial: 0, duplicateFindingsDropped: 2 });
  });
});

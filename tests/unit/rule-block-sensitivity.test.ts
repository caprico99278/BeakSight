// BN-c（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.4）: Rule ごとの「結果が変わりうる遮断の種類の集まり」の表が、Rule の一覧
// （page rule の `RULE_CATALOG` と Cross-page rule の `CROSS_PAGE_RULES`）と過不足なく一致すること。表を引く関数の決まり。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { axeViolationFindingRuleIdOf } from '../../src/audit/accessibility-rules.js';
import { CROSS_PAGE_RULES } from '../../src/audit/cross-page-rules.js';
import { RULE_CATALOG } from '../../src/audit/rule-catalog.js';
import { RULE_BLOCK_SENSITIVITIES, ruleBlockSensitivityOf, type SafetyPhaseEvents } from '../../src/audit/rule-block-sensitivity.js';
import { SAFETY_RULES } from '../../src/audit/safety-rules.js';
import { BEAKSIGHT_BLOCK_KINDS } from '../../src/core/beaksight-block-relation.js';
import type { SafetyEventsEvidence } from '../../src/core/evidence-types.js';
import { PAGE_1, fixtureUrl, safety } from '../helpers/audit-run-fixture.js';

const keyOf = (entry: { readonly ruleId?: string; readonly ruleIdPrefix?: string }): string =>
  entry.ruleIdPrefix === undefined ? `id:${entry.ruleId ?? ''}` : `prefix:${entry.ruleIdPrefix}`;

describe('BN-c: the table of the Rule sensitivities to the BeakSight blocks', () => {
  it('has exactly one row for each Rule of the catalogs (by ruleId, or by ruleIdPrefix for the Rules that make ruleIds), and no other row', () => {
    const prefixes = RULE_CATALOG.flatMap((rule) => (rule.ruleIdPrefix === undefined ? [] : [rule.ruleIdPrefix]));
    // 評価のたびに ruleId を作る Rule の、名前つきの行（例: axe の欠けの Rule。接頭辞の行より先に引く）は、Rule の一覧の行ではない。
    const isDerivedRow = (entry: (typeof RULE_BLOCK_SENSITIVITIES)[number]): boolean =>
      entry.ruleId !== undefined && prefixes.some((prefix) => entry.ruleId?.startsWith(prefix) === true)
      && ![...RULE_CATALOG, ...CROSS_PAGE_RULES].some((rule) => rule.ruleId === entry.ruleId);
    const ruleKeys = [...RULE_CATALOG, ...CROSS_PAGE_RULES].map(keyOf).sort();
    const tableKeys = RULE_BLOCK_SENSITIVITIES.filter((entry) => !isDerivedRow(entry)).map(keyOf).sort();
    expect(tableKeys).toEqual(ruleKeys);
    const allKeys = RULE_BLOCK_SENSITIVITIES.map(keyOf);
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(RULE_BLOCK_SENSITIVITIES.filter(isDerivedRow).map((entry) => entry.ruleId)).toEqual([
      'A11Y_DOCUMENT_TITLE',
      'A11Y_HTML_HAS_LANG',
      'A11Y_LANDMARK_ONE_MAIN',
      'A11Y_PAGE_HAS_HEADING_ONE',
      'A11Y_BYPASS',
    ]);
  });

  it('has a row with either a ruleId or a ruleIdPrefix, and kinds of the closed list in its order', () => {
    for (const entry of RULE_BLOCK_SENSITIVITIES) {
      expect((entry.ruleId === undefined) !== (entry.ruleIdPrefix === undefined), keyOf(entry)).toBe(true);
      expect([...entry.kinds], keyOf(entry)).toEqual(BEAKSIGHT_BLOCK_KINDS.filter((kind) => entry.kinds.includes(kind)));
    }
  });

  it('gives the Rules that a block cannot change an empty set, and the Rules of the SAFETY group an empty set', () => {
    for (const ruleId of ['HTTP_4XX', 'HTTP_5XX', 'POOR_TTFB', 'SCRIPT_LOAD_FAILED', 'STYLESHEET_LOAD_FAILED', 'SAFETY_NON_READ_REQUEST_BLOCKED']) {
      expect(ruleBlockSensitivityOf(ruleId).kinds, ruleId).toEqual([]);
    }
  });

  // BN-R1 の M-3: 欠けの指摘と例外はデータの遮断で変わりうる。表示された要素の欠陥は、表示を作る種類の遮断だけで変わりうる（N-2 で image を足した）。
  it('gives the missing and the exception Rules script and data, and the Rules of the displayed elements script, stylesheet, font, image and document only', () => {
    for (const ruleId of [
      'MISSING_TITLE', 'EMPTY_TITLE', 'MISSING_HTML_LANG', 'INVALID_CANONICAL_URL', 'DUPLICATE_PAGE_TITLE', 'DUPLICATE_CANONICAL', 'CANONICAL_TARGET_NOT_FOUND',
      'A11Y_DOCUMENT_TITLE', 'A11Y_HTML_HAS_LANG', 'A11Y_LANDMARK_ONE_MAIN', 'A11Y_PAGE_HAS_HEADING_ONE', 'A11Y_BYPASS',
    ]) {
      expect(ruleBlockSensitivityOf(ruleId).kinds, ruleId).toEqual(['SCRIPT', 'DATA']);
    }
    // サーバが返した応答の事実（設計者の判断）。
    for (const ruleId of ['RESOURCE_4XX', 'RESOURCE_5XX']) {
      expect(ruleBlockSensitivityOf(ruleId).kinds, ruleId).toEqual([]);
    }
    expect(ruleBlockSensitivityOf('EMPTY_VISIBLE_CONTENT').kinds).toEqual(['SCRIPT', 'STYLESHEET', 'DATA']);
    expect(ruleBlockSensitivityOf('PAGE_ERROR').kinds).toEqual(['SCRIPT', 'DATA', 'DOCUMENT', 'WEBSOCKET']);
    for (const ruleId of [
      'DOCUMENT_HORIZONTAL_OVERFLOW', 'ELEMENT_OUTSIDE_VIEWPORT', 'ELEMENT_OVERLAP', 'TEXT_CLIPPING', 'FIXED_ELEMENT_OCCLUSION', 'ZERO_SIZE_INTERACTIVE_ELEMENT',
      'CONTENT_COLLISION', 'OVERSIZED_FIXED_ELEMENT', 'DYNAMIC_LAYOUT_SHIFT', 'COLOR_CONTRAST_VIOLATION', 'A11Y_IMAGE_ALT', 'A11Y_FRAME_TITLE', 'DUPLICATE_ELEMENT_ID',
      'UNLABELED_REQUIRED_CONTROL', 'FORM_WITHOUT_ACTION', 'IMAGE_LOAD_FAILED',
    ]) {
      expect(ruleBlockSensitivityOf(ruleId).kinds, ruleId).toEqual(['SCRIPT', 'STYLESHEET', 'FONT', 'IMAGE', 'DOCUMENT']);
    }
  });

  it('finds the target of the load failure Rules, the target navigation and the page error', () => {
    expect(ruleBlockSensitivityOf('SCRIPT_LOAD_FAILED').target).toEqual({ kind: 'LOAD_FAILURE', resourceType: 'script', domImages: false });
    expect(ruleBlockSensitivityOf('IMAGE_LOAD_FAILED').target).toEqual({ kind: 'LOAD_FAILURE', resourceType: 'image', domImages: true });
    expect(ruleBlockSensitivityOf('TARGET_NAVIGATION_FAILED').target).toEqual({ kind: 'TARGET_NAVIGATION' });
    expect(ruleBlockSensitivityOf('PAGE_ERROR').target).toEqual({ kind: 'PAGE_ERROR' });
    expect(ruleBlockSensitivityOf('MISSING_TITLE').target).toBeNull();
  });

  it('reads a ruleId made by a Rule with a ruleIdPrefix by the prefix row, and treats an unknown ruleId as sensitive to every kind', () => {
    expect(ruleBlockSensitivityOf('A11Y_IMAGE_ALT').kinds).toEqual(['SCRIPT', 'STYLESHEET', 'FONT', 'IMAGE', 'DOCUMENT']);
    expect(ruleBlockSensitivityOf('TEST_RULE_1')).toEqual({ kinds: BEAKSIGHT_BLOCK_KINDS, target: null, doubtful: true, safetyPhaseEvents: null });
  });

  // 名前つきの axe の行の元の axe のルールの ID が、今入っている axe-core（`@axe-core/playwright` が読むもの）のルールの一覧にあること。axe の版が上がって ID が
  // 変わると、名前つきの行が当たらなくなり、接頭辞の行の扱いに黙って戻るため。axe-core は Node の中で読み、ブラウザを起動しない（`axe.getRules()`）。
  it('finds the axe rule ID of every named axe row in the installed axe-core, and converts it to the ruleId of the row', () => {
    const requireFromAxeBuilder = createRequire(createRequire(import.meta.url).resolve('@axe-core/playwright'));
    const axe = requireFromAxeBuilder('axe-core') as { readonly version: string; getRules(): readonly { readonly ruleId: string }[] };
    const installed = new Set(axe.getRules().map((rule) => rule.ruleId));
    const prefixRows = RULE_BLOCK_SENSITIVITIES.flatMap((entry) => (entry.ruleIdPrefix === undefined ? [] : [entry.ruleIdPrefix]));
    const namedAxeRows = RULE_BLOCK_SENSITIVITIES.flatMap((entry) =>
      (entry.ruleId !== undefined && prefixRows.some((prefix) => entry.ruleId?.startsWith(prefix) === true) && entry.ruleId !== 'A11Y_AXE' ? [entry.ruleId] : []));
    // 名前つきの行ごとの、元の axe のルールの ID（行を足したら、ここにも足す）。
    const sourceIds: Readonly<Record<string, string>> = {
      A11Y_DOCUMENT_TITLE: 'document-title',
      A11Y_HTML_HAS_LANG: 'html-has-lang',
      A11Y_LANDMARK_ONE_MAIN: 'landmark-one-main',
      A11Y_PAGE_HAS_HEADING_ONE: 'page-has-heading-one',
      A11Y_BYPASS: 'bypass',
    };
    expect(Object.keys(sourceIds).sort()).toEqual([...namedAxeRows].sort());
    const missing = Object.values(sourceIds).filter((id) => !installed.has(id));
    expect(missing, `axe-core ${axe.version} にない axe のルールの ID: ${missing.join(', ')}`).toEqual([]);
    for (const [ruleId, axeRuleId] of Object.entries(sourceIds)) {
      expect(axeViolationFindingRuleIdOf(axeRuleId), axeRuleId).toBe(ruleId);
    }
  });

  // BN-R0 の M-3: SAFETY の Rule が数える、時点を持つ止めた事象の一覧が、Rule の評価と一致すること。
  it('names, for each SAFETY Rule, the blocked events with a phase that the Rule counts', () => {
    const samples: Readonly<Record<SafetyPhaseEvents, Partial<SafetyEventsEvidence>>> = {
      NON_READ_REQUESTS: { blockedRequests: [{ method: 'DELETE', url: fixtureUrl('/api/x'), reason: 'NON_READ_METHOD', resourceType: 'xhr', phase: 'CLOSING' }] },
      NAVIGATIONS: { blockedNavigations: [{ method: 'GET', url: 'https://external.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION', phase: 'LOAD' }] },
      WEBSOCKETS: { blockedWebSockets: [{ url: 'ws://127.0.0.1:4173/socket', reason: 'PASSIVE_WEBSOCKET', phase: 'LOAD' }] },
    };
    for (const [events, overrides] of Object.entries(samples) as [SafetyPhaseEvents, Partial<SafetyEventsEvidence>][]) {
      const evidence = safety(1, PAGE_1, 'desktop', overrides);
      const fired = SAFETY_RULES.filter((rule) =>
        rule.evaluate({ pageId: PAGE_1, pageUrl: fixtureUrl('/'), viewport: 'desktop', evidence: [evidence] }).length > 0).map((rule) => rule.ruleId);
      const named = RULE_BLOCK_SENSITIVITIES.filter((entry) => entry.safetyPhaseEvents === events).map((entry) => entry.ruleId);
      expect(fired, events).toEqual(named);
    }
    // 読み取りの GET を止めた記録（上限など）は、読み取りでない送信の Rule が数えない。
    const readBlock = safety(1, PAGE_1, 'desktop', {
      blockedRequests: [{ method: 'GET', url: fixtureUrl('/x.js'), reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED', resourceType: 'script', phase: 'LOAD' }],
    });
    expect(SAFETY_RULES.filter((rule) =>
      rule.evaluate({ pageId: PAGE_1, pageUrl: fixtureUrl('/'), viewport: 'desktop', evidence: [readBlock] }).length > 0)).toEqual([]);
  });
});

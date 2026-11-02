// OP-R2（UI の SSOT の決まり「Finding の文言は Rule が持つ」。PL 設計書 14 章）: 結果の報告の本文に出す、Rule ごとのやさしい文（`plainMessage`）。
// - 持ち主は Rule の定義（page rule の `RULE_CATALOG`、Cross-page rule の `CROSS_PAGE_RULES`）の 1 か所。表示のカタログには置かない。
// - 評価のたびに ruleId を作る Rule（axe の Rule）は、その Rule の群の持ち主の、種類ごとの 1 つの文で受ける。
// - 文の決まり: 技術の語（タグ・属性の名前、HTTP の番号、Origin、URL など）を使わない。困ることが分かる 1〜2 文。
import { describe, expect, it } from 'vitest';
import { axeViolationFindingRuleIdOf } from '../../src/audit/accessibility-rules.js';
import { CROSS_PAGE_RULES, rulePlainMessageOf } from '../../src/audit/cross-page-rules.js';
import { RULE_CATALOG } from '../../src/audit/rule-catalog.js';

const ALL_RULES = [...RULE_CATALOG, ...CROSS_PAGE_RULES];

/** 技術の語の目印（英字・数字・タグや住所の記号）。やさしい文には、どれも入れない。 */
const TECHNICAL_CHARACTERS = /[A-Za-z0-9<>/:=#@_]/u;
/** 文の終わり。 */
const SENTENCE_END = '。';
const MAX_SENTENCES = 2;

describe('OP-R2: the plain message of each Rule', () => {
  it('gives every Rule of both catalogs a plain message of one or two sentences without technical words', () => {
    expect(ALL_RULES.length).toBeGreaterThan(0);
    for (const rule of ALL_RULES) {
      const text = rule.plainMessage;
      expect(typeof text, rule.ruleId).toBe('string');
      expect(text.length, rule.ruleId).toBeGreaterThan(0);
      expect(text, rule.ruleId).not.toMatch(TECHNICAL_CHARACTERS);
      expect(text.endsWith(SENTENCE_END), rule.ruleId).toBe(true);
      const sentences = text.split(SENTENCE_END).length - 1;
      expect(sentences, rule.ruleId).toBeGreaterThanOrEqual(1);
      expect(sentences, rule.ruleId).toBeLessThanOrEqual(MAX_SENTENCES);
    }
  });

  it('finds the plain message of a Finding by its ruleId, from the Rule that owns the ruleId', () => {
    for (const rule of ALL_RULES) {
      expect(rulePlainMessageOf(rule.ruleId), rule.ruleId).toBe(rule.plainMessage);
    }
    expect(rulePlainMessageOf('MISSING_HTML_LANG')).toBe('ページの言語の指定がないため、読み上げのソフトが正しく読めないことがあります。');
  });

  it('answers the ruleIds made by the axe Rule with the one plain message of that group', () => {
    const group = RULE_CATALOG.find((rule) => rule.ruleIdPrefix !== undefined);
    expect(group).toBeDefined();
    for (const axeRuleId of ['image-alt', 'document-title', 'label']) {
      const ruleId = axeViolationFindingRuleIdOf(axeRuleId);
      expect(ruleId, axeRuleId).not.toBeNull();
      expect(rulePlainMessageOf(ruleId!), axeRuleId).toBe(group!.plainMessage);
    }
    // 色のコントラストは、別の Rule の文。
    expect(rulePlainMessageOf('COLOR_CONTRAST_VIOLATION')).not.toBe(group!.plainMessage);
  });

  it('answers null for a ruleId that no Rule owns (the prefix alone, or an unknown ruleId)', () => {
    const prefix = RULE_CATALOG.find((rule) => rule.ruleIdPrefix !== undefined)?.ruleIdPrefix;
    expect(prefix).toBeDefined();
    expect(rulePlainMessageOf(prefix!)).toBeNull();
    expect(rulePlainMessageOf('TEST_RULE_1')).toBeNull();
    expect(rulePlainMessageOf('')).toBeNull();
  });
});

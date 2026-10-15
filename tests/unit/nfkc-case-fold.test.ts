// CCX-15（共通化の台帳の CC-069）: Unicode の正規化（NFKC）と大文字小文字の畳み込み（`toUpperCase` の後に `toLowerCase`）の結果を固定する表。
// - 呼び出し側の 2 か所の結果を固定する: 要求の判定の owner の、除外のパスと危険な語の比べ（`classifyPassiveRequest` の `auditExclusions`）と、
//   発見の候補の分類（`classifyCandidate`）。畳み込みを `src/core/text.ts` の 1 か所に移しても、結果が変わらないことを確かめる（移す前に
//   PASS させた表）。
// - 文字の表: `ſ`（U+017F）、ケルビン記号（U+212A）、全角の英字と `／`・`；`、ドイツ語の `ß`、トルコ語の `İ`（U+0130）、合字（U+FB01）、
//   ギリシャ語の終わりのシグマ、空文字、サロゲートの対。
// 例の値は、匿名の値（`127.0.0.1`）だけを使う。
import { describe, expect, it } from 'vitest';
import { foldNfkcCase } from '../../src/core/text.js';
import type { DiscoveredCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { classifyPassiveRequest, type AuditExclusionPolicy } from '../../src/safety/request-policy.js';
import { SAMPLE_ALLOWED_ORIGINS, SAMPLE_ORIGIN, sampleField, sampleForm } from './discovery-candidate-samples.js';

const LONG_S = 'ſ';
const KELVIN = 'K';
const FULLWIDTH_ADMIN = 'ａｄｍｉｎ';
const FULLWIDTH_SLASH = '／';
const FULLWIDTH_SEMICOLON = '；';
const SHARP_S = 'ß';
const DOTTED_CAPITAL_I = 'İ';
const COMBINING_DOT_ABOVE = '̇';
const FI_LIGATURE = 'ﬁ';
const GREEK_CAPITAL_ODOS = 'ΟΔΟΣ';
const GREEK_SMALL_ODOS_WITH_MEDIAL_SIGMA = 'οδοσ';
const GREEK_SMALL_ODOS_WITH_FINAL_SIGMA = 'οδος';
const BOLD_SMALL_A = '\u{1d41a}';
const BOLD_SMALL_DELETE = '\u{1d41d}\u{1d41e}\u{1d425}\u{1d41e}\u{1d42d}\u{1d41e}';
const EMOJI = '\u{1f600}';

describe('CCX-15: foldNfkcCase (the owner in src/core/text.ts, CC-069)', () => {
  /** [説明, 入力, 期待] */
  const TABLE: readonly (readonly [string, string, string])[] = [
    ['ASCII upper case', 'AdMiN', 'admin'],
    ['long s', LONG_S, 's'],
    ['the Kelvin sign', KELVIN, 'k'],
    ['full-width letters, slash and semicolon', `Ａ${FULLWIDTH_SLASH}${FULLWIDTH_SEMICOLON}`, 'a/;'],
    ['German sharp s (upper case first, so it becomes ss)', SHARP_S, 'ss'],
    ['Turkish dotted capital I (i with a combining dot)', DOTTED_CAPITAL_I, `i${COMBINING_DOT_ABOVE}`],
    ['the fi ligature', FI_LIGATURE, 'fi'],
    ['a lone Greek capital sigma', 'Σ', 'σ'],
    ['Greek capitals with a final sigma', GREEK_CAPITAL_ODOS, GREEK_SMALL_ODOS_WITH_FINAL_SIGMA],
    ['a medial sigma at the end of a word', GREEK_SMALL_ODOS_WITH_MEDIAL_SIGMA, GREEK_SMALL_ODOS_WITH_FINAL_SIGMA],
    ['the empty string', '', ''],
    ['a surrogate pair folded to ASCII', BOLD_SMALL_A, 'a'],
    ['a surrogate pair that stays', EMOJI, EMOJI],
  ];

  it.each(TABLE)('%s', (_label, input, expected) => {
    expect(foldNfkcCase(input)).toBe(expected);
  });

  it('folds upper case first, then lower case (not lower case only)', () => {
    expect(SHARP_S.toLowerCase()).toBe(SHARP_S);
    expect(foldNfkcCase(SHARP_S)).not.toBe(SHARP_S.normalize('NFKC').toLowerCase());
  });
});

describe('CCX-15: the exclusion comparison of the request policy keeps its results (CC-069)', () => {
  const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([SAMPLE_ORIGIN]);
  const decide = (path: string, exclusions: Partial<AuditExclusionPolicy>): string => classifyPassiveRequest(
    { kind: 'HTTP', method: 'GET', url: `${SAMPLE_ORIGIN}${path}`, isNavigationRequest: true, isMainFrame: true },
    ALLOWED_ORIGINS,
    { auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [], ...exclusions } },
  ).action;

  /** [説明, path, 除外の口, 期待] */
  const TABLE: readonly (readonly [string, string, Partial<AuditExclusionPolicy>, 'ALLOW' | 'BLOCK'])[] = [
    ['a plain path without a match', '/public', { dangerousTerms: ['secret'], excludedPathPrefixes: ['/admin'] }, 'ALLOW'],
    ['long s in the path', `/${LONG_S}ecret`, { dangerousTerms: ['secret'] }, 'BLOCK'],
    ['long s in the term', '/secret', { dangerousTerms: [`${LONG_S}ecret`] }, 'BLOCK'],
    ['the Kelvin sign in the path', `/${KELVIN}ey`, { excludedPathPrefixes: ['/key'] }, 'BLOCK'],
    ['full-width letters in the path', `/${FULLWIDTH_ADMIN}`, { excludedPathPrefixes: ['/admin'] }, 'BLOCK'],
    ['a full-width slash and dot segments', `/public${FULLWIDTH_SLASH}..${FULLWIDTH_SLASH}admin`, { excludedPathPrefixes: ['/admin'] }, 'BLOCK'],
    ['a full-width semicolon', `/a${FULLWIDTH_SEMICOLON}b`, { excludedPathPrefixes: ['/a;b'] }, 'BLOCK'],
    ['German sharp s', `/stra${SHARP_S}e`, { dangerousTerms: ['strasse'] }, 'BLOCK'],
    ['Turkish dotted capital I against a plain i', `/${DOTTED_CAPITAL_I}nfo`, { dangerousTerms: ['info'] }, 'ALLOW'],
    ['Turkish dotted capital I against i with a combining dot', `/${DOTTED_CAPITAL_I}nfo`, { dangerousTerms: [`i${COMBINING_DOT_ABOVE}nfo`] }, 'BLOCK'],
    ['the fi ligature', `/pro${FI_LIGATURE}le`, { dangerousTerms: ['profile'] }, 'BLOCK'],
    ['Greek capitals against a medial sigma', `/${GREEK_CAPITAL_ODOS}`, { dangerousTerms: [GREEK_SMALL_ODOS_WITH_MEDIAL_SIGMA] }, 'BLOCK'],
    ['a medial sigma against a final sigma', `/${GREEK_SMALL_ODOS_WITH_MEDIAL_SIGMA}`, { dangerousTerms: [GREEK_SMALL_ODOS_WITH_FINAL_SIGMA] }, 'BLOCK'],
    ['an empty term and an empty prefix', '/anything', { dangerousTerms: [''], excludedPathPrefixes: [''] }, 'ALLOW'],
    ['a surrogate pair folded to ASCII', `/${BOLD_SMALL_A}dmin`, { excludedPathPrefixes: ['/admin'] }, 'BLOCK'],
    ['a surrogate pair that stays', `/${EMOJI}`, { dangerousTerms: ['admin'] }, 'ALLOW'],
  ];

  it.each(TABLE)('%s', (_label, path, exclusions, expected) => {
    expect(decide(path, exclusions)).toBe(expected);
  });
});

describe('CCX-15: the discovery classification keeps its results (CC-069)', () => {
  const policy = { allowedOrigins: SAMPLE_ALLOWED_ORIGINS };
  const resultOf = (candidate: DiscoveredCandidate) => {
    const { reasonCode, hasStateField } = classifyCandidate(candidate, policy);
    return { reasonCode, hasStateField };
  };
  const action = (path: string) => ({ origin: SAMPLE_ORIGIN, path, queryNames: [] });

  /** [説明, 候補, 期待の理由, 期待の状態の欄の印] */
  const TABLE: readonly (readonly [string, DiscoveredCandidate, string, boolean])[] = [
    ['a plain submit button', sampleForm(), 'UNCLASSIFIED', false],
    ['long s in the button text', sampleForm({ submitterText: `${LONG_S}earch` }), 'POST_SEARCH', false],
    ['the Kelvin sign in the button text', sampleForm({ submitterText: `bul${KELVIN}` }), 'DESTRUCTIVE', false],
    ['full-width letters in the button text', sampleForm({ submitterText: 'ｄｅｌｅｔｅ' }), 'DESTRUCTIVE', false],
    ['a full-width slash in the action path', sampleForm({ action: action(`/api${FULLWIDTH_SLASH}graphql`) }), 'GRAPHQL_ENDPOINT', false],
    ['a full-width semicolon in the button text', sampleForm({ submitterText: `sign${FULLWIDTH_SEMICOLON}out` }), 'DESTRUCTIVE', false],
    ['a full-width _method field', sampleForm({ fields: [sampleField('＿ｍｅｔｈｏｄ', 'hidden')] }), 'METHOD_OVERRIDE_UNRECOGNIZED', false],
    ['German sharp s in a field name', sampleForm({ fields: [sampleField(`statu${SHARP_S}`)] }), 'UNCLASSIFIED', true],
    ['Turkish dotted capital I in the button text', sampleForm({ submitterText: `${DOTTED_CAPITAL_I}nsert` }), 'UNCLASSIFIED', false],
    ['the fi ligature in the button text', sampleForm({ submitterText: `${FI_LIGATURE}nd` }), 'POST_SEARCH', false],
    ['Greek capitals in the button text', sampleForm({ submitterText: GREEK_CAPITAL_ODOS }), 'UNCLASSIFIED', false],
    ['an empty button text', sampleForm({ submitterText: '' }), 'UNCLASSIFIED', false],
    ['a surrogate pair folded to ASCII', sampleForm({ submitterText: BOLD_SMALL_DELETE }), 'DESTRUCTIVE', false],
    ['a surrogate pair that stays', sampleForm({ submitterText: EMOJI }), 'UNCLASSIFIED', false],
  ];

  it.each(TABLE)('%s', (_label, candidate, reasonCode, hasStateField) => {
    expect(resultOf(candidate)).toEqual({ reasonCode, hasStateField });
  });
});

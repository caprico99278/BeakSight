// AUD-9b・9c（設計書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md`）: 同じ UI の繰り返しを、表示用モデルで候補群に 1 回だけまとめる。
// - 群の鍵は ruleId と `groupingKeys`（URL・ページ・ビューポートは入れない）。要素の作りの印（タグと class）が取れる Finding は selector の番号を丸め、作りの印が
//   同じものだけを同じ群にする。取れない Finding は丸めない。鍵が空の Finding は 1 件の群。
// - HTML のまとめの段に「同じ作りの所でまとめると N か所です。」を出す。
// - 確信度は表の 1 か所で決め、並びには使わない（severity の順のまま）。
// - バンドルの `finding-groups.json` と `findings-by-rule.json` の群の ID は、表示用モデルの写し。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ACCESSIBILITY_RULES } from '../../src/audit/accessibility-rules.js';
import { roundSelectorNumbers } from '../../src/audit/finding-grouping-keys.js';
import { RuleEngine } from '../../src/audit/rule-engine.js';
import { RULE_VERIFICATION_BASES } from '../../src/audit/rule-verification-basis.js';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { AuditRunResult, EvidencePayloadByType, Finding, PageId } from '../../src/core/contracts.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { CHATGPT_BUNDLE_FILE_NAMES, createChatGptBundle, type ReadArtifactFile } from '../../src/report/chatgpt-bundle.js';
import {
  FINDING_GROUP_CONFIDENCE_BY_BASIS,
  FINDING_GROUP_CONFIDENCES,
  findingGroupConfidenceOf,
  structureOfHtmlSnippet,
} from '../../src/report/finding-groups.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { HTML_REPORT_TEXT } from '../../src/presentation/messages.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, PAGE_2, PAGE_3, auditRun, dom, edgeCaseAuditRun, finding, idOf, page, record } from '../helpers/audit-run-fixture.js';
import { bundledFindingsOf } from '../helpers/bundle-findings.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const readAll = (result: AuditRunResult): ReadArtifactFile => async (path) => {
  if (path === RUN_ARTIFACT_FILE_NAMES.run) {
    return encoder.encode(JSON.stringify(result.run));
  }
  const value = result.pages.find((candidate) => path === pageArtifactRelativePath(candidate.pageId, 'page'));
  return value === undefined ? encoder.encode('x') : encoder.encode(JSON.stringify(value));
};

const target = (selector: string): readonly { readonly name: string; readonly value: string }[] => [{ name: 'target', value: JSON.stringify([selector]) }];

/**
 * 3 ページの見本。各ページに、同じ selector の region の指摘（WARN）、番号だけ違う selector のカードの指摘（INFO）、鍵のない指摘（ERROR）がある。
 */
function repeatedRun(): AuditRunResult {
  const pages: PageId[] = [PAGE_1, PAGE_2, PAGE_3];
  let sequence = 0;
  const findings: Finding[] = [];
  const doms = pages.map((pageId, index) => dom(index + 1, pageId, 'desktop', `page ${index}`));
  pages.forEach((pageId, index) => {
    const ref = [idOf(doms[index]!)];
    findings.push(finding((sequence += 1), 'INFO', 'ACCESSIBILITY', pageId, ref, {
      schemaVersion: 'finding-schema/1.1',
      ruleId: 'A11Y_LIST_CARD',
      groupingKeys: target(`li:nth-of-type(${index + 1}) > div.card`),
    }));
    findings.push(finding((sequence += 1), 'WARN', 'ACCESSIBILITY', pageId, ref, {
      schemaVersion: 'finding-schema/1.1',
      ruleId: 'A11Y_REGION',
      groupingKeys: target('div.banner'),
    }));
    findings.push(finding((sequence += 1), 'ERROR', 'LAYOUT', pageId, ref, {
      schemaVersion: 'finding-schema/1.1',
      ruleId: 'DOCUMENT_HORIZONTAL_OVERFLOW',
      groupingKeys: [],
    }));
  });
  return auditRun({
    pages: pages.map((pageId, index) => page(pageId, `/p${index}.html`, 'AUDITED', [doms[index]!], findings.filter((value) => value.pageId === pageId))),
    findings,
  });
}

/** axe の accessibility の Evidence（表示用モデルが読む `violations` の要素の selector と HTML の抜粋だけを持つ見本）。 */
const accessibility = (sequence: number, pageId: PageId, nodes: readonly { readonly selector: string; readonly html: string }[]) =>
  record('accessibility', sequence, pageId, 'desktop', {
    status: 'COMPLETE',
    scrollPosition: { scrollX: 0, scrollY: 0 },
    violations: [{
      ruleId: 'list-card',
      impact: 'minor',
      help: 'help',
      helpUrl: 'https://example.invalid/help',
      tags: [],
      nodes: nodes.map(({ selector, html }) => ({ impact: 'minor', targetSelectors: [selector], failureSummary: null, htmlSnippet: html, truncated: false })),
      omittedNodeCount: 0,
    }],
    incomplete: [],
  } as unknown as EvidencePayloadByType['accessibility']);

/**
 * AUD-9b の見直し（設計者の判断 2026-11-09）: 3 ページの見本。各ページに、番号だけ違う selector の同じ作りのカード（`<div class="card item">`）の指摘がある。
 * 1 ページ目には、丸めると同じ selector になるが作りの違う要素（`<section class="promo">`）の指摘もある。
 */
function structuredRun(): AuditRunResult {
  const pages: PageId[] = [PAGE_1, PAGE_2, PAGE_3];
  const promoSelector = 'li:nth-of-type(9) > div.card';
  const evidence = pages.map((pageId, index) => accessibility(index + 1, pageId, [
    { selector: `li:nth-of-type(${index + 1}) > div.card`, html: `<div class="card item" data-id="${index + 7}">商品 ${index + 7} の説明</div>` },
    ...(index === 0 ? [{ selector: promoSelector, html: '<section class="promo" data-x="secret">特集</section>' }] : []),
  ]));
  const findings: Finding[] = pages.map((pageId, index) => finding(index + 1, 'INFO', 'ACCESSIBILITY', pageId, [idOf(evidence[index]!)], {
    schemaVersion: 'finding-schema/1.1',
    ruleId: 'A11Y_LIST_CARD',
    groupingKeys: target(`li:nth-of-type(${index + 1}) > div.card`),
  }));
  findings.push(finding(4, 'INFO', 'ACCESSIBILITY', PAGE_1, [idOf(evidence[0]!)], {
    schemaVersion: 'finding-schema/1.1',
    ruleId: 'A11Y_LIST_CARD',
    groupingKeys: target(promoSelector),
  }));
  return auditRun({
    pages: pages.map((pageId, index) => page(pageId, `/p${index}.html`, 'AUDITED', [evidence[index]!], findings.filter((value) => value.pageId === pageId))),
    findings,
  });
}

describe('AUD-9b: rounding the selector numbers with the same structure of the element', () => {
  it('makes one group of the same cards on three pages, and another group of the element with a different structure', () => {
    const model = buildReportViewModel(structuredRun());
    const groups = model.findingGroups.filter((group) => group.ruleId === 'A11Y_LIST_CARD');

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      groupingKeys: target('li:nth-of-type(n) > div.card'),
      structure: { tagName: 'div', classNames: ['card', 'item'] },
      pageIds: [PAGE_1, PAGE_2, PAGE_3],
      occurrenceCount: 3,
    });
    expect(groups[1]).toMatchObject({
      groupingKeys: target('li:nth-of-type(n) > div.card'),
      structure: { tagName: 'section', classNames: ['promo'] },
      occurrenceCount: 1,
    });
    expect(groups[0]?.groupId).not.toBe(groups[1]?.groupId);
    // 作りの印には、文字の中身とほかの属性の値を入れない。
    const json = JSON.stringify(model.findingGroups);
    for (const value of ['商品', 'data-id', 'secret', '特集', '"7"']) {
      expect(json, value).not.toContain(value);
    }
  });

  it('reads the structure from the first opening tag of the snippet only', () => {
    expect(structureOfHtmlSnippet('<BUTTON class="a  b" title="x">押す</BUTTON>')).toEqual({ tagName: 'button', classNames: ['a', 'b'] });
    expect(structureOfHtmlSnippet("<img src='a.png' class='icon'>")).toEqual({ tagName: 'img', classNames: ['icon'] });
    expect(structureOfHtmlSnippet('<p>')).toEqual({ tagName: 'p', classNames: [] });
    expect(structureOfHtmlSnippet('text only')).toBeNull();
    expect(roundSelectorNumbers('ul:nth-child(2) > li:nth-of-type( 13 )')).toBe('ul:nth-child(n) > li:nth-of-type(n)');
  });
});

describe('AUD-9b: the candidate groups of the view model', () => {
  it('puts every Finding in exactly one group', () => {
    for (const result of [repeatedRun(), edgeCaseAuditRun(), auditRun()]) {
      const model = buildReportViewModel(result);
      const ids = model.findingGroups.flatMap((group) => group.findingIds);
      expect([...ids].sort()).toEqual(result.findings.map((value) => value.findingId).sort());
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('makes one group of the region Findings with the same selector on three pages, with the pages, the count and the viewports', () => {
    const model = buildReportViewModel(repeatedRun());
    const regions = model.findingGroups.filter((group) => group.ruleId === 'A11Y_REGION');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      ruleId: 'A11Y_REGION',
      groupingKeys: target('div.banner'),
      pageIds: [PAGE_1, PAGE_2, PAGE_3],
      pageCount: 3,
      occurrenceCount: 3,
      viewports: ['desktop'],
      verification: { basis: 'STATIC_CANDIDATE', byStatus: { STATIC_CANDIDATE: 3 } },
      missingEvidenceFindingCount: 0,
      confidence: 'MEDIUM',
    });
    expect(regions[0]?.findingIds).toHaveLength(3);
  });

  it('keeps the selectors that differ only by their number in different groups without the structure of the element, and makes a group of one for an empty key', () => {
    const model = buildReportViewModel(repeatedRun());
    // 作りの印（axe の htmlSnippet）が取れないので丸めない。番号だけ違う 3 つのカードは 3 つの群。
    const cards = model.findingGroups.filter((group) => group.ruleId === 'A11Y_LIST_CARD');
    expect(cards).toHaveLength(3);
    expect(cards.map((group) => group.structure)).toEqual([null, null, null]);
    const empties = model.findingGroups.filter((group) => group.ruleId === 'DOCUMENT_HORIZONTAL_OVERFLOW');
    expect(empties).toHaveLength(3);
    for (const group of empties) {
      expect(group.findingIds).toHaveLength(1);
      expect(group.groupingKeys).toEqual([]);
    }
    // 9 件の指摘が、7 つの群になる（region 1・カード 3・鍵なし 3）。
    expect(model.findings).toHaveLength(9);
    expect(model.findingGroups).toHaveLength(7);
  });

  it('gives a stable groupId from the key, whatever the order of the Findings', () => {
    const result = repeatedRun();
    const first = buildReportViewModel(result);
    const reversed = buildReportViewModel({ ...result, findings: [...result.findings].reverse() });
    const idOfRegion = (model: typeof first): string | undefined => model.findingGroups.find((group) => group.ruleId === 'A11Y_REGION')?.groupId;
    expect(idOfRegion(first)).toMatch(/^FG-[0-9a-f]{16}$/u);
    expect(idOfRegion(reversed)).toBe(idOfRegion(first));
    expect(new Set(first.findingGroups.map((group) => group.groupId)).size).toBe(first.findingGroups.length);
  });

  it('keeps the order of severity, not of the count or the confidence', () => {
    const model = buildReportViewModel(repeatedRun());
    // ERROR（鍵なし、1 件ずつ）が先、WARN（region、3 件）、INFO（カード）の順。数の多い群が上に来ない。
    expect(model.findingGroups.map((group) => group.severity)).toEqual(['ERROR', 'ERROR', 'ERROR', 'WARN', 'INFO', 'INFO', 'INFO']);
  });

  it('decides the confidence by the table of the bases, lowering it for a missing reference and for a lone static candidate', () => {
    expect(Object.keys(FINDING_GROUP_CONFIDENCE_BY_BASIS).sort()).toEqual([...RULE_VERIFICATION_BASES].sort());
    expect(findingGroupConfidenceOf('RENDERED', 1, false)).toBe('HIGH');
    expect(findingGroupConfidenceOf('NAVIGATION_OBSERVED', 5, false)).toBe('HIGH');
    expect(findingGroupConfidenceOf('RENDERED', 3, true)).toBe('MEDIUM');
    expect(findingGroupConfidenceOf('STATIC_CANDIDATE', 3, false)).toBe('MEDIUM');
    expect(findingGroupConfidenceOf('STATIC_CANDIDATE', 1, false)).toBe('LOW');
    expect(findingGroupConfidenceOf('STATIC_CANDIDATE', 3, true)).toBe('LOW');
    expect(findingGroupConfidenceOf('STATIC_CANDIDATE', 1, true)).toBe('LOW');
    const model = buildReportViewModel(repeatedRun(), { missingArtifactPaths: [pageArtifactRelativePath(PAGE_2, 'page')] });
    const overflow = model.findingGroups.find((group) => group.ruleId === 'DOCUMENT_HORIZONTAL_OVERFLOW' && group.pageIds[0] === PAGE_2);
    expect(overflow).toMatchObject({ missingEvidenceFindingCount: 1, confidence: 'MEDIUM', verification: { byStatus: { UNVERIFIED: 1 } } });
  });
});

// AUD-5（S-02・S-07）: 区分の鍵の付いた指摘は、区分のない指摘と別の群にし、群の確信度を 1 段下げる（重さは変えない）。
describe('AUD-5: the class keys of the findings', () => {
  it.each([
    ['ELEMENT_OVERLAP', 'INTENDED_PLACEMENT', [{ name: 'firstSelector', value: '#photo' }, { name: 'secondSelector', value: '#edit' }]],
    ['DUPLICATE_PAGE_TITLE', 'SAME_TEMPLATE', [{ name: 'sameTemplate', value: 'abc' }]],
  ] as const)('makes one lowered group of the %s findings of the class %s on three pages', (ruleId, findingClass, keys) => {
    const pages: PageId[] = [PAGE_1, PAGE_2, PAGE_3];
    const doms = pages.map((pageId, index) => dom(index + 1, pageId, 'desktop', `page ${index}`));
    const findings = pages.flatMap((pageId, index) => [true, false].map((classed, offset) => finding(index * 2 + offset + 1, 'WARN', 'LAYOUT', pageId, [idOf(doms[index]!)], {
      schemaVersion: 'finding-schema/1.1',
      ruleId,
      groupingKeys: [...keys, ...(classed ? [{ name: 'findingClass', value: findingClass }] : [])],
    })));
    const model = buildReportViewModel(auditRun({
      pages: pages.map((pageId, index) => page(pageId, `/p${index}.html`, 'AUDITED', [doms[index]!], findings.filter((value) => value.pageId === pageId))),
      findings,
    }));
    const groups = model.findingGroups.filter((group) => group.ruleId === ruleId);
    const classed = groups.find((group) => group.groupingKeys.some(({ name }) => name === 'findingClass'));
    const plain = groups.find((group) => !group.groupingKeys.some(({ name }) => name === 'findingClass'));
    expect(groups).toHaveLength(2);
    expect(classed?.occurrenceCount).toBe(3);
    expect(FINDING_GROUP_CONFIDENCES.indexOf(classed!.confidence)).toBe(FINDING_GROUP_CONFIDENCES.indexOf(plain!.confidence) + 1);
  });
});

// DEF-297: axe の指摘は、対象の selector（番号と描画の順の id を丸めた形）で群にする。名前の不一致は selector と区分の両方で群にする。fingerprint は変えない。
describe('DEF-297: the groups of the axe findings across the pages', () => {
  const axeNode = (selector: string, html: string, label?: { readonly axName: string; readonly segments: readonly string[] }) => ({
    impact: 'serious', targetSelectors: [selector], failureSummary: null, htmlSnippet: html, truncated: false,
    ...(label === undefined ? {} : {
      nameContext: { status: 'READ', axName: label.axName, axRole: 'link', axDisabled: false, nameSource: { type: 'contents' }, labelSegments: label.segments },
    }),
  });
  const violation = (ruleId: string, nodes: readonly unknown[]) => ({ ruleId, impact: 'serious', help: 'h', helpUrl: 'https://rules.test/x', tags: [], omittedNodeCount: 0, nodes });
  const pages: PageId[] = [PAGE_1, PAGE_2, PAGE_3];
  const missing = { axName: 'home-icon', segments: ['ホーム'] };
  const runOf = (): AuditRunResult => {
    const evaluated = pages.map((pageId, index) => {
      const axe = record('accessibility', 30 + index, pageId, 'desktop', {
        status: 'COMPLETE', frameScope: 'SAME_ORIGIN_ONLY', scrollPosition: { scrollX: 0, scrollY: 0 },
        violations: [
          violation('color-contrast', [
            // 共通の枠の同じ部品（属性の値の selector）と、描画の順の id だけ違う同じ部品。1 ページ目だけの違う部品。
            axeNode('a[href="/home"]', '<a class="home">'),
            axeNode(`#\\:r${String(index + 1)}\\: > span`, '<span class="badge">'),
            ...(index === 0 ? [axeNode('button[aria-label="close"]', '<button class="close">')] : []),
          ]),
          violation('label-content-name-mismatch', [
            // 同じ部品で区分が違う（1・2 ページ目。2 ページ目は名前の文脈を読めない）。区分が同じで違う部品（1・3 ページ目）。
            index === 2 ? axeNode('footer > a[href="/help"]', '<a class="help">', missing) : axeNode('nav > a[href="/news"]', '<a class="news">', index === 0 ? missing : undefined),
          ]),
        ],
        incomplete: [],
      } as never);
      const { findings } = new RuleEngine({ targetId: 'def297', firstFindingSequence: index * 100 + 1, catalog: ACCESSIBILITY_RULES })
        .evaluate({ pageId, pageUrl: page(pageId, `/p${String(index)}.html`).pageUrl, viewport: 'desktop', evidence: [axe] });
      return { axe, findings };
    });
    return auditRun({
      pages: pages.map((pageId, index) => page(pageId, `/p${String(index)}.html`, 'AUDITED', [evaluated[index]!.axe], evaluated[index]!.findings)),
      findings: evaluated.flatMap(({ findings }) => findings),
    });
  };
  const groupsOf = (model: ReturnType<typeof buildReportViewModel>, ruleId: string, selector: string) => model.findingGroups.filter((group) => group.ruleId === ruleId
    && group.findingIds.some((id) => model.findings.find(({ finding }) => finding.findingId === id)?.finding.message.includes(selector)));

  it('makes one group of the same common part on three pages, also when only the render-order id differs, and separate groups of different parts', () => {
    const model = buildReportViewModel(runOf());
    expect(groupsOf(model, 'COLOR_CONTRAST_VIOLATION', 'a[href="/home"]').map((group) => group.pageCount)).toEqual([3]);
    expect(groupsOf(model, 'COLOR_CONTRAST_VIOLATION', ' > span').map((group) => group.pageCount)).toEqual([3]);
    expect(groupsOf(model, 'COLOR_CONTRAST_VIOLATION', 'close').map((group) => group.pageCount)).toEqual([1]);
    expect(model.findingGroups.filter((group) => group.ruleId === 'COLOR_CONTRAST_VIOLATION')).toHaveLength(3);
  });

  it('groups the label-in-name findings by both the part and the class', () => {
    const model = buildReportViewModel(runOf());
    expect(groupsOf(model, 'A11Y_LABEL_CONTENT_NAME_MISMATCH', '/news').map((group) => group.occurrenceCount)).toEqual([1, 1]);
    expect(groupsOf(model, 'A11Y_LABEL_CONTENT_NAME_MISMATCH', '/help').map((group) => group.occurrenceCount)).toEqual([1]);
    expect(model.findingGroups.filter((group) => group.ruleId === 'A11Y_LABEL_CONTENT_NAME_MISMATCH')).toHaveLength(3);
  });

  it('changes the group count of findings-by-rule.json in the bundle, and keeps the fingerprints', async () => {
    const result = runOf();
    // 今の Run と同じ fingerprint（群の鍵を足す前の Rule Engine で求めた値）。
    expect(result.findings.filter(({ pageId }) => pageId === PAGE_1).map(({ fingerprint }) => fingerprint)).toEqual([
      'sha256:b89c0627717ad9972fd2e2428b83487c8b2b6d4d3f00b37162bc498174d571c6',
      'sha256:2caead86ddf43de512db0174cd560574c7137e5a5cde7a0b4fc3769a0c4e9ceb',
      'sha256:364d6478ee4b41ca1a1859ab6b9b6500b43744b1a14b5a7701da1767276603ec',
      'sha256:cc2a576052cb9d0f9bf29cddb05d40cbdc8b2c25594ec51fc7e44ab442799ec2',
    ]);
    const entries = unzipSync(await createChatGptBundle(buildReportViewModel(result), result, readAll(result)));
    const byRule = JSON.parse(decoder.decode(entries[CHATGPT_BUNDLE_FILE_NAMES.findingsByRule])) as {
      readonly main: readonly { readonly ruleId: string; readonly groupCount: number }[];
    };
    expect(byRule.main.find((digest) => digest.ruleId === 'COLOR_CONTRAST_VIOLATION')?.groupCount).toBe(3);
  });
});

describe('AUD-9c: the groups in the bundle', () => {
  // REC-4: finding-groups.json は、表示用モデルの群から指摘の ID の一覧を除いたもの。指摘は、指摘ごとの `groupId` で群に結び付く。
  it('puts finding-groups.json as the copy of the view model without the Finding IDs, the group of each Finding, and the groups of each Rule in findings-by-rule.json', async () => {
    const result = repeatedRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await createChatGptBundle(model, result, readAll(result)));

    expect(JSON.parse(decoder.decode(entries[CHATGPT_BUNDLE_FILE_NAMES.findingGroups])))
      .toEqual(JSON.parse(JSON.stringify(model.findingGroups.map(({ findingIds: _findingIds, ...group }) => group))));
    const groupOf = new Map(bundledFindingsOf<{ readonly finding: { readonly findingId: string }; readonly groupId: string | null }>(entries)
      .map((entry) => [entry.finding.findingId, entry.groupId]));
    for (const group of model.findingGroups) {
      for (const findingId of group.findingIds.filter((id) => groupOf.has(id))) {
        expect(groupOf.get(findingId), findingId).toBe(group.groupId);
      }
    }
    const byRule = JSON.parse(decoder.decode(entries[CHATGPT_BUNDLE_FILE_NAMES.findingsByRule])) as {
      readonly main: readonly { readonly ruleId: string; readonly groupCount: number; readonly groupIds: readonly string[] }[];
    };
    const cards = byRule.main.find((digest) => digest.ruleId === 'A11Y_LIST_CARD');
    expect(cards?.groupCount).toBe(3);
    expect(cards?.groupIds).toEqual(model.findingGroups.filter((group) => group.ruleId === 'A11Y_LIST_CARD').map((group) => group.groupId));
    expect(model.mainRuleDigests.find((digest) => digest.ruleId === 'A11Y_REGION')?.groupIds).toHaveLength(1);
    expect(decoder.decode(entries[CHATGPT_BUNDLE_FILE_NAMES.readme])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.findingGroupsNote(`\`${CHATGPT_BUNDLE_FILE_NAMES.findingGroups}\``));
  });
});

describe('AUD-9c: the plain count of the groups in the overview of the HTML', () => {
  it('tells the number of the places of the same structure, counting the site quality groups of the view model', () => {
    const model = buildReportViewModel(structuredRun());
    // 4 件の問題が、同じ作りの所でまとめると 2 か所。
    expect(model.overview.problemCount).toBe(4);
    expect(model.overview.problemGroupCount).toBe(2);
    expect(renderHtmlReport(model)).toContain(HTML_REPORT_TEXT.overview.problemGroups('2'));
  });

  it('does not tell it when there is no problem', () => {
    const base = auditRun();
    const model = buildReportViewModel({ ...base, findings: [] });
    expect(model.overview.problemGroupCount).toBe(0);
    expect(renderHtmlReport(model)).not.toContain(HTML_REPORT_TEXT.overview.problemGroups('0'));
  });
});

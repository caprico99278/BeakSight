import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_TYPES,
  FINDING_CATEGORIES,
  INTERACTION_STATUSES,
  PAGE_AUDIT_STATUSES,
  RUN_STATUSES,
  SEVERITIES,
  VIEWPORT_PROFILES,
} from '../../src/core/contracts.js';
import {
  EXTERNAL_SCHEME_NAVIGATION_REASONS,
  INTERACTION_NOT_VERIFIABLE_KINDS,
  SCREENSHOT_CAPTURE_TYPES,
} from '../../src/core/evidence-types.js';
import {
  DISPLAY_TONES,
  EVIDENCE_TYPE_CATALOG,
  FINDING_CATEGORY_CATALOG,
  INTERACTION_NOT_VERIFIABLE_KIND_CATALOG,
  INTERACTION_STATUS_CATALOG,
  PAGE_AUDIT_STATUS_CATALOG,
  REPORT_CATEGORY_SECTION_CATALOG,
  REPORT_CATEGORY_SECTIONS,
  REPORT_SECTION_CATALOG,
  REPORT_SECTIONS,
  RUN_STATUS_CATALOG,
  SAFETY_EVENT_KIND_CATALOG,
  SCREENSHOT_CAPTURE_TYPE_CATALOG,
  SEVERITY_CATALOG,
  SEVERITY_GROUP_CATALOG,
  SEVERITY_GROUPS,
  VIEWPORT_PROFILE_CATALOG,
  findingCategoriesInSection,
  severitiesInGroup,
  sortByDisplayOrder,
  type DisplaySpec,
  type SafetyEventKind,
  type SeveritySpec,
} from '../../src/presentation/catalog.js';
import { safetyEventListNames } from '../helpers/audit-run-fixture.js';

/** ひらがな・カタカナ・漢字のどれかを含むか（日本語のラベルであることの近似）。 */
const JAPANESE_CHARACTER = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
/** アンカーに使ってよい文字だけか。 */
const SAFE_ANCHOR = /^[a-z][a-z0-9-]*$/u;

const DISPLAY_CATALOGS: readonly {
  readonly name: string;
  readonly values: readonly string[];
  readonly catalog: Readonly<Record<string, DisplaySpec>>;
}[] = [
  { name: 'SEVERITY_CATALOG', values: SEVERITIES, catalog: SEVERITY_CATALOG },
  { name: 'SEVERITY_GROUP_CATALOG', values: SEVERITY_GROUPS, catalog: SEVERITY_GROUP_CATALOG },
  { name: 'RUN_STATUS_CATALOG', values: RUN_STATUSES, catalog: RUN_STATUS_CATALOG },
  { name: 'PAGE_AUDIT_STATUS_CATALOG', values: PAGE_AUDIT_STATUSES, catalog: PAGE_AUDIT_STATUS_CATALOG },
  { name: 'INTERACTION_STATUS_CATALOG', values: INTERACTION_STATUSES, catalog: INTERACTION_STATUS_CATALOG },
  {
    name: 'INTERACTION_NOT_VERIFIABLE_KIND_CATALOG',
    values: INTERACTION_NOT_VERIFIABLE_KINDS,
    catalog: INTERACTION_NOT_VERIFIABLE_KIND_CATALOG,
  },
  { name: 'FINDING_CATEGORY_CATALOG', values: FINDING_CATEGORIES, catalog: FINDING_CATEGORY_CATALOG },
  { name: 'EVIDENCE_TYPE_CATALOG', values: EVIDENCE_TYPES, catalog: EVIDENCE_TYPE_CATALOG },
  { name: 'VIEWPORT_PROFILE_CATALOG', values: VIEWPORT_PROFILES, catalog: VIEWPORT_PROFILE_CATALOG },
  { name: 'SCREENSHOT_CAPTURE_TYPE_CATALOG', values: SCREENSHOT_CAPTURE_TYPES, catalog: SCREENSHOT_CAPTURE_TYPE_CATALOG },
  // C16d（設計書 6.1.10）: 値の一覧は、実際の Safety の Evidence の、事象の一覧の項目の名前。
  { name: 'SAFETY_EVENT_KIND_CATALOG', values: safetyEventListNames(), catalog: SAFETY_EVENT_KIND_CATALOG },
];

describe('display catalogs', () => {
  it.each(DISPLAY_CATALOGS)('$name has exactly one entry for every value of the core list', ({ values, catalog }) => {
    expect(Object.keys(catalog).sort()).toEqual([...values].sort());
  });

  it.each(DISPLAY_CATALOGS)('$name gives a Japanese label, a unique order and a known tone', ({ values, catalog }) => {
    const orders = values.map((value) => catalog[value]?.order);
    expect(new Set(orders).size).toBe(values.length);
    for (const value of values) {
      const spec = catalog[value];
      expect(spec, value).toBeDefined();
      expect(spec?.label.trim().length, value).toBeGreaterThan(0);
      // 日本語か、表記の定まった技術用語（`DOM`、`HTTP`、`JavaScript`）。
      expect(JAPANESE_CHARACTER.test(spec?.label ?? '') || /^[A-Za-z]{2,}$/u.test(spec?.label ?? ''), value).toBe(true);
      expect(Number.isSafeInteger(spec?.order), value).toBe(true);
      expect(DISPLAY_TONES, value).toContain(spec?.tone);
      expect(spec?.description === null || (spec?.description.trim().length ?? 0) > 0, value).toBe(true);
    }
  });

  it.each(DISPLAY_CATALOGS)('$name is frozen', ({ catalog }) => {
    expect(Object.isFrozen(catalog)).toBe(true);
    for (const spec of Object.values(catalog)) {
      expect(Object.isFrozen(spec)).toBe(true);
    }
  });

  it('describes every severity and status value', () => {
    for (const catalog of [SEVERITY_CATALOG, RUN_STATUS_CATALOG, PAGE_AUDIT_STATUS_CATALOG, INTERACTION_STATUS_CATALOG]) {
      for (const spec of Object.values<DisplaySpec>(catalog)) {
        expect(spec.description).not.toBeNull();
      }
    }
  });

  it('separates site-quality severities from the safety severity', () => {
    expect(SEVERITY_CATALOG.ERROR.group).toBe('SITE_QUALITY');
    expect(SEVERITY_CATALOG.WARN.group).toBe('SITE_QUALITY');
    expect(SEVERITY_CATALOG.INFO.group).toBe('SITE_QUALITY');
    expect(SEVERITY_CATALOG.SAFETY.group).toBe('SAFETY');
    expect(sortByDisplayOrder(SEVERITIES, SEVERITY_CATALOG)).toEqual(['ERROR', 'WARN', 'INFO', 'SAFETY']);
  });

  it('marks only ERROR for the section of critical Findings, with an explicit attribute (design 6.1.8)', () => {
    expect(SEVERITIES.filter((severity) => SEVERITY_CATALOG[severity].criticalSection)).toEqual(['ERROR']);
    for (const severity of SEVERITIES) {
      expect(typeof SEVERITY_CATALOG[severity].criticalSection, severity).toBe('boolean');
    }
  });

  it('makes a severity spec without criticalSection a type error', () => {
    const complete = {
      label: 'x',
      order: 1,
      tone: 'critical',
      description: null,
      group: 'SITE_QUALITY',
      criticalSection: true,
    } as const satisfies SeveritySpec;
    // @ts-expect-error -- criticalSection を書き漏らしたカタログの値は、型のエラーになる。
    const missing = { label: 'x', order: 1, tone: 'critical', description: null, group: 'SITE_QUALITY' } as const satisfies SeveritySpec;
    expect(complete.criticalSection).toBe(true);
    expect(missing.group).toBe('SITE_QUALITY');
  });

  it('does not rely on colour alone: distinct severities have distinct labels', () => {
    const labels = SEVERITIES.map((severity) => SEVERITY_CATALOG[severity].label);
    expect(new Set(labels).size).toBe(SEVERITIES.length);
  });
});

describe('the kinds of Safety events (design 6.1.10)', () => {
  /** 型の上の、すべての記録の種類（`SafetyEventsEvidence` の事象の一覧の項目。書き漏れと余分は、型のエラーになる）。 */
  const ALL_KINDS = {
    blockedRequests: true,
    blockedNavigations: true,
    blockedWebSockets: true,
    blockedExternalActions: true,
    excludedInteractionCandidates: true,
    blockedInteractionRequests: true,
    blockedInteractionNavigations: true,
    blockedPopups: true,
    blockedDownloads: true,
    blockedInteractionWebSockets: true,
    externalSchemeNavigations: true,
  } as const satisfies Record<SafetyEventKind, true>;

  it('has a Japanese label for every kind of record of SafetyEventsEvidence, and no other key', () => {
    expect(Object.keys(ALL_KINDS)).toEqual(safetyEventListNames());
    expect(Object.keys(SAFETY_EVENT_KIND_CATALOG).sort()).toEqual([...safetyEventListNames()].sort());
    for (const kind of safetyEventListNames()) {
      const spec = (SAFETY_EVENT_KIND_CATALOG as Readonly<Record<string, DisplaySpec>>)[kind];
      expect(spec?.label, kind).toMatch(JAPANESE_CHARACTER);
    }
    const labels = Object.values<DisplaySpec>(SAFETY_EVENT_KIND_CATALOG).map((spec) => spec.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('orders the kinds as the items of SafetyEventsEvidence', () => {
    expect(sortByDisplayOrder(Object.keys(ALL_KINDS) as SafetyEventKind[], SAFETY_EVENT_KIND_CATALOG)).toEqual(safetyEventListNames());
  });

  it('makes a catalog without a kind a type error', () => {
    const spec = { label: 'x', order: 1, tone: 'shield', description: null } as const satisfies DisplaySpec;
    // @ts-expect-error -- 記録の種類を書き漏らしたカタログは、型のエラーになる。
    const missing = { blockedRequests: spec } as const satisfies Record<SafetyEventKind, DisplaySpec>;
    // @ts-expect-error -- 事象の一覧ではない項目（`recordLimits`）は、記録の種類ではない。
    const notAKind: SafetyEventKind = 'recordLimits';
    expect(missing.blockedRequests.label).toBe('x');
    expect(notAKind).toBe('recordLimits');
  });

  // C18g: 外部スキームへの移動の記録には、止められない試み（`EXTERNAL_SCHEME_NAVIGATION`）と、Guard が止めたサーバのリダイレクト
  // （`EXTERNAL_SCHEME_REDIRECT_BLOCKED`）がある。レポートは事象の理由のコードをそのまま表示するので、説明で両方の意味を示す。
  it('describes both reasons of the external scheme navigation records, including the stopped server redirect', () => {
    const { description } = SAFETY_EVENT_KIND_CATALOG.externalSchemeNavigations;
    for (const reason of EXTERNAL_SCHEME_NAVIGATION_REASONS) {
      expect(description).toContain(reason);
    }
    expect(description).toContain('リダイレクト');
    expect(description).toContain('止め');
  });
});

describe('report sections', () => {
  it('lists the report sections in the order of the design (6.1.4)', () => {
    expect(sortByDisplayOrder(REPORT_SECTIONS, REPORT_SECTION_CATALOG)).toEqual([
      'SUMMARY',
      'CRITICAL_FINDINGS',
      'CATEGORY_FINDINGS',
      'INTERACTIONS',
      'SAFETY',
      'PAGES',
    ]);
  });

  it('gives every report section and category section a Japanese label and a safe, unique anchor', () => {
    const anchors: string[] = [];
    for (const [values, catalog] of [
      [REPORT_SECTIONS, REPORT_SECTION_CATALOG],
      [REPORT_CATEGORY_SECTIONS, REPORT_CATEGORY_SECTION_CATALOG],
    ] as const) {
      expect(Object.keys(catalog).sort()).toEqual([...values].sort());
      const orders = new Set<number>();
      for (const value of values) {
        const spec = (catalog as Readonly<Record<string, { label: string; order: number; anchor: string }>>)[value];
        expect(JAPANESE_CHARACTER.test(spec?.label ?? '') || /^[A-Za-z]{2,}$/u.test(spec?.label ?? ''), value).toBe(true);
        expect(spec?.anchor, value).toMatch(SAFE_ANCHOR);
        orders.add(spec?.order ?? Number.NaN);
        anchors.push(spec?.anchor ?? '');
      }
      expect(orders.size).toBe(values.length);
    }
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('maps the finding categories to the category sections in one place (HTTP and RESOURCE are the network section)', () => {
    expect(FINDING_CATEGORY_CATALOG.HTTP.section).toBe('NETWORK');
    expect(FINDING_CATEGORY_CATALOG.RESOURCE.section).toBe('NETWORK');
    expect(FINDING_CATEGORY_CATALOG.JAVASCRIPT.section).toBe('JAVASCRIPT');
    expect(FINDING_CATEGORY_CATALOG.LINK.section).toBe('LINKS');
    expect(REPORT_CATEGORY_SECTION_CATALOG.NETWORK.label).toBe('ネットワーク');
    expect(REPORT_CATEGORY_SECTION_CATALOG.LINKS.label).toBe('リンク');
    expect(findingCategoriesInSection('NETWORK')).toEqual(['HTTP', 'RESOURCE']);
  });

  it('puts every finding category into exactly one section and leaves no section empty', () => {
    const covered = REPORT_CATEGORY_SECTIONS.flatMap((section) => findingCategoriesInSection(section));
    expect([...covered].sort()).toEqual([...FINDING_CATEGORIES].sort());
    for (const section of REPORT_CATEGORY_SECTIONS) {
      expect(findingCategoriesInSection(section).length, section).toBeGreaterThan(0);
    }
  });
});

// C17a: severity の区分に入る severity を、表示の順に返す補助（表示用モデルと CLI の、区分での絞り込みの唯一の場所）。
describe('severitiesInGroup', () => {
  it('returns the severities of each group, in the display order', () => {
    expect(severitiesInGroup('SITE_QUALITY')).toEqual(['ERROR', 'WARN', 'INFO']);
    expect(severitiesInGroup('SAFETY')).toEqual(['SAFETY']);
    for (const group of SEVERITY_GROUPS) {
      const severities = severitiesInGroup(group);
      expect(severities, group).toEqual(sortByDisplayOrder(severities, SEVERITY_CATALOG));
      for (const severity of severities) {
        expect(SEVERITY_CATALOG[severity].group, `${group}: ${severity}`).toBe(group);
      }
    }
  });

  it('puts every severity in exactly one group', () => {
    const covered = SEVERITY_GROUPS.flatMap((group) => severitiesInGroup(group));
    expect([...covered].sort()).toEqual([...SEVERITIES].sort());
  });

  it('returns a new array on each call', () => {
    const first = severitiesInGroup('SITE_QUALITY');
    expect(severitiesInGroup('SITE_QUALITY')).not.toBe(first);
  });
});

describe('sortByDisplayOrder', () => {
  it('sorts the given values by the catalog order without changing the input', () => {
    const input = ['SAFETY', 'INFO', 'ERROR', 'WARN', 'ERROR'] as const;
    expect(sortByDisplayOrder(input, SEVERITY_CATALOG)).toEqual(['ERROR', 'ERROR', 'WARN', 'INFO', 'SAFETY']);
    expect(input).toEqual(['SAFETY', 'INFO', 'ERROR', 'WARN', 'ERROR']);
  });
});

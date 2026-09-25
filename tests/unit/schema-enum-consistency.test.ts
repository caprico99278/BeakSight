// スキーマ（`schemas/*.schema.json`）の enum と、`src/core/` の `as const` の凍結した配列が一致することを、
// 1か所でまとめて確かめる（F12）。値の一覧の owner は core の配列で、TypeScript の型はその配列から導く。
// スキーマの enum を増やしたら、下の対応表に、その JSON Pointer と core の配列の名前を加える。
// 対応表にない enum がスキーマにあれば、このテストが失敗する。
// 速さの要件（設計書 UI追補 第6章 6.2 と同じ考え方）: スキーマのファイルの一覧の取得と読み込みは `beforeAll` で1回だけ行い、
// 各検査で共有する。ファイル全体を1秒以内に終える。
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as contracts from '../../src/core/contracts.js';
import * as evidenceTypes from '../../src/core/evidence-types.js';
import { createEvidenceId } from '../../src/core/ids.js';

type SchemaName = 'audit' | 'finding' | 'page' | 'run';

interface EnumMapping {
  readonly schema: SchemaName;
  /** enum の配列そのものを指す JSON Pointer（RFC 6901）。 */
  readonly pointer: string;
  /** `src/core/contracts.ts` か `src/core/evidence-types.ts` が公開する、値の一覧の配列の名前。 */
  readonly coreArray: string;
  /** スキーマの enum が、配列の値の後に `null` を加えたものか。 */
  readonly nullable: boolean;
}

const mapping = (schema: SchemaName, pointer: string, coreArray: string, nullable = false): EnumMapping =>
  Object.freeze({ schema, pointer, coreArray, nullable });

const NULLABLE = true;

/** スキーマの enum と、core の配列の対応表。 */
const ENUM_MAPPINGS: readonly EnumMapping[] = Object.freeze([
  // finding.schema.json
  mapping('finding', '/properties/category/enum', 'FINDING_CATEGORIES'),
  mapping('finding', '/properties/severity/enum', 'SEVERITIES'),
  mapping('finding', '/properties/viewport/enum', 'VIEWPORT_PROFILES', NULLABLE),
  // run.schema.json
  mapping('run', '/properties/runStatus/enum', 'RUN_STATUSES'),
  mapping('run', '/$defs/incompleteReason/properties/code/enum', 'INCOMPLETE_REASON_CODES'),
  // R15a（Task 14〜17 の設計書 5.6.4、5.6.5）: 再試行の記録の、最初の試行のナビゲーションの結果の種類。
  mapping('run', '/properties/retries/items/properties/navigationOutcome/enum', 'NAVIGATION_OUTCOME_KINDS'),
  // page.schema.json: ページとビューポート
  mapping('page', '/properties/status/enum', 'PAGE_AUDIT_STATUSES'),
  mapping('page', '/$defs/viewportAuditResult/properties/status/enum', 'PAGE_AUDIT_STATUSES'),
  // P14a（Task 14〜17 の設計書 4.3.0）: ナビゲーションの結果の種類。スキップしたビューポートでは null。
  mapping('page', '/$defs/viewportAuditResult/properties/navigationOutcome/enum', 'NAVIGATION_OUTCOME_KINDS', NULLABLE),
  // page.schema.json: Evidence の記録
  mapping('page', '/$defs/evidence/properties/type/enum', 'EVIDENCE_TYPES'),
  mapping('page', '/$defs/evidence/properties/viewport/enum', 'VIEWPORT_PROFILES', NULLABLE),
  // page.schema.json: Console
  mapping('page', '/$defs/consoleEvidence/properties/consoleMessages/items/properties/type/enum', 'CONSOLE_MESSAGE_TYPES'),
  // page.schema.json: Link
  mapping('page', '/$defs/urlRejectionReason/enum', 'URL_REJECTION_REASONS'),
  // page.schema.json: DOM
  mapping('page', '/$defs/domEvidence/properties/visibleText/properties/source/enum', 'VISIBLE_TEXT_SOURCES'),
  mapping(
    'page',
    '/$defs/domEvidence/properties/visibleText/properties/regions/items/properties/kind/enum',
    'SEMANTIC_REGION_KINDS',
  ),
  mapping(
    'page',
    '/$defs/domEvidence/properties/forms/items/properties/submitControls/items/properties/type/enum',
    'SUBMIT_CONTROL_TYPES',
  ),
  // page.schema.json: Layout
  mapping('page', '/$defs/layoutElement/properties/kind/enum', 'LAYOUT_ELEMENT_KINDS'),
  mapping('page', '/$defs/layoutEvidence/properties/boxesOutsideViewport/items/properties/kind/enum', 'LAYOUT_ELEMENT_KINDS'),
  mapping(
    'page',
    '/$defs/layoutEvidence/properties/boxesOutsideViewport/items/properties/horizontalClipAncestor/enum',
    'HORIZONTAL_CLIP_ANCESTOR_KINDS',
  ),
  mapping(
    'page',
    '/$defs/layoutEvidence/properties/document/properties/viewportHorizontalClip/enum',
    'HORIZONTAL_CLIP_ANCESTOR_KINDS',
  ),
  mapping(
    'page',
    '/$defs/layoutEvidence/properties/fixedHeadingOverlaps/items/properties/overlayPosition/enum',
    'FIXED_ELEMENT_POSITIONS',
  ),
  mapping('page', '/$defs/layoutEvidence/properties/fixedElements/items/properties/kind/enum', 'LAYOUT_ELEMENT_KINDS'),
  mapping(
    'page',
    '/$defs/layoutEvidence/properties/fixedElements/items/properties/position/enum',
    'FIXED_ELEMENT_POSITIONS',
  ),
  mapping('page', '/$defs/layoutCollectionResult/oneOf/1/properties/reason/enum', 'LAYOUT_INCOMPLETE_REASONS'),
  mapping('page', '/$defs/stressLayoutEvidence/oneOf/1/properties/reason/enum', 'LAYOUT_INCOMPLETE_REASONS'),
  mapping('page', '/$defs/stressLayoutEvidence/oneOf/2/properties/stage/enum', 'STRESS_LAYOUT_FAILURE_STAGES'),
  mapping('page', '/$defs/stressLayoutEvidence/oneOf/2/properties/reason/enum', 'STRESS_LAYOUT_FAILURE_REASONS'),
  // page.schema.json: Color
  mapping(
    'page',
    '/$defs/colorEvidence/properties/textSamples/items/properties/background/oneOf/1/properties/reason/enum',
    'COLOR_UNAVAILABLE_REASONS',
  ),
  mapping(
    'page',
    '/$defs/colorEvidence/properties/textSamples/items/properties/contrast/oneOf/1/properties/reason/enum',
    'COLOR_UNAVAILABLE_REASONS',
  ),
  // page.schema.json: Performance
  mapping('page', '/$defs/inpAttribution/properties/interactionType/enum', 'INP_INTERACTION_TYPES'),
  ...(['CLS', 'FCP', 'INP', 'LCP', 'TTFB'] as const).flatMap((metric) => [
    mapping(
      'page',
      `/$defs/webVitals/properties/${metric}/oneOf/0/properties/navigationType/anyOf/1/enum`,
      'WEB_VITAL_NAVIGATION_TYPES',
    ),
    mapping('page', `/$defs/webVitals/properties/${metric}/oneOf/1/properties/status/enum`, 'UNOBSERVED_WEB_VITAL_STATUSES'),
  ]),
  mapping('page', '/$defs/serverTiming/properties/source/enum', 'SERVER_TIMING_SOURCES'),
  ...(['0', '1'] as const).flatMap((branch) => [
    mapping('page', `/$defs/resourceTiming/oneOf/${branch}/properties/category/anyOf/1/enum`, 'RESOURCE_CATEGORIES'),
    mapping('page', `/$defs/resourceTiming/oneOf/${branch}/properties/categoryBasis/enum`, 'RESOURCE_CATEGORY_BASES'),
    mapping(
      'page',
      `/$defs/performanceEvidence/oneOf/${branch}/properties/telemetryHeaders/items/oneOf/0/properties/direction/enum`,
      'TELEMETRY_HEADER_DIRECTIONS',
    ),
    mapping(
      'page',
      `/$defs/performanceEvidence/oneOf/${branch}/properties/telemetryHeaders/items/oneOf/1/properties/direction/enum`,
      'TELEMETRY_HEADER_DIRECTIONS',
    ),
    mapping(
      'page',
      `/$defs/performanceEvidence/oneOf/${branch}/properties/telemetryCandidates/items/properties/matchingBasis/items/enum`,
      'TELEMETRY_MATCHING_BASES',
    ),
  ]),
  mapping('page', '/$defs/performanceEvidence/oneOf/1/properties/reason/enum', 'PERFORMANCE_INCOMPLETE_REASONS'),
  // page.schema.json: Accessibility
  mapping('page', '/$defs/accessibilityRule/properties/impact/enum', 'ACCESSIBILITY_IMPACTS', NULLABLE),
  mapping('page', '/$defs/accessibilityRule/properties/nodes/items/properties/impact/enum', 'ACCESSIBILITY_IMPACTS', NULLABLE),
  mapping('page', '/$defs/accessibilityEvidence/oneOf/1/properties/reason/enum', 'ACCESSIBILITY_INCOMPLETE_REASONS'),
  // page.schema.json: Interaction
  mapping('page', '/$defs/interactionCandidate/properties/hrefKind/enum', 'INTERACTION_HREF_KINDS'),
  mapping('page', '/$defs/interactionChange/properties/identityStatus/enum', 'INTERACTION_IDENTITY_STATUSES'),
  mapping('page', '/$defs/interactionEvidence/properties/status/enum', 'INTERACTION_STATUSES'),
  mapping('page', '/$defs/interactionEvidence/properties/work/properties/status/enum', 'INTERACTION_STATUSES'),
  // I15a（Task 14〜17 の設計書 5.4.1）: NOT_VERIFIABLE の区分。NOT_VERIFIABLE 以外の状態では null。
  mapping('page', '/$defs/interactionEvidence/properties/notVerifiableKind/enum', 'INTERACTION_NOT_VERIFIABLE_KINDS', NULLABLE),
  // C18n（Task 19 の前の整理の設計書 5.1）: Interaction の理由のコード（Evidence と work の reason）と、status ごとのコード、
  // lifecycle の理由のコード。理由がない lifecycle では null。
  mapping('page', '/$defs/interactionReasonCode/enum', 'INTERACTION_REASON_CODES'),
  mapping('page', '/$defs/interactionStatusReason/allOf/0/then/properties/reason/enum', 'INTERACTION_VERIFIED_REASON_CODES'),
  mapping('page', '/$defs/interactionStatusReason/allOf/1/then/properties/reason/enum', 'INTERACTION_REJECTION_REASONS'),
  mapping(
    'page',
    '/$defs/interactionStatusReason/allOf/2/then/properties/reason/enum',
    'INTERACTION_BLOCKED_BY_SAFETY_REASON_CODES',
  ),
  mapping(
    'page',
    '/$defs/interactionStatusReason/allOf/3/then/properties/reason/enum',
    'INTERACTION_NOT_VERIFIABLE_REASON_CODES',
  ),
  mapping(
    'page',
    '/$defs/interactionStatusReason/allOf/4/then/properties/reason/enum',
    'INTERACTION_EXECUTION_FAILED_REASON_CODES',
  ),
  mapping(
    'page',
    '/$defs/interactionEvidence/properties/lifecycle/properties/reason/enum',
    'INTERACTION_LIFECYCLE_REASON_CODES',
    NULLABLE,
  ),
  // page.schema.json: Screenshot
  mapping('page', '/$defs/screenshotEvidence/properties/viewport/enum', 'VIEWPORT_PROFILES'),
  mapping('page', '/$defs/screenshotEvidence/properties/captureType/enum', 'SCREENSHOT_CAPTURE_TYPES'),
  // page.schema.json: Scroll
  mapping('page', '/$defs/scrollObservation/properties/scrollTarget/enum', 'SCROLL_TARGETS', NULLABLE),
  mapping('page', '/$defs/scrollRestoration/oneOf/1/properties/reason/enum', 'SCROLL_RESTORATION_FAILURE_REASONS'),
  mapping('page', '/$defs/scrollEvidence/oneOf/1/properties/reason/enum', 'SCROLL_INCOMPLETE_REASONS'),
  // page.schema.json: Metadata（R15a。Task 14〜17 の設計書 5.6.2）
  mapping('page', '/$defs/metadataEvidence/properties/kind/enum', 'SITE_METADATA_KINDS'),
  mapping('page', '/$defs/metadataEvidence/properties/outcome/enum', 'SITE_METADATA_OUTCOMES'),
  // page.schema.json: Safety（T12d0）
  mapping('page', '/$defs/safetyEventsEvidence/properties/scope/enum', 'SAFETY_EVIDENCE_SCOPES'),
  mapping('page', '/$defs/blockedRequestEvent/properties/reason/enum', 'BLOCKED_REQUEST_REASONS'),
  mapping('page', '/$defs/blockedNavigationEvent/properties/reason/enum', 'BLOCKED_NAVIGATION_REASONS'),
  mapping('page', '/$defs/blockedWebSocketEvent/properties/reason/enum', 'BLOCKED_WEBSOCKET_REASONS'),
  // CC-014（P14a）
  mapping('page', '/$defs/blockedExternalActionEvent/properties/reason/enum', 'BLOCKED_EXTERNAL_ACTION_REASONS'),
  mapping('page', '/$defs/excludedInteractionCandidateEvent/properties/reason/enum', 'INTERACTION_REJECTION_REASONS'),
  mapping('page', '/$defs/blockedInteractionRequestEvent/properties/reason/enum', 'INTERACTION_FROZEN_REASONS'),
  mapping('page', '/$defs/blockedPopupEvent/properties/reason/enum', 'INTERACTION_FROZEN_REASONS'),
  mapping('page', '/$defs/blockedDownloadEvent/properties/reason/enum', 'BLOCKED_DOWNLOAD_REASONS'),
  mapping('page', '/$defs/blockedInteractionWebSocketEvent/properties/reason/enum', 'INTERACTION_FROZEN_REASONS'),
  // C18a（DEF-012）: 外部スキームへの移動の試み。
  mapping('page', '/$defs/externalSchemeNavigationEvent/properties/frame/enum', 'EXTERNAL_SCHEME_NAVIGATION_FRAMES'),
  mapping('page', '/$defs/externalSchemeNavigationEvent/properties/phase/enum', 'EXTERNAL_SCHEME_NAVIGATION_PHASES'),
  mapping('page', '/$defs/externalSchemeNavigationEvent/properties/reason/enum', 'EXTERNAL_SCHEME_NAVIGATION_REASONS'),
]);

const coreExports: Readonly<Record<string, unknown>> = Object.freeze({ ...contracts, ...evidenceTypes });

const mappingKey = (schema: string, pointer: string): string => `${schema}.schema.json#${pointer}`;

const escapePointerToken = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1');

function resolvePointer(document: unknown, pointer: string): unknown {
  let current = document;
  for (const token of pointer.split('/').slice(1)) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** スキーマを走査し、`enum` のキーを持つすべての場所の JSON Pointer（enum の配列そのものを指す）を集める。 */
function collectEnumPointers(node: unknown, pointer: string, found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectEnumPointers(item, `${pointer}/${index}`, found));
    return;
  }
  if (typeof node !== 'object' || node === null) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const childPointer = `${pointer}/${escapePointerToken(key)}`;
    if (key === 'enum') {
      found.push(childPointer);
    } else {
      collectEnumPointers(value, childPointer, found);
    }
  }
}

// スキーマのファイルは、ここで1回だけ読み、各検査で共有する。
const schemas = new Map<string, unknown>();

beforeAll(() => {
  const directory = resolve(process.cwd(), 'schemas');
  for (const fileName of readdirSync(directory)) {
    const match = /^(.+)\.schema\.json$/u.exec(fileName);
    if (match?.[1] !== undefined) {
      schemas.set(match[1], JSON.parse(readFileSync(resolve(directory, fileName), 'utf8')) as unknown);
    }
  }
});

describe('F12: schema enums and the core value arrays', () => {
  it('reads every schema that the mapping table refers to', () => {
    expect([...schemas.keys()].sort()).toEqual(['audit', 'finding', 'page', 'run']);
  });

  it('has no duplicate row in the mapping table', () => {
    const keys = ENUM_MAPPINGS.map((row) => mappingKey(row.schema, row.pointer));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(ENUM_MAPPINGS.map((row) => [mappingKey(row.schema, row.pointer), row] as const))(
    'matches %s with the frozen core array',
    (_key, row) => {
      const values = coreExports[row.coreArray];
      expect(Array.isArray(values), `${row.coreArray} is not exported from src/core as an array`).toBe(true);
      expect(Object.isFrozen(values), `${row.coreArray} is not frozen`).toBe(true);
      const expected = row.nullable ? [...(values as readonly unknown[]), null] : values;
      expect(resolvePointer(schemas.get(row.schema), row.pointer)).toEqual(expected);
    },
  );

  it('maps every enum found in the schemas (no enum outside the mapping table)', () => {
    const found: string[] = [];
    for (const [name, schema] of schemas) {
      const pointers: string[] = [];
      collectEnumPointers(schema, '', pointers);
      found.push(...pointers.map((pointer) => mappingKey(name, pointer)));
    }
    const mapped = new Set(ENUM_MAPPINGS.map((row) => mappingKey(row.schema, row.pointer)));

    expect(found.filter((key) => !mapped.has(key))).toEqual([]);
    expect([...mapped].filter((key) => !found.includes(key))).toEqual([]);
  });
});

// Evidence の ID の接頭辞の owner は `src/core/ids.ts`（`createEvidenceId`）。スキーマの Evidence の各分岐（`oneOf`）の
// `evidenceId` の pattern は、その種類の接頭辞に限る（R''2 の m2）。接頭辞は、実行時に `createEvidenceId` から読む。
describe('F13 m2: evidenceId prefix of each Evidence branch and src/core/ids.ts', () => {
  const evidenceIdPrefix = (type: contracts.EvidenceType): string => {
    const sample = createEvidenceId(type, 0);
    return sample.slice(0, sample.lastIndexOf('-') + 1);
  };

  it.each([...contracts.EVIDENCE_TYPES])('limits the evidenceId pattern of the %s branch to its createEvidenceId prefix', (type) => {
    const branches = resolvePointer(schemas.get('page'), '/$defs/evidence/oneOf');
    expect(Array.isArray(branches)).toBe(true);
    const matching = (branches as readonly unknown[]).filter((branch) => resolvePointer(branch, '/properties/type/const') === type);
    expect(matching).toHaveLength(1);

    const prefix = evidenceIdPrefix(type);
    expect(prefix).toMatch(/^EV-[A-Z0-9_]+-$/u);
    expect(resolvePointer(matching[0], '/properties/evidenceId/pattern')).toBe(`^${prefix}[0-9]{6,}$`);
  });

  it('gives every Evidence type a different prefix', () => {
    const prefixes = contracts.EVIDENCE_TYPES.map(evidenceIdPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

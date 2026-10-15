// スキーマ（`schemas/*.schema.json`）の enum と、`src/core/` の `as const` の凍結した配列が一致することを、
// 1か所でまとめて確かめる（F12）。値の一覧の owner は core の配列で、TypeScript の型はその配列から導く。
// スキーマの enum を増やしたら、下の対応表に、その JSON Pointer と core の配列の名前を加える。
// 対応表にない enum がスキーマにあれば、このテストが失敗する。
// 速さの要件（設計書 UI追補 第6章 6.2 と同じ考え方）: スキーマのファイルの一覧の取得と読み込みは `beforeAll` で1回だけ行い、
// 各検査で共有する。ファイル全体を1秒以内に終える。
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS,
  MAX_NAVIGATION_DIAGNOSTICS_EVENTS,
} from '../../src/browser/navigation-diagnostics.js';
import * as actionContracts from '../../src/control/actions/action-contracts.js';
import { MAX_SAFE_RECORD_ID_LENGTH, SAFE_RECORD_ID_PATTERN } from '../../src/control/actions/action-outcome.js';
import * as scenarioContracts from '../../src/control/approval/scenario-contracts.js';
import * as automatedLoginResults from '../../src/control/auth/automated-login-results.js';
import * as controlContracts from '../../src/control/contracts.js';
import * as credentialStore from '../../src/control/credentials/credential-store.js';
import * as dataRuleContracts from '../../src/control/data-rules/rule-contracts.js';
import * as workerProtocol from '../../src/control/worker-protocol.js';
import * as contracts from '../../src/core/contracts.js';
import * as evidenceTypes from '../../src/core/evidence-types.js';
import { createEvidenceId } from '../../src/core/ids.js';
import { MAX_ERROR_MESSAGE_LENGTH, MAX_HTTP_METHOD_LENGTH, MAX_URL_LENGTH } from '../../src/core/limits.js';
import * as discoveryCandidateContracts from '../../src/discovery/candidate-contracts.js';
import * as discoveryClassificationWords from '../../src/discovery/classification-words.js';
import * as discoveryResult from '../../src/discovery/discovery-result.js';
import * as readCheckContracts from '../../src/discovery/read-check-contracts.js';
import * as readCheckEvaluation from '../../src/discovery/read-check-evaluation.js';
import { INTERACTION_CANDIDATE_LIMITS } from '../../src/safety/interaction-policy.js';
import { SUBMISSION_STAGE_BLOCK_REASONS } from '../../src/safety/request-policy.js';
import { WRITE_PAYLOAD_BLOCK_REASONS } from '../../src/safety/write-payload-policy.js';

type SchemaName =
  | 'action-evidence'
  | 'action-run'
  | 'approval-summary'
  | 'audit'
  | 'checkpoint'
  | 'checkpoint-page'
  | 'discovery'
  | 'finding'
  | 'page'
  | 'read-evidence'
  | 'run'
  | 'site-unavailable-diagnostic';

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
  // R4b2（中断した Run の再開の設計書 4.8）: run.json の実行の記録の終わり方（実行を終えた記録だけなので、null なし）。
  mapping('run', '/properties/executions/items/properties/endReason/enum', 'RUN_EXECUTION_END_REASONS'),
  // checkpoint.schema.json（R2。中断した Run の再開の設計書 4.1、4.2）: 保存の状態、実行の終わり方（実行の途中は null）、
  // 巡回の記録の状態。checkpoint-page.schema.json は、page.schema.json の定義を参照するだけで、enum を持たない。
  mapping('checkpoint', '/properties/state/enum', 'RUN_CHECKPOINT_STATES'),
  mapping('checkpoint', '/$defs/execution/properties/endReason/enum', 'RUN_EXECUTION_END_REASONS', NULLABLE),
  mapping('checkpoint', '/$defs/frontierEntry/properties/state/enum', 'CRAWL_URL_STATES'),
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
  // T25b round 1（Task 25 の設計書 4.2）: 監査の段の除外で遮断した要求の理由（この記録の中だけの一覧）。
  mapping('page', '/$defs/blockedAuditExclusionEvent/properties/reason/enum', 'BLOCKED_AUDIT_EXCLUSION_REASONS'),
  // CC-014（P14a）
  mapping('page', '/$defs/blockedExternalActionEvent/properties/reason/enum', 'BLOCKED_EXTERNAL_ACTION_REASONS'),
  mapping('page', '/$defs/excludedInteractionCandidateEvent/properties/reason/enum', 'INTERACTION_REJECTION_REASONS'),
  // DEF-039・DEF-040 の設計書 2.1.3: リクエストは出口の中継の理由を含む閉じた一覧、ナビゲーションは凍結の理由だけ。
  mapping('page', '/$defs/blockedInteractionRequestEvent/properties/reason/enum', 'BLOCKED_INTERACTION_REQUEST_REASONS'),
  mapping('page', '/$defs/blockedInteractionNavigationEvent/properties/reason/enum', 'INTERACTION_FROZEN_REASONS'),
  mapping('page', '/$defs/blockedPopupEvent/properties/reason/enum', 'INTERACTION_FROZEN_REASONS'),
  mapping('page', '/$defs/blockedDownloadEvent/properties/reason/enum', 'BLOCKED_DOWNLOAD_REASONS'),
  // DEF-040（NP3）: 凍結の後の WebSocket は、Worker の中のもの（`WORKER_CONNECT_POLICY`）を含む閉じた一覧。
  mapping('page', '/$defs/blockedInteractionWebSocketEvent/properties/reason/enum', 'BLOCKED_INTERACTION_WEBSOCKET_REASONS'),
  // C18a（DEF-012）: 外部スキームへの移動の試み。
  mapping('page', '/$defs/externalSchemeNavigationEvent/properties/frame/enum', 'EXTERNAL_SCHEME_NAVIGATION_FRAMES'),
  mapping('page', '/$defs/externalSchemeNavigationEvent/properties/phase/enum', 'EXTERNAL_SCHEME_NAVIGATION_PHASES'),
  mapping('page', '/$defs/externalSchemeNavigationEvent/properties/reason/enum', 'EXTERNAL_SCHEME_NAVIGATION_REASONS'),
  // T27d（Task 27 の設計書の変更履歴「Blocker: T27d」の行）: 発見の成果物 discovery.json。値の一覧は `src/discovery/discovery-result.ts`。
  // 画面の状態は分岐の const で表し、候補は `control/candidate.schema.json` を参照する（候補の enum は下の Control の対応表）。
  mapping('discovery', '/properties/runStatus/enum', 'RUN_STATUSES'),
  mapping('discovery', '/properties/endReason/enum', 'DISCOVERY_END_REASONS'),
  mapping('discovery', '/$defs/page/oneOf/1/properties/reason/enum', 'DISCOVERY_UNREAD_REASONS'),
  // T27e（Task 27 の設計書 4.5）: READ の確かめの成果物 read-evidence.json。値の一覧は `src/discovery/read-check-evaluation.ts`（結果の一覧は
  // `src/discovery/read-check-contracts.ts`）。期待は `control/read-check-definition.schema.json` を参照する（enum を持たない）。
  mapping('read-evidence', '/properties/runStatus/enum', 'RUN_STATUSES'),
  mapping('read-evidence', '/properties/endReason/enum', 'READ_CHECK_END_REASONS'),
  mapping('read-evidence', '/$defs/expectationResult/enum', 'READ_EXPECTATION_RESULTS'),
  mapping('read-evidence', '/$defs/undeterminedReason/anyOf/0/enum', 'READ_EXPECTATION_UNDETERMINED_REASONS'),
  mapping('read-evidence', '/$defs/executed/properties/result/enum', 'READ_CHECK_RESULTS'),
  mapping('read-evidence', '/$defs/executed/properties/detail/enum', 'READ_CHECK_DETAILS'),
  mapping('read-evidence', '/$defs/notExecuted/properties/reason/enum', 'READ_CHECK_NOT_EXECUTED_REASONS'),
  mapping('read-evidence', '/$defs/structure/properties/region/enum', 'READ_PAGE_REGIONS'),
  mapping('read-evidence', '/$defs/rowCountEvidence/properties/rowSource/anyOf/0/enum', 'READ_ROW_SOURCES'),
  // T30a（Task 30 の設計書 3 章の「記録」）: 書き込みのジョブの記録 action-run.json。値の一覧は `src/control/actions/action-contracts.ts`（照合の READ の
  // 結果は `src/discovery/read-check-contracts.ts`）。送らずに止めた記録の分岐の const は `tests/unit/action-run-schema.test.ts` で確かめる。
  mapping('action-run', '/properties/submission/enum', 'SUBMISSION_STATES'),
  mapping('action-run', '/properties/blockReason/enum', 'ACTION_BLOCK_REASONS', NULLABLE),
  mapping('action-run', '/properties/responseJudgement/enum', 'RESPONSE_JUDGEMENTS', NULLABLE),
  mapping('action-run', '/properties/reservationState/enum', 'SETTLED_RESERVATION_STATES'),
  mapping('action-run', '/properties/result/enum', 'ACTION_RESULTS'),
  mapping('action-run', '/properties/reason/enum', 'ACTION_OUTCOME_REASONS'),
  mapping('action-run', '/$defs/readVerification/properties/result/enum', 'READ_CHECK_RESULTS'),
  // T31f: UPDATE の証拠の欄の役割（`update.updateEvidence`）。
  mapping('action-run', '/$defs/updateEvidenceField/properties/role/enum', 'UPDATE_EVIDENCE_FIELD_ROLES'),
  // T32c（Task 32 の設計書 4.1）: 書き込みの報告。ほかの値の一覧は `action-run`・`read-evidence`・`control/scenario` を `$ref` で使うので、ここに
  // 来るのは新しい enum だけ。Guard の要約の理由の鍵は、Guard の閉じた一覧（`src/safety/request-policy.ts`、`src/safety/write-payload-policy.ts`。
  // `src/control/` は読み込めないので契約に書き写さない）と一致する。人が決めたこと・自動で行うことは `src/control/actions/action-contracts.ts`。
  mapping('action-evidence', '/$defs/guardSummary/properties/blockedByReason/propertyNames/enum', 'SUBMISSION_STAGE_BLOCK_REASONS'),
  mapping('action-evidence', '/$defs/guardSummary/properties/blockedByPayloadReason/propertyNames/enum', 'WRITE_PAYLOAD_BLOCK_REASONS'),
  // T32d: 事実の形は `$defs/facts` に 1 回だけ置き（IPC の `START` も `$ref` で使う）、種類ごとの一覧の決まりは `$defs/kindLists`。
  mapping('approval-summary', '/$defs/facts/properties/humanDecisions/items/enum', 'HUMAN_DECISIONS'),
  mapping('approval-summary', '/$defs/facts/properties/automatedActions/items/enum', 'AUTOMATED_ACTIONS'),
  mapping('approval-summary', '/$defs/kindLists/then/properties/humanDecisions/items/not/enum', 'UPDATE_ONLY_HUMAN_DECISIONS'),
  mapping('approval-summary', '/$defs/kindLists/then/properties/automatedActions/items/not/enum', 'UPDATE_ONLY_AUTOMATED_ACTIONS'),
]);

const coreExports: Readonly<Record<string, unknown>> = Object.freeze({
  ...contracts,
  ...evidenceTypes,
  ...discoveryResult,
  ...readCheckContracts,
  ...readCheckEvaluation,
  ...actionContracts,
  // T32c: Guard の要約の理由の鍵（owner は `src/safety/`。名前を指定して足し、ほかの名前を混ぜない）。
  SUBMISSION_STAGE_BLOCK_REASONS,
  WRITE_PAYLOAD_BLOCK_REASONS,
});

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
    expect([...schemas.keys()].sort()).toEqual([
      'action-evidence', 'action-run', 'approval-summary', 'audit', 'checkpoint', 'checkpoint-page', 'discovery', 'finding', 'page', 'read-evidence', 'run',
      'site-unavailable-diagnostic',
    ]);
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

// T22a（Task 22 の設計書 3.1、7）: Control のスキーマ（`schemas/control/*.schema.json`）の enum と、`src/control/contracts.ts` の
// `as const` の凍結した配列の対応表。成果物のスキーマ（上の対応表）とは、置き場所も値の一覧の owner も別なので、別の表にする。
// Control のスキーマに enum を増やしたら、この表に1行を加える。対応表にない enum があれば、このテストが失敗する。
type ControlSchemaName = 'profile' | 'worker-message' | 'credential-file' | 'candidate' | 'scenario' | 'approval-receipt' | 'data-rule';

interface ControlEnumMapping {
  readonly schema: ControlSchemaName;
  /** enum の配列そのものを指す JSON Pointer（RFC 6901）。 */
  readonly pointer: string;
  /** `src/control/contracts.ts` が公開する、値の一覧の配列の名前。 */
  readonly controlArray: string;
}

const controlMapping = (schema: ControlSchemaName, pointer: string, controlArray: string): ControlEnumMapping =>
  Object.freeze({ schema, pointer, controlArray });

/** Control のスキーマの enum と、`src/control/contracts.ts` の配列の対応表。 */
const CONTROL_ENUM_MAPPINGS: readonly ControlEnumMapping[] = Object.freeze([
  // control/profile.schema.json（Task 22 の設計書 4.1）
  controlMapping('profile', '/properties/environment/enum', 'ENVIRONMENT_KINDS'),
  controlMapping('profile', '/properties/mode/enum', 'AUDIT_MODES'),
  controlMapping('profile', '/properties/auth/enum', 'AUTH_STRATEGIES'),
  // control/worker-message.schema.json（Task 24 の設計書 4.3。T24d）。値の一覧は `src/control/worker-protocol.ts`。メッセージの種類と知らせの種類は
  // 分岐の const で表すので、`tests/unit/worker-protocol.test.ts` で確かめる。
  controlMapping('worker-message', '/$defs/runStarted/properties/resumeDecision/properties/kind/enum', 'WORKER_RESUME_DECISION_KINDS'),
  controlMapping('worker-message', '/$defs/outcome/properties/kind/enum', 'WORKER_OUTCOME_KINDS'),
  controlMapping('worker-message', '/$defs/outcome/properties/runStatus/anyOf/0/enum', 'WORKER_RUN_STATUSES'),
  controlMapping('worker-message', '/$defs/failed/properties/reason/enum', 'WORKER_FAILURE_REASONS'),
  // T25d: 認証の状態の知らせ（Task 25 の設計書 4.4）。
  controlMapping('worker-message', '/$defs/authState/properties/state/enum', 'WORKER_AUTH_STATES'),
  // T26d-2: ジョブの種類と、自動ログインの結果（Task 26 の設計書 4.5）。結果と送信の一覧は `src/control/auth/automated-login-results.ts`。
  controlMapping('worker-message', '/$defs/start/properties/jobKind/enum', 'WORKER_JOB_KINDS'),
  controlMapping('worker-message', '/$defs/automatedLoginReport/properties/result/enum', 'AUTOMATED_LOGIN_RESULTS'),
  controlMapping('worker-message', '/$defs/automatedLoginReport/properties/submitted/enum', 'AUTOMATED_LOGIN_SUBMISSIONS'),
  controlMapping('worker-message', '/$defs/automatedLoginReport/properties/formInvalidReason/anyOf/0/enum', 'WORKER_LOGIN_FORM_INVALID_REASONS'),
  // T30e: 書き込みのジョブの、確かめ直しの結果の理由と、送信の報告（送信の状態と止めた理由は `action-contracts.ts` の一覧そのもの）。
  controlMapping('worker-message', '/$defs/writeRecheckResult/properties/reason/anyOf/0/enum', 'WORKER_WRITE_RECHECK_REJECTION_REASONS'),
  controlMapping('worker-message', '/$defs/writeSubmission/properties/submission/enum', 'WORKER_WRITE_SUBMISSION_STATES'),
  controlMapping('worker-message', '/$defs/writeSubmission/properties/blockReason/anyOf/0/enum', 'WORKER_WRITE_BLOCK_REASONS'),
  // T26a: 資格情報のファイル（Task 26 の設計書 4.1、4.2）。値の一覧は `src/control/credentials/credential-store.ts`。
  controlMapping('credential-file', '/properties/lastChangeKind/enum', 'CREDENTIAL_CHANGE_KINDS'),
  // T27a: 発見の候補（Task 27 の設計書 4.1）。値の一覧は `src/discovery/candidate-contracts.ts`。form の外のボタンと form の項目の組み合わせは
  // スキーマの `if`・`then`（`const` と型）で表すので、上限と組み合わせは `tests/unit/discovery-candidate-schema.test.ts` で確かめる。
  controlMapping('candidate', '/properties/kind/enum', 'CANDIDATE_KINDS'),
  controlMapping('candidate', '/properties/formMethod/anyOf/0/enum', 'FORM_METHODS'),
  controlMapping('candidate', '/properties/methodOverride/anyOf/0/enum', 'METHOD_OVERRIDE_VALUES'),
  controlMapping('candidate', '/properties/enctype/anyOf/0/enum', 'FORM_ENCTYPES'),
  controlMapping('candidate', '/properties/classification/enum', 'CANDIDATE_CLASSIFICATIONS'),
  controlMapping('candidate', '/properties/reasonCode/enum', 'CANDIDATE_REASON_CODES'),
  controlMapping('candidate', '/properties/incompleteReasons/items/enum', 'INCOMPLETE_REASONS'),
  controlMapping('candidate', '/$defs/field/properties/tag/enum', 'CANDIDATE_FIELD_TAGS'),
  controlMapping('candidate', '/$defs/field/properties/type/enum', 'CANDIDATE_FIELD_TYPES'),
  controlMapping('candidate', '/$defs/listenerKinds/items/enum', 'LISTENER_KINDS'),
  // T27R-fix-1（DEF-086）: 送信ボタンの語の閉じた一覧。値の一覧は `src/discovery/classification-words.ts`。
  controlMapping('candidate', '/properties/submitterWords/items/enum', 'DISCOVERY_SUBMITTER_WORDS'),
  // T28a: シナリオと承認の記録（Task 28 の設計書 4.1）。値の一覧は `src/control/approval/scenario-contracts.ts`（enctype は候補の契約の一覧）。
  // 承認の記録の種類と承認者は分岐の const なので、`tests/unit/approval-schemas.test.ts` で確かめる。
  controlMapping('scenario', '/properties/kind/enum', 'SCENARIO_KINDS'),
  controlMapping('scenario', '/$defs/request/properties/methodOverride/anyOf/0/enum', 'SCENARIO_METHOD_OVERRIDES'),
  controlMapping('scenario', '/$defs/request/properties/enctype/enum', 'FORM_ENCTYPES'),
  controlMapping('approval-receipt', '/$defs/revocation/properties/reason/enum', 'REVOCATION_REASONS'),
  // T29a: 入力の規則の集まり（Task 29 の設計書 4.1）。値の一覧は `src/control/data-rules/rule-contracts.ts`。欄どうしの関係の種類は分岐の const
  // なので、`tests/unit/data-rule-contracts.test.ts` で確かめる。
  controlMapping('data-rule', '/$defs/fieldRule/properties/semanticKind/enum', 'SEMANTIC_KINDS'),
  controlMapping('data-rule', '/$defs/fieldRule/properties/method/enum', 'GENERATION_METHODS'),
]);

const controlExports: Readonly<Record<string, unknown>> = Object.freeze({
  ...controlContracts,
  ...workerProtocol,
  ...credentialStore,
  ...automatedLoginResults,
  ...discoveryCandidateContracts,
  ...discoveryClassificationWords,
  ...scenarioContracts,
  ...dataRuleContracts,
});

const controlMappingKey = (schema: string, pointer: string): string => mappingKey(`control/${schema}`, pointer);

// Control のスキーマのファイルも、ここで1回だけ読み、各検査で共有する。
const controlSchemas = new Map<string, unknown>();

beforeAll(() => {
  const directory = resolve(process.cwd(), 'schemas', 'control');
  for (const fileName of readdirSync(directory)) {
    const match = /^(.+)\.schema\.json$/u.exec(fileName);
    if (match?.[1] !== undefined) {
      controlSchemas.set(match[1], JSON.parse(readFileSync(resolve(directory, fileName), 'utf8')) as unknown);
    }
  }
});

describe('T22a: control schema enums and the src/control value arrays', () => {
  it('reads every control schema that the mapping table refers to', () => {
    // T23f: ローカルの管理画面の Server Function の入力のスキーマ（enum を持たない）。
    expect([...controlSchemas.keys()].sort()).toEqual([
      // T28a: 承認の記録（Task 28 の設計書 4.1。enum は上の対応表。分岐の const と上限の一致は `approval-schemas.test.ts`）。
      'approval-receipt',
      // T25a: 認証の設定（Task 25 の設計書 4.1。enum を持たない。上限と名前つきの定数の一致は `control-auth-setup.test.ts`）。
      'auth-setup',
      // T26b: 認証の設定の版 2（Task 26 の設計書 4.3。enum を持たない。上限と名前つきの定数の一致は `control-auth-setup-v2.test.ts`）。
      'auth-setup-v2',
      // T27a: 発見の候補（Task 27 の設計書 4.1。enum は上の対応表。上限と名前つきの定数の一致は `discovery-candidate-schema.test.ts`）。
      'candidate',
      // T26a: 資格情報のファイル（Task 26 の設計書 4.1。enum は上の対応表の `lastChangeKind`）。
      'credential-file',
      // T29a: 入力の規則の集まり（Task 29 の設計書 4.1。enum は上の対応表。上限と分岐の const の一致は `data-rule-contracts.test.ts`）。
      'data-rule',
      'profile',
      // T27c: READ の確かめの定義（Task 27 の設計書 4.5。期待の種類は分岐の const。種類と上限の一致は `read-check-contracts.test.ts`）。
      'read-check-definition',
      // T28a: シナリオの版（Task 28 の設計書 4.1。enum は上の対応表。上限と名前つきの定数の一致は `approval-schemas.test.ts`）。
      'scenario',
      // T24f: 画面の監査のジョブの Server Function の入力（Task 24 の設計書 4.8。enum を持たない）。
      'ui-audit-job-key',
      'ui-audit-job-start',
      'ui-audit-job-stop',
      // T25e: 画面の認証の設定の保存の Server Function の入力（Task 25 の設計書 4.5。enum を持たない）。
      'ui-auth-setup-save',
      // T26e: 画面の資格情報の登録・変更・入れ直しと、ログインの検証の開始の Server Function の入力（Task 26 の設計書 4.2、4.6。enum を持たない）。
      'ui-credential-change',
      'ui-credential-register',
      'ui-credential-replace',
      // T29e: 画面の入力の規則の保存の Server Function の入力（Task 29 の設計書 4.4。enum は data-rule のスキーマの参照）。
      'ui-data-rule-save',
      // T27f: 画面の操作の候補の発見と READ の確かめの Server Function の入力（Task 27 の設計書 4.7。enum を持たない）。
      'ui-discovery-start',
      'ui-login-check-start',
      'ui-profile-create',
      'ui-profile-key',
      'ui-profile-retire',
      'ui-profile-update',
      'ui-read-check-cancel',
      'ui-read-check-create',
      'ui-read-check-start',
      'ui-read-check-update',
      // T28e: 画面のシナリオの Server Function の入力（Task 28 の設計書 4.6。enum を持たない）。
      'ui-scenario-approve',
      'ui-scenario-create',
      'ui-scenario-form',
      'ui-scenario-key',
      'ui-scenario-revoke',
      'ui-scenario-update',
      'ui-target-config',
      // T30g fix round 1: 画面の書き込みの開始の Server Function の入力（Task 30 の設計書 3 章、10 章。enum を持たない）。
      'ui-write-start',
      // T31h-2: 画面の更新の書き込みの開始の Server Function の入力（Task 31 の設計書 3 章、10 章。enum を持たない）。
      'ui-write-update-start',
      // T24d: IPC のメッセージ（Task 24 の設計書 4.3）。
      'worker-message',
    ]);
  });

  it('has no duplicate row in the control mapping table', () => {
    const keys = CONTROL_ENUM_MAPPINGS.map((row) => controlMappingKey(row.schema, row.pointer));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(CONTROL_ENUM_MAPPINGS.map((row) => [controlMappingKey(row.schema, row.pointer), row] as const))(
    'matches %s with the frozen src/control array',
    (_key, row) => {
      const values = controlExports[row.controlArray];
      expect(Array.isArray(values), `${row.controlArray} is not exported from src/control as an array`).toBe(true);
      expect(Object.isFrozen(values), `${row.controlArray} is not frozen`).toBe(true);
      expect(resolvePointer(controlSchemas.get(row.schema), row.pointer)).toEqual(values);
    },
  );

  it('maps every enum found in the control schemas (no enum outside the control mapping table)', () => {
    const found: string[] = [];
    for (const [name, schema] of controlSchemas) {
      const pointers: string[] = [];
      collectEnumPointers(schema, '', pointers);
      found.push(...pointers.map((pointer) => controlMappingKey(name, pointer)));
    }
    const mapped = new Set(CONTROL_ENUM_MAPPINGS.map((row) => controlMappingKey(row.schema, row.pointer)));

    expect(found.filter((key) => !mapped.has(key))).toEqual([]);
    expect([...mapped].filter((key) => !found.includes(key))).toEqual([]);
  });
});

// D2（サイトの不調で止めたときの診断の記録の設計書 2.3）: 診断の記録のスキーマは、enum を持たない。ページ本体の要求の観察の結果の状態は、
// 分岐（`oneOf`）ごとの `const` で表すので、分岐の `const` の並びが core の一覧（`NAVIGATION_DIAGNOSTICS_STATUSES`）と一致することを確かめる。
// 上限（`maxItems`、`maxLength`）は、観察の部品（`src/browser/navigation-diagnostics.ts`）の定数と `src/core/limits.ts` の定数と一致する
// ことを、下の対応表で確かめる。対応表にない上限がスキーマにあれば、失敗する。
const DIAGNOSTIC_SCHEMA: SchemaName = 'site-unavailable-diagnostic';
/** ページ本体の要求の観察の結果の分岐（`OBSERVED`、`NOT_OBSERVED` の順）。 */
const NAVIGATION_DIAGNOSTICS_BRANCHES_POINTER = '/$defs/navigationDiagnostics/oneOf';

/** 診断の記録のスキーマの上限と、その定義元の定数の対応表。 */
const DIAGNOSTIC_LIMIT_MAPPINGS: readonly (readonly [pointer: string, expected: number, constant: string])[] = Object.freeze([
  // D3（設計書 2.2 の 2026-10-07 の改訂、2.3）: ビューポートごとの、幅の走査の幅ごとの観察の数の上限（設定の `stressWidths` に上限がないので、
  // 記録の上限は `src/core/contracts.ts` の定数）と、Interaction の候補ごとの観察の数の上限（候補の数の上限 `INTERACTION_CANDIDATE_LIMITS.maxCandidates`）。
  ['/$defs/viewportNavigationDiagnostics/properties/stressWidths/maxItems', contracts.MAX_STRESS_WIDTH_NAVIGATION_DIAGNOSTICS, 'MAX_STRESS_WIDTH_NAVIGATION_DIAGNOSTICS'],
  ['/$defs/viewportNavigationDiagnostics/properties/interactionCandidates/maxItems', INTERACTION_CANDIDATE_LIMITS.maxCandidates, 'INTERACTION_CANDIDATE_LIMITS.maxCandidates'],
  [`${NAVIGATION_DIAGNOSTICS_BRANCHES_POINTER}/0/properties/documentRequests/maxItems`, MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS, 'MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS'],
  // 文書の要求の1回分（hop）は、それぞれ1件の事象（`Network.requestWillBeSent`）から作るので、1つの要求の回の数は、事象の上限を超えない。
  ['/$defs/documentRequest/properties/hops/maxItems', MAX_NAVIGATION_DIAGNOSTICS_EVENTS, 'MAX_NAVIGATION_DIAGNOSTICS_EVENTS'],
  ['/$defs/documentRequestHop/properties/url/maxLength', MAX_URL_LENGTH, 'MAX_URL_LENGTH'],
  ['/$defs/documentRequestHop/properties/method/maxLength', MAX_HTTP_METHOD_LENGTH, 'MAX_HTTP_METHOD_LENGTH'],
  ['/$defs/loadingFailure/properties/errorText/maxLength', MAX_ERROR_MESSAGE_LENGTH, 'MAX_ERROR_MESSAGE_LENGTH'],
  [`${NAVIGATION_DIAGNOSTICS_BRANCHES_POINTER}/1/properties/reason/maxLength`, MAX_ERROR_MESSAGE_LENGTH, 'MAX_ERROR_MESSAGE_LENGTH'],
] as const);

/** スキーマを走査し、`maxItems` と `maxLength` のキーを持つすべての場所の JSON Pointer（値そのものを指す）を集める。 */
function collectLimitPointers(node: unknown, pointer: string, found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectLimitPointers(item, `${pointer}/${index}`, found));
    return;
  }
  if (typeof node !== 'object' || node === null) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const childPointer = `${pointer}/${escapePointerToken(key)}`;
    if (key === 'maxItems' || key === 'maxLength') {
      found.push(childPointer);
    } else {
      collectLimitPointers(value, childPointer, found);
    }
  }
}

describe('D2: the statuses and the limits of the site-unavailable diagnostic schema, and the core and D1 constants', () => {
  it('lists the statuses of the branches of the navigation diagnostics in the order of NAVIGATION_DIAGNOSTICS_STATUSES', () => {
    const branches = resolvePointer(schemas.get(DIAGNOSTIC_SCHEMA), NAVIGATION_DIAGNOSTICS_BRANCHES_POINTER);

    expect(Array.isArray(branches)).toBe(true);
    expect(Object.isFrozen(contracts.NAVIGATION_DIAGNOSTICS_STATUSES)).toBe(true);
    expect((branches as readonly unknown[]).map((branch) => resolvePointer(branch, '/properties/status/const')))
      .toEqual([...contracts.NAVIGATION_DIAGNOSTICS_STATUSES]);
  });

  it('requires the navigation diagnostics of every viewport of VIEWPORT_PROFILES, and no other viewport', () => {
    const schema = schemas.get(DIAGNOSTIC_SCHEMA);

    expect(resolvePointer(schema, '/properties/navigationDiagnostics/required')).toEqual([...contracts.VIEWPORT_PROFILES]);
    expect(Object.keys(resolvePointer(schema, '/properties/navigationDiagnostics/properties') as object)).toEqual([...contracts.VIEWPORT_PROFILES]);
    expect(resolvePointer(schema, '/properties/navigationDiagnostics/additionalProperties')).toBe(false);
  });

  it.each(DIAGNOSTIC_LIMIT_MAPPINGS.map(([pointer, expected, constant]) => [`${pointer} = ${constant}`, pointer, expected] as const))(
    'matches %s',
    (_name, pointer, expected) => {
      expect(resolvePointer(schemas.get(DIAGNOSTIC_SCHEMA), pointer)).toBe(expected);
    },
  );

  it('maps every limit found in the schema (no limit outside the mapping table)', () => {
    const found: string[] = [];
    collectLimitPointers(schemas.get(DIAGNOSTIC_SCHEMA), '', found);

    expect(found.sort()).toEqual(DIAGNOSTIC_LIMIT_MAPPINGS.map(([pointer]) => pointer).sort());
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

// CCX-28（T31f の共通化の候補 3）: 登録の ID として使える形（`src/control/actions/action-outcome.ts` の `SAFE_RECORD_ID_PATTERN` と
// `MAX_SAFE_RECORD_ID_LENGTH`。`isUsableRecordId` の判定そのもの）と、スキーマの対象のレコードの ID の対応表。成果物のスキーマ（`schemas/`）と
// Control のスキーマ（`schemas/control/`）の両方を見る。同じパターンの項目をスキーマに増やしたら、この表に 1 行を加える。対応表にない項目があれば、
// このテストが失敗する。
interface RecordIdShapeMapping {
  /** `schemas/` からのスキーマのファイルの path。 */
  readonly file: string;
  /** 項目を指す JSON Pointer（RFC 6901）。 */
  readonly pointer: string;
}

const RECORD_ID_SHAPE_MAPPINGS: readonly RecordIdShapeMapping[] = Object.freeze([
  // T31f: 書き込みの記録の UPDATE の対象の ID。
  { file: 'action-run.schema.json', pointer: '/properties/update/properties/targetRecordId' },
  // T31f: `START` の書き込みの指定の、UPDATE の対象の ID。
  { file: 'control/worker-message.schema.json', pointer: '/$defs/startWrite/properties/update/properties/targetRecordId' },
  // T31h-2: 画面の更新の書き込みの開始の入力の、画面が見せた予定のレコードの ID。
  { file: 'control/ui-write-update-start.schema.json', pointer: '/properties/expectedTargetRecordId' },
]);

/** スキーマの中の、`pattern` が登録の ID の形のパターンと同じ項目の JSON Pointer を集める。 */
function collectRecordIdShapePointers(node: unknown, pointer: string, found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectRecordIdShapePointers(item, `${pointer}/${index}`, found));
    return;
  }
  if (typeof node !== 'object' || node === null) {
    return;
  }
  if ((node as Record<string, unknown>)['pattern'] === SAFE_RECORD_ID_PATTERN.source) {
    found.push(pointer);
  }
  for (const [key, value] of Object.entries(node)) {
    collectRecordIdShapePointers(value, `${pointer}/${escapePointerToken(key)}`, found);
  }
}

/** `schemas/` と `schemas/control/` のスキーマ（`schemas/` からの path → 中身）。 */
const readRecordIdShapeSchemas = (): ReadonlyMap<string, unknown> => {
  const files = new Map<string, unknown>();
  for (const directory of ['', 'control']) {
    const base = resolve(process.cwd(), 'schemas', directory);
    for (const fileName of readdirSync(base).filter((name) => name.endsWith('.schema.json'))) {
      files.set(directory === '' ? fileName : `${directory}/${fileName}`, JSON.parse(readFileSync(resolve(base, fileName), 'utf8')) as unknown);
    }
  }
  return files;
};

describe('CCX-28: the record id shape in the schemas and the usable record id', () => {
  it.each(RECORD_ID_SHAPE_MAPPINGS.map((row) => [`${row.file}#${row.pointer}`, row] as const))(
    'matches %s with SAFE_RECORD_ID_PATTERN and MAX_SAFE_RECORD_ID_LENGTH',
    (_key, row) => {
      const node = resolvePointer(readRecordIdShapeSchemas().get(row.file), row.pointer) as Record<string, unknown> | undefined;
      expect(node?.['type']).toBe('string');
      expect(node?.['pattern']).toBe(SAFE_RECORD_ID_PATTERN.source);
      expect(node?.['maxLength']).toBe(MAX_SAFE_RECORD_ID_LENGTH);
      expect(node?.['minLength']).toBe(1);
    },
  );

  it('maps every property with the record id pattern in the schemas (no copy outside the mapping table)', () => {
    const found: string[] = [];
    for (const [file, schema] of readRecordIdShapeSchemas()) {
      const pointers: string[] = [];
      collectRecordIdShapePointers(schema, '', pointers);
      found.push(...pointers.map((pointer) => `${file}#${pointer}`));
    }
    expect(found.sort()).toEqual(RECORD_ID_SHAPE_MAPPINGS.map((row) => `${row.file}#${row.pointer}`).sort());
  });
});

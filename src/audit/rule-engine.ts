import {
  FINDING_CATEGORIES,
  SEVERITIES,
  type EvidenceId,
  type Finding,
  type IncompleteReasonCode,
  type PageId,
  type ViewportProfile,
} from '../core/contracts.js';
import { safeErrorMessage } from '../core/errors.js';
import type { NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { isNonNegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../core/guards.js';
import {
  createFindingFingerprint,
  createFindingId,
  type FindingFingerprintIdentityField,
} from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { compareCodeUnits } from '../core/text.js';
import type { AuditRule, FindingDraft, PageRuleInput } from './rule.js';
import { RULE_CATALOG, freezeCatalog } from './rule-catalog.js';
import { distinctSorted } from './rule-helpers.js';

/**
 * Rule の評価の失敗。Rule が例外を投げたか、不正な下書きを返した場合に、その Rule の下書きをすべて捨てて返す。
 * Page Auditor は、これを未完了の理由（`code` と、`ruleId` と `message` の補足）として記録する。
 */
export interface RuleEvaluationFailure {
  readonly code: Extract<IncompleteReasonCode, 'RULE_EVALUATION_FAILED'>;
  /** 失敗した Rule の `AuditRule.ruleId`（下書きの ruleId ではない）。 */
  readonly ruleId: string;
  /** 失敗の内容。`MAX_ERROR_MESSAGE_LENGTH` 以内。 */
  readonly message: string;
}

/**
 * 下書きを Finding にするときの文脈。Finding の `pageId`・`pageUrl`・`viewport` になり、fingerprint の対象になる。
 * ページやビューポートによらない Finding（Cross-page rule の Finding など）では、該当する値を `null` にする。
 */
export interface FindingDraftContext {
  readonly pageId: PageId | null;
  /** 正規化したページのURL。 */
  readonly pageUrl: NormalizedHttpUrlEvidence | null;
  /** `null` でなければ、予約名 `viewport` の同一性の要素として fingerprint に含める。`null` なら含めない。 */
  readonly viewport: ViewportProfile | null;
}

/**
 * 下書きを返した Rule。ruleId の決まりの検査、ruleVersion と category が Rule の定義と一致することの検査、
 * 失敗の報告に使う（`AuditRule` と `CrossPageRule` をそのまま渡せる）。
 */
export type FindingDraftOwner = Pick<AuditRule, 'ruleId' | 'ruleIdPrefix' | 'version' | 'category'>;

/** `materializeFindingDrafts` に渡す、文脈と、返した Rule を付けた下書き。 */
export interface FindingDraftEntry {
  readonly owner: FindingDraftOwner;
  readonly context: FindingDraftContext;
  /** 形はこの関数が検査する（Rule の実装が型どおりの値を返すとは限らないため）。 */
  readonly draft: FindingDraft;
}

export interface MaterializeFindingDraftsOptions {
  /** `AuditConfig.target.id`。空でない文字列。fingerprint の対象になる。 */
  readonly targetId: string;
  /** 最初に振る Finding の連番。0以上の安全な整数（Run 全体で一意にするため、採番器から受け取る）。 */
  readonly firstFindingSequence: number;
  /** 下書きが参照してよい Evidence の ID。 */
  readonly evidenceIds: ReadonlySet<string>;
  readonly drafts: readonly FindingDraftEntry[];
}

export interface MaterializeFindingDraftsResult {
  /** severity（`SEVERITIES` の順）、ruleId、fingerprint の順に並べ、この順に ID を振った Finding。 */
  readonly findings: readonly Finding[];
  /** ruleId の順に並べた、評価に失敗した Rule（1つの Rule につき1件）。 */
  readonly failures: readonly RuleEvaluationFailure[];
  /** 次に使う Finding の連番（`firstFindingSequence` + Finding の件数）。 */
  readonly nextFindingSequence: number;
}

/** page rule の評価の結果。失敗には、例外を投げた Rule と、不正な下書きを返した Rule の両方が入る。 */
export type RuleEngineResult = MaterializeFindingDraftsResult;

export interface RuleEngineOptions {
  /** `AuditConfig.target.id`。fingerprint の対象になる。 */
  readonly targetId: string;
  /** この評価で最初に振る Finding の連番（Run 全体で一意にするため、採番器から受け取る）。 */
  readonly firstFindingSequence: number;
  /** 評価する Rule の一覧。省略すると `RULE_CATALOG`。テストで仮の Rule を渡すためのもので、登録先ではない。 */
  readonly catalog?: readonly AuditRule[];
}

/** fingerprint の同一性の要素のうち、ビューポートを表す予約名。下書きは、この名前の要素を持てない。 */
const VIEWPORT_IDENTITY_FIELD_NAME = 'viewport';

type FindingWithoutId = Omit<Finding, 'findingId'>;

/**
 * 文脈付きの下書きを検査し、fingerprint を付け、決定論的な順序に並べ、Finding ID を振って、凍結した Finding を返す（設計書 第6章）。
 * Page rule の Engine と Cross-page rule が共有する、下書きから Finding への唯一の変換。
 * - 検査に失敗した下書きが1件でもある Rule は、その Rule の失敗とし、同じ Rule のほかの下書きもすべて捨てる。
 *   Rule は `owner.ruleId` で区別する。失敗の文字列は、その Rule で最初に検査に失敗した下書きの理由。
 * - 検査の内容: 下書きの形、ruleId の決まり（`AuditRule` の説明）、ruleVersion と category が持ち主の Rule の
 *   `version` と `category` に一致すること、`evidenceRefs` が1件以上で `evidenceIds` の中にあること、
 *   同一性の要素に予約名 `viewport` がないこと。severity は下書きの値を正とするので、Rule の定義と比べない。
 * - `evidenceRefs` は、重複を除いてコード単位の順に並べる（入力の順序が出力に影響しないようにするため）。
 * - `targetId` が空でない文字列でなければ `TypeError`、`firstFindingSequence` が0以上の安全な整数でなければ `RangeError` を投げる。
 */
export const materializeFindingDrafts = (options: MaterializeFindingDraftsOptions): MaterializeFindingDraftsResult => {
  assertMaterializationOptions(options.targetId, options.firstFindingSequence);

  const pending: { readonly ownerRuleId: string; readonly finding: FindingWithoutId }[] = [];
  const failures = new Map<string, RuleEvaluationFailure>();
  for (const entry of options.drafts) {
    const ownerRuleId = entry.owner.ruleId;
    if (failures.has(ownerRuleId)) {
      continue;
    }
    try {
      const draft = validateDraft(entry.draft, entry.owner, options.evidenceIds);
      pending.push({ ownerRuleId, finding: toFinding(draft, entry.context, options.targetId) });
    } catch (error) {
      failures.set(ownerRuleId, toRuleEvaluationFailure(ownerRuleId, error));
    }
  }

  const findings = pending
    .filter(({ ownerRuleId }) => !failures.has(ownerRuleId))
    .map(({ finding }) => finding)
    .sort(compareFindings)
    .map(
      (finding, index): Finding => ({
        schemaVersion: finding.schemaVersion,
        findingId: createFindingId(options.firstFindingSequence + index),
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        ruleVersion: finding.ruleVersion,
        category: finding.category,
        severity: finding.severity,
        pageId: finding.pageId,
        pageUrl: finding.pageUrl,
        viewport: finding.viewport,
        message: finding.message,
        evidenceRefs: finding.evidenceRefs,
      }),
    );

  return deepFreeze({
    findings,
    failures: [...failures.values()].sort(compareRuleEvaluationFailures),
    nextFindingSequence: options.firstFindingSequence + findings.length,
  });
};

/**
 * Rule の一覧を1ページ・1ビューポートについて評価し、ID と fingerprint を付けた Finding を返す（設計書 第6章）。
 * Engine は各 Rule の評価と例外の封じ込めだけを行い、下書きの変換は `materializeFindingDrafts` に任せる。
 */
export class RuleEngine {
  readonly #targetId: string;
  readonly #firstFindingSequence: number;
  readonly #catalog: readonly AuditRule[];

  constructor(options: RuleEngineOptions) {
    assertMaterializationOptions(options.targetId, options.firstFindingSequence);
    this.#targetId = options.targetId;
    this.#firstFindingSequence = options.firstFindingSequence;
    this.#catalog = options.catalog === undefined ? RULE_CATALOG : freezeCatalog(options.catalog);
  }

  evaluate(input: PageRuleInput): RuleEngineResult {
    const context: FindingDraftContext = { pageId: input.pageId, pageUrl: input.pageUrl, viewport: input.viewport };
    const entries: FindingDraftEntry[] = [];
    const evaluationFailures: RuleEvaluationFailure[] = [];

    for (const rule of this.#catalog) {
      try {
        const drafts = rule.evaluate(input);
        if (!Array.isArray(drafts)) {
          throw new TypeError('rule must return an array of finding drafts');
        }
        const ruleEntries = drafts.map((draft): FindingDraftEntry => ({ owner: rule, context, draft }));
        entries.push(...ruleEntries);
      } catch (error) {
        evaluationFailures.push(toRuleEvaluationFailure(rule.ruleId, error));
      }
    }

    const materialized = materializeFindingDrafts({
      targetId: this.#targetId,
      firstFindingSequence: this.#firstFindingSequence,
      evidenceIds: new Set<string>(input.evidence.map((record) => record.evidenceId)),
      drafts: entries,
    });

    return deepFreeze({
      findings: materialized.findings,
      failures: [...evaluationFailures, ...materialized.failures].sort(compareRuleEvaluationFailures),
      nextFindingSequence: materialized.nextFindingSequence,
    });
  }
}

const assertMaterializationOptions = (targetId: unknown, firstFindingSequence: unknown): void => {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new TypeError('finding target id must be a non-empty string');
  }
  if (!isNonNegativeSafeInteger(firstFindingSequence)) {
    throw new RangeError('first finding sequence must be a non-negative safe integer');
  }
};

/**
 * Rule の評価の例外（または下書きの検査の失敗）を、その Rule の失敗に変える唯一の変換。
 * Page rule の Engine と Cross-page rule（`evaluateCrossPageRules`）が共有する。
 */
export const toRuleEvaluationFailure = (ruleId: string, error: unknown): RuleEvaluationFailure => ({
  code: 'RULE_EVALUATION_FAILED',
  ruleId,
  message: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH),
});

/**
 * Rule の評価の失敗の決定論的な順序（ruleId のコード単位の順）。Page rule の Engine と Cross-page rule が共有する。
 */
export const compareRuleEvaluationFailures = (left: RuleEvaluationFailure, right: RuleEvaluationFailure): number =>
  compareCodeUnits(left.ruleId, right.ruleId);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/** 下書きの ruleId が、返した Rule の ruleId の決まり（`AuditRule` の説明）に合うことを検査する。 */
const assertDraftRuleIdBelongsToOwner = (ruleId: string, owner: FindingDraftOwner): void => {
  const prefix = owner.ruleIdPrefix;
  if (prefix === undefined) {
    if (ruleId !== owner.ruleId) {
      throw new Error(`finding draft rule id ${ruleId} does not match the rule id ${owner.ruleId}`);
    }
    return;
  }
  if (!ruleId.startsWith(prefix) || ruleId.length <= prefix.length) {
    throw new Error(`finding draft rule id ${ruleId} must start with and be longer than the rule id prefix ${prefix}`);
  }
};

/**
 * 下書きを検査し、Rule が持つ配列と切り離した写しを返す。不正なら例外を投げる（呼び出し側で、その Rule の失敗になる）。
 * `evidenceRefs` は、重複を除いてコード単位の順に並べる（入力の Evidence の順序が、出力に影響しないようにするため）。
 */
const validateDraft = (draft: unknown, owner: FindingDraftOwner, evidenceIds: ReadonlySet<string>): FindingDraft => {
  if (!isRecord(draft)) {
    throw new TypeError('finding draft must be an object');
  }
  const { ruleId, ruleVersion, category, severity, message, evidenceRefs, identityFields } = draft;
  if (!isNonEmptyString(ruleId)) {
    throw new TypeError('finding draft rule id must be a non-empty string');
  }
  assertDraftRuleIdBelongsToOwner(ruleId, owner);
  if (!isPositiveSafeInteger(ruleVersion)) {
    throw new RangeError('finding draft rule version must be a positive safe integer');
  }
  if (ruleVersion !== owner.version) {
    throw new Error(`finding draft rule version ${ruleVersion} does not match the version ${owner.version} of ${owner.ruleId}`);
  }
  if (!includes(FINDING_CATEGORIES, category)) {
    throw new TypeError('finding draft category is not a finding category');
  }
  if (category !== owner.category) {
    throw new Error(`finding draft category ${category} does not match the category ${owner.category} of ${owner.ruleId}`);
  }
  if (!includes(SEVERITIES, severity)) {
    throw new TypeError('finding draft severity is not a severity');
  }
  if (!isNonEmptyString(message)) {
    throw new TypeError('finding draft message must be a non-empty string');
  }
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    throw new TypeError('finding draft must reference at least one evidence');
  }
  for (const evidenceRef of evidenceRefs as unknown[]) {
    if (typeof evidenceRef !== 'string' || !evidenceIds.has(evidenceRef)) {
      throw new Error(`finding draft references evidence that is not in the input: ${String(evidenceRef)}`);
    }
  }
  if (!Array.isArray(identityFields)) {
    throw new TypeError('finding draft identity fields must be an array');
  }
  const identityCopy = (identityFields as unknown[]).map((field): FindingFingerprintIdentityField => {
    if (!isRecord(field) || typeof field.name !== 'string' || typeof field.value !== 'string') {
      throw new TypeError('finding draft identity field must have a string name and a string value');
    }
    if (field.name === VIEWPORT_IDENTITY_FIELD_NAME) {
      throw new Error(`finding draft identity field name ${VIEWPORT_IDENTITY_FIELD_NAME} is reserved`);
    }
    return { name: field.name, value: field.value };
  });

  return {
    ruleId,
    ruleVersion,
    category,
    severity,
    message,
    evidenceRefs: distinctSorted(evidenceRefs as EvidenceId[]),
    identityFields: identityCopy,
  };
};

const toFinding = (draft: FindingDraft, context: FindingDraftContext, targetId: string): FindingWithoutId => ({
  schemaVersion: 'finding-schema/1.0',
  fingerprint: createFindingFingerprint({
    targetId,
    ruleId: draft.ruleId,
    ruleVersion: draft.ruleVersion,
    normalizedUrl: context.pageUrl,
    identityFields:
      context.viewport === null
        ? draft.identityFields
        : [...draft.identityFields, { name: VIEWPORT_IDENTITY_FIELD_NAME, value: context.viewport }],
  }),
  ruleId: draft.ruleId,
  ruleVersion: draft.ruleVersion,
  category: draft.category,
  severity: draft.severity,
  pageId: context.pageId,
  pageUrl: context.pageUrl,
  viewport: context.viewport,
  message: draft.message,
  evidenceRefs: draft.evidenceRefs,
});

/**
 * Finding の決定論的な順序。severity（`SEVERITIES` の順）、ruleId、fingerprint の順に比べる。
 * それでも同じ場合（同じ Rule が同じ対象の下書きを複数返した場合）は、文言、Evidence の参照の順に比べ、順序を入力に依存させない。
 */
const compareFindings = (left: FindingWithoutId, right: FindingWithoutId): number =>
  SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity)
  || compareCodeUnits(left.ruleId, right.ruleId)
  || compareCodeUnits(left.fingerprint, right.fingerprint)
  || compareCodeUnits(left.message, right.message)
  || compareCodeUnits(left.evidenceRefs.join('\n'), right.evidenceRefs.join('\n'));

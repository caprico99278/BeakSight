// 承認が有効かの判定の唯一の owner（Task 28 の設計書 3 章、4.3、5 章。T28a）。純粋な関数。時計は引数で受ける。
// - 画面の表示、実行の許可の発行と消費、書き込みの前の確かめ直し（Task 30）は、すべて `evaluateApprovalValidity` を通す（同じ判定をほかに
//   書かない。`tests/architecture/approval-ssot.test.ts`）。承認の期限の時刻の計算（`approvalExpiresAtOf`）も、ここだけに置く。
// - 入力: 今のシナリオの版、今の事実（プロファイルの改訂・状態・モード、認証の設定の digest、ターゲットの設定の digest、最後の発見の索引の
//   候補（識別と規則の digest、分類、ドリフト）、入力の規則の参照、照らす READ の定義）、最後の承認の記録と最後の撤回の記録、今の時刻。
// - 出力: `approved: true`（承認の記録の id と、効く期限）か、再承認が要る理由（閉じた一覧 `APPROVAL_INVALIDITY_REASONS`。複数あれば、一覧の順で
//   すべて）。
// - 判定の内訳:
//   - シナリオと今の事実（承認がなくても見る）: 候補（T28a fix round 1。ドリフトの印 `CHANGED` ではなく digest で比べる。比べる相手は、シナリオの
//     候補の 2 つの digest と、承認の記録があれば記録に固定した 2 つの digest。今の索引に同じ識別の digest の候補がない、`MISSING`・
//     `NOT_REVISITED` → `CANDIDATE_MISSING`。規則の digest が違う、分類がシナリオの kind と違う → `CANDIDATE_CHANGED`。ドリフトが `CHANGED`・`NEW`
//     でも、digest と分類が同じなら受ける（承認の後にもう一度発見しなくても使える））、
//     入力の規則の参照（シナリオの参照と今の参照が違う → `INPUT_RULES_CHANGED`）、照らす READ の定義（同じプロファイルにない・取り消した・版が
//     違う → `READ_CHECK_CHANGED`。T30a: 検証の指定の照合の READ の定義も同じ）、プロファイルの状態（`PROFILE_RETIRED`）とモード（`TEST_APPROVED_WRITE` でない → `MODE_NOT_WRITE`）。
//   - 承認の記録（ないときは `NOT_APPROVED` だけ）: シナリオの版、プロファイルの改訂、認証の設定、ターゲットの設定、入力の規則の参照（記録に
//     縛った値と今の値）、期限（記録の期限と、承認した版の日数から求めた期限の早い方。ちょうど期限の時刻は期限切れ）、撤回（最後の承認を
//     対象とする撤回の記録 → `REVOKED`）。承認の digest を今の値で求め直し、記録と違うのに縛った値がどれも同じとき（記録の書き換え）は、
//     `SCENARIO_REVISION_CHANGED` とする（fail-closed）。
// - T31b（Task 31 の設計書 3 章の「型にした識別の digest」、11 章の T31b の Blocker の判断（案 D））: kind が `UPDATE` のシナリオは、候補の識別の digest
//   の代わりに、UPDATE の指定の型にした識別の digest で候補を確かめる（今の `CREATE` の判定は変えない）。事実は「最後の発見の索引の候補ごとの、型に
//   した識別の digest の一覧と規則の digest と分類とドリフト」（`templatedCandidates`）。一覧のどれかに同じ digest を持ち、`MISSING`・`NOT_REVISITED`
//   でない候補がない → `CANDIDATE_MISSING`。そのどれも、規則の digest（シナリオと承認の記録の両方）と分類（UPDATE）が合わない → `CANDIDATE_CHANGED`
//   （別のレコードの画面の候補でも、合うものが 1 つあれば受ける）。承認の記録の識別の digest は、シナリオの候補の識別の digest と同じであること（違えば
//   `CANDIDATE_MISSING`）。事実がまだ集められない（null。管理データの版 9 の前）→ `CANDIDATE_TEMPLATES_UNAVAILABLE`（止める側）。UPDATE の指定の
//   ない保存済みの版 → `UPDATE_SPEC_MISSING`。
// - 呼び出し側の誤り（別のプロファイルの事実、別のシナリオ・プロファイルの記録、不正な時刻）は `RangeError`。
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import type { AuditMode } from '../contracts.js';
import type { DiscoveryCandidateIndexView } from '../job/discovery-index-store.js';
import type { CandidateClassification } from '../../discovery/candidate-contracts.js';
import type { ProfileStatus } from '../store/profile-records.js';
import { computeApprovalDigest } from './approval-digest.js';
import {
  APPROVAL_TTL_DAY_MS,
  MIN_APPROVAL_TTL_DAYS,
  WRITE_AUDIT_MODE,
  type ApprovalReceipt,
  type InputRuleReference,
  type RevocationReceipt,
  type ScenarioReadCheckFact,
  type ScenarioRevision,
} from './scenario-contracts.js';

/**
 * 再承認が要る理由（閉じた一覧。判定の結果は、この順で並べる）。
 * - `SCENARIO_REVISION_CHANGED`: シナリオの版が、承認した版と違う（承認の記録の書き換えを含む）。
 * - `PROFILE_REVISION_CHANGED`: プロファイルの改訂が、承認の時と違う（どの編集でも）。
 * - `AUTH_SETUP_CHANGED`・`TARGET_CONFIG_CHANGED`: 認証の設定・ターゲットの設定の digest が、承認の時と違う。
 * - `CANDIDATE_CHANGED`: 最後の発見の候補の規則の digest が、シナリオか承認に固定したものと違う、または分類がシナリオの kind と違う。
 * - `CANDIDATE_MISSING`: 最後の発見で、候補を確かめられない（同じ識別の digest の候補が索引にない、`MISSING`、`NOT_REVISITED`）。T31b: UPDATE は、
 *   型にした識別の digest で同じことを確かめる。
 * - `UPDATE_SPEC_MISSING`: UPDATE のシナリオの版に UPDATE の指定がない（UPDATE の指定の前に保存した版。T31b）。
 * - `CANDIDATE_TEMPLATES_UNAVAILABLE`: UPDATE のシナリオで、最後の発見の索引の型にした識別の digest の一覧を、まだ集められない（管理データの版 9 の
 *   前。T31b）。
 * - `INPUT_RULES_CHANGED`: 入力の規則の参照（id、版、digest）が変わった。
 * - `READ_CHECK_CHANGED`: 照らす READ の定義が変わった（ない、取り消した、版が違う）。
 * - `EXPIRED`: 承認の期限を過ぎた（ちょうど期限の時刻を含む）。
 * - `REVOKED`: 最後の承認が撤回された。
 * - `NOT_APPROVED`: 承認の記録がない。
 * - `PROFILE_RETIRED`: プロファイルを取り消した。
 * - `MODE_NOT_WRITE`: プロファイルのモードが書き込みのモード（`TEST_APPROVED_WRITE`）でない。
 */
export const APPROVAL_INVALIDITY_REASONS = Object.freeze([
  'SCENARIO_REVISION_CHANGED',
  'PROFILE_REVISION_CHANGED',
  'AUTH_SETUP_CHANGED',
  'TARGET_CONFIG_CHANGED',
  'CANDIDATE_CHANGED',
  'CANDIDATE_MISSING',
  'UPDATE_SPEC_MISSING',
  'CANDIDATE_TEMPLATES_UNAVAILABLE',
  'INPUT_RULES_CHANGED',
  'READ_CHECK_CHANGED',
  'EXPIRED',
  'REVOKED',
  'NOT_APPROVED',
  'PROFILE_RETIRED',
  'MODE_NOT_WRITE',
] as const);
export type ApprovalInvalidityReason = (typeof APPROVAL_INVALIDITY_REASONS)[number];

/** プロファイルの今の事実。 */
export interface ApprovalProfileFact {
  readonly profileId: string;
  /** 今の改訂（`profile_revisions`）。 */
  readonly revision: number;
  readonly status: ProfileStatus;
  readonly mode: AuditMode;
}

/** 最後の発見の索引の、シナリオの候補の識別の digest の行（`readDiscoveryIndex` の候補 1 件から、要る項目だけ）。 */
export type ApprovalCandidateFact = Pick<DiscoveryCandidateIndexView, 'identityDigest' | 'ruleDigest' | 'classification' | 'drift'>;

/**
 * 最後の発見の索引の候補 1 件の、型にした識別の digest の一覧と、規則の digest・分類・ドリフト（T31b。一覧は、索引に入れるときに親が
 * `fingerprint.ts` の `templatedIdentityDigestsOf` で求める。索引の読み出しは版 9（T31e））。
 */
export interface ApprovalTemplatedCandidateFact {
  readonly templatedIdentityDigests: readonly string[];
  readonly ruleDigest: string;
  readonly classification: CandidateClassification;
  readonly drift: ApprovalCandidateFact['drift'];
}

/** 今の事実。 */
export interface ApprovalCurrentFacts {
  readonly profile: ApprovalProfileFact;
  readonly authSetupDigest: string | null;
  readonly targetConfigDigest: string;
  /** 最後の発見の索引の、シナリオの候補の行（索引になければ null）。 */
  readonly candidate: ApprovalCandidateFact | null;
  /**
   * 最後の発見の索引の候補ごとの、型にした識別の digest の一覧（T31b。UPDATE のシナリオだけが使う）。まだ集められなければ null（UPDATE を
   * 止める側にする）。
   */
  readonly templatedCandidates: readonly ApprovalTemplatedCandidateFact[] | null;
  /** 入力の規則の今の参照（規則の集まりの今の版と digest。参照がなければ null）。 */
  readonly inputRuleReference: InputRuleReference | null;
  /** 照らす READ の定義の今の事実（プロファイルの定義の一覧。シナリオが参照しない定義を含んでよい）。 */
  readonly readChecks: readonly ScenarioReadCheckFact[];
}

/** 判定の入力。 */
export interface ApprovalValidityInput {
  readonly scenario: ScenarioRevision;
  readonly facts: ApprovalCurrentFacts;
  /** シナリオの最後の承認の記録（なければ null）。 */
  readonly lastApproval: ApprovalReceipt | null;
  /** シナリオの最後の撤回の記録（なければ null）。対象が最後の承認でなければ、見ない。 */
  readonly lastRevocation: RevocationReceipt | null;
  readonly now: Date;
}

/** 判定の結果（凍結）。 */
export type ApprovalValidity =
  | { readonly approved: true; readonly receiptId: string; readonly expiresAt: string }
  | { readonly approved: false; readonly reasons: readonly ApprovalInvalidityReason[] };

// ---------------------------------------------------------------------------------------------------------------
// 期限
// ---------------------------------------------------------------------------------------------------------------

/**
 * 承認の期限の時刻（承認の時刻 + 期限の日数。UTC の 14 桁）。承認の記録を書く部品と、判定がここを使う。承認の時刻の形が違う、日数が最小より
 * 小さいか整数でなければ `RangeError`。
 */
export const approvalExpiresAtOf = (approvedAt: string, ttlDays: number): string => {
  if (!Number.isSafeInteger(ttlDays) || ttlDays < MIN_APPROVAL_TTL_DAYS) {
    throw new RangeError(`the approval TTL must be an integer of at least ${MIN_APPROVAL_TTL_DAYS} days`);
  }
  const approvedTime = dateOfCompactUtcTimestamp(approvedAt).getTime();
  return formatCompactUtcTimestamp(new Date(approvedTime + ttlDays * APPROVAL_TTL_DAY_MS), 'approval expiry time');
};

/** 効く期限の時刻（記録の期限と、承認した版の日数から求めた期限の早い方。fail-closed）。 */
const effectiveExpiresAtOf = (approval: ApprovalReceipt, scenario: ScenarioRevision): string => {
  const computed = approvalExpiresAtOf(approval.approvedAt, scenario.approvalTtlDays);
  return dateOfCompactUtcTimestamp(approval.expiresAt).getTime() <= dateOfCompactUtcTimestamp(computed).getTime() ? approval.expiresAt : computed;
};

/** 期限切れか（ちょうど期限の時刻は期限切れ）。 */
const isExpired = (approval: ApprovalReceipt, scenario: ScenarioRevision, now: Date): boolean =>
  now.getTime() >= dateOfCompactUtcTimestamp(effectiveExpiresAtOf(approval, scenario)).getTime();

// ---------------------------------------------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------------------------------------------

/** 入力の規則の参照が同じか（null どうしは同じ）。 */
const sameInputRules = (left: InputRuleReference | null, right: InputRuleReference | null): boolean =>
  left === null || right === null
    ? left === right
    : left.ruleSetId === right.ruleSetId && left.revision === right.revision && left.digest === right.digest;

/** 候補を確かめられない印のドリフトか。 */
const isUnconfirmedDrift = (drift: ApprovalCandidateFact['drift']): boolean => drift === 'MISSING' || drift === 'NOT_REVISITED';

/**
 * 候補の理由。比べる相手は、シナリオの候補の 2 つの digest と、承認の記録があれば記録に固定した 2 つの digest（どちらとも同じであること）。
 * ドリフトは、候補を確かめられない印（`MISSING`・`NOT_REVISITED`）だけを見る。
 */
const candidateReasonsOf = (
  scenario: ScenarioRevision,
  candidate: ApprovalCandidateFact | null,
  approval: ApprovalReceipt | null,
): readonly ApprovalInvalidityReason[] => {
  const identityDigests = [scenario.candidate.identityDigest, ...(approval === null ? [] : [approval.bound.candidateIdentityDigest])];
  const ruleDigests = [scenario.candidate.ruleDigest, ...(approval === null ? [] : [approval.bound.candidateRuleDigest])];
  if (candidate === null || identityDigests.some((digest) => digest !== candidate.identityDigest) || isUnconfirmedDrift(candidate.drift)) {
    return ['CANDIDATE_MISSING'];
  }
  return ruleDigests.some((digest) => digest !== candidate.ruleDigest) || candidate.classification !== scenario.kind ? ['CANDIDATE_CHANGED'] : [];
};

/**
 * シナリオの参照する READ の定義（照らす READ の定義と、T30a の検証の指定の照合の READ）が、今も同じプロファイルの、取り消していない、同じ版の
 * 定義か。
 */
const readChecksUnchanged = (scenario: ScenarioRevision, readChecks: readonly ScenarioReadCheckFact[]): boolean => {
  const verificationRead = scenario.verification.readVerification;
  const references = verificationRead === null ? scenario.readChecks : [...scenario.readChecks, verificationRead];
  return references.every(({ readCheckId, revision }) => readChecks.some((fact) => fact.readCheckId === readCheckId
    && fact.profileId === scenario.profileId && fact.canceledAt === null && fact.revision === revision));
};

/**
 * UPDATE のシナリオの候補の理由（T31b）。型にした識別の digest を一覧に持つ、確かめられる候補のうち、規則の digest（シナリオと承認の記録の両方）と
 * 分類が合うものが 1 つあれば受ける。
 */
const updateCandidateReasonsOf = (
  scenario: ScenarioRevision,
  templatedCandidates: readonly ApprovalTemplatedCandidateFact[] | null,
  approval: ApprovalReceipt | null,
): readonly ApprovalInvalidityReason[] => {
  const { update } = scenario;
  if (update === null) {
    return ['UPDATE_SPEC_MISSING'];
  }
  if (templatedCandidates === null) {
    return ['CANDIDATE_TEMPLATES_UNAVAILABLE'];
  }
  const ruleDigests = [scenario.candidate.ruleDigest, ...(approval === null ? [] : [approval.bound.candidateRuleDigest])];
  const found = templatedCandidates.filter((candidate) => candidate.templatedIdentityDigests.includes(update.templatedIdentityDigest)
    && !isUnconfirmedDrift(candidate.drift));
  if (found.length === 0 || (approval !== null && approval.bound.candidateIdentityDigest !== scenario.candidate.identityDigest)) {
    return ['CANDIDATE_MISSING'];
  }
  return found.some((candidate) => ruleDigests.every((digest) => digest === candidate.ruleDigest) && candidate.classification === scenario.kind)
    ? []
    : ['CANDIDATE_CHANGED'];
};

/** シナリオと今の事実の理由（承認の記録がなくても見る。候補は、承認の記録があれば記録に固定した digest とも比べる）。 */
const scenarioReasonsOf = (
  scenario: ScenarioRevision,
  facts: ApprovalCurrentFacts,
  approval: ApprovalReceipt | null,
): readonly ApprovalInvalidityReason[] => [
  ...(scenario.kind === 'UPDATE'
    ? updateCandidateReasonsOf(scenario, facts.templatedCandidates, approval)
    : candidateReasonsOf(scenario, facts.candidate, approval)),
  ...(sameInputRules(scenario.inputRuleReference, facts.inputRuleReference) ? [] : ['INPUT_RULES_CHANGED' as const]),
  ...(readChecksUnchanged(scenario, facts.readChecks) ? [] : ['READ_CHECK_CHANGED' as const]),
  ...(facts.profile.status === 'RETIRED' ? ['PROFILE_RETIRED' as const] : []),
  ...(facts.profile.mode === WRITE_AUDIT_MODE ? [] : ['MODE_NOT_WRITE' as const]),
];

/** 承認の記録の理由。 */
const approvalReasonsOf = (input: ApprovalValidityInput, approval: ApprovalReceipt): readonly ApprovalInvalidityReason[] => {
  const { scenario, facts, lastRevocation, now } = input;
  const { bound } = approval;
  const bindingReasons: ApprovalInvalidityReason[] = [
    ...(approval.scenarioRevision === scenario.revision ? [] : ['SCENARIO_REVISION_CHANGED' as const]),
    ...(bound.profileRevision === facts.profile.revision ? [] : ['PROFILE_REVISION_CHANGED' as const]),
    ...(bound.authSetupDigest === facts.authSetupDigest ? [] : ['AUTH_SETUP_CHANGED' as const]),
    ...(bound.targetConfigDigest === facts.targetConfigDigest ? [] : ['TARGET_CONFIG_CHANGED' as const]),
    ...(sameInputRules(bound.inputRuleReference, facts.inputRuleReference) && sameInputRules(bound.inputRuleReference, scenario.inputRuleReference)
      ? []
      : ['INPUT_RULES_CHANGED' as const]),
  ];
  const digest = computeApprovalDigest(scenario, {
    profileRevision: facts.profile.revision,
    authSetupDigest: facts.authSetupDigest,
    targetConfigDigest: facts.targetConfigDigest,
  });
  const tampered = bindingReasons.length === 0 && digest !== approval.approvalDigest ? ['SCENARIO_REVISION_CHANGED' as const] : [];
  return [
    ...bindingReasons,
    ...tampered,
    ...(isExpired(approval, scenario, now) ? ['EXPIRED' as const] : []),
    ...(lastRevocation !== null && lastRevocation.targetReceiptId === approval.receiptId ? ['REVOKED' as const] : []),
  ];
};

/** 呼び出し側の誤りを確かめる。 */
const assertConsistentInput = (input: ApprovalValidityInput): void => {
  const { scenario, facts, lastApproval, lastRevocation, now } = input;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('the clock must be a valid Date');
  }
  if (facts.profile.profileId !== scenario.profileId) {
    throw new RangeError('the facts are not of the profile of the scenario');
  }
  for (const receipt of [lastApproval, lastRevocation]) {
    if (receipt !== null && (receipt.scenarioId !== scenario.scenarioId || receipt.profileId !== scenario.profileId)) {
      throw new RangeError(`the ${receipt.kind.toLowerCase()} receipt is not of the scenario`);
    }
  }
};

/** 承認が今も有効かを判定する（純粋。入力を変えない）。 */
export const evaluateApprovalValidity = (input: ApprovalValidityInput): ApprovalValidity => {
  assertConsistentInput(input);
  const { lastApproval } = input;
  const found = new Set<ApprovalInvalidityReason>([
    ...scenarioReasonsOf(input.scenario, input.facts, lastApproval),
    ...(lastApproval === null ? ['NOT_APPROVED' as const] : approvalReasonsOf(input, lastApproval)),
  ]);
  if (found.size === 0 && lastApproval !== null) {
    return Object.freeze({ approved: true, receiptId: lastApproval.receiptId, expiresAt: effectiveExpiresAtOf(lastApproval, input.scenario) });
  }
  return Object.freeze({ approved: false, reasons: Object.freeze(APPROVAL_INVALIDITY_REASONS.filter((reason) => found.has(reason))) });
};

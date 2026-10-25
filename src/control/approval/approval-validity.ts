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
//   `CANDIDATE_MISSING`）。事実がまだ集められない（null。管理データの版 9 の前）→ `CANDIDATE_TEMPLATES_UNAVAILABLE`（止める側）。
//   LG-3（2026-10-24 のテストの組の設計 3.7.2）: UPDATE の指定のない版の理由 `UPDATE_SPEC_MISSING` は捨てた（その版は保存の部品が読まない）。渡されたら
//   呼び出し側の誤り（`RangeError`）。
// - T38c（Task 38 の設計書 3.3、T38d の申し送り）: 送り方が `API` のシナリオは、kind によらず、分類と kind の一致の代わりに、最後の発見の索引の候補の
//   型の digest の一覧（`candidateShapeDigests`。`scenario-facts.ts` の `candidateShapeDigestsOf`。管理データの版 13）に、シナリオの型の digest
//   （`api.shapeDigest`）が含まれることを見る。候補の識別・`MISSING`・`NOT_REVISITED`（→ `CANDIDATE_MISSING`）と規則の digest（→ `CANDIDATE_CHANGED`）は
//   FORM と同じ。含まれない・型のない候補 → `CANDIDATE_SHAPE_CHANGED`、一覧がない（版 13 の前に書いた行で、その後に発見していない）→
//   `CANDIDATE_SHAPES_UNAVAILABLE`（発見のやり直しが要る。止める側）。型の違いは索引のドリフトに数えないので、ここで照らす。API の UPDATE は型にした
//   識別の digest を持たない（T38b の契約）ので、その記録の画面を次の発見で読み直さないと `CANDIDATE_MISSING`（限界。Task 41 で扱う）。
//   v3 の承認の digest の記録は、v4 で求め直した digest と違うので、縛った値がどれも同じなら `SCENARIO_REVISION_CHANGED`（再承認が要る）。
// - T41a（Task 41 の設計書 3.1）: API の UPDATE は、画面の path を型にした識別の digest（`api.templatedIdentityDigest`）が最新の索引の型にした digest の
//   一覧にあることで候補を確かめる（form の UPDATE と同じ。`apiUpdateCandidateReasonsOf`）。当たった候補の行の型の digest と鍵と欄の対応の digest
//   （目印の付いた欄の鍵の全体 `scenarioApiMarkedKeyFieldsOf`。変える鍵と保つ鍵）を照らす。Origin と最新の発見の改訂は登録と同じ。
// - 呼び出し側の誤り（別のプロファイルの事実、別のシナリオ・プロファイルの記録、不正な時刻）は `RangeError`。
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import { isOriginInAllowedOrigins } from '../../crawl/normalize-url.js';
import type { AuditMode } from '../contracts.js';
import type { DiscoveryCandidateIndexView } from '../job/discovery-index-store.js';
import type { CandidateClassification } from '../../discovery/candidate-contracts.js';
import {
  APPROVAL_INVALIDITY_REASONS,
  EXPIRED_INVALIDITY_REASON,
  NOT_APPROVED_INVALIDITY_REASON,
  REVOKED_INVALIDITY_REASON,
  type ApprovalInvalidityReason,
} from '../../core/approval-invalidity-reasons.js';
import { RETIRED_PROFILE_STATUS, type ProfileStatus } from '../store/profile-records.js';
import { computeApprovalDigest } from './approval-digest.js';
import {
  APPROVAL_TTL_DAY_MS,
  MIN_APPROVAL_TTL_DAYS,
  WRITE_AUDIT_MODE,
  apiKeyFieldsDigestOf,
  scenarioApiMarkedKeyFieldsOf,
  scenarioTransportOf,
  API_SCENARIO_TRANSPORT,
  type ApprovalReceipt,
  type InputRuleReference,
  type RevocationReceipt,
  type ScenarioReadCheckFact,
  type ScenarioRevision,
} from './scenario-contracts.js';

/**
 * 再承認が要る理由（閉じた一覧。判定の結果は、この順で並べる）。PRE42-CC 組 UI-K3（台帳の CC-113）: 一覧の値と意味は、画面のブラウザ側からも読める
 * 純粋なファイル `src/core/approval-invalidity-reasons.ts` に移し、ここは同じ名前で公開し直す（判定はここのまま。Gate `approval-ssot` の (a)）。
 */
export {
  APPROVAL_INVALIDITY_REASONS,
  EXPIRED_INVALIDITY_REASON,
  NOT_APPROVED_INVALIDITY_REASON,
  REVOKED_INVALIDITY_REASON,
  type ApprovalInvalidityReason,
};

/** プロファイルの今の事実。 */
export interface ApprovalProfileFact {
  readonly profileId: string;
  /** 今の改訂（`profile_revisions`）。 */
  readonly revision: number;
  readonly status: ProfileStatus;
  readonly mode: AuditMode;
  /** T38R-fix の C-2: 今の承認したサービスの Origin（プロファイルの一覧の順）。 */
  readonly approvedServiceOrigins: readonly string[];
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
  /**
   * T41a: その候補の型の digest の一覧と、鍵と欄の対応の digest の一覧（API の UPDATE だけが使う。版 13 の前の行・事実を持たない文脈は null か省く。
   * 省けば止める側の `CANDIDATE_SHAPES_UNAVAILABLE`）。
   */
  readonly shapeDigests?: readonly string[] | null;
  readonly keyFieldDigests?: readonly string[] | null;
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
  /**
   * 最後の発見の索引の、シナリオの候補の型の digest の一覧（T38c。API のシナリオだけが使う）。候補がないか、一覧を持たない（管理データの版 13 の前の
   * 行）なら null。型のない候補は空。
   */
  readonly candidateShapeDigests: readonly string[] | null;
  /**
   * 最後の発見の索引の、シナリオの候補の鍵と欄の対応の digest の一覧（T38R-fix の I-1。API のシナリオだけが使う）。候補がないか、一覧を持たない行
   * なら null。
   */
  readonly candidateKeyFieldDigests: readonly string[] | null;
  /** シナリオの版の発見の根拠の、型の Origin の番号（T38R-fix の C-2。API のシナリオだけが使う。分からなければ null）。 */
  readonly apiShapeOriginIndex: number | null;
  /** 索引を書いた最新の発見のジョブのプロファイルの改訂（T38R-fix の C-2。API のシナリオだけが使う。分からなければ null）。 */
  readonly latestDiscoveryProfileRevision: number | null;
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
    // LG-3: form の UPDATE の版は、スキーマで UPDATE の指定を必ず持つ（指定のない前の形は、保存の部品が読まない）。
    throw new RangeError('a form UPDATE scenario revision must have the UPDATE spec');
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

/**
 * API のシナリオの候補の理由（T38c）。候補の識別とドリフトと規則の digest は FORM の CREATE と同じに比べ、分類と kind の一致の代わりに、候補の型の
 * digest の一覧にシナリオの型の digest があることを見る。
 */
const apiCandidateReasonsOf = (
  scenario: ScenarioRevision,
  facts: ApprovalCurrentFacts,
  approval: ApprovalReceipt | null,
): readonly ApprovalInvalidityReason[] => {
  const found = scenario.kind === 'UPDATE' ? apiUpdateCandidateReasonsOf(scenario, facts.templatedCandidates, approval) : apiCreateCandidateReasonsOf(scenario, facts, approval);
  if (!found.ok) {
    return found.reasons;
  }
  const { api } = scenario;
  const { apiShapeOriginIndex, latestDiscoveryProfileRevision, profile } = facts;
  // T38R-fix の C-2: 型の Origin の番号の位置に、シナリオの Origin が今もあること。索引を書いた発見の改訂が今の改訂であること。
  // Origin の比べ方は、URL の意味の owner（`src/crawl/normalize-url.ts`）の部品に任せる（GATE-ARCH04）。
  const approvedAtIndex = apiShapeOriginIndex === null ? undefined : profile.approvedServiceOrigins[apiShapeOriginIndex];
  const originApproved = api !== undefined && approvedAtIndex !== undefined && isOriginInAllowedOrigins([approvedAtIndex], api.request.origin);
  return [
    ...found.reasons,
    ...(originApproved ? [] : ['API_ORIGIN_NOT_APPROVED' as const]),
    ...(latestDiscoveryProfileRevision === profile.revision ? [] : ['API_DISCOVERY_PROFILE_STALE' as const]),
  ];
};

/** 候補を確かめられたか（`ok: false` は、ほかの理由を見ない候補の理由）と、その候補の規則の digest と型の理由。 */
type ApiCandidateFinding = { readonly ok: boolean; readonly reasons: readonly ApprovalInvalidityReason[] };

/**
 * 1 つの候補の型の理由（T38c・T38R-fix の I-1）: 一覧がない → `CANDIDATE_SHAPES_UNAVAILABLE`、シナリオの型の digest がない → `CANDIDATE_SHAPE_CHANGED`、
 * 型は同じでも鍵と欄の対応（目印の付いた欄の鍵の全体。T41a: UPDATE は変える鍵と保つ鍵を合わせる）が違う → `CANDIDATE_FIELDS_CHANGED`。
 */
const apiShapeReasonsOf = (
  api: ScenarioRevision['api'],
  shapeDigests: readonly string[] | null,
  keyFieldDigests: readonly string[] | null,
): readonly ApprovalInvalidityReason[] => {
  if (shapeDigests === null || keyFieldDigests === null) {
    return ['CANDIDATE_SHAPES_UNAVAILABLE'];
  }
  if (api === undefined || !shapeDigests.includes(api.shapeDigest)) {
    return ['CANDIDATE_SHAPE_CHANGED'];
  }
  return keyFieldDigests.includes(apiKeyFieldsDigestOf(api.shapeDigest, scenarioApiMarkedKeyFieldsOf(api))) ? [] : ['CANDIDATE_FIELDS_CHANGED'];
};

/** API の登録の候補（T38c）: 候補の識別とドリフトと規則の digest は FORM の CREATE と同じに比べ、型はシナリオの候補の行の一覧で見る。 */
const apiCreateCandidateReasonsOf = (
  scenario: ScenarioRevision,
  facts: ApprovalCurrentFacts,
  approval: ApprovalReceipt | null,
): ApiCandidateFinding => {
  const { candidate } = facts;
  const identityDigests = [scenario.candidate.identityDigest, ...(approval === null ? [] : [approval.bound.candidateIdentityDigest])];
  const ruleDigests = [scenario.candidate.ruleDigest, ...(approval === null ? [] : [approval.bound.candidateRuleDigest])];
  if (candidate === null || identityDigests.some((digest) => digest !== candidate.identityDigest) || isUnconfirmedDrift(candidate.drift)) {
    return { ok: false, reasons: ['CANDIDATE_MISSING'] };
  }
  return {
    ok: true,
    reasons: [
      ...(ruleDigests.some((digest) => digest !== candidate.ruleDigest) ? ['CANDIDATE_CHANGED' as const] : []),
      ...apiShapeReasonsOf(scenario.api, facts.candidateShapeDigests, facts.candidateKeyFieldDigests),
    ],
  };
};

/**
 * API の更新の候補（T41a。Task 41 の設計書 3.1）: 画面の path を型にした識別の digest（`api.templatedIdentityDigest`）を一覧に持つ、確かめられる候補で
 * 確かめる（form の UPDATE と同じ考え。probe したレコードの画面を次の発見で読み直さなくても、別のレコードの同じ型の画面の候補で受ける）。digest がない
 * （T41a の前に保存した版。LG-3 でスキーマが拒む）→ `RangeError`、一覧がまだない → `CANDIDATE_TEMPLATES_UNAVAILABLE`、当たる候補がない・承認の記録の識別の digest が
 * シナリオと違う → `CANDIDATE_MISSING`。当たる候補のうち、規則の digest（シナリオと承認の記録の両方）と型の理由がいちばん少ないものの理由を返す。
 */
const apiUpdateCandidateReasonsOf = (
  scenario: ScenarioRevision,
  templatedCandidates: readonly ApprovalTemplatedCandidateFact[] | null,
  approval: ApprovalReceipt | null,
): ApiCandidateFinding => {
  const templated = scenario.api?.templatedIdentityDigest;
  if (templated === undefined) {
    // LG-3: API の UPDATE の版は、スキーマで型にした識別の digest を必ず持つ（T41a の前の形は、保存の部品が読まない）。
    throw new RangeError('an API UPDATE scenario revision must have the templated identity digest');
  }
  if (templatedCandidates === null) {
    return { ok: false, reasons: ['CANDIDATE_TEMPLATES_UNAVAILABLE'] };
  }
  const ruleDigests = [scenario.candidate.ruleDigest, ...(approval === null ? [] : [approval.bound.candidateRuleDigest])];
  const found = templatedCandidates.filter((candidate) => candidate.templatedIdentityDigests.includes(templated) && !isUnconfirmedDrift(candidate.drift));
  if (found.length === 0 || (approval !== null && approval.bound.candidateIdentityDigest !== scenario.candidate.identityDigest)) {
    return { ok: false, reasons: ['CANDIDATE_MISSING'] };
  }
  const reasonsByCandidate = found.map((candidate): readonly ApprovalInvalidityReason[] => [
    ...(ruleDigests.some((digest) => digest !== candidate.ruleDigest) ? ['CANDIDATE_CHANGED' as const] : []),
    ...apiShapeReasonsOf(scenario.api, candidate.shapeDigests ?? null, candidate.keyFieldDigests ?? null),
  ]);
  const fewest = reasonsByCandidate.reduce((best, reasons) => (reasons.length < best.length ? reasons : best));
  return { ok: true, reasons: fewest };
};

/** 送り方と kind ごとの候補の理由（T38c: API のシナリオは型の digest。FORM の UPDATE は型にした識別の digest、FORM の CREATE は識別の digest）。 */
const candidateReasonsByTransportOf = (
  scenario: ScenarioRevision,
  facts: ApprovalCurrentFacts,
  approval: ApprovalReceipt | null,
): readonly ApprovalInvalidityReason[] => {
  if (scenarioTransportOf(scenario) === API_SCENARIO_TRANSPORT) {
    return apiCandidateReasonsOf(scenario, facts, approval);
  }
  return scenario.kind === 'UPDATE'
    ? updateCandidateReasonsOf(scenario, facts.templatedCandidates, approval)
    : candidateReasonsOf(scenario, facts.candidate, approval);
};

/** シナリオと今の事実の理由（承認の記録がなくても見る。候補は、承認の記録があれば記録に固定した digest とも比べる）。 */
const scenarioReasonsOf = (
  scenario: ScenarioRevision,
  facts: ApprovalCurrentFacts,
  approval: ApprovalReceipt | null,
): readonly ApprovalInvalidityReason[] => [
  ...candidateReasonsByTransportOf(scenario, facts, approval),
  ...(sameInputRules(scenario.inputRuleReference, facts.inputRuleReference) ? [] : ['INPUT_RULES_CHANGED' as const]),
  ...(readChecksUnchanged(scenario, facts.readChecks) ? [] : ['READ_CHECK_CHANGED' as const]),
  ...(facts.profile.status === RETIRED_PROFILE_STATUS ? ['PROFILE_RETIRED' as const] : []),
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
    ...(isExpired(approval, scenario, now) ? [EXPIRED_INVALIDITY_REASON] as const : []),
    ...(lastRevocation !== null && lastRevocation.targetReceiptId === approval.receiptId ? [REVOKED_INVALIDITY_REASON] as const : []),
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
    ...(lastApproval === null ? [NOT_APPROVED_INVALIDITY_REASON] as const : approvalReasonsOf(input, lastApproval)),
  ]);
  if (found.size === 0 && lastApproval !== null) {
    return Object.freeze({ approved: true, receiptId: lastApproval.receiptId, expiresAt: effectiveExpiresAtOf(lastApproval, input.scenario) });
  }
  return Object.freeze({ approved: false, reasons: Object.freeze(APPROVAL_INVALIDITY_REASONS.filter((reason) => found.has(reason))) });
};

// 管理データの版 6 の表（`scenarios`、`scenario_revisions`、`approval_receipts`、`execution_grants`、`write_reservations`）の読み書きの唯一の owner
// （Task 28 の設計書 3 章、4.1、4.2、4.4、4.7、10 章の 1・3・4。T28c、T28d）。手本は `src/control/job/read-check-store.ts`。
// - T28d の Blocker の判断（案 A）: 版 6 の表に書く SQL は、このファイルだけに置く（Architecture Gate `control-store-boundary.test.ts` の (l)）。
//   トランザクションの中で使う書き込みの関数は、ファイルの間で受け渡せない（同じ Gate の (g)）ので、撤回と許可の無効化のように 1 つの
//   トランザクションで複数の表に書く口は、このファイルの中で組み立てる。許可と予約の純粋な決まり（理由の一覧、遷移の表、期限、上限と残り、同時実行の
//   枠）は `execution-grant.ts`、行の読み出しと今の事実の集め方は `scenario-facts.ts`（読むだけ）に置き、ここから使う。
// - ファイルの中は 4 つの節に分ける: 「シナリオ」（作成・版の更新・入力の規則の参照・読み出し）、「承認と撤回」（承認・撤回・記録と状態の読み出し）、
//   「許可と予約」（発行・消費・確かめ直し・予約の状態の変更・読み出し）、「書き込みの結果」（T30d。管理データの版 8 の `write_results` の記録と締め、
//   起動のときの回復）。各節の先頭に、その節の決まりを書く。
// - T30d: 書き込みの結果の表に書く SQL も、このファイルだけに置く（予約の締め（版 6 の表）と同じトランザクションで書くため。Architecture Gate
//   `control-store-boundary.test.ts` の (l)(m)）。行の読み方と読み出しは `src/control/actions/write-result-facts.ts`（読むだけ）。
// - 書き込みは、すべて `withWriteTransaction`（`BEGIN IMMEDIATE`）の中で、確かめ直してから書く。読むだけの関数は `withReadTransaction` を通す。
//   生の接続を直接参照しない（同じ Gate の (f)(g)）。書き込みのロックを待ち切れなければ、今の管理データの決めのまま `ControlStoreError`
//   （`DATABASE_LOCKED`）で止める（やり直さない）。時計は注入する（書く時刻 `at`、判定の時刻 `now`。14 桁の UTC）。
// - 今の事実（`scenario-facts.ts`）: プロファイル、照らす READ の定義、最後の発見の索引（書くトランザクションの前に読み、中で「その後に発見のジョブが
//   記録されていない」ことを確かめ直す。記録されていれば `…_FACTS_CHANGED`）、入力の規則の今の参照（T29d: 規則の集まりの最新の版）。認証の
//   設定の digest とターゲットの設定の digest は、呼び出し側が求めて渡す（`ApprovalExternalFacts`）。
// - 秘密: 写しと記録は、契約の形（`scenario`・`approval-receipt`・`candidate` のスキーマ）を確かめてから書く。入力の値・トークン・hidden の値・選択肢の
//   label・資格情報の口はない（設計書 4.7）。外の事実は 2 つの digest だけを写す。
// - 呼び出し側の誤り（形の違う ID・時刻・digest・件数・状態、使った ID、前の時刻、契約の形に合わない候補）は、書く前に `RangeError`。
import { isSha256Fingerprint } from '../../core/ids.js';
import { deepFreeze } from '../../core/immutable.js';
import { jsonCopyOf } from '../../core/json-copy.js';
import { isNonNegativeSafeInteger, isRecord } from '../../core/guards.js';
import { MAX_FIELD_NAME_LENGTH } from '../../discovery/candidate-contracts.js';
import { READ_CHECK_RESULTS, type ReadCheckResult } from '../../discovery/read-check-contracts.js';
import {
  ACTION_BLOCK_REASONS,
  MAX_HTTP_STATUS,
  MAX_SUBMITTED_VALUE_LENGTH,
  MIN_HTTP_STATUS,
  NOT_SENT_SUBMISSION_STATE,
  RESPONSE_JUDGEMENTS,
  SUBMISSION_STATES,
  type ActionBlockReason,
  type ActionOutcomeInput,
  type ActionOutcomeUpdateInput,
  type ResponseJudgement,
  type SubmissionState,
  type WriteUpdateEvidence,
} from '../actions/action-contracts.js';
import { actionOutcomeOf, fieldsMatchedOf, isUsableRecordId, reservationSettlementOf, usableRecordIdOf } from '../actions/action-outcome.js';
import {
  ledgerValueWritesIn,
  updateEvidenceOf,
  verifiedRegistrationsIn,
  writeGenerationHistoryIn,
  type RecordValueWrite,
  writeResultRowOfGrant,
  writeResultRowOfJob,
  writeResultViewOf,
  type WriteGenerationHistory,
  type WriteResultRow,
  type WriteResultView,
} from '../actions/write-result-facts.js';
import { isDataSeed } from '../data-rules/deterministic-stream.js';
import type { SeedRecord } from '../data-rules/scenario-data.js';
import { ACTIVE_AUDIT_JOB_STATES } from '../job/job-records.js';
import { readJobIn } from '../job/job-store.js';
import { dateOfCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import type { DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import type { DiscoveryDocument } from '../../discovery/discovery-result.js';
import { candidateOfDiscoveryDocument, candidateOfDiscoveryDocumentByShape } from '../discovery-candidate-lookup.js';
import { evaluateRuleSet } from '../data-rules/field-evaluation.js';
import { readVerificationVaryingRejectionOf } from '../data-rules/varying-values.js';
import type { FieldRuleProblem } from '../data-rules/rule-contracts.js';
import { latestRuleSetIn, latestRuleSetReferenceIn } from '../data-rules/rule-set-facts.js';
import { isProfileOperationAllowed } from '../execution-policy.js';
import type { DiscoveryCandidateIndexView } from '../job/discovery-index-store.js';
import type { ControlDatabase } from '../store/control-database.js';
import { RETIRED_PROFILE_STATUS } from '../store/profile-records.js';
import { getProfile } from '../store/profile-store.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { withReadTransaction, withWriteTransaction } from '../store/transaction.js';
import { approvalBoundFactsOf, computeApprovalDigest } from './approval-digest.js';
import {
  approvalExpiresAtOf,
  evaluateApprovalValidity,
  type ApprovalInvalidityReason,
  type ApprovalValidity,
} from './approval-validity.js';
import {
  WRITE_RESERVATION_TRANSITIONS,
  environmentEvidenceRejectionOf,
  executionGrantExpiresAtOf,
  expiredOpenGrantIdsOf,
  isExecutionGrantExpired,
  usedCumulativeWrites,
  isWriteConcurrencyAvailable,
  isWriteReservationTransitionAllowed,
  selectUpdateTargetRecordId,
  targetSelectionRejectionOf,
  writeLimitRejectionOf,
  writeRateRejectionOf,
  type ExecutionGrantRejectionReason,
  type ExpiringGrant,
  type WriteReservationRejectionReason,
} from './execution-grant.js';
import {
  REVISION_COLUMNS,
  SCENARIO_COLUMNS,
  approvalStateIn,
  candidateFactOf,
  currentFactsIn,
  digestFactsOf,
  discoverySnapshotOf,
  discoveryUnchangedIn,
  integrityError,
  lastReceiptsIn,
  profileIdOfScenario,
  readCheckFactsIn,
  receiptOf,
  scenarioKindFactsIn,
  requireEvidence,
  requireExternal,
  revisionRowOf,
  revisionViewOf,
  scenarioRowOf,
  scenarioViewOf,
  writeFamilyScenarioIdsIn,
  type ApprovalExternalFacts,
  type DiscoverySnapshot,
  type ReceiptRow,
  type RevisionRow,
  type ScenarioApprovalState,
  type ScenarioRevisionView,
  type ScenarioRow,
  type ScenarioView,
} from './scenario-facts.js';
import {
  APPROVAL_RECEIPT_SCHEMA_VERSION,
  APPROVER_LOCAL_OPERATOR,
  MAX_SCENARIO_FIELD_NAMES,
  MIN_SCENARIO_REVISION,
  SCENARIO_ID_PATTERN,
  SCENARIO_SCHEMA_VERSION,
  DRAFT_SCENARIO_STATE,
  UPDATE_SCENARIO_KIND,
  WRITE_RESERVATION_STATES,
  scenarioTransportOf,
  updateLedgerScenarioIdOf,
  API_SCENARIO_TRANSPORT,
  FORM_SCENARIO_TRANSPORT,
  type ApprovalReceipt,
  type ApprovalReceiptRecord,
  type InputRuleReference,
  type RevocationReceipt,
  type ScenarioContent,
  type ScenarioKind,
  type ScenarioKindFact,
  type ScenarioRecordIdSpec,
  type ScenarioRevision,
  type ScenarioState,
  type ScenarioTransport,
  type WriteReservationState,
} from './scenario-contracts.js';
import {
  assertStorableApprovalReceipt,
  assertStorableScenarioRevision,
  apiUpdateLedgerBindingRejectionOf,
  isUpdatePathBoundToLedger,
  missingVerificationItemsOf,
  unconfirmedSideEffectsOf,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftError,
} from './scenario-policy.js';
import type { SiteProfile } from '../contracts.js';

// 行の読み出しと今の事実の集め方は `scenario-facts.ts`（T28d で移した）。形の名前は、ここからも公開し直す。
export type { ApprovalExternalFacts, ScenarioRevisionView, ScenarioView } from './scenario-facts.js';

// ===============================================================================================================
// 共通（拒む理由と結果、入力の確かめ）
// ===============================================================================================================

/**
 * シナリオと承認の保存を拒む理由（閉じた一覧）。
 * - `SCENARIO_PROFILE_NOT_FOUND`・`SCENARIO_PROFILE_RETIRED`・`SCENARIO_MODE_NOT_WRITE`: プロファイルがない・取り消した・書き込みのモードでない
 *   （作成と版の更新。入力の規則の参照は、取り消したプロファイルだけを拒む）。
 * - `SCENARIO_DISCOVERY_NOT_LATEST`: 渡された `discovery.json` が、プロファイルの最後の発見のジョブのものでない（ない、発見の記録がない）。
 * - `SCENARIO_CANDIDATE_NOT_FOUND`: 候補が、最後の発見の文書にない、または最後の発見の索引で確かめられない（`MISSING`・`NOT_REVISITED`、規則の
 *   digest か分類が文書と違う）。
 * - `SCENARIO_DRAFT_INVALID`: 下書きが `validateScenarioDraft` に通らない（誤りは `draftErrors`）。
 * - `SCENARIO_NOT_FOUND`・`SCENARIO_REVISION_CONFLICT`: シナリオがない・画面が読んだ版と今の版が違う。
 * - `SCENARIO_APPROVAL_DIGEST_MISMATCH`: 画面から来た承認の digest が、サーバで今の事実から求め直した値と違う（古い画面）。
 * - `SCENARIO_SIDE_EFFECTS_UNCONFIRMED`: 副作用の確認に、まだ確かめていない項目がある。
 * - `SCENARIO_NOT_APPROVABLE`: 今の事実では承認できない（再承認の判定の理由は `invalidityReasons`）。
 * - `SCENARIO_NOT_APPROVED`: 撤回する承認がない（承認済みでない、撤回済み）。
 * - `SCENARIO_FACTS_CHANGED`: 確かめの間に、プロファイルの発見のジョブが記録された（読み直してやり直す）。
 * - LG-3（2026-10-24 のテストの組の設計 3.7.2）: T31b の `SCENARIO_UPDATE_SPEC_MISSING`（UPDATE の指定の前に保存した UPDATE の版）は捨てた。その版は
 *   読むときに契約の形の誤り（`DATABASE_INTEGRITY_FAILED`）で止まる。
 * - `SCENARIO_INPUT_RULES_NOT_LATEST`: 付ける入力の規則の参照が、シナリオの規則の集まりの最新の版（id・版・digest）と一致しない（形だけの参照、
 *   古い版。T29d fix round 1）。
 */
export const SCENARIO_STORE_REJECTION_REASONS = Object.freeze([
  'SCENARIO_PROFILE_NOT_FOUND',
  'SCENARIO_PROFILE_RETIRED',
  'SCENARIO_MODE_NOT_WRITE',
  'SCENARIO_DISCOVERY_NOT_LATEST',
  'SCENARIO_CANDIDATE_NOT_FOUND',
  'SCENARIO_DRAFT_INVALID',
  'SCENARIO_NOT_FOUND',
  'SCENARIO_REVISION_CONFLICT',
  'SCENARIO_APPROVAL_DIGEST_MISMATCH',
  'SCENARIO_SIDE_EFFECTS_UNCONFIRMED',
  'SCENARIO_NOT_APPROVABLE',
  'SCENARIO_NOT_APPROVED',
  'SCENARIO_FACTS_CHANGED',
  'SCENARIO_INPUT_RULES_NOT_LATEST',
] as const);
export type ScenarioStoreRejectionReason = (typeof SCENARIO_STORE_REJECTION_REASONS)[number];

/** 保存の結果。拒むときは理由と、下書きの誤り（`SCENARIO_DRAFT_INVALID` のときだけ）と、再承認の判定の理由（`SCENARIO_NOT_APPROVABLE` のときだけ）。 */
export type ScenarioStoreResult =
  | { readonly ok: true; readonly scenario: ScenarioView }
  | {
    readonly ok: false;
    readonly reason: ScenarioStoreRejectionReason;
    readonly draftErrors: readonly ScenarioDraftError[];
    readonly invalidityReasons: readonly ApprovalInvalidityReason[];
  };

/** 状態。 */
const DRAFT_STATE = DRAFT_SCENARIO_STATE;
const APPROVED_STATE = 'APPROVED' satisfies ScenarioState;
const REVOKED_STATE = 'REVOKED' satisfies ScenarioState;
/** 1 回の変更で書き換える行の数。 */
const ONE_ROW = 1;
const NO_DRAFT_ERRORS: readonly ScenarioDraftError[] = Object.freeze([]);
const NO_INVALIDITY_REASONS: readonly ApprovalInvalidityReason[] = Object.freeze([]);

const rejected = (
  reason: ScenarioStoreRejectionReason,
  details: { readonly draftErrors?: readonly ScenarioDraftError[]; readonly invalidityReasons?: readonly ApprovalInvalidityReason[] } = {},
): ScenarioStoreResult => Object.freeze({
  ok: false,
  reason,
  draftErrors: Object.freeze([...(details.draftErrors ?? NO_DRAFT_ERRORS)]),
  invalidityReasons: Object.freeze([...(details.invalidityReasons ?? NO_INVALIDITY_REASONS)]),
});

const requireId = (value: string, subject: string): string => {
  if (typeof value !== 'string' || !SCENARIO_ID_PATTERN.test(value)) {
    throw new RangeError(`the ${subject} must match the scenario id pattern`);
  }
  return value;
};

const requireTimestamp = (value: string): string => {
  dateOfCompactUtcTimestamp(value);
  return value;
};

const requireRevision = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < MIN_SCENARIO_REVISION) {
    throw new RangeError(`the scenario revision must be a safe integer of at least ${MIN_SCENARIO_REVISION}`);
  }
  return value;
};

/** シナリオの行（書いた直後に読む。なければ、データベースの誤り）。 */
const scenarioRowOrThrow = (connection: SqliteConnection, scenarioId: string): ScenarioRow => {
  const row = scenarioRowOf(connection, scenarioId);
  if (row === undefined) {
    throw integrityError('scenarios', 'the written row was not found');
  }
  return row;
};

/** 変える前の確かめ（ない、版が違う、前の時刻）。拒む理由か、今の行。 */
const changeableRowOf = (
  connection: SqliteConnection,
  scenarioId: string,
  expectedRevision: number,
  at: string,
): ScenarioRow | ScenarioStoreRejectionReason => {
  const row = scenarioRowOf(connection, scenarioId);
  if (row === undefined) {
    return 'SCENARIO_NOT_FOUND';
  }
  if (row.revision !== expectedRevision) {
    return 'SCENARIO_REVISION_CONFLICT';
  }
  if (at < row.updated_at) {
    throw new RangeError('the time must not be before the last change of the scenario');
  }
  return row;
};

// ===============================================================================================================
// 節 1: シナリオ（作成・版の更新・入力の規則の参照・読み出し）
// - 作成（`createScenario`）: 最後の発見のジョブの `discovery.json`（呼び出し側が読んで渡す。読み方の owner は `src/control/discovery-candidate-lookup.ts`）
//   から候補を探し、`validateScenarioDraft` を通してから、版 1 の写し（シナリオの版の文書と、発見の根拠の写し（候補の契約の形））を書く。状態は
//   `DRAFT`。取り消したプロファイル・書き込みのモードでないプロファイル・最後の発見でない文書・最後の発見で確かめられない候補は拒む。
// - 版の更新（`updateScenario`）: 画面が読んだ版と同じときだけ、版を 1 つ上げた写しを足す（前の版の写しは残す）。状態は `DRAFT` に戻る（承認は
//   引き継がない）。入力の規則の参照は前の版から引き継ぐ。
// - 入力の規則の参照（`attachInputRuleReference`。Task 29 が使う。T28d）: 参照（規則の集まりの id・版・digest）を付けた版を足す（根拠の写しは前の版の
//   まま）。状態は `DRAFT` に戻る（再承認が要る。再承認の判定は `SCENARIO_REVISION_CHANGED` と `INPUT_RULES_CHANGED`）。T29d fix round 1: 参照は
//   規則の集まりの最新の版と一致するものだけを受ける（`SCENARIO_INPUT_RULES_NOT_LATEST`）。
// - 版の写しは追記だけ（UPDATE・DELETE の文を持たない。Gate の (k)）。
// ===============================================================================================================

/** 作成の入力。 */
export interface NewScenario {
  /** シナリオの ID（`SCENARIO_ID_PATTERN`）。 */
  readonly scenarioId: string;
  /** 人の下書き（`ScenarioDraftInput` の形。確かめは `validateScenarioDraft`）。 */
  readonly draft: unknown;
  /** プロファイルの最後の発見のジョブの `discovery.json`（呼び出し側がスキーマとジョブの ID を確かめて読んだもの。読めなければ null）。 */
  readonly discovery: DiscoveryDocument | null;
  readonly at: string;
}

/** 版の更新の入力。 */
export interface ScenarioChange extends NewScenario {
  /** 画面が読んだ版。 */
  readonly expectedRevision: number;
}

/** 入力の規則の参照を付ける入力（T28d）。 */
export interface InputRuleAttachment {
  readonly scenarioId: string;
  /** 呼び出し側が読んだ版。 */
  readonly expectedRevision: number;
  readonly reference: InputRuleReference;
  readonly at: string;
}

const SELECT_PROFILE_SCENARIOS_SQL = `SELECT ${SCENARIO_COLUMNS} FROM scenarios WHERE profile_id = ? ORDER BY created_at, scenario_id`;
const SELECT_REVISIONS_SQL = `SELECT ${REVISION_COLUMNS} FROM scenario_revisions WHERE scenario_id = ? ORDER BY revision`;
const INSERT_SCENARIO_SQL = `INSERT INTO scenarios (${SCENARIO_COLUMNS}) VALUES (?, ?, ?, ?, NULL, ?, ?)`;
const INSERT_REVISION_SQL = `INSERT INTO scenario_revisions (scenario_id, ${REVISION_COLUMNS}, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_SCENARIO_REVISION_SQL = `UPDATE scenarios SET revision = ?, state = ?, updated_at = ?
  WHERE scenario_id = ? AND revision = ?`;

/** 候補を最後の発見で確かめられないドリフト。 */
const UNCONFIRMED_DRIFTS: ReadonlySet<DiscoveryCandidateIndexView['drift']> = new Set(['MISSING', 'NOT_REVISITED']);

/** T38b: 下書きが送り方 `API` なら、その型の digest（文字列でなければ null。形の確かめは `validateScenarioDraft`）。FORM の下書きは null。 */
const apiShapeDigestOfDraft = (draft: unknown): string | null => {
  if (!isRecord(draft) || draft['transport'] !== API_SCENARIO_TRANSPORT || !isRecord(draft['api'])) {
    return null;
  }
  const shapeDigest = draft['api']['shapeDigest'];
  return typeof shapeDigest === 'string' ? shapeDigest : null;
};

/** 下書きの、文字列の項目（形の確かめは `validateScenarioDraft`）。 */
const draftTextOf = (draft: unknown, key: 'profileId' | 'candidateIdentityDigest'): string | null =>
  isRecord(draft) && typeof draft[key] === 'string' ? draft[key] : null;

/** 入力の規則の参照の形を確かめた凍結した写し（形が違えば `RangeError`）。 */
const requireInputRuleReference = (reference: InputRuleReference): InputRuleReference => {
  const { ruleSetId, revision, digest } = reference;
  if (typeof ruleSetId !== 'string' || !SCENARIO_ID_PATTERN.test(ruleSetId) || !Number.isSafeInteger(revision) || revision < MIN_SCENARIO_REVISION
    || !isSha256Fingerprint(digest)) {
    throw new RangeError('the input rule reference must have a rule set id, a revision of at least 1 and a digest');
  }
  return Object.freeze({ ruleSetId, revision, digest });
};

/** 確かめた作成・版の更新の入力。 */
interface CheckedDraftInput {
  readonly scenarioId: string;
  readonly draft: unknown;
  readonly profileId: string;
  readonly discovery: DiscoveryDocument | null;
  readonly snapshot: DiscoverySnapshot;
  readonly at: string;
}

/** 下書きを、今の事実で確かめた結果（拒む理由か、シナリオの中身と根拠の写し）。 */
type CheckedDraft =
  | { readonly ok: true; readonly content: ScenarioContent; readonly evidence: DiscoveryCandidate; readonly discoveryJobId: string }
  | { readonly ok: false; readonly result: ScenarioStoreResult };

/** 発見のジョブのプロファイルの改訂（T38c。ジョブの行の owner の読み出し。行がないか、別のプロファイルのジョブなら null）。 */
const discoveryJobProfileRevisionIn = (connection: SqliteConnection, profileId: string, jobId: string): number | null => {
  const job = readJobIn(connection, jobId);
  return job === null || job.profileId !== profileId ? null : job.profileRevision;
};

/**
 * 下書きの確かめの文脈（トランザクションの中で読む。作成と版の更新の確かめと、T38f の作成の画面の確かめ `readScenarioDraftContext` が共用する）。
 * - T31b: 台帳の参照は、プロファイルのシナリオの事実で確かめる（確かめるシナリオの id を渡す）。
 * - T38b: API の候補の Origin は、プロファイルの承認したサービスの Origin。
 * - T38c: 候補を見つけた発見のジョブのプロファイルの改訂（ジョブの行。同じプロファイルのジョブでなければ分からない）と、今の改訂。
 */
const draftContextIn = (
  connection: SqliteConnection,
  profile: Pick<SiteProfile, 'profileId' | 'revision' | 'approvedServiceOrigins'>,
  scenarioId: string | null,
  discoveryJobId: string,
): ScenarioDraftContext => ({
  scenarioId,
  scenarios: scenarioKindFactsIn(connection, profile.profileId),
  approvedServiceOrigins: profile.approvedServiceOrigins ?? [],
  profileRevisions: { discoveryJob: discoveryJobProfileRevisionIn(connection, profile.profileId, discoveryJobId), current: profile.revision },
});

/**
 * 下書きの確かめの文脈を読む（T38f。作成の画面が、保存と同じ文脈で選べる項目と候補の誤りを求める。読むだけ）。プロファイルがなければ null。
 * `discoveryJobId` は、画面が読んだ最後の発見のジョブ。
 */
export const readScenarioDraftContext = (
  database: ControlDatabase,
  profileId: string,
  discoveryJobId: string,
  scenarioId: string | null,
): ScenarioDraftContext | null => {
  const stored = getProfile(database, profileId);
  return stored === null ? null : withReadTransaction(database, (connection) => draftContextIn(connection, stored.profile, scenarioId, discoveryJobId));
};

/** プロファイルと発見と下書きを、トランザクションの中で確かめる（作成と版の更新に共通）。 */
const checkDraftIn = (database: ControlDatabase, connection: SqliteConnection, input: CheckedDraftInput): CheckedDraft => {
  const stored = getProfile(database, input.profileId);
  if (stored === null) {
    return { ok: false, result: rejected('SCENARIO_PROFILE_NOT_FOUND') };
  }
  if (stored.status === RETIRED_PROFILE_STATUS) {
    return { ok: false, result: rejected('SCENARIO_PROFILE_RETIRED') };
  }
  // T28e fix round 1: シナリオを許すモードと方式か（`execution-policy.ts` の `SCENARIO` の行。判定は 1 か所）。
  if (!isProfileOperationAllowed('SCENARIO', stored.profile.mode, stored.profile.auth)) {
    return { ok: false, result: rejected('SCENARIO_MODE_NOT_WRITE') };
  }
  if (!discoveryUnchangedIn(connection, input.profileId, input.snapshot)) {
    return { ok: false, result: rejected('SCENARIO_FACTS_CHANGED') };
  }
  const { discovery, snapshot } = input;
  if (discovery === null || snapshot.latestJobId === null || discovery.jobId !== snapshot.latestJobId) {
    return { ok: false, result: rejected('SCENARIO_DISCOVERY_NOT_LATEST') };
  }
  const identityDigest = draftTextOf(input.draft, 'candidateIdentityDigest');
  // T38b（Task 38 の設計書 3.2）: API のシナリオの下書きは、候補の行を型の digest で選ぶ（同じ識別で型が違う行が別に残るため）。
  const apiShapeDigest = apiShapeDigestOfDraft(input.draft);
  const candidate = identityDigest === null
    ? null
    : (apiShapeDigest === null
      ? candidateOfDiscoveryDocument(discovery, identityDigest)
      : candidateOfDiscoveryDocumentByShape(discovery, identityDigest, apiShapeDigest));
  if (identityDigest !== null) {
    const fact = candidateFactOf(snapshot, identityDigest);
    if (candidate === null || fact === null || UNCONFIRMED_DRIFTS.has(fact.drift)
      || fact.ruleDigest !== candidate.ruleDigest || fact.classification !== candidate.classification) {
      return { ok: false, result: rejected('SCENARIO_CANDIDATE_NOT_FOUND') };
    }
  }
  // T31b: 台帳の参照は、同じトランザクションで読んだプロファイルのシナリオの事実で確かめる（確かめるシナリオの id を文脈に渡す）。
  const validation = validateScenarioDraft(input.draft, candidate, readCheckFactsIn(connection, input.profileId),
    draftContextIn(connection, stored.profile, input.scenarioId, discovery.jobId));
  if (!validation.ok) {
    return { ok: false, result: rejected('SCENARIO_DRAFT_INVALID', { draftErrors: validation.errors }) };
  }
  if (candidate === null) {
    throw new Error('validateScenarioDraft accepted a draft without a candidate');
  }
  return { ok: true, content: validation.content, evidence: requireEvidence(candidate), discoveryJobId: discovery.jobId };
};

/** 版の写しを書く（追記だけ）。 */
const insertRevisionIn = (
  connection: SqliteConnection,
  scenario: ScenarioRevision,
  evidence: DiscoveryCandidate,
  discoveryJobId: string,
  at: string,
): void => {
  connection.prepare(INSERT_REVISION_SQL).run(
    scenario.scenarioId, scenario.revision, JSON.stringify(scenario), JSON.stringify(evidence), discoveryJobId, at, scenario.profileId,
  );
};

/** シナリオの版の文書（契約の形を確かめた凍結した写し）。 */
const scenarioRevisionOf = (
  content: ScenarioContent,
  identity: { readonly scenarioId: string; readonly revision: number; readonly createdAt: string; readonly updatedAt: string },
  inputRuleReference: ScenarioRevision['inputRuleReference'],
): ScenarioRevision => assertStorableScenarioRevision({
  schemaVersion: SCENARIO_SCHEMA_VERSION,
  scenarioId: identity.scenarioId,
  revision: identity.revision,
  ...content,
  inputRuleReference,
  createdAt: identity.createdAt,
  updatedAt: identity.updatedAt,
});

/** 次の版の写しを足し、今の行を次の版の `DRAFT` にする（版の更新と入力の規則の参照に共通）。 */
const advanceRevisionIn = (
  connection: SqliteConnection,
  row: ScenarioRow,
  scenario: ScenarioRevision,
  evidence: DiscoveryCandidate,
  discoveryJobId: string,
  at: string,
): ScenarioStoreResult => {
  insertRevisionIn(connection, scenario, evidence, discoveryJobId, at);
  const changes = connection.prepare(UPDATE_SCENARIO_REVISION_SQL).run(scenario.revision, DRAFT_STATE, at, row.scenario_id, row.revision).changes;
  if (Number(changes) !== ONE_ROW) {
    throw integrityError('scenarios', 'the changed row was not found');
  }
  return Object.freeze({ ok: true, scenario: scenarioViewOf(connection, scenarioRowOrThrow(connection, row.scenario_id)) });
};

const createIn = (database: ControlDatabase, connection: SqliteConnection, input: CheckedDraftInput): ScenarioStoreResult => {
  if (scenarioRowOf(connection, input.scenarioId) !== undefined) {
    throw new RangeError('the scenario id is already used');
  }
  const checked = checkDraftIn(database, connection, input);
  if (!checked.ok) {
    return checked.result;
  }
  const scenario = scenarioRevisionOf(
    checked.content,
    { scenarioId: input.scenarioId, revision: MIN_SCENARIO_REVISION, createdAt: input.at, updatedAt: input.at },
    null,
  );
  connection.prepare(INSERT_SCENARIO_SQL).run(input.scenarioId, input.profileId, MIN_SCENARIO_REVISION, DRAFT_STATE, input.at, input.at);
  insertRevisionIn(connection, scenario, checked.evidence, checked.discoveryJobId, input.at);
  return Object.freeze({ ok: true, scenario: scenarioViewOf(connection, scenarioRowOrThrow(connection, input.scenarioId)) });
};

const updateIn = (database: ControlDatabase, connection: SqliteConnection, input: CheckedDraftInput & { readonly expectedRevision: number }): ScenarioStoreResult => {
  const row = changeableRowOf(connection, input.scenarioId, input.expectedRevision, input.at);
  if (typeof row === 'string') {
    return rejected(row);
  }
  if (row.profile_id !== input.profileId) {
    throw new RangeError('the draft must be of the profile of the scenario');
  }
  const checked = checkDraftIn(database, connection, input);
  if (!checked.ok) {
    return checked.result;
  }
  const previous = revisionViewOf(revisionRowOf(connection, row.scenario_id, row.revision));
  const scenario = scenarioRevisionOf(
    checked.content,
    { scenarioId: row.scenario_id, revision: row.revision + 1, createdAt: row.created_at, updatedAt: input.at },
    previous.scenario.inputRuleReference,
  );
  return advanceRevisionIn(connection, row, scenario, checked.evidence, checked.discoveryJobId, input.at);
};

/** 2 つの入力の規則の参照が同じか（id・版・digest）。 */
const sameInputRuleReference = (left: InputRuleReference | null, right: InputRuleReference): boolean =>
  left !== null && left.ruleSetId === right.ruleSetId && left.revision === right.revision && left.digest === right.digest;

const attachIn = (database: ControlDatabase, connection: SqliteConnection, input: InputRuleAttachment): ScenarioStoreResult => {
  const row = changeableRowOf(connection, input.scenarioId, input.expectedRevision, input.at);
  if (typeof row === 'string') {
    return rejected(row);
  }
  if (getProfile(database, row.profile_id)?.status === RETIRED_PROFILE_STATUS) {
    return rejected('SCENARIO_PROFILE_RETIRED');
  }
  // T29d fix round 1: 付ける参照は、このシナリオの規則の集まりの最新の版（id・版・digest）と一致するものだけ（形だけの参照・古い版は付けない）。
  if (!sameInputRuleReference(latestRuleSetReferenceIn(connection, row.scenario_id), input.reference)) {
    return rejected('SCENARIO_INPUT_RULES_NOT_LATEST');
  }
  const previous = revisionViewOf(revisionRowOf(connection, row.scenario_id, row.revision));
  const scenario = assertStorableScenarioRevision({
    ...previous.scenario,
    revision: row.revision + 1,
    inputRuleReference: input.reference,
    updatedAt: input.at,
  });
  return advanceRevisionIn(connection, row, scenario, previous.evidence, previous.discoveryJobId, input.at);
};

/** 作成と版の更新の入力を確かめる（下書きのプロファイルがなければ、下書きの誤りを返す）。 */
const checkedDraftInputOf = (
  database: ControlDatabase,
  input: NewScenario,
): CheckedDraftInput | ScenarioStoreResult => {
  const scenarioId = requireId(input.scenarioId, 'scenario id');
  const at = requireTimestamp(input.at);
  // 下書きの JSON の写し（入力を変えない。JSON でない値は落ちて、`validateScenarioDraft` で拒まれる）。
  const draft = jsonCopyOf(input.draft);
  const profileId = draftTextOf(draft, 'profileId');
  if (profileId === null) {
    const validation = validateScenarioDraft(draft, null, []);
    return rejected('SCENARIO_DRAFT_INVALID', { draftErrors: validation.ok ? NO_DRAFT_ERRORS : validation.errors });
  }
  return Object.freeze({ scenarioId, draft, profileId, discovery: input.discovery, snapshot: discoverySnapshotOf(database, profileId), at });
};

const isStoreResult = (value: CheckedDraftInput | ScenarioStoreResult): value is ScenarioStoreResult => 'ok' in value;

/** シナリオを作る（版 1、`DRAFT`）。拒むときは理由を返して何も書かない。同じ ID は `RangeError`。 */
export const createScenario = (database: ControlDatabase, input: NewScenario): ScenarioStoreResult => {
  const checked = checkedDraftInputOf(database, input);
  if (isStoreResult(checked)) {
    return checked;
  }
  return withWriteTransaction(database, (connection) => createIn(database, connection, checked));
};

/** シナリオの版を上げる（画面が読んだ版と同じときだけ。状態は `DRAFT` に戻る）。拒むときは理由を返して何も書かない。 */
export const updateScenario = (database: ControlDatabase, input: ScenarioChange): ScenarioStoreResult => {
  const expectedRevision = requireRevision(input.expectedRevision);
  const checked = checkedDraftInputOf(database, input);
  if (isStoreResult(checked)) {
    return checked;
  }
  const values = Object.freeze({ ...checked, expectedRevision });
  return withWriteTransaction(database, (connection) => updateIn(database, connection, values));
};

/**
 * シナリオに入力の規則の参照を付ける（T28d。Task 29 が使う）。版を 1 つ上げ、状態は `DRAFT` に戻る（再承認が要る）。拒むときは理由を返して何も
 * 書かない。参照の形が違えば `RangeError`。
 */
export const attachInputRuleReference = (database: ControlDatabase, input: InputRuleAttachment): ScenarioStoreResult => {
  const values: InputRuleAttachment = Object.freeze({
    scenarioId: requireId(input.scenarioId, 'scenario id'),
    expectedRevision: requireRevision(input.expectedRevision),
    reference: requireInputRuleReference(input.reference),
    at: requireTimestamp(input.at),
  });
  return withWriteTransaction(database, (connection) => attachIn(database, connection, values));
};

/** シナリオ 1 件（なければ null）。 */
export const readScenario = (database: ControlDatabase, scenarioId: string): ScenarioView | null =>
  withReadTransaction(database, (connection) => {
    const row = scenarioRowOf(connection, scenarioId);
    return row === undefined ? null : scenarioViewOf(connection, row);
  });

/** プロファイルのシナリオの一覧（作った順）。 */
export const listScenarios = (database: ControlDatabase, profileId: string): readonly ScenarioView[] =>
  withReadTransaction(database, (connection) => Object.freeze(
    (connection.prepare(SELECT_PROFILE_SCENARIOS_SQL).all(profileId) as unknown as ScenarioRow[]).map((row) => scenarioViewOf(connection, row)),
  ));

/** シナリオの版の写しの履歴（版の順。なければ空）。 */
export const readScenarioRevisions = (database: ControlDatabase, scenarioId: string): readonly ScenarioRevisionView[] =>
  withReadTransaction(database, (connection) => Object.freeze(
    (connection.prepare(SELECT_REVISIONS_SQL).all(scenarioId) as unknown as RevisionRow[]).map(revisionViewOf),
  ));

// ===============================================================================================================
// 節 2: 承認と撤回
// - 承認（`approveScenario`）: 画面から来た版と承認の digest が、サーバで今の事実から求め直した値と一致し、副作用の確認がすべて済み、再承認の判定
//   （`evaluateApprovalValidity`）の理由が承認がないこと（`NOT_APPROVED`）だけのときだけ、承認者 `LOCAL_OPERATOR` の承認の記録を追記し、状態を
//   `APPROVED` にする。期限は `approvalExpiresAtOf`。有効な承認の上の承認し直し（期限が延びる）は許す（T28c の判断）。
// - 撤回（`revokeScenarioApproval`）: `APPROVED` のシナリオの最後の承認に対する撤回の記録を追記し、状態を `REVOKED` にする。同じトランザクションで、
//   そのシナリオの消費していない許可を無効にし、その `RESERVED` の予約を `RELEASED` にする（T28d。節 3 の `releaseOpenGrantsIn`）。消費済みの許可の
//   予約は今のまま（送ったかどうかの扱いは Task 30）。
// - 承認と撤回の記録は追記だけ（UPDATE・DELETE の文を持たない。Gate の (k)）。
// ===============================================================================================================

/** 承認の入力。 */
export interface ScenarioApproval {
  readonly scenarioId: string;
  /** 画面が出した版。 */
  readonly expectedRevision: number;
  /** 画面が出した承認の digest（`readScenarioApprovalStatus` の `approvalDigest`）。 */
  readonly expectedApprovalDigest: string;
  /** 承認の記録の ID（`SCENARIO_ID_PATTERN`）。 */
  readonly receiptId: string;
  readonly external: ApprovalExternalFacts;
  readonly at: string;
}

/** 撤回の入力。 */
export interface ScenarioRevocation {
  readonly scenarioId: string;
  readonly expectedRevision: number;
  /** 撤回の記録の ID（`SCENARIO_ID_PATTERN`）。 */
  readonly receiptId: string;
  readonly at: string;
}

/** 承認の状態（画面の表示と承認のダイアログ）。凍結。 */
export interface ScenarioApprovalStatus {
  readonly scenario: ScenarioView;
  /** 今の版と今の事実から求めた承認の digest（承認の操作は、この値を送り返す）。 */
  readonly approvalDigest: string;
  readonly validity: ApprovalValidity;
}

const SELECT_RECEIPTS_SQL = 'SELECT document FROM approval_receipts WHERE scenario_id = ? ORDER BY recorded_at, rowid';
const SELECT_RECEIPT_USED_SQL = 'SELECT count(*) AS n FROM approval_receipts WHERE receipt_id = ?';
const INSERT_RECEIPT_SQL = `INSERT INTO approval_receipts (receipt_id, profile_id, scenario_id, kind, scenario_revision, approval_digest,
  target_receipt_id, recorded_at, expires_at, document) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_SCENARIO_STATE_SQL = `UPDATE scenarios SET state = ?, last_approval_receipt_id = ?, updated_at = ?
  WHERE scenario_id = ? AND revision = ?`;

/** 撤回の理由（今は人の撤回だけ）。 */
const OPERATOR_REVOCATION_REASON = 'OPERATOR_REQUEST' satisfies RevocationReceipt['reason'];
/** 承認の前に、まだない承認を表す理由（承認の操作では、これだけは許す）。 */
const NOT_APPROVED_REASON = 'NOT_APPROVED' satisfies ApprovalInvalidityReason;

/** 状態を書き換える（今の版の行だけ。1 行でなければ、データベースの誤り）。 */
const updateStateIn = (connection: SqliteConnection, row: ScenarioRow, state: ScenarioState, lastApprovalReceiptId: string | null, at: string): void => {
  const changes = connection.prepare(UPDATE_SCENARIO_STATE_SQL).run(state, lastApprovalReceiptId, at, row.scenario_id, row.revision).changes;
  if (Number(changes) !== ONE_ROW) {
    throw integrityError('scenarios', 'the changed row was not found');
  }
};

/** 記録の ID が、まだ使われていないこと（使われていれば `RangeError`）。 */
const assertUnusedReceiptId = (connection: SqliteConnection, receiptId: string): void => {
  if ((connection.prepare(SELECT_RECEIPT_USED_SQL).get(receiptId) as { readonly n: number }).n > 0) {
    throw new RangeError('the receipt id is already used');
  }
};

/** 承認か撤回の記録を書く（追記だけ）。 */
const insertReceiptIn = (connection: SqliteConnection, receipt: ApprovalReceiptRecord): void => {
  if (receipt.kind === 'APPROVAL') {
    connection.prepare(INSERT_RECEIPT_SQL).run(
      receipt.receiptId, receipt.profileId, receipt.scenarioId, receipt.kind, receipt.scenarioRevision, receipt.approvalDigest, null,
      receipt.approvedAt, receipt.expiresAt, JSON.stringify(receipt),
    );
    return;
  }
  connection.prepare(INSERT_RECEIPT_SQL).run(
    receipt.receiptId, receipt.profileId, receipt.scenarioId, receipt.kind, null, null, receipt.targetReceiptId, receipt.revokedAt, null,
    JSON.stringify(receipt),
  );
};

interface CheckedApproval extends ScenarioApproval {
  readonly snapshot: DiscoverySnapshot;
}

const approveIn = (database: ControlDatabase, connection: SqliteConnection, input: CheckedApproval): ScenarioStoreResult => {
  const row = changeableRowOf(connection, input.scenarioId, input.expectedRevision, input.at);
  if (typeof row === 'string') {
    return rejected(row);
  }
  if (!discoveryUnchangedIn(connection, row.profile_id, input.snapshot)) {
    return rejected('SCENARIO_FACTS_CHANGED');
  }
  // LG-3: UPDATE の指定の前に保存した UPDATE の版は、読むとき（`revisionViewOf`）に止まる（T31b の承認の前の確かめは捨てた）。
  const scenario = revisionViewOf(revisionRowOf(connection, row.scenario_id, row.revision)).scenario;
  const facts = currentFactsIn(connection, database, scenario, input.snapshot, input.external);
  const digestFacts = digestFactsOf(facts);
  const approvalDigest = computeApprovalDigest(scenario, digestFacts);
  if (approvalDigest !== input.expectedApprovalDigest) {
    return rejected('SCENARIO_APPROVAL_DIGEST_MISMATCH');
  }
  if (unconfirmedSideEffectsOf(scenario.sideEffectConfirmations).length > 0) {
    return rejected('SCENARIO_SIDE_EFFECTS_UNCONFIRMED');
  }
  const validity = evaluateApprovalValidity({ scenario, facts, lastApproval: null, lastRevocation: null, now: dateOfCompactUtcTimestamp(input.at) });
  const blocking = validity.approved ? [] : validity.reasons.filter((reason) => reason !== NOT_APPROVED_REASON);
  if (blocking.length > 0) {
    return rejected('SCENARIO_NOT_APPROVABLE', { invalidityReasons: blocking });
  }
  assertUnusedReceiptId(connection, input.receiptId);
  const receipt = assertStorableApprovalReceipt<ApprovalReceipt>({
    schemaVersion: APPROVAL_RECEIPT_SCHEMA_VERSION,
    kind: 'APPROVAL',
    receiptId: input.receiptId,
    profileId: row.profile_id,
    scenarioId: row.scenario_id,
    scenarioRevision: scenario.revision,
    approvalDigest,
    bound: approvalBoundFactsOf(scenario, digestFacts),
    approvedAt: input.at,
    expiresAt: approvalExpiresAtOf(input.at, scenario.approvalTtlDays),
    approver: APPROVER_LOCAL_OPERATOR,
  });
  insertReceiptIn(connection, receipt);
  updateStateIn(connection, row, APPROVED_STATE, receipt.receiptId, input.at);
  return Object.freeze({ ok: true, scenario: scenarioViewOf(connection, scenarioRowOrThrow(connection, row.scenario_id)) });
};

const revokeIn = (connection: SqliteConnection, input: ScenarioRevocation): ScenarioStoreResult => {
  const row = changeableRowOf(connection, input.scenarioId, input.expectedRevision, input.at);
  if (typeof row === 'string') {
    return rejected(row);
  }
  const { approval, revocation } = lastReceiptsIn(connection, row);
  if (row.state !== APPROVED_STATE || approval === null || revocation !== null) {
    return rejected('SCENARIO_NOT_APPROVED');
  }
  assertUnusedReceiptId(connection, input.receiptId);
  const receipt = assertStorableApprovalReceipt<RevocationReceipt>({
    schemaVersion: APPROVAL_RECEIPT_SCHEMA_VERSION,
    kind: 'REVOCATION',
    receiptId: input.receiptId,
    profileId: row.profile_id,
    scenarioId: row.scenario_id,
    targetReceiptId: approval.receiptId,
    revokedAt: input.at,
    reason: OPERATOR_REVOCATION_REASON,
  });
  insertReceiptIn(connection, receipt);
  updateStateIn(connection, row, REVOKED_STATE, approval.receiptId, input.at);
  releaseOpenGrantsIn(connection, row.scenario_id, input.at);
  return Object.freeze({ ok: true, scenario: scenarioViewOf(connection, scenarioRowOrThrow(connection, row.scenario_id)) });
};

/**
 * シナリオの今の版を承認する（承認の記録を追記し、状態を `APPROVED` にする）。版・承認の digest・副作用の確認・今の事実を、1 つのトランザクションの
 * 中で確かめ直す。拒むときは理由を返して何も書かない。
 */
export const approveScenario = (database: ControlDatabase, input: ScenarioApproval): ScenarioStoreResult => {
  const scenarioId = requireId(input.scenarioId, 'scenario id');
  const values = {
    scenarioId,
    expectedRevision: requireRevision(input.expectedRevision),
    expectedApprovalDigest: input.expectedApprovalDigest,
    receiptId: requireId(input.receiptId, 'receipt id'),
    external: requireExternal(input.external),
    at: requireTimestamp(input.at),
  };
  if (!isSha256Fingerprint(values.expectedApprovalDigest)) {
    throw new RangeError('the expected approval digest must be a digest of computeApprovalDigest');
  }
  const profileId = profileIdOfScenario(database, scenarioId);
  if (profileId === null) {
    return rejected('SCENARIO_NOT_FOUND');
  }
  const checked: CheckedApproval = Object.freeze({ ...values, snapshot: discoverySnapshotOf(database, profileId) });
  return withWriteTransaction(database, (connection) => approveIn(database, connection, checked));
};

/**
 * シナリオの最後の承認を撤回する（撤回の記録を追記し、状態を `REVOKED` にし、消費していない許可を無効にして予約を返す。1 つのトランザクション）。
 * 拒むときは理由を返して何も書かない。
 */
export const revokeScenarioApproval = (database: ControlDatabase, input: ScenarioRevocation): ScenarioStoreResult => {
  const values: ScenarioRevocation = Object.freeze({
    scenarioId: requireId(input.scenarioId, 'scenario id'),
    expectedRevision: requireRevision(input.expectedRevision),
    receiptId: requireId(input.receiptId, 'receipt id'),
    at: requireTimestamp(input.at),
  });
  return withWriteTransaction(database, (connection) => revokeIn(connection, values));
};

/** シナリオの承認と撤回の記録の履歴（記録の順。なければ空）。 */
export const readApprovalReceipts = (database: ControlDatabase, scenarioId: string): readonly ApprovalReceiptRecord[] =>
  withReadTransaction(database, (connection) => Object.freeze(
    (connection.prepare(SELECT_RECEIPTS_SQL).all(scenarioId) as unknown as ReceiptRow[]).map(receiptOf),
  ));

/**
 * シナリオの承認の状態（今の版、今の事実から求めた承認の digest、再承認の判定）。シナリオがなければ null。判定の時刻 `now` は注入する。
 * 外の事実は呼び出し側が求めて渡す（`ApprovalExternalFacts`）。
 */
export const readScenarioApprovalStatus = (
  database: ControlDatabase,
  scenarioId: string,
  external: ApprovalExternalFacts,
  now: Date,
): ScenarioApprovalStatus | null => {
  const facts = requireExternal(external);
  const profileId = profileIdOfScenario(database, scenarioId);
  if (profileId === null) {
    return null;
  }
  const snapshot = discoverySnapshotOf(database, profileId);
  return withReadTransaction(database, (connection) => {
    const row = scenarioRowOf(connection, scenarioId);
    if (row === undefined) {
      return null;
    }
    const state = approvalStateIn(connection, database, row, snapshot, facts, now);
    return deepFreeze({ scenario: state.scenario, approvalDigest: state.approvalDigest, validity: state.validity });
  });
};

// ===============================================================================================================
// 節 3: 許可と予約（T28d。決まりは `execution-grant.ts`）
// - 発行（`issueExecutionGrant`）: 1 つのトランザクションの中で、この順に確かめる: シナリオと版、発見の確かめ直し、承認の判定（`approvalStateIn`。
//   時刻は書く時刻）、入力の規則の参照（T29d: 規則の集まりの最新の版で `evaluateRuleSet` をかけ、送る欄すべてが `DECIDED` でなければ `NEEDS_RULE_INPUT`。
//   欄ごとの問題を `ruleProblems` に添える）、このシナリオの消費していない有効な許可、件数（1 回の Run の上限と累積の上限の残り）、書き込みの同時実行の枠
//   （全体の、消費していない有効な許可と、消費済みで予約が `RESERVED` のままの許可の数）。外れたら何も書かずに理由で拒む。
//   T30d: 入力の規則の後に、検証の指定がそろっていること（`missingVerificationItemsOf`。`VERIFICATION_SPEC_MISSING`）と、プロファイルの環境の証跡の
//   参照（`environmentEvidenceRejectionOf`）を、件数の上限の後に連続の上限（`writeRateRejectionOf`。最後の書き込みから 5 分、24 時間に 5 件。
//   判定の時刻は書く時刻）を確かめる。受けたら、古い許可
//   （期限切れ、またはこのシナリオの承認の記録か版が今と違う、消費していない許可）を無効にして予約を返し、許可（ジョブの id に結び付け、期限は
//   `executionGrantExpiresAtOf`）と予約（`RESERVED`）を書く。古い許可とその予約は、件数と同時実行の枠に数えない。
// - 消費（`consumeExecutionGrant`）: 許可の id・シナリオ・版・ジョブ・プロファイル・未消費・未無効を確かめ、期限切れなら無効にして予約を返してから
//   `GRANT_EXPIRED` で拒む（同じトランザクションで書く）。承認の判定をやり直し、承認の記録と版が許可を出したときと同じことを確かめてから、消費の
//   時刻を書く。
// - 確かめ直し（`assertGrantStillValid`。Task 30 が書き込みの要求の前に呼ぶ。読むだけ）: 許可が消費済みで、無効でなく、承認が今も有効で、承認の
//   記録と版が許可を出したときと同じか。結果で返す（投げない）。
// - 予約の状態の変更（`settleWriteReservation`。Task 30 が使う）: 遷移の表（`WRITE_RESERVATION_TRANSITIONS`）の遷移だけ。送った・分からない
//   （`COMMITTED`・`UNKNOWN`）は消費済みの許可の予約だけ。
// - 撤回との結び付け（`releaseOpenGrantsIn`）: 節 2 の撤回が、同じトランザクションの中で呼ぶ（公開しない）。
// - 無効にする時刻と予約を返す時刻は、書く時刻と、発行・予約の時刻の遅い方（表の CHECK の、時刻の順を守る）。
// - T31e（Task 31 の設計書 3 章の「対象の選び方」「対象にできるレコード」。管理データの版 9）: UPDATE のシナリオの発行では、同じトランザクションの中で、
//   参照した CREATE のシナリオの `VERIFIED` の登録（`verifiedRegistrationsIn`）から、登録の時刻が最も新しい 1 件を選び直し
//   （`selectUpdateTargetRecordId`）、画面が見せた予定の ID（`expectedTargetRecordId`）と照らす（`targetSelectionRejectionOf`。違えば
//   `TARGET_SELECTION_CHANGED`、対象がなければ `TARGET_RECORD_UNAVAILABLE`）。選んだ ID を許可（`target_record_id`）に結ぶ（予約は許可に 1 件なので、
//   許可を通して結び付く）。許可を読む口（`ExecutionGrantView.targetRecordId`）が ID を返す。画面のための読むだけの口は `readPlannedUpdateTarget`。
//   CREATE の発行に予定の ID を渡すのは、呼び出し側の誤り（`RangeError`）。
// ===============================================================================================================

/** 予約 1 件（凍結。日時は UTC の 14 桁）。 */
export interface WriteReservationView {
  readonly reservationId: number;
  readonly grantId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly count: number;
  readonly state: WriteReservationState;
  readonly reservedAt: string;
  readonly settledAt: string | null;
}

/** 実行の許可 1 件と、その予約（凍結）。 */
export interface ExecutionGrantView {
  readonly grantId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly approvalReceiptId: string;
  readonly jobId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly invalidatedAt: string | null;
  /** UPDATE の対象のレコードの ID（T31e。発行の中で選んで結んだ ID。CREATE の許可は null）。 */
  readonly targetRecordId: string | null;
  readonly reservation: WriteReservationView;
}

/**
 * 許可の発行・消費・確かめ直しの結果。拒むときは理由と、再承認の判定の理由（`GRANT_APPROVAL_INVALID` のときだけ）と、入力の規則の欄ごとの問題
 * （発行の `NEEDS_RULE_INPUT` のときだけ。T29d）。
 */
export type ExecutionGrantResult =
  | { readonly ok: true; readonly grant: ExecutionGrantView }
  | {
    readonly ok: false;
    readonly reason: ExecutionGrantRejectionReason;
    readonly invalidityReasons: readonly ApprovalInvalidityReason[];
    readonly ruleProblems: readonly FieldRuleProblem[];
  };

/** 予約の状態の変更の結果。 */
export type WriteReservationResult =
  | { readonly ok: true; readonly reservation: WriteReservationView }
  | { readonly ok: false; readonly reason: WriteReservationRejectionReason };

/** 発行の入力。 */
export interface GrantIssue {
  readonly scenarioId: string;
  /** 呼び出し側が読んだシナリオの版。 */
  readonly expectedRevision: number;
  /** 許可の ID（`SCENARIO_ID_PATTERN`）。 */
  readonly grantId: string;
  /** 結び付ける書き込みのジョブの ID（`SCENARIO_ID_PATTERN`。許可ごとに一意）。 */
  readonly jobId: string;
  /** 予約する件数（1 回の Run の上限まで）。 */
  readonly count: number;
  /**
   * 画面が見せた、UPDATE の更新の予定のレコードの ID（T31e。`readPlannedUpdateTarget` の値。予定がなかったときは null）。UPDATE のシナリオだけが
   * 使う。CREATE のシナリオでは省略するか null（ほかの値は `RangeError`）。
   */
  readonly expectedTargetRecordId?: string | null;
  readonly external: ApprovalExternalFacts;
  readonly at: string;
}

/** 消費の入力（ジョブの開始のときに、許可を出したときの値を渡す）。 */
export interface GrantConsumption {
  readonly grantId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly jobId: string;
  readonly profileId: string;
  readonly external: ApprovalExternalFacts;
  readonly at: string;
}

/** 確かめ直しの入力（判定の時刻 `now` は注入する）。 */
export interface GrantRecheck extends Omit<GrantConsumption, 'at'> {
  readonly now: Date;
}

/** 予約の状態の変更の入力。 */
export interface ReservationSettlement {
  readonly reservationId: number;
  readonly to: WriteReservationState;
  readonly at: string;
}

interface GrantRow {
  readonly grant_id: string;
  readonly profile_id: string;
  readonly scenario_id: string;
  readonly scenario_revision: number;
  readonly approval_receipt_id: string;
  readonly job_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly invalidated_at: string | null;
  readonly target_record_id: string | null;
}

interface ReservationRow {
  readonly reservation_id: number;
  readonly grant_id: string;
  readonly profile_id: string;
  readonly scenario_id: string;
  readonly count: number;
  readonly state: string;
  readonly reserved_at: string;
  readonly settled_at: string | null;
}

const GRANT_COLUMNS = 'grant_id, profile_id, scenario_id, scenario_revision, approval_receipt_id, job_id, issued_at, expires_at, consumed_at, invalidated_at, '
  + 'target_record_id';
const RESERVATION_COLUMNS = 'reservation_id, grant_id, profile_id, scenario_id, count, state, reserved_at, settled_at';
const SELECT_GRANT_SQL = `SELECT ${GRANT_COLUMNS} FROM execution_grants WHERE grant_id = ?`;
const SELECT_OPEN_GRANTS_SQL = `SELECT ${GRANT_COLUMNS} FROM execution_grants WHERE consumed_at IS NULL AND invalidated_at IS NULL ORDER BY grant_id`;
const SELECT_SCENARIO_OPEN_GRANTS_SQL = `SELECT ${GRANT_COLUMNS} FROM execution_grants
  WHERE scenario_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL ORDER BY grant_id`;
const SELECT_GRANT_USED_SQL = 'SELECT count(*) AS n FROM execution_grants WHERE grant_id = ? OR job_id = ?';
/** 消費済みで、予約が決着していない（`RESERVED` のまま）許可の数（動いている書き込み）。 */
const SELECT_IN_FLIGHT_COUNT_SQL = `SELECT count(DISTINCT g.grant_id) AS n FROM execution_grants AS g
  JOIN write_reservations AS r ON r.grant_id = g.grant_id WHERE g.consumed_at IS NOT NULL AND r.state = ?`;
const SELECT_GRANT_RESERVATION_SQL = `SELECT ${RESERVATION_COLUMNS} FROM write_reservations WHERE grant_id = ? ORDER BY reservation_id LIMIT 1`;
const SELECT_RESERVATION_SQL = `SELECT ${RESERVATION_COLUMNS} FROM write_reservations WHERE reservation_id = ?`;
const SELECT_SCENARIO_RESERVATIONS_SQL = `SELECT ${RESERVATION_COLUMNS} FROM write_reservations WHERE scenario_id = ? ORDER BY reservation_id`;
const INSERT_GRANT_SQL = `INSERT INTO execution_grants (${GRANT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`;
const INSERT_RESERVATION_SQL = `INSERT INTO write_reservations (grant_id, profile_id, scenario_id, count, state, reserved_at, settled_at)
  VALUES (?, ?, ?, ?, ?, ?, NULL)`;
const UPDATE_GRANT_CONSUMED_SQL = `UPDATE execution_grants SET consumed_at = ?
  WHERE grant_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL`;
const UPDATE_GRANT_INVALIDATED_SQL = `UPDATE execution_grants SET invalidated_at = max(?, issued_at)
  WHERE grant_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL`;
const UPDATE_GRANT_RESERVATIONS_RELEASED_SQL = `UPDATE write_reservations SET state = ?, settled_at = max(?, reserved_at)
  WHERE grant_id = ? AND state = ?`;
const UPDATE_RESERVATION_STATE_SQL = `UPDATE write_reservations SET state = ?, settled_at = max(?, reserved_at)
  WHERE reservation_id = ? AND state = ?`;

/** 予約中と、返した予約の状態。 */
const RESERVED_STATE = 'RESERVED' satisfies WriteReservationState;
const RELEASED_STATE = 'RELEASED' satisfies WriteReservationState;
/** 予約の状態の変更の行き先（遷移の表のどこかの行き先）。 */
const SETTLEMENT_TARGETS: ReadonlySet<WriteReservationState> = new Set(Object.values(WRITE_RESERVATION_TRANSITIONS).flat());

/** 入力の規則の欄ごとの問題が、まだないときの空の一覧。 */
const NO_RULE_PROBLEMS: readonly FieldRuleProblem[] = Object.freeze([]);

const grantRejected = (
  reason: ExecutionGrantRejectionReason,
  invalidityReasons: readonly ApprovalInvalidityReason[] = NO_INVALIDITY_REASONS,
  ruleProblems: readonly FieldRuleProblem[] = NO_RULE_PROBLEMS,
): ExecutionGrantResult => deepFreeze({ ok: false, reason, invalidityReasons: [...invalidityReasons], ruleProblems: [...ruleProblems] });

const isWriteReservationState = (value: string): value is WriteReservationState => (WRITE_RESERVATION_STATES as readonly string[]).includes(value);

const reservationViewOf = (row: ReservationRow): WriteReservationView => {
  if (!isWriteReservationState(row.state)) {
    throw integrityError('write_reservations', 'state is not in the closed list');
  }
  return Object.freeze({
    reservationId: row.reservation_id,
    grantId: row.grant_id,
    profileId: row.profile_id,
    scenarioId: row.scenario_id,
    count: row.count,
    state: row.state,
    reservedAt: row.reserved_at,
    settledAt: row.settled_at,
  });
};

const grantRowOf = (connection: SqliteConnection, grantId: string): GrantRow | undefined =>
  connection.prepare(SELECT_GRANT_SQL).get(grantId) as GrantRow | undefined;

const grantViewOf = (connection: SqliteConnection, row: GrantRow): ExecutionGrantView => {
  const reservation = connection.prepare(SELECT_GRANT_RESERVATION_SQL).get(row.grant_id) as ReservationRow | undefined;
  if (reservation === undefined) {
    throw integrityError('write_reservations', 'the reservation of the grant was not found');
  }
  return deepFreeze({
    grantId: row.grant_id,
    profileId: row.profile_id,
    scenarioId: row.scenario_id,
    scenarioRevision: row.scenario_revision,
    approvalReceiptId: row.approval_receipt_id,
    jobId: row.job_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    invalidatedAt: row.invalidated_at,
    targetRecordId: requireStoredTarget(row.target_record_id),
    reservation: reservationViewOf(reservation),
  });
};

/** 保存した許可の対象のレコードの ID（T31e。null か、登録の ID の形。違えばデータベースの誤り）。 */
const requireStoredTarget = (targetRecordId: string | null): string | null => {
  if (targetRecordId !== null && !isUsableRecordId(targetRecordId)) {
    throw integrityError('execution_grants', 'target_record_id is not a usable record id');
  }
  return targetRecordId;
};

/** UPDATE のシナリオの kind（T31e。CC-106: 種類の一覧の owner の名前つきの定数）。 */
const UPDATE_KIND = UPDATE_SCENARIO_KIND;

/**
 * UPDATE のシナリオの、今の対象のレコードの ID（T31e。参照した CREATE のシナリオの `VERIFIED` の登録の最新の 1 件。呼び出し側のトランザクションの中で
 * 読む）。UPDATE でない・UPDATE の指定がないシナリオは null。
 */
/**
 * 台帳（参照した CREATE のシナリオ）の今の版の登録の ID の取り方（T31R-fix-1 の I-2。下書きの確かめと同じ事実 `scenarioKindFactsIn` から読む。
 * 台帳がない・未指定なら null）。
 */
const ledgerRecordIdIn = (connection: SqliteConnection, profileId: string, ledgerScenarioId: string): ScenarioRecordIdSpec | null =>
  ledgerFactIn(connection, profileId, ledgerScenarioId)?.recordId ?? null;

/** 台帳の今の版の事実（T41b。下書きの確かめと同じ `scenarioKindFactsIn`。API の登録の応答の鍵の取り方を含む。なければ undefined）。 */
const ledgerFactIn = (connection: SqliteConnection, profileId: string, ledgerScenarioId: string): ScenarioKindFact | undefined =>
  scenarioKindFactsIn(connection, profileId).find(({ scenarioId }) => scenarioId === ledgerScenarioId);

/**
 * API の UPDATE の台帳の結び付きの誤り（T41b の発行の確かめ直しを、T41e-2 で開始の画面の読み出しと共用するために取り出した）: 台帳の今の登録の ID の取り方に、
 * filter の名前と更新の画面の path の型が結び付かなければ、その理由（唯一の判定 `apiUpdateLedgerBindingRejectionOf`）。API の UPDATE でなければ null。
 */
const apiUpdateLedgerRejectionIn = (
  connection: SqliteConnection,
  profileId: string,
  scenario: ScenarioRevision,
): ReturnType<typeof apiUpdateLedgerBindingRejectionOf> => {
  const apiLedger = scenario.kind === UPDATE_KIND ? scenario.api?.ledger ?? null : null;
  if (apiLedger === null || scenario.api === undefined) {
    return null;
  }
  const fact = ledgerFactIn(connection, profileId, apiLedger.targetCreateScenarioId);
  // T41R-fix-B: 台帳が同じ表（同じ API の Origin と path の型）の API の登録であることも、同じ部品で確かめ直す（台帳がなければ、送り先が分からないので拒む）。
  const { request } = scenario.api;
  return apiUpdateLedgerBindingRejectionOf(
    { filterName: scenario.api.filterName, formPathTemplate: apiLedger.formPathTemplate, origin: request.origin, pathShape: request.pathShape },
    { recordId: fact?.recordId ?? null, apiRecordId: fact?.apiRecordId ?? null, apiRequest: fact?.apiRequest ?? null },
  );
};

// T41R2-fix-B: UPDATE のシナリオの台帳の参照の決まり（`updateLedgerScenarioIdOf`）は、同じ台帳のシナリオの集まりと共用するため `scenario-contracts.ts` へ移した。

/** T41b: 対象の選び方は Task 31 と同じ部品（台帳の照合済みの登録の最新の 1 件）。API の UPDATE は `api.ledger` の台帳から選ぶ。 */
const updateTargetOfIn = (connection: SqliteConnection, scenario: ScenarioRevision): string | null => {
  const ledgerScenarioId = updateLedgerScenarioIdOf(scenario);
  return ledgerScenarioId === null ? null : selectUpdateTargetRecordId(verifiedRegistrationsIn(connection, ledgerScenarioId));
};

/** 消費していない許可を無効にし、その `RESERVED` の予約を `RELEASED` にする（同じトランザクションの中）。 */
const invalidateGrantIn = (connection: SqliteConnection, grantId: string, at: string): void => {
  connection.prepare(UPDATE_GRANT_RESERVATIONS_RELEASED_SQL).run(RELEASED_STATE, at, grantId, RESERVED_STATE);
  connection.prepare(UPDATE_GRANT_INVALIDATED_SQL).run(at, grantId);
};

/** シナリオの、消費していない有効な許可を、すべて無効にして予約を返す（撤回の同じトランザクションの中。節 2 が呼ぶ）。 */
const releaseOpenGrantsIn = (connection: SqliteConnection, scenarioId: string, at: string): void => {
  for (const grant of connection.prepare(SELECT_SCENARIO_OPEN_GRANTS_SQL).all(scenarioId) as unknown as GrantRow[]) {
    invalidateGrantIn(connection, grant.grant_id, at);
  }
};

/** 期限切れの判定に要る許可の項目。 */
const expiringGrantOf = (grant: GrantRow): ExpiringGrant => ({
  grantId: grant.grant_id,
  expiresAt: grant.expires_at,
  consumedAt: grant.consumed_at,
  invalidatedAt: grant.invalidated_at,
});

/** 許可を出したときの承認の記録と版が、今の承認の状態と同じか。 */
const grantMatchesApproval = (grant: GrantRow, row: ScenarioRow, state: ScenarioApprovalState): boolean =>
  state.validity.approved && state.validity.receiptId === grant.approval_receipt_id && row.revision === grant.scenario_revision;

/** 呼び出し側の値が、許可の値と同じか（シナリオ・版・ジョブ・プロファイル）。 */
const grantMatchesInput = (grant: GrantRow, input: Omit<GrantConsumption, 'external' | 'at'>): boolean =>
  grant.scenario_id === input.scenarioId && grant.scenario_revision === input.scenarioRevision && grant.job_id === input.jobId
  && grant.profile_id === input.profileId;

interface CheckedIssue extends GrantIssue {
  readonly snapshot: DiscoverySnapshot;
}

const issueIn = (database: ControlDatabase, connection: SqliteConnection, input: CheckedIssue): ExecutionGrantResult => {
  const row = scenarioRowOf(connection, input.scenarioId);
  if (row === undefined) {
    return grantRejected('GRANT_SCENARIO_NOT_FOUND');
  }
  if (row.revision !== input.expectedRevision) {
    return grantRejected('GRANT_REVISION_CONFLICT');
  }
  if (!discoveryUnchangedIn(connection, row.profile_id, input.snapshot)) {
    return grantRejected('GRANT_FACTS_CHANGED');
  }
  // T40a・T41b: API のシナリオも、下の確かめ（有効性、入力の規則、検証の指定、上限、予約）を FORM と同じく使う。LG-3b: T41a の契約のない API の
  // 更新を拒む送り方の確かめ（T38b の重ねの守り）は捨てた（その版は、読むときに `DATABASE_INTEGRITY_FAILED` で止まる）。
  const now = dateOfCompactUtcTimestamp(input.at);
  const state = approvalStateIn(connection, database, row, input.snapshot, input.external, now);
  // LG-3: UPDATE の指定の前に保存した UPDATE の版は、読むときに止まる（T31b の発行の前の確かめは捨てた）。
  if (!state.validity.approved) {
    return grantRejected('GRANT_APPROVAL_INVALID', state.validity.reasons);
  }
  // T28R-fix-1（M-2）: 時計の巻き戻し（承認の時刻より前の発行）は、理由のコードで拒む。
  if (state.lastApproval !== null && input.at < state.lastApproval.approvedAt) {
    return grantRejected('GRANT_CLOCK_BEFORE_APPROVAL');
  }
  const scenario = state.scenario.current;
  if (scenario.inputRuleReference === null) {
    return grantRejected('NEEDS_RULE_INPUT');
  }
  // T29d: 規則の集まりの最新の版（承認の判定で、シナリオの参照と同じことを確かめ済み）で、送る欄すべてに規則が決まっていることを確かめる。
  const latestRules = latestRuleSetIn(connection, row.scenario_id);
  if (latestRules === null) {
    return grantRejected('NEEDS_RULE_INPUT');
  }
  const evaluation = evaluateRuleSet(latestRules.ruleSet, scenario, state.scenario.evidence);
  if (!evaluation.executable) {
    return grantRejected('NEEDS_RULE_INPUT', NO_INVALIDITY_REASONS,
      evaluation.fields.flatMap((field) => (field.problem === null ? [] : [{ fieldName: field.fieldName, problem: field.problem }])));
  }
  // T30d: 検証の指定（成否の条件・登録の ID の取り方・照合の READ）がそろっていないシナリオには、許可を出さない（承認はできる）。
  // T40a-fix: 求める項目は送り方で決まる（API は照合の READ と ID の取り方だけ。判定は `missingVerificationItemsOf`）。
  if (missingVerificationItemsOf(scenario.verification, scenario).length > 0) {
    return grantRejected('VERIFICATION_SPEC_MISSING');
  }
  // T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行の M-1）: API のシナリオの送る値を持たない照合の READ は、実行のたびに変わる値と比べる期待が要る。
  // 入力の規則（毎回同じ値になる欄か）は、シナリオの保存の時にはまだないので、規則を確かめるここで判定する（開始の画面も同じ判定を出す）。
  const varyingRejection = readVerificationVaryingRejectionOf(latestRules.ruleSet, scenario, state.scenario.evidence);
  if (varyingRejection !== null) {
    return grantRejected(varyingRejection);
  }
  // T30d: プロファイルの環境の証跡の参照が空なら、許可を出さない（プロファイルの確かめに重ねた確かめ。設計書 10 章の 4）。
  const evidenceRejection = environmentEvidenceRejectionOf(getProfile(database, row.profile_id)?.profile.environmentEvidenceRef ?? null);
  if (evidenceRejection !== null) {
    return grantRejected(evidenceRejection);
  }
  const openGrants = connection.prepare(SELECT_OPEN_GRANTS_SQL).all() as unknown as GrantRow[];
  // 古い許可: 期限切れ（`expiredOpenGrantIdsOf`。画面の使った件数と同じ判定）と、このシナリオの承認の記録か版が今と違う許可。
  const expiredIds = expiredOpenGrantIdsOf(openGrants.map(expiringGrantOf), now);
  const stale = openGrants.filter((grant) => expiredIds.has(grant.grant_id)
    || (grant.scenario_id === row.scenario_id && !grantMatchesApproval(grant, row, state)));
  const staleIds: ReadonlySet<string> = new Set(stale.map((grant) => grant.grant_id));
  const live = openGrants.filter((grant) => !staleIds.has(grant.grant_id));
  if (live.some((grant) => grant.scenario_id === row.scenario_id)) {
    return grantRejected('GRANT_ALREADY_OPEN');
  }
  const reservations = (connection.prepare(SELECT_SCENARIO_RESERVATIONS_SQL).all(row.scenario_id) as unknown as ReservationRow[])
    .map(reservationViewOf);
  const limitRejection = writeLimitRejectionOf(input.count, scenario.limits, reservations, staleIds);
  if (limitRejection !== null) {
    return grantRejected(limitRejection);
  }
  // T30d: 連続の上限（同じシナリオの最後の書き込みから 5 分、24 時間に 5 件。`UNKNOWN` を数え、`RELEASED` を数えない）。
  const rateRejection = writeRateRejectionOf(reservations, now);
  if (rateRejection !== null) {
    return grantRejected(rateRejection);
  }
  const inFlight = (connection.prepare(SELECT_IN_FLIGHT_COUNT_SQL).get(RESERVED_STATE) as { readonly n: number }).n;
  if (!isWriteConcurrencyAvailable(live.length + inFlight)) {
    return grantRejected('GRANT_WRITE_CONCURRENCY_EXCEEDED');
  }
  // T31R-fix-1 の I-2: 下書きの保存の後に台帳の登録の ID の取り方が変わっていたら、path の型の `{id}` の位置が今の取り方に結び付くかを確かめ直す
  // （下書きの確かめと同じ判定。外れれば何も書かない）。
  if (scenario.kind === UPDATE_KIND && scenario.update !== null && !isUpdatePathBoundToLedger(
    scenario.update.actionPathTemplate, ledgerRecordIdIn(connection, row.profile_id, scenario.update.targetCreateScenarioId),
  )) {
    return grantRejected('SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID');
  }
  // T41b（Task 41 の設計書 3.2）: API の UPDATE も、台帳の今の登録の ID の取り方に、filter の名前と更新の画面の path の型が結び付くかを確かめ直す
  // （下書きの確かめと同じ唯一の判定 `apiUpdateLedgerBindingRejectionOf`。外れれば何も書かない）。T41e-2: 開始の画面と同じ部品（`apiUpdateLedgerRejectionIn`）。
  const bindingRejection = apiUpdateLedgerRejectionIn(connection, row.profile_id, scenario);
  if (bindingRejection !== null) {
    return grantRejected(bindingRejection);
  }
  // T31e: UPDATE の対象を、同じトランザクションの中で選び直し、画面が見せた予定の ID と照らす（2 つの process の競争でも、選び直しと結び付けは
  // 1 つのトランザクション）。CREATE に予定の ID を渡すのは、呼び出し側の誤り。
  const expectedTarget = input.expectedTargetRecordId ?? null;
  let targetRecordId: string | null = null;
  if (scenario.kind === UPDATE_KIND) {
    targetRecordId = updateTargetOfIn(connection, scenario);
    const targetRejection = targetSelectionRejectionOf(targetRecordId, expectedTarget);
    if (targetRejection !== null) {
      return grantRejected(targetRejection);
    }
  } else if (expectedTarget !== null) {
    throw new RangeError('a CREATE scenario has no update target');
  }
  if ((connection.prepare(SELECT_GRANT_USED_SQL).get(input.grantId, input.jobId) as { readonly n: number }).n > 0) {
    throw new RangeError('the grant id or the job id is already used');
  }
  for (const grant of stale) {
    invalidateGrantIn(connection, grant.grant_id, input.at);
  }
  connection.prepare(INSERT_GRANT_SQL).run(
    input.grantId, row.profile_id, row.scenario_id, row.revision, state.validity.receiptId, input.jobId, input.at, executionGrantExpiresAtOf(input.at),
    targetRecordId,
  );
  connection.prepare(INSERT_RESERVATION_SQL).run(input.grantId, row.profile_id, row.scenario_id, input.count, RESERVED_STATE, input.at);
  const written = grantRowOf(connection, input.grantId);
  if (written === undefined) {
    throw integrityError('execution_grants', 'the written row was not found');
  }
  return Object.freeze({ ok: true, grant: grantViewOf(connection, written) });
};

interface CheckedConsumption extends GrantConsumption {
  readonly snapshot: DiscoverySnapshot | null;
}

const consumeIn = (database: ControlDatabase, connection: SqliteConnection, input: CheckedConsumption): ExecutionGrantResult => {
  const grant = grantRowOf(connection, input.grantId);
  if (grant === undefined || input.snapshot === null) {
    return grantRejected('GRANT_NOT_FOUND');
  }
  if (!grantMatchesInput(grant, input)) {
    return grantRejected('GRANT_MISMATCH');
  }
  if (grant.consumed_at !== null) {
    return grantRejected('GRANT_ALREADY_CONSUMED');
  }
  if (grant.invalidated_at !== null) {
    return grantRejected('GRANT_INVALIDATED');
  }
  // T28R-fix-1（M-2）: 時計の巻き戻し（発行の時刻より前の消費）は、理由のコードで拒む（何も書かない）。
  if (input.at < grant.issued_at) {
    return grantRejected('GRANT_CLOCK_BEFORE_ISSUE');
  }
  const now = dateOfCompactUtcTimestamp(input.at);
  if (isExecutionGrantExpired(grant.expires_at, now)) {
    invalidateGrantIn(connection, grant.grant_id, input.at);
    return grantRejected('GRANT_EXPIRED');
  }
  if (!discoveryUnchangedIn(connection, grant.profile_id, input.snapshot)) {
    return grantRejected('GRANT_FACTS_CHANGED');
  }
  const row = scenarioRowOf(connection, grant.scenario_id);
  if (row === undefined) {
    throw integrityError('execution_grants', 'the scenario of the grant does not exist');
  }
  const state = approvalStateIn(connection, database, row, input.snapshot, input.external, now);
  if (!state.validity.approved) {
    return grantRejected('GRANT_APPROVAL_INVALID', state.validity.reasons);
  }
  if (!grantMatchesApproval(grant, row, state)) {
    return grantRejected('GRANT_MISMATCH');
  }
  const changes = connection.prepare(UPDATE_GRANT_CONSUMED_SQL).run(input.at, grant.grant_id).changes;
  const written = grantRowOf(connection, grant.grant_id);
  if (Number(changes) !== ONE_ROW || written === undefined) {
    throw integrityError('execution_grants', 'the consumed row was not found');
  }
  return Object.freeze({ ok: true, grant: grantViewOf(connection, written) });
};

const settleIn = (connection: SqliteConnection, input: ReservationSettlement): WriteReservationResult => {
  const row = connection.prepare(SELECT_RESERVATION_SQL).get(input.reservationId) as ReservationRow | undefined;
  if (row === undefined) {
    return Object.freeze({ ok: false, reason: 'RESERVATION_NOT_FOUND' });
  }
  const current = reservationViewOf(row);
  const consumed = grantRowOf(connection, current.grantId)?.consumed_at !== null;
  if (!isWriteReservationTransitionAllowed(current.state, input.to) || (input.to !== RELEASED_STATE && !consumed)) {
    return Object.freeze({ ok: false, reason: 'RESERVATION_TRANSITION_NOT_ALLOWED' });
  }
  const changes = connection.prepare(UPDATE_RESERVATION_STATE_SQL).run(input.to, input.at, current.reservationId, current.state).changes;
  const written = connection.prepare(SELECT_RESERVATION_SQL).get(input.reservationId) as ReservationRow | undefined;
  if (Number(changes) !== ONE_ROW || written === undefined) {
    throw integrityError('write_reservations', 'the changed row was not found');
  }
  return Object.freeze({ ok: true, reservation: reservationViewOf(written) });
};

/** 許可の口に共通の、ID と外の事実の確かめ。 */
const requireGrantIdentity = <T extends Omit<GrantConsumption, 'at'>>(input: T): T => Object.freeze({
  ...input,
  grantId: requireId(input.grantId, 'grant id'),
  scenarioId: requireId(input.scenarioId, 'scenario id'),
  scenarioRevision: requireRevision(input.scenarioRevision),
  jobId: requireId(input.jobId, 'job id'),
  external: requireExternal(input.external),
});

/** 許可のプロファイルの発見の索引（許可がなければ null）。 */
const grantSnapshotOf = (database: ControlDatabase, grantId: string): DiscoverySnapshot | null => {
  const profileId = withReadTransaction(database, (connection) => grantRowOf(connection, grantId)?.profile_id ?? null);
  return profileId === null ? null : discoverySnapshotOf(database, profileId);
};

/**
 * 実行の許可を発行する（許可と予約を書く）。1 つのトランザクションの中で、承認の判定・入力の規則の参照・消費していない有効な許可・件数の上限・
 * 書き込みの同時実行の枠を確かめる。拒むときは理由を返して何も書かない。使った許可の ID かジョブの ID は `RangeError`。
 */
export const issueExecutionGrant = (database: ControlDatabase, input: GrantIssue): ExecutionGrantResult => {
  const scenarioId = requireId(input.scenarioId, 'scenario id');
  const expectedTargetRecordId = input.expectedTargetRecordId ?? null;
  if (expectedTargetRecordId !== null && !isUsableRecordId(expectedTargetRecordId)) {
    throw new RangeError('the expected update target must be null or a usable record id');
  }
  const values = {
    scenarioId,
    expectedRevision: requireRevision(input.expectedRevision),
    grantId: requireId(input.grantId, 'grant id'),
    jobId: requireId(input.jobId, 'job id'),
    count: input.count,
    expectedTargetRecordId,
    external: requireExternal(input.external),
    at: requireTimestamp(input.at),
  };
  const profileId = profileIdOfScenario(database, scenarioId);
  if (profileId === null) {
    return grantRejected('GRANT_SCENARIO_NOT_FOUND');
  }
  const checked: CheckedIssue = Object.freeze({ ...values, snapshot: discoverySnapshotOf(database, profileId) });
  return withWriteTransaction(database, (connection) => issueIn(database, connection, checked));
};

/**
 * 実行の許可を消費する（ジョブの開始のときに 1 回だけ）。許可の値の一致・未消費・未無効・期限・承認の判定を、1 つのトランザクションの中で確かめる。
 * 期限切れの許可は、無効にして予約を返してから拒む。ほかの拒むときは何も書かない。
 */
export const consumeExecutionGrant = (database: ControlDatabase, input: GrantConsumption): ExecutionGrantResult => {
  const values = Object.freeze({ ...requireGrantIdentity(input), at: requireTimestamp(input.at) });
  const checked: CheckedConsumption = Object.freeze({ ...values, snapshot: grantSnapshotOf(database, values.grantId) });
  return withWriteTransaction(database, (connection) => consumeIn(database, connection, checked));
};

/**
 * 書き込みの要求の前の確かめ直し（Task 30 が呼ぶ。読むだけ）。許可が消費済みで、無効でなく、承認が今も有効で、承認の記録と版が許可を出したときと
 * 同じなら受ける。結果で返す（投げない。呼び出し側の誤りは `RangeError`）。
 */
export const assertGrantStillValid = (database: ControlDatabase, input: GrantRecheck): ExecutionGrantResult => {
  const values = requireGrantIdentity(input);
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new RangeError('the clock must be a valid Date');
  }
  const snapshot = grantSnapshotOf(database, values.grantId);
  return withReadTransaction(database, (connection) => {
    const grant = grantRowOf(connection, values.grantId);
    if (grant === undefined || snapshot === null) {
      return grantRejected('GRANT_NOT_FOUND');
    }
    if (!grantMatchesInput(grant, values)) {
      return grantRejected('GRANT_MISMATCH');
    }
    if (grant.invalidated_at !== null) {
      return grantRejected('GRANT_INVALIDATED');
    }
    if (grant.consumed_at === null) {
      return grantRejected('GRANT_NOT_CONSUMED');
    }
    // T28R-fix-1（I-2）: 予約が `RESERVED` のときだけ受ける（送った・分からない・返した後の許可で、次の書き込みの要求を送らない）。
    const view = grantViewOf(connection, grant);
    if (view.reservation.state !== RESERVED_STATE) {
      return grantRejected('GRANT_RESERVATION_SETTLED');
    }
    const row = scenarioRowOf(connection, grant.scenario_id);
    if (row === undefined) {
      throw integrityError('execution_grants', 'the scenario of the grant does not exist');
    }
    const state = approvalStateIn(connection, database, row, snapshot, values.external, input.now);
    if (!state.validity.approved) {
      return grantRejected('GRANT_APPROVAL_INVALID', state.validity.reasons);
    }
    return grantMatchesApproval(grant, row, state) ? Object.freeze({ ok: true, grant: view }) : grantRejected('GRANT_MISMATCH');
  });
};

/**
 * 予約を返す（`RESERVED` から `RELEASED` へだけ）。拒むときは理由を返して何も書かない。
 * T30e（T30d の発見事項 2 の判断）: 送った・分からない（`COMMITTED`・`UNKNOWN`）の締めは、書き込みの結果の記録を伴う口（`settleWriteResult`、
 * `closeOrphanedWriteResults`）だけが行う。ここで `COMMITTED`・`UNKNOWN` を求めると `RangeError`（行き先が遷移の表のどこにもない状態も同じ）。
 */
export const settleWriteReservation = (database: ControlDatabase, input: ReservationSettlement): WriteReservationResult => {
  if (!Number.isSafeInteger(input.reservationId) || !SETTLEMENT_TARGETS.has(input.to)) {
    throw new RangeError('the reservation id must be an integer and the state must be a target of the transition table');
  }
  if (input.to !== RELEASED_STATE) {
    throw new RangeError('a write reservation is settled as COMMITTED or UNKNOWN only together with its write result (settleWriteResult)');
  }
  const values: ReservationSettlement = Object.freeze({ reservationId: input.reservationId, to: input.to, at: requireTimestamp(input.at) });
  return withWriteTransaction(database, (connection) => settleIn(connection, values));
};

/** 実行の許可 1 件と、その予約（なければ null）。 */
export const readExecutionGrant = (database: ControlDatabase, grantId: string): ExecutionGrantView | null =>
  withReadTransaction(database, (connection) => {
    const row = grantRowOf(connection, grantId);
    return row === undefined ? null : grantViewOf(connection, row);
  });

/**
 * シナリオの累積の使った件数（T28R-fix-1。M-6）。発行の判定と同じ数え方: `usedCumulativeWrites` で、期限を過ぎた、消費していない有効な許可
 * （次の発行のときに無効にして予約を返す許可。`expiredOpenGrantIdsOf`）の予約は数えない。判定の時刻 `now` は注入する。
 */
export const readUsedCumulativeWrites = (database: ControlDatabase, scenarioId: string, now: Date): number =>
  withReadTransaction(database, (connection) => {
    const openGrants = connection.prepare(SELECT_SCENARIO_OPEN_GRANTS_SQL).all(scenarioId) as unknown as GrantRow[];
    const reservations = (connection.prepare(SELECT_SCENARIO_RESERVATIONS_SQL).all(scenarioId) as unknown as ReservationRow[]).map(reservationViewOf);
    return usedCumulativeWrites(reservations, expiredOpenGrantIdsOf(openGrants.map(expiringGrantOf), now));
  });

/**
 * T41e-2（Task 41 の設計書 3.2）: API の UPDATE のシナリオの、台帳の結び付きの誤り（画面の開始の確かめに出す。読むだけ）。発行の確かめ直しと同じ部品
 * （`apiUpdateLedgerRejectionIn`）で、許可を出さない理由を先に示す。API の UPDATE でない・結び付く・シナリオがないときは null。
 */
export const readApiUpdateLedgerBindingRejection = (
  database: ControlDatabase,
  scenarioId: string,
): ReturnType<typeof apiUpdateLedgerBindingRejectionOf> =>
  withReadTransaction(database, (connection) => {
    const row = scenarioRowOf(connection, scenarioId);
    return row === undefined
      ? null
      : apiUpdateLedgerRejectionIn(connection, row.profile_id, revisionViewOf(revisionRowOf(connection, row.scenario_id, row.revision)).scenario);
  });

/**
 * UPDATE のシナリオの、更新の予定のレコードの ID（T31e。画面の開始の確かめに出す。読むだけ）。発行と同じ選び方（参照した CREATE のシナリオの
 * `VERIFIED` の登録の最新の 1 件）。UPDATE でない・UPDATE の指定がない・対象がない・シナリオがないときは null。画面は、この値を発行の
 * `expectedTargetRecordId` に渡す（発行の中で選び直して照らす）。
 */
export const readPlannedUpdateTarget = (database: ControlDatabase, scenarioId: string): string | null =>
  withReadTransaction(database, (connection) => {
    const row = scenarioRowOf(connection, scenarioId);
    return row === undefined ? null : updateTargetOfIn(connection, revisionViewOf(revisionRowOf(connection, row.scenario_id, row.revision)).scenario);
  });

/**
 * シナリオの生成の履歴（T31e。Task 31 の設計書 4 章の「台帳の読み出し」、T31d の申し送り）。同じ台帳の CREATE と UPDATE のシナリオ
 * （`writeFamilyScenarioIdsIn`）の使った値（CREATE の登録の値と、UPDATE で送った値）から、そのシナリオの一意にする欄の組（`uniqueKeyFieldNames`。
 * 生成の判定 `evaluateRuleSet` の `uniqueKeyFieldNames`）で鍵を求め直す（`writeGenerationHistoryIn`）。電話番号はプロファイルの使った番号のまま。
 * 1 つの読むトランザクションの中で読む。
 */
export const readScenarioWriteGenerationHistory = (
  database: ControlDatabase,
  scenarioId: string,
  uniqueKeyFieldNames: readonly string[],
): WriteGenerationHistory =>
  withReadTransaction(database, (connection) =>
    writeGenerationHistoryIn(connection, scenarioId, writeFamilyScenarioIdsIn(connection, scenarioId), uniqueKeyFieldNames));

/**
 * 同じ台帳のシナリオ（`writeFamilyScenarioIdsIn`。生成の履歴と同じ集まり）の書き込みの値の履歴（T41R2-fix-B。Task 41 の設計書 8 章の「T41R2」の C-2 (1)）。
 * 開始の口（`write-job-start.ts` の `writeStartSpecOf`）が、対象のレコードの保つ鍵ごとの最後に分かっている値（T41R3-fix-B）を求めるのに使う。1 つの読むトランザクションの中で読む。
 */
export const readLedgerValueWrites = (database: ControlDatabase, scenarioId: string): readonly RecordValueWrite[] =>
  withReadTransaction(database, (connection) => ledgerValueWritesIn(connection, writeFamilyScenarioIdsIn(connection, scenarioId)));

/** シナリオの予約の一覧（予約の順）。 */
export const readWriteReservations = (database: ControlDatabase, scenarioId: string): readonly WriteReservationView[] =>
  withReadTransaction(database, (connection) => Object.freeze(
    (connection.prepare(SELECT_SCENARIO_RESERVATIONS_SQL).all(scenarioId) as unknown as ReservationRow[]).map(reservationViewOf),
  ));

// ===============================================================================================================
// 節 4: 書き込みの結果（T30d。Task 30 の設計書 3 章の「予約の締め」「`UNKNOWN` の後」「記録」。決まりは `src/control/actions/`）
// - 記録は 2 段。送る前（`recordWriteAttempt`）: 許可が消費済みで、無効でなく、予約が `RESERVED` で、ジョブの id が許可のものと同じときだけ、生成した値
//   （送る値。合成のテストデータなので平文）・seed の記録・一意にする欄の組・作った電話番号を書く（結果の列は空）。送る値の欄は、許可の版のシナリオの
//   送る欄の中だけ。1 つの許可・ジョブに 1 行。
// - 締め（`settleWriteResult`）: 呼び出し側の報告（送信の状態、止めた理由、HTTP の状態、結果の判定、登録の ID、照合の結果、送信の時刻）から、
//   `actionOutcomeOf`（`ActionResult` と理由）と `reservationSettlementOf`（予約の締め方。応答の有無は HTTP の状態の有無）で決め、書き込みの結果の行と
//   予約を同じトランザクションで 1 回だけ書く（呼び出し側の言う結果を信じない）。食い違う報告は呼び出し側の誤り（`RangeError`）。受けない登録の ID は
//   null で書く（`usableRecordIdOf`）。
// - 回復（`closeOrphanedWriteResults`）: 終わっていないジョブ（`ACTIVE_AUDIT_JOB_STATES`）のものでない、消費済みで無効でなく予約が `RESERVED` のままの
//   許可を、送信の状態 `UNKNOWN` で締める（`UNKNOWN`・`NO_RESPONSE`、予約は `UNKNOWN`）。送る前の記録がなければ、値なしの行を足してから締める。
//   締めた数を返す。二重に締めない（2 回目は 0）。画面のサーバの起動の回復（`audit-job-manager.ts`）が、自動ログインの未確定の試しの閉じ方と同じ所で呼ぶ。
// - 締めた行の結果の列は書き換えない（UPDATE は、締めていない行の結果の列だけ。Architecture Gate の (m)）。
// - 送らずに止めたときの締め（`closeWriteWithoutSending`。T30e。ジョブの開始の途中で止めたとき、ジョブの管理が呼ぶ）: 消費済みで予約が `RESERVED` の
//   許可は、送る前の記録（なければ値なしの行を足す）を `NOT_SENT`（`PRECHECK_FAILED`）で締める（`BLOCKED`・`RELEASED`）。消費していない、そのジョブの
//   許可（無効にしていない）は、無効にして予約を返す。ほかのジョブの許可、ない許可、締めた許可は変えない。
// - T31e（Task 31 の設計書 3 章の「証拠と記録」。管理データの版 9）: 書き込みの種類は、許可の版のシナリオの kind から、対象のレコードの ID は、許可に
//   結んだ ID から書く（ワーカーの報告を鵜呑みにしない。回復と、送らずに止めたときの締めで足す行も同じ）。締めの報告の UPDATE の証拠
//   （`updateEvidence`）は、UPDATE の行だけが持て（CREATE の行に渡すのは `RangeError`）、変えた欄は許可の版のシナリオの変える欄の中で、新しい値は
//   送る前の記録の値と同じであること。T31e fix round 1: UPDATE の結果は、対象の ID（行の値）と、証拠の欄の一致（`fieldsMatchedOf`）も入れて
//   `actionOutcomeOf` で決める（取れた ID が対象と違えば `UNKNOWN` の `RECORD_ID_MISMATCH`、一致しない欄があれば `UNKNOWN` の
//   `UNEXPECTED_FIELD_CHANGE`、証拠がない・照合できない欄があれば `VERIFIED` にしない）。証拠は締めの列として 1 回だけ書く（Gate (m)）。
// - T40c（Task 40 の設計書 3.4。管理データの版 14）: 行を足すとき（送る前の記録、回復、送らずに止めたときの締め）に、送り方と API の型の要約（型の digest、
//   method、Origin、path の型）を、許可の版のシナリオから書く（`writeTransportColumnsOf`。ワーカーの報告を鵜呑みにしない）。締めでは書き換えない。
// ===============================================================================================================

/**
 * 書き込みの結果の記録と締めを拒む理由（閉じた一覧）。
 * - `WRITE_GRANT_NOT_FOUND`: 許可がない。`WRITE_GRANT_MISMATCH`: ジョブの id が許可のものと違う。`WRITE_GRANT_NOT_CONSUMED`: 許可が消費されていない、
 *   または無効にした。`WRITE_RESERVATION_SETTLED`: 予約がもう締まっている。
 * - `WRITE_ATTEMPT_ALREADY_RECORDED`: その許可かジョブの記録が、もうある。`WRITE_VALUES_NOT_IN_SCENARIO`: 送る値の欄が、許可の版のシナリオの送る欄に
 *   ない。
 * - `WRITE_ATTEMPT_NOT_FOUND`: 締める記録（送る前の記録）がない。`WRITE_RESULT_ALREADY_SETTLED`: もう締めた。
 */
export const WRITE_RESULT_REJECTION_REASONS = Object.freeze([
  'WRITE_GRANT_NOT_FOUND',
  'WRITE_GRANT_MISMATCH',
  'WRITE_GRANT_NOT_CONSUMED',
  'WRITE_RESERVATION_SETTLED',
  'WRITE_ATTEMPT_ALREADY_RECORDED',
  'WRITE_VALUES_NOT_IN_SCENARIO',
  'WRITE_ATTEMPT_NOT_FOUND',
  'WRITE_RESULT_ALREADY_SETTLED',
] as const);
export type WriteResultRejectionReason = (typeof WRITE_RESULT_REJECTION_REASONS)[number];

/** 記録と締めの結果。 */
export type WriteResultStoreResult =
  | { readonly ok: true; readonly result: WriteResultView }
  | { readonly ok: false; readonly reason: WriteResultRejectionReason };

/** 送る前の記録の入力。 */
export interface WriteAttempt {
  /** 書き込みのジョブの id（許可に結び付けたジョブの id）。 */
  readonly jobId: string;
  readonly grantId: string;
  /** 生成の seed の記録（Task 29 の `generateScenarioData` の結果）。 */
  readonly seedRecord: SeedRecord;
  /** 送る値（欄の名前 → 値。送らない欄は持たない）。 */
  readonly submittedValues: Readonly<Record<string, string>>;
  /** 一意にする欄の組の値（`uniqueKeyOf`。組がなければ null）。 */
  readonly uniqueKey: string | null;
  /** 作った電話番号。 */
  readonly phoneNumbers: readonly string[];
  readonly at: string;
}

/** 締めの入力（ワーカーの報告。結果と予約の締め方は、ここから決める）。 */
export interface WriteOutcomeReport {
  readonly jobId: string;
  readonly submission: SubmissionState;
  /** 送らずに止めた理由（`NOT_SENT` のときだけ）。 */
  readonly blockReason: ActionBlockReason | null;
  /** 送信の後の main frame の文書の HTTP の状態（応答がなければ null）。 */
  readonly httpStatus: number | null;
  /** 結果の判定（応答があるときだけ）。 */
  readonly responseJudgement: ResponseJudgement | null;
  readonly recordId: string | null;
  /** 照合の READ の結果（Task 27 の結果。実行しなければ null）。 */
  readonly readVerification: ReadCheckResult | null;
  /** 送信の時刻（送らなければ null）。 */
  readonly submittedAt: string | null;
  /** UPDATE の証拠（T31e。UPDATE の行だけ。照合まで進まなかったときは省略か null）。 */
  readonly updateEvidence?: WriteUpdateEvidence | null;
  readonly at: string;
}

/** 締めて書く値。 */
interface SettledWriteValues {
  readonly submission: SubmissionState;
  readonly blockReason: ActionBlockReason | null;
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly recordId: string | null;
  readonly readVerification: ReadCheckResult | null;
  readonly submittedAt: string | null;
  readonly updateEvidence: WriteUpdateEvidence | null;
  readonly at: string;
}

const INSERT_WRITE_RESULT_SQL = `INSERT INTO write_results (job_id, grant_id, profile_id, scenario_id, scenario_revision, write_kind, target_record_id,
  seed_record, submitted_values, unique_key, phone_numbers, recorded_at, transport, api_shape_digest, api_method, api_origin, api_path_shape)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_WRITE_RESULT_SETTLED_SQL = `UPDATE write_results SET submission = ?, block_reason = ?, http_status = ?, response_judgement = ?,
  record_id = ?, read_verification = ?, update_evidence = ?, result = ?, reason = ?, reservation_state = ?, submitted_at = ?, settled_at = ?
  WHERE job_id = ? AND settled_at IS NULL`;
/** 終わっていないジョブのものでない、消費済みで無効でなく、予約が締まっていない許可（回復）。 */
const SELECT_ORPHANED_WRITE_GRANTS_SQL = `SELECT ${GRANT_COLUMNS} FROM execution_grants AS g
  WHERE g.consumed_at IS NOT NULL AND g.invalidated_at IS NULL
  AND EXISTS (SELECT 1 FROM write_reservations AS r WHERE r.grant_id = g.grant_id AND r.state = ?)
  AND g.job_id NOT IN (SELECT job_id FROM jobs WHERE state IN (SELECT value FROM json_each(?))) ORDER BY g.grant_id`;

const ACTIVE_JOB_STATES_JSON = JSON.stringify(ACTIVE_AUDIT_JOB_STATES);
/** 回復で足す行の、空の送る値と電話番号。 */
const NO_SUBMITTED_VALUES = '{}';
const NO_PHONE_NUMBERS = '[]';
/** 回復で締める報告（送ったか分からない）。 */
const UNKNOWN_SUBMISSION = 'UNKNOWN' satisfies SubmissionState;

const writeRejected = (reason: WriteResultRejectionReason): WriteResultStoreResult => Object.freeze({ ok: false, reason });

/** 遅い方の時刻（UTC の 14 桁は、文字列の順が時刻の順）。 */
const laterOf = (left: string, right: string): string => (left >= right ? left : right);

/** 閉じた一覧の値か。 */
const isOneOfList = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);

/** seed の記録の形（呼び出し側の誤りは `RangeError`）。 */
const requireSeedRecord = (record: SeedRecord): string => {
  // 分解して読む（Gate (g) の近似は、`.seed` を版の一覧の中身の参照とみなすため）。
  const { seed: dataSeed, seedInput, baseDate, attempt } = isRecord(record) ? record : ({} as Partial<SeedRecord>);
  if (!isDataSeed(dataSeed) || !isRecord(seedInput) || typeof baseDate !== 'string' || !isNonNegativeSafeInteger(attempt)) {
    throw new RangeError('the seed record must have a seed, a seed input, a base date and an attempt number');
  }
  return JSON.stringify(record);
};

/** 送る値の形（呼び出し側の誤りは `RangeError`）。 */
const requireSubmittedValues = (values: Readonly<Record<string, string>>): Readonly<Record<string, string>> => {
  if (!isRecord(values)) {
    throw new RangeError('the submitted values must be an object');
  }
  const entries = Object.entries(values);
  if (entries.length > MAX_SCENARIO_FIELD_NAMES || entries.some(([name, value]) => name.length === 0 || name.length > MAX_FIELD_NAME_LENGTH
    || typeof value !== 'string' || value.length > MAX_SUBMITTED_VALUE_LENGTH)) {
    throw new RangeError('the submitted values must be at most the field names of a scenario, with names and string values of the limits');
  }
  return Object.freeze(Object.fromEntries(entries));
};

/** 送る前の記録の入力の確かめ（呼び出し側の誤りは `RangeError`）。 */
const requireAttempt = (input: WriteAttempt): WriteAttempt & { readonly seedJson: string } => {
  const { uniqueKey, phoneNumbers } = input;
  if (uniqueKey !== null && (typeof uniqueKey !== 'string' || uniqueKey.length === 0)) {
    throw new RangeError('the unique key must be null or a non-empty string');
  }
  if (!Array.isArray(phoneNumbers) || phoneNumbers.some((phone) => typeof phone !== 'string' || phone.length === 0)) {
    throw new RangeError('the phone numbers must be non-empty strings');
  }
  return Object.freeze({
    jobId: requireId(input.jobId, 'job id'),
    grantId: requireId(input.grantId, 'grant id'),
    seedRecord: input.seedRecord,
    seedJson: requireSeedRecord(input.seedRecord),
    submittedValues: requireSubmittedValues(input.submittedValues),
    uniqueKey,
    phoneNumbers: Object.freeze([...phoneNumbers]),
    at: requireTimestamp(input.at),
  });
};

/**
 * 締めの報告の確かめ（呼び出し側の誤りは `RangeError`）: 閉じた一覧、HTTP の状態の範囲、時刻の形と、食い違い（`NOT_SENT` は止めた理由だけを持つ、
 * `UNKNOWN` は応答の項目を持たない、`SENT` は止めた理由を持たない、結果の判定は応答があるときだけ）。
 */
const requireReport = (report: WriteOutcomeReport): SettledWriteValues & { readonly jobId: string } => {
  const { submission, blockReason, httpStatus, responseJudgement, recordId, readVerification, submittedAt } = report;
  // T31e: UPDATE の証拠の形（形が違えば呼び出し側の誤り）。
  const updateEvidence = report.updateEvidence === undefined || report.updateEvidence === null ? null : updateEvidenceOf(report.updateEvidence);
  if (report.updateEvidence !== undefined && report.updateEvidence !== null && updateEvidence === null) {
    throw new RangeError('the update evidence must have one entry for each field name, in the contract shape');
  }
  if (!isOneOfList(SUBMISSION_STATES, submission) || (blockReason !== null && !isOneOfList(ACTION_BLOCK_REASONS, blockReason))
    || (responseJudgement !== null && !isOneOfList(RESPONSE_JUDGEMENTS, responseJudgement))
    || (readVerification !== null && !isOneOfList(READ_CHECK_RESULTS, readVerification))
    || (recordId !== null && typeof recordId !== 'string')
    || (httpStatus !== null && (!Number.isSafeInteger(httpStatus) || httpStatus < MIN_HTTP_STATUS || httpStatus > MAX_HTTP_STATUS))) {
    throw new RangeError('the write outcome report must use the closed lists and an HTTP status in range');
  }
  const responseFields = [httpStatus, responseJudgement, recordId, readVerification, submittedAt];
  const consistent = submission === 'SENT'
    ? blockReason === null && (httpStatus === null) === (responseJudgement === null)
    : responseFields.every((field) => field === null) && (blockReason !== null) === (submission === 'NOT_SENT');
  if (!consistent) {
    throw new RangeError('the write outcome report contradicts itself');
  }
  return Object.freeze({
    jobId: requireId(report.jobId, 'job id'),
    submission,
    blockReason,
    httpStatus,
    responseJudgement,
    recordId,
    readVerification,
    submittedAt: submittedAt === null ? null : requireTimestamp(submittedAt),
    updateEvidence,
    at: requireTimestamp(report.at),
  });
};

/** 締めの報告を、`ActionResult` を決める入力にする（T31e fix round 1: UPDATE の行は `update` を足す）。 */
const outcomeInputOf = (values: SettledWriteValues, update?: ActionOutcomeUpdateInput): ActionOutcomeInput => {
  switch (values.submission) {
    case 'NOT_SENT':
      if (values.blockReason === null) {
        throw new RangeError('a NOT_SENT report must have a block reason');
      }
      return { submission: 'NOT_SENT', blockReason: values.blockReason };
    case 'UNKNOWN':
      return { submission: 'UNKNOWN' };
    case 'SENT':
      return {
        submission: 'SENT', responseJudgement: values.responseJudgement, recordId: values.recordId, readVerification: values.readVerification,
        ...(update === undefined ? {} : { update }),
      };
  }
};

/** 許可の予約の行（なければ、データベースの誤り）。 */
const grantReservationOf = (connection: SqliteConnection, grantId: string): ReservationRow => {
  const row = connection.prepare(SELECT_GRANT_RESERVATION_SQL).get(grantId) as ReservationRow | undefined;
  if (row === undefined) {
    throw integrityError('write_reservations', 'the reservation of the grant was not found');
  }
  return row;
};

/**
 * 締めの報告の UPDATE の証拠を、記録の行に照らす（T31e。食い違いは呼び出し側の誤りの `RangeError`）。CREATE の行は証拠を持てない。UPDATE の行の
 * 変えた欄は、許可の版のシナリオの変える欄の中で、新しい値は送る前の記録の値と同じ。保つ欄（`KEPT`）は、変える欄の名前でないこと。
 */
const requireEvidenceOfRow = (connection: SqliteConnection, row: WriteResultView, evidence: WriteUpdateEvidence | null): void => {
  if (evidence === null) {
    return;
  }
  if (row.writeKind !== UPDATE_KIND) {
    throw new RangeError('only an UPDATE write result has update evidence');
  }
  const { scenario } = revisionViewOf(revisionRowOf(connection, row.scenarioId, row.scenarioRevision));
  for (const field of evidence.fields) {
    const changeable = scenario.fieldNames.includes(field.fieldName);
    if (field.role === 'CHANGED' ? !changeable || row.submittedValues[field.fieldName] !== field.newValue : changeable) {
      throw new RangeError('the update evidence does not match the fields of the scenario and the recorded values');
    }
  }
};

/** 締めていない行と、その許可の `RESERVED` の予約を、同じトランザクションの中で締める。 */
const settleWriteIn = (connection: SqliteConnection, row: WriteResultRow, reservation: ReservationRow, values: SettledWriteValues): WriteResultView => {
  if (values.at < row.recorded_at || (values.submittedAt !== null && values.submittedAt < row.recorded_at)) {
    throw new RangeError('the settlement and the submission must not be before the record of the attempt');
  }
  const recorded = writeResultViewOf(row);
  requireEvidenceOfRow(connection, recorded, values.updateEvidence);
  // T31e fix round 1: UPDATE は、対象の ID（許可から書いた行の値）と更新の後の照合の結果を、結果の判定に渡す（ID の違い・欄の変化は `UNKNOWN`）。
  const outcome = actionOutcomeOf(outcomeInputOf(values, recorded.targetRecordId === null
    ? undefined
    : { targetRecordId: recorded.targetRecordId, fieldsMatched: fieldsMatchedOf(values.updateEvidence) }));
  const reservationState = reservationSettlementOf(values.submission, values.httpStatus !== null);
  if (!isWriteReservationTransitionAllowed(RESERVED_STATE, reservationState)) {
    throw integrityError('write_reservations', 'the settlement is not a transition of the table');
  }
  const changes = connection.prepare(UPDATE_WRITE_RESULT_SETTLED_SQL).run(
    values.submission, values.blockReason, values.httpStatus, values.responseJudgement, usableRecordIdOf(values.recordId), values.readVerification,
    values.updateEvidence === null ? null : JSON.stringify(values.updateEvidence), outcome.result, outcome.reason, reservationState, values.submittedAt,
    values.at, row.job_id,
  ).changes;
  const reserved = connection.prepare(UPDATE_RESERVATION_STATE_SQL).run(reservationState, values.at, reservation.reservation_id, RESERVED_STATE).changes;
  const written = writeResultRowOfJob(connection, row.job_id);
  if (Number(changes) !== ONE_ROW || Number(reserved) !== ONE_ROW || written === undefined) {
    throw integrityError('write_results', 'the settled row was not found');
  }
  return writeResultViewOf(written);
};

/**
 * 書き込みの結果の行の送り方と API の型の要約の列（T40c。版 14。`transport`・`api_shape_digest`・`api_method`・`api_origin`・`api_path_shape` の順）。
 * 許可の版のシナリオの送り方と、承認した API の指定から書く（ワーカーの報告を鵜呑みにしない）。FORM は要約の列が null。API なのに API の指定がない版は、
 * データベースの誤り。
 */
type WriteTransportColumns = readonly [ScenarioTransport, string | null, string | null, string | null, string | null];

// T40R-fix-B（M-2）: 送り方の値はシナリオの契約の名前つきの定数（`FORM_SCENARIO_TRANSPORT`・`API_SCENARIO_TRANSPORT`）。
const FORM_TRANSPORT_COLUMNS: WriteTransportColumns = Object.freeze([FORM_SCENARIO_TRANSPORT, null, null, null, null] as const);

const writeTransportColumnsOf = (scenario: ScenarioRevision): WriteTransportColumns => {
  if (scenarioTransportOf(scenario) !== API_SCENARIO_TRANSPORT) {
    return FORM_TRANSPORT_COLUMNS;
  }
  const { api } = scenario;
  if (api === undefined) {
    throw integrityError('scenario_revisions', 'an API scenario has no API spec');
  }
  return Object.freeze([API_SCENARIO_TRANSPORT, api.shapeDigest, api.request.method, api.request.origin, api.request.pathShape] as const);
};

/**
 * 許可の書き込みの種類と対象のレコードの ID（T31e。種類は許可の版のシナリオの kind、対象は許可に結んだ ID。UPDATE なのに対象がない、CREATE なのに
 * 対象がある許可は、データベースの誤り）。T40c: 送り方と API の型の要約の列（`writeTransportColumnsOf`）も返す。
 */
const writeKindOfGrantIn = (
  connection: SqliteConnection,
  grant: GrantRow,
): { readonly kind: ScenarioKind; readonly target: string | null; readonly transport: WriteTransportColumns } => {
  const { scenario } = revisionViewOf(revisionRowOf(connection, grant.scenario_id, grant.scenario_revision));
  if ((scenario.kind === UPDATE_KIND) !== (grant.target_record_id !== null)) {
    throw integrityError('execution_grants', 'the update target of the grant does not match the kind of the scenario');
  }
  return Object.freeze({ kind: scenario.kind, target: requireStoredTarget(grant.target_record_id), transport: writeTransportColumnsOf(scenario) });
};

const recordAttemptIn = (connection: SqliteConnection, input: ReturnType<typeof requireAttempt>): WriteResultStoreResult => {
  const grant = grantRowOf(connection, input.grantId);
  if (grant === undefined) {
    return writeRejected('WRITE_GRANT_NOT_FOUND');
  }
  if (grant.job_id !== input.jobId) {
    return writeRejected('WRITE_GRANT_MISMATCH');
  }
  if (grant.consumed_at === null || grant.invalidated_at !== null) {
    return writeRejected('WRITE_GRANT_NOT_CONSUMED');
  }
  if (grantReservationOf(connection, grant.grant_id).state !== RESERVED_STATE) {
    return writeRejected('WRITE_RESERVATION_SETTLED');
  }
  if (writeResultRowOfJob(connection, input.jobId) !== undefined || writeResultRowOfGrant(connection, input.grantId) !== undefined) {
    return writeRejected('WRITE_ATTEMPT_ALREADY_RECORDED');
  }
  const { scenario } = revisionViewOf(revisionRowOf(connection, grant.scenario_id, grant.scenario_revision));
  if (Object.keys(input.submittedValues).some((name) => !scenario.fieldNames.includes(name))) {
    return writeRejected('WRITE_VALUES_NOT_IN_SCENARIO');
  }
  if (input.at < grant.consumed_at) {
    throw new RangeError('the attempt must not be recorded before the consumption of the grant');
  }
  const { kind, target, transport } = writeKindOfGrantIn(connection, grant);
  connection.prepare(INSERT_WRITE_RESULT_SQL).run(
    input.jobId, grant.grant_id, grant.profile_id, grant.scenario_id, grant.scenario_revision, kind, target, input.seedJson,
    JSON.stringify(input.submittedValues), input.uniqueKey, JSON.stringify(input.phoneNumbers), input.at, ...transport,
  );
  const written = writeResultRowOfJob(connection, input.jobId);
  if (written === undefined) {
    throw integrityError('write_results', 'the written row was not found');
  }
  return Object.freeze({ ok: true, result: writeResultViewOf(written) });
};

const settleResultIn = (connection: SqliteConnection, values: ReturnType<typeof requireReport>): WriteResultStoreResult => {
  const row = writeResultRowOfJob(connection, values.jobId);
  if (row === undefined) {
    return writeRejected('WRITE_ATTEMPT_NOT_FOUND');
  }
  if (row.settled_at !== null) {
    return writeRejected('WRITE_RESULT_ALREADY_SETTLED');
  }
  const reservation = grantReservationOf(connection, row.grant_id);
  if (reservation.state !== RESERVED_STATE) {
    return writeRejected('WRITE_RESERVATION_SETTLED');
  }
  return Object.freeze({ ok: true, result: settleWriteIn(connection, row, reservation, values) });
};

/**
 * 送る前の記録を書く（生成した値と seed の記録。結果の列は空）。許可が消費済みで、予約が `RESERVED` のときだけ。拒むときは理由を返して何も書かない。
 * 形の違う入力・消費より前の時刻は `RangeError`。
 */
export const recordWriteAttempt = (database: ControlDatabase, input: WriteAttempt): WriteResultStoreResult => {
  const values = requireAttempt(input);
  return withWriteTransaction(database, (connection) => recordAttemptIn(connection, values));
};

/**
 * 書き込みの結果を締める（`ActionResult` と予約の締め方は、報告から純粋な決まりで決め、結果の行と予約を同じトランザクションで書く）。拒むときは理由を
 * 返して何も書かない。食い違う報告・形の違う入力・記録より前の時刻は `RangeError`。
 */
export const settleWriteResult = (database: ControlDatabase, report: WriteOutcomeReport): WriteResultStoreResult => {
  const values = requireReport(report);
  return withWriteTransaction(database, (connection) => settleResultIn(connection, values));
};

/**
 * 起動のときの回復（画面のサーバの起動で、終わっていないジョブを中断に直した後に呼ぶ）。終わっていないジョブのものでない、消費済みで予約が締まって
 * いない許可を、送信の状態 `UNKNOWN` で締める（送る前の記録がなければ、値なしの行を足してから）。締めた数を返す。
 */
export const closeOrphanedWriteResults = (database: ControlDatabase, at: string): number => {
  requireTimestamp(at);
  return withWriteTransaction(database, (connection) => {
    const grants = connection.prepare(SELECT_ORPHANED_WRITE_GRANTS_SQL).all(RESERVED_STATE, ACTIVE_JOB_STATES_JSON) as unknown as GrantRow[];
    return grants.filter((grant) => {
      const recordedAt = laterOf(at, grant.consumed_at ?? at);
      if (writeResultRowOfGrant(connection, grant.grant_id) === undefined) {
        const { kind, target, transport } = writeKindOfGrantIn(connection, grant);
        connection.prepare(INSERT_WRITE_RESULT_SQL).run(
          grant.job_id, grant.grant_id, grant.profile_id, grant.scenario_id, grant.scenario_revision, kind, target, null, NO_SUBMITTED_VALUES, null,
          NO_PHONE_NUMBERS, recordedAt, ...transport,
        );
      }
      const row = writeResultRowOfGrant(connection, grant.grant_id);
      if (row === undefined || row.settled_at !== null) {
        return false;
      }
      settleWriteIn(connection, row, grantReservationOf(connection, grant.grant_id), {
        submission: UNKNOWN_SUBMISSION, blockReason: null, httpStatus: null, responseJudgement: null, recordId: null, readVerification: null,
        submittedAt: null, updateEvidence: null, at: laterOf(at, row.recorded_at),
      });
      return true;
    }).length;
  });
};

/** 送らずに止めたときの締めの入力（T30e）。 */
export interface WriteClosureWithoutSending {
  readonly grantId: string;
  /** 許可に結び付けたジョブの id（違えば何もしない）。 */
  readonly jobId: string;
  readonly at: string;
}

/** 送らずに止めたときの締めの結果（T30e）。 */
export type WriteClosureWithoutSendingResult =
  | { readonly kind: 'SETTLED_NOT_SENT'; readonly result: WriteResultView }
  | { readonly kind: 'GRANT_RELEASED' }
  | { readonly kind: 'UNCHANGED' };

const UNCHANGED_CLOSURE: WriteClosureWithoutSendingResult = Object.freeze({ kind: 'UNCHANGED' });
const GRANT_RELEASED_CLOSURE: WriteClosureWithoutSendingResult = Object.freeze({ kind: 'GRANT_RELEASED' });
/** 送らずに止めた理由（送る前の確かめで止めた）。 */
const PRECHECK_FAILED_REASON = 'PRECHECK_FAILED' satisfies ActionBlockReason;

const closeWithoutSendingIn = (connection: SqliteConnection, input: WriteClosureWithoutSending): WriteClosureWithoutSendingResult => {
  const grant = grantRowOf(connection, input.grantId);
  if (grant === undefined || grant.job_id !== input.jobId || grant.invalidated_at !== null) {
    return UNCHANGED_CLOSURE;
  }
  const reservation = grantReservationOf(connection, grant.grant_id);
  if (reservation.state !== RESERVED_STATE) {
    return UNCHANGED_CLOSURE;
  }
  if (grant.consumed_at === null) {
    invalidateGrantIn(connection, grant.grant_id, input.at);
    return GRANT_RELEASED_CLOSURE;
  }
  const recordedAt = laterOf(input.at, grant.consumed_at);
  if (writeResultRowOfGrant(connection, grant.grant_id) === undefined) {
    const { kind, target, transport } = writeKindOfGrantIn(connection, grant);
    connection.prepare(INSERT_WRITE_RESULT_SQL).run(
      grant.job_id, grant.grant_id, grant.profile_id, grant.scenario_id, grant.scenario_revision, kind, target, null, NO_SUBMITTED_VALUES, null,
      NO_PHONE_NUMBERS, recordedAt, ...transport,
    );
  }
  const row = writeResultRowOfGrant(connection, grant.grant_id);
  if (row === undefined || row.settled_at !== null) {
    return UNCHANGED_CLOSURE;
  }
  const result = settleWriteIn(connection, row, reservation, {
    submission: NOT_SENT_SUBMISSION_STATE, blockReason: PRECHECK_FAILED_REASON, httpStatus: null, responseJudgement: null, recordId: null,
    readVerification: null, submittedAt: null, updateEvidence: null, at: laterOf(input.at, row.recorded_at),
  });
  return Object.freeze({ kind: 'SETTLED_NOT_SENT', result });
};

/**
 * 送らずに止めたときの締め（T30e。ジョブの開始の途中で止めたとき、ジョブの管理が呼ぶ）。消費済みの許可は `NOT_SENT`・`BLOCKED`・`RELEASED` で締め、
 * 消費していない、そのジョブの許可は無効にして予約を返す。ほかは変えない。形の違う入力は `RangeError`。
 */
export const closeWriteWithoutSending = (database: ControlDatabase, input: WriteClosureWithoutSending): WriteClosureWithoutSendingResult => {
  const values: WriteClosureWithoutSending = Object.freeze({
    grantId: requireId(input.grantId, 'grant id'),
    jobId: requireId(input.jobId, 'job id'),
    at: requireTimestamp(input.at),
  });
  return withWriteTransaction(database, (connection) => closeWithoutSendingIn(connection, values));
};

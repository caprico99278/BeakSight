// シナリオの行と記録の読み出しと、承認の判定に渡す今の事実の集め方の唯一の owner（Task 28 の設計書 3 章、4.3、4.4。T28c で `scenario-store.ts` に
// 作り、T28d で実行の許可と予約の確かめと共用するために、ここへ移した。書き写さない）。
// - 行から形へ: シナリオの行・版の写し・承認と撤回の記録を、契約の形（`scenario`・`approval-receipt`・`candidate` のスキーマ）で読む。合わなければ
//   データベースの誤り（`DATABASE_INTEGRITY_FAILED`）。
// - 今の事実（`currentFactsIn`）: プロファイル（`getProfile`。トランザクションを開かない読み出し）、照らす READ の定義（`read_checks` の id・プロファイル・
//   版・取り消しの時刻。T30a: 今の版の送る値の名前も。値は読まない）、最後の発見の索引（`readDiscoveryIndex`。自分の読むトランザクションを開くので、書くトランザクションの前に読み
//   （`discoverySnapshotOf`）、書くトランザクションの中で「その後に発見のジョブが記録されていない」ことを確かめ直す（`discoveryUnchangedIn`））、
//   入力の規則の今の参照（T29d: シナリオ自身の参照ではなく、管理データの版 7 の規則の集まりの最新の版の id・版・digest。読み出しの owner は
//   `src/control/data-rules/rule-set-facts.ts`。規則の新しい版を保存すると、参照を付け直す前でも `INPUT_RULES_CHANGED` になる。規則の集まりが
//   なければ null）、管理データの外の 2 つの digest（呼び出し側が求めて渡す）。
// - 承認の状態（`approvalStateIn`）: 今の版・今の事実・最後の承認と撤回の記録から、承認の digest と再承認の判定（`evaluateApprovalValidity`）を求める。
//   承認の状態の読み出し（`readScenarioApprovalStatus`）と、実行の許可の発行・消費・確かめ直しが、同じこの関数を使う。
// - CCX-17（CC-077、CC-078 の前半）: 照らす READ の定義と、発見のジョブの確かめ直しは、それぞれの表の owner（`read-check-store.ts` の
//   `listReadChecksIn`、`discovery-index-store.ts` の `noDiscoveryJobRecordedAfterIn`）の、トランザクションの中で使える読み出しで読む（表を直接
//   SELECT しない）。発見の根拠の写しは `schema-checked-copy.ts` の手順で確かめる。
// - 読むだけ（SQL の書き込みの文を持たない。書き込みは `scenario-store.ts` だけ）。`connection` を受ける関数は、呼び出し側の `withWriteTransaction`・
//   `withReadTransaction` の中から呼ぶ。
import { isSha256Fingerprint } from '../../core/ids.js';
import { deepFreeze } from '../../core/immutable.js';
import { compareCodeUnits } from '../../core/text.js';
import type { DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { noDiscoveryJobRecordedAfterIn, readDiscoveryIndex, type DiscoveryCandidateIndexView } from '../job/discovery-index-store.js';
import { listReadChecksIn } from '../job/read-check-store.js';
import { requireSchemaCheckedCopy } from '../schema-checked-copy.js';
import type { ControlDatabase } from '../store/control-database.js';
import { getProfile } from '../store/profile-store.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { ControlStoreError, storedRowIntegrityError } from '../store/store-errors.js';
import { withReadTransaction } from '../store/transaction.js';
import { TARGET_CONFIG_SHA256_PATTERN } from '../worker-protocol.js';
import { latestRuleSetReferenceIn } from '../data-rules/rule-set-facts.js';
import { computeApprovalDigest, type ApprovalDigestFacts } from './approval-digest.js';
import {
  evaluateApprovalValidity,
  type ApprovalCandidateFact,
  type ApprovalTemplatedCandidateFact,
  type ApprovalCurrentFacts,
  type ApprovalValidity,
} from './approval-validity.js';
import {
  SCENARIO_STATES,
  type ApprovalReceipt,
  type ApprovalReceiptRecord,
  type RevocationReceipt,
  type ScenarioKindFact,
  type ScenarioReadCheckDefinitionFact,
  type ScenarioRevision,
  type ScenarioState,
} from './scenario-contracts.js';
import { assertStorableApprovalReceipt, storedScenarioRevisionOf } from './scenario-policy.js';

// ---------------------------------------------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------------------------------------------

/** シナリオ 1 件（今の行と今の版の写し。凍結。日時は UTC の 14 桁）。 */
export interface ScenarioView {
  readonly scenarioId: string;
  readonly profileId: string;
  readonly revision: number;
  readonly state: ScenarioState;
  readonly lastApprovalReceiptId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 今の版の文書。 */
  readonly current: ScenarioRevision;
  /** 今の版の発見の根拠の写し（候補の契約の形。値を持たない）。 */
  readonly evidence: DiscoveryCandidate;
  /** 今の版の根拠を写した発見のジョブ。 */
  readonly discoveryJobId: string;
}

/** 版の写し 1 件（凍結）。 */
export interface ScenarioRevisionView {
  readonly revision: number;
  readonly scenario: ScenarioRevision;
  readonly evidence: DiscoveryCandidate;
  readonly discoveryJobId: string;
  readonly recordedAt: string;
}

/** 管理データの外の事実（呼び出し側が求める。認証の設定は `authSetupDigestOf`、ターゲットの設定は `targetConfigDigestOf`）。 */
export interface ApprovalExternalFacts {
  readonly authSetupDigest: string | null;
  readonly targetConfigDigest: string;
}

/** `scenarios` の行。 */
export interface ScenarioRow {
  readonly scenario_id: string;
  readonly profile_id: string;
  readonly revision: number;
  readonly state: string;
  readonly last_approval_receipt_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** `scenario_revisions` の行。 */
export interface RevisionRow {
  readonly revision: number;
  readonly document: string;
  readonly evidence: string;
  readonly discovery_job_id: string;
  readonly recorded_at: string;
}

/** `approval_receipts` の行（文書だけ）。 */
export interface ReceiptRow {
  readonly document: string;
}

/** 書くトランザクションの前に読んだ、最後の発見の索引。 */
export interface DiscoverySnapshot {
  readonly latestJobId: string | null;
  readonly candidates: readonly DiscoveryCandidateIndexView[];
}

/** 承認の状態（今の版、今の事実、承認の digest、再承認の判定、最後の承認と撤回の記録）。凍結。 */
export interface ScenarioApprovalState {
  readonly scenario: ScenarioView;
  readonly facts: ApprovalCurrentFacts;
  readonly approvalDigest: string;
  readonly validity: ApprovalValidity;
  readonly lastApproval: ApprovalReceipt | null;
  readonly lastRevocation: RevocationReceipt | null;
}

// ---------------------------------------------------------------------------------------------------------------
// SQL（読むだけ）
// ---------------------------------------------------------------------------------------------------------------

/** `scenarios` の列（読み書きの共通）。 */
export const SCENARIO_COLUMNS = 'scenario_id, profile_id, revision, state, last_approval_receipt_id, created_at, updated_at';
/** `scenario_revisions` の列（シナリオの id とプロファイルを除く。読み書きの共通）。 */
export const REVISION_COLUMNS = 'revision, document, evidence, discovery_job_id, recorded_at';
const SELECT_SCENARIO_SQL = `SELECT ${SCENARIO_COLUMNS} FROM scenarios WHERE scenario_id = ?`;
const SELECT_REVISION_SQL = `SELECT ${REVISION_COLUMNS} FROM scenario_revisions WHERE scenario_id = ? AND revision = ?`;
const SELECT_RECEIPT_SQL = 'SELECT document FROM approval_receipts WHERE receipt_id = ?';
const SELECT_REVOCATION_OF_SQL = 'SELECT document FROM approval_receipts WHERE target_receipt_id = ?';
/** プロファイルのシナリオと今の版の写し（T31b。台帳の参照の確かめに、今の版の kind を読む）。 */
const SELECT_PROFILE_SCENARIO_REVISIONS_SQL = `SELECT scenarios.scenario_id AS scenario_id, ${REVISION_COLUMNS.split(', ').map((column) => `scenario_revisions.${column} AS ${column}`).join(', ')}
  FROM scenarios JOIN scenario_revisions ON scenario_revisions.scenario_id = scenarios.scenario_id AND scenario_revisions.revision = scenarios.revision
  WHERE scenarios.profile_id = ? ORDER BY scenarios.scenario_id`;
/** シナリオのプロファイルの、すべてのシナリオのすべての版の写し（T31e。同じ台帳のシナリオを、過去の版の参照まで含めて求める）。 */
const SELECT_FAMILY_REVISIONS_SQL = `SELECT scenario_id, ${REVISION_COLUMNS} FROM scenario_revisions
  WHERE profile_id = (SELECT profile_id FROM scenarios WHERE scenario_id = ?) ORDER BY scenario_id, revision`;

/** 候補の契約のスキーマの名前。 */
const CANDIDATE_SCHEMA_NAME = 'candidate';

/** 保存した行の誤り（データベースの誤り。owner は `store-errors.ts` の `storedRowIntegrityError`。T29d fix round 1）。 */
export const integrityError = storedRowIntegrityError;

// ---------------------------------------------------------------------------------------------------------------
// 入力の確かめ（呼び出し側の誤りは `RangeError`）
// ---------------------------------------------------------------------------------------------------------------

/** 外の事実の 2 つの digest だけを写す（余分な項目は写さない）。形が違えば `RangeError`。 */
export const requireExternal = (external: ApprovalExternalFacts): ApprovalExternalFacts => {
  const { authSetupDigest, targetConfigDigest } = external;
  if (authSetupDigest !== null && !isSha256Fingerprint(authSetupDigest)) {
    throw new RangeError('the auth setup digest must be null or a digest of authSetupDigestOf');
  }
  if (typeof targetConfigDigest !== 'string' || !TARGET_CONFIG_SHA256_PATTERN.test(targetConfigDigest)) {
    throw new RangeError('the target config digest must have the form of targetConfigDigestOf');
  }
  return Object.freeze({ authSetupDigest, targetConfigDigest });
};

/** 発見の根拠の写し（候補の契約の形を確かめた凍結した写し。形が違えば `RangeError`）。 */
export const requireEvidence = (candidate: DiscoveryCandidate): DiscoveryCandidate =>
  // CCX-17（CC-077）: JSON の写し → スキーマ → 凍結の手順は `schema-checked-copy.ts`。
  requireSchemaCheckedCopy<DiscoveryCandidate>(CANDIDATE_SCHEMA_NAME, 'discovery candidate', candidate);

// ---------------------------------------------------------------------------------------------------------------
// 行から形へ
// ---------------------------------------------------------------------------------------------------------------

const parsedJson = (table: string, text: string, detail: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw integrityError(table, `${detail} is not JSON`, error);
  }
};

/** 保存した値を契約の形で読む（合わなければ、データベースの誤り）。 */
const storedOf = <T>(table: string, read: () => T): T => {
  try {
    return read();
  } catch (error) {
    if (error instanceof ControlStoreError) {
      throw error;
    }
    throw integrityError(table, 'the stored document does not match the contract', error);
  }
};

/** 版の写しの行を形にする。 */
export const revisionViewOf = (row: RevisionRow): ScenarioRevisionView => {
  // T30a: 検証の指定の前に保存した版は、すべて未指定として読む（`storedScenarioRevisionOf`）。
  const scenario = storedOf('scenario_revisions', () => storedScenarioRevisionOf(parsedJson('scenario_revisions', row.document, 'document')));
  const evidence = storedOf('scenario_revisions', () => requireEvidence(parsedJson('scenario_revisions', row.evidence, 'evidence') as DiscoveryCandidate));
  if (scenario.revision !== row.revision) {
    throw integrityError('scenario_revisions', 'the revision of the document does not match its row');
  }
  return deepFreeze({ revision: row.revision, scenario, evidence, discoveryJobId: row.discovery_job_id, recordedAt: row.recorded_at });
};

/** 承認か撤回の記録の行を形にする。 */
export const receiptOf = (row: ReceiptRow): ApprovalReceiptRecord =>
  storedOf('approval_receipts', () => assertStorableApprovalReceipt(parsedJson('approval_receipts', row.document, 'document') as ApprovalReceiptRecord));

const isScenarioState = (value: string): value is ScenarioState => (SCENARIO_STATES as readonly string[]).includes(value);

/** シナリオの版の写しの行（なければ、データベースの誤り）。 */
export const revisionRowOf = (connection: SqliteConnection, scenarioId: string, revision: number): RevisionRow => {
  const row = connection.prepare(SELECT_REVISION_SQL).get(scenarioId, revision) as RevisionRow | undefined;
  if (row === undefined) {
    throw integrityError('scenario_revisions', 'the revision of the scenario row was not found');
  }
  return row;
};

/** シナリオの行と今の版の写しを形にする。 */
export const scenarioViewOf = (connection: SqliteConnection, row: ScenarioRow): ScenarioView => {
  if (!isScenarioState(row.state)) {
    throw integrityError('scenarios', 'state is not in the closed list');
  }
  const revision = revisionViewOf(revisionRowOf(connection, row.scenario_id, row.revision));
  if (revision.scenario.scenarioId !== row.scenario_id || revision.scenario.profileId !== row.profile_id) {
    throw integrityError('scenario_revisions', 'the document does not match its scenario row');
  }
  return deepFreeze({
    scenarioId: row.scenario_id,
    profileId: row.profile_id,
    revision: row.revision,
    state: row.state,
    lastApprovalReceiptId: row.last_approval_receipt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    current: revision.scenario,
    evidence: revision.evidence,
    discoveryJobId: revision.discoveryJobId,
  });
};

/** シナリオの行（なければ `undefined`）。 */
export const scenarioRowOf = (connection: SqliteConnection, scenarioId: string): ScenarioRow | undefined =>
  connection.prepare(SELECT_SCENARIO_SQL).get(scenarioId) as ScenarioRow | undefined;

/** 書くトランザクションの前に、シナリオのプロファイルを読む（なければ null）。 */
export const profileIdOfScenario = (database: ControlDatabase, scenarioId: string): string | null =>
  withReadTransaction(database, (connection) => scenarioRowOf(connection, scenarioId)?.profile_id ?? null);

// ---------------------------------------------------------------------------------------------------------------
// 今の事実
// ---------------------------------------------------------------------------------------------------------------

/** 最後の発見の索引を読む（書くトランザクションの前に。`readDiscoveryIndex` は自分の読むトランザクションを開く）。 */
export const discoverySnapshotOf = (database: ControlDatabase, profileId: string): DiscoverySnapshot => {
  const index = readDiscoveryIndex(database, profileId);
  return Object.freeze({ latestJobId: index.latestJobId, candidates: index.candidates });
};

/** 索引を読んだ後に、プロファイルの発見のジョブが記録されていないか（トランザクションの中で確かめ直す）。 */
export const discoveryUnchangedIn = (connection: SqliteConnection, profileId: string, snapshot: DiscoverySnapshot): boolean =>
  // CCX-17（CC-078）: 表の読み方は索引の owner（`discovery-index-store.ts`）の、トランザクションの中で使える読み出し。
  noDiscoveryJobRecordedAfterIn(connection, profileId, snapshot.latestJobId);

/**
 * 照らす READ の定義の今の事実（プロファイルの定義のすべて（取り消したものを含む）。id の順。T30a: 今の版の送る値の名前（定義の順）を含む。値は
 * 読み出しの形に入れない）。CCX-17（CC-078）: 表の読み方は READ の定義の owner（`read-check-store.ts`）の、トランザクションの中で使える読み出し。
 */
export const readCheckFactsIn = (connection: SqliteConnection, profileId: string): readonly ScenarioReadCheckDefinitionFact[] =>
  Object.freeze(listReadChecksIn(connection, profileId, { includeCanceled: true })
    .map(({ readCheckId, profileId: owner, revision, canceledAt, definition }) => Object.freeze({
      readCheckId,
      profileId: owner,
      revision,
      canceledAt,
      parameterNames: Object.freeze(Object.keys(definition.parameters)),
    }))
    .sort((left, right) => compareCodeUnits(left.readCheckId, right.readCheckId)));

/**
 * プロファイルのシナリオの事実（T31b。id・プロファイル・今の版の kind。id の順。下書きの確かめが台帳の参照を確かめる）。T31R-fix-1 の I-2: 今の版の
 * 登録の ID の取り方も入れる（台帳の取り方に、UPDATE の path の型を結ぶ確かめと、発行の確かめ直しが使う）。
 */
export const scenarioKindFactsIn = (connection: SqliteConnection, profileId: string): readonly ScenarioKindFact[] =>
  Object.freeze((connection.prepare(SELECT_PROFILE_SCENARIO_REVISIONS_SQL).all(profileId) as unknown as (RevisionRow & { readonly scenario_id: string })[])
    .map((row) => {
      const { scenario } = revisionViewOf(row);
      return Object.freeze({ scenarioId: row.scenario_id, profileId, kind: scenario.kind, recordId: scenario.verification.recordId });
    }));

/**
 * 同じ台帳のシナリオの id（T31e。生成の履歴に使う。id の順）。台帳は、CREATE のシナリオと、どれかの版でそれを参照する UPDATE のシナリオの集まり。
 * 起点は、そのシナリオが CREATE なら自分、UPDATE ならどれかの版で参照した CREATE のシナリオ。そのシナリオ自身も必ず含む。シナリオがなければ空。
 */
export const writeFamilyScenarioIdsIn = (connection: SqliteConnection, scenarioId: string): readonly string[] => {
  const revisions = (connection.prepare(SELECT_FAMILY_REVISIONS_SQL).all(scenarioId) as unknown as (RevisionRow & { readonly scenario_id: string })[])
    .map((row) => Object.freeze({ scenarioId: row.scenario_id, scenario: revisionViewOf(row).scenario }));
  if (revisions.length === 0) {
    return Object.freeze([]);
  }
  const own = revisions.filter((revision) => revision.scenarioId === scenarioId);
  const roots = new Set([
    ...(own.at(-1)?.scenario.kind === 'CREATE' ? [scenarioId] : []),
    ...own.flatMap(({ scenario }) => (scenario.update === null ? [] : [scenario.update.targetCreateScenarioId])),
  ]);
  const family = new Set([scenarioId, ...roots, ...revisions
    .filter(({ scenario }) => scenario.update !== null && roots.has(scenario.update.targetCreateScenarioId))
    .map((revision) => revision.scenarioId)]);
  return Object.freeze([...family].sort(compareCodeUnits));
};

/** 索引の、識別の digest の候補の事実（なければ null）。 */
export const candidateFactOf = (snapshot: DiscoverySnapshot, identityDigest: string): ApprovalCandidateFact | null => {
  const entry = snapshot.candidates.find((candidate) => candidate.identityDigest === identityDigest);
  return entry === undefined
    ? null
    : Object.freeze({ identityDigest: entry.identityDigest, ruleDigest: entry.ruleDigest, classification: entry.classification, drift: entry.drift });
};

/**
 * 索引の候補ごとの、型にした識別の digest の一覧の事実（T31e。管理データの版 9）。候補があり、どの候補も一覧を持たない（版 9 の前に書いた索引で、
 * その後に発見していない）なら null（`CANDIDATE_TEMPLATES_UNAVAILABLE`。もう一度の発見が要る）。一覧のない候補（版 9 の後の発見で読み直していない候補）は、
 * 空の一覧（どの型にも当たらない。止める側）。
 */
export const templatedCandidateFactsOf = (snapshot: DiscoverySnapshot): readonly ApprovalTemplatedCandidateFact[] | null =>
  (snapshot.candidates.length > 0 && snapshot.candidates.every(({ templatedIdentityDigests }) => templatedIdentityDigests === null)
    ? null
    : Object.freeze(snapshot.candidates.map((entry) => Object.freeze({
      templatedIdentityDigests: entry.templatedIdentityDigests ?? Object.freeze([]),
      ruleDigest: entry.ruleDigest,
      classification: entry.classification,
      drift: entry.drift,
    }))));

/** 承認の判定に渡す今の事実（同じトランザクションの中で読む）。 */
export const currentFactsIn = (
  connection: SqliteConnection,
  database: ControlDatabase,
  scenario: ScenarioRevision,
  snapshot: DiscoverySnapshot,
  external: ApprovalExternalFacts,
): ApprovalCurrentFacts => {
  const stored = getProfile(database, scenario.profileId);
  if (stored === null) {
    throw integrityError('scenarios', 'the profile of the scenario does not exist');
  }
  return Object.freeze({
    profile: Object.freeze({ profileId: stored.profile.profileId, revision: stored.profile.revision, status: stored.status, mode: stored.profile.mode }),
    authSetupDigest: external.authSetupDigest,
    targetConfigDigest: external.targetConfigDigest,
    candidate: candidateFactOf(snapshot, scenario.candidate.identityDigest),
    // T31e: 索引の候補ごとの型にした識別の digest の一覧（管理データの版 9。版 9 の前の索引だけなら null で止める側）。
    templatedCandidates: templatedCandidateFactsOf(snapshot),
    // T29d: 入力の規則の今の参照は、規則の集まりの最新の版（シナリオ自身の参照ではない）。
    inputRuleReference: latestRuleSetReferenceIn(connection, scenario.scenarioId),
    readChecks: readCheckFactsIn(connection, scenario.profileId),
  });
};

/** 承認の digest が縛る、シナリオの外の事実。 */
export const digestFactsOf = (facts: ApprovalCurrentFacts): ApprovalDigestFacts => Object.freeze({
  profileRevision: facts.profile.revision,
  authSetupDigest: facts.authSetupDigest,
  targetConfigDigest: facts.targetConfigDigest,
});

/** 最後の承認の記録と、それに対する撤回の記録。 */
export const lastReceiptsIn = (
  connection: SqliteConnection,
  row: ScenarioRow,
): { readonly approval: ApprovalReceipt | null; readonly revocation: RevocationReceipt | null } => {
  if (row.last_approval_receipt_id === null) {
    return { approval: null, revocation: null };
  }
  const approvalRow = connection.prepare(SELECT_RECEIPT_SQL).get(row.last_approval_receipt_id) as ReceiptRow | undefined;
  const approval = approvalRow === undefined ? null : receiptOf(approvalRow);
  if (approval === null || approval.kind !== 'APPROVAL') {
    throw integrityError('approval_receipts', 'the last approval of the scenario is not an approval receipt');
  }
  const revocationRow = connection.prepare(SELECT_REVOCATION_OF_SQL).get(approval.receiptId) as ReceiptRow | undefined;
  const revocation = revocationRow === undefined ? null : receiptOf(revocationRow);
  if (revocation !== null && revocation.kind !== 'REVOCATION') {
    throw integrityError('approval_receipts', 'the revocation of the approval is not a revocation receipt');
  }
  return { approval, revocation };
};

/**
 * 承認の状態（同じトランザクションの中で読む）。今の版と今の事実から承認の digest を求め、最後の承認と撤回の記録で再承認の判定をする
 * （`evaluateApprovalValidity`。時刻は注入）。
 */
export const approvalStateIn = (
  connection: SqliteConnection,
  database: ControlDatabase,
  row: ScenarioRow,
  snapshot: DiscoverySnapshot,
  external: ApprovalExternalFacts,
  now: Date,
): ScenarioApprovalState => {
  const scenario = scenarioViewOf(connection, row);
  const facts = currentFactsIn(connection, database, scenario.current, snapshot, external);
  const { approval, revocation } = lastReceiptsIn(connection, row);
  return deepFreeze({
    scenario,
    facts,
    approvalDigest: computeApprovalDigest(scenario.current, digestFactsOf(facts)),
    validity: evaluateApprovalValidity({ scenario: scenario.current, facts, lastApproval: approval, lastRevocation: revocation, now }),
    lastApproval: approval,
    lastRevocation: revocation,
  });
};

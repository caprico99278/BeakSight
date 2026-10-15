// 管理データの版 7 の表（`rule_sets`・`rule_set_revisions`）の書き込みの唯一の owner（Task 29 の設計書 3 章、4.3、10 章の 4。T29d）。
// - 版 7 の表に書く SQL は、このファイルだけに置く（Architecture Gate `control-store-boundary.test.ts` の (l)）。版の写しは追記だけ（同じ Gate の (k)）。
//   書き込みは、すべて `withWriteTransaction`（`BEGIN IMMEDIATE`）の中で、確かめ直してから書く。読むだけの関数は `withReadTransaction` を通す。
//   行の読み出しは `rule-set-facts.ts`（書き写さない）。時計は注入する（14 桁の UTC の `at`）。
// - 保存（`saveRuleSet`）: 作成（`expectedRevision` が null。版 1）と、新しい版の追記（呼び出し側が読んだ最新の版と同じときだけ、版を 1 つ上げる）。
//   シナリオがない → `RULE_SET_SCENARIO_NOT_FOUND`、取り消したプロファイル → `RULE_SET_PROFILE_RETIRED`、シナリオを許さないモード・方式
//   （`execution-policy.ts` の `SCENARIO` の行）→ `RULE_SET_MODE_NOT_WRITE`、版が違う → `RULE_SET_REVISION_CONFLICT`。文書は `assertStorableRuleSet`
//   で確かめ、シナリオの今の版と発見の根拠の写しに照らして `evaluateRuleSet` をかけ、判定の結果を返す（不足があっても保存は受ける。不足は実行の
//   許可の発行で拒む。設計書 4.3）。人が入れた固定の値は、管理データに平文で残る（設計書 10 章の 4）。
// - 2 段の手順（`saveRuleSetAndAttach`）: 規則を保存した後に、別のトランザクションで Task 28 の `attachInputRuleReference` を呼び、シナリオに参照を
//   付け直す（Gate (g): トランザクションの中の書き込みは、ファイルをまたげない）。2 段目で版の衝突が起きたら、規則の版は残り、参照は付かない（画面が
//   読み直してやり直す）。規則の新しい版を保存しただけでも、承認の判定の今の事実が変わるので、参照を付け直す前から再承認が要る（`INPUT_RULES_CHANGED`）。
// - 呼び出し側の誤り（形の違う ID・時刻・版、別の規則の集まりの id、契約の形に合わない中身、前の時刻）は、書く前に `RangeError`。
import { deepFreeze } from '../../core/immutable.js';
import { dateOfCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import { attachInputRuleReference, type ScenarioStoreResult } from '../approval/scenario-store.js';
import { scenarioRowOf, scenarioViewOf } from '../approval/scenario-facts.js';
import type { InputRuleReference } from '../approval/scenario-contracts.js';
import { isProfileOperationAllowed } from '../execution-policy.js';
import type { ControlDatabase } from '../store/control-database.js';
import { getProfile } from '../store/profile-store.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { withReadTransaction, withWriteTransaction } from '../store/transaction.js';
import { evaluateRuleSet, type RuleSetEvaluation } from './field-evaluation.js';
import {
  MIN_RULE_SET_REVISION,
  RULE_SET_ID_PATTERN,
  RULE_SET_SCHEMA_VERSION,
  type RuleSetContent,
  type RuleSetRevision,
} from './rule-contracts.js';
import { computeRuleSetDigest } from './rule-digest.js';
import {
  RULE_SET_COLUMNS,
  RULE_SET_REVISION_COLUMNS,
  latestRuleSetIn,
  ruleSetRevisionsIn,
  ruleSetRowOfScenario,
  type StoredRuleSet,
} from './rule-set-facts.js';
import { assertStorableRuleSet, ruleSetHasSecretFieldFixedValues } from './rule-set-policy.js';

/**
 * 規則の保存を拒む理由（閉じた一覧）。
 * - `RULE_SET_SCENARIO_NOT_FOUND`: シナリオがない。
 * - `RULE_SET_PROFILE_RETIRED`: シナリオのプロファイルを取り消した。
 * - `RULE_SET_MODE_NOT_WRITE`: シナリオのプロファイルのモードと方式が、シナリオを許さない（`execution-policy.ts` の `SCENARIO` の行）。
 * - `RULE_SET_REVISION_CONFLICT`: 呼び出し側が読んだ最新の版と、今の最新の版が違う（作成なのに規則の集まりがある、を含む）。
 * - `RULE_SET_SECRET_FIELD_FIXED_VALUE`: 秘密に見える名前の欄に、人の固定の値がある（`rule-set-policy.ts` の
 *   `ruleSetHasSecretFieldFixedValues`。T29R-fix-1 の M-4。画面のサーバから移した）。
 */
export const RULE_SET_STORE_REJECTION_REASONS = Object.freeze([
  'RULE_SET_SCENARIO_NOT_FOUND',
  'RULE_SET_PROFILE_RETIRED',
  'RULE_SET_MODE_NOT_WRITE',
  'RULE_SET_REVISION_CONFLICT',
  'RULE_SET_SECRET_FIELD_FIXED_VALUE',
] as const);
export type RuleSetStoreRejectionReason = (typeof RULE_SET_STORE_REJECTION_REASONS)[number];

/** 保存の入力。 */
export interface RuleSetSave {
  /** 規則の集まりの id（`RULE_SET_ID_PATTERN`。シナリオごとに 1 つ。追記では最新の版と同じ id）。 */
  readonly ruleSetId: string;
  readonly scenarioId: string;
  /** 呼び出し側が読んだ最新の版（作成は null）。 */
  readonly expectedRevision: number | null;
  readonly content: RuleSetContent;
  readonly at: string;
}

/** 2 段の手順の入力（保存の入力と、シナリオの、呼び出し側が読んだ版）。 */
export interface RuleSetSaveAndAttach extends RuleSetSave {
  readonly expectedScenarioRevision: number;
}

/** 保存の結果。受けたときは、保存した版、シナリオに付ける参照、シナリオの今の版に照らした判定（不足があっても保存は受ける）。 */
export type RuleSetStoreResult =
  | { readonly ok: true; readonly ruleSet: RuleSetRevision; readonly reference: InputRuleReference; readonly evaluation: RuleSetEvaluation }
  | { readonly ok: false; readonly reason: RuleSetStoreRejectionReason };

/** 2 段の手順の結果（1 段目の結果と、2 段目の結果。1 段目で拒めば、2 段目は null）。 */
export interface RuleSetSaveAndAttachResult {
  readonly ruleSet: RuleSetStoreResult;
  readonly attachment: ScenarioStoreResult | null;
}

const RETIRED_PROFILE_STATUS = 'RETIRED';
const ONE_ROW = 1;

const INSERT_RULE_SET_SQL = `INSERT INTO rule_sets (${RULE_SET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`;
const UPDATE_RULE_SET_REVISION_SQL = 'UPDATE rule_sets SET revision = ?, updated_at = ? WHERE rule_set_id = ? AND revision = ?';
const INSERT_RULE_SET_REVISION_SQL = `INSERT INTO rule_set_revisions (${RULE_SET_REVISION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`;

const rejected = (reason: RuleSetStoreRejectionReason): RuleSetStoreResult => Object.freeze({ ok: false, reason });

const requireId = (value: string, subject: string): string => {
  if (typeof value !== 'string' || !RULE_SET_ID_PATTERN.test(value)) {
    throw new RangeError(`the ${subject} must match the rule set id pattern`);
  }
  return value;
};

const requireExpectedRevision = (value: number | null): number | null => {
  if (value !== null && (!Number.isSafeInteger(value) || value < MIN_RULE_SET_REVISION)) {
    throw new RangeError(`the expected rule set revision must be null or a safe integer of at least ${MIN_RULE_SET_REVISION}`);
  }
  return value;
};

/** 入力を確かめた凍結した写し（形が違えば `RangeError`。中身の形は書く前に `assertStorableRuleSet` で確かめる）。 */
const checkedSaveOf = (input: RuleSetSave): RuleSetSave => {
  dateOfCompactUtcTimestamp(input.at);
  return deepFreeze({
    ruleSetId: requireId(input.ruleSetId, 'rule set id'),
    scenarioId: requireId(input.scenarioId, 'scenario id'),
    expectedRevision: requireExpectedRevision(input.expectedRevision),
    content: JSON.parse(JSON.stringify(input.content)) as RuleSetContent,
    at: input.at,
  });
};

const saveIn = (database: ControlDatabase, connection: SqliteConnection, input: RuleSetSave): RuleSetStoreResult => {
  const scenarioRow = scenarioRowOf(connection, input.scenarioId);
  if (scenarioRow === undefined) {
    return rejected('RULE_SET_SCENARIO_NOT_FOUND');
  }
  const stored = getProfile(database, scenarioRow.profile_id);
  if (stored === null || stored.status === RETIRED_PROFILE_STATUS) {
    return rejected('RULE_SET_PROFILE_RETIRED');
  }
  if (!isProfileOperationAllowed('SCENARIO', stored.profile.mode, stored.profile.auth)) {
    return rejected('RULE_SET_MODE_NOT_WRITE');
  }
  if (ruleSetHasSecretFieldFixedValues(input.content)) {
    return rejected('RULE_SET_SECRET_FIELD_FIXED_VALUE');
  }
  const existing = ruleSetRowOfScenario(connection, input.scenarioId);
  if (input.expectedRevision === null ? existing !== undefined : existing === undefined || existing.revision !== input.expectedRevision) {
    return rejected('RULE_SET_REVISION_CONFLICT');
  }
  if (existing !== undefined && existing.rule_set_id !== input.ruleSetId) {
    throw new RangeError('the rule set id must be the id of the rule set of the scenario');
  }
  if (existing !== undefined && input.at < existing.updated_at) {
    throw new RangeError('the time must not be before the last change of the rule set');
  }
  const revision = existing === undefined ? MIN_RULE_SET_REVISION : existing.revision + 1;
  const ruleSet = assertStorableRuleSet({
    schemaVersion: RULE_SET_SCHEMA_VERSION,
    ruleSetId: input.ruleSetId,
    scenarioId: input.scenarioId,
    revision,
    ...input.content,
    createdAt: input.at,
  });
  const scenario = scenarioViewOf(connection, scenarioRow);
  const evaluation = evaluateRuleSet(ruleSet, scenario.current, scenario.evidence);
  const digest = computeRuleSetDigest(ruleSet);
  if (existing === undefined) {
    connection.prepare(INSERT_RULE_SET_SQL).run(input.ruleSetId, input.scenarioId, scenarioRow.profile_id, revision, input.at, input.at);
  } else if (Number(connection.prepare(UPDATE_RULE_SET_REVISION_SQL).run(revision, input.at, existing.rule_set_id, existing.revision).changes) !== ONE_ROW) {
    throw new RangeError('the rule set changed while it was saved');
  }
  connection.prepare(INSERT_RULE_SET_REVISION_SQL).run(
    input.ruleSetId, revision, input.scenarioId, scenarioRow.profile_id, JSON.stringify(ruleSet), digest, input.at,
  );
  return deepFreeze({ ok: true, ruleSet, reference: { ruleSetId: ruleSet.ruleSetId, revision, digest }, evaluation });
};

/**
 * 規則の集まりの版を保存する（作成か、新しい版の追記）。拒むときは理由を返して何も書かない。シナリオに参照は付けない（付けるのは
 * `saveRuleSetAndAttach` の 2 段目）。
 */
export const saveRuleSet = (database: ControlDatabase, input: RuleSetSave): RuleSetStoreResult => {
  const checked = checkedSaveOf(input);
  return withWriteTransaction(database, (writer) => saveIn(database, writer, checked));
};

/**
 * 規則を保存し、別のトランザクションでシナリオに参照を付け直す（2 段の手順）。1 段目で拒めば、2 段目は行わない。2 段目で拒まれても（版の衝突など）、
 * 1 段目の規則の版は残る。
 */
export const saveRuleSetAndAttach = (database: ControlDatabase, input: RuleSetSaveAndAttach): RuleSetSaveAndAttachResult => {
  const ruleSet = saveRuleSet(database, input);
  if (!ruleSet.ok) {
    return Object.freeze({ ruleSet, attachment: null });
  }
  const attachment = attachInputRuleReference(database, {
    scenarioId: input.scenarioId,
    expectedRevision: input.expectedScenarioRevision,
    reference: ruleSet.reference,
    at: input.at,
  });
  return Object.freeze({ ruleSet, attachment });
};

/** シナリオの規則の集まりの最新の版と参照（なければ null）。 */
export const readLatestRuleSet = (database: ControlDatabase, scenarioId: string): StoredRuleSet | null =>
  withReadTransaction(database, (connection) => latestRuleSetIn(connection, scenarioId));

/** シナリオの規則の集まりの版の履歴（版の順。なければ空）。 */
export const readRuleSetRevisions = (database: ControlDatabase, scenarioId: string): readonly StoredRuleSet[] =>
  withReadTransaction(database, (connection) => ruleSetRevisionsIn(connection, scenarioId));

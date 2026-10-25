// 管理データの版 7 の表（`rule_sets`・`rule_set_revisions`）の読み出しの唯一の owner（Task 29 の設計書 4.3。T29d）。読むだけ。
// - 書き込みは `rule-store.ts` だけ（Architecture Gate `control-store-boundary.test.ts` の (l)）。ここは SQL の書き込みの文を持たない。
// - 承認の判定の今の事実（`src/control/approval/scenario-facts.ts` の `currentFactsIn`）と、実行の許可の発行の確かめ（`scenario-store.ts`）と、
//   規則の保存（`rule-store.ts`）が、同じこの読み出しを使う（`connection` を受ける関数は、呼び出し側の `withWriteTransaction`・`withReadTransaction`
//   の中から呼ぶ）。
// - 版の写しは、契約の形（`ruleSetRevisionOfStoredDocument`。版 2 のスキーマ。LG-3: 版 1 の文書は契約の形の誤り）と、行の列（規則の集まりの
//   id・版・シナリオ・digest）が文書と合うことを確かめて読む。合わなければデータベースの誤り（`DATABASE_INTEGRITY_FAILED`）。
import { deepFreeze } from '../../core/immutable.js';
import type { InputRuleReference } from '../approval/scenario-contracts.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { storedRowIntegrityError } from '../store/store-errors.js';
import type { RuleSetRevision } from './rule-contracts.js';
import { computeRuleSetDigest } from './rule-digest.js';
import { ruleSetRevisionOfStoredDocument } from './rule-set-policy.js';

/** `rule_sets` の列（読み書きの共通）。 */
export const RULE_SET_COLUMNS = 'rule_set_id, scenario_id, profile_id, revision, created_at, updated_at';
/** `rule_set_revisions` の列（読み書きの共通）。 */
export const RULE_SET_REVISION_COLUMNS = 'rule_set_id, revision, scenario_id, profile_id, document, digest, recorded_at';

/** `rule_sets` の行。 */
export interface RuleSetRow {
  readonly rule_set_id: string;
  readonly scenario_id: string;
  readonly profile_id: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** `rule_set_revisions` の行。 */
interface RuleSetRevisionRow {
  readonly rule_set_id: string;
  readonly revision: number;
  readonly scenario_id: string;
  readonly profile_id: string;
  readonly document: string;
  readonly digest: string;
  readonly recorded_at: string;
}

/** 規則の集まりの版 1 つと、シナリオに付ける参照（凍結）。 */
export interface StoredRuleSet {
  readonly ruleSet: RuleSetRevision;
  readonly reference: InputRuleReference;
  readonly profileId: string;
  readonly recordedAt: string;
}

const SELECT_RULE_SET_OF_SCENARIO_SQL = `SELECT ${RULE_SET_COLUMNS} FROM rule_sets WHERE scenario_id = ?`;
const SELECT_REVISION_SQL = `SELECT ${RULE_SET_REVISION_COLUMNS} FROM rule_set_revisions WHERE rule_set_id = ? AND revision = ?`;
const SELECT_REVISIONS_SQL = `SELECT ${RULE_SET_REVISION_COLUMNS} FROM rule_set_revisions WHERE rule_set_id = ? ORDER BY revision`;

/** 保存した行の誤り（データベースの誤り。owner は `store-errors.ts`）。 */
const integrityError = storedRowIntegrityError;

/** 版の写しの行を形にする（文書の形、行の列との一致、digest の一致を確かめる）。 */
const storedRuleSetOf = (row: RuleSetRevisionRow): StoredRuleSet => {
  let ruleSet: RuleSetRevision;
  try {
    ruleSet = ruleSetRevisionOfStoredDocument(JSON.parse(row.document) as unknown);
  } catch (error) {
    throw integrityError('rule_set_revisions', 'the stored document does not match the contract', error);
  }
  if (ruleSet.ruleSetId !== row.rule_set_id || ruleSet.revision !== row.revision || ruleSet.scenarioId !== row.scenario_id) {
    throw integrityError('rule_set_revisions', 'the document does not match its row');
  }
  const digest = computeRuleSetDigest(ruleSet);
  if (digest !== row.digest) {
    throw integrityError('rule_set_revisions', 'the digest does not match the document');
  }
  return deepFreeze({
    ruleSet,
    reference: { ruleSetId: ruleSet.ruleSetId, revision: ruleSet.revision, digest },
    profileId: row.profile_id,
    recordedAt: row.recorded_at,
  });
};

/** シナリオの規則の集まりの行（なければ `undefined`）。 */
export const ruleSetRowOfScenario = (connection: SqliteConnection, scenarioId: string): RuleSetRow | undefined =>
  connection.prepare(SELECT_RULE_SET_OF_SCENARIO_SQL).get(scenarioId) as RuleSetRow | undefined;

/** シナリオの規則の集まりの最新の版（なければ null）。 */
export const latestRuleSetIn = (connection: SqliteConnection, scenarioId: string): StoredRuleSet | null => {
  const row = ruleSetRowOfScenario(connection, scenarioId);
  if (row === undefined) {
    return null;
  }
  const revision = connection.prepare(SELECT_REVISION_SQL).get(row.rule_set_id, row.revision) as RuleSetRevisionRow | undefined;
  if (revision === undefined) {
    throw integrityError('rule_set_revisions', 'the latest revision of the rule set was not found');
  }
  return storedRuleSetOf(revision);
};

/** シナリオの入力の規則の今の参照（規則の集まりの最新の版の id・版・digest。なければ null）。承認の判定の今の事実。 */
export const latestRuleSetReferenceIn = (connection: SqliteConnection, scenarioId: string): InputRuleReference | null =>
  latestRuleSetIn(connection, scenarioId)?.reference ?? null;

/** シナリオの規則の集まりの版の履歴（版の順。なければ空）。 */
export const ruleSetRevisionsIn = (connection: SqliteConnection, scenarioId: string): readonly StoredRuleSet[] => {
  const row = ruleSetRowOfScenario(connection, scenarioId);
  return row === undefined
    ? Object.freeze([])
    : Object.freeze((connection.prepare(SELECT_REVISIONS_SQL).all(row.rule_set_id) as unknown as RuleSetRevisionRow[]).map(storedRuleSetOf));
};

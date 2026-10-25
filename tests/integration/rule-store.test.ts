// T29d（Task 29 の設計書 4.3）: 入力の規則の保存（`src/control/data-rules/rule-store.ts`）と、承認の判定の今の事実、実行の許可の発行の確かめの
// 結合テスト。
// - 規則の保存: 作成と追記、版の衝突、ないシナリオ、取り消したプロファイル、シナリオを許さないモード、呼び出し側の誤り、不足があっても保存は受ける。
// - 2 段の手順: 保存した後に参照を付け直す。2 段目の版の衝突では、規則の版は残り、参照は付かない。
// - 承認の判定の今の事実: 規則の新しい版を保存すると、参照を付け直す前でも `INPUT_RULES_CHANGED`。
// - 許可の発行: 規則の不足は `NEEDS_RULE_INPUT`（欄ごとの問題を添える）、すべて決まれば通る。
// - 開き直しの後も、規則と参照が残る。
// - FM2c: 推した規則（出どころの印 `INFERRED`）を保存すると digest に入り、承認に結ばれる。保存してある版 1 の文書は、版 1 の digest のまま読める。
// 一時のフォルダだけを使い、終わったら消す。例の値は匿名の値だけ。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachInputRuleReference,
  issueExecutionGrant,
  readScenario,
  readScenarioApprovalStatus,
  type ExecutionGrantResult,
} from '../../src/control/approval/scenario-store.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  RULE_SET_SCHEMA_VERSION,
  type RuleSetContent,
} from '../../src/control/data-rules/rule-contracts.js';
import { computeRuleSetDigest } from '../../src/control/data-rules/rule-digest.js';
import { inferRuleSetContent } from '../../src/control/data-rules/rule-set-inference.js';
import { ruleFieldNameRejectsFixedValues } from '../../src/control/data-rules/rule-set-policy.js';
import {
  readLatestRuleSet,
  readRuleSetRevisions,
  saveRuleSet,
  saveRuleSetAndAttach,
  type RuleSetSave,
} from '../../src/control/data-rules/rule-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { retireProfile, updateProfile } from '../../src/control/store/profile-store.js';
import { resolveTestContext, testAuthProfile } from './control-profile-fixtures.js';
import {
  EMPTY_RULE_CONTENT,
  EXTERNAL,
  ISSUED_AT,
  prepareGrantProfile,
  prepareScenario,
  ruleSetIdOf,
} from './execution-grant-fixtures.js';

/** 版 1 の文書の行に書き換える生の接続の、待ちの上限（FM2c）。 */
const RAW_TIMEOUT_MS = 5_000;
const SAVED_AT = '20261012040000';
const LATER_AT = '20261012050000';
const STATUS_AT = new Date(Date.parse('2026-10-12T06:00:00Z'));

/** 人の規則で、送る欄 `name` に値を作れない中身（テンプレートの外で、固定の値がない）。 */
const UNDECIDED_CONTENT: RuleSetContent = {
  fieldRules: [{ fieldName: 'name', semanticKind: 'OUT_OF_TEMPLATE', method: 'FROM_TEMPLATE', range: null, fixedValues: [] }],
  relations: [],
  uniqueKeyFieldNames: [],
};

/** 人の固定の一覧で、送る欄 `name` が決まる中身。 */
const FIXED_CONTENT: RuleSetContent = {
  fieldRules: [{ fieldName: 'name', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['試験一郎'] }],
  relations: [],
  uniqueKeyFieldNames: ['name'],
};

let workDirectory = '';
let database: ControlDatabase;
let latest: ReturnType<typeof prepareGrantProfile>;

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-rule-store-'));
  database = openControlDatabase(databasePath());
  latest = prepareGrantProfile(database);
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const saveOf = (overrides: Partial<RuleSetSave> = {}): RuleSetSave => ({
  ruleSetId: ruleSetIdOf('scenario-1'),
  scenarioId: 'scenario-1',
  expectedRevision: null,
  content: EMPTY_RULE_CONTENT,
  at: SAVED_AT,
  ...overrides,
});

const reasonOf = (result: { readonly ok: boolean; readonly reason?: string }): string | null => (result.ok ? null : result.reason ?? null);

const issue = (scenarioId: string, grantId = 'grant-1'): ExecutionGrantResult => {
  const revision = readScenario(database, scenarioId)?.revision ?? 1;
  return issueExecutionGrant(database, {
    scenarioId, expectedRevision: revision, grantId, jobId: `job-${grantId}`, count: 1, external: EXTERNAL, at: ISSUED_AT,
  });
};

describe('rule store (T29d): saving', () => {
  it('creates the first revision, appends the next one, and reads the latest and the history', () => {
    prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    const first = saveRuleSet(database, saveOf());
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.ruleSet).toMatchObject({ ruleSetId: 'rules-scenario-1', scenarioId: 'scenario-1', revision: 1, createdAt: SAVED_AT });
    expect(first.reference).toEqual({ ruleSetId: 'rules-scenario-1', revision: 1, digest: computeRuleSetDigest(first.ruleSet) });
    expect(first.evaluation.executable).toBe(true);
    const second = saveRuleSet(database, saveOf({ expectedRevision: 1, content: FIXED_CONTENT, at: LATER_AT }));
    expect(second.ok && second.reference.revision).toBe(2);
    expect(readLatestRuleSet(database, 'scenario-1')?.ruleSet).toMatchObject({ revision: 2, fieldRules: FIXED_CONTENT.fieldRules });
    expect(readRuleSetRevisions(database, 'scenario-1').map(({ ruleSet }) => ruleSet.revision)).toEqual([1, 2]);
    expect(readLatestRuleSet(database, 'scenario-missing')).toBeNull();
    expect(readRuleSetRevisions(database, 'scenario-missing')).toEqual([]);
  });

  it('accepts a rule set with a lack of rules (the issue rejects it), and returns the judgement', () => {
    prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    const saved = saveRuleSet(database, saveOf({ content: UNDECIDED_CONTENT }));
    expect(saved.ok && saved.evaluation.executable).toBe(false);
    expect(saved.ok && saved.evaluation.fields.find((field) => field.fieldName === 'name')?.problem)
      .toEqual({ code: 'NEEDS_RULE_INPUT', detail: 'NO_RULE' });
  });

  it('rejects a revision conflict and a missing scenario without writing', () => {
    prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    expect(saveRuleSet(database, saveOf()).ok).toBe(true);
    expect(reasonOf(saveRuleSet(database, saveOf()))).toBe('RULE_SET_REVISION_CONFLICT');
    expect(reasonOf(saveRuleSet(database, saveOf({ expectedRevision: 2 })))).toBe('RULE_SET_REVISION_CONFLICT');
    expect(reasonOf(saveRuleSet(database, saveOf({ scenarioId: 'scenario-missing', ruleSetId: 'rules-missing' })))).toBe('RULE_SET_SCENARIO_NOT_FOUND');
    prepareScenario(database, latest, 'scenario-2', { attach: false, approve: false });
    expect(reasonOf(saveRuleSet(database, saveOf({ scenarioId: 'scenario-2', ruleSetId: 'rules-x', expectedRevision: 1 }))))
      .toBe('RULE_SET_REVISION_CONFLICT');
    expect(readRuleSetRevisions(database, 'scenario-1')).toHaveLength(1);
  });

  it('rejects a retired profile and a mode that does not allow scenarios', () => {
    prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    expect(updateProfile(database, { profile: testAuthProfile('example-grant', MIN_PROFILE_REVISION + 1), expectedRevision: MIN_PROFILE_REVISION },
      { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(reasonOf(saveRuleSet(database, saveOf()))).toBe('RULE_SET_MODE_NOT_WRITE');
    expect(retireProfile(database, { profileId: 'example-grant', expectedRevision: MIN_PROFILE_REVISION + 1 }).ok).toBe(true);
    expect(reasonOf(saveRuleSet(database, saveOf()))).toBe('RULE_SET_PROFILE_RETIRED');
    expect(readLatestRuleSet(database, 'scenario-1')).toBeNull();
  });

  it('rejects fixed values of a secret-looking field name without writing (T29R-fix-1: M-4, the owner of the rule)', () => {
    prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    for (const fieldName of ['api_key', 'csrf_token', 'session']) {
      const content: RuleSetContent = {
        fieldRules: [{ fieldName, semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['x1'] }],
        relations: [],
        uniqueKeyFieldNames: [],
      };
      expect(reasonOf(saveRuleSet(database, saveOf({ content }))), fieldName).toBe('RULE_SET_SECRET_FIELD_FIXED_VALUE');
      expect(ruleFieldNameRejectsFixedValues(fieldName), fieldName).toBe(true);
    }
    expect(ruleFieldNameRejectsFixedValues('name')).toBe(false);
    // 固定の値のない規則は受ける（秘密に見える名前の欄でも、値を残さない）。
    expect(saveRuleSet(database, saveOf({
      content: { fieldRules: [{ fieldName: 'api_key', semanticKind: 'OUT_OF_TEMPLATE', method: 'FROM_TEMPLATE', range: null, fixedValues: [] }],
        relations: [], uniqueKeyFieldNames: [] },
    })).ok).toBe(true);
    expect(readRuleSetRevisions(database, 'scenario-1')).toHaveLength(1);
  });

  it('throws RangeError on caller errors before writing', () => {
    prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    expect(saveRuleSet(database, saveOf()).ok).toBe(true);
    for (const input of [
      saveOf({ ruleSetId: 'Rules_1' }),
      saveOf({ scenarioId: 'Scenario 1' }),
      saveOf({ at: '2026-10-12' }),
      saveOf({ expectedRevision: 0 }),
      saveOf({ expectedRevision: 1, ruleSetId: 'rules-other' }),
      saveOf({ expectedRevision: 1, at: '20261012000000' }),
      saveOf({ expectedRevision: 1, at: LATER_AT, content: { ...EMPTY_RULE_CONTENT, uniqueKeyFieldNames: ['missing'] } }),
    ]) {
      expect(() => saveRuleSet(database, input), JSON.stringify(input)).toThrow(RangeError);
    }
    expect(readRuleSetRevisions(database, 'scenario-1')).toHaveLength(1);
  });
});

describe('rule store (T29d): the two steps, the current facts and the issue', () => {
  it('saves the rules and attaches the reference in a second transaction', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    const result = saveRuleSetAndAttach(database, { ...saveOf(), expectedScenarioRevision: scenario.revision });
    expect(result.ruleSet.ok && result.attachment?.ok).toBe(true);
    const attached = readScenario(database, 'scenario-1');
    expect(attached).toMatchObject({ revision: scenario.revision + 1, state: 'DRAFT' });
    expect(attached?.current.inputRuleReference).toEqual(readLatestRuleSet(database, 'scenario-1')?.reference);
  });

  it('keeps the rules and attaches nothing when the second step conflicts', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    const result = saveRuleSetAndAttach(database, { ...saveOf(), expectedScenarioRevision: scenario.revision + 1 });
    expect(result.ruleSet.ok).toBe(true);
    expect(result.attachment?.ok ? null : result.attachment?.reason).toBe('SCENARIO_REVISION_CONFLICT');
    expect(readLatestRuleSet(database, 'scenario-1')?.ruleSet.revision).toBe(1);
    expect(readScenario(database, 'scenario-1')).toMatchObject({ revision: scenario.revision });
    expect(readScenario(database, 'scenario-1')?.current.inputRuleReference).toBeNull();
    const first = saveRuleSetAndAttach(database, { ...saveOf(), expectedScenarioRevision: scenario.revision });
    expect(first.ruleSet.ok ? null : first.ruleSet.reason).toBe('RULE_SET_REVISION_CONFLICT');
    expect(first.attachment).toBeNull();
  });

  it('attaches only the reference of the latest revision of the rule set (T29d fix round 1)', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    const attach = (reference: { readonly ruleSetId: string; readonly revision: number; readonly digest: string }, expectedRevision = scenario.revision) =>
      attachInputRuleReference(database, { scenarioId: 'scenario-1', expectedRevision, reference, at: LATER_AT });
    const fake = { ruleSetId: 'rules-scenario-1', revision: 1, digest: `sha256:${'1'.repeat(64)}` };
    // 規則の集まりがない: 形だけの参照は付けない。
    expect(reasonOf(attach(fake))).toBe('SCENARIO_INPUT_RULES_NOT_LATEST');
    const first = saveRuleSet(database, saveOf());
    const second = saveRuleSet(database, saveOf({ expectedRevision: 1, content: FIXED_CONTENT, at: LATER_AT }));
    if (!first.ok || !second.ok) {
      throw new Error('the rule set was not saved');
    }
    // 形だけの digest、古い版、別の id は付けない。何も書かない。
    expect(reasonOf(attach({ ...second.reference, digest: fake.digest }))).toBe('SCENARIO_INPUT_RULES_NOT_LATEST');
    expect(reasonOf(attach(first.reference))).toBe('SCENARIO_INPUT_RULES_NOT_LATEST');
    expect(reasonOf(attach({ ...second.reference, ruleSetId: 'rules-other' }))).toBe('SCENARIO_INPUT_RULES_NOT_LATEST');
    expect(readScenario(database, 'scenario-1')).toMatchObject({ revision: scenario.revision });
    // 最新の版の参照は付ける。
    const attached = attach(second.reference);
    expect(attached.ok && attached.scenario.current.inputRuleReference).toEqual(second.reference);
  });

  it('turns an approval invalid with INPUT_RULES_CHANGED as soon as a new revision of the rules is saved', () => {
    prepareScenario(database, latest, 'scenario-1');
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, STATUS_AT)?.validity.approved).toBe(true);
    expect(saveRuleSet(database, saveOf({ expectedRevision: 1, content: FIXED_CONTENT })).ok).toBe(true);
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, STATUS_AT)?.validity)
      .toEqual({ approved: false, reasons: ['INPUT_RULES_CHANGED'] });
    expect(issue('scenario-1')).toMatchObject({ ok: false, reason: 'GRANT_APPROVAL_INVALID', invalidityReasons: ['INPUT_RULES_CHANGED'] });
  });

  it('rejects the issue with NEEDS_RULE_INPUT and the field problems when a field has no rule, and issues when every field is decided', () => {
    prepareScenario(database, latest, 'scenario-1', { ruleContent: UNDECIDED_CONTENT });
    expect(issue('scenario-1')).toEqual({
      ok: false,
      reason: 'NEEDS_RULE_INPUT',
      invalidityReasons: [],
      ruleProblems: [{ fieldName: 'name', problem: { code: 'NEEDS_RULE_INPUT', detail: 'NO_RULE' } }],
    });
    prepareScenario(database, latest, 'scenario-2', { ruleContent: FIXED_CONTENT });
    expect(issue('scenario-2', 'grant-2').ok).toBe(true);
  });

  it('binds the inferred rules to the approval through the digest, and issues with them (FM2c)', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    const inferred = inferRuleSetContent(scenario.current, scenario.evidence);
    expect(inferred.content.fieldRules.map(({ fieldName, origin }) => [fieldName, origin])).toEqual([['name', 'INFERRED'], ['plan', 'INFERRED']]);
    const first = saveRuleSetAndAttach(database, { ...saveOf({ content: inferred.content }), expectedScenarioRevision: scenario.revision });
    expect(first.ruleSet.ok && first.attachment?.ok).toBe(true);
    const stored = readLatestRuleSet(database, 'scenario-1');
    if (stored === null) {
      throw new Error('the rule set was not stored');
    }
    expect(stored.ruleSet).toMatchObject({ schemaVersion: RULE_SET_SCHEMA_VERSION, fieldRules: inferred.content.fieldRules });
    expect(stored.reference.digest).toBe(computeRuleSetDigest(stored.ruleSet));
    expect(readScenario(database, 'scenario-1')?.current.inputRuleReference).toEqual(stored.reference);
    // 同じ規則を、出どころの印だけ変えて保存すると、digest が変わる（推した規則の印も承認に結ぶ）。
    const human = saveRuleSet(database, saveOf({
      expectedRevision: 1, at: LATER_AT,
      content: { ...inferred.content, fieldRules: inferred.content.fieldRules.map((rule) => ({ ...rule, origin: 'HUMAN' as const })) },
    }));
    expect(human.ok && human.reference.digest).not.toBe(stored.reference.digest);
    // 推した規則だけで、送る欄がすべて決まれば、実行の許可を発行できる。
    prepareScenario(database, latest, 'scenario-2', { ruleContent: inferRuleSetContent(scenario.current, scenario.evidence).content });
    expect(issue('scenario-2', 'grant-2').ok).toBe(true);
  });

  // LG-3（2026-10-24 の設計 3.7.2）: 版 1 の文書の行（FM2c の前に保存した形）は、読み替えずに、契約の形の誤りとして管理データの誤り
  // （`DATABASE_INTEGRITY_FAILED`）で止まる（人の規則として黙って読まない）。
  it('stops at a stored version 1 document with DATABASE_INTEGRITY_FAILED (LG-3)', () => {
    prepareScenario(database, latest, 'scenario-1', { attach: false, approve: false });
    const saved = saveRuleSet(database, saveOf({ content: FIXED_CONTENT }));
    if (!saved.ok) {
      throw new Error('the rule set was not saved');
    }
    const v1Document = { ...JSON.parse(JSON.stringify(saved.ruleSet)) as Record<string, unknown>, schemaVersion: 'beaksight-data-rule/1' };
    const raw = new DatabaseSync(databasePath(), { timeout: RAW_TIMEOUT_MS });
    try {
      raw.prepare('UPDATE rule_set_revisions SET document = ? WHERE rule_set_id = ? AND revision = ?')
        .run(JSON.stringify(v1Document), saved.ruleSet.ruleSetId, saved.ruleSet.revision);
    } finally {
      raw.close();
    }
    for (const read of [() => readLatestRuleSet(database, 'scenario-1'), () => readRuleSetRevisions(database, 'scenario-1')]) {
      expect(read).toThrow(expect.objectContaining({ reason: 'DATABASE_INTEGRITY_FAILED' }));
      expect(read).toThrow(/does not match the contract/u);
    }
  });

  it('keeps the rules and the reference after reopening the database', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1');
    const before = readLatestRuleSet(database, 'scenario-1');
    closeControlDatabase(database);
    database = openControlDatabase(databasePath());
    expect(readLatestRuleSet(database, 'scenario-1')).toEqual(before);
    expect(readScenario(database, 'scenario-1')?.current.inputRuleReference).toEqual(before?.reference);
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, STATUS_AT)?.validity.approved).toBe(true);
    expect(scenario.current.inputRuleReference).toEqual(before?.reference);
  });
});

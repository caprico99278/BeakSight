// OP-F（安全のレビュー OP-REV の M-4。設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'、4.1.2 の「チェックの保存」）: チェックの範囲の
// 承認（`approveForCheck`。サイトの画面のチェックの保存と、点検の中の更新の自動の承認が使う 1 か所）。チェックの意味は「その画面で登録と更新を試す」なので、
// 更新を承認できなかったときは、その呼び出しで行った登録の承認を取り消し、どちらも承認しない形に戻す。前から有効な承認は、そのまま。
// 管理データは一時のフォルダだけ。サイトには接続しない。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readScenario } from '../../src/control/approval/scenario-store.js';
import { ruleSetHasHumanItems } from '../../src/control/data-rules/rule-contracts.js';
import { readRuleSetRevisions } from '../../src/control/data-rules/rule-store.js';
import { approveForCheck, approveUpdateForChain } from '../../src/control/approval/update-autodraft.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { APPROVED_AT, EXTERNAL, prepareGrantProfile, prepareScenario, prepareUpdateScenario } from './execution-grant-fixtures.js';
import { CREATE_CANDIDATE, UPDATE_CANDIDATE, candidateOf } from '../unit/approval-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';

const CREATE_ID = 'scenario-check-create';
const UPDATE_ID = 'scenario-check-update';
const MISSING_UPDATE_ID = 'scenario-check-missing-update';
const clock = (): string => APPROVED_AT;
const stateOf = (scenarioId: string): string | undefined => readScenario(database, scenarioId)?.state;

let workDirectory = '';
let database: ControlDatabase;
let latest: DiscoveryDocument;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-check-approval-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('OP-F M-4: the check approves the create and the update together', () => {
  beforeEach(() => {
    latest = prepareGrantProfile(database);
  });
  it('approves both when both can be approved', () => {
    prepareScenario(database, latest, CREATE_ID, { approve: false });
    prepareUpdateScenario(database, latest, UPDATE_ID, CREATE_ID, { approve: false });
    expect(approveForCheck(database, [CREATE_ID, UPDATE_ID], EXTERNAL, clock)).toEqual({ ok: true });
    expect([stateOf(CREATE_ID), stateOf(UPDATE_ID)]).toEqual(['APPROVED', 'APPROVED']);
  });

  it('takes back the approval of the create made in the same call when the update cannot be approved', () => {
    prepareScenario(database, latest, CREATE_ID, { approve: false });
    // 更新を承認できない（承認の口が状態を読めない更新。消えた・読めない更新のふり）。
    expect(approveForCheck(database, [CREATE_ID, MISSING_UPDATE_ID], EXTERNAL, clock)).toEqual({ ok: false, reason: 'APPROVAL_REJECTED' });
    expect(stateOf(CREATE_ID)).not.toBe('APPROVED');
  });

  it('keeps an approval that was already valid before the call', () => {
    prepareScenario(database, latest, CREATE_ID);
    expect(approveForCheck(database, [CREATE_ID, MISSING_UPDATE_ID], EXTERNAL, clock)).toEqual({ ok: false, reason: 'APPROVAL_REJECTED' });
    expect(stateOf(CREATE_ID)).toBe('APPROVED');
  });

  it('approves only the create when there is no update yet (the update is tried in the next inspection)', () => {
    prepareScenario(database, latest, CREATE_ID, { approve: false });
    expect(approveForCheck(database, [CREATE_ID], EXTERNAL, clock)).toEqual({ ok: true });
    expect(stateOf(CREATE_ID)).toBe('APPROVED');
  });
});

describe('SPEC-4: the check does not use the rules a person saved on the removed rules screen', () => {
  beforeEach(() => {
    latest = prepareGrantProfile(database);
  });
  // 前の規則の画面で人が保存した固定の値（印のない規則）。
  const humanContent = {
    fieldRules: [{ fieldName: 'plan', semanticKind: 'FIXED_LIST' as const, method: 'FROM_FIXED_LIST' as const, range: null, fixedValues: ['a'] }],
    relations: [],
    uniqueKeyFieldNames: [],
  };
  const attachedRulesOf = (scenarioId: string) => {
    const reference = readScenario(database, scenarioId)?.current.inputRuleReference ?? null;
    return readRuleSetRevisions(database, scenarioId).find(({ reference: saved }) => saved.revision === reference?.revision)?.ruleSet ?? null;
  };

  it.each([['a draft', false], ['an approved scenario', true]] as const)('approves %s with the inferred rules instead of the human rules', (_label, approve) => {
    prepareScenario(database, latest, CREATE_ID, { approve, ruleContent: humanContent });
    expect(approveForCheck(database, [CREATE_ID], EXTERNAL, clock)).toEqual({ ok: true });
    expect(stateOf(CREATE_ID)).toBe('APPROVED');
    const rules = attachedRulesOf(CREATE_ID);
    expect(rules).not.toBeNull();
    expect(ruleSetHasHumanItems(rules!)).toBe(false);
  });
});

describe('OP-F M-3: the update found in the inspection after the check (the default candidates)', () => {
  beforeEach(() => {
    latest = prepareGrantProfile(database);
  });

  it('M-3: approves the update found later when the line about notifications was shown at the check (the create screen may notify)', () => {
    prepareScenario(database, latest, CREATE_ID);
    prepareUpdateScenario(database, latest, UPDATE_ID, CREATE_ID, { approve: false });
    expect(approveUpdateForChain(database, CREATE_ID, UPDATE_ID, EXTERNAL, clock)).toEqual({ ok: true });
    expect(stateOf(UPDATE_ID)).toBe('APPROVED');
  });
});

describe('OP-F M-3: the update screen that may notify, found after a check without the line', () => {
  // 知らせの欄のない登録の画面（チェックのときに行に 1 行が出なかった）と、メールの欄のある更新の画面。
  const quietCreate = candidateOf(sampleForm({
    page: { origin: SAMPLE_ORIGIN, path: '/members/new' }, action: sampleAction('/members'), submitterText: '登録',
    fields: [sampleField('name', 'text', { required: true }), sampleField('plan', 'select-one', { options: ['a', 'b'] })],
  }));
  const noisyUpdate = candidateOf(sampleForm({
    page: { origin: SAMPLE_ORIGIN, path: '/members/1/edit' }, action: sampleAction('/members/1'), methodOverride: 'PATCH', submitterText: '更新',
    enctype: 'multipart/form-data',
    fields: [sampleField('name'), sampleField('email', 'email'), sampleField('_method', 'hidden', { hasValue: true })],
  }));

  it('does not approve the update automatically, and keeps the create approved', () => {
    expect(CREATE_CANDIDATE.identityDigest).not.toBe(quietCreate.identityDigest);
    expect(UPDATE_CANDIDATE.identityDigest).not.toBe(noisyUpdate.identityDigest);
    latest = prepareGrantProfile(database, [quietCreate, noisyUpdate]);
    prepareScenario(database, latest, CREATE_ID, { candidate: quietCreate });
    prepareUpdateScenario(database, latest, UPDATE_ID, CREATE_ID, { approve: false, candidate: noisyUpdate, keepFieldNames: ['email'] });
    expect(approveUpdateForChain(database, CREATE_ID, UPDATE_ID, EXTERNAL, clock)).toEqual({ ok: false, reason: 'UPDATE_MAY_NOTIFY' });
    expect(stateOf(UPDATE_ID)).not.toBe('APPROVED');
    expect(stateOf(CREATE_ID)).toBe('APPROVED');
  });
});

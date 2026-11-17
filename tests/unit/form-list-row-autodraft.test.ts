// LU-11（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 4.0 の D5、5.4 の 4 のフォームの部分）: 行の下に広がるフォームの形（形 B）。
// - 送信先を型にした識別の digest（`src/discovery/fingerprint.ts` の `actionPathTemplatedIdentityDigestOf`）: 送信先の path の最後の番号の区切りだけを `{id}`
//   にする。番号だけが違う送信先で同じ、途中の番号は変えない、構造が違えば違う。画面の path を型にした digest と印が違う。
// - まとめ（`src/control/approval/autodraft-shared.ts` の `formAutoDraftRowsOf`）: 画面の path に番号がなく、送信先の最後が番号のフォームの更新は 1 行。
//   画面の path に番号がある今の形（形 C）は今のまま。
// - LU-11 fix round 1: フォームの候補の同じ行の開き手（`rowOpener`。行の決まりは `read-executor.ts` の `listRowOfFormPath`、結び付けは `discover-page.ts` の
//   `withRowOpeners`）、形 B の型の推し（`listRowFormTemplatesOf`）と行の選び方（`formListRowUpdateOf`）、下書きの確かめ（`validateScenarioDraft` の `update.listRow`）。
import { describe, expect, it } from 'vitest';
import {
  autoDraftRecordIdTemplatesOf,
  formAutoDraftRowsOf,
  formUpdateTemplatesOf,
  listRowFormTemplatesOf,
} from '../../src/control/approval/autodraft-shared.js';
import { listRowUpdateFieldsOf } from '../../src/control/approval/api-scenario-autodraft.js';
import { formListRowUpdateOf, formRecordIdFromUpdateOf, formUpdateDraftPresetOf } from '../../src/control/approval/form-scenario-autodraft.js';
import { chooseUpdateChangedField, type UpdateChangedFieldFact } from '../../src/control/approval/update-changed-field.js';
import type { ScenarioKindFact } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft, type ScenarioDraftContext } from '../../src/control/approval/scenario-policy.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { withRevealedRowFormFields, withRowOpeners } from '../../src/discovery/discover-page.js';
import {
  CANDIDATE_ACTION_TEMPLATE_IDENTITY_DIGEST_FORMAT,
  CANDIDATE_PAGE_TEMPLATE_IDENTITY_DIGEST_FORMAT,
  CANDIDATE_TEMPLATE_IDENTITY_DIGEST_FORMAT,
  actionPathTemplatedIdentityDigestOf,
  computeCandidateDigests,
  listRowFormTemplatedIdentityDigestOf,
} from '../../src/discovery/fingerprint.js';
import type { ProbedCandidate } from '../../src/discovery/probe.js';
import { listRowOfFormPath, type ListRowPath } from '../../src/discovery/read-executor.js';
import { submissionProbeOpenerOf, type SubmissionProbeOpener } from '../../src/discovery/submission-probe-contracts.js';
import { CREATE_CANDIDATE, PROFILE_ID, UPDATE_CANDIDATE, candidateOf, sampleDraft } from './approval-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleButton, sampleField, sampleForm } from './discovery-candidate-samples.js';

/** 一覧の画面 `/items` の、行 `id` の下に広がるフォーム（送信先 `/items/<id>`）。 */
const rowFormOf = (id: string, overrides: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate => sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/items' },
  action: sampleAction(`/items/${id}`),
  submitterText: '保存',
  fields: [sampleField('name'), sampleField('note')],
  ...overrides,
});

describe('LU-11: the identity digest with the last record id of the action as {id}', () => {
  it('is the same for the actions of two rows, and differs from the plain identity digest', () => {
    const four = actionPathTemplatedIdentityDigestOf(rowFormOf('4'));
    expect(four).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('5'))).toBe(four);
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('0b5c6a3e-6f5d-4bfb-9a3d-2f1d3c4b5a69'))).toBe(four);
    expect(computeCandidateDigests(rowFormOf('4')).identityDigest).not.toBe(four);
    expect(computeCandidateDigests(rowFormOf('4')).identityDigest).not.toBe(computeCandidateDigests(rowFormOf('5')).identityDigest);
  });

  it('keeps a record id in the middle of the action path', () => {
    const inProject = (project: string, id: string) => actionPathTemplatedIdentityDigestOf(rowFormOf(id, {
      page: { origin: SAMPLE_ORIGIN, path: `/projects/${project}/items` },
      action: sampleAction(`/projects/${project}/items/${id}`),
    }));
    expect(inProject('7', '4')).toBe(inProject('7', '5'));
    expect(inProject('7', '4')).not.toBe(inProject('8', '4'));
  });

  it('differs when the structure differs (the fields, the method, the page)', () => {
    const base = actionPathTemplatedIdentityDigestOf(rowFormOf('4'));
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('4', { fields: [sampleField('name')] }))).not.toBe(base);
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('4', { methodOverride: 'PATCH' }))).not.toBe(base);
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('4', { page: { origin: SAMPLE_ORIGIN, path: '/things' } }))).not.toBe(base);
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('4', { action: sampleAction('/things/4') }))).not.toBe(base);
  });

  it('is null without an action or when the last segment of the action is not a record id', () => {
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('4', { action: null }))).toBeNull();
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('4', { action: sampleAction('/items/4/update') }))).toBeNull();
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('4', { action: sampleAction('/items') }))).toBeNull();
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('4', { action: sampleAction('/items/') }))).toBeNull();
    expect(actionPathTemplatedIdentityDigestOf(rowFormOf('4', { action: sampleAction('/4') }))).not.toBeNull();
  });

  it('has its own format mark, apart from the other templated digests', () => {
    expect(new Set([
      CANDIDATE_ACTION_TEMPLATE_IDENTITY_DIGEST_FORMAT,
      CANDIDATE_PAGE_TEMPLATE_IDENTITY_DIGEST_FORMAT,
      CANDIDATE_TEMPLATE_IDENTITY_DIGEST_FORMAT,
    ]).size).toBe(3);
  });
});

describe('LU-11: the rows of the form drafts group the forms under the rows of a list', () => {
  it('makes one update row of the four forms of the rows, with the first form as the row', () => {
    const forms = ['1', '2', '3', '4'].map((id) => candidateOf(rowFormOf(id)));
    expect(new Set(forms.map(({ classification }) => classification))).toEqual(new Set(['UPDATE']));
    const rows = formAutoDraftRowsOf([CREATE_CANDIDATE, ...forms]);
    expect(rows.map(({ kind, candidate }) => [kind, candidate.action?.path])).toEqual([['CREATE', '/members'], ['UPDATE', '/items/1']]);
  });

  it('keeps the forms of different lists apart', () => {
    const items = ['1', '2'].map((id) => candidateOf(rowFormOf(id)));
    const things = ['1', '2'].map((id) => candidateOf(rowFormOf(id, {
      page: { origin: SAMPLE_ORIGIN, path: '/things' },
      action: sampleAction(`/things/${id}`),
    })));
    expect(formAutoDraftRowsOf([...items, ...things]).map(({ candidate }) => candidate.action?.path)).toEqual(['/items/1', '/things/1']);
  });

  it('keeps the update forms whose page path has a record id (the separate edit screen) as they are', () => {
    const second = candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/members/2/edit' },
      action: sampleAction('/members/2'),
      methodOverride: 'PATCH',
      submitterText: '更新',
      enctype: 'multipart/form-data',
      fields: [sampleField('name'), sampleField('_method', 'hidden', { hasValue: true })],
    }));
    expect(formAutoDraftRowsOf([UPDATE_CANDIDATE, second, UPDATE_CANDIDATE]).map(({ candidate }) => candidate.page.path))
      .toEqual(['/members/1/edit', '/members/2/edit']);
  });

  it('keeps the forms whose action does not end with a record id apart, one row for each identity', () => {
    const forms = ['1', '2'].map((id) => candidateOf(rowFormOf(id, { action: sampleAction(`/items/${id}/update`) })));
    expect(formAutoDraftRowsOf(forms).map(({ candidate }) => candidate.action?.path)).toEqual(['/items/1/update', '/items/2/update']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// LU-11 fix round 1（設計者の判断。案 (a)）: フォームの候補に同じ行の開き手（`rowOpener`）を結ぶ、形 B の型の推しと行の選び方、下書きの確かめ
// ---------------------------------------------------------------------------------------------------------------

const ROW_TABLE = [0, 1, 0, 0, 1];
/** 表の行の位置（`tbody` の `index` 番目の子）。 */
const rowPathOf = (index: number): readonly number[] => [...ROW_TABLE, index];
const tableRow = (index: number): ListRowPath => ({ path: rowPathOf(index), tableRow: true });

/** probe の候補（契約の形の部分と要素の位置）。 */
const probedOf = (candidate: DiscoveredCandidate, element: readonly number[], hasSubmitterText = true): ProbedCandidate => ({
  kind: candidate.kind,
  formMethod: candidate.formMethod,
  methodOverride: candidate.methodOverride,
  action: candidate.action,
  enctype: candidate.enctype,
  target: candidate.target,
  fields: candidate.fields,
  submitterWords: candidate.submitterWords,
  hasSubmitterText,
  hasSubmitWord: false,
  inlineHandler: false,
  form: candidate.kind === 'FORM' ? { path: element, localName: 'form' } : null,
  submitter: candidate.kind === 'BUTTON' ? { path: element, localName: 'button' } : null,
});

const LIST_PAGE = { origin: SAMPLE_ORIGIN, path: '/items' };
const EDIT_BUTTON = sampleButton({ page: LIST_PAGE, submitterText: '編集' });
const REMOVE_BUTTON = sampleButton({ page: LIST_PAGE, submitterText: '削除' });
const EDIT_AND_REMOVE_BUTTON = sampleButton({ page: LIST_PAGE, submitterText: '編集 削除' });
const OTHER_OPENER_BUTTON = sampleButton({ page: LIST_PAGE, submitterText: '修正' });

type LinkItem = readonly [DiscoveredCandidate, readonly number[], boolean?];

/** 候補と probe の候補の組から、結んだ候補を作る。 */
const linkedOf = (items: readonly LinkItem[], rows: readonly ListRowPath[] | null): readonly DiscoveryCandidate[] => {
  const candidates = items.map(([candidate]) => candidateOf(candidate));
  return withRowOpeners(candidates, items.map(([candidate, path, named]) => probedOf(candidate, path, named ?? true)), rows);
};

describe('LU-11 fix round 1: the opener of the row of a form', () => {
  const EDIT_DIGEST = candidateOf(EDIT_BUTTON).identityDigest;

  it('binds a form to the named opener in the same row (a table row and a list item)', () => {
    const [form, button] = linkedOf([[rowFormOf('4'), [...rowPathOf(0), 2, 0]], [EDIT_BUTTON, [...rowPathOf(0), 1, 0]]], [tableRow(0)]);
    expect(form?.rowOpener).toEqual({ identityDigest: EDIT_DIGEST, hasName: true, openerWords: ['編集'] });
    expect(button?.rowOpener).toBeUndefined();
    const item: ListRowPath = { path: [0, 1, 0, 3], tableRow: false };
    const [inItem] = linkedOf([[rowFormOf('4'), [0, 1, 0, 3, 2]], [EDIT_BUTTON, [0, 1, 0, 3, 0]]], [item]);
    expect(inItem?.rowOpener?.identityDigest).toBe(EDIT_DIGEST);
  });

  it('binds a form in the hidden table row just below to the opener of the row above', () => {
    const rows = [tableRow(0), tableRow(1), tableRow(2), tableRow(3)];
    const linked = linkedOf([
      [EDIT_BUTTON, [...rowPathOf(0), 2, 0]],
      [rowFormOf('4'), [...rowPathOf(1), 0, 0]],
      [EDIT_BUTTON, [...rowPathOf(2), 2, 0]],
      [rowFormOf('5'), [...rowPathOf(3), 0, 0]],
    ], rows);
    expect(linked.map(({ rowOpener }) => rowOpener?.identityDigest ?? null)).toEqual([null, EDIT_DIGEST, null, EDIT_DIGEST]);
  });

  it('does not reach over a row, into the list item before, or outside the rows', () => {
    // 2 つ上の行の開き手には結ばない（すぐ前の行だけ）。
    const [far] = linkedOf([[rowFormOf('4'), [...rowPathOf(2), 0, 0]], [EDIT_BUTTON, [...rowPathOf(0), 2, 0]]], [tableRow(0), tableRow(1), tableRow(2)]);
    expect(far?.rowOpener).toBeUndefined();
    // 一覧の `li` は同じ `li` の中だけ（前の `li` の開き手には結ばない）。
    const items: ListRowPath[] = [{ path: [0, 1, 0, 0], tableRow: false }, { path: [0, 1, 0, 1], tableRow: false }];
    const [inNext] = linkedOf([[rowFormOf('4'), [0, 1, 0, 1, 0]], [EDIT_BUTTON, [0, 1, 0, 0, 0]]], items);
    expect(inNext?.rowOpener).toBeUndefined();
    // 行の外のフォームは結ばない。
    const [outside] = linkedOf([[rowFormOf('4'), [0, 1, 1]], [EDIT_BUTTON, [...rowPathOf(0), 2, 0]]], [tableRow(0)]);
    expect(outside?.rowOpener).toBeUndefined();
  });

  it('does not bind when the row has no opener or two openers, an unnamed opener, or an opener with a removal word', () => {
    const form: LinkItem = [rowFormOf('4'), [...rowPathOf(0), 3, 0]];
    const rows = [tableRow(0)];
    expect(linkedOf([form], rows)[0]?.rowOpener).toBeUndefined();
    expect(linkedOf([form, [EDIT_BUTTON, [...rowPathOf(0), 1, 0]], [OTHER_OPENER_BUTTON, [...rowPathOf(0), 2, 0]]], rows)[0]?.rowOpener).toBeUndefined();
    expect(linkedOf([form, [EDIT_BUTTON, [...rowPathOf(0), 1, 0]], [EDIT_BUTTON, [...rowPathOf(0), 2, 0]]], rows)[0]?.rowOpener).toBeUndefined();
    expect(linkedOf([form, [EDIT_BUTTON, [...rowPathOf(0), 1, 0], false]], rows)[0]?.rowOpener).toBeUndefined();
    expect(linkedOf([form, [EDIT_AND_REMOVE_BUTTON, [...rowPathOf(0), 1, 0]]], rows)[0]?.rowOpener).toBeUndefined();
    // 削除のボタンは開き手に数えない（編集とならんでいても、編集の 1 つに結ぶ）。
    expect(linkedOf([form, [EDIT_BUTTON, [...rowPathOf(0), 1, 0]], [REMOVE_BUTTON, [...rowPathOf(0), 2, 0]]], rows)[0]?.rowOpener?.identityDigest)
      .toBe(EDIT_DIGEST);
    // 行の位置が読めなければ結ばない。
    expect(linkedOf([form, [EDIT_BUTTON, [...rowPathOf(0), 1, 0]]], null)[0]?.rowOpener).toBeUndefined();
  });

  it('keeps the row rule in one named function of the row rule owner', () => {
    const rows = [tableRow(0), tableRow(1)];
    expect(listRowOfFormPath(rows, [...rowPathOf(1), 0], (row) => row === rows[0])).toBe(rows[0]);
    expect(listRowOfFormPath(rows, [...rowPathOf(1), 0], () => false)).toBeNull();
    expect(listRowOfFormPath(rows, [...rowPathOf(1), 0], () => true)).toBe(rows[1]);
    expect(listRowOfFormPath(rows, [9], () => true)).toBeNull();
  });
});

const EDIT_OPENER = submissionProbeOpenerOf(candidateOf(EDIT_BUTTON).identityDigest, true, ['編集']);
const UNNAMED_OPENER = submissionProbeOpenerOf(EDIT_OPENER.identityDigest, false, ['編集']);

/** 同じ行の開き手（なければ省く）のある、形 B のフォームの候補。 */
const withOpener = (candidate: DiscoveredCandidate, opener: SubmissionProbeOpener | null): DiscoveryCandidate =>
  ({ ...candidateOf(candidate), ...(opener === null ? {} : { rowOpener: opener }) });

const KEYED_FORM = rowFormOf('4', { fields: [sampleField('title'), sampleField('note')] });
const ROW_FORM = withOpener(KEYED_FORM, EDIT_OPENER);
const LEDGER_RECORD_ID = { source: 'URL_PATH_PATTERNS', pathPatterns: ['/items/{id}'] } as const;

describe('LU-11 fix round 1: the templates and the list row of a list row form update', () => {
  it('presets the list path and the action template for a form with a row opener, and keeps the edit screen form as it was', () => {
    expect(listRowFormTemplatesOf(ROW_FORM)).toEqual({ formPathTemplate: '/items', actionPathTemplate: '/items/{id}', recordId: '4' });
    expect(formUpdateTemplatesOf(ROW_FORM)).toEqual(listRowFormTemplatesOf(ROW_FORM));
    expect(listRowFormTemplatesOf(withOpener(KEYED_FORM, null))).toBeNull();
    expect(listRowFormTemplatesOf(withOpener(KEYED_FORM, UNNAMED_OPENER))).toBeNull();
    expect(formUpdateTemplatesOf(UPDATE_CANDIDATE)).toEqual(autoDraftRecordIdTemplatesOf(UPDATE_CANDIDATE));
    const preset = formUpdateDraftPresetOf(ROW_FORM, [{ scenarioId: 'scenario-ledger', kind: 'CREATE', recordId: LEDGER_RECORD_ID }]);
    expect(preset.templates?.value).toEqual({ formPathTemplate: '/items', actionPathTemplate: '/items/{id}' });
    expect(preset.ledger?.value).toBe('scenario-ledger');
  });

  it('takes the record id of a create of the same table from the action template of the list row form only', () => {
    const create = candidateOf(sampleForm({ page: LIST_PAGE, action: sampleAction('/items'), submitterText: '登録', fields: [sampleField('title')] }));
    expect(formRecordIdFromUpdateOf(create, [ROW_FORM])?.value).toEqual({ source: 'URL_PATH_PATTERNS', pathPatterns: ['/items/{id}'] });
  });

  // LU-11 fix round 2: 規則 F の事実（`title` は登録で送った欄、`note` は登録の画面にない欄。どちらも変えられる）。
  const FACTS: readonly UpdateChangedFieldFact[] = [
    { name: 'title', usable: true, sentInLedger: true, onCreateScreen: true },
    { name: 'note', usable: true, sentInLedger: false, onCreateScreen: false },
  ];

  it('chooses the row key field first and the changed field among the others, and makes nothing without a named opener or a key field', () => {
    const input = {
      update: ROW_FORM, formPathTemplate: '/items', facts: FACTS, ledgerFact: { uniqueEachRunFieldNames: ['title'] }, listShownFieldNames: [],
    };
    // 毎回違う欄が `title` だけで、それが行を選ぶ欄になる。規則 F だけなら `title` を変えるが、変える欄は `note` から選ぶ。
    expect(formListRowUpdateOf(input)).toEqual({
      listRow: { listPagePath: '/items', openerIdentityDigest: EDIT_OPENER.identityDigest, rowKeyField: 'title' },
      changedFieldNames: ['note'],
      keepFieldNames: ['title'],
    });
    expect(formListRowUpdateOf({ ...input, ledgerFact: undefined })).toBeNull();
    expect(formListRowUpdateOf({ ...input, ledgerFact: { uniqueEachRunFieldNames: ['other'] } })).toBeNull();
    expect(formListRowUpdateOf({ ...input, update: withOpener(KEYED_FORM, null) })).toBeNull();
    expect(formListRowUpdateOf({ ...input, update: withOpener(KEYED_FORM, UNNAMED_OPENER) })).toBeNull();
    expect(formListRowUpdateOf({ ...input, formPathTemplate: '/items/{id}' })).toBeNull();
    // 行を選ぶ欄のほかに変えられる欄がなければ作らない。
    expect(formListRowUpdateOf({ ...input, facts: [FACTS[0] as UpdateChangedFieldFact, { ...FACTS[1] as UpdateChangedFieldFact, usable: false }] })).toBeNull();
  });

  it('keeps the rule F choice in one place: the excluded field is never chosen, for the API form and the form form', () => {
    expect(chooseUpdateChangedField(FACTS)).toEqual({ kind: 'CHOSEN', fieldName: 'title', ground: 'SENT_BY_CREATE' });
    expect(chooseUpdateChangedField(FACTS, ['title'])).toEqual({ kind: 'CHOSEN', fieldName: 'note', ground: 'OTHER_FIELD' });
    expect(chooseUpdateChangedField(FACTS, ['title', 'note'])).toEqual({ kind: 'UNAVAILABLE', reason: 'UPDATE_CHANGED_FIELD_NOT_FOUND' });
    expect(listRowUpdateFieldsOf({ facts: FACTS, uniqueEachRunFieldNames: ['title'], listShownFieldNames: [] }))
      .toEqual({ rowKeyField: 'title', changedFieldNames: ['note'], keepFieldNames: ['title'], ground: 'OTHER_FIELD' });
    expect(listRowUpdateFieldsOf({ facts: [FACTS[0] as UpdateChangedFieldFact], uniqueEachRunFieldNames: ['title'], listShownFieldNames: [] })).toBeNull();
  });
});

describe('LU-11 fix round 1: the draft check of a list row form update', () => {
  const LEDGER_FACT: ScenarioKindFact = { scenarioId: 'scenario-ledger', profileId: PROFILE_ID, kind: 'CREATE', uniqueEachRunFieldNames: ['title'] };
  const CONTEXT: ScenarioDraftContext = Object.freeze({ scenarioId: null, scenarios: [LEDGER_FACT] });
  const LIST_ROW = { listPagePath: '/items', openerIdentityDigest: EDIT_OPENER.identityDigest, rowKeyField: 'title' };
  const draftOf = (update: Record<string, unknown> = {}, candidate: DiscoveryCandidate = ROW_FORM): Record<string, unknown> => sampleDraft({
    candidateIdentityDigest: candidate.identityDigest,
    fieldNames: ['note'],
    readChecks: [],
    update: {
      targetCreateScenarioId: 'scenario-ledger', formPathTemplate: '/items', actionPathTemplate: '/items/{id}', keepFieldNames: ['title'], listRow: LIST_ROW,
      ...update,
    },
  });
  const codesOf = (result: ReturnType<typeof validateScenarioDraft>): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
  const validate = (draft: unknown, candidate: DiscoveryCandidate = ROW_FORM, context: ScenarioDraftContext = CONTEXT) =>
    validateScenarioDraft(draft, candidate, [], context);

  it('accepts the list row, with the list row digest of the action template and a copy of the list row', () => {
    const result = validate(draftOf());
    expect(codesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.content.update).toMatchObject({ formPathTemplate: '/items', actionPathTemplate: '/items/{id}', listRow: LIST_ROW });
    expect(result.content.update?.templatedIdentityDigest).toBe(listRowFormTemplatedIdentityDigestOf(ROW_FORM));
  });

  it('checks the shape: the form template is the list page path and the action template ends with {id}', () => {
    expect(codesOf(validate(draftOf({ formPathTemplate: '/things' })))).toContain('SCENARIO_INPUT_INVALID');
    expect(codesOf(validate(draftOf({ actionPathTemplate: '/items/{id}/save' })))).toContain('SCENARIO_INPUT_INVALID');
    expect(codesOf(validate(draftOf({ actionPathTemplate: '/items/4' })))).toContain('SCENARIO_INPUT_INVALID');
    expect(codesOf(validate(draftOf({ listRow: { ...LIST_ROW, extra: 1 } })))).toContain('SCENARIO_INPUT_INVALID');
  });

  it('rejects another list path, another opener, an unnamed opener, no opener and an action template that does not give back the action', () => {
    expect(codesOf(validate(draftOf({ formPathTemplate: '/other', listRow: { ...LIST_ROW, listPagePath: '/other' } }))))
      .toContain('SCENARIO_UPDATE_PATH_MISMATCH');
    expect(codesOf(validate(draftOf({ listRow: { ...LIST_ROW, openerIdentityDigest: `sha256:${'2'.repeat(64)}` } }))))
      .toContain('SCENARIO_UPDATE_PATH_MISMATCH');
    const unnamed = withOpener(KEYED_FORM, UNNAMED_OPENER);
    expect(codesOf(validate(draftOf({}, unnamed), unnamed))).toContain('SCENARIO_UPDATE_PATH_MISMATCH');
    const noOpener = withOpener(KEYED_FORM, null);
    expect(codesOf(validate(draftOf({}, noOpener), noOpener))).toContain('SCENARIO_UPDATE_PATH_MISMATCH');
    expect(codesOf(validate(draftOf({ actionPathTemplate: '/things/{id}' })))).toContain('SCENARIO_UPDATE_PATH_MISMATCH');
  });

  it('rejects a row key field that is not a field of the ledger whose value differs each run (and fails closed without the fact)', () => {
    expect(codesOf(validate(draftOf({ listRow: { ...LIST_ROW, rowKeyField: 'note' } })))).toContain('SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID');
    const withoutFact: ScenarioDraftContext = { scenarioId: null, scenarios: [{ scenarioId: 'scenario-ledger', profileId: PROFILE_ID, kind: 'CREATE' }] };
    expect(codesOf(validate(draftOf(), ROW_FORM, withoutFact))).toContain('SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID');
  });

  it('keeps the edit screen form update as it was, and rejects a list row on an edit screen form', () => {
    const edit = { targetCreateScenarioId: 'scenario-ledger', formPathTemplate: '/members/{id}/edit', actionPathTemplate: '/members/{id}', keepFieldNames: [] };
    const draft = sampleDraft({ candidateIdentityDigest: UPDATE_CANDIDATE.identityDigest, fieldNames: ['name'], readChecks: [], update: edit });
    expect(codesOf(validateScenarioDraft(draft, UPDATE_CANDIDATE, [], CONTEXT))).toEqual([]);
    const listed = { ...draft, update: { ...edit, formPathTemplate: '/members/1/edit', listRow: { ...LIST_ROW, listPagePath: '/members/1/edit' } } };
    expect(codesOf(validateScenarioDraft(listed, UPDATE_CANDIDATE, [], CONTEXT))).toContain('SCENARIO_UPDATE_PATH_MISMATCH');
  });
});

// LU-11 fix round 2（設計者の判断。選択肢 1）: 開き手を押した後の読み直しで、その開き手に結ばれた形 B のフォームの欄の見え方を記録し直す。
describe('LU-11 fix round 2: the fields of the list row form revealed by pressing the opener', () => {
  const OPENER_DIGEST = candidateOf(EDIT_BUTTON).identityDigest;
  const hiddenForm = (id: string, overrides: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate => rowFormOf(id, {
    fields: [sampleField('title', 'text', { hidden: true }), sampleField('note', 'text', { hidden: true }), sampleField('lock', 'hidden')],
    ...overrides,
  });
  const visibleForm = (id: string): DiscoveredCandidate => rowFormOf(id, { fields: [sampleField('title'), sampleField('note'), sampleField('lock', 'hidden')] });
  const boundOf = (candidate: DiscoveredCandidate): DiscoveryCandidate => withOpener(candidate, submissionProbeOpenerOf(OPENER_DIGEST, true, ['編集']));
  const rereadOf = (...candidates: DiscoveredCandidate[]): readonly ProbedCandidate[] => candidates.map((candidate, index) => probedOf(candidate, [0, 1, index]));
  const hiddenOf = (candidates: readonly DiscoveryCandidate[]) => candidates.map(({ fields }) => fields.map(({ hidden }) => hidden));

  it('records the visibility of the revealed form only, keeps the identity and takes the rule digest after the press', () => {
    const before = [boundOf(hiddenForm('4')), boundOf(hiddenForm('5'))];
    const after = withRevealedRowFormFields(before, LIST_PAGE, OPENER_DIGEST, rereadOf(visibleForm('4'), hiddenForm('5')));
    expect(hiddenOf(after)).toEqual([[false, false, true], [true, true, true]]);
    expect(after[0]?.identityDigest).toBe(before[0]?.identityDigest);
    expect(after[0]?.ruleDigest).not.toBe(before[0]?.ruleDigest);
    expect(after[0]?.ruleDigest).toBe(candidateOf(visibleForm('4')).ruleDigest);
    expect(after[1]).toBe(before[1]);
  });

  it('keeps the record when the form is replaced, two forms are revealed, the opener differs or the form is not bound', () => {
    const before = [boundOf(hiddenForm('4')), boundOf(hiddenForm('5'))];
    // 欄の並びが違う（押した後に別のフォームにすり替わる形）。
    const swapped = rowFormOf('4', { fields: [sampleField('note'), sampleField('title'), sampleField('lock', 'hidden')] });
    expect(withRevealedRowFormFields(before, LIST_PAGE, OPENER_DIGEST, rereadOf(swapped))).toBe(before);
    // 送信先が違う（識別の digest が違う）。
    expect(withRevealedRowFormFields(before, LIST_PAGE, OPENER_DIGEST, rereadOf(rowFormOf('9', { fields: visibleForm('4').fields })))).toBe(before);
    // 2 つのフォームが見えるようになった（どれが押した行か分からない）。
    expect(withRevealedRowFormFields(before, LIST_PAGE, OPENER_DIGEST, rereadOf(visibleForm('4'), visibleForm('5')))).toBe(before);
    // 別の開き手。
    expect(withRevealedRowFormFields(before, LIST_PAGE, `sha256:${'3'.repeat(64)}`, rereadOf(visibleForm('4')))).toBe(before);
    // 開き手に結ばれていないフォーム。
    const unbound = [candidateOf(hiddenForm('4'))];
    expect(withRevealedRowFormFields(unbound, LIST_PAGE, OPENER_DIGEST, rereadOf(visibleForm('4')))).toBe(unbound);
    // 見えるようにならなかった。
    expect(withRevealedRowFormFields(before, LIST_PAGE, OPENER_DIGEST, rereadOf(hiddenForm('4'), hiddenForm('5')))).toBe(before);
  });
});

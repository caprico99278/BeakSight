// PL-6b（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8 章、8.1 の「自動で決める項目」）: フォームの形の書き込みの手順の自動の下書き
// （`src/control/approval/form-scenario-autodraft.ts`）と、API の形と共通の決まり（`autodraft-shared.ts`）と、書き換えの検証の指定の台帳からの写し
// （`update-verification-copy.ts`）。
// - 登録の送る欄（必須と送らないと保存できない欄）、登録の ID の型（同じ表の書き換えの候補の送信先の型と画面の型の 2 つ）、答え合わせ（検索の候補の文字の欄の
//   照合の専用の定義。期待は「作った値を含む」）、決められないときの理由、既にあるもの、古い発見。
// - 作った下書きは、今の下書きの確かめ（`validateScenarioDraft`）を通る。副作用の確認の 4 項目は偽。
import { describe, expect, it } from 'vitest';
import {
  AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS,
  autoDraftReadCheckChoiceOf,
} from '../../src/control/approval/api-scenario-autodraft.js';
import {
  autoDraftDefinitionChoiceOf,
  autoDraftRecordIdTemplatesOf,
  autoDraftScreenMayNotifyOf,
  formAutoDraftRowsOf,
  isAutoDraftRecordIdSegment,
  updateNotifyConfirmedByCheckOf,
  writeScreenMayNotifyOf,
} from '../../src/control/approval/autodraft-shared.js';
import {
  FORM_AUTO_DRAFT_GAPS,
  formAnswerReadChoiceOf,
  formAnswerReadDefinitionOf,
  formAnswerReadVerificationOf,
  formAutoDraftPlanOf,
  formCreateFieldNamesOf,
  formUpdateDraftPresetOf,
  type FormAutoDraftCreatePlan,
} from '../../src/control/approval/form-scenario-autodraft.js';
import { SIDE_EFFECT_CONFIRMATIONS } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft, type ScenarioDraftContext } from '../../src/control/approval/scenario-policy.js';
import { updateVerificationCopyOf } from '../../src/control/approval/update-verification-copy.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { CREATE_CANDIDATE, PROFILE_ID, READ_CANDIDATE, UPDATE_CANDIDATE, candidateOf } from './approval-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

const CONTEXT: ScenarioDraftContext = Object.freeze({
  scenarioId: null,
  scenarios: Object.freeze([]),
  profileRevisions: Object.freeze({ discoveryJob: 2, current: 2 }),
}) as ScenarioDraftContext;

const planOf = (candidates: readonly DiscoveryCandidate[], context = CONTEXT, scenarios: Parameters<typeof formAutoDraftPlanOf>[0]['scenarios'] = []) =>
  formAutoDraftPlanOf({ profileId: PROFILE_ID, candidates, context, scenarios });

const newOf = (plan: FormAutoDraftCreatePlan | undefined): Extract<FormAutoDraftCreatePlan, { status: 'NEW' }> => {
  if (plan?.status !== 'NEW') {
    throw new Error(`the create plan is not NEW: ${plan?.status ?? 'none'}`);
  }
  return plan;
};

/** 検索の候補（文字の欄がない。checkbox だけ）。 */
const CHECKBOX_SEARCH = candidateOf(sampleForm({
  formMethod: 'GET',
  page: { origin: SAMPLE_ORIGIN, path: '/members/filter' },
  action: sampleAction('/members/filter'),
  submitterText: '表示',
  fields: [sampleField('active', 'checkbox')],
}));

/** 別の表の書き換え（送信先の `{id}` の前が `/groups`）。 */
const GROUP_UPDATE = candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/groups/7/edit' },
  action: sampleAction('/groups/7'),
  methodOverride: 'PATCH',
  submitterText: '更新',
  fields: [sampleField('name'), sampleField('_method', 'hidden', { hasValue: true })],
}));

describe('PL-6b: the shared parts of the automatic drafts', () => {
  it('chooses the record id segments with the core rule (digits and UUIDs, not words such as members)', () => {
    expect(isAutoDraftRecordIdSegment('1001')).toBe(true);
    expect(isAutoDraftRecordIdSegment('0b5c6a3e-6f5d-4bfb-9a3d-2f1d3c4b5a69')).toBe(true);
    expect(isAutoDraftRecordIdSegment('members')).toBe(false);
    expect(isAutoDraftRecordIdSegment('new')).toBe(false);
  });

  it('makes the templates of an update form (the page and the action) and takes the form rows only', () => {
    expect(autoDraftRecordIdTemplatesOf(UPDATE_CANDIDATE)).toMatchObject({ formPathTemplate: '/members/{id}/edit', actionPathTemplate: '/members/{id}', recordId: '1' });
    expect(autoDraftRecordIdTemplatesOf(CREATE_CANDIDATE)).toBeNull();
    expect(formAutoDraftRowsOf([UPDATE_CANDIDATE, READ_CANDIDATE, CREATE_CANDIDATE, UPDATE_CANDIDATE]).map(({ kind, candidate }) => [kind, candidate.page.path]))
      .toEqual([['CREATE', '/members/new'], ['UPDATE', '/members/1/edit']]);
  });

  it('reuses the same definition, stops at the limit, and creates otherwise (the API and the form share the choice)', () => {
    const definitions = [{ readCheckId: 'read-1', revision: 3, targetPagePath: '/a/{id}' }];
    expect(autoDraftDefinitionChoiceOf({ definitions, isSame: ({ targetPagePath }) => targetPagePath === '/a/{id}', maxDefinitions: 5, definition: 'new' }))
      .toEqual({ kind: 'EXISTING', reference: { readCheckId: 'read-1', revision: 3 } });
    expect(autoDraftDefinitionChoiceOf({ definitions, isSame: () => false, maxDefinitions: 1, definition: 'new' })).toEqual({ kind: 'LIMIT_REACHED' });
    expect(autoDraftDefinitionChoiceOf({ definitions, isSame: () => false, maxDefinitions: 5, definition: 'new' })).toEqual({ kind: 'CREATE', definition: 'new' });
    // API の形は同じ部品で選ぶ（型の推しの後）。
    expect(autoDraftReadCheckChoiceOf({ createPagePath: '/admin/members/new', readPagePaths: ['/admin/members/12'], definitions: [], maxDefinitions: 5 }))
      .toMatchObject({ kind: 'CREATE', definition: { targetPagePath: '/admin/members/{id}' } });
  });
});

describe('PL-6b: the automatic draft of a form create', () => {
  it('sends the required fields and the fields that must be sent, and the draft passes the draft check with every side effect unconfirmed', () => {
    expect(formCreateFieldNamesOf(PROFILE_ID, CREATE_CANDIDATE)).toEqual(['name', 'plan']);
    const plan = newOf(planOf([CREATE_CANDIDATE, UPDATE_CANDIDATE, READ_CANDIDATE]).creates[0]);
    expect(plan.draft).toMatchObject({
      profileId: PROFILE_ID,
      candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
      fieldNames: ['name', 'plan'],
      readChecks: [],
      sideEffectConfirmations: Object.fromEntries(SIDE_EFFECT_CONFIRMATIONS.map((item) => [item, false])),
    });
    expect(validateScenarioDraft(plan.draft, CREATE_CANDIDATE, [], CONTEXT).ok).toBe(true);
    expect(plan.textFieldNames).toEqual(['name']);
    expect(plan.gaps).toEqual([]);
  });

  it('adds the first text field when no required field is a text field', () => {
    const optional = candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/notes/new' },
      action: sampleAction('/notes'),
      submitterText: '登録',
      fields: [sampleField('agree', 'checkbox', { required: true }), sampleField('title'), sampleField('memo', 'textarea')],
    }));
    expect(formCreateFieldNamesOf(PROFILE_ID, optional)).toEqual(['agree', 'title']);
  });

  it('takes the record id from the action and the page templates of the update of the same table (two patterns at most)', () => {
    const plan = newOf(planOf([CREATE_CANDIDATE, GROUP_UPDATE, UPDATE_CANDIDATE, READ_CANDIDATE]).creates[0]);
    expect(plan.recordId).toEqual({
      value: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/members/{id}', '/members/{id}/edit'] },
      origin: 'INFERRED',
      ground: 'FORM_RECORD_ID_FROM_UPDATE_CANDIDATE',
    });
    expect(plan.draft['verification']).toEqual({ recordId: plan.recordId?.value, readVerification: null });
  });

  it('chooses the search candidate and its text field for the answer check, as a verification only definition', () => {
    const plan = newOf(planOf([CREATE_CANDIDATE, UPDATE_CANDIDATE, CHECKBOX_SEARCH, READ_CANDIDATE]).creates[0]);
    expect(plan.answerRead?.value.candidate.identityDigest).toBe(READ_CANDIDATE.identityDigest);
    expect(plan.answerRead?.value.parameterName).toBe('q');
    expect(plan.answerRead?.ground).toBe('ANSWER_READ_FROM_SEARCH_CANDIDATE');
    const answerRead = plan.answerRead?.value;
    if (answerRead === undefined) {
      throw new Error('no answer read');
    }
    expect(formAnswerReadDefinitionOf(answerRead))
      .toEqual({ targetIdentityDigest: READ_CANDIDATE.identityDigest, parameters: { q: '' }, expectations: AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS });
    // 照合の専用の印で参照される同じ定義だけを使う（人が作った定義は使わない）。
    const fact = { readCheckId: 'read-1', revision: 2, targetPagePath: null, targetIdentityDigest: READ_CANDIDATE.identityDigest, parameterNames: ['q'] };
    expect(formAnswerReadChoiceOf({ answerRead, definitions: [fact], verificationOnlyReadCheckIds: [], maxDefinitions: 20 })).toMatchObject({ kind: 'CREATE' });
    expect(formAnswerReadChoiceOf({ answerRead, definitions: [fact], verificationOnlyReadCheckIds: ['read-1'], maxDefinitions: 20 }))
      .toEqual({ kind: 'EXISTING', reference: { readCheckId: 'read-1', revision: 2 } });
    // 結び付けと期待（作った値を含む）は、実行のたびに値が変わる文字の欄。変わる欄がなければ結ばない。
    expect(formAnswerReadVerificationOf({ reference: { readCheckId: 'read-1', revision: 2 }, parameterName: 'q', textFieldNames: ['name'], varyingFieldNames: ['plan', 'name'] }))
      .toEqual({
        readCheckId: 'read-1', revision: 2, bindings: [{ parameterName: 'q', fieldName: 'name' }], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }], verificationOnly: true,
      });
    expect(formAnswerReadVerificationOf({ reference: { readCheckId: 'read-1', revision: 2 }, parameterName: 'q', textFieldNames: ['name'], varyingFieldNames: ['plan'] })).toBeNull();
  });

  it('tells the gaps at the time of the draft and still makes what it can', () => {
    expect(FORM_AUTO_DRAFT_GAPS).toEqual(['RECORD_ID_NOT_FOUND', 'ANSWER_READ_NO_CANDIDATE', 'ANSWER_READ_NO_TEXT_FIELD']);
    // OP-G（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.4 の E1。前は、同じ表の更新の候補がないと番号の型は null で、gap に
    // `RECORD_ID_NOT_FOUND` を出していた）: データのないサイトでは、登録の送信先の path の後ろに `{id}` を足した、よくある形を推す（根拠の名前つき）。
    const none = newOf(planOf([CREATE_CANDIDATE]).creates[0]);
    expect(none.gaps).toEqual(['ANSWER_READ_NO_CANDIDATE']);
    expect(none.recordId).toEqual({
      value: { source: 'URL_PATH_PATTERNS', pathPatterns: [`${CREATE_CANDIDATE.action?.path ?? ''}/{id}`] },
      origin: 'INFERRED',
      ground: 'FORM_RECORD_ID_FROM_CREATE_ACTION',
    });
    expect(none.answerRead).toBeNull();
    expect(validateScenarioDraft(none.draft, CREATE_CANDIDATE, [], CONTEXT).ok).toBe(true);
    const noText = newOf(planOf([CREATE_CANDIDATE, UPDATE_CANDIDATE, CHECKBOX_SEARCH]).creates[0]);
    expect(noText.gaps).toEqual(['ANSWER_READ_NO_TEXT_FIELD']);
    expect(noText.answerRead).toBeNull();
  });

  it('makes nothing for an existing scenario of the same candidate or a stale discovery, and does not save the updates', () => {
    const existing = planOf([CREATE_CANDIDATE, UPDATE_CANDIDATE], CONTEXT, [
      { scenarioId: 'scenario-1', kind: 'CREATE', state: 'APPROVED', candidateIdentityDigest: CREATE_CANDIDATE.identityDigest, shapeDigest: null },
    ]);
    expect(existing.creates).toEqual([{ status: 'EXISTING', row: expect.anything(), scenarioId: 'scenario-1' }]);
    // OP-2（D10）: 更新の変える欄は規則 F で決める（計画は保存しない）。
    expect(existing.updates.map(({ status }) => status)).toEqual(['NEW']);
    const stale = planOf([CREATE_CANDIDATE, UPDATE_CANDIDATE], { ...CONTEXT, profileRevisions: { discoveryJob: 1, current: 2 } });
    expect([...stale.creates, ...stale.updates].map((plan) => (plan.status === 'REJECTED' ? plan.reason : plan.status)))
      .toEqual(['SCENARIO_API_DISCOVERY_PROFILE_STALE', 'SCENARIO_API_DISCOVERY_PROFILE_STALE']);
  });

  it('presets the ledger only when exactly one create scenario binds to the action template', () => {
    const recordId = { source: 'URL_PATH_PATTERNS', pathPatterns: ['/members/{id}', '/members/{id}/edit'] } as const;
    const one = formUpdateDraftPresetOf(UPDATE_CANDIDATE, [
      { scenarioId: 'scenario-1', kind: 'CREATE', recordId },
      { scenarioId: 'scenario-2', kind: 'CREATE', recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/groups/{id}'] } },
      { scenarioId: 'scenario-3', kind: 'UPDATE', recordId: null },
    ]);
    expect(one).toMatchObject({ ledger: { value: 'scenario-1', ground: 'SINGLE_BOUND_LEDGER' }, ledgerOptionCount: 1 });
    expect(one.templates?.value).toEqual({ formPathTemplate: '/members/{id}/edit', actionPathTemplate: '/members/{id}' });
    const two = formUpdateDraftPresetOf(UPDATE_CANDIDATE, [{ scenarioId: 'a', kind: 'CREATE', recordId }, { scenarioId: 'b', kind: 'CREATE', recordId }]);
    expect([two.ledger, two.ledgerOptionCount]).toEqual([null, 2]);
  });
});

describe('PL-6b: copying the verification of an update from the ledger (the API and the form)', () => {
  const formLedger = {
    recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/members/{id}'] } as const,
    readVerification: {
      readCheckId: 'read-1', revision: 1, bindings: [{ parameterName: 'q', fieldName: 'name' }],
      expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }], verificationOnly: true,
    } as const,
  };
  const readChecks = [{ readCheckId: 'read-1', revision: 4, targetPagePath: null }, { readCheckId: 'read-page', revision: 2, targetPagePath: '/admin/members/{id}' }];

  it('copies the record id and the answer check of a form ledger, binding them to the changed text field', () => {
    expect(updateVerificationCopyOf({ transport: 'FORM', ledger: formLedger, readChecks, changedFieldNames: ['name'], changedTextFieldNames: ['name'] })).toEqual({
      kind: 'FILLED',
      recordId: formLedger.recordId,
      readVerification: {
        readCheckId: 'read-1', revision: 4, bindings: [{ parameterName: 'q', fieldName: 'name' }],
        expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }], verificationOnly: true,
      },
    });
    expect(updateVerificationCopyOf({ transport: 'FORM', ledger: formLedger, readChecks, changedFieldNames: ['title'], changedTextFieldNames: ['title'] }))
      .toMatchObject({ readVerification: { bindings: [{ parameterName: 'q', fieldName: 'title' }], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'title' }] } });
  });

  it('tells why it cannot copy (no changed field, no answer check, an unusable definition, no changed text field)', () => {
    expect(updateVerificationCopyOf({ transport: 'FORM', ledger: formLedger, readChecks, changedFieldNames: [] })).toEqual({ kind: 'NEEDS_CHANGED_FIELDS' });
    expect(updateVerificationCopyOf({ transport: 'FORM', ledger: { ...formLedger, readVerification: null }, readChecks, changedFieldNames: ['name'], changedTextFieldNames: ['name'] }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'LEDGER_READ_VERIFICATION_MISSING' });
    expect(updateVerificationCopyOf({ transport: 'FORM', ledger: formLedger, readChecks: [], changedFieldNames: ['name'], changedTextFieldNames: ['name'] }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'LEDGER_READ_CHECK_UNUSABLE' });
    expect(updateVerificationCopyOf({ transport: 'FORM', ledger: formLedger, readChecks, changedFieldNames: ['agree'], changedTextFieldNames: [] }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'CHANGED_FIELD_NOT_TEXT' });
  });

  it('copies the {id} template definition of an API ledger without bindings, as MI-7 did', () => {
    const ledger = { recordId: null, readVerification: { readCheckId: 'read-page', revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] } as const };
    expect(updateVerificationCopyOf({ transport: 'API', ledger, readChecks, changedFieldNames: ['name'] })).toEqual({
      kind: 'FILLED',
      recordId: null,
      readVerification: { readCheckId: 'read-page', revision: 2, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }] },
    });
    expect(updateVerificationCopyOf({ transport: 'API', ledger: formLedger, readChecks, changedFieldNames: ['name'] }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'LEDGER_READ_CHECK_UNUSABLE' });
  });
});

// OP-2 の修正の 1 回目（判断 1）: 画面の一覧の行の「メールなどを送ることがある」の印。送る欄（見える欄と、押して見た API の入力の欄）に、メール・電話の欄があるか。
describe('autoDraftScreenMayNotifyOf (OP-2 fix round 1, the decision 1)', () => {
  it('marks a screen with a visible mail or phone field', () => {
    expect(autoDraftScreenMayNotifyOf(CREATE_CANDIDATE)).toBe(true);
    expect(autoDraftScreenMayNotifyOf(candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/members/new' }, action: sampleAction('/members'), submitterText: '登録',
      fields: [sampleField('name', 'text'), sampleField('mobile', 'tel')],
    })))).toBe(true);
  });

  it('does not mark a screen whose mail-like field is hidden, or that has no such field', () => {
    expect(autoDraftScreenMayNotifyOf(candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/members/new' }, action: sampleAction('/members'), submitterText: '登録',
      fields: [sampleField('name', 'text'), sampleField('email', 'email', { hidden: true })],
    })))).toBe(false);
    expect(autoDraftScreenMayNotifyOf(CHECKBOX_SEARCH)).toBe(false);
  });

  it('marks a screen whose API input field has a mail-like name', () => {
    const base = candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/members/new' }, action: sampleAction('/members'), submitterText: '登録', fields: [sampleField('name', 'text')],
    }));
    const probe = { result: 'API_CREATE', inputFields: [{ name: 'contact_email', selector: '#m', type: 'text', marker: null }] };
    expect(autoDraftScreenMayNotifyOf({ ...base, submissionProbe: probe } as unknown as DiscoveryCandidate)).toBe(true);
  });
});

// OP-F（安全のレビューの M-3。設計者の判断（案 b））: 行の「知らせを送ることがある」の 1 行は、登録の画面か、分かっている更新の画面のどちらかが当たれば出す。点検の中の
// 更新の自動の承認は、更新の画面が当たり、チェックしたときの行（チェックで承認した登録の版の画面）にその 1 行が出ていなかったときだけ、しない。
describe('OP-F M-3: the line about notifications covers the update screen', () => {
  const quiet = candidateOf(sampleForm({
    page: { origin: SAMPLE_ORIGIN, path: '/members/new' }, action: sampleAction('/members'), submitterText: '登録', fields: [sampleField('name', 'text')],
  }));
  const noisyUpdate = candidateOf(sampleForm({
    page: { origin: SAMPLE_ORIGIN, path: '/members/1/edit' }, action: sampleAction('/members/1'), submitterText: '更新',
    fields: [sampleField('name', 'text'), sampleField('email', 'email')],
  }));
  const quietUpdate = candidateOf(sampleForm({
    page: { origin: SAMPLE_ORIGIN, path: '/members/1/edit' }, action: sampleAction('/members/1'), submitterText: '更新', fields: [sampleField('name', 'text')],
  }));

  it('shows the line when the create screen or a known update screen may notify', () => {
    expect(writeScreenMayNotifyOf(quiet, [])).toBe(false);
    expect(writeScreenMayNotifyOf(quiet, [quietUpdate])).toBe(false);
    expect(writeScreenMayNotifyOf(quiet, [noisyUpdate])).toBe(true);
    expect(writeScreenMayNotifyOf(CREATE_CANDIDATE, [])).toBe(true);
  });

  it('confirms the update by the check only when the update does not notify or the line was shown when checked', () => {
    expect(updateNotifyConfirmedByCheckOf(writeScreenMayNotifyOf(quiet, []), quietUpdate)).toBe(true);
    expect(updateNotifyConfirmedByCheckOf(writeScreenMayNotifyOf(quiet, []), noisyUpdate)).toBe(false);
    expect(updateNotifyConfirmedByCheckOf(writeScreenMayNotifyOf(CREATE_CANDIDATE, []), noisyUpdate)).toBe(true);
    // チェックのときに、更新の画面も分かっていて行に 1 行が出ていた。
    expect(updateNotifyConfirmedByCheckOf(writeScreenMayNotifyOf(quiet, [noisyUpdate]), noisyUpdate)).toBe(true);
  });
});

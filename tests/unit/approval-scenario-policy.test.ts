// T28a（Task 28 の設計書 3 章、4.1）: シナリオの契約の既定値と閉じた一覧（`scenario-contracts.ts`）と、シナリオの下書きの確かめ
// （`scenario-policy.ts` の `validateScenarioDraft`。純粋な関数）。
// - 候補の分類が CREATE か UPDATE であること。送る欄は候補の送れる欄（`isSendableField`）の中にあり、秘密に見える名前と危険な語に当たらないこと。
// - 照らす READ の定義は、同じプロファイルの、取り消していない、同じ版の定義であること。
// - 上限と期限は既定以下。副作用の確認は閉じた一覧の 4 項目の真偽。拒む理由は閉じた一覧（項目ごと）。
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_DAYS,
  APPROVAL_TTL_DAY_MS,
  APPROVER_LOCAL_OPERATOR,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  EXECUTION_GRANT_TTL_MS,
  MAX_SCENARIO_FIELD_NAMES,
  MAX_SCENARIO_READ_CHECKS,
  REVOCATION_REASONS,
  APPROVAL_RECEIPT_KINDS,
  SCENARIO_KINDS,
  SCENARIO_METHOD_OVERRIDES,
  SCENARIO_STATES,
  SIDE_EFFECT_CONFIRMATIONS,
  UNSPECIFIED_VERIFICATION,
  WRITE_JOB_CONCURRENCY,
} from '../../src/control/approval/scenario-contracts.js';
import {
  SCENARIO_DRAFT_REJECTION_REASONS,
  unconfirmedSideEffectsOf,
  validateScenarioDraft,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import { MAX_CANDIDATE_FIELDS } from '../../src/discovery/candidate-contracts.js';
import { MAX_READ_CHECK_DEFINITIONS_PER_PROFILE } from '../../src/discovery/read-check-contracts.js';
import {
  ALL_CONFIRMED,
  BOUND_CANDIDATE,
  CREATE_CANDIDATE,
  PROFILE_ID,
  READ_CANDIDATE,
  READ_CHECK_FACTS,
  UPDATE_CANDIDATE,
  candidateOf,
  sampleDraft,
} from './approval-samples.js';
import { sampleField, sampleForm } from './discovery-candidate-samples.js';

const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));

const MINUTE_MS = 60_000;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;

describe('scenario contracts and defaults (T28a)', () => {
  it('has the user-approved defaults as named constants', () => {
    expect(APPROVAL_TTL_DAYS).toBe(30);
    expect(DEFAULT_MAX_CREATES_PER_RUN).toBe(1);
    expect(DEFAULT_MAX_CUMULATIVE_CREATES).toBe(20);
    expect(WRITE_JOB_CONCURRENCY).toBe(1);
    expect(EXECUTION_GRANT_TTL_MS).toBe(5 * MINUTE_MS);
    expect(APPROVAL_TTL_DAY_MS).toBe(HOURS_PER_DAY * MINUTES_PER_HOUR * MINUTE_MS);
    expect(APPROVER_LOCAL_OPERATOR).toBe('LOCAL_OPERATOR');
    expect(MAX_SCENARIO_FIELD_NAMES).toBe(MAX_CANDIDATE_FIELDS);
    expect(MAX_SCENARIO_READ_CHECKS).toBe(MAX_READ_CHECK_DEFINITIONS_PER_PROFILE);
  });

  it('has the frozen closed lists (EXPIRED is not stored)', () => {
    expect(SCENARIO_KINDS).toEqual(['CREATE', 'UPDATE']);
    expect(SCENARIO_STATES).toEqual(['DRAFT', 'APPROVED', 'REVOKED']);
    expect(SIDE_EFFECT_CONFIRMATIONS).toEqual([
      'TEST_RECORDS_ONLY',
      'NO_EXTERNAL_NOTIFICATION',
      'NO_PAYMENT_OR_EXTERNAL_SERVICE',
      'NOT_DESTRUCTIVE',
    ]);
    expect(SCENARIO_METHOD_OVERRIDES).toEqual(['PUT', 'PATCH']);
    expect(APPROVAL_RECEIPT_KINDS).toEqual(['APPROVAL', 'REVOCATION']);
    expect(REVOCATION_REASONS).toEqual(['OPERATOR_REQUEST']);
    for (const list of [SCENARIO_KINDS, SCENARIO_STATES, SIDE_EFFECT_CONFIRMATIONS, SCENARIO_METHOD_OVERRIDES, APPROVAL_RECEIPT_KINDS, REVOCATION_REASONS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('has the closed list of the draft rejection reasons', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS).toEqual([
      'SCENARIO_INPUT_INVALID',
      'SCENARIO_CANDIDATE_UNKNOWN',
      'SCENARIO_CANDIDATE_NOT_WRITABLE',
      'SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED',
      'SCENARIO_FIELD_SECRET_LIKE',
      'SCENARIO_FIELD_DANGEROUS_WORD',
      'SCENARIO_FIELD_TYPE_NOT_SENDABLE',
      'SCENARIO_FIELD_NOT_ALLOWED',
      'SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT',
      // T31R2-fix-1 の項目 3: 値を読めず照らせない、秘密に見える名前の欄がある画面（登録と更新）。
      'SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD',
      // T31b: UPDATE の指定（`scenario-update-spec.test.ts`）。
      'SCENARIO_UPDATE_SPEC_MISSING',
      'SCENARIO_UPDATE_SPEC_NOT_ALLOWED',
      'SCENARIO_UPDATE_TARGET_NOT_FOUND',
      'SCENARIO_UPDATE_TARGET_NOT_CREATE',
      'SCENARIO_UPDATE_PATH_MISMATCH',
      'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
      // T31R-fix-1 の I-2: path の型の `{id}` の位置が、台帳の登録の ID の取り方に結び付かない。
      'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID',
      'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD',
      // T31e fix round 1: 状態の語に当たり、秘密に見える名前でもある、値を送る見えない欄。
      'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD',
      'SCENARIO_STATE_FIELD_NOT_CHANGEABLE',
      // T31R-fix-1 の I-1: 危険な語・削除の語に当たる名前の欄は、保つだけ。
      'SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE',
      'SCENARIO_UPDATE_FIELD_ROLE_OVERLAP',
      'SCENARIO_UPDATE_FIELD_ROLE_MISSING',
      'SCENARIO_UPDATE_NO_CHANGED_FIELD',
      'SCENARIO_READ_CHECK_NOT_FOUND',
      'SCENARIO_READ_CHECK_CANCELED',
      'SCENARIO_READ_CHECK_REVISION_MISMATCH',
      // T30a: 検証の指定（2 つの結果の条件の重なり（fix round 1）、照合の READ の結び付けと期待の欄）。
      'SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS',
      'SCENARIO_VERIFICATION_PARAMETER_UNKNOWN',
      'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
      'SCENARIO_LIMIT_ABOVE_DEFAULT',
      'SCENARIO_LIMIT_INCONSISTENT',
      'SCENARIO_TTL_ABOVE_DEFAULT',
      // T37d fix round 1: 照合の READ に、画面の path を読む定義を選んだ。
      'SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET',
      // T38b: API のシナリオの下書き（`scenario-api-draft.test.ts` で確かめる）。
      'SCENARIO_API_CANDIDATE_NOT_API',
      'SCENARIO_API_STATE_KEY',
      'SCENARIO_API_METHOD_OVERRIDE',
      'SCENARIO_API_HEADER_METHOD_OVERRIDE',
      'SCENARIO_API_ORIGIN_NOT_APPROVED',
      'SCENARIO_API_SHAPE_NOT_EXECUTABLE',
      'SCENARIO_API_FIELD_KEY_MISMATCH',
      'SCENARIO_API_FIELD_TYPE_MISMATCH',
      'SCENARIO_API_KEY_NOT_ALLOWED',
      'SCENARIO_API_PAGE_KEY_SECRET_LIKE',
      'SCENARIO_API_FILTER_MISMATCH',
      // T38c: 候補を見つけた発見のジョブのプロファイルの改訂が、今の改訂と違う（`scenario-api-draft.test.ts`）。
      'SCENARIO_API_DISCOVERY_PROFILE_STALE',
      // T38R-fix の I-2（`scenario-api-review-fixes.test.ts`）。
      'SCENARIO_API_PAGE_KEY_NOT_SCALAR',
      'SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE',
      // T40R-fix-B の I-2（`scenario-api-save-checks.test.ts`）。T40R2-fix: ID の型の理由は、注意に下げて一覧から外した。
      'SCENARIO_API_READ_VERIFICATION_NOT_BOUND',
      // T41a（`scenario-api-update-contract.test.ts`）: API の更新のページが決める鍵、台帳の ID と filter の結び付け。
      'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE',
      'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID',
    ]);
    expect(Object.isFrozen(SCENARIO_DRAFT_REJECTION_REASONS)).toBe(true);
  });
});

describe('scenario draft validation (T28a)', () => {
  it('accepts a CREATE draft and returns the frozen content built from the candidate (field names in code unit order)', () => {
    const result = validateScenarioDraft(sampleDraft(), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result).toEqual({
      ok: true,
      content: {
        profileId: PROFILE_ID,
        kind: 'CREATE',
        candidate: { identityDigest: CREATE_CANDIDATE.identityDigest, ruleDigest: CREATE_CANDIDATE.ruleDigest },
        request: {
          formMethod: 'POST',
          methodOverride: null,
          origin: 'http://127.0.0.1:4173',
          path: '/members',
          enctype: 'application/x-www-form-urlencoded',
        },
        fieldNames: ['email', 'name', 'plan'],
        readChecks: [{ readCheckId: 'rc-1', revision: 2 }],
        sideEffectConfirmations: ALL_CONFIRMED,
        limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
        approvalTtlDays: 30,
        // T30a: 下書きに検証の指定がなければ、すべて未指定（形の確かめは `scenario-verification-spec.test.ts`）。
        verification: UNSPECIFIED_VERIFICATION,
        // T31b: CREATE は UPDATE の指定を持たない（UPDATE の指定の確かめは `scenario-update-spec.test.ts`）。
        update: null,
      },
    });
    expect(result.ok && Object.isFrozen(result.content) && Object.isFrozen(result.content.fieldNames)).toBe(true);
  });

  // T31b: UPDATE の下書きは、UPDATE の指定（台帳の参照・path の型・保つ欄）と、変える欄 1 つ以上が要る（意図した変化。前は送る欄なしでも受けた）。
  it('accepts an UPDATE draft (PATCH by _method) with the UPDATE spec, smaller limits, no READ check and unconfirmed side effects', () => {
    const result = validateScenarioDraft(sampleDraft({
      candidateIdentityDigest: UPDATE_CANDIDATE.identityDigest,
      fieldNames: ['name'],
      readChecks: [],
      sideEffectConfirmations: { ...ALL_CONFIRMED, NOT_DESTRUCTIVE: false },
      limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 3 },
      approvalTtlDays: 7,
      update: {
        targetCreateScenarioId: 'scenario-create',
        formPathTemplate: '/members/{id}/edit',
        actionPathTemplate: '/members/{id}',
        keepFieldNames: [],
      },
    }), UPDATE_CANDIDATE, [], { scenarioId: null, scenarios: [{ scenarioId: 'scenario-create', profileId: PROFILE_ID, kind: 'CREATE' }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.kind).toBe('UPDATE');
      expect(result.content.request).toEqual({
        formMethod: 'POST',
        methodOverride: 'PATCH',
        origin: 'http://127.0.0.1:4173',
        path: '/members/1',
        enctype: 'multipart/form-data',
      });
      expect(unconfirmedSideEffectsOf(result.content.sideEffectConfirmations)).toEqual(['NOT_DESTRUCTIVE']);
    }
    expect(unconfirmedSideEffectsOf(ALL_CONFIRMED)).toEqual([]);
  });

  it('sorts the READ check references by id and does not change the input', () => {
    const input = sampleDraft({ readChecks: [{ readCheckId: 'rc-2', revision: 1 }, { readCheckId: 'rc-1', revision: 2 }] });
    const snapshot = structuredClone(input);
    const result = validateScenarioDraft(input, CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok && result.content.readChecks).toEqual([{ readCheckId: 'rc-1', revision: 2 }, { readCheckId: 'rc-2', revision: 1 }]);
    expect(input).toEqual(snapshot);
  });

  it.each([
    ['not an object', null],
    ['an unknown property', sampleDraft({ extra: true })],
    ['a missing property', (({ approvalTtlDays: _omitted, ...rest }) => rest)(sampleDraft())],
    ['a bad profile id', sampleDraft({ profileId: 'Bad Profile' })],
    ['a bad candidate digest', sampleDraft({ candidateIdentityDigest: 'sha256:xyz' })],
    ['a non-string field name', sampleDraft({ fieldNames: ['name', 1] })],
    ['an empty field name', sampleDraft({ fieldNames: [''] })],
    ['a duplicate field name', sampleDraft({ fieldNames: ['name', 'name'] })],
    ['too many field names', sampleDraft({ fieldNames: Array.from({ length: MAX_SCENARIO_FIELD_NAMES + 1 }, (_value, index) => `f${index}`) })],
    ['a bad READ check reference', sampleDraft({ readChecks: [{ readCheckId: 'rc-1' }] })],
    ['a zero READ check revision', sampleDraft({ readChecks: [{ readCheckId: 'rc-1', revision: 0 }] })],
    ['a duplicate READ check', sampleDraft({ readChecks: [{ readCheckId: 'rc-1', revision: 2 }, { readCheckId: 'rc-1', revision: 2 }] })],
    ['too many READ checks', sampleDraft({
      readChecks: Array.from({ length: MAX_SCENARIO_READ_CHECKS + 1 }, (_value, index) => ({ readCheckId: `rc-${index}`, revision: 1 })),
    })],
    ['a missing side effect item', sampleDraft({ sideEffectConfirmations: { ...ALL_CONFIRMED, NOT_DESTRUCTIVE: undefined } })],
    ['an unknown side effect item', sampleDraft({ sideEffectConfirmations: { ...ALL_CONFIRMED, OTHER: true } })],
    ['a non-boolean side effect item', sampleDraft({ sideEffectConfirmations: { ...ALL_CONFIRMED, TEST_RECORDS_ONLY: 'yes' } })],
    ['a zero limit', sampleDraft({ limits: { maxCreatesPerRun: 0, maxCumulativeCreates: 20 } })],
    ['a fractional limit', sampleDraft({ limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 1.5 } })],
    ['an unknown limit', sampleDraft({ limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20, other: 1 } })],
    ['a zero TTL', sampleDraft({ approvalTtlDays: 0 })],
    ['a string TTL', sampleDraft({ approvalTtlDays: '30' })],
  ])('rejects the shape of a draft with %s (SCENARIO_INPUT_INVALID only)', (_label, input) => {
    const result = validateScenarioDraft(input, CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(codesOf(result).length).toBeGreaterThan(0);
    expect(new Set(codesOf(result))).toEqual(new Set(['SCENARIO_INPUT_INVALID']));
  });

  it.each([
    ['no candidate', sampleDraft(), null, 'SCENARIO_CANDIDATE_UNKNOWN'],
    ['another identity digest', sampleDraft({ candidateIdentityDigest: UPDATE_CANDIDATE.identityDigest }), CREATE_CANDIDATE, 'SCENARIO_CANDIDATE_UNKNOWN'],
    ['a READ candidate', sampleDraft({ candidateIdentityDigest: READ_CANDIDATE.identityDigest, fieldNames: ['q'] }), READ_CANDIDATE, 'SCENARIO_CANDIDATE_NOT_WRITABLE'],
    ['a NEEDS_BINDING candidate', sampleDraft({ candidateIdentityDigest: BOUND_CANDIDATE.identityDigest, fieldNames: ['name'] }),
      BOUND_CANDIDATE, 'SCENARIO_CANDIDATE_NOT_WRITABLE'],
    ['a CREATE candidate without a form request', sampleDraft({ fieldNames: ['plan'] }), { ...CREATE_CANDIDATE, action: null }, 'SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED'],
    ['a CREATE candidate with a GET method', sampleDraft({ fieldNames: ['plan'] }), { ...CREATE_CANDIDATE, formMethod: 'GET' as const }, 'SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED'],
    ['a CREATE candidate with a DELETE override', sampleDraft({ fieldNames: ['plan'] }), { ...CREATE_CANDIDATE, methodOverride: 'DELETE' as const }, 'SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED'],
  ])('rejects %s', (_label, input, candidate, code) => {
    expect(codesOf(validateScenarioDraft(input, candidate, READ_CHECK_FACTS))).toEqual([code]);
  });

  it.each([
    ['a secret-like name', 'API-Key', 'SCENARIO_FIELD_SECRET_LIKE'],
    ['a dangerous word', 'delete_flag', 'SCENARIO_FIELD_DANGEROUS_WORD'],
    ['a dangerous word at a camelCase boundary', 'deleteFlag', 'SCENARIO_FIELD_DANGEROUS_WORD'],
    ['a hidden field', 'mode', 'SCENARIO_FIELD_NOT_ALLOWED'],
    ['a readonly field', 'kept', 'SCENARIO_FIELD_NOT_ALLOWED'],
    ['a disabled field', 'locked', 'SCENARIO_FIELD_NOT_ALLOWED'],
    ['an invisible field', 'invisible', 'SCENARIO_FIELD_NOT_ALLOWED'],
    ['a field that the candidate does not have', 'missing', 'SCENARIO_FIELD_NOT_ALLOWED'],
    ['the method override field', '_method', 'SCENARIO_FIELD_NOT_ALLOWED'],
  ])('rejects a field with %s, and names the field', (_label, fieldName, code) => {
    const result = validateScenarioDraft(sampleDraft({ fieldNames: ['name', 'plan', fieldName] }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok ? [] : result.errors.map(({ code: errorCode, fieldName: name }) => [errorCode, name])).toEqual([[code, fieldName]]);
  });

  // DEF-094: 名前が秘密に見えなくても、値を送れない型（password・file）の欄は送る欄にできない（名前の判定と、見える・編集できるの判定の
  // どちらにも当たらない欄）。同じ名前の欄のどれかがその型なら拒む（fail-closed）。名前の判定（秘密・危険な語）が先。
  describe('fields of a type whose value is never sent (DEF-094)', () => {
    const TYPED_CANDIDATE = candidateOf(sampleForm({
      submitterText: '登録',
      fields: [
        sampleField('name'),
        sampleField('nickname', 'password'),
        sampleField('attachment', 'file'),
        sampleField('choice', 'radio'),
        sampleField('choice', 'password'),
        sampleField('password', 'password'),
      ],
    }));
    const typedDraft = (fieldNames: readonly string[]) =>
      sampleDraft({ candidateIdentityDigest: TYPED_CANDIDATE.identityDigest, fieldNames, readChecks: [] });

    it('has a writable sample candidate whose plain field is sendable', () => {
      expect(TYPED_CANDIDATE.classification).toBe('CREATE');
      expect(validateScenarioDraft(typedDraft(['name']), TYPED_CANDIDATE, READ_CHECK_FACTS).ok).toBe(true);
    });

    it.each([
      ['a password field with a plain name', 'nickname'],
      ['a file field', 'attachment'],
      ['a name shared with a password field', 'choice'],
    ])('rejects %s, and names the field', (_label, fieldName) => {
      const result = validateScenarioDraft(typedDraft(['name', fieldName]), TYPED_CANDIDATE, READ_CHECK_FACTS);
      expect(result.ok ? [] : result.errors.map(({ code, fieldName: name }) => [code, name])).toEqual([['SCENARIO_FIELD_TYPE_NOT_SENDABLE', fieldName]]);
    });

    it('checks the name before the type, and does not check the type without a known candidate', () => {
      const result = validateScenarioDraft(typedDraft(['password']), TYPED_CANDIDATE, READ_CHECK_FACTS);
      expect(codesOf(result)).toEqual(['SCENARIO_FIELD_SECRET_LIKE']);
      expect(codesOf(validateScenarioDraft(typedDraft(['nickname', 'attachment']), null, READ_CHECK_FACTS))).toEqual(['SCENARIO_CANDIDATE_UNKNOWN']);
    });
  });

  // T28a fix round 1（発見事項 5）: 欄の名前の危険な語は、発見の分類と同じ語の単位の判定（`fieldNameHasDestructiveWord`）。`include_disabled` は
  // `disable` の語に当たらない（部分一致では当たっていた。意図した変化）。
  it('accepts a field whose name only contains a dangerous word inside another word (include_disabled)', () => {
    const result = validateScenarioDraft(sampleDraft({ fieldNames: ['name', 'plan', 'include_disabled'] }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok && result.content.fieldNames).toEqual(['include_disabled', 'name', 'plan']);
  });

  it('reports one error per field, in the order of the input, and checks only the names (not the candidate fields) without a known candidate', () => {
    const result = validateScenarioDraft(sampleDraft({ fieldNames: ['missing', 'API-Key', 'mode', 'plan'] }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok ? [] : result.errors.map(({ fieldName }) => fieldName)).toEqual(['missing', 'API-Key', 'mode']);
    expect(codesOf(validateScenarioDraft(sampleDraft({ fieldNames: ['API-Key', 'missing'] }), null, READ_CHECK_FACTS)))
      .toEqual(['SCENARIO_CANDIDATE_UNKNOWN', 'SCENARIO_FIELD_SECRET_LIKE']);
  });

  it.each([
    ['an unknown definition', 'rc-unknown', 1, 'SCENARIO_READ_CHECK_NOT_FOUND'],
    ['a definition of another profile', 'rc-other', 1, 'SCENARIO_READ_CHECK_NOT_FOUND'],
    ['a canceled definition', 'rc-canceled', 1, 'SCENARIO_READ_CHECK_CANCELED'],
    ['another revision', 'rc-1', 1, 'SCENARIO_READ_CHECK_REVISION_MISMATCH'],
  ])('rejects a READ check reference to %s, and names it', (_label, readCheckId, revision, code) => {
    const result = validateScenarioDraft(sampleDraft({ readChecks: [{ readCheckId, revision }] }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok ? [] : result.errors.map(({ code: errorCode, readCheckId: id }) => [errorCode, id])).toEqual([[code, readCheckId]]);
  });

  it.each([
    ['a per-run limit above the default', { maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN + 1, maxCumulativeCreates: 20 }, 30,
      ['SCENARIO_LIMIT_ABOVE_DEFAULT']],
    ['a cumulative limit above the default', { maxCreatesPerRun: 1, maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES + 1 }, 30,
      ['SCENARIO_LIMIT_ABOVE_DEFAULT']],
    ['both limits above the default', { maxCreatesPerRun: 2, maxCumulativeCreates: 21 }, 30,
      ['SCENARIO_LIMIT_ABOVE_DEFAULT', 'SCENARIO_LIMIT_ABOVE_DEFAULT']],
    ['a per-run limit above the cumulative limit', { maxCreatesPerRun: 2, maxCumulativeCreates: 1 }, 30,
      ['SCENARIO_LIMIT_ABOVE_DEFAULT', 'SCENARIO_LIMIT_INCONSISTENT']],
    ['a TTL above the default', { maxCreatesPerRun: 1, maxCumulativeCreates: 20 }, APPROVAL_TTL_DAYS + 1, ['SCENARIO_TTL_ABOVE_DEFAULT']],
  ])('rejects %s', (_label, limits, approvalTtlDays, codes) => {
    expect(codesOf(validateScenarioDraft(sampleDraft({ limits, approvalTtlDays }), CREATE_CANDIDATE, READ_CHECK_FACTS))).toEqual(codes);
  });

  it('accepts the limits and the TTL exactly at the defaults and at the minimum', () => {
    for (const [limits, approvalTtlDays] of [
      [{ maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN, maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES }, APPROVAL_TTL_DAYS],
      [{ maxCreatesPerRun: 1, maxCumulativeCreates: 1 }, 1],
    ] as const) {
      expect(validateScenarioDraft(sampleDraft({ limits, approvalTtlDays }), CREATE_CANDIDATE, READ_CHECK_FACTS).ok).toBe(true);
    }
  });

  it('reports the errors in the order of the items (candidate, fields, READ checks, limits, TTL)', () => {
    const result = validateScenarioDraft(sampleDraft({
      fieldNames: ['API-Key'],
      readChecks: [{ readCheckId: 'rc-canceled', revision: 1 }],
      limits: { maxCreatesPerRun: 2, maxCumulativeCreates: 20 },
      approvalTtlDays: 31,
    }), READ_CANDIDATE, READ_CHECK_FACTS);
    expect(codesOf(result)).toEqual([
      'SCENARIO_CANDIDATE_UNKNOWN',
      'SCENARIO_FIELD_SECRET_LIKE',
      'SCENARIO_READ_CHECK_CANCELED',
      'SCENARIO_LIMIT_ABOVE_DEFAULT',
      'SCENARIO_TTL_ABOVE_DEFAULT',
    ]);
  });

  it('never writes a field value into the error details', () => {
    const result = validateScenarioDraft(sampleDraft({ fieldNames: ['API-Key'] }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) {
      expect(Object.isFrozen(result.errors)).toBe(true);
      expect(result.errors.every(({ detail }) => typeof detail === 'string' && detail.length > 0)).toBe(true);
    }
  });
});

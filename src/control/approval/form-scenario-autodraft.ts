// フォームの形の書き込みの手順の下書きを自動で作る決まりの唯一の owner（PL-6b。設計書 `2026-10-26-beaksight-plain-ui-design.md` 8 章、8.1 の「自動で
// 決める項目」。FV-0 の実験の結果）。純粋な部品（管理データ・ファイル・画面に依らない。同じ入力に同じ出力。入力を変えない）。画面のサーバ
// （`apps/local-ui/src/server/scenario-autodraft-functions.ts`）は、これを呼んで、今の保存の口で保存するだけにする。
// - 作る順（`formAutoDraftPlanOf`）: 登録を先に作り、書き換えは保存しない（変える欄は人が必ず選ぶ。API の形と同じ。ユーザーの判断 2026-10-22）。
// - 登録の送る欄（`formCreateFieldNamesOf`）: 必須の欄と、送らないと保存できない欄（既定の値が分からない欄）のうち送れる欄。そこに文字の欄がなければ、最初の
//   送れる文字の欄を足す（答え合わせに作った値を使うため）。選べるかは下書きの確かめの owner（`validateScenarioDraft`）に聞く（判定を書き写さない）。
// - 登録の ID の取り方（`formRecordIdOf`）: 同じ表（送信先の Origin と、`{id}` の前の path が登録の送信先の path）の書き換えの候補から、送信先の型と画面の型の
//   2 つ（ID の区切りの選び方は共通の部品 `autoDraftRecordIdTemplatesOf`。core の `isRecordIdLikePathSegment`）。書き換えの候補がなければ ID なし
//   （`RECORD_ID_NOT_FOUND`。作成の時点で理由を出す）。
// - 答え合わせ（`formAnswerReadOf`）: 発見の検索・一覧の候補（分類 `READ`、同じ Origin）の、送れる文字の欄 1 つを、照合の専用の定義
//   （`formAnswerReadDefinitionOf`。送る値は空、期待は仮の 1 件。単独の READ の作業では読まない）にする。登録の送信先と同じ path の候補を先に選ぶ。結び付けと
//   期待（「作った値を含む」。緩めない）は、入れる値の決まりを付けた後に、実行のたびに値が変わる文字の欄で決める（`formAnswerReadStepOf`）。
// - 決められないときは、下書きの時点で理由（`FORM_AUTO_DRAFT_GAPS`）を返す。作れる所までは作る。
// - 副作用の確認の 4 項目は必ず偽（`UNCONFIRMED_SIDE_EFFECTS`）。上限と期限は契約の既定。
import { isOriginInAllowedOrigins } from '../../crawl/normalize-url.js';
import { externalDeliveryKindsOf } from '../data-rules/external-delivery-words.js';
import type { CandidateFieldType, DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { READ_CANDIDATE_CLASSIFICATION } from '../../discovery/candidate-contracts.js';
import { isSendableReadCheckParameter, type ReadCheckExpectation } from '../../discovery/read-check-contracts.js';
import {
  AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS,
  inferredReadExpectationOf,
  isAutoDraftDiscoveryStale,
  type AutoDraftPlanInput,
  type AutoDraftScenarioFact,
} from './api-scenario-autodraft.js';
import {
  DRAFT_PROBE_LEDGER_SCENARIO_ID,
  DRAFT_PROBE_PATH_TEMPLATE,
  SCENARIO_UPDATE_INPUT_REASONS,
  UNCONFIRMED_SIDE_EFFECTS,
} from './api-scenario-draft.js';
import {
  autoDraftDefinitionChoiceOf,
  autoDraftRecordIdTemplatesOf,
  formAutoDraftRowsOf,
  type AutoDraftDefinitionChoice,
  type AutoDraftDefinitionFact,
  type FormAutoDraftRow,
} from './autodraft-shared.js';
import { draftValueOf, type DraftValue } from './draft-value-origin.js';
import {
  chooseUpdateChangedField,
  updateChangedValueVaries,
  type UpdateChangedFieldGround,
  type UpdateChangedFieldUnavailableReason,
} from './update-changed-field.js';
import {
  APPROVAL_TTL_DAYS,
  CREATE_SCENARIO_KIND,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  FORM_RECORD_ID_SOURCE,
  MAX_FORM_RECORD_ID_PATTERNS,
  RECORD_ID_PLACEHOLDER,
  SCENARIO_API_FIELD_JSON_TYPES,
  UPDATE_SCENARIO_KIND,
  type FormRecordIdSpec,
  type ReadCheckReference,
  type ScenarioKindFact,
  type ScenarioReadVerification,
  type ScenarioVerificationRecordId,
} from './scenario-contracts.js';
import {
  isUpdatePathBoundToLedger,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftError,
  type ScenarioDraftRejectionReason,
} from './scenario-policy.js';

/**
 * 下書きの時点で出す、決められなかった理由（閉じた一覧。画面の文言は `messages.ts` の `LOCAL_UI_AUTO_DRAFT_TEXT.formGaps`）。
 * - `RECORD_ID_NOT_FOUND`: 作ったデータの番号の取り方を決められない（同じ表の書き換えの画面がない。データがまだない、番号が数字・UUID の形でない）。
 *   作ったデータを後で探せず、書き換えは試せない。
 * - `ANSWER_READ_NO_CANDIDATE`: 答え合わせに使える検索・一覧の画面が、操作さがしの結果にない。
 * - `ANSWER_READ_NO_TEXT_FIELD`: 検索・一覧の画面か書き込みの画面に、文字を入れて送れる欄がない。
 */
export const FORM_AUTO_DRAFT_GAPS = Object.freeze(['RECORD_ID_NOT_FOUND', 'ANSWER_READ_NO_CANDIDATE', 'ANSWER_READ_NO_TEXT_FIELD'] as const);
export type FormAutoDraftGap = (typeof FORM_AUTO_DRAFT_GAPS)[number];

/** 答え合わせに使う検索・一覧の候補と、作った値を入れる送る値の名前。 */
export interface FormAnswerRead {
  readonly candidate: DiscoveryCandidate;
  readonly parameterName: string;
}

/** フォームの形の登録の行の計画（作る・既にある・作れない）。 */
export type FormAutoDraftCreatePlan =
  | {
    readonly status: 'NEW';
    readonly row: FormAutoDraftRow;
    /** 保存の口に渡す下書き（今の下書きの確かめを通る形。答え合わせは、入れる値の決まりの後に結ぶので未指定）。 */
    readonly draft: Readonly<Record<string, unknown>>;
    /** 登録の ID の型（決められなければ null）。 */
    readonly recordId: DraftValue<FormRecordIdSpec> | null;
    /** 答え合わせの候補（決められなければ null）。 */
    readonly answerRead: DraftValue<FormAnswerRead> | null;
    /** 答え合わせに結べる、送る文字の欄（欄の順）。 */
    readonly textFieldNames: readonly string[];
    /** 決められなかった理由（一覧の順）。 */
    readonly gaps: readonly FormAutoDraftGap[];
  }
  | { readonly status: 'EXISTING'; readonly row: FormAutoDraftRow; readonly scenarioId: string }
  | { readonly status: 'REJECTED'; readonly row: FormAutoDraftRow; readonly reason: ScenarioDraftRejectionReason };

/**
 * フォームの形の更新の行の計画（変える欄を規則 F で決めた・決められない・既にある・作れない）。OP-2（D10）: 前は変える欄を人が選んだ（`NEEDS_CHANGED_FIELDS`）。
 * 計画は保存しない（画面のサーバが、登録を保存した後に、台帳と型を決めて保存する）。
 */
export type FormAutoDraftUpdatePlan =
  | {
    readonly status: 'NEW';
    readonly row: FormAutoDraftRow;
    readonly changedFieldNames: readonly string[];
    readonly keepFieldNames: readonly string[];
    readonly ground: UpdateChangedFieldGround;
  }
  | { readonly status: 'NO_CHANGED_FIELD'; readonly row: FormAutoDraftRow; readonly reason: UpdateChangedFieldUnavailableReason }
  | { readonly status: 'EXISTING'; readonly row: FormAutoDraftRow; readonly scenarioId: string }
  | { readonly status: 'REJECTED'; readonly row: FormAutoDraftRow; readonly reason: ScenarioDraftRejectionReason };

/** フォームの形の計画（作る順: 登録が先、書き換えが後）。 */
export interface FormAutoDraftPlan {
  readonly creates: readonly FormAutoDraftCreatePlan[];
  readonly updates: readonly FormAutoDraftUpdatePlan[];
}

/** 発見の改訂が古い理由。 */
const STALE_REASON = 'SCENARIO_API_DISCOVERY_PROFILE_STALE' satisfies ScenarioDraftRejectionReason;
/** 見えていて編集できる欄が役割を持たない誤り（OP-2。更新の変える欄の候補を求める）。 */
const UPDATE_FIELD_ROLE_MISSING_REASON = 'SCENARIO_UPDATE_FIELD_ROLE_MISSING' satisfies ScenarioDraftRejectionReason;
/** 送らないと保存できない欄の誤り（既定の値が分からない欄）。 */
const MUST_SEND_REASON = 'SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT' satisfies ScenarioDraftRejectionReason;
/** 文字の値の JSON の型（送る値が文字の欄。欄の型の表は契約の 1 か所 `SCENARIO_API_FIELD_JSON_TYPES`）。 */
const STRING_JSON_TYPE = 'string';
/** path の区切り。 */
const PATH_SEPARATOR = '/';

/**
 * 値を読めない秘密に見える名前の欄など、その画面で書き込みの手順を作れない欄の誤り（欄に結び付くが、候補を作れない理由にする）。作成の画面の候補を作れない
 * 理由（`formCandidateRejectionOf`）と同じ一覧。
 */
export const FORM_UNUSABLE_SCREEN_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD',
  'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD',
  'SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD',
]);

/** 欄の型が、文字の値を送る型か。 */
const isTextFieldType = (type: CandidateFieldType): boolean => (SCENARIO_API_FIELD_JSON_TYPES[type] ?? []).includes(STRING_JSON_TYPE);

/** 候補の、その名前の欄（最初の 1 つ）が文字の欄か。 */
const isTextFieldName = (candidate: DiscoveryCandidate, name: string): boolean => {
  const field = candidate.fields.find((candidateField) => candidateField.name === name);
  return field !== undefined && isTextFieldType(field.type);
};

/**
 * 選べるかを確かめるフォームの形の下書き（送る欄と保つ欄を受け、ほかは既定の値。書き換えの候補では、形だけ正しい書き換えの指定を足す）。作成の画面の欄の
 * 判定と、自動の下書きが共用する。
 */
export const formScenarioProbeDraftOf = (
  profileId: string,
  candidate: DiscoveryCandidate,
  fieldNames: readonly string[],
  keepFieldNames: readonly string[] = [],
): Record<string, unknown> => ({
  profileId,
  candidateIdentityDigest: candidate.identityDigest,
  fieldNames: [...fieldNames],
  readChecks: [],
  sideEffectConfirmations: UNCONFIRMED_SIDE_EFFECTS,
  limits: { maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN, maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES },
  approvalTtlDays: APPROVAL_TTL_DAYS,
  ...(candidate.classification === UPDATE_SCENARIO_KIND
    ? {
      update: {
        targetCreateScenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID,
        formPathTemplate: DRAFT_PROBE_PATH_TEMPLATE,
        actionPathTemplate: DRAFT_PROBE_PATH_TEMPLATE,
        keepFieldNames: [...keepFieldNames],
      },
    }
    : {}),
});

/** 下書きの確かめの誤り（受けるなら空。文脈は事実なし）。 */
const probeErrorsOf = (draft: unknown, candidate: DiscoveryCandidate): readonly ScenarioDraftError[] => {
  const result = validateScenarioDraft(draft, candidate, []);
  return result.ok ? [] : result.errors;
};

/**
 * 候補からフォームの形の書き込みの手順を作れない理由（送る欄なしの下書きの、候補の誤りの最初。作れるなら null）。欄ごとの誤り（送る欄に選ぶべき欄など）と、
 * 書き換えの指定の入力で直せる誤りは数えない。その画面で作れない欄の誤り（`FORM_UNUSABLE_SCREEN_REASONS`）は数える。
 */
export const formCandidateRejectionOf = (profileId: string, candidate: DiscoveryCandidate): ScenarioDraftRejectionReason | null => {
  const errors = probeErrorsOf(formScenarioProbeDraftOf(profileId, candidate, []), candidate);
  return errors.find((error) => FORM_UNUSABLE_SCREEN_REASONS.has(error.code))?.code
    ?? errors.find((error) => error.fieldName === null && error.readCheckId === null && !SCENARIO_UPDATE_INPUT_REASONS.has(error.code))?.code
    ?? null;
};

/** 欄を送る欄に選べるか（その欄だけを送る下書きに、その欄の誤りがない）。 */
const isChoosableFieldName = (profileId: string, candidate: DiscoveryCandidate, name: string): boolean =>
  !probeErrorsOf(formScenarioProbeDraftOf(profileId, candidate, [name]), candidate)
    .some((error) => error.fieldName === name && !FORM_UNUSABLE_SCREEN_REASONS.has(error.code));

/**
 * 登録の送る欄（候補の欄の順。重なりなし）: 必須の欄と、送らないと保存できない欄のうち、送る欄に選べる欄。そこに文字の欄がなければ、最初の選べる文字の欄を
 * 足す。
 */
export const formCreateFieldNamesOf = (profileId: string, candidate: DiscoveryCandidate): readonly string[] => {
  const names = [...new Set(candidate.fields.map(({ name }) => name).filter((name) => name.length > 0))];
  const mustSend = new Set(probeErrorsOf(formScenarioProbeDraftOf(profileId, candidate, []), candidate)
    .flatMap(({ code, fieldName }) => (code === MUST_SEND_REASON && fieldName !== null ? [fieldName] : [])));
  const required = new Set(candidate.fields.filter(({ required: isRequired }) => isRequired).map(({ name }) => name));
  const chosen = names.filter((name) => (required.has(name) || mustSend.has(name)) && isChoosableFieldName(profileId, candidate, name));
  if (chosen.some((name) => isTextFieldName(candidate, name))) {
    return Object.freeze(chosen);
  }
  const text = names.find((name) => !chosen.includes(name) && isTextFieldName(candidate, name) && isChoosableFieldName(profileId, candidate, name));
  return Object.freeze(text === undefined ? chosen : names.filter((name) => chosen.includes(name) || name === text));
};

/** path の末尾の区切りを外した形。 */
const withoutTrailingSeparator = (path: string): string => path.replace(/\/+$/u, '');

/**
 * 登録の ID の型（推測。根拠 `FORM_RECORD_ID_FROM_UPDATE_CANDIDATE`。なければ `FORM_RECORD_ID_FROM_CREATE_ACTION`）: 同じ表の書き換えの候補（送信先が同じ Origin で、送信先の型の `{id}` の前の path が登録の
 * 送信先の path）の、送信先の型と画面の型（同じなら 1 つ。`MAX_FORM_RECORD_ID_PATTERNS` まで）。候補の順で最初の 1 つ。なければ null。
 */
export const formRecordIdOf = (create: DiscoveryCandidate, candidates: readonly DiscoveryCandidate[]): DraftValue<FormRecordIdSpec> | null => {
  const fromUpdate = formRecordIdFromUpdateOf(create, candidates);
  const action = create.action;
  if (fromUpdate !== null || action === null) {
    return fromUpdate;
  }
  // OP-G（設計書 4.1.4 の E1）: 同じ表の更新の候補がない（データのないサイト）ときは、登録の送信先の path の後ろに `{id}` を足した、よくある形を推す。送る中身・
  // 回数・送り先は変えない（変わるのは、送った後の URL から番号を取ることだけ。番号の形でない区切りは取らない `recordIdOfResultUrl`）。送信先が根の path なら推さない。
  const tablePath = withoutTrailingSeparator(action.path);
  if (tablePath.length === 0) {
    return null;
  }
  return draftValueOf(
    Object.freeze({ source: FORM_RECORD_ID_SOURCE, pathPatterns: Object.freeze([`${tablePath}${PATH_SEPARATOR}${RECORD_ID_PLACEHOLDER}`]) }),
    'FORM_RECORD_ID_FROM_CREATE_ACTION',
  );
};

/**
 * 同じ表の更新の候補から推した、登録の ID の型（根拠 `FORM_RECORD_ID_FROM_UPDATE_CANDIDATE`。なければ null）。登録と更新の候補が同じ表かの判定にも使う
 * （OP-G: データのないときの推し `FORM_RECORD_ID_FROM_CREATE_ACTION` は、表の結び付けの判定に使わない）。
 */
export const formRecordIdFromUpdateOf = (create: DiscoveryCandidate, candidates: readonly DiscoveryCandidate[]): DraftValue<FormRecordIdSpec> | null => {
  const action = create.action;
  if (action === null) {
    return null;
  }
  const tablePath = withoutTrailingSeparator(action.path);
  for (const { kind, candidate } of formAutoDraftRowsOf(candidates)) {
    const templates = kind === UPDATE_SCENARIO_KIND ? autoDraftRecordIdTemplatesOf(candidate) : null;
    // Origin の比べ方は URL の意味の owner（`isOriginInAllowedOrigins`。GATE-ARCH04）。
    if (templates === null || candidate.action === null || !isOriginInAllowedOrigins([action.origin], candidate.action.origin)
      || templates.actionPathTemplate.slice(0, templates.actionPathTemplate.indexOf(`${PATH_SEPARATOR}${RECORD_ID_PLACEHOLDER}`)) !== tablePath) {
      continue;
    }
    const pathPatterns = [...new Set([templates.actionPathTemplate, templates.formPathTemplate])].slice(0, MAX_FORM_RECORD_ID_PATTERNS);
    return draftValueOf(Object.freeze({ source: FORM_RECORD_ID_SOURCE, pathPatterns: Object.freeze(pathPatterns) }), 'FORM_RECORD_ID_FROM_UPDATE_CANDIDATE');
  }
  return null;
};

/** 検索・一覧の候補の、作った値を入れられる送る値の名前（送れる文字の欄の最初。なければ null）。 */
const answerParameterOf = (candidate: DiscoveryCandidate): string | null =>
  candidate.fields.find(({ name, type }) => name.length > 0 && isTextFieldType(type) && isSendableReadCheckParameter(candidate, name))?.name ?? null;

/**
 * 答え合わせの候補（推測。根拠 `ANSWER_READ_FROM_SEARCH_CANDIDATE`）と、決められない理由。検索・一覧の候補（分類 `READ`、送信先が登録の送信先と同じ Origin）
 * のうち、送れる文字の欄を持つもの。送信先の path が登録の送信先の path と同じ候補を先に、ほかは候補の順。
 */
export const formAnswerReadOf = (create: DiscoveryCandidate, candidates: readonly DiscoveryCandidate[]): {
  readonly answerRead: DraftValue<FormAnswerRead> | null;
  readonly gap: Extract<FormAutoDraftGap, 'ANSWER_READ_NO_CANDIDATE' | 'ANSWER_READ_NO_TEXT_FIELD'> | null;
} => {
  const origin = create.action?.origin ?? null;
  const reads = candidates.filter((candidate) => candidate.classification === READ_CANDIDATE_CLASSIFICATION && candidate.action !== null
    && origin !== null && isOriginInAllowedOrigins([origin], candidate.action.origin));
  if (reads.length === 0) {
    return { answerRead: null, gap: 'ANSWER_READ_NO_CANDIDATE' };
  }
  const tablePath = create.action === null ? null : withoutTrailingSeparator(create.action.path);
  const ordered = [
    ...reads.filter((candidate) => withoutTrailingSeparator(candidate.action?.path ?? '') === tablePath),
    ...reads.filter((candidate) => withoutTrailingSeparator(candidate.action?.path ?? '') !== tablePath),
  ];
  for (const candidate of ordered) {
    const parameterName = answerParameterOf(candidate);
    if (parameterName !== null) {
      return { answerRead: draftValueOf(Object.freeze({ candidate, parameterName }), 'ANSWER_READ_FROM_SEARCH_CANDIDATE'), gap: null };
    }
  }
  return { answerRead: null, gap: 'ANSWER_READ_NO_TEXT_FIELD' };
};

/** 照合の専用の定義の中身（検索・一覧の候補。作った値を入れる送る値だけを持ち、値は空。期待は仮の 1 件。単独の READ の作業では読まない）。 */
export const formAnswerReadDefinitionOf = (answerRead: FormAnswerRead): {
  readonly targetIdentityDigest: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly expectations: readonly ReadCheckExpectation[];
} => ({
  targetIdentityDigest: answerRead.candidate.identityDigest,
  parameters: { [answerRead.parameterName]: '' },
  expectations: AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS,
});

/**
 * 照合の専用の定義の選び方: 同じ候補で同じ送る値の、照合の専用の印で参照される定義（`verificationOnlyReadCheckIds`）が既にあれば使う（人が作った定義は、
 * 単独の READ の作業から外さないため使わない）。上限なら作らない。
 */
export const formAnswerReadChoiceOf = (input: {
  readonly answerRead: FormAnswerRead;
  readonly definitions: readonly AutoDraftDefinitionFact[];
  readonly verificationOnlyReadCheckIds: readonly string[];
  readonly maxDefinitions: number;
}): AutoDraftDefinitionChoice<ReturnType<typeof formAnswerReadDefinitionOf>> => autoDraftDefinitionChoiceOf({
  definitions: input.definitions,
  isSame: ({ readCheckId, targetIdentityDigest, parameterNames }) => input.verificationOnlyReadCheckIds.includes(readCheckId)
    && targetIdentityDigest === input.answerRead.candidate.identityDigest
    && JSON.stringify(parameterNames ?? []) === JSON.stringify([input.answerRead.parameterName]),
  maxDefinitions: input.maxDefinitions,
  definition: formAnswerReadDefinitionOf(input.answerRead),
});

/**
 * 答え合わせの結び付けと期待（入れる値の決まりを付けた後）: 送る文字の欄のうち、実行のたびに値が変わる最初の欄を、検索の送る値に結び、「作った値を含む」を
 * 期待にする（照合の専用の印つき）。変わる欄がなければ null（理由は `NO_VARYING_FIELD`）。
 */
export const formAnswerReadVerificationOf = (input: {
  readonly reference: ReadCheckReference;
  readonly parameterName: string;
  readonly textFieldNames: readonly string[];
  readonly varyingFieldNames: readonly string[];
}): ScenarioReadVerification | null => {
  const expectation = inferredReadExpectationOf(input.textFieldNames, input.varyingFieldNames);
  return expectation === null
    ? null
    : {
      readCheckId: input.reference.readCheckId,
      revision: input.reference.revision,
      bindings: [{ parameterName: input.parameterName, fieldName: expectation.value.fieldName }],
      expectations: [expectation.value],
      verificationOnly: true,
    };
};

/** 同じ候補のフォームの形のシナリオ（状態によらない。なければ null）。 */
const existingScenarioIdOf = (row: FormAutoDraftRow, scenarios: readonly AutoDraftScenarioFact[]): string | null =>
  scenarios.find((scenario) => scenario.kind === row.kind && scenario.candidateIdentityDigest === row.candidate.identityDigest
    && scenario.shapeDigest === null)?.scenarioId ?? null;

/** 登録の行の計画。 */
const createPlanOf = (input: AutoDraftPlanInput, row: FormAutoDraftRow): FormAutoDraftCreatePlan => {
  const { profileId, context, candidates } = input;
  const { candidate } = row;
  const rejection = formCandidateRejectionOf(profileId, candidate);
  if (rejection !== null) {
    return { status: 'REJECTED', row, reason: rejection };
  }
  const fieldNames = formCreateFieldNamesOf(profileId, candidate);
  const recordId = formRecordIdOf(candidate, candidates);
  const { answerRead, gap } = formAnswerReadOf(candidate, candidates);
  const textFieldNames = fieldNames.filter((name) => isTextFieldName(candidate, name));
  const draft: Readonly<Record<string, unknown>> = {
    ...formScenarioProbeDraftOf(profileId, candidate, fieldNames),
    verification: { recordId: recordId?.value ?? null, readVerification: null },
  };
  const result = validateScenarioDraft(draft, candidate, [], context);
  const [first] = result.ok ? [] : result.errors;
  if (first !== undefined) {
    return { status: 'REJECTED', row, reason: first.code };
  }
  const textGap = answerRead !== null && textFieldNames.length === 0 ? 'ANSWER_READ_NO_TEXT_FIELD' : gap;
  const gaps = FORM_AUTO_DRAFT_GAPS.filter((item) => (item === 'RECORD_ID_NOT_FOUND' ? recordId === null : item === textGap));
  return {
    status: 'NEW',
    row,
    draft,
    recordId,
    answerRead: textFieldNames.length === 0 ? null : answerRead,
    textFieldNames: Object.freeze(textFieldNames),
    gaps: Object.freeze(gaps),
  };
};

/** 見えていて編集できる欄（役割を持たない下書きで `SCENARIO_UPDATE_FIELD_ROLE_MISSING` になる欄。候補の欄の順。重なりなし）。 */
const editableUpdateFieldNamesOf = (profileId: string, candidate: DiscoveryCandidate): readonly string[] => [...new Set(
  probeErrorsOf(formScenarioProbeDraftOf(profileId, candidate, []), candidate)
    .flatMap(({ code, fieldName }) => (code === UPDATE_FIELD_ROLE_MISSING_REASON && fieldName !== null ? [fieldName] : [])),
)];


/** OP-2: 規則 F で決めた、フォームの形の更新の変える欄と保つ欄（選べなければ理由）。 */
export type FormUpdateChangedFieldChoice =
  | {
    readonly kind: 'CHOSEN';
    readonly changedFieldNames: readonly string[];
    readonly keepFieldNames: readonly string[];
    readonly ground: UpdateChangedFieldGround;
  }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: UpdateChangedFieldUnavailableReason };

/**
 * OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D10、規則 F）: フォームの形の更新の画面で、変える欄を 1 つ決める（決まりは
 * `update-changed-field.ts`）。選べる欄は、その欄だけを変える下書きが今の下書きの確かめを通り（ほかの見えていて編集できる欄は保つ欄）、ふつうの文字の欄で、
 * 外部へ届く語でなく、推した規則で値が決まり毎回変わる欄。`create` は登録の画面の候補（分からなければ null）、`ledgerFieldNames` は台帳が送る欄（分からなければ
 * null）。
 */
export const formUpdateChangedFieldOf = (
  profileId: string,
  update: DiscoveryCandidate,
  create: DiscoveryCandidate | null,
  ledgerFieldNames: readonly string[] | null,
): FormUpdateChangedFieldChoice => {
  const editable = editableUpdateFieldNamesOf(profileId, update);
  const facts = editable.map((name) => {
    const keep = editable.filter((other) => other !== name);
    const field = update.fields.find((candidateField) => candidateField.name === name);
    const usable = field !== undefined && isTextFieldType(field.type) && externalDeliveryKindsOf(field).length === 0
      && !probeErrorsOf(formScenarioProbeDraftOf(profileId, update, [name], keep), update).some((error) => !SCENARIO_UPDATE_INPUT_REASONS.has(error.code))
      && updateChangedValueVaries(update, name, keep);
    return {
      name,
      usable,
      sentInLedger: ledgerFieldNames?.includes(name) ?? false,
      onCreateScreen: create?.fields.some((candidateField) => candidateField.name === name) ?? false,
    };
  });
  const choice = chooseUpdateChangedField(facts);
  if (choice.kind === 'UNAVAILABLE') {
    return choice;
  }
  return Object.freeze({
    kind: 'CHOSEN',
    changedFieldNames: Object.freeze([choice.fieldName]),
    keepFieldNames: Object.freeze(editable.filter((name) => name !== choice.fieldName)),
    ground: choice.ground,
  });
};

/** 同じ表の登録の候補（`formRecordIdFromUpdateOf` が、この更新の候補から型を作れる登録）。なければ null。 */
const sameTableCreateOf = (update: DiscoveryCandidate, candidates: readonly DiscoveryCandidate[]): DiscoveryCandidate | null =>
  candidates.find((candidate) => candidate.classification === CREATE_SCENARIO_KIND && formRecordIdFromUpdateOf(candidate, [update]) !== null) ?? null;

/**
 * 更新の行の計画（保存しない。作れない理由は、作成の画面の候補を作れない理由と同じ判定）。OP-2（D10）: 変える欄は規則 F で決める（前は人が選んだ
 * `NEEDS_CHANGED_FIELDS`）。台帳が送る欄は、同じ表の登録の候補の送る欄（登録はまだ保存していないので、作る登録と同じ決まり `formCreateFieldNamesOf`）。
 */
const updatePlanOf = (input: AutoDraftPlanInput, row: FormAutoDraftRow): FormAutoDraftUpdatePlan => {
  const reason = formCandidateRejectionOf(input.profileId, row.candidate);
  if (reason !== null) {
    return { status: 'REJECTED', row, reason };
  }
  const create = sameTableCreateOf(row.candidate, input.candidates);
  const choice = formUpdateChangedFieldOf(input.profileId, row.candidate, create, create === null ? null : formCreateFieldNamesOf(input.profileId, create));
  return choice.kind === 'CHOSEN'
    ? { status: 'NEW', row, changedFieldNames: choice.changedFieldNames, keepFieldNames: choice.keepFieldNames, ground: choice.ground }
    : { status: 'NO_CHANGED_FIELD', row, reason: choice.reason };
};

/**
 * フォームの形の下書きの計画（作る順: 登録が先、書き換えが後）。既にある行は作らない。発見の改訂が古ければ、どの行も作らない
 * （`SCENARIO_API_DISCOVERY_PROFILE_STALE`。API の形と同じ fail-closed）。凍結。
 */
export const formAutoDraftPlanOf = (input: AutoDraftPlanInput): FormAutoDraftPlan => {
  const rows = formAutoDraftRowsOf(input.candidates);
  const stale = isAutoDraftDiscoveryStale(input.context);
  const planOf = <Plan>(kind: string, make: (row: FormAutoDraftRow) => Plan) => rows.filter((row) => row.kind === kind)
    .map((row): Plan | { readonly status: 'EXISTING'; readonly row: FormAutoDraftRow; readonly scenarioId: string } | {
      readonly status: 'REJECTED'; readonly row: FormAutoDraftRow; readonly reason: ScenarioDraftRejectionReason;
    } => {
      const existing = existingScenarioIdOf(row, input.scenarios);
      if (existing !== null) {
        return { status: 'EXISTING', row, scenarioId: existing };
      }
      return stale ? { status: 'REJECTED', row, reason: STALE_REASON } : make(row);
    });
  return Object.freeze({
    creates: Object.freeze(planOf(CREATE_SCENARIO_KIND, (row) => createPlanOf(input, row))) as readonly FormAutoDraftCreatePlan[],
    updates: Object.freeze(planOf(UPDATE_SCENARIO_KIND, (row) => updatePlanOf(input, row))) as readonly FormAutoDraftUpdatePlan[],
  });
};

/** 書き換えの作成の画面で前もって選ぶ値（フォームの形）。 */
export interface FormAutoDraftUpdatePreset {
  /** 台帳（結び付く登録がちょうど 1 つのときだけ。ほかは null）。 */
  readonly ledger: DraftValue<string> | null;
  readonly ledgerOptionCount: number;
  /** 書き換えの画面の型と送信先の型（作れなければ null）。 */
  readonly templates: DraftValue<{ readonly formPathTemplate: string; readonly actionPathTemplate: string }> | null;
}

/**
 * 書き換えの作成の画面で前もって選ぶ値: 型は共通の部品（`autoDraftRecordIdTemplatesOf`）。台帳は、同じプロファイルの登録のシナリオのうち、登録の ID の取り方が
 * 送信先の型に結び付くもの（唯一の判定 `isUpdatePathBoundToLedger`）がちょうど 1 つのとき。
 */
export const formUpdateDraftPresetOf = (
  update: DiscoveryCandidate,
  ledgers: readonly (Pick<ScenarioKindFact, 'scenarioId' | 'kind'> & { readonly recordId: ScenarioVerificationRecordId | null })[],
): FormAutoDraftUpdatePreset => {
  const templates = autoDraftRecordIdTemplatesOf(update);
  const bound = templates === null
    ? []
    : ledgers.filter(({ kind, recordId }) => kind === CREATE_SCENARIO_KIND && isUpdatePathBoundToLedger(templates.actionPathTemplate, recordId));
  const [only] = bound;
  return Object.freeze({
    ledger: bound.length === 1 && only !== undefined ? draftValueOf(only.scenarioId, 'SINGLE_BOUND_LEDGER') : null,
    ledgerOptionCount: bound.length,
    templates: templates === null
      ? null
      : draftValueOf({ formPathTemplate: templates.formPathTemplate, actionPathTemplate: templates.actionPathTemplate }, 'FORM_RECORD_ID_FROM_UPDATE_CANDIDATE'),
  });
};

/** 送る欄のうち、文字の欄（欄の名前の順のまま）。書き換えの検証の指定を台帳から写すときの、変える文字の欄に使う。 */
export const formTextFieldNamesOf = (candidate: DiscoveryCandidate, fieldNames: readonly string[]): readonly string[] =>
  Object.freeze(fieldNames.filter((name) => isTextFieldName(candidate, name)));

// API のシナリオの下書きの入力と案を作る唯一の部品（手を減らす段 2 の設計書 3A.2 の「共通化」。FM2a）。純粋な部品（管理データ・ファイル・画面に
// 依らない。同じ入力に同じ出力。入力を変えない）。作成の画面のサーバ（`apps/local-ui/src/server/scenario-functions.ts`）にあった
// `apiProbeDraftOf`・`apiFormOf`（T38f、T41e、T41e-3）を移した。画面の案と自動の下書き（FM2b）は、この部品を使う。
// - 入力: probe の記録を持つ候補（発見の結果）、発見の Run の情報（下書きの確かめの文脈 `ScenarioDraftContext`。承認したサービスの Origin、発見の時と
//   今のプロファイルの改訂、ほかのシナリオの事実）、既にあるシナリオの一覧（同じプロファイル。台帳の選択肢）。
// - 出力: 下書きの入力（`apiScenarioDraftInputOf`。保存の口と下書きの確かめが受ける形）と、案（`apiScenarioFormOf`。欄に対応する鍵・ページが決める鍵と
//   選べない理由、型の要約の案、filter の名前、台帳の選択肢、更新の画面の型の選択肢、候補を作れない理由）。
// - 選べるか・作れない理由は、下書きの確かめの owner（`validateScenarioDraft`）に、保存と同じ文脈で聞いて決める（判定を書き写さない）。更新の台帳の
//   参照は、確かめのためだけの登録のシナリオの事実（`DRAFT_PROBE_LEDGER_SCENARIO_ID`。この型と同じ送り先の API の登録）で確かめる（本当の台帳の参照は、
//   保存のときに確かめる）。台帳の選択肢は、台帳の結び付きの唯一の判定（`apiUpdateLedgerBindingRejectionOf`）で、画面の型のどれかで結び付くものだけ。
// - 副作用の確認の 4 項目は、必ず偽で作る（設計書 3A 章の共通の決まり。`UNCONFIRMED_SIDE_EFFECTS`）。上限と期限は契約の既定。
// - 案の出どころの印は `draft-value-origin.ts`（印は承認に結ばない）。
import type { DiscoveryCandidate } from '../../discovery/candidate-contracts.js';
import { pagePathTemplateOptionsOf } from '../../discovery/fingerprint.js';
import { submissionProbeKeyFieldsOf, submissionProbeWriteOf, type SubmissionProbeRecord } from '../../discovery/submission-probe-contracts.js';
import type { ApiJsonValueType } from '../../core/api-request-shape.js';
import { API_SCENARIO_TRANSPORT } from '../../core/scenario-transport.js';
import { usableRecordIdOf } from '../actions/action-outcome.js';
import {
  APPROVAL_TTL_DAYS,
  CREATE_SCENARIO_KIND,
  UPDATE_SCENARIO_KIND,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  RECORD_ID_PLACEHOLDER,
  SIDE_EFFECT_CONFIRMATIONS,
  scenarioApiKeyFieldsOfProbe,
  scenarioApiPublicationStateKeysOf,
  type ScenarioApiSpec,
  type ScenarioKind,
  type SideEffectConfirmation,
  type SideEffectConfirmations,
} from './scenario-contracts.js';
import {
  apiRequestTargetOfProbe,
  apiUpdateLedgerBindingRejectionOf,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftError,
  type ScenarioDraftRejectionReason,
} from './scenario-policy.js';

/** 登録・更新のシナリオの種類（CC-106: 種類の一覧の owner の名前つきの定数）。 */
const CREATE_KIND = CREATE_SCENARIO_KIND;
const UPDATE_KIND = UPDATE_SCENARIO_KIND;

/** 副作用の確認（どれも確かめていない。自動の下書きと、選べるかの確かめの下書きに使う）。 */
export const UNCONFIRMED_SIDE_EFFECTS: SideEffectConfirmations = Object.freeze(
  Object.fromEntries(SIDE_EFFECT_CONFIRMATIONS.map((item) => [item, false])) as Record<SideEffectConfirmation, boolean>,
);

/**
 * 選べるかを確かめる更新の下書きの、形だけ正しい値。path の型は、区切りの全体を印にした path（契約の印を使う。書き写さない）。台帳の参照は、シナリオの
 * id の形に合う、確かめのためだけの名前。
 */
export const DRAFT_PROBE_PATH_TEMPLATE = `/${RECORD_ID_PLACEHOLDER}`;
export const DRAFT_PROBE_LEDGER_SCENARIO_ID = 'scenario-form-probe';

/** 更新の下書きで、更新の指定の入力で直せる、欄に結び付かない誤り（候補を作れない理由にしない）。 */
export const SCENARIO_UPDATE_INPUT_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_UPDATE_TARGET_NOT_FOUND',
  'SCENARIO_UPDATE_TARGET_NOT_CREATE',
  'SCENARIO_UPDATE_PATH_MISMATCH',
  'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
  'SCENARIO_UPDATE_NO_CHANGED_FIELD',
]);

/** API の下書きで、フォームの入力で直せる、鍵に結び付かない誤り（候補を作れない理由にしない）。 */
const API_INPUT_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_API_KEY_NOT_ALLOWED',
  'SCENARIO_API_PAGE_KEY_SECRET_LIKE',
  'SCENARIO_API_FILTER_MISMATCH',
  // T38R-fix の I-2: ページが決める鍵の scalar と、登録の ID を読む応答の鍵の秘密に見える名前。
  'SCENARIO_API_PAGE_KEY_NOT_SCALAR',
  'SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE',
  // T41e: 更新の画面の欄として識別できないページが決める鍵と、台帳の ID と filter の結び付き（入力の近くに出す。候補を作れない理由にしない）。
  'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE',
  'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID',
  ...SCENARIO_UPDATE_INPUT_REASONS,
]);
/**
 * ページが決める鍵に選べない理由（秘密に見える名前と、T38R-fix の I-2 の scalar でない鍵）。T41e: 更新の画面の欄として識別できない鍵（更新だけ。ユーザーの
 * 判断 2）。
 */
const PAGE_KEY_REJECTION_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_API_PAGE_KEY_SECRET_LIKE',
  'SCENARIO_API_PAGE_KEY_NOT_SCALAR',
  'SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE',
]);
/** T41e: 台帳の画面の型が候補の画面の path に合わない理由（API の更新の型の選択肢から外す。判定は下書きの確かめの owner）。 */
const TEMPLATE_MISMATCH_REASON = 'SCENARIO_UPDATE_PATH_MISMATCH' satisfies ScenarioDraftRejectionReason;
/** API の型を持たない候補の理由。 */
const NOT_API_REASON = 'SCENARIO_API_CANDIDATE_NOT_API' satisfies ScenarioDraftRejectionReason;

/** ID の区切りの値が、レコードの ID の形か（owner は `src/control/actions/action-outcome.ts`）。 */
export const isUsableRecordIdSegment = (value: string): boolean => usableRecordIdOf(value) !== null;

/** 下書きの入力の選び方（送る鍵、ページが決める鍵、更新の画面の型）。 */
export interface ApiScenarioDraftChoice {
  readonly fieldNames: readonly string[];
  readonly pageKeys: readonly string[];
  readonly formPathTemplate: string;
}

/**
 * API の下書きの入力（送る鍵とページが決める鍵を受け、ほかは既定の値。副作用の確認はすべて偽。更新は型の filter と、確かめのためだけの台帳の参照を足す）。
 */
export const apiScenarioDraftInputOf = (
  profileId: string,
  candidate: DiscoveryCandidate,
  probe: SubmissionProbeRecord,
  choice: ApiScenarioDraftChoice,
): Record<string, unknown> => {
  const kind = submissionProbeWriteOf(probe.result)?.kind ?? null;
  return {
    profileId,
    candidateIdentityDigest: candidate.identityDigest,
    transport: API_SCENARIO_TRANSPORT,
    fieldNames: [...choice.fieldNames],
    readChecks: [],
    sideEffectConfirmations: UNCONFIRMED_SIDE_EFFECTS,
    limits: { maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN, maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES },
    approvalTtlDays: APPROVAL_TTL_DAYS,
    api: {
      shapeDigest: probe.shapeDigest,
      pageKeys: [...choice.pageKeys],
      filterName: kind === UPDATE_KIND ? probe.shape?.filters[0]?.name ?? null : null,
      recordId: null,
      ledger: kind === UPDATE_KIND ? { targetCreateScenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID, formPathTemplate: choice.formPathTemplate } : null,
    },
  };
};

/** 既にあるシナリオ 1 件（同じプロファイル。台帳の選択肢に要るものだけ）。 */
export interface ApiScenarioExistingScenario {
  readonly scenarioId: string;
  /** 今の版のシナリオの種類。 */
  readonly kind: ScenarioKind;
  /** 発見の根拠の画面の path。 */
  readonly pagePath: string;
}

/** 案を作る入力。 */
export interface ApiScenarioFormInput {
  readonly profileId: string;
  readonly candidate: DiscoveryCandidate;
  /** 下書きの確かめの文脈（保存と同じ。発見の Run の情報とほかのシナリオの事実）。 */
  readonly context: ScenarioDraftContext;
  readonly scenarios: readonly ApiScenarioExistingScenario[];
}

/** 欄に対応する鍵 1 つ（probe の案。送るかを利用者が確かめる）。 */
export interface ApiScenarioKeyFieldProposal {
  readonly key: string;
  readonly type: ApiJsonValueType;
  readonly field: ScenarioApiSpec['keyFields'][number]['field'];
  /** T41e: 欄の型（メールアドレスと電話番号の欄は、既定で保つことを近くで知らせる）。 */
  readonly fieldType: ScenarioApiSpec['keyFields'][number]['fieldType'];
  /** その鍵を送れない理由（下書きの確かめの owner の、その鍵の誤り。送れるなら null）。 */
  readonly rejection: ScenarioDraftRejectionReason | null;
}

/** 欄に対応しない鍵 1 つ（ページが決める鍵に選べるか）。 */
export interface ApiScenarioPageKeyProposal {
  readonly key: string;
  readonly type: ApiJsonValueType;
  /** ページが決める鍵に選べない理由（秘密に見える名前など。下書きの確かめの owner の誤り。選べるなら null）。 */
  readonly rejection: ScenarioDraftRejectionReason | null;
}

/** 更新の台帳にできる登録のシナリオ 1 件。 */
export interface ApiScenarioLedgerOption {
  readonly scenarioId: string;
  readonly pagePath: string;
}

/** API の候補の案（probe の型から作る。値は持たない）。 */
export interface ApiScenarioFormProposal {
  /** 候補の行を選んだ型の digest。 */
  readonly shapeDigest: string;
  /** probe の結果のシナリオの種類（登録か更新）。 */
  readonly kind: ScenarioKind | null;
  /**
   * 型の要約の案（欄に対応する鍵をすべて送り、選べるページが決める鍵をすべて許した下書きを、下書きの確かめの owner が作った API の指定）。作れなければ
   * null。
   */
  readonly proposal: ScenarioApiSpec | null;
  readonly keyFields: readonly ApiScenarioKeyFieldProposal[];
  readonly pageKeys: readonly ApiScenarioPageKeyProposal[];
  /** DEF-147: 欄に対応する鍵とページが決める鍵のうち、公開の状態にあたる鍵（判定は契約の 1 か所）。 */
  readonly publicationStateKeys: readonly string[];
  /** 更新の filter の名前の案（型の filter。登録は null）。 */
  readonly filterName: string | null;
  /** 更新の台帳にできる登録のシナリオ（同じ表の API の登録。登録は空）。 */
  readonly ledgerOptions: readonly ApiScenarioLedgerOption[];
  /** 更新の画面の path の型の選択肢（候補の画面の path から作り、保存で拒まれない型だけ。登録は空）。 */
  readonly formPathTemplates: readonly string[];
}

/** 案と、候補を作れない理由。 */
export interface ApiScenarioFormResult {
  /** API の型を持たない候補は null。 */
  readonly form: ApiScenarioFormProposal | null;
  readonly rejection: ScenarioDraftRejectionReason | null;
}

/** probe の型の、欄に対応する鍵（契約の `scenarioApiKeyFieldsOfProbe`。索引の鍵と欄の digest と同じ作り方）と、欄に対応しない鍵。 */
const apiKeysOf = (probe: SubmissionProbeRecord): {
  readonly fielded: ScenarioApiSpec['keyFields'];
  readonly unfielded: readonly { readonly key: string; readonly type: ApiJsonValueType }[];
} => ({
  fielded: scenarioApiKeyFieldsOfProbe(probe),
  unfielded: submissionProbeKeyFieldsOf(probe).flatMap(({ key, type, field }) => (field === null ? [{ key, type }] : [])),
});

/** API の候補の案と、候補を作れない理由（下書きの確かめの owner に、保存と同じ文脈で任せる）。 */
export const apiScenarioFormOf = (input: ApiScenarioFormInput): ApiScenarioFormResult => {
  const { profileId, candidate, context, scenarios } = input;
  const probe = candidate.submissionProbe;
  if (probe === undefined || probe.shapeDigest === null) {
    return { form: null, rejection: NOT_API_REASON };
  }
  // 案の確かめでは、更新の台帳の参照に、確かめのためだけの登録のシナリオの事実を足す（本当の台帳の参照は、保存のときに確かめる）。T41e-3（T41R-fix-B）:
  // 台帳は同じ表の API の登録だけなので、確かめのための事実も、この型と同じ送り先（`apiRequestTargetOfProbe`）を持つ API の登録にする。
  const requestTarget = apiRequestTargetOfProbe(probe, context.approvedServiceOrigins ?? []);
  const probeContext: ScenarioDraftContext = {
    ...context,
    scenarios: [...context.scenarios, { scenarioId: DRAFT_PROBE_LEDGER_SCENARIO_ID, profileId, kind: CREATE_KIND, apiRequest: requestTarget }],
  };
  const errorsOf = (draft: Record<string, unknown>): readonly ScenarioDraftError[] => {
    const result = validateScenarioDraft(draft, candidate, [], probeContext);
    return result.ok ? [] : result.errors;
  };
  const { fielded, unfielded } = apiKeysOf(probe);
  const kind = submissionProbeWriteOf(probe.result)?.kind ?? null;
  const pathTemplates = [...pagePathTemplateOptionsOf(candidate.page.path, isUsableRecordIdSegment)];
  // T41e（T41a の発見事項 3）: API の更新の画面の型は、保存で拒まれない型（`{id}` が最後の ID の区切り）だけを出す（判定は下書きの確かめの owner）。
  const templateDraftOf = (formPathTemplate: string) =>
    apiScenarioDraftInputOf(profileId, candidate, probe, { fieldNames: fielded.map(({ key }) => key), pageKeys: [], formPathTemplate });
  const formPathTemplates = kind === UPDATE_KIND
    ? pathTemplates.filter((template) => !errorsOf(templateDraftOf(template)).some(({ code }) => code === TEMPLATE_MISMATCH_REASON))
    : pathTemplates;
  const choiceOf = (pageKeys: readonly string[]): ApiScenarioDraftChoice => ({
    fieldNames: fielded.map(({ key }) => key),
    pageKeys,
    formPathTemplate: formPathTemplates[0] ?? DRAFT_PROBE_PATH_TEMPLATE,
  });
  const pageKeys = unfielded.map(({ key, type }): ApiScenarioPageKeyProposal => ({
    key,
    type,
    rejection: errorsOf(apiScenarioDraftInputOf(profileId, candidate, probe, choiceOf([key]))).find(({ code }) => PAGE_KEY_REJECTION_REASONS.has(code))?.code
      ?? null,
  }));
  const proposed = validateScenarioDraft(
    apiScenarioDraftInputOf(profileId, candidate, probe, choiceOf(pageKeys.filter(({ rejection }) => rejection === null).map(({ key }) => key))),
    candidate,
    [],
    probeContext,
  );
  const errors = proposed.ok ? [] : proposed.errors;
  const rejection = errors.find((error) => error.fieldName === null && error.readCheckId === null && !API_INPUT_REASONS.has(error.code))?.code ?? null;
  const filterName = kind === UPDATE_KIND ? probe.shape?.filters[0]?.name ?? null : null;
  // T41e-3（T41R-fix-B の申し送り）: 台帳の選択肢は、保存を通る登録のシナリオだけ（台帳の事実と、下書きの確かめと同じ唯一の判定
  // `apiUpdateLedgerBindingRejectionOf`。画面の型のどれかで結び付くもの）。
  const isBoundLedger = (scenarioId: string): boolean => {
    const fact = context.scenarios.find((scenario) => scenario.scenarioId === scenarioId && scenario.profileId === profileId);
    return requestTarget !== null && fact !== undefined && formPathTemplates.some((formPathTemplate) =>
      apiUpdateLedgerBindingRejectionOf({ filterName, formPathTemplate, origin: requestTarget.origin, pathShape: requestTarget.pathShape }, fact) === null);
  };
  return {
    rejection,
    form: {
      shapeDigest: probe.shapeDigest,
      kind,
      proposal: proposed.ok ? structuredClone(proposed.content.api) ?? null : null,
      keyFields: fielded.map(({ key, type, field, fieldType }) => ({
        key, type, field, fieldType, rejection: errors.find((error) => error.fieldName === key)?.code ?? null,
      })),
      pageKeys,
      // DEF-147: 公開の状態にあたる鍵（欄に対応する鍵とページが決める鍵から。判定は契約の 1 か所）。
      publicationStateKeys: [...scenarioApiPublicationStateKeysOf({
        keyFields: fielded,
        pageKeys: unfielded.map(({ key, type }) => ({ key, type })),
      })],
      filterName,
      ledgerOptions: kind === UPDATE_KIND
        ? scenarios
          .filter((scenario) => scenario.kind === CREATE_KIND && isBoundLedger(scenario.scenarioId))
          .map(({ scenarioId, pagePath }) => ({ scenarioId, pagePath }))
        : [],
      formPathTemplates: kind === UPDATE_KIND ? formPathTemplates : [],
    },
  };
};

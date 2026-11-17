/**
 * シナリオの画面の Server Functions（Task 28 の設計書 3 章、4.6、4.7。T28e）。読むだけ（一覧と詳細の値。GET）。
 * - SPEC-4（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.1）: 作成・変更・入れる値の決まり・承認・撤回・書き込みの開始の口は外した。書き込みは、
 *   サイトの画面の一覧のチェック（`write-screen-functions.ts`）だけで決める。
 * - 入力は、サーバで `schemas/control/` のスキーマ（`ui-profile-key`、`ui-scenario-key`）で確かめてから使う（`requestOf`）。
 * - 承認の部品は、画面向けの公開し直し（`src/control/approval-view.ts`）からだけ読む（`src/control/approval/` を直接 import しない。Gate
 *   `local-ui-boundary` の (j)）。実行の許可と予約を変える口は使わない。
 * - 状態の表示: 再承認の判定は `readScenarioApprovalStatus`（判定の owner `approval-validity.ts` を通す）。画面の表示の状態は
 *   `display/scenarios.ts` が理由から選ぶ。使った件数は `readUsedCumulativeWrites`（発行の判定と同じ数え方。数え方の owner は `execution-grant.ts`）。
 * - 返す値は、表示に要るものだけ（入力の値・トークン・hidden の値・選択肢の label は、契約にも写しにもない）。日時は ISO 8601。
 * - 詳細の値: 検証の指定・未指定の項目（`missingVerificationItemsOf`）、書き込みの履歴（`write-results.ts`）、UPDATE の指定と更新の予定のレコード
 *   （`readPlannedUpdateTarget`）、自動の下書きが推した値のまま残る項目と根拠（`autoDraftInferredItemsOf` で求め直す。承認に結ばない）。
 */
import { createServerFn } from '@tanstack/react-start';
import {
  CREATE_SCENARIO_KIND,
  UPDATE_SCENARIO_KIND,
  FORM_SCENARIO_TRANSPORT,
  apiScenarioFormOf,
  autoDraftInferredItemsOf,
  API_SCENARIO_TRANSPORT,
  readScenarioDraftContext,
  scenarioApiPublicationStateKeysOf,
  listScenarios,
  missingVerificationItemsOf,
  requiredVerificationItemsOf,
  readPlannedUpdateTarget,
  readScenario,
  readScenarioApprovalStatus,
  readScenarioRevisions,
  readUsedCumulativeWrites,
  scenarioTransportOf,
  type ApprovalExternalFacts,
  type ApprovalInvalidityReason,
  type AutoDraftInferredItem,
  type InputRuleReference,
  type ReadCheckReference,
  type ScenarioApiSpec,
  type ScenarioApprovalStatus,
  type ScenarioDraftContext,
  type ScenarioTransport,
  type ScenarioKind,
  type ScenarioLimits,
  type ScenarioRequestShape,
  type ScenarioState,
  type ScenarioVerification,
  type ScenarioVerificationItem,
  type ScenarioView,
  type SideEffectConfirmations,
} from '../../../../src/control/approval-view.js';
import type { CandidateFieldTag, CandidateFieldType, CandidateKind, DiscoveryCandidate } from '../../../../src/control/discovery-view.js';
import { PRE_APPROVAL_EVALUATION_PREMISE, defaultRangeFieldNamesOf, planRuleSet, varyingFieldNamesOf } from '../../../../src/control/data-rules-view.js';
import { listReadChecks } from '../../../../src/control/job/read-check-store.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../src/control/store/profile-records.js';
import { usesScenarios } from '../display/labels';
import { scenarioDisplayStateOf, shownInvalidityReasonsOf, type ScenarioDisplayState } from '../display/scenarios';
import type { InputRuleState } from '../display/data-rules';
import { dataRuleFactsOf } from './data-rule-facts';
import { localUiStore } from './control-store';
import {
  candidateFieldViewOf,
  discoveryProfileViewOf,
  mergedCandidatesOf,
  readDiscoveryDocuments,
  showsOriginsOf,
  type CandidateFieldConstraintView,
  type DiscoveryProfileView,
} from './discovery-documents';
import { approvalExternalFactsOf } from './scenario-facts';
import { readCheckPagePathsOf } from './read-check-page-context';
import { readProfileStart } from './start-check-inputs';
import { requestOf } from './request-validation';
import { isoTimestampOf } from './timestamps';
import { writeResultSummariesOfScenario, type WriteResultSummaryView } from './write-results';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 承認の状態（管理データの外の事実を求められなければ、画面は null を受ける）。 */
export interface ScenarioStatusView {
  readonly displayState: ScenarioDisplayState;
  /** 再承認が要る理由（未承認の理由を除く。判定の順）。 */
  readonly reasons: readonly ApprovalInvalidityReason[];
  /** 今の版と今の事実から求めた承認の digest（承認の操作は、この値を送り返す）。 */
  readonly approvalDigest: string;
  // LZ-3c: 承認の期限（前は `expiresAt`）は返さない（承認は期限で切れない。L12b）。
}

/** シナリオの一覧の 1 件。 */
export interface ScenarioSummaryView {
  readonly scenarioId: string;
  readonly revision: number;
  readonly state: ScenarioState;
  readonly kind: ScenarioKind;
  readonly pageOrigin: string;
  readonly pagePath: string;
  readonly actionOrigin: string;
  readonly actionPath: string;
  readonly status: ScenarioStatusView | null;
  readonly limits: ScenarioLimits;
  /** 累積の使った件数（`readUsedCumulativeWrites`。発行の判定と同じ数え方。T28R-fix-1 の M-6）。 */
  readonly used: number;
  readonly updatedAt: string;
  /** 入力の規則の状態（T29e。未設定・すべて決まった・不足あり）。 */
  readonly inputRuleState: InputRuleState;
}

/** シナリオの画面のプロファイルの要点と、使えるか。 */
interface ScenarioProfileFrameView {
  readonly profile: DiscoveryProfileView;
  /** シナリオを使うプロファイルか（`usesScenarios`）。 */
  readonly eligible: boolean;
  /** 作り・変え・承認できるか（使うプロファイルで、取り消していない）。 */
  readonly editable: boolean;
  readonly showOrigins: boolean;
}

/** シナリオの一覧の画面の値。 */
export interface ScenarioListPageView extends ScenarioProfileFrameView {
  /** 承認の状態を求められたか（管理データの外の事実）。 */
  readonly factsAvailable: boolean;
  readonly scenarios: readonly ScenarioSummaryView[];
}

/** T31h-1: シナリオの UPDATE の指定（保存した内容のうち、表示に要るもの）。 */
export interface ScenarioUpdateView {
  readonly targetCreateScenarioId: string;
  readonly formPathTemplate: string;
  readonly actionPathTemplate: string;
  readonly keepFieldNames: readonly string[];
}

/** 発見の根拠の写しの欄（名前のある欄だけ。値と選択肢と label は持たない）。 */
export interface ScenarioEvidenceFieldView {
  readonly name: string;
  readonly tag: CandidateFieldTag;
  readonly type: CandidateFieldType;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly constraints: readonly CandidateFieldConstraintView[];
}

/** 発見の根拠の写し（シナリオの今の版のもの）。 */
export interface ScenarioEvidenceView {
  readonly kind: CandidateKind;
  readonly pageOrigin: string;
  readonly pagePath: string;
  readonly queryNames: readonly string[];
  readonly submitterWords: readonly string[];
  readonly fields: readonly ScenarioEvidenceFieldView[];
  readonly discoveryJobId: string;
}

/** シナリオの今の版の内容。 */
export interface ScenarioContentView {
  readonly scenarioId: string;
  readonly revision: number;
  readonly state: ScenarioState;
  readonly kind: ScenarioKind;
  readonly candidateIdentityDigest: string;
  /** form の要求の形（T38b: API のシナリオは null。API の要求の型は `api`）。 */
  readonly request: ScenarioRequestShape | null;
  /** T38c: 送り方。 */
  readonly transport: ScenarioTransport;
  /** T38c: API の指定（要求の型、鍵と欄、ページが決める鍵、ヘッダの名前、filter の名前。値は持たない）。FORM のシナリオは null。 */
  readonly api: ScenarioApiSpec | null;
  /** DEF-147: API の指定の鍵のうち、公開の状態にあたる鍵（承認の画面の注意の印。FORM のシナリオは空）。 */
  readonly apiPublicationStateKeys: readonly string[];
  readonly fieldNames: readonly string[];
  readonly readChecks: readonly ReadCheckReference[];
  readonly sideEffectConfirmations: SideEffectConfirmations;
  readonly limits: ScenarioLimits;
  readonly approvalTtlDays: number;
  readonly inputRuleReference: InputRuleReference | null;
  /** 検証の指定（T30g。項目ごとに、未指定なら null）。 */
  readonly verification: ScenarioVerification;
  /** T31h-1: UPDATE の指定（CREATE と、UPDATE の指定の前に保存した UPDATE の版は null）。 */
  readonly update: ScenarioUpdateView | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * シナリオの詳細の画面の値（読むだけ）。SPEC-4: 承認と撤回を外したので、承認の履歴・版の履歴・差分・使った件数・確かめていない副作用の値は返さない。
 */
export interface ScenarioDetailPageView extends ScenarioProfileFrameView {
  readonly scenario: ScenarioContentView;
  readonly evidence: ScenarioEvidenceView;
  readonly status: ScenarioStatusView | null;
  /** 入力の規則の状態（T29e。未設定・すべて決まった・不足あり）。 */
  readonly inputRuleState: InputRuleState;
  /** 検証の指定の未指定の項目（T30g。空でなければ、実行の許可を出さない。`VERIFICATION_SPEC_MISSING`）。 */
  readonly missingVerification: readonly ScenarioVerificationItem[];
  /** T40a-fix: 検証の指定で求める項目（画面に出す項目。FORM はすべて、API は ID の取り方と照合の READ だけ。`requiredVerificationItemsOf`）。 */
  readonly verificationItems: readonly ScenarioVerificationItem[];
  /** 書き込みの履歴（T30g。新しい順）。 */
  readonly writes: readonly WriteResultSummaryView[];
  /** T31h-1: 台帳のシナリオ（UPDATE の指定がなければ null。台帳のシナリオが読めなければ、画面の path は null）。 */
  readonly updateLedger: { readonly scenarioId: string; readonly pagePath: string | null } | null;
  /** T31h-1: 更新の予定のレコードの ID（`readPlannedUpdateTarget`。UPDATE でないか、対象にできるレコードがなければ null）。 */
  readonly plannedUpdateTarget: string | null;
  /**
   * FM2b（手を減らす段 2 の設計書 3A.2）: 自動の下書きが推した値のまま残る項目と根拠（API の登録だけ。表示のときに、同じ部品
   * `autoDraftInferredItemsOf` で求め直す。承認に結ばない）。
   */
  readonly inferredItems: readonly AutoDraftInferredItem[];
  /**
   * PL-5 の 9 の (4)（設計書 8.1）: フォームの登録で、作ったデータの ID の取り方を決められなかったか（書き込みはできる。結果は ID なしの `PARTIAL` で、その
   * 登録のデータは台帳に ID がないので書き換えられない）。
   */
  readonly recordIdUndetermined: boolean;
  /** PL-5 の 9 の (2): 書き換えの答え合わせを、台帳の登録の書き込みの手順から写したか（同じ見るだけの確かめを使う）。中身は画面に出さない。 */
  readonly verificationCopied: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// 値の組み立て
// ---------------------------------------------------------------------------------------------------------------

// シナリオを使えるプロファイルの状態（`ACTIVE_PROFILE_STATUS`）は、owner から読む（FM2R の Minor 13）。

/** プロファイルの要点と、使えるか。 */
const frameOf = (stored: StoredProfile): ScenarioProfileFrameView => {
  const eligible = usesScenarios(stored.profile.mode, stored.profile.auth);
  return {
    profile: discoveryProfileViewOf(stored),
    eligible,
    editable: eligible && stored.status === ACTIVE_PROFILE_STATUS,
    showOrigins: showsOriginsOf(stored),
  };
};

/** 欄の要点（値と選択肢は持たない）。 */
const evidenceFieldOf = (candidate: DiscoveryCandidate, field: DiscoveryCandidate['fields'][number]): ScenarioEvidenceFieldView => {
  const view = candidateFieldViewOf(candidate, field);
  return {
    name: view.name,
    tag: view.tag,
    type: view.type,
    required: view.required,
    readonly: view.readonly,
    disabled: view.disabled,
    hidden: view.hidden,
    constraints: view.constraints,
  };
};

/**
 * FM2R の Minor 11: API の更新の画面の型の選択肢（自動の下書きと同じ案の部品 `apiScenarioFormOf`。ここは、管理データから既にあるシナリオの一覧を読んで渡す
 * だけ）。案を作れなければ空。
 */
const apiFormPathTemplatesOf = (profileId: string, candidate: DiscoveryCandidate, context: ScenarioDraftContext): readonly string[] => {
  const { form } = apiScenarioFormOf({
    profileId,
    candidate,
    context,
    // MI-7（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6）: 更新の照合の READ を台帳から埋めるために、台帳の今の版の照合の READ と、
    // 取り消していない READ の確かめの定義を渡す（使えるかの判定は案の部品）。
    scenarios: listScenarios(localUiStore(), profileId).map((scenario) => ({
      scenarioId: scenario.scenarioId,
      kind: scenario.current.kind,
      pagePath: scenario.evidence.page.path,
      readVerification: scenario.current.verification.readVerification,
    })),
    readChecks: listReadChecks(localUiStore(), profileId)
      .map(({ readCheckId, revision, definition }) => ({ readCheckId, revision, targetPagePath: definition.targetPagePath ?? null })),
  });
  return form?.formPathTemplates ?? [];
};

/** 承認の状態の表示の値。 */
const statusViewOf = (status: ScenarioApprovalStatus): ScenarioStatusView => ({
  displayState: scenarioDisplayStateOf(status.validity),
  reasons: [...shownInvalidityReasonsOf(status.validity)],
  approvalDigest: status.approvalDigest,
});

/** 累積の使った件数。 */
// T28R-fix-1（独立レビュー T28R の M-6）: 発行の判定と同じ数え方（`execution-grant.ts` の `usedCumulativeWrites` と `expiredOpenGrantIdsOf`。期限切れで
// まだ無効にしていない許可の予約は数えない）。数え方は書き写さず、保存の部品の読み出しを使う。
const usedOf = (scenarioId: string): number => readUsedCumulativeWrites(localUiStore(), scenarioId, new Date());

/** 承認の状態（管理データの外の事実がなければ null）。 */
const scenarioStatusOf = (scenarioId: string, external: ApprovalExternalFacts | null): ScenarioStatusView | null => {
  if (external === null) {
    return null;
  }
  const status = readScenarioApprovalStatus(localUiStore(), scenarioId, external, new Date());
  return status === null ? null : statusViewOf(status);
};

/** 一覧の 1 件。 */
const summaryOf = (scenario: ScenarioView, external: ApprovalExternalFacts | null): ScenarioSummaryView => {
  const { current } = scenario;
  return {
    scenarioId: scenario.scenarioId,
    revision: scenario.revision,
    state: scenario.state,
    kind: current.kind,
    pageOrigin: scenario.evidence.page.origin,
    pagePath: scenario.evidence.page.path,
    // T38b: API のシナリオは、送り先を API の要求の型（Origin と path の型）から示す。
    actionOrigin: current.request?.origin ?? current.api?.request.origin ?? '',
    actionPath: current.request?.path ?? current.api?.request.pathShape ?? '',
    status: scenarioStatusOf(scenario.scenarioId, external),
    limits: { ...current.limits },
    used: usedOf(scenario.scenarioId),
    updatedAt: isoTimestampOf(scenario.updatedAt),
    inputRuleState: dataRuleFactsOf(scenario).state,
  };
};

/** 詳細の画面の値。 */
const detailOf = async (scenario: ScenarioView, stored: StoredProfile): Promise<ScenarioDetailPageView> => {
  const external = await approvalExternalFactsOf(stored);
  const { current, evidence } = scenario;
  const status = scenarioStatusOf(scenario.scenarioId, external);
  const missingVerification = missingVerificationItemsOf(current.verification, current);
  return {
    ...frameOf(stored),
    scenario: {
      scenarioId: scenario.scenarioId,
      revision: scenario.revision,
      state: scenario.state,
      kind: current.kind,
      candidateIdentityDigest: current.candidate.identityDigest,
      request: current.request === null ? null : { ...current.request },
      transport: scenarioTransportOf(current),
      api: current.api === undefined ? null : structuredClone(current.api) as ScenarioApiSpec,
      apiPublicationStateKeys: current.api === undefined ? [] : [...scenarioApiPublicationStateKeysOf(current.api)],
      fieldNames: [...current.fieldNames],
      readChecks: current.readChecks.map(({ readCheckId, revision }) => ({ readCheckId, revision })),
      sideEffectConfirmations: { ...current.sideEffectConfirmations },
      limits: { ...current.limits },
      approvalTtlDays: current.approvalTtlDays,
      inputRuleReference: current.inputRuleReference === null ? null : { ...current.inputRuleReference },
      verification: structuredClone(current.verification) as ScenarioVerification,
      update: updateViewOf(scenario),
      createdAt: isoTimestampOf(scenario.createdAt),
      updatedAt: isoTimestampOf(scenario.updatedAt),
    },
    evidence: {
      kind: evidence.kind,
      pageOrigin: evidence.page.origin,
      pagePath: evidence.page.path,
      queryNames: evidence.action === null ? [] : [...evidence.action.queryNames],
      submitterWords: [...evidence.submitterWords],
      fields: evidence.fields.filter((field) => field.name.length > 0).map((field) => evidenceFieldOf(evidence, field)),
      discoveryJobId: scenario.discoveryJobId,
    },
    status,
    inputRuleState: dataRuleFactsOf(scenario).state,
    // T40a-fix: 求める項目は送り方で決まる（API は照合の READ と ID の取り方だけ。同じ判定を発行の口も使う）。
    missingVerification: [...missingVerification],
    verificationItems: [...requiredVerificationItemsOf(current)],
    writes: await writeResultSummariesOfScenario(scenario.scenarioId),
    updateLedger: updateLedgerOf(scenario),
    plannedUpdateTarget: current.kind === UPDATE_KIND ? readPlannedUpdateTarget(localUiStore(), scenario.scenarioId) : null,
    inferredItems: await inferredItemsOf(scenario, stored),
    recordIdUndetermined: scenarioTransportOf(current) === FORM_SCENARIO_TRANSPORT && current.kind === CREATE_KIND && current.verification.recordId === null,
    verificationCopied: verificationCopiedOf(scenario),
  };
};

/** PL-5 の 9 の (2): 書き換えの答え合わせが、台帳の登録の書き込みの手順と同じ見るだけの確かめを使うか（写した結果。写し方は `update-verification-copy.ts`）。 */
const verificationCopiedOf = (scenario: ScenarioView): boolean => {
  const { current } = scenario;
  const ledgerId = current.update?.targetCreateScenarioId ?? current.api?.ledger?.targetCreateScenarioId ?? null;
  const own = current.verification.readVerification;
  if (current.kind !== UPDATE_KIND || ledgerId === null || own === null) {
    return false;
  }
  const ledger = readScenario(localUiStore(), ledgerId)?.current.verification.readVerification ?? null;
  return ledger !== null && ledger.readCheckId === own.readCheckId;
};

/**
 * FM2b: 自動の下書きが推した値のまま残る項目（API の登録だけ）。最後の発見の候補と読めた画面の path、照合の READ の定義の画面の path、入力の規則の
 * 実行のたびに変わる欄を集め、同じ部品で求め直す。どれかを読めなければ、その項目は出ない（推測の印を多く出す側に倒さない。表示だけ）。
 */
const inferredItemsOf = async (scenario: ScenarioView, stored: StoredProfile): Promise<readonly AutoDraftInferredItem[]> => {
  const { current, evidence } = scenario;
  if (scenarioTransportOf(current) !== API_SCENARIO_TRANSPORT) {
    return [];
  }
  const { profileId } = scenario;
  const { latest } = await readDiscoveryDocuments(profileId);
  const reading = await readProfileStart(profileId);
  const readCheckId = current.verification.readVerification?.readCheckId ?? null;
  const definition = readCheckId === null ? undefined : listReadChecks(localUiStore(), profileId).find((view) => view.readCheckId === readCheckId);
  const { saved } = dataRuleFactsOf(scenario);
  let varyingFieldNames: readonly string[] = [];
  let defaultRangeFieldNames: readonly string[] = [];
  try {
    // MI-C（MI-6 の報告の片付け）: シナリオの詳細は承認の前の画面なので、入力の規則の判定（`data-rule-facts.ts`）と同じ前提（一覧のチェックで副作用を
    // 確認する `PRE_APPROVAL_EVALUATION_PREMISE`）で求め直す（確認のない版でも、メールの欄を変わる欄に数える。自動の下書きの推しと同じ判定）。
    varyingFieldNames = saved === null
      ? []
      : varyingFieldNamesOf(planRuleSet(saved, current, evidence, undefined, PRE_APPROVAL_EVALUATION_PREMISE));
    // FM2R の Minor 11: 範囲の既定の幅を入れた欄（判定は規則の部品の 1 か所）。
    defaultRangeFieldNames = saved === null ? [] : defaultRangeFieldNamesOf(saved.fieldRules, current, evidence);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
  }
  // FM2R の Minor 11: 更新の画面の型の選択肢（自動の下書きと同じ案の部品。最後の発見の文脈で求め直す）。
  const context = current.kind !== UPDATE_KIND || latest === null ? null : readScenarioDraftContext(localUiStore(), profileId, latest.jobId, scenario.scenarioId);
  const updateFormPathTemplates = context === null ? [] : apiFormPathTemplatesOf(profileId, evidence, context);
  return autoDraftInferredItemsOf({
    scenarioId: scenario.scenarioId,
    scenario: current,
    // FM2R の Minor 9: 自動の下書きの値が、その後に人の手で変わっていないかを、版の写しの履歴で見る。
    history: readScenarioRevisions(localUiStore(), scenario.scenarioId).map((view) => view.scenario),
    evidence,
    candidates: mergedCandidatesOf(latest),
    approvedServiceOrigins: stored.profile.approvedServiceOrigins ?? [],
    // DEF-220: テスト用のサイト自身の API の型の番号は、承認したテストの Origin の一覧で解く。
    approvedTestOrigins: stored.profile.approvedTestOrigins,
    readPagePaths: reading === null ? [] : readCheckPagePathsOf(latest, reading),
    readVerificationPagePath: definition?.definition.targetPagePath ?? null,
    varyingFieldNames,
    updateFormPathTemplates,
    defaultRangeFieldNames,
  });
};

/** 登録・更新のシナリオの種類（T30g、T31h-1。CC-106: 種類の一覧の owner の名前つきの定数）。書き込みのジョブの種類は `write-kinds.ts`（T31h-2）。 */
const CREATE_KIND = CREATE_SCENARIO_KIND;
const UPDATE_KIND = UPDATE_SCENARIO_KIND;


/** T31h-1: シナリオの UPDATE の指定の表示の値（なければ null）。 */
const updateViewOf = (scenario: ScenarioView): ScenarioUpdateView | null => {
  const { update } = scenario.current;
  return update === null
    ? null
    : {
      targetCreateScenarioId: update.targetCreateScenarioId,
      formPathTemplate: update.formPathTemplate,
      actionPathTemplate: update.actionPathTemplate,
      keepFieldNames: [...update.keepFieldNames],
    };
};

/** T31h-1: 台帳のシナリオ（UPDATE の指定がなければ null）。T38f: API の UPDATE は、台帳の参照（`api.ledger`）の登録のシナリオ。 */
const updateLedgerOf = (scenario: ScenarioView): ScenarioDetailPageView['updateLedger'] => {
  const targetId = scenario.current.update?.targetCreateScenarioId ?? scenario.current.api?.ledger?.targetCreateScenarioId ?? null;
  if (targetId === null) {
    return null;
  }
  const ledger = readScenario(localUiStore(), targetId);
  return { scenarioId: targetId, pagePath: ledger === null ? null : ledger.evidence.page.path };
};

/** シナリオとプロファイル（どちらかがなければ null）。 */
const scenarioWithProfileOf = (scenarioId: string): { readonly scenario: ScenarioView; readonly stored: StoredProfile } | null => {
  const scenario = readScenario(localUiStore(), scenarioId);
  const stored = scenario === null ? null : getProfile(localUiStore(), scenario.profileId);
  return scenario === null || stored === null ? null : { scenario, stored };
};

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface ProfileKeyRequest {
  readonly profileId: string;
}
interface ScenarioKeyRequest {
  readonly scenarioId: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** シナリオの一覧の画面の値（読むだけ）。プロファイルがなければ `null`。 */
export const scenarioListPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<ScenarioListPageView | null> => {
    const stored = getProfile(localUiStore(), data.profileId);
    if (stored === null) {
      return null;
    }
    const external = await approvalExternalFactsOf(stored);
    return {
      ...frameOf(stored),
      factsAvailable: external !== null,
      scenarios: listScenarios(localUiStore(), stored.profile.profileId).map((scenario) => summaryOf(scenario, external)),
    };
  });

/** シナリオの詳細の画面の値（読むだけ）。シナリオがなければ `null`。 */
export const scenarioDetailPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ScenarioKeyRequest>('ui-scenario-key'))
  .handler(async ({ data }): Promise<ScenarioDetailPageView | null> => {
    const found = scenarioWithProfileOf(data.scenarioId);
    return found === null ? null : detailOf(found.scenario, found.stored);
  });


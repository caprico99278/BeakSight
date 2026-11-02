/**
 * シナリオの画面の Server Functions（Task 28 の設計書 3 章、4.6、4.7。T28e）。
 * - 読むだけのもの（一覧・フォーム・詳細の値）は GET。作成・変更・承認・撤回は POST だけ。入力は、サーバで `schemas/control/` のスキーマ
 *   （`ui-profile-key`、`ui-scenario-*`）で確かめてから使う（`requestOf`）。承認と撤回は、画面の確認のダイアログの後にだけ呼ぶ（画面の側）。
 * - 承認の部品は、画面向けの公開し直し（`src/control/approval-view.ts`）からだけ読む（`src/control/approval/` を直接 import しない。Gate
 *   `local-ui-boundary` の (j)）。実行の許可と予約を変える口は使わない（この Task の画面は、書き込みの要求の動線を持たない）。
 * - 作成と変更: 最後の発見のジョブの `discovery.json`（`discovery-documents.ts`）を渡し、`createScenario`・`updateScenario` が、下書きの確かめ
 *   （`validateScenarioDraft`）とプロファイル（取り消し、書き込みのモード）と最後の発見を確かめてから保存する。拒むときは、理由のコードと、項目
 *   （送る欄の名前、照らす READ の定義の ID）ごとの誤りを返す（英語の詳しい文は返さない）。変更の下書きのプロファイルと候補は、シナリオのものを
 *   使う（シナリオは候補を変えない）。
 * - 承認: 画面が出した版と承認の digest を受け、`approveScenario` がサーバで今の事実から求め直して一致しなければ拒む
 *   （`SCENARIO_APPROVAL_DIGEST_MISMATCH`。古い画面のまま承認しない）。管理データの外の事実（認証の設定とターゲットの設定の digest）は
 *   `scenario-facts.ts` で求め、求められなければ `SCENARIO_FACTS_UNAVAILABLE` で拒む。T30R-fix-1（DEF-103）: 撤回と変更が通ったら、そのシナリオの
 *   動いている書き込みのジョブを止める（`stopWriteJobsOfScenario`）。撤回は `revokeScenarioApproval`（消費していない許可を
 *   無効にし、予約を返す）。承認者は保存の部品が `LOCAL_OPERATOR` を記録する。
 * - 状態の表示: 再承認の判定は `readScenarioApprovalStatus`（判定の owner `approval-validity.ts` を通す）。画面の表示の状態は
 *   `display/scenarios.ts` が理由から選ぶ。最後の承認との差分は `approvalDigestDifferencesOf`（承認の digest の項目と同じ並び）。使った件数は
 *   `readUsedCumulativeWrites`（発行の判定と同じ数え方。数え方の owner は `execution-grant.ts`。T28R-fix-1 の M-6）。
 * - 返す値は、表示に要るものだけ（入力の値・トークン・hidden の値・選択肢の label は、契約にも写しにもない。選択肢の値も返さない。値の例は
 *   Task 29）。日時は ISO 8601。
 * - T30g（Task 30 の設計書 3 章の「検証の指定」）: フォームの値に、照合の READ に選べる定義の送る値の名前を足し、詳細の値に、検証の指定・未指定の
 *   項目（`missingVerificationItemsOf`）・書き込みを始められるプロファイルとシナリオか・書き込みの履歴（`write-results.ts`）を足した。検証の指定の
 *   保存は、今のシナリオの保存の口（`validateScenarioDraft` が確かめる）。
 * - T31h-1（Task 31 の設計書 3 章の「UPDATE の指定」）: UPDATE の候補のフォームの値に、台帳にできる登録（CREATE）のシナリオ、候補から作れる path の型の
 *   組（`pathTemplateOptionsOf`。ID の形の判定は `usableRecordIdOf`）、型の印を足し、欄ごとに「役割を決める欄か」と「変える欄に選べない理由」を足した。
 *   どちらも、下書きの確かめの owner（`validateScenarioDraft`）に、形の正しい UPDATE の指定を持った下書きで聞いて決める（判定を書き写さない）。
 *   詳細の値に、UPDATE の指定と、更新の予定のレコード（`readPlannedUpdateTarget`。なければ null）を足した。保存は今の保存の口のまま。
 * - FM2a（手を減らす段 2 の設計書 3A.2 の「共通化」）: API の候補のフォームの値（下書きの入力と案）は、純粋な部品
 *   （`src/control/approval/api-scenario-draft.ts`。自動の下書きと共用）が作る。ここは、管理データから既にあるシナリオの一覧を読んで渡すだけ。
 * - FM2b（同 3A.2。案 2）: 自動の下書きの案内から開いた更新の作成の画面に、前もって選ぶ台帳と更新の画面の型（URL の引数の案。選択肢にあるものだけ）を
 *   返す。詳細の値に、自動の下書きが推した値のまま残る項目と根拠（`autoDraftInferredItemsOf` で求め直す。承認に結ばない）を足す。
 */
import { randomUUID } from 'node:crypto';
import { createServerFn } from '@tanstack/react-start';
import {
  APPROVAL_TTL_DAYS,
  CREATE_SCENARIO_KIND,
  UPDATE_SCENARIO_KIND,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  MIN_APPROVAL_TTL_DAYS,
  MIN_SCENARIO_LIMIT,
  RECORD_ID_PLACEHOLDER,
  SCENARIO_KINDS,
  SIDE_EFFECT_CONFIRMATIONS,
  DRAFT_SCENARIO_STATE,
  FORM_SCENARIO_TRANSPORT,
  FORM_UNUSABLE_SCREEN_REASONS,
  UNCONFIRMED_SIDE_EFFECTS,
  formCandidateRejectionOf,
  formScenarioProbeDraftOf,
  formTextFieldNamesOf,
  isAutoDraftRecordIdSegment,
  updateVerificationCopyOf,
  apiScenarioFormOf,
  apiUpdateDraftPresetOf,
  autoDraftInferredItemsOf,
  API_SCENARIO_TRANSPORT,
  approvalDigestDifferencesOf,
  approveScenario,
  readScenarioDraftContext,
  scenarioApiPublicationStateKeysOf,
  createScenario,
  listScenarios,
  missingVerificationItemsOf,
  requiredVerificationItemsOf,
  readApprovalReceipts,
  isUpdatePathBoundToLedger,
  readPlannedUpdateTarget,
  readScenario,
  readScenarioApprovalStatus,
  readScenarioRevisions,
  readUsedCumulativeWrites,
  revokeScenarioApproval,
  scenarioTransportOf,
  unconfirmedSideEffectsOf,
  updateScenario,
  validateScenarioDraft,
  type ApiScenarioFormProposal,
  type ApiScenarioKeyFieldProposal,
  type ApiScenarioPageKeyProposal,
  type ApprovalDigestDifference,
  type ApprovalExternalFacts,
  type ApprovalInvalidityReason,
  type ApprovalReceipt,
  type ApprovalReceiptKind,
  type AutoDraftInferredItem,
  type DraftValue,
  type DraftValueGround,
  type DraftValueOrigin,
  type InputRuleReference,
  type ReadCheckReference,
  type RevocationReason,
  type ScenarioApiSpec,
  type ScenarioApprovalStatus,
  type ScenarioDraftContext,
  type ScenarioTransport,
  type ScenarioDraftRejectionReason,
  type ScenarioKind,
  type ScenarioLimits,
  type ScenarioRequestShape,
  type ScenarioState,
  type ScenarioStoreRejectionReason,
  type ScenarioStoreResult,
  type ScenarioVerification,
  type ScenarioVerificationItem,
  type ScenarioView,
  type SideEffectConfirmation,
  type SideEffectConfirmations,
} from '../../../../src/control/approval-view.js';
import { PROFILE_ID_PATTERN } from '../../../../src/control/contracts.js';
import { isProfileOperationAllowed } from '../../../../src/control/execution-policy.js';
import {
  isReadCheckPageTemplatePath,
  pathTemplateOptionsOf,
  readCheckTargetKindOf,
  type CandidateFieldTag,
  type CandidateFieldType,
  type CandidateKind,
  type DiscoveryCandidate,
  type FormEnctype,
  type FormMethod,
  type MethodOverride,
  type PathTemplateOption,
} from '../../../../src/control/discovery-view.js';
import { PRE_APPROVAL_EVALUATION_PREMISE, defaultRangeFieldNamesOf, planRuleSet, readLatestRuleSet, varyingFieldNamesOf } from '../../../../src/control/data-rules-view.js';
import { listReadChecks } from '../../../../src/control/job/read-check-store.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { isRecord } from '../../../../src/core/guards.js';
import { recordIdPatternMatchesPagePath } from '../../../../src/core/record-id-path-pattern.js';
import { ACTIVE_PROFILE_STATUS } from '../../../../src/control/store/profile-records.js';
import { usesScenarios } from '../display/labels';
import { scenarioDisplayStateOf, shownInvalidityReasonsOf, type ScenarioDisplayState } from '../display/scenarios';
import type { InputRuleState } from '../display/data-rules';
import { dataRuleFactsOf } from './data-rule-facts';
import { localUiAuditJobs, runningLocalUiAuditJobCount } from './audit-jobs';
import { localUiStore } from './control-store';
import {
  candidateFieldViewOf,
  candidateOfDocument,
  candidateOfDocumentByShape,
  discoveryProfileViewOf,
  mergedCandidatesOf,
  readDiscoveryDocuments,
  showsOriginsOf,
  type CandidateFieldConstraintView,
  type DiscoveryProfileView,
} from './discovery-documents';
import { approvalExternalFactsOf, type ScenarioRequestLocalRejectionReason } from './scenario-facts';
import { readCheckPagePathsOf } from './read-check-page-context';
import { attachInferredRulesOnSave } from './scenario-autodraft-functions';
import { readProfileStart } from './start-check-inputs';
import { requestOf } from './request-validation';
import { isoTimestampOf, nowCompactTimestamp } from './timestamps';
import { writeJobKindOf } from './write-kinds';
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
  /** 承認が有効なら、効く期限（ISO 8601）。 */
  readonly expiresAt: string | null;
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
  /** 最後の承認の記録の期限（ISO 8601。承認の記録がなければ null）。 */
  readonly lastApprovalExpiresAt: string | null;
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

/** フォームの送る欄の 1 件（名前のある欄だけ。同じ名前は最初の 1 つ。値と選択肢と label は持たない）。 */
export interface ScenarioFieldView {
  readonly name: string;
  readonly tag: CandidateFieldTag;
  readonly type: CandidateFieldType;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly constraints: readonly CandidateFieldConstraintView[];
  /**
   * 送る欄に選べない理由（下書きの確かめの owner の、その欄の誤り。選べるなら null）。T31h-1: UPDATE の候補では、変える欄に選べない理由（状態の欄
   * など。役割のない欄は、送る欄の確かめの理由）。
   */
  readonly rejection: ScenarioDraftRejectionReason | null;
  /** T31h-1: UPDATE の候補で、役割（変える・保つ）を決める欄か（見えていて編集できる欄。下書きの確かめの owner が求める欄）。CREATE は false。 */
  readonly roleRequired: boolean;
  /**
   * MI-6（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6）: 必ず送る欄か（CREATE の、既定の値が分からない見えていて編集できる欄。送る欄なしの
   * 下書きで、下書きの確かめの owner が `SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT` を返す欄）。1 つの値しか通らないので、画面は表示だけにする。
   */
  readonly mustSend: boolean;
}

/** T31h-1: 台帳にできる登録（CREATE）のシナリオ 1 件（同じプロファイル）。 */
export interface ScenarioLedgerOptionView {
  readonly scenarioId: string;
  readonly pagePath: string;
  /**
   * T31R-fix-1 の I-2: この台帳の登録の ID の取り方に結び付かない、型の組の選択肢の番号（`templateOptions` の位置。判定は下書きの確かめの owner の
   * `isUpdatePathBoundToLedger`）。台帳の取り方が未指定なら空。
   */
  readonly unboundTemplates: readonly number[];
}

/** T31h-1: UPDATE の候補のフォームの値（台帳の選択肢、候補から作れる path の型の組、型の印）。 */
export interface ScenarioUpdateFormView {
  readonly ledgerOptions: readonly ScenarioLedgerOptionView[];
  readonly templateOptions: readonly PathTemplateOption[];
  /** path の型のレコードの ID の区切りの印（契約の値）。 */
  readonly placeholder: string;
}

/** T31h-1: シナリオの UPDATE の指定（保存した内容のうち、表示に要るもの）。 */
export interface ScenarioUpdateView {
  readonly targetCreateScenarioId: string;
  readonly formPathTemplate: string;
  readonly actionPathTemplate: string;
  readonly keepFieldNames: readonly string[];
}

/** シナリオにする候補（最後の発見のジョブの結果から）。 */
export interface ScenarioCandidateView {
  readonly identityDigest: string;
  readonly kind: CandidateKind;
  /** T31h-1: シナリオの種類（登録か更新。どちらでもなければ null）。 */
  readonly scenarioKind: ScenarioKind | null;
  readonly pageOrigin: string;
  readonly pagePath: string;
  readonly actionOrigin: string | null;
  readonly actionPath: string | null;
  readonly formMethod: FormMethod | null;
  readonly methodOverride: MethodOverride | null;
  readonly enctype: FormEnctype | null;
  readonly submitterWords: readonly string[];
  readonly fields: readonly ScenarioFieldView[];
}

/** フォームの決まり（契約の上限と既定と閉じた一覧）。 */
export interface ScenarioFormRulesView {
  readonly minLimit: number;
  readonly maxCreatesPerRun: number;
  readonly maxCumulativeCreates: number;
  readonly minTtlDays: number;
  readonly maxTtlDays: number;
  readonly sideEffects: readonly SideEffectConfirmation[];
  /**
   * MI-F3（独立レビュー MI-R の Minor 12）: 新しいシナリオの副作用の確認の初めの値（すべて偽。下書きの部品の定数 `UNCONFIRMED_SIDE_EFFECTS`）。作成の画面の
   * ブラウザのコードは承認の部品の値を読まない（`approval-view.ts` の決まり）ので、サーバがこの値を渡す。画面で組み立て直さない。
   */
  readonly unconfirmedSideEffects: SideEffectConfirmations;
}

/** 照らす READ の定義・照合の READ に選べる定義（取り消していないもの。T30g: 今の版の送る値の名前。値は返さない）。 */
export interface ScenarioReadCheckOptionView extends ReadCheckReference {
  readonly parameterNames: readonly string[];
  /** T37d fix round 1: 書き込みの照合の READ に使えるか（候補を読む定義だけ。画面の path を読む定義は使えない）。 */
  readonly verifiable: boolean;
  /**
   * T38f: `{id}` つきの画面の path の定義か（`isReadCheckPageTemplatePath`）。API のシナリオだけ、照合の READ に選べる（結び付けは 0 件。判定は下書きの
   * 確かめ）。
   */
  readonly pageTemplate: boolean;
}

/** T38f: API の候補の、欄に対応する鍵 1 つ（probe の案。送るかを利用者が確かめる）。FM2a: 案の部品（`api-scenario-draft.ts`）の型。 */
export type ScenarioApiKeyFieldView = ApiScenarioKeyFieldProposal;

/** T38f: API の候補の、欄に対応しない鍵 1 つ（ページが決める鍵に選べるか）。FM2a: 案の部品の型。 */
export type ScenarioApiPageKeyView = ApiScenarioPageKeyProposal;

/**
 * T38f: API の候補のフォームの値（probe の型から作る案。値は持たない）。FM2a: 案は、作成の画面と自動の下書きが共用する純粋な部品
 * （`src/control/approval/api-scenario-draft.ts` の `apiScenarioFormOf`）が作る。型の要約の案（`proposal`）は、PL-5 から画面に
 * 出さない（保存の確かめが使う）。公開の状態にあたる鍵（DEF-147）は、UPDATE では既定で保つことを近くで知らせる。
 */
export interface ScenarioApiFormView extends ApiScenarioFormProposal {
  /** T40R-fix-B（CC-103）: 送り方（いつも API。型の要約の部品が、表示のカタログのラベルで出す）。 */
  readonly transport: ScenarioTransport;
  /**
   * FM2b（手を減らす段 2 の設計書 3A.2。案 2）: 自動の下書きの案内から開いた更新の、前もって選ぶ値（URL の引数の案のうち、選択肢にあるものだけ。印は、
   * 同じ部品 `apiUpdateDraftPresetOf` で求め直した値と同じときだけ付ける。承認に結ばない。確かめは今の保存の口）。結び付く台帳の数も返す。登録は null。
   */
  readonly preset: ScenarioApiPresetView | null;
}

/** FM2b: 前もって選ぶ値 1 つ（印は表示だけ）。 */
export interface ScenarioApiPresetValueView {
  readonly value: string;
  readonly origin: DraftValueOrigin | null;
  readonly ground: DraftValueGround | null;
}

/** FM2b: 更新の作成の画面で前もって選ぶ値。 */
export interface ScenarioApiPresetView {
  readonly ledger: ScenarioApiPresetValueView | null;
  readonly formPathTemplate: ScenarioApiPresetValueView | null;
  readonly ledgerOptionCount: number;
}

/** FM2b: 作成の画面の URL の引数の、前もって選ぶ値の案。 */
interface ScenarioFormPresetRequest {
  readonly ledgerScenarioId?: string;
  readonly formPathTemplate?: string;
}

/** 作成と変更のフォームの画面の値。 */
export interface ScenarioFormPageView extends ScenarioProfileFrameView {
  /** 候補（最後の発見のジョブの結果になければ null）。 */
  readonly candidate: ScenarioCandidateView | null;
  /** 候補からシナリオを作れない理由（下書きの確かめの owner の、候補の誤り。作れるなら null）。 */
  readonly candidateRejection: ScenarioDraftRejectionReason | null;
  /** 照らせる READ の確かめの定義（取り消していないもの。ID と今の版と、T30g: 送る値の名前）。 */
  readonly readChecks: readonly ScenarioReadCheckOptionView[];
  readonly rules: ScenarioFormRulesView;
  /** T31h-1: UPDATE の候補のフォームの値（UPDATE の候補でなければ null）。 */
  readonly update: ScenarioUpdateFormView | null;
  /** T38f: API の候補のフォームの値（型の digest で行を選んだときだけ。FORM の候補は null）。 */
  readonly api: ScenarioApiFormView | null;
}

/** 発見の根拠の写しの欄（値と選択肢は持たない）。 */
export type ScenarioEvidenceFieldView = Omit<ScenarioFieldView, 'rejection' | 'roleRequired' | 'mustSend'>;

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

/** 承認と撤回の記録の 1 件。 */
export interface ScenarioHistoryView {
  readonly receiptId: string;
  readonly kind: ApprovalReceiptKind;
  /** 承認・撤回の日時（ISO 8601）。 */
  readonly at: string;
  /** 承認した版（撤回は null）。 */
  readonly scenarioRevision: number | null;
  /** 承認の期限（撤回は null）。 */
  readonly expiresAt: string | null;
  /** 撤回の理由（承認は null）。 */
  readonly reason: RevocationReason | null;
}

/** 版の履歴の 1 件。 */
export interface ScenarioRevisionSummaryView {
  readonly revision: number;
  readonly recordedAt: string;
  readonly fieldNames: readonly string[];
  readonly limits: ScenarioLimits;
  readonly approvalTtlDays: number;
}

/** シナリオの詳細の画面の値。 */
export interface ScenarioDetailPageView extends ScenarioProfileFrameView {
  readonly scenario: ScenarioContentView;
  readonly evidence: ScenarioEvidenceView;
  readonly status: ScenarioStatusView | null;
  /** 副作用の確認のうち、まだ確かめていない項目（空なら、承認の前の確認は済んでいる）。 */
  readonly unconfirmedSideEffects: readonly SideEffectConfirmation[];
  readonly used: number;
  readonly history: readonly ScenarioHistoryView[];
  readonly revisions: readonly ScenarioRevisionSummaryView[];
  /** 最後の承認の版（承認の記録がなければ null）。 */
  readonly lastApprovalRevision: number | null;
  /** 最後の承認との差分（承認の記録がないか、管理データの外の事実を求められなければ null）。 */
  readonly differences: readonly ApprovalDigestDifference[] | null;
  /** 入力の規則の状態（T29e。未設定・すべて決まった・不足あり）。 */
  readonly inputRuleState: InputRuleState;
  /** 検証の指定の未指定の項目（T30g。空でなければ、実行の許可を出さない。`VERIFICATION_SPEC_MISSING`）。 */
  readonly missingVerification: readonly ScenarioVerificationItem[];
  /** T40a-fix: 検証の指定で求める項目（画面に出す項目。FORM はすべて、API は ID の取り方と照合の READ だけ。`requiredVerificationItemsOf`）。 */
  readonly verificationItems: readonly ScenarioVerificationItem[];
  /** T40R2-fix: 画面から ID を取る型が書き込みの画面にも当たるか（API のシナリオだけ。当たれば注意を出す。`recordIdPatternMatchesPagePath`）。 */
  readonly recordIdPatternCaution: boolean;
  /** 書き込みを始める画面を出すか（T30g。T31h-2 から、登録（CREATE）と更新（UPDATE）のシナリオで、その書き込みのジョブを始められるプロファイル）。 */
  readonly writeStartAvailable: boolean;
  /** 書き込みの履歴（T30g。新しい順）。 */
  readonly writes: readonly WriteResultSummaryView[];
  /** T31h-1: 台帳のシナリオ（UPDATE の指定がなければ null。台帳のシナリオが読めなければ、画面の path は null）。 */
  readonly updateLedger: { readonly scenarioId: string; readonly pagePath: string | null } | null;
  /** T31h-1: 更新の予定のレコードの ID（`readPlannedUpdateTarget`。UPDATE でないか、対象にできるレコードがなければ null）。 */
  readonly plannedUpdateTarget: string | null;
  /**
   * FM2b（手を減らす段 2 の設計書 3A.2）: 自動の下書きが推した値のまま残る項目と根拠（API の登録だけ。表示のときに、同じ部品
   * `autoDraftInferredItemsOf` で求め直す。承認に結ばない）。1 つでも残れば、承認のダイアログにも出す。
   */
  readonly inferredItems: readonly AutoDraftInferredItem[];
  /**
   * PL-5（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、8 章の最後の行）: 要点の主のボタン（状態で 1 つ。判定はここの 1 か所。画面は描くだけ）。
   * `APPROVE`（書き込みの OK）: 今の内容に有効な OK がなく、変えてよいサイトのとき。`START`（書き込みを始める）: 有効な OK があり、書き込みの作業を始められる
   * サイトで、検証の指定がそろうとき。ほかは null（押せない理由は要点の文）。
   */
  readonly primaryAction: ScenarioPrimaryAction | null;
  /**
   * PL-5 の 9 の (4)（設計書 8.1）: フォームの登録で、作ったデータの ID の取り方を決められなかったか（書き込みはできる。結果は ID なしの `PARTIAL` で、その
   * 登録のデータは台帳に ID がないので書き換えられない）。
   */
  readonly recordIdUndetermined: boolean;
  /** PL-5 の 9 の (2): 書き換えの答え合わせを、台帳の登録の書き込みの手順から写したか（同じ見るだけの確かめを使う）。中身は画面に出さない。 */
  readonly verificationCopied: boolean;
}

/** PL-5: 書き込みの手順の詳細の主のボタン（閉じた一覧）。 */
export const SCENARIO_PRIMARY_ACTIONS = Object.freeze(['APPROVE', 'START'] as const);
export type ScenarioPrimaryAction = (typeof SCENARIO_PRIMARY_ACTIONS)[number];

/** 誤り 1 件（送る欄の誤りはその欄の名前、照らす READ の定義の誤りはその ID）。 */
export interface ScenarioErrorView {
  readonly code: ScenarioDraftRejectionReason;
  readonly fieldName: string | null;
  readonly readCheckId: string | null;
}

/** 画面の要求を拒む理由（保存の部品の理由と、画面のサーバの理由）。 */
export type ScenarioRequestRejectionReason = ScenarioStoreRejectionReason | ScenarioRequestLocalRejectionReason;

/** 拒んだ結果（理由と、下書きの誤りと、再承認の判定の理由）。 */
export interface ScenarioRejectionView {
  readonly ok: false;
  readonly reason: ScenarioRequestRejectionReason;
  readonly errors: readonly ScenarioErrorView[];
  readonly invalidityReasons: readonly ApprovalInvalidityReason[];
}

/**
 * 作成・変更・承認・撤回の結果。PL-6b: 作成と変更で推した規則を付けたときは、付けたかと推せなかった欄（その欄だけを人に聞く。画面は PL-5）。
 */
export type ScenarioChangeView = {
  readonly ok: true;
  readonly scenarioId: string;
  readonly revision: number;
  readonly rules?: { readonly attached: boolean; readonly unresolvedFieldNames: readonly string[] };
} | ScenarioRejectionView;

// ---------------------------------------------------------------------------------------------------------------
// 値の組み立て
// ---------------------------------------------------------------------------------------------------------------

// シナリオを作り・変えてよいプロファイルの状態（`ACTIVE_PROFILE_STATUS`）と今の時刻（`nowCompactTimestamp`）は、owner から読む（FM2R の Minor 13）。

const RULES_VIEW: ScenarioFormRulesView = Object.freeze({
  minLimit: MIN_SCENARIO_LIMIT,
  maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN,
  maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES,
  minTtlDays: MIN_APPROVAL_TTL_DAYS,
  maxTtlDays: APPROVAL_TTL_DAYS,
  sideEffects: SIDE_EFFECT_CONFIRMATIONS,
  unconfirmedSideEffects: UNCONFIRMED_SIDE_EFFECTS,
});

/** 今の時刻（管理データの UTC の 14 桁。owner は `timestamps.ts`）。 */
const nowStamp = nowCompactTimestamp;

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

/** 候補のシナリオの種類（登録か更新。どちらでもなければ null）。 */
const scenarioKindOfCandidate = (candidate: DiscoveryCandidate): ScenarioKind | null =>
  SCENARIO_KINDS.find((kind) => kind === candidate.classification) ?? null;

/**
 * T31h-1: UPDATE を受けない画面の欄の誤り（欄に結び付くが、その画面で UPDATE のシナリオを作れない。候補を作れない理由にする）。T31R2-fix-1: 値を
 * 読めない秘密に見える名前の欄がある画面（登録と更新）も、候補を作れない理由にする。
 */
// PL-6b: 一覧の owner は、自動の下書きと共用する純粋な部品（`form-scenario-autodraft.ts`）。
const UPDATE_FORM_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = FORM_UNUSABLE_SCREEN_REASONS;
/** T31h-1: 役割を持たない、見えていて編集できる欄の誤り（役割を決める欄の印）。 */
const ROLE_MISSING_REASON = 'SCENARIO_UPDATE_FIELD_ROLE_MISSING' satisfies ScenarioDraftRejectionReason;
/** MI-6: 送る欄にしないと保存できない欄の誤り（必ず送る欄の印）。 */
const MUST_SEND_REASON = 'SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT' satisfies ScenarioDraftRejectionReason;

/**
 * 選べるかを確かめる下書き（その欄だけを送る、ほかは既定の値。判定は下書きの確かめの owner に任せる）。T31h-1: UPDATE の候補では、形の正しい UPDATE の
 * 指定を足す（保つ欄は `keepFieldNames`。形だけ正しい値で、台帳の参照と path の型の誤りは、欄の判定では見ない）。FM2a: 副作用の確認・確かめのためだけの
 * 台帳の参照と path の型は、API の下書きの部品（`api-scenario-draft.ts`）と同じ値を使う。PL-6b: 作り方は、フォームの形の自動の下書きと共用する純粋な部品
 * （`formScenarioProbeDraftOf`）の 1 か所。
 */
const probeDraftOf = formScenarioProbeDraftOf;

/** 入力の形の誤りの理由。 */
const INPUT_INVALID_REASON = 'SCENARIO_INPUT_INVALID' satisfies ScenarioDraftRejectionReason;
/** 候補が最後の発見の結果にない理由。 */
const CANDIDATE_UNKNOWN_REASON = 'SCENARIO_CANDIDATE_UNKNOWN' satisfies ScenarioDraftRejectionReason;

/** 下書きの確かめの誤り（受けるなら空）。 */
const draftErrorsOf = (draft: unknown, candidate: DiscoveryCandidate): readonly ScenarioErrorView[] => {
  const result = validateScenarioDraft(draft, candidate, []);
  return result.ok ? [] : result.errors;
};

/**
 * 候補からシナリオを作れない理由（送る欄なしの下書きの、候補の誤り（欄と READ の定義に結び付かない誤り）の最初。作れるなら null）。T30g: 欄ごとの
 * 誤り（送る欄に選ぶべき欄など）は、候補を作れない理由にしない（フォームで欄を選んで直せる）。T31h-1: UPDATE の候補は、UPDATE の指定を持った
 * 下書きで確かめる（T31b の「選べない」を直した）。UPDATE の指定の入力で直せる誤りは数えず、UPDATE を受けない画面の欄の誤りは数える。
 */
// PL-6b: 判定の owner は、自動の下書きと共用する純粋な部品（`formCandidateRejectionOf`）。
const candidateRejectionOf = formCandidateRejectionOf;

/**
 * 欄を送る欄（UPDATE は変える欄）に選べない理由（その欄だけを送る下書きの、その欄の誤りか、形の誤り。候補の誤りと、UPDATE を受けない画面の欄の
 * 誤りは数えない。選べるなら null）。
 */
const fieldRejectionOf = (profileId: string, candidate: DiscoveryCandidate, name: string): ScenarioDraftRejectionReason | null => {
  const errors = draftErrorsOf(probeDraftOf(profileId, candidate, [name]), candidate);
  return (errors.find((error) => error.fieldName === name && !UPDATE_FORM_REASONS.has(error.code))
    ?? errors.find((error) => error.code === INPUT_INVALID_REASON))?.code ?? null;
};

/** T31h-1: UPDATE の候補の、役割を決める欄（役割を持たない下書きで、下書きの確かめの owner が役割を求める欄。CREATE は空）。 */
const roleFieldNamesOf = (profileId: string, candidate: DiscoveryCandidate): ReadonlySet<string> =>
  (scenarioKindOfCandidate(candidate) === UPDATE_KIND
    ? new Set(draftErrorsOf(probeDraftOf(profileId, candidate, []), candidate)
      .filter((error) => error.code === ROLE_MISSING_REASON && error.fieldName !== null)
      .map((error) => error.fieldName ?? ''))
    : new Set());

/** MI-6: 必ず送る欄（送る欄なしの下書きで、下書きの確かめの owner が送る欄にすることを求める欄。判定を書き写さない）。 */
const mustSendFieldNamesOf = (profileId: string, candidate: DiscoveryCandidate): ReadonlySet<string> =>
  new Set(draftErrorsOf(probeDraftOf(profileId, candidate, []), candidate)
    .filter((error) => error.code === MUST_SEND_REASON && error.fieldName !== null)
    .map((error) => error.fieldName ?? ''));

/** 候補を、フォームの値にする（名前のある欄だけ。同じ名前は最初の 1 つ）。 */
const candidateViewOf = (profileId: string, candidate: DiscoveryCandidate): ScenarioCandidateView => {
  const seen = new Set<string>();
  const fields: ScenarioFieldView[] = [];
  const roleFields = roleFieldNamesOf(profileId, candidate);
  const mustSendFields = mustSendFieldNamesOf(profileId, candidate);
  for (const field of candidate.fields) {
    if (field.name.length === 0 || seen.has(field.name)) {
      continue;
    }
    seen.add(field.name);
    fields.push({
      ...evidenceFieldOf(candidate, field),
      rejection: fieldRejectionOf(profileId, candidate, field.name),
      roleRequired: roleFields.has(field.name),
      mustSend: mustSendFields.has(field.name),
    });
  }
  return {
    identityDigest: candidate.identityDigest,
    kind: candidate.kind,
    scenarioKind: scenarioKindOfCandidate(candidate),
    pageOrigin: candidate.page.origin,
    pagePath: candidate.page.path,
    actionOrigin: candidate.action?.origin ?? null,
    actionPath: candidate.action?.path ?? null,
    formMethod: candidate.formMethod,
    methodOverride: candidate.methodOverride,
    enctype: candidate.enctype,
    submitterWords: [...candidate.submitterWords],
    fields,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// T38f: API の候補のフォームの値（選べるか・作れない理由は、下書きの確かめの owner に、保存と同じ文脈で任せる）
// ---------------------------------------------------------------------------------------------------------------

/**
 * API の候補のフォームの値と、候補を作れない理由。FM2a: 案は、作成の画面と自動の下書きが共用する純粋な部品（`apiScenarioFormOf`）が作る。ここは、
 * 管理データから既にあるシナリオの一覧を読んで渡し、送り方を足すだけ。
 */
const apiFormOf = (
  profileId: string,
  candidate: DiscoveryCandidate,
  context: ScenarioDraftContext,
  request: ScenarioFormPresetRequest = {},
): { readonly view: ScenarioApiFormView | null; readonly rejection: ScenarioDraftRejectionReason | null } => {
  const { form, rejection } = apiScenarioFormOf({
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
  return { rejection, view: form === null ? null : { ...form, transport: API_SCENARIO_TRANSPORT, preset: presetViewOf(form, request) } };
};

/**
 * FM2b: 更新の作成の画面で前もって選ぶ値（URL の引数の案のうち、選択肢にあるものだけ）。印は、自動の下書きと同じ部品で求め直した値と同じときだけ
 * 付ける。登録は null。
 */
const presetViewOf = (form: ApiScenarioFormProposal, request: ScenarioFormPresetRequest): ScenarioApiPresetView | null => {
  if (form.kind !== UPDATE_KIND) {
    return null;
  }
  const computed = apiUpdateDraftPresetOf(form);
  const valueOf = (value: string | undefined, options: readonly string[], mark: DraftValue<string> | null): ScenarioApiPresetValueView | null => {
    if (value === undefined || !options.includes(value)) {
      return null;
    }
    return mark !== null && mark.value === value ? { value, origin: mark.origin, ground: mark.ground } : { value, origin: null, ground: null };
  };
  return {
    ledger: valueOf(request.ledgerScenarioId, form.ledgerOptions.map(({ scenarioId }) => scenarioId), computed.ledger),
    formPathTemplate: valueOf(request.formPathTemplate, form.formPathTemplates, computed.formPathTemplate),
    ledgerOptionCount: computed.ledgerOptionCount,
  };
};

/** 承認の状態の表示の値。 */
const statusViewOf = (status: ScenarioApprovalStatus): ScenarioStatusView => ({
  displayState: scenarioDisplayStateOf(status.validity),
  reasons: [...shownInvalidityReasonsOf(status.validity)],
  approvalDigest: status.approvalDigest,
  expiresAt: status.validity.approved ? isoTimestampOf(status.validity.expiresAt) : null,
});

/** シナリオの最後の承認の記録（なければ null）。 */
const lastApprovalOf = (scenario: ScenarioView): ApprovalReceipt | null => {
  if (scenario.lastApprovalReceiptId === null) {
    return null;
  }
  const receipt = readApprovalReceipts(localUiStore(), scenario.scenarioId)
    .find((record) => record.kind === 'APPROVAL' && record.receiptId === scenario.lastApprovalReceiptId);
  return receipt === undefined || receipt.kind !== 'APPROVAL' ? null : receipt;
};

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
  const lastApproval = lastApprovalOf(scenario);
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
    lastApprovalExpiresAt: lastApproval === null ? null : isoTimestampOf(lastApproval.expiresAt),
    limits: { ...current.limits },
    used: usedOf(scenario.scenarioId),
    updatedAt: isoTimestampOf(scenario.updatedAt),
    inputRuleState: dataRuleFactsOf(scenario).state,
  };
};

/** 最後の承認との差分（前は、最後の承認の版と承認の記録に縛った事実。今は、今の版と今の事実）。 */
const differencesOf = (
  scenario: ScenarioView,
  lastApproval: ApprovalReceipt | null,
  stored: StoredProfile,
  external: ApprovalExternalFacts | null,
): readonly ApprovalDigestDifference[] | null => {
  if (lastApproval === null || external === null) {
    return null;
  }
  const approved = readScenarioRevisions(localUiStore(), scenario.scenarioId).find((view) => view.revision === lastApproval.scenarioRevision);
  if (approved === undefined) {
    return null;
  }
  const { bound } = lastApproval;
  return approvalDigestDifferencesOf(
    {
      scenario: approved.scenario,
      facts: { profileRevision: bound.profileRevision, authSetupDigest: bound.authSetupDigest, targetConfigDigest: bound.targetConfigDigest },
    },
    { scenario: scenario.current, facts: { profileRevision: stored.profile.revision, ...external } },
  );
};

/** 詳細の画面の値。 */
const detailOf = async (scenario: ScenarioView, stored: StoredProfile): Promise<ScenarioDetailPageView> => {
  const external = await approvalExternalFactsOf(stored);
  const { current, evidence } = scenario;
  const lastApproval = lastApprovalOf(scenario);
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
    unconfirmedSideEffects: [...unconfirmedSideEffectsOf(current.sideEffectConfirmations)],
    used: usedOf(scenario.scenarioId),
    history: readApprovalReceipts(localUiStore(), scenario.scenarioId).map((receipt) => (receipt.kind === 'APPROVAL'
      ? {
        receiptId: receipt.receiptId,
        kind: receipt.kind,
        at: isoTimestampOf(receipt.approvedAt),
        scenarioRevision: receipt.scenarioRevision,
        expiresAt: isoTimestampOf(receipt.expiresAt),
        reason: null,
      }
      : { receiptId: receipt.receiptId, kind: receipt.kind, at: isoTimestampOf(receipt.revokedAt), scenarioRevision: null, expiresAt: null, reason: receipt.reason })),
    revisions: readScenarioRevisions(localUiStore(), scenario.scenarioId).map((view) => ({
      revision: view.revision,
      recordedAt: isoTimestampOf(view.recordedAt),
      fieldNames: [...view.scenario.fieldNames],
      limits: { ...view.scenario.limits },
      approvalTtlDays: view.scenario.approvalTtlDays,
    })),
    lastApprovalRevision: lastApproval?.scenarioRevision ?? null,
    differences: differencesOf(scenario, lastApproval, stored, external),
    inputRuleState: dataRuleFactsOf(scenario).state,
    // T40a-fix: 求める項目は送り方で決まる（API は照合の READ と ID の取り方だけ。同じ判定を発行の口も使う）。
    missingVerification: [...missingVerification],
    verificationItems: [...requiredVerificationItemsOf(current)],
    // T40R2-fix（使える度合い）: API のシナリオで、画面から ID を取る型が書き込みの画面（候補の画面）にも当たれば注意を出す（保存は拒まない）。
    recordIdPatternCaution: current.transport === API_SCENARIO_TRANSPORT
      && recordIdPatternMatchesPagePath(current.verification.recordId, scenario.evidence.page.path),
    // T31h-2: 登録（CREATE）と更新（UPDATE）のどちらも、プロファイルがその書き込みのジョブを始められるときに、開始の画面へ移れる。
    writeStartAvailable: isProfileOperationAllowed(writeJobKindOf(current.kind), stored.profile.mode, stored.profile.auth),
    writes: await writeResultSummariesOfScenario(scenario.scenarioId),
    updateLedger: updateLedgerOf(scenario),
    plannedUpdateTarget: current.kind === UPDATE_KIND ? readPlannedUpdateTarget(localUiStore(), scenario.scenarioId) : null,
    inferredItems: await inferredItemsOf(scenario, stored),
    primaryAction: primaryActionOf(scenario, stored, status, missingVerification),
    recordIdUndetermined: scenarioTransportOf(current) === FORM_SCENARIO_TRANSPORT && current.kind === CREATE_KIND && current.verification.recordId === null,
    verificationCopied: verificationCopiedOf(scenario),
  };
};

/** PL-5: 有効な書き込みの OK の表示の状態（`ScenarioStatusView.displayState`）。 */
const APPROVED_DISPLAY_STATE: ScenarioDisplayState = 'APPROVED';

/**
 * PL-5: 要点の主のボタン（`ScenarioDetailPageView.primaryAction` の説明）。管理データの外の事実を求められない（状態が null）なら出さない。
 */
const primaryActionOf = (
  scenario: ScenarioView,
  stored: StoredProfile,
  status: ScenarioStatusView | null,
  missingVerification: readonly ScenarioVerificationItem[],
): ScenarioPrimaryAction | null => {
  if (status === null) {
    return null;
  }
  if (status.displayState === APPROVED_DISPLAY_STATE) {
    return isProfileOperationAllowed(writeJobKindOf(scenario.current.kind), stored.profile.mode, stored.profile.auth) && missingVerification.length === 0
      ? 'START'
      : null;
  }
  return frameOf(stored).editable ? 'APPROVE' : null;
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
    // MI-C（MI-6 の報告の片付け）: シナリオの詳細は承認の前の画面なので、入力の規則の判定（`data-rule-facts.ts`）と同じ前提（承認のダイアログで副作用を
    // 確認する `PRE_APPROVAL_EVALUATION_PREMISE`）で求め直す（確認のない版でも、メールの欄を変わる欄に数える。自動の下書きの推しと同じ判定）。
    varyingFieldNames = saved === null
      ? []
      : varyingFieldNamesOf(planRuleSet(saved, current, evidence, undefined, PRE_APPROVAL_EVALUATION_PREMISE));
    // FM2R の Minor 11: 範囲の既定の幅を入れた欄（判定は規則の部品の 1 か所。規則の画面と同じ）。
    defaultRangeFieldNames = saved === null ? [] : defaultRangeFieldNamesOf(saved.fieldRules, current, evidence);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
  }
  // FM2R の Minor 11: 更新の画面の型の選択肢（作成の画面と同じ案の部品。最後の発見の文脈で求め直す）。
  const context = current.kind !== UPDATE_KIND || latest === null ? null : readScenarioDraftContext(localUiStore(), profileId, latest.jobId, scenario.scenarioId);
  const updateFormPathTemplates = context === null ? [] : apiFormOf(profileId, evidence, context).view?.formPathTemplates ?? [];
  return autoDraftInferredItemsOf({
    scenarioId: scenario.scenarioId,
    scenario: current,
    // FM2R の Minor 9: 自動の下書きの値が、その後に人の手で変わっていないかを、版の写しの履歴で見る。
    history: readScenarioRevisions(localUiStore(), scenario.scenarioId).map((view) => view.scenario),
    evidence,
    candidates: mergedCandidatesOf(latest),
    approvedServiceOrigins: stored.profile.approvedServiceOrigins ?? [],
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

/**
 * T31h-1: UPDATE の候補のフォームの値（台帳にできる登録のシナリオ、候補から作れる path の型の組、型の印。UPDATE でなければ null）。PL-5 の 9 の (3)
 * （設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1）: ID の区切りの値がレコードの ID の形かは、自動の下書きと同じ判定（`isAutoDraftRecordIdSegment`。
 * core の `isRecordIdLikePathSegment`。数字か UUID の形の区切りだけ）。
 */
const updateFormViewOf = (profileId: string, candidate: DiscoveryCandidate): ScenarioUpdateFormView | null => {
  if (scenarioKindOfCandidate(candidate) !== UPDATE_KIND) {
    return null;
  }
  const templateOptions = pathTemplateOptionsOf(candidate, isAutoDraftRecordIdSegment).map((option) => ({ ...option }));
  return {
    ledgerOptions: listScenarios(localUiStore(), profileId)
      .filter((scenario) => scenario.current.kind === CREATE_KIND)
      .map((scenario) => ({
        scenarioId: scenario.scenarioId,
        pagePath: scenario.evidence.page.path,
        // T31R-fix-1 の I-2: 台帳の今の登録の ID の取り方に結び付かない組。
        unboundTemplates: templateOptions.flatMap((option, index) =>
          (isUpdatePathBoundToLedger(option.actionPathTemplate, scenario.current.verification.recordId) ? [] : [index])),
      })),
    templateOptions,
    placeholder: RECORD_ID_PLACEHOLDER,
  };
};

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

/** 拒んだ結果（理由と、項目ごとの誤りと、再承認の判定の理由）。 */
const rejectionOf = (
  reason: ScenarioRequestRejectionReason,
  details: { readonly errors?: readonly ScenarioErrorView[]; readonly invalidityReasons?: readonly ApprovalInvalidityReason[] } = {},
): ScenarioRejectionView => ({ ok: false, reason, errors: [...(details.errors ?? [])], invalidityReasons: [...(details.invalidityReasons ?? [])] });

/** 保存の部品の結果を、画面に返す値にする（英語の詳しい文は返さない）。 */
/**
 * T30R-fix-1（DEF-103）: 承認を無効にする操作（撤回、シナリオの変更）が通った後に、そのシナリオの動いている書き込みのジョブを、ジョブの管理の
 * 止める口（`stopWriteJobsOfScenario`）で止める。動いているワーカーがなければ（ジョブの管理をまだ作っていないときを含む）、何もしない
 * （ジョブの管理を、ここで作らない。作ると管理のロックを取り、前のジョブの行を直すため）。止められなくても、撤回・変更の結果は変えない
 * （ワーカーの押す直前の確かめ直しが、無効になった承認を拒む）。
 */
const stopWriteJobsAfterInvalidation = (result: ScenarioStoreResult, scenarioId: string): ScenarioStoreResult => {
  if (result.ok && runningLocalUiAuditJobCount() > 0) {
    try {
      localUiAuditJobs().stopWriteJobsOfScenario(scenarioId);
    } catch {
      // 止める口の失敗は、撤回・変更の結果を変えない（上の説明）。
    }
  }
  return result;
};

const changeViewOf = (result: ScenarioStoreResult): ScenarioChangeView => (result.ok
  ? { ok: true, scenarioId: result.scenario.scenarioId, revision: result.scenario.revision }
  : rejectionOf(result.reason, {
    errors: result.draftErrors.map(({ code, fieldName, readCheckId }) => ({ code, fieldName, readCheckId })),
    invalidityReasons: result.invalidityReasons,
  }));

/** 下書きのプロファイル（形が違えば null。形の誤りは下書きの確かめが返す）。 */
const draftProfileIdOf = (draft: unknown): string | null =>
  (isRecord(draft) && typeof draft['profileId'] === 'string' && PROFILE_ID_PATTERN.test(draft['profileId']) ? draft['profileId'] : null);

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
interface ScenarioFormRequest extends ScenarioFormPresetRequest {
  readonly profileId: string;
  readonly candidateIdentityDigest: string;
  /** T38f: API の候補の行を選ぶ型の digest（省けば FORM の候補）。 */
  readonly shapeDigest?: string;
}
interface ScenarioCreateRequest {
  readonly draft: Readonly<Record<string, unknown>>;
}
interface ScenarioUpdateRequest {
  readonly scenarioId: string;
  readonly expectedRevision: number;
  readonly draft: Readonly<Record<string, unknown>>;
}
interface ScenarioApproveRequest {
  readonly scenarioId: string;
  readonly expectedRevision: number;
  readonly expectedApprovalDigest: string;
  /** MI-6: 承認のダイアログが副作用の確認の 4 項目を示し、1 回の「承認する」で確かめた（ダイアログだけが送る）。 */
  readonly sideEffectsConfirmed?: true;
}
interface ScenarioRevokeRequest {
  readonly scenarioId: string;
  readonly expectedRevision: number;
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

/** 作成と変更のフォームの画面の値（読むだけ。候補は最後の発見のジョブの結果から）。プロファイルがなければ `null`。 */
export const scenarioFormPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ScenarioFormRequest>('ui-scenario-form'))
  .handler(async ({ data }): Promise<ScenarioFormPageView | null> => {
    const stored = getProfile(localUiStore(), data.profileId);
    if (stored === null) {
      return null;
    }
    const { profileId } = stored.profile;
    const { latest } = await readDiscoveryDocuments(profileId);
    const { shapeDigest } = data;
    // T38f: 型の digest があれば、API の候補の行を型で選ぶ（同じ識別で型が違う行が別に残る）。下書きの確かめは保存と同じ文脈で行う。
    const candidate = shapeDigest === undefined
      ? candidateOfDocument(latest, data.candidateIdentityDigest)
      : candidateOfDocumentByShape(latest, data.candidateIdentityDigest, shapeDigest);
    const context = latest === null ? null : readScenarioDraftContext(localUiStore(), profileId, latest.jobId, null);
    const api = shapeDigest === undefined || candidate === null || context === null
      ? null
      : apiFormOf(profileId, candidate, context, {
        ...(data.ledgerScenarioId === undefined ? {} : { ledgerScenarioId: data.ledgerScenarioId }),
        ...(data.formPathTemplate === undefined ? {} : { formPathTemplate: data.formPathTemplate }),
      });
    return {
      ...frameOf(stored),
      candidate: candidate === null ? null : candidateViewOf(profileId, candidate),
      candidateRejection: candidate === null
        ? CANDIDATE_UNKNOWN_REASON
        : shapeDigest === undefined ? candidateRejectionOf(profileId, candidate) : api === null ? CANDIDATE_UNKNOWN_REASON : api.rejection,
      readChecks: listReadChecks(localUiStore(), profileId).map(({ readCheckId, revision, definition }) => ({
        readCheckId,
        revision,
        parameterNames: Object.keys(definition.parameters),
        verifiable: readCheckTargetKindOf(definition) === 'CANDIDATE',
        pageTemplate: definition.targetPagePath !== undefined && isReadCheckPageTemplatePath(definition.targetPagePath),
      })),
      rules: RULES_VIEW,
      update: candidate === null || shapeDigest !== undefined ? null : updateFormViewOf(profileId, candidate),
      api: api?.view ?? null,
    };
  });

/** シナリオの詳細の画面の値（読むだけ）。シナリオがなければ `null`。 */
export const scenarioDetailPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ScenarioKeyRequest>('ui-scenario-key'))
  .handler(async ({ data }): Promise<ScenarioDetailPageView | null> => {
    const found = scenarioWithProfileOf(data.scenarioId);
    return found === null ? null : detailOf(found.scenario, found.stored);
  });

/**
 * PL-6b（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1 の「更新の検証」）: 書き換えの下書き（API の形とフォームの形）の照合の READ が未指定なら、台帳の
 * 登録の書き込みの手順から写す（写し方の 1 か所 `updateVerificationCopyOf`。フォームの形は登録の ID の型も、人が入れていなければ写す）。人が入れた照合の READ は
 * 変えない。写せなければ下書きのまま（保存の確かめと許可の発行が、今どおり未指定を扱う）。
 */
const withLedgerVerificationOf = (
  draft: Readonly<Record<string, unknown>>,
  profileId: string,
  latest: Awaited<ReturnType<typeof readDiscoveryDocuments>>['latest'],
): Readonly<Record<string, unknown>> => {
  const transport: ScenarioTransport = draft['transport'] === API_SCENARIO_TRANSPORT ? API_SCENARIO_TRANSPORT : FORM_SCENARIO_TRANSPORT;
  const api = isRecord(draft['api']) ? draft['api'] : null;
  const update = isRecord(draft['update']) ? draft['update'] : null;
  const ledgerSource = transport === API_SCENARIO_TRANSPORT ? (api !== null && isRecord(api['ledger']) ? api['ledger'] : null) : update;
  const ledgerId = ledgerSource?.['targetCreateScenarioId'];
  const verification = isRecord(draft['verification']) ? draft['verification'] : null;
  const readVerification = verification?.['readVerification'] ?? null;
  const ledger = typeof ledgerId === 'string' && readVerification === null ? readScenario(localUiStore(), ledgerId) : null;
  if (ledger === null || ledger.profileId !== profileId) {
    return draft;
  }
  const fieldNames = Array.isArray(draft['fieldNames']) ? draft['fieldNames'].filter((name): name is string => typeof name === 'string') : [];
  const digest = draft['candidateIdentityDigest'];
  const candidate = transport === FORM_SCENARIO_TRANSPORT && typeof digest === 'string' ? candidateOfDocument(latest, digest) : null;
  const copy = updateVerificationCopyOf({
    transport,
    ledger: ledger.current.verification,
    readChecks: listReadChecks(localUiStore(), profileId)
      .map(({ readCheckId, revision, definition }) => ({ readCheckId, revision, targetPagePath: definition.targetPagePath ?? null })),
    changedFieldNames: fieldNames,
    changedTextFieldNames: candidate === null ? [] : formTextFieldNamesOf(candidate, fieldNames),
  });
  if (copy.kind !== 'FILLED') {
    return draft;
  }
  const recordId = verification?.['recordId'] ?? copy.recordId;
  return { ...draft, verification: { ...(verification ?? {}), recordId, readVerification: copy.readVerification } };
};

/**
 * PL-6b（設計書 8 章の「入れる値の決まり」）: 保存した下書きに、規則がまだなければ、推した規則を付ける（付け方の 1 か所 `attachInferredRulesOnSave`）。推せない
 * 欄があるときだけ、その欄を返す。付けた後の版を返す。PL-5 の 9 の (1)（設計者の判断）: 手で作ったものを含む、すべての保存（作成・変更）に付ける。
 */
const withRulesOnSave = (result: ScenarioStoreResult): ScenarioChangeView => {
  if (!result.ok || result.scenario.state !== DRAFT_SCENARIO_STATE || result.scenario.current.inputRuleReference !== null
    || readLatestRuleSet(localUiStore(), result.scenario.scenarioId) !== null) {
    return changeViewOf(result);
  }
  const attached = attachInferredRulesOnSave(result.scenario);
  return {
    ok: true,
    scenarioId: result.scenario.scenarioId,
    revision: attached.scenario?.revision ?? result.scenario.revision,
    rules: { attached: attached.view.attached, unresolvedFieldNames: attached.view.unresolved.map(({ fieldName }) => fieldName) },
  };
};

/** シナリオを作る（最後の発見の候補に照らす確かめの後に保存する。版 1、下書き。PL-6b: 書き換えの検証の写しと、推した規則を付ける）。 */
export const createScenarioFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ScenarioCreateRequest>('ui-scenario-create'))
  .handler(async ({ data }): Promise<ScenarioChangeView> => {
    const profileId = draftProfileIdOf(data.draft);
    const discovery = profileId === null ? null : (await readDiscoveryDocuments(profileId)).latest;
    const filled = profileId === null ? data.draft : withLedgerVerificationOf(data.draft, profileId, discovery);
    return withRulesOnSave(createScenario(localUiStore(), {
      scenarioId: randomUUID(),
      draft: filled,
      discovery,
      at: nowStamp('scenario creation time'),
    }));
  });

/** シナリオを変える（画面が読んだ版と同じときだけ。版を 1 つ上げ、下書きに戻る）。 */
export const updateScenarioFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ScenarioUpdateRequest>('ui-scenario-update'))
  .handler(async ({ data }): Promise<ScenarioChangeView> => {
    const scenario = readScenario(localUiStore(), data.scenarioId);
    if (scenario === null) {
      return rejectionOf('SCENARIO_NOT_FOUND');
    }
    const { latest } = await readDiscoveryDocuments(scenario.profileId);
    const draft = { ...data.draft, profileId: scenario.profileId, candidateIdentityDigest: scenario.current.candidate.identityDigest };
    // PL-6b: 変更の保存も、書き換えの検証の写しを行う。PL-5 の 9 の (1): 規則がまだなければ、推した規則も付ける（作成と同じ `withRulesOnSave`）。
    return withRulesOnSave(stopWriteJobsAfterInvalidation(updateScenario(localUiStore(), {
      scenarioId: data.scenarioId,
      expectedRevision: data.expectedRevision,
      draft: withLedgerVerificationOf(draft, scenario.profileId, latest),
      discovery: latest,
      at: nowStamp('scenario change time'),
    }), data.scenarioId));
  });

/**
 * シナリオの今の版を承認する（確認のダイアログの後。画面が出した版と承認の digest を、サーバで求め直した値と照らす）。MI-6: ダイアログの副作用の確認
 * （`sideEffectsConfirmed`）があれば、承認する版は、確認を入れた次の版になる（返す版の番号はその版）。
 */
export const approveScenarioFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ScenarioApproveRequest>('ui-scenario-approve'))
  .handler(async ({ data }): Promise<ScenarioChangeView> => {
    const found = scenarioWithProfileOf(data.scenarioId);
    if (found === null) {
      return rejectionOf('SCENARIO_NOT_FOUND');
    }
    const external = await approvalExternalFactsOf(found.stored);
    if (external === null) {
      return rejectionOf('SCENARIO_FACTS_UNAVAILABLE');
    }
    return changeViewOf(approveScenario(localUiStore(), {
      scenarioId: data.scenarioId,
      expectedRevision: data.expectedRevision,
      expectedApprovalDigest: data.expectedApprovalDigest,
      receiptId: randomUUID(),
      external,
      at: nowStamp('scenario approval time'),
      // MI-6: ダイアログの確認があれば、確認のない版に確認を入れた次の版を、同じトランザクションで作って承認する（保存の部品）。
      confirmSideEffects: data.sideEffectsConfirmed === true,
    }));
  });

/** シナリオの最後の承認を撤回する（確認のダイアログの後。消費していない許可を無効にし、予約を返す）。 */
export const revokeScenarioFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ScenarioRevokeRequest>('ui-scenario-revoke'))
  .handler(({ data }): ScenarioChangeView => changeViewOf(stopWriteJobsAfterInvalidation(revokeScenarioApproval(localUiStore(), {
    scenarioId: data.scenarioId,
    expectedRevision: data.expectedRevision,
    receiptId: randomUUID(),
    at: nowStamp('scenario revocation time'),
  }), data.scenarioId)));

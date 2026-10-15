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
 */
import { randomUUID } from 'node:crypto';
import { createServerFn } from '@tanstack/react-start';
import {
  APPROVAL_TTL_DAYS,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  MIN_APPROVAL_TTL_DAYS,
  MIN_SCENARIO_LIMIT,
  RECORD_ID_PLACEHOLDER,
  SCENARIO_KINDS,
  SIDE_EFFECT_CONFIRMATIONS,
  approvalDigestDifferencesOf,
  approveScenario,
  createScenario,
  listScenarios,
  missingVerificationItemsOf,
  readApprovalReceipts,
  isUpdatePathBoundToLedger,
  readPlannedUpdateTarget,
  readScenario,
  readScenarioApprovalStatus,
  readScenarioRevisions,
  readUsedCumulativeWrites,
  revokeScenarioApproval,
  unconfirmedSideEffectsOf,
  updateScenario,
  validateScenarioDraft,
  type ApprovalDigestDifference,
  type ApprovalExternalFacts,
  type ApprovalInvalidityReason,
  type ApprovalReceipt,
  type ApprovalReceiptKind,
  type InputRuleReference,
  type ReadCheckReference,
  type RevocationReason,
  type ScenarioApprovalStatus,
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
import { usableRecordIdOf } from '../../../../src/control/actions/action-outcome.js';
import { PROFILE_ID_PATTERN } from '../../../../src/control/contracts.js';
import { isProfileOperationAllowed } from '../../../../src/control/execution-policy.js';
import {
  pathTemplateOptionsOf,
  type CandidateFieldTag,
  type CandidateFieldType,
  type CandidateKind,
  type DiscoveryCandidate,
  type FormEnctype,
  type FormMethod,
  type MethodOverride,
  type PathTemplateOption,
} from '../../../../src/control/discovery-view.js';
import { listReadChecks } from '../../../../src/control/job/read-check-store.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { isRecord } from '../../../../src/core/guards.js';
import { formatCompactUtcTimestamp } from '../../../../src/core/utc-timestamp.js';
import { usesScenarios } from '../display/labels';
import { scenarioDisplayStateOf, shownInvalidityReasonsOf, type ScenarioDisplayState } from '../display/scenarios';
import type { InputRuleState } from '../display/data-rules';
import { dataRuleFactsOf } from './data-rule-facts';
import { localUiAuditJobs, runningLocalUiAuditJobCount } from './audit-jobs';
import { localUiStore } from './control-store';
import {
  candidateFieldViewOf,
  candidateOfDocument,
  discoveryProfileViewOf,
  readDiscoveryDocuments,
  showsOriginsOf,
  type CandidateFieldConstraintView,
  type DiscoveryProfileView,
} from './discovery-documents';
import { approvalExternalFactsOf, type ScenarioRequestLocalRejectionReason } from './scenario-facts';
import { requestOf } from './request-validation';
import { isoTimestampOf } from './timestamps';
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
}

/** 照らす READ の定義・照合の READ に選べる定義（取り消していないもの。T30g: 今の版の送る値の名前。値は返さない）。 */
export interface ScenarioReadCheckOptionView extends ReadCheckReference {
  readonly parameterNames: readonly string[];
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
}

/** 発見の根拠の写しの欄（値と選択肢は持たない）。 */
export type ScenarioEvidenceFieldView = Omit<ScenarioFieldView, 'rejection' | 'roleRequired'>;

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
  readonly request: ScenarioRequestShape;
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
  /** 書き込みを始める画面を出すか（T30g。T31h-2 から、登録（CREATE）と更新（UPDATE）のシナリオで、その書き込みのジョブを始められるプロファイル）。 */
  readonly writeStartAvailable: boolean;
  /** 書き込みの履歴（T30g。新しい順）。 */
  readonly writes: readonly WriteResultSummaryView[];
  /** T31h-1: 台帳のシナリオ（UPDATE の指定がなければ null。台帳のシナリオが読めなければ、画面の path は null）。 */
  readonly updateLedger: { readonly scenarioId: string; readonly pagePath: string | null } | null;
  /** T31h-1: 更新の予定のレコードの ID（`readPlannedUpdateTarget`。UPDATE でないか、対象にできるレコードがなければ null）。 */
  readonly plannedUpdateTarget: string | null;
}

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

/** 作成・変更・承認・撤回の結果。 */
export type ScenarioChangeView = { readonly ok: true; readonly scenarioId: string; readonly revision: number } | ScenarioRejectionView;

// ---------------------------------------------------------------------------------------------------------------
// 値の組み立て
// ---------------------------------------------------------------------------------------------------------------

/** シナリオを作り・変えてよいプロファイルの状態。 */
const ACTIVE_PROFILE_STATUS = 'ACTIVE';

const RULES_VIEW: ScenarioFormRulesView = Object.freeze({
  minLimit: MIN_SCENARIO_LIMIT,
  maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN,
  maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES,
  minTtlDays: MIN_APPROVAL_TTL_DAYS,
  maxTtlDays: APPROVAL_TTL_DAYS,
  sideEffects: SIDE_EFFECT_CONFIRMATIONS,
});

/** 副作用の確認（どれも確かめていない。選べるかの確かめの下書きに使う）。 */
const NOTHING_CONFIRMED: SideEffectConfirmations = Object.freeze(
  Object.fromEntries(SIDE_EFFECT_CONFIRMATIONS.map((item) => [item, false])) as Record<SideEffectConfirmation, boolean>,
);

/** 今の時刻（管理データの UTC の 14 桁）。 */
const nowStamp = (label: string): string => formatCompactUtcTimestamp(new Date(), label);

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
 * T31h-1: 選べるかを確かめる UPDATE の下書きの、UPDATE の指定（形だけ正しい値。台帳の参照と path の型の誤りは、欄の判定では見ない）。型は、
 * 区切りの全体を印にした path（契約の印を使う。書き写さない）。台帳の参照は、シナリオの id の形に合う、確かめのためだけの名前。
 */
const PROBE_PATH_TEMPLATE = `/${RECORD_ID_PLACEHOLDER}`;
const PROBE_LEDGER_SCENARIO_ID = 'scenario-form-probe';
/** T31h-1: UPDATE の下書きで、フォームの UPDATE の指定の入力で直せる、欄に結び付かない誤り（候補を作れない理由にしない）。 */
const UPDATE_INPUT_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_UPDATE_TARGET_NOT_FOUND',
  'SCENARIO_UPDATE_TARGET_NOT_CREATE',
  'SCENARIO_UPDATE_PATH_MISMATCH',
  'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
  'SCENARIO_UPDATE_NO_CHANGED_FIELD',
]);
/**
 * T31h-1: UPDATE を受けない画面の欄の誤り（欄に結び付くが、その画面で UPDATE のシナリオを作れない。候補を作れない理由にする）。T31R2-fix-1: 値を
 * 読めない秘密に見える名前の欄がある画面（登録と更新）も、候補を作れない理由にする。
 */
const UPDATE_FORM_REASONS: ReadonlySet<ScenarioDraftRejectionReason> = new Set([
  'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD',
  'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD',
  'SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD',
]);
/** T31h-1: 役割を持たない、見えていて編集できる欄の誤り（役割を決める欄の印）。 */
const ROLE_MISSING_REASON = 'SCENARIO_UPDATE_FIELD_ROLE_MISSING' satisfies ScenarioDraftRejectionReason;

/**
 * 選べるかを確かめる下書き（その欄だけを送る、ほかは既定の値。判定は下書きの確かめの owner に任せる）。T31h-1: UPDATE の候補では、形の正しい UPDATE の
 * 指定を足す（保つ欄は `keepFieldNames`）。
 */
const probeDraftOf = (
  profileId: string,
  candidate: DiscoveryCandidate,
  fieldNames: readonly string[],
  keepFieldNames: readonly string[] = [],
): Record<string, unknown> => ({
  profileId,
  candidateIdentityDigest: candidate.identityDigest,
  fieldNames: [...fieldNames],
  readChecks: [],
  sideEffectConfirmations: NOTHING_CONFIRMED,
  limits: { maxCreatesPerRun: DEFAULT_MAX_CREATES_PER_RUN, maxCumulativeCreates: DEFAULT_MAX_CUMULATIVE_CREATES },
  approvalTtlDays: APPROVAL_TTL_DAYS,
  ...(scenarioKindOfCandidate(candidate) === UPDATE_KIND
    ? {
      update: {
        targetCreateScenarioId: PROBE_LEDGER_SCENARIO_ID,
        formPathTemplate: PROBE_PATH_TEMPLATE,
        actionPathTemplate: PROBE_PATH_TEMPLATE,
        keepFieldNames: [...keepFieldNames],
      },
    }
    : {}),
});

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
const candidateRejectionOf = (profileId: string, candidate: DiscoveryCandidate): ScenarioDraftRejectionReason | null => {
  const errors = draftErrorsOf(probeDraftOf(profileId, candidate, []), candidate);
  return errors.find((error) => UPDATE_FORM_REASONS.has(error.code))?.code
    ?? errors.find((error) => error.fieldName === null && error.readCheckId === null && !UPDATE_INPUT_REASONS.has(error.code))?.code
    ?? null;
};

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

/** 候補を、フォームの値にする（名前のある欄だけ。同じ名前は最初の 1 つ）。 */
const candidateViewOf = (profileId: string, candidate: DiscoveryCandidate): ScenarioCandidateView => {
  const seen = new Set<string>();
  const fields: ScenarioFieldView[] = [];
  const roleFields = roleFieldNamesOf(profileId, candidate);
  for (const field of candidate.fields) {
    if (field.name.length === 0 || seen.has(field.name)) {
      continue;
    }
    seen.add(field.name);
    fields.push({
      ...evidenceFieldOf(candidate, field),
      rejection: fieldRejectionOf(profileId, candidate, field.name),
      roleRequired: roleFields.has(field.name),
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
    actionOrigin: current.request.origin,
    actionPath: current.request.path,
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
  return {
    ...frameOf(stored),
    scenario: {
      scenarioId: scenario.scenarioId,
      revision: scenario.revision,
      state: scenario.state,
      kind: current.kind,
      candidateIdentityDigest: current.candidate.identityDigest,
      request: { ...current.request },
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
    status: scenarioStatusOf(scenario.scenarioId, external),
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
    missingVerification: [...missingVerificationItemsOf(current.verification)],
    // T31h-2: 登録（CREATE）と更新（UPDATE）のどちらも、プロファイルがその書き込みのジョブを始められるときに、開始の画面へ移れる。
    writeStartAvailable: isProfileOperationAllowed(writeJobKindOf(current.kind), stored.profile.mode, stored.profile.auth),
    writes: await writeResultSummariesOfScenario(scenario.scenarioId),
    updateLedger: updateLedgerOf(scenario),
    plannedUpdateTarget: current.kind === UPDATE_KIND ? readPlannedUpdateTarget(localUiStore(), scenario.scenarioId) : null,
  };
};

/** 登録のシナリオの種類（T30g）。書き込みのジョブの種類は `write-kinds.ts`（T31h-2）。 */
const CREATE_KIND = 'CREATE' satisfies ScenarioKind;
/** T31h-1: 更新のシナリオの種類。 */
const UPDATE_KIND = 'UPDATE' satisfies ScenarioKind;

/** T31h-1: ID の区切りの値が、レコードの ID の形か（owner は `src/control/actions/action-outcome.ts`）。 */
const isUsableRecordId = (value: string): boolean => usableRecordIdOf(value) !== null;

/** T31h-1: UPDATE の候補のフォームの値（台帳にできる登録のシナリオ、候補から作れる path の型の組、型の印。UPDATE でなければ null）。 */
const updateFormViewOf = (profileId: string, candidate: DiscoveryCandidate): ScenarioUpdateFormView | null => {
  if (scenarioKindOfCandidate(candidate) !== UPDATE_KIND) {
    return null;
  }
  const templateOptions = pathTemplateOptionsOf(candidate, isUsableRecordId).map((option) => ({ ...option }));
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

/** T31h-1: 台帳のシナリオ（UPDATE の指定がなければ null）。 */
const updateLedgerOf = (scenario: ScenarioView): ScenarioDetailPageView['updateLedger'] => {
  const { update } = scenario.current;
  if (update === null) {
    return null;
  }
  const ledger = readScenario(localUiStore(), update.targetCreateScenarioId);
  return { scenarioId: update.targetCreateScenarioId, pagePath: ledger === null ? null : ledger.evidence.page.path };
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
interface ScenarioFormRequest {
  readonly profileId: string;
  readonly candidateIdentityDigest: string;
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
    const candidate = candidateOfDocument(latest, data.candidateIdentityDigest);
    return {
      ...frameOf(stored),
      candidate: candidate === null ? null : candidateViewOf(profileId, candidate),
      candidateRejection: candidate === null ? CANDIDATE_UNKNOWN_REASON : candidateRejectionOf(profileId, candidate),
      readChecks: listReadChecks(localUiStore(), profileId).map(({ readCheckId, revision, definition }) => ({
        readCheckId,
        revision,
        parameterNames: Object.keys(definition.parameters),
      })),
      rules: RULES_VIEW,
      update: candidate === null ? null : updateFormViewOf(profileId, candidate),
    };
  });

/** シナリオの詳細の画面の値（読むだけ）。シナリオがなければ `null`。 */
export const scenarioDetailPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ScenarioKeyRequest>('ui-scenario-key'))
  .handler(async ({ data }): Promise<ScenarioDetailPageView | null> => {
    const found = scenarioWithProfileOf(data.scenarioId);
    return found === null ? null : detailOf(found.scenario, found.stored);
  });

/** シナリオを作る（最後の発見の候補に照らす確かめの後に保存する。版 1、下書き）。 */
export const createScenarioFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ScenarioCreateRequest>('ui-scenario-create'))
  .handler(async ({ data }): Promise<ScenarioChangeView> => {
    const profileId = draftProfileIdOf(data.draft);
    const discovery = profileId === null ? null : (await readDiscoveryDocuments(profileId)).latest;
    return changeViewOf(createScenario(localUiStore(), {
      scenarioId: randomUUID(),
      draft: data.draft,
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
    return changeViewOf(stopWriteJobsAfterInvalidation(updateScenario(localUiStore(), {
      scenarioId: data.scenarioId,
      expectedRevision: data.expectedRevision,
      draft: { ...data.draft, profileId: scenario.profileId, candidateIdentityDigest: scenario.current.candidate.identityDigest },
      discovery: latest,
      at: nowStamp('scenario change time'),
    }), data.scenarioId));
  });

/** シナリオの今の版を承認する（確認のダイアログの後。画面が出した版と承認の digest を、サーバで求め直した値と照らす）。 */
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

/**
 * 書き込みの開始の画面の Server Functions（Task 30 の設計書 2 章のユーザーの判断 1〜4、3 章、10 章。T30g の Blocker の判断（案 A））。
 * - 開始の画面の値（`writeStartPageFn`。GET。読むだけ）: 人が始める前に確かめる内容（シナリオと版、送る欄、送り先、1 回の Run で 1 件、累積の残り、
 *   連続の上限の残りと次に実行できる時刻（判定の owner `execution-grant.ts` の `writeScheduleOf`）、外部への通知の確認、環境の証跡、検証の指定の
 *   未指定の項目、承認の状態、ジョブの管理と同じ開始の前の確かめの結果）と、今始められるか。
 * - 開始（`startWriteCreateFn`。POST だけ。CSRF は画面のサーバの middleware が確かめる）: シナリオとプロファイルを読み、登録（CREATE）のシナリオで
 *   あること、ジョブの管理と同じ開始の前の確かめ（書き込みのモードの、ログインを使うプロファイルだけ。`execution-policy.ts` の `WRITE_CREATE` の行）、
 *   終わっていないジョブがないこと、管理データの外の事実を確かめてから、実行の許可を発行し（`issueExecutionGrant`）、すぐに `startWriteCreate` で
 *   始める。開始の前の確かめで止まるときは、許可を発行しない（使わない許可の予約を残さない）。ジョブの管理が開始を拒んだときの予約の締めは、
 *   ジョブの管理の決まり（T30e）。
 * - T31h-2（Task 31 の設計書 3 章の「対象の選び方」、10 章）: 更新（UPDATE）も同じ部品で始める。開始の画面の値に、更新の予定のレコード
 *   （`readPlannedUpdateTarget`）、変える欄と保つ欄、型に予定の ID を入れた画面の path と送り先の path（`concretePathOfTemplate`）を足し、予定の
 *   レコードがなければ始められない。開始（`startWriteUpdateFn`。入力は `ui-write-update-start`）は、画面が見せた予定の ID を発行に渡し
 *   （`expectedTargetRecordId`。発行の中で選び直して照らす）、すぐに `startWriteUpdate` で始める。CREATE の口（`startWriteCreateFn`）と、その入力は
 *   変えない。ジョブの種類は `write-kinds.ts`（`WRITE_CREATE`・`WRITE_UPDATE`）。
 * - T40d（Task 40 の設計書 3.5）: 開始の画面の値に、送り方と、承認した API の指定（API のシナリオだけ。型と名前で、値を持たない）を足した。API の
 *   登録も、form と同じ確かめ（許可、上限、予約、検証の指定）と同じ開始の口（`startWriteCreateFn`）で始める。
 * - 実行の許可の発行を参照する画面のコードは、このファイルだけ（Gate `approval-ssot` の (e)）。
 * - 返す値に、資格情報・Cookie・CSRF のトークン・hidden の値は入らない（シナリオの契約と管理データにない）。日時は ISO 8601。
 */
import { randomUUID } from 'node:crypto';
import { createServerFn } from '@tanstack/react-start';
import {
  CREATE_SCENARIO_KIND,
  UPDATE_SCENARIO_KIND,
  DEFAULT_MAX_CREATES_PER_RUN,
  MAX_WRITES_PER_DAY,
  MIN_WRITE_INTERVAL_MS,
  issueExecutionGrant,
  missingVerificationItemsOf,
  readApiUpdateLedgerBindingRejection,
  readPlannedUpdateTarget,
  readScenario,
  readScenarioApprovalStatus,
  readUsedCumulativeWrites,
  readWriteReservations,
  scenarioTransportOf,
  writeScheduleOf,
  type ApprovalInvalidityReason,
  type ExecutionGrantRejectionReason,
  type ScenarioApiSpec,
  type ScenarioKind,
  type ScenarioLimits,
  type ScenarioRequestShape,
  type ScenarioState,
  type ScenarioTransport,
  type ScenarioVerificationItem,
  type ScenarioView,
} from '../../../../src/control/approval-view.js';
import { readLatestRuleSet, readVerificationVaryingRejectionOf } from '../../../../src/control/data-rules-view.js';
import { concretePathOfTemplate } from '../../../../src/control/discovery-view.js';
import { isProfileOperationAllowed } from '../../../../src/control/execution-policy.js';
import { ACTIVE_AUDIT_JOB_STATES, type AuditJobStartRejectionReason } from '../../../../src/control/job/job-records.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { MINUTE_MS } from '../../../../src/core/time-units.js';
import { shownInvalidityReasonsOf } from '../display/scenarios';
import { auditStartCheckOf, startRejectionViewOf, type AuditStartBlocker, type AuditJobStartRejectionView } from './audit-start-check';
import { localUiAuditJobs } from './audit-jobs';
import { localUiStore } from './control-store';
import { discoveryProfileViewOf, showsOriginsOf, type DiscoveryProfileView } from './discovery-documents';
import { requestOf } from './request-validation';
import { approvalExternalFactsOf } from './scenario-facts';
import { readProfileStart } from './start-check-inputs';
import { isoTimestampOrNull, nowCompactTimestamp } from './timestamps';
import { writeJobKindOf, type WriteJobKind } from './write-kinds';
import { latestWriteChainOfUpdateScenario, recordWriteChain, type WriteChainView } from './write-chain';
import {
  WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS,
  writeChainOfferOf,
  writeChainRetryOf,
  writeChainUpdateDecisionOf,
  type WriteChainOfferInput,
  type WriteChainOfferReason,
  type WriteChainStopReason,
} from './write-chain-policy';
import { readWriteResult, readWriteResults } from '../../../../src/control/actions/write-result-facts.js';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 画面のサーバが、書き込みの開始を拒む理由（閉じた一覧。文言は `WRITE_START_LOCAL_REJECTION_DESCRIPTIONS`）。 */
export const WRITE_START_LOCAL_REJECTION_REASONS = Object.freeze([
  'WRITE_SCENARIO_NOT_FOUND',
  'WRITE_KIND_NOT_CREATE',
  'WRITE_FACTS_UNAVAILABLE',
  // T31h-2: 更新の開始の口に、更新（UPDATE）でないシナリオが来た。
  'WRITE_KIND_NOT_UPDATE',
] as const);
export type WriteStartLocalRejectionReason = (typeof WRITE_START_LOCAL_REJECTION_REASONS)[number];

/**
 * 更新（UPDATE）の開始の画面の確かめる内容（T31h-2）。値は持たない（保つ欄の値・前の値は、ワーカーが画面から読む）。
 * - `plannedTarget`: 更新の予定のレコードの ID（`readPlannedUpdateTarget`。なければ null で、始められない）。
 * - `formPath`・`actionPath`: シナリオの path の型に予定の ID を入れた、更新の画面の path と送り先の path（予定がなければ null）。
 */
export interface WriteStartUpdateView {
  readonly targetCreateScenarioId: string;
  readonly plannedTarget: string | null;
  readonly changedFieldNames: readonly string[];
  readonly keptFieldNames: readonly string[];
  readonly formPath: string | null;
  readonly actionPath: string | null;
}

/**
 * T41g（Task 41 の設計書 3.5.1）: 「登録してから更新する」の、確認のダイアログに出す登録の 1 回（台帳の登録のシナリオの版、送り先、上限の残り）。
 */
export interface WriteChainCreateStepView {
  readonly scenarioId: string;
  readonly revision: number;
  /** 送り先（Origin と path。API は承認した Origin と path の型）。 */
  readonly action: string;
  readonly remaining: number;
  readonly limit: number;
}

/**
 * T41g: 更新のシナリオの開始の画面の「登録してから更新する」（台帳の参照を持つ更新のシナリオだけ。ほかは null）。
 * - `offer`: 出す理由（`writeChainOfferOf`。出さないなら null）。
 * - `createStartable`・`updateStartable`: 台帳の登録のシナリオが始められるか、更新のシナリオが対象のレコードのほかは始められるか（開始の画面と同じ確かめ）。
 * - `startable`: 出す理由があり、両方が始められる（画面の表示の補助。始めてよいかは、開始の要求でサーバが決める）。
 * - `last`: 最後に続けて始めた予定と状態（メモリの中。なければ null）。
 */
export interface WriteChainStartView {
  readonly offer: WriteChainOfferReason | null;
  readonly createStartable: boolean;
  readonly updateStartable: boolean;
  readonly startable: boolean;
  readonly create: WriteChainCreateStepView | null;
  readonly last: WriteChainView | null;
}

/** 開始の画面の値。 */
export interface WriteStartPageView {
  readonly profile: DiscoveryProfileView;
  readonly showOrigins: boolean;
  /** プロファイルで書き込みのジョブを始められるか（書き込みのモードの、ログインを使うプロファイル。`execution-policy.ts`）。 */
  readonly eligible: boolean;
  readonly scenario: {
    readonly scenarioId: string;
    readonly revision: number;
    readonly state: ScenarioState;
    readonly kind: ScenarioKind;
    readonly fieldNames: readonly string[];
    /** form の要求の形（T38b: API のシナリオは null。送り先は `api` の要求の型で示す）。 */
    readonly request: ScenarioRequestShape | null;
    readonly limits: ScenarioLimits;
    /** T40d: 送り方（`scenarioTransportOf`）と、承認した API の指定（API のシナリオだけ。値を持たない型と名前。FORM は null）。 */
    readonly transport: ScenarioTransport;
    readonly api: ScenarioApiSpec | null;
  };
  /** 累積の使った件数（発行の判定と同じ数え方）と残り。 */
  readonly used: number;
  readonly remaining: number;
  /** 次に実行できる時刻（ISO 8601。今実行できるなら null）と、24 時間の窓の中の残り。 */
  readonly nextWriteAllowedAt: string | null;
  readonly remainingInWindow: number;
  /** 連続の上限の決まり（間隔の分、24 時間の件数）。 */
  readonly intervalMinutes: number;
  readonly writesPerDay: number;
  /** 外部への通知が送られないことを、承認の前に確かめたか（副作用の確認の `NO_EXTERNAL_NOTIFICATION`）。 */
  readonly notificationConfirmed: boolean;
  /** プロファイルに環境の証跡の参照があるか（値は返さない）。 */
  readonly evidencePresent: boolean;
  /** 検証の指定の未指定の項目（空なら、すべて決まっている）。 */
  readonly missingVerification: readonly ScenarioVerificationItem[];
  /** T31h-2: 更新（UPDATE）の確かめる内容（UPDATE の指定のある UPDATE のシナリオだけ。ほかは null）。 */
  readonly update: WriteStartUpdateView | null;
  /** 承認が今有効か（管理データの外の事実を求められなければ null）と、再承認が要る理由。 */
  readonly approved: boolean | null;
  readonly invalidityReasons: readonly ApprovalInvalidityReason[];
  /** ジョブの管理と同じ開始の前の確かめで止まる理由（なければ null）。 */
  readonly startBlocker: AuditStartBlocker | 'JOB_ALREADY_ACTIVE' | null;
  /**
   * T40R2-fix（M-1）: 送る値のない照合の READ の期待が、実行のたびに変わる値と比べない理由（許可の発行と同じ判定 `readVerificationVaryingRejectionOf`。
   * 比べる、対象の外、入力の規則がまだないときは null）。
   */
  readonly readVerificationVaryingRejection: 'READ_VERIFICATION_NOT_VARYING' | null;
  /**
   * T41e-2（Task 41 の設計書 3.2）: API の更新の台帳の結び付きが外れて、許可を出さない理由（発行の確かめ直しと同じ部品 `readApiUpdateLedgerBindingRejection`。
   * API の更新でない・結び付くときは null）。
   */
  readonly ledgerBindingRejection: ExecutionGrantRejectionReason | null;
  /** T41g: 「登録してから更新する」（台帳の参照を持つ更新のシナリオだけ。ほかは null）。 */
  readonly chain: WriteChainStartView | null;
  /** 今始められるか（画面の表示の補助。始めてよいかは、開始の要求でサーバが決める）。 */
  readonly startable: boolean;
}

/** 開始の結果。 */
export type WriteStartView =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly stage: 'LOCAL'; readonly reason: WriteStartLocalRejectionReason }
  | {
    readonly ok: false;
    readonly stage: 'GRANT';
    readonly reason: ExecutionGrantRejectionReason;
    readonly invalidityReasons: readonly ApprovalInvalidityReason[];
  }
  | ({ readonly ok: false; readonly stage: 'START' } & AuditJobStartRejectionView)
  // T41g: 「登録してから更新する」を、何も始めずに拒んだ（両方が始められる状態でない、出す理由がない、画面の版が違う）。
  | { readonly ok: false; readonly stage: 'CHAIN'; readonly reason: WriteChainStartRejectionReason };

/** T41g: 「登録してから更新する」を何も始めずに拒む理由（閉じた一覧。文言は `LOCAL_UI_WRITE_TEXT.chain.startRejections`）。 */
export const WRITE_CHAIN_START_REJECTION_REASONS = Object.freeze(['CHAIN_NOT_OFFERED', 'CREATE_NOT_STARTABLE', 'UPDATE_NOT_STARTABLE'] as const);
export type WriteChainStartRejectionReason = (typeof WRITE_CHAIN_START_REJECTION_REASONS)[number];

// ---------------------------------------------------------------------------------------------------------------
// 値の組み立て
// ---------------------------------------------------------------------------------------------------------------

/** 登録・更新のシナリオの種類（T31h-2。CC-106: 種類の一覧の owner の名前つきの定数）。 */
const CREATE_KIND = CREATE_SCENARIO_KIND;
const UPDATE_KIND = UPDATE_SCENARIO_KIND;
/** 開始の口とシナリオの種類が違うときの、画面のサーバの拒む理由（T31h-2）。 */
const KIND_MISMATCH_REASON = Object.freeze({
  CREATE: 'WRITE_KIND_NOT_CREATE',
  UPDATE: 'WRITE_KIND_NOT_UPDATE',
} as const satisfies Record<ScenarioKind, WriteStartLocalRejectionReason>);
/** 外部への通知の確認の項目。 */
const NOTIFICATION_CONFIRMATION = 'NO_EXTERNAL_NOTIFICATION';
/** 終わっていないジョブがあるときの、ジョブの管理と同じ拒む理由。 */
const JOB_ALREADY_ACTIVE = 'JOB_ALREADY_ACTIVE' satisfies AuditJobStartRejectionReason;
/** 1 回の Run で予約する件数（登録を 1 件。既定の 1 回の Run の上限と同じ値）。 */
const WRITE_COUNT_PER_RUN = DEFAULT_MAX_CREATES_PER_RUN;
/** 終わっていないジョブの状態。 */
const ACTIVE_STATES: ReadonlySet<string> = new Set(ACTIVE_AUDIT_JOB_STATES);

// 今の時刻（管理データの UTC の 14 桁）は `timestamps.ts` の `nowCompactTimestamp`（CC-109。前の `nowStamp` は、使う所が実行の許可の発行の 1 か所
// だけなので時刻の名前を中に持っていた。意味は同じなので寄せた）。

/** シナリオとプロファイル（どちらかがなければ null）。 */
const scenarioWithProfileOf = (scenarioId: string): { readonly scenario: ScenarioView; readonly stored: StoredProfile } | null => {
  const scenario = readScenario(localUiStore(), scenarioId);
  const stored = scenario === null ? null : getProfile(localUiStore(), scenario.profileId);
  return scenario === null || stored === null ? null : { scenario, stored };
};

/** 終わっていないジョブがあるか（ジョブの管理は同時に 1 つだけ）。 */
const hasActiveJob = (): boolean => localUiAuditJobs().listAuditJobs().some((job) => ACTIVE_STATES.has(job.state));

/** ジョブの管理と同じ開始の前の確かめ（書き込みのジョブ。T31h-2: その種類の行）と、終わっていないジョブ。止まらなければ null。 */
const startBlockerOf = async (profileId: string, jobKind: WriteJobKind): Promise<AuditStartBlocker | 'JOB_ALREADY_ACTIVE' | null> =>
  (await startCheckOf(profileId, jobKind)).blocker;

/**
 * 開始の前の確かめの理由と、次に始められる時刻（T41g-3。`AUTO_LOGIN_RATE_LIMITED` のときだけ ISO 8601。ジョブの管理と同じ確かめ `auditStartCheckOf` の値）。
 */
const startCheckOf = async (
  profileId: string,
  jobKind: WriteJobKind,
): Promise<{ readonly blocker: AuditStartBlocker | 'JOB_ALREADY_ACTIVE' | null; readonly nextAllowedAt: string | null }> => {
  const reading = await readProfileStart(profileId);
  const check = reading === null ? null : auditStartCheckOf({ ...reading.checkInput, jobKind });
  if (check !== null && check.blocker !== null) {
    return { blocker: check.blocker, nextAllowedAt: check.nextAllowedAt };
  }
  return { blocker: hasActiveJob() ? JOB_ALREADY_ACTIVE : null, nextAllowedAt: null };
};

/** 更新（UPDATE）の確かめる内容（UPDATE の指定のない版と、登録のシナリオは null）。 */
const updateViewOf = (scenario: ScenarioView): WriteStartUpdateView | null => {
  const { current } = scenario;
  const apiLedger = current.api?.ledger ?? null;
  if (current.kind === UPDATE_KIND && current.api !== undefined && apiLedger !== null) {
    // T41e（Task 41 の設計書 3.2、3.5）: API の更新。予定のレコードは同じ唯一の読み出し（`readPlannedUpdateTarget`）。送り先は、承認した API の path の型
    // （対象の行は filter が選ぶ）。変える鍵と保つ鍵は API の指定から。
    const planned = readPlannedUpdateTarget(localUiStore(), scenario.scenarioId);
    return {
      targetCreateScenarioId: apiLedger.targetCreateScenarioId,
      plannedTarget: planned,
      changedFieldNames: current.api.keyFields.map(({ key }) => key),
      keptFieldNames: (current.api.keptKeys ?? []).map(({ key }) => key),
      formPath: planned === null ? null : concretePathOfTemplate(apiLedger.formPathTemplate, planned),
      actionPath: current.api.request.pathShape,
    };
  }
  if (current.kind !== UPDATE_KIND || current.update === null) {
    return null;
  }
  const plannedTarget = readPlannedUpdateTarget(localUiStore(), scenario.scenarioId);
  return {
    targetCreateScenarioId: current.update.targetCreateScenarioId,
    plannedTarget,
    changedFieldNames: [...current.fieldNames],
    keptFieldNames: [...current.update.keepFieldNames],
    formPath: plannedTarget === null ? null : concretePathOfTemplate(current.update.formPathTemplate, plannedTarget),
    actionPath: plannedTarget === null ? null : concretePathOfTemplate(current.update.actionPathTemplate, plannedTarget),
  };
};

/** 書き込む相手が決まっているか（登録はいつも。更新は、予定のレコードと、その画面の path と送り先の path がある）。 */
const hasWriteTarget = (kind: ScenarioKind, update: WriteStartUpdateView | null): boolean =>
  kind === CREATE_KIND || (update !== null && update.plannedTarget !== null && update.formPath !== null && update.actionPath !== null);

/** 開始の画面の値（T41g の `chain` を除く）と、対象のレコードのほかは始められるか（T41g。「登録してから更新する」の確かめ）。 */
interface StartFacts {
  readonly view: Omit<WriteStartPageView, 'chain'>;
  readonly startableExceptTarget: boolean;
}

/** 開始の画面の値（T41g の `chain` を除く）。 */
const startFactsOf = async (scenario: ScenarioView, stored: StoredProfile): Promise<StartFacts> => {
  const now = new Date();
  const { current } = scenario;
  const { profile } = stored;
  const used = readUsedCumulativeWrites(localUiStore(), scenario.scenarioId, now);
  const schedule = writeScheduleOf(readWriteReservations(localUiStore(), scenario.scenarioId), now);
  const external = await approvalExternalFactsOf(stored);
  const status = external === null ? null : readScenarioApprovalStatus(localUiStore(), scenario.scenarioId, external, now);
  const jobKind = writeJobKindOf(current.kind);
  const eligible = isProfileOperationAllowed(jobKind, profile.mode, profile.auth);
  // T40a-fix: 求める項目は送り方で決まる（API は照合の READ と ID の取り方だけ。発行の口と同じ判定）。
  const missingVerification = [...missingVerificationItemsOf(current.verification, current)];
  const startBlocker = await startBlockerOf(profile.profileId, jobKind);
  const update = updateViewOf(scenario);
  const remaining = Math.max(0, current.limits.maxCumulativeCreates - used);
  const evidencePresent = (profile.environmentEvidenceRef ?? '').trim().length > 0;
  const notificationConfirmed = current.sideEffectConfirmations[NOTIFICATION_CONFIRMATION];
  const approved = status === null ? null : status.validity.approved;
  // T41e-2: API の更新の台帳の結び付き（発行の確かめ直しと同じ部品）。
  const ledgerBindingRejection = readApiUpdateLedgerBindingRejection(localUiStore(), scenario.scenarioId);
  // T40R2-fix（M-1）: 許可の発行と同じ判定（入力の規則の最新の版があるときだけ。規則がなければ、発行が `NEEDS_RULE_INPUT` で止める）。
  const latestRules = readLatestRuleSet(localUiStore(), scenario.scenarioId);
  const readVerificationVaryingRejection = latestRules === null
    ? null
    : readVerificationVaryingRejectionOf(latestRules.ruleSet, current, scenario.evidence);
  // T41g: 書き込む相手（更新の予定のレコード）のほかの確かめ（「登録してから更新する」は、相手のない更新もこの確かめで始められるかを見る）。
  const startableExceptTarget = eligible && approved === true && missingVerification.length === 0 && notificationConfirmed
    && evidencePresent && schedule.nextWriteAllowedAt === null && remaining > 0 && startBlocker === null
    && readVerificationVaryingRejection === null && ledgerBindingRejection === null;
  const view: Omit<WriteStartPageView, 'chain'> = {
    profile: discoveryProfileViewOf(stored),
    showOrigins: showsOriginsOf(stored),
    eligible,
    scenario: {
      scenarioId: scenario.scenarioId,
      revision: scenario.revision,
      state: scenario.state,
      kind: current.kind,
      fieldNames: [...current.fieldNames],
      request: current.request === null ? null : { ...current.request },
      limits: { ...current.limits },
      transport: scenarioTransportOf(current),
      api: current.api === undefined ? null : structuredClone(current.api) as ScenarioApiSpec,
    },
    used,
    remaining,
    nextWriteAllowedAt: isoTimestampOrNull(schedule.nextWriteAllowedAt),
    remainingInWindow: schedule.remainingInWindow,
    intervalMinutes: MIN_WRITE_INTERVAL_MS / MINUTE_MS,
    writesPerDay: MAX_WRITES_PER_DAY,
    notificationConfirmed,
    evidencePresent,
    missingVerification,
    update,
    approved,
    invalidityReasons: status === null ? [] : [...shownInvalidityReasonsOf(status.validity)],
    startBlocker,
    readVerificationVaryingRejection,
    ledgerBindingRejection,
    startable: startableExceptTarget && hasWriteTarget(current.kind, update),
  };
  return { view, startableExceptTarget };
};

/** T41g: 送り先の表示（API は承認した Origin と path の型、form は送信先の Origin と path）。 */
const actionTextOf = (scenario: ScenarioView): string => {
  const { current } = scenario;
  if (current.api !== undefined) {
    return `${current.api.request.origin}${current.api.request.pathShape}`;
  }
  return current.request === null ? '' : `${current.request.origin}${current.request.path}`;
};

/** T41g: 更新のシナリオの、最後の書き込みの結果（前の更新が止まったかの判定に使う。なければ null）。 */
const lastUpdateOf = (scenarioId: string): WriteChainOfferInput['lastUpdate'] => {
  const last = readWriteResults(localUiStore(), scenarioId).at(-1);
  return last === undefined ? null : { targetRecordId: last.targetRecordId, result: last.result };
};

/**
 * T41g（Task 41 の設計書 3.5.1）: 「登録してから更新する」の開始の画面の値（台帳の参照を持つ更新のシナリオだけ）。台帳の登録のシナリオは、今の開始の画面と
 * 同じ確かめ（`startFactsOf`）で始められるかを見る。更新のシナリオは、対象のレコードのほかの確かめ（`startableExceptTarget`）で見る。
 */
const chainStartOf = async (
  scenario: ScenarioView,
  stored: StoredProfile,
  update: WriteStartUpdateView | null,
  updateStartable: boolean,
): Promise<WriteChainStartView | null> => {
  if (update === null) {
    return null;
  }
  const ledger = readScenario(localUiStore(), update.targetCreateScenarioId);
  const ledgerFacts = ledger === null || ledger.profileId !== stored.profile.profileId ? null : await startFactsOf(ledger, stored);
  const offer = writeChainOfferOf({ plannedTarget: update.plannedTarget, lastUpdate: lastUpdateOf(scenario.scenarioId) });
  const createStartable = ledger !== null && ledgerFacts !== null && ledger.current.kind === CREATE_KIND && ledgerFacts.view.startable;
  return {
    offer,
    createStartable,
    updateStartable,
    startable: offer !== null && createStartable && updateStartable,
    create: ledger === null || ledgerFacts === null
      ? null
      : {
        scenarioId: ledger.scenarioId,
        revision: ledger.revision,
        action: actionTextOf(ledger),
        remaining: ledgerFacts.view.remaining,
        limit: ledger.current.limits.maxCumulativeCreates,
      },
    last: latestWriteChainOfUpdateScenario(scenario.scenarioId),
  };
};

/** 開始の画面の値（T41g: 「登録してから更新する」を含む）。 */
const startPageOf = async (scenario: ScenarioView, stored: StoredProfile): Promise<WriteStartPageView> => {
  const facts = await startFactsOf(scenario, stored);
  return { ...facts.view, chain: await chainStartOf(scenario, stored, facts.view.update, facts.startableExceptTarget) };
};

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface ScenarioKeyRequest {
  readonly scenarioId: string;
}
/** 開始の要求（シナリオと、画面が読んだ版。形は専用のスキーマ `ui-write-start` で確かめる。T30g fix round 1）。 */
interface WriteStartRequest {
  readonly scenarioId: string;
  readonly expectedRevision: number;
}
/**
 * T41g-3（T41R5 の M-1）: 「登録してから更新する」の要求（更新のシナリオと画面が読んだ版に、画面が読んだ台帳の登録のシナリオの版を足す。形は専用のスキーマ
 * `ui-write-chain-start` で確かめる）。
 */
interface WriteChainStartRequest extends WriteStartRequest {
  readonly expectedCreateRevision: number;
}
/** 更新の開始の要求（T31h-2。画面が見せた予定のレコードの ID を足す。形は専用のスキーマ `ui-write-update-start` で確かめる）。 */
interface WriteUpdateStartRequest extends WriteStartRequest {
  readonly expectedTargetRecordId: string;
}

/**
 * 書き込みを始める（CREATE と UPDATE の共通の部品。T31h-2）。シナリオの種類が口の種類と違えば、画面のサーバが拒む。開始の前の確かめの後に実行の
 * 許可を発行し（UPDATE は画面が見せた予定の ID を渡す）、すぐにその種類の書き込みのジョブを始める。
 */
const startWrite = async (kind: ScenarioKind, data: WriteStartRequest, expectedTargetRecordId: string | null): Promise<WriteStartView> => {
  const found = scenarioWithProfileOf(data.scenarioId);
  if (found === null) {
    return { ok: false, stage: 'LOCAL', reason: 'WRITE_SCENARIO_NOT_FOUND' };
  }
  const { scenario, stored } = found;
  if (scenario.current.kind !== kind) {
    return { ok: false, stage: 'LOCAL', reason: KIND_MISMATCH_REASON[kind] };
  }
  // 開始の前の確かめで止まるときは、許可を発行しない（使わない許可の予約を残さない）。
  // T41g-3: 自動ログインの間隔で止めたときは、次に始められる時刻も返す（「登録してから更新する」が、その時刻まで待ってやり直す）。
  const { blocker, nextAllowedAt } = await startCheckOf(stored.profile.profileId, writeJobKindOf(kind));
  if (blocker !== null) {
    return { ok: false, stage: 'START', reason: blocker, errorCodes: [], authSetupErrors: [], ...(nextAllowedAt === null ? {} : { nextAllowedAt }) };
  }
  const external = await approvalExternalFactsOf(stored);
  if (external === null) {
    return { ok: false, stage: 'LOCAL', reason: 'WRITE_FACTS_UNAVAILABLE' };
  }
  const grantId = randomUUID();
  const issued = issueExecutionGrant(localUiStore(), {
    scenarioId: scenario.scenarioId,
    expectedRevision: data.expectedRevision,
    grantId,
    jobId: randomUUID(),
    count: WRITE_COUNT_PER_RUN,
    ...(expectedTargetRecordId === null ? {} : { expectedTargetRecordId }),
    external,
    at: nowCompactTimestamp('execution grant issue time'),
  });
  if (!issued.ok) {
    return { ok: false, stage: 'GRANT', reason: issued.reason, invalidityReasons: [...issued.invalidityReasons] };
  }
  const request = { profileId: stored.profile.profileId, expectedRevision: stored.profile.revision, scenarioId: scenario.scenarioId, grantId };
  const started = kind === UPDATE_KIND ? await localUiAuditJobs().startWriteUpdate(request) : await localUiAuditJobs().startWriteCreate(request);
  return started.ok ? { ok: true, jobId: started.job.jobId } : { ok: false, stage: 'START', ...startRejectionViewOf(started) };
};

// ---------------------------------------------------------------------------------------------------------------
// T41g（Task 41 の設計書 3.5.1）: 登録してから更新する
// ---------------------------------------------------------------------------------------------------------------

/** 登録のジョブの終わりを確かめる間隔（ms。ジョブの管理の状態の読み出しを、この間隔で繰り返す）。 */
const WRITE_CHAIN_POLL_INTERVAL_MS = 500;
/** 登録のジョブの終わりを待つ上限（ms。過ぎたら更新を始めない）。 */
const WRITE_CHAIN_WAIT_LIMIT_MS = 60 * MINUTE_MS;
/** T41g-3: 自動ログインの間隔を待った後、次に始められる時刻から、やり直しまでに足す余裕（ms。時刻の丸めで、また間隔に当たらないため）。 */
const WRITE_CHAIN_RETRY_MARGIN_MS = 1_000;

/** 登録のジョブが終わるまで待つ（ジョブの管理の今の口 `getAuditJob` を間隔を置いて読む）。上限までに終われば真。 */
const waitForJobEnd = async (jobId: string): Promise<boolean> => {
  const deadline = Date.now() + WRITE_CHAIN_WAIT_LIMIT_MS;
  for (;;) {
    const job = localUiAuditJobs().getAuditJob(jobId);
    if (job === null || !ACTIVE_STATES.has(job.state)) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, WRITE_CHAIN_POLL_INTERVAL_MS));
  }
};

/**
 * 登録のジョブの後に、続けて更新を始める（始めた後の続き。画面の要求には待たずに答える）。登録のジョブが終わったら、その結果と、更新の予定の対象
 * （`readPlannedUpdateTarget`）を `writeChainUpdateDecisionOf` で照らし、始めるときだけ、今の口（`startWrite` の UPDATE。予定の ID を渡す）で始める。
 */
const continueWriteChain = async (chain: WriteChainView, updateRevision: number): Promise<void> => {
  const stop = (reason: WriteChainStopReason): void =>
    recordWriteChain({ ...chain, state: 'NOT_STARTED', reason, updateJobId: null, nextStartAt: null });
  try {
    if (!await waitForJobEnd(chain.createJobId)) {
      stop('CREATE_WAIT_TIMEOUT');
      return;
    }
    const created = readWriteResult(localUiStore(), chain.createJobId);
    const decision = writeChainUpdateDecisionOf({
      createResult: created?.result ?? null,
      createRecordId: created?.recordId ?? null,
      plannedTarget: readPlannedUpdateTarget(localUiStore(), chain.updateScenarioId),
    });
    if (decision.kind === 'STOP') {
      stop(decision.reason);
      return;
    }
    const startUpdate = (): Promise<WriteStartView> =>
      startWrite(UPDATE_KIND, { scenarioId: chain.updateScenarioId, expectedRevision: updateRevision }, decision.targetRecordId);
    let started = await startUpdate();
    if (!started.ok) {
      // T41g-3（Task 41 の設計書 3.5.1 の末尾）: 自動ログインの最小の間隔で止まったときだけ、次に始められる時刻まで待ってから、開始の前の確かめと許可の
      // 発行を 1 回だけやり直す（許可は待った後にだけ発行する。`startWrite` は開始の前の確かめで止まると許可を発行しない）。
      const retry = writeChainRetryOf(started, new Date(), WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS);
      if (retry.kind === 'STOP') {
        stop('UPDATE_START_REJECTED');
        return;
      }
      recordWriteChain({ ...chain, state: 'WAITING_LOGIN_INTERVAL', reason: null, updateJobId: null, nextStartAt: retry.until });
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(0, new Date(retry.until).getTime() - Date.now()) + WRITE_CHAIN_RETRY_MARGIN_MS));
      started = await startUpdate();
    }
    if (started.ok) {
      recordWriteChain({ ...chain, state: 'UPDATE_STARTED', reason: null, updateJobId: started.jobId, nextStartAt: null });
    } else {
      stop('UPDATE_START_REJECTED');
    }
  } catch {
    // 続きの中の予期しない誤りでは、更新を始めない（安全側）。
    stop('UPDATE_START_REJECTED');
  }
};

/**
 * 登録してから更新する（確認のダイアログの後。POST の口から）。更新のシナリオの開始の画面と同じ確かめで、台帳の登録のシナリオが始められ、更新のシナリオが
 * 対象のレコードのほかは始められることを確かめる。どちらかが始められなければ、何も始めない（許可を発行しない）。登録は今の口（`startWrite` の CREATE）で
 * 始め、予定と状態をメモリに書いて、続き（`continueWriteChain`）を待たずに登録のジョブの id を返す。
 */
const startWriteCreateThenUpdate = async (data: WriteChainStartRequest): Promise<WriteStartView> => {
  const found = scenarioWithProfileOf(data.scenarioId);
  if (found === null) {
    return { ok: false, stage: 'LOCAL', reason: 'WRITE_SCENARIO_NOT_FOUND' };
  }
  const { scenario, stored } = found;
  if (scenario.current.kind !== UPDATE_KIND) {
    return { ok: false, stage: 'LOCAL', reason: KIND_MISMATCH_REASON.UPDATE };
  }
  const page = await startPageOf(scenario, stored);
  const chain = page.chain;
  if (chain === null || chain.create === null || chain.offer === null) {
    return { ok: false, stage: 'CHAIN', reason: 'CHAIN_NOT_OFFERED' };
  }
  if (!chain.updateStartable || scenario.revision !== data.expectedRevision) {
    return { ok: false, stage: 'CHAIN', reason: 'UPDATE_NOT_STARTABLE' };
  }
  if (!chain.createStartable) {
    return { ok: false, stage: 'CHAIN', reason: 'CREATE_NOT_STARTABLE' };
  }
  // T41g-3（T41R5 の M-1）: 登録の許可の発行には、画面が読んだ台帳の登録のシナリオの版を渡す（違えば `GRANT_REVISION_CONFLICT` で何も始めない）。
  const created = await startWrite(CREATE_KIND, { scenarioId: chain.create.scenarioId, expectedRevision: data.expectedCreateRevision }, null);
  if (!created.ok) {
    return created;
  }
  const record: WriteChainView = {
    createJobId: created.jobId,
    createScenarioId: chain.create.scenarioId,
    updateScenarioId: scenario.scenarioId,
    state: 'CREATING',
    reason: null,
    updateJobId: null,
    nextStartAt: null,
  };
  recordWriteChain(record);
  void continueWriteChain(record, data.expectedRevision);
  return created;
};

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** 書き込みの開始の画面の値（読むだけ）。シナリオがなければ `null`。 */
export const writeStartPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ScenarioKeyRequest>('ui-scenario-key'))
  .handler(async ({ data }): Promise<WriteStartPageView | null> => {
    const found = scenarioWithProfileOf(data.scenarioId);
    return found === null ? null : startPageOf(found.scenario, found.stored);
  });

/**
 * 書き込みを始める（確認のダイアログの後。POST だけ）。開始の前の確かめの後に実行の許可を発行し、すぐに書き込みのジョブを始める。拒むときは、
 * どの段で拒んだか（画面のサーバ・許可の発行・ジョブの管理）と理由を返す（英語の詳しい文は返さない）。
 */
export const startWriteCreateFn = createServerFn({ method: 'POST' })
  .validator(requestOf<WriteStartRequest>('ui-write-start'))
  .handler(({ data }): Promise<WriteStartView> => startWrite(CREATE_KIND, data, null));

/**
 * 更新（UPDATE）を始める（T31h-2。確認のダイアログの後。POST だけ）。画面が見せた予定のレコードの ID を発行に渡す（発行の中で選び直した ID と違えば
 * `TARGET_SELECTION_CHANGED`、対象がなければ `TARGET_RECORD_UNAVAILABLE`）。ほかは `startWriteCreateFn` と同じ。
 */
export const startWriteUpdateFn = createServerFn({ method: 'POST' })
  .validator(requestOf<WriteUpdateStartRequest>('ui-write-update-start'))
  .handler(({ data }): Promise<WriteStartView> =>
    startWrite(UPDATE_KIND, { scenarioId: data.scenarioId, expectedRevision: data.expectedRevision }, data.expectedTargetRecordId));

/**
 * T41g（Task 41 の設計書 3.5.1）: 登録してから更新する（更新のシナリオの開始の画面の確認のダイアログの後。POST だけ。CSRF は画面のサーバの middleware が
 * 確かめる）。入力は更新のシナリオと画面が読んだ版で、形は開始と同じスキーマ `ui-write-start` で確かめる。始めたら登録のジョブの id を返す。
 */
export const startWriteCreateThenUpdateFn = createServerFn({ method: 'POST' })
  .validator(requestOf<WriteChainStartRequest>('ui-write-chain-start'))
  .handler(({ data }): Promise<WriteStartView> => startWriteCreateThenUpdate(data));

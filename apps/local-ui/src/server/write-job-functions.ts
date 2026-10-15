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
 * - 実行の許可の発行を参照する画面のコードは、このファイルだけ（Gate `approval-ssot` の (e)）。
 * - 返す値に、資格情報・Cookie・CSRF のトークン・hidden の値は入らない（シナリオの契約と管理データにない）。日時は ISO 8601。
 */
import { randomUUID } from 'node:crypto';
import { createServerFn } from '@tanstack/react-start';
import {
  DEFAULT_MAX_CREATES_PER_RUN,
  MAX_WRITES_PER_DAY,
  MIN_WRITE_INTERVAL_MS,
  issueExecutionGrant,
  missingVerificationItemsOf,
  readPlannedUpdateTarget,
  readScenario,
  readScenarioApprovalStatus,
  readUsedCumulativeWrites,
  readWriteReservations,
  writeScheduleOf,
  type ApprovalInvalidityReason,
  type ExecutionGrantRejectionReason,
  type ScenarioKind,
  type ScenarioLimits,
  type ScenarioRequestShape,
  type ScenarioState,
  type ScenarioVerificationItem,
  type ScenarioView,
} from '../../../../src/control/approval-view.js';
import { concretePathOfTemplate } from '../../../../src/control/discovery-view.js';
import { isProfileOperationAllowed } from '../../../../src/control/execution-policy.js';
import { ACTIVE_AUDIT_JOB_STATES, type AuditJobStartRejectionReason } from '../../../../src/control/job/job-records.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { MINUTE_MS } from '../../../../src/core/time-units.js';
import { formatCompactUtcTimestamp } from '../../../../src/core/utc-timestamp.js';
import { shownInvalidityReasonsOf } from '../display/scenarios';
import { auditStartCheckOf, startRejectionViewOf, type AuditStartBlocker, type AuditJobStartRejectionView } from './audit-start-check';
import { localUiAuditJobs } from './audit-jobs';
import { localUiStore } from './control-store';
import { discoveryProfileViewOf, showsOriginsOf, type DiscoveryProfileView } from './discovery-documents';
import { requestOf } from './request-validation';
import { approvalExternalFactsOf } from './scenario-facts';
import { readProfileStart } from './start-check-inputs';
import { isoTimestampOrNull } from './timestamps';
import { writeJobKindOf, type WriteJobKind } from './write-kinds';

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
    readonly request: ScenarioRequestShape;
    readonly limits: ScenarioLimits;
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
  | ({ readonly ok: false; readonly stage: 'START' } & AuditJobStartRejectionView);

// ---------------------------------------------------------------------------------------------------------------
// 値の組み立て
// ---------------------------------------------------------------------------------------------------------------

/** 登録のシナリオの種類。 */
const CREATE_KIND = 'CREATE' satisfies ScenarioKind;
/** 更新のシナリオの種類（T31h-2）。 */
const UPDATE_KIND = 'UPDATE' satisfies ScenarioKind;
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

/** 今の時刻（管理データの UTC の 14 桁）。 */
const nowStamp = (): string => formatCompactUtcTimestamp(new Date(), 'execution grant issue time');

/** シナリオとプロファイル（どちらかがなければ null）。 */
const scenarioWithProfileOf = (scenarioId: string): { readonly scenario: ScenarioView; readonly stored: StoredProfile } | null => {
  const scenario = readScenario(localUiStore(), scenarioId);
  const stored = scenario === null ? null : getProfile(localUiStore(), scenario.profileId);
  return scenario === null || stored === null ? null : { scenario, stored };
};

/** 終わっていないジョブがあるか（ジョブの管理は同時に 1 つだけ）。 */
const hasActiveJob = (): boolean => localUiAuditJobs().listAuditJobs().some((job) => ACTIVE_STATES.has(job.state));

/** ジョブの管理と同じ開始の前の確かめ（書き込みのジョブ。T31h-2: その種類の行）と、終わっていないジョブ。止まらなければ null。 */
const startBlockerOf = async (profileId: string, jobKind: WriteJobKind): Promise<AuditStartBlocker | 'JOB_ALREADY_ACTIVE' | null> => {
  const reading = await readProfileStart(profileId);
  const blocker = reading === null ? null : auditStartCheckOf({ ...reading.checkInput, jobKind }).blocker;
  if (blocker !== null) {
    return blocker;
  }
  return hasActiveJob() ? JOB_ALREADY_ACTIVE : null;
};

/** 更新（UPDATE）の確かめる内容（UPDATE の指定のない版と、登録のシナリオは null）。 */
const updateViewOf = (scenario: ScenarioView): WriteStartUpdateView | null => {
  const { current } = scenario;
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

/** 開始の画面の値。 */
const startPageOf = async (scenario: ScenarioView, stored: StoredProfile): Promise<WriteStartPageView> => {
  const now = new Date();
  const { current } = scenario;
  const { profile } = stored;
  const used = readUsedCumulativeWrites(localUiStore(), scenario.scenarioId, now);
  const schedule = writeScheduleOf(readWriteReservations(localUiStore(), scenario.scenarioId), now);
  const external = await approvalExternalFactsOf(stored);
  const status = external === null ? null : readScenarioApprovalStatus(localUiStore(), scenario.scenarioId, external, now);
  const jobKind = writeJobKindOf(current.kind);
  const eligible = isProfileOperationAllowed(jobKind, profile.mode, profile.auth);
  const missingVerification = [...missingVerificationItemsOf(current.verification)];
  const startBlocker = await startBlockerOf(profile.profileId, jobKind);
  const update = updateViewOf(scenario);
  const remaining = Math.max(0, current.limits.maxCumulativeCreates - used);
  const evidencePresent = (profile.environmentEvidenceRef ?? '').trim().length > 0;
  const notificationConfirmed = current.sideEffectConfirmations[NOTIFICATION_CONFIRMATION];
  const approved = status === null ? null : status.validity.approved;
  return {
    profile: discoveryProfileViewOf(stored),
    showOrigins: showsOriginsOf(stored),
    eligible,
    scenario: {
      scenarioId: scenario.scenarioId,
      revision: scenario.revision,
      state: scenario.state,
      kind: current.kind,
      fieldNames: [...current.fieldNames],
      request: { ...current.request },
      limits: { ...current.limits },
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
    startable: eligible && hasWriteTarget(current.kind, update) && approved === true && missingVerification.length === 0 && notificationConfirmed
      && evidencePresent && schedule.nextWriteAllowedAt === null && remaining > 0 && startBlocker === null,
  };
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
  const blocker = await startBlockerOf(stored.profile.profileId, writeJobKindOf(kind));
  if (blocker !== null) {
    return { ok: false, stage: 'START', reason: blocker, errorCodes: [], authSetupErrors: [] };
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
    at: nowStamp(),
  });
  if (!issued.ok) {
    return { ok: false, stage: 'GRANT', reason: issued.reason, invalidityReasons: [...issued.invalidityReasons] };
  }
  const request = { profileId: stored.profile.profileId, expectedRevision: stored.profile.revision, scenarioId: scenario.scenarioId, grantId };
  const started = kind === UPDATE_KIND ? await localUiAuditJobs().startWriteUpdate(request) : await localUiAuditJobs().startWriteCreate(request);
  return started.ok ? { ok: true, jobId: started.job.jobId } : { ok: false, stage: 'START', ...startRejectionViewOf(started) };
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

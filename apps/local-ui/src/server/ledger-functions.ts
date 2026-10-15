/**
 * 監査済みデータの台帳の画面の Server Function（T32g。Task 32 の設計書 4.1 の「監査済みデータの台帳」。ロードマップ 13.4）。読むだけ。
 * - 台帳の行の読み出しは `src/control/actions/write-result-facts.ts` の `readAuditedDataLedger`（書き込みの結果の表の読み出しの owner。画面は管理
 *   データを直接読まない）。累計の件数は、発行の判定と同じ数え方（`readUsedCumulativeWrites`）。上限はシナリオの今の版の値。
 * - 書き込みのモードのプロファイル（`usesScenarios`）だけ、台帳の行を返す。ほかのプロファイルは、行を返さず `eligible` を偽にする（画面が理由を
 *   出す）。プロファイルがなければ `null`。
 * - seed の記録は、許可の ID と入力の規則の集まりの digest だけ（seed の値・基準日・試行の番号は返さない）。送った値も返さない。日時は ISO 8601。
 * - 台帳の書き出し（ファイル）は作らない（設計者の判断。画面だけ）。
 */
import { createServerFn } from '@tanstack/react-start';
import type {
  ActionResult,
  SettledReservationState,
  SubmissionState,
} from '../../../../src/control/actions/action-contracts.js';
import { readAuditedDataLedger, type AuditedDataLedgerEntry } from '../../../../src/control/actions/write-result-facts.js';
import { listScenarios, readUsedCumulativeWrites, type ScenarioKind } from '../../../../src/control/approval-view.js';
import type { ReadCheckResult } from '../../../../src/control/discovery-view.js';
import { getProfile } from '../../../../src/control/store/profile-store.js';
import { usesScenarios } from '../display/labels';
import { localUiStore } from './control-store';
import { discoveryProfileViewOf, type DiscoveryProfileView } from './discovery-documents';
import { requestOf } from './request-validation';
import { isoTimestampOf } from './timestamps';

/** 台帳の 1 行（CREATE の書き込み 1 件。新しい順）。 */
export interface LedgerEntryView {
  readonly jobId: string;
  readonly runId: string | null;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  /** 登録の ID（取れていなければ null）。 */
  readonly recordId: string | null;
  /** seed の記録の ID と digest（許可の ID と、入力の規則の集まりの digest）。 */
  readonly seed: { readonly executionGrantId: string; readonly ruleSetDigest: string } | null;
  readonly submission: SubmissionState | null;
  readonly result: ActionResult | null;
  readonly readVerification: ReadCheckResult | null;
  readonly reservationState: SettledReservationState | null;
  readonly recordedAt: string;
  /** その ID への UPDATE の回数と、最後の 1 回の結果（締める前は null）とジョブ。 */
  readonly updates: {
    readonly count: number;
    readonly lastResult: ActionResult | null;
    readonly lastJobId: string | null;
  };
}

/** 台帳の、シナリオごとの累計の件数と上限。 */
export interface LedgerScenarioView {
  readonly scenarioId: string;
  readonly kind: ScenarioKind;
  readonly revision: number;
  /** 累計の使った件数（発行の判定と同じ数え方）。 */
  readonly used: number;
  /** 累計の上限（今の版の値）。 */
  readonly limit: number;
}

/** 台帳の画面の値。 */
export interface LedgerPageView {
  readonly profile: DiscoveryProfileView;
  /** 台帳を出すプロファイルか（書き込みのモード）。偽なら、行とシナリオは空。 */
  readonly eligible: boolean;
  readonly entries: readonly LedgerEntryView[];
  readonly scenarios: readonly LedgerScenarioView[];
}

interface ProfileKeyRequest {
  readonly profileId: string;
}

const entryOf = (entry: AuditedDataLedgerEntry): LedgerEntryView => ({
  jobId: entry.jobId,
  runId: entry.runId,
  scenarioId: entry.scenarioId,
  scenarioRevision: entry.scenarioRevision,
  recordId: entry.recordId,
  seed: entry.seed === null ? null : { executionGrantId: entry.seed.executionGrantId, ruleSetDigest: entry.seed.ruleSetDigest },
  submission: entry.submission,
  result: entry.result,
  readVerification: entry.readVerification,
  reservationState: entry.reservationState,
  recordedAt: isoTimestampOf(entry.recordedAt),
  updates: {
    count: entry.updates.count,
    lastResult: entry.updates.last?.result ?? null,
    lastJobId: entry.updates.last?.jobId ?? null,
  },
});

/** 監査済みデータの台帳の画面の値（読むだけ）。プロファイルがなければ `null`。 */
export const auditedDataLedgerPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(({ data }): LedgerPageView | null => {
    const stored = getProfile(localUiStore(), data.profileId);
    if (stored === null) {
      return null;
    }
    const profile = discoveryProfileViewOf(stored);
    if (!usesScenarios(stored.profile.mode, stored.profile.auth)) {
      return { profile, eligible: false, entries: [], scenarios: [] };
    }
    const now = new Date();
    return {
      profile,
      eligible: true,
      entries: readAuditedDataLedger(localUiStore(), stored.profile.profileId).map(entryOf),
      scenarios: listScenarios(localUiStore(), stored.profile.profileId).map((scenario) => ({
        scenarioId: scenario.scenarioId,
        kind: scenario.current.kind,
        revision: scenario.revision,
        used: readUsedCumulativeWrites(localUiStore(), scenario.scenarioId, now),
        limit: scenario.current.limits.maxCumulativeCreates,
      })),
    };
  });

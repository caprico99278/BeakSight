/**
 * シナリオの種類と、書き込みのジョブの種類の対応（T31h-2。Task 31 の設計書 3 章。登録（CREATE）は `WRITE_CREATE`、更新（UPDATE）は
 * `WRITE_UPDATE`）。開始の画面（`write-job-functions.ts`）とシナリオの詳細（`scenario-functions.ts`）が、プロファイルで始められるか
 * （`execution-policy.ts` の行）を確かめるのに共用する。ジョブの詳細（`audit-job-functions.ts`）は、書き込みのジョブかを決めるのに使う。
 */
import type { ScenarioKind } from '../../../../src/control/approval-view.js';
import type { AuditJobKind } from '../../../../src/control/job/job-records.js';

/** 書き込みのジョブの種類。 */
export type WriteJobKind = Extract<AuditJobKind, 'WRITE_CREATE' | 'WRITE_UPDATE'>;

/** シナリオの種類ごとの、書き込みのジョブの種類。 */
const WRITE_JOB_KIND_OF_SCENARIO_KIND = Object.freeze({
  CREATE: 'WRITE_CREATE',
  UPDATE: 'WRITE_UPDATE',
} as const satisfies Record<ScenarioKind, WriteJobKind>);

/** シナリオの種類の、書き込みのジョブの種類。 */
export const writeJobKindOf = (kind: ScenarioKind): WriteJobKind => WRITE_JOB_KIND_OF_SCENARIO_KIND[kind];

/** 書き込みのジョブの種類か（T31h-2。ジョブの詳細が、書き込みの結果を読むかを決める）。 */
export const isWriteJobKind = (jobKind: AuditJobKind): jobKind is WriteJobKind =>
  (Object.values(WRITE_JOB_KIND_OF_SCENARIO_KIND) as readonly AuditJobKind[]).includes(jobKind);

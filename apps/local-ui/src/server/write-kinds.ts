/**
 * シナリオの種類と、書き込みのジョブの種類の対応（T31h-2。Task 31 の設計書 3 章。登録（CREATE）は `WRITE_CREATE`、更新（UPDATE）は
 * `WRITE_UPDATE`）。開始の画面（`write-job-functions.ts`）とシナリオの詳細（`scenario-functions.ts`）が、プロファイルで始められるか
 * （`execution-policy.ts` の行）を確かめるのに共用する。ジョブの詳細（`audit-job-functions.ts`）は、書き込みのジョブかを決めるのに使う。
 */
import type { ScenarioKind } from '../../../../src/control/approval-view.js';
import type { AuditJobKind } from '../../../../src/control/job/job-records.js';
// PRE42-CC 組 3（CC-105 の B）: ジョブの種類の値は、IPC の契約の名前つきの定数から読む（画面のサーバに同じ値を書かない）。
import { WORKER_WRITE_CREATE_JOB_KIND, WORKER_WRITE_UPDATE_JOB_KIND } from '../../../../src/control/worker-protocol.js';

/** 書き込みのジョブの種類。 */
export type WriteJobKind = Extract<AuditJobKind, 'WRITE_CREATE' | 'WRITE_UPDATE'>;

/** シナリオの種類ごとの、書き込みのジョブの種類。 */
const WRITE_JOB_KIND_OF_SCENARIO_KIND = Object.freeze({
  CREATE: WORKER_WRITE_CREATE_JOB_KIND,
  UPDATE: WORKER_WRITE_UPDATE_JOB_KIND,
} as const satisfies Record<ScenarioKind, WriteJobKind>);

/** シナリオの種類の、書き込みのジョブの種類。 */
export const writeJobKindOf = (kind: ScenarioKind): WriteJobKind => WRITE_JOB_KIND_OF_SCENARIO_KIND[kind];

/** 書き込みのジョブの種類か（T31h-2。ジョブの詳細が、書き込みの結果を読むかを決める）。 */
export const isWriteJobKind = (jobKind: AuditJobKind): jobKind is WriteJobKind =>
  (Object.values(WRITE_JOB_KIND_OF_SCENARIO_KIND) as readonly AuditJobKind[]).includes(jobKind);

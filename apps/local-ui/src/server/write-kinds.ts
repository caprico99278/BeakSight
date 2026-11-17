/**
 * シナリオの種類と、書き込みのジョブの種類の対応（T31h-2。Task 31 の設計書 3 章。登録（CREATE）は `WRITE_CREATE`、更新（UPDATE）は
 * `WRITE_UPDATE`）。ジョブの詳細（`audit-job-functions.ts`）と書き込みの結果（`write-results.ts`）が、書き込みのジョブかを決めるのに使う。
 * SPEC-4: 開始の画面を外したので、シナリオの種類からジョブの種類を引く口（`writeJobKindOf`）は捨てた。
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

/** 書き込みのジョブの種類か（T31h-2。ジョブの詳細が、書き込みの結果を読むかを決める）。 */
export const isWriteJobKind = (jobKind: AuditJobKind): jobKind is WriteJobKind =>
  (Object.values(WRITE_JOB_KIND_OF_SCENARIO_KIND) as readonly AuditJobKind[]).includes(jobKind);

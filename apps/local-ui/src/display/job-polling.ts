/**
 * 監査のジョブの進み具合を、画面が読み直す間隔（Task 24 の設計書 4.8。T24f）。TanStack Query のポーリングで使う。
 * 読み直しは画面のサーバの管理データを読むだけで、監査の対象のサイトには何も送らない（サイトへの負荷は変わらない）。
 * ジョブが終わったら、読み直しを止める（終わった後に背後で書く結果を待つ間だけは、短く続ける。`awaitsAutoRegistration`）。
 */
import { SECOND_MS } from '../../../../src/core/time-units.js';
import { parseCompactUtcTimestamp } from '../../../../src/core/utc-timestamp.js';
import type { AuditJobDetailView } from '../server/audit-job-functions';

export const AUDIT_JOB_POLL_INTERVAL_MS = 2_000;

/**
 * ML-b-2（設計書 `doc/design/2026-10-19-beaksight-manual-login-pass-through-design.md` の 2.3）: 手動のログインの成功から設定を自動で登録した結果
 * （`loginStage.autoRegistration`）を、終わったジョブの画面が待つ時間の上限（ジョブの終わりの時刻から。ジョブの管理は終わりの直後に背後で書く）。
 */
export const AUDIT_JOB_AUTO_REGISTRATION_WAIT_MS = 30 * SECOND_MS;

/**
 * ML-b-2: 終わったジョブの画面が、自動の登録の結果を待って読み直しを続けるか（T41g-2 の「登録中」の読み直しと同じ考え）。手動のログインで送信を通した
 * （`loginStage.passedRequests` がある）ジョブが終わり、結果がまだ書かれず、終わりの時刻から上限の時間の内のときだけ。動いているジョブは、ふだんの読み直し。
 */
export const awaitsAutoRegistration = (
  job: Pick<AuditJobDetailView, 'active' | 'finishedAt' | 'loginStage'>,
  nowMs: number,
): boolean => {
  if (job.active || job.loginStage?.passedRequests === undefined || job.loginStage.autoRegistration !== undefined) {
    return false;
  }
  const finishedAt = parseCompactUtcTimestamp(job.finishedAt);
  return finishedAt !== null && nowMs - finishedAt.getTime() <= AUDIT_JOB_AUTO_REGISTRATION_WAIT_MS;
};

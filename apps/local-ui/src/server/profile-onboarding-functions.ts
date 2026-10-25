/**
 * プロファイルの詳細の「次にすること」と「監査を始める」の Server Function（T43a。Task 43 の設計書 4.1）。読むだけ（GET）。
 * - 読み方は、開始の画面と同じ `start-check-inputs.ts` の `readProfileStart`（プロファイル、ターゲット設定、保存した認証の設定、自動ログインの
 *   開始の前の確かめの値）。監査を始められない理由は、開始の画面と同じ `audit-start-check.ts` の `auditStartCheckOf`（ジョブの管理と同じ順）。
 * - 「次にすること」の状態は、`display/next-steps.ts` の `profileNextStepsOf` が、ここで読んだ事実から選ぶ: 認証の設定の新しさ、資格情報を
 *   保存しているか、ログインの確かめの開始の確かめが `CREDENTIAL_STALE` か、そのプロファイルの最後のログインの確かめのジョブ（結果が成功か、
 *   そのときの改訂）、最後の監査のジョブが終わったか（ジョブの一覧は新しい順）。
 * - 返す値は、表示に要るものだけ（値と秘密を含まない）。
 */
import { createServerFn } from '@tanstack/react-start';
import { AUTOMATED_LOGIN_SUCCEEDED } from '../../../../src/control/auth/automated-login-results.js';
// PRE42-CC 組 3（N4-8b）: 終わったジョブの状態は、owner の `job-records.ts` の名前つきの定数から読む。
import { FINISHED_AUDIT_JOB_STATE } from '../../../../src/control/job/job-records.js';
// T44g（Task 44 の設計書 P4-8 の CC-105）: ジョブの種類の値は、IPC の契約の名前つきの定数から読む（画面のサーバに同じ定数を置かない）。
import { WORKER_AUDIT_JOB_KIND, WORKER_LOGIN_CHECK_JOB_KIND } from '../../../../src/control/worker-protocol.js';
import { profileNextStepsOf, type ProfileNextStepRow } from '../display/next-steps';
import { auditStartCheckOf, type AuditStartBlocker } from './audit-start-check';
import { localUiAuditJobs } from './audit-jobs';
import { requestOf } from './request-validation';
import { readProfileStart } from './start-check-inputs';

/** 資格情報が今の認証の設定と合わない、開始を拒む理由。 */
const CREDENTIAL_STALE = 'CREDENTIAL_STALE' satisfies AuditStartBlocker;

/** プロファイルの詳細の「次にすること」と「監査を始める」の値。 */
export interface ProfileOnboardingView {
  /** 手順の順の行。 */
  readonly steps: readonly ProfileNextStepRow[];
  /** 監査を始められない理由（開始の画面と同じ確かめ。始められるなら `null`）。 */
  readonly auditStartBlocker: AuditStartBlocker | null;
}

interface ProfileKeyRequest {
  readonly profileId: string;
}

/** プロファイルの「次にすること」と、監査を始められない理由。プロファイルがなければ `null`。 */
export const profileOnboardingFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<ProfileOnboardingView | null> => {
    const reading = await readProfileStart(data.profileId);
    if (reading === null) {
      return null;
    }
    const { stored, storedSetup, autoLoginSummary, checkInput } = reading;
    const { profile } = stored;
    const audit = auditStartCheckOf(checkInput);
    const loginCheck = auditStartCheckOf({ ...checkInput, jobKind: WORKER_LOGIN_CHECK_JOB_KIND });
    const jobs = localUiAuditJobs().listAuditJobs().filter((job) => job.profileId === profile.profileId);
    const lastLoginCheck = jobs.find((job) => job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND) ?? null;
    const lastAudit = jobs.find((job) => job.jobKind === WORKER_AUDIT_JOB_KIND) ?? null;
    return {
      steps: profileNextStepsOf({
        mode: profile.mode,
        auth: profile.auth,
        revision: profile.revision,
        authSetupFreshness: storedSetup?.freshness ?? null,
        credentialSaved: autoLoginSummary?.credentialSaved ?? false,
        credentialStale: loginCheck.blocker === CREDENTIAL_STALE,
        lastLoginCheck: lastLoginCheck === null
          ? null
          : { succeeded: lastLoginCheck.autoLoginAttempt?.result === AUTOMATED_LOGIN_SUCCEEDED, profileRevision: lastLoginCheck.profileRevision },
        lastAuditFinished: lastAudit?.state === FINISHED_AUDIT_JOB_STATE,
      }),
      auditStartBlocker: audit.blocker,
    };
  });

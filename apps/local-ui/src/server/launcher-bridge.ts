/**
 * 本番の起動の部品（`launcher/serve.ts`）が読む、ビルドした画面のサーバの入口（T23f）。
 * Vite の SSR のビルドの 2 つ目の入口として、`dist/server/launcher-bridge.js` に出す（`vite.config.ts` の `environments.ssr`）。
 * - 起動の部品は Node の型の除去で動き、`src/` の TypeScript を直接読めない。管理データの準備と、拒否の応答の文言は、ここから受け取る。
 * - 画面のサーバ（`server.js`）と同じ process で読むので、管理データの接続（`control-store`）は 1 つを共有する。
 * - 監査のジョブの管理（`audit-jobs`）の起動のときの準備（中断に直す）と、終わりのときの後始末も、ここから受け取る（T24f）。
 */
import type { AuditJobState } from '../../../../src/core/audit-job-values.js';
import { ACTIVE_AUDIT_JOB_STATES } from '../../../../src/control/job/job-records.js';
import { readAllJobs } from '../../../../src/control/job/job-store.js';
import { RETIRED_PROFILE_STATUS } from '../../../../src/control/store/profile-records.js';
import { getProfile } from '../../../../src/control/store/profile-store.js';
import { localUiAuditJobs, prepareLocalUiAuditJobs as prepareAuditJobs, type LocalUiAuditJobsPreparation } from './audit-jobs';
import { localUiStore } from './control-store';
import { localUiCredentialBaseDependencies } from './credential-dependencies';
import { removeCredentialOfRetiredProfile } from './credential-service';
import { retireUnusableProfiles, unusableProfileRetirementLinesOf } from './unusable-profile-retirement';

export { closeLocalUiStore, prepareLocalUiStore, type LocalUiStorePreparation } from './control-store';
export { runningLocalUiAuditJobCount, shutdownLocalUiAuditJobs } from './audit-jobs';
// T26e（Task 26 の設計書 4.1 の「起動のとき」）: 資格情報のフォルダの一時のファイルの片付けと、暗号化の確かめ（待ち受けの前に 1 回）。
export { prepareLocalUiCredentials } from './credential-runtime';

const ACTIVE_JOB_STATES: ReadonlySet<AuditJobState> = new Set(ACTIVE_AUDIT_JOB_STATES);

/**
 * MI-F5（再レビュー MI-R2 の Minor M-2）: 起動のときに中断に直したジョブの、プロファイルの ID（ジョブごと）。中断に直す前の、終わっていないジョブの行から求める
 * （中断に直すのは、終わっていないジョブの行。`recoverInterruptedJobs`）。起動の時の自動の取り消しの後に、取り消したプロファイルのジョブを「前回の続きから再開する」
 * の案内の数から除くために使う。
 */
let recoveredJobProfileIds: readonly string[] = [];

/**
 * 起動のときの準備（`audit-jobs.ts` の `prepareLocalUiAuditJobs`）。MI-F5（M-2）: 準備の前に、終わっていないジョブのプロファイルを覚える（準備が中断に直した
 * ジョブのプロファイル）。結果は今の準備のまま。
 */
export const prepareLocalUiAuditJobs = (port: number | null = null): LocalUiAuditJobsPreparation => {
  const active = readAllJobs(localUiStore()).filter((job) => ACTIVE_JOB_STATES.has(job.state)).map((job) => job.profileId);
  const prepared = prepareAuditJobs(port);
  recoveredJobProfileIds = prepared.ok && prepared.recovered > 0 ? Object.freeze(active) : Object.freeze([]);
  return prepared;
};

/**
 * MI-F5（M-2）: 起動のときに中断に直したジョブのうち、「前回の続きから再開する」で再開できるもの（プロファイルを取り消していないもの）の数。起動の部品が、起動の時の
 * 自動の取り消し（`retireUnusableLocalUiProfiles`）の後に呼び、中断に直したジョブの案内の数にする（取り消したプロファイルのジョブの案内を出さない）。
 */
export const resumableRecoveredLocalUiJobCount = (): number => {
  const database = localUiStore();
  return recoveredJobProfileIds.filter((profileId) => getProfile(database, profileId)?.status !== RETIRED_PROFILE_STATUS).length;
};

/**
 * MI-F3 項目 6（ユーザーの指示 2026-10-26「フォームやボタンは増やさない。基本的に自動化を厳守する」）: 起動のときに 1 回、使えないプロファイルを自動で取り消し、
 * 画面のサーバのログに出す行（取り消したプロファイルごとに 1 行）を返す。起動の部品が、管理データの準備・ジョブの管理の準備（管理のロック、中断に直す）・資格情報の
 * 準備の後、待ち受けの前に呼ぶ。処理は `unusable-profile-retirement.ts`、本番の部品（管理データ、終わっていないジョブ、資格情報の片付け
 * `removeCredentialOfRetiredProfile`。画面の「取り消す」と同じ部品）はここで組み立てる。
 */
export const retireUnusableLocalUiProfiles = async (): Promise<readonly string[]> => {
  const credentialDependencies = localUiCredentialBaseDependencies();
  const activeProfiles = new Set(localUiAuditJobs().listAuditJobs().filter((job) => ACTIVE_JOB_STATES.has(job.state)).map((job) => job.profileId));
  return unusableProfileRetirementLinesOf(await retireUnusableProfiles({
    database: localUiStore(),
    hasActiveJob: (profileId) => activeProfiles.has(profileId),
    removeCredential: (profileId) => removeCredentialOfRetiredProfile(credentialDependencies, profileId),
  }));
};
// DEF-146: 画面のサーバが終わったときの記録（予期しない例外、止める決まり、process の終わり。token は記録に書かない値として渡す）。
// OP-P（P3）: 起動の行（前の起動の終わりの記録がなければ、そのことも）と、止める決まりを受けたことの記録。
export {
  recordLocalUiServerExit,
  recordLocalUiServerShutdown,
  recordLocalUiServerStart,
  recordLocalUiServerStopRequest,
  recordLocalUiServerUnexpectedError,
  setLocalUiServerLogSecrets,
} from './ui-server-log-file';
export { AUDIT_JOB_SHUTDOWN_WAIT_MS } from '../../../../src/control/job/job-records.js';
export { formatCount, formatDuration } from '../../../../src/presentation/format.js';
export {
  LOCAL_UI_CONSOLE_TEXT,
  LOCAL_UI_GUARD_REJECTION_TEXT,
  LOCAL_UI_JOB_CONSOLE_TEXT,
  describeLocalUiStartFailure,
} from '../../../../src/presentation/messages.js';

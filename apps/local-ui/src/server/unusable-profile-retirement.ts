/**
 * MI-F3 項目 6（ユーザーの指示 2026-10-26「フォームやボタンは増やさない。基本的に自動化を厳守する」。設計書
 * `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の終わりの段落）: 画面のサーバの起動のときに、使えないプロファイル（判定は
 * `src/control/unusable-profile.ts` の `startupRetirementReasonOf` の 1 か所）を 1 回だけ自動で取り消す。サーバだけで使う。
 * - 取り消しは、今の取り消しと同じ部品（管理データの `retireProfile`。画面の「取り消す」の `retireProfileFn` と同じ）で、プロファイルを読んだ改訂を照合して行う。
 *   取り消したら、保存した資格情報の片付け（本番は `removeCredentialOfRetiredProfile`）を呼ぶ。取り消せなかったプロファイル（読んだ後に変わった）は、そのまま残す。
 * - 動いているジョブのあるプロファイルは取り消さない（判定の入力）。
 * - 画面には何も足さない。取り消したプロファイルの ID と理由を、画面のサーバのログ（標準出力）に 1 行ずつ残す（`unusableProfileRetirementLinesOf`。文言は
 *   `LOCAL_UI_UNUSABLE_PROFILE_TEXT`。プロファイルの ID は秘密でない。値・資格情報は書かない）。
 * - 2 回目からは、取り消したプロファイルが対象から外れるので、何もしない。
 * - 本番の組み立て（管理データ、ジョブの管理、資格情報の部品）は、起動の部品の入口（`launcher-bridge.ts` の `retireUnusableLocalUiProfiles`）。
 */
import { getAuthSetup } from '../../../../src/control/store/auth-setup-store.js';
import type { ControlDatabase } from '../../../../src/control/store/control-database.js';
import { listProfiles, retireProfile } from '../../../../src/control/store/profile-store.js';
import { startupRetirementReasonOf, type UnusableProfileReason } from '../../../../src/control/unusable-profile.js';
import { LOCAL_UI_UNUSABLE_PROFILE_TEXT } from '../../../../src/presentation/messages.js';
import type { RetiredCredentialCleanup } from './credential-service';

/** 資格情報を消せなかったときの片付けの結果（`RETIRED_CREDENTIAL_CLEANUPS` の値）。 */
const FAILED_CREDENTIAL_CLEANUP = 'FAILED' satisfies RetiredCredentialCleanup;

/** 処理が使う部品（本番は `launcher-bridge.ts` が渡す）。 */
export interface UnusableProfileRetirementDependencies {
  readonly database: ControlDatabase;
  /** そのプロファイルに、終わっていないジョブがあるか。 */
  readonly hasActiveJob: (profileId: string) => boolean;
  /** 取り消したプロファイルの、保存した資格情報の片付け（本番は `removeCredentialOfRetiredProfile`）。 */
  readonly removeCredential: (profileId: string) => Promise<RetiredCredentialCleanup>;
  /** 今の時刻（既定は `new Date()`）。 */
  readonly now?: () => Date;
}

/** 取り消したプロファイル 1 つ。 */
export interface RetiredUnusableProfile {
  readonly profileId: string;
  readonly reason: UnusableProfileReason;
  readonly credentialCleanup: RetiredCredentialCleanup;
}

/** 使えないプロファイルを取り消す（取り消したものを、管理データの一覧の順に返す）。 */
export const retireUnusableProfiles = async (deps: UnusableProfileRetirementDependencies): Promise<readonly RetiredUnusableProfile[]> => {
  const retired: RetiredUnusableProfile[] = [];
  for (const stored of listProfiles(deps.database)) {
    const { profileId, revision, auth } = stored.profile;
    const reason = startupRetirementReasonOf({
      status: stored.status,
      auth,
      hasAuthSetup: getAuthSetup(deps.database, profileId) !== null,
      hasActiveJob: deps.hasActiveJob(profileId),
    });
    if (reason === null) {
      continue;
    }
    const result = retireProfile(deps.database, { profileId, expectedRevision: revision }, deps.now === undefined ? {} : { now: deps.now });
    if (result.ok) {
      retired.push(Object.freeze({ profileId, reason, credentialCleanup: await deps.removeCredential(profileId) }));
    }
  }
  return Object.freeze(retired);
};

/** 取り消したプロファイルごとの、画面のサーバのログの 1 行（資格情報を消せなかったときは、その知らせを同じ行に足す）。 */
export const unusableProfileRetirementLinesOf = (retired: readonly RetiredUnusableProfile[]): readonly string[] => {
  const text = LOCAL_UI_UNUSABLE_PROFILE_TEXT;
  return Object.freeze(retired.map(({ profileId, reason, credentialCleanup }) =>
    text.retired(profileId, text.reasons[reason], credentialCleanup === FAILED_CREDENTIAL_CLEANUP)));
};

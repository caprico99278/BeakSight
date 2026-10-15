// 承認の判定に渡す管理データの外の事実（認証の設定の digest と、ターゲットの設定の digest）を求める唯一の部品（Task 28 の設計書 3 章の
// 「承認を縛るもの」。T28R-fix-1。独立レビュー T28R の I-1、台帳の CC-080 (a)。T28e で画面のサーバ（`apps/local-ui/src/server/scenario-facts.ts`）に
// 作った求め方を、書き込みのジョブ（Task 30）と共用するために、ここへ移した）。
// - 認証の設定の digest: 保存した認証の設定（`getAuthSetup`）と、資格情報を使うプロファイル（`isProfileOperationAllowed('CREDENTIAL', …)`。自動
//   ログイン）なら資格情報の事実（資格情報のファイルのメタデータの版（値は読まない）と、管理データの `credential_events` の、資格情報の変更の最後の
//   出来事の id）から、owner の `authSetupDigestOf` で求める。資格情報を削除して登録し直すと、版は 1 に戻るが出来事の id は増えるので、digest が
//   変わる。資格情報を使わないプロファイルは、資格情報を縛らない（残った資格情報のファイルの変化で、承認を縛らない）。
// - ターゲットの設定の digest: プロファイルが指す設定のファイル（`isAcceptedTargetConfigPath` を通ったパスだけ）の内容の、owner の
//   `targetConfigDigestOf`（ジョブの管理とワーカーと同じ求め方）。
// - どちらかを求められない（設定のファイルを読めない、パスを受けない、資格情報のメタデータを読めない、保存した設定の形が違う）ときは `null`
//   （fail-closed。画面は承認の状態を「確かめられない」と示し、承認・撤回の要求を拒む）。
// - 依存（管理データ、リポジトリの根、資格情報の部品）は、呼び出し側が渡す（画面のサーバは自分の部品、ジョブの管理は自分の部品）。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalExternalFacts } from './approval/scenario-facts.js';
import { authSetupDigestOf, type AuthSetupCredentialFacts } from './auth/auth-setup-digest.js';
import type { CredentialStore } from './credentials/credential-store.js';
import { isProfileOperationAllowed, type ProfileOperation } from './execution-policy.js';
import { readLatestCredentialChangeEventId } from './job/auto-login-store.js';
import { isAcceptedTargetConfigPath } from './profile-policy.js';
import { getAuthSetup } from './store/auth-setup-store.js';
import type { ControlDatabase } from './store/control-database.js';
import type { StoredProfile } from './store/profile-store.js';
import { targetConfigDigestOf } from './worker-protocol.js';

/** 求めるのに要る依存。 */
export interface ApprovalExternalFactsDependencies {
  readonly database: ControlDatabase;
  /** リポジトリの根（ターゲットの設定のファイルの相対パスの基準）。 */
  readonly repositoryRoot: string;
  /** 資格情報の部品（メタデータだけを読む。値は読まない）。 */
  readonly credentialStore: Pick<CredentialStore, 'readMetadata'>;
}

/** 資格情報を使う操作（自動ログインの資格情報）。 */
const CREDENTIAL_OPERATION = 'CREDENTIAL' satisfies ProfileOperation;

/** プロファイルが指す設定のファイルの digest（読めない・パスを受けないなら null）。 */
const targetConfigDigestOfProfile = async (stored: StoredProfile, repositoryRoot: string): Promise<string | null> => {
  const { targetConfigPath } = stored.profile;
  if (!isAcceptedTargetConfigPath(targetConfigPath)) {
    return null;
  }
  try {
    return targetConfigDigestOf(await readFile(join(repositoryRoot, targetConfigPath)));
  } catch {
    return null;
  }
};

/** 承認に縛る資格情報の事実（資格情報を使わないプロファイルは null。メタデータを読めなければ `undefined`）。 */
const credentialFactsOf = async (
  stored: StoredProfile,
  deps: ApprovalExternalFactsDependencies,
): Promise<AuthSetupCredentialFacts | null | undefined> => {
  const { profile } = stored;
  if (!isProfileOperationAllowed(CREDENTIAL_OPERATION, profile.mode, profile.auth)) {
    return null;
  }
  let credentialRevision: number | null;
  try {
    credentialRevision = (await deps.credentialStore.readMetadata(profile.profileId))?.credentialRevision ?? null;
  } catch {
    return undefined;
  }
  return Object.freeze({ credentialRevision, lastCredentialEventId: readLatestCredentialChangeEventId(deps.database, profile.profileId) });
};

/** 承認の判定に渡す管理データの外の事実（求められなければ null）。 */
export const approvalExternalFactsOf = async (
  stored: StoredProfile,
  deps: ApprovalExternalFactsDependencies,
): Promise<ApprovalExternalFacts | null> => {
  const targetConfigDigest = await targetConfigDigestOfProfile(stored, deps.repositoryRoot);
  const credential = await credentialFactsOf(stored, deps);
  if (targetConfigDigest === null || credential === undefined) {
    return null;
  }
  try {
    return Object.freeze({ authSetupDigest: authSetupDigestOf(getAuthSetup(deps.database, stored.profile.profileId), credential), targetConfigDigest });
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
};

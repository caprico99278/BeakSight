/**
 * 画面の Server Functions（Task 23 設計書 4.3、4.4、4.7。T23f）。
 * - 入力は、サーバで `schemas/control/` のスキーマ（`ui-*`）で検証してから使う。合わない入力は 400 で拒否し、何も保存しない。
 *   プロファイルの文書は、保存の部品（`src/control/store/profile-store.ts`）が Task 22 の `validateSiteProfile` で検証する。
 * - 書き込み（作成・更新・取り消し）は POST の Server Function だけで行う。読むだけのものは GET。
 * - 設定の文脈は、`isAcceptedTargetConfigPath` を通ったパスだけを、既存の `loadConfig` で読む（設定の検証の owner を写さない）。
 * - 返す値は、表示に要るものだけ（SQLite の生の誤りの文や、内部のパスの全体を返さない）。
 */
import { readdirSync, type Dirent } from 'node:fs';
import { join, posix } from 'node:path';
import { createServerFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import type { TargetConfigCreationFailure, TargetSiteInput, TargetSiteProblem } from '../../../../src/config/target-config-draft.js';
import type { AuditMode, AuthStrategy, EnvironmentKind, ProfileValidationErrorCode, SiteProfile } from '../../../../src/control/contracts.js';
import { checkControlEnvironment } from '../../../../src/control/environment/control-environment.js';
import { isAcceptedTargetConfigPath, type ProfileValidationContext } from '../../../../src/control/profile-policy.js';
import { TARGET_CONFIG_DIRECTORIES, TARGET_CONFIG_EXTENSION } from '../../../../src/control/target-config-locations.js';
import {
  createProfile,
  getProfile,
  listProfiles,
  retireProfile,
  updateProfile,
  type ProfileStoreRejectionReason,
  type ProfileStoreResult,
  type StoredProfile,
} from '../../../../src/control/store/profile-store.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import { getAuthSetup, type AuthSetupFreshness } from '../../../../src/control/store/auth-setup-store.js';
import { getStoreStatus } from '../../../../src/control/store/store-status.js';
import { localUiRepositoryRoot, localUiStore, relativeDatabaseLocation } from './control-store';
import { localUiCredentialServiceDependencies } from './credential-functions';
import { localUiCredentialEnvironment, type CredentialEnvironmentState } from './credential-runtime';
import { credentialRemainsOf, removeCredentialOfRetiredProfile, type RetiredCredentialCleanup } from './credential-service';
import { requestOf } from './request-validation';
import { loadTargetContext } from './target-config';
import { createProfileWithGeneratedTarget } from './target-config-writer';
import { isoTimestampOf } from './timestamps';
import { loginSetupViewOf, type LoginSetupView } from './login-setup-view';

// 設定のファイルの候補を探すフォルダは、`isAcceptedTargetConfigPath` が受けるもの（`target-config-locations.ts` の `TARGET_CONFIG_DIRECTORIES`。
// T43b fix round 1 で写しをやめた）。

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 一覧の 1 行。 */
export interface ProfileRowView {
  readonly profileId: string;
  readonly environment: EnvironmentKind;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  readonly status: ProfileStatus;
  readonly revision: number;
  /** 最後に変えた日時（ISO 8601。表示は `formatDateTime`）。 */
  readonly updatedAt: string;
}

/** 1 つのプロファイル（編集の画面）。 */
export interface ProfileDetailView {
  readonly profile: SiteProfile;
  readonly status: ProfileStatus;
  readonly updatedAt: string;
}

/** プロファイルの詳細の画面の値（T26g-3: 資格情報のファイルが残っているか。値は持たない）。 */
export interface ProfileDetailPageView extends ProfileDetailView {
  readonly credentialRemains: boolean;
  /** ML-b（手動のログインの設計書 2.3）: 手動のログインの成功から自動で登録した設定（スクリプトで送るログインの設定があるときだけ。値を持たない）。 */
  readonly loginSetup: LoginSetupView | null;
  /**
   * T44d（Task 44 の設計書 P2-2）: 保存してある認証の設定の、読む範囲と読まないパスと新しさ（認証の設定の画面への入り口の近くの要約。保存して
   * いなければ null）。パスは秘密ではない（開始の画面も読む範囲を出す）。
   */
  readonly authSetupScope: ProfileAuthSetupScopeView | null;
}

/** プロファイルの画面の、認証の設定の要約（T44d）。 */
export interface ProfileAuthSetupScopeView {
  /** 読む範囲のパスの前方一致（空なら制限なし）。 */
  readonly auditPathPrefixes: readonly string[];
  /** 読まないパスの前方一致。 */
  readonly excludedPaths: readonly string[];
  readonly freshness: AuthSetupFreshness;
}

/** 変更の結果。拒否のときは、理由、検証の誤りのコード、設定のファイルの誤りの種類（あれば）。 */
export type ProfileChangeView =
  | {
    readonly ok: true;
    readonly detail: ProfileDetailView;
    /** 取り消しの後の、資格情報のファイルの片付けの結果（取り消しの応答だけ。T26g-2、T26R の I1）。 */
    readonly credentialCleanup?: RetiredCredentialCleanup;
  }
  | {
    readonly ok: false;
    readonly reason: ProfileStoreRejectionReason;
    readonly errorCodes: readonly ProfileValidationErrorCode[];
    readonly configError: ConfigErrorKind | null;
  };

/**
 * T43b（Task 43 の設計書 4.2）: 開始の URL から対象の設定のファイルを作れなかったときの結果（プロファイルも作らない）。欄の誤りは
 * `siteProblems`（開始の URL と許可 Origin の欄に出す）。
 */
export interface TargetConfigRejectionView {
  readonly ok: false;
  readonly reason: TargetConfigCreationFailure;
  readonly siteProblems: readonly TargetSiteProblem[];
}

/** 作成の結果（すでにある設定のファイルを使うときは `ProfileChangeView` だけ）。 */
export type ProfileCreateView = ProfileChangeView | TargetConfigRejectionView;

/** 設定のファイルの確かめの結果。 */
export type TargetConfigCheckView =
  | { readonly ok: true }
  | { readonly ok: false; readonly pathAccepted: false }
  | { readonly ok: false; readonly pathAccepted: true; readonly configError: ConfigErrorKind };

/** 環境の状態（設計書 4.7）。 */
export interface EnvironmentStatusView {
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  /** 管理データの場所（リポジトリの root からの相対。区切りは `/`）。 */
  readonly databaseLocation: string;
  readonly schemaVersion: number;
  readonly latestSchemaVersion: number;
  readonly profileCounts: Readonly<Record<ProfileStatus, number>>;
  readonly quickCheckOk: boolean;
  /** 待ち受けのアドレス（127.0.0.1 だけ）。 */
  readonly listenHost: string;
  /** 資格情報の暗号化を、この環境で使えるか（起動のときの準備の結果。サーバの判定。値は出さない。T26e）。 */
  readonly credentialEnvironment: CredentialEnvironmentState;
}

/** 待ち受けのアドレス（起動の部品と開発のサーバの決まり。表示用）。 */
const LISTEN_HOST = '127.0.0.1';

const detailOf = (stored: StoredProfile): ProfileDetailView => ({
  profile: structuredClone(stored.profile),
  status: stored.status,
  updatedAt: isoTimestampOf(stored.updatedAt),
});

const rowOf = (stored: StoredProfile): ProfileRowView => ({
  profileId: stored.profile.profileId,
  environment: stored.profile.environment,
  mode: stored.profile.mode,
  auth: stored.profile.auth,
  status: stored.status,
  revision: stored.profile.revision,
  updatedAt: isoTimestampOf(stored.updatedAt),
});

const changeViewOf = (result: ProfileStoreResult, configError: ConfigErrorKind | null): ProfileChangeView =>
  result.ok
    ? { ok: true, detail: detailOf(result.stored) }
    : { ok: false, reason: result.reason, errorCodes: result.errors.map((error) => error.code), configError };

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface ProfileKeyRequest {
  readonly profileId: string;
}
interface ProfileCreateRequest {
  readonly profile: Readonly<Record<string, unknown>>;
  /** T43b: あれば、`local/targets/<profileId>.json` を作り、プロファイルはそれを指す（`profile.targetConfigPath` は使わない）。 */
  readonly newTargetSite?: TargetSiteInput;
}
interface ProfileUpdateRequest {
  readonly profile: Readonly<Record<string, unknown>>;
  readonly expectedRevision: number;
}
interface ProfileRetireRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
}
interface TargetConfigRequest {
  readonly targetConfigPath: string;
}

// ---------------------------------------------------------------------------------------------------------------
// 設定のファイル
// ---------------------------------------------------------------------------------------------------------------

/** 読んだ文脈だけを返す `resolveContext`（同期。保存の部品が、パスを確かめてから呼ぶ）。 */
const resolverFor = (targetConfigPath: unknown, context: ProfileValidationContext | undefined) =>
  (path: string): ProfileValidationContext | undefined => (path === targetConfigPath ? context : undefined);

/** フォルダの中の `.json` の、リポジトリの root からの相対パス（名前だけを列挙する。中身は読まない）。 */
const listJsonFiles = (directory: string): readonly string[] => {
  const root = localUiRepositoryRoot();
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, directory), { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(TARGET_CONFIG_EXTENSION))
    .map((entry) => posix.relative(root, `${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`));
};

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** T44d: 保存してある認証の設定の、読む範囲と読まないパスと新しさ（なければ null）。 */
const authSetupScopeOf = (profileId: string): ProfileAuthSetupScopeView | null => {
  const stored = getAuthSetup(localUiStore(), profileId);
  return stored === null
    ? null
    : { auditPathPrefixes: [...stored.setup.auditPathPrefixes], excludedPaths: [...stored.setup.excludedPaths], freshness: stored.freshness };
};

/** プロファイルの一覧（取り消したものを含む）。 */
export const listProfilesFn = createServerFn({ method: 'GET' }).handler((): readonly ProfileRowView[] =>
  listProfiles(localUiStore()).map(rowOf));

/**
 * 1 つのプロファイル。なければ `null`。資格情報のファイルが残っているか（`credentialRemains`）も、サーバで判定して渡す（T26g-3。画面は、認証の
 * 方式が自動ログインでなくても、残っていれば資格情報の画面へのリンクを出す）。
 */
export const getProfileFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<ProfileDetailPageView | null> => {
    const stored = getProfile(localUiStore(), data.profileId);
    if (stored === null) {
      return null;
    }
    const credentialRemains = await credentialRemainsOf(localUiCredentialServiceDependencies(), data.profileId);
    return { ...detailOf(stored), credentialRemains, loginSetup: loginSetupViewOf(data.profileId), authSetupScope: authSetupScopeOf(data.profileId) };
  });

/**
 * T43b（Task 43 の設計書 4.2）: 開始の URL から、対象の設定のファイル `local/targets/<profileId>.json` を作ってから、それを指すプロファイルを作る。
 * 流れ（確かめ → 書く → 読み直して保存 → 失敗なら書いたファイルを消す）は `target-config-writer.ts` の `createProfileWithGeneratedTarget`。
 * ここは、本番の部品（管理データ、リポジトリの root、`loadTargetContext`）を渡し、結果を画面の値にするだけ。
 */
const createProfileWithNewTarget = async (input: Readonly<Record<string, unknown>>, site: TargetSiteInput): Promise<ProfileCreateView> => {
  const database = localUiStore();
  const outcome = await createProfileWithGeneratedTarget(input, site, {
    root: localUiRepositoryRoot(),
    profileExists: (profileId) => getProfile(database, profileId) !== null,
    loadContext: loadTargetContext,
    saveProfile: (profile, resolveContext) => createProfile(database, profile, { resolveContext }),
  });
  switch (outcome.kind) {
    case 'TARGET_REJECTED':
      return { ok: false, reason: outcome.reason, siteProblems: outcome.siteProblems };
    case 'PROFILE_REJECTED':
      return { ok: false, reason: outcome.reason, errorCodes: outcome.errorCodes, configError: null };
    default:
      return changeViewOf(outcome.result, outcome.configError);
  }
};

/** プロファイルを作る（T43b: `newTargetSite` があれば、対象の設定のファイルを作ってから）。 */
export const createProfileFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ProfileCreateRequest>('ui-profile-create'))
  .handler(async ({ data }): Promise<ProfileCreateView> => {
    if (data.newTargetSite !== undefined) {
      return createProfileWithNewTarget(data.profile, data.newTargetSite);
    }
    const targetConfigPath = data.profile['targetConfigPath'];
    const { context, configError } = await loadTargetContext(targetConfigPath);
    const result = createProfile(localUiStore(), data.profile, { resolveContext: resolverFor(targetConfigPath, context) });
    return changeViewOf(result, configError);
  });

/** プロファイルを次の改訂に更新する。 */
export const updateProfileFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ProfileUpdateRequest>('ui-profile-update'))
  .handler(async ({ data }): Promise<ProfileChangeView> => {
    const targetConfigPath = data.profile['targetConfigPath'];
    const { context, configError } = await loadTargetContext(targetConfigPath);
    const result = updateProfile(
      localUiStore(),
      { profile: data.profile, expectedRevision: data.expectedRevision },
      { resolveContext: resolverFor(targetConfigPath, context) },
    );
    return changeViewOf(result, configError);
  });

/**
 * プロファイルを取り消す。取り消しが成功した後にだけ、資格情報のファイルを消して `DELETED` を記録する（Task 26 の設計書 4.1、変更履歴の
 * 「T26R」の I1。消す処理は `removeCredentialOfRetiredProfile` → `removeCredential`）。消せなくても、取り消しは成功のまま（巻き戻さない）。
 * ジョブが動いている間の取り消しの扱いは変えない（そのときは資格情報を消せず、`FAILED` を返す）。
 */
export const retireProfileFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ProfileRetireRequest>('ui-profile-retire'))
  .handler(async ({ data }): Promise<ProfileChangeView> => {
    const result = retireProfile(localUiStore(), { profileId: data.profileId, expectedRevision: data.expectedRevision });
    if (!result.ok) {
      return changeViewOf(result, null);
    }
    // 資格情報の画面の Server Function と同じ本番の部品（組み立ては `credential-functions.ts` の 1 か所）を渡す。
    const credentialCleanup = await removeCredentialOfRetiredProfile(localUiCredentialServiceDependencies(), data.profileId);
    return { ok: true, detail: detailOf(result.stored), credentialCleanup };
  });

/** 環境の状態。 */
export const environmentStatusFn = createServerFn({ method: 'GET' }).handler(async (): Promise<EnvironmentStatusView> => {
  const credentialEnvironment = await localUiCredentialEnvironment();
  const status = getStoreStatus(localUiStore());
  return {
    nodeVersion: checkControlEnvironment().nodeVersion,
    sqliteVersion: status.sqliteVersion,
    databaseLocation: relativeDatabaseLocation(),
    schemaVersion: status.schemaVersion,
    latestSchemaVersion: status.latestSchemaVersion,
    profileCounts: { ...status.profileCounts },
    quickCheckOk: status.quickCheck.ok,
    listenHost: LISTEN_HOST,
    credentialEnvironment,
  };
});

/** 設定のファイルの候補（`config/targets/` と `local/targets/` の `.json`。ファイルの名前の一覧だけ）。 */
export const targetConfigCandidatesFn = createServerFn({ method: 'GET' }).handler((): readonly string[] =>
  TARGET_CONFIG_DIRECTORIES.flatMap((directory) => listJsonFiles(directory)).filter(isAcceptedTargetConfigPath).sort());

/** 設定のファイルを、既存の読み込みと検証で確かめる。 */
export const checkTargetConfigFn = createServerFn({ method: 'GET' })
  .validator(requestOf<TargetConfigRequest>('ui-target-config'))
  .handler(async ({ data }): Promise<TargetConfigCheckView> => {
    if (!isAcceptedTargetConfigPath(data.targetConfigPath)) {
      return { ok: false, pathAccepted: false };
    }
    const { configError } = await loadTargetContext(data.targetConfigPath);
    return configError === null ? { ok: true } : { ok: false, pathAccepted: true, configError };
  });

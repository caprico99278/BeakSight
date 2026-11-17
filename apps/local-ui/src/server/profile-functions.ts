/**
 * 画面の Server Functions（Task 23 設計書 4.3、4.4、4.7。T23f）。
 * - 入力は、サーバで `schemas/control/` のスキーマ（`ui-*`）で検証してから使う。合わない入力は 400 で拒否し、何も保存しない。
 *   プロファイルの文書は、保存の部品（`src/control/store/profile-store.ts`）が Task 22 の `validateSiteProfile` で検証する。
 * - 書き込み（作成・更新・取り消し）は POST の Server Function だけで行う。読むだけのものは GET。
 * - 設定の文脈は、`isAcceptedTargetConfigPath` を通ったパスだけを、既存の `loadConfig` で読む（設定の検証の owner を写さない）。
 * - 返す値は、表示に要るものだけ（SQLite の生の誤りの文や、内部のパスの全体を返さない）。
 */
import { createServerFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import type { TargetConfigCreationFailure, TargetSiteInput, TargetSiteProblem } from '../../../../src/config/target-config-draft.js';
import { WRITE_AUDIT_MODE, type AuditMode, type AuthStrategy, type EnvironmentKind, type ProfileValidationErrorCode, type SiteProfile } from '../../../../src/control/contracts.js';
import { checkControlEnvironment } from '../../../../src/control/environment/control-environment.js';
import {
  PROFILE_SAVE_GUARD_REJECTIONS,
  profileSaveGuardRejectionOf,
  type ProfileSaveGuardRejection,
} from '../../../../src/control/auth/credential-destination.js';
import { isAcceptedTargetConfigPath, type ProfileValidationContext } from '../../../../src/control/profile-policy.js';
import {
  createProfile,
  getProfile,
  listProfiles,
  retireProfile,
  updateProfile,
  type GatedProfileStoreResult,
  type ProfileStoreRejectionReason,
  type ProfileStoreResult,
  type StoredProfile,
} from '../../../../src/control/store/profile-store.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import { CURRENT_AUTH_SETUP_FRESHNESS, getAuthSetup } from '../../../../src/control/store/auth-setup-store.js';
import { saveProfileAndAuthSetup } from '../../../../src/control/store/profile-auth-setup-store.js';
import { sortedKeysJsonOf } from '../../../../src/core/sorted-keys-json.js';
import { getStoreStatus } from '../../../../src/control/store/store-status.js';
import { localUiRepositoryRoot, localUiStore, relativeDatabaseLocation } from './control-store';
import { localUiCredentialServiceDependencies } from './credential-functions';
import { localUiCredentialEnvironment, type CredentialEnvironmentState } from './credential-runtime';
import { credentialRemainsOf, removeCredentialOfRetiredProfile, type RetiredCredentialCleanup } from './credential-service';
import { requestOf } from './request-validation';
import { loadTargetContext, targetConfigCandidatesIn } from './target-config';
import { createProfileFromRequest, type ProfileTargetChoice, type ProfileTargetRequest } from './target-config-writer';
import { isoTimestampOf } from './timestamps';
import { isIsolationUnverifiedEvidenceRef } from './isolation-evidence-ref';
export type { ProfileTargetChoice };

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

/**
 * プロファイルの詳細の画面の値（T26g-3: 資格情報のファイルが残っているか。値は持たない）。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章、3 章の 1）:
 * 前の手動のログインから登録した設定（ML-b）と、認証の設定の読む範囲・読まないパスの要約（T44d）は、サイトの画面に出さなくなったので、返さない（登録した設定は
 * 作業の画面と認証の設定の画面、読む範囲と読まないパスは監査の開始の画面が出す）。
 */
export interface ProfileDetailPageView extends ProfileDetailView {
  readonly credentialRemains: boolean;
  /**
   * PL-5（設計書 6 章の 6、PL-1 の判断 3）: 書き込みも試すサイトで、環境の証跡の参照が隔離の未確認の形か（判定は `isolation-evidence-ref.ts` の 1 か所）。
   * 真なら、要点に「本番との切り離し: まだ確かめていない」の印を出し続ける。
   */
  readonly writeIsolationUnverified: boolean;
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

/** MI-1: 開始の URL の Origin を許可 Origin に含む設定のファイルが 2 つ以上あった理由（詳しい設定で選んでもらう。何も保存していない）。 */
export const TARGET_CONFIG_AMBIGUOUS_REASON = 'TARGET_CONFIG_AMBIGUOUS';

/**
 * MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: 設定のファイルを 1 つに決められなかったときの結果（候補のパスは、
 * 作成の画面の選択肢と同じ、リポジトリの root からの相対パス）。
 */
export interface TargetConfigAmbiguousView {
  readonly ok: false;
  readonly reason: typeof TARGET_CONFIG_AMBIGUOUS_REASON;
  readonly candidates: readonly string[];
}

/**
 * MI-C（MI-1 の報告。設計者の判断）: 開始の URL の Origin を許可 Origin に含む設定のファイルはあるが、どれも別の開始の URL だった理由（新しいファイルを
 * 作らない。詳しい設定で選んでもらう。何も保存していない）。
 */
export const TARGET_CONFIG_START_URL_MISMATCH_REASON = 'TARGET_CONFIG_START_URL_MISMATCH';

/** MI-C: 同じ Origin で別の開始の URL のファイルしかなかったときの結果（候補は、その同じ Origin のファイル。形は `TargetConfigAmbiguousView` と同じ）。 */
export interface TargetConfigStartUrlMismatchView {
  readonly ok: false;
  readonly reason: typeof TARGET_CONFIG_START_URL_MISMATCH_REASON;
  readonly candidates: readonly string[];
}

/**
 * MI-F1（安全。設計書 4.7.1 の 1・2。MI-C2 項目 16 の `NEW_TARGET_FROM_AUTOMATED_LOGIN` の拒否を置き換えた）: プロファイルの保存（作成・更新）を、画面のサーバの
 * 口で拒んだ結果（理由は `PROFILE_SAVE_GUARD_REJECTIONS`。判定は `profileSaveGuardRejectionOf`。形は `ProfileChangeView` の拒否と同じ。何も保存していない）。
 */
export interface ProfileSaveGuardRejectionView {
  readonly ok: false;
  readonly reason: ProfileSaveGuardRejection;
  readonly errorCodes: readonly ProfileValidationErrorCode[];
  readonly configError: null;
}

/** プロファイルの保存（更新）の結果。 */
export type ProfileSaveView = ProfileChangeView | ProfileSaveGuardRejectionView;

/** 作成の結果（すでにある設定のファイルを使うときは `ProfileSaveView` だけ）。 */
export type ProfileCreateView = ProfileSaveView | TargetConfigRejectionView | TargetConfigAmbiguousView | TargetConfigStartUrlMismatchView;

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
  /**
   * MI-C: 対象の設定の選び方（明示の項目）。`AUTO`・`NEW` は `newTargetSite` を持つ（スキーマが確かめる）。省略は `EXISTING`（`profile.targetConfigPath`
   * のファイルを使う。T23 からの入力の形）。
   */
  readonly targetChoice?: ProfileTargetChoice;
  readonly profile: Readonly<Record<string, unknown>>;
  /** T43b: 開始の URL から決める選び方（`AUTO`・`NEW`）の、開始の URL と許可 Origin（`profile.targetConfigPath` は使わない）。 */
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

// 設定のファイルの候補の集め方は `target-config.ts` の `targetConfigCandidatesIn`（MI-1 で、作成の流れの自動の選び方と共用にするため移した）。

/** MI-F1: 口の判定で拒んだ結果（何も保存しない）。 */
const guardRejectionOf = (reason: ProfileSaveGuardRejection): ProfileSaveGuardRejectionView =>
  Object.freeze({ ok: false, reason, errorCodes: Object.freeze([]), configError: null });

const isProfileSaveGuardRejection = (reason: string): reason is ProfileSaveGuardRejection =>
  (PROFILE_SAVE_GUARD_REJECTIONS as readonly string[]).includes(reason);

/** MI-F5: 口の判定を保存の部品に渡した更新の結果を、画面の値にする（口の判定の理由は `guardRejectionOf`、ほかは今の `changeViewOf`）。 */
const gatedChangeViewOf = (result: GatedProfileStoreResult<ProfileSaveGuardRejection>, configError: ConfigErrorKind | null): ProfileSaveView =>
  (!result.ok && isProfileSaveGuardRejection(result.reason)
    ? guardRejectionOf(result.reason)
    : changeViewOf(result as ProfileStoreResult, configError));

/**
 * MI-C: 作成の入力の、対象の設定の選び方（スキーマが、`AUTO`・`NEW` には `newTargetSite` があり、`EXISTING` と省略には `newTargetSite` がないことを
 * 確かめた後に呼ぶ）。
 */
const targetRequestOf = (data: ProfileCreateRequest): ProfileTargetRequest => {
  const { targetChoice, newTargetSite } = data;
  return newTargetSite !== undefined && (targetChoice === 'AUTO' || targetChoice === 'NEW')
    ? { choice: targetChoice, site: newTargetSite }
    : { choice: 'EXISTING' };
};

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

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
    const writeIsolationUnverified = stored.profile.mode === WRITE_AUDIT_MODE && isIsolationUnverifiedEvidenceRef(stored.profile.environmentEvidenceRef);
    return { ...detailOf(stored), credentialRemains, writeIsolationUnverified };
  });

/**
 * プロファイルを作る（T43b: `newTargetSite` があれば、対象の設定のファイルを作ってから。MI-1: 作成の画面が送らなかった項目（名前、設定のファイル、
 * テスト環境の Origin、隔離が未確認の参照）を決める。MI-C: 対象の設定は、明示の選び方 `targetChoice` で決め、`AUTO` では、開始の URL の Origin と
 * 開始の URL が一致するファイルが 1 つあればそれを使う）。流れは `target-config-writer.ts` の
 * `createProfileFromRequest`（確かめ → 書く → 読み直して保存 → 失敗なら書いたファイルを消す、を含む）。ここは、本番の部品（管理データ、リポジトリの
 * root、`loadTargetContext`、設定のファイルの候補、時刻）を渡し、結果を画面の値にするだけ。
 */
export const createProfileFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ProfileCreateRequest>('ui-profile-create'))
  .handler(async ({ data }): Promise<ProfileCreateView> => {
    // MI-F1（設計書 4.7.1 の 1・2）: 作成では、承認したサービスの Origin を受けず、自動ログインのプロファイルを作らない（自動ログインへは、手動のログインの
    // 観察の後の切り替えだけで入る）。MI-F5（4.7.1 の 7）: 作成の判定は、保存してある値を読まず（保存の前の値は `null`）、入力だけで決まるので、読んでから書く
    // までの間の競合がない（同じ名前のプロファイルがあれば、保存の部品がトランザクションの中で `PROFILE_ALREADY_EXISTS` で拒む）。画面が読んだ改訂もない。
    const guarded = profileSaveGuardRejectionOf(null, data.profile);
    if (guarded !== null) {
      return guardRejectionOf(guarded);
    }
    const database = localUiStore();
    const root = localUiRepositoryRoot();
    const outcome = await createProfileFromRequest(data.profile, targetRequestOf(data), {
      root,
      profileExists: (profileId) => getProfile(database, profileId) !== null,
      loadContext: loadTargetContext,
      saveProfile: (profile, resolveContext) => createProfile(database, profile, { resolveContext }),
      profileIds: () => listProfiles(database).map((stored) => stored.profile.profileId),
      targetConfigCandidates: () => targetConfigCandidatesIn(root),
      now: () => new Date(),
    });
    switch (outcome.kind) {
      case 'TARGET_REJECTED':
        return { ok: false, reason: outcome.reason, siteProblems: outcome.siteProblems };
      case 'TARGET_AMBIGUOUS':
        return { ok: false, reason: TARGET_CONFIG_AMBIGUOUS_REASON, candidates: outcome.candidates };
      case 'TARGET_START_URL_MISMATCH':
        return { ok: false, reason: TARGET_CONFIG_START_URL_MISMATCH_REASON, candidates: outcome.candidates };
      case 'PROFILE_REJECTED':
        return { ok: false, reason: outcome.reason, errorCodes: outcome.errorCodes, configError: null };
      default:
        return changeViewOf(outcome.result, outcome.configError);
    }
  });

/**
 * プロファイルを次の改訂に更新する。MI-F1（設計書 4.7.1 の 1・2）: 方式によらず、承認したサービスの Origin を足す保存（今保存してある値にないもの）と、
 * 保存の前が自動ログインでないプロファイルを自動ログインにする保存を、何も保存せずに拒む（判定は `profileSaveGuardRejectionOf`。消すこと、手動へ戻すことは
 * 受ける）。自動ログインのプロファイルの送信先の変更は、保存の部品の層が拒む（`CREDENTIAL_DESTINATION_LOCKED`）。
 * MI-F5（安全。設計書 4.7.1 の 7。再レビュー MI-R2 の Important I-A）: 画面が読んだ改訂（`expectedRevision`）と今の改訂を先に照らし（違えば
 * `PROFILE_REVISION_CONFLICT`）、口の判定は、保存の部品の書き込みのトランザクションの中で、改訂の照合の後に、保存してある改訂に対して呼ぶ（`gate`。判定の関数は
 * `profileSaveGuardRejectionOf` の 1 か所のまま。読んでから書くまでの間に読み直さない）。プロファイルがなければ、保存の部品が `PROFILE_NOT_FOUND` で拒む。
 */
export const updateProfileFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ProfileUpdateRequest>('ui-profile-update'))
  .handler(async ({ data }): Promise<ProfileSaveView> => {
    const profileId = data.profile['profileId'];
    const stored = typeof profileId === 'string' ? getProfile(localUiStore(), profileId) : null;
    if (stored !== null && stored.profile.revision !== data.expectedRevision) {
      return { ok: false, reason: 'PROFILE_REVISION_CONFLICT', errorCodes: [], configError: null };
    }
    const targetConfigPath = data.profile['targetConfigPath'];
    const { context, configError } = await loadTargetContext(targetConfigPath);
    // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5、4.1.3 の 2）: 「毎回手でログインする」の切り替えだけの保存は、今の認証の設定を次の改訂に結び直す
    // （切り替えるたびに、ログインの設定が古くならないように）。保存の守り（4.7.1 の 3。送信先が変わらないこと）は、まとめて保存の部品が行う。
    const currentSetup = stored === null ? null : getAuthSetup(localUiStore(), stored.profile.profileId);
    if (stored !== null && currentSetup !== null && currentSetup.freshness === CURRENT_AUTH_SETUP_FRESHNESS
      && isLoginPreferenceOnlyChange(stored.profile, data.profile)) {
      const saved = saveProfileAndAuthSetup(localUiStore(), {
        profile: data.profile,
        expectedRevision: data.expectedRevision,
        setup: { ...currentSetup.setup, profileRevision: data.profile['revision'] },
      }, { resolveContext: resolverFor(targetConfigPath, context), now: () => new Date() });
      return saved.ok
        ? { ok: true, detail: detailOf(saved.profile) }
        : { ok: false, reason: saved.part === 'PROFILE' ? saved.reason : 'PROFILE_INVALID', errorCodes: saved.part === 'PROFILE' ? saved.errors.map((error) => error.code) : [], configError };
    }
    const result = updateProfile<ProfileSaveGuardRejection>(
      localUiStore(),
      { profile: data.profile, expectedRevision: data.expectedRevision },
      { resolveContext: resolverFor(targetConfigPath, context), gate: (previous) => profileSaveGuardRejectionOf(previous, data.profile) },
    );
    return gatedChangeViewOf(result, configError);
  });

/** 比べるための形（空の承認したサービスの Origin は、項目なしと同じ。保存の部品の扱いと同じ）。 */
const comparableProfileOf = (profile: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const { revision: _revision, loginPreference: _preference, approvedServiceOrigins, ...rest } = profile;
  return Array.isArray(approvedServiceOrigins) && approvedServiceOrigins.length > 0 ? { ...rest, approvedServiceOrigins } : rest;
};

/** OP-1: 保存してあるプロファイルと次の改訂の文書の違いが、ログインのしかたの希望（`loginPreference`）と改訂だけか。 */
const isLoginPreferenceOnlyChange = (current: SiteProfile, next: Readonly<Record<string, unknown>>): boolean =>
  current.loginPreference !== next['loginPreference']
  && sortedKeysJsonOf(comparableProfileOf(current as unknown as Readonly<Record<string, unknown>>)) === sortedKeysJsonOf(comparableProfileOf(next));

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
export const environmentStatusFn =createServerFn({ method: 'GET' }).handler(async (): Promise<EnvironmentStatusView> => {
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
  targetConfigCandidatesIn(localUiRepositoryRoot()));

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

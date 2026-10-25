/**
 * 認証の設定の Server Functions（Task 25 の設計書 4.1、4.5、4.6。T25e）。
 * - 読むだけのもの（設定の画面の値）は GET。保存は POST だけ。入力は、サーバで `schemas/control/` のスキーマ（`ui-profile-key`、
 *   `ui-auth-setup-save`）で確かめてから使う（`requestOf`）。設定の文書そのものは、保存の部品（`saveAuthSetup`）が、保存してあるプロファイルを
 *   今のターゲット設定で検証し直してから、`validateAuthSetup` で検証する（画面の確かめは補助だけ）。
 * - ターゲット設定は、保存してあるプロファイルが指すパスだけを、`isAcceptedTargetConfigPath` を通してから読む（`loadTargetContext`）。
 * - 返す値は、表示に要るものだけ。検証の誤りは、コードと項目と行だけ（英語の詳細を返さない。`authSetupErrorViewsOf`）。
 * - 認証の設定は秘密を含まない文書（設計書 3 章）。この画面には、秘密（パスワード、Cookie の値）を受ける入力も、返す値もない。
 */
import { createServerFn } from '@tanstack/react-start';
import { startUrlPathOf } from '../../../../src/config/target-config-draft.js';
import type { AuthSetup } from '../../../../src/control/auth/auth-setup-contracts.js';
import type { AuditMode, AuthStrategy } from '../../../../src/control/contracts.js';
import {
  AUTH_SETUP_STORE_REJECTION_REASONS,
  getAuthSetup,
  saveAuthSetup,
  type AuthSetupFreshness,
  type AuthSetupStoreRejectionReason,
  type StoredAuthSetup,
} from '../../../../src/control/store/auth-setup-store.js';
import { saveProfileAndAuthSetup } from '../../../../src/control/store/profile-auth-setup-store.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import { getProfile, type ProfileStoreRejectionReason } from '../../../../src/control/store/profile-store.js';
import { usesAuthSetup } from '../display/labels';
import { authSetupErrorViewsOf, type AuthSetupErrorView } from './auth-setup-errors';
import { localUiStore } from './control-store';
import { requestOf } from './request-validation';
import { loadTargetContext } from './target-config';
import { isoTimestampOf } from './timestamps';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 認証の設定の画面の、プロファイルの要点。 */
export interface AuthSetupProfileView {
  readonly profileId: string;
  readonly revision: number;
  readonly mode: AuditMode;
  readonly auth: AuthStrategy;
  readonly status: ProfileStatus;
  readonly approvedTestOrigins: readonly string[];
  /** T34d: 承認したサービスの Origin（項目のないプロファイルは空）。 */
  readonly approvedServiceOrigins: readonly string[];
}

/** 保存してある認証の設定。 */
export interface StoredAuthSetupView {
  readonly setup: AuthSetup;
  /** 今のプロファイルの改訂に結びつくか（`CURRENT`）、古いか（`STALE`）。 */
  readonly freshness: AuthSetupFreshness;
  /** 最後に保存した日時（ISO 8601。表示は `formatDateTime`）。 */
  readonly updatedAt: string;
}

/** 認証の設定の画面の値。 */
export interface AuthSetupPageView {
  readonly profile: AuthSetupProfileView;
  /**
   * このプロファイルで認証の設定を使うか（認証の設定が要るモードで、今実行できる認証の方式。`execution-policy.ts` の判定）。偽なら、画面は
   * フォームを出さない。
   */
  readonly eligible: boolean;
  readonly stored: StoredAuthSetupView | null;
  /**
   * T43b（Task 43 の設計書 4.2）: プロファイルが指す対象の設定の開始の URL の path（新しい認証の設定の案に使う）。保存した設定があるときと、
   * 対象の設定を読めないときは `null`。
   */
  readonly startUrlPath: string | null;
}

/** 保存の結果。拒否のときは、理由と、検証の誤り（ないときは空）。 */
export type AuthSetupSaveView =
  | { readonly ok: true; readonly stored: StoredAuthSetupView }
  | { readonly ok: false; readonly reason: AuthSetupStoreRejectionReason; readonly errors: readonly AuthSetupErrorView[] };

const storedViewOf = (stored: StoredAuthSetup): StoredAuthSetupView => ({
  setup: structuredClone(stored.setup),
  freshness: stored.freshness,
  updatedAt: isoTimestampOf(stored.updatedAt),
});

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface ProfileKeyRequest {
  readonly profileId: string;
}
interface AuthSetupSaveRequest {
  readonly setup: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** 認証の設定の画面の値（プロファイルの要点と、保存してある設定）。プロファイルがなければ `null`。 */
export const getAuthSetupFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<AuthSetupPageView | null> => {
    const database = localUiStore();
    const stored = getProfile(database, data.profileId);
    if (stored === null) {
      return null;
    }
    const { profile } = stored;
    const setup = getAuthSetup(database, profile.profileId);
    // T43b: 新しい認証の設定のときだけ、プロファイルが指す対象の設定（今の `loadTargetContext`）から開始の URL の path を読む。
    const startUrl = setup === null ? (await loadTargetContext(profile.targetConfigPath)).context?.targetConfig.site.startUrl : undefined;
    return {
      profile: {
        profileId: profile.profileId,
        revision: profile.revision,
        mode: profile.mode,
        auth: profile.auth,
        status: stored.status,
        approvedTestOrigins: [...profile.approvedTestOrigins],
        approvedServiceOrigins: [...(profile.approvedServiceOrigins ?? [])],
      },
      eligible: usesAuthSetup(profile.mode, profile.auth),
      stored: setup === null ? null : storedViewOf(setup),
      startUrlPath: startUrl === undefined ? null : (startUrlPathOf(startUrl) ?? null),
    };
  });

interface AuthSetupProfileSaveRequest {
  readonly setup: Readonly<Record<string, unknown>>;
  readonly expectedRevision: number;
  readonly addServiceOrigins: readonly string[];
}

/**
 * T43d: プロファイルの保存の部品の理由を、認証の設定の画面の拒否の理由（閉じた一覧）に写す。同じ名前の理由はそのまま、ほか（改訂が進まない、保存して
 * あるプロファイルが壊れているなど）はプロファイルを通せない（`PROFILE_INVALID`）。
 */
const authSetupReasonOfProfile = (reason: ProfileStoreRejectionReason): AuthSetupStoreRejectionReason =>
  (AUTH_SETUP_STORE_REJECTION_REASONS as readonly string[]).includes(reason) ? reason as AuthSetupStoreRejectionReason : 'PROFILE_INVALID';

/**
 * T43d（Task 43 の設計書 4.4）: 認証の設定と、プロファイルの承認したサービスの Origin に足す Origin を、1 回で保存する（管理データの 1 つの
 * トランザクション。`saveProfileAndAuthSetup`）。プロファイルの次の改訂は、保存してあるプロファイルに Origin を足したもの（画面が読んだ改訂
 * `expectedRevision` の照合を保つ）。認証の設定は、その次の改訂に結びつけて送る。
 */
export const saveAuthSetupWithServiceOriginsFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AuthSetupProfileSaveRequest>('ui-auth-setup-profile-save'))
  .handler(async ({ data }): Promise<AuthSetupSaveView> => {
    const database = localUiStore();
    const profileId = data.setup['profileId'];
    const current = typeof profileId === 'string' ? getProfile(database, profileId) : null;
    if (current === null) {
      return { ok: false, reason: 'PROFILE_NOT_FOUND', errors: [] };
    }
    const targetConfigPath = current.profile.targetConfigPath;
    const { context } = await loadTargetContext(targetConfigPath);
    const services = [...(current.profile.approvedServiceOrigins ?? [])];
    const next = {
      ...current.profile,
      revision: data.expectedRevision + 1,
      approvedServiceOrigins: [...services, ...data.addServiceOrigins.filter((origin) => !services.includes(origin))],
    };
    const result = saveProfileAndAuthSetup(database, { profile: next, expectedRevision: data.expectedRevision, setup: data.setup }, {
      resolveContext: (path) => (path === targetConfigPath ? context : undefined),
    });
    if (result.ok) {
      return { ok: true, stored: storedViewOf(result.stored) };
    }
    return result.part === 'AUTH_SETUP'
      ? { ok: false, reason: result.reason, errors: authSetupErrorViewsOf(result.errors) }
      : { ok: false, reason: authSetupReasonOfProfile(result.reason), errors: [] };
  });

/** 認証の設定を保存する（プロファイルごとに 1 つ。あれば置き換える）。 */
export const saveAuthSetupFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AuthSetupSaveRequest>('ui-auth-setup-save'))
  .handler(async ({ data }): Promise<AuthSetupSaveView> => {
    const database = localUiStore();
    const profileId = data.setup['profileId'];
    const current = typeof profileId === 'string' ? getProfile(database, profileId) : null;
    // 保存の部品は、保存してあるプロファイルの指すパスを `isAcceptedTargetConfigPath` で確かめてから、`resolveContext` を呼ぶ。ここでは、
    // そのパスだけを先に読む（読めなければ文脈なし）。
    const targetConfigPath = current?.profile.targetConfigPath;
    const { context } = await loadTargetContext(targetConfigPath);
    const result = saveAuthSetup(database, data.setup, {
      resolveContext: (path) => (path === targetConfigPath ? context : undefined),
    });
    return result.ok
      ? { ok: true, stored: storedViewOf(result.stored) }
      : { ok: false, reason: result.reason, errors: authSetupErrorViewsOf(result.errors) };
  });

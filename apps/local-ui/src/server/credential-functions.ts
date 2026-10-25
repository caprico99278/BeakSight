/**
 * 資格情報の画面の Server Functions（Task 26 の設計書 4.2、4.6、4.7。T26e）。
 * - 読むだけのもの（資格情報の画面の値）は GET。書き込み（登録、変更、入れ直し、削除、自動ログインの停止の解除）は POST だけ（Task 23・24 の
 *   Host、`localAddress`、cookie、CSRF、header、CSP の守りを、そのまま通る）。
 * - 入力は、サーバで `schemas/control/` のスキーマ（`ui-credential-register`・`ui-credential-change`・`ui-credential-replace`・`ui-profile-key`。
 *   長さの上限は `MAX_CREDENTIAL_VALUE_LENGTH`）で確かめてから使う（`requestOf`。合わなければ 400 で、値を返さない）。値の決まりは、資格情報の
 *   ファイルの部品が確かめ直す。処理は `credential-service.ts`。
 * - 応答に値を返さない。誤りの応答には、誤りのコードと項目の名前だけを入れる。
 * - FM2e: 1 回の操作で自動ログインの設定を終える要求（`setUpAutomatedLoginFn`。スキーマ `ui-automated-login-setup`。順は `setUpAutomatedLogin`）。
 */
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { getProfile } from '../../../../src/control/store/profile-store.js';
import { localUiAuditJobs } from './audit-jobs';
import { localUiStore } from './control-store';
import {
  changeCredential,
  clearCredentialHold,
  credentialPageOf,
  registerCredential,
  removeCredential,
  replaceCredential,
  setUpAutomatedLogin,
  type AutomatedLoginSetupRequest,
  type AutomatedLoginSetupResultView,
  type AutomatedLoginSetupView,
  type CredentialChangeRequest,
  type CredentialHoldClearView,
  type CredentialPageView,
  type CredentialRegisterRequest,
  type CredentialReplaceRequest,
  type CredentialRequestView,
  type CredentialServiceDependencies,
} from './credential-service';
import { isCredentialPlatformSupported, localUiCredentialEnvironment, localUiCredentialStore } from './credential-runtime';
import { requestOf } from './request-validation';
import { approvedScenarioCountOf } from './scenario-facts';
import { loadTargetContext } from './target-config';

export type { AutomatedLoginSetupResultView, AutomatedLoginSetupView, CredentialHoldClearView, CredentialPageView, CredentialRequestView };

interface ProfileKeyRequest {
  readonly profileId: string;
}

/**
 * 本番の部品（管理データ、資格情報のファイルの部品、ジョブの管理、サーバの判定）。組み立ては、ここ 1 か所（プロファイルの取り消しの片付け
 * `profile-functions.ts` も、これを使う。T26g-2 round 1）。
 * - サーバだけの関数（`createServerOnlyFn`）にする。公開した関数はブラウザのバンドルの組み立てでも残るので、普通の関数のままだと、その中で使う
 *   サーバの部品（管理データ、資格情報のファイルの部品）までブラウザに入り、読み込みで落ちる（T26g-2 round 1 の画面の検査で確かめた）。
 */
export const localUiCredentialServiceDependencies = createServerOnlyFn((): CredentialServiceDependencies => ({
  database: localUiStore(),
  store: localUiCredentialStore(),
  checkCredentialChange: (profileId) => localUiAuditJobs().checkCredentialChange(profileId),
  platformSupported: isCredentialPlatformSupported,
  environment: localUiCredentialEnvironment,
  now: () => new Date(),
  // FM2e: 1 回の操作で自動ログインに切り替える確認のダイアログの、承認が外れるシナリオの数（監査の負荷の変更と同じ部品）。
  approvedScenarioCount: approvedScenarioCountOf,
}));

/** 資格情報の画面の値（値を含まない）。プロファイルがなければ `null`。 */
export const getCredentialPageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(({ data }): Promise<CredentialPageView | null> => credentialPageOf(localUiCredentialServiceDependencies(), data.profileId));

/** 新しく登録する。 */
export const registerCredentialFn = createServerFn({ method: 'POST' })
  .validator(requestOf<CredentialRegisterRequest>('ui-credential-register'))
  .handler(({ data }): Promise<CredentialRequestView> => registerCredential(localUiCredentialServiceDependencies(), data));

/** 選んだ項目だけを変える。 */
export const changeCredentialFn = createServerFn({ method: 'POST' })
  .validator(requestOf<CredentialChangeRequest>('ui-credential-change'))
  .handler(({ data }): Promise<CredentialRequestView> => changeCredential(localUiCredentialServiceDependencies(), data));

/** ユーザー名とパスワードの両方を、今のログインの Origin で入れ直す。 */
export const replaceCredentialFn = createServerFn({ method: 'POST' })
  .validator(requestOf<CredentialReplaceRequest>('ui-credential-replace'))
  .handler(({ data }): Promise<CredentialRequestView> => replaceCredential(localUiCredentialServiceDependencies(), data));

/** 削除する。 */
export const removeCredentialFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(({ data }): Promise<CredentialRequestView> => removeCredential(localUiCredentialServiceDependencies(), data.profileId));

/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 1 回の操作で、認証の方式を自動ログインに変え、ログインの 3 つのセレクタを入れ、資格情報を登録する（確認の
 * ダイアログの後）。プロファイルの指す対象の設定だけを、今の部品（`loadTargetContext`）で先に読み、管理データの検証の文脈として渡す。
 */
export const setUpAutomatedLoginFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AutomatedLoginSetupRequest>('ui-automated-login-setup'))
  .handler(async ({ data }): Promise<AutomatedLoginSetupResultView> => {
    const deps = localUiCredentialServiceDependencies();
    const targetConfigPath = getProfile(deps.database, data.profileId)?.profile.targetConfigPath;
    const { context } = await loadTargetContext(targetConfigPath);
    return setUpAutomatedLogin(deps, data, { resolveContext: (path) => (path === targetConfigPath ? context : undefined) });
  });

/** 自動ログインの停止を解く（確かめのダイアログの後）。 */
export const clearAutoLoginHoldFn = createServerFn({ method: 'POST' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(({ data }): Promise<CredentialHoldClearView> => clearCredentialHold(localUiCredentialServiceDependencies(), data.profileId));

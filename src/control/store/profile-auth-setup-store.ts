// プロファイルと認証の設定のまとめて保存の唯一の owner（Task 43 の設計書 4.4「プロファイルと認証の設定の両方が変わるときは、1 回の保存で両方を書く
// （プロファイルの改訂で認証の設定が『古い』にならない形）」。T43d）。
// - 観察した要求の「登録する」の下書きが、プロファイルの承認したサービスの Origin と認証の設定の両方を変えるときに、画面のサーバが呼ぶ。
// - 検証と書き込みは、今の 2 つの保存の部品の口を使う: プロファイルの更新（`updateProfileWithFollowingWrite`。`validateSiteProfile`、改訂の照合、改訂が
//   増えることの確かめ。書き込みのトランザクションは保存の部品の中）と、その次の改訂に結びつけた認証の設定の検証（`validateAuthSetupForProfile`。
//   `validateAuthSetup`）と書き込み（`writeAuthSetupRow`。プロファイルを書いた直後に、同じトランザクションの中で呼ばれる）。
// - どちらかが通らなければ、どちらも書かない。画面が読んだ改訂と保存されている改訂が違えば `PROFILE_REVISION_CONFLICT`（今の改訂の照合を保つ）。
// - 拒否は、どちらの部品の理由か（`part`）と、その部品の閉じた一覧の理由の値で返す（日本語の説明は今の表示のカタログ）。
import { deepFreeze } from '../../core/immutable.js';
import type { AuthSetup, AuthSetupValidationError } from '../auth/auth-setup-contracts.js';
import type { ProfileValidationError } from '../contracts.js';
import {
  validateAuthSetupForProfile,
  writeAuthSetupRow,
  type AuthSetupStoreRejectionReason,
  type AuthSetupStoreResult,
  type StoredAuthSetup,
} from './auth-setup-store.js';
import type { ControlDatabase } from './control-database.js';
import {
  updateProfileWithFollowingWrite,
  type ProfileStoreRejectionReason,
  type ProfileWriteOptions,
  type StoredProfile,
} from './profile-store.js';

/** まとめて保存の依頼（`profile` は次の改訂の文書の全体、`expectedRevision` は画面が読んだ今の改訂、`setup` は次の改訂に結びつく設定）。 */
export interface ProfileAndAuthSetupSaveRequest {
  readonly profile: unknown;
  readonly expectedRevision: number;
  readonly setup: unknown;
}

/** まとめて保存の結果。 */
export type ProfileAndAuthSetupSaveResult =
  | { readonly ok: true; readonly profile: StoredProfile; readonly stored: StoredAuthSetup }
  | {
    readonly ok: false;
    readonly part: 'PROFILE';
    readonly reason: ProfileStoreRejectionReason;
    readonly detail: string;
    readonly errors: readonly ProfileValidationError[];
  }
  | {
    readonly ok: false;
    readonly part: 'AUTH_SETUP';
    readonly reason: AuthSetupStoreRejectionReason;
    readonly detail: string;
    readonly errors: readonly AuthSetupValidationError[];
  };

type AuthSetupRejection = Extract<AuthSetupStoreResult, { ok: false }>;

/**
 * プロファイルの次の改訂と、その改訂に結びつく認証の設定を、1 つのトランザクションで書く（ファイルの先頭）。データベースそのものの誤りは
 * `ControlStoreError` で投げる。
 */
export const saveProfileAndAuthSetup = (
  database: ControlDatabase,
  request: ProfileAndAuthSetupSaveRequest,
  options: ProfileWriteOptions,
): ProfileAndAuthSetupSaveResult => {
  const result = updateProfileWithFollowingWrite<AuthSetup, AuthSetupRejection, StoredAuthSetup>(
    database,
    { profile: request.profile, expectedRevision: request.expectedRevision },
    options,
    {
      validate: (candidate) => {
        // プロファイルの検証が同じパスで文脈を解決できたことを確かめてある。
        const context = options.resolveContext(candidate.targetConfigPath);
        if (context === undefined) {
          return { ok: false, rejection: deepFreeze({ ok: false, reason: 'TARGET_CONFIG_UNAVAILABLE', detail: 'the target configuration of the profile could not be resolved', errors: [] }) };
        }
        const validation = validateAuthSetupForProfile(request.setup, candidate, context);
        return validation.ok ? { ok: true, value: validation.setup } : { ok: false, rejection: validation };
      },
      write: (connection, setup) => {
        const written = writeAuthSetupRow(connection, setup, options.now);
        if (!written.ok) {
          // 書く部品は拒まない（型のための分岐）。投げると、プロファイルの書き込みも元に戻る。
          throw new Error('the auth setup row could not be written');
        }
        return written.stored;
      },
    },
  );
  if (result.ok) {
    return deepFreeze({ ok: true, profile: result.stored, stored: result.written });
  }
  if (result.part === 'PROFILE') {
    const { reason, detail, errors } = result.rejection;
    return deepFreeze({ ok: false, part: 'PROFILE', reason, detail, errors: [...errors] });
  }
  const { reason, detail, errors } = result.rejection;
  return deepFreeze({ ok: false, part: 'AUTH_SETUP', reason, detail, errors: [...errors] });
};

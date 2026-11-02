// プロファイルと認証の設定のまとめて保存の唯一の owner（Task 43 の設計書 4.4「プロファイルと認証の設定の両方が変わるときは、1 回の保存で両方を書く
// （プロファイルの改訂で認証の設定が『古い』にならない形）」。T43d）。
// - 観察した要求の「登録する」の下書きが、プロファイルの承認したサービスの Origin と認証の設定の両方を変えるときに、画面のサーバが呼ぶ。
// - 検証と書き込みは、今の 2 つの保存の部品の口を使う: プロファイルの更新（`updateProfileWithFollowingWrite`。`validateSiteProfile`、改訂の照合、改訂が
//   増えることの確かめ。書き込みのトランザクションは保存の部品の中）と、その次の改訂に結びつけた認証の設定の検証（`validateAuthSetupForProfile`。
//   `validateAuthSetup`）と書き込み（`writeAuthSetupRow`。プロファイルを書いた直後に、同じトランザクションの中で呼ばれる）。
// - どちらかが通らなければ、どちらも書かない。画面が読んだ改訂と保存されている改訂が違えば `PROFILE_REVISION_CONFLICT`（今の改訂の照合を保つ）。
// - 拒否は、どちらの部品の理由か（`part`）と、その部品の閉じた一覧の理由の値で返す（日本語の説明は今の表示のカタログ）。
// - MI-F1（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 3・4）: 保存の前も後も自動ログインのプロファイルなら、資格情報の送信先が変わる
//   保存を拒む（プロファイルの項目は `PROFILE` の、認証の設定の項目は `AUTH_SETUP` の `CREDENTIAL_DESTINATION_LOCKED`。どちらも書かない）。
// - MI-F5（設計書 4.7.1 の 6・7）: 画面の口（認証の設定の画面の、行から開いた下書きの保存）は、選択肢 `observedDestinationsOnly` を渡す。書き込みのトランザクション
//   の中で、保存してあった改訂と今保存してある設定から、口が受ける送信先の案（行の観察を足した設定）を求め、今の設定か案と同じ送信先だけを受ける（方式によらない。
//   違えば `AUTH_SETUP` の `CREDENTIAL_DESTINATION_OBSERVED_ONLY`）。観察の口（表の行の「登録する」）と切り替えは渡さない。
import { deepFreeze } from '../../core/immutable.js';
import type { AuthSetup, AuthSetupValidationError } from '../auth/auth-setup-contracts.js';
import type { ProfileValidationError, SiteProfile } from '../contracts.js';
import {
  credentialDestinationRejectionIn,
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

/** まとめて保存の選択肢（MI-F5: 画面の口の、送信先の案。`baselinesOf` は、トランザクションの中で読んだ、保存してあった改訂と今保存してある設定で呼ぶ）。 */
export interface ProfileAndAuthSetupWriteOptions extends ProfileWriteOptions {
  readonly observedDestinationsOnly?: {
    readonly baselinesOf: (previous: SiteProfile, stored: AuthSetup | null) => readonly AuthSetup[];
  };
}

/**
 * プロファイルの次の改訂と、その改訂に結びつく認証の設定を、1 つのトランザクションで書く（ファイルの先頭）。データベースそのものの誤りは
 * `ControlStoreError` で投げる。
 */
export const saveProfileAndAuthSetup = (
  database: ControlDatabase,
  request: ProfileAndAuthSetupSaveRequest,
  options: ProfileAndAuthSetupWriteOptions,
): ProfileAndAuthSetupSaveResult => {
  const observed = options.observedDestinationsOnly;
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
      // MI-F1（設計書 4.7.1 の 3・4）: 書き込みのトランザクションの中で、保存してあった改訂の方式と次の改訂の方式で、今保存してある設定と比べる（プロファイルの
      // 項目の送信先は、プロファイルの更新の部品が同じトランザクションで確かめる）。手動から自動への切り替え（`setUpAutomatedLogin`）は当たらない。
      // MI-F5（6・7）: 画面の口の選択肢があれば、同じトランザクションの中で、口の案（保存してあった改訂と今の設定から求める）とも比べる。
      check: (connection, previous, next, setup) => credentialDestinationRejectionIn(connection, previous.auth, next.auth, setup, observed === undefined
        ? undefined
        : { baselinesOf: (stored) => observed.baselinesOf(previous, stored) }),
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

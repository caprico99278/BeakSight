/**
 * 資格情報の画面のサーバの処理（Task 26 の設計書 4.2、4.7、変更履歴の「Blocker: T26d-2」。T26e）。サーバだけで使う。Server Function
 * （`credential-functions.ts`）は、本番の部品をこの関数に渡すだけ。テストは、偽の暗号化の部品で作った資格情報のファイルの部品を渡す。
 * - 書くのは画面のサーバだけ。資格情報のファイルの読み書きは `credential-store.ts`（`register`・`replaceAll`・`change`・`remove`・`readMetadata`）
 *   だけを通す。復号はしない（値を画面のサーバに戻さない）。
 * - 対象は、`AUTOMATED_LOGIN` のプロファイルだけ（`usesAutomatedLogin`。`TEST_AUTH_PASSIVE` と、T28b から `TEST_APPROVED_WRITE`）。保存・変更・入れ直しは、有効（`ACTIVE`）な
 *   プロファイルだけ。削除と停止の解除は、取り消したプロファイルでもできる（削除は秘密を減らすだけなので）。ほかのプロファイルへの直接の要求は
 *   `CREDENTIAL_NOT_ELIGIBLE` で拒む。ただし削除は、資格で拒まない（T26g-2 round 1。自動ログインでなくなったプロファイルに残ったファイルも
 *   消せる。画面の値も、残ったファイルの秘密でない項目を返す）。
 * - 確かめの順（値に触れる前に）: プロファイル → 対象か → Windows か（サーバの判定。違えば `CREDENTIAL_PLATFORM_UNSUPPORTED`。フォルダも作らない）
 *   → そのプロファイルのジョブが動いていないか（ジョブの管理の `checkCredentialChange`。動いていれば `CREDENTIAL_IN_USE`）→ 認証の設定の
 *   ログインの Origin（`loginOriginOf`。なければ `AUTH_SETUP_MISSING`）→ 2 回入れたパスワードの一致（`CREDENTIAL_CONFIRMATION_MISMATCH`）→
 *   資格情報のファイルの部品（値の決まりと長さ、Origin の一致、置き換え）。
 * - 置き換え（と削除）が成功した後にだけ、`credential_events` を書く（`recordCredentialEvent`。失敗したら書かない）。変更の画面の「自動ログインの
 *   停止も解く」を選んだときだけ、同じトランザクションで解除の記録も書く（`clearHold`）。
 * - 応答に値を返さない。誤りの応答と記録には、誤りのコードと項目の名前だけを入れる（`credential-errors.ts`）。値を持つ変数の参照は、ファイルの
 *   部品に渡した後に捨てる（`null` を入れる）。
 */
import { loginOriginOf, type AutomatedLoginFailureResult } from '../../../../src/control/auth/automated-login-results.js';
import type { AuditMode, AuthStrategy } from '../../../../src/control/contracts.js';
import {
  MAX_CREDENTIAL_VALUE_LENGTH,
  type CredentialChangeKind,
  type CredentialField,
  type CredentialMetadata,
  type CredentialStore,
} from '../../../../src/control/credentials/credential-store.js';
import type { CredentialChangeCheck } from '../../../../src/control/job/audit-job-manager.js';
import { clearAutoLoginHold, readAutoLoginHold, recordCredentialEvent } from '../../../../src/control/job/auto-login-store.js';
import { getAuthSetup } from '../../../../src/control/store/auth-setup-store.js';
import type { ControlDatabase } from '../../../../src/control/store/control-database.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { formatCompactUtcTimestamp } from '../../../../src/core/utc-timestamp.js';
import { usesAutomatedLogin } from '../display/labels';
import {
  credentialRejection,
  credentialRejectionOf,
  type CredentialRequestRejection,
  type CredentialRequestRejectionReason,
} from './credential-errors';
import type { CredentialEnvironmentState } from './credential-runtime';
import { isoTimestampOf } from './timestamps';

// ---------------------------------------------------------------------------------------------------------------
// 依存と、画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 処理が使う部品（本番は `credential-functions.ts` が渡す）。 */
export interface CredentialServiceDependencies {
  readonly database: ControlDatabase;
  readonly store: CredentialStore;
  /** 資格情報を変えてよいか（ジョブの管理の `checkCredentialChange`）。 */
  readonly checkCredentialChange: (profileId: string) => CredentialChangeCheck;
  /** 資格情報を保存できるプラットフォームか（サーバの判定）。 */
  readonly platformSupported: () => boolean;
  /** 資格情報の暗号化を、この環境で使えるか（起動のときの準備の結果）。 */
  readonly environment: () => Promise<CredentialEnvironmentState>;
  readonly now: () => Date;
}

/** 保存した資格情報の、秘密でない項目（日時は ISO 8601）。 */
export interface CredentialMetadataView {
  readonly loginOrigin: string;
  readonly credentialRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastChangeKind: CredentialChangeKind;
}

/** 止めている自動ログイン（日時は ISO 8601）。 */
export interface CredentialHoldView {
  readonly reason: AutomatedLoginFailureResult;
  readonly heldAt: string;
}

/** 資格情報の画面の値（値を持たない）。 */
export interface CredentialPageView {
  readonly profile: {
    readonly profileId: string;
    readonly revision: number;
    readonly mode: AuditMode;
    readonly auth: AuthStrategy;
    readonly status: ProfileStatus;
  };
  /** 自動ログインのプロファイルか（偽なら、画面は資格情報を出さない）。 */
  readonly eligible: boolean;
  readonly environment: CredentialEnvironmentState;
  /**
   * ユーザー名とパスワードの長さの上限（`MAX_CREDENTIAL_VALUE_LENGTH`。欄の説明に使う。資格情報のファイルの部品はブラウザのバンドルに入れないので、
   * サーバから渡す）。
   */
  readonly maxValueLength: number;
  /** 今の認証の設定のログインの Origin（認証の設定がなければ `null`）。 */
  readonly currentLoginOrigin: string | null;
  readonly credential: CredentialMetadataView | null;
  /** 保存した Origin が今の認証の設定と合うか（どちらかがなければ `null`）。 */
  readonly originMatches: boolean | null;
  /** 保存した資格情報を読めなかった理由（読めたか、ないときは `null`）。 */
  readonly readError: CredentialRequestRejectionReason | null;
  readonly hold: CredentialHoldView | null;
  /** そのプロファイルのジョブが動いている（変更と削除はできない）。 */
  readonly inUse: boolean;
}

/** 登録・変更・入れ直し・削除の結果（成功では、秘密でない項目だけ。削除の後は `credential` が `null`）。 */
export type CredentialRequestView =
  | { readonly ok: true; readonly credential: CredentialMetadataView | null; readonly holdCleared: boolean }
  | CredentialRequestRejection;

/** 停止の解除の結果（止めていなければ `cleared` が偽）。 */
export type CredentialHoldClearView = { readonly ok: true; readonly cleared: boolean } | CredentialRequestRejection;

/** 登録の入力（形はスキーマ `ui-credential-register` で確かめた後）。 */
export interface CredentialRegisterRequest {
  readonly profileId: string;
  readonly username: string;
  readonly password: string;
  readonly passwordConfirmation: string;
}

/** 入れ直しの入力（スキーマ `ui-credential-replace`）。 */
export interface CredentialReplaceRequest extends CredentialRegisterRequest {
  readonly clearHold: boolean;
}

/** 変更の入力（スキーマ `ui-credential-change`。`null` は変えない項目）。 */
export interface CredentialChangeRequest {
  readonly profileId: string;
  readonly username: string | null;
  readonly password: string | null;
  readonly passwordConfirmation: string | null;
  readonly clearHold: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------------------------------------------

/** 削除の記録の種類。 */
const DELETED_EVENT_KIND = 'DELETED';
/** 有効なプロファイルの状態。 */
const ACTIVE_STATUS = 'ACTIVE' satisfies ProfileStatus;
/** 2 回入れたパスワードの不一致の項目。 */
const PASSWORD_FIELD = 'password' satisfies CredentialField;

const metadataViewOf = (metadata: CredentialMetadata): CredentialMetadataView => Object.freeze({
  loginOrigin: metadata.loginOrigin,
  credentialRevision: metadata.credentialRevision,
  createdAt: isoTimestampOf(metadata.createdAt),
  updatedAt: isoTimestampOf(metadata.updatedAt),
  lastChangeKind: metadata.lastChangeKind,
});

const isEligible = (stored: StoredProfile): boolean => usesAutomatedLogin(stored.profile.mode, stored.profile.auth);

/** 今の認証の設定のログインの Origin（認証の設定がないか、求められなければ `null`）。 */
const currentLoginOriginOf = (database: ControlDatabase, profileId: string): string | null => {
  const setup = getAuthSetup(database, profileId);
  return setup === null ? null : (loginOriginOf(setup.setup.loginStartUrl) ?? null);
};

/** 対象のプロファイルの確かめ（保存・変更・入れ直しは `ACTIVE` だけ）。通らなければ拒否の応答。 */
const targetRejectionOf = (deps: CredentialServiceDependencies, profileId: string, requireActive: boolean): CredentialRequestRejection | null => {
  const stored = getProfile(deps.database, profileId);
  if (stored === null) {
    return credentialRejection('PROFILE_NOT_FOUND');
  }
  if (!isEligible(stored) || (requireActive && stored.status !== ACTIVE_STATUS)) {
    return credentialRejection('CREDENTIAL_NOT_ELIGIBLE');
  }
  return null;
};

/** 書き込みの前の確かめ（プロファイル、Windows、ジョブ、ログインの Origin）。通ればログインの Origin。 */
const writableOriginOf = (deps: CredentialServiceDependencies, profileId: string): { readonly loginOrigin: string } | CredentialRequestRejection => {
  const target = targetRejectionOf(deps, profileId, true);
  if (target !== null) {
    return target;
  }
  if (!deps.platformSupported()) {
    return credentialRejection('CREDENTIAL_PLATFORM_UNSUPPORTED');
  }
  const inUse = deps.checkCredentialChange(profileId);
  if (!inUse.ok) {
    return credentialRejection(inUse.reason);
  }
  const loginOrigin = currentLoginOriginOf(deps.database, profileId);
  return loginOrigin === null ? credentialRejection('AUTH_SETUP_MISSING') : Object.freeze({ loginOrigin });
};

/**
 * 置き換えが成功した後に、変更（と、選んだときは停止の解除）を記録する。記録の時刻は、削除と停止の解除と同じ依存の時計（`deps.now`）から取る
 * （DEF-078。資格情報のファイルの `updatedAt`（ファイルの部品の時計）を使うと、時計がずれたときに記録の順が逆になるため）。
 */
const recordChange = (
  deps: CredentialServiceDependencies,
  metadata: CredentialMetadata,
  clearHold: boolean,
): CredentialRequestView => {
  const { holdCleared } = recordCredentialEvent(
    deps.database,
    {
      profileId: metadata.profileId,
      kind: metadata.lastChangeKind,
      at: formatCompactUtcTimestamp(deps.now(), 'credential change time'),
      credentialRevision: metadata.credentialRevision,
    },
    { clearHold },
  );
  return Object.freeze({ ok: true, credential: metadataViewOf(metadata), holdCleared });
};

/** 値を部品に渡す（渡した後は、値の参照を捨てる）。部品の誤りは、コードと項目の名前だけの拒否の応答にする。 */
const withValues = async <TValues extends object>(
  values: TValues,
  operation: (values: TValues) => Promise<CredentialMetadata>,
): Promise<CredentialMetadata | CredentialRequestRejection> => {
  let held: TValues | null = values;
  try {
    return await operation(held);
  } catch (error) {
    return credentialRejectionOf(error);
  } finally {
    held = null;
  }
};

const isRejection = (value: CredentialMetadata | CredentialRequestRejection): value is CredentialRequestRejection =>
  'ok' in value && value.ok === false;

const mismatched = (password: string | null, confirmation: string | null): boolean => password !== confirmation;

// ---------------------------------------------------------------------------------------------------------------
// 処理
// ---------------------------------------------------------------------------------------------------------------

/** 資格情報の画面の値（プロファイルがなければ `null`）。自動ログインのプロファイルでなければ、資格情報のファイルを読まない。 */
export const credentialPageOf = async (deps: CredentialServiceDependencies, profileId: string): Promise<CredentialPageView | null> => {
  const stored = getProfile(deps.database, profileId);
  if (stored === null) {
    return null;
  }
  const { profile } = stored;
  const eligible = isEligible(stored);
  const environment = await deps.environment();
  const base = {
    profile: { profileId: profile.profileId, revision: profile.revision, mode: profile.mode, auth: profile.auth, status: stored.status },
    eligible,
    environment,
    maxValueLength: MAX_CREDENTIAL_VALUE_LENGTH,
  };
  let credential: CredentialMetadataView | null = null;
  let readError: CredentialRequestRejectionReason | null = null;
  try {
    const metadata = await deps.store.readMetadata(profileId);
    credential = metadata === null ? null : metadataViewOf(metadata);
  } catch (error) {
    readError = credentialRejectionOf(error).reason;
  }
  if (!eligible) {
    // T26g-2 round 1: 自動ログインでないプロファイルでも、ファイルが残っていれば（読めない場合を含む）、秘密でない項目を返す（画面は削除の
    // 操作だけを出す）。
    const remains = credential !== null || readError !== null;
    return Object.freeze({
      ...base,
      currentLoginOrigin: null,
      credential,
      originMatches: null,
      readError,
      hold: null,
      inUse: remains && !deps.checkCredentialChange(profileId).ok,
    });
  }
  const currentLoginOrigin = currentLoginOriginOf(deps.database, profileId);
  const hold = readAutoLoginHold(deps.database, profileId);
  return Object.freeze({
    ...base,
    currentLoginOrigin,
    credential,
    originMatches: credential === null || currentLoginOrigin === null ? null : credential.loginOrigin === currentLoginOrigin,
    readError,
    hold: hold === null ? null : Object.freeze({ reason: hold.reason, heldAt: isoTimestampOf(hold.heldAt) }),
    inUse: !deps.checkCredentialChange(profileId).ok,
  });
};

/**
 * 資格情報のファイルが残っているか（読めないファイルを含む。プロファイルがなければ偽）。プロファイルの詳細の画面が、認証の方式が自動ログインで
 * なくても資格情報の画面へのリンクを出すために使う（T26g-3）。判定は、資格情報の画面と同じ読み出し（`credentialPageOf`）で行う。
 */
export const credentialRemainsOf = async (deps: CredentialServiceDependencies, profileId: string): Promise<boolean> => {
  const page = await credentialPageOf(deps, profileId);
  return page !== null && (page.credential !== null || page.readError !== null);
};

/** 新しく登録する（ユーザー名とパスワードの両方が必須。パスワードは 2 回）。 */
export const registerCredential = async (deps: CredentialServiceDependencies, request: CredentialRegisterRequest): Promise<CredentialRequestView> => {
  const target = writableOriginOf(deps, request.profileId);
  if ('ok' in target) {
    return target;
  }
  if (mismatched(request.password, request.passwordConfirmation)) {
    return credentialRejection('CREDENTIAL_CONFIRMATION_MISMATCH', PASSWORD_FIELD);
  }
  const metadata = await withValues(
    { profileId: request.profileId, loginOrigin: target.loginOrigin, username: request.username, password: request.password },
    (values) => deps.store.register(values),
  );
  return isRejection(metadata) ? metadata : recordChange(deps, metadata, false);
};

/** ユーザー名とパスワードの両方を、今のログインの Origin で入れ直す（Origin が変わったとき）。 */
export const replaceCredential = async (deps: CredentialServiceDependencies, request: CredentialReplaceRequest): Promise<CredentialRequestView> => {
  const target = writableOriginOf(deps, request.profileId);
  if ('ok' in target) {
    return target;
  }
  if (mismatched(request.password, request.passwordConfirmation)) {
    return credentialRejection('CREDENTIAL_CONFIRMATION_MISMATCH', PASSWORD_FIELD);
  }
  const metadata = await withValues(
    { profileId: request.profileId, loginOrigin: target.loginOrigin, username: request.username, password: request.password },
    (values) => deps.store.replaceAll(values),
  );
  return isRejection(metadata) ? metadata : recordChange(deps, metadata, request.clearHold);
};

/** 選んだ項目だけを変える（`null` は変えない。どちらも選ばなければ、ファイルの部品が拒む）。 */
export const changeCredential = async (deps: CredentialServiceDependencies, request: CredentialChangeRequest): Promise<CredentialRequestView> => {
  const target = writableOriginOf(deps, request.profileId);
  if ('ok' in target) {
    return target;
  }
  if (request.password !== null && mismatched(request.password, request.passwordConfirmation)) {
    return credentialRejection('CREDENTIAL_CONFIRMATION_MISMATCH', PASSWORD_FIELD);
  }
  const metadata = await withValues(
    {
      profileId: request.profileId,
      loginOrigin: target.loginOrigin,
      ...(request.username === null ? {} : { username: request.username }),
      ...(request.password === null ? {} : { password: request.password }),
    },
    (values) => deps.store.change(values),
  );
  return isRejection(metadata) ? metadata : recordChange(deps, metadata, request.clearHold);
};

/** 削除する（確かめのダイアログの後）。削除できたら `DELETED` を記録する。 */
export const removeCredential = async (deps: CredentialServiceDependencies, profileId: string): Promise<CredentialRequestView> => {
  // T26g-2 round 1: 削除は、資格（自動ログインのプロファイルか）で拒まない（自動ログインでなくなったプロファイルに残ったファイルも消せる）。
  // ジョブが動いている間の拒否と、ファイルの部品のリンクの確かめは、そのまま。
  if (getProfile(deps.database, profileId) === null) {
    return credentialRejection('PROFILE_NOT_FOUND');
  }
  const inUse = deps.checkCredentialChange(profileId);
  if (!inUse.ok) {
    return credentialRejection(inUse.reason);
  }
  let revision: number | null = null;
  try {
    revision = (await deps.store.readMetadata(profileId))?.credentialRevision ?? null;
  } catch {
    // 読めない（壊れた）ファイルも削除できる。記録の改訂の番号は分からない。
    revision = null;
  }
  let removed: boolean;
  try {
    removed = await deps.store.remove(profileId);
  } catch (error) {
    return credentialRejectionOf(error);
  }
  if (!removed) {
    return credentialRejection('CREDENTIAL_MISSING');
  }
  recordCredentialEvent(deps.database, {
    profileId,
    kind: DELETED_EVENT_KIND,
    at: formatCompactUtcTimestamp(deps.now(), 'credential removal time'),
    credentialRevision: revision,
  });
  return Object.freeze({ ok: true, credential: null, holdCleared: false });
};

/**
 * 取り消したプロファイルの資格情報の片付けの結果（閉じた一覧。T26g-2、T26R の I1）。`REMOVED` は消して `DELETED` を記録した、`NONE` は
 * 消すものがない（ファイルがない、取り消していない）、`FAILED` は消せなかった（取り消しは巻き戻さない。
 * 画面は資格情報の画面から消すよう案内する）。
 */
export const RETIRED_CREDENTIAL_CLEANUPS = Object.freeze(['REMOVED', 'NONE', 'FAILED'] as const);
export type RetiredCredentialCleanup = (typeof RETIRED_CREDENTIAL_CLEANUPS)[number];

/** 消すものがないことを表す、削除の拒否の理由（ほかの拒否は、消せなかったとみなす。削除は資格で拒まない）。 */
const NOTHING_TO_REMOVE_REASONS: ReadonlySet<CredentialRequestRejectionReason> = new Set(['CREDENTIAL_MISSING']);
/** 取り消したプロファイルの状態。 */
const RETIRED_STATUS = 'RETIRED' satisfies ProfileStatus;

/**
 * 取り消しが成功した後に、そのプロファイルの資格情報のファイルを消し、`DELETED` を記録する（Task 26 の設計書 4.1、変更履歴の「T26R」の I1）。
 * 消す処理は `removeCredential`（削除の画面と同じ確かめと記録）を通す。取り消していないプロファイルでは何もしない（取り消しが失敗したら消さない）。
 * 例外を投げない（失敗は `FAILED`）。
 */
export const removeCredentialOfRetiredProfile = async (
  deps: CredentialServiceDependencies,
  profileId: string,
): Promise<RetiredCredentialCleanup> => {
  if (getProfile(deps.database, profileId)?.status !== RETIRED_STATUS) {
    return 'NONE';
  }
  try {
    const result = await removeCredential(deps, profileId);
    if (result.ok) {
      return 'REMOVED';
    }
    return NOTHING_TO_REMOVE_REASONS.has(result.reason) ? 'NONE' : 'FAILED';
  } catch {
    return 'FAILED';
  }
};

/** 自動ログインの停止を解く（確かめのダイアログの後の、明示の操作）。 */
export const clearCredentialHold = async (deps: CredentialServiceDependencies, profileId: string): Promise<CredentialHoldClearView> => {
  const target = targetRejectionOf(deps, profileId, false);
  if (target !== null) {
    return target;
  }
  let revision: number | null = null;
  try {
    revision = (await deps.store.readMetadata(profileId))?.credentialRevision ?? null;
  } catch {
    revision = null;
  }
  const cleared = clearAutoLoginHold(deps.database, profileId, formatCompactUtcTimestamp(deps.now(), 'auto login hold clearing time'), revision);
  return Object.freeze({ ok: true, cleared });
};

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
 * - FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインのプロファイルを、1 回の操作で自動ログインに切り替える（`setUpAutomatedLogin`。認証の方式・
 *   ログインの 3 つのセレクタ・資格情報。保存の順と戻し方は関数の説明）。資格情報の確かめは同じ規則で、前提の方式（保存の後の `AUTOMATED_LOGIN`）を
 *   渡して行う（`writableOriginOf` の `assumption`）。画面の値は `credentialPageOf` の `automatedLoginSetup`。
 * - MI-4（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.4）: 切り替えの前の確かめは `automatedLoginPlanOf`（OP-3: 前の「次から自動で
 *   ログインする」の判定 `automatedLoginReadinessOf` は、使い先がなくなったので消した）。セレクタの案は、最後の手動のログインの観察の案がなければ、最後の
 *   入口の確かめの案（`entryCheckLoginFields`）。
 */
import {
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../../../src/control/auth/auth-setup-contracts.js';
import { loginOriginOf, type AutomatedLoginFailureResult } from '../../../../src/control/auth/automated-login-results.js';
import {
  automatedLoginSwitchOf,
  credentialTargetRejectionOf,
  isCredentialEligible,
  offersAutomatedLoginSwitch,
  writableLoginOriginOf,
  type AutomatedLoginSelectors as AutomatedLoginSwitchSelectors,
  type CredentialWriteAssumption,
} from '../../../../src/control/auth/automated-login-switch.js';
import { AUTOMATED_LOGIN_AUTH_STRATEGY, type AuditMode, type AuthStrategy, type SiteProfile } from '../../../../src/control/contracts.js';
import { readAllJobs } from '../../../../src/control/job/job-store.js';
import { loginFieldDraftsOf, type LoginFieldDrafts } from '../../../../src/control/login-observation-draft.js';
import type { WorkerLoginFieldProposals } from '../../../../src/control/worker-protocol.js';
import { type ProfileValidationContext } from '../../../../src/control/profile-policy.js';
// PRE42-CC 組 UI-K2（CC-113）: 認証の設定の新しさは、owner の名前つきの定数と比べる（文字列で比べない）。
import {
  CURRENT_AUTH_SETUP_FRESHNESS,
  getAuthSetup,
  type StoredAuthSetup,
} from '../../../../src/control/store/auth-setup-store.js';
import { saveProfileAndAuthSetup, type ProfileAndAuthSetupSaveResult } from '../../../../src/control/store/profile-auth-setup-store.js';
import {
  MAX_CREDENTIAL_VALUE_LENGTH,
  MIN_CREDENTIAL_VALUE_LENGTH,
  type CredentialChangeKind,
  type CredentialField,
  type CredentialMetadata,
  type CredentialStore,
} from '../../../../src/control/credentials/credential-store.js';
import type { CredentialChangeCheck } from '../../../../src/control/job/audit-job-manager.js';
import { clearAutoLoginHold, readAutoLoginHold, recordCredentialEvent } from '../../../../src/control/job/auto-login-store.js';
import type { ControlDatabase } from '../../../../src/control/store/control-database.js';
import { ACTIVE_PROFILE_STATUS, RETIRED_PROFILE_STATUS, type ProfileStatus } from '../../../../src/control/store/profile-records.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { formatCompactUtcTimestamp } from '../../../../src/core/utc-timestamp.js';
import { offersAutomatedLogin } from '../display/labels';
import { authSetupErrorViewsOf, type AuthSetupErrorView } from './auth-setup-errors';
import { authSetupErrorViewsOfProfileAndAuthSetupSaveRejection, reasonOfProfileAndAuthSetupSaveRejection } from './profile-auth-setup-save-rejection';
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
  /**
   * FM2e: 今承認が有効なシナリオの数（自動ログインの設定の確認のダイアログに出す。本番はシナリオの承認の判定の事実から求める。省くと 0）。
   */
  readonly approvedScenarioCount?: (stored: StoredProfile) => Promise<number>;
  /**
   * MI-4（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.4）: 最後の入口の確かめの、ログインの 3 つの欄の案（`entry-check.json` の
   * `proposal.selectors`。入口の確かめの結果がないか、案がなければ `null`）。最後の手動のログインの観察の案がないときだけ、切り替えの画面の案に使う。省くと使わない。
   */
  readonly entryCheckLoginFields?: (profileId: string) => Promise<WorkerLoginFieldProposals | null>;
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

/**
 * FM2e（手を減らす段 2 の設計書 3A.4）: 1 回の操作で自動ログインの設定を終える欄の値（手動のログインのプロファイルで、自動ログインに進めるときだけ）。
 * 値（ユーザー名とパスワード）を持たない。
 */
export interface AutomatedLoginSetupView {
  /** 今の認証の設定が、今のプロファイルの改訂に結びついているか（偽なら、先に認証の設定の画面で保存し直す）。 */
  readonly authSetupCurrent: boolean;
  /** 今の認証の方式（保存の後は `AUTOMATED_LOGIN`）。 */
  readonly currentAuth: AuthStrategy;
  /** 最後の手動のログインの段の観察から作った案（推測の印つき。案のない欄は `null`）。 */
  readonly proposals: LoginFieldDrafts;
  /** 案のもとのジョブ（最後の手動のログインの観察の案のときだけ。ほかは `null`）。 */
  readonly proposalJobId: string | null;
  /** MI-4: 案のもと（最後の手動のログインの観察か、最後の入口の確かめか。案がなければ `null`）。 */
  readonly proposalSource: AutomatedLoginProposalSource | null;
  /** ログインの段の POST の回数の上限（今の値と、保存の後の値。自動ログインは 1 に固定）。 */
  readonly maxLoginAttempts: { readonly before: number; readonly after: number };
  /** 今承認が有効なシナリオの数（保存で改訂が進むので、承認が外れる）。 */
  readonly approvedScenarioCount: number;
  /**
   * PL-S（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 7 章・9 章の 2）: パスワードを入れる先（今の認証の設定のログインの画面のホストだけ。切り替えでは
   * 変わらない。求められなければ `null`）。確認のダイアログに出す。
   */
  readonly loginHost: string | null;
}

/**
 * MI-4: 切り替えの画面のセレクタの案のもと（閉じた一覧。使う順）。PL-4: 画面には出さない（案のもとの説明の文言はなくした）。値は案のもとの名前で、ジョブの種類の
 * 値（`WORKER_JOB_KINDS`）と重ならない名前にする（意味が違うため）。
 */
export const AUTOMATED_LOGIN_PROPOSAL_SOURCES = Object.freeze(['MANUAL_LOGIN_OBSERVATION', 'ENTRY_CHECK_PROPOSAL'] as const);
export type AutomatedLoginProposalSource = (typeof AUTOMATED_LOGIN_PROPOSAL_SOURCES)[number];

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
  /** T36c: ユーザー名とパスワードの長さの下限（`MIN_CREDENTIAL_VALUE_LENGTH`。欄の説明に使う。上限と同じく、サーバから渡す）。 */
  readonly minValueLength: number;
  /** 今の認証の設定のログインの Origin（認証の設定がなければ `null`）。 */
  readonly currentLoginOrigin: string | null;
  readonly credential: CredentialMetadataView | null;
  /** 保存した Origin が今の認証の設定と合うか（どちらかがなければ `null`）。 */
  readonly originMatches: boolean | null;
  /**
   * PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 2、作業記録 UX-1 の画面 C の 9 章の 1）: ID とパスワードの画面の要点の「ログインする先」の
   * ホスト（保存した資格情報のログインの Origin、なければ今の認証の設定のログインの Origin のホストだけ。Origin の表記は出さない。どちらもなければ `null`）。
   */
  readonly loginHost: string | null;
  /** 保存した資格情報を読めなかった理由（読めたか、ないときは `null`）。 */
  readonly readError: CredentialRequestRejectionReason | null;
  readonly hold: CredentialHoldView | null;
  /** そのプロファイルのジョブが動いている（変更と削除はできない）。 */
  readonly inUse: boolean;
  /** FM2e: 1 回の操作で自動ログインの設定を終える欄（認証の設定のある、有効な、手動のログインのプロファイルだけ。ほかは `null`）。 */
  readonly automatedLoginSetup: AutomatedLoginSetupView | null;
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
/** 2 回入れたパスワードの不一致の項目。 */
const PASSWORD_FIELD = 'password' satisfies CredentialField;

const metadataViewOf = (metadata: CredentialMetadata): CredentialMetadataView => Object.freeze({
  loginOrigin: metadata.loginOrigin,
  credentialRevision: metadata.credentialRevision,
  createdAt: isoTimestampOf(metadata.createdAt),
  updatedAt: isoTimestampOf(metadata.updatedAt),
  lastChangeKind: metadata.lastChangeKind,
});

/**
 * 自動ログインのプロファイルか・対象の確かめ・書く前の確かめ。OP-1 の修正の 1 回目（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 1）: 中身を
 * `src/control/auth/automated-login-switch.ts` へ移した（ジョブの管理の、ログインの直後の切り替えと共用する）。ここは部品を渡して呼ぶだけ。
 */
const isEligible = (stored: StoredProfile, auth?: AuthStrategy): boolean => isCredentialEligible(stored, auth);

/** 今の認証の設定のログインの Origin（認証の設定がないか、求められなければ `null`）。 */
const currentLoginOriginOf = (database: ControlDatabase, profileId: string): string | null => {
  const setup = getAuthSetup(database, profileId);
  return setup === null ? null : (loginOriginOf(setup.setup.loginStartUrl) ?? null);
};

const targetRejectionOf = (
  deps: CredentialServiceDependencies,
  profileId: string,
  requireActive: boolean,
  auth?: AuthStrategy,
): CredentialRequestRejection | null => credentialTargetRejectionOf(deps.database, profileId, requireActive, auth);

const writableOriginOf = (
  deps: CredentialServiceDependencies,
  profileId: string,
  assumption?: CredentialWriteAssumption,
): { readonly loginOrigin: string } | CredentialRequestRejection => writableLoginOriginOf(deps, profileId, assumption);

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
    minValueLength: MIN_CREDENTIAL_VALUE_LENGTH,
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
      loginHost: null,
      readError,
      hold: null,
      // FM2e: 1 回の操作の画面は、資格情報を登録するので、ジョブが動いている間は進めない（登録の今の確かめと同じ）。
      inUse: (remains || offersAutomatedLogin(profile.mode, profile.auth)) && !deps.checkCredentialChange(profileId).ok,
      automatedLoginSetup: await automatedLoginSetupViewOf(deps, stored),
    });
  }
  const currentLoginOrigin = currentLoginOriginOf(deps.database, profileId);
  const hold = readAutoLoginHold(deps.database, profileId);
  return Object.freeze({
    ...base,
    currentLoginOrigin,
    credential,
    originMatches: credential === null || currentLoginOrigin === null ? null : credential.loginOrigin === currentLoginOrigin,
    loginHost: loginHostOrNullOf(credential?.loginOrigin ?? currentLoginOrigin),
    readError,
    hold: hold === null ? null : Object.freeze({ reason: hold.reason, heldAt: isoTimestampOf(hold.heldAt) }),
    inUse: !deps.checkCredentialChange(profileId).ok,
    automatedLoginSetup: null,
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

/**
 * 取り消しが成功した後に、そのプロファイルの資格情報のファイルを消し、`DELETED` を記録する（Task 26 の設計書 4.1、変更履歴の「T26R」の I1）。
 * 消す処理は `removeCredential`（削除の画面と同じ確かめと記録）を通す。取り消していないプロファイルでは何もしない（取り消しが失敗したら消さない）。
 * 例外を投げない（失敗は `FAILED`）。
 */
export const removeCredentialOfRetiredProfile = async (
  deps: CredentialServiceDependencies,
  profileId: string,
): Promise<RetiredCredentialCleanup> => {
  if (getProfile(deps.database, profileId)?.status !== RETIRED_PROFILE_STATUS) {
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

// ---------------------------------------------------------------------------------------------------------------
// FM2e（手を減らす段 2 の設計書 3A.4）: 1 回の操作で自動ログインの設定を終える
// ---------------------------------------------------------------------------------------------------------------

/** 自動ログインの認証の方式（FM2R の Minor 4: 値は owner `contracts.ts` の定数）。 */
const AUTOMATED_LOGIN_STRATEGY = AUTOMATED_LOGIN_AUTH_STRATEGY;

/** 案のない状態（どの欄も `null`）。 */
const NO_LOGIN_FIELD_DRAFTS: LoginFieldDrafts = Object.freeze({ username: null, password: null, submit: null });


/**
 * 1 回の操作の拒否の理由（閉じた一覧。資格情報の確かめとファイルの部品の拒否は、資格情報の画面の理由 `CredentialRequestRejectionReason` のまま返す）。
 * - `PROFILE_NOT_FOUND`: プロファイルがない。
 * - `NOT_OFFERED`: 手動のログインの、有効なプロファイルでない（自動ログインに進める対象でない。すでに自動ログインのプロファイルを含む）。
 * - `PROFILE_REVISION_CONFLICT`: 画面が読んだ改訂と、保存してある改訂が違う（確かめの時と、管理データを書く時の両方で照らす）。
 * - `AUTH_SETUP_NOT_CURRENT`: 認証の設定がないか、今の改訂に結びついていない。
 * - `TARGET_CONFIG_UNAVAILABLE`: プロファイルの指す対象の設定を読めない。
 * - `PROFILE_INVALID`: 方式を変えたプロファイルが、プロファイルの検証を通らない。
 * - `AUTH_SETUP_INVALID`: セレクタを入れた認証の設定が、認証の設定の検証（`validateAuthSetup`）を通らない（`errors` に誤り）。
 * - `SAVE_FAILED`: 管理データを書けなかった（資格情報のファイルの後）。
 */
export const AUTOMATED_LOGIN_SETUP_REJECTION_REASONS = Object.freeze([
  'PROFILE_NOT_FOUND',
  'NOT_OFFERED',
  'PROFILE_REVISION_CONFLICT',
  'AUTH_SETUP_NOT_CURRENT',
  'TARGET_CONFIG_UNAVAILABLE',
  'PROFILE_INVALID',
  'AUTH_SETUP_INVALID',
  'SAVE_FAILED',
] as const);
export type AutomatedLoginSetupRejectionReason = (typeof AUTOMATED_LOGIN_SETUP_REJECTION_REASONS)[number];

/**
 * 管理データで失敗したときの、資格情報のファイルの戻し（閉じた一覧）。`NOT_NEEDED` はファイルを書く前に止めた、`REMOVED` は書いたファイルを消して前の
 * 状態に戻した、`FAILED` はファイルを消せなかった（画面は、資格情報の画面で消すよう案内する）。
 */
export const AUTOMATED_LOGIN_SETUP_ROLLBACKS = Object.freeze(['NOT_NEEDED', 'REMOVED', 'FAILED'] as const);
export type AutomatedLoginSetupRollback = (typeof AUTOMATED_LOGIN_SETUP_ROLLBACKS)[number];

/** 1 回の操作の入力（形はスキーマ `ui-automated-login-setup` で確かめた後）。値（ユーザー名とパスワード）は保存の処理の間だけ持つ。 */
export interface AutomatedLoginSetupRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
  readonly usernameSelector: string;
  readonly passwordSelector: string;
  readonly submitSelector: string;
  readonly username: string;
  readonly password: string;
  readonly passwordConfirmation: string;
}

/** 1 回の操作の、管理データの検証の文脈（本番は Server Function が、プロファイルの指す対象の設定を読んで渡す）。 */
export interface AutomatedLoginSetupOptions {
  readonly resolveContext: (targetConfigPath: string) => ProfileValidationContext | undefined;
}

/** 1 回の操作の結果（値を持たない）。 */
export type AutomatedLoginSetupResultView =
  | { readonly ok: true; readonly profileRevision: number; readonly credential: CredentialMetadataView | null }
  | (CredentialRequestRejection & { readonly kind: 'CREDENTIAL' })
  | {
    readonly ok: false;
    readonly kind: 'SETUP';
    readonly reason: AutomatedLoginSetupRejectionReason;
    readonly errors: readonly AuthSetupErrorView[];
    readonly rollback: AutomatedLoginSetupRollback;
  };

const setupRejection = (
  reason: AutomatedLoginSetupRejectionReason,
  errors: readonly AuthSetupErrorView[] = [],
  rollback: AutomatedLoginSetupRollback = 'NOT_NEEDED',
): AutomatedLoginSetupResultView => Object.freeze({ ok: false, kind: 'SETUP', reason, errors: Object.freeze([...errors]), rollback });

const credentialSideRejection = (rejection: CredentialRequestRejection): AutomatedLoginSetupResultView => Object.freeze({ ...rejection, kind: 'CREDENTIAL' });

/** 自動ログインに進める対象か（有効な、手動のログインのプロファイル。判定は表示の部品 `offersAutomatedLogin`）。 */
const offersSetUp = (stored: StoredProfile): boolean => offersAutomatedLoginSwitch(stored);

/**
 * 最後の手動のログインのジョブの観察から作った、欄の案と、そのジョブ（なければ `null`）。FM2R の Minor 6:
 * - 最後の手動のログインのジョブ（そのプロファイルの、ログインの段のまとめがあり、自動ログインの試しでないジョブのうち、いちばん新しいもの）の案だけを使う。
 *   そのジョブに案がなければ、古いジョブの案に戻らず `null`（案なし）。
 * - 案のもとのジョブの改訂が、今のプロファイルの改訂と違えば使わない。ジョブの改訂は、そのジョブからの自動の登録が保存したときは保存した改訂（手動の
 *   ログインの後の「次から自動でログインする」の形）、ほかはジョブを始めた改訂。
 */
const latestLoginFieldDraftsOf = (
  database: ControlDatabase,
  profileId: string,
  currentRevision: number,
): { readonly jobId: string; readonly drafts: LoginFieldDrafts } | null => {
  const job = readAllJobs(database).find((candidate) =>
    candidate.profileId === profileId && candidate.loginStage !== null && candidate.autoLoginAttempt === null);
  if (job === undefined) {
    return null;
  }
  const registration = job.loginStage?.autoRegistration;
  const revision = registration?.result === 'SAVED' ? registration.profileRevision : job.profileRevision;
  const drafts = revision === currentRevision ? loginFieldDraftsOf(job.loginStage?.observation) : null;
  return drafts === null ? null : { jobId: job.jobId, drafts };
};

/**
 * MI-4（設計書 4.4）: 切り替えの画面の 3 つのセレクタの案。最後の手動のログインの観察の案（`latestLoginFieldDraftsOf`。今どおり）を使い、それがないときだけ、
 * 最後の入口の確かめの案（同じ検出の部品の結果。案への写しも同じ `loginFieldDraftsOf`）を使う。どちらもなければ `null`。
 */
const loginFieldProposalsOf = async (
  deps: CredentialServiceDependencies,
  profileId: string,
  currentRevision: number,
): Promise<{ readonly jobId: string | null; readonly drafts: LoginFieldDrafts; readonly source: AutomatedLoginProposalSource } | null> => {
  const manual = latestLoginFieldDraftsOf(deps.database, profileId, currentRevision);
  if (manual !== null) {
    return { ...manual, source: 'MANUAL_LOGIN_OBSERVATION' };
  }
  const fields = deps.entryCheckLoginFields === undefined ? null : await deps.entryCheckLoginFields(profileId);
  const drafts = fields === null ? null : loginFieldDraftsOf({ loginFields: fields });
  return drafts === null ? null : { jobId: null, drafts, source: 'ENTRY_CHECK_PROPOSAL' };
};

/** 1 回の操作の欄の値（対象でなければ `null`）。 */
const automatedLoginSetupViewOf = async (deps: CredentialServiceDependencies, stored: StoredProfile): Promise<AutomatedLoginSetupView | null> => {
  if (!offersSetUp(stored)) {
    return null;
  }
  const { profile } = stored;
  const setup = getAuthSetup(deps.database, profile.profileId);
  // 認証の設定がまだないプロファイルは、手動のログインの設定から始める（この欄は、手動のログインの設定の後の「次から自動でログインする」の先）。
  if (setup === null) {
    return null;
  }
  const source = await loginFieldProposalsOf(deps, profile.profileId, profile.revision);
  return Object.freeze({
    authSetupCurrent: setup.freshness === CURRENT_AUTH_SETUP_FRESHNESS,
    currentAuth: profile.auth,
    proposals: source?.drafts ?? NO_LOGIN_FIELD_DRAFTS,
    proposalJobId: source?.jobId ?? null,
    proposalSource: source?.source ?? null,
    maxLoginAttempts: Object.freeze({ before: setup.setup.maxLoginAttempts, after: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS }),
    approvedScenarioCount: deps.approvedScenarioCount === undefined ? 0 : await deps.approvedScenarioCount(stored),
    loginHost: loginHostOf(setup.setup.loginStartUrl),
  });
};

/** PL-S: ログインの画面の URL のホスト（Origin の表記や path は出さない。求められなければ `null`）。 */
const loginHostOf = (loginStartUrl: string): string | null => {
  const origin = loginOriginOf(loginStartUrl);
  return origin === undefined ? null : new URL(origin).host;
};

/** PL-4: ログインの Origin（か URL）のホスト（値がないときは `null`。ホストの求め方は `loginHostOf` の 1 か所）。 */
const loginHostOrNullOf = (loginOriginOrUrl: string | null): string | null =>
  (loginOriginOrUrl === null ? null : loginHostOf(loginOriginOrUrl));

/** 管理データで失敗した後に、書いた資格情報のファイルを消す（例外を投げない）。 */
const removeWrittenCredential = async (deps: CredentialServiceDependencies, profileId: string): Promise<AutomatedLoginSetupRollback> => {
  try {
    return (await deps.store.remove(profileId)) ? 'REMOVED' : 'FAILED';
  } catch {
    return 'FAILED';
  }
};

// MI-C（CC-115）: 保存の部品の拒否を、この操作の理由に写す変換は `profile-auth-setup-save-rejection.ts`（「書き込みにも使う」と共用）。

/** 3 つのセレクタ（切り替えの入力の項目）。 */
type AutomatedLoginSelectors = AutomatedLoginSwitchSelectors;

/** 切り替えの前の確かめで拒む理由（`AUTOMATED_LOGIN_SETUP_REJECTION_REASONS` のうち、認証の設定からセレクタを入れた認証の設定の検証まで）。 */
type AutomatedLoginPlanRejectionReason = Extract<
  AutomatedLoginSetupRejectionReason,
  'AUTH_SETUP_NOT_CURRENT' | 'TARGET_CONFIG_UNAVAILABLE' | 'PROFILE_INVALID' | 'AUTH_SETUP_INVALID'
>;

/** 切り替えの前の確かめの結果。 */
type AutomatedLoginPlan =
  | {
    readonly ok: true;
    readonly context: ProfileValidationContext;
    readonly nextRevision: number;
    readonly nextProfile: SiteProfile;
    readonly nextSetup: AuthSetup;
  }
  | { readonly ok: false; readonly reason: AutomatedLoginPlanRejectionReason; readonly errors: readonly AuthSetupErrorView[] };

const planRejection = (reason: AutomatedLoginPlanRejectionReason, errors: readonly AuthSetupErrorView[] = []): AutomatedLoginPlan =>
  ({ ok: false, reason, errors });

/**
 * 切り替えの前の確かめ（`setUpAutomatedLogin` の 1. のうち、プロファイルと改訂の後の部分）:
 * 認証の設定が今の改訂に結びついているか → 対象の設定を読めたか → 方式を変えたプロファイルの検証 → セレクタを入れた認証の設定の検証（`validateAuthSetup`）。
 */
const automatedLoginPlanOf = (
  stored: StoredProfile,
  current: StoredAuthSetup | null,
  context: ProfileValidationContext | undefined,
  selectors: AutomatedLoginSelectors,
): AutomatedLoginPlan => {
  if (current === null || current.freshness !== CURRENT_AUTH_SETUP_FRESHNESS) {
    return planRejection('AUTH_SETUP_NOT_CURRENT');
  }
  if (context === undefined) {
    return planRejection('TARGET_CONFIG_UNAVAILABLE');
  }
  const nextRevision = stored.profile.revision + 1;
  const switched = automatedLoginSwitchOf(stored.profile, current.setup, nextRevision, context, selectors);
  if (!switched.ok) {
    return switched.reason === 'PROFILE_INVALID' ? planRejection('PROFILE_INVALID') : planRejection('AUTH_SETUP_INVALID', authSetupErrorViewsOf(switched.errors));
  }
  return { ok: true, context, nextRevision, nextProfile: switched.nextProfile, nextSetup: switched.nextSetup };
};

/**
 * 1 回の操作で、認証の方式を自動ログインに変え、ログインの 3 つのセレクタを入れ、資格情報を登録する（確認のダイアログの後）。順は次のとおり:
 * 1. 全部を確かめる（プロファイルと改訂、認証の設定、方式を変えたプロファイルの検証と、セレクタを入れた認証の設定の検証 `validateAuthSetup`、資格情報の
 *    確かめ（保存の後の方式で。Windows か、ジョブが動いていないか、ログインの Origin）、2 回入れたパスワードの一致）。どれかが通らなければ、何も書かない。
 * 2. 資格情報のファイルを書く（`register`。ファイルがすでにあれば拒み、触らない）。通らなければ、何も書かない。
 * 3. 管理データ（プロファイルの方式と、認証の設定のセレクタ）を 1 つのトランザクションで書く（`saveProfileAndAuthSetup`。改訂の照合を含む）。
 * 4. 管理データで失敗したら、書いた資格情報のファイルを消して、前の状態に戻す（消せなければ `FAILED` を返す）。
 * 5. 成功したら、資格情報の変更の記録（`CREATED`）を書く。「ログインを確かめる」は始めない（PL-4: 画面は点検の開始の画面へ移る。点検の最初の自動ログインが
 *    確かめを兼ねる）。
 * 値は、ファイルの部品に渡した後に捨てる（`withValues`）。応答に値を返さない。
 */
export const setUpAutomatedLogin = async (
  deps: CredentialServiceDependencies,
  request: AutomatedLoginSetupRequest,
  options: AutomatedLoginSetupOptions,
): Promise<AutomatedLoginSetupResultView> => {
  // 1. 全部を確かめる（値に触れる前に）。
  const stored = getProfile(deps.database, request.profileId);
  if (stored === null) {
    return setupRejection('PROFILE_NOT_FOUND');
  }
  if (!offersSetUp(stored)) {
    return setupRejection('NOT_OFFERED');
  }
  const { profile } = stored;
  if (profile.revision !== request.expectedRevision) {
    return setupRejection('PROFILE_REVISION_CONFLICT');
  }
  const { targetConfigPath } = profile;
  const plan = automatedLoginPlanOf(stored, getAuthSetup(deps.database, profile.profileId), options.resolveContext(targetConfigPath), request);
  if (!plan.ok) {
    return setupRejection(plan.reason, plan.errors);
  }
  const { context, nextRevision, nextProfile, nextSetup } = plan;
  const target = writableOriginOf(deps, profile.profileId, { auth: AUTOMATED_LOGIN_STRATEGY, loginStartUrl: nextSetup.loginStartUrl });
  if ('ok' in target) {
    return credentialSideRejection(target);
  }
  if (mismatched(request.password, request.passwordConfirmation)) {
    return credentialSideRejection(credentialRejection('CREDENTIAL_CONFIRMATION_MISMATCH', PASSWORD_FIELD));
  }
  // 2. 資格情報のファイルを書く。
  const metadata = await withValues(
    { profileId: profile.profileId, loginOrigin: target.loginOrigin, username: request.username, password: request.password },
    (values) => deps.store.register(values),
  );
  if (isRejection(metadata)) {
    return credentialSideRejection(metadata);
  }
  // 3. 管理データを 1 つのトランザクションで書く（失敗したら 4. ファイルを消す）。
  let saved: ProfileAndAuthSetupSaveResult | null;
  try {
    saved = saveProfileAndAuthSetup(deps.database, { profile: nextProfile, expectedRevision: profile.revision, setup: nextSetup }, {
      resolveContext: (path) => (path === targetConfigPath ? context : undefined),
      now: deps.now,
    });
  } catch {
    saved = null;
  }
  if (saved === null || !saved.ok) {
    const rollback = await removeWrittenCredential(deps, profile.profileId);
    return saved === null
      ? setupRejection('SAVE_FAILED', [], rollback)
      : setupRejection(reasonOfProfileAndAuthSetupSaveRejection(saved), authSetupErrorViewsOfProfileAndAuthSetupSaveRejection(saved), rollback);
  }
  // 5. 資格情報の変更の記録。
  const recorded = recordChange(deps, metadata, false);
  return Object.freeze({ ok: true, profileRevision: nextRevision, credential: recorded.ok ? recorded.credential : null });
};

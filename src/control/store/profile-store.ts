// 監査プロファイルの保存の唯一の owner（Task 23 の設計書 4.3 の「表（版 1）」「保存の前に」「取り消し」「公開の関数」。T23c）。
// - 保存の前に Task 22 の `validateSiteProfile` を通す。通らなければ保存せず、検証の誤りの一覧を返す。
// - 書き込みは、すべて `withWriteTransaction`（`BEGIN IMMEDIATE`）の中で行う。更新と取り消しは、同じトランザクションの中で今の行を読み、
//   呼び出し側が期待する今の改訂（楽観の確かめ）と比べる。
// - 前の改訂（保存してあった値）は、形（スキーマ）と行との一致（`profile_id`、`revision`、状態）だけを確かめ、今のターゲット設定や
//   組み合わせの規則では検証し直さない（Task 22 の `assertProfileRevisionAdvance` の決まり。T23c round 1）。形が壊れていたら止める。
// - 更新の次の改訂は `validateSiteProfile` を通し、`assertProfileRevisionAdvance` で改訂が増えることを確かめてから書く。
// - 取り消しは、行を消さず、改訂を 1 つ進めて状態を `RETIRED` にする。次の改訂の写しは Task 22 の `retiredRevisionOf` が作る（改訂の
//   数え方をここに書かない）。取り消しはターゲット設定を読まない。取り消したものは更新できない。同じ `profileId` で作り直せない。
// - すべての変更を `profile_revisions` に記録する（`CREATED`、`UPDATED`、`RETIRED`）。日時は UTC の 14 桁（`formatCompactUtcTimestamp`）。
// - 検証の文脈（参照するターゲット JSON を読み込んだ結果）は、呼び出し側が `resolveContext` で渡す（この部品はファイルを読まない。
//   ターゲット JSON の読み込みは CLI と画面のサーバの owner）。`resolveContext` を呼ぶ前に、パスの形を Task 22 の
//   `isAcceptedTargetConfigPath` で確かめ、通らないパスでは呼ばない（受けないパスのファイルを読ませない。T23c round 1）。
// - 拒否は、閉じた一覧の理由の値（`PROFILE_STORE_REJECTION_REASONS`）で返す。日本語の説明は `src/presentation/messages.ts`（T23d）。
//   データベースそのものの誤り（busy の待ちを過ぎた、読み取り専用、保存された文書が読めない）は `ControlStoreError` で投げる。
// - 生の接続（`ControlDatabase.connection`）を外へ出さない。返す値は凍結した写し。
import { DEFAULT_AUDIT_SEND_POLICY, isAuditSendPolicyName, type AuditSendPolicyName } from '../../core/audit-send-policy.js';
import { isRecord } from '../../core/guards.js';
import { deepFreeze } from '../../core/immutable.js';
import { formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import {
  MIN_PROFILE_REVISION,
  type ProfileValidationError,
  type SiteProfile,
  type ValidatedSiteProfile,
} from '../contracts.js';
import { validateControlDocument } from '../control-schema-validator.js';
import {
  assertProfileRevisionAdvance,
  isAcceptedTargetConfigPath,
  retiredRevisionOf,
  validateSiteProfile,
  type ProfileValidationContext,
} from '../profile-policy.js';
import type { ControlDatabase } from './control-database.js';
import {
  ACTIVE_PROFILE_STATUS,
  PROFILE_STATUSES,
  RETIRED_PROFILE_STATUS,
  type ProfileChangeKind,
  type ProfileStatus,
} from './profile-records.js';
import type { SqliteConnection } from './sqlite-module.js';
import { ControlStoreError } from './store-errors.js';
import { withWriteTransaction } from './transaction.js';

/** 保存の部品が変更を拒むときの理由（閉じた一覧）。 */
export const PROFILE_STORE_REJECTION_REASONS = Object.freeze([
  /** 新しい文書が `validateSiteProfile` を通らない（`errors` に検証の誤り）。 */
  'PROFILE_INVALID',
  /** 呼び出し側が、新しい文書が参照するターゲット JSON の検証の文脈を用意できない。 */
  'TARGET_CONFIG_UNAVAILABLE',
  /** 作成の改訂が最小値（`MIN_PROFILE_REVISION`）でない。 */
  'PROFILE_REVISION_NOT_INITIAL',
  /** 同じ `profileId` が、もうある（取り消したものを含む）。 */
  'PROFILE_ALREADY_EXISTS',
  /** 更新・取り消しの対象がない。 */
  'PROFILE_NOT_FOUND',
  /** 取り消したプロファイルは、更新も取り消しもできない。 */
  'PROFILE_RETIRED',
  /** 呼び出し側が期待する今の改訂と、保存されている改訂が違う（別の変更が先に保存された）。 */
  'PROFILE_REVISION_CONFLICT',
  /** 新しい改訂が、保存されている改訂より大きくない（`errors` に `assertProfileRevisionAdvance` の誤り）。 */
  'PROFILE_REVISION_NOT_ADVANCED',
  /** 保存されている文書が壊れている（形がスキーマに合わない、行と一致しない。`errors` に形の誤り）。変更しない。 */
  'STORED_PROFILE_INVALID',
] as const);
export type ProfileStoreRejectionReason = (typeof PROFILE_STORE_REJECTION_REASONS)[number];

/** `targetConfigPath` から、検証の文脈を返す。用意できなければ `undefined`（同期。呼び出し側が先に読み込んでおく）。 */
export type ProfileContextResolver = (targetConfigPath: string) => ProfileValidationContext | undefined;

/** 作成と更新の選択肢。 */
export interface ProfileWriteOptions {
  readonly resolveContext: ProfileContextResolver;
  /** 今の時刻（既定は `new Date()`）。 */
  readonly now?: () => Date;
}

/** 取り消しの選択肢（ターゲット設定を読まないので、文脈は求めない）。 */
export interface ProfileRetireOptions {
  /** 今の時刻（既定は `new Date()`）。 */
  readonly now?: () => Date;
}

/** 保存されているプロファイル（凍結）。 */
export interface StoredProfile {
  readonly profile: SiteProfile;
  readonly status: ProfileStatus;
  /** 最後に変えた日時（UTC の 14 桁）。 */
  readonly updatedAt: string;
}

/** 変更の結果。受けたら保存した後の値、拒んだら理由と詳細（英語）と検証の誤り（ないときは空）。 */
export type ProfileStoreResult =
  | { readonly ok: true; readonly stored: StoredProfile }
  | {
    readonly ok: false;
    readonly reason: ProfileStoreRejectionReason;
    readonly detail: string;
    readonly errors: readonly ProfileValidationError[];
  };

/** 更新の依頼。`profile` は新しい改訂の文書の全体。`expectedRevision` は、呼び出し側が読んだ今の改訂。 */
export interface ProfileUpdateRequest {
  readonly profile: unknown;
  readonly expectedRevision: number;
}

/** 取り消しの依頼。 */
export interface ProfileRetireRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
}

type Rejection = Extract<ProfileStoreResult, { ok: false }>;

/** `profiles` の 1 行。 */
interface ProfileRow {
  readonly profile_id: string;
  readonly revision: number;
  readonly status: string;
  readonly document: string;
  readonly updated_at: string;
}

const SELECT_PROFILE_SQL = 'SELECT profile_id, revision, status, document, updated_at FROM profiles WHERE profile_id = ?';
const SELECT_ALL_PROFILES_SQL = 'SELECT profile_id, revision, status, document, updated_at FROM profiles ORDER BY profile_id';
const INSERT_PROFILE_SQL = 'INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, ?, ?, ?, ?)';
const UPDATE_PROFILE_SQL =
  'UPDATE profiles SET revision = ?, status = ?, document = ?, updated_at = ? WHERE profile_id = ? AND revision = ?';
const INSERT_REVISION_SQL =
  'INSERT INTO profile_revisions (profile_id, revision, document, change_kind, recorded_at) VALUES (?, ?, ?, ?, ?)';

/** 1 回の変更で書き換える `profiles` の行の数。 */
const ONE_ROW = 1;

const NO_ERRORS: readonly ProfileValidationError[] = Object.freeze([]);

const rejected = (
  reason: ProfileStoreRejectionReason,
  detail: string,
  errors: readonly ProfileValidationError[] = NO_ERRORS,
): Rejection => deepFreeze({ ok: false, reason, detail, errors: [...errors] });

/** 形の誤り（Task 22 の `PROFILE_SCHEMA_INVALID`）。 */
const schemaError = (detail: string): ProfileValidationError => Object.freeze({ code: 'PROFILE_SCHEMA_INVALID', detail });

const accepted = (stored: StoredProfile): ProfileStoreResult => deepFreeze({ ok: true, stored });

const timestampOf = (now: (() => Date) | undefined): string =>
  formatCompactUtcTimestamp(now === undefined ? new Date() : now(), 'profile change time');

const isProfileStatus = (value: string): value is ProfileStatus => (PROFILE_STATUSES as readonly string[]).includes(value);

/** 1 行を読む（`profile_id` で）。 */
const readRow = (connection: SqliteConnection, profileId: string): ProfileRow | undefined =>
  connection.prepare(SELECT_PROFILE_SQL).get(profileId) as ProfileRow | undefined;

/** 行の文書の形の確かめ（文脈なしで確かめられる部分）。受けたら凍結したプロファイルと状態。 */
type RowCheck =
  | { readonly ok: true; readonly profile: SiteProfile; readonly status: ProfileStatus }
  | { readonly ok: false; readonly detail: string; readonly errors: readonly ProfileValidationError[] };

const checkRow = (row: ProfileRow): RowCheck => {
  if (!isProfileStatus(row.status)) {
    return { ok: false, detail: `status ${row.status} is not in the closed list`, errors: NO_ERRORS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document) as unknown;
  } catch {
    return { ok: false, detail: 'the stored document is not JSON', errors: NO_ERRORS };
  }
  const shape = validateControlDocument('profile', parsed);
  if (!shape.ok) {
    return {
      ok: false,
      detail: 'the stored document is not a profile',
      errors: shape.errors.map(schemaError),
    };
  }
  const profile = parsed as SiteProfile;
  if (profile.profileId !== row.profile_id || profile.revision !== row.revision) {
    return { ok: false, detail: 'the stored document does not match its row (profileId or revision)', errors: NO_ERRORS };
  }
  return { ok: true, profile: deepFreeze(profile), status: row.status };
};

/** 読み出し: 壊れた行は、データベースの誤りとして止める。 */
const storedOf = (row: ProfileRow): StoredProfile => {
  const check = checkRow(row);
  if (!check.ok) {
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', `stored profile ${row.profile_id}: ${check.detail}`);
  }
  return deepFreeze({ profile: check.profile, status: check.status, updatedAt: row.updated_at });
};

/**
 * 新しい文書を検証する（保存の前）。入力の写しを取り（写せない値は形の誤り）、以後は写しだけを読む。
 * `targetConfigPath` が文字列でない、または Task 22 の `isAcceptedTargetConfigPath` を通らないときは、`resolveContext` を呼ばずに拒む。
 * そのときの誤りは、`validateSiteProfile` と同じ順（形の誤りがあれば `PROFILE_SCHEMA_INVALID`、なければ `PROFILE_TARGET_PATH_INVALID`）。
 */
const validateIncoming = (
  input: unknown,
  resolveContext: ProfileContextResolver,
): { readonly ok: true; readonly profile: ValidatedSiteProfile } | Rejection => {
  let copy: unknown;
  try {
    copy = structuredClone(input);
  } catch {
    return rejected('PROFILE_INVALID', 'the profile must be a plain JSON value', [schemaError('profile must be a plain JSON value')]);
  }
  const targetConfigPath = isRecord(copy) ? copy['targetConfigPath'] : undefined;
  if (typeof targetConfigPath !== 'string' || !isAcceptedTargetConfigPath(targetConfigPath)) {
    const shape = validateControlDocument('profile', copy);
    return shape.ok
      ? rejected('PROFILE_INVALID', 'the profile did not pass validateSiteProfile', [
        Object.freeze({ code: 'PROFILE_TARGET_PATH_INVALID', detail: 'targetConfigPath is not accepted by isAcceptedTargetConfigPath' }),
      ])
      : rejected('PROFILE_INVALID', 'the profile did not pass validateSiteProfile', shape.errors.map(schemaError));
  }
  const context = resolveContext(targetConfigPath);
  if (context === undefined) {
    return rejected('TARGET_CONFIG_UNAVAILABLE', 'the target configuration of the profile could not be resolved');
  }
  const validation = validateSiteProfile(copy, context);
  return validation.ok ? validation : rejected('PROFILE_INVALID', 'the profile did not pass validateSiteProfile', validation.errors);
};

/**
 * 更新・取り消しの前の、今の行の確かめ（トランザクションの中）。行があること、取り消していないこと、期待する改訂と同じこと、文書の形と
 * 行との一致だけを確かめる（今のターゲット設定や組み合わせの規則では検証し直さない）。受けたら、保存してあった凍結したプロファイル。
 */
const currentForChange = (
  connection: SqliteConnection,
  profileId: string,
  expectedRevision: number,
): { readonly ok: true; readonly profile: SiteProfile } | Rejection => {
  const row = readRow(connection, profileId);
  if (row === undefined) {
    return rejected('PROFILE_NOT_FOUND', 'no profile has this profileId');
  }
  if (row.status === RETIRED_PROFILE_STATUS) {
    return rejected('PROFILE_RETIRED', 'a retired profile cannot be changed');
  }
  if (row.revision !== expectedRevision) {
    return rejected('PROFILE_REVISION_CONFLICT', `the stored revision is ${row.revision}, not the expected ${expectedRevision}`);
  }
  const check = checkRow(row);
  if (!check.ok) {
    return rejected('STORED_PROFILE_INVALID', check.detail, check.errors);
  }
  return { ok: true, profile: check.profile };
};

/** 改訂が増えることの確かめ（Task 22 の部品）。 */
const advanceOf = (
  previous: SiteProfile | null,
  next: ValidatedSiteProfile,
): { readonly ok: true; readonly profile: ValidatedSiteProfile } | Rejection => {
  const advance = assertProfileRevisionAdvance(previous, next);
  return advance.ok ? advance : rejected('PROFILE_REVISION_NOT_ADVANCED', 'the revision did not advance', advance.errors);
};

/** 履歴を 1 行書く（トランザクションの中）。 */
const recordRevision = (
  connection: SqliteConnection,
  profile: SiteProfile,
  document: string,
  changeKind: ProfileChangeKind,
  recordedAt: string,
): void => {
  connection.prepare(INSERT_REVISION_SQL).run(profile.profileId, profile.revision, document, changeKind, recordedAt);
};

/** 今の行を、次の改訂に書き換える（トランザクションの中。前の改訂の行だけを書き換える）。 */
const replaceRow = (
  connection: SqliteConnection,
  previousRevision: number,
  next: SiteProfile,
  status: ProfileStatus,
  changeKind: ProfileChangeKind,
  recordedAt: string,
): StoredProfile => {
  const document = JSON.stringify(next);
  const { changes } = connection.prepare(UPDATE_PROFILE_SQL)
    .run(next.revision, status, document, recordedAt, next.profileId, previousRevision);
  if (Number(changes) !== ONE_ROW) {
    // 同じトランザクションの中で読んだ行なので、起きないはず。起きたら書き込みを元に戻す（withWriteTransaction が ROLLBACK する）。
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', `expected to change one profile row, changed ${String(changes)}`);
  }
  recordRevision(connection, next, document, changeKind, recordedAt);
  return deepFreeze({ profile: next, status, updatedAt: recordedAt });
};

/** すべてのプロファイル（`profileId` の順。取り消したものを含む）。 */
export const listProfiles = (database: ControlDatabase): readonly StoredProfile[] => {
  const rows = database.connection.prepare(SELECT_ALL_PROFILES_SQL).all() as unknown as ProfileRow[];
  return Object.freeze(rows.map(storedOf));
};

/** 1 つのプロファイル。なければ `null`。 */
export const getProfile = (database: ControlDatabase, profileId: string): StoredProfile | null => {
  const row = readRow(database.connection, profileId);
  return row === undefined ? null : storedOf(row);
};

/** プロファイルを作る（`ACTIVE`、改訂は `MIN_PROFILE_REVISION`、履歴は `CREATED`）。 */
export const createProfile = (database: ControlDatabase, input: unknown, options: ProfileWriteOptions): ProfileStoreResult => {
  const incoming = validateIncoming(input, options.resolveContext);
  if (!incoming.ok) {
    return incoming;
  }
  if (incoming.profile.revision !== MIN_PROFILE_REVISION) {
    return rejected('PROFILE_REVISION_NOT_INITIAL', `a new profile must start at revision ${MIN_PROFILE_REVISION}`);
  }
  const advance = advanceOf(null, incoming.profile);
  if (!advance.ok) {
    return advance;
  }
  const next = advance.profile;
  return withWriteTransaction(database, (connection) => {
    if (readRow(connection, next.profileId) !== undefined) {
      return rejected('PROFILE_ALREADY_EXISTS', 'a profile with this profileId already exists');
    }
    const recordedAt = timestampOf(options.now);
    const document = JSON.stringify(next);
    connection.prepare(INSERT_PROFILE_SQL).run(next.profileId, next.revision, ACTIVE_PROFILE_STATUS, document, recordedAt);
    recordRevision(connection, next, document, 'CREATED', recordedAt);
    return accepted({ profile: next, status: ACTIVE_PROFILE_STATUS, updatedAt: recordedAt });
  });
};

/**
 * 検証した次の改訂を書く（書き込みのトランザクションの中だけで呼ぶ。今の行の確かめ、改訂の照合、改訂が増えることの確かめ、行と履歴の書き込み）。
 * T43d: `updateProfile` と `updateProfileWithFollowingWrite` が共有する。
 */
const applyUpdate = (
  connection: SqliteConnection,
  candidate: ValidatedSiteProfile,
  expectedRevision: number,
  now: (() => Date) | undefined,
): ProfileStoreResult => {
  const current = currentForChange(connection, candidate.profileId, expectedRevision);
  if (!current.ok) {
    return current;
  }
  const advance = advanceOf(current.profile, candidate);
  if (!advance.ok) {
    return advance;
  }
  return accepted(replaceRow(connection, current.profile.revision, advance.profile, ACTIVE_PROFILE_STATUS, 'UPDATED', timestampOf(now)));
};

/** プロファイルを更新する（次の改訂。履歴は `UPDATED`）。 */
export const updateProfile = (
  database: ControlDatabase,
  request: ProfileUpdateRequest,
  options: ProfileWriteOptions,
): ProfileStoreResult => {
  const incoming = validateIncoming(request.profile, options.resolveContext);
  if (!incoming.ok) {
    return incoming;
  }
  const candidate = incoming.profile;
  return withWriteTransaction(database, (connection) => applyUpdate(connection, candidate, request.expectedRevision, options.now));
};

/**
 * T43d（Task 43 の設計書 4.4）: プロファイルの次の改訂の後に、同じトランザクションで続けて書くもの。`validate` は次の改訂を検証した後、トランザクション
 * の外で呼ぶ（検証の結果を返す）。`write` は、プロファイルの行を書いた直後に、同じ書き込みのトランザクションの中で呼ぶ（投げると両方を元に戻す）。
 */
export interface ProfileFollowingWrite<TValidated, TRejection, TWritten> {
  readonly validate: (candidate: ValidatedSiteProfile) => { readonly ok: true; readonly value: TValidated } | { readonly ok: false; readonly rejection: TRejection };
  readonly write: (connection: SqliteConnection, value: TValidated) => TWritten;
}

/** `updateProfileWithFollowingWrite` の結果（どちらの拒否か）。 */
export type ProfileFollowingWriteResult<TRejection, TWritten> =
  | { readonly ok: true; readonly stored: StoredProfile; readonly written: TWritten }
  | { readonly ok: false; readonly part: 'PROFILE'; readonly rejection: Extract<ProfileStoreResult, { ok: false }> }
  | { readonly ok: false; readonly part: 'FOLLOWING'; readonly rejection: TRejection };

/**
 * プロファイルを更新し、続けて同じ書き込みのトランザクションで別のもの（認証の設定）を書く（T43d。プロファイルと認証の設定のまとめて保存
 * `profile-auth-setup-store.ts` が使う）。検証の決まりと改訂の照合は `updateProfile` と同じ。どちらかが拒めば、どちらも書かない。
 */
export const updateProfileWithFollowingWrite = <TValidated, TRejection, TWritten>(
  database: ControlDatabase,
  request: ProfileUpdateRequest,
  options: ProfileWriteOptions,
  following: ProfileFollowingWrite<TValidated, TRejection, TWritten>,
): ProfileFollowingWriteResult<TRejection, TWritten> => {
  const incoming = validateIncoming(request.profile, options.resolveContext);
  if (!incoming.ok) {
    return { ok: false, part: 'PROFILE', rejection: incoming };
  }
  const candidate = incoming.profile;
  const followed = following.validate(candidate);
  if (!followed.ok) {
    return { ok: false, part: 'FOLLOWING', rejection: followed.rejection };
  }
  return withWriteTransaction(database, (connection): ProfileFollowingWriteResult<TRejection, TWritten> => {
    const updated = applyUpdate(connection, candidate, request.expectedRevision, options.now);
    if (!updated.ok) {
      return { ok: false, part: 'PROFILE', rejection: updated };
    }
    return { ok: true, stored: updated.stored, written: following.write(connection, followed.value) };
  });
};

/**
 * プロファイルを取り消す（行は消さず、改訂を 1 つ進めて `RETIRED`。履歴は `RETIRED`）。ターゲット設定を読まない。
 * 次の改訂の写しは Task 22 の `retiredRevisionOf` が作る（形の誤りは `STORED_PROFILE_INVALID`、進められない改訂は
 * `PROFILE_REVISION_NOT_ADVANCED`）。
 */
export const retireProfile = (
  database: ControlDatabase,
  request: ProfileRetireRequest,
  options: ProfileRetireOptions = {},
): ProfileStoreResult => withWriteTransaction(database, (connection) => {
  const current = currentForChange(connection, request.profileId, request.expectedRevision);
  if (!current.ok) {
    return current;
  }
  const retired = retiredRevisionOf(current.profile);
  if (!retired.ok) {
    const schemaBroken = retired.errors.some((error) => error.code === 'PROFILE_SCHEMA_INVALID');
    return schemaBroken
      ? rejected('STORED_PROFILE_INVALID', 'the stored profile is not a profile', retired.errors)
      : rejected('PROFILE_REVISION_NOT_ADVANCED', 'the revision of the stored profile cannot be advanced', retired.errors);
  }
  return accepted(replaceRow(connection, current.profile.revision, retired.profile, RETIRED_PROFILE_STATUS, 'RETIRED', timestampOf(options.now)));
});

// ---------------------------------------------------------------------------------------------------------------
// FM-2（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.2）: プロファイルごとの表示の設定（管理データの版 15 の `profile_display_settings`）。
// 承認に結ばれるプロファイルの文書と改訂とは別に持ち、書いても、プロファイルの改訂・履歴・承認・発見の有効性を変えない。
// ---------------------------------------------------------------------------------------------------------------

/** プロファイルの表示の設定（AS-b から、監査の段の送信の扱いも持つ。どちらも承認に結ばれるプロファイルの改訂の外の設定）。 */
export interface ProfileDisplaySettings {
  /** 監査・発見・READ の確かめ・書き込みのジョブのブラウザを表示（headed）で起動するか。 */
  readonly showJobBrowser: boolean;
  /**
   * AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1）: 監査・発見・READ の確かめのジョブの、監査の段の送信の扱い（管理データの版 17 の
   * `audit_send_policy`。行がなければ既定の `READ_ONLY`）。ジョブの開始のときに `START` の `auditSendPolicy` で渡す。
   */
  readonly auditSendPolicy: AuditSendPolicyName;
}

/** 保存の入力（AS-b: 監査の段の送信の扱いを省略すると、今の値を変えない。行がなければ既定の `READ_ONLY`）。 */
export interface ProfileDisplaySettingsInput {
  readonly showJobBrowser: boolean;
  readonly auditSendPolicy?: AuditSendPolicyName;
}

/** 行のないプロファイルの表示の設定（既定は表示する・読み取りだけ）。 */
export const DEFAULT_PROFILE_DISPLAY_SETTINGS: ProfileDisplaySettings = Object.freeze({
  showJobBrowser: true,
  auditSendPolicy: DEFAULT_AUDIT_SEND_POLICY,
});

/** 表示の設定の保存が拒む理由（閉じた一覧）。 */
export const PROFILE_DISPLAY_SETTINGS_REJECTION_REASONS = Object.freeze(['PROFILE_NOT_FOUND', 'SETTINGS_INVALID'] as const);
export type ProfileDisplaySettingsRejectionReason = (typeof PROFILE_DISPLAY_SETTINGS_REJECTION_REASONS)[number];

/** 表示の設定の保存の結果。 */
export type ProfileDisplaySettingsSaveResult =
  | { readonly ok: true; readonly settings: ProfileDisplaySettings }
  | { readonly ok: false; readonly reason: ProfileDisplaySettingsRejectionReason };

const SELECT_DISPLAY_SETTINGS_SQL = 'SELECT show_job_browser, audit_send_policy FROM profile_display_settings WHERE profile_id = ?';
/** 行がなければ、扱いは列の既定（`READ_ONLY`）で作る。扱いを省略した保存は、行があれば扱いを変えない。 */
const UPSERT_DISPLAY_SETTINGS_SQL = `INSERT INTO profile_display_settings (profile_id, show_job_browser, updated_at) VALUES (?, ?, ?)
  ON CONFLICT (profile_id) DO UPDATE SET show_job_browser = excluded.show_job_browser, updated_at = excluded.updated_at`;
/** AS-b: 扱いも書く保存。 */
const UPSERT_DISPLAY_AND_AUDIT_SEND_SETTINGS_SQL = `INSERT INTO profile_display_settings (profile_id, show_job_browser, audit_send_policy, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (profile_id) DO UPDATE SET show_job_browser = excluded.show_job_browser, audit_send_policy = excluded.audit_send_policy,
    updated_at = excluded.updated_at`;

/** 表の行を設定の値にする（扱いが一覧の値でなければ、データベースの誤り。CHECK で起きない）。 */
const displaySettingsOfRow = (row: { readonly show_job_browser: number; readonly audit_send_policy: unknown }): ProfileDisplaySettings => {
  if (!isAuditSendPolicyName(row.audit_send_policy)) {
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', 'profile_display_settings.audit_send_policy is not a listed audit send policy');
  }
  return Object.freeze({ showJobBrowser: row.show_job_browser === 1, auditSendPolicy: row.audit_send_policy });
};

/** プロファイルの表示の設定を読む（行がなければ既定。プロファイルがなくても既定）。 */
export const readProfileDisplaySettings = (database: ControlDatabase, profileId: string): ProfileDisplaySettings => {
  const row = database.connection.prepare(SELECT_DISPLAY_SETTINGS_SQL).get(profileId) as
    | { readonly show_job_browser: number; readonly audit_send_policy: unknown }
    | undefined;
  return row === undefined ? DEFAULT_PROFILE_DISPLAY_SETTINGS : displaySettingsOfRow(row);
};

/**
 * プロファイルの表示の設定を保存する（行があれば置き換える）。プロファイルがなければ `PROFILE_NOT_FOUND`、表示の値が真偽でないか、AS-b の監査の段の送信の
 * 扱いが一覧の値でなければ `SETTINGS_INVALID`（どちらも書かない）。扱いを省略すると、今の値を変えない（行がなければ既定の `READ_ONLY`）。プロファイルの行と
 * 改訂と履歴は変えない。データベースそのものの誤りは `ControlStoreError` で投げる。結果の設定は、保存した後の行の値。
 */
export const saveProfileDisplaySettings = (
  database: ControlDatabase,
  profileId: string,
  settings: ProfileDisplaySettingsInput,
  options: { readonly now?: () => Date } = {},
): ProfileDisplaySettingsSaveResult => {
  const showJobBrowser: unknown = isRecord(settings) ? settings.showJobBrowser : undefined;
  const auditSendPolicyGiven = isRecord(settings) && Object.hasOwn(settings, 'auditSendPolicy');
  const auditSendPolicy: unknown = auditSendPolicyGiven ? settings.auditSendPolicy : undefined;
  if (typeof showJobBrowser !== 'boolean' || (auditSendPolicyGiven && !isAuditSendPolicyName(auditSendPolicy))) {
    return Object.freeze({ ok: false, reason: 'SETTINGS_INVALID' });
  }
  return withWriteTransaction(database, (connection) => {
    if (typeof profileId !== 'string' || readRow(connection, profileId) === undefined) {
      return Object.freeze({ ok: false, reason: 'PROFILE_NOT_FOUND' } as const);
    }
    const updatedAt = timestampOf(options.now);
    if (isAuditSendPolicyName(auditSendPolicy)) {
      connection.prepare(UPSERT_DISPLAY_AND_AUDIT_SEND_SETTINGS_SQL).run(profileId, showJobBrowser ? 1 : 0, auditSendPolicy, updatedAt);
    } else {
      connection.prepare(UPSERT_DISPLAY_SETTINGS_SQL).run(profileId, showJobBrowser ? 1 : 0, updatedAt);
    }
    const row = connection.prepare(SELECT_DISPLAY_SETTINGS_SQL).get(profileId) as { readonly show_job_browser: number; readonly audit_send_policy: unknown };
    return Object.freeze({ ok: true, settings: displaySettingsOfRow(row) } as const);
  });
};

// 認証の設定の保存の唯一の owner（Task 25 の設計書 4.1 の「保存」。管理データの版 3 の `auth_setups`。T25a round 1）。
// - 保存（`saveAuthSetup`）の前に、保存してあるプロファイルを読み、今のターゲット設定の文脈で `validateSiteProfile` を通し直し、
//   `validateAuthSetup` を通す。通らなければ書かず、閉じた一覧の理由の値（`AUTH_SETUP_STORE_REJECTION_REASONS`）で返す。
//   ターゲット設定の文脈は、呼び出し側が `resolveContext` で渡す（この部品はファイルを読まない。`profile-store.ts` と同じ）。`resolveContext`
//   を呼ぶ前に、パスの形を Task 22 の `isAcceptedTargetConfigPath` で確かめる（受けないパスのファイルを読ませない）。
// - 検証はトランザクションの外で行い、書き込みのトランザクション（`withWriteTransaction`）の中で、プロファイルの行を読み直して、検証した
//   改訂と同じで取り消していないことを確かめてから書く（違えば `PROFILE_REVISION_CONFLICT`）。プロファイルごとに 1 行（置き換え）。
// - 読み（`getAuthSetup`）は、読むだけの入口（`withReadTransaction`）の中で、設定の行とプロファイルの行を読む。保存してあった文書は、形
//   （スキーマ）と行との一致だけを確かめ、今の文脈では検証し直さない（壊れていれば `ControlStoreError` の `DATABASE_INTEGRITY_FAILED`）。
//   プロファイルの改訂が変わった（取り消しを含む）設定は、`freshness: 'STALE'` で返す（古い改訂の設定では監査を始めない。設計書 4.1）。
// - LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 保存も読み出しも版 3 だけ（`validateAuthSetup` が版 3 だけを受け、読むときは版 3 のスキーマで
//   確かめる）。版 1・版 2 の文書の行は、読み替えずに壊れた行（`DATABASE_INTEGRITY_FAILED`）にする（T26b・T34a の読み替えは捨てた）。
// - 秘密（Cookie、localStorage、パスワード）は扱わない（認証の設定は秘密を含まない文書。設計書 3 章）。
// - 生の接続（`ControlDatabase.connection`）を外へ出さない。返す値は凍結した写し。
import {
  AUTH_SETUP_FRESHNESS_VALUES,
  CURRENT_AUTH_SETUP_FRESHNESS,
  STALE_AUTH_SETUP_FRESHNESS,
  type AuthSetupFreshness,
} from '../../core/auth-setup-freshness.js';
import { deepFreeze } from '../../core/immutable.js';
import { isRecord } from '../../core/guards.js';
import { formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import {
  AUTH_SETUP_SCHEMA_NAME,
  type AuthSetup,
  type AuthSetupValidationError,
} from '../auth/auth-setup-contracts.js';
import { validateAuthSetup } from '../auth/auth-setup-policy.js';
import { validateControlDocument } from '../control-schema-validator.js';
import type { ValidatedSiteProfile } from '../contracts.js';
import { isAcceptedTargetConfigPath, validateSiteProfile, type ProfileValidationContext } from '../profile-policy.js';
import type { ControlDatabase } from './control-database.js';
import { ACTIVE_PROFILE_STATUS, RETIRED_PROFILE_STATUS } from './profile-records.js';
import { getProfile, type ProfileContextResolver, type StoredProfile } from './profile-store.js';
import type { SqliteConnection } from './sqlite-module.js';
import { ControlStoreError } from './store-errors.js';
import { withReadTransaction, withWriteTransaction } from './transaction.js';

/** 保存の部品が設定を拒むときの理由（閉じた一覧）。 */
export const AUTH_SETUP_STORE_REJECTION_REASONS = Object.freeze([
  /** 設定が `validateAuthSetup` を通らない（`errors` に検証の誤り。写せない値と `profileId` のない値を含む）。 */
  'AUTH_SETUP_INVALID',
  /** 結びつくプロファイルがない。 */
  'PROFILE_NOT_FOUND',
  /** 結びつくプロファイルを取り消してある。 */
  'PROFILE_RETIRED',
  /** 呼び出し側が、プロファイルが参照するターゲット JSON の検証の文脈を用意できない。 */
  'TARGET_CONFIG_UNAVAILABLE',
  /** 保存してあるプロファイルが、今のターゲット設定の文脈で `validateSiteProfile` を通らない。 */
  'PROFILE_INVALID',
  /** 検証の後、書き込みの前に、プロファイルが変わった（別の変更が先に保存された）。 */
  'PROFILE_REVISION_CONFLICT',
] as const);
export type AuthSetupStoreRejectionReason = (typeof AUTH_SETUP_STORE_REJECTION_REASONS)[number];

/**
 * 保存してある設定が、今のプロファイルの改訂に結びつくか（`CURRENT`）、古いか（`STALE`。改訂が変わった、取り消した）。PRE42-CC 組 UI-K2（CC-113）:
 * 定義は、画面のブラウザ側からも読める純粋なファイル `src/core/auth-setup-freshness.ts` に移し、ここは同じ名前で公開し直す。
 */
export { AUTH_SETUP_FRESHNESS_VALUES, CURRENT_AUTH_SETUP_FRESHNESS, STALE_AUTH_SETUP_FRESHNESS, type AuthSetupFreshness };

/** 保存してある認証の設定（凍結）。 */
export interface StoredAuthSetup {
  readonly setup: AuthSetup;
  /** 最後に保存した日時（UTC の 14 桁）。 */
  readonly updatedAt: string;
  readonly freshness: AuthSetupFreshness;
  /** 読んだ時点の、結びつくプロファイルの改訂。 */
  readonly profileRevision: number;
}

/** 保存の結果。受けたら保存した後の値、拒んだら理由と詳細（英語。設定の値を入れない）と検証の誤り（ないときは空）。 */
export type AuthSetupStoreResult =
  | { readonly ok: true; readonly stored: StoredAuthSetup }
  | {
    readonly ok: false;
    readonly reason: AuthSetupStoreRejectionReason;
    readonly detail: string;
    readonly errors: readonly AuthSetupValidationError[];
  };

/** 保存の選択肢。 */
export interface AuthSetupWriteOptions {
  readonly resolveContext: ProfileContextResolver;
  /** 今の時刻（既定は `new Date()`）。 */
  readonly now?: () => Date;
}

type Rejection = Extract<AuthSetupStoreResult, { ok: false }>;

/** `auth_setups` の 1 行。 */
interface AuthSetupRow {
  readonly profile_id: string;
  readonly profile_revision: number;
  readonly document: string;
  readonly updated_at: string;
}

const SELECT_AUTH_SETUP_SQL = 'SELECT profile_id, profile_revision, document, updated_at FROM auth_setups WHERE profile_id = ?';
const UPSERT_AUTH_SETUP_SQL = 'INSERT INTO auth_setups (profile_id, profile_revision, document, updated_at) VALUES (?, ?, ?, ?) '
  + 'ON CONFLICT (profile_id) DO UPDATE SET profile_revision = excluded.profile_revision, document = excluded.document, '
  + 'updated_at = excluded.updated_at';

const NO_ERRORS: readonly AuthSetupValidationError[] = Object.freeze([]);

const rejected = (
  reason: AuthSetupStoreRejectionReason,
  detail: string,
  errors: readonly AuthSetupValidationError[] = NO_ERRORS,
): Rejection => deepFreeze({ ok: false, reason, detail, errors: [...errors] });

/** 形の誤り（`validateAuthSetup` の `AUTH_SETUP_SCHEMA_INVALID`）。`pointer` は誤りのある項目の位置（CCX-23。値全体を写せないときは `null`）。 */
const schemaError = (detail: string, pointer: string | null): AuthSetupValidationError =>
  Object.freeze({ code: 'AUTH_SETUP_SCHEMA_INVALID', detail, pointer });

const timestampOf = (now: (() => Date) | undefined): string =>
  formatCompactUtcTimestamp(now === undefined ? new Date() : now(), 'auth setup change time');

/** 設定が、今のプロファイルの改訂に結びつくか。 */
const freshnessOf = (setup: AuthSetup, profile: StoredProfile): AuthSetupFreshness =>
  profile.status === ACTIVE_PROFILE_STATUS && profile.profile.revision === setup.profileRevision ? CURRENT_AUTH_SETUP_FRESHNESS : STALE_AUTH_SETUP_FRESHNESS;

/** 保存してあった文書を、設定として読む（版 3 のスキーマに合う文書だけ。LG-3b: 前の版は読み替えない）。合わなければ `undefined`。 */
const storedSetupOf = (parsed: unknown): AuthSetup | undefined =>
  (validateControlDocument(AUTH_SETUP_SCHEMA_NAME, parsed).ok ? parsed as AuthSetup : undefined);

/** 読み出し: 壊れた行は、データベースの誤りとして止める。 */
const storedOf = (row: AuthSetupRow, profile: StoredProfile | null): StoredAuthSetup => {
  const fail = (detail: string): never => {
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', `stored auth setup ${row.profile_id}: ${detail}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document) as unknown;
  } catch {
    return fail('the stored document is not JSON');
  }
  const setup = storedSetupOf(parsed);
  if (setup === undefined) {
    return fail('the stored document is not an auth setup of version 3');
  }
  if (setup.profileId !== row.profile_id || setup.profileRevision !== row.profile_revision) {
    return fail('the stored document does not match its row (profileId or profileRevision)');
  }
  if (profile === null) {
    return fail('the profile of the stored auth setup does not exist');
  }
  return deepFreeze({
    setup: deepFreeze(setup),
    updatedAt: row.updated_at,
    freshness: freshnessOf(setup, profile),
    profileRevision: profile.profile.revision,
  });
};

/** 保存してある認証の設定。なければ `null`。読むだけのトランザクションの中で、設定の行とプロファイルの行を読む。 */
export const getAuthSetup = (database: ControlDatabase, profileId: string): StoredAuthSetup | null =>
  withReadTransaction(database, (connection) => {
    const row = connection.prepare(SELECT_AUTH_SETUP_SQL).get(profileId) as AuthSetupRow | undefined;
    return row === undefined ? null : storedOf(row, getProfile(database, profileId));
  });

/**
 * 認証の設定を保存する（プロファイルごとに 1 行。あれば置き換える）。保存の前に、保存してあるプロファイルを今の文脈で検証し直し、
 * `validateAuthSetup` を通す。データベースそのものの誤りは `ControlStoreError` で投げる。
 */
export const saveAuthSetup = (database: ControlDatabase, input: unknown, options: AuthSetupWriteOptions): AuthSetupStoreResult => {
  let copy: unknown;
  try {
    copy = structuredClone(input);
  } catch {
    return rejected('AUTH_SETUP_INVALID', 'the auth setup must be a plain JSON value', [schemaError('the auth setup must be a plain JSON value', null)]);
  }
  const profileId = isRecord(copy) ? copy['profileId'] : undefined;
  if (typeof profileId !== 'string') {
    return rejected('AUTH_SETUP_INVALID', 'the auth setup must have a profileId', [schemaError('/profileId must be a string', '/profileId')]);
  }
  const current = withReadTransaction(database, () => getProfile(database, profileId));
  if (current === null) {
    return rejected('PROFILE_NOT_FOUND', 'no profile has this profileId');
  }
  if (current.status === RETIRED_PROFILE_STATUS) {
    return rejected('PROFILE_RETIRED', 'an auth setup cannot be saved for a retired profile');
  }
  if (!isAcceptedTargetConfigPath(current.profile.targetConfigPath)) {
    return rejected('PROFILE_INVALID', 'the targetConfigPath of the stored profile is not accepted by isAcceptedTargetConfigPath');
  }
  const context = options.resolveContext(current.profile.targetConfigPath);
  if (context === undefined) {
    return rejected('TARGET_CONFIG_UNAVAILABLE', 'the target configuration of the profile could not be resolved');
  }
  const profile = validateSiteProfile(current.profile, context);
  if (!profile.ok) {
    return rejected('PROFILE_INVALID', 'the stored profile does not pass validateSiteProfile with the current target configuration');
  }
  const validation = validateAuthSetupForProfile(copy, profile.profile, context);
  if (!validation.ok) {
    return validation;
  }
  const { setup } = validation;
  return withWriteTransaction(database, (connection) => {
    const latest = getProfile(database, profileId);
    if (latest === null || latest.status !== ACTIVE_PROFILE_STATUS || latest.profile.revision !== profile.profile.revision) {
      return rejected('PROFILE_REVISION_CONFLICT', 'the profile changed after the auth setup was validated');
    }
    return writeAuthSetupRow(connection, setup, options.now);
  });
};

/**
 * 設定を、結びつくプロファイル（検証した改訂）と文脈で検証する（T43d。`saveAuthSetup` と、プロファイルと認証の設定のまとめて保存
 * （`profile-auth-setup-store.ts`）が使う）。入力の写しを取ってから検証する。
 */
export const validateAuthSetupForProfile = (
  input: unknown,
  profile: ValidatedSiteProfile,
  context: ProfileValidationContext,
): { readonly ok: true; readonly setup: AuthSetup } | Rejection => {
  let copy: unknown;
  try {
    copy = structuredClone(input);
  } catch {
    return rejected('AUTH_SETUP_INVALID', 'the auth setup must be a plain JSON value', [schemaError('the auth setup must be a plain JSON value', null)]);
  }
  const validation = validateAuthSetup(copy, profile, context);
  return validation.ok ? validation : rejected('AUTH_SETUP_INVALID', 'the auth setup did not pass validateAuthSetup', validation.errors);
};

/**
 * 検証した設定を、書き込みのトランザクションの中で書く（T43d。プロファイルごとに 1 行。あれば置き換える）。呼ぶ側が `withWriteTransaction` の中で、
 * 結びつくプロファイルの改訂を確かめてから呼ぶ。返す値の改訂は、設定が結びつく改訂（書いた時点の今の改訂）。
 */
export const writeAuthSetupRow = (connection: SqliteConnection, setup: AuthSetup, now: (() => Date) | undefined): AuthSetupStoreResult => {
  const updatedAt = timestampOf(now);
  connection.prepare(UPSERT_AUTH_SETUP_SQL).run(setup.profileId, setup.profileRevision, JSON.stringify(setup), updatedAt);
  return deepFreeze({
    ok: true,
    stored: { setup, updatedAt, freshness: CURRENT_AUTH_SETUP_FRESHNESS, profileRevision: setup.profileRevision },
  } satisfies AuthSetupStoreResult);
};

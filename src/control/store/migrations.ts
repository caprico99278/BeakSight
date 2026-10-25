// 管理データの版の管理（migration）の唯一の owner（Task 23 の設計書 4.3 の 6、7。T23a。LG-2 で基準の版から作る形に改めた）。
// - LG-2（設計書 `2026-10-24-beaksight-test-suite-tiers-design.md` 3.7.1）: 空の所からは、基準の版 17 の文（`control-schema-v17.ts`。公開済み）と
//   seed を 1 つのトランザクションで流し、`application_id` と `user_version = 17` を書く。版 1〜16 の段と、その写しの定数は捨てた。
// - 基準の版より前の版（版 1〜16）の管理データは、版を読む確かめの段で、何も書かないうちに止める（`DATABASE_FROM_OLDER_VERSION`。WAL にもしない。
//   利用者のファイルは変えない）。
// - 基準の版の後の段（`CONTROL_MIGRATIONS`）は、基準の版の次（版 18）から 1 ずつ増える。表を足すときは、段を 1 つ足すだけにする（設計書 6）。
//   今は空。段の文は、公開した後は変えない（公開した版の CHECK と索引が参照する値の一覧と数値は、公開した時点の写しで固定する）。
// - 版ごとに、書き込みの唯一の入口（`withWriteTransaction`。`BEGIN IMMEDIATE`）の中で、DDL → seed → `PRAGMA user_version = N` を行う。
//   失敗したら、その版のトランザクションは元に戻る（表も版も `application_id` も）。
// - トランザクションの中で版を読み直す（別の process が同じ版を先に済ませていたら、二重に作らない）。
// - 誰のデータベースか、どの版かの確かめ（`assertControlDatabaseIdentity`）は、何も書かないうちに行う（ほかのプログラムのファイルや、前の版の
//   管理データを変えない）。
import { formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import { CONTROL_SCHEMA_V17 } from './control-schema-v17.js';
import { STORE_META_KEYS } from './profile-records.js';
import { ControlStoreError, toControlStoreError } from './store-errors.js';
import type { SqliteConnection } from './sqlite-module.js';
import { withWriteTransaction } from './transaction.js';

/** 移行の値を書く関数に渡す文脈。 */
export interface ControlMigrationContext {
  /** この移行を行った日時（UTC の 14 桁。`formatCompactUtcTimestamp`）。 */
  readonly appliedAt: string;
  /** 走らせている版の一覧の最新の版。 */
  readonly latestVersion: number;
}

/**
 * 基準の版の後の段 1 つ分の移行。`statements` は DDL などの SQL（トランザクションの文と `user_version`・`application_id` は書かない。走らせる側が
 * 持つ）。`seed` は、DDL の後に、同じトランザクションの中で初めの値を書く（任意）。
 */
export interface ControlMigration {
  readonly version: number;
  readonly statements: readonly string[];
  readonly seed?: (connection: SqliteConnection, context: ControlMigrationContext) => void;
}

/** 基準の版（空の所から作るときに流す文と seed）。 */
export interface ControlSchemaBase {
  readonly version: number;
  readonly statements: readonly string[];
  readonly seed: (connection: SqliteConnection, context: ControlMigrationContext) => void;
}

/** 基準の版の初めの値: 作ったときの版と日時（診断用）。 */
const seedBase = (connection: SqliteConnection, context: ControlMigrationContext): void => {
  const insert = connection.prepare('INSERT INTO store_meta (key, value) VALUES (?, ?)');
  insert.run(STORE_META_KEYS.createdSchemaVersion, String(context.latestVersion));
  insert.run(STORE_META_KEYS.createdAt, context.appliedAt);
};

/** 基準の版 17（凍結。`control-schema-v17.ts`）。 */
export const CONTROL_SCHEMA_BASE: ControlSchemaBase = Object.freeze({ ...CONTROL_SCHEMA_V17, seed: seedBase });

/** 基準の版の後の段の一覧（凍結。版 18 から。今は空）。 */
export const CONTROL_MIGRATIONS: readonly ControlMigration[] = Object.freeze([]);

/** この BeakSight が知る最新の版（基準の版と、その後の段の数）。 */
export const CONTROL_SCHEMA_VERSION: number = CONTROL_SCHEMA_BASE.version + CONTROL_MIGRATIONS.length;

/**
 * BeakSight の管理データの印（`PRAGMA application_id`。32 bit の符号つきの正の整数）。
 * ASCII の `BkSt`（0x42 0x6B 0x53 0x74）。
 */
export const CONTROL_DB_APPLICATION_ID = 0x426b5374;

/** `application_id` が書かれていない（新しいファイル）ときの値。 */
const UNSET_APPLICATION_ID = 0;
/** 版の管理を始める前の `user_version`。 */
const UNVERSIONED = 0;

/** データベースが誰のものか、どの版かの事実。 */
export interface ControlDatabaseIdentity {
  readonly applicationId: number;
  readonly userVersion: number;
  /** `sqlite_schema` の行の数（表、索引、view、trigger）。 */
  readonly schemaObjectCount: number;
}

/** 版の管理の選択肢。 */
export interface ControlMigrationOptions {
  /** 今の時刻（既定は `new Date()`）。`store_meta` などの日時に使う。 */
  readonly now?: () => Date;
  /** 基準の版（既定は `CONTROL_SCHEMA_BASE`）。 */
  readonly base?: ControlSchemaBase;
}

/** 版の管理の結果。 */
export interface ControlMigrationOutcome {
  /** 開いたときの版（0 は、まだ版の管理が始まっていない新しいデータベース）。 */
  readonly foundSchemaVersion: number;
  /** 版の管理の後の版。 */
  readonly schemaVersion: number;
}

/** 1 行 1 列の結果の整数を読む。整数でなければ、壊れているとみなす。 */
const readInteger = (connection: SqliteConnection, sql: string, column: string): number => {
  const row = connection.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row?.[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', `${sql} did not return an integer`);
  }
  return value;
};

/** データベースが誰のものか、どの版かを読む（読むだけ。書かない）。 */
export const readControlDatabaseIdentity = (connection: SqliteConnection): ControlDatabaseIdentity => ({
  applicationId: readInteger(connection, 'PRAGMA application_id', 'application_id'),
  userVersion: readInteger(connection, 'PRAGMA user_version', 'user_version'),
  schemaObjectCount: readInteger(connection, 'SELECT count(*) AS object_count FROM sqlite_schema', 'object_count'),
});

/**
 * BeakSight の管理データとして扱ってよいかを確かめる（何も書かない）。
 * - `application_id` が別の値 → `NOT_A_BEAKSIGHT_DATABASE`。
 * - `application_id` が未設定（0）なのに、版や表がある → ほかのプログラムのデータベース（`NOT_A_BEAKSIGHT_DATABASE`）。
 * - `user_version` が `latestVersion` より大きい → `DATABASE_FROM_NEWER_VERSION`。
 * - `user_version` が 1 以上で `baseVersion` より小さい → `DATABASE_FROM_OLDER_VERSION`（LG-2。前の版の段は持たない）。
 * - `user_version` が 0 なのに表がある → `NOT_A_BEAKSIGHT_DATABASE`（設計書 4.3 の 7）。
 */
export const assertControlDatabaseIdentity = (
  identity: ControlDatabaseIdentity,
  latestVersion: number,
  baseVersion: number = CONTROL_SCHEMA_BASE.version,
): void => {
  const { applicationId, userVersion, schemaObjectCount } = identity;
  if (applicationId !== UNSET_APPLICATION_ID && applicationId !== CONTROL_DB_APPLICATION_ID) {
    throw new ControlStoreError('NOT_A_BEAKSIGHT_DATABASE', `application_id ${applicationId} is not the BeakSight control database`);
  }
  if (applicationId === UNSET_APPLICATION_ID && userVersion !== UNVERSIONED) {
    throw new ControlStoreError('NOT_A_BEAKSIGHT_DATABASE', `user_version ${userVersion} is set without the BeakSight application_id`);
  }
  if (userVersion > latestVersion) {
    throw new ControlStoreError(
      'DATABASE_FROM_NEWER_VERSION',
      `user_version ${userVersion} is newer than the latest known version ${latestVersion}`,
    );
  }
  if (userVersion !== UNVERSIONED && userVersion < baseVersion) {
    throw new ControlStoreError(
      'DATABASE_FROM_OLDER_VERSION',
      `user_version ${userVersion} is older than the base version ${baseVersion}`,
    );
  }
  if (userVersion === UNVERSIONED && schemaObjectCount > 0) {
    throw new ControlStoreError('NOT_A_BEAKSIGHT_DATABASE', `user_version is 0 but ${schemaObjectCount} schema objects exist`);
  }
};

/** 基準の版が 1 以上の整数で、後の段が基準の版の次から 1 ずつ増えるか（呼び出し側の誤りは `RangeError`）。 */
const assertMigrationList = (base: ControlSchemaBase, migrations: readonly ControlMigration[]): void => {
  if (!Number.isSafeInteger(base.version) || base.version <= UNVERSIONED) {
    throw new RangeError('the control schema base version must be a positive integer');
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== base.version + 1 + index) {
      throw new RangeError(`the control migration at index ${index} must be version ${base.version + 1 + index}`);
    }
  });
};

/**
 * 1 つの版を、1 つのトランザクションで行う（中で版を読み直し、もう済んでいれば何もしない）。失敗したら、そのトランザクションを元に戻し、
 * `MIGRATION_FAILED`（busy なら `DATABASE_LOCKED` など、分類できる理由）で止める。
 */
const applyVersion = (
  connection: SqliteConnection,
  step: ControlMigration,
  latestVersion: number,
  baseVersion: number,
  appliedAt: () => string,
): void => {
  try {
    withWriteTransaction({ connection }, (writer) => {
      // 待っている間に、別の process が済ませたかもしれない。トランザクションの中で読み直す。
      const current = readControlDatabaseIdentity(writer);
      assertControlDatabaseIdentity(current, latestVersion, baseVersion);
      if (current.userVersion >= step.version) {
        return;
      }
      writer.exec(`PRAGMA application_id = ${CONTROL_DB_APPLICATION_ID}`);
      for (const statement of step.statements) {
        writer.exec(statement);
      }
      step.seed?.(writer, { appliedAt: appliedAt(), latestVersion });
      writer.exec(`PRAGMA user_version = ${step.version}`);
    });
  } catch (error) {
    throw toControlStoreError(error, 'MIGRATION_FAILED', `migration to version ${step.version} failed`);
  }
};

/**
 * 版の管理を行う。空のデータベースには基準の版を、基準の版から後は足りない段だけを、版ごとに 1 つのトランザクションで行う。
 * 基準の版より前の版のデータベースは、何も書かないうちに `DATABASE_FROM_OLDER_VERSION` で止める。
 */
export const runControlMigrations = (
  connection: SqliteConnection,
  migrations: readonly ControlMigration[] = CONTROL_MIGRATIONS,
  options: ControlMigrationOptions = {},
): ControlMigrationOutcome => {
  const now = options.now ?? ((): Date => new Date());
  const base = options.base ?? CONTROL_SCHEMA_BASE;
  assertMigrationList(base, migrations);
  const latestVersion = base.version + migrations.length;
  const found = readControlDatabaseIdentity(connection);
  assertControlDatabaseIdentity(found, latestVersion, base.version);
  const appliedAt = (): string => formatCompactUtcTimestamp(now(), 'control store migration time');

  if (found.userVersion === UNVERSIONED) {
    applyVersion(connection, base, latestVersion, base.version, appliedAt);
  }
  for (const migration of migrations) {
    if (migration.version > found.userVersion) {
      applyVersion(connection, migration, latestVersion, base.version, appliedAt);
    }
  }

  return Object.freeze({
    foundSchemaVersion: found.userVersion,
    schemaVersion: readInteger(connection, 'PRAGMA user_version', 'user_version'),
  });
};

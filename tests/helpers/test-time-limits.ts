/**
 * 場面ごとの時間の上限の表（`tests/test-time-limits.json`）の読み込みと判定（RB-0。設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md`
 * 2 章 8）。秒の値は、この表の 1 か所にだけ置く（テストとコードに書かない）。
 * - `defaultLimitMs`: 1 場面（it 1 本）の上限。場面の時間は、beforeEach・本体・afterEach の和（beforeAll は入らない）。
 * - `exceptions`: 名前つきの例外（ファイルと場面の名前 `describe > it`）。種類は、端から端・ずれの確かめの両方の Chromium・Windows の本物の機能。
 * - `migrating`: 移る途中の例外（ファイル → 件数）。そのファイルで既定を超えてよい場面の数（場面は it の名前で数える。2 つの Chromium の
 *   `describe.each` で同じ it が 2 回流れても 1 つ）と、その場面の上限。段ごとに件数を減らし、行を消す。
 * - `migratingTimeoutOptions`: テストのファイルに書いてある場面の上限（`it(…, <数>)` など）の、移る途中の数（ファイル → 件数）。Gate が数える。
 * 見張りは `tests/helpers/test-time-limit-setup.ts`（Vitest の setupFiles）。形と例外の確かめは `tests/architecture/test-time-limits.test.ts`。
 */
import TIME_LIMITS_DATA from '../test-time-limits.json' with { type: 'json' };

/** 名前つきの例外の種類。 */
export const NAMED_TIME_LIMIT_KINDS = Object.freeze(['E2E', 'CONTRACT_BOTH', 'WINDOWS'] as const);
export type NamedTimeLimitKind = (typeof NAMED_TIME_LIMIT_KINDS)[number];

export interface NamedTimeLimitException {
  readonly file: string;
  /** 場面の名前（`describe > it`。Vitest の `fullTestName`）。 */
  readonly test: string;
  readonly limitMs: number;
  readonly reason: string;
  readonly kind: NamedTimeLimitKind;
}

export interface MigratingTimeLimit {
  readonly file: string;
  readonly count: number;
  readonly limitMs: number;
  readonly reason: string;
}

export interface TestTimeLimits {
  readonly defaultLimitMs: number;
  readonly exceptions: readonly NamedTimeLimitException[];
  readonly migrating: readonly MigratingTimeLimit[];
  readonly migratingTimeoutOptions: { readonly reason: string; readonly files: Readonly<Record<string, number>> };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** 表の形の誤り（空なら正しい）。 */
export const testTimeLimitsShapeErrorsOf = (value: unknown): readonly string[] => {
  if (!isRecord(value)) {
    return ['the table is not an object'];
  }
  const errors: string[] = [];
  const defaultLimitMs = value['defaultLimitMs'];
  if (!isPositiveInteger(defaultLimitMs)) {
    return ['defaultLimitMs is not a positive integer'];
  }
  const rowsOf = (key: string): readonly unknown[] => {
    const rows = value[key];
    if (!Array.isArray(rows)) {
      errors.push(`${key} is not a list`);
      return [];
    }
    return rows;
  };
  const checkLimit = (where: string, row: Readonly<Record<string, unknown>>): void => {
    if (!isText(row['file'])) errors.push(`${where}: no file`);
    if (!isText(row['reason'])) errors.push(`${where}: no reason`);
    if (!isPositiveInteger(row['limitMs']) || row['limitMs'] <= defaultLimitMs) errors.push(`${where}: limitMs is not above defaultLimitMs`);
  };
  const seen = new Set<string>();
  const checkDuplicate = (where: string, key: string): void => {
    if (seen.has(key)) errors.push(`${where}: duplicated (${key})`);
    seen.add(key);
  };
  rowsOf('exceptions').forEach((row, index) => {
    const where = `exceptions[${String(index)}]`;
    if (!isRecord(row)) {
      errors.push(`${where}: not an object`);
      return;
    }
    checkLimit(where, row);
    if (!isText(row['test'])) errors.push(`${where}: no test`);
    if (!NAMED_TIME_LIMIT_KINDS.includes(row['kind'] as NamedTimeLimitKind)) errors.push(`${where}: unknown kind`);
    checkDuplicate(where, `${String(row['file'])} :: ${String(row['test'])}`);
  });
  rowsOf('migrating').forEach((row, index) => {
    const where = `migrating[${String(index)}]`;
    if (!isRecord(row)) {
      errors.push(`${where}: not an object`);
      return;
    }
    checkLimit(where, row);
    if (!isPositiveInteger(row['count'])) errors.push(`${where}: count is not a positive integer`);
    checkDuplicate(where, String(row['file']));
  });
  const options = value['migratingTimeoutOptions'];
  if (!isRecord(options) || !isText(options['reason']) || !isRecord(options['files'])
    || !Object.values(options['files']).every((count) => isPositiveInteger(count))) {
    errors.push('migratingTimeoutOptions is not { reason, files: { <file>: <count> } }');
  }
  return errors;
};

/** 表を読む（形が違えば投げる。見張りも Vitest の設定も、形の違う表では始めない）。 */
export const testTimeLimitsOf = (value: unknown): TestTimeLimits => {
  const errors = testTimeLimitsShapeErrorsOf(value);
  if (errors.length > 0) {
    throw new Error(`tests/test-time-limits.json: ${errors.join('; ')}`);
  }
  return value as TestTimeLimits;
};

/** リポジトリの表。 */
export const TEST_TIME_LIMITS: TestTimeLimits = testTimeLimitsOf(TIME_LIMITS_DATA);

/** 表の最大の上限（Vitest の `testTimeout` の既定。見張りが、ファイルごとに狭める）。 */
export const maxLimitMsOf = (limits: TestTimeLimits): number =>
  Math.max(limits.defaultLimitMs, ...limits.exceptions.map(({ limitMs }) => limitMs), ...limits.migrating.map(({ limitMs }) => limitMs));

/** 1 つのテストのファイルに当たる上限。 */
export interface FileTimeLimits {
  readonly file: string;
  readonly defaultLimitMs: number;
  /** 場面の名前（`describe > it`） → 上限。 */
  readonly named: ReadonlyMap<string, number>;
  readonly migrating: MigratingTimeLimit | undefined;
  /** このファイルの最大の上限（見張りが、このファイルの Vitest の `testTimeout` にする）。 */
  readonly maxLimitMs: number;
}

/** `file`（リポジトリの根からの相対。区切りは `/`）の上限。 */
export const fileTimeLimitsOf = (limits: TestTimeLimits, file: string): FileTimeLimits => {
  const named = new Map(limits.exceptions.filter((row) => row.file === file).map(({ test, limitMs }) => [test, limitMs] as const));
  const migrating = limits.migrating.find((row) => row.file === file);
  return {
    file,
    defaultLimitMs: limits.defaultLimitMs,
    named,
    migrating,
    maxLimitMs: Math.max(limits.defaultLimitMs, ...named.values(), migrating?.limitMs ?? 0),
  };
};

/** 判定する場面（`fullName` は `describe > it`、`name` は it の名前）。 */
export interface TimedScene {
  readonly fullName: string;
  readonly name: string;
}

export interface SceneTimeVerdict {
  /** 誤り（場面を落とす文）。 */
  readonly error?: string;
  /** 移る途中の例外で、既定を超えた場面として数える it の名前。 */
  readonly overDefault?: string;
}

/**
 * 1 つの場面の判定。`overDefault` は、このファイルで既に既定を超えた場面（it の名前）。呼ぶ側は、戻りの `overDefault` を足していく。
 */
export const judgeSceneTime = (limits: FileTimeLimits, scene: TimedScene, elapsedMs: number, overDefault: ReadonlySet<string>): SceneTimeVerdict => {
  const elapsed = `${String(Math.ceil(elapsedMs))} ms`;
  const named = limits.named.get(scene.fullName);
  if (named !== undefined) {
    return elapsedMs <= named ? {} : { error: `the scene took ${elapsed}, over its limit ${String(named)} ms in tests/test-time-limits.json` };
  }
  if (elapsedMs <= limits.defaultLimitMs) {
    return {};
  }
  const { migrating } = limits;
  if (migrating === undefined) {
    return { error: `the scene took ${elapsed}, over the limit ${String(limits.defaultLimitMs)} ms of one scene (no exception in tests/test-time-limits.json)` };
  }
  if (elapsedMs > migrating.limitMs) {
    return { error: `the scene took ${elapsed}, over the migrating limit ${String(migrating.limitMs)} ms of ${limits.file} in tests/test-time-limits.json` };
  }
  if (!overDefault.has(scene.name) && overDefault.size >= migrating.count) {
    return { error: `the scene took ${elapsed}, and ${limits.file} already has the migrating count ${String(migrating.count)} of scenes over ${String(limits.defaultLimitMs)} ms in tests/test-time-limits.json` };
  }
  return { overDefault: scene.name };
};

/** 使われない行（名前つきの例外の場面がファイルにない、移る途中の件数がファイルの場面の数より多い）。`scenes` は、ファイルの全部の場面。 */
export const unusedFileTimeLimitsOf = (limits: FileTimeLimits, scenes: readonly TimedScene[]): readonly string[] => {
  const fullNames = new Set(scenes.map(({ fullName }) => fullName));
  const names = new Set(scenes.map(({ name }) => name));
  return [
    ...[...limits.named.keys()].filter((test) => !fullNames.has(test)).map((test) => `${limits.file}: the named exception "${test}" has no scene`),
    ...(limits.migrating !== undefined && limits.migrating.count > names.size
      ? [`${limits.file}: the migrating count ${String(limits.migrating.count)} is above the ${String(names.size)} scenes of the file`]
      : []),
  ];
};

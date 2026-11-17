import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { errorCodeOf, safeErrorMessage } from '../core/errors.js';
import { isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { ConfigError } from './config-error.js';
import { DEFAULT_CONFIG } from './defaults.js';
import type { AuditConfig, AuditConfigOverrides } from './types.js';
import { validateConfig } from './validate-config.js';

type UnknownRecord = Record<string, unknown>;

interface TargetConfig {
  readonly target: {
    readonly id: string;
  };
  readonly [section: string]: unknown;
}

const deepMerge = (base: unknown, addition: unknown): unknown => {
  if (addition === undefined) {
    return base;
  }
  if (!isRecord(base) || !isRecord(addition)) {
    return addition;
  }

  const merged: UnknownRecord = { ...base };
  for (const [key, value] of Object.entries(addition)) {
    const nextValue = Object.hasOwn(merged, key) ? deepMerge(merged[key], value) : value;
    Object.defineProperty(merged, key, {
      configurable: true,
      enumerable: true,
      value: nextValue,
      writable: true,
    });
  }
  return merged;
};

/**
 * 対象の設定のファイルの中身（JSON を読んだ値）に、既定値（`DEFAULT_CONFIG`）を深く合わせた値（`validateConfig` に渡す前の形。上書きは含まない）。
 * T44d（Task 44 の設計書 P2-1）: 画面から負荷の値を変える部品も、`loadConfig` と同じ合わせ方で確かめるために使う（合わせ方を写さない）。
 */
export const targetConfigWithDefaultsOf = (targetConfig: unknown): unknown => deepMerge(DEFAULT_CONFIG, withoutOldHiddenDefaults(targetConfig));

/**
 * L14（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 3・6 の L14）: 前の画面に出ない既定の値（`DEFAULT_CONFIG.crawl` にあった値）。
 * 画面で作った前のプロファイルのファイルは、`DEFAULT_CONFIG.crawl` を丸ごと書いたので、利用者が選んだ値と見分ける印がない。そのため、この値と同じ値は
 * 「選んでいない」とみなして読まない（上限・期限なしになる）。違う値は、利用者が選んだ値として効く。読み込みの間隔（`minNavigationIntervalMs`）は守る
 * 決まりなので、ここに入れない。`allowedQueryParameters` の前の既定 `[]` は、読み方が「指定なし」と同じ（`normalize-url.ts`）なので、ここに入れない。
 */
export const OLD_HIDDEN_CRAWL_DEFAULTS = Object.freeze({
  // L14 の後の段（設計書 6.1）: ページの数の上限と Run の時間の上限の、前の `DEFAULT_CONFIG.crawl` の値。
  maxPages: 500,
  maxRuntimeMs: 3_600_000,
  maxDepth: 20,
  navigationTimeoutMs: 30_000,
  overallPageTimeoutMs: 60_000,
  resourceSettlingTimeoutMs: 5_000,
  interactionTimeoutMs: 3_000,
  maxInteractionsPerPage: 20,
} as const satisfies Partial<Record<keyof AuditConfig['crawl'], number>>);

/**
 * L14 の後の段（設計書 6.1）: 画面で作った前のプロファイルのファイルに書いた、最初の読み込みのページの上限（前の `GENERATED_TARGET_CRAWL_LIMITS`）。
 * `OLD_HIDDEN_CRAWL_DEFAULTS` と同じく、この値と同じ値は「選んでいない」とみなして読まない。
 */
const OLD_GENERATED_CRAWL_DEFAULTS = Object.freeze({
  maxPages: 3,
} as const satisfies Partial<Record<keyof AuditConfig['crawl'], number>>);

const OLD_HIDDEN_CRAWL_DEFAULT_TABLES: readonly Readonly<Record<string, number>>[] = [OLD_HIDDEN_CRAWL_DEFAULTS, OLD_GENERATED_CRAWL_DEFAULTS];

/** `crawl` の項目の値が、前の既定（どれかの表）と同じか。 */
const isOldHiddenCrawlDefault = (key: string, value: unknown): boolean =>
  OLD_HIDDEN_CRAWL_DEFAULT_TABLES.some((table) => Object.hasOwn(table, key) && table[key] === value);

/** 設定のファイルの中身から、前の画面に出ない既定の値と同じ `crawl` の値を除く（元の値は変えない）。 */
const withoutOldHiddenDefaults = (targetConfig: unknown): unknown => {
  if (!isRecord(targetConfig) || !isRecord(targetConfig.crawl)) {
    return targetConfig;
  }
  const crawl: UnknownRecord = {};
  for (const [key, value] of Object.entries(targetConfig.crawl)) {
    if (!isOldHiddenCrawlDefault(key, value)) {
      Object.defineProperty(crawl, key, { configurable: true, enumerable: true, value, writable: true });
    }
  }
  return { ...targetConfig, crawl };
};

/**
 * 設定のファイルの中身の先頭の UTF-8 の BOM を 1 つだけ取り除く（`loadConfig` と同じ読み方。T44d で、画面から負荷の値を変える部品と共用する）。
 */
export const targetConfigTextWithoutByteOrderMark = (contents: string): string => withoutByteOrderMark(contents);

/** 例外の文（技術的な詳細）。 */
const errorDetail = (error: unknown): string => safeErrorMessage(error);

const isFileNotFound = (error: unknown): boolean => errorCodeOf(error) === 'ENOENT';

/**
 * 設定のファイルかディレクトリの入出力の失敗を、`ConfigError` にする。ない場合は `CONFIG_FILE_NOT_FOUND`、ほかの失敗
 * （ディレクトリである、権限がない、など）は `CONFIG_FILE_UNREADABLE`。
 */
const configInputError = (subject: string, path: string, error: unknown): ConfigError => {
  if (isFileNotFound(error)) {
    const message = `${subject} not found: ${path}`;
    return new ConfigError('CONFIG_FILE_NOT_FOUND', message, [message], { cause: error });
  }
  const message = `cannot read the ${subject}: ${path}`;
  return new ConfigError('CONFIG_FILE_UNREADABLE', message, [message, errorDetail(error)], { cause: error });
};

/** UTF-8 の BOM（U+FEFF）。 */
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * 先頭の UTF-8 の BOM を、1つだけ取り除く（Task 14〜17 の設計書 第7章、R17 の指摘4）。Windows PowerShell 5.1 は、既定で BOM を付けて書くため。
 * 2つ目以降の BOM と、先頭以外の BOM は、そのまま残す（JSON として読めなければ、`CONFIG_JSON_INVALID` になる）。
 */
const withoutByteOrderMark = (contents: string): string =>
  contents.startsWith(BYTE_ORDER_MARK) ? contents.slice(BYTE_ORDER_MARK.length) : contents;

const readTargetConfig = async (path: string): Promise<TargetConfig> => {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw configInputError('target configuration', path, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutByteOrderMark(contents));
  } catch (error) {
    const message = `target configuration is not valid JSON: ${path}`;
    throw new ConfigError('CONFIG_JSON_INVALID', message, [message, errorDetail(error)], { cause: error });
  }

  if (!isRecord(parsed) || !isRecord(parsed.target) || typeof parsed.target.id !== 'string' || parsed.target.id.length === 0) {
    const message = `target configuration requires a non-empty target.id: ${path}`;
    throw new ConfigError('TARGET_ID_MISSING', message, [message]);
  }
  return parsed as TargetConfig;
};

const listTargetConfigPaths = async (directory: string): Promise<readonly string[]> => {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw configInputError('target configuration directory', directory, error);
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => resolve(directory, entry.name));
  const nested = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => listTargetConfigPaths(resolve(directory, entry.name))));
  return [...files, ...nested.flat()].sort();
};

const isWithinDirectory = (path: string, directory: string): boolean => {
  const pathFromDirectory = relative(directory, path);
  return pathFromDirectory !== '..' && !pathFromDirectory.startsWith(`..${sep}`) && !isAbsolute(pathFromDirectory);
};

const selectCanonicalTargetConfigPath = async (directory: string): Promise<string> => {
  const targetPaths = await listTargetConfigPaths(directory);
  const targetPath = targetPaths[0];
  if (targetPaths.length !== 1 || targetPath === undefined) {
    throw new ConfigError('TARGET_NOT_SELECTED', 'expected exactly one target configuration; pass --config to select one', [
      `found ${targetPaths.length} target configurations in ${directory}`,
      ...targetPaths,
    ]);
  }
  return targetPath;
};

const verifyUniqueTargetIds = async (directory: string): Promise<void> => {
  const targetPaths = await listTargetConfigPaths(directory);
  const seenIds = new Set<string>();
  for (const targetPath of targetPaths) {
    const targetConfig = await readTargetConfig(targetPath);
    if (seenIds.has(targetConfig.target.id)) {
      const message = `duplicate target.id: ${targetConfig.target.id}`;
      throw new ConfigError('TARGET_ID_DUPLICATED', message, [message, targetPath]);
    }
    seenIds.add(targetConfig.target.id);
  }
};

/**
 * 対象の設定ファイルを読み、既定値と上書きを合わせて検証した、不変な設定を返す。
 *
 * - `path` を省略した場合と、`path` が `config/targets/` 配下の場合は、`config/targets/` 配下の
 *   `target.id` の一意性を確かめる。
 * - `path` が `config/targets/` の外の場合は、そのファイルだけを読む（ほかの JSON は読まない）。
 * - 設定の誤り（ファイルがない・読めない、JSON として読めない、`target.id` がない・重なる、対象が1つに決まらない、検証のエラー）は、
 *   `ConfigError`（種類のコードと、英語の技術的な詳細の一覧）を投げる（Task 14〜17 の設計書 6.1.5）。
 */
export const loadConfig = async (path?: string, overrides?: AuditConfigOverrides): Promise<AuditConfig> => {
  const canonicalTargetDirectory = resolve(process.cwd(), 'config', 'targets');
  const resolvedPath = path === undefined ? undefined : resolve(path);
  if (resolvedPath === undefined || isWithinDirectory(resolvedPath, canonicalTargetDirectory)) {
    await verifyUniqueTargetIds(canonicalTargetDirectory);
  }
  const targetPath = resolvedPath ?? await selectCanonicalTargetConfigPath(canonicalTargetDirectory);
  const targetConfig = await readTargetConfig(targetPath);
  const merged = deepMerge(targetConfigWithDefaultsOf(targetConfig), overrides);
  const validation = validateConfig(merged);
  if (!validation.ok) {
    throw new ConfigError('CONFIG_INVALID', `invalid configuration: ${validation.errors.join('; ')}`, validation.errors);
  }
  // 既定値や呼び出し側の上書きと参照を共有しないよう、複製してから凍結する。
  return deepFreeze(structuredClone(validation.value));
};

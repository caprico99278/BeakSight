import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { safeErrorMessage } from '../core/errors.js';
import { isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
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

/** 例外の文（技術的な詳細）。 */
const errorDetail = (error: unknown): string => safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH);

const isFileNotFound = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT';

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
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, targetConfig), overrides);
  const validation = validateConfig(merged);
  if (!validation.ok) {
    throw new ConfigError('CONFIG_INVALID', `invalid configuration: ${validation.errors.join('; ')}`, validation.errors);
  }
  // 既定値や呼び出し側の上書きと参照を共有しないよう、複製してから凍結する。
  return deepFreeze(structuredClone(validation.value));
};

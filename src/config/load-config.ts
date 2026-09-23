import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
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

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null && !Array.isArray(value);

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

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const readTargetConfig = async (path: string): Promise<TargetConfig> => {
  const contents = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`target configuration is not valid JSON: ${path}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.target) || typeof parsed.target.id !== 'string' || parsed.target.id.length === 0) {
    throw new Error(`target configuration requires a non-empty target.id: ${path}`);
  }
  return parsed as TargetConfig;
};

const listTargetConfigPaths = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
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

const selectTargetConfigPath = async (path: string | undefined, directory: string): Promise<string> => {
  if (path !== undefined) {
    return resolve(path);
  }

  const targetPaths = await listTargetConfigPaths(directory);
  if (targetPaths.length !== 1) {
    throw new Error('expected exactly one target configuration; pass --config to select one');
  }
  const targetPath = targetPaths[0];
  if (targetPath === undefined) {
    throw new Error('no target configuration found');
  }
  return targetPath;
};

const verifyUniqueTargetIds = async (directory: string): Promise<void> => {
  const targetPaths = await listTargetConfigPaths(directory);
  const seenIds = new Set<string>();
  for (const targetPath of targetPaths) {
    const targetConfig = await readTargetConfig(targetPath);
    if (seenIds.has(targetConfig.target.id)) {
      throw new Error(`duplicate target.id: ${targetConfig.target.id}`);
    }
    seenIds.add(targetConfig.target.id);
  }
};

export const loadConfig = async (path?: string, overrides?: AuditConfigOverrides): Promise<AuditConfig> => {
  const canonicalTargetDirectory = resolve(process.cwd(), 'config', 'targets');
  const resolvedPath = path === undefined ? undefined : resolve(path);
  const directory = resolvedPath !== undefined && !isWithinDirectory(resolvedPath, canonicalTargetDirectory)
    ? dirname(resolvedPath)
    : canonicalTargetDirectory;
  await verifyUniqueTargetIds(directory);
  const targetPath = await selectTargetConfigPath(resolvedPath, directory);
  const targetConfig = await readTargetConfig(targetPath);
  const { target: _target, ...policy } = targetConfig;
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, policy), overrides);
  const validation = validateConfig(merged);
  if (!validation.ok) {
    throw new Error(`invalid configuration: ${validation.errors.join('; ')}`);
  }
  return deepFreeze(validation.value);
};

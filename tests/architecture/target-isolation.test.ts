/**
 * GATE-ARCH01 Target Isolation（実装タスク指示 第6章・第10章、Task 18 の設計書 4.4）。
 * - `config/targets/*.json` を読むだけで、対象のサイトにはアクセスしない。設定の中身は、実行時に読んで照らすだけで、このファイルに書き写さない。
 * - `src/**` の読み込みは、このファイルの読み込み時に1回だけ行う。判定は、`fs`、正規表現、文字列の検索だけで行う。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT, loadSourceFiles, scanSource, type ScannedSource } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** 対象の設定のディレクトリ（リポジトリの根からの相対パス）。 */
const TARGET_CONFIG_DIRECTORY = 'config/targets';

interface TargetConfigFile {
  readonly path: string;
  readonly value: unknown;
}

/** `config/targets/*.json` を、1回だけ列挙して読み込む。 */
const TARGET_CONFIG_FILES: readonly TargetConfigFile[] = readdirSync(join(REPOSITORY_ROOT, TARGET_CONFIG_DIRECTORY), { encoding: 'utf8' })
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({
    path: `${TARGET_CONFIG_DIRECTORY}/${name}`,
    value: JSON.parse(readFileSync(join(REPOSITORY_ROOT, TARGET_CONFIG_DIRECTORY, name), 'utf8')) as unknown,
  }));

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数
// ---------------------------------------------------------------------------------------------------------------

/** 対象を識別する文字列（設計書 4.4 の ARCH01）。 */
interface TargetIdentity {
  /** `target.id`。文字列でなければ `null`。 */
  readonly id: string | null;
  /** 設定の中の URL（開始の URL、許可 Origin など、すべての文字列の値のうち、ホスト名を持つ URL として解析できるもの）。 */
  readonly urls: readonly string[];
  /** 各 URL のホスト名（小文字）。 */
  readonly hostnames: readonly string[];
  /** 各 URL の origin。 */
  readonly origins: readonly string[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 値の中のすべての文字列（配列とオブジェクトの中を含む。キーは含めない）。 */
const stringValues = (value: unknown): readonly string[] => {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringValues);
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
};

/** 1つの対象の設定から、`target.id` と、設定の中のすべての URL のホスト名と origin を取り出す。 */
const extractTargetIdentity = (config: unknown): TargetIdentity => {
  const target = isRecord(config) ? config['target'] : undefined;
  const id = isRecord(target) && typeof target['id'] === 'string' ? target['id'] : null;
  const urls: string[] = [];
  const hostnames = new Set<string>();
  const origins = new Set<string>();
  for (const text of stringValues(config)) {
    if (!URL.canParse(text)) {
      continue;
    }
    const url = new URL(text);
    if (url.hostname.length === 0) {
      continue;
    }
    urls.push(text);
    hostnames.add(url.hostname.toLowerCase());
    if (url.origin !== 'null') {
      origins.add(url.origin);
    }
  }
  return { id, urls, hostnames: [...hostnames], origins: [...origins] };
};

/** `target.id` と、文字列のリテラルの値がそのまま一致するもの（コメントの中と、識別子の一部は数えない）。 */
const findTargetIdLiterals = (source: ScannedSource, targetIds: readonly string[]): readonly string[] =>
  source.literals.filter((literal) => targetIds.includes(literal));

/** ホスト名・origin・URL が、どこかに現れるもの（コメントを含む。大文字と小文字を区別しない）。`content` は読み込んだままの本文。 */
const findTargetLocators = (content: string, locators: readonly string[]): readonly string[] => {
  const lowerContent = content.toLowerCase();
  return locators.filter((locator) => locator.length > 0 && lowerContent.includes(locator.toLowerCase()));
};

/** 2つ以上のファイルにある `target.id`（`<id>: <ファイル>, <ファイル>`）。 */
const findDuplicateTargetIds = (entries: readonly { readonly path: string; readonly id: string }[]): readonly string[] => {
  const pathsById = new Map<string, string[]>();
  for (const { path, id } of entries) {
    pathsById.set(id, [...(pathsById.get(id) ?? []), path]);
  }
  return [...pathsById].filter(([, paths]) => paths.length > 1).map(([id, paths]) => `${id}: ${paths.join(', ')}`);
};

// ---------------------------------------------------------------------------------------------------------------
// 除外（ARCH01 の除外の一覧は、ここに1か所だけ置く）
// ---------------------------------------------------------------------------------------------------------------

/** GATE-ARCH01 の除外。今は、ない（`src/**` のすべての `.ts` を対象にする）。 */
const ARCH01_EXCLUDED_FILES: ReadonlyMap<string, string> = new Map();

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('GATE-ARCH01 detectors', () => {
  it('extract target.id and the host names, origins and URLs of every URL in a target config', () => {
    const identity = extractTargetIdentity({
      target: { id: 'sample-target' },
      site: {
        startUrl: 'https://www.target-site.invalid/start/?q=1',
        allowedOrigins: ['https://www.target-site.invalid', 'https://CDN.Target-Site.invalid:8443'],
      },
      crawl: { note: 'not a url', depth: 3, list: ['mailto:someone@target-site.invalid'] },
    });
    expect(identity.id).toBe('sample-target');
    expect(identity.urls).toEqual([
      'https://www.target-site.invalid/start/?q=1',
      'https://www.target-site.invalid',
      'https://CDN.Target-Site.invalid:8443',
    ]);
    expect(identity.hostnames).toEqual(['www.target-site.invalid', 'cdn.target-site.invalid']);
    expect(identity.origins).toEqual(['https://www.target-site.invalid', 'https://cdn.target-site.invalid:8443']);
  });

  it('return a null id when target.id is missing or not a string', () => {
    expect(extractTargetIdentity({}).id).toBeNull();
    expect(extractTargetIdentity({ target: { id: 3 } }).id).toBeNull();
    expect(extractTargetIdentity(null).urls).toEqual([]);
  });

  it('detect target.id only as the exact value of a string literal', () => {
    for (const line of ["const a = 'sample-target';", 'const a = "sample-target";', 'const a = `sample-target`;', "x('a', 'sample-target');"]) {
      expect(findTargetIdLiterals(scanSource(line), ['sample-target']), line).toHaveLength(1);
    }
    for (const line of [
      '// sample-target',
      '/** `sample-target` */ const a = 1;',
      'const sampleTarget = 1;',
      "const a = 'sample-target-2';",
      "const a = 'the sample-target site';",
    ]) {
      expect(findTargetIdLiterals(scanSource(line), ['sample-target']), line).toHaveLength(0);
    }
  });

  it('detect host names and origins anywhere, including comments and other letter cases', () => {
    const locators = ['www.target-site.invalid', 'https://www.target-site.invalid'];
    expect(findTargetLocators('// see https://www.target-site.invalid/page', locators)).toEqual(locators);
    expect(findTargetLocators('/** WWW.TARGET-SITE.INVALID */', locators)).toEqual(['www.target-site.invalid']);
    expect(findTargetLocators("const host = 'www.target-site.invalid';", locators)).toEqual(['www.target-site.invalid']);
    expect(findTargetLocators("const host = 'www.other-site.invalid';", locators)).toEqual([]);
    expect(findTargetLocators('anything', [''])).toEqual([]);
  });

  it('detect the same target.id in two or more files', () => {
    expect(findDuplicateTargetIds([
      { path: 'a.json', id: 'one' },
      { path: 'b.json', id: 'two' },
      { path: 'c.json', id: 'one' },
    ])).toEqual(['one: a.json, c.json']);
    expect(findDuplicateTargetIds([{ path: 'a.json', id: 'one' }, { path: 'b.json', id: 'two' }])).toEqual([]);
  });
});

describe('GATE-ARCH01 Target Isolation', () => {
  const identities = TARGET_CONFIG_FILES.map((file) => ({ path: file.path, ...extractTargetIdentity(file.value) }));

  it('GATE-ARCH01: every target config has a target.id and at least one URL, and target.id is unique across the configs', () => {
    expect(identities.length).toBeGreaterThan(0);
    for (const identity of identities) {
      expect(identity.id, identity.path).toEqual(expect.any(String));
      expect(identity.id?.length ?? 0, identity.path).toBeGreaterThan(0);
      expect(identity.hostnames.length, identity.path).toBeGreaterThan(0);
    }
    const entries = identities.flatMap(({ path, id }) => (id === null ? [] : [{ path, id }]));
    expect(findDuplicateTargetIds(entries)).toEqual([]);
  });

  it('GATE-ARCH01: src/**/*.ts contains no target.id literal and no host name, origin or URL of the target configs', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(0);
    for (const excluded of ARCH01_EXCLUDED_FILES.keys()) {
      expect(SOURCE_FILES.some((file) => file.path === excluded), excluded).toBe(true);
    }
    const targetIds = identities.flatMap(({ id }) => (id === null ? [] : [id]));
    const locators = [...new Set(identities.flatMap(({ urls, hostnames, origins }) => [...hostnames, ...origins, ...urls]))];
    expect(locators.length).toBeGreaterThan(0);
    const violations = SOURCE_FILES.filter((file) => !ARCH01_EXCLUDED_FILES.has(file.path)).flatMap((file) => [
      ...findTargetIdLiterals(file, targetIds).map((literal) => `${file.path}: target.id literal ${JSON.stringify(literal)}`),
      ...findTargetLocators(file.content, locators).map((locator) => `${file.path}: ${locator}`),
    ]);
    expect(violations).toEqual([]);
  });
});

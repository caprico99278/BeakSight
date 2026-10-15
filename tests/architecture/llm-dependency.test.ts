/**
 * LLM の依存 0 の Architecture Gate（Task 29 の設計書 3 章の「LLM の依存 0」、6 章の Gate、8 章の G29。T29f）。
 * 入力の規則とデータの生成は、LLM や合成データのライブラリを使わず、型・制約・小さな辞書・業務テンプレートと決定的な値の取り出しだけで作る。
 * - (a) `package.json` の依存（`dependencies`・`devDependencies`。`npm:` の別名の先も）に、禁じたパッケージがない。
 * - (b) `package-lock.json` の `packages` のすべて（`node_modules/…` の最後の名前と、別名の `name`）と、それぞれの依存の名前
 *   （`dependencies`・`devDependencies`・`optionalDependencies`・`peerDependencies`）に、禁じたパッケージがない（間接の依存を含む）。
 * - (c) `src/**` と画面の `apps/local-ui/src/**`・起動の部品 `apps/local-ui/launcher/**`・ビルドの補助 `apps/local-ui/build-tools/**`（`.ts`、
 *   `.tsx`。T29R-fix-1 の M-6 で後の 2 つを足した）が、禁じたパッケージを参照しない（import・`export … from`・`import()`・
 *   `require` などのすべての形。指定子は `source-scan.ts` の `findModuleSpecifiers` で取る）。
 * - 禁じたパッケージは閉じた一覧（`FORBIDDEN_PACKAGE_NAMES` の名前、`FORBIDDEN_PACKAGE_SCOPES` の scope、`FORBIDDEN_PACKAGE_NAME_PREFIXES` の
 *   頭、`FORBIDDEN_SCOPED_NAME_PREFIXES` の scope つきの名前の頭）。LLM の SDK（OpenAI・Anthropic・Google・Cohere・Mistral・Ollama・LangChain など）と、合成データのライブラリ（Faker など）。
 * - 判定は `fs`、JSON の読み込み、文字列の比べだけ。読み込みは、このファイルの読み込み時に 1 回だけ。ファイル全体を 1 秒以内に終える。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findModuleSpecifiers,
  loadLocalUiSourceFiles,
  loadSourceFiles,
  loadTypeScriptFilesUnder,
  REPOSITORY_ROOT,
  scanSource,
  type ScannedSource,
} from './source-scan.js';

/** 禁じたパッケージの名前（ちょうどその名前。閉じた一覧）。 */
const FORBIDDEN_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  // LLM の SDK と、LLM を呼ぶ枠組み
  'openai',
  'anthropic',
  '@google/generative-ai',
  '@google/genai',
  '@google-cloud/vertexai',
  '@google-cloud/aiplatform',
  '@azure/openai',
  '@azure-rest/ai-inference',
  'node-llama-cpp',
  'cohere-ai',
  'ollama',
  'groq-sdk',
  'replicate',
  'together-ai',
  'ai',
  'llamaindex',
  'gpt-tokenizer',
  'tiktoken',
  'js-tiktoken',
  // 合成データ（偽のデータ）のライブラリ
  'faker',
  'chance',
  'casual',
  'falso',
  'mockjs',
  'json-schema-faker',
]);

/** 禁じた scope（`@scope/…` のすべて。閉じた一覧）。 */
const FORBIDDEN_PACKAGE_SCOPES: ReadonlySet<string> = new Set([
  '@anthropic-ai',
  '@mistralai',
  '@langchain',
  '@ai-sdk',
  '@huggingface',
  '@xenova',
  '@faker-js',
  '@ngneat',
  '@openai',
  '@mlc-ai',
]);

/** 禁じた名前の頭（scope のない名前が、この頭で始まる。閉じた一覧）。 */
const FORBIDDEN_PACKAGE_NAME_PREFIXES: readonly string[] = ['langchain', 'openai-', 'anthropic-', 'ollama-'];

/** 禁じた scope つきの名前の頭（`@scope/name` の全体が、この頭で始まる。閉じた一覧。T29R-fix-1 の M-6）。 */
const FORBIDDEN_SCOPED_NAME_PREFIXES: readonly string[] = ['@aws-sdk/client-bedrock'];

/** 依存の名前（scope つきの名前を含む）が、禁じたパッケージか。 */
const isForbiddenPackageName = (name: string): boolean => {
  const normalized = name.trim().toLowerCase();
  if (FORBIDDEN_PACKAGE_NAMES.has(normalized)) {
    return true;
  }
  if (normalized.startsWith('@')) {
    return FORBIDDEN_PACKAGE_SCOPES.has(normalized.split('/')[0] ?? '') || FORBIDDEN_SCOPED_NAME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }
  return FORBIDDEN_PACKAGE_NAME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

/** `npm:` の別名の指定（`npm:<名前>@<範囲>`）の、先のパッケージの名前（別名でなければ null）。 */
const NPM_ALIAS_PREFIX = 'npm:';
const aliasTargetOf = (specification: unknown): string | null => {
  if (typeof specification !== 'string' || !specification.startsWith(NPM_ALIAS_PREFIX)) {
    return null;
  }
  const target = specification.slice(NPM_ALIAS_PREFIX.length);
  // scope つきの名前は、2 つめの `@` の前まで。scope のない名前は、1 つめの `@` の前まで。
  const versionAt = target.indexOf('@', target.startsWith('@') ? 1 : 0);
  return versionAt < 0 ? target : target.slice(0, versionAt);
};

/** 依存の表（名前 → 指定）の、名前と別名の先のすべて。 */
const namesOfDependencyTable = (table: unknown): readonly string[] => {
  if (table === null || typeof table !== 'object') {
    return [];
  }
  return Object.entries(table).flatMap(([name, specification]) => [name, ...[aliasTargetOf(specification)].filter((target) => target !== null)]);
};

/** `package.json` の依存の表の名前。 */
const MANIFEST_DEPENDENCY_TABLES = Object.freeze(['dependencies', 'devDependencies'] as const);
/** `package-lock.json` の各パッケージの依存の表の名前。 */
const LOCK_DEPENDENCY_TABLES = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const);
/** `package-lock.json` の `packages` の鍵の、パッケージのフォルダの区切り。 */
const NODE_MODULES_SEGMENT = 'node_modules/';

/** (a) `package.json` の中の、禁じたパッケージ（`<表>: <名前>`）。 */
const findForbiddenManifestDependencies = (manifest: Readonly<Record<string, unknown>>): readonly string[] =>
  MANIFEST_DEPENDENCY_TABLES.flatMap((table) =>
    namesOfDependencyTable(manifest[table]).filter(isForbiddenPackageName).map((name) => `${table}: ${name}`));

/** `packages` の鍵（`node_modules/a/node_modules/@s/b` など）の、最後のパッケージの名前（root の `''` は null）。 */
const packageNameOfLockKey = (key: string): string | null => {
  const at = key.lastIndexOf(NODE_MODULES_SEGMENT);
  return at < 0 ? null : key.slice(at + NODE_MODULES_SEGMENT.length);
};

/** (b) `package-lock.json` の中の、禁じたパッケージ（`<鍵>: <名前>`）。 */
const findForbiddenLockPackages = (lock: Readonly<Record<string, unknown>>): readonly string[] => {
  const packages = lock['packages'];
  if (packages === null || typeof packages !== 'object') {
    return [];
  }
  return Object.entries(packages as Readonly<Record<string, unknown>>).flatMap(([key, entry]) => {
    const record = entry !== null && typeof entry === 'object' ? (entry as Readonly<Record<string, unknown>>) : {};
    const names = [
      packageNameOfLockKey(key),
      typeof record['name'] === 'string' ? record['name'] : null,
      ...LOCK_DEPENDENCY_TABLES.flatMap((table) => namesOfDependencyTable(record[table])),
    ].filter((name): name is string => name !== null);
    return [...new Set(names)].filter(isForbiddenPackageName).map((name) => `${key === '' ? '(root)' : key}: ${name}`);
  });
};

/** モジュールの指定子の、パッケージの名前（相対・絶対のパス、`node:` の組み込み、URL は null）。 */
const packageNameOfSpecifier = (specifier: string): string | null => {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || /^[a-z][a-z0-9+.-]*:\/\//iu.test(specifier)) {
    return null;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? null);
};

/** (c) ソースの中の、禁じたパッケージの参照（`import <指定子>`）。 */
const findForbiddenImports = (source: ScannedSource): readonly string[] =>
  findModuleSpecifiers(source.code)
    .filter((specifier) => {
      const name = packageNameOfSpecifier(specifier);
      return name !== null && isForbiddenPackageName(name);
    })
    .map((specifier) => `import ${specifier}`);

const readJson = (relativePath: string): Readonly<Record<string, unknown>> =>
  JSON.parse(readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8')) as Readonly<Record<string, unknown>>;

const MANIFEST = readJson('package.json');
const LOCK = readJson('package-lock.json');
/** 画面の起動の部品と、ビルドの補助（T29R-fix-1 の M-6）。 */
const LOCAL_UI_TOOL_DIRECTORIES: readonly string[] = ['apps/local-ui/launcher', 'apps/local-ui/build-tools'];
const SOURCE_FILES = [...loadSourceFiles(), ...loadLocalUiSourceFiles(), ...LOCAL_UI_TOOL_DIRECTORIES.flatMap(loadTypeScriptFilesUnder)];

/** 必ず走査の対象に入るファイル（空の走査で PASS しないための確かめ）。 */
const REQUIRED_FILES: readonly string[] = [
  'src/control/data-rules/scenario-data.ts',
  'src/control/data-rules-view.ts',
  'apps/local-ui/src/server/data-rule-functions.ts',
  'apps/local-ui/src/routes/scenarios/$profileId/$scenarioId/rules.tsx',
  // T29R-fix-1（M-6）: 画面の起動の部品と、ビルドの補助も走査する。
  'apps/local-ui/launcher/serve.ts',
  'apps/local-ui/build-tools/control-schemas-plugin.ts',
];

describe('LLM dependency gate (Task 29, T29f)', () => {
  it('detects the forbidden packages by name, scope and prefix, and leaves the others', () => {
    const forbidden = ['openai', 'OpenAI', '@anthropic-ai/sdk', 'anthropic', '@google/generative-ai', 'cohere-ai', '@mistralai/mistralai', 'ollama',
      'langchain', '@langchain/core', 'langchain-community', '@faker-js/faker', 'faker', 'chance', '@ai-sdk/openai', 'ai',
      // T29R-fix-1（M-6）
      '@openai/agents', '@google-cloud/aiplatform', '@google-cloud/vertexai', '@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-bedrock-agent-runtime',
      '@aws-sdk/client-bedrock', 'node-llama-cpp', '@mlc-ai/web-llm', '@azure-rest/ai-inference', '@azure/openai'];
    for (const name of forbidden) {
      expect(isForbiddenPackageName(name), name).toBe(true);
    }
    const allowed = ['@tanstack/react-start', 'playwright', 'ajv', 'fflate', 'react', 'vite', 'vitest', '@types/node', 'aiohttp-like', 'openapi-types',
      '@google/closure-compiler', 'chalk', 'airbnb-js-shims', '@openai-like/x', 'anthropology', '@aws-sdk/client-s3', '@google-cloud/storage',
      '@azure/identity'];
    for (const name of allowed) {
      expect(isForbiddenPackageName(name), name).toBe(false);
    }
  });

  it('(a)(b) detects a forbidden dependency in a manifest and a lock (including an npm alias and an indirect dependency)', () => {
    expect(findForbiddenManifestDependencies({ dependencies: { react: '^19', openai: '^4' }, devDependencies: { '@faker-js/faker': '^9' } }))
      .toEqual(['dependencies: openai', 'devDependencies: @faker-js/faker']);
    expect(findForbiddenManifestDependencies({ dependencies: { helper: 'npm:@anthropic-ai/sdk@0.30.0' } })).toEqual(['dependencies: @anthropic-ai/sdk']);
    expect(findForbiddenManifestDependencies({ dependencies: { react: '^19' }, scripts: { openai: 'x' } })).toEqual([]);
    expect(findForbiddenLockPackages({
      packages: {
        '': { dependencies: { react: '^19' } },
        'node_modules/react': { version: '19.0.0' },
        'node_modules/some-tool/node_modules/@langchain/core': { version: '0.3.0' },
        'node_modules/renamed': { name: 'cohere-ai', version: '7.0.0' },
        'node_modules/wrapper': { version: '1.0.0', optionalDependencies: { ollama: '^0.5' } },
      },
    })).toEqual([
      'node_modules/some-tool/node_modules/@langchain/core: @langchain/core',
      'node_modules/renamed: cohere-ai',
      'node_modules/wrapper: ollama',
    ]);
    expect(findForbiddenLockPackages({ packages: { '': {}, 'node_modules/ajv': { version: '8.0.0' } } })).toEqual([]);
  });

  it('(c) detects a forbidden import in every form, and ignores comments, relative paths and the other packages', () => {
    // 文字列の中の import の形も数える（指定子は文字列を残す本文から取る。厳しい側の近似）。
    const violating = [
      "const text = \"import OpenAI from 'openai'\";",
      "import OpenAI from 'openai';",
      "import { Anthropic } from '@anthropic-ai/sdk';",
      "import type { Content } from '@google/generative-ai';",
      "export { ChatOllama } from '@langchain/ollama';",
      "const faker = await import('@faker-js/faker/locale/ja');",
      "const client = require('cohere-ai');",
      "import 'langchain/chains';",
    ];
    for (const line of violating) {
      expect(findForbiddenImports(scanSource(line)), line).toHaveLength(1);
    }
    const allowed = [
      "// import OpenAI from 'openai';",
      "import { generateScenarioData } from './control/data-rules/scenario-data.js';",
      "import { createHash } from 'node:crypto';",
      "import { createServerFn } from '@tanstack/react-start';",
    ];
    for (const line of allowed) {
      expect(findForbiddenImports(scanSource(line)), line).toEqual([]);
    }
  });

  it('(a) package.json has no LLM SDK or synthetic data library', () => {
    expect(MANIFEST_DEPENDENCY_TABLES.some((table) => Object.keys((MANIFEST[table] ?? {}) as object).length > 0)).toBe(true);
    expect(findForbiddenManifestDependencies(MANIFEST)).toEqual([]);
  });

  it('(b) package-lock.json has no LLM SDK or synthetic data library, directly or indirectly', () => {
    expect(Object.keys((LOCK['packages'] ?? {}) as object).length).toBeGreaterThan(1);
    expect(findForbiddenLockPackages(LOCK)).toEqual([]);
  });

  it('(c) src/, apps/local-ui/src/, the launcher and the build tools import no LLM SDK or synthetic data library', () => {
    const paths = SOURCE_FILES.map((file) => file.path);
    for (const required of REQUIRED_FILES) {
      expect(paths).toContain(required);
    }
    const violations = SOURCE_FILES.flatMap((file) => findForbiddenImports(file).map((found) => `${file.path}: ${found}`));
    expect(violations).toEqual([]);
  });
});

/**
 * 後方互換を捨てた後の片づけの Gate（PRE42-CC 組 UI-K3。台帳の CC-114。LG-3b の報告）。
 * - (a) 認証の設定の型（`AuthSetup`）は版 3 だけ（`AuthSetupV3`）。いつも真になる版の確かめ（`setup.schemaVersion === AUTH_SETUP_SCHEMA_VERSION_3`・
 *   `!==`。左右どちらでも）を、`src/` と画面（`apps/local-ui/src/`）に書かない。読み取った文書の版の確かめは、スキーマ（管理データの検証）が行う。
 * - (b) `npm run build` は、`schemas` を `dist/schemas` に写す前に `dist/schemas` を消す（消した Schema を dist に残さない）。依存を足さず、Node の
 *   標準の `fs`（`rmSync`・`cpSync`）の 1 行で行う。PRE42-CC 組 Z: `tsc` の前に `dist` の全体を消す（消した src のファイルの出力を dist に残さない。
 *   `dist/schemas` も、その中で消える）。順は「`dist` を消す → `tsc` → `schemas` を写す」。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の検索だけで行う（近似の検査。コメントは数えない）。1 秒以内に終える。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCAL_UI_SOURCE_DIRECTORY, MAX_GATE_MS, readTypeScriptFilesUnder, scanSource, startCpuStopwatch, type UnscannedFile } from './source-scan.js';

const FILES: readonly UnscannedFile[] = [...readTypeScriptFilesUnder('src'), ...readTypeScriptFilesUnder(LOCAL_UI_SOURCE_DIRECTORY)];

/** (a) 版 3 との比べ（`….schemaVersion` と `AUTH_SETUP_SCHEMA_VERSION_3`。左右どちらでも）。 */
const VERSION_NAME = 'AUTH_SETUP_SCHEMA_VERSION_3';
const VERSION_COMPARISONS: readonly RegExp[] = [
  new RegExp(String.raw`(?:[\w$]+\s*\??\.\s*)*schemaVersion\s*[=!]==?\s*${VERSION_NAME}(?![\w$])`, 'gu'),
  new RegExp(String.raw`(?<![\w$])${VERSION_NAME}\s*[=!]==?\s*(?:[\w$]+\s*\??\.\s*)*schemaVersion(?![\w$])`, 'gu'),
];
const findVersionComparisons = (content: string): readonly string[] => {
  const { code } = scanSource(content);
  return VERSION_COMPARISONS.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[0]));
};

/** (b) `package.json` の `build` の、写す前に消す形。 */
const buildScriptOf = (): string => (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts['build'] ?? '';
const REMOVE_OPTIONS = String.raw`\s*,\s*\{\s*recursive:\s*true\s*,\s*force:\s*true\s*\}\s*\)`;
const COMPILE = /\btsc\s+-p\s+tsconfig\.build\.json\b/u;
const COPY_SCHEMAS = /\bcpSync\(\s*'schemas'\s*,\s*'dist\/schemas'/u;
/** 組 Z: `dist` の全体を `tsc` の前に消し、`schemas` は `tsc` の後に写す。 */
const removesBeforeCopy = (script: string): boolean => {
  const removal = script.search(new RegExp(String.raw`\brmSync\(\s*'dist'${REMOVE_OPTIONS}`, 'u'));
  const compile = script.search(COMPILE);
  const copy = script.search(COPY_SCHEMAS);
  return removal >= 0 && compile > removal && copy > compile;
};

describe('Gate: the clean-up after dropping the old auth setup versions (PRE42-CC group UI-K3, CC-114)', () => {
  it('(a) writes no always-true comparison with AUTH_SETUP_SCHEMA_VERSION_3 in src and the local UI', () => {
    const stopwatch = startCpuStopwatch();
    const found = FILES.filter(({ content }) => content.includes(VERSION_NAME))
      .flatMap(({ path, content }) => findVersionComparisons(content).map((comparison) => `${path}: ${comparison}`));
    expect(found).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });

  it('(b) removes dist before compiling, and copies the schemas after compiling in npm run build (PRE42-CC group Z)', () => {
    expect(removesBeforeCopy(buildScriptOf()), buildScriptOf()).toBe(true);
  });

  it('detects the comparisons and the build script forms (detector self-check)', () => {
    expect(findVersionComparisons('if (setup.schemaVersion !== AUTH_SETUP_SCHEMA_VERSION_3 || other) {}')).toEqual(['setup.schemaVersion !== AUTH_SETUP_SCHEMA_VERSION_3']);
    expect(findVersionComparisons('return stored.setup.schemaVersion === AUTH_SETUP_SCHEMA_VERSION_3 && ok;')).toHaveLength(1);
    expect(findVersionComparisons('if (AUTH_SETUP_SCHEMA_VERSION_3 === setup.schemaVersion) {}')).toHaveLength(1);
    expect(findVersionComparisons('const setup = { schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3, profileId };')).toHaveLength(0);
    expect(findVersionComparisons('// setup.schemaVersion === AUTH_SETUP_SCHEMA_VERSION_3\nconst x = 1;')).toHaveLength(0);
    const removeDist = "node -e \"import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true });\"";
    const copy = "node -e \"import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });\"";
    expect(removesBeforeCopy(`${removeDist} && tsc -p tsconfig.build.json && ${copy}`)).toBe(true);
    // 前の形（組 UI-K3）: `dist/schemas` だけを消す（消した src のファイルの出力が残る）。
    expect(removesBeforeCopy("tsc -p tsconfig.build.json && node -e \"import { cpSync, rmSync } from 'node:fs'; "
      + "rmSync('dist/schemas', { recursive: true, force: true }); cpSync('schemas', 'dist/schemas', { recursive: true });\"")).toBe(false);
    expect(removesBeforeCopy(`tsc -p tsconfig.build.json && ${copy}`)).toBe(false);
    // 順が違う: `tsc` の後に消す、写した後に消す。
    expect(removesBeforeCopy(`tsc -p tsconfig.build.json && ${removeDist} && ${copy}`)).toBe(false);
    expect(removesBeforeCopy(`tsc -p tsconfig.build.json && ${copy} && ${removeDist}`)).toBe(false);
  });
});

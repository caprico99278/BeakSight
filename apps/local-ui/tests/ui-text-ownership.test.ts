/**
 * 画面のコード（`apps/local-ui/src/**`、`launcher/**`、`build-tools/**`、`vite.config.ts`）に、日本語の文字を直接書かないことの確かめ
 * （UI 追補設計書の GATE-UI06 と同じ決まり。T23f）。利用者に見せる文は、`src/presentation/messages.ts` と `catalog.ts` から取る。
 * - 既存の UI Gate（`tests/architecture/ui-ssot.test.ts`）は `src/**` だけを読むので、画面のコードはここで確かめる（Gate のファイルは変えない）。
 * - コメントを除いた本文（文字列リテラルと JSX の文字を含む）を見る。生成のファイル（`routeTree.gen.ts`）は除く。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanSource } from '../../../tests/architecture/source-scan.js';
import { REPO_ROOT } from './helpers/local-server.ts';

/** 日本語の文字（ひらがな・カタカナ・漢字）。 */
const JAPANESE_CHARACTER_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

/** 読むフォルダ（`apps/local-ui/` から）。 */
const UI_CODE_DIRECTORIES = Object.freeze(['src', 'launcher', 'build-tools'] as const);

/** 読まないファイル（生成のファイル）。 */
const GENERATED_FILES: ReadonlySet<string> = new Set(['src/routeTree.gen.ts']);

const APP_DIRECTORY = `${REPO_ROOT}/apps/local-ui`;

const uiCodeFiles = (): readonly string[] => [
  'vite.config.ts',
  ...UI_CODE_DIRECTORIES.flatMap((directory) =>
    readdirSync(`${APP_DIRECTORY}/${directory}`, { recursive: true, encoding: 'utf8' })
      .map((path) => `${directory}/${path.replaceAll('\\', '/')}`)
      .filter((path) => /\.tsx?$/u.test(path) && !GENERATED_FILES.has(path))),
];

/** コメントを除いた本文の、日本語の文字を含む行（`<行番号>: <行>`）。 */
const japaneseLinesOf = (source: string): readonly string[] =>
  scanSource(source).code.split('\n').flatMap((line, index) => (JAPANESE_CHARACTER_PATTERN.test(line) ? [`${index + 1}: ${line.trim()}`] : []));

describe('local UI code does not write Japanese text directly', () => {
  it('detects Japanese in string literals and JSX text, and ignores comments', () => {
    expect(japaneseLinesOf("const label = '保存する';")).toHaveLength(1);
    expect(japaneseLinesOf('const view = <p>保存する</p>;')).toHaveLength(1);
    expect(japaneseLinesOf('// 保存する\n/* 保存する */\nconst label = LOCAL_UI_TEXT.profileForm.save;')).toHaveLength(0);
  });

  it('reads the routes, the components, the server functions and the launcher', () => {
    expect(uiCodeFiles()).toEqual(expect.arrayContaining([
      'src/routes/index.tsx',
      'src/components/ProfileForm.tsx',
      'src/server/profile-functions.ts',
      'launcher/serve.ts',
      'launcher/request-guard.ts',
    ]));
  });

  it('has no Japanese outside comments in the UI code', () => {
    const violations = uiCodeFiles().flatMap((path) =>
      japaneseLinesOf(readFileSync(`${APP_DIRECTORY}/${path}`, 'utf8')).map((line) => `${path}:${line}`));
    expect(violations).toEqual([]);
  });
});

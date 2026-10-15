/**
 * READ の確かめの判定の SSOT の Architecture Gate（CCX-10。T27e の発見事項 1・3・4）。
 * - (a) 送れる欄の判定（`isSendableField`、`isSendableReadCheckParameter`、`unsendableReadCheckParameterNames`）は、純粋な契約
 *   `src/discovery/read-check-contracts.ts` にだけ定義する。保存の確かめ（`src/control/read-check-policy.ts`）と、ワーカーの実行の前の確かめ直し
 *   （`src/worker/read-check-run.ts`）は、そこから import して使う。前の非公開の名前（`isAllowedParameter`）も、owner の外に定義しない。
 * - (b) 「この画面の記録は読み切れたか」の判定（`isDiscoveryPageReadInFull`）は、`src/discovery/discovery-result.ts` にだけ定義する。読んだ画面の
 *   path（`discoveryReadPagePaths`。同じファイル）と、READ の確かめの対象の画面の読み取り（`src/discovery/read-executor.ts`）が使う。読み切れなかった
 *   理由の一覧（`UNRELIABLE_INCOMPLETE_REASONS`）も、owner の外に定義しない。
 * - (c) 読み込みの事前の判定（`isRunNavigationBlocked`）は、`src/orchestration/authenticated-run.ts` にだけ定義する。巡回の候補の除外
 *   （`isExcludedCrawlCandidate`。同じファイル）と、READ の確かめの事前の判定（`src/worker/read-check-run.ts` の `isReadUrlAllowed`）が使い、
 *   READ の確かめの流れは、要求の判定（`classifyPassiveRequest`）を直接呼ばない。
 * - 判定は、関数の定義の名前（`function 名前`、`const 名前 =` など）と識別子の出現を、`fs`、正規表現、文字列の走査だけで数える（AST・子
 *   process・`dist/` を使わない）。`src/**` の読み込みは、このファイルの読み込み時に 1 回だけ行う（`source-scan.ts`）。1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { countIdentifier, findImportSpecifiers, loadSourceFiles, scanSource, type ScannedSource, type SourceFile } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** 判定の owner と、owner の外に定義しない名前と、使う側（owner から import して、その名前を使うファイル）。 */
interface JudgementOwnership {
  readonly owner: string;
  /** owner にちょうど 1 回定義し、owner の外に定義しない名前。 */
  readonly names: readonly string[];
  /** 前の名前（どこにも定義しない。書き写しを、前の名前で戻さない）。 */
  readonly retiredNames: readonly string[];
  readonly users: readonly { readonly path: string; readonly name: string; readonly specifier: string }[];
}

/** (a)(b)(c) の owner と使う側。 */
const OWNERSHIPS: readonly JudgementOwnership[] = [
  {
    // (a) 送れる欄の判定。
    owner: 'src/discovery/read-check-contracts.ts',
    names: ['isSendableField', 'isSendableReadCheckParameter', 'unsendableReadCheckParameterNames'],
    retiredNames: ['isAllowedParameter'],
    users: [
      { path: 'src/control/read-check-policy.ts', name: 'isSendableReadCheckParameter', specifier: '../discovery/read-check-contracts.js' },
      { path: 'src/worker/read-check-run.ts', name: 'unsendableReadCheckParameterNames', specifier: '../discovery/read-check-contracts.js' },
    ],
  },
  {
    // (b) 読み切れた画面の判定。
    owner: 'src/discovery/discovery-result.ts',
    names: ['isDiscoveryPageReadInFull', 'UNRELIABLE_INCOMPLETE_REASONS'],
    retiredNames: [],
    users: [{ path: 'src/discovery/read-executor.ts', name: 'isDiscoveryPageReadInFull', specifier: './discovery-result.js' }],
  },
  {
    // (c) 読み込みの事前の判定。
    owner: 'src/orchestration/authenticated-run.ts',
    names: ['isRunNavigationBlocked'],
    retiredNames: [],
    users: [{ path: 'src/worker/read-check-run.ts', name: 'isRunNavigationBlocked', specifier: '../orchestration/authenticated-run.js' }],
  },
];

/** (c): 要求の判定を直接呼ばず、読み込みの事前の判定の部品を使うファイル。 */
const READ_CHECK_FLOW = 'src/worker/read-check-run.ts';
const REQUEST_CLASSIFIER = 'classifyPassiveRequest';

/** 正規表現の特別な文字を逃がす。 */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * `bare`（コメントと文字列の中身を除いた本文）の中の、`name` の定義の数（`function name`、`function* name`、`const`・`let`・`var` の `name =`・
 * `name:`（型の注釈つき）、`class name`）。近似の検査。
 */
const countDefinitions = (bare: string, name: string): number => {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(
    `(?<![\\w$])(?:function\\s*\\*?\\s*${escaped}(?![\\w$])|(?:const|let|var)\\s+${escaped}\\s*[=:]|class\\s+${escaped}(?![\\w$]))`,
    'gu',
  );
  return [...bare.matchAll(pattern)].length;
};

/** ファイル（パスで探す。なければテストの失敗）。 */
const fileOf = (path: string): SourceFile => {
  const file = SOURCE_FILES.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`missing source file: ${path}`);
  }
  return file;
};

/** owner の外で owner の名前を定義している箇所と、どこかで前の名前を定義している箇所（`パス: 名前`）。 */
const copiedDefinitionsOf = (files: readonly (Pick<SourceFile, 'path'> & ScannedSource)[], ownership: JudgementOwnership): readonly string[] =>
  files.flatMap((file) => [...(file.path === ownership.owner ? [] : ownership.names), ...ownership.retiredNames]
    .filter((name) => countDefinitions(file.bare, name) > 0)
    .map((name) => `${file.path}: ${name}`));

describe('READ check judgement SSOT detectors (CCX-10)', () => {
  it('counts the definitions by name, not the uses, the comments or the strings', () => {
    const source = scanSource([
      'const isSendableField = (field) => field.name.length > 0;',
      'export function isDiscoveryPageReadInFull(record) { return true; }',
      'let isRunNavigationBlocked: (url: string) => boolean;',
      'export const UNRELIABLE_INCOMPLETE_REASONS = new Set();',
      'function* isAllowedParameter() {}',
      'const used = isSendableField(field) && isSendableFieldOther(field);',
      '// const isSendableReadCheckParameter = () => true;',
      "const text = 'function unsendableReadCheckParameterNames() {}';",
      'import { isSendableReadCheckParameter } from "./read-check-contracts.js";',
    ].join('\n'));
    expect(countDefinitions(source.bare, 'isSendableField')).toBe(1);
    expect(countDefinitions(source.bare, 'isDiscoveryPageReadInFull')).toBe(1);
    expect(countDefinitions(source.bare, 'isRunNavigationBlocked')).toBe(1);
    expect(countDefinitions(source.bare, 'UNRELIABLE_INCOMPLETE_REASONS')).toBe(1);
    expect(countDefinitions(source.bare, 'isAllowedParameter')).toBe(1);
    expect(countDefinitions(source.bare, 'isSendableReadCheckParameter')).toBe(0);
    expect(countDefinitions(source.bare, 'unsendableReadCheckParameterNames')).toBe(0);
    expect(countDefinitions(source.bare, 'isSendableFieldOther')).toBe(0);
  });

  it('reports a copied definition outside the owner', () => {
    const [ownership] = OWNERSHIPS;
    if (ownership === undefined) {
      throw new Error('no ownership');
    }
    const copy = { path: 'src/control/read-check-policy.ts', ...scanSource('const isSendableField = (field) => !field.hidden;') };
    const owner = { path: ownership.owner, ...scanSource('export const isSendableField = (field) => !field.hidden;') };
    const retired = { path: 'src/worker/read-check-run.ts', ...scanSource('const isAllowedParameter = (candidate, name) => true;') };
    expect(copiedDefinitionsOf([copy, owner, retired], ownership))
      .toEqual(['src/control/read-check-policy.ts: isSendableField', 'src/worker/read-check-run.ts: isAllowedParameter']);
  });
});

describe('READ check judgement SSOT (CCX-10)', () => {
  it.each(OWNERSHIPS.map((ownership) => [ownership.owner, ownership] as const))('defines the judgements of %s only in the owner', (_owner, ownership) => {
    const owner = fileOf(ownership.owner);
    expect(ownership.names.map((name) => [name, countDefinitions(owner.bare, name)])).toEqual(ownership.names.map((name) => [name, 1]));
    expect(copiedDefinitionsOf(SOURCE_FILES, ownership)).toEqual([]);
  });

  it.each(OWNERSHIPS.flatMap((ownership) => ownership.users.map((user) => [user.path, user.name, user] as const)))(
    '%s uses %s from the owner',
    (_path, name, user) => {
      const file = fileOf(user.path);
      expect(findImportSpecifiers(file.code)).toContain(user.specifier);
      // import の 1 回と、使う 1 回以上。
      expect(countIdentifier(file.bare, name)).toBeGreaterThanOrEqual(2);
    },
  );

  it('lists the read pages with the judgement of a page read in full (the same owner)', () => {
    expect(countIdentifier(fileOf('src/discovery/discovery-result.ts').bare, 'isDiscoveryPageReadInFull')).toBeGreaterThanOrEqual(2);
  });

  it('leaves the request judgement of the READ check flow to the shared navigation pre-check', () => {
    expect(countIdentifier(fileOf(READ_CHECK_FLOW).bare, REQUEST_CLASSIFIER)).toBe(0);
    expect(countIdentifier(fileOf('src/orchestration/authenticated-run.ts').bare, 'isRunNavigationBlocked')).toBeGreaterThanOrEqual(2);
  });
});

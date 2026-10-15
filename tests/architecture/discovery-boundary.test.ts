/**
 * 発見（`src/discovery/`）の純粋な部品の境界の Architecture Gate（Task 27 の設計書 4.1、4.3、4.4。T27a）。
 * - (x) 純粋な部品（`PURE_DISCOVERY_FILES`。候補の契約、分類の語、分類、指紋）は、Playwright（`playwright-core`、`@playwright/*`、
 *   `@axe-core/playwright` を含む）、ブラウザと監査エンジン（`src/browser/`、`src/safety/`、`src/orchestration/`、`src/evidence/`、
 *   `src/interaction/`）、管理の側（`src/control/`、`src/worker/`）、ファイル・プロセス・ネットワーク・データベースの Node の部品
 *   （`node:fs`、`node:child_process`、`node:sqlite` など）を、直接にも、実行時に読み込む相対の import をたどった先にも読み込まない。
 *   `src/control/`（T27c）とワーカーから、そのまま import できるようにするため（`control-boundary.test.ts` の (b) と同じ禁止の範囲を含む）。
 *   `node:crypto`（`src/core/ids.ts` の SHA-256）は許す。型だけの import はたどらない（実行時に消えるため）。
 * - (y) 純粋な部品の一覧のファイルがすべてある（一覧が古くならない）。
 * - T27b（Task 27 の設計書 4.2）: ブラウザの部品（`BROWSER_DISCOVERY_FILES`。probe、JS の結び付き、落ち着きの待ち、発見の入口）を、純粋な
 *   部品と分けて持つ。
 *   - (v) `src/discovery/` のファイルは、純粋な部品かブラウザの部品の、どちらかの一覧にちょうど 1 回だけ載る（新しいファイルの置き忘れを防ぐ）。
 *     ブラウザの部品の一覧のファイルもすべてある。
 *   - (x) 純粋な部品は、ブラウザの部品も、直接にも、たどった先にも読み込まない（純粋な部品の一覧の Gate は、ブラウザの部品を含めずに保つ）。
 *   - (w) `src/discovery/` のどのファイルも、ページを操作する呼び出し（`fill`・`type`・`press`・`pressSequentially`・`insertText`・`setInputFiles`・
 *     `check`・`uncheck`・`setChecked`・`selectOption`・`click`・`dblclick`・`dispatchEvent`・`submit`・`requestSubmit`・`tap`・`hover`・
 *     `dragTo`・`dragAndDrop`・`focus`）と、`keyboard`・`mouse`・`touchscreen` を使わない。ブラウザの中で動く関数の中も同じ（関数の本文も
 *     走査の対象）。`.click.call(…)` のような、メソッドを取り出して呼ぶ形と、`x['click']` の形も数える。`worker-login-hooks.test.ts` の (q) は
 *     `src/` の全体の入力の操作を見ていて、`src/discovery/` に例外はない（例外の一覧には入れない）。
 *     T27R の M3: page を受け取るワーカーの流れ（`PAGE_RECEIVING_WORKER_FILES`。発見のジョブ、READ の確かめのジョブ、共通の読み込みの部品）も、
 *     同じ (w) の対象にする（一覧のファイルがすべてあることも確かめる）。
 * - DEF-087（Task 27 の設計書 4.2、4.5）: ページを読む関数は、CDP の isolated world で動かす（ページの JS が読み取りを偽れない）。
 *   - (e) `src/discovery/` のどのファイルも、`page.evaluate`・`frame.evaluate`・`evaluateHandle`・`evaluateAll`・`$eval`・`$$eval` を使わない
 *     （main world で動く。`.evaluate.call(…)` の形と、`x['evaluate']` の形も数える）。T27R2 の M1: `waitForFunction`・`addScriptTag`・
 *     `addInitScript`・`exposeFunction`・`exposeBinding`・`addStyleTag` も同じく数える。ページの中の読み取りの入口は、isolated world の部品
 *     （`ISOLATED_READ_FILE`）だけ。isolated world を作る命令と、関数を動かす命令（`ISOLATED_WORLD_COMMANDS`）は、その部品の外に書かない。
 *   - (c) 送る CDP の命令は、閉じた一覧の外にない: CDP の命令の形の文字列（`Domain.command`）は、同じファイルが宣言した閉じた一覧
 *     （`*_CDP_COMMANDS = Object.freeze([…])`）に載るものだけ。`.send(` の最初の引数は、文字列のリテラル（session の共通の部品
 *     `CDP_SESSION_FILE` の、型で一覧に絞った引数を除く）。CDP の session を開く呼び出し（`newCDPSession`）は、session の共通の部品だけ。
 * - T32j-4（Task 32 の設計書 4.4 の「CC-068 の設計」の 2）: 要素の橋渡し（`ISOLATED_READ_FILE` の `readElementsInIsolatedWorld`・
 *   `readElementInIsolatedWorld`・`elementHandleOf`）を足した。要素の backendNodeId を読む命令と、要素を解決する命令（`DOM.describeNode`・
 *   `DOM.resolveNode`）は、その部品の閉じた一覧（`ISOLATED_ELEMENT_CDP_COMMANDS`）に載せる（(c)。`listeners.ts` も `DOM.resolveNode` を使う）。
 *   - (e2) `src/discovery/` の外で、ページを読んで安全の判断に使う部品（`ISOLATED_READ_CALLER_FILES`。ログインの form の事前の確かめ、
 *     書き込みの form の読み取りと同じ要素の確かめ、Interaction の候補の発見・解決・読み取り）は、main world で動かす呼び出し（(e) と同じ
 *     名前）を使わず、CDP の session を自分で開かず、isolated world の命令を自分で書かない。読み取りは `ISOLATED_READ_FILE` の部品を
 *     import して行う（一覧のファイルがすべてあり、どれもその部品を import する）。
 *   - (e3)（T32j-4 fix round 1）: 候補の読み取りの差し替えの口（`src/interaction/discover-candidates.ts` の `withInteractionCandidateReads`）は、
 *     テストだけが使う。`src/` のほかのファイルは、この名前を書かない（本番の呼び出し側は既定の isolated world の読み取りを使う）。
 * - 判定は、`fs`、正規表現、文字列の走査だけで行う（`source-scan.ts` の走査を共用する。AST・子 process・`dist/` を使わない）。近似の検査で
 *   ある（指定子を実行時に組み立てる import は、相対パスの文字列リテラルの検出で補う）。ファイル全体を 1 秒以内に終える。
 * - CCX-9（台帳の CC-054、CC-056）: 指定子の取り出し（`findModuleSpecifiers`。`getBuiltinModule` の文字列を含む）、import のたどり
 *   （`findImportChains`）、相対の指定子の解決（`resolveRelativeSpecifier`）は、`source-scan.ts` の共通の部品を使う（指定子を取り出す
 *   正規表現は、このファイルに書かない）。
 */
import { describe, expect, it } from 'vitest';
import {
  PLAYWRIGHT_PACKAGE_PATTERN,
  findTransitiveForbiddenReferences,
  loadSourceFiles,
  moduleReferenceCandidatesOf,
  resolveRelativeSpecifier,
  scanSource,
  withoutModuleExtension,
  type ScannedSource,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** (x): 発見の純粋な部品（T27a）。ブラウザの部品（T27b の probe など）は含めない。 */
const PURE_DISCOVERY_FILES: readonly string[] = [
  'src/discovery/candidate-contracts.ts',
  'src/discovery/classification-words.ts',
  'src/discovery/classify.ts',
  'src/discovery/fingerprint.ts',
  // T27c（設計書の変更履歴「Blocker: T27c」の行の (3)）: READ の確かめの契約（純粋。`src/control/` とワーカーから使う）。
  'src/discovery/read-check-contracts.ts',
  // T27d（設計書の変更履歴「Blocker: T27d」の行）: 成果物 `discovery.json` の形と、組み立てとまとめ（純粋。ワーカーとジョブの管理から使う）。
  'src/discovery/discovery-result.ts',
  // T27e（設計書 4.5）: READ の確かめの候補の確かめ・URL の組み立て・照合・成果物 `read-evidence.json` の形（純粋。ワーカーとジョブの管理から使う）。
  'src/discovery/read-check-evaluation.ts',
];

/** (v): 発見のブラウザの部品（T27b）。純粋な部品の一覧には含めない。 */
const BROWSER_DISCOVERY_FILES: readonly string[] = [
  'src/discovery/probe.ts',
  'src/discovery/listeners.ts',
  'src/discovery/settle.ts',
  'src/discovery/discover-page.ts',
  // T27e（設計書 4.5）: READ の確かめの、対象の画面の候補の読み取りと、結果のページの構造の読み取り（isolated world の 1 回の読み取り。DEF-087）。
  'src/discovery/read-executor.ts',
  // DEF-087: CDP の session の開け閉めの共通の部品と、isolated world の読み取り。
  'src/discovery/cdp-session.ts',
  'src/discovery/isolated-read.ts',
];

/** (e)・(c)（DEF-087）: isolated world の読み取りの部品と、CDP の session の共通の部品。 */
const ISOLATED_READ_FILE = 'src/discovery/isolated-read.ts';
const CDP_SESSION_FILE = 'src/discovery/cdp-session.ts';
/** (e): isolated world を作る命令と、関数を動かす命令（`ISOLATED_READ_FILE` の外に書かない）。 */
const ISOLATED_WORLD_COMMANDS: readonly string[] = ['Page.createIsolatedWorld', 'Runtime.callFunctionOn'];

/** (e3)（T32j-4 fix round 1）: 候補の読み取りの差し替えの口と、その持ち主のファイル。 */
const CANDIDATE_READS_OVERRIDE_NAME = 'withInteractionCandidateReads';
const CANDIDATE_READS_OWNER_FILE = 'src/interaction/discover-candidates.ts';

/** (e2)（T32j-4）: `src/discovery/` の外で、ページを読んで安全の判断に使う部品（読み取りは `ISOLATED_READ_FILE` の部品だけで行う）。 */
const ISOLATED_READ_CALLER_FILES: readonly string[] = [
  'src/browser/login-form-submitter.ts',
  'src/browser/write-form-submitter.ts',
  'src/interaction/discover-candidates.ts',
];

/** (v): 発見の部品のフォルダ。 */
const DISCOVERY_DIRECTORY = 'src/discovery/';

/**
 * (w)（T27R の M3）: page を受け取るワーカーの流れ（発見のジョブ、READ の確かめのジョブ、その共通の読み込みの部品）。`src/discovery/` と同じく、
 * ページを操作しない。
 */
const PAGE_RECEIVING_WORKER_FILES: readonly string[] = [
  'src/worker/discovery-run.ts',
  'src/worker/read-check-run.ts',
  'src/worker/worker-run-session.ts',
];

/** (w) の対象のファイルか（`src/discovery/` のファイルと、page を受け取るワーカーの流れ）。 */
const isPageOperationTarget = (path: string): boolean => path.startsWith(DISCOVERY_DIRECTORY) || PAGE_RECEIVING_WORKER_FILES.includes(path);

/** (w): ページを操作するメソッドの名前（呼び出し、`.call`・`.apply`・`.bind` での呼び出し、`x['name']` の取り出しを数える）。 */
const PAGE_OPERATION_NAMES: readonly string[] = [
  'fill', 'type', 'press', 'pressSequentially', 'insertText', 'setInputFiles', 'check', 'uncheck', 'setChecked', 'selectOption', 'click',
  'dblclick', 'dispatchEvent', 'submit', 'requestSubmit', 'tap', 'hover', 'dragTo', 'dragAndDrop', 'focus',
];
const PAGE_OPERATION_ALTERNATION = PAGE_OPERATION_NAMES.join('|');
/** (w): 引数を問わず数える名前（`type` を除く）。 */
const UNCONDITIONAL_OPERATION_ALTERNATION = PAGE_OPERATION_NAMES.filter((name) => name !== 'type').join('|');
/** (w): `.name(`（`type` は引数のある呼び出しだけ。引数のない `type()` は読み取り）と、`.name.call(` などの形（`bare` から）。 */
const PAGE_OPERATION_CALL = new RegExp(
  `\\.\\s*(?:(?:${UNCONDITIONAL_OPERATION_ALTERNATION})\\s*\\(|type\\s*\\((?!\\s*\\))|(?:${PAGE_OPERATION_ALTERNATION})\\s*\\.\\s*(?:call|apply|bind)\\b)`,
  'gu',
);
/**
 * (w): `x['name']` の形（`code` から。直前が識別子か閉じ括弧のときだけ。配列のリテラルは数えない）。`type` は、引数のある呼び出し
 * （`x['type']('…')`）だけを数える（`x['type']` は、CDP の結果などの読み取り）。
 */
const PAGE_OPERATION_INDEX = new RegExp(
  `(?<=[\\w$)\\]])\\s*\\[\\s*(?:(['"\`])(?:${UNCONDITIONAL_OPERATION_ALTERNATION})\\1\\s*\\]|(['"\`])type\\2\\s*\\]\\s*\\((?!\\s*\\)))`,
  'gu',
);
/** (w): 入力の装置（`page.keyboard`、`page.mouse`、`page.touchscreen`）の識別子（`bare` から）。 */
const INPUT_DEVICE_IDENTIFIER = /(?<![\w$])(?:keyboard|mouse|touchscreen)(?![\w$])/gu;

/** (e): main world で動かす Playwright の呼び出しの名前。 */
const PAGE_EVALUATION_ALTERNATION = [
  'evaluate', 'evaluateHandle', 'evaluateAll', '\\$eval', '\\$\\$eval',
  // T27R2 の M1: 関数や script をページの main world で動かす、ほかの呼び出し（関数を待つ、script と style を足す、読み込みの前の script、
  // ページから Node の関数を呼べるようにする）。
  'waitForFunction', 'addScriptTag', 'addInitScript', 'exposeFunction', 'exposeBinding', 'addStyleTag',
].join('|');
/** (e): `.name(` と、`.name.call(` などの形（`bare` から）。 */
const PAGE_EVALUATION_CALL = new RegExp(`\\.\\s*(?:${PAGE_EVALUATION_ALTERNATION})\\s*(?:\\(|\\.\\s*(?:call|apply|bind)\\b)`, 'gu');
/** (e): `x['name']` の形（`code` から。直前が識別子か閉じ括弧のときだけ）。 */
const PAGE_EVALUATION_INDEX = new RegExp(`(?<=[\\w$)\\]])\\s*\\[\\s*(['"\`])(?:${PAGE_EVALUATION_ALTERNATION})\\1\\s*\\]`, 'gu');
/** (c): CDP の命令の形の文字列（`Domain.command`）。 */
const CDP_COMMAND_SHAPE = /^[A-Z][A-Za-z]*\.[a-z][A-Za-z]*$/u;
/** (c): 閉じた一覧の宣言（`*_CDP_COMMANDS = Object.freeze([…])`。`code` から）。 */
const CDP_COMMAND_LIST_DECLARATION = /\b[A-Z][A-Z_]*_CDP_COMMANDS\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]/gu;
/** (c): 一覧の中の文字列のリテラル。 */
const QUOTED_LITERAL = /(['"])([^'"\r\n]*)\1/gu;
/** (c): 最初の引数が文字列のリテラルでない `.send(`（`bare` から。リテラルの中身は空になり、引用符は残る）。 */
const NON_LITERAL_SEND = /\.\s*send\s*\(\s*(?![\s'"`])/gu;
/** (c): CDP の session を開く呼び出し（`bare` から）。 */
const NEW_CDP_SESSION = /\bnewCDPSession\b/gu;

/** (x): 読み込まない Node の部品（`node:` の有無を問わない。下の部分も含む）。`node:crypto` は許す。 */
const FORBIDDEN_NODE_MODULE = /^(?:node:)?(?:fs|child_process|sqlite|net|http|https|http2|dgram|worker_threads|cluster|vm|inspector)(?:\/|$)/u;
/** (x): 読み込まない `src/` のフォルダ。 */
const FORBIDDEN_DIRECTORIES: readonly string[] = [
  'src/browser/', 'src/safety/', 'src/orchestration/', 'src/evidence/', 'src/interaction/', 'src/control/', 'src/worker/',
];

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/** 指定子（相対でないもの）が、禁止のパッケージか Node の部品か。 */
const isForbiddenPackage = (specifier: string): boolean =>
  PLAYWRIGHT_PACKAGE_PATTERN.test(specifier) || FORBIDDEN_NODE_MODULE.test(specifier) || /(?:^|\/)src\/(?:browser|safety|orchestration|evidence|interaction|control|worker)(?:\/|$)/u.test(specifier);

/** リポジトリの根からのパスが、禁止のフォルダか、発見のブラウザの部品（T27b。拡張子を問わない）か。 */
const isForbiddenPath = (path: string): boolean => FORBIDDEN_DIRECTORIES.some((directory) => `${path}/`.startsWith(directory))
  || BROWSER_DISCOVERY_FILES.includes(`${withoutModuleExtension(path)}.ts`);

/** 直接の参照の違反（指定子のすべてと、相対パスの文字列リテラル。型だけの import も数える）。 */
const findDirectViolations = (path: string, source: ScannedSource): readonly string[] =>
  moduleReferenceCandidatesOf(source, [PLAYWRIGHT_PACKAGE_PATTERN]).filter((text) => {
  const resolved = resolveRelativeSpecifier(path, text);
  return resolved === null ? isForbiddenPackage(text) : isForbiddenPath(resolved);
});

/**
 * 実行時の import を、`source-scan.ts` の `findImportChains`（CCX-9）でたどった先の違反（`<始まり> -> … -> <先>` の形）。禁止のフォルダの
 * 判定は、`.js` などを `.ts` に読み替えたパス（たどった先のファイルが禁止のフォルダでも同じ）。
 */
const findTransitiveViolations = (files: ReadonlyMap<string, ScannedSource>, starts: readonly string[]): readonly string[] =>
  findTransitiveForbiddenReferences(files, starts, isForbiddenPath, isForbiddenPackage);

/** (w): ページを操作する呼び出しと、入力の装置の参照（近似）。 */
const findPageOperations = (source: ScannedSource): readonly string[] => [
  ...[...source.bare.matchAll(PAGE_OPERATION_CALL)].map((match) => match[0]),
  ...[...source.code.matchAll(PAGE_OPERATION_INDEX)].map((match) => match[0].trim()),
  ...[...source.bare.matchAll(INPUT_DEVICE_IDENTIFIER)].map((match) => match[0]),
];

/** (e): main world で動かす呼び出し（近似）。 */
const findPageEvaluations = (source: ScannedSource): readonly string[] => [
  ...[...source.bare.matchAll(PAGE_EVALUATION_CALL)].map((match) => match[0]),
  ...[...source.code.matchAll(PAGE_EVALUATION_INDEX)].map((match) => match[0].trim()),
];

/** (e): `src/discovery/` の、main world で動かす呼び出しと、isolated world の部品の外の、isolated world の命令（`<path>: <呼び出し>` の形）。 */
const findPageEvaluationViolations = (files: readonly (ScannedSource & { readonly path: string })[]): readonly string[] => files
  .filter(({ path }) => path.startsWith(DISCOVERY_DIRECTORY))
  .flatMap((file) => [
    ...findPageEvaluations(file),
    ...(file.path === ISOLATED_READ_FILE ? [] : file.literals.filter((literal) => ISOLATED_WORLD_COMMANDS.includes(literal))),
  ].map((violation) => `${file.path}: ${violation}`));

/** (e2): 読み取りの部品の import の指定子（`ISOLATED_READ_FILE` を指すもの）があるか。 */
const importsIsolatedRead = (file: ScannedSource & { readonly path: string }): boolean =>
  moduleReferenceCandidatesOf(file).some((text) => {
    const resolved = resolveRelativeSpecifier(file.path, text);
    return resolved !== null && `${withoutModuleExtension(resolved)}.ts` === ISOLATED_READ_FILE;
  });

/**
 * (e2): 一覧の部品の、main world で動かす呼び出し、CDP の session を開く呼び出し、isolated world の命令、読み取りの部品の import がないこと
 * （`<path>: <違反>` の形）。
 */
const findIsolatedReadCallerViolations = (files: readonly (ScannedSource & { readonly path: string })[]): readonly string[] => files
  .filter(({ path }) => ISOLATED_READ_CALLER_FILES.includes(path))
  .flatMap((file) => [
    ...findPageEvaluations(file),
    ...[...file.bare.matchAll(NEW_CDP_SESSION)].map((match) => match[0]),
    ...file.literals.filter((literal) => ISOLATED_WORLD_COMMANDS.includes(literal)),
    ...(importsIsolatedRead(file) ? [] : ['no import of the isolated read part']),
  ].map((violation) => `${file.path}: ${violation}`));

/** (e3): 持ち主のほかの `src/` のファイルが、差し替えの口の名前を書いた行（`<path>: <行>`）。 */
const findCandidateReadsOverrideViolations = (files: readonly (ScannedSource & { readonly path: string })[]): readonly string[] => files
  .filter(({ path }) => path.startsWith('src/') && path !== CANDIDATE_READS_OWNER_FILE)
  .flatMap((file) => file.code.split('\n').filter((line) => line.includes(CANDIDATE_READS_OVERRIDE_NAME)).map((line) => `${file.path}: ${line.trim()}`));

/** (c): ファイルが宣言した閉じた一覧の命令。 */
const declaredCdpCommandsOf = (source: ScannedSource): ReadonlySet<string> => new Set(
  [...source.code.matchAll(CDP_COMMAND_LIST_DECLARATION)].flatMap((match) => [...(match[1] ?? '').matchAll(QUOTED_LITERAL)].map((literal) => literal[2] ?? '')),
);

/** (c): `src/discovery/` の、閉じた一覧の外の CDP の命令、リテラルでない命令の名前、session の共通の部品の外の session を開く呼び出し。 */
const findCdpCommandViolations = (files: readonly (ScannedSource & { readonly path: string })[]): readonly string[] => files
  .filter(({ path }) => path.startsWith(DISCOVERY_DIRECTORY))
  .flatMap((file) => {
    const declared = declaredCdpCommandsOf(file);
    const ownsSession = file.path === CDP_SESSION_FILE;
    return [
      ...file.literals.filter((literal) => CDP_COMMAND_SHAPE.test(literal) && !declared.has(literal)),
      ...(ownsSession ? [] : [...file.bare.matchAll(NON_LITERAL_SEND)].map((match) => match[0].trim())),
      ...(ownsSession ? [] : [...file.bare.matchAll(NEW_CDP_SESSION)].map((match) => match[0])),
    ].map((violation) => `${file.path}: ${violation}`);
  });

/** (w): 対象のファイル（`isPageOperationTarget`）の、ページを操作する呼び出し（`<path>: <呼び出し>` の形）。 */
const findPageOperationViolations = (files: readonly (ScannedSource & { readonly path: string })[]): readonly string[] => files
  .filter(({ path }) => isPageOperationTarget(path))
  .flatMap((file) => findPageOperations(file).map((operation) => `${file.path}: ${operation}`));

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト（違反の例と、違反でない例）
// ---------------------------------------------------------------------------------------------------------------

describe('Discovery boundary detectors', () => {
  it('(x) detects direct references to Playwright, the browser and audit engine, src/control and file or process modules', () => {
    const path = 'src/discovery/classify.ts';
    for (const line of [
      "import { chromium } from 'playwright';",
      "import type { Page } from 'playwright-core';",
      "import { AxeBuilder } from '@axe-core/playwright';",
      "import { readFileSync } from 'node:fs';",
      "import { readFile } from 'node:fs/promises';",
      "import { readFileSync } from 'fs';",
      "import { spawn } from 'node:child_process';",
      "import { DatabaseSync } from 'node:sqlite';",
      "const fs = process.getBuiltinModule('node:fs');",
      "const fs = require('fs');",
      "import { createContext } from '../browser/context-factory.js';",
      "import { classifyPassiveRequest } from '../safety/request-policy.js';",
      "import { DEFAULT_EXCLUDED_URL_WORDS } from '../control/auth/auth-setup-contracts.js';",
      "import type { WorkerMessage } from '../worker/protocol.js';",
      "const policy = await import('../safety/request-policy.js');",
      "const directory = '../control/';",
    ]) {
      expect(findDirectViolations(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import { createSha256Fingerprint } from '../core/ids.js';",
      "import { classifyUrl } from '../crawl/admission-policy.js';",
      "import { CANDIDATE_KINDS } from './candidate-contracts.js';",
      "import { createHash } from 'node:crypto';",
      "// import { chromium } from 'playwright';",
      "const label = 'playwright を使わない';",
      "const word = 'fs';",
    ]) {
      expect(findDirectViolations(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(x) follows runtime imports transitively, and skips type-only imports', () => {
    const files = new Map<string, ScannedSource>([
      ['src/discovery/a.ts', scanSource("import { b } from '../core/b.js';\nimport type { T } from '../core/t.js';")],
      ['src/core/b.ts', scanSource("import { c } from '../crawl/c.js';")],
      ['src/crawl/c.ts', scanSource("import { readFileSync } from 'node:fs';")],
      ['src/core/t.ts', scanSource("import { chromium } from 'playwright';")],
      ['src/discovery/clean.ts', scanSource("import { d } from '../core/d.js';")],
      ['src/core/d.ts', scanSource("import { createHash } from 'node:crypto';\nimport type { T } from '../core/t.js';")],
      ['src/discovery/engine.ts', scanSource("export * from '../core/e.js';")],
      ['src/core/e.ts', scanSource("import '../safety/request-policy.js';")],
    ]);
    expect(findTransitiveViolations(files, ['src/discovery/a.ts'])).toEqual([
      'src/discovery/a.ts -> src/core/b.ts -> src/crawl/c.ts -> node:fs',
    ]);
    expect(findTransitiveViolations(files, ['src/discovery/clean.ts'])).toEqual([]);
    expect(findTransitiveViolations(files, ['src/discovery/engine.ts'])).toEqual([
      'src/discovery/engine.ts -> src/core/e.ts -> src/safety/request-policy.ts',
    ]);
  });

  it('(x) treats the browser discovery files as forbidden for the pure files (T27b)', () => {
    const path = 'src/discovery/classify.ts';
    for (const line of [
      "import { probePageCandidates } from './probe.js';",
      "import type { ProbedCandidate } from './probe.js';",
      "import { discoverPageCandidates } from './discover-page.js';",
      "const settle = await import('./settle.js');",
    ]) {
      expect(findDirectViolations(path, scanSource(line)), line).toHaveLength(1);
    }
    expect(findDirectViolations(path, scanSource("import { CANDIDATE_KINDS } from './candidate-contracts.js';"))).toHaveLength(0);
    const files = new Map<string, ScannedSource>([
      ['src/discovery/pure.ts', scanSource("import { x } from '../core/x.js';")],
      ['src/core/x.ts', scanSource("import { readCandidateListeners } from '../discovery/listeners.js';")],
    ]);
    expect(findTransitiveViolations(files, ['src/discovery/pure.ts'])).toEqual([
      'src/discovery/pure.ts -> src/core/x.ts -> src/discovery/listeners.ts',
    ]);
  });

  it('(w) detects page operations, also inside functions that run in the browser', () => {
    for (const line of [
      "await page.fill('#q', value);",
      "await locator.type('x');",
      "await page.press('#q', 'Enter');",
      "await locator.pressSequentially('x');",
      "await page.keyboard.insertText('x');",
      "await locator.setInputFiles('a.txt');",
      'await locator.check();',
      'await locator.uncheck();',
      'await locator.setChecked(true);',
      "await locator.selectOption('a');",
      'await locator.click();',
      'await locator.dblclick();',
      "await locator.dispatchEvent('click');",
      'await page.evaluate(() => { form.submit(); });',
      'await page.evaluate(() => { HTMLFormElement.prototype.requestSubmit.call(form); });',
      'await locator.tap();',
      'await locator.hover();',
      'await locator.dragTo(other);',
      "await page.dragAndDrop('#a', '#b');",
      'await page.evaluate(() => element.focus());',
      'HTMLElement.prototype.click.call(element);',
      'const press = HTMLElement.prototype.click.bind(element);',
      'element.dispatchEvent.apply(element, [event]);',
      "element['click']();",
      "form[\"submit\"]();",
      "await locator['type']('x');",
      'await page.mouse.down();',
      "await page.touchscreen.tap(1, 2);",
    ]) {
      expect(findPageOperations(scanSource(line)), line).not.toHaveLength(0);
    }
    for (const line of [
      'const kind = message.type();',
      "const kinds = ['click', 'submit', 'focus'];",
      "const listener = { type: 'click' };",
      "// await locator.click();",
      "const label = 'page.fill() を呼ばない';",
      "const submitter = candidate.submitterText;",
      "const typeOf = (node: Node): string => text(read(prototype, 'type', node));",
      "const isClickable = kinds.includes('click');",
      "const kind = typeof listener['type'] === 'string' ? listener['type'] : '';",
      "const type = requireOneOf(CANDIDATE_FIELD_TYPES, raw['type']);",
      'const focused = submitterPath;',
    ]) {
      expect(findPageOperations(scanSource(line)), line).toEqual([]);
    }
  });

  it('(w) also looks at the worker flows that receive the page, and not at the other files (T27R M3)', () => {
    const violation = 'await page.click();';
    const files = [
      'src/worker/discovery-run.ts',
      'src/worker/read-check-run.ts',
      'src/worker/worker-run-session.ts',
      'src/discovery/probe.ts',
      'src/worker/audit-worker.ts',
      'src/browser/login-form-submitter.ts',
    ].map((path) => ({ path, ...scanSource(violation) }));
    expect(findPageOperationViolations(files)).toEqual([
      'src/worker/discovery-run.ts: .click(',
      'src/worker/read-check-run.ts: .click(',
      'src/worker/worker-run-session.ts: .click(',
      'src/discovery/probe.ts: .click(',
    ]);
  });

  it('(e) detects the calls that run in the main world, and the isolated world commands outside the isolated read part (DEF-087)', () => {
    for (const line of [
      'const raw = await page.evaluate(discoveryProbeInPage, DISCOVERY_PROBE_INPUT);',
      'await page.mainFrame().evaluate(() => document.title);',
      'await frame.evaluate(readStructureInPage, input);',
      'const handle = await page.evaluateHandle(() => window);',
      'await locator.evaluateAll((elements) => elements.length);',
      "await page.$eval('form', (form) => form.method);",
      "await page.$$eval('form', (forms) => forms.length);",
      'const run = page.evaluate.bind(page);',
      "await page['evaluate'](readStructureInPage, input);",
      // T27R2 の M1: ページの main world で関数や script を動かす、ほかの呼び出し。
      'await page.waitForFunction(() => document.readyState === "complete");',
      "await page.mainFrame().waitForFunction('window.ready');",
      "await page.addScriptTag({ content: 'window.x = 1' });",
      'await page.addInitScript(readStructureInPage);',
      'await page.context().addInitScript({ path: script });',
      'await page.exposeFunction("report", (value) => value);',
      'await context.exposeBinding("report", (source, value) => value);',
      "await page.addStyleTag({ content: 'form { display: none }' });",
      'const wait = page.waitForFunction.bind(page);',
      "await page['addInitScript'](readStructureInPage);",
      "await context['exposeBinding']('report', handler);",
    ]) {
      expect(findPageEvaluations(scanSource(line)), line).not.toHaveLength(0);
    }
    for (const line of [
      "await reader.send('Runtime.evaluate', { expression: WINDOW_EXPRESSION });",
      '// await page.evaluate(fn);',
      "const label = 'page.evaluate を使わない';",
      'const evaluated = evaluateReadCheck(structure);',
      'const outcome = await readInIsolatedWorld(page, readStructureInPage, input, deadlineAtMs);',
      // 名前の一部に含むだけのもの（呼び出しの名前と一致しない）は数えない。
      'const settled = await waitForFunctionalSettle(page);',
      "const label = 'addInitScript を使わない';",
    ]) {
      expect(findPageEvaluations(scanSource(line)), line).toEqual([]);
    }
    const commands = "const a = 'Page.createIsolatedWorld';\nconst b = 'Runtime.callFunctionOn';";
    expect(findPageEvaluationViolations([
      { path: ISOLATED_READ_FILE, ...scanSource(commands) },
      { path: 'src/discovery/probe.ts', ...scanSource(commands) },
      { path: 'src/discovery/listeners.ts', ...scanSource('await page.evaluate(fn);') },
      { path: 'src/discovery/settle.ts', ...scanSource('await page.waitForFunction(fn);\nawait page.addInitScript(fn);') },
      { path: 'src/browser/login-form-submitter.ts', ...scanSource('await page.evaluate(fn);') },
    ])).toEqual([
      'src/discovery/probe.ts: Page.createIsolatedWorld',
      'src/discovery/probe.ts: Runtime.callFunctionOn',
      'src/discovery/listeners.ts: .evaluate(',
      'src/discovery/settle.ts: .waitForFunction(',
      'src/discovery/settle.ts: .addInitScript(',
    ]);
  });

  it('(e2) detects main world calls, own CDP sessions, isolated world commands and a missing import of the isolated read part in the callers (T32j-4)', () => {
    const reads = "import { readInIsolatedWorld } from '../discovery/isolated-read.js';\n";
    expect(findIsolatedReadCallerViolations([
      { path: 'src/browser/login-form-submitter.ts', ...scanSource(`${reads}await locator.evaluate(fn, args);`) },
      { path: 'src/browser/write-form-submitter.ts', ...scanSource(`${reads}const session = await page.context().newCDPSession(page);`) },
      { path: 'src/interaction/discover-candidates.ts', ...scanSource("await handle.evaluate(fn);\nconst command = 'Page.createIsolatedWorld';") },
      { path: 'src/interaction/isolated-auditor.ts', ...scanSource('await page.evaluate(fn);') },
    ])).toEqual([
      'src/browser/login-form-submitter.ts: .evaluate(',
      'src/browser/write-form-submitter.ts: newCDPSession',
      'src/interaction/discover-candidates.ts: .evaluate(',
      'src/interaction/discover-candidates.ts: Page.createIsolatedWorld',
      'src/interaction/discover-candidates.ts: no import of the isolated read part',
    ]);
    expect(findIsolatedReadCallerViolations([
      { path: 'src/browser/login-form-submitter.ts', ...scanSource(`${reads}const outcome = await readInIsolatedWorld(page, fn, input, deadline);`) },
    ])).toEqual([]);
  });

  it('(e3) detects the candidate reads override outside its owner (T32j-4 fix round 1)', () => {
    expect(findCandidateReadsOverrideViolations([
      { path: 'src/interaction/isolated-auditor.ts', ...scanSource('const page = withInteractionCandidateReads(session.page, reads);') },
      { path: CANDIDATE_READS_OWNER_FILE, ...scanSource('export function withInteractionCandidateReads(page, reads) {}') },
      { path: 'tests/integration/x.test.ts', ...scanSource('withInteractionCandidateReads(page, reads);') },
      { path: 'src/orchestration/page-auditor.ts', ...scanSource('// withInteractionCandidateReads は使わない') },
    ])).toEqual(['src/interaction/isolated-auditor.ts: const page = withInteractionCandidateReads(session.page, reads);']);
  });

  it('(c) detects CDP commands outside the closed list of the file, non-literal command names and sessions opened outside the session part (DEF-087)', () => {
    const declared = "export const EXAMPLE_CDP_COMMANDS = Object.freeze([\n  'DOM.getDocument',\n  'Runtime.evaluate',\n] as const);\n";
    expect(findCdpCommandViolations([
      { path: 'src/discovery/listeners.ts', ...scanSource(`${declared}await reader.send('DOM.getDocument', {});`) },
      { path: 'src/discovery/probe.ts', ...scanSource("await session.send('Runtime.evaluate', {});") },
      { path: 'src/discovery/settle.ts', ...scanSource(`${declared}await reader.send('Input.dispatchMouseEvent', {});`) },
      { path: 'src/discovery/read-executor.ts', ...scanSource('await session.send(method, params);') },
      { path: 'src/discovery/discover-page.ts', ...scanSource('const session = await page.context().newCDPSession(page);') },
      { path: CDP_SESSION_FILE, ...scanSource('const opening = page.context().newCDPSession(page);\nawait session.send(method, params as never);') },
      { path: 'src/browser/navigation-diagnostics.ts', ...scanSource("await session.send('Network.enable');") },
    ])).toEqual([
      'src/discovery/probe.ts: Runtime.evaluate',
      'src/discovery/settle.ts: Input.dispatchMouseEvent',
      'src/discovery/read-executor.ts: .send(',
      'src/discovery/discover-page.ts: newCDPSession',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

describe('Discovery boundary (Task 27 design 4.1, 4.3, 4.4)', () => {
  it('(y) every listed pure discovery file exists', () => {
    const paths = new Set(SOURCE_FILES.map((file) => file.path));
    for (const path of PURE_DISCOVERY_FILES) {
      expect(paths.has(path), path).toBe(true);
    }
  });

  it('(x) the pure discovery files do not reference Playwright, the audit engine, src/control or file and process modules', () => {
    const violations = SOURCE_FILES
      .filter((file) => PURE_DISCOVERY_FILES.includes(file.path))
      .flatMap((file) => findDirectViolations(file.path, file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(x) nothing that the pure discovery files load at run time reaches them either', () => {
    const files = new Map<string, ScannedSource>(SOURCE_FILES.map((file) => [file.path, file]));
    expect(findTransitiveViolations(files, PURE_DISCOVERY_FILES)).toEqual([]);
  });

  it('(v) every file in src/discovery/ is listed exactly once, either as a pure part or as a browser part (T27b)', () => {
    const listed = [...PURE_DISCOVERY_FILES, ...BROWSER_DISCOVERY_FILES];
    expect(new Set(listed).size).toBe(listed.length);
    const discoveryFiles = SOURCE_FILES.map(({ path }) => path).filter((path) => path.startsWith(DISCOVERY_DIRECTORY)).sort();
    expect(discoveryFiles).toEqual([...listed].sort());
  });

  it('(w) no file in src/discovery/ and no worker flow that receives the page operates the page (T27b, T27R M3)', () => {
    expect(findPageOperationViolations(SOURCE_FILES)).toEqual([]);
  });

  it('(w) every listed worker flow that receives the page exists (T27R M3)', () => {
    const paths = new Set(SOURCE_FILES.map((file) => file.path));
    for (const path of PAGE_RECEIVING_WORKER_FILES) {
      expect(paths.has(path), path).toBe(true);
    }
  });

  it('(e) no file in src/discovery/ runs a function in the main world; only the isolated read part runs functions in the page (DEF-087)', () => {
    expect(findPageEvaluationViolations(SOURCE_FILES)).toEqual([]);
    const isolatedRead = SOURCE_FILES.find(({ path }) => path === ISOLATED_READ_FILE);
    expect(ISOLATED_WORLD_COMMANDS.filter((command) => !(isolatedRead?.literals.includes(command) ?? false))).toEqual([]);
  });

  it('(e2) the login form, the write form and the interaction candidates read the page only through the isolated read part (T32j-4)', () => {
    const paths = new Set(SOURCE_FILES.map((file) => file.path));
    expect(ISOLATED_READ_CALLER_FILES.filter((path) => !paths.has(path))).toEqual([]);
    expect(findIsolatedReadCallerViolations(SOURCE_FILES)).toEqual([]);
  });

  it('(e3) only the tests override the interaction candidate reads (T32j-4 fix round 1)', () => {
    expect(SOURCE_FILES.some(({ path, code }) => path === CANDIDATE_READS_OWNER_FILE && code.includes(CANDIDATE_READS_OVERRIDE_NAME))).toBe(true);
    expect(findCandidateReadsOverrideViolations(SOURCE_FILES)).toEqual([]);
  });

  it('(c) every CDP command sent from src/discovery/ is in the closed list of its file (DEF-087)', () => {
    expect(findCdpCommandViolations(SOURCE_FILES)).toEqual([]);
  });
});

/**
 * Architecture Gate（GATE-ARCH01〜08）の、ソースの読み込みと走査の補助。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の走査だけで行う（AST・TypeScript のコンパイラ API・外部ツール・子プロセス・
 *   `dist/` を使わない。`references/ui-ux-ssot.md` 第6章）。
 * - `loadSourceFiles()` は、各テストのファイルの読み込み時に1回だけ呼び、結果を各検査で共有する（ファイルごとに1回だけ読む）。
 * - `scanSource()` は、1文字ずつの走査で、コメントと文字列リテラルを分ける。構文の解析はしない（近似）。
 * - CCX-9（台帳の CC-054、CC-056）: モジュールの参照の取り出し（`findModuleReferences` とその見方）と、import のたどり（`findImportChains`、
 *   `reachableFiles`、`resolveRelativeSpecifier`、`resolveImportTarget`）は、このファイルだけに置く。指定子を取り出す正規表現を、
 *   ほかの Gate のファイルに書かない（`module-references.test.ts` の規則。`findSpecifierRegexShapes` で確かめる）。
 * - CCX-27（台帳の CC-074、CC-082 の後半、CC-088）: Gate が共用する、相対パスの文字列の判定（`isRelativePathText`）、参照の候補
 *   （`moduleReferenceCandidatesOf`）、Playwright のパッケージの名前（`PLAYWRIGHT_PACKAGE_PATTERN`）、禁じた層へのたどり
 *   （`findTransitiveForbiddenReferences`）、静的な参照の節（`ModuleReference` の `statement`・`defaultBinding`・`namedBindings`）、括弧の対応
 *   （`matchingParenthesis`）も、ここに置く。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 走査の結果。 */
export interface ScannedSource {
  /** コメントを空白に置き換えた本文（文字列リテラルは残す。改行の位置は元のまま）。 */
  readonly code: string;
  /** コメントを空白に置き換え、文字列リテラルの中身を空にした本文（引用符と、テンプレートの `${…}` の式は残す）。 */
  readonly bare: string;
  /** 文字列リテラルの中身（引用符を除いた、書いたままの文字列）。テンプレートは、`${…}` で分けた固定の部分ごと。 */
  readonly literals: readonly string[];
  /**
   * 文字列リテラルの1つずつを、引用符を含めて書いたままの形で（UI Gate が使う。CC-030）。
   * - テンプレートは、`${…}` で分けずに1つとして並べ、`${…}` の式は `${}` に置き換える（例: `` `<td>${}</td>` ``）。
   *   式の中の文字列リテラルと、入れ子のテンプレートは、それぞれ別の1つとして並ぶ（閉じた順。内側が先）。
   * - 閉じていないリテラル（行の終わりの `'…`、ファイルの終わりのテンプレート）は、閉じる引用符なしで並べる。
   */
  readonly wholeLiterals: readonly string[];
}

export interface SourceFile extends ScannedSource {
  /** リポジトリの根からの相対パス（区切りは `/`）。 */
  readonly path: string;
  /** 読み込んだままの本文。 */
  readonly content: string;
}

/** 正規表現のリテラルの前に来うる語（この語の直後の `/` は、割り算ではなく正規表現の始まりとみなす）。 */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const IDENTIFIER_CHARACTER = /[\w$]/u;
const REGEX_PRECEDING_PUNCTUATORS = '(,=:[!&|?{};+-*%<>~^';

/** 直前の出力から、`/` が正規表現の始まりかを推定する（末尾から後ろ向きに読むだけで、出力を複製しない）。 */
const startsRegex = (emitted: string): boolean => {
  let end = emitted.length;
  while (end > 0 && /\s/u.test(emitted[end - 1] ?? '')) {
    end -= 1;
  }
  if (end === 0) {
    return true;
  }
  const last = emitted[end - 1] ?? '';
  if (IDENTIFIER_CHARACTER.test(last)) {
    let start = end;
    while (start > 0 && IDENTIFIER_CHARACTER.test(emitted[start - 1] ?? '')) {
      start -= 1;
    }
    return REGEX_PRECEDING_KEYWORDS.has(emitted.slice(start, end));
  }
  return REGEX_PRECEDING_PUNCTUATORS.includes(last);
};

/** 本文の走査で扱いの要る文字（コメントと正規表現の `/`、引用符、テンプレートの始まり）。CC-089: ほかの文字は、まとめて写す。 */
const CODE_SPECIAL = /[/'"`]/gu;
/** テンプレートの `${…}` の式の中で扱いの要る文字（上に、深さを数える波括弧を足す）。 */
const CODE_SPECIAL_IN_TEMPLATE = /[/'"`{}]/gu;
/** テンプレートの固定の部分で扱いの要る文字（`\` の後の 1 文字、終わりの `` ` ``、`${` の `$`）。 */
const TEMPLATE_SPECIAL = /[\\`$]/gu;

/**
 * TypeScript のソースを1文字ずつ走査し、コメントと文字列リテラルを分ける（近似。構文は解析しない）。
 * - `//` と `/* … *\/` のコメントは、空白に置き換える（改行は残す）。
 * - `'…'`、`"…"`、`` `…` ``（`${…}` の入れ子を含む）を文字列リテラルとして扱う。
 * - 正規表現のリテラルは、直前の字句から推定して、中身をそのまま残す（中の引用符やスラッシュを、文字列やコメントとみなさない）。
 * - 文字列リテラルは、固定の部分ごとの中身（`literals`）と、1つずつの書いたままの形（`wholeLiterals`。CC-030）の両方で返す。
 */
export const scanSource = (source: string): ScannedSource => {
  let code = '';
  let bare = '';
  const literals: string[] = [];
  const wholeLiterals: string[] = [];
  /** テンプレートの `${…}` の中にいる場合の、波括弧の深さの積み重ね。 */
  const templateDepths: number[] = [];
  /** 閉じていないテンプレートの、それまでの形（`wholeLiterals` に並べる形。外側から順に積む）。 */
  const openTemplates: string[] = [];
  let index = 0;
  const length = source.length;

  /** テンプレートの固定の部分を、`` ` `` か `${` の直後から読む。終わりの `` ` `` か、次の `${` の後まで進める。 */
  const readTemplateChunk = (): void => {
    let chunk = '';
    while (index < length) {
      // CC-089: 扱いの要らない文字（`\`・`` ` ``・`$` のほか）は、まとめて写す（1 文字ずつ写すのと同じ結果）。
      TEMPLATE_SPECIAL.lastIndex = index;
      const special = TEMPLATE_SPECIAL.exec(source)?.index ?? length;
      if (special > index) {
        const plain = source.slice(index, special);
        chunk += plain;
        code += plain;
        index = special;
        continue;
      }
      const character = source[index] ?? '';
      if (character === '\\') {
        chunk += source.slice(index, index + 2);
        code += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (character === '`') {
        literals.push(chunk);
        wholeLiterals.push(`${openTemplates.pop() ?? ''}${chunk}\``);
        code += '`';
        bare += '`';
        index += 1;
        return;
      }
      if (character === '$' && source[index + 1] === '{') {
        literals.push(chunk);
        openTemplates.push(`${openTemplates.pop() ?? ''}${chunk}\${}`);
        code += '${';
        bare += '${';
        index += 2;
        templateDepths.push(0);
        return;
      }
      chunk += character;
      code += character;
      index += 1;
    }
    literals.push(chunk);
    wholeLiterals.push(`${openTemplates.pop() ?? ''}${chunk}`);
  };

  while (index < length) {
    // CC-089: 扱いの要らない文字（`/`・引用符・`` ` ``・テンプレートの式の中の波括弧のほか）は、まとめて写す（1 文字ずつ写すのと同じ結果）。
    const plainPattern = templateDepths.length > 0 ? CODE_SPECIAL_IN_TEMPLATE : CODE_SPECIAL;
    plainPattern.lastIndex = index;
    const special = plainPattern.exec(source)?.index ?? length;
    if (special > index) {
      const plain = source.slice(index, special);
      code += plain;
      bare += plain;
      index = special;
      continue;
    }
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end < 0 ? length : end;
      code += ' ';
      bare += ' ';
      index = stop;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? length : end + 2;
      const newlines = source.slice(index, stop).replace(/[^\n]/gu, '');
      code += ` ${newlines}`;
      bare += ` ${newlines}`;
      index = stop;
      continue;
    }
    if (character === '/' && startsRegex(code)) {
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < length) {
        const inner = source[cursor] ?? '';
        if (inner === '\n') {
          break;
        }
        if (inner === '\\') {
          cursor += 2;
          continue;
        }
        if (inner === '[') {
          inClass = true;
        } else if (inner === ']') {
          inClass = false;
        } else if (inner === '/' && !inClass) {
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (closed) {
        const regex = source.slice(index, cursor + 1);
        code += regex;
        bare += regex;
        index = cursor + 1;
        continue;
      }
    }
    if (character === '\'' || character === '"') {
      let cursor = index + 1;
      while (cursor < length && source[cursor] !== character && source[cursor] !== '\n') {
        cursor += source[cursor] === '\\' ? 2 : 1;
      }
      literals.push(source.slice(index + 1, cursor));
      wholeLiterals.push(source.slice(index, source[cursor] === character ? cursor + 1 : cursor));
      code += source.slice(index, cursor + 1);
      bare += `${character}${character}`;
      index = cursor + 1;
      continue;
    }
    if (character === '`') {
      code += '`';
      bare += '`';
      index += 1;
      openTemplates.push('`');
      readTemplateChunk();
      continue;
    }
    if (templateDepths.length > 0) {
      const depth = templateDepths.length - 1;
      if (character === '{') {
        templateDepths[depth] = (templateDepths[depth] ?? 0) + 1;
      } else if (character === '}') {
        if (templateDepths[depth] === 0) {
          templateDepths.pop();
          code += '}';
          bare += '}';
          index += 1;
          readTemplateChunk();
          continue;
        }
        templateDepths[depth] = (templateDepths[depth] ?? 0) - 1;
      }
    }
    code += character;
    bare += character;
    index += 1;
  }
  // ファイルの終わりまで閉じなかった（`${…}` の中で終わった）テンプレートも、内側から並べる。
  wholeLiterals.push(...openTemplates.reverse());
  return { code, bare, literals, wholeLiterals };
};

/** `src/**` の TypeScript のファイルを、1回だけ列挙して読み込み、走査する。 */
export const loadSourceFiles = (): readonly SourceFile[] =>
  readdirSync(join(REPOSITORY_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((relativePath) => relativePath.endsWith('.ts'))
    .map((relativePath) => relativePath.replaceAll('\\', '/'))
    .sort()
    .map((relativePath) => {
      const content = readFileSync(join(REPOSITORY_ROOT, 'src', relativePath), 'utf8');
      return { path: `src/${relativePath}`, content, ...scanSource(content) };
    });

/** 画面のソースの置き場所（`apps/local-ui/src`）。 */
export const LOCAL_UI_SOURCE_DIRECTORY = 'apps/local-ui/src';
/** 画面のソースの拡張子（`.ts`、`.tsx`）。 */
const LOCAL_UI_SOURCE_EXTENSION = /\.tsx?$/u;

/**
 * 画面のソース（`apps/local-ui/src/**` の `.ts` と `.tsx`）を、1回だけ列挙して読み込み、走査する（T29f: 3 つの Gate が同じ読み込みを
 * それぞれ書いていたものを 1 か所にした）。パスは `apps/local-ui/src/<相対パス>`（区切りは `/`）。
 */
export const loadLocalUiSourceFiles = (): readonly SourceFile[] => loadTypeScriptFilesUnder(LOCAL_UI_SOURCE_DIRECTORY);

/**
 * リポジトリの根からの相対のフォルダ（区切りは `/`）の下の `.ts` と `.tsx` を、1回だけ列挙して読み込み、走査する（T29R-fix-1 の M-6。画面の起動の
 * 部品 `apps/local-ui/launcher` とビルドの補助 `apps/local-ui/build-tools` など）。パスは `<フォルダ>/<相対パス>`（区切りは `/`）。
 */
export const loadTypeScriptFilesUnder = (directory: string): readonly SourceFile[] =>
  readTypeScriptFilesUnder(directory).map((file) => scanFile(file));

/** 読み込んだだけの（走査していない）ファイル。 */
export interface UnscannedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * `loadTypeScriptFilesUnder` と同じファイルを、走査せずに読み込む（DEF-107。走査は文字ずつで重いので、本文の文字列で絞ってから
 * `scanFile` で走査するため）。パスと並びは `loadTypeScriptFilesUnder` と同じ。
 */
export const readTypeScriptFilesUnder = (directory: string): readonly UnscannedFile[] =>
  readdirSync(join(REPOSITORY_ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter((relativePath) => LOCAL_UI_SOURCE_EXTENSION.test(relativePath))
    .map((relativePath) => relativePath.replaceAll('\\', '/'))
    .sort()
    .map((relativePath) => ({
      path: `${directory}/${relativePath}`,
      content: readFileSync(join(REPOSITORY_ROOT, directory, relativePath), 'utf8'),
    }));

/** 読み込んだファイルを走査する。 */
export const scanFile = ({ path, content }: UnscannedFile): SourceFile => ({ path, content, ...scanSource(content) });

// ---------------------------------------------------------------------------------------------------------------
// モジュールの参照の取り出し（CCX-9。台帳の CC-054。指定子を取り出す正規表現は、このファイルの中だけに書く）
// ---------------------------------------------------------------------------------------------------------------

/**
 * モジュールの参照の形。
 * - `static`: `import … from '…'`、`export … from '…'`（`import * as`、`export *` を含む）
 * - `side-effect`: `import '…'`
 * - `dynamic-import`: `import('…')`、`` import(`…`) ``（`import('…')` の型を含む）
 * - `require`: `require('…')`、`require.resolve('…')`、`` require(`…`) ``
 * - `create-require`: `createRequire(…)('…')`、`createRequire(…).resolve('…')`、`createRequire(…)` を入れた変数の呼び出し
 * - `builtin-module`: `getBuiltinModule('…')`
 * - `file-url`: `new URL('…', import.meta.url)`、`` new URL(`…`, import.meta.url) ``
 */
export type ModuleReferenceForm =
  | 'static'
  | 'side-effect'
  | 'dynamic-import'
  | 'require'
  | 'create-require'
  | 'builtin-module'
  | 'file-url';

/** モジュールの参照の 1 つ。 */
export interface ModuleReference {
  readonly form: ModuleReferenceForm;
  /** 指定子（引用符を除く）。テンプレートは、最初の `${` の前まで（固定の部分。空のこともある）。 */
  readonly specifier: string;
  /**
   * 照合した、書いたままの形（前後の空白を除く）。`import * as`・`export *` は文の全体、ほかは指定子の閉じる引用符まで
   * （`from '…'`、`import('…'`、`require('…'` など）。GATE-ARCH08 の報告に使う。
   */
  readonly text: string;
  /** `code` の中の位置（参照の並びは、この位置の順）。 */
  readonly index: number;
  /** 型だけの import と export（`import type … from`、`export type … from`）。実行時には消える。`import { type T }` は含まない。 */
  readonly typeOnly: boolean;
  /**
   * モジュールの全体を受け取る形（`import * as`、`export *`、動的 import、`require`、`createRequire(…)(…)`、`getBuiltinModule`）。
   * `require.resolve`・`createRequire(…).resolve` と `new URL` は、モジュールを読み込まないので含まない。
   */
  readonly wholeModule: boolean;
  /** 指定子をテンプレートで書いた（`specifier` は固定の部分だけ）。 */
  readonly template: boolean;
  /**
   * 静的な参照（`form` が `static`）の、`import`・`export` の節（CCX-27。CC-088）。`keyword` は、`from` の前のいちばん近い `import` か `export`
   * （どちらもなければ `import`）、`clause` はその後から `from` の前まで（前後の空白と、先頭の `type` を除く）。ほかの形は `null`。
   */
  readonly statement: { readonly keyword: 'import' | 'export'; readonly clause: string } | null;
  /**
   * 既定の import の名前（`import name from`、`import name, { … } from` の `name`。`statement` の `keyword` が `import` で、節が識別子で
   * 始まるとき）。ほかは `null`。型だけの import（`import type X from`）でも名前を返す（`typeOnly` で見分ける）。
   */
  readonly defaultBinding: string | null;
  /** 節の `{ … }` の中の項目（前後の空白と、項目の前の `type` を除く。`a as b` はそのまま）。`{ … }` のない節と、ほかの形は空。 */
  readonly namedBindings: readonly string[];
}

/** `{ … }` の中身の項目（`,` で分け、前後の空白と、項目の前の `type` を除く。空の項目は除く）。 */
const bindingItemsOf = (text: string): readonly string[] =>
  text.split(',').map((name) => name.trim().replace(/^type\s+/u, '')).filter((name) => name.length > 0);

/** 節の始まりの識別子（既定の import の名前）。 */
const DEFAULT_BINDING_PATTERN = /^[A-Za-z_$][\w$]*/u;
/** 節を区切るキーワード。 */
const IMPORT_KEYWORD = 'import';
const EXPORT_KEYWORD = 'export';

/** 静的な参照（`from '…'` の位置が `fromIndex`）の節と、既定の import の名前と、`{ … }` の中の項目。 */
const staticStatementOf = (
  code: string,
  fromIndex: number,
): Pick<ModuleReference, 'statement' | 'defaultBinding' | 'namedBindings'> => {
  const importAt = code.lastIndexOf(IMPORT_KEYWORD, fromIndex);
  const exportAt = code.lastIndexOf(EXPORT_KEYWORD, fromIndex);
  const start = Math.max(importAt, exportAt);
  const keyword = start === importAt ? IMPORT_KEYWORD : EXPORT_KEYWORD;
  const clause = start < 0 ? '' : code.slice(start + IMPORT_KEYWORD.length, fromIndex).trim().replace(/^type\s+/u, '');
  const open = clause.indexOf('{');
  const close = clause.indexOf('}', open);
  return {
    statement: { keyword, clause },
    defaultBinding: keyword === IMPORT_KEYWORD ? DEFAULT_BINDING_PATTERN.exec(clause)?.[0] ?? null : null,
    namedBindings: open < 0 || close < 0 ? [] : bindingItemsOf(clause.slice(open + 1, close)),
  };
};

/** 文字列リテラルの指定子（`1` が引用符、`2` が中身）。 */
const QUOTED = String.raw`(['"])([^'"\r\n]+)\1`;
/** `from '…'`（静的な import と `export … from`）。 */
const STATIC_PATTERN = new RegExp(String.raw`\bfrom\s*${QUOTED}`, 'gu');
/** `import '…'`。 */
const SIDE_EFFECT_PATTERN = new RegExp(String.raw`\bimport\s*${QUOTED}`, 'gu');
/** `import('…'`・`` import(`… ``。閉じ括弧は問わない（第 2 引数や、文字列の連結の指定子も取る。GATE-ARCH08 の取り出しと同じ広さ）。 */
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(?:(['"])([^'"\r\n]+)\1|`([^`$]*))/gu;
/** `require('…'`・`require.resolve('…'`・`` require(`… ``（`1` が `.resolve`）。閉じ括弧は問わない。 */
const REQUIRE_PATTERN = /(?<![\w$.])require(\s*\.\s*resolve)?\s*\(\s*(?:(['"])([^'"\r\n]+)\2|`([^`$]*))/gu;
/** `createRequire(…)('…'`・`createRequire(…).resolve('…'`（`createRequire` の引数の中の括弧は 1 段の入れ子まで。`1` が `.resolve`）。 */
const CREATE_REQUIRE_CALL_PATTERN = /(?<![\w$])createRequire\s*\((?:[^()]|\([^()]*\))*\)\s*(\.\s*resolve\s*)?\(\s*(['"])([^'"\r\n]+)\2/gu;
/** `createRequire(…)` を入れた変数の名前（`const load = createRequire(…)`、`= module.createRequire(…)`）。 */
const CREATE_REQUIRE_BINDING_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\s*\.\s*)?createRequire\s*\(/gu;
/** `getBuiltinModule('…'`。 */
const BUILTIN_MODULE_PATTERN = new RegExp(String.raw`\bgetBuiltinModule\s*\(\s*${QUOTED}`, 'gu');
/** `new URL('…', import.meta.url)`・`` new URL(`…`, import.meta.url) ``。 */
const FILE_URL_PATTERN = /\bnew\s+URL\s*\(\s*(?:(['"])([^'"\r\n]+)\1|`([^`$]*)[^`]*`)\s*,\s*import\s*\.\s*meta\s*\.\s*url\b/gu;
/** 型だけの import と export（終わりの位置が、`STATIC_PATTERN` の終わりの位置と同じ）。 */
const TYPE_ONLY_PATTERN = new RegExp(String.raw`\b(?:import|export)\s+type\s+[^;'"\x60]*?\bfrom\s*${QUOTED}`, 'gu');
/** モジュールの全体を受け取る静的な形（`import * as`、`export *`、`export * as`。終わりの位置が、`STATIC_PATTERN` の終わりの位置と同じ）。 */
const WHOLE_STATIC_PATTERN = /\bimport\s*\*\s*as\s+[\w$]+\s*from\s*(['"])[^'"\r\n]+\1|\bexport\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*(['"])[^'"\r\n]+\2/gu;

/** 正規表現の終わりの位置ごとの、照合した本文。 */
const matchEnds = (code: string, pattern: RegExp): ReadonlyMap<number, string> =>
  new Map([...code.matchAll(pattern)].map((match) => [match.index + match[0].length, match[0]]));

/** `createRequire(…)` を入れた変数の呼び出し（`load('…'`・`load.resolve('…'`）。 */
const createRequireBindingCallsOf = (code: string): readonly RegExpExecArray[] =>
  [...new Set([...code.matchAll(CREATE_REQUIRE_BINDING_PATTERN)].map((binding) => binding[1] ?? ''))]
    .flatMap((name) => [...code.matchAll(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(name)}(\s*\.\s*resolve)?\s*\(\s*(['"])([^'"\r\n]+)\2`, 'gu'))]);

/**
 * `code`（コメントを除いた本文）の中の、モジュールの参照のすべて（近似。`code` の中の位置の順）。Architecture Gate の、指定子の取り出しの
 * ただ 1 つの入口（CCX-9）。今までの Gate のうち最も広い取り出しに合わせた: 閉じ括弧を問わない（第 2 引数のある呼び出しと、文字列の連結の
 * 指定子の最初の部分も取る）。テンプレートは、最初の `${` の前までを指定子とみなす。指定子を実行時に組み立てる参照は取れない
 * （各 Gate が、相対パスの文字列リテラルの検出で補う）。
 */
export const findModuleReferences = (code: string): readonly ModuleReference[] => {
  const cached = MODULE_REFERENCES_CACHE.get(code);
  if (cached !== undefined) {
    return cached;
  }
  const references = extractModuleReferences(code);
  MODULE_REFERENCES_CACHE.set(code, references);
  return references;
};

/** 本文ごとの取り出しの結果（同じファイルを、いくつもの検査が読むので、1 回だけ取り出す。結果は書き換えない）。 */
const MODULE_REFERENCES_CACHE = new Map<string, readonly ModuleReference[]>();

/** 静的な参照でない形の、節の値。 */
const NO_STATIC_STATEMENT: Pick<ModuleReference, 'statement' | 'defaultBinding' | 'namedBindings'> = Object.freeze({
  statement: null,
  defaultBinding: null,
  namedBindings: Object.freeze([]),
});

const extractModuleReferences = (code: string): readonly ModuleReference[] => {
  const typeOnlyEnds = matchEnds(code, TYPE_ONLY_PATTERN);
  const wholeStaticEnds = matchEnds(code, WHOLE_STATIC_PATTERN);
  const references: ModuleReference[] = [];
  const add = (
    form: ModuleReferenceForm,
    match: RegExpExecArray,
    specifier: string | undefined,
    flags: { readonly wholeModule: boolean; readonly template: boolean; readonly typeOnly?: boolean; readonly text?: string },
  ): void => {
    references.push({
      form,
      specifier: specifier ?? '',
      text: (flags.text ?? match[0]).trim(),
      index: match.index,
      typeOnly: flags.typeOnly ?? false,
      wholeModule: flags.wholeModule,
      template: flags.template,
      ...(form === 'static' ? staticStatementOf(code, match.index) : NO_STATIC_STATEMENT),
    });
  };
  for (const match of code.matchAll(STATIC_PATTERN)) {
    const end = match.index + match[0].length;
    const whole = wholeStaticEnds.get(end);
    add('static', match, match[2], {
      typeOnly: typeOnlyEnds.has(end),
      wholeModule: whole !== undefined,
      template: false,
      ...(whole === undefined ? {} : { text: whole }),
    });
  }
  for (const match of code.matchAll(SIDE_EFFECT_PATTERN)) {
    add('side-effect', match, match[2], { wholeModule: false, template: false });
  }
  for (const match of code.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    add('dynamic-import', match, match[2] ?? match[3], { wholeModule: true, template: match[3] !== undefined });
  }
  for (const match of code.matchAll(REQUIRE_PATTERN)) {
    add('require', match, match[3] ?? match[4], { wholeModule: match[1] === undefined, template: match[4] !== undefined });
  }
  for (const match of [...code.matchAll(CREATE_REQUIRE_CALL_PATTERN), ...createRequireBindingCallsOf(code)]) {
    add('create-require', match, match[3], { wholeModule: match[1] === undefined, template: false });
  }
  for (const match of code.matchAll(BUILTIN_MODULE_PATTERN)) {
    add('builtin-module', match, match[2], { wholeModule: true, template: false });
  }
  for (const match of code.matchAll(FILE_URL_PATTERN)) {
    add('file-url', match, match[2] ?? match[3], { wholeModule: false, template: match[3] !== undefined });
  }
  // 同じ位置の参照（`require` を `createRequire(…)` の変数の名前にした場合）は、上の順のまま並べる（`sort` は安定）。
  return references.sort((left, right) => left.index - right.index);
};

/** モジュールの指定子のすべて（型だけの import を含む。`code` の中の位置の順。同じ指定子も、書いた数だけ並べる）。 */
export const findModuleSpecifiers = (code: string): readonly string[] =>
  findModuleReferences(code).map((reference) => reference.specifier);

/** 実行時に読み込む指定子（`findModuleSpecifiers` から、型だけの import と export を除いたもの）。 */
export const findRuntimeModuleSpecifiers = (code: string): readonly string[] =>
  findModuleReferences(code).filter((reference) => !reference.typeOnly).map((reference) => reference.specifier);

/** import の文の指定子（`from '…'`、`import '…'`、`import('…')`。`export … from '…'` を含む。テンプレート・`require` などは含まない）の一覧。 */
const IMPORT_STATEMENT_FORMS: ReadonlySet<ModuleReferenceForm> = new Set(['static', 'side-effect', 'dynamic-import']);
export const findImportSpecifiers = (code: string): readonly string[] =>
  findModuleReferences(code)
    .filter((reference) => IMPORT_STATEMENT_FORMS.has(reference.form) && !reference.template)
    .map((reference) => reference.specifier);

/** 名前つきの import（`import { a, type B, c as d } from '…'`。`import type { … }` と、既定の import と並べた形は含まない）。 */
export interface NamedImport {
  readonly specifier: string;
  /** `{ … }` の中の項目（前後の空白と、項目の前の `type` を除く。`c as d` はそのまま）。 */
  readonly names: readonly string[];
}
const NAMED_IMPORT_PATTERN = new RegExp(String.raw`\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"\r\n]+)\2`, 'gu');
export const findNamedImports = (code: string): readonly NamedImport[] => [...code.matchAll(NAMED_IMPORT_PATTERN)].map((match) => ({
  specifier: match[3] ?? '',
  names: bindingItemsOf(match[1] ?? ''),
}));

/** import の文（`import … from '…'`）の範囲（`[始まり, 終わり)`）。`bare`（文字列の中身を除いた本文）を渡す。 */
const IMPORT_STATEMENT_PATTERN = /\bimport\s[^;]*?\bfrom\s*(['"])[^'"]*\1/gu;
export const findImportStatementRanges = (bare: string): readonly (readonly [number, number])[] =>
  [...bare.matchAll(IMPORT_STATEMENT_PATTERN)].map((match) => [match.index, match.index + match[0].length] as const);

/**
 * Gate の規則（CCX-9）: 指定子を取り出す正規表現の形。`import`・`require`・`createRequire` の直後の `\s`・`\(`・`\b`・`\.`・`(?:`・`|`
 * （間に `)` を挟んでもよい）と、`from` の直後の `\s*(['"]`。正規表現のリテラル（`bare` に残る）と、`new RegExp` に渡す文字列
 * （`literals`。`\\s` の形）の両方で見る。
 */
const SPECIFIER_REGEX_SHAPE =
  /(?<=^|[^\w$]|\\b)(?:import|require|createRequire)\)?(?:\\{1,2}[sb(.]|\(\?:|\|)|(?<=^|[^\w$]|\\b)from\\{1,2}s\*?\(?\[?\\?['"]/u;

/** ファイルの中の、指定子を取り出す正規表現の形（コメントは数えない）。`source-scan.ts` の外の Gate のファイルでは、空であること。 */
export const findSpecifierRegexShapes = (source: ScannedSource): readonly string[] => [
  ...source.bare.split('\n').filter((line) => SPECIFIER_REGEX_SHAPE.test(line)).map((line) => line.trim()),
  ...source.literals.filter((literal) => SPECIFIER_REGEX_SHAPE.test(literal)),
];

// ---------------------------------------------------------------------------------------------------------------
// import のたどり（CCX-9。台帳の CC-056）
// ---------------------------------------------------------------------------------------------------------------

/** 相対パスの書き出し（`./`・`../`）。 */
const RELATIVE_PATH_PREFIXES: readonly string[] = ['./', '../'];
/** それだけで相対のパスになる指定子（`.`・`..`）。 */
const RELATIVE_PATH_ONLY: readonly string[] = ['.', '..'];

/** 相対パスの書き出し（`./`・`../`）で始まる文字列か（指定子と、相対パスの文字列リテラルの判定。CCX-27。CC-074）。 */
export const isRelativePathText = (text: string): boolean => RELATIVE_PATH_PREFIXES.some((prefix) => text.startsWith(prefix));

/** 相対の指定子（`./`・`../` で始まるもの、`.`・`..`）を、`fromPath` の場所から、リポジトリの根からのパス（区切りは `/`）にする。相対でなければ `null`。 */
export const resolveRelativeSpecifier = (fromPath: string, specifier: string): string | null =>
  isRelativePathText(specifier) || RELATIVE_PATH_ONLY.includes(specifier)
    ? posix.normalize(posix.join(posix.dirname(fromPath), specifier))
    : null;

/** Playwright（`@axe-core/playwright` を含む）のパッケージの名前（指定子か、文字列リテラル。CCX-27）。 */
export const PLAYWRIGHT_PACKAGE_PATTERN = /^(?:playwright|playwright-core|@playwright\/[^/]+|@axe-core\/playwright)(?:\/|$)/u;

/**
 * ファイルが参照するモジュールの候補（CCX-27。CC-074）: 指定子のすべて（`findModuleSpecifiers`。型だけの import を含む）と、相対パスの
 * 文字列リテラル（指定子を実行時に組み立てる参照の補い）と、`extraLiteralPatterns` のどれかに当たる文字列リテラル。同じ文字列は 1 つに
 * まとめる（初めに現れた順。指定子が先、文字列リテラルは本文の順）。
 */
export const moduleReferenceCandidatesOf = (source: ScannedSource, extraLiteralPatterns: readonly RegExp[] = []): readonly string[] =>
  [...new Set([
    ...findModuleSpecifiers(source.code),
    ...source.literals.filter((literal) => isRelativePathText(literal) || extraLiteralPatterns.some((pattern) => pattern.test(literal))),
  ])];

/** 拡張子（`.js`・`.ts`・`.mjs`・`.cts` など）を除いたパス。 */
export const withoutModuleExtension = (path: string): string => path.replace(/\.[cm]?[jt]s$/u, '');

/** 相対の import の解決の候補（そのまま、拡張子を `.ts`・`.tsx` に読み替えたもの、フォルダの `index.ts`・`index.tsx`。この順）。 */
export const importTargetCandidates = (resolved: string): readonly string[] => {
  const base = resolved.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/u, '');
  return [resolved, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
};

/** `fromPath` の相対の指定子が指す、`files` の中のファイル。相対でないか、`files` に無ければ `undefined`。 */
export const resolveImportTarget = (files: ReadonlyMap<string, unknown>, fromPath: string, specifier: string): string | undefined => {
  const resolved = resolveRelativeSpecifier(fromPath, specifier);
  return resolved === null ? undefined : importTargetCandidates(resolved).find((candidate) => files.has(candidate));
};

/** たどりの 1 歩（`chain` の最後のファイルの、実行時の指定子の 1 つ）。 */
export interface ImportStep {
  /** 始まりから、今のファイルまでの道（始まりを含む）。 */
  readonly chain: readonly string[];
  readonly specifier: string;
  /** 相対の指定子を、リポジトリの根からのパスにしたもの（拡張子は書いたまま）。相対でなければ `null`。 */
  readonly resolved: string | null;
  /** `files` の中の、指定子が指すファイル（拡張子を補った先）。無ければ `undefined`。 */
  readonly target: string | undefined;
}

/**
 * `starts` のそれぞれから、実行時に読み込む指定子（`findRuntimeModuleSpecifiers`。型だけの import はたどらない）を幅優先でたどる。
 * - 指定子ごとに `check` を呼ぶ。文字列を返したら、`<始まり> -> … -> <返した値>` を違反として記録し、その先はたどらない。
 *   `undefined` なら、`files` の中の先（`target`）へ進む。
 * - たどる範囲は `files` の中だけ（パッケージと、`files` に無いファイルには進まない）。始まりごとに、1 度着いたファイルには戻らない（循環で止まる）。
 */
export const findImportChains = (
  files: ReadonlyMap<string, ScannedSource>,
  starts: readonly string[],
  check: (step: ImportStep) => string | undefined,
): readonly string[] => {
  const violations: string[] = [];
  for (const start of starts) {
    const chains = new Map<string, readonly string[]>([[start, [start]]]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift() ?? '';
      const chain = chains.get(current) ?? [current];
      const source = files.get(current);
      if (source === undefined) {
        continue;
      }
      for (const specifier of findRuntimeModuleSpecifiers(source.code)) {
        const resolved = resolveRelativeSpecifier(current, specifier);
        const target = resolved === null ? undefined : importTargetCandidates(resolved).find((candidate) => files.has(candidate));
        const violation = check({ chain, specifier, resolved, target });
        if (violation !== undefined) {
          violations.push([...chain, violation].join(' -> '));
          continue;
        }
        if (target !== undefined && !chains.has(target)) {
          chains.set(target, [...chain, target]);
          queue.push(target);
        }
      }
    }
  }
  return violations;
};

/**
 * `starts` から実行時の import をたどり（`findImportChains`）、禁じた層に届いた所（`<始まり> -> … -> <先>`。CCX-27。CC-082 の後半）。
 * - 相対でない指定子は、`isForbiddenPackage` が真なら、その指定子で違反にする。
 * - 相対の指定子は、`.js` などを `.ts` に読み替えたパスか、たどった先のファイル（`files` の中）で `isForbiddenPath` が真なら、そのパスで違反に
 *   する（読み替えたパスを先に見る）。
 */
export const findTransitiveForbiddenReferences = (
  files: ReadonlyMap<string, ScannedSource>,
  starts: readonly string[],
  isForbiddenPath: (path: string) => boolean,
  isForbiddenPackage: (specifier: string) => boolean,
): readonly string[] => findImportChains(files, starts, ({ specifier, resolved, target }) => {
  if (resolved === null) {
    return isForbiddenPackage(specifier) ? specifier : undefined;
  }
  const path = `${withoutModuleExtension(resolved)}.ts`;
  if (isForbiddenPath(path)) {
    return path;
  }
  return target !== undefined && isForbiddenPath(target) ? target : undefined;
});

/** `start` から、実行時の import をたどって着くファイル（`start` を除く。並びは名前の順）。たどり方は `findImportChains` と同じ。 */
export const reachableFiles = (files: ReadonlyMap<string, ScannedSource>, start: string): readonly string[] => {
  const reached = new Set<string>();
  findImportChains(files, [start], ({ target }) => {
    if (target !== undefined && target !== start) {
      reached.add(target);
    }
    return undefined;
  });
  return [...reached].sort();
};

/** `open` の位置の括弧に対応する、閉じ括弧の位置。見つからなければ `-1`。`bare`（文字列の中身を除いた本文）を渡す（CCX-27 で公開。CC-088）。 */
export const matchingParenthesis =(bare: string, open: number): number => {
  let depth = 0;
  for (let cursor = open; cursor < bare.length; cursor += 1) {
    const character = bare[cursor];
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
  }
  return -1;
};

/** 呼び出しの位置と、括弧の中の引数の本文。 */
export interface CallSite {
  readonly index: number;
  readonly argumentText: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * `name(…)` の形の呼び出しの一覧（`obj.name(…)`、`new name(…)`、型引数付きの `name<T>(…)` を含む）。`bare` を渡す。
 * 次の形は、定義として除く: `function name(…)`、クラスやオブジェクトのメソッドの定義（`name(…) {`、`name(…): T {`）。
 */
export const findCallSites = (bare: string, name: string): readonly CallSite[] => {
  const pattern = new RegExp(String.raw`(?<![\w$])${escapeRegExp(name)}\s*(?:<[^<>()]*>)?\s*\(`, 'gu');
  const sites: CallSite[] = [];
  for (const match of bare.matchAll(pattern)) {
    const before = bare.slice(Math.max(0, match.index - 40), match.index);
    if (/\bfunction\s*\*?\s*$/u.test(before)) {
      continue;
    }
    const open = match.index + match[0].length - 1;
    const close = matchingParenthesis(bare, open);
    if (close < 0) {
      continue;
    }
    if (/^\s*(?::[^;{}=]*)?\{/u.test(bare.slice(close + 1)) && !/(?:=>|[=(,:?]|\breturn)\s*$/u.test(before)) {
      continue;
    }
    sites.push({ index: match.index, argumentText: bare.slice(open + 1, close) });
  }
  return sites;
};

/** 引数の本文を、最上位のカンマで分ける（括弧・角括弧・波括弧の中のカンマでは分けない）。空の引数は数えない。 */
export const splitTopLevelArguments = (argumentText: string): readonly string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of argumentText) {
    if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      depth -= 1;
    }
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
};

/** `bare` の中の、識別子 `name` の出現（前後が識別子の文字でないもの）の数。 */
export const countIdentifier = (bare: string, name: string): number =>
  [...bare.matchAll(new RegExp(String.raw`(?<![\w$])${escapeRegExp(name)}(?![\w$])`, 'gu'))].length;

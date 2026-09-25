/**
 * Architecture Gate（GATE-ARCH01〜08）の、ソースの読み込みと走査の補助。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の走査だけで行う（AST・TypeScript のコンパイラ API・外部ツール・子プロセス・
 *   `dist/` を使わない。`references/ui-ux-ssot.md` 第6章）。
 * - `loadSourceFiles()` は、各テストのファイルの読み込み時に1回だけ呼び、結果を各検査で共有する（ファイルごとに1回だけ読む）。
 * - `scanSource()` は、1文字ずつの走査で、コメントと文字列リテラルを分ける。構文の解析はしない（近似）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** import の指定子（`from '…'`、`import '…'`、`import('…')`。`export … from '…'` を含む）の一覧。`code`（コメントを除いた本文）を渡す。 */
const IMPORT_SPECIFIER_PATTERN = /\bfrom\s*(['"])([^'"\r\n]+)\1|\bimport\s*(['"])([^'"\r\n]+)\3|\bimport\s*\(\s*(['"])([^'"\r\n]+)\5\s*\)/gu;
export const findImportSpecifiers = (code: string): readonly string[] =>
  [...code.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => match[2] ?? match[4] ?? match[6] ?? '');

/** `open` の位置の括弧に対応する、閉じ括弧の位置。見つからなければ `-1`。`bare`（文字列の中身を除いた本文）を渡す。 */
const matchingParenthesis = (bare: string, open: number): number => {
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

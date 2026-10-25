/**
 * 秘密に見える名前の方針の Architecture Gate（CCX-4。共通化の台帳の N3。`CC-plan.md` の「設計者の判断」の 3）。
 * - 秘密に見える名前の 3 つの方針（伏せ字の完全一致、認証の設定の部分一致の拒否、header の部分一致）の語の一覧と比べ方は、
 *   `src/core/secret-query-names.ts`（`SECRET_NAME_POLICY_OWNER`）の 1 か所に、名前を付けて並べる（意味はまとめない）。
 * - (a) 秘密に見える語（`token`・`password`・`secret`・`csrf` など。`SECRET_LIKE_VOCABULARY`）を 2 つ以上含む、文字列リテラルの並び
 *   （カンマで区切った 2 つ以上の文字列リテラル。配列のリテラルの要素の並び）を、owner の外の `src/**` に書かない。正当な使い方は、
 *   `EXCLUSIONS` に理由を付けて置く（除外の一覧は、このファイルの中の 1 か所だけ）。
 * - (b) owner は import を持たない（純粋な定義と関数だけ）。そのため、`src/control/`（`control-boundary.test.ts` の (b)）、
 *   `src/discovery/`（`discovery-boundary.test.ts`）、`src/safety/` のどこからも、たどった先に禁止の対象が現れずに import できる。
 * - (c) 元の場所（`auth-setup-policy.ts`、`redact.ts`）は、owner から import する。
 * - (d) PRE42-CC 組 Z（LG-4F の発見）: 認証の設定の契約（`auth-setup-contracts.ts`）は、owner の名前を公開し直さない（呼び出し側は owner から
 *   読む）。`export { … } from '…/core/secret-query-names.js'`・`export * from …`・import した名前の `export { … }` を数える。まだ公開し直す
 *   ファイル（`redact.ts`）は、理由を付けて `SECRET_NAME_REEXPORT_EXCEPTIONS` に置く（使われない除外は落とす）。
 * - `src/**` の読み込みは、このファイルの読み込み時に 1 回だけ行う。判定は、`fs`、正規表現、文字列の走査だけで行う（AST・TypeScript の
 *   コンパイラ API・外部ツール・子プロセス・`dist/` を使わない）。近似の検査である（テンプレートのリテラルは数えない）。
 */
import { describe, expect, it } from 'vitest';
import {
  exportedNamesOf,
  findImportSpecifiers,
  findModuleReferences,
  findModuleSpecifiers,
  judgeWithFileExceptions,
  loadSourceFiles,
  scanSource,
  sourceFileAt,
  unusedExclusionsOf,
  type FileExceptions,
  type ScannedSource,
  type SourceFile,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** 秘密に見える名前の方針の owner。 */
const SECRET_NAME_POLICY_OWNER = 'src/core/secret-query-names.ts';

/** owner から import する、元の場所（判定を使うか、今の名前のまま公開し直す）。 */
const SECRET_NAME_POLICY_USERS: readonly string[] = [
  'src/control/auth/auth-setup-policy.ts',
  'src/safety/redact.ts',
];

/** (d) owner の名前を公開し直してよいファイル（パス → 理由。件数も確かめる）。寄せたら消す。 */
const SECRET_NAME_REEXPORT_EXCEPTIONS: FileExceptions = Object.freeze({
  'src/safety/redact.ts': {
    count: 1,
    reason: '伏せ字の完全一致の一覧と比べ方（`SECRET_URL_QUERY_PARAMETER_NAMES`・`isSecretUrlQueryParameterName`）を、伏せ字の部品の名前で'
      + '公開し直す（`authenticated-run.ts` と単体のテストが読む。組 Z の範囲の外。寄せるときに消す）',
  },
});

/** owner が公開する名前（`export const`・`export function`）。 */
const ownerExportNamesOf = (owner: ScannedSource): readonly string[] =>
  [...owner.bare.matchAll(/\bexport\s+(?:const|function)\s+([\w$]+)/gu)].map((match) => match[1] ?? '');

/** owner の指定子の終わり。 */
const OWNER_SPECIFIER_SUFFIX = '/core/secret-query-names.js';

/**
 * (d) owner の名前の公開し直し（`<見つけた形>`）。指定子の取り出しは `source-scan.ts` の共通の補助（CCX-9）。
 * - owner からの `export … from`（`export { … } from`・`export * from`）: `export <節> from '<指定子>'`。
 * - それ以外の公開（`from` のない `export { … }`、`export const`）の名前が owner の名前: `export <名前>`。
 */
const findSecretNameReexports = (source: ScannedSource, ownerNames: readonly string[]): readonly string[] => {
  const fromOwner = findModuleReferences(source.code)
    .filter((reference) => reference.form === 'static' && reference.statement?.keyword === 'export' && reference.specifier.endsWith(OWNER_SPECIFIER_SUFFIX));
  // `exportedNamesOf` は `from` のある公開の名前も数えるので、owner からの `export … from` の名前を、書いた数だけ引く。
  const viaFrom = fromOwner.flatMap((reference) => reference.namedBindings.map((binding) => binding.split(/\s+as\s+/u).at(-1)?.trim() ?? ''));
  const others = exportedNamesOf(source.code).filter((name) => {
    const index = viaFrom.indexOf(name);
    if (index >= 0) {
      viaFrom.splice(index, 1);
      return false;
    }
    return ownerNames.includes(name);
  });
  return [
    ...fromOwner.map((reference) => `export ${reference.statement?.clause ?? ''} from '${reference.specifier}'`.replace(/\s+/gu, ' ')),
    ...others.map((name) => `export ${name}`),
  ];
};

/** 一つの並びに、秘密に見える語がこの数以上あれば、秘密に見える名前の一覧とみなす。 */
const MIN_SECRET_LIKE_ELEMENTS = 2;

/** 秘密に見える語（比べる形: 小文字にし、区切りの `-`・`_`・`.`・空白を除いた形の完全一致）。 */
const SECRET_LIKE_VOCABULARY: ReadonlySet<string> = new Set([
  'token', 'password', 'passwd', 'pwd', 'secret', 'csrf', 'xsrf', 'session', 'sessionid', 'sid', 'apikey', 'auth',
  'authorization', 'authkey', 'credential', 'credentials', 'cookie', 'setcookie', 'jwt',
]);

/** 秘密に見える語の終わり（比べる形が、これで終われば、秘密に見える語とみなす。`access_token`、`client_secret`、`x-api-key` など）。 */
const SECRET_LIKE_SUFFIXES: readonly string[] = ['token', 'secret', 'password', 'passwd', 'sessionid', 'apikey'];

/** 比べる形にするときに除く区切り。 */
const NAME_SEPARATORS = /[-_.\s]/gu;

/** 一重か二重の引用符の、1 行の文字列リテラル（中身を捕まえる）。 */
const STRING_LITERAL = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/gu;

/** 並びの中の、隣り合う 2 つの文字列リテラルの間（カンマと空白だけ。`code` はコメントを空白に置き換えてある）。 */
const ELEMENT_SEPARATOR = /^\s*,\s*$/u;

const isSecretLikeElement = (value: string): boolean => {
  const comparable = value.toLowerCase().replace(NAME_SEPARATORS, '');
  return SECRET_LIKE_VOCABULARY.has(comparable) || SECRET_LIKE_SUFFIXES.some((suffix) => comparable.endsWith(suffix));
};

/** `code` の中の、カンマで区切った 2 つ以上の文字列リテラルの並び（それぞれ、要素の中身の一覧）。 */
const literalRunsOf = (code: string): readonly (readonly string[])[] => {
  const runs: string[][] = [];
  let current: string[] = [];
  let previousEnd = 0;
  for (const match of code.matchAll(STRING_LITERAL)) {
    const value = match[2] ?? '';
    if (current.length > 0 && ELEMENT_SEPARATOR.test(code.slice(previousEnd, match.index))) {
      current.push(value);
    } else {
      if (current.length > 1) {
        runs.push(current);
      }
      current = [value];
    }
    previousEnd = match.index + match[0].length;
  }
  if (current.length > 1) {
    runs.push(current);
  }
  return runs;
};

/** 秘密に見える名前の一覧に見える並び（`'<最初の要素>', …` の形で返す）。 */
const findSecretLikeNameLists = (source: ScannedSource): readonly string[] =>
  literalRunsOf(source.code)
    .filter((run) => run.filter(isSecretLikeElement).length >= MIN_SECRET_LIKE_ELEMENTS)
    .map((run) => `'${run[0] ?? ''}', …`);

/**
 * 除外（`<ファイル>: <検出した並び>` → 理由）。owner の外の、秘密に見える名前の方針ではない正当な並びだけを置く。
 */
const EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    "src/evidence/network-collector.ts: 'accept', …",
    'Network の Evidence に残す要求の header の名前の一覧（集める header の選び方。秘密の判定ではない。値の伏せ字は redactHeaders）',
  ],
  [
    "src/evidence/network-collector.ts: 'cache-control', …",
    'Network の Evidence に残す応答の header の名前の一覧（集める header の選び方。秘密の判定ではない。値の伏せ字は redactHeaders）',
  ],
]);

const detects = (line: string): readonly string[] => findSecretLikeNameLists(scanSource(line));

const sourceFile = (path: string): SourceFile => sourceFileAt(SOURCE_FILES, path);

describe('secret-like name policies detector (CCX-4)', () => {
  it('detects arrays of two or more secret-like names', () => {
    expect(detects("const WORDS = Object.freeze(['password', 'token'] as const);")).toEqual(["'password', …"]);
    expect(detects("const SET = new Set([\n  'csrf',\n  // the session\n  'X-Session-Id',\n  'q',\n]);")).toEqual(["'csrf', …"]);
    expect(detects('const NAMES = ["access_token", "client_secret"];')).toEqual(["'access_token', …"]);
    expect(detects("const A = ['a', 'secret'], B = ['x-api-key', 'Set-Cookie'];")).toHaveLength(1);
  });

  it('ignores a single secret-like name, names that only contain a secret-like word, and comments', () => {
    expect(detects("const A = ['token', 'q', 'page'];")).toEqual([]);
    expect(detects("const CODES = ['CREDENTIAL_MISSING', 'AUTH_SETUP_INVALID', 'passwordType'];")).toEqual([]);
    expect(detects("// ['token', 'password']\nconst A = 1;")).toEqual([]);
    expect(detects("const A = 'token';\nconst B = 'password';")).toEqual([]);
  });

  it('(d) detects re-exports of the owner names, and ignores other exports and comments (PRE42-CC group Z)', () => {
    const ownerNames = ['SECRET_LIKE_QUERY_NAME_WORDS', 'isSecretLikeQueryName'];
    const source = scanSource([
      "export { SECRET_LIKE_QUERY_NAME_WORDS } from '../../core/secret-query-names.js';",
      "export {\n  isSecretLikeQueryName as isSecret,\n} from '../core/secret-query-names.js';",
      "export * from '../core/secret-query-names.js';",
      'export { SECRET_LIKE_QUERY_NAME_WORDS, OTHER };',
      // 当たらない: ほかの owner からの公開し直し、owner の名前を含まない export、import、コメント。
      "export { MAX_URL_LENGTH } from '../../core/limits.js';",
      'export { OTHER };',
      "import { SECRET_LIKE_QUERY_NAME_WORDS } from '../../core/secret-query-names.js';",
      "// export { SECRET_LIKE_QUERY_NAME_WORDS } from '../../core/secret-query-names.js';",
    ].join('\n'));
    expect(findSecretNameReexports(source, ownerNames)).toEqual([
      "export { SECRET_LIKE_QUERY_NAME_WORDS } from '../../core/secret-query-names.js'",
      "export { isSecretLikeQueryName as isSecret, } from '../core/secret-query-names.js'",
      "export * from '../core/secret-query-names.js'",
      'export SECRET_LIKE_QUERY_NAME_WORDS',
    ]);
  });
});

describe('secret-like name policies Gate (CCX-4)', () => {
  it(`(a) only ${SECRET_NAME_POLICY_OWNER} writes lists of secret-like names in src/**`, () => {
    const detections = SOURCE_FILES
      .filter((file) => file.path !== SECRET_NAME_POLICY_OWNER)
      .flatMap((file) => findSecretLikeNameLists(file).map((match) => `${file.path}: ${match}`));
    expect(unusedExclusionsOf(EXCLUSIONS.keys(), detections), '除外が古くなっている').toEqual([]);
    expect(detections.filter((detection) => !EXCLUSIONS.has(detection))).toEqual([]);
    expect(findSecretLikeNameLists(sourceFile(SECRET_NAME_POLICY_OWNER)).length).toBeGreaterThan(0);
  });

  it('(b) the owner has no imports, so src/control/, src/discovery/ and src/safety/ can all import it', () => {
    // CCX-27（CC-074）: import の文だけでなく、`require`・`createRequire`・`new URL(…, import.meta.url)` なども数える（強くなる側）。
    expect(findModuleSpecifiers(sourceFile(SECRET_NAME_POLICY_OWNER).code)).toEqual([]);
  });

  it('(c) the original places import the policies from the owner', () => {
    for (const path of SECRET_NAME_POLICY_USERS) {
      const specifiers = findImportSpecifiers(sourceFile(path).code);
      expect(specifiers.some((specifier) => specifier.endsWith('/core/secret-query-names.js')), path).toBe(true);
    }
  });

  it('(d) no file re-exports the owner names, besides the closed exceptions; callers read the owner (PRE42-CC group Z, LG-4F)', () => {
    const ownerNames = ownerExportNamesOf(sourceFile(SECRET_NAME_POLICY_OWNER));
    expect(ownerNames).toContain('SECRET_LIKE_QUERY_NAME_WORDS');
    const { found, countMismatches, unusedExceptions } = judgeWithFileExceptions(
      SOURCE_FILES.filter((file) => file.path !== SECRET_NAME_POLICY_OWNER),
      (file) => findSecretNameReexports(file, ownerNames),
      SECRET_NAME_REEXPORT_EXCEPTIONS,
    );
    expect(found).toEqual([]);
    expect(countMismatches).toEqual([]);
    expect(unusedExceptions, '除外が古くなっている').toEqual([]);
  });
});

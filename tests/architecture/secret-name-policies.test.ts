/**
 * 秘密に見える名前の方針の Architecture Gate（CCX-4。共通化の台帳の N3。`CC-plan.md` の「設計者の判断」の 3）。
 * - 秘密に見える名前の 3 つの方針（伏せ字の完全一致、認証の設定の部分一致の拒否、header の部分一致）の語の一覧と比べ方は、
 *   `src/core/secret-query-names.ts`（`SECRET_NAME_POLICY_OWNER`）の 1 か所に、名前を付けて並べる（意味はまとめない）。
 * - (a) 秘密に見える語（`token`・`password`・`secret`・`csrf` など。`SECRET_LIKE_VOCABULARY`）を 2 つ以上含む、文字列リテラルの並び
 *   （カンマで区切った 2 つ以上の文字列リテラル。配列のリテラルの要素の並び）を、owner の外の `src/**` に書かない。正当な使い方は、
 *   `EXCLUSIONS` に理由を付けて置く（除外の一覧は、このファイルの中の 1 か所だけ）。
 * - (b) owner は import を持たない（純粋な定義と関数だけ）。そのため、`src/control/`（`control-boundary.test.ts` の (b)）、
 *   `src/discovery/`（`discovery-boundary.test.ts`）、`src/safety/` のどこからも、たどった先に禁止の対象が現れずに import できる。
 * - (c) 元の場所（`auth-setup-contracts.ts`、`auth-setup-policy.ts`、`redact.ts`）は、owner から import する。
 * - `src/**` の読み込みは、このファイルの読み込み時に 1 回だけ行う。判定は、`fs`、正規表現、文字列の走査だけで行う（AST・TypeScript の
 *   コンパイラ API・外部ツール・子プロセス・`dist/` を使わない）。近似の検査である（テンプレートのリテラルは数えない）。
 */
import { describe, expect, it } from 'vitest';
import { findImportSpecifiers, findModuleSpecifiers, loadSourceFiles, scanSource, type ScannedSource, type SourceFile } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** 秘密に見える名前の方針の owner。 */
const SECRET_NAME_POLICY_OWNER = 'src/core/secret-query-names.ts';

/** owner から import する、元の場所（今の名前のまま公開し直すか、判定を使う）。 */
const SECRET_NAME_POLICY_USERS: readonly string[] = [
  'src/control/auth/auth-setup-contracts.ts',
  'src/control/auth/auth-setup-policy.ts',
  'src/safety/redact.ts',
];

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

const sourceFile = (path: string): SourceFile => {
  const file = SOURCE_FILES.find((candidate) => candidate.path === path);
  expect(file, path).toBeDefined();
  return file ?? { path, content: '', ...scanSource('') };
};

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
});

describe('secret-like name policies Gate (CCX-4)', () => {
  it(`(a) only ${SECRET_NAME_POLICY_OWNER} writes lists of secret-like names in src/**`, () => {
    const detections = SOURCE_FILES
      .filter((file) => file.path !== SECRET_NAME_POLICY_OWNER)
      .flatMap((file) => findSecretLikeNameLists(file).map((match) => `${file.path}: ${match}`));
    for (const key of EXCLUSIONS.keys()) {
      expect(detections, `除外が古くなっている: ${key}`).toContain(key);
    }
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
});

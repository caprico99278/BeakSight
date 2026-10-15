/**
 * 管理データの部品の境界の Architecture Gate（Task 23 の設計書 4.3 の「書き込みの決まり」、4.5、4.6 の「Git の管理の外であることの保証」。T23a）。
 * - (c) `node:sqlite` をモジュールとして参照する（import、`import type`、`process.getBuiltinModule('node:sqlite')`、動的 import、
 *   `require`、`import.meta.resolve`、モジュールの識別子の定数）のは `src/control/store/` の中だけ。利用者向けの文言の中の言及は
 *   数えない（T23c round 2）。その中でも、実行時に読み込むのは `sqlite-module.ts` の `getBuiltinModule` だけで、
 *   静的な import（型だけの import を除く）と動的 import はしない（環境の確かめの前に読み込みで落ちないため。設計書 4.5）。
 * - (d) `src/` の中で、SQL の `BEGIN` を文字列に書くのは、`src/control/store/transaction.ts` の 2 つの入口の中だけ（T24e round 2 で改めた）:
 *   書き込みの唯一の入口 `withWriteTransaction` には `BEGIN IMMEDIATE` がちょうど 1 つ（書き込みは IMMEDIATE だけ）、読むだけの入口
 *   `withReadTransaction`（`PRAGMA query_only` つき）には deferred の `BEGIN` がちょうど 1 つ。`transaction.ts` のほかの部分と、`src/` の
 *   ほかのファイルには 0 個。
 * - (e) `.gitignore` に `/local-data/` がある（管理データは Git の管理の外）。
 * - (f) 生の接続（`ControlDatabase` の `connection`）を、`src/control/store/` の外（`src/` の残りと `apps/local-ui/`）で参照しない（T23c）。
 * - (g) SQL の書き込みの文（`INSERT`、`UPDATE`、`DELETE`、`REPLACE`、`CREATE`、`DROP`、`ALTER`）を書くのは、`src/control/store/` の
 *   移行のファイル（`migrations.ts`）と書き込みの関数のファイル（`profile-store.ts`。`withWriteTransaction` の中で使う）だけ（T23c）。
 *   T24e: 監査のジョブの管理（`src/control/job/` のファイル）も対象に足した（書いてよく、どの書き込みも `withWriteTransaction` の中だけ）。
 *   T25a round 1: 認証の設定の保存の部品（`auth-setup-store.ts`）も対象に足した（書いてよく、どの書き込みも `withWriteTransaction` の中だけ）。
 *   T28c: シナリオと承認の記録の保存の部品（`src/control/approval/scenario-store.ts`）も対象に足した（書いてよく、どの書き込みも
 *   `withWriteTransaction` の中だけ）。
 *   T29d: 入力の規則の保存の部品（`src/control/data-rules/rule-store.ts`。版 7 の表）も対象に足した（書いてよく、どの書き込みも
 *   `withWriteTransaction` の中だけ）。
 * - (k)（T28c。Task 28 の設計書 4.2、実装計画の Gate）: 承認と撤回の記録（`approval_receipts`）と、シナリオの版の写し（`scenario_revisions`）は追記だけ。
 *   `src/` と画面のコードの、どのファイルにも、この 2 つの表への `UPDATE`・`DELETE`・`REPLACE`・`INSERT OR REPLACE`・`DROP TABLE`・`ALTER TABLE`
 *   の文を書かない（移行のファイルを含む。表を作り直すときは、新しい版の設計を先に決める）。T29d: 入力の規則の集まりの版の写し
 *   （`rule_set_revisions`）も追記だけの表に足した。
 * - (l)（T28d。Task 28 の設計書 4.4、T28d の Blocker の判断（案 A））: 管理データの版 6 の表（`scenarios`、`scenario_revisions`、`approval_receipts`、
 *   `execution_grants`、`write_reservations`）に書く文（`INSERT`・`UPDATE`・`DELETE`・`REPLACE`）を書くのは、`src/control/approval/scenario-store.ts`
 *   だけ（表を作る移行の `migrations.ts` を除く）。許可と予約の決まり（`execution-grant.ts`）と今の事実の読み出し（`scenario-facts.ts`）は書かない。
 *   T29d: 管理データの版 7 の表（`rule_sets`、`rule_set_revisions`）に書く文を書くのは、`src/control/data-rules/rule-store.ts` だけ（移行を除く）。
 *   規則の読み出し（`rule-set-facts.ts`）と、シナリオと承認の保存の部品（`scenario-store.ts`）は書かない（版 6 と版 7 の書き手を分ける）。
 *   T30d: 管理データの版 8 の書き込みの結果の表（`write_results`）に書く文を書くのは、`src/control/approval/scenario-store.ts` だけ（予約の締めと
 *   同じトランザクションで書くため。移行を除く）。行の読み出し（`src/control/actions/write-result-facts.ts`）は書かない。
 * - (m)（T30d。Task 30 の設計書 3 章の「記録」）: 書き込みの結果の表は、追記と締めだけ。`UPDATE write_results` は、締めの列（送信の状態から締めの
 *   時刻まで。`WRITE_RESULT_SETTLEMENT_COLUMNS`）だけを書き、`settled_at IS NULL`（締めていない行）を条件に持つ。`DELETE`・`REPLACE`・
 *   `INSERT OR REPLACE`・upsert・`DROP TABLE`・`ALTER TABLE` を書かない（移行のファイルを含む。表を作り直すときは、新しい版の設計を先に決める）。
 *   T31e（Task 31 の設計書 3 章の「記録」。管理データの版 9 で表を作り直した）: 移行のファイル（`src/control/store/migrations.ts`）の中の、版の
 *   作り直しの組だけを受ける。組は、`INSERT INTO write_results_v<N> (…) SELECT … FROM write_results`（今の行をすべて移す）と、
 *   `ALTER TABLE write_results_v<N> RENAME TO write_results` の 2 つの文が同じファイルにあること。そのときだけ、文の全体がちょうど
 *   `DROP TABLE write_results` のリテラルを、組の数まで受ける（行を消す `DELETE`、締めでない `UPDATE`、組のない `DROP`、条件つきの `DROP`、
 *   ほかのファイルの `DROP` は、今までどおり検出する）。
 * - (n)（T30e。T30d の発見事項 2 の判断）: 書き込みの結果を記録せずに予約を返す口（`settleWriteReservation`。`RELEASED` だけ）を参照するのは、
 *   `src/control/approval/scenario-store.ts` だけ。結果の記録を伴って予約を締める口と送る前の記録（`recordWriteAttempt`・`settleWriteResult`・
 *   `closeOrphanedWriteResults`・`closeWriteWithoutSending`）を参照するのは、保存の部品と、書き込みのジョブの管理（`audit-job-manager.ts`）だけ
 *   （画面のコードと、ほかの部品の再公開を含めて、ほかのファイルは参照しない）。
 *   T30g fix round 1: (n) の対象は、製品のコード（`src/` と `apps/local-ui/src/`）。画面のテスト（`apps/local-ui/tests/`）は、(o) の対象にした。
 * - (o)（T30g fix round 1）: テストのコード（`tests/` と `apps/local-ui/tests/`）で、予約を締める口と送る前の記録（(n) の 5 つ）を参照するのは、
 *   テストの補助（`tests/integration/execution-grant-fixtures.ts`、`tests/helpers/write-result-fixtures.ts`）と、閉じた一覧の例外（理由つき。保存の部品と
 *   ジョブの管理そのものを確かめるテスト）だけ。画面のテストは、補助を通す（例外はない）。
 * - 判定は、`fs`、正規表現、文字列の走査だけで行う（AST・子 process を使わない。`control-boundary.test.ts` と同じ方式）。近似の検査である
 *   （指定子を実行時に組み立てる参照は検出できない）。
 * - T23c round 3（独立レビュー T23R の M1）で (f)(g) を強めた。限界（近似で捕まえられないもの）:
 *   - (f) 生の接続の参照: `.connection`、`['connection']`、分解（変数・引数・関数の宣言・メソッド・`for … of` の、どの位置でも）、
 *     文字列での参照（`Reflect.*`・`Object.*` の引数、`'connection' in …`、`connection` の文字列を入れた変数）を数える。
 *     `Object.values(database)`・展開（`{ ...database }`）・実行時に組み立てた鍵（`'conn' + 'ection'`）は検出できない。
 *     値が識別子のオブジェクトのリテラル（`{ connection: socket }`）や、型の `connection: T` は、分解と同じ形なので違反として数える。
 *   - (g) SQL の書き込みの文: 大文字と小文字を区別せず、文の形（`INSERT INTO <表> (…`、`UPDATE <表> SET <列> =` など）で数える。
 *     実行時に組み立てた SQL（キーワードを変数に入れるなど）は検出できない。
 *   - (g) トランザクションの外の書き込み: `migrations.ts` と `profile-store.ts` を、最上位の宣言（`const`・`function` など）の単位で見る。
 *     書き込みの文を持つ宣言の名前を、`withWriteTransaction(…)` の引数の外で参照する宣言は「外で書けるもの」とし、それが公開（`export`）
 *     されていれば違反とする（名前でたどる近似。同じ宣言の中の別の関数や、名前を使わない受け渡しは区別できない）。公開は、
 *     宣言の `export`、`export { a, b as c }` の一覧、`export default`（名前のある関数とクラス、識別子、名前のない式。名前のない式は
 *     `default` という名前で報告する）を数える（T23c round 4）。`export { … } from '…'` の再公開と、`export * from` は、ほかの
 *     モジュールの名前なので数えない。
 *     版の一覧（`CONTROL_MIGRATIONS`）は、データとして公開してよい代わりに、その中身（`.statements`・`.seed`）を
 *     `withWriteTransaction(…)` の引数の外で使わないことを確かめる。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_ROOT,
  findCallSites,
  findModuleReferences,
  loadSourceFiles,
  readTypeScriptFilesUnder,
  scanFile,
  scanSource,
  type ScannedSource,
  type SourceFile,
  type UnscannedFile,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();
const GITIGNORE_LINES = readFileSync(join(REPOSITORY_ROOT, '.gitignore'), 'utf8').split(/\r?\n/u).map((line) => line.trim());

const STORE_DIRECTORY = 'src/control/store/';
const SQLITE_LOADER_FILE = 'src/control/store/sqlite-module.ts';
const TRANSACTION_FILE = 'src/control/store/transaction.ts';
/** `withWriteTransaction` の定義の始まり（この行から、行の頭の `};` までを、関数の本文とみなす）。 */
const TRANSACTION_FUNCTION_START = 'export const withWriteTransaction';
/** `withReadTransaction` の定義の始まり（T24e round 2。本文の範囲の決め方は `withWriteTransaction` と同じ）。 */
const READ_TRANSACTION_FUNCTION_START = 'export const withReadTransaction';
const TOP_LEVEL_END = /^\};?\s*$/mu;
const LOCAL_DATA_IGNORE_LINE = '/local-data/';

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/** 文字列リテラルの中の `node:sqlite`。 */
const NODE_SQLITE_PATTERN = /(?<![\w-])node:sqlite(?![\w-])/u;

/** モジュールの識別子そのもの。 */
const NODE_SQLITE_MODULE_ID = 'node:sqlite';

/**
 * (c): `node:sqlite` をモジュールとして指す文字列リテラル（T23c round 2 で絞った）。中身がちょうど `node:sqlite` のリテラルだけを数える。
 * モジュールを指す形は、どれもこの形のリテラルを使う: import・export の `from` の指定子、`import type`、副作用の import、
 * 動的 import と `import('…')` の型、`require`・`require.resolve`・`createRequire(…)(…)` の引数、`getBuiltinModule` の引数、
 * `import.meta.resolve` の引数。モジュールの識別子の定数（`const ID = 'node:sqlite'`。引数に定数を渡す形の元）も数える。
 * 文の中の言及（利用者向けの文言の `…（node:sqlite）を使えません。` など）は、モジュールの参照ではないので数えない。
 */
const findSqliteReferences = (source: ScannedSource): readonly string[] =>
  source.literals.filter((literal) => literal === NODE_SQLITE_MODULE_ID);

/**
 * (c): 実行時に `node:sqlite` を読み込む参照（静的な import、`export … from`、副作用の import、動的 import、`require`、`createRequire`）。
 * 型だけの import と、`getBuiltinModule`（(c) が許す、ただ 1 つの読み込みの道。下で呼び出しの数を数える）を除く。CCX-9（台帳の CC-054）:
 * `source-scan.ts` の `findModuleReferences` で取る（指定子を取り出す正規表現は、このファイルに書かない）。
 */
const findRuntimeSqliteImports = (source: ScannedSource): readonly string[] =>
  // DEF-107: 指定子は `code` の一部なので、`code` に `node:sqlite` がなければ当たる参照はない（取り出しの重い処理を省く。結果は同じ）。
  (source.code.includes(NODE_SQLITE_MODULE_ID) ? findModuleReferences(source.code) : [])
    .filter((reference) => !reference.typeOnly && reference.form !== 'builtin-module' && NODE_SQLITE_PATTERN.test(reference.specifier))
    .map((reference) => reference.specifier);

/** (c): `getBuiltinModule(…)` の呼び出しの数（引数を問わない。引数が定数でも見落とさないため、呼び出しそのものを数える）。 */
const GET_BUILTIN_MODULE_PATTERN = /\bgetBuiltinModule\s*\(/gu;
const findGetBuiltinModuleCalls = (source: ScannedSource): number => [...source.code.matchAll(GET_BUILTIN_MODULE_PATTERN)].length;

/**
 * (d): SQL の `BEGIN` の文（`BEGIN`、`BEGIN IMMEDIATE`、`BEGIN DEFERRED TRANSACTION` など。文の頭か `;` の後）を含む文字列リテラル。
 * 大文字と小文字を区別しない。英語の文（`begin the …`）は数えない。
 */
const SQL_BEGIN_PATTERN = /(?:^|;)\s*BEGIN(?:\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*(?:;|$)/iu;
const findBeginStatements = (source: ScannedSource): readonly string[] =>
  source.literals.filter((literal) => SQL_BEGIN_PATTERN.test(literal));

/** (d): `BEGIN` の文の種類（種類を書かない `BEGIN` は SQLite の既定の deferred）。 */
type BeginMode = 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE';
const DEFAULT_BEGIN_MODE: BeginMode = 'DEFERRED';

/** (d): 文字列リテラルの `BEGIN` の文の種類の一覧（T24e round 2）。 */
const beginModesOf = (source: ScannedSource): readonly BeginMode[] =>
  findBeginStatements(source).map((literal) => (SQL_BEGIN_PATTERN.exec(literal)?.[1]?.toUpperCase() ?? DEFAULT_BEGIN_MODE) as BeginMode);

/** (d): `marker` で始まる定義の、本文の範囲（`[始まり, 終わり)`）。定義がなければ `null`。 */
const definitionRangeOf = (content: string, marker: string): readonly [number, number] | null => {
  const start = content.indexOf(marker);
  if (start < 0) {
    return null;
  }
  const endMatch = TOP_LEVEL_END.exec(content.slice(start));
  if (endMatch === null) {
    return null;
  }
  return [start, start + endMatch.index + endMatch[0].length];
};

/** (d): `withWriteTransaction` の定義の本文と、それ以外の本文に分ける。定義がなければ `null`。 */
const splitTransactionFunction = (content: string): { readonly inside: string; readonly outside: string } | null => {
  const range = definitionRangeOf(content, TRANSACTION_FUNCTION_START);
  if (range === null) {
    return null;
  }
  const [start, end] = range;
  return { inside: content.slice(start, end), outside: `${content.slice(0, start)}\n${content.slice(end)}` };
};

/**
 * (d): `transaction.ts` の `BEGIN` の置き場所の違反（T24e round 2）。`withWriteTransaction` には `IMMEDIATE` がちょうど 1 つ、
 * `withReadTransaction` には deferred がちょうど 1 つ、2 つの本文の外には 0 個。違反の説明の一覧を返す（違反がなければ空）。
 */
const findTransactionBeginViolations = (content: string): readonly string[] => {
  const writeRange = definitionRangeOf(content, TRANSACTION_FUNCTION_START);
  const readRange = definitionRangeOf(content, READ_TRANSACTION_FUNCTION_START);
  if (writeRange === null || readRange === null) {
    return [writeRange === null ? 'withWriteTransaction is not defined' : 'withReadTransaction is not defined'];
  }
  const violations: string[] = [];
  const checkBody = (name: string, range: readonly [number, number], expected: BeginMode): void => {
    const modes = beginModesOf(scanSource(content.slice(range[0], range[1])));
    if (modes.length !== 1 || modes[0] !== expected) {
      violations.push(`${name} must have exactly one BEGIN ${expected}, found [${modes.join(', ')}]`);
    }
  };
  checkBody('withWriteTransaction', writeRange, 'IMMEDIATE');
  checkBody('withReadTransaction', readRange, DEFAULT_BEGIN_MODE);
  const outside = [...content].map((character, index) => {
    const inBody = [writeRange, readRange].some(([start, end]) => index >= start && index < end);
    return inBody && character !== '\n' ? ' ' : character;
  }).join('');
  const outsideModes = beginModesOf(scanSource(outside));
  if (outsideModes.length > 0) {
    violations.push(`BEGIN outside the two transaction functions: [${outsideModes.join(', ')}]`);
  }
  return violations;
};

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト（違反の例と、違反でない例）
// ---------------------------------------------------------------------------------------------------------------

describe('Control store boundary detectors', () => {
  it('(c) detects every form of reference to node:sqlite', () => {
    for (const line of [
      "import { DatabaseSync } from 'node:sqlite';",
      "import type { DatabaseSync } from 'node:sqlite';",
      "import type * as NodeSqlite from 'node:sqlite';",
      "export { DatabaseSync } from 'node:sqlite';",
      "const sqlite = process.getBuiltinModule('node:sqlite');",
      'const sqlite = await import("node:sqlite");',
      "type Connection = import('node:sqlite').DatabaseSync;",
      'const sqlite = require(`node:sqlite`);',
      // T23c round 2: モジュールを指すほかの形と、モジュールの識別子の定数。
      "export * from 'node:sqlite';",
      "export type { DatabaseSync } from 'node:sqlite';",
      "import 'node:sqlite';",
      "const sqlite = require.resolve('node:sqlite');",
      "const sqlite = createRequire(import.meta.url)('node:sqlite');",
      "const url = import.meta.resolve('node:sqlite');",
      "const NODE_SQLITE_MODULE_ID = 'node:sqlite';",
    ]) {
      expect(findSqliteReferences(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "// import { DatabaseSync } from 'node:sqlite';",
      "/* process.getBuiltinModule('node:sqlite') */",
      "const file = 'beaksight-control.sqlite';",
      "import { readFileSync } from 'node:fs';",
      "const name = 'node:sqlite3-extra';",
      // T23c round 2: 利用者向けの文言の中の言及は、モジュールの参照ではない（`src/presentation/messages.ts` の文言の形）。
      "const text = 'この Node.js では、組み込みの SQLite（node:sqlite）を使えません。';",
      "const text = 'node:sqlite is not available in this Node.js';",
      'const text = `Node.js ${version} では node:sqlite を使えません。`;',
    ]) {
      expect(findSqliteReferences(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(c) tells runtime imports of node:sqlite from type-only imports', () => {
    for (const line of [
      "import { DatabaseSync } from 'node:sqlite';",
      "import { type DatabaseSync } from 'node:sqlite';",
      "import 'node:sqlite';",
      "export * from 'node:sqlite';",
      "const sqlite = await import('node:sqlite');",
      // CCX-9: 共通の取り出し（`findModuleReferences`）で、`require` と `createRequire(…)(…)` の読み込みも数える。
      "const sqlite = require('node:sqlite');",
      "const sqlite = createRequire(import.meta.url)('node:sqlite');",
    ]) {
      expect(findRuntimeSqliteImports(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import type { DatabaseSync } from 'node:sqlite';",
      "import type * as NodeSqlite from 'node:sqlite';",
      "export type { DatabaseSync } from 'node:sqlite';",
      "const sqlite = process.getBuiltinModule('node:sqlite');",
    ]) {
      expect(findRuntimeSqliteImports(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(d) detects SQL BEGIN statements in string literals, and ignores comments and English text', () => {
    for (const line of [
      "connection.exec('BEGIN');",
      "connection.exec('BEGIN IMMEDIATE');",
      'connection.exec("begin deferred transaction");',
      'connection.exec(`BEGIN EXCLUSIVE;`);',
      "connection.exec('PRAGMA foreign_keys = ON; BEGIN');",
      "const sql = 'BEGIN TRANSACTION; INSERT INTO t VALUES (1)';",
    ]) {
      expect(findBeginStatements(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "// connection.exec('BEGIN');",
      "const detail = 'begin the migration';",
      "connection.exec('COMMIT');",
      "const name = 'BEGINNER';",
      "const label = 'beginning';",
    ]) {
      expect(findBeginStatements(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(d) splits the withWriteTransaction definition from the rest of the file', () => {
    const content = [
      "const before = 'BEGIN';",
      'export const withWriteTransaction = () => {',
      "  connection.exec('BEGIN IMMEDIATE');",
      '};',
      "const after = 'BEGIN';",
    ].join('\n');
    const parts = splitTransactionFunction(content);
    expect(parts).not.toBeNull();
    expect(findBeginStatements(scanSource(parts?.inside ?? ''))).toEqual(['BEGIN IMMEDIATE']);
    expect(findBeginStatements(scanSource(parts?.outside ?? ''))).toEqual(['BEGIN', 'BEGIN']);
    expect(splitTransactionFunction("const x = 'BEGIN';")).toBeNull();
  });

  // T24e round 2: 書き込みは IMMEDIATE だけ、deferred の BEGIN は読むだけの入口だけ。
  it('(d) tells the kind of BEGIN, and checks where each kind is written in transaction.ts', () => {
    expect(beginModesOf(scanSource("x('BEGIN'); y('BEGIN IMMEDIATE'); z('begin deferred transaction'); w('BEGIN EXCLUSIVE');")))
      .toEqual(['DEFERRED', 'IMMEDIATE', 'DEFERRED', 'EXCLUSIVE']);
    const fileOf = (write: string, read: string, extra = ''): string => [
      extra,
      'export const withWriteTransaction = () => {',
      `  connection.exec('${write}');`,
      '};',
      'export const withReadTransaction = () => {',
      `  connection.exec('${read}');`,
      "  connection.exec('PRAGMA query_only = ON');",
      '};',
    ].join('\n');
    // 違反でない例。
    expect(findTransactionBeginViolations(fileOf('BEGIN IMMEDIATE', 'BEGIN'))).toEqual([]);
    expect(findTransactionBeginViolations(fileOf('BEGIN IMMEDIATE', 'BEGIN DEFERRED'))).toEqual([]);
    // 違反の例。
    for (const content of [
      fileOf('BEGIN', 'BEGIN'),
      fileOf('BEGIN EXCLUSIVE', 'BEGIN'),
      fileOf('BEGIN IMMEDIATE', 'BEGIN IMMEDIATE'),
      fileOf('BEGIN IMMEDIATE', 'COMMIT'),
      fileOf('COMMIT', 'BEGIN'),
      fileOf('BEGIN IMMEDIATE', 'BEGIN', "const leak = 'BEGIN';"),
      fileOf('BEGIN IMMEDIATE', 'BEGIN', "const leak = 'BEGIN IMMEDIATE';"),
      fileOf('BEGIN IMMEDIATE', 'BEGIN').replace("connection.exec('PRAGMA query_only = ON');", "connection.exec('BEGIN');"),
      fileOf('BEGIN IMMEDIATE', 'BEGIN').replace('export const withReadTransaction', 'export const withAnyTransaction'),
      fileOf('BEGIN IMMEDIATE', 'BEGIN').replace('export const withWriteTransaction', 'export const withOtherTransaction'),
    ]) {
      expect(findTransactionBeginViolations(content), content).not.toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

describe('Control store boundary (Task 23 design 4.3, 4.5, 4.6)', () => {
  it('reads the source files once, and src/control/store/ exists', () => {
    expect(SOURCE_FILES.some((file) => file.path === SQLITE_LOADER_FILE)).toBe(true);
    expect(SOURCE_FILES.some((file) => file.path === TRANSACTION_FILE)).toBe(true);
  });

  it('(c) only src/control/store/ refers to node:sqlite', () => {
    const violations = SOURCE_FILES
      .filter((file) => !file.path.startsWith(STORE_DIRECTORY))
      .flatMap((file) => findSqliteReferences(file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(c) src/ never imports node:sqlite at run time, and only sqlite-module.ts calls getBuiltinModule', () => {
    const loader = SOURCE_FILES.find((file) => file.path === SQLITE_LOADER_FILE);
    expect(loader === undefined ? 0 : findGetBuiltinModuleCalls(loader)).toBeGreaterThan(0);
    expect(SOURCE_FILES.flatMap((file) => findRuntimeSqliteImports(file).map((text) => `${file.path}: ${text}`))).toEqual([]);
    expect(SOURCE_FILES
      .filter((file) => file.path !== SQLITE_LOADER_FILE && findGetBuiltinModuleCalls(file) > 0)
      .map((file) => file.path)).toEqual([]);
  });

  it('(d) SQL BEGIN is written only as BEGIN IMMEDIATE in withWriteTransaction and a deferred BEGIN in withReadTransaction', () => {
    const transaction = SOURCE_FILES.find((file) => file.path === TRANSACTION_FILE);
    expect(transaction).toBeDefined();
    expect(findTransactionBeginViolations(transaction?.content ?? '')).toEqual([]);
    const violations = SOURCE_FILES
      .filter((file) => file.path !== TRANSACTION_FILE)
      .flatMap((file) => findBeginStatements(file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(e) .gitignore keeps local-data/ out of Git', () => {
    expect(GITIGNORE_LINES).toContain(LOCAL_DATA_IGNORE_LINE);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T23c: 生の接続と、SQL の書き込みの文の置き場所
// ---------------------------------------------------------------------------------------------------------------

/** 画面のコードの置き場所（T23e が作る。なければ空）。生成物と依存は読まない。 */
const UI_DIRECTORY = 'apps/local-ui';
const UI_SKIPPED_SEGMENTS: readonly string[] = ['node_modules', 'dist'];
const UI_SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts)$/u;

/** `apps/local-ui/` の TypeScript のファイルを、1 回だけ読み込んで走査する。 */
const loadUiSourceFiles = (): readonly SourceFile[] => {
  const root = join(REPOSITORY_ROOT, UI_DIRECTORY);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((relativePath) => relativePath.replaceAll('\\', '/'))
    .filter((relativePath) => UI_SOURCE_EXTENSION.test(relativePath))
    .filter((relativePath) => !relativePath.split('/').some((segment) => UI_SKIPPED_SEGMENTS.includes(segment)))
    .sort()
    .map((relativePath) => {
      const content = readFileSync(join(root, relativePath), 'utf8');
      return { path: `${UI_DIRECTORY}/${relativePath}`, content, ...scanSource(content) };
    });
};
const UI_SOURCE_FILES = loadUiSourceFiles();

const MIGRATIONS_FILE = 'src/control/store/migrations.ts';
const PROFILE_STORE_FILE = 'src/control/store/profile-store.ts';
/** T25a round 1: 認証の設定の保存の部品（版 3 の `auth_setups`。書き込みは `withWriteTransaction` の中だけ）。 */
const AUTH_SETUP_STORE_FILE = 'src/control/store/auth-setup-store.ts';
/** T28c: シナリオと承認の記録の保存の部品（版 6 の表。書き込みは `withWriteTransaction` の中だけ）。 */
const SCENARIO_STORE_FILE = 'src/control/approval/scenario-store.ts';
/** T29d: 入力の規則の保存の部品（版 7 の表。書き込みは `withWriteTransaction` の中だけ）。 */
const RULE_STORE_FILE = 'src/control/data-rules/rule-store.ts';
const SQL_WRITE_FILES: readonly string[] = [MIGRATIONS_FILE, PROFILE_STORE_FILE, AUTH_SETUP_STORE_FILE, SCENARIO_STORE_FILE, RULE_STORE_FILE];
/** T24e: 監査のジョブの管理のフォルダ（どのファイルも、書き込みは `withWriteTransaction` の中だけ）と、行の読み書きのファイル。 */
const JOB_DIRECTORY = 'src/control/job/';
const JOB_STORE_FILE = 'src/control/job/job-store.ts';
const JOB_FILES: readonly string[] = SOURCE_FILES.filter((file) => file.path.startsWith(JOB_DIRECTORY)).map((file) => file.path);
/** SQL の書き込みの文を書いてよいファイル（`SQL_WRITE_FILES` と、`src/control/job/` のファイル）。 */
const SQL_WRITER_PATHS: readonly string[] = [...SQL_WRITE_FILES, ...JOB_FILES];

/** 版の一覧（データとして公開してよい名前。中身の `.statements`・`.seed` は、トランザクションの中でだけ使う）。 */
const MIGRATION_LIST_NAMES: readonly string[] = ['CONTROL_MIGRATIONS'];

/**
 * (f): 生の接続の参照（近似。限界はファイルの冒頭）。`bare`（文字列の中身を除いた本文）から:
 * - `.connection` のプロパティの参照。
 * - 分解の `connection`（`{ connection }`、`{ connection: raw }`、`{ connection = x }`、`{ a, connection }`。変数・引数・関数の宣言・
 *   メソッド・`for … of` のどの位置でも、波括弧の中の鍵の形で見る）。値が文字列のオブジェクトのリテラル（`{ connection: 'close' }`）は数えない。
 */
const RAW_CONNECTION_BARE_PATTERNS: readonly RegExp[] = [
  /\.\s*connection(?![\w$])/gu,
  /\{(?:[^{}]*?,)?\s*connection\s*(?:[,}=]|:\s*[A-Za-z_$[{])/gu,
];
/**
 * (f): 文字列での参照（`code` から）: `['connection']`、`Reflect.*`・`Object.*` の引数の `'connection'`、`'connection' in …`、
 * `'connection'` を入れた変数（鍵の定数）。HTTP の header の名前（`['connection', …]`、`setHeader('connection', …)`）や、
 * `net.Server` の event の名前（`on('connection', …)`）は数えない。
 */
const RAW_CONNECTION_CODE_PATTERNS: readonly RegExp[] = [
  /\[\s*(['"`])connection\1\s*\]/gu,
  /\b(?:Reflect|Object)\s*\.\s*[\w$]+\s*\([^()]*?(['"`])connection\1/gu,
  /(['"`])connection\1\s+in\b/gu,
  /\b(?:const|let|var)\s+[\w$]+\s*(?::[^=;]+)?=\s*(['"`])connection\1/gu,
];

/** (f) どの形も含む名前（大文字と小文字を区別する）。 */
const RAW_CONNECTION_NAME = 'connection';
const findRawConnectionReferences = (source: ScannedSource): readonly string[] =>
  // DEF-107: どの形も `connection` を含み、`bare` の文字は `code` の同じ位置の文字なので、`code` に `connection` がなければ当たらない
  // （波括弧の形の正規表現は重いので、要らないファイルでは照らさない。結果は同じ）。
  !source.code.includes(RAW_CONNECTION_NAME) ? [] : [
    ...RAW_CONNECTION_BARE_PATTERNS.flatMap((pattern) => [...source.bare.matchAll(pattern)].map((match) => match[0])),
    ...RAW_CONNECTION_CODE_PATTERNS.flatMap((pattern) => [...source.code.matchAll(pattern)].map((match) => match[0])),
  ];

/** SQL の表や列の名前（識別子、二重引用符の名前、テンプレートの式の `${}`。`schema.` の前置きを含む）。 */
const SQL_NAME = String.raw`(?:[\w$]+|"[^"]+"|\$\{\})(?:\s*\.\s*(?:[\w$]+|"[^"]+"))?`;
/**
 * (g): SQL の書き込みの文（大文字と小文字を区別しない。文の形で見るので、英語の文の `delete from the list` などは数えない）。
 * `INSERT [OR …] INTO <表> (…|VALUES|SELECT|DEFAULT`、`REPLACE INTO <表> …`、`UPDATE [OR …] <表> SET <列> =`、
 * `DELETE FROM <表> [WHERE|RETURNING|;|終わり]`、`CREATE [TEMP|UNIQUE|…] TABLE|INDEX|VIEW|TRIGGER [IF NOT EXISTS] <名前> (…|ON|AS|…`、
 * `DROP TABLE|INDEX|VIEW|TRIGGER [IF EXISTS] <名前> [;|終わり]`、`ALTER TABLE <表> ADD|RENAME|DROP`。
 */
const SQL_WRITE_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+${SQL_NAME}\s*(?:\(|\b(?:VALUES|SELECT|DEFAULT)\b)`, 'iu'),
  new RegExp(String.raw`\bUPDATE(?:\s+OR\s+\w+)?\s+${SQL_NAME}\s+SET\s+${SQL_NAME}\s*=`, 'iu'),
  new RegExp(String.raw`\bDELETE\s+FROM\s+${SQL_NAME}\s*(?:\b(?:WHERE|RETURNING)\b|;|$)`, 'iu'),
  new RegExp(
    String.raw`\bCREATE(?:\s+(?:TEMP|TEMPORARY|UNIQUE|VIRTUAL))?\s+(?:TABLE|INDEX|VIEW|TRIGGER)(?:\s+IF\s+NOT\s+EXISTS)?\s+${SQL_NAME}`
      + String.raw`\s*(?:\(|\b(?:ON|AS|USING|BEFORE|AFTER|INSTEAD)\b)`,
    'iu',
  ),
  new RegExp(String.raw`\bDROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)(?:\s+IF\s+EXISTS)?\s+${SQL_NAME}\s*(?:;|$)`, 'iu'),
  new RegExp(String.raw`\bALTER\s+TABLE\s+${SQL_NAME}\s+(?:ADD|RENAME|DROP)\b`, 'iu'),
];

/** 書いたままの形のリテラル（`wholeLiterals`）から、引用符を除いた中身（テンプレートの式は `${}` のまま）。 */
const literalBodyOf = (whole: string): string => {
  const quote = whole[0] ?? '';
  return whole.length > 1 && whole.endsWith(quote) ? whole.slice(1, -1) : whole.slice(1);
};

const isSqlWriteStatement = (text: string): boolean => SQL_WRITE_PATTERNS.some((pattern) => pattern.test(text));

/** (g): SQL の書き込みの文を含む文字列リテラル（テンプレートは、式を `${}` にした 1 つのリテラルとして見る）。 */
const findSqlWriteStatements = (source: ScannedSource): readonly string[] =>
  source.wholeLiterals.map(literalBodyOf).filter(isSqlWriteStatement);

/** 最上位の宣言の始まり（行の頭から。`export` と `async` などの前置きを含む）。 */
const TOP_LEVEL_DECLARATION =
  /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu;
/**
 * 最上位の `export { … }` の一覧（T23c round 4）。`from` の付いた再公開は、ほかのモジュールの名前なので数えない（`lastIndex` を
 * 使って、一覧の後ろが `from` かを確かめる）。`export type { … }` は値を公開しないので数えない。
 */
const TOP_LEVEL_EXPORT_LIST = /^export\s*\{([^{}]*)\}/gmu;
const EXPORT_LIST_FROM = /^\s*from\b/u;
/** 最上位の `export default <識別子>;`（T23c round 4）。 */
const TOP_LEVEL_EXPORT_DEFAULT_NAME = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?[ \t]*$/gmu;
/**
 * 最上位の名前のない `export default`（式、名前のない関数とクラス。T23c round 4）。名前のある関数とクラスは `TOP_LEVEL_DECLARATION` が、
 * 識別子だけのものは `TOP_LEVEL_EXPORT_DEFAULT_NAME` が受ける。宣言の名前は `default` とする。
 */
const TOP_LEVEL_EXPORT_DEFAULT_EXPRESSION =
  /^export\s+default\b(?!\s+(?:async\s+)?(?:function\s*\*?|class)\s+[A-Za-z_$])(?!\s+[A-Za-z_$][\w$]*\s*;?[ \t]*$)/gmu;
/** 名前のない `export default` の宣言の名前。 */
const DEFAULT_EXPORT_NAME = 'default';
/** 宣言でない区切り（`export { … }` と `export default <識別子>;`）の名前。参照の判定と違反の一覧から除く。 */
const NOT_A_DECLARATION = '';

/** 版の一覧の中身の参照（`.statements`、`.seed`）。 */
const MIGRATION_LIST_CONTENT_PATTERN = /\.\s*(?:statements|seed)(?![\w$])/u;

/** 最上位の宣言 1 つ（`withWriteTransaction(…)` の引数の中と外に分けた本文）。 */
interface TopLevelDeclaration {
  readonly name: string;
  readonly exported: boolean;
  readonly inside: ScannedSource;
  readonly outside: ScannedSource;
}

/** `text` の `[start, end)` の範囲だけを残し、ほかを空白にする（改行は残す）。 */
const keepRanges = (text: string, ranges: readonly (readonly [number, number])[], keep: boolean): string => {
  // DEF-107: 1 文字ずつ配列を作って関数を呼ぶ形をやめ、1 回の走査で組み立てる。位置は、前と同じく文字（コードポイント）の順の番号で比べる
  // （結果は同じ）。
  let result = '';
  let index = 0;
  for (const character of text) {
    let inRange = false;
    for (const [start, end] of ranges) {
      if (index >= start && index < end) {
        inRange = true;
        break;
      }
    }
    result += inRange === keep || character === '\n' ? character : ' ';
    index += 1;
  }
  return result;
};

/** 最上位の宣言と区切りの始まり（位置の順に並べる）。 */
interface DeclarationHead {
  readonly index: number;
  readonly name: string;
  readonly exported: boolean;
}

/** `code` の最上位の宣言と区切りの始まり（`export { … }` と `export default` を含む。T23c round 4）。 */
const declarationHeadsOf = (code: string): readonly DeclarationHead[] => [
  ...[...code.matchAll(TOP_LEVEL_DECLARATION)].map((head) => ({
    index: head.index,
    name: head[2] ?? NOT_A_DECLARATION,
    exported: head[1] !== undefined,
  })),
  ...[...code.matchAll(TOP_LEVEL_EXPORT_LIST)].map((head) => ({ index: head.index, name: NOT_A_DECLARATION, exported: false })),
  ...[...code.matchAll(TOP_LEVEL_EXPORT_DEFAULT_NAME)].map((head) => ({ index: head.index, name: NOT_A_DECLARATION, exported: false })),
  ...[...code.matchAll(TOP_LEVEL_EXPORT_DEFAULT_EXPRESSION)].map((head) => ({ index: head.index, name: DEFAULT_EXPORT_NAME, exported: true })),
].sort((left, right) => left.index - right.index);

/**
 * 一覧（`export { a, b as c, d as default }`）と `export default <識別子>;` で公開された、このファイルの名前（T23c round 4）。
 * `from` の付いた再公開と `export type { … }` は数えない。
 */
const exportedNamesOf = (code: string): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const match of code.matchAll(TOP_LEVEL_EXPORT_LIST)) {
    if (EXPORT_LIST_FROM.test(code.slice(match.index + match[0].length))) {
      continue;
    }
    for (const item of (match[1] ?? '').split(',')) {
      const local = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)/u.exec(item);
      if (local !== null && !/^\s*type\s/u.test(item)) {
        names.add(local[1] ?? NOT_A_DECLARATION);
      }
    }
  }
  for (const match of code.matchAll(TOP_LEVEL_EXPORT_DEFAULT_NAME)) {
    names.add(match[1] ?? NOT_A_DECLARATION);
  }
  return names;
};

/** ファイルを、最上位の宣言ごとに分け、`withWriteTransaction(…)` の引数の中と外に分ける（`code` の上で行う）。 */
const topLevelDeclarationsOf = (content: string): readonly TopLevelDeclaration[] => {
  const { code } = scanSource(content);
  const heads = declarationHeadsOf(code);
  const exportedNames = exportedNamesOf(code);
  return heads.flatMap((head, index) => {
    if (head.name === NOT_A_DECLARATION) {
      return [];
    }
    const chunk = code.slice(head.index, heads[index + 1]?.index ?? code.length);
    const ranges = findCallSites(chunk, 'withWriteTransaction').map((site): readonly [number, number] => {
      const open = chunk.indexOf('(', site.index);
      return [open + 1, open + 1 + site.argumentText.length];
    });
    return [{
      name: head.name,
      exported: head.exported || exportedNames.has(head.name),
      inside: scanSource(keepRanges(chunk, ranges, true)),
      outside: scanSource(keepRanges(chunk, ranges, false)),
    }];
  });
};

/** `bare` の中で、識別子 `name` を参照しているか（プロパティの `.name` は除く）。 */
const referencesName = (bare: string, name: string): boolean =>
  // DEF-107: `bare` に名前の文字列がなければ、参照はない（正規表現を作って照らすのを省く。結果は同じ）。
  bare.includes(name) && new RegExp(String.raw`(?<![\w$.])${name.replace(/[$]/gu, '\\$')}(?![\w$])`, 'u').test(bare);

/**
 * (g): `withWriteTransaction(…)` の外で書き込みが行われうる、公開の名前（近似。限界はファイルの冒頭）。
 * 1. `withWriteTransaction(…)` の引数の外に書き込みの文を持つ宣言を「外で書けるもの」とする。
 * 2. 「外で書けるもの」の名前を、引数の外で参照する宣言も「外で書けるもの」とする（くり返す）。版の一覧の名前は、一覧そのものを
 *    データとして扱い、たどらない。
 * 3. 「外で書けるもの」のうち公開（`export`）されたもの（版の一覧を除く）と、版の一覧の中身（`.statements`・`.seed`）を引数の外で
 *    使う宣言を、違反として返す（名前の順）。
 */
const findWritesOutsideTransactions = (content: string, migrationListNames: readonly string[]): readonly string[] => {
  const declarations = topLevelDeclarationsOf(content);
  const isMigrationList = (name: string): boolean => migrationListNames.includes(name);
  const unsafe = new Set<string>();
  const queue: string[] = [];
  for (const declaration of declarations) {
    if (!isMigrationList(declaration.name) && declaration.outside.wholeLiterals.map(literalBodyOf).some(isSqlWriteStatement)) {
      unsafe.add(declaration.name);
      queue.push(declaration.name);
    }
  }
  while (queue.length > 0) {
    const name = queue.shift() ?? '';
    for (const declaration of declarations) {
      if (declaration.name === name || unsafe.has(declaration.name) || isMigrationList(declaration.name)) {
        continue;
      }
      if (referencesName(declaration.outside.bare, name)) {
        unsafe.add(declaration.name);
        queue.push(declaration.name);
      }
    }
  }
  const violations = new Set<string>(declarations
    .filter((declaration) => declaration.exported && unsafe.has(declaration.name) && !isMigrationList(declaration.name))
    .map((declaration) => declaration.name));
  if (migrationListNames.length > 0) {
    for (const declaration of declarations) {
      if (MIGRATION_LIST_CONTENT_PATTERN.test(declaration.outside.bare)) {
        violations.add(declaration.name);
      }
    }
  }
  return [...violations].sort();
};

describe('Control store boundary detectors (T23c)', () => {
  it('(f) detects references to the raw connection, and ignores HTTP header names and object literals', () => {
    for (const line of [
      "database.connection.prepare('SELECT 1');",
      'const sqlite = handle . connection;',
      "const sqlite = database['connection'];",
      'const { connection } = database;',
      'const { path, connection: raw } = database;',
      'const read = ({ connection }) => connection;',
      'const read = ({ connection }: ControlDatabase) => connection;',
    ]) {
      expect(findRawConnectionReferences(scanSource(line)), line).not.toHaveLength(0);
    }
    for (const line of [
      "const HOP_BY_HOP = ['connection', 'keep-alive'];",
      "server.on('connection', (socket) => track(socket));",
      "response.writeHead(status, { connection: 'close' });",
      '// database.connection.prepare(sql);',
      'const connectionCount = 1;',
      "const label = 'database.connection';",
    ]) {
      expect(findRawConnectionReferences(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(g) detects SQL write statements in string literals', () => {
    for (const line of [
      "connection.prepare('INSERT INTO profiles (profile_id) VALUES (?)');",
      "connection.prepare('INSERT OR REPLACE INTO store_meta VALUES (?, ?)');",
      "connection.prepare('REPLACE INTO store_meta VALUES (?, ?)');",
      "connection.prepare('UPDATE profiles SET status = ?');",
      "connection.prepare('DELETE FROM profiles');",
      'connection.exec(`CREATE TABLE t (x INTEGER) STRICT`);',
      "connection.exec('CREATE UNIQUE INDEX i ON t (x)');",
      "connection.exec('DROP TABLE t');",
      "connection.exec('ALTER TABLE t ADD COLUMN y TEXT');",
      "connection.exec('SELECT 1; DELETE FROM t');",
      'const sql = `\n  INSERT INTO t (x)\n  VALUES (${value})`;',
    ]) {
      expect(findSqlWriteStatements(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "connection.prepare('SELECT * FROM profiles');",
      "const methods = 'GET, POST, OPTIONS, DELETE';",
      "const detail = 'could not create the data directory';",
      "const detail = 'delete from the list';",
      "// connection.exec('DROP TABLE t');",
      "connection.exec('PRAGMA journal_mode = WAL');",
    ]) {
      expect(findSqlWriteStatements(scanSource(line)), line).toHaveLength(0);
    }
  });
});

describe('Control store boundary (T23c)', () => {
  it('(f) the raw connection is used only inside src/control/store/ (src/ and apps/local-ui/)', () => {
    const store = SOURCE_FILES.filter((file) => file.path.startsWith(STORE_DIRECTORY));
    // 検出の関数が、実際のファイルの参照を見つけられていることの確かめ（store の中にはある）。
    expect(store.flatMap((file) => findRawConnectionReferences(file)).length).toBeGreaterThan(0);
    const violations = [...SOURCE_FILES.filter((file) => !file.path.startsWith(STORE_DIRECTORY)), ...UI_SOURCE_FILES]
      .flatMap((file) => findRawConnectionReferences(file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(g) SQL write statements are written only in migrations.ts and profile-store.ts, and profile-store.ts writes through withWriteTransaction', () => {
    for (const path of SQL_WRITE_FILES) {
      const file = SOURCE_FILES.find((candidate) => candidate.path === path);
      expect(file, path).toBeDefined();
      expect(findSqlWriteStatements(file ?? scanSource('')).length, path).toBeGreaterThan(0);
    }
    const profileStore = SOURCE_FILES.find((file) => file.path === PROFILE_STORE_FILE);
    expect(findCallSites(profileStore?.bare ?? '', 'withWriteTransaction').length).toBeGreaterThan(0);
    // T24e: ジョブの行の読み書きのファイルも、書き込みの文を持ち、`withWriteTransaction` を通す。
    const jobStore = SOURCE_FILES.find((file) => file.path === JOB_STORE_FILE);
    expect(findSqlWriteStatements(jobStore ?? scanSource('')).length, JOB_STORE_FILE).toBeGreaterThan(0);
    expect(findCallSites(jobStore?.bare ?? '', 'withWriteTransaction').length).toBeGreaterThan(0);
    // T25a round 1: 認証の設定の保存の部品も、書き込みの文を持ち、`withWriteTransaction` を通す。
    const authSetupStore = SOURCE_FILES.find((file) => file.path === AUTH_SETUP_STORE_FILE);
    expect(findCallSites(authSetupStore?.bare ?? '', 'withWriteTransaction').length).toBeGreaterThan(0);
    // T28c: シナリオと承認の記録の保存の部品も、書き込みの文を持ち、`withWriteTransaction` を通す。
    const scenarioStore = SOURCE_FILES.find((file) => file.path === SCENARIO_STORE_FILE);
    expect(findCallSites(scenarioStore?.bare ?? '', 'withWriteTransaction').length).toBeGreaterThan(0);
    // T29d: 入力の規則の保存の部品も、書き込みの文を持ち、`withWriteTransaction` を通す。
    const ruleStore = SOURCE_FILES.find((file) => file.path === RULE_STORE_FILE);
    expect(findCallSites(ruleStore?.bare ?? '', 'withWriteTransaction').length).toBeGreaterThan(0);
    const violations = [...SOURCE_FILES.filter((file) => !SQL_WRITER_PATHS.includes(file.path)), ...UI_SOURCE_FILES]
      .flatMap((file) => findSqlWriteStatements(file).map((text) => `${file.path}: ${text.trim()}`));
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T23c round 3（独立レビュー T23R の M1）: (f)(g) の抜け道の検出
// ---------------------------------------------------------------------------------------------------------------

describe('Control store boundary detectors (T23c round 3)', () => {
  it('(g) detects SQL write statements in any letter case', () => {
    for (const line of [
      "connection.prepare('insert into profiles (profile_id) values (?)');",
      "connection.prepare('Insert Or Replace Into store_meta values (?, ?)');",
      "connection.prepare('replace into store_meta values (?, ?)');",
      "connection.prepare('Update profiles set status = ?');",
      "connection.prepare('delete from profiles where profile_id = ?');",
      "connection.prepare('delete from profiles');",
      "connection.exec('create table t (x integer) strict');",
      "connection.exec('Create Unique Index if not exists i on t (x)');",
      "connection.exec('drop table if exists t');",
      "connection.exec('alter table t add column y text');",
      'connection.exec(`insert into ${table} (x) values (?)`);',
      "connection.exec('select 1; delete from t');",
    ]) {
      expect(findSqlWriteStatements(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "const detail = 'delete from the list';",
      "const detail = 'Please insert into the form below';",
      "const detail = 'update the profile settings';",
      "const detail = 'create a table of contents';",
      "const detail = 'Drop the table name from the report';",
      "const detail = 'could not create the data directory';",
      "const methods = 'GET, POST, OPTIONS, DELETE';",
      "connection.prepare('select * from profiles where status = ?');",
    ]) {
      expect(findSqlWriteStatements(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(f) detects destructuring of connection in every parameter and binding position', () => {
    for (const line of [
      'function read({ connection }: ControlDatabase) { return connection; }',
      'function read(path: string, { connection }: ControlDatabase) { return connection; }',
      'export function read({ path, connection: raw }) { return raw; }',
      'const read = async function ({ connection }) { return connection; };',
      'class Reader { read({ connection }: ControlDatabase) { return connection; } }',
      'const { connection = fallback } = database;',
      'for (const { connection } of databases) { use(connection); }',
      'const [{ connection }] = databases;',
    ]) {
      expect(findRawConnectionReferences(scanSource(line)), line).not.toHaveLength(0);
    }
    for (const line of [
      "response.writeHead(status, { connection: 'close' });",
      "const headers = { connection: 'keep-alive', 'content-length': '0' };",
      'const connectionCount = 1;',
    ]) {
      expect(findRawConnectionReferences(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(f) detects references to connection by a string', () => {
    for (const line of [
      "const sqlite = Reflect.get(database, 'connection');",
      'const descriptor = Object.getOwnPropertyDescriptor(database, "connection");',
      "if ('connection' in database) { use(database); }",
      "const key = 'connection';",
      "const KEY: keyof ControlDatabase = 'connection';",
      'const sqlite = database[`connection`];',
    ]) {
      expect(findRawConnectionReferences(scanSource(line)), line).not.toHaveLength(0);
    }
    for (const line of [
      "const HOP_BY_HOP = ['connection', 'keep-alive'];",
      "server.on('connection', (socket) => track(socket));",
      "response.setHeader('connection', 'close');",
      "const label = 'database.connection';",
    ]) {
      expect(findRawConnectionReferences(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(g) finds writes that can run outside withWriteTransaction (top-level names, approximate)', () => {
    const violationsOf = (content: string, migrationListNames: readonly string[] = []): readonly string[] =>
      findWritesOutsideTransactions(content, migrationListNames);

    // 違反: 書き込みを、トランザクションの外で行う公開の関数。
    expect(violationsOf([
      'export const remove = (database) => {',
      "  database.connection.prepare('DELETE FROM profiles').run();",
      '};',
    ].join('\n'))).toEqual(['remove']);
    // 違反: トランザクションの中の書き込みの後に、外で書く。
    expect(violationsOf([
      'export const both = (database) => {',
      "  withWriteTransaction(database, (connection) => connection.exec('DELETE FROM a'));",
      "  database.connection.exec('DELETE FROM b');",
      '};',
    ].join('\n'))).toEqual(['both']);
    // 違反: 書き込みの内部の関数を、トランザクションの外から呼ぶ。
    expect(violationsOf([
      "const INSERT_SQL = 'INSERT INTO t (x) VALUES (?)';",
      'const insertRow = (connection, value) => connection.prepare(INSERT_SQL).run(value);',
      'export const add = (database, value) => insertRow(database.connection, value);',
    ].join('\n'))).toEqual(['add']);
    // 違反: 書き込みの文の定数や、書き込みの内部の関数を公開する（ほかのファイルから、トランザクションの外で使える）。
    expect(violationsOf("export const DELETE_SQL = 'DELETE FROM t';")).toEqual(['DELETE_SQL']);
    expect(violationsOf([
      "export const clear = (connection) => connection.exec('DELETE FROM t');",
    ].join('\n'))).toEqual(['clear']);
    // 違反でない: 書き込みの文の定数と内部の関数を、トランザクションに渡す関数の中からだけ使う。
    expect(violationsOf([
      "const INSERT_SQL = 'INSERT INTO t (x) VALUES (?)';",
      "const UPDATE_SQL =\n  'UPDATE t SET x = ? WHERE id = ?';",
      'const insertRow = (connection, value) => connection.prepare(INSERT_SQL).run(value);',
      'const replaceRow = (connection, value) => {',
      '  connection.prepare(UPDATE_SQL).run(value, 1);',
      '  insertRow(connection, value);',
      '};',
      'export const add = (database, value) => withWriteTransaction(database, (connection) => insertRow(connection, value));',
      'export const change = (database, value) => withWriteTransaction(database, (connection) => {',
      '  replaceRow(connection, value);',
      '  return 1;',
      '});',
    ].join('\n'))).toEqual([]);
    // 違反でない: 書き込みの文を、トランザクションに渡す関数の中に直接書く。
    expect(violationsOf([
      'export const add = (database) => withWriteTransaction(database, (connection) => {',
      "  connection.exec('INSERT INTO t (x) VALUES (1)');",
      '});',
    ].join('\n'))).toEqual([]);
    // 版の一覧（データ）: 書き込みの文は一覧を通して、トランザクションの中でだけ使う（`.statements`・`.seed`）。
    const migrations = [
      "const V1 = Object.freeze(['CREATE TABLE t (x INTEGER) STRICT']);",
      "const seedV1 = (connection) => connection.prepare('INSERT INTO t (x) VALUES (1)').run();",
      'export const MIGRATIONS = Object.freeze([{ version: 1, statements: V1, seed: seedV1 }]);',
      'export const run = (connection, migrations = MIGRATIONS) => {',
      '  for (const migration of migrations) {',
      '    withWriteTransaction({ connection }, (writer) => {',
      '      for (const statement of migration.statements) {',
      '        writer.exec(statement);',
      '      }',
      '      migration.seed?.(writer);',
      '    });',
      '  }',
      '};',
    ];
    expect(violationsOf(migrations.join('\n'), ['MIGRATIONS'])).toEqual([]);
    // 違反: 版の一覧の書き込みを、トランザクションの外で使う。
    expect(violationsOf([...migrations, 'export const leak = (connection) => connection.exec(MIGRATIONS[0].statements[0]);'].join('\n'), ['MIGRATIONS']))
      .toEqual(['leak']);
    // T23c round 4（再レビュー T23R2 の N2）: `export { … }` の一覧と `export default` での公開も、公開の名前として数える。
    const remove = "const remove = (connection) => connection.exec('DELETE FROM t');";
    const add = "const add = (database) => withWriteTransaction(database, (connection) => connection.exec('INSERT INTO t (x) VALUES (1)'));";
    expect(violationsOf([remove, 'export { remove };'].join('\n'))).toEqual(['remove']);
    expect(violationsOf([remove, 'export { remove as clear };'].join('\n'))).toEqual(['remove']);
    expect(violationsOf([remove, 'export { add, remove as default };', add].join('\n'))).toEqual(['remove']);
    expect(violationsOf([remove, 'export default remove;'].join('\n'))).toEqual(['remove']);
    expect(violationsOf("export default function remove(connection) { connection.exec('DELETE FROM t'); }")).toEqual(['remove']);
    expect(violationsOf("export default async function (connection) { connection.exec('DELETE FROM t'); }")).toEqual(['default']);
    expect(violationsOf("export default (connection) => connection.exec('DELETE FROM t');")).toEqual(['default']);
    expect(violationsOf([remove, 'export default { remove };'].join('\n'))).toEqual(['default']);
    // 違反でない: トランザクションの中だけで書く関数を、一覧や default で公開する。
    expect(violationsOf([add, 'export { add };', 'export { add as insertOne };', 'export default add;'].join('\n'))).toEqual([]);
    // 違反でない: 外で書く関数でも、公開しなければよい（`export { … }` の後ろに宣言が続いても、ほかの宣言に混ざらない）。
    expect(violationsOf([remove, add, 'export { add };', 'export const other = 1;'].join('\n'))).toEqual([]);
    // 違反でない: ほかのモジュールからの再公開（`export { … } from '…'`）は、このファイルの名前ではない。
    expect(violationsOf([remove, "export { remove } from './other.js';", "export type { Remove } from './other.js';"].join('\n'))).toEqual([]);
    // 違反: 版の一覧として扱わないなら、公開した一覧も違反。
    expect(violationsOf(migrations.join('\n'))).toContain('MIGRATIONS');
  });
});

describe('Control store boundary (T23c round 3)', () => {
  it('(g) every SQL write in migrations.ts, profile-store.ts and src/control/job/ can run only inside withWriteTransaction', () => {
    expect(JOB_FILES).toContain(JOB_STORE_FILE);
    for (const path of SQL_WRITER_PATHS) {
      const file = SOURCE_FILES.find((candidate) => candidate.path === path);
      expect(file, path).toBeDefined();
      expect(findWritesOutsideTransactions(file?.content ?? '', MIGRATION_LIST_NAMES), path).toEqual([]);
    }
  });

  it('(g) the check sees the real files: a leak appended to each file is reported', () => {
    // 検出の関数が、実際のファイルの書き込みの文と内部の関数を見つけられていることの確かめ（ファイルは変えず、本文の写しに足す）。
    const contentOf = (path: string): string => SOURCE_FILES.find((candidate) => candidate.path === path)?.content ?? '';
    expect(findWritesOutsideTransactions(
      `${contentOf(PROFILE_STORE_FILE)}\nexport const leak = (database) => replaceRow(database.connection, 1, next, 'ACTIVE', 'UPDATED', now);\n`,
      MIGRATION_LIST_NAMES,
    )).toEqual(['leak']);
    expect(findWritesOutsideTransactions(
      `${contentOf(PROFILE_STORE_FILE)}\nexport const leak = (database) => database.connection.prepare(INSERT_PROFILE_SQL).run();\n`,
      MIGRATION_LIST_NAMES,
    )).toEqual(['leak']);
    expect(findWritesOutsideTransactions(
      `${contentOf(MIGRATIONS_FILE)}\nexport const leak = (connection) => connection.exec(VERSION_1_STATEMENTS[0]);\n`,
      MIGRATION_LIST_NAMES,
    )).toEqual(['leak']);
    expect(findWritesOutsideTransactions(
      `${contentOf(MIGRATIONS_FILE)}\nexport const leak = (connection) => CONTROL_MIGRATIONS[0]?.seed?.(connection, context);\n`,
      MIGRATION_LIST_NAMES,
    )).toEqual(['leak']);
    // T24e: ジョブの行の読み書きのファイルも、同じく見えている。
    expect(findWritesOutsideTransactions(
      `${contentOf(JOB_STORE_FILE)}\nexport const leak = (connection) => connection.prepare(UPDATE_ENDED_SQL).run();\n`,
      MIGRATION_LIST_NAMES,
    )).toEqual(['leak']);
    // T25a round 1: 認証の設定の保存の部品も、同じく見えている。
    expect(findWritesOutsideTransactions(
      `${contentOf(AUTH_SETUP_STORE_FILE)}\nexport const leak = (database) => database.connection.prepare(UPSERT_AUTH_SETUP_SQL).run();\n`,
      MIGRATION_LIST_NAMES,
    )).toEqual(['leak']);
    // T28c: シナリオと承認の記録の保存の部品も、同じく見えている。
    expect(findWritesOutsideTransactions(
      `${contentOf(SCENARIO_STORE_FILE)}\nexport const leak = (connection) => connection.prepare(INSERT_RECEIPT_SQL).run();\n`,
      MIGRATION_LIST_NAMES,
    )).toEqual(['leak']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T28c: (k) 承認と撤回の記録と、シナリオの版の写しは追記だけ
// ---------------------------------------------------------------------------------------------------------------

/** (k) 追記だけの表（Task 28 の設計書 4.2）。 */
const APPEND_ONLY_TABLES: readonly string[] = ['approval_receipts', 'scenario_revisions', 'rule_set_revisions'];

/** (k) 表の名前（識別子か、二重引用符の名前。`main.` などの前置きを含む）を、正規表現の一部にする。 */
const appendOnlyTablePattern = (table: string): string => String.raw`(?:[\w$]+\s*\.\s*)?(?:${table}|"${table}")(?![\w$])`;

/**
 * (k) 追記だけの表を書き換える文（大文字と小文字を区別しない。テンプレートは、式を `${}` にした 1 つのリテラルとして見る）:
 * `UPDATE [OR …] <表> SET`、`DELETE FROM <表>`、`REPLACE INTO <表>`、`INSERT OR REPLACE INTO <表>`、`DROP TABLE <表>`、`ALTER TABLE <表>`。
 * T28R-fix-1（独立レビュー T28R の M-5）: upsert（`INSERT [OR …] INTO <表> … ON CONFLICT … DO UPDATE`）も書き換えとして数える（`DO NOTHING` は数えない）。
 */
/** (k) 追記だけの表を書き換える文の形（T29d: 表ごとに 1 回だけ組み立てる。ファイル 1 つの検査を 1 秒以内に保つ）。 */
const APPEND_ONLY_REWRITE_PATTERNS: readonly RegExp[] = APPEND_ONLY_TABLES.flatMap((table) => {
  const name = appendOnlyTablePattern(table);
  return [
    new RegExp(String.raw`\bUPDATE(?:\s+OR\s+\w+)?\s+${name}\s+SET\b`, 'iu'),
    new RegExp(String.raw`\bDELETE\s+FROM\s+${name}`, 'iu'),
    new RegExp(String.raw`\b(?:REPLACE|INSERT\s+OR\s+REPLACE)\s+INTO\s+${name}`, 'iu'),
    new RegExp(String.raw`\b(?:DROP|ALTER)\s+TABLE(?:\s+IF\s+EXISTS)?\s+${name}`, 'iu'),
    new RegExp(String.raw`\bINSERT(?:\s+OR\s+\w+)?\s+INTO\s+${name}[\s\S]*?\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\b`, 'iu'),
  ];
});

const findAppendOnlyRewrites = (source: ScannedSource): readonly string[] => source.wholeLiterals.map(literalBodyOf).filter((text) =>
  APPEND_ONLY_REWRITE_PATTERNS.some((pattern) => pattern.test(text)));

describe('Control store boundary detectors (T28c)', () => {
  it('(k) detects rewrites of the append-only tables, and ignores appends, reads and other tables', () => {
    for (const line of [
      "connection.prepare('UPDATE approval_receipts SET document = ? WHERE receipt_id = ?');",
      "connection.prepare('update OR ignore approval_receipts set expires_at = ?');",
      "connection.prepare('DELETE FROM approval_receipts WHERE receipt_id = ?');",
      'connection.prepare(`DELETE FROM main.approval_receipts`);',
      "connection.prepare('INSERT OR REPLACE INTO approval_receipts (receipt_id) VALUES (?)');",
      'connection.prepare(\'REPLACE INTO "approval_receipts" (receipt_id) VALUES (?)\');',
      "connection.prepare('UPDATE scenario_revisions SET document = ?');",
      "connection.prepare('DELETE FROM scenario_revisions');",
      "connection.exec('DROP TABLE approval_receipts');",
      "connection.exec('ALTER TABLE scenario_revisions RENAME TO old');",
      'const sql = `UPDATE approval_receipts SET ${column} = ?`;',
      // T28R-fix-1（M-5）: upsert（`ON CONFLICT … DO UPDATE`）と `INSERT OR REPLACE` も書き換え。
      "connection.prepare('INSERT INTO approval_receipts (receipt_id, document) VALUES (?, ?) ON CONFLICT (receipt_id) DO UPDATE SET document = excluded.document');",
      'connection.prepare(`insert into scenario_revisions (scenario_id, revision) values (?, ?)\n  on conflict do update set document = ?`);',
      "connection.prepare('INSERT OR REPLACE INTO scenario_revisions (scenario_id) VALUES (?)');",
    ]) {
      expect(findAppendOnlyRewrites(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "connection.prepare('INSERT INTO approval_receipts (receipt_id) VALUES (?)');",
      "connection.prepare('SELECT * FROM approval_receipts WHERE scenario_id = ?');",
      "connection.prepare('UPDATE scenarios SET state = ? WHERE scenario_id = ?');",
      "connection.prepare('UPDATE approval_receipts_old SET x = 1');",
      "connection.prepare('DELETE FROM write_reservations');",
      "// connection.prepare('DELETE FROM approval_receipts');",
      "const note = 'the approval receipts are never updated';",
      "connection.prepare('INSERT INTO approval_receipts (receipt_id) VALUES (?) ON CONFLICT DO NOTHING');",
      "connection.prepare('INSERT INTO write_reservations (grant_id) VALUES (?) ON CONFLICT (grant_id) DO UPDATE SET state = ?');",
    ]) {
      expect(findAppendOnlyRewrites(scanSource(line)), line).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T28d: (l) 版 6 の表に書くのは、シナリオと承認と許可と予約の保存の部品だけ
// ---------------------------------------------------------------------------------------------------------------

/** (l) 版 6 の表。 */
const VERSION_6_TABLES: readonly string[] = ['scenarios', 'scenario_revisions', 'approval_receipts', 'execution_grants', 'write_reservations'];
/** (l) 版 6 の表に書いてよいファイル（表を作る移行のファイルは、作る文だけを持つ）。 */
const VERSION_6_WRITER_FILES: readonly string[] = [SCENARIO_STORE_FILE, MIGRATIONS_FILE];

/** (l) 版 6 の表に書く文（`INSERT [OR …] INTO`・`REPLACE INTO`・`UPDATE [OR …] … SET`・`DELETE FROM`。大文字と小文字を区別しない）。 */
/**
 * (l) 表の一覧に書く文を見つける関数（T29d: 版 6 と版 7 で共用し、形は表ごとに 1 回だけ組み立てる）。`INSERT [OR …] INTO`・`REPLACE INTO`・
 * `UPDATE [OR …] … SET`・`DELETE FROM`。大文字と小文字を区別しない。
 */
const findTableWrites = (tables: readonly string[]): ((source: ScannedSource) => readonly string[]) => {
  const patterns = tables.flatMap((table) => {
    const name = appendOnlyTablePattern(table);
    return [
      new RegExp(String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+${name}`, 'iu'),
      new RegExp(String.raw`\bUPDATE(?:\s+OR\s+\w+)?\s+${name}\s+SET\b`, 'iu'),
      new RegExp(String.raw`\bDELETE\s+FROM\s+${name}`, 'iu'),
    ];
  });
  return (source) => source.wholeLiterals.map(literalBodyOf).filter((text) => patterns.some((pattern) => pattern.test(text)));
};

/** (l) 版 6 の表に書く文。 */
const findVersion6Writes = findTableWrites(VERSION_6_TABLES);

describe('Control store boundary detectors (T28d)', () => {
  it('(l) detects writes to the version 6 tables, and ignores reads and other tables', () => {
    for (const line of [
      "connection.prepare('INSERT INTO execution_grants (grant_id) VALUES (?)');",
      "connection.prepare('UPDATE write_reservations SET state = ? WHERE reservation_id = ?');",
      "connection.prepare('update OR ignore execution_grants set consumed_at = ?');",
      "connection.prepare('DELETE FROM scenarios WHERE scenario_id = ?');",
      'connection.prepare(`INSERT INTO scenario_revisions (${columns}) VALUES (?)`);',
      "connection.prepare('REPLACE INTO approval_receipts (receipt_id) VALUES (?)');",
    ]) {
      expect(findVersion6Writes(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "connection.prepare('SELECT * FROM execution_grants WHERE grant_id = ?');",
      "connection.prepare('UPDATE jobs SET state = ? WHERE job_id = ?');",
      "connection.prepare('INSERT INTO execution_grants_old (x) VALUES (1)');",
      "// connection.prepare('DELETE FROM write_reservations');",
      "const note = 'insert into the grants';",
    ]) {
      expect(findVersion6Writes(scanSource(line)), line).toHaveLength(0);
    }
  });
});

describe('Control store boundary (T28d)', () => {
  it('(l) only scenario-store.ts writes the version 6 tables (src/ and apps/local-ui/)', () => {
    // 検出の関数が、実際の保存の部品の書き込みを見ていることの確かめ（許可と予約の表にも書く）。
    const scenarioStore = SOURCE_FILES.find((file) => file.path === SCENARIO_STORE_FILE);
    const writes = findVersion6Writes(scenarioStore ?? scanSource(''));
    for (const table of VERSION_6_TABLES) {
      expect(writes.some((text) => text.includes(table)), table).toBe(true);
    }
    const violations = [...SOURCE_FILES.filter((file) => !VERSION_6_WRITER_FILES.includes(file.path)), ...UI_SOURCE_FILES]
      .flatMap((file) => findVersion6Writes(file).map((text) => `${file.path}: ${text.trim()}`));
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T29d: (l) 版 7 の表に書くのは、入力の規則の保存の部品だけ
// ---------------------------------------------------------------------------------------------------------------

/** (l) 版 7 の表。 */
const VERSION_7_TABLES: readonly string[] = ['rule_sets', 'rule_set_revisions'];
/** (l) 版 7 の表に書いてよいファイル。 */
const VERSION_7_WRITER_FILES: readonly string[] = [RULE_STORE_FILE, MIGRATIONS_FILE];

const findVersion7Writes = findTableWrites(VERSION_7_TABLES);

describe('Control store boundary detectors (T29d)', () => {
  it('(l) detects writes to the version 7 tables, and (k) rewrites of the rule set revisions', () => {
    for (const line of [
      "connection.prepare('INSERT INTO rule_sets (rule_set_id) VALUES (?)');",
      "connection.prepare('UPDATE rule_sets SET revision = ? WHERE rule_set_id = ?');",
      "connection.prepare('INSERT INTO rule_set_revisions (rule_set_id) VALUES (?)');",
      "connection.prepare('DELETE FROM rule_set_revisions');",
    ]) {
      expect(findVersion7Writes(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "connection.prepare('SELECT * FROM rule_sets WHERE scenario_id = ?');",
      "connection.prepare('INSERT INTO scenarios (scenario_id) VALUES (?)');",
      "connection.prepare('INSERT INTO rule_sets_old (x) VALUES (1)');",
    ]) {
      expect(findVersion7Writes(scanSource(line)), line).toHaveLength(0);
    }
    expect(findAppendOnlyRewrites(scanSource("connection.prepare('UPDATE rule_set_revisions SET document = ?');"))).toHaveLength(1);
    expect(findAppendOnlyRewrites(scanSource("connection.prepare('UPDATE rule_sets SET revision = ?');"))).toHaveLength(0);
  });
});

describe('Control store boundary (T29d)', () => {
  it('(l) only rule-store.ts writes the version 7 tables, and it writes no version 6 table (src/ and apps/local-ui/)', () => {
    const ruleStore = SOURCE_FILES.find((file) => file.path === RULE_STORE_FILE);
    const writes = findVersion7Writes(ruleStore ?? scanSource(''));
    for (const table of VERSION_7_TABLES) {
      expect(writes.some((text) => text.includes(table)), table).toBe(true);
    }
    const violations = [...SOURCE_FILES.filter((file) => !VERSION_7_WRITER_FILES.includes(file.path)), ...UI_SOURCE_FILES]
      .flatMap((file) => findVersion7Writes(file).map((text) => `${file.path}: ${text.trim()}`));
    expect(violations).toEqual([]);
    expect(findVersion6Writes(ruleStore ?? scanSource(''))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T30d: (l) 版 8 の書き込みの結果の表に書くのは、シナリオと承認と許可と予約の保存の部品だけ。(m) 追記と締めだけ
// ---------------------------------------------------------------------------------------------------------------

/** (l) 版 8 の表。 */
const VERSION_8_TABLES: readonly string[] = ['write_results'];
/** (l) 版 8 の表に書いてよいファイル。 */
const VERSION_8_WRITER_FILES: readonly string[] = [SCENARIO_STORE_FILE, MIGRATIONS_FILE];
/** (m) 締めで書いてよい列（送信の状態から締めの時刻まで）。 */
const WRITE_RESULT_SETTLEMENT_COLUMNS: ReadonlySet<string> = new Set([
  'submission', 'block_reason', 'http_status', 'response_judgement', 'record_id', 'read_verification', 'result', 'reason', 'reservation_state',
  'submitted_at', 'settled_at',
  // T31e（版 9）: UPDATE の証拠は、更新の後の照合まで済んでから分かるので、締めで 1 回だけ書く。
  'update_evidence',
]);

const findVersion8Writes = findTableWrites(VERSION_8_TABLES);

/** (m) 書き込みの結果の表の、`UPDATE … SET <列> = … WHERE …` の形（大文字と小文字を区別しない）。 */
const WRITE_RESULT_UPDATE_PATTERN = new RegExp(String.raw`\bUPDATE(?:\s+OR\s+\w+)?\s+${appendOnlyTablePattern('write_results')}\s+SET\b([\s\S]*?)(?:\bWHERE\b([\s\S]*))?$`, 'iu');
/** (m) 書き込みの結果の表を書き換える、締めでない文の形。 */
const WRITE_RESULT_REWRITE_PATTERNS: readonly RegExp[] = (() => {
  const name = appendOnlyTablePattern('write_results');
  return [
    new RegExp(String.raw`\bDELETE\s+FROM\s+${name}`, 'iu'),
    new RegExp(String.raw`\b(?:REPLACE|INSERT\s+OR\s+REPLACE)\s+INTO\s+${name}`, 'iu'),
    new RegExp(String.raw`\b(?:DROP|ALTER)\s+TABLE(?:\s+IF\s+EXISTS)?\s+${name}`, 'iu'),
    new RegExp(String.raw`\bINSERT(?:\s+OR\s+\w+)?\s+INTO\s+${name}[\s\S]*?\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\b`, 'iu'),
  ];
})();

/** (m) 書き込みの結果の表の、締めでない書き換え（締めの列の外を書く・締めていない行の条件がない `UPDATE` と、ほかの書き換え）。 */
const findWriteResultRewrites = (source: ScannedSource): readonly string[] => source.wholeLiterals.map(literalBodyOf).filter((text) => {
  if (WRITE_RESULT_REWRITE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const update = WRITE_RESULT_UPDATE_PATTERN.exec(text);
  if (update === null) {
    return false;
  }
  const columns = [...(update[1] ?? '').matchAll(/(?:^|,)\s*([\w$]+)\s*=/gu)].map((match) => match[1] ?? '');
  return columns.length === 0 || columns.some((column) => !WRITE_RESULT_SETTLEMENT_COLUMNS.has(column))
    || !/\bsettled_at\s+IS\s+NULL\b/iu.test(update[2] ?? '');
});

/** (m) T31e: 版の作り直しの、今の行を移す文（`INSERT INTO write_results_v<N> (…) SELECT … FROM write_results`）。`<N>` を取り出す。 */
const WRITE_RESULT_REBUILD_COPY_PATTERN = /\bINSERT\s+INTO\s+(write_results_v\d+)\s*\([\s\S]*?\)\s*SELECT\b[\s\S]*?\bFROM\s+write_results(?![\w$])/iu;
/** (m) T31e: 版の作り直しで消してよい文の、文の全体（`DROP TABLE write_results` だけ。条件や別の表を伴わない）。 */
const WRITE_RESULT_REBUILD_DROP_PATTERN = /^\s*DROP\s+TABLE\s+write_results\s*$/iu;

/** (m) T31e: 移行のファイルの、版の作り直しの組（今の行を移す文と、作った表を `write_results` に名前を変える文がそろうもの）の数。 */
const writeResultRebuildsOf = (source: ScannedSource): number => {
  const bodies = source.wholeLiterals.map(literalBodyOf);
  const temporaryTables = bodies.flatMap((text) => {
    const match = WRITE_RESULT_REBUILD_COPY_PATTERN.exec(text);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  return temporaryTables.filter((table) => bodies.some((text) =>
    new RegExp(String.raw`\bALTER\s+TABLE\s+${table}\s+RENAME\s+TO\s+write_results(?![\w$])`, 'iu').test(text))).length;
};

/**
 * (m) 書き込みの結果の表の、締めでない書き換え（T31e）。移行のファイル（`isMigrations`）だけ、版の作り直しの組の数まで、文の全体がちょうど
 * `DROP TABLE write_results` の文を除く（`writeResultRebuildsOf`）。ほかは `findWriteResultRewrites` のまま。
 */
const findWriteResultRewritesOutsideRebuilds = (source: ScannedSource, isMigrations: boolean): readonly string[] => {
  let allowedDrops = isMigrations ? writeResultRebuildsOf(source) : 0;
  return findWriteResultRewrites(source).filter((text) => {
    if (allowedDrops > 0 && WRITE_RESULT_REBUILD_DROP_PATTERN.test(text)) {
      allowedDrops -= 1;
      return false;
    }
    return true;
  });
};

describe('Control store boundary detectors (T30d)', () => {
  it('(m) accepts only the rebuild of a version in the migrations, up to the number of rebuilds (T31e)', () => {
    const rebuild = [
      'const s = [`INSERT INTO write_results_v9 (job_id, write_kind)\n    SELECT job_id, \'CREATE\' FROM write_results`,',
      "  'DROP TABLE write_results',",
      "  'ALTER TABLE write_results_v9 RENAME TO write_results'];",
    ].join('\n');
    expect(findWriteResultRewritesOutsideRebuilds(scanSource(rebuild), true)).toEqual([]);
    // 移行のファイルでなければ、作り直しの組があっても検出する。
    expect(findWriteResultRewritesOutsideRebuilds(scanSource(rebuild), false)).toHaveLength(1);
    // 組のない DROP、名前を変える文のない組、組の数を超える DROP、条件つきの DROP、行を消す DELETE は、移行のファイルでも検出する。
    for (const [label, text] of [
      ['a drop without a rebuild', "const s = ['DROP TABLE write_results'];"],
      ['a copy without a rename', "const s = ['INSERT INTO write_results_v9 (job_id) SELECT job_id FROM write_results', 'DROP TABLE write_results'];"],
      ['a drop more than the rebuilds', `${rebuild}\nconst t = ['DROP TABLE write_results'];`],
      ['a conditional drop', `${rebuild.replace("'DROP TABLE write_results'", "'DROP TABLE IF EXISTS write_results'")}`],
      ['a delete', `${rebuild}\nconst t = ['DELETE FROM write_results WHERE job_id = ?'];`],
      ['a settled-row update', `${rebuild}\nconst t = ['UPDATE write_results SET result = ? WHERE job_id = ?'];`],
    ] as const) {
      expect(findWriteResultRewritesOutsideRebuilds(scanSource(text), true).length, label).toBeGreaterThan(0);
    }
  });

  it('(l) detects writes to the version 8 table, and (m) rewrites that are not settlements', () => {
    expect(findVersion8Writes(scanSource("connection.prepare('INSERT INTO write_results (job_id) VALUES (?)');"))).toHaveLength(1);
    expect(findVersion8Writes(scanSource("connection.prepare('SELECT * FROM write_results');"))).toHaveLength(0);
    for (const line of [
      "connection.prepare('UPDATE write_results SET submitted_values = ? WHERE job_id = ? AND settled_at IS NULL');",
      "connection.prepare('UPDATE write_results SET result = ? WHERE job_id = ?');",
      "connection.prepare('UPDATE write_results SET result = ?, job_id = ? WHERE settled_at IS NULL');",
      "connection.prepare('DELETE FROM write_results WHERE job_id = ?');",
      "connection.prepare('INSERT OR REPLACE INTO write_results (job_id) VALUES (?)');",
      "connection.prepare('INSERT INTO write_results (job_id) VALUES (?) ON CONFLICT (job_id) DO UPDATE SET result = ?');",
      "connection.exec('ALTER TABLE write_results ADD COLUMN x TEXT');",
    ]) {
      expect(findWriteResultRewrites(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "connection.prepare('UPDATE write_results SET result = ?, reason = ?, settled_at = ? WHERE job_id = ? AND settled_at IS NULL');",
      'connection.prepare(`UPDATE write_results SET submission = ?,\n  record_id = ? WHERE job_id = ? AND settled_at IS NULL`);',
      "connection.prepare('INSERT INTO write_results (job_id) VALUES (?)');",
      "connection.prepare('UPDATE write_reservations SET state = ? WHERE reservation_id = ?');",
    ]) {
      expect(findWriteResultRewrites(scanSource(line)), line).toHaveLength(0);
    }
  });
});

describe('Control store boundary (T30d)', () => {
  it('(l) only scenario-store.ts writes the version 8 table (src/ and apps/local-ui/)', () => {
    const scenarioStore = SOURCE_FILES.find((file) => file.path === SCENARIO_STORE_FILE);
    expect(findVersion8Writes(scenarioStore ?? scanSource('')).length).toBeGreaterThan(0);
    const violations = [...SOURCE_FILES.filter((file) => !VERSION_8_WRITER_FILES.includes(file.path)), ...UI_SOURCE_FILES]
      .flatMap((file) => findVersion8Writes(file).map((text) => `${file.path}: ${text.trim()}`));
    expect(violations).toEqual([]);
  });

  it('(m) the write results are only appended and settled (src/ and apps/local-ui/)', () => {
    // 検出の関数が、実際の締めの文を見ていることの確かめ（締めの UPDATE はある）。
    const scenarioStore = SOURCE_FILES.find((file) => file.path === SCENARIO_STORE_FILE);
    expect((scenarioStore?.wholeLiterals ?? []).map(literalBodyOf).some((text) => WRITE_RESULT_UPDATE_PATTERN.test(text))).toBe(true);
    // T31e: 移行のファイルは、版の作り直しの組だけを受ける（`findWriteResultRewritesOutsideRebuilds`）。
    const violations = [...SOURCE_FILES, ...UI_SOURCE_FILES]
      .flatMap((file) => findWriteResultRewritesOutsideRebuilds(file, file.path === MIGRATIONS_FILE).map((text) => `${file.path}: ${text.trim()}`));
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T30e（T30d の発見事項 2 の判断）: 予約を締める口を参照するのは、保存の部品と、書き込みのジョブの管理だけ
// ---------------------------------------------------------------------------------------------------------------

/** (n) 書き込みの結果を記録せずに予約を返す口（`RELEASED` だけ）。参照してよいのは、定義する保存の部品だけ。 */
const RESERVATION_ONLY_SETTLERS: readonly string[] = ['settleWriteReservation'];
/** (n) 書き込みの結果の記録を伴って予約を締める口と、送る前の記録。参照してよいのは、保存の部品と、書き込みのジョブの管理だけ。 */
const WRITE_RESULT_SETTLERS: readonly string[] = ['recordWriteAttempt', 'settleWriteResult', 'closeOrphanedWriteResults', 'closeWriteWithoutSending'];
const AUDIT_JOB_MANAGER_FILE = 'src/control/job/audit-job-manager.ts';
/** (n) 口ごとの、参照してよいファイル。 */
const SETTLER_OWNERS: ReadonlyMap<string, readonly string[]> = new Map([
  ...RESERVATION_ONLY_SETTLERS.map((name): readonly [string, readonly string[]] => [name, [SCENARIO_STORE_FILE]]),
  ...WRITE_RESULT_SETTLERS.map((name): readonly [string, readonly string[]] => [name, [SCENARIO_STORE_FILE, AUDIT_JOB_MANAGER_FILE]]),
]);

/**
 * (n) 口の名前の参照（コメントと文字列の中身を除いた本文で、識別子として現れる位置。呼び出し・import・再公開・別名の代入のどれも数える）。
 * 近似: 名前を実行時に組み立てる参照（`store['settle' + 'WriteResult']`）は検出できない。
 */
const findSettlerReferences = (source: ScannedSource, name: string): number =>
  // DEF-107: `bare` に名前の文字列がなければ、数は 0（正規表現を作って照らすのを省く。結果は同じ）。
  (source.bare.includes(name) ? [...source.bare.matchAll(new RegExp(String.raw`(?<![\w$])${name}(?![\w$])`, 'gu'))].length : 0);

describe('Control store boundary detectors (T30e)', () => {
  it('(n) counts calls, imports and re-exports of a settlement function, and ignores comments, strings and longer names', () => {
    expect(findSettlerReferences(scanSource("import { settleWriteResult } from './scenario-store.js';"), 'settleWriteResult')).toBe(1);
    expect(findSettlerReferences(scanSource("export { settleWriteResult as settle } from './scenario-store.js';"), 'settleWriteResult')).toBe(1);
    expect(findSettlerReferences(scanSource('store.settleWriteReservation(database, input);'), 'settleWriteReservation')).toBe(1);
    expect(findSettlerReferences(scanSource('// settleWriteResult(database, report);'), 'settleWriteResult')).toBe(0);
    expect(findSettlerReferences(scanSource("const text = 'settleWriteResult';"), 'settleWriteResult')).toBe(0);
    expect(findSettlerReferences(scanSource('this.#settleWrite(job, result, at); settleWriteResults();'), 'settleWriteResult')).toBe(0);
  });
});

describe('Control store boundary (T30e)', () => {
  it('(n) only scenario-store.ts and the audit job manager refer to the functions that settle a write reservation (src/ and apps/local-ui/)', () => {
    // 検出の関数が、実際の定義と呼び出しを見ていることの確かめ（保存の部品は全部を定義し、ジョブの管理は結果を伴う口を全部使う）。
    const scenarioStore = SOURCE_FILES.find((file) => file.path === SCENARIO_STORE_FILE);
    const manager = SOURCE_FILES.find((file) => file.path === AUDIT_JOB_MANAGER_FILE);
    for (const name of SETTLER_OWNERS.keys()) {
      expect(findSettlerReferences(scenarioStore ?? scanSource(''), name), name).toBeGreaterThan(0);
    }
    for (const name of WRITE_RESULT_SETTLERS) {
      expect(findSettlerReferences(manager ?? scanSource(''), name), name).toBeGreaterThan(0);
    }
    // T30g fix round 1: 製品のコード（`src/` と画面の `apps/local-ui/src/`）。画面のテストは (o) が見る。
    const violations = [...SOURCE_FILES, ...UI_PRODUCT_FILES].flatMap((file) => [...SETTLER_OWNERS]
      .filter(([name, owners]) => !owners.includes(file.path) && findSettlerReferences(file, name) > 0)
      .map(([name]) => `${file.path}: ${name}`));
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T30g fix round 1: (o) テストは、予約を締める口と送る前の記録を、テストの補助（と、理由つきの閉じた例外）からだけ使う
// ---------------------------------------------------------------------------------------------------------------

/** 画面の製品のコード（`apps/local-ui/src/`。(n) の対象）。 */
const UI_PRODUCT_FILES: readonly SourceFile[] = UI_SOURCE_FILES.filter((file) => file.path.startsWith(`${UI_DIRECTORY}/src/`));
/** (o) `tests/` のテストのコード（読み込んだだけ。走査は下の `TEST_FILES` で、要るものだけ。DEF-107）。 */
const ROOT_TEST_TEXTS: readonly UnscannedFile[] = readTypeScriptFilesUnder('tests');
/** (o) 画面のテスト（`apps/local-ui/tests/`。`UI_SOURCE_FILES` で走査済み）。 */
const UI_TEST_FILES: readonly SourceFile[] = UI_SOURCE_FILES.filter((file) => file.path.startsWith(`${UI_DIRECTORY}/tests/`));
/** (o) テストのコードのすべてのパス（`tests/` と、画面のテスト）。 */
const TEST_FILE_PATHS: readonly string[] = [...ROOT_TEST_TEXTS, ...UI_TEST_FILES].map(({ path }) => path);
/** (o) 口を参照してよいテストの補助。 */
const SETTLER_TEST_HELPERS: readonly string[] = ['tests/integration/execution-grant-fixtures.ts', 'tests/helpers/write-result-fixtures.ts'];
/** (o) 口を直接参照してよいテスト（閉じた一覧。ファイル → 理由）。画面のテストは入れない。 */
const SETTLER_TEST_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'tests/integration/write-result-store.test.ts': '書き込みの結果の記録と締めの口そのものを確かめる（保存の部品のテスト）',
  'tests/integration/execution-grant-store.test.ts': '予約を返す口（settleWriteReservation）の遷移と拒否そのものを確かめる（保存の部品のテスト）',
  'tests/integration/control-write-jobs.test.ts': 'ジョブを通さずに書いた送る前の記録を、再起動の後にジョブの管理が締めること（回復）を確かめる',
  'tests/integration/write-job-g30.test.ts': 'G30 の結合の確かめで、送る前の記録と締めを直接作る（Task 30 の G30 の担当のテスト）',
});
/** (o) 予約を締める口と送る前の記録（(n) の 5 つ）。 */
const ALL_SETTLERS: readonly string[] = [...RESERVATION_ONLY_SETTLERS, ...WRITE_RESULT_SETTLERS];
/**
 * (o) 調べるテストのコード（`tests/` と、画面のテスト）。DEF-107: `tests/` の全体を文字ずつ走査すると重いので、`tests/` は、本文に口の名前の
 * どれかを含むファイルと、補助（`SETTLER_TEST_HELPERS`）だけを走査する。本文に名前を含まないファイルは、`bare`（コメントを空白にし、文字列の
 * 中身を空にした本文）にも名前がないので、口を参照しえない（検出は前と同じ）。
 */
const TEST_FILES: readonly SourceFile[] = [
  ...ROOT_TEST_TEXTS
    .filter(({ path, content }) => SETTLER_TEST_HELPERS.includes(path) || ALL_SETTLERS.some((name) => content.includes(name)))
    .map(scanFile),
  ...UI_TEST_FILES,
];

/** (o) テストのファイルの違反（参照してよいファイルでないのに、口を参照する。`<ファイル>: <名前>`）。 */
const testSettlerViolationsOf = (files: readonly SourceFile[]): readonly string[] => files.flatMap((file) => (
  SETTLER_TEST_HELPERS.includes(file.path) || Object.hasOwn(SETTLER_TEST_EXCEPTIONS, file.path)
    ? []
    : ALL_SETTLERS.filter((name) => findSettlerReferences(file, name) > 0).map((name) => `${file.path}: ${name}`)));

describe('Control store boundary (T30g fix round 1)', () => {
  it('(o) reports a test file that refers to a settlement function outside the helpers and the closed exceptions (control)', () => {
    const fileOf = (path: string, text: string): SourceFile => ({ path, content: text, ...scanSource(text) });
    expect(testSettlerViolationsOf([
      fileOf(`${UI_DIRECTORY}/tests/example.test.ts`, "import { settleWriteResult } from '../../../src/control/approval/scenario-store.js';"),
      fileOf('tests/integration/example.test.ts', 'recordWriteAttempt(database, input);'),
      fileOf('tests/helpers/write-result-fixtures.ts', 'settleWriteResult(database, report);'),
      fileOf('tests/integration/write-result-store.test.ts', 'settleWriteResult(database, report);'),
      fileOf('tests/integration/comment.test.ts', '// settleWriteResult(database, report);'),
    ])).toEqual([`${UI_DIRECTORY}/tests/example.test.ts: settleWriteResult`, 'tests/integration/example.test.ts: recordWriteAttempt']);
  });

  it('(o) tests use the settlement functions only through the helpers, besides the closed exceptions (tests/ and apps/local-ui/tests/)', () => {
    // 対照: 読み込んだテストのファイルに、補助と画面のテストが入っていて、補助は口を参照している。
    const helpers = TEST_FILES.filter((file) => SETTLER_TEST_HELPERS.includes(file.path));
    expect(helpers.map(({ path }) => path).sort()).toEqual([...SETTLER_TEST_HELPERS].sort());
    expect(helpers.every((file) => ALL_SETTLERS.some((name) => findSettlerReferences(file, name) > 0))).toBe(true);
    expect(TEST_FILE_PATHS.some((path) => path.startsWith(`${UI_DIRECTORY}/tests/`))).toBe(true);
    // 例外の一覧のファイルはすべてある（古くならない）。
    expect(Object.keys(SETTLER_TEST_EXCEPTIONS).filter((path) => !TEST_FILE_PATHS.includes(path))).toEqual([]);
    expect(testSettlerViolationsOf(TEST_FILES)).toEqual([]);
  });
});

describe('Control store boundary (T28c)', () => {
  it('(k) no file rewrites the approval receipts or the scenario revisions (src/ and apps/local-ui/)', () => {
    // 検出の関数が、実際の保存の部品の、追記の文を見ていることの確かめ（追記はある）。
    const scenarioStore = SOURCE_FILES.find((file) => file.path === SCENARIO_STORE_FILE);
    expect(findSqlWriteStatements(scenarioStore ?? scanSource('')).some((text) => /INSERT\s+INTO\s+approval_receipts/iu.test(text))).toBe(true);
    const violations = [...SOURCE_FILES, ...UI_SOURCE_FILES]
      .flatMap((file) => findAppendOnlyRewrites(file).map((text) => `${file.path}: ${text.trim()}`));
    expect(violations).toEqual([]);
  });
});

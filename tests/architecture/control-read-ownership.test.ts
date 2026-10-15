/**
 * CCX-17（台帳の CC-077、CC-078 の前半）: 管理の層で 1 か所にまとめた読み出しと写しの手順が、ほかの場所で作り直されないための Architecture Gate。
 * 判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts` の `scanSource` と `loadSourceFiles` を共用する）。近似の検査である。
 * - (a) CC-077: 「JSON の写し → 管理の契約のスキーマで確かめる」の手順（同じファイルの中の、`JSON.parse(JSON.stringify(…))` の写しと
 *   `validateControlDocument(` の呼び出しの組）は、`src/control/schema-checked-copy.ts` だけに書く。ほかのファイルは `schemaCheckedCopyOf`・
 *   `requireSchemaCheckedCopy` を使う（写しだけ、確かめだけのファイルは数えない）。
 * - (b) CC-078 の前半: 発見の索引（`discovery_candidates`・`discovery_jobs`）と READ の定義（`read_checks`・`read_check_results`）の表の名前を
 *   文字列リテラル（SQL）に書くのは、それぞれの owner（`src/control/job/discovery-index-store.ts`、`src/control/job/read-check-store.ts`）と、
 *   表を作る移行（`src/control/store/migrations.ts`）だけ。ほかの部品は、owner の読み出し（トランザクションの中で使える `readDiscoveryIndexIn`・
 *   `noDiscoveryJobRecordedAfterIn`・`listReadChecksIn` を含む）を使う。コメントの中の表の名前は数えない。
 * - 対象は `src/**` と、画面の `apps/local-ui/src/**`（`.ts`、`.tsx`）。読み込みと走査は、このファイルの読み込み時に 1 回だけ。1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { loadLocalUiSourceFiles, loadSourceFiles, scanSource, type ScannedSource, type SourceFile } from './source-scan.js';

const SOURCE_FILES: readonly SourceFile[] = [...loadSourceFiles(), ...loadLocalUiSourceFiles()];

const SCHEMA_CHECKED_COPY_OWNER = 'src/control/schema-checked-copy.ts';
const DISCOVERY_INDEX_OWNER = 'src/control/job/discovery-index-store.ts';
const READ_CHECK_OWNER = 'src/control/job/read-check-store.ts';
const MIGRATIONS_FILE = 'src/control/store/migrations.ts';

/** (b) 表ごとの、表の名前を SQL に書いてよいファイル。 */
const TABLE_OWNERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['discovery_candidates', [DISCOVERY_INDEX_OWNER, MIGRATIONS_FILE]],
  ['discovery_jobs', [DISCOVERY_INDEX_OWNER, MIGRATIONS_FILE]],
  ['read_checks', [READ_CHECK_OWNER, MIGRATIONS_FILE]],
  ['read_check_results', [READ_CHECK_OWNER, MIGRATIONS_FILE]],
]);

/** (a) JSON の写しの形（`JSON.parse(JSON.stringify(`。空白を許す）と、管理の契約のスキーマの確かめの呼び出し。 */
const JSON_COPY_PATTERN = /\bJSON\s*\.\s*parse\s*\(\s*JSON\s*\.\s*stringify\s*\(/u;
const CONTROL_VALIDATION_PATTERN = /\bvalidateControlDocument\s*\(/u;

/** (a) 写しと確かめの組を持つか（コメントを除いた本文。文字列の中は数えない）。 */
const hasSchemaCheckedCopy = (source: ScannedSource): boolean =>
  JSON_COPY_PATTERN.test(source.bare) && CONTROL_VALIDATION_PATTERN.test(source.bare);

/** (b) 文字列リテラルの中の、表の名前（語の単位）。 */
const tablesWrittenIn = (source: ScannedSource): readonly string[] => [...TABLE_OWNERS.keys()].filter((table) =>
  source.literals.some((literal) => new RegExp(`(?<![\\w$])${table}(?![\\w$])`, 'u').test(literal)));

describe('control read ownership detectors (CCX-17)', () => {
  it('(a) finds a JSON copy together with a control schema validation, and ignores comments and each one alone', () => {
    expect(hasSchemaCheckedCopy(scanSource('const copy = JSON.parse(JSON.stringify(value));\nconst shape = validateControlDocument(\'scenario\', copy);'))).toBe(true);
    expect(hasSchemaCheckedCopy(scanSource('const copy = JSON . parse ( JSON.stringify(value) ); validateControlDocument (name, copy);'))).toBe(true);
    expect(hasSchemaCheckedCopy(scanSource('const copy = JSON.parse(JSON.stringify(value));'))).toBe(false);
    expect(hasSchemaCheckedCopy(scanSource('const shape = validateControlDocument(name, value);'))).toBe(false);
    expect(hasSchemaCheckedCopy(scanSource('// JSON.parse(JSON.stringify(value)); validateControlDocument(name, copy);'))).toBe(false);
  });

  it('(b) finds the table names in string literals only, as whole words', () => {
    expect(tablesWrittenIn(scanSource("db.prepare('SELECT count(*) AS n FROM discovery_jobs WHERE profile_id = ?');"))).toEqual(['discovery_jobs']);
    expect(tablesWrittenIn(scanSource('db.prepare(`SELECT * FROM read_checks WHERE profile_id = ?`);'))).toEqual(['read_checks']);
    expect(tablesWrittenIn(scanSource("db.prepare('SELECT * FROM read_check_results');"))).toEqual(['read_check_results']);
    expect(tablesWrittenIn(scanSource('// the rows of discovery_candidates and read_checks'))).toEqual([]);
    expect(tablesWrittenIn(scanSource("const name = 'read_checks_view';"))).toEqual([]);
  });
});

describe('control read ownership (CCX-17)', () => {
  it('(a) only schema-checked-copy.ts copies a document as JSON and checks it with a control schema (src/ and apps/local-ui/)', () => {
    const owner = SOURCE_FILES.find((file) => file.path === SCHEMA_CHECKED_COPY_OWNER);
    expect(owner !== undefined && hasSchemaCheckedCopy(owner)).toBe(true);
    const violations = SOURCE_FILES.filter((file) => file.path !== SCHEMA_CHECKED_COPY_OWNER && hasSchemaCheckedCopy(file)).map((file) => file.path);
    expect(violations).toEqual([]);
  });

  it('(b) only the owners of the discovery index and of the READ checks write their table names in SQL (src/ and apps/local-ui/)', () => {
    for (const [table, owners] of TABLE_OWNERS) {
      const [owner] = owners;
      const ownerFile = SOURCE_FILES.find((file) => file.path === owner);
      expect(ownerFile === undefined ? [] : tablesWrittenIn(ownerFile), table).toContain(table);
    }
    const violations = SOURCE_FILES.flatMap((file) => tablesWrittenIn(file)
      .filter((table) => !(TABLE_OWNERS.get(table) ?? []).includes(file.path))
      .map((table) => `${file.path}: ${table}`));
    expect(violations).toEqual([]);
  });
});

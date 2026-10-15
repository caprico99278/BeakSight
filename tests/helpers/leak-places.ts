// CC-091（T32k）: ワーカーの fork のテストの、秘密の目印を探す場所の組み立てと、読み取りでない要求の取り出し（テストのファイルではない）。
// 書き込みのジョブの補助（`write-job-harness.ts`）、自動ログインと認証の対比と発見のジョブの fork のテストが使い、テストのファイルに書き写さない。
// - ファイルの中身は ZIP を展開した中身も並べる（`<ZIP のパス>!/<ZIP の中のパス>`。圧縮のバイト列のままでは値を見つけられない。T32f）。
// - 目印は UTF-8 のバイトで探す（画面のテストの補助 `apps/local-ui/tests/helpers/secret-markers.ts` は UTF-16LE も探す。場所の名前の形が違う
//   ので、ここでは同じ名前の関数を作らない）。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync } from 'fflate';

/** 読み取りの要求のメソッド。 */
export const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** 探す場所の 1 つ（場所の名前と中身）。 */
export type LeakPlace = readonly [string, Buffer];

/** ZIP の中の項目の場所の区切り（`<ZIP のパス>!/<ZIP の中のパス>`）。 */
export const ZIP_ENTRY_PLACE_SEPARATOR = '!/';

/** GET と HEAD 以外の要求（`since` 番目から。`<method> <path>` の形）。 */
export const nonReadRequestsOf = (requests: readonly { readonly method: string; readonly path: string }[], since = 0): readonly string[] =>
  requests.slice(since).filter(({ method }) => !READ_METHODS.has(method)).map(({ method, path }) => `${method} ${path}`);

/**
 * ディレクトリの下のすべてのファイルの中身。ZIP（書き込みのバンドルなど）は、ファイルそのものに加えて、展開した各項目も
 * `<ZIP のパス>!/<ZIP の中のパス>` の場所として並べる（目印と値の検査が ZIP の中身まで届く）。
 */
export const filesUnder = (root: string): readonly LeakPlace[] => (existsSync(root)
  ? readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const path = join(entry.parentPath, entry.name);
      const bytes = readFileSync(path);
      return path.endsWith('.zip')
        ? [[path, bytes] as const, ...Object.entries(unzipSync(bytes)).map(([inner, content]) => [`${path}${ZIP_ENTRY_PLACE_SEPARATOR}${inner}`, Buffer.from(content)] as const)]
        : [[path, bytes] as const];
    })
  : []);

/** 管理データのファイルと WAL（あるものだけ）。 */
export const databaseFilePlaces = (databasePath: string): readonly LeakPlace[] =>
  [databasePath, `${databasePath}-wal`].filter((path) => existsSync(path)).map((path) => [path, readFileSync(path)] as const);

/** 自動ログインのジョブの値が入る管理データの表（ジョブ、自動ログインの試しと止め、資格情報の出来事）。 */
export const AUTO_LOGIN_CONTROL_TABLES: readonly string[] = Object.freeze(['jobs', 'auto_login_attempts', 'auto_login_holds', 'credential_events']);

/** 管理データの表のすべての行（読むだけで開く。表ごとに JSON の文字列にして、改行でつなぐ）。 */
export const databaseTablesText = (databasePath: string, tables: readonly string[]): string => {
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return tables.map((table) => JSON.stringify(raw.prepare(`SELECT * FROM ${table}`).all())).join('\n');
  } finally {
    raw.close();
  }
};

/** 文字列の場所（UTF-8 のバイト）。 */
export const textLeakPlace = (place: string, text: string): LeakPlace => [place, Buffer.from(text, 'utf8')];

/** 目印が出た場所の名前（目印ごとに 1 つ。目印の値は出さない）。 */
export const placesWithMarkers = (places: readonly LeakPlace[], markers: readonly string[]): readonly string[] =>
  places.flatMap(([place, bytes]) => markers.filter((marker) => bytes.includes(Buffer.from(marker, 'utf8'))).map(() => place));

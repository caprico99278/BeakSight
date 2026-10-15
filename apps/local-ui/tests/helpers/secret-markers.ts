/**
 * 資格情報の目印の検査の補助（Task 26 の設計書 4.7。T26f）。目印の値は出力しない（漏れた場所の名前と、文字の形だけを返す）。
 * - 検索の場所: ディレクトリの下のすべてのファイル（ZIP は展開した中身も。symlink と junction はたどらない。決まった名前のフォルダは読まない）、
 *   SQLite のすべての表のすべての行（読むだけで開く）、子プロセスの起動の記録（PowerShell の `-EncodedCommand` は、戻した本文も）、文字列。
 * - 目印の形: UTF-8 と UTF-16LE の両方のバイトで探す（Windows の API や .NET が書く UTF-16LE の文字列にも当たるように）。
 * - 子プロセスの起動の記録: テストだけの前処理（画面のサーバの `node --import`）と、テストだけのワーカーの入口に埋める本文。`node:child_process` の
 *   `spawn` を包み、起動のファイルと引数と、環境を渡したかを、記録のファイルに 1 行ずつ書き足してから、元の `spawn` を呼ぶ（`syncBuiltinESMExports`
 *   で、`import { spawn }` の名前にも届く）。製品の起動の部品は変えない。
 * - SQL の書き込み（時刻の進め方と、対照の WAL）は、`tests/helpers/control-data-test-writes.ts` に置く（画面のコードの置き場所に SQL の
 *   書き込みの文を置かない Gate のため）。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

/** 目印を探す文字の形。 */
export const MARKER_ENCODINGS = Object.freeze(['utf8', 'utf16le'] as const);

/** 検索する場所の 1 つ（名前と中身）。 */
export interface SearchedPlace {
  readonly place: string;
  readonly bytes: Uint8Array;
}

/** ZIP の拡張子。 */
const ZIP_EXTENSION = '.zip';
/** PowerShell の、本文を base64（UTF-16LE）で渡す引数の名前。 */
const ENCODED_COMMAND_ARGUMENT = '-EncodedCommand';

export const textPlace = (place: string, text: string): SearchedPlace => ({ place, bytes: Buffer.from(text, 'utf8') });

/**
 * `directory` の下のすべてのファイル（ZIP は、展開した中身も `<場所>!<中の名前>` として足す）。場所の名前は `<label>:<相対パス>`（区切りは `/`）。
 * symlink と junction はたどらない。`skippedDirectoryNames` の名前のフォルダは読まない。
 */
export const filesUnder = (directory: string, label: string, skippedDirectoryNames: readonly string[] = []): SearchedPlace[] => {
  if (!existsSync(directory)) {
    return [];
  }
  const places: SearchedPlace[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!skippedDirectoryNames.includes(entry.name)) {
          walk(path);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const bytes = new Uint8Array(readFileSync(path));
      const place = `${label}:${relative(directory, path).split('\\').join('/')}`;
      places.push({ place, bytes });
      if (entry.name.endsWith(ZIP_EXTENSION)) {
        for (const [name, content] of Object.entries(unzipSync(bytes))) {
          places.push({ place: `${place}!${name}`, bytes: content });
        }
      }
    }
  };
  walk(directory);
  return places;
};

/** SQLite のすべての表のすべての行（読むだけで開く。BLOB は latin1 の文字にする）と、表ごとの行の数。 */
export const databaseRowsPlace = (databasePath: string, label: string): { readonly place: SearchedPlace; readonly rowCounts: ReadonlyMap<string, number> } => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { readonly name: string }[];
    const rows = tables.map(({ name }) => ({ name, rows: database.prepare(`SELECT * FROM "${name.split('"').join('""')}"`).all() }));
    const text = JSON.stringify(rows, (_key, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : value));
    return { place: textPlace(label, text), rowCounts: new Map(rows.map(({ name, rows: tableRows }) => [name, tableRows.length])) };
  } finally {
    database.close();
  }
};

/** 子プロセスの起動の記録の 1 行。 */
export interface ChildProcessRecord {
  /** 記録した process（`server`、`worker` など）。 */
  readonly process: string;
  readonly file: string;
  readonly args: readonly string[];
  /** 環境（`env`）を渡したか。 */
  readonly hasEnv: boolean;
}

/**
 * 子プロセスの起動の記録のファイルを読む。場所は、行ごとの `<label>:<行の番号>`（記録のそのまま）と、`-EncodedCommand` の値を戻した本文の
 * `<label>:<行の番号>:script`。ファイルがなければ空。
 */
export const childProcessRecordsOf = (recordFile: string, label: string): { readonly records: readonly ChildProcessRecord[]; readonly places: readonly SearchedPlace[] } => {
  if (!existsSync(recordFile)) {
    return { records: [], places: [] };
  }
  const lines = readFileSync(recordFile, 'utf8').split('\n').filter((line) => line.length > 0);
  const records: ChildProcessRecord[] = [];
  const places: SearchedPlace[] = [];
  lines.forEach((line, index) => {
    const record = JSON.parse(line) as ChildProcessRecord;
    records.push(record);
    const lineNumber = index + 1;
    places.push(textPlace(`${label}:${lineNumber}`, line));
    const encodedAt = record.args.indexOf(ENCODED_COMMAND_ARGUMENT);
    const encoded = encodedAt < 0 ? undefined : record.args[encodedAt + 1];
    if (encoded !== undefined) {
      // `-EncodedCommand` の値は、本文の UTF-16LE のバイトの base64。
      places.push({ place: `${label}:${lineNumber}:script`, bytes: new Uint8Array(Buffer.from(encoded, 'base64')) });
    }
  });
  return { records, places };
};

/** 目印を含む場所（`<場所> (<文字の形>)`。目印の値は出さない）。 */
export const leakedPlaces = (places: readonly SearchedPlace[], markers: readonly string[]): readonly string[] => {
  const needles = markers.flatMap((marker) => MARKER_ENCODINGS.map((encoding) => ({ encoding, bytes: Buffer.from(marker, encoding) })));
  return places.flatMap(({ place, bytes }) => {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const encodings = MARKER_ENCODINGS.filter((encoding) => needles.some((needle) => needle.encoding === encoding && buffer.includes(needle.bytes)));
    return encodings.map((encoding) => `${place} (${encoding})`);
  });
};

/**
 * 子プロセスの起動を記録する本文（ESM。テストだけの前処理と、テストだけのワーカーの入口に埋める）。`recordFile` に、1 回の起動ごとに
 * `ChildProcessRecord` の JSON を 1 行書き足す。名前は、入口のほかの名前と重ならないものにする。
 */
export const childProcessRecordingSource = (recordFile: string, processLabel: string): string => String.raw`
import { appendFileSync as appendChildProcessRecord } from 'node:fs';
import childProcessForRecords from 'node:child_process';
import { syncBuiltinESMExports as syncChildProcessRecordExports } from 'node:module';
const CHILD_PROCESS_RECORD_FILE = __RECORD_FILE__;
const CHILD_PROCESS_RECORD_LABEL = __RECORD_LABEL__;
const originalSpawnForRecords = childProcessForRecords.spawn;
childProcessForRecords.spawn = function spawnWithRecord(file, ...rest) {
  const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
  const options = Array.isArray(rest[0]) ? rest[1] : rest[0];
  const hasEnv = options !== null && typeof options === 'object' && options.env !== undefined;
  appendChildProcessRecord(CHILD_PROCESS_RECORD_FILE, JSON.stringify({ process: CHILD_PROCESS_RECORD_LABEL, file: String(file), args, hasEnv }) + '\n');
  return originalSpawnForRecords.call(this, file, ...rest);
};
syncChildProcessRecordExports();
`.split('__RECORD_FILE__').join(JSON.stringify(recordFile)).split('__RECORD_LABEL__').join(JSON.stringify(processLabel));

/** 子プロセスの起動を記録する、テストだけの前処理（`node --import <URL>`）を `path` に書き、その URL を返す。 */
export const writeChildProcessRecordingPreload = (path: string, recordFile: string, processLabel: string): string => {
  writeFileSync(path, childProcessRecordingSource(recordFile, processLabel), 'utf8');
  return pathToFileURL(path).href;
};

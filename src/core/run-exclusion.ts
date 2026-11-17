/**
 * 監査中の印（出力先ごとの排他。SPEC-2 の作り直し。2026-11-14 の設計書 slim-and-simplify 5.2、DEF-057・DEF-269〜271）の唯一の owner。
 * CLI の監査（`src/cli/audit-run.ts`）とワーカーの Run（`src/worker/worker-run-session.ts`・`src/worker/discovery-run.ts`）が、Run の開始の段から
 * 終わりまで持つ。
 * - OS が、持ち主の process の終わり（強制終了を含む）と同時に必ず放す排他を使う。古さを推し量らない（PID・時刻・端末の起動の時刻を見ない）。
 *   - Windows: 名前つきのパイプ（`\\.\pipe\beaksight-run-<digest>`）に listen する。
 *   - Linux: 抽象の名前空間の Unix socket（名前の先頭が `\0`。ファイルを残さない）に listen する。
 *   - ほか（macOS）: 一時のフォルダの Unix socket に listen する（強制終了の後に socket のファイルが残ると、持たれているとみなす。止まる側。
 *     macOS は対象の外）。
 * - 出力先がなければ作ってから取る。`<digest>` は、出力先のディレクトリの `dev` と `ino`（`outputDirectoryIdentity`）の SHA-256 の先頭
 *   （`RUN_EXCLUSION_DIGEST_LENGTH` 桁）。パスの綴り（大文字と小文字、`\\?\`、リンク、8.3 の名前など）によらず、同じディレクトリは同じ排他になる。
 *   `dev` か `ino` が 0 のファイルシステムでは使えない（止まる側）。取った後に読み直し、ディレクトリが変わっていれば（作り直された）離して、持たれて
 *   いるとみなす。
 * - 結果は 3 つ（`RunExclusion`）。取れた（server を持ち続ける）・持たれている（`EADDRINUSE`）・使えない（ほかの誤り。呼ぶ側は止まる）。
 * - 離すときは、取るために作った出力先のディレクトリを、空のときだけ消してから（DEF-081。Run のディレクトリができていれば残る）、server を閉じる。
 *   process が終われば、OS が放す。server は process を生かし続けない（`unref`）。
 * - `node:net` は `createServer` と `listen` だけを使う（送る口は使わない。`write-stage-boundary.test.ts` の (e)）。つないできた相手は、すぐに切る。
 * - 限界: 同じ名前のパイプを、BeakSight の外の process が先に listen すると、閉じるまで取れない（止まる側）。
 */
import { mkdir, rmdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { errorCodeOf } from './errors.js';
import { sha256HexOfText } from './ids.js';

/** パイプ・socket の名前の接頭辞。 */
const RUN_EXCLUSION_NAME_PREFIX = 'beaksight-run-';
/** 名前に使う、出力先のディレクトリの同一性の SHA-256（16 進）の先頭の桁数（128 bit。macOS の socket のパスの長さの上限に収まる）。 */
export const RUN_EXCLUSION_DIGEST_LENGTH = 32;
/** 抽象の名前空間の Unix socket を使う環境（`process.platform` の値）。 */
const ABSTRACT_SOCKET_PLATFORM = 'linux';
/** 名前つきのパイプを使う環境か（Windows。資格情報の Gate (x) の除外。パイプの名前の形を選ぶためで、資格情報の保存とは意味が違う）。 */
const USES_NAMED_PIPES = process.platform === 'win32';
/** 一時のフォルダの Unix socket のファイルの名前の接尾辞。 */
const SOCKET_FILE_SUFFIX = '.sock';
/** 持たれている（ほかの起動が listen している）ことを表す、listen の誤りの `code`。 */
const ADDRESS_IN_USE_CODE = 'EADDRINUSE';

/** 出力先のディレクトリの `dev` と `ino` を読めない（0 のファイルシステム）。排他は使えない（止まる側）。 */
export class OutputDirectoryIdentityUnavailableError extends Error {
  constructor() {
    super('the output directory has no device and file number to name the run exclusion');
    this.name = 'OutputDirectoryIdentityUnavailableError';
  }
}

/**
 * 出力先のディレクトリの同一性（排他の名前の元。この 1 か所だけで決める）。ディレクトリの `dev` と `ino`（`stat` の `bigint`）で、パスの綴りは
 * 使わない。ディレクトリがなければ、`stat` の誤りで reject する。`dev` か `ino` が 0 なら `OutputDirectoryIdentityUnavailableError`。
 */
export async function outputDirectoryIdentity(outputDirectory: string): Promise<string> {
  const { dev, ino } = await stat(outputDirectory, { bigint: true });
  if (dev === 0n || ino === 0n) {
    throw new OutputDirectoryIdentityUnavailableError();
  }
  return `${dev.toString()}:${ino.toString()}`;
}

/** 出力先のディレクトリの同一性（`outputDirectoryIdentity`）の排他の名前（listen するパイプ・socket。ファイルの先頭の説明）。 */
function runExclusionAddressOf(identity: string): string {
  const name = `${RUN_EXCLUSION_NAME_PREFIX}${sha256HexOfText(identity).slice(0, RUN_EXCLUSION_DIGEST_LENGTH)}`;
  if (USES_NAMED_PIPES) {
    return `\\\\.\\pipe\\${name}`;
  }
  return process.platform === ABSTRACT_SOCKET_PLATFORM ? `\0${name}` : join(tmpdir(), `${name}${SOCKET_FILE_SUFFIX}`);
}

/**
 * 取るために作った出力先（`created` は、作ったディレクトリのいちばん上）を、出力先から `created` まで、空のものだけ深い方から消す（DEF-081）。
 * 空でなければ（Run のディレクトリなどがあれば）、そこで止める。消せなくても進む。
 */
async function removeEmptyCreatedDirectories(outputDirectory: string, created: string): Promise<void> {
  const top = resolve(created);
  for (let directory = resolve(outputDirectory); ; directory = dirname(directory)) {
    try {
      await rmdir(directory);
    } catch {
      return;
    }
    if (directory === top || dirname(directory) === directory) {
      return;
    }
  }
}

/** server に listen する。持たれていれば `EADDRINUSE` で reject する。 */
const listenOn = async (server: ReturnType<typeof createServer>, address: string): Promise<void> =>
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(address, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

/** server を閉じる（誤りは無視する）。 */
const closeServer = async (server: ReturnType<typeof createServer>): Promise<void> =>
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });

/**
 * 出力先の排他を取った結果。
 * - `ACQUIRED`: 取れた。Run の終わりに `release` で離す（何回呼んでもよい。reject しない）。
 * - `HELD`: ほかの起動が持っている（`EADDRINUSE`）。Run を始めない。
 * - `UNAVAILABLE`: ほかの誤りで取れなかった（`cause`）。呼ぶ側は止まる（排他なしで Run を進めない）。
 */
export type RunExclusion =
  | { readonly kind: 'ACQUIRED'; readonly release: () => Promise<void> }
  | { readonly kind: 'HELD' }
  | { readonly kind: 'UNAVAILABLE'; readonly cause: unknown };

const RUN_EXCLUSION_HELD: RunExclusion = Object.freeze({ kind: 'HELD' });

/** 出力先（`outputDirectory`）の排他を取る（ファイルの先頭の説明）。reject しない。 */
export async function acquireRunExclusion(outputDirectory: string): Promise<RunExclusion> {
  const server = createServer((socket) => {
    socket.destroy();
  });
  let created: string | undefined;
  let identity: string;
  try {
    created = await mkdir(outputDirectory, { recursive: true });
    identity = await outputDirectoryIdentity(outputDirectory);
    await listenOn(server, runExclusionAddressOf(identity));
  } catch (error) {
    await closeServer(server);
    return errorCodeOf(error) === ADDRESS_IN_USE_CODE ? RUN_EXCLUSION_HELD : Object.freeze<RunExclusion>({ kind: 'UNAVAILABLE', cause: error });
  }
  // 取った後の誤りで process を落とさない（排他は、閉じるか process が終わるまで OS が持つ）。
  server.on('error', () => undefined);
  server.unref();
  let released: Promise<void> | null = null;
  const release = async (): Promise<void> => {
    released ??= (async () => {
      // 作った出力先を消すのは、持っている間だけ（ほかの起動が同じディレクトリを持っている間に消さない）。
      if (created !== undefined) {
        await removeEmptyCreatedDirectories(outputDirectory, created);
      }
      await closeServer(server);
    })();
    await released;
  };
  // 取った後に読み直す。前の持ち主が空の出力先を消した後なら、別のディレクトリなので、離して持たれているとみなす（止まる側）。
  const current = await outputDirectoryIdentity(outputDirectory).catch(() => null);
  if (current !== identity) {
    created = undefined;
    await release();
    return RUN_EXCLUSION_HELD;
  }
  return Object.freeze({ kind: 'ACQUIRED', release });
}

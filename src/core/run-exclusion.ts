/**
 * 監査中の印（出力先 + 対象の ID ごとの排他。SPEC-2 の作り直し。2026-11-14 の設計書 slim-and-simplify 5.2、DEF-057・DEF-269〜271。対象の ID を
 * 足したのは 2026-11-17 の設計書 parallel-site-audits の PAR-a。出力先を共有する別のサイトの Run は、同時に取れる）の唯一の owner。
 * CLI の監査（`src/cli/audit-run.ts`）とワーカーの Run（`src/worker/worker-run-session.ts`・`src/worker/discovery-run.ts`）が、Run の開始の段から
 * 終わりまで持つ。
 * - OS が、持ち主の process の終わり（強制終了を含む）と同時に必ず放す排他を使う。古さを推し量らない（PID・時刻・端末の起動の時刻を見ない）。
 *   - Windows: 名前つきのパイプ（`\\.\pipe\beaksight-run-<digest>`）に listen する。
 *   - Linux: 抽象の名前空間の Unix socket（名前の先頭が `\0`。ファイルを残さない）に listen する。
 *   - ほか（macOS）: 一時のフォルダの Unix socket に listen する（強制終了の後に socket のファイルが残ると、持たれているとみなす。止まる側。
 *     macOS は対象の外）。
 * - 出力先がなければ作ってから取る。`<digest>` は、出力先のディレクトリの `dev` と `ino`（`outputDirectoryIdentity`）と対象の ID の SHA-256 の先頭
 *   （`RUN_EXCLUSION_DIGEST_LENGTH` 桁）。パスの綴り（大文字と小文字、`\\?\`、リンク、8.3 の名前など）によらず、同じディレクトリは同じ排他になる。
 *   `dev` か `ino` が 0 のファイルシステムでは使えない（止まる側）。取った後に読み直し、ディレクトリが変わっていれば（作り直された）離して、持たれて
 *   いるとみなす。
 * - 結果は 3 つ（`RunExclusion`）。取れた（server を持ち続ける）・持たれている（`EADDRINUSE`）・使えない（ほかの誤り。呼ぶ側は止まる）。
 * - 離すときは、server を閉じる。process が終われば、OS が放す。server は process を生かし続けない（`unref`）。REV-PAR の m-1: 出力先は別の対象の起動と
 *   共有するので、取るために作った出力先も消さない（前の DEF-081 の後始末はやめた。別の対象の起動が持つ出力先を消して作り直させない）。
 * - `node:net` は `createServer` と `listen` だけを使う（送る口は使わない。`write-stage-boundary.test.ts` の (e)）。つないできた相手は、すぐに切る。
 * - 限界: 同じ名前のパイプを、BeakSight の外の process が先に listen すると、閉じるまで取れない（止まる側）。
 */
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * 出力先のディレクトリの同一性（`outputDirectoryIdentity`）と対象の ID（設定の `target.id`）の排他の名前（listen するパイプ・socket。ファイルの
 * 先頭の説明）。2 つの値は、区切りが紛れない JSON の配列にしてから digest にする。
 */
function runExclusionAddressOf(identity: string, targetId: string): string {
  const name = `${RUN_EXCLUSION_NAME_PREFIX}${sha256HexOfText(JSON.stringify([identity, targetId])).slice(0, RUN_EXCLUSION_DIGEST_LENGTH)}`;
  if (USES_NAMED_PIPES) {
    return `\\\\.\\pipe\\${name}`;
  }
  return process.platform === ABSTRACT_SOCKET_PLATFORM ? `\0${name}` : join(tmpdir(), `${name}${SOCKET_FILE_SUFFIX}`);
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

/** 出力先（`outputDirectory`）と対象の ID（`targetId`）の排他を取る（ファイルの先頭の説明）。reject しない。 */
export async function acquireRunExclusion(outputDirectory: string, targetId: string): Promise<RunExclusion> {
  const server = createServer((socket) => {
    socket.destroy();
  });
  let identity: string;
  try {
    await mkdir(outputDirectory, { recursive: true });
    identity = await outputDirectoryIdentity(outputDirectory);
    await listenOn(server, runExclusionAddressOf(identity, targetId));
  } catch (error) {
    await closeServer(server);
    return errorCodeOf(error) === ADDRESS_IN_USE_CODE ? RUN_EXCLUSION_HELD : Object.freeze<RunExclusion>({ kind: 'UNAVAILABLE', cause: error });
  }
  // 取った後の誤りで process を落とさない（排他は、閉じるか process が終わるまで OS が持つ）。
  server.on('error', () => undefined);
  server.unref();
  let released: Promise<void> | null = null;
  // REV-PAR の m-1: 出力先は消さない（別の対象の起動と共有する）。
  const release = async (): Promise<void> => {
    released ??= closeServer(server);
    await released;
  };
  // 取った後に読み直す。出力先が消されて作り直された後なら、別のディレクトリなので、離して持たれているとみなす（止まる側）。
  const current = await outputDirectoryIdentity(outputDirectory).catch(() => null);
  if (current !== identity) {
    await release();
    return RUN_EXCLUSION_HELD;
  }
  return Object.freeze({ kind: 'ACQUIRED', release });
}

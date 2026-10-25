/**
 * ローカルの管理画面の起動の部品（Task 23 設計書 3.2、4.4、4.6。T23b で作り、T23e で守りを、T23f で管理データの準備を足した）。
 * - Nitro を使わない。Vite のビルドの出力 `apps/local-ui/dist/server/server.js` の `fetch` に、`node:http` で中継する。
 * - 待ち受けは `127.0.0.1` だけ（設定で変えない）。port が使用中なら、別の port を選ばずに止める。
 * - すべての要求に、まず要求の守りの部品（`request-guard.ts`。Host、token と cookie、応答の header、CSP の nonce）を掛ける。
 * - 守りを通った要求だけ、`apps/local-ui/dist/client` の中のファイルを static で配るか、`fetch` へ中継する。外へ出るパスは配らない。
 * - 中継の URL の origin は、いつも `http://127.0.0.1:<port>`（Host は守りの部品で確かめ済み）。
 * - 待ち受けの前に、ビルドした画面のサーバの入口（`dist/server/launcher-bridge.js`）を通して管理データを準備する。失敗したら、
 *   `npm run setup:local` と同じ説明を出し、待ち受けずに 0 でない終了コードで止まる。終わるとき（SIGINT、SIGTERM）は閉じる。
 * - 管理データの準備の後、待ち受けの前に、監査のジョブの管理を作り、前の画面のサーバで終わっていなかったジョブを中断に直す（Task 24 の
 *   設計書 4.4。T24f）。終わるとき（SIGINT、SIGTERM）は、2 段の扱い（`shutdown.ts`）で、動いているジョブを止めてから閉じる（1 回目は
 *   名前つきの時間だけ待つ。2 回目は待たずに終える）。
 * - 待ち受けの前に、資格情報のフォルダに残った一時のファイルを消し、暗号化が使えるかを 1 回確かめる（Task 26 の設計書 4.1。T26e。使えなくても
 *   起動は止めない）。
 * - 利用者に見せる文言（拒否の応答、コンソール）は `src/presentation/messages.ts` のもの（同じ入口から受け取る。起動の部品は Node の型の
 *   除去で動き、`src/` の TypeScript を直接読めないため）。
 *
 * 起動: `node apps/local-ui/launcher/serve.ts [--port <番号>]`（Node の型の除去で実行する。消せる型の書き方だけを使う）。
 * 起動ごとの token の URL は、コンソールにだけ表示する（ログやファイルに書かない）。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { UiServerEndReason } from '../../../src/control/ui-server-log.ts';
import type { LocalUiStartFailure } from '../../../src/presentation/messages.ts';
import type * as LauncherBridge from '../src/server/launcher-bridge.ts';
import {
  UI_PRESENCE_CHECK_INTERVAL_MS,
  UI_PRESENCE_CLOSED_GRACE_MS,
  UI_PRESENCE_SILENCE_LIMIT_MS,
} from '../src/security/ui-presence.ts';
import { errorMessageOrString } from './error-message.ts';
import { createPresenceMonitor, handlePresenceRequest, type PresenceMonitor } from './presence.ts';
import { LOCAL_UI_LISTEN_HOST, createSessionToken, formatTokenUrl, guardNodeRequest, type LocalUiGuardOptions } from './request-guard.ts';
import { createTwoStepShutdown } from './shutdown.ts';

/** 既定の port。使用中なら止める（別の port を自動で選ばない）。 */
export const LOCAL_UI_DEFAULT_PORT = 4317;

/** 使える port の上限。 */
const MAX_PORT = 65_535;

/** 管理データを準備できなかったときの終了コード（`npm run setup:local` と同じ 1）。 */
const PREPARATION_FAILED_EXIT_CODE = 1;

/** 起動できなかったとき（port、待ち受け）の終了コード（準備の失敗と同じ 1）。 */
const START_FAILED_EXIT_CODE = 1;

/** 中継で誤りが起きたときの状態。 */
const INTERNAL_SERVER_ERROR = 500;

/** static の配信の成功の状態。 */
const OK = 200;

/** `apps/local-ui/dist/`（ビルドの出力の置き場所）。 */
const DIST_DIRECTORY = fileURLToPath(new URL('../dist/', import.meta.url));

/** static で配るフォルダ。 */
const CLIENT_DIRECTORY = resolve(DIST_DIRECTORY, 'client');

/** TanStack Start のサーバの入口。 */
const SERVER_ENTRY_PATH = resolve(DIST_DIRECTORY, 'server', 'server.js');

/** 起動の部品が読む、画面のサーバの 2 つ目の入口（管理データの準備と文言）。 */
const LAUNCHER_BRIDGE_PATH = resolve(DIST_DIRECTORY, 'server', 'launcher-bridge.js');

/** 2 つ目の入口の形（型だけを `src/server/launcher-bridge.ts` から取る）。 */
type Bridge = Pick<
  typeof LauncherBridge,
  | 'prepareLocalUiStore'
  | 'closeLocalUiStore'
  | 'prepareLocalUiAuditJobs'
  | 'prepareLocalUiCredentials'
  | 'runningLocalUiAuditJobCount'
  | 'shutdownLocalUiAuditJobs'
  | 'AUDIT_JOB_SHUTDOWN_WAIT_MS'
  | 'formatCount'
  | 'formatDuration'
  | 'LOCAL_UI_GUARD_REJECTION_TEXT'
  | 'LOCAL_UI_CONSOLE_TEXT'
  | 'LOCAL_UI_JOB_CONSOLE_TEXT'
  | 'describeLocalUiStartFailure'
  | 'recordLocalUiServerUnexpectedError'
  | 'recordLocalUiServerShutdown'
  | 'recordLocalUiServerExit'
  | 'setLocalUiServerLogSecrets'
>;

/** static で配るファイルの拡張子と Content-Type。ここにない拡張子は配らない。 */
const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
});

/** ビルドの出力のサーバの入口の形（`export default { fetch }`）。 */
interface ServerEntry {
  readonly fetch: (request: Request) => Response | Promise<Response>;
}

/** 起動した画面のサーバ。 */
export interface LocalUiServer {
  readonly port: number;
  readonly origin: string;
  /** コンソールに表示する token の URL（ログやファイルに書かない）。 */
  readonly tokenUrl: string;
  close(): Promise<void>;
}

function isBridge(value: unknown): value is Bridge {
  return typeof value === 'object' && value !== null
    && 'prepareLocalUiStore' in value && typeof value.prepareLocalUiStore === 'function'
    && 'closeLocalUiStore' in value && typeof value.closeLocalUiStore === 'function'
    && 'prepareLocalUiAuditJobs' in value && typeof value.prepareLocalUiAuditJobs === 'function'
    && 'prepareLocalUiCredentials' in value && typeof value.prepareLocalUiCredentials === 'function'
    && 'runningLocalUiAuditJobCount' in value && typeof value.runningLocalUiAuditJobCount === 'function'
    && 'shutdownLocalUiAuditJobs' in value && typeof value.shutdownLocalUiAuditJobs === 'function'
    && 'AUDIT_JOB_SHUTDOWN_WAIT_MS' in value && typeof value.AUDIT_JOB_SHUTDOWN_WAIT_MS === 'number'
    && 'formatCount' in value && typeof value.formatCount === 'function'
    && 'formatDuration' in value && typeof value.formatDuration === 'function'
    && 'LOCAL_UI_JOB_CONSOLE_TEXT' in value && typeof value.LOCAL_UI_JOB_CONSOLE_TEXT === 'object'
    && 'LOCAL_UI_GUARD_REJECTION_TEXT' in value && typeof value.LOCAL_UI_GUARD_REJECTION_TEXT === 'object'
    && 'LOCAL_UI_CONSOLE_TEXT' in value && typeof value.LOCAL_UI_CONSOLE_TEXT === 'object'
    && 'describeLocalUiStartFailure' in value && typeof value.describeLocalUiStartFailure === 'function'
    && 'recordLocalUiServerUnexpectedError' in value && typeof value.recordLocalUiServerUnexpectedError === 'function'
    && 'recordLocalUiServerShutdown' in value && typeof value.recordLocalUiServerShutdown === 'function'
    && 'recordLocalUiServerExit' in value && typeof value.recordLocalUiServerExit === 'function'
    && 'setLocalUiServerLogSecrets' in value && typeof value.setLocalUiServerLogSecrets === 'function';
}

/** 2 つ目の入口を読み込む。 */
async function loadBridge(): Promise<Bridge> {
  const module: unknown = await import(pathToFileURL(LAUNCHER_BRIDGE_PATH).href);
  if (!isBridge(module)) {
    throw new Error(`unexpected shape of the build output (launcher bridge): ${LAUNCHER_BRIDGE_PATH}`);
  }
  return module;
}

function isServerEntry(value: unknown): value is ServerEntry {
  return typeof value === 'object' && value !== null && 'fetch' in value && typeof value.fetch === 'function';
}

/** ビルドの出力のサーバの入口を読み込む。 */
async function loadServerEntry(): Promise<ServerEntry> {
  const module: unknown = await import(pathToFileURL(SERVER_ENTRY_PATH).href);
  const entry = typeof module === 'object' && module !== null && 'default' in module ? module.default : undefined;
  if (!isServerEntry(entry)) {
    throw new Error(`unexpected shape of the build output (no fetch): ${SERVER_ENTRY_PATH}`);
  }
  return entry;
}

/**
 * URL のパスから、`dist/client` の中のファイルのパスを求める。外へ出るパス、解けないパス、配らない拡張子は `null`。
 */
function resolveStaticFilePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) {
    return null;
  }
  const candidate = resolve(CLIENT_DIRECTORY, `.${decoded}`);
  const fromRoot = relative(CLIENT_DIRECTORY, candidate);
  if (fromRoot === '' || fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    return null;
  }
  if (STATIC_CONTENT_TYPES[extname(candidate).toLowerCase()] === undefined) {
    return null;
  }
  return join(CLIENT_DIRECTORY, fromRoot);
}

/** static のファイルがあれば配って `true` を返す。なければ `false`。 */
async function tryServeStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false;
  }
  const filePath = resolveStaticFilePath(pathname);
  if (filePath === null) {
    return false;
  }
  const fileStat = await stat(filePath).catch(() => null);
  if (fileStat === null || !fileStat.isFile()) {
    return false;
  }
  const contentType = STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  response.writeHead(OK, { 'Content-Type': contentType, 'Content-Length': String(fileStat.size) });
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  await pipeline(createReadStream(filePath), response);
  return true;
}

/** Node の要求を、Fetch の `Request` にする（守りの部品が入れた nonce の header を含む）。 */
function toFetchRequest(request: IncomingMessage, origin: string): Request {
  const url = new URL(request.url ?? '/', origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  const method = request.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** Fetch の `Response` を、Node の応答に書く（守りの header は `writeHead` の直前に付け直される）。 */
async function writeFetchResponse(fetchResponse: Response, response: ServerResponse, method: string): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  fetchResponse.headers.forEach((value, name) => {
    if (name !== 'set-cookie') {
      headers[name] = value;
    }
  });
  const cookies = fetchResponse.headers.getSetCookie();
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies;
  }
  response.writeHead(fetchResponse.status, fetchResponse.statusText, headers);
  if (fetchResponse.body === null || method === 'HEAD') {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(fetchResponse.body as import('node:stream/web').ReadableStream<Uint8Array>), response);
}

/**
 * 画面のサーバを `127.0.0.1:<port>` で起動する（管理データは準備済みであること）。port が使用中なら失敗する。UI-close: 要求の守りを通った要求の
 * うち、管理画面のページの知らせの口（`presence.ts`）は、`presence`（止める決まりの判定）へ渡す。
 */
export async function startLocalUiServer(
  bridge: Bridge,
  port: number = LOCAL_UI_DEFAULT_PORT,
  presence: PresenceMonitor | null = null,
): Promise<LocalUiServer> {
  const entry = await loadServerEntry();
  const origin = `http://${LOCAL_UI_LISTEN_HOST}:${port}`;
  const guard: LocalUiGuardOptions = { port, token: createSessionToken(), rejectionText: bridge.LOCAL_UI_GUARD_REJECTION_TEXT };
  // DEF-146: token（URL の値と cookie の値）は、終わりの記録のファイルに書かない値として渡す。
  bridge.setLocalUiServerLogSecrets([guard.token]);
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        if (!guardNodeRequest(guard, request, response)) {
          return;
        }
        if (handlePresenceRequest(presence, origin, request, response)) {
          return;
        }
        const pathname = new URL(request.url ?? '/', origin).pathname;
        if (await tryServeStatic(request, response, pathname)) {
          return;
        }
        const fetchResponse = await entry.fetch(toFetchRequest(request, origin));
        await writeFetchResponse(fetchResponse, response, request.method ?? 'GET');
      } catch (error: unknown) {
        console.error(bridge.LOCAL_UI_CONSOLE_TEXT.requestFailed, error instanceof Error ? error.message : error);
        if (!response.headersSent) {
          response.writeHead(INTERNAL_SERVER_ERROR, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        response.end();
      }
    })();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen({ host: LOCAL_UI_LISTEN_HOST, port, exclusive: true }, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  return {
    port,
    origin,
    tokenUrl: formatTokenUrl(port, guard.token),
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
        server.closeAllConnections();
      }),
  };
}

/** port の引数の読み取りの結果。 */
type PortArgument = { readonly ok: true; readonly port: number } | { readonly ok: false; readonly value: string };

/** 10 進の数字だけの port の値。 */
const PORT_ARGUMENT_PATTERN = /^\d+$/u;

/** コマンドの引数から port を読む（`--port <番号>`）。番号でない値、範囲の外の値は誤り。 */
function parsePortArgument(argv: readonly string[]): PortArgument {
  const index = argv.indexOf('--port');
  if (index === -1) {
    return { ok: true, port: LOCAL_UI_DEFAULT_PORT };
  }
  const raw = argv[index + 1] ?? '';
  const port = PORT_ARGUMENT_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    return { ok: false, value: raw };
  }
  return { ok: true, port };
}

/**
 * UI-close: 止める決まりの時間の引数（`--ui-close-grace-ms <ms>`、`--ui-silence-limit-ms <ms>`、`--ui-presence-check-ms <ms>`）を読む。テストが短い値を
 * 注入するためのもの。ない・正の整数でない値は、名前つきの既定（`src/security/ui-presence.ts`）にする。
 */
function durationArgument(argv: readonly string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  const raw = index === -1 ? '' : argv[index + 1] ?? '';
  const value = PORT_ARGUMENT_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 待ち受けの失敗を、起動できなかった理由にする（T23h の M2）。 */
function listenFailureOf(error: unknown, port: number): LocalUiStartFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'EADDRINUSE') {
    return { kind: 'PORT_IN_USE', port };
  }
  if (code === 'EACCES') {
    return { kind: 'PORT_PERMISSION_DENIED', port };
  }
  return { kind: 'START_FAILED', detail: errorMessageOrString(error) };
}

/** 起動できなかった理由を出して、0 でない終了コードにする。 */
function reportStartFailure(bridge: Bridge, failure: LocalUiStartFailure): void {
  for (const line of bridge.describeLocalUiStartFailure(failure)) {
    console.error(line);
  }
  process.exitCode = START_FAILED_EXIT_CODE;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  let bridge: Bridge | undefined;
  try {
    bridge = await loadBridge();
  } catch (error: unknown) {
    // 文言は画面のサーバの入口から受け取るので、入口を読めないとき（ビルドしていない）だけは英語の技術的な詳細を出す。
    console.error('the local UI build output could not be loaded (run npm run build:ui):', error instanceof Error ? error.message : error);
    process.exitCode = START_FAILED_EXIT_CODE;
  }
  if (bridge !== undefined) {
    const logBridge = bridge;
    // DEF-146: 予期しない例外（uncaughtException・unhandledRejection）で終わるときと、終わりの記録のないまま process が終わるときを、終わりの記録の
    // ファイルに書く（`uncaughtExceptionMonitor` は、Node の既定の落ち方を変えない）。
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      logBridge.recordLocalUiServerUnexpectedError(origin, error, logBridge.runningLocalUiAuditJobCount());
    });
    process.on('exit', (code) => {
      logBridge.recordLocalUiServerExit(code, logBridge.runningLocalUiAuditJobCount());
    });
    const portArgument = parsePortArgument(process.argv.slice(2));
    if (!portArgument.ok) {
      reportStartFailure(bridge, { kind: 'PORT_INVALID', value: portArgument.value });
    } else {
      // 待ち受けの前に、管理データを準備する（失敗したら待ち受けない）。
      const preparation = bridge.prepareLocalUiStore();
      if (!preparation.ok) {
        for (const line of preparation.lines) {
          console.error(line);
        }
        process.exitCode = PREPARATION_FAILED_EXIT_CODE;
      } else {
        const ready = bridge;
        let recovered: number | undefined;
        try {
          // 待ち受けの前に、監査のジョブの管理を作り（画面のサーバを 1 つだけにする管理のロックを取ってから。DEF-061。T24h-4）、前の画面の
          // サーバで終わっていなかったジョブを中断に直す（T24f）。ほかの画面のサーバが動いていれば、何も書き換えずに、待ち受けずに止まる。
          const jobs = ready.prepareLocalUiAuditJobs(portArgument.port);
          if (jobs.ok) {
            recovered = jobs.recovered;
          } else {
            for (const line of jobs.lines) {
              console.error(line);
            }
            ready.closeLocalUiStore();
            process.exitCode = START_FAILED_EXIT_CODE;
          }
        } catch (error: unknown) {
          ready.closeLocalUiStore();
          reportStartFailure(ready, { kind: 'START_FAILED', detail: errorMessageOrString(error) });
        }
        if (recovered !== undefined) {
          try {
            // T26e（Task 26 の設計書 4.1 の「起動のとき」）: 資格情報のフォルダに残った一時のファイルを消し、暗号化が使えるかを 1 回確かめる
            // （結果は環境の状態の画面に出す。使えなくても起動は止めない。例外を投げない）。
            await ready.prepareLocalUiCredentials();
            // UI-close: 管理画面のブラウザが閉じられ、動いているジョブがなければ、Ctrl+C と同じ止め方（1 回目）で止める。
            const argv = process.argv.slice(2);
            let stopWhenClosed: (() => void) | undefined;
            const presence = createPresenceMonitor({
              closedGraceMs: durationArgument(argv, '--ui-close-grace-ms', UI_PRESENCE_CLOSED_GRACE_MS),
              silenceLimitMs: durationArgument(argv, '--ui-silence-limit-ms', UI_PRESENCE_SILENCE_LIMIT_MS),
              runningJobCount: ready.runningLocalUiAuditJobCount,
              onIdle: () => {
                console.log(ready.LOCAL_UI_CONSOLE_TEXT.closedByUi);
                stopWhenClosed?.();
              },
            });
            const server = await startLocalUiServer(ready, portArgument.port, presence);
            if (recovered > 0) {
              console.log(ready.LOCAL_UI_JOB_CONSOLE_TEXT.recoveredJobs(ready.formatCount(recovered)));
            }
            console.log(ready.LOCAL_UI_CONSOLE_TEXT.tokenUrl(server.tokenUrl));
            console.log(ready.LOCAL_UI_CONSOLE_TEXT.tokenNotice);
            const stop = createTwoStepShutdown<UiServerEndReason>({
              runningJobCount: ready.runningLocalUiAuditJobCount,
              text: {
                jobsStopping: ready.LOCAL_UI_JOB_CONSOLE_TEXT.jobsStopping(ready.formatDuration(ready.AUDIT_JOB_SHUTDOWN_WAIT_MS)),
                exitingNow: ready.LOCAL_UI_JOB_CONSOLE_TEXT.exitingNow,
              },
              log: (line) => console.log(line),
              shutdownJobs: () => ready.shutdownLocalUiAuditJobs(),
              closeServer: () => server.close(),
              closeStore: ready.closeLocalUiStore,
              exit: (code) => process.exit(code),
              // DEF-146: 止める決まりの終わり（終わり方と、動いていたジョブの数）を、終わりの記録のファイルに書く。
              recordEnd: (reason, immediate, runningJobs) => ready.recordLocalUiServerShutdown(reason ?? 'OTHER', immediate, runningJobs),
            });
            process.on('SIGINT', () => stop('CTRL_C'));
            process.on('SIGTERM', () => stop('SIGTERM'));
            stopWhenClosed = () => stop('UI_CLOSED');
            setInterval(() => presence.check(), durationArgument(argv, '--ui-presence-check-ms', UI_PRESENCE_CHECK_INTERVAL_MS)).unref();
          } catch (error: unknown) {
            await ready.shutdownLocalUiAuditJobs(0);
            ready.closeLocalUiStore();
            reportStartFailure(ready, listenFailureOf(error, portArgument.port));
          }
        }
      }
    }
  }
}

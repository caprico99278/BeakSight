/**
 * 画面のサーバのテストの補助（T23e、T23f）。一時の root、子の process の起動と停止、空きの port、Host を自由に指定できる HTTP の要求。
 * - サーバは 127.0.0.1 だけで待ち受ける。外部へは繋がない。
 * - 起動の部品がコンソールに出す `?token=` の URL を、子の process の標準出力から読む（token はテストの中だけで使い、書き出さない）。
 * - T24f: 一時の root（`built`）には、監査の本体のビルドの出力（`dist/`）も写す。画面のサーバが起動する監査のワーカーは、一時の root の
 *   `dist/worker/audit-worker.js` で、cwd は一時の root（設定のファイルと出力先は、一時の root の中だけ）。
 * - 画面のサーバは、起動の初めに、自分の場所から決めたリポジトリの root の `local-data/` に管理データを準備する。テストは、リポジトリの
 *   外の一時のフォルダ（OS の一時のフォルダ）に、画面の起動に要るものを写して起動する（`createTemporaryUiRoot`）。リポジトリの
 *   `local-data/` を作らない。データの場所を変える口（引数、環境変数）は、製品にもテストにもない。
 * - 一時の root の `node_modules` は、リポジトリの `node_modules` への junction（依存のパッケージを読むため）。片付けでは、junction を
 *   先に外してから（リンクの先をたどらずに）、一時のフォルダを消す。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** リポジトリの root（区切りは `/`、末尾の `/` なし）。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/u, '');

/** 待ち受けのアドレス。 */
export const LOOPBACK_HOST = '127.0.0.1';

/** 子の process の起動を待つ上限（ミリ秒）。 */
export const SERVER_STARTUP_TIMEOUT_MS = 60_000;

/** Vite の CLI。 */
const VITE_CLI = `${REPO_ROOT}/node_modules/vite/bin/vite.js`;

/** ビルドの出力のサーバの入口（テストの前に `npm run build:ui` が要る）。 */
export const BUILT_SERVER_ENTRY = `${REPO_ROOT}/apps/local-ui/dist/server/server.js`;

/**
 * 監査の本体のビルドの出力の、監査のワーカーの入口（テストの前に `npm run build` が要る。T24f）。一時の root に `dist/` を写し、画面のサーバは
 * 一時の root の `dist/worker/audit-worker.js` を起動する（リポジトリの `dist/` を直接は使わない）。
 */
export const BUILT_WORKER_ENTRY = `${REPO_ROOT}/dist/worker/audit-worker.js`;

/** 一時の root に写す、例の設定のファイル（リポジトリの root から。`local/` は使わない）。 */
export const EXAMPLE_TARGET_CONFIG = 'config/targets/example.json';

/** コンソールの `?token=` の URL。 */
const TOKEN_URL_PATTERN = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/u;

/** ANSI の色の指定。 */
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/gu;

/**
 * 一時の root の種類（`built`: ビルドした画面と起動の部品、`source`: 開発のサーバに要るソース、`combined`: 両方。同じ管理データで、本番の
 * 起動の部品と開発のサーバを動かす。T24h-4）。
 */
export type TemporaryUiRootKind = 'built' | 'source' | 'combined';

/** 一時の root。 */
export interface TemporaryUiRoot {
  /** 一時の root（区切りは `/`）。 */
  readonly root: string;
  readonly kind: TemporaryUiRootKind;
  /** 片付け（junction を外してから消す）。 */
  readonly remove: () => void;
}

const copyFromRepository = (root: string, relativePath: string, filter?: (source: string) => boolean): void => {
  cpSync(`${REPO_ROOT}/${relativePath}`, `${root}/${relativePath}`, { recursive: true, ...(filter === undefined ? {} : { filter }) });
};

/** 開発のサーバのために写さないもの（ビルドの出力、Vite の cache）。 */
const isCopiedSource = (source: string): boolean => !/\/apps\/local-ui\/(?:dist|node_modules)(?:\/|$)/u.test(source.replaceAll('\\', '/'));

/** 画面の起動に要るものを、OS の一時のフォルダに写す（`local-data/` は作らない。画面のサーバが作る）。 */
export const createTemporaryUiRoot = (kind: TemporaryUiRootKind): TemporaryUiRoot => {
  if (kind !== 'source' && !existsSync(BUILT_SERVER_ENTRY)) {
    throw new Error('ビルドの出力がない。先に `npm run build:ui` を実行する');
  }
  if (kind !== 'source' && !existsSync(BUILT_WORKER_ENTRY)) {
    throw new Error('監査の本体のビルドの出力がない。先に `npm run build` を実行する');
  }
  const root = mkdtempSync(join(tmpdir(), 'beaksight-local-ui-')).replaceAll('\\', '/');
  const junction = `${root}/node_modules`;
  const remove = (): void => {
    if (existsSync(junction) && lstatSync(junction).isSymbolicLink()) {
      unlinkSync(junction);
    }
    if (existsSync(junction)) {
      throw new Error('一時の root の node_modules の junction を外せなかった（消さずに止める）');
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    copyFromRepository(root, 'package.json');
    mkdirSync(`${root}/config/targets`, { recursive: true });
    copyFromRepository(root, EXAMPLE_TARGET_CONFIG);
    if (kind === 'built') {
      // 監査のワーカー（T24f）: 監査の本体のビルドの出力（`dist/`。スキーマを含む）を写す。ワーカーは一時の root を cwd にして動く。
      copyFromRepository(root, 'dist');
      copyFromRepository(root, 'apps/local-ui/dist');
      copyFromRepository(root, 'apps/local-ui/launcher');
      copyFromRepository(root, 'apps/local-ui/src/security');
    } else {
      if (kind === 'combined') {
        // 本番の起動の部品の分（起動の部品と src/security は、開発のサーバの分の写しに入る）。
        copyFromRepository(root, 'dist');
        copyFromRepository(root, 'apps/local-ui/dist');
      }
      copyFromRepository(root, 'tsconfig.json');
      copyFromRepository(root, 'src');
      copyFromRepository(root, 'schemas');
      copyFromRepository(root, 'apps/local-ui', isCopiedSource);
      // Vite の deps の cache（`node_modules/.vite`）と config の一時のファイルは、package の root に作られる。一時の root の
      // `apps/local-ui` を package の root にして、junction の先（リポジトリの `node_modules`）に書かないようにする（T23h の M4）。
      writeFileSync(`${root}/apps/local-ui/package.json`, `${JSON.stringify({ name: 'beaksight-local-ui-test-root', private: true, type: 'module' })}\n`);
    }
    symlinkSync(`${REPO_ROOT}/node_modules`, junction, 'junction');
  } catch (error) {
    remove();
    throw error;
  }
  return { root, kind, remove };
};

/** 同時に動くほかのテスト（リポジトリの vitest）が書く場所。比べる対象から除く。 */
const VITEST_CACHE_ENTRY = 'vitest';

/**
 * リポジトリの `node_modules/.vite` の様子（名前と更新の時刻の一覧。中身は読まない）。画面のテストが、ここに Vite の deps の cache を
 * 書かないことの確かめに使う（T23h の M4）。リポジトリの vitest が書く `vitest/` は除く。
 */
export const snapshotRepositoryViteCache = (): string => {
  const directory = `${REPO_ROOT}/node_modules/.vite`;
  if (!existsSync(directory)) {
    return 'absent';
  }
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => `${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`)
    .filter((path) => !path.slice(directory.length + 1).startsWith(VITEST_CACHE_ENTRY))
    .sort()
    .map((path) => `${path}@${statSync(path).mtimeMs}`)
    .join('\n');
};

/** 空きの port を 1 つ得る（127.0.0.1 で 0 を listen して閉じる）。 */
export const findFreePort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });

/** 起動した子の process と、コンソールに出た token の URL。 */
export interface StartedServer {
  readonly child: ChildProcess;
  readonly port: number;
  readonly origin: string;
  readonly tokenUrl: URL;
  readonly output: () => string;
}

/** 子の process を起動し、標準出力か標準エラーに token の URL が出るまで待つ。 */
const startProcess = async (args: readonly string[], port: number, cwd: string): Promise<StartedServer> => {
  const child = spawn(process.execPath, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    output += chunk;
  });
  const tokenUrl = await new Promise<URL>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      // 起動を待てなかった process も止める（残さない）。
      void stopServer({ child, port, origin: '', tokenUrl: new URL(`http://${LOOPBACK_HOST}/`), output: () => output })
        .finally(() => rejectUrl(new Error('サーバの起動の待ちが時間切れ')));
    }, SERVER_STARTUP_TIMEOUT_MS);
    const check = (): void => {
      const match = TOKEN_URL_PATTERN.exec(output.replace(ANSI_ESCAPE_PATTERN, ''));
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolveUrl(new URL(match[1]));
      }
    };
    child.stdout?.on('data', check);
    child.stderr?.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`サーバが終了した（code=${String(code)}）`));
    });
  });
  return { child, port, origin: `http://${LOOPBACK_HOST}:${port}`, tokenUrl, output: () => output };
};

/** 一時の root の起動の部品の入口。 */
const launcherEntryOf = (root: TemporaryUiRoot): string => `${root.root}/apps/local-ui/launcher/serve.ts`;

/** ビルドした画面を、一時の root の起動の部品（`launcher/serve.ts`）で起動する。 */
export const startLauncher = async (root: TemporaryUiRoot, port: number): Promise<StartedServer> =>
  startProcess([launcherEntryOf(root), '--port', String(port)], port, root.root);

/**
 * T26e: Node の起動の引数（`--import <テストだけの前処理>` など）を前に付けて、起動の部品を起動する（Windows でない環境を、プラットフォームの
 * 値を差し替えて確かめるため。製品の起動の部品は変えない）。
 */
export const startLauncherWithNodeArguments = async (root: TemporaryUiRoot, port: number, nodeArguments: readonly string[]): Promise<StartedServer> =>
  startProcess([...nodeArguments, launcherEntryOf(root), '--port', String(port)], port, root.root);

/** 終わるまで待った子の process の結果。 */
export interface ExitedProcess {
  readonly status: number | null;
  readonly output: string;
}

const runUntilExit = (args: readonly string[], cwd: string): ExitedProcess => {
  const result = spawnSync(process.execPath, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: SERVER_STARTUP_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

/** 開発のサーバ（Vite）を、引数を付けて動かし、終わるまで待つ（起動を止める場合の確かめ。T23h）。 */
export const runDevServerUntilExit = (root: TemporaryUiRoot, args: readonly string[]): ExitedProcess =>
  runUntilExit([VITE_CLI, 'dev', `${root.root}/apps/local-ui`, ...args], root.root);

/** Vite の preview を、引数を付けて動かし、終わるまで待つ（起動を止めることの確かめ。T23i）。 */
export const runPreviewUntilExit = (root: TemporaryUiRoot, args: readonly string[]): ExitedProcess =>
  runUntilExit([VITE_CLI, 'preview', `${root.root}/apps/local-ui`, ...args], root.root);

/** 起動の部品を、引数を付けて動かし、終わるまで待つ（待ち受けずに止まる場合の確かめ）。 */
export const runLauncherWithArgumentsUntilExit = (root: TemporaryUiRoot, args: readonly string[]): ExitedProcess =>
  runUntilExit([launcherEntryOf(root), ...args], root.root);

/** 起動の部品を動かし、終わるまで待つ（待ち受けずに止まる場合の確かめ）。 */
export const runLauncherUntilExit = (root: TemporaryUiRoot, port: number): { readonly status: number | null; readonly output: string } => {
  const result = spawnSync(process.execPath, [launcherEntryOf(root), '--port', String(port)], {
    cwd: root.root,
    encoding: 'utf8',
    timeout: SERVER_STARTUP_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

/** 一時の root で、開発のサーバ（Vite）を起動する。 */
export const startDevServer = async (root: TemporaryUiRoot, port: number): Promise<StartedServer> =>
  startProcess([VITE_CLI, 'dev', `${root.root}/apps/local-ui`, '--port', String(port)], port, root.root);

/** 子の process とその子を止める（Windows は taskkill の /T）。 */
export const stopServer = async (server: StartedServer | undefined): Promise<void> => {
  if (server === undefined) {
    return;
  }
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill();
  }
  await exited;
};

/** HTTP の応答。 */
export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** HTTP の要求の指定。`host` を省くと `127.0.0.1:<port>`。 */
export interface RawRequestOptions {
  readonly method?: string;
  readonly host?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** 127.0.0.1:<port> へ要求を送る（Host の header を自由に指定できる。応答の本文は UTF-8 の文字列）。 */
export const rawRequest = (port: number, path: string, options: RawRequestOptions = {}): Promise<RawResponse> =>
  new Promise((resolveResponse, rejectResponse) => {
    const req = request(
      {
        host: LOOPBACK_HOST,
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `${LOOPBACK_HOST}:${port}`, ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolveResponse({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', rejectResponse);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });

/** `Set-Cookie` の 1 つ目を `name=value` と属性に分ける。 */
export const parseSetCookie = (header: string | string[] | undefined): { readonly pair: string; readonly attributes: readonly string[] } | null => {
  const first = Array.isArray(header) ? header[0] : header;
  if (first === undefined) {
    return null;
  }
  const [pair = '', ...attributes] = first.split(';').map((part) => part.trim());
  return { pair, attributes };
};

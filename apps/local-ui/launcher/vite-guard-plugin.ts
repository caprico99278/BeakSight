/**
 * 開発のサーバ（`npm run ui:dev`）に、要求の守りの部品（`request-guard.ts`）を Vite の middleware として差し込む plugin（T23e、T23f）。
 * - `enforce: 'pre'` で、ほかの plugin（TanStack Start の middleware を含む）と Vite の内部の middleware より前に掛ける。
 * - HMR の websocket の upgrade の要求にも、Host と cookie の確かめを掛ける（通らなければ接続を閉じる）。
 * - 待ち受けを始めたら、最初の要求の前に、SSR の環境の中で管理データを準備する（`control-store` の `prepareLocalUiStore`）。失敗したら、
 *   `npm run setup:local` と同じ説明を出して、開発のサーバを止める。準備ができてから、token の URL をコンソールに出す。
 * - 待ち受けは 127.0.0.1 だけ。Vite の CLI の `--host` などで変えようとしたら起動しない。実際に待ち受けたアドレスも確かめる（T23h）。
 * - port の使用中などの起動の失敗は、`messages.ts` の日本語の説明を出して止める（T23h）。
 * - Vite の preview（`vite preview`）は、守りの部品を通らないので起動させない（T23i）。画面は `npm run ui` で起動する。
 * - 管理データの準備の後に、監査のジョブの管理を作り、前のサーバで終わっていなかったジョブを中断に直す（`jobsModule` の
 *   `prepareLocalUiAuditJobs`。Task 24 の設計書 4.4。T24f）。開発のサーバの終わり（Vite の SIGTERM と標準入力の終わりは `server.close`、
 *   Ctrl+C は 2 段の扱い `shutdown.ts`）では、動いているジョブを止めてから閉じる。
 * - 起動ごとの token の URL は、Vite のコンソールにだけ表示する（ログやファイルに書かない）。
 */
import type { AddressInfo } from 'node:net';
import { isRunnableDevEnvironment, type Plugin, type ViteDevServer } from 'vite';
import type { LOCAL_UI_CONSOLE_TEXT, LocalUiStartFailure } from '../../../src/presentation/messages.ts';
import type { LocalUiStorePreparation } from '../src/server/control-store.ts';
import {
  createSessionToken,
  evaluateRequest,
  formatTokenUrl,
  guardInputOf,
  HTTP_STATUS,
  LOCAL_UI_LISTEN_HOST,
  guardNodeRequest,
  upgradeRejectionResponse,
  type LocalUiGuardOptions,
  type RejectionText,
} from './request-guard.ts';
import { createTwoStepShutdown } from './shutdown.ts';

/** TanStack Start の SSR の環境の名前。 */
const SSR_ENVIRONMENT_NAME = 'ssr';

/** 開発のサーバを止めるときの終了コード（準備の失敗）。 */
const PREPARATION_FAILED_EXIT_CODE = 1;

/** 開発のサーバを起動できないときの終了コード（待ち受けのアドレス、port。本番の起動の部品と同じ 1）。 */
const START_FAILED_EXIT_CODE = 1;

/** plugin の指定（文言は `src/presentation/messages.ts` から、Vite の設定が渡す）。 */
export interface LocalUiGuardPluginOptions {
  readonly rejectionText: RejectionText;
  readonly consoleText: Pick<typeof LOCAL_UI_CONSOLE_TEXT, 'devTokenUrl' | 'tokenNotice'>;
  /** 起動できない理由を、コンソールに出す行にする（`describeLocalUiStartFailure`。T23h）。 */
  readonly describeStartFailure: (failure: LocalUiStartFailure) => readonly string[];
  /** 管理データの準備の部品（Vite の root からのパス。SSR の環境で読む）。 */
  readonly storeModule: string;
  /** 監査のジョブの管理の部品（Vite の root からのパス。SSR の環境で読む。T24f）。 */
  readonly jobsModule: string;
  /** 監査のジョブのコンソールの文言（`LOCAL_UI_JOB_CONSOLE_TEXT` から、Vite の設定が作る。T24f）。 */
  readonly jobConsoleText: {
    readonly jobsStopping: string;
    readonly exitingNow: string;
    readonly recoveredJobs: (count: number) => string;
  };
}

/** SSR の環境で読む、監査のジョブの管理の部品の形（`src/server/audit-jobs.ts`）。 */
interface JobsModule {
  prepareLocalUiAuditJobs(port: number | null):
    | { readonly ok: true; readonly recovered: number }
    | { readonly ok: false; readonly lines: readonly string[] };
  runningLocalUiAuditJobCount(): number;
  shutdownLocalUiAuditJobs(): Promise<unknown>;
}

const isJobsModule = (value: unknown): value is JobsModule =>
  typeof value === 'object' && value !== null
  && 'prepareLocalUiAuditJobs' in value && typeof value.prepareLocalUiAuditJobs === 'function'
  && 'runningLocalUiAuditJobCount' in value && typeof value.runningLocalUiAuditJobCount === 'function'
  && 'shutdownLocalUiAuditJobs' in value && typeof value.shutdownLocalUiAuditJobs === 'function';

/** この process で、Ctrl+C の受け手を登録したか（Vite がサーバを作り直しても、1 回だけ登録する）。 */
let interruptHandlerInstalled = false;
/** Ctrl+C の受け手が閉じる、今の開発のサーバ。 */
let currentDevServer: ViteDevServer | undefined;
/** 今の開発のサーバの、監査のジョブの管理の部品（準備の前は `undefined`）。 */
let currentJobs: JobsModule | undefined;

/** 使える port の範囲。 */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/** 待ち受けの設定の `server.host`（`true` はすべてのアドレス。表示は文言の側で決める）。 */
const hostOf = (host: string | boolean | undefined): string | true => (host === true ? true : String(host));

/** 開発のサーバが待ち受けている port（待ち受けの前は設定の値）。 */
const listeningPort = (server: ViteDevServer): number => {
  const address = server.httpServer?.address();
  return typeof address === 'object' && address !== null ? (address as AddressInfo).port : (server.config.server.port ?? 0);
};

const isPreparationModule = (value: unknown): value is { prepareLocalUiStore: () => LocalUiStorePreparation } =>
  typeof value === 'object' && value !== null && 'prepareLocalUiStore' in value && typeof value.prepareLocalUiStore === 'function';

/** SSR の環境の中で、モジュールを読む。 */
const importInSsr = async (server: ViteDevServer, modulePath: string): Promise<unknown> => {
  const environment = server.environments[SSR_ENVIRONMENT_NAME];
  if (environment === undefined || !isRunnableDevEnvironment(environment)) {
    throw new Error('the TanStack Start SSR environment is not runnable');
  }
  return environment.runner.import(modulePath);
};

/** SSR の環境の中で、管理データを準備する。 */
const prepareStore = async (server: ViteDevServer, storeModule: string): Promise<LocalUiStorePreparation> => {
  const module = await importInSsr(server, storeModule);
  if (!isPreparationModule(module)) {
    throw new Error(`${storeModule} does not export prepareLocalUiStore`);
  }
  return module.prepareLocalUiStore();
};

/** SSR の環境の中で、監査のジョブの管理の部品を読む（T24f）。 */
const loadJobs = async (server: ViteDevServer, jobsModule: string): Promise<JobsModule> => {
  const module = await importInSsr(server, jobsModule);
  if (!isJobsModule(module)) {
    throw new Error(`${jobsModule} does not export the audit job lifecycle functions`);
  }
  return module;
};

/** 開発のサーバの守りの plugin。 */
export function localUiGuardPlugin(pluginOptions: LocalUiGuardPluginOptions): Plugin {
  const token = createSessionToken();
  const optionsOf = (server: ViteDevServer): LocalUiGuardOptions => ({
    port: listeningPort(server),
    token,
    rejectionText: pluginOptions.rejectionText,
  });
  return {
    name: 'beaksight-local-ui-guard',
    enforce: 'pre',
    apply: 'serve',
    config(_config, env) {
      // Vite の preview は、守りの部品（Host、token、header）を通らずに dist/client を配るので、起動させない（T23i の N1）。
      // 設定を読む最初の時点で止める（logger はまだないので、標準エラーに出す）。
      if (env.isPreview === true) {
        for (const line of pluginOptions.describeStartFailure({ kind: 'PREVIEW_NOT_SUPPORTED' })) {
          console.error(line);
        }
        process.exit(START_FAILED_EXIT_CODE);
      }
    },
    configResolved(config) {
      // Vite の CLI の `--host` などは設定より優先されるので、解決した設定を確かめる（127.0.0.1 以外なら起動しない。T23h の I1）。
      const stop = (failure: LocalUiStartFailure): never => {
        for (const line of pluginOptions.describeStartFailure(failure)) {
          config.logger.error(line);
        }
        process.exit(START_FAILED_EXIT_CODE);
      };
      if (config.server.host !== LOCAL_UI_LISTEN_HOST) {
        stop({ kind: 'HOST_NOT_ALLOWED', host: hostOf(config.server.host) });
      }
      const { port } = config.server;
      if (port !== undefined && (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT)) {
        stop({ kind: 'PORT_INVALID', value: String(port) });
      }
    },
    configurePreviewServer(server) {
      // configResolved で止めているが、念のため、preview のサーバが作られても待ち受けの前に止める（T23i の N1）。
      for (const line of pluginOptions.describeStartFailure({ kind: 'PREVIEW_NOT_SUPPORTED' })) {
        server.config.logger.error(line);
      }
      process.exit(START_FAILED_EXIT_CODE);
    },
    configureServer(server) {
      const stopServer = async (failure: LocalUiStartFailure): Promise<void> => {
        for (const line of pluginOptions.describeStartFailure(failure)) {
          server.config.logger.error(line);
        }
        process.exitCode = START_FAILED_EXIT_CODE;
        await server.close();
      };
      // port の使用中と権限の誤りは、Vite の英語の誤りの前に、日本語の説明を出して止める（T23h の M2）。
      server.httpServer?.prependListener('error', (error: NodeJS.ErrnoException) => {
        const port = server.config.server.port ?? 0;
        const failure: LocalUiStartFailure = error.code === 'EADDRINUSE'
          ? { kind: 'PORT_IN_USE', port }
          : error.code === 'EACCES'
            ? { kind: 'PORT_PERMISSION_DENIED', port }
            : { kind: 'START_FAILED', detail: error.message };
        for (const line of pluginOptions.describeStartFailure(failure)) {
          server.config.logger.error(line);
        }
        process.exit(START_FAILED_EXIT_CODE);
      });
      // 終わり（T24f）: Vite の SIGTERM と標準入力の終わりの処理は `server.close` を呼ぶので、閉じる前に監査のジョブを止める。
      // Ctrl+C は、本番と同じ 2 段の扱いにする（1 回目はジョブを止めてから閉じる。2 回目は待たずに終える）。
      const closeServer = server.close.bind(server);
      let closing: Promise<void> | undefined;
      server.close = (): Promise<void> => {
        closing ??= (async () => {
          const jobs = currentJobs;
          currentJobs = undefined;
          if (jobs !== undefined) {
            await jobs.shutdownLocalUiAuditJobs().catch(() => undefined);
          }
          await closeServer();
        })();
        return closing;
      };
      currentDevServer = server;
      if (!interruptHandlerInstalled) {
        interruptHandlerInstalled = true;
        process.on('SIGINT', createTwoStepShutdown({
          runningJobCount: () => currentJobs?.runningLocalUiAuditJobCount() ?? 0,
          text: pluginOptions.jobConsoleText,
          log: (line) => console.log(line),
          shutdownJobs: async () => undefined,
          closeServer: async () => currentDevServer?.close(),
          closeStore: () => undefined,
          exit: (code) => process.exit(code),
        }));
      }
      server.middlewares.use((request, response, next) => {
        if (guardNodeRequest(optionsOf(server), request, response)) {
          next();
        }
      });
      // Vite の内部の middleware（Host の確かめなど）の一部は、plugin の middleware より前に入る。守りの部品を、いちばん前に移す
      // （すべての応答に守りの header を付け、Host の違いを Vite より先に 421 にするため）。
      const guardLayer = server.middlewares.stack.pop();
      if (guardLayer !== undefined) {
        server.middlewares.stack.unshift(guardLayer);
      }
      server.httpServer?.prependListener('upgrade', (request, socket) => {
        // Vite の HMR の websocket は、Vite 自身の `?token=` を query に付ける（この部品の token とは別のもの）。upgrade では query を
        // 見ずに、Host と cookie だけで確かめる（token の交換は画面の要求だけで行う）。
        const input = guardInputOf(request);
        const decision = evaluateRequest(optionsOf(server), { ...input, url: input.url?.split('?')[0] });
        if (decision.kind !== 'allow') {
          // websocket では token の交換（303）をしない。cookie がなければ 401 で閉じる。
          socket.end(upgradeRejectionResponse(decision.kind === 'reject' ? decision.status : HTTP_STATUS.UNAUTHORIZED));
          socket.destroy();
        }
      });
      server.httpServer?.once('listening', () => {
        // 実際に待ち受けたアドレスが 127.0.0.1 だけであること（設定の確かめを通り抜けた場合の備え）。
        const address = server.httpServer?.address();
        if (typeof address !== 'object' || address === null || address.address !== LOCAL_UI_LISTEN_HOST) {
          void stopServer({ kind: 'LISTEN_ADDRESS_NOT_ALLOWED', address: typeof address === 'object' && address !== null ? address.address : String(address) });
          return;
        }
        void prepareStore(server, pluginOptions.storeModule).then(async (preparation) => {
          if (!preparation.ok) {
            for (const line of preparation.lines) {
              server.config.logger.error(line);
            }
            process.exitCode = PREPARATION_FAILED_EXIT_CODE;
            await server.close();
            return;
          }
          // 監査のジョブの管理を作り、前のサーバで終わっていなかったジョブを中断に直す（T24f）。
          const jobs = await loadJobs(server, pluginOptions.jobsModule);
          // 画面のサーバを 1 つだけにする管理のロックを取ってから作る（DEF-061。T24h-4）。ほかの画面のサーバ（本番と開発、--port の違いを含む）が
          // 動いていれば、何も書き換えずに、説明を出して開発のサーバを止める（終了コード 1。token の URL は出さない）。
          const jobsPreparation = jobs.prepareLocalUiAuditJobs(listeningPort(server));
          if (!jobsPreparation.ok) {
            for (const line of jobsPreparation.lines) {
              server.config.logger.error(line);
            }
            process.exitCode = START_FAILED_EXIT_CODE;
            await server.close();
            return;
          }
          const { recovered } = jobsPreparation;
          currentJobs = jobs;
          if (recovered > 0) {
            server.config.logger.info(pluginOptions.jobConsoleText.recoveredJobs(recovered));
          }
          server.config.logger.info(`\n  ${pluginOptions.consoleText.devTokenUrl(formatTokenUrl(listeningPort(server), token))}`);
          server.config.logger.info(`  ${pluginOptions.consoleText.tokenNotice}\n`);
        }, async (error: unknown) => {
          server.config.logger.error(error instanceof Error ? error.message : String(error));
          process.exitCode = PREPARATION_FAILED_EXIT_CODE;
          await server.close();
        });
      });
    },
  };
}

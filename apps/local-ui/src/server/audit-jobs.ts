/**
 * 画面のサーバの監査のジョブの管理（Task 24 の設計書 3 章、4.4。T24f）。サーバだけで使う。
 * - 画面のサーバの process の中に、`createAuditJobManager` を 1 つだけ作って使い回す（管理データの接続 `control-store` と同じ形）。
 *   リポジトリの root は、このモジュールの場所から決める（`localUiRepositoryRoot`）。ワーカーは `<root>/dist/worker/audit-worker.js`
 *   （`npm run build` の出力。`npm run ui` は、ビルドしてから起動する）。ワーカーの cwd はリポジトリの root。
 * - ターゲット設定の読み直し（開始の直前の検証し直し）は、プロファイルの画面と同じ `loadConfig` の形（`loadTargetContext`）。
 * - 作るとき（最初に使うとき）に、前の画面のサーバで終わっていなかったジョブの行を中断に直す（`recoverInterruptedJobs`）。本番の起動の部品と
 *   開発のサーバは、待ち受けの前（開発のサーバは待ち受けを始めたとき）に `prepareLocalUiAuditJobs` を呼ぶ。
 * - 終わり（本番の起動の部品の SIGINT・SIGTERM と、開発のサーバの終わり）に `shutdownLocalUiAuditJobs` を呼ぶ（名前つきの時間だけ待つ）。
 * - 背後の処理の誤りは、画面のサーバを落とさずに、コンソールに日本語の見出しと英語の詳細を出す。
 * - 画面のサーバは同時に 1 つだけ（独立レビュー T24R の C1、DEF-061。T24h-4）: ジョブの管理を作るときに、管理データの中の管理のロックを取る。
 *   ほかの画面のサーバ（本番と開発、`--port` の違いを含む）が動いていれば、管理を作らず（前のジョブの行も直さず）、起動の部品に日本語の説明を
 *   返す（`prepareLocalUiAuditJobs`）。起動の部品は、待ち受けずに終了コード 1 で止まる。
 * - T26e: ジョブの管理には、資格情報の画面と同じ資格情報のファイルの部品を渡す（`credential-runtime.ts`。書くのは画面のサーバだけ）。
 */
import { join } from 'node:path';
import {
  createAuditJobManager,
  type AuditJobManager,
  type AuditJobShutdownResult,
} from '../../../../src/control/job/audit-job-manager.js';
import { AUDIT_JOB_SHUTDOWN_WAIT_MS } from '../../../../src/control/job/job-records.js';
import { ControlInstanceLockedError } from '../../../../src/control/job/instance-lock.js';
import { LOCAL_UI_JOB_CONSOLE_TEXT, describeLocalUiStartFailure } from '../../../../src/presentation/messages.js';
import { localUiRepositoryRoot, localUiStore } from './control-store';
import { localUiCredentialRoot, localUiCredentialStore } from './credential-runtime';
import { loadTargetContext } from './target-config';

/** リポジトリの root からの、監査のワーカーの入口（`npm run build` の出力）。 */
const WORKER_ENTRY_SEGMENTS = Object.freeze(['dist', 'worker', 'audit-worker.js'] as const);

/** 終わったときの結果（ジョブの管理を作っていなかった場合）。 */
const NOTHING_TO_SHUT_DOWN: AuditJobShutdownResult = Object.freeze({ stopRequested: 0, killed: 0 });

/** この process の、ただ 1 つのジョブの管理と、作ったときに中断に直した行の数。 */
let state: { readonly manager: AuditJobManager; readonly recovered: number } | null = null;

/** 終わりの後始末を始めた（その後は、ジョブの管理を作り直さない）。 */
let shutDown = false;

/** 監査のワーカーの入口（絶対パス）。 */
export const localUiWorkerPath = (): string => join(localUiRepositoryRoot(), ...WORKER_ENTRY_SEGMENTS);

/** 起動のときの準備の結果。作れなければ（ほかの画面のサーバが動いている）、コンソールに出す行。 */
export type LocalUiAuditJobsPreparation =
  | { readonly ok: true; readonly recovered: number }
  | { readonly ok: false; readonly lines: readonly string[] };

/**
 * ジョブの管理を作る（作る中で、管理のロックを取る。取れなければ `ControlInstanceLockedError` で、何も書き換えない）。作れたら、前の画面のサーバで
 * 終わっていなかったジョブの行を中断に直す（ロックを持つ管理だけが直す）。
 */
const create = (port: number | null): { readonly manager: AuditJobManager; readonly recovered: number } => {
  if (shutDown) {
    throw new Error('the audit job manager of the local UI server is shut down');
  }
  const manager = createAuditJobManager({
    database: localUiStore(),
    repositoryRoot: join(localUiRepositoryRoot()),
    workerPath: localUiWorkerPath(),
    resolveContext: async (targetConfigPath) => (await loadTargetContext(targetConfigPath)).context,
    onBackgroundError: (error) => {
      console.error(LOCAL_UI_JOB_CONSOLE_TEXT.backgroundError, error instanceof Error ? error.message : String(error));
    },
    instancePort: port,
    credentials: { root: localUiCredentialRoot(), store: localUiCredentialStore() },
  });
  return { manager, recovered: manager.recoverInterruptedJobs() };
};

/** ジョブの管理（なければ作り、前の画面のサーバのジョブの行を中断に直す）。管理データを準備できなければ、その誤りを投げる。 */
export const localUiAuditJobs = (): AuditJobManager => {
  state ??= create(null);
  return state.manager;
};

/**
 * 起動のときの準備。ジョブの管理を作り（管理のロックを取ってから）、中断に直した行の数を返す（2 回目からは 0）。`port` は、この画面のサーバの
 * port（管理のロックに記録し、2 つ目の画面のサーバの説明に出す）。ほかの画面のサーバが動いていれば、何も書き換えずに、日本語の説明の行を返す。
 * ほかの誤り（管理データの誤りなど）は投げる。
 */
export const prepareLocalUiAuditJobs = (port: number | null = null): LocalUiAuditJobsPreparation => {
  if (state !== null) {
    return Object.freeze({ ok: true, recovered: 0 });
  }
  try {
    state = create(port);
  } catch (error) {
    if (error instanceof ControlInstanceLockedError) {
      return Object.freeze({
        ok: false,
        lines: describeLocalUiStartFailure({ kind: 'ALREADY_RUNNING', processId: error.holderProcessId, port: error.holderPort }),
      });
    }
    throw error;
  }
  return Object.freeze({ ok: true, recovered: state.recovered });
};

/** 動いているワーカーの数（ジョブの管理を作っていなければ 0）。 */
export const runningLocalUiAuditJobCount = (): number => state?.manager.runningWorkerCount() ?? 0;

/**
 * 終わりのときの後始末。動いているジョブに `STOP` を送り、`waitMs`（既定は名前つきの時間）だけ終わりを待ち、残ったワーカーを止めて、
 * ジョブの管理を閉じる。2 回呼んでもよい。その後は、ジョブの管理を作り直さない（Server Function は誤りになる）。
 */
export const shutdownLocalUiAuditJobs = async (waitMs: number = AUDIT_JOB_SHUTDOWN_WAIT_MS): Promise<AuditJobShutdownResult> => {
  shutDown = true;
  const current = state;
  if (current === null) {
    return NOTHING_TO_SHUT_DOWN;
  }
  const result = await current.manager.shutdownAuditJobs({ waitMs });
  await current.manager.close();
  if (state === current) {
    state = null;
  }
  return result;
};

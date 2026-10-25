/**
 * DEF-146: 画面のサーバが終わったときの記録のファイル（`local-data/logs/ui-server.log`。場所の owner は `src/control/store/database-path.ts` の
 * `resolveUiServerLogPath`）を、`node:fs` の同期の読み書きで書く部品。サーバだけで使う。記録の中身・伏せ字・大きさの上限は `src/control/ui-server-log.ts`
 * が決め、ここはファイルの読み書きだけを渡す（`src/**` のファイルの書き込みは ArtifactWriter だけ。GATE-ARCH08。対象の設定のファイルを書く
 * `target-config-writer.ts` と同じく、画面のサーバの部品で書く）。
 * - 起動の部品（`launcher/serve.ts`）は、2 つ目の入口（`launcher-bridge.ts`）から、予期しない例外・止める決まり・process の終わりの記録を呼ぶ。
 *   ジョブの管理（`audit-jobs.ts`）は、結果の前に終わったワーカーの終わり方を記録する。
 * - 画面のサーバの token は、起動の部品が `setLocalUiServerLogSecrets` で渡す（記録には書かない）。
 * - 終わる直前（`exit` の受け手、`uncaughtExceptionMonitor`）にも書けるように、同期で書く。書けなくても投げない（記録の部品が受け止める）。
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveUiServerLogPath } from '../../../../src/control/store/database-path.js';
import { errorCodeOf } from '../../../../src/core/errors.js';
import {
  createUiServerLog,
  unexpectedErrorRecordOf,
  type UiServerEndReason,
  type UiServerErrorOrigin,
  type UiServerLog,
  type UiServerLogFiles,
  type UiServerLogRecord,
} from '../../../../src/control/ui-server-log.js';
import { localUiRepositoryRoot } from './control-store';

/** ファイルがないときの誤りの code。 */
const NOT_FOUND_CODE = 'ENOENT';

/** `node:fs` の同期の読み書き（足すときと置き換えるときは、フォルダも作る）。 */
export const nodeUiServerLogFiles: UiServerLogFiles = Object.freeze({
  sizeOf: (path: string): number => {
    try {
      return statSync(path).size;
    } catch (error) {
      if (errorCodeOf(error) === NOT_FOUND_CODE) {
        return 0;
      }
      throw error;
    }
  },
  read: (path: string): string => readFileSync(path, 'utf8'),
  append: (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, text, 'utf8');
  },
  replace: (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  },
});

/** 記録に書かない値（画面のサーバの token）。 */
let secrets: readonly string[] = Object.freeze([]);
/** この process の記録の部品（最初に使うときに作る）。 */
let log: UiServerLog | null = null;

const localUiServerLog = (): UiServerLog => {
  log ??= createUiServerLog({ path: resolveUiServerLogPath(localUiRepositoryRoot()), files: nodeUiServerLogFiles, secrets: () => secrets });
  return log;
};

/** 記録に書かない値を渡す（起動の部品が、画面のサーバの token を渡す）。 */
export const setLocalUiServerLogSecrets = (values: readonly string[]): void => {
  secrets = Object.freeze([...values]);
};

/** 予期しない例外（`uncaughtExceptionMonitor`。出どころと、動いていたジョブの数）を記録する。投げない。 */
export const recordLocalUiServerUnexpectedError = (origin: UiServerErrorOrigin, error: unknown, runningJobs: number): void => {
  localUiServerLog().write(unexpectedErrorRecordOf(origin, error, runningJobs));
};

/** 止める決まりの終わり（終わり方、2 回目のすぐの終わりか、止め始めたときに動いていたジョブの数）を記録する。投げない。 */
export const recordLocalUiServerShutdown = (reason: UiServerEndReason, immediate: boolean, runningJobs: number): void => {
  localUiServerLog().write({ kind: 'SHUTDOWN', reason, immediate, runningJobs });
};

/** process の終わり（終わりの記録をまだ書いていないときだけ）を記録する。投げない。 */
export const recordLocalUiServerExit = (exitCode: number, runningJobs: number): void => {
  localUiServerLog().recordExit(exitCode, runningJobs);
};

/** 結果の前に終わったワーカーの終わり方（ジョブの管理の `onUnexpectedWorkerExit`）を記録する。投げない。 */
export const recordLocalUiWorkerExit = (event: Omit<Extract<UiServerLogRecord, { kind: 'WORKER_EXITED' }>, 'kind'>): void => {
  localUiServerLog().write({ kind: 'WORKER_EXITED', ...event });
};

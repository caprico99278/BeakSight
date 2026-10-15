// 管理のロックのテスト（T24h-4）の共通の値と補助。親のテストと、子 process（`control-instance-child.ts`）の両方が使う。
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { spawnTypeScriptChild } from './control-profile-fixtures.js';

/** 子 process との決まり（標準入出力の 1 行ずつ）。 */
export const INSTANCE_CHILD_PROTOCOL = Object.freeze({
  ready: 'READY',
  locked: 'LOCKED',
  start: 'START',
  result: 'RESULT',
  ok: 'OK',
  list: 'LIST',
  jobs: 'JOBS',
  exit: 'EXIT',
  closed: 'CLOSED',
});

/** 子 process のモジュールの URL。 */
export const INSTANCE_CHILD_MODULE_URL = new URL('./control-instance-child.ts', import.meta.url).href;

/** 子 process の 1 行の応答を待つ上限（ms。busy の待ちと、process の起動より長く）。 */
export const INSTANCE_CHILD_LINE_TIMEOUT_MS = 60_000;

/** 起動した子 process（画面のサーバの代わり）。 */
export interface InstanceChild {
  readonly process: ChildProcessWithoutNullStreams;
  /** 最初の行（`READY <数>` か `LOCKED <PID> <port>`）。 */
  readonly first: string;
  nextLine(): Promise<string>;
  send(line: string): void;
  /** 終わりを待つ。 */
  readonly exited: Promise<number | null>;
  /** 強制終了して、終わりを待つ。 */
  kill(): Promise<void>;
}

/** 子 process を起動し、最初の行を待つ。 */
export async function startInstanceChild(args: {
  readonly databasePath: string;
  readonly repositoryRoot: string;
  readonly workerPath: string;
  readonly port?: number;
}): Promise<InstanceChild> {
  const child = spawnTypeScriptChild(INSTANCE_CHILD_MODULE_URL, [
    args.databasePath, args.repositoryRoot, args.workerPath, ...(args.port === undefined ? [] : [String(args.port)]),
  ]);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lines: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      lines.push(line);
    } else {
      waiter(line);
    }
  });
  const exited = new Promise<number | null>((resolvePromise) => {
    child.once('exit', (code) => {
      for (const waiter of waiters.splice(0)) {
        waiter(null);
      }
      resolvePromise(code);
    });
  });
  const nextLine = (): Promise<string> => {
    const buffered = lines.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`no line from the child within ${INSTANCE_CHILD_LINE_TIMEOUT_MS} ms: ${stderr}`)), INSTANCE_CHILD_LINE_TIMEOUT_MS);
      waiters.push((line) => {
        clearTimeout(timer);
        if (line === null) {
          rejectPromise(new Error(`the child exited: ${stderr}`));
        } else {
          resolvePromise(line);
        }
      });
    });
  };
  const first = await nextLine();
  return {
    process: child,
    first,
    nextLine,
    send: (line) => {
      child.stdin.write(`${line}\n`);
    },
    exited,
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
}

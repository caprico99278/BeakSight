// 監査のジョブの管理のテストの共通の値と補助（T24e）。親のテストと、子 process（`control-audit-jobs-child.ts`）の両方が使う。
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { spawnTypeScriptChild } from './control-profile-fixtures.js';

/** 子 process との決まり（標準入出力の 1 行ずつ）。 */
export const JOB_CHILD_PROTOCOL = Object.freeze({
  /** 文脈の読み方: テストの決まった文脈／`loadConfig` で読む。 */
  fixtureContext: 'fixture',
  loadConfigContext: 'load-config',
  /** ジョブの管理を作らずに、ジョブの行の部品だけで行を作る（T24h-4）。 */
  storeOnly: 'store-only',
  /** 子 → 親: ジョブの管理を作った。 */
  ready: 'READY',
  /** 親 → 子: `START <profileId> <改訂>`。 */
  start: 'START',
  /** 子 → 親: `RESULT OK <jobId> <ワーカーの process の ID>`、または `RESULT <理由> - -`。 */
  result: 'RESULT',
  ok: 'OK',
  /** 親 → 子: 閉じて終わる。 */
  exit: 'EXIT',
  /** 子 → 親: 閉じた。 */
  closed: 'CLOSED',
});

/** 子 process のモジュールの URL。 */
export const JOB_CHILD_MODULE_URL = new URL('./control-audit-jobs-child.ts', import.meta.url).href;

/** 子 process の 1 行の応答を待つ上限（ms。busy の待ちと、ワーカーの起動より長く）。 */
export const JOB_CHILD_LINE_TIMEOUT_MS = 60_000;

/** 開始の結果の 1 行を読んだもの。 */
export interface JobChildResult {
  readonly ok: boolean;
  /** 拒まれたときの理由（受けたときは `OK`）。 */
  readonly reason: string;
  readonly jobId: string | null;
  readonly workerPid: number | null;
}

/** 起動した子 process（ジョブの管理）。 */
export interface JobChild {
  readonly process: ChildProcessWithoutNullStreams;
  /** 次の 1 行を待つ。 */
  nextLine(): Promise<string>;
  send(line: string): void;
  /** `START` を送り、結果の 1 行を読む。 */
  start(profileId: string, revision: number): Promise<JobChildResult>;
  /** `EXIT` を送り、`CLOSED` と終わりを待つ。 */
  close(): Promise<void>;
  /** 強制終了して、終わりを待つ（画面のサーバが落ちた場合を模す）。 */
  kill(): Promise<void>;
}

/** 子 process を起動し、`READY` を待つ。 */
export async function startJobChild(args: {
  readonly databasePath: string;
  readonly repositoryRoot: string;
  readonly workerPath: string;
  readonly contextKind: string;
}): Promise<JobChild> {
  const child = spawnTypeScriptChild(JOB_CHILD_MODULE_URL, [args.databasePath, args.repositoryRoot, args.workerPath, args.contextKind]);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const reader: Interface = createInterface({ input: child.stdout });
  const lines: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  reader.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      lines.push(line);
    } else {
      waiter(line);
    }
  });
  const exited = new Promise<void>((resolvePromise) => {
    child.once('exit', () => {
      for (const waiter of waiters.splice(0)) {
        waiter(null);
      }
      resolvePromise();
    });
  });
  const nextLine = (): Promise<string> => {
    const buffered = lines.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`no line from the child within ${JOB_CHILD_LINE_TIMEOUT_MS} ms: ${stderr}`)), JOB_CHILD_LINE_TIMEOUT_MS);
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
  const send = (line: string): void => {
    child.stdin.write(`${line}\n`);
  };
  const ready = await nextLine();
  if (ready !== JOB_CHILD_PROTOCOL.ready) {
    throw new Error(`unexpected first line from the child: ${ready} ${stderr}`);
  }
  return {
    process: child,
    nextLine,
    send,
    start: async (profileId, revision) => {
      send(`${JOB_CHILD_PROTOCOL.start} ${profileId} ${String(revision)}`);
      const [label, reason = '', jobId = '-', pid = '-'] = (await nextLine()).split(' ');
      if (label !== JOB_CHILD_PROTOCOL.result) {
        throw new Error(`unexpected line from the child: ${label}`);
      }
      return {
        ok: reason === JOB_CHILD_PROTOCOL.ok,
        reason,
        jobId: jobId === '-' ? null : jobId,
        workerPid: pid === '-' ? null : Number(pid),
      };
    },
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      send(JOB_CHILD_PROTOCOL.exit);
      const closed = await nextLine();
      if (closed !== JOB_CHILD_PROTOCOL.closed) {
        throw new Error(`unexpected line from the child: ${closed}`);
      }
      await exited;
    },
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
}

/**
 * 一時的なビルドの CLI（`<一時ビルド>/dist/cli/index.js`）を、別のプロセスで動かす補助（T19a。`tests/integration/cli.test.ts` と
 * `tests/integration/fixture-full-crawl.test.ts` が共通に使う）。
 *
 * - プロセスの起動と、標準出力・標準エラーの受け取り、上限の時間を過ぎたときの停止。
 * - 上限の時間の中で終わったことの確かめ、スタックトレースの行の形、出力先の根の下にある Run のディレクトリの取り出し。
 * 検証の内容（期待値）は、各テストに置く。
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { TemporaryBuild } from './temporary-build.js';

/** CLI のプロセスが終わるまでの上限（これを過ぎたら、プロセスを止めてテストを失敗にする）。 */
export const CLI_PROCESS_LIMIT_MS = 120_000;

/** スタックトレースの行（`    at ...`）。CLI の出力に、これが出てはならない。 */
export const STACK_TRACE_LINE = /^\s+at\s/mu;

/** CLI のプロセスの結果。 */
export interface CliProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** 起動から終了までの時間（ms）。 */
  readonly elapsedMs: number;
  /** `CLI_PROCESS_LIMIT_MS` を過ぎたので、プロセスを止めたか。 */
  readonly killedByLimit: boolean;
}

/**
 * 一時的なビルドの CLI を、非同期で起動する（fixture のサーバが同じプロセスで応答するので、`spawnSync` は使えない）。
 * 作業のディレクトリは `cwd`。`CLI_PROCESS_LIMIT_MS` を過ぎても終わらない場合は、プロセスを止める。
 */
export function runCliProcess(build: TemporaryBuild, cwd: string, arguments_: readonly string[]): Promise<CliProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(build.distDirectory, 'cli', 'index.js'), ...arguments_], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killedByLimit = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      killedByLimit = true;
      child.kill();
    }, CLI_PROCESS_LIMIT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, killedByLimit });
    });
  });
}

/** プロセスが `CLI_PROCESS_LIMIT_MS` の中で、シグナルで止められずに終わった。 */
export function expectFinishedInTime(result: CliProcessResult): void {
  expect(result.killedByLimit, `the CLI did not exit within ${CLI_PROCESS_LIMIT_MS} ms`).toBe(false);
  expect(result.signal).toBeNull();
  expect(result.elapsedMs).toBeLessThan(CLI_PROCESS_LIMIT_MS);
}

/** 出力先の根の下にある、ただ1つの Run のディレクトリ。 */
export async function onlyRunDirectory(outputDirectory: string): Promise<string> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  expect(directories).toHaveLength(1);
  return join(outputDirectory, directories[0]?.name ?? '');
}

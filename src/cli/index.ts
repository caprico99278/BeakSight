#!/usr/bin/env node
/**
 * BeakSight の CLI の入口（Task 14〜17 の設計書 第7章）。
 * `runCli` は、標準出力と標準エラーへのすべての書き込みが終わってから、終了コードを返す。その後に `process.exit` で終える。
 * Browser を閉じる処理が期限（`BROWSER_CLOSE_TIMEOUT_MS`）を過ぎて Chromium が残っていても、プロセスを終えるためである。
 * - 標準出力と標準エラーの `'error'`（閉じたパイプの EPIPE など）は、無視する。終了コードは変えない（R17 の指摘1）。
 * - 扱われない例外と reject は、日本語の短い文言と、例外のメッセージの1行を示し、終了コード 1 で終える。スタックトレースは出さない。
 *   扱われない失敗では、Run Coordinator の `finally` の終わりを待たない。Chromium の終了は、Playwright がプロセスの終了時に行う
 *   処理に任せる（設計書 第7章、R17r の Minor-1）。2つ目以降の扱われない失敗は、最初のものの表示を待つだけにする。
 */
import { reportUnhandledFailure, runCli } from './main.js';
import { ignoreOutputErrors, streamOutput } from './output-stream.js';

ignoreOutputErrors(process.stdout);
ignoreOutputErrors(process.stderr);
const stdout = streamOutput(process.stdout);
const stderr = streamOutput(process.stderr);

/** 最初の扱われない失敗の、表示の後の終了コード（起きていなければ `undefined`）。 */
let unhandledFailure: Promise<number> | undefined;
const handleUnhandledFailure = (error: unknown): void => {
  if (unhandledFailure !== undefined) {
    return;
  }
  unhandledFailure = reportUnhandledFailure(error, stderr);
  void unhandledFailure.then((code) => process.exit(code));
};
process.on('uncaughtException', handleUnhandledFailure);
process.on('unhandledRejection', handleUnhandledFailure);

const exitCode = await runCli(process.argv.slice(2), { stdout, stderr });
process.exit(await (unhandledFailure ?? exitCode));

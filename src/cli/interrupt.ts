/**
 * CLI のシグナルの受け方（中断した Run の再開の設計書 4.7 の「シグナル」、4.7.1。R5b）。
 * Playwright の既定のシグナルの処理は、Chromium の起動で止めてある（`run-command.ts` の `PRODUCTION_RUN_DEPENDENCIES`）。BeakSight が、
 * 閉じた一覧（`INTERRUPT_SIGNALS`）のシグナルを受ける。どのシグナルも、同じ数え方にする（1回目が SIGINT、2回目が SIGTERM でも、2回目）。
 * - 1回目: 文言を標準エラーに書き、止める印（`AbortController`）を付ける。Run Coordinator は、今のページを（再試行を含めて）最後まで行い、
 *   新しいページを始めずに、最後の処理を行う（設計書 4.6.1）。終了コードは、その Run の Run Status のとおり。
 * - 2回目: 文言を標準エラーに書き、書き込みの終わりを待ってから、終了コード 5（`INTERRUPTED`）でプロセスを終える。最後の処理はしない。
 *   再開のための保存は、最後に監査を終えたページまで残る（状態は `IN_PROGRESS`）。Chromium の終了は、`index.ts` の扱われない失敗と同じく、
 *   Playwright がプロセスの終了時に行う処理に任せる。
 * - 3回目以降: 何もしない。
 * 受け手を作る関数と、登録する関数を分ける。テストは、本物の `process` ではなく、偽の `EventEmitter` に登録して確かめる（テストのプロセスを
 * 終えないため）。登録するのは `index.ts` だけである。
 */
import { CLI_TEXT } from '../presentation/messages.js';
import { INTERRUPTED_EXIT_CODE } from './exit-codes.js';
import { joinLines } from './output.js';
import type { CliOutput } from './output-stream.js';

/** BeakSight が受けるシグナルの閉じた一覧（設計書 4.7。Ctrl+C、`kill` などの終了の要求、端末のウィンドウを閉じた場合）。 */
export const INTERRUPT_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP'] as const satisfies readonly NodeJS.Signals[]);
export type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

/** シグナルの受け手を作るときに受け取るもの。 */
export interface InterruptHandlerOptions {
  /** 1回目のシグナルで `abort()` を呼ぶ。その `signal` を、止める印として Run Coordinator に渡す（`index.ts` が `runCli` に渡す）。 */
  readonly controller: AbortController;
  /** 文言を書く標準エラー。 */
  readonly stderr: CliOutput;
  /** 終了コードを受け取って、プロセスを終える関数（本番は `process.exit`）。2回目のシグナルで呼ぶ。 */
  readonly exit: (code: number) => void;
}

/** シグナルの受け手（`INTERRUPT_SIGNALS` のどれを受けても、同じ受け手を呼ぶ）。 */
export type InterruptHandler = () => void;

/** シグナルを受ける相手（`process.on` の形を持つもの。本番は `process`、テストは偽の `EventEmitter`）。 */
export interface InterruptSignalTarget {
  on(event: InterruptSignal, listener: InterruptHandler): unknown;
}

/**
 * シグナルの受け手を作る。受けた回数は、受け手ごとに数える（すべてのシグナルで共通）。
 * 1回目は、文言の書き込みを始めてから、書き込みの終わりを待たずに止める印を付ける（書き込みが遅れても、止めるのを遅らせない）。
 * 2回目は、文言の書き込みが終わってから `exit` を呼ぶ（`CliOutput.write` は reject しない）。3回目以降は、何もしない。
 */
export function createInterruptHandler(options: InterruptHandlerOptions): InterruptHandler {
  const { controller, stderr, exit } = options;
  let received = 0;
  return () => {
    received += 1;
    if (received === 1) {
      void stderr.write(joinLines([CLI_TEXT.interrupt.stopRequested]));
      controller.abort();
      return;
    }
    if (received === 2) {
      void stderr.write(joinLines([CLI_TEXT.interrupt.exitingNow])).then(() => exit(INTERRUPTED_EXIT_CODE));
    }
  };
}

/** `target` に、`INTERRUPT_SIGNALS` のそれぞれのシグナルの受け手として、`handler` を登録する。 */
export function registerInterruptHandlers(target: InterruptSignalTarget, handler: InterruptHandler): void {
  for (const signal of INTERRUPT_SIGNALS) {
    target.on(signal, handler);
  }
}

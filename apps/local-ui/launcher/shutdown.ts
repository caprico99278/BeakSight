/**
 * 画面のサーバの終わり（Ctrl+C、SIGTERM）の 2 段の扱い（Task 24 の設計書 4.4 の「画面のサーバの終わり」。T24f）。
 * 本番の起動の部品（`serve.ts`）と、開発のサーバ（`vite-guard-plugin.ts`）の両方で、この部品を使う。
 * - 1 回目: 動いている監査のジョブがあれば、日本語で知らせる。ジョブの後始末（`STOP` を送り、名前つきの時間だけ終わりを待つ。残ったワーカーは
 *   止める）→ 画面のサーバを閉じる → 管理データを閉じる、の順に行ってから終える。途中で失敗しても、残りを行って終える。
 * - 2 回目: 待たずに、すぐに終える（ワーカーは detached でないので、IPC が切れて自分で止まり始める。ジョブの行は、次の起動で中断に直す）。
 * Node の型の除去で動くので、消せる型の書き方だけを使う。
 */

/** 終わるときの終了コード（1 回目も 2 回目も、利用者が求めた終わりなので 0）。 */
export const SHUTDOWN_EXIT_CODE = 0;

/** 2 段の終わりの指定。 */
export interface TwoStepShutdownOptions {
  /** 動いている監査のジョブ（この画面のサーバが起動したワーカー）の数。 */
  readonly runningJobCount: () => number;
  /** 知らせる文言（`src/presentation/messages.ts` の `LOCAL_UI_JOB_CONSOLE_TEXT` から、呼び出し側が作る）。 */
  readonly text: { readonly jobsStopping: string; readonly exitingNow: string };
  readonly log: (line: string) => void;
  /** 監査のジョブの後始末（名前つきの時間だけ待つ）。 */
  readonly shutdownJobs: () => Promise<unknown>;
  readonly closeServer: () => Promise<unknown>;
  readonly closeStore: () => void;
  readonly exit: (code: number) => void;
}

/** 失敗しても先へ進む（終わりの処理を止めない）。 */
const settle = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work();
  } catch {
    // 終わりの処理では、失敗を投げずに、残りを行う。
  }
};

/** シグナルの受け手を作る（`process.on('SIGINT', …)` などに渡す）。 */
export const createTwoStepShutdown = (options: TwoStepShutdownOptions): (() => void) => {
  let started = false;
  return (): void => {
    if (started) {
      options.log(options.text.exitingNow);
      options.exit(SHUTDOWN_EXIT_CODE);
      return;
    }
    started = true;
    if (options.runningJobCount() > 0) {
      options.log(options.text.jobsStopping);
    }
    void (async () => {
      await settle(options.shutdownJobs);
      await settle(options.closeServer);
      await settle(async () => options.closeStore());
      options.exit(SHUTDOWN_EXIT_CODE);
    })();
  };
};

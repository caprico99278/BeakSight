/**
 * 画面のサーバの終わり（Ctrl+C、SIGTERM）の 2 段の扱い（Task 24 の設計書 4.4 の「画面のサーバの終わり」。T24f）。
 * 本番の起動の部品（`serve.ts`）と、開発のサーバ（`vite-guard-plugin.ts`）の両方で、この部品を使う。
 * - 1 回目: 動いている監査のジョブがあれば、日本語で知らせる。ジョブの後始末（`STOP` を送り、名前つきの時間だけ終わりを待つ。残ったワーカーは
 *   止める）→ 画面のサーバを閉じる → 管理データを閉じる、の順に行ってから終える。途中で失敗しても、残りを行って終える。
 * - 2 回目: 待たずに、すぐに終える（ワーカーは detached でないので、IPC が切れて自分で止まり始める。ジョブの行は、次の起動で中断に直す）。
 * - DEF-146: 受け手は、終わり方（`reason`。呼び出し側の閉じた一覧。Ctrl+C・SIGTERM・画面を閉じたなど）を受ける。終える直前に `recordEnd` があれば、
 *   終わり方、2 回目のすぐの終わりか、1 回目を始めたときに動いていたジョブの数を渡す（本番の起動の部品は、終わりの記録のファイルに書く）。
 * Node の型の除去で動くので、消せる型の書き方だけを使う。
 */

/** 終わるときの終了コード（1 回目も 2 回目も、利用者が求めた終わりなので 0）。 */
export const SHUTDOWN_EXIT_CODE = 0;

/** 2 段の終わりの指定。 */
export interface TwoStepShutdownOptions<Reason = string> {
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
  /** DEF-146: 終える直前の記録（終わり方、2 回目のすぐの終わりか、1 回目を始めたときに動いていたジョブの数）。投げても終える。 */
  readonly recordEnd?: (reason: Reason | undefined, immediate: boolean, runningJobs: number) => void;
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
export const createTwoStepShutdown = <Reason = string>(options: TwoStepShutdownOptions<Reason>): ((reason?: Reason) => void) => {
  let started = false;
  /** DEF-146: 終える直前の記録（投げても終える）。 */
  const recordEnd = (reason: Reason | undefined, immediate: boolean, runningJobs: number): void => {
    try {
      options.recordEnd?.(reason, immediate, runningJobs);
    } catch {
      // 記録は、終わりの処理を止めない。
    }
  };
  return (reason?: Reason): void => {
    if (started) {
      options.log(options.text.exitingNow);
      recordEnd(reason, true, options.runningJobCount());
      options.exit(SHUTDOWN_EXIT_CODE);
      return;
    }
    started = true;
    const runningJobs = options.runningJobCount();
    if (runningJobs > 0) {
      options.log(options.text.jobsStopping);
    }
    void (async () => {
      await settle(options.shutdownJobs);
      await settle(options.closeServer);
      await settle(async () => options.closeStore());
      recordEnd(reason, false, runningJobs);
      options.exit(SHUTDOWN_EXIT_CODE);
    })();
  };
};

/**
 * CLI の出力先（標準出力、標準エラー）。書き込みが終わるのを待てる形にする（Task 14〜17 の設計書 第7章、U17a の指示書の4）。
 * CLI は、すべての書き込みを待ってから `process.exit` で終える。Browser を閉じる処理が期限を過ぎて Chromium が残っていても
 * プロセスを終えるためと、Windows のパイプへの書き込みを途中で切らないためである。
 */

/** 書き込みの終わりを待てる出力先。 */
export interface CliOutput {
  /** `text` を書く。書き込みが終わる（出力先が callback を呼ぶ）と解決する。書き込みの失敗でも reject しない。 */
  write(text: string): Promise<void>;
}

/** `process.stdout` などの、callback 付きの `write` を持つ出力先。 */
export interface CallbackWritable {
  write(text: string, callback: (error?: Error | null) => void): boolean;
}

/** `'error'` の事象を出す出力先（`process.stdout`、`process.stderr`）。 */
export interface ErrorEmittingOutput {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * 出力先の `'error'` の事象（閉じたパイプの EPIPE など）を受けて、無視する（設計書 第7章、R17 の指摘1）。
 * 受けないと、Node は扱われない `'error'` の事象として、スタックトレースを出して終了コード 1 で終える。
 * 表示できないだけなので、終了コードは変えない（Run Status か CONFIG_ERROR のまま）。
 */
export const ignoreOutputErrors = (stream: ErrorEmittingOutput): void => {
  stream.on('error', () => {
    // 表示できないだけなので、何もしない。
  });
};

/**
 * callback 付きの `write` を持つ出力先を、`CliOutput` にする。
 * 書き込みの失敗（閉じたパイプなど）は、表示できないだけなので、無視して解決する（終了コードは変えない）。
 */
export const streamOutput = (stream: CallbackWritable): CliOutput => ({
  write: (text) =>
    new Promise<void>((resolve) => {
      try {
        stream.write(text, () => resolve());
      } catch {
        resolve();
      }
    }),
});

/**
 * 画面の起動の部品（`serve.ts`・`vite-guard-plugin.ts`）が使う、誤りの文の取り出し（PRE42-CC 組 R。台帳の N1 の launcher）。
 * 起動の部品は実行時に core を読めないので、`src/core/errors.ts` の `errorMessageOrString` と同じ振る舞いの補助を、launcher の中に 1 つだけ置く
 * （設計者の判断。Gate `core-small-parts-ownership` の (i)）。
 * Node の型の除去で動くので、消せる型の書き方だけを使う。
 */

/** 誤りの値を、`Error` なら `message`、そうでなければ `String(…)` にする。 */
export const errorMessageOrString = (error: unknown): string => (error instanceof Error ? error.message : String(error));

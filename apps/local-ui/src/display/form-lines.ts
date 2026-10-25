/**
 * 画面の「1 行に 1 つ」の欄の読み方と書き方の唯一の owner（T43b fix round 1。共通化）。プロファイルの作成（許可 Origin、テスト環境の Origin、
 * 承認したサービスの Origin）、認証の設定（送信先、読まないパス、読む範囲のパス）、入力の規則（人が入れた値の一覧）が共用する。純粋な関数だけ。
 * - 読む: 行の区切りは `\n` と `\r\n`。各行の前後の空白を除き、空の行を除く。
 * - 書く: `\n` でつなぐ。
 */

/** 行の区切り（`\n` と `\r\n`）。 */
const LINE_BREAK = /\r?\n/u;
/** 書くときの行の区切り。 */
const LINE_JOINER = '\n';

/** 「1 行に 1 つ」の欄の文字を、前後の空白と空の行を除いた一覧にする。 */
export const linesOf = (text: string): string[] => text.split(LINE_BREAK).map((line) => line.trim()).filter((line) => line.length > 0);

/** 値の一覧を、「1 行に 1 つ」の欄の文字にする。 */
export const textOfLines = (lines: readonly string[]): string => lines.join(LINE_JOINER);

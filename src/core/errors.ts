import { isNonNegativeSafeInteger, isRecord } from './guards.js';

/** エラーの値から文字列を安全に取り出せなかったときの代替文言。 */
export const ERROR_MESSAGE_FALLBACK = 'Error could not be safely normalized';

/**
 * 不明な値を、例外を投げずに、`maxLength` 以内の文字列にする。
 *
 * - 文字列はそのまま、`Error` などのオブジェクトと関数は `Reflect.get` で読んだ文字列の `message` を使う。
 * - `toString` などの変換は呼ばない。読み取りが例外を投げた場合や、`message` が文字列でない場合は代替文言を使う。
 * - 代替文言は `fallback` で指定できる（省略時は `ERROR_MESSAGE_FALLBACK`）。代替文言も `maxLength` 以内に切り詰める。
 * - `maxLength` が0以上の安全な整数でない場合は、呼び出し側の誤りとして `RangeError` を投げる。
 */
export function safeErrorMessage(
  error: unknown,
  maxLength: number,
  fallback: string = ERROR_MESSAGE_FALLBACK,
): string {
  if (!isNonNegativeSafeInteger(maxLength)) {
    throw new RangeError('error message maximum length must be a non-negative safe integer');
  }
  return describeError(error, fallback).slice(0, maxLength);
}

function describeError(error: unknown, fallback: string): string {
  if (error === null) return 'null';
  switch (typeof error) {
    case 'string':
      return error;
    case 'undefined':
      return 'undefined';
    case 'boolean':
      return error ? 'true' : 'false';
    case 'number':
      return String(error);
    case 'bigint':
      return fallback;
    case 'symbol':
      return 'symbol';
    case 'object':
    case 'function':
      try {
        const message = Reflect.get(error, 'message') as unknown;
        return typeof message === 'string' ? message : fallback;
      } catch {
        return fallback;
      }
  }
  return fallback;
}

/**
 * 入出力などの例外の `code`（`ENOENT` など。文字列のときだけ）。なければ `null`（CC-062。CCX-11。成果物の書き出し、資格情報のファイル、
 * 管理データの準備、成果物のファイルの読み込みが共用する）。配列とプリミティブの値は、`code` を持たないとみなす（`isRecord`）。
 */
export const errorCodeOf = (error: unknown): string | null => (isRecord(error) && typeof error.code === 'string' ? error.code : null);

/**
 * 誤りの値の文（PRE42-CC 組 5a。台帳の N1）。`Error` なら `message`、そうでなければ `String(error)`。長さは切り詰めない（上限が要るときは
 * `safeErrorMessage` を使う）。管理データの `quick_check` の誤りの文、管理データを開く誤りの詳細、画面のサーバの背後の処理の誤りのコンソールの出力が
 * 共用する。画面の起動の部品（`apps/local-ui/launcher/`）は実行時に core を読めないので、使わない。
 */
export const errorMessageOrString = (error: unknown): string => (error instanceof Error ? error.message : String(error));

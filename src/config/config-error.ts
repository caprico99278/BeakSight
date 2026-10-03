/**
 * 設定のエラー（Task 14〜17 の設計書 6.1.5、第7章）。
 * - 種類のコード（`kind`）と、詳細の一覧（`details`）を持つ。詳細は、英語の技術的な詳細（検証のエラー、ファイルのパス、
 *   入出力のエラーの文）で、CLI がそのまま示す。
 * - `message` は、英語の技術的な要約である。利用者に見せる日本語の文言は、`src/presentation/messages.ts` の
 *   `CONFIG_ERROR_DESCRIPTIONS` が、種類のコードごとに持つ。
 * - CLI は、`isConfigError` でこのエラーを見分け、終了コード 4（CONFIG_ERROR）で終える。
 */
import type { CONFIG_ERROR_DESCRIPTIONS } from '../presentation/messages.js';

/** 設定のエラーの種類。 */
export const CONFIG_ERROR_KINDS = Object.freeze([
  /** 設定のファイル（または `config/targets/`）がない。 */
  'CONFIG_FILE_NOT_FOUND',
  /** 設定のファイルを読めない（ディレクトリである、権限がない、など）。 */
  'CONFIG_FILE_UNREADABLE',
  /** 設定のファイルが、JSON として読めない。 */
  'CONFIG_JSON_INVALID',
  /** 設定のファイルに、空でない `target.id` がない。 */
  'TARGET_ID_MISSING',
  /** `--config` がなく、`config/targets/` の中の設定のファイルが1つに決まらない。 */
  'TARGET_NOT_SELECTED',
  /** `config/targets/` の中に、同じ `target.id` の設定のファイルがある。 */
  'TARGET_ID_DUPLICATED',
  /** 設定の検証のエラー（既定値と CLI の上書きを合わせた後の設定）。 */
  'CONFIG_INVALID',
  /** CLI のコマンドがない。 */
  'COMMAND_MISSING',
  /** CLI のコマンドが、知らないものである。 */
  'UNKNOWN_COMMAND',
  /** CLI の引数の誤り（知らないオプション、値のないオプション、余分な引数）。 */
  'INVALID_ARGUMENTS',
  /** CLI の引数の矛盾（`--headed` と `--headless` を同時に指定した）。 */
  'CONFLICTING_ARGUMENTS',
] as const);
export type ConfigErrorKind = (typeof CONFIG_ERROR_KINDS)[number];

/**
 * 日本語の説明（`messages.ts` の `CONFIG_ERROR_DESCRIPTIONS`）が、すべての種類について、余分なく書かれていることを、型で確かめる。
 * `messages.ts` は `src/config/types.ts` 以外の `src/config/**` を import しない（UI追補設計書 4.1）ので、確かめはこちら側に置く。
 */
type SameKeys<Left extends PropertyKey, Right extends PropertyKey> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type AssertTrue<Condition extends true> = Condition;
export type ConfigErrorDescriptionsCoverEveryKind = AssertTrue<SameKeys<ConfigErrorKind, keyof typeof CONFIG_ERROR_DESCRIPTIONS>>;

const CONFIG_ERROR_KIND_SET: ReadonlySet<string> = new Set(CONFIG_ERROR_KINDS);

/** 設定のエラー。 */
export class ConfigError extends Error {
  /** 種類のコード。 */
  readonly kind: ConfigErrorKind;
  /** 詳細の一覧（英語の技術的な詳細）。凍結した写し。 */
  readonly details: readonly string[];

  /** 種類が一覧にない場合は、呼び出し側の誤りとして `RangeError` を投げる。 */
  constructor(kind: ConfigErrorKind, message: string, details: readonly string[] = [], options: { readonly cause?: unknown } = {}) {
    if (!CONFIG_ERROR_KIND_SET.has(kind)) {
      throw new RangeError(`unknown configuration error kind: ${String(kind)}`);
    }
    super(message, Object.hasOwn(options, 'cause') ? { cause: options.cause } : undefined);
    this.name = 'ConfigError';
    this.kind = kind;
    this.details = Object.freeze([...details]);
  }
}

/** 設定のエラーか。 */
export const isConfigError = (error: unknown): error is ConfigError => error instanceof ConfigError;

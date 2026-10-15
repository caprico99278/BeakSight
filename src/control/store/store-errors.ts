// 管理データの部品が止めるときの理由の閉じた一覧と、誤りの型（Task 23 の設計書 4.3。T23a）。
// - 理由の値だけを持つ。利用者への日本語の説明と取るべき手順は、表示の部品（`src/presentation/messages.ts`。T23d）が持つ。
// - `detail` は英語の技術的な詳細（ログと診断用）。
// - SQLite の誤り（`node:sqlite` の `ERR_SQLITE_ERROR`）は、主の結果コード（拡張コードの下位 8 bit）で分類する。
import { CONTROL_ENVIRONMENT_FAILURE_REASONS } from '../environment/control-environment.js';

/** 止める理由（閉じた一覧。先頭は環境の確かめの理由）。 */
export const CONTROL_STORE_FAILURE_REASONS = Object.freeze([
  ...CONTROL_ENVIRONMENT_FAILURE_REASONS,
  /** 置き場所のフォルダ（またはその上のフォルダ）の位置に、フォルダでないものがある。 */
  'DATA_DIRECTORY_NOT_DIRECTORY',
  /** 置き場所のフォルダを作れない、または書き込めない。 */
  'DATA_DIRECTORY_NOT_WRITABLE',
  /** データベースの位置に、SQLite でないファイル（またはフォルダ）がある。上書き・削除・移動はしない。 */
  'NOT_A_SQLITE_FILE',
  /** SQLite のファイルだが、BeakSight の管理データではない（`application_id` が違う、ほかのプログラムの表や版がある）。 */
  'NOT_A_BEAKSIGHT_DATABASE',
  /** この BeakSight が知るより新しい版で作られた。書き込まない。 */
  'DATABASE_FROM_NEWER_VERSION',
  /** 別のプログラムが開いている・書き込んでいる（busy の待ちを過ぎた）。 */
  'DATABASE_LOCKED',
  /** ファイルが読み取り専用で、書き込めない。 */
  'DATABASE_READ_ONLY',
  /** WAL にできない（ネットワークのドライブなど）。 */
  'DATABASE_WAL_UNAVAILABLE',
  /** ファイルが壊れている（`quick_check` が ok でない、SQLite が壊れていると判断した）。 */
  'DATABASE_INTEGRITY_FAILED',
  /** 版の管理（表の作成など）が失敗した。版ごとのトランザクションは元に戻してある。 */
  'MIGRATION_FAILED',
  /** 上のどれにも当たらない、開くときの誤り。 */
  'DATABASE_OPEN_FAILED',
] as const);
export type ControlStoreFailureReason = (typeof CONTROL_STORE_FAILURE_REASONS)[number];

/** 管理データの部品が止めるときの誤り。`reason` は閉じた一覧の値。 */
export class ControlStoreError extends Error {
  override readonly name = 'ControlStoreError';
  readonly reason: ControlStoreFailureReason;

  constructor(reason: ControlStoreFailureReason, detail: string, options?: ErrorOptions) {
    super(`${reason}: ${detail}`, options);
    this.reason = reason;
  }
}

/** 管理データを開く・準備するときの失敗（止める理由と英語の詳細）。 */
export interface ControlStoreFailure {
  readonly reason: ControlStoreFailureReason;
  readonly detail: string;
}

/**
 * 管理データを開く・準備するときの誤りを、止める理由と詳細にする（CCX-5、台帳の N2。`npm run setup:local` と画面のサーバの準備が使う）。
 * `ControlStoreError` はその理由と誤りの文のまま。それ以外は `DATABASE_OPEN_FAILED` にし、詳細は `Error` なら `message`、そうでなければ
 * `String(error)`。
 */
export const controlStoreFailureOf = (error: unknown): ControlStoreFailure =>
  error instanceof ControlStoreError
    ? { reason: error.reason, detail: error.message }
    : { reason: 'DATABASE_OPEN_FAILED', detail: error instanceof Error ? error.message : String(error) };

/** `node:sqlite` が投げる誤りのコード。 */
const NODE_SQLITE_ERROR_CODE = 'ERR_SQLITE_ERROR';
/** 拡張の結果コードから、主の結果コードを取り出すマスク（下位 8 bit）。 */
const SQLITE_PRIMARY_RESULT_CODE_MASK = 0xff;
/** SQLite の主の結果コード（https://sqlite.org/rescode.html）。 */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
/** フォルダは先に確かめて作ってあるので、開けないのは、ほかのプログラムがファイルを開いている場合とみなす（設計書 4.3）。 */
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;

const REASON_BY_PRIMARY_RESULT_CODE: ReadonlyMap<number, ControlStoreFailureReason> = new Map<number, ControlStoreFailureReason>([
  [SQLITE_BUSY, 'DATABASE_LOCKED'],
  [SQLITE_LOCKED, 'DATABASE_LOCKED'],
  [SQLITE_CANTOPEN, 'DATABASE_LOCKED'],
  [SQLITE_READONLY, 'DATABASE_READ_ONLY'],
  [SQLITE_CORRUPT, 'DATABASE_INTEGRITY_FAILED'],
  [SQLITE_NOTADB, 'DATABASE_INTEGRITY_FAILED'],
]);

/** SQLite の誤りの主の結果コード。SQLite の誤りでなければ `null`。 */
const sqlitePrimaryResultCodeOf = (error: unknown): number | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const { code, errcode } = error as { readonly code?: unknown; readonly errcode?: unknown };
  if (code !== NODE_SQLITE_ERROR_CODE || typeof errcode !== 'number' || !Number.isInteger(errcode)) {
    return null;
  }
  return errcode & SQLITE_PRIMARY_RESULT_CODE_MASK;
};

/** SQLite の誤りを、止める理由に分類する。分類できなければ `null`（呼び出し側が文脈に合う理由を選ぶ）。 */
export const classifySqliteFailure = (error: unknown): ControlStoreFailureReason | null => {
  const primary = sqlitePrimaryResultCodeOf(error);
  return primary === null ? null : (REASON_BY_PRIMARY_RESULT_CODE.get(primary) ?? null);
};

/**
 * 保存した行の誤り（データベースの誤り。`DATABASE_INTEGRITY_FAILED`）。表の名前と、何が合わないかを書く（T29d fix round 1: シナリオの今の事実と、
 * 入力の規則の読み出しが共用する。前は `src/control/approval/scenario-facts.ts` と `src/control/data-rules/rule-set-facts.ts` に同じ形があった）。
 */
export const storedRowIntegrityError = (table: string, detail: string, cause?: unknown): ControlStoreError =>
  new ControlStoreError('DATABASE_INTEGRITY_FAILED', `stored ${table} row: ${detail}`, cause === undefined ? undefined : { cause });

/**
 * 誤りを `ControlStoreError` にする。既に `ControlStoreError` ならそのまま、SQLite の誤りで分類できればその理由、
 * それ以外は `fallback`。元の誤りは `cause` に残す。
 */
export const toControlStoreError = (error: unknown, fallback: ControlStoreFailureReason, detail: string): ControlStoreError => {
  if (error instanceof ControlStoreError) {
    return error;
  }
  return new ControlStoreError(classifySqliteFailure(error) ?? fallback, detail, { cause: error });
};

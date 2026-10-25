// DEF-146: 画面のサーバが終わったときの記録のファイル（`local-data/logs/ui-server.log`。場所の owner は `store/database-path.ts` の
// `resolveUiServerLogPath`。Git の外）を書く部品。
// - 1 行に 1 つの JSON。書くのは、予期しない例外（uncaughtException・unhandledRejection）で終わるとき、止める決まり（Ctrl+C・SIGTERM・画面を閉じた・
//   ほかの理由）で終わるとき、終わりの記録のないまま process が終わるとき、ワーカーが結果の前に終わったとき（親が分かる終わり方）。
// - 中身は、時刻、終わり方、例外の名前と文（スタックは `UI_SERVER_LOG_MAX_STACK_LINES` 行まで）、動いていたジョブの数。値は書かない: 呼び出し側が渡す
//   秘密（画面のサーバの token）、URL の userinfo と query・fragment の値と値に見える path の区切り（core の `redactServiceOriginUrl`）、秘密に見える
//   header の名前の後の値と、秘密に見える名前の `name=value` の値（core の `secret-query-names.ts`）を伏せる。
// - ファイルの大きさの上限（`UI_SERVER_LOG_MAX_BYTES`）を超えるときは、古い行を捨てて新しい行を残す。書けなくても投げない（終わりの処理を止めない）。
// - 終わる直前にも書けるように、同期で書く。ファイルの読み書きそのものは、呼び出し側が渡す部品（`UiServerLogFiles`）が行う（`src/**` のファイルの
//   書き込みは ArtifactWriter だけ。GATE-ARCH08。画面のサーバの部品 `apps/local-ui/src/server/ui-server-log-file.ts` が `node:fs` で渡す）。
import { REDACTED } from '../core/redaction.js';
import { isSecretLikeHeaderName, isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { redactServiceOriginUrl } from '../core/url-redaction.js';

/** ファイルの大きさの上限（バイト）。超えるときは、古い行を捨てて、上限の半分まで残す。 */
export const UI_SERVER_LOG_MAX_BYTES = 1024 * 1024;
/** スタックの行の上限。 */
export const UI_SERVER_LOG_MAX_STACK_LINES = 20;
/** 文 1 つの長さの上限（文字）。 */
const MAX_TEXT_LENGTH = 2_000;
/** スタックの 1 行の長さの上限（文字）。 */
const MAX_STACK_LINE_LENGTH = 500;
/** 上限を超えたときに残す割合（上限の半分）。 */
const KEPT_FRACTION = 2;

/** 止める決まりの終わり方（Ctrl+C、SIGTERM、画面を閉じた、ほか）。 */
export const UI_SERVER_END_REASONS = Object.freeze(['CTRL_C', 'SIGTERM', 'UI_CLOSED', 'OTHER'] as const);
export type UiServerEndReason = (typeof UI_SERVER_END_REASONS)[number];

/** 予期しない例外の出どころ（Node の `uncaughtExceptionMonitor` の `origin`）。 */
export type UiServerErrorOrigin = 'uncaughtException' | 'unhandledRejection';

/** 記録の 1 行（時刻は書くときに足す）。 */
export type UiServerLogRecord =
  | {
    readonly kind: 'UNEXPECTED_ERROR';
    readonly origin: UiServerErrorOrigin;
    readonly errorName: string;
    readonly message: string;
    readonly stack: readonly string[];
    readonly runningJobs: number;
  }
  | { readonly kind: 'SHUTDOWN'; readonly reason: UiServerEndReason; readonly immediate: boolean; readonly runningJobs: number }
  | { readonly kind: 'EXIT'; readonly exitCode: number; readonly runningJobs: number }
  | { readonly kind: 'WORKER_EXITED'; readonly jobId: string; readonly jobKind: string; readonly exitCode: number | null; readonly signal: string | null };

/** 終わりの記録の種類（これを書いた後は、process の終わりの行を書かない）。 */
const END_RECORD_KINDS: ReadonlySet<UiServerLogRecord['kind']> = new Set(['UNEXPECTED_ERROR', 'SHUTDOWN']);

/** 記録の部品。 */
export interface UiServerLog {
  /** 1 行を書く（投げない）。 */
  write(record: UiServerLogRecord): void;
  /** 終わりの記録を書いていなければ、process の終わりを 1 行書く（`process.on('exit')` から呼ぶ。投げない）。 */
  recordExit(exitCode: number, runningJobs: number): void;
}

/** 記録のファイルの読み書き（同期。呼び出し側が渡す。どれも、できなければ投げてよい）。 */
export interface UiServerLogFiles {
  /** ファイルの大きさ（バイト。ないときは 0）。 */
  readonly sizeOf: (path: string) => number;
  /** ファイルの中身（UTF-8）。 */
  readonly read: (path: string) => string;
  /** 末尾に足す（なければ、フォルダも作る）。 */
  readonly append: (path: string, text: string) => void;
  /** 中身を置き換える（なければ、フォルダも作る）。 */
  readonly replace: (path: string, text: string) => void;
}

/** 記録の部品の指定。 */
export interface UiServerLogOptions {
  readonly path: string;
  readonly files: UiServerLogFiles;
  /** 書かない値（画面のサーバの token など）。書くときに読む。 */
  readonly secrets?: () => readonly string[];
  readonly now?: () => Date;
  readonly maxBytes?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// 伏せ字
// ---------------------------------------------------------------------------------------------------------------

/** 文の中の、URL の候補（空白、引用符、`<`、`>`、backtick を含まない連なり）。 */
const URL_CANDIDATE = /[^\s"'<>`]+/gu;
/** URL の候補の印（scheme、query、fragment、userinfo）。 */
const URL_MARKS: readonly string[] = Object.freeze(['://', '?', '#', '@']);
/** 絶対形の URL の userinfo（`scheme://userinfo@`）。 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/giu;
/** header の形の `名前: 値`（行の中）。 */
const HEADER_LIKE = /([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*/gu;
/** `名前=値` の組。 */
const NAME_VALUE_PAIR = /([A-Za-z][A-Za-z0-9_.-]*)=([^\s;,&"'<>`]+)/gu;
/** 伏せる秘密の短さの下限（短すぎる値で、ふつうの文を伏せない）。 */
const MIN_SECRET_LENGTH = 8;

const isSecretLikeName = (name: string): boolean => isSecretLikeHeaderName(name) || isSecretUrlQueryParameterName(name);

/** 行の中の、最初の秘密に見える header の名前の後を、行の終わりまで伏せる。 */
const redactHeaderLikeLine = (line: string): string => {
  for (const match of line.matchAll(HEADER_LIKE)) {
    if (isSecretLikeName(match[1] ?? '')) {
      return `${line.slice(0, (match.index ?? 0) + match[0].length)}${REDACTED}`;
    }
  }
  return line;
};

/** 記録に書く文の値を伏せる（秘密、URL、秘密に見える header と `name=value`）。 */
export const redactUiServerLogText = (text: string, secrets: readonly string[] = []): string => {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) {
      redacted = redacted.split(secret).join(REDACTED);
    }
  }
  redacted = redacted.replace(URL_CANDIDATE, (candidate) =>
    URL_MARKS.some((mark) => candidate.includes(mark))
      ? redactServiceOriginUrl(candidate.replace(URL_USERINFO, (_whole, scheme: string) => `${scheme}${REDACTED}@`))
      : candidate);
  redacted = redacted.split('\n').map(redactHeaderLikeLine).join('\n');
  return redacted.replace(NAME_VALUE_PAIR, (whole, name: string) => (isSecretLikeName(name) ? `${name}=${REDACTED}` : whole));
};

// ---------------------------------------------------------------------------------------------------------------
// 記録
// ---------------------------------------------------------------------------------------------------------------

const limited = (text: string, maxLength: number): string => (text.length > maxLength ? text.slice(0, maxLength) : text);

/**
 * 予期しない例外の記録（`Error` でない値は、名前を `NonError` にする。文字列はその文、ほかの値は中身を書かずに型だけを書く。中身の値を書かないため）。
 */
export const unexpectedErrorRecordOf = (origin: UiServerErrorOrigin, error: unknown, runningJobs: number): UiServerLogRecord => {
  const isError = error instanceof Error;
  const message = isError ? String(error.message) : typeof error === 'string' ? error : `(${error === null ? 'null' : typeof error})`;
  const stackLines = isError && typeof error.stack === 'string' ? error.stack.split('\n') : [];
  return Object.freeze({
    kind: 'UNEXPECTED_ERROR',
    origin,
    errorName: isError ? error.name : 'NonError',
    message,
    stack: stackLines.slice(0, UI_SERVER_LOG_MAX_STACK_LINES),
    runningJobs,
  });
};

/** 書く前に、文の値を伏せ、長さを切る。 */
const redactedRecordOf = (record: UiServerLogRecord, secrets: readonly string[]): UiServerLogRecord => {
  if (record.kind !== 'UNEXPECTED_ERROR') {
    return record;
  }
  return {
    ...record,
    errorName: limited(redactUiServerLogText(record.errorName, secrets), MAX_TEXT_LENGTH),
    message: limited(redactUiServerLogText(record.message, secrets), MAX_TEXT_LENGTH),
    stack: record.stack.slice(0, UI_SERVER_LOG_MAX_STACK_LINES).map((line) => limited(redactUiServerLogText(line, secrets), MAX_STACK_LINE_LENGTH)),
  };
};

/** 1 行を足す。上限を超えるときは、古い行を捨てて、上限の半分までの新しい行と、足す行を残す。 */
const appendWithinLimit = (files: UiServerLogFiles, path: string, line: string, maxBytes: number): void => {
  const lineBytes = Buffer.byteLength(line);
  let size = 0;
  try {
    size = files.sizeOf(path);
  } catch {
    size = 0;
  }
  if (size + lineBytes <= maxBytes) {
    files.append(path, line);
    return;
  }
  let lines: readonly string[] = [];
  try {
    lines = files.read(path).split('\n').filter((item) => item.length > 0);
  } catch {
    lines = [];
  }
  const budget = Math.floor(maxBytes / KEPT_FRACTION) - lineBytes;
  const kept: string[] = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const item = `${lines[index] ?? ''}\n`;
    const bytes = Buffer.byteLength(item);
    if (total + bytes > budget) {
      break;
    }
    total += bytes;
    kept.unshift(item);
  }
  files.replace(path, `${kept.join('')}${line}`);
};

/** 記録の部品を作る。 */
export const createUiServerLog = (options: UiServerLogOptions): UiServerLog => {
  const now = options.now ?? ((): Date => new Date());
  const maxBytes = options.maxBytes ?? UI_SERVER_LOG_MAX_BYTES;
  let endRecorded = false;
  const write = (record: UiServerLogRecord): void => {
    try {
      const secrets = options.secrets?.() ?? [];
      appendWithinLimit(options.files, options.path, `${JSON.stringify({ at: now().toISOString(), ...redactedRecordOf(record, secrets) })}\n`, maxBytes);
      endRecorded ||= END_RECORD_KINDS.has(record.kind);
    } catch {
      // 記録は、終わりの処理を止めない。
    }
  };
  return {
    write,
    recordExit(exitCode, runningJobs) {
      if (!endRecorded) {
        write({ kind: 'EXIT', exitCode, runningJobs });
      }
    },
  };
};

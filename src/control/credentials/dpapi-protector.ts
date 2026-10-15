// 資格情報の暗号化の部品の唯一の owner（Task 26 の設計書 4.1、4.7、10 章の 1・2。T26a）。
// - Windows の DPAPI（`ProtectedData` の `CurrentUser`）で、値を暗号化・復号する。Windows PowerShell 5.1 を絶対パスで、固定の文
//   （`-EncodedCommand`）だけで起動する。PATH の検索・環境変数・シェルを使わない。
// - 値と entropy は、stdin で、UTF-8 を base64 にした行として渡す（stdin を shift_jis で読まれて壊れないため）。結果は stdout の base64 で
//   受ける。値を、スクリプトの本文・起動の引数・環境変数・cmdlet の引数に入れない（.NET のメソッドだけで扱う。PowerShell がスクリプトの
//   本文をイベントログに記録しても、値は入らない）。
// - 子プロセスの stderr は読まず、記録もしない（`'ignore'`）。終了コードと stdout の形だけで成否を決める。時間の上限と stdout の大きさの
//   上限を設ける。誤りは、固定のコードの閉じた一覧（`CREDENTIAL_PROTECTION_ERROR_CODES`）で返し、値・暗号文・entropy・子プロセスの出力を
//   入れない。
// - 子プロセスを起動する部品（`runCredentialProcess`）は、資格情報のファイルの部品（`credential-store.ts`）の権限の確かめと共用する
//   （時間の上限と出力の上限を 1 か所にする）。
// - 本番の入口（`createDpapiCredentialProtector`）は引数なしで、本物の `spawn` を使う。テストは `createDpapiCredentialProtectorWith` に
//   子プロセスを起動する関数を渡す（`tests/architecture/credential-boundary.test.ts` で確かめる）。
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { resolveTimeoutMs } from '../../core/deadline.js';
import { hasLoneSurrogate } from '../../core/text.js';
import { CREDENTIAL_PLATFORM } from './credential-platform.js';

// ---------------------------------------------------------------------------------------------------------------
// 名前つきの定数
// ---------------------------------------------------------------------------------------------------------------

/** 資格情報の部品が起動する子プロセス 1 つを待つ時間の上限（ms）。過ぎたら止めて失敗にする。 */
export const CREDENTIAL_PROCESS_TIMEOUT_MS = 10_000;

/** 子プロセスの stdout の大きさの上限（バイト）。超えたら止めて失敗にする。 */
export const MAX_CREDENTIAL_PROCESS_OUTPUT_BYTES = 16_384;

/** 暗号化する値と entropy の長さの上限（UTF-16 の単位）。 */
export const MAX_PROTECTOR_INPUT_LENGTH = 1_024;

/** 暗号文（base64）の長さの上限。`MAX_PROTECTOR_INPUT_LENGTH` の値（UTF-8 で 3 倍まで）の暗号文が収まる長さ。 */
export const MAX_PROTECTED_TEXT_LENGTH = 8_192;

/** Windows PowerShell 5.1 の絶対パス（PATH の検索をしない）。 */
export const WINDOWS_POWERSHELL_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Windows PowerShell の起動の引数（この後に、固定の文を UTF-16LE の base64 にしたものを 1 つだけ続ける）。 */
export const POWERSHELL_LAUNCH_ARGUMENTS = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'] as const);

/** 固定の文の中で失敗したとき（try/catch で捕まえたとき）の終了コード。誤りの文は出さない。 */
export const CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE = 3;

/** 子プロセスが成功したときの終了コード。 */
const SUCCESS_EXIT_CODE = 0;

/** 暗号化の誤りのコード（閉じた一覧）。 */
export const CREDENTIAL_PROTECTION_ERROR_CODES = Object.freeze([
  /** Windows でない、または PowerShell を起動できない。 */
  'PROTECTION_UNAVAILABLE',
  /** 暗号化・復号ができなかった（entropy の違い、壊れた暗号文、終了コードや出力の形の誤りを含む）。 */
  'PROTECTION_FAILED',
  /** 時間の上限を過ぎた（子プロセスを止めた）。 */
  'PROTECTION_TIMEOUT',
  /** 渡した値の形の誤り（空、長すぎる、対にならないサロゲート、base64 でない暗号文）。子プロセスは起動しない。 */
  'PROTECTION_INPUT_INVALID',
] as const);
export type CredentialProtectionErrorCode = (typeof CREDENTIAL_PROTECTION_ERROR_CODES)[number];

/** 誤りの文（固定。値を入れない）。 */
const PROTECTION_ERROR_MESSAGES: Readonly<Record<CredentialProtectionErrorCode, string>> = Object.freeze({
  PROTECTION_UNAVAILABLE: 'credential protection is unavailable (PROTECTION_UNAVAILABLE)',
  PROTECTION_FAILED: 'credential protection failed (PROTECTION_FAILED)',
  PROTECTION_TIMEOUT: 'credential protection timed out (PROTECTION_TIMEOUT)',
  PROTECTION_INPUT_INVALID: 'credential protection input is invalid (PROTECTION_INPUT_INVALID)',
});

/** 暗号化の誤り。持つのは固定のコードだけ（値・暗号文・entropy・子プロセスの出力を持たない）。 */
export class CredentialProtectionError extends Error {
  readonly code: CredentialProtectionErrorCode;

  constructor(code: CredentialProtectionErrorCode) {
    super(PROTECTION_ERROR_MESSAGES[code]);
    this.name = 'CredentialProtectionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 子プロセスの起動（`credential-store.ts` と共用）
// ---------------------------------------------------------------------------------------------------------------

/** 子プロセスの起動の設定。stderr は常に `'ignore'`（読まず、記録もしない）。シェルを使わない。 */
export interface CredentialProcessSpawnOptions {
  readonly stdio: readonly ['pipe' | 'ignore', 'pipe' | 'ignore', 'ignore'];
  readonly windowsHide: true;
  readonly shell: false;
}

/** 起動した子プロセス（`node:child_process` の `ChildProcess` の一部）。stderr は持たない。 */
export interface CredentialChildProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(): boolean;
}

/** 子プロセスを起動する関数（本番は `node:child_process` の `spawn`。テストは偽物を渡す）。 */
export type CredentialProcessSpawner = (
  file: string,
  args: readonly string[],
  options: CredentialProcessSpawnOptions,
) => CredentialChildProcess;

/** 本物の子プロセスの起動（`spawn`。PATH の検索をしないよう、`file` は絶対パスで渡す）。 */
export const spawnCredentialProcess: CredentialProcessSpawner = (file, args, options) =>
  spawn(file, [...args], { stdio: [...options.stdio], windowsHide: options.windowsHide, shell: options.shell });

/** 子プロセスの起動の依頼。 */
export interface CredentialProcessRequest {
  /** 起動するファイルの絶対パス。 */
  readonly file: string;
  readonly args: readonly string[];
  /** stdin に書いて閉じる文字列（`null` なら stdin を使わない）。 */
  readonly stdinText: string | null;
  /** stdout を受けるか（受けないなら `'ignore'`）。 */
  readonly captureStdout: boolean;
  readonly timeoutMs: number;
}

/** 子プロセスの結果（stderr は持たない）。 */
export type CredentialProcessOutcome =
  | { readonly kind: 'EXITED'; readonly exitCode: number | null; readonly stdout: string }
  | { readonly kind: 'SPAWN_FAILED' }
  | { readonly kind: 'TIMED_OUT' }
  | { readonly kind: 'OUTPUT_TOO_LARGE' };

const SPAWN_FAILED: CredentialProcessOutcome = Object.freeze({ kind: 'SPAWN_FAILED' });
const TIMED_OUT: CredentialProcessOutcome = Object.freeze({ kind: 'TIMED_OUT' });
const OUTPUT_TOO_LARGE: CredentialProcessOutcome = Object.freeze({ kind: 'OUTPUT_TOO_LARGE' });

/**
 * 子プロセスを 1 つ起動し、終わりを待つ（例外を投げない）。stderr は読まない。時間の上限（`timeoutMs`）を過ぎたら、または stdout が
 * `MAX_CREDENTIAL_PROCESS_OUTPUT_BYTES` を超えたら、子プロセスを止めて失敗の結果を返す。
 */
export const runCredentialProcess = (
  spawner: CredentialProcessSpawner,
  request: CredentialProcessRequest,
): Promise<CredentialProcessOutcome> => new Promise((resolve) => {
  let child: CredentialChildProcess;
  try {
    child = spawner(request.file, request.args, {
      stdio: [request.stdinText === null ? 'ignore' : 'pipe', request.captureStdout ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
      shell: false,
    });
  } catch {
    resolve(SPAWN_FAILED);
    return;
  }

  let settled = false;
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  const settle = (outcome: CredentialProcessOutcome, stop: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    chunks.length = 0;
    if (stop) {
      try {
        child.kill();
      } catch {
        // 止められなくても、結果は失敗のまま返す。
      }
    }
    resolve(outcome);
  };
  const timer = setTimeout(() => settle(TIMED_OUT, true), request.timeoutMs);

  child.once('error', () => settle(SPAWN_FAILED, true));
  child.once('close', (code) => settle(
    Object.freeze({ kind: 'EXITED', exitCode: code, stdout: Buffer.concat(chunks).toString('utf8') }),
    false,
  ));
  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (settled) {
      return;
    }
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    outputBytes += buffer.length;
    if (outputBytes > MAX_CREDENTIAL_PROCESS_OUTPUT_BYTES) {
      settle(OUTPUT_TOO_LARGE, true);
      return;
    }
    chunks.push(buffer);
  });
  if (request.stdinText !== null) {
    // 子プロセスが先に終わったときの書き込みの誤り（EPIPE など）は、終了コードで判断するので無視する。
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(request.stdinText, 'utf8');
  }
});

/** 固定の文を、Windows PowerShell の起動の引数にする（`-EncodedCommand` は UTF-16LE の base64）。 */
export const powerShellArgumentsFor = (script: string): readonly string[] =>
  Object.freeze([...POWERSHELL_LAUNCH_ARGUMENTS, Buffer.from(script, 'utf16le').toString('base64')]);

// ---------------------------------------------------------------------------------------------------------------
// 固定の文（値を含まない）
// ---------------------------------------------------------------------------------------------------------------

/**
 * DPAPI の固定の文。stdin の 1 行目（値か暗号文の base64）と 2 行目（entropy の UTF-8 の base64）を読み、`ProtectedData` の
 * `Protect`・`Unprotect`（`CurrentUser`）にかけ、結果の base64 を stdout に書く。値は .NET のメソッドだけで扱い、cmdlet の引数に入れない。
 * 失敗は catch して、誤りの文を出さずに `CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE` で終わる。
 */
const dpapiScriptFor = (operation: 'Protect' | 'Unprotect'): string => [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Security',
  '  $inputData = [System.Convert]::FromBase64String([System.Console]::In.ReadLine())',
  '  $entropy = [System.Convert]::FromBase64String([System.Console]::In.ReadLine())',
  `  $outputData = [System.Security.Cryptography.ProtectedData]::${operation}($inputData, $entropy, `
    + '[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '  [System.Console]::Out.Write([System.Convert]::ToBase64String($outputData))',
  '  [System.Array]::Clear($inputData, 0, $inputData.Length)',
  '  [System.Array]::Clear($outputData, 0, $outputData.Length)',
  '} catch {',
  `  exit ${CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE}`,
  '}',
  `exit ${SUCCESS_EXIT_CODE}`,
].join('\n');

const PROTECT_ARGUMENTS = powerShellArgumentsFor(dpapiScriptFor('Protect'));
const UNPROTECT_ARGUMENTS = powerShellArgumentsFor(dpapiScriptFor('Unprotect'));

// ---------------------------------------------------------------------------------------------------------------
// 暗号化の部品
// ---------------------------------------------------------------------------------------------------------------

/** 資格情報の暗号化の部品。暗号文は base64 の文字列。誤りは `CredentialProtectionError`。 */
export interface CredentialProtector {
  protect(plainText: string, entropy: string): Promise<string>;
  unprotect(cipherText: string, entropy: string): Promise<string>;
}

/** 暗号化の部品の内部の作り（テストが偽の子プロセスを渡す）。 */
export interface DpapiCredentialProtectorDependencies {
  readonly spawnProcess: CredentialProcessSpawner;
  /** 実行している環境（`process.platform` の値）。`CREDENTIAL_PLATFORM` でなければ、使えない。 */
  readonly platform: string;
  /** 子プロセスを待つ時間の上限（ms。既定は `CREDENTIAL_PROCESS_TIMEOUT_MS`）。 */
  readonly timeoutMs?: number;
}

/** 正しい base64（標準の文字、`=` の埋め、正規の形）の文字列か。 */
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const isProtectedText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_PROTECTED_TEXT_LENGTH && CANONICAL_BASE64_PATTERN.test(value);

/** 暗号化に渡せる文字列（空でない、上限まで、対にならないサロゲートがない）か。 */
const isProtectableText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_PROTECTOR_INPUT_LENGTH && !hasLoneSurrogate(value);

/** 出力の末尾の改行（あれば 1 つ）を除く。 */
const withoutTrailingNewline = (output: string): string => output.replace(/\r?\n$/u, '');

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const fail = (code: CredentialProtectionErrorCode): never => {
  throw new CredentialProtectionError(code);
};

/** 子プロセスの結果から、stdout の 1 行（base64）を取り出す。成功でなければ、固定のコードで失敗にする。 */
const protectedOutputOf = (outcome: CredentialProcessOutcome): string => {
  switch (outcome.kind) {
    case 'SPAWN_FAILED':
      return fail('PROTECTION_UNAVAILABLE');
    case 'TIMED_OUT':
      return fail('PROTECTION_TIMEOUT');
    case 'OUTPUT_TOO_LARGE':
      return fail('PROTECTION_FAILED');
    case 'EXITED': {
      const output = withoutTrailingNewline(outcome.stdout);
      return outcome.exitCode === SUCCESS_EXIT_CODE && isProtectedText(output) ? output : fail('PROTECTION_FAILED');
    }
  }
};

/** 暗号化の部品の内部の作り（テストが偽の子プロセスを渡す）。本番は `createDpapiCredentialProtector`。 */
export const createDpapiCredentialProtectorWith = (dependencies: DpapiCredentialProtectorDependencies): CredentialProtector => {
  const timeoutMs = resolveTimeoutMs(dependencies.timeoutMs, CREDENTIAL_PROCESS_TIMEOUT_MS);
  const { spawnProcess, platform } = dependencies;

  const run = async (args: readonly string[], firstLine: string, entropy: string): Promise<string> => {
    if (platform !== CREDENTIAL_PLATFORM) {
      return fail('PROTECTION_UNAVAILABLE');
    }
    const stdinText = `${firstLine}\n${Buffer.from(entropy, 'utf8').toString('base64')}\n`;
    const outcome = await runCredentialProcess(spawnProcess, {
      file: WINDOWS_POWERSHELL_PATH,
      args,
      stdinText,
      captureStdout: true,
      timeoutMs,
    });
    return protectedOutputOf(outcome);
  };

  return Object.freeze({
    async protect(plainText: string, entropy: string): Promise<string> {
      if (!isProtectableText(plainText) || !isProtectableText(entropy)) {
        return fail('PROTECTION_INPUT_INVALID');
      }
      return run(PROTECT_ARGUMENTS, Buffer.from(plainText, 'utf8').toString('base64'), entropy);
    },
    async unprotect(cipherText: string, entropy: string): Promise<string> {
      if (!isProtectedText(cipherText) || !isProtectableText(entropy)) {
        return fail('PROTECTION_INPUT_INVALID');
      }
      const output = await run(UNPROTECT_ARGUMENTS, cipherText, entropy);
      try {
        return STRICT_UTF8.decode(Buffer.from(output, 'base64'));
      } catch {
        return fail('PROTECTION_FAILED');
      }
    },
  });
};

/** 暗号化の部品の本番の入口（引数なし。本物の `spawn` と `process.platform` を使う）。 */
export const createDpapiCredentialProtector = (): CredentialProtector =>
  createDpapiCredentialProtectorWith({ spawnProcess: spawnCredentialProcess, platform: process.platform });

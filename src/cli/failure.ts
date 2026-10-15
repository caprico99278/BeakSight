/**
 * 監査の外の失敗（例外）から、終了コードへの変換（Task 24 の設計書 4.1。T24a）。`main.ts`（CLI）と、ワーカー（Task 24 の 4.2）で共用する
 * 1 つの関数にする。文言は持たない（CLI は `main.ts` が、種類ごとに今と同じ行を `output.ts` で組み立てる）。
 * - 設定のエラー（`ConfigError`）: 終了コード 4（`CONFIG_ERROR`）。
 * - artifact の書き出しの入出力の失敗（`ArtifactWriteError`）: 終了コード 1（FAILED と同じ）。
 * - 予期しない例外（それ以外のすべての値）: 終了コード 1（FAILED と同じ）。
 * 終了コードの値は、`exit-codes.ts` の表から取る。
 */
import { isConfigError, type ConfigError } from '../config/config-error.js';
import { ArtifactWriteError } from '../report/artifact-writer.js';
import { CONFIG_ERROR_EXIT_CODE, CONFIG_ERROR_OUTCOME, FAILURE_EXIT_CODE } from './exit-codes.js';

/** 監査の外の失敗の種類の閉じた一覧（設定のエラー、artifact の書き出しの失敗、予期しない例外）。 */
export const CLI_FAILURE_KINDS = Object.freeze([CONFIG_ERROR_OUTCOME, 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE'] as const);
export type CliFailureKind = (typeof CLI_FAILURE_KINDS)[number];

/** 監査の外の失敗の、種類と、元の例外と、終了コード。 */
export type CliFailure =
  | { readonly kind: typeof CONFIG_ERROR_OUTCOME; readonly error: ConfigError; readonly exitCode: number }
  | { readonly kind: Extract<CliFailureKind, 'ARTIFACT_WRITE_FAILED'>; readonly error: ArtifactWriteError; readonly exitCode: number }
  | { readonly kind: Extract<CliFailureKind, 'UNEXPECTED_FAILURE'>; readonly error: unknown; readonly exitCode: number };

/** 例外（`error`）を、失敗の種類と終了コードに変換する。投げない。 */
export function classifyCliFailure(error: unknown): CliFailure {
  if (isConfigError(error)) {
    return { kind: CONFIG_ERROR_OUTCOME, error, exitCode: CONFIG_ERROR_EXIT_CODE };
  }
  if (error instanceof ArtifactWriteError) {
    return { kind: 'ARTIFACT_WRITE_FAILED', error, exitCode: FAILURE_EXIT_CODE };
  }
  return { kind: 'UNEXPECTED_FAILURE', error, exitCode: FAILURE_EXIT_CODE };
}

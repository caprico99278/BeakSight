// T24a（Task 24 の設計書 4.1）: 例外から終了コードへの変換（`classifyCliFailure`）。`main.ts` の扱い（設定のエラー → 4、artifact の書き出しの
// 失敗と予期しない例外 → 1）を 1 つの関数にしたもの。CLI とワーカーで共用する。CLI の表示が変わらないことは、`tests/unit/cli.test.ts` と
// `tests/integration/cli-output-parity.test.ts` で確かめる。
import { describe, expect, it } from 'vitest';
import { CONFIG_ERROR_EXIT_CODE, CONFIG_ERROR_OUTCOME, FAILURE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { CLI_FAILURE_KINDS, classifyCliFailure } from '../../src/cli/failure.js';
import { ConfigError } from '../../src/config/config-error.js';
import { ArtifactWriteError } from '../../src/report/artifact-writer.js';

describe('classifyCliFailure: the exit code of an exception', () => {
  it('lists the kinds of the failure', () => {
    expect(CLI_FAILURE_KINDS).toEqual([CONFIG_ERROR_OUTCOME, 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE']);
  });

  it('gives exit code 4 to a configuration error, with the error itself', () => {
    const error = new ConfigError('CONFIG_JSON_INVALID', 'the configuration is not JSON', ['Unexpected token']);

    expect(classifyCliFailure(error)).toEqual({ kind: CONFIG_ERROR_OUTCOME, error, exitCode: CONFIG_ERROR_EXIT_CODE });
  });

  it('gives exit code 1 to a failure to write the artifacts', () => {
    const error = new ArtifactWriteError('C:/blocked/run.json', new Error('EBUSY'));

    expect(classifyCliFailure(error)).toEqual({ kind: 'ARTIFACT_WRITE_FAILED', error, exitCode: FAILURE_EXIT_CODE });
  });

  it.each([new Error('unexpected'), 'a string', null, undefined])('gives exit code 1 to an unexpected exception (%s)', (error) => {
    expect(classifyCliFailure(error)).toEqual({ kind: 'UNEXPECTED_FAILURE', error, exitCode: FAILURE_EXIT_CODE });
  });
});

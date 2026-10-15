/**
 * CCX-5（台帳の N2 の control の側）: 管理データを開く誤りを、止める理由と詳細に振り分ける部品（`controlStoreFailureOf`）は
 * `src/control/store/store-errors.ts` の 1 か所にある。`npm run setup:local` と画面のサーバの準備が使う。
 * - `ControlStoreError` は、その理由と誤りの文（`<reason>: <detail>`）のまま。
 * - それ以外は `DATABASE_OPEN_FAILED`。詳細は、`Error` なら `message`、そうでなければ `String(error)`（振る舞いを変えない）。
 */
import { describe, expect, it } from 'vitest';
import { ControlStoreError, controlStoreFailureOf } from '../../src/control/store/store-errors.js';

describe('CCX-5: control store failure classification (N2)', () => {
  it('keeps the reason and the message of a ControlStoreError', () => {
    const error = new ControlStoreError('DATABASE_LOCKED', 'another program holds the file');
    expect(controlStoreFailureOf(error)).toEqual({ reason: 'DATABASE_LOCKED', detail: 'DATABASE_LOCKED: another program holds the file' });
  });

  it('maps any other Error to DATABASE_OPEN_FAILED with its message', () => {
    expect(controlStoreFailureOf(new TypeError('unexpected shape'))).toEqual({ reason: 'DATABASE_OPEN_FAILED', detail: 'unexpected shape' });
  });

  it('maps a thrown value that is not an Error to DATABASE_OPEN_FAILED with String(value)', () => {
    expect(controlStoreFailureOf('plain text')).toEqual({ reason: 'DATABASE_OPEN_FAILED', detail: 'plain text' });
    expect(controlStoreFailureOf({ message: 'not an Error' })).toEqual({ reason: 'DATABASE_OPEN_FAILED', detail: '[object Object]' });
    expect(controlStoreFailureOf(undefined)).toEqual({ reason: 'DATABASE_OPEN_FAILED', detail: 'undefined' });
  });
});

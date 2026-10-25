// PRE42-BN（2026-10-24 のユーザーの判断）: `START` の、プロファイルの名前の項目（`profileName`）。ChatGPT 用バンドルのファイル名だけに使う。
// - 監査のジョブだけが持てる（バンドルを書くのは監査の段だけ。まとめて実行では、監査は最初の段だけなので、`START` の種類で決まる）。
// - 1 文字以上、`MAX_WORKER_PROFILE_NAME_LENGTH` 文字までの文字列。省略は名前の部分なし（今の形）。
import { describe, expect, it } from 'vitest';
import {
  MAX_WORKER_PROFILE_NAME_LENGTH,
  WORKER_PROTOCOL_VERSION,
  validateParentToWorkerMessage,
} from '../../src/control/worker-protocol.js';

const START = Object.freeze({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-profile-name',
  jobKind: 'AUDIT',
  targetConfigPath: 'config/targets/example.json',
  startNew: true,
  targetConfigSha256: 'a'.repeat(64),
});

describe('PRE42-BN: the profile name in START', () => {
  it('accepts a profile name for an audit job, and its absence', () => {
    expect(validateParentToWorkerMessage({ ...START, profileName: 'example-public' }).ok).toBe(true);
    expect(validateParentToWorkerMessage({ ...START, profileName: '管理画面' }).ok).toBe(true);
    expect(validateParentToWorkerMessage({ ...START, profileName: 'x'.repeat(MAX_WORKER_PROFILE_NAME_LENGTH) }).ok).toBe(true);
    expect(validateParentToWorkerMessage(START).ok).toBe(true);
  });

  it('rejects a value that is not a string, an empty string, and a string that is too long', () => {
    expect(MAX_WORKER_PROFILE_NAME_LENGTH).toBe(256);
    for (const value of [null, 1, true, [], {}, '', 'x'.repeat(MAX_WORKER_PROFILE_NAME_LENGTH + 1)]) {
      expect(validateParentToWorkerMessage({ ...START, profileName: value }).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects the item for the job kinds that write no audit bundle', () => {
    expect(validateParentToWorkerMessage({ ...START, jobKind: 'ENTRY_CHECK', profileName: 'example-public' }).ok).toBe(false);
    const checked = validateParentToWorkerMessage({ ...START, jobKind: 'ENTRY_CHECK', profileName: 'example-public' });
    expect(checked.ok ? [] : checked.errors).toContain('/profileName is not allowed for ENTRY_CHECK');
  });
});

/**
 * CCX-5（台帳の CC-065）: 資格情報を保存できるプラットフォームの値と、起動のときの準備の手順の置き場所（`src/control/credentials/`）。
 * - `CREDENTIAL_PLATFORM` は `credential-platform.ts` の 1 か所で公開する（資格情報のファイルの部品、暗号化の部品、画面のサーバが使う）。
 * - `prepareCredentialStorage`（一時のファイルを消してから、暗号化の往復を 1 回確かめる）は `credential-preparation.ts` の 1 か所に置き、
 *   `npm run setup:local`（`src/control/setup-local.ts`）は同じ関数を公開し続ける。
 * 本物の資格情報・子プロセスは使わない（偽物の部品だけ）。
 */
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLATFORM } from '../../src/control/credentials/credential-platform.js';
import { prepareCredentialStorage } from '../../src/control/credentials/credential-preparation.js';
import type { CredentialProtectionState } from '../../src/control/credentials/credential-store.js';
import { prepareCredentialStorage as setupLocalPrepareCredentialStorage } from '../../src/control/setup-local.js';

/** 呼ばれた順を記録する偽物の部品。 */
const recordingStore = (options: {
  readonly removed: number | Error;
  readonly protection: CredentialProtectionState;
}): { readonly calls: string[]; readonly store: Parameters<typeof prepareCredentialStorage>[0] } => {
  const calls: string[] = [];
  return {
    calls,
    store: {
      removeTemporaryFiles: async () => {
        calls.push('removeTemporaryFiles');
        if (options.removed instanceof Error) {
          throw options.removed;
        }
        return options.removed;
      },
      checkProtection: async () => {
        calls.push('checkProtection');
        return options.protection;
      },
    },
  };
};

const REMOVED_COUNT = 2;

describe('CCX-5: credential platform and startup preparation (CC-065)', () => {
  it('publishes the platform where credentials can be stored as one named value (Windows only)', () => {
    expect(CREDENTIAL_PLATFORM).toBe('win32');
  });

  it('removes the temporary files first, then checks the protection once, and returns a frozen result', async () => {
    const { calls, store } = recordingStore({ removed: REMOVED_COUNT, protection: 'AVAILABLE' });
    const preparation = await prepareCredentialStorage(store);
    expect(calls).toEqual(['removeTemporaryFiles', 'checkProtection']);
    expect(preparation).toEqual({ protection: 'AVAILABLE', removedTemporaryFiles: REMOVED_COUNT });
    expect(Object.isFrozen(preparation)).toBe(true);
  });

  it('keeps going when the temporary files cannot be removed (the count becomes null)', async () => {
    const { calls, store } = recordingStore({ removed: new Error('unreadable folder'), protection: 'UNAVAILABLE' });
    const preparation = await prepareCredentialStorage(store);
    expect(calls).toEqual(['removeTemporaryFiles', 'checkProtection']);
    expect(preparation).toEqual({ protection: 'UNAVAILABLE', removedTemporaryFiles: null });
  });

  it('setup-local keeps exposing the same preparation function (no second copy of the steps)', () => {
    expect(setupLocalPrepareCredentialStorage).toBe(prepareCredentialStorage);
  });
});

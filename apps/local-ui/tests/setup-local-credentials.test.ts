/**
 * 起動のときの資格情報の準備（Task 26 の設計書 4.1 の「起動のとき」。T26e）。`npm run setup:local` の部品（`src/control/setup-local.ts` の
 * `prepareCredentialStorage`・`credentialStorageLines`）と、画面のサーバの部品（`src/server/credential-runtime.ts` の
 * `credentialEnvironmentStateOf`）を確かめる。
 * - 資格情報のフォルダに残った書きかけの一時のファイル（`.<名前>.credential.json.<UUID>.tmp`）だけを消し、本体は残す。
 * - 暗号化の往復を 1 回だけ確かめ、結果（使える・使えない）を返す。表示の行に、値（目印）を出さない。
 * - フォルダがない（まだ保存していない）ときは何も作らない（リポジトリの `local/secrets/` は作らない。一時の root だけ）。
 * 資格情報は、偽の暗号化の部品（`tests/helpers/test-credential-store.ts`）で作る。本物の DPAPI は使わない。
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_DIRECTORY_NAME, CREDENTIAL_PARENT_DIRECTORY_NAME } from '../../../src/control/credentials/credential-store.js';
import type { CredentialProtector } from '../../../src/control/credentials/dpapi-protector.js';
import { CredentialProtectionError } from '../../../src/control/credentials/dpapi-protector.js';
import { credentialStorageLines, prepareCredentialStorage } from '../../../src/control/setup-local.js';
import { temporaryPathFor } from '../../../src/core/temporary-file-name.js';
import { formatCount } from '../../../src/presentation/format.js';
import { SETUP_LOCAL_TEXT, cliFieldText } from '../../../src/presentation/messages.js';
import { createTestCredentialProtector, createTestCredentialStore, type TestCredentialStore } from '../../../tests/helpers/test-credential-store.js';
import { credentialEnvironmentStateOf } from '../src/server/credential-runtime';

const PROFILE_ID = 't26e-setup';
const LOGIN_ORIGIN = 'https://app.example.invalid';
/** 実行ごとの目印（値を出力しない）。 */
const USERNAME_MARKER = `t26e-user-${process.pid}-${Date.now()}`;
const PASSWORD_MARKER = `t26e-pass-${process.pid}-${Date.now()}`;

let space: TestCredentialStore | undefined;

afterEach(async () => {
  await space?.remove();
  space = undefined;
});

/** 暗号化の往復で失敗する偽の暗号化の部品（暗号化が使えない場面）。 */
const failingProtector: CredentialProtector = {
  protect: async () => {
    throw new CredentialProtectionError('PROTECTION_UNAVAILABLE');
  },
  unprotect: async () => {
    throw new CredentialProtectionError('PROTECTION_UNAVAILABLE');
  },
};

describe('T26e: the credential preparation of setup:local', () => {
  it('removes only the temporary files left in the credential folder, and keeps the credential file', async () => {
    space = await createTestCredentialStore();
    await space.store.register({ profileId: PROFILE_ID, loginOrigin: LOGIN_ORIGIN, username: USERNAME_MARKER, password: PASSWORD_MARKER });
    const credentialFile = join(space.store.directory, `${PROFILE_ID}.credential.json`);
    const leftovers = [temporaryPathFor(credentialFile), temporaryPathFor(join(space.store.directory, 'other-profile.credential.json'))];
    for (const path of leftovers) {
      writeFileSync(path, '{}');
    }
    const unrelated = join(space.store.directory, 'notes.txt');
    writeFileSync(unrelated, 'kept');

    const preparation = await prepareCredentialStorage(space.store);

    expect(preparation).toEqual({ protection: 'AVAILABLE', removedTemporaryFiles: leftovers.length });
    expect(leftovers.filter((path) => existsSync(path))).toEqual([]);
    expect(existsSync(credentialFile)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('creates nothing when the credential folder does not exist yet', async () => {
    space = await createTestCredentialStore();
    const preparation = await prepareCredentialStorage(space.store);
    expect(preparation).toEqual({ protection: 'AVAILABLE', removedTemporaryFiles: 0 });
    expect(existsSync(join(space.root, CREDENTIAL_PARENT_DIRECTORY_NAME, CREDENTIAL_DIRECTORY_NAME))).toBe(false);
    expect(readdirSync(space.root)).toEqual([]);
  });

  it('reports that the encryption is not available, without stopping', async () => {
    space = await createTestCredentialStore({ protector: failingProtector });
    const preparation = await prepareCredentialStorage(space.store);
    expect(preparation).toEqual({ protection: 'UNAVAILABLE', removedTemporaryFiles: 0 });
    expect(credentialStorageLines(preparation)).toEqual([
      cliFieldText(SETUP_LOCAL_TEXT.credentialProtectionLabel, SETUP_LOCAL_TEXT.credentialProtectionUnavailable),
    ]);
  });

  it('shows the encryption state and the number of removed files, and no value', async () => {
    space = await createTestCredentialStore({ protector: createTestCredentialProtector() });
    await space.store.register({ profileId: PROFILE_ID, loginOrigin: LOGIN_ORIGIN, username: USERNAME_MARKER, password: PASSWORD_MARKER });
    writeFileSync(temporaryPathFor(join(space.store.directory, `${PROFILE_ID}.credential.json`)), USERNAME_MARKER);
    const lines = credentialStorageLines(await prepareCredentialStorage(space.store));
    expect(lines).toEqual([
      SETUP_LOCAL_TEXT.temporaryCredentialFilesRemovedText(formatCount(1)),
      cliFieldText(SETUP_LOCAL_TEXT.credentialProtectionLabel, SETUP_LOCAL_TEXT.credentialProtectionAvailable),
    ]);
    const joined = lines.join('\n');
    expect(joined.includes(USERNAME_MARKER) || joined.includes(PASSWORD_MARKER)).toBe(false);
  });

  it('shows that the temporary files could not be cleaned up when the folder cannot be read', () => {
    expect(credentialStorageLines({ protection: 'AVAILABLE', removedTemporaryFiles: null })).toEqual([
      SETUP_LOCAL_TEXT.temporaryCredentialFilesUnreadable,
      cliFieldText(SETUP_LOCAL_TEXT.credentialProtectionLabel, SETUP_LOCAL_TEXT.credentialProtectionAvailable),
    ]);
  });
});

describe('T26e: the credential environment state of the local UI server (judged on the server)', () => {
  it.each([
    [true, 'AVAILABLE', 'AVAILABLE'],
    [true, 'UNAVAILABLE', 'UNAVAILABLE'],
    [false, 'UNAVAILABLE', 'NOT_WINDOWS'],
    [false, 'AVAILABLE', 'NOT_WINDOWS'],
  ] as const)('platform supported %s and protection %s is %s', (platformSupported, protection, expected) => {
    expect(credentialEnvironmentStateOf(platformSupported, protection)).toBe(expected);
  });
});

/**
 * T26g-2（T26R の M1）: 本物の DPAPI と icacls で、資格情報のファイルの部品が junction とハードリンクを拒むことの結合の検査（Windows だけ）。
 * - T26R の実験（`local` か `local/secrets` を、本物の部品で作った別の場所の資格情報への junction にする、ファイルを外のファイルへの
 *   ハードリンクにする）を再現し、読み出しも書き込みも `CREDENTIAL_STORAGE_UNSAFE` で、先のファイルが変わらないことを確かめる。
 * - 一時のフォルダだけを使う。junction は先に unlink してから消す。目印の値は実行ごとのランダムな文字列で、`includes` の真偽だけで確かめる。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_FILE_SUFFIX,
  CREDENTIAL_PARENT_DIRECTORY_NAME,
  CredentialStoreError,
  createCredentialStore,
  credentialFilePathFor,
  resolveCredentialDirectory,
  type CredentialStore,
} from '../../src/control/credentials/credential-store.js';

const IS_WINDOWS = process.platform === 'win32';
const TEST_TIMEOUT_MS = 60_000;
const PROFILE_ID = 'link-profile';
const ORIGIN = 'https://login.example.test';

const roots: string[] = [];
const junctions: string[] = [];
afterAll(() => {
  for (const junction of junctions.splice(0).reverse()) {
    if (existsSync(junction)) {
      unlinkSync(junction);
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'beaksight-t26g2-links-'));
  roots.push(root);
  return root;
};
const makeJunction = (target: string, path: string): void => {
  symlinkSync(target, path, 'junction');
  junctions.push(path);
};

const marker = (): string => `目印${randomBytes(9).toString('base64url')}「記号」!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;

const caughtCode = async (operation: () => Promise<unknown>): Promise<string> => {
  try {
    await operation();
  } catch (error) {
    return error instanceof CredentialStoreError ? error.code : `OTHER ${error instanceof Error ? error.name : typeof error}`;
  }
  return 'NO_ERROR';
};

const allOperations = (store: CredentialStore): readonly (readonly [string, () => Promise<unknown>])[] => [
  ['readMetadata', () => store.readMetadata(PROFILE_ID)],
  ['decrypt', () => store.decrypt(PROFILE_ID, ORIGIN)],
  ['register', () => store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() })],
  ['change', () => store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() })],
  ['replaceAll', () => store.replaceAll({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() })],
  ['remove', () => store.remove(PROFILE_ID)],
  ['removeTemporaryFiles', () => store.removeTemporaryFiles()],
];

/** 本物の部品で、別の根に資格情報を作る（junction の先）。 */
const realCredentialElsewhere = async () => {
  const root = temporaryRoot();
  const store = createCredentialStore(root);
  const username = marker();
  await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username, password: marker() });
  const path = credentialFilePathFor(store.directory, PROFILE_ID);
  return { root, store, path, bytes: readFileSync(path), username };
};

describe.skipIf(!IS_WINDOWS)('T26g-2: real DPAPI and icacls refuse junctions and hard links (Windows only; junctions, DPAPI and icacls exist only on Windows)', () => {
  it('refuses every read and write through a junction at local/, and the real credential there stays unchanged', async () => {
    const elsewhere = await realCredentialElsewhere();
    const root = temporaryRoot();
    makeJunction(join(elsewhere.root, CREDENTIAL_PARENT_DIRECTORY_NAME), join(root, CREDENTIAL_PARENT_DIRECTORY_NAME));
    const store = createCredentialStore(root);
    for (const [name, operation] of allOperations(store)) {
      expect(await caughtCode(operation), name).toBe('CREDENTIAL_STORAGE_UNSAFE');
    }
    expect(readFileSync(elsewhere.path).equals(elsewhere.bytes)).toBe(true);
    expect(readdirSync(elsewhere.store.directory)).toEqual([`${PROFILE_ID}${CREDENTIAL_FILE_SUFFIX}`]);
    // 本来の場所からは、今までどおり読める。
    expect((await elsewhere.store.decrypt(PROFILE_ID, ORIGIN)).username === elsewhere.username).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('refuses every read and write through a junction at local/secrets', async () => {
    const elsewhere = await realCredentialElsewhere();
    const root = temporaryRoot();
    mkdirSync(join(root, CREDENTIAL_PARENT_DIRECTORY_NAME));
    makeJunction(elsewhere.store.directory, resolveCredentialDirectory(root));
    const store = createCredentialStore(root);
    for (const [name, operation] of allOperations(store)) {
      expect(await caughtCode(operation), name).toBe('CREDENTIAL_STORAGE_UNSAFE');
    }
    expect(readFileSync(elsewhere.path).equals(elsewhere.bytes)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('refuses every read and write of a credential file that is a hard link to an outside file', async () => {
    const root = temporaryRoot();
    const store = createCredentialStore(root);
    await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() });
    const path = credentialFilePathFor(store.directory, PROFILE_ID);
    const outside = join(temporaryRoot(), `outside${CREDENTIAL_FILE_SUFFIX}`);
    writeFileSync(outside, readFileSync(path));
    unlinkSync(path);
    linkSync(outside, path);
    const before = readFileSync(outside);
    for (const [name, operation] of allOperations(store).filter(([name]) => name !== 'removeTemporaryFiles')) {
      expect(await caughtCode(operation), name).toBe('CREDENTIAL_STORAGE_UNSAFE');
    }
    expect(readFileSync(outside).equals(before)).toBe(true);
    // 普通のファイルに戻せば、今までどおり読み書きできる。
    unlinkSync(path);
    writeFileSync(path, before);
    expect((await store.readMetadata(PROFILE_ID))?.credentialRevision).toBe(1);
    await store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() });
    expect((await store.readMetadata(PROFILE_ID))?.credentialRevision).toBe(2);
  }, TEST_TIMEOUT_MS);
});

/**
 * T26g-2（T26R の M1。Task 26 の設計書 4.1、変更履歴の「T26R」）: 資格情報のファイルの部品が、reparse point（junction、symlink）と
 * ハードリンクを拒むことの単体の検査。暗号化の部品と子プロセスは偽物（どの OS でも動く）。本物の DPAPI と icacls での確かめは
 * `tests/integration/credential-store-links.test.ts`（Windows だけ）。
 * - `local` か `local/secrets` がリンク（Windows は junction、ほかは dir の symlink）、資格情報のファイルがハードリンク（リンクの数が 2）なら、
 *   読み出し（`readMetadata`、`decrypt`）も書き込み（登録、変更、入れ直し、削除、一時のファイルの片付け）も `CREDENTIAL_STORAGE_UNSAFE`。
 *   リンクの先のファイルは変わらない。
 * - 目印の値は実行ごとに作るランダムな文字列で、失敗の文に値が出ないよう、`includes` の真偽だけで確かめる。
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_DIRECTORY_NAME,
  CREDENTIAL_FILE_SUFFIX,
  CREDENTIAL_PARENT_DIRECTORY_NAME,
  CredentialStoreError,
  ICACLS_PATH,
  createCredentialStoreWith,
  credentialFilePathFor,
  resolveCredentialDirectory,
  type CredentialStore,
} from '../../src/control/credentials/credential-store.js';
import {
  CredentialProtectionError,
  type CredentialChildProcess,
  type CredentialProcessSpawner,
  type CredentialProtector,
} from '../../src/control/credentials/dpapi-protector.js';
import { temporaryPathFor } from '../../src/core/temporary-file-name.js';

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const USER_SID = 'S-1-5-21-1000-2000-3000-1001';
const FULL_CONTROL = 2_032_127;
const SAFE_ACL = [`USER ${USER_SID}`, `OWNER ${USER_SID}`, 'PROTECTED True', `RULE ${USER_SID} Allow ${FULL_CONTROL} 3 0 False`].join('\n');
const PROFILE_ID = 'link-profile';
const ORIGIN = 'https://login.example.test';

const marker = (): string => `目印-${randomBytes(12).toString('hex')}-記号!"'\`$<>&|;%`;

/** 偽の暗号化の部品（暗号文はランダム。復号は同じ entropy のときだけ）。 */
const createFakeCredentialProtector = () => {
  const table = new Map<string, { readonly plain: string; readonly entropy: string }>();
  const unprotects: string[] = [];
  const protector: CredentialProtector = {
    async protect(plain, entropy) {
      const cipher = randomBytes(48).toString('base64');
      table.set(cipher, { plain, entropy });
      return cipher;
    },
    async unprotect(cipher, entropy) {
      unprotects.push(entropy);
      const entry = table.get(cipher);
      if (entry === undefined || entry.entropy !== entropy) {
        throw new CredentialProtectionError('PROTECTION_FAILED');
      }
      return entry.plain;
    },
  };
  return { protector, unprotects };
};

class FakeCredentialChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  kill(): boolean {
    return true;
  }
}

/** 偽の子プロセス（権限の読み取りは、いつも今の利用者だけ。icacls は成功）。 */
const createFakeCredentialSpawner = (): CredentialProcessSpawner => (file, _args, options) => {
  const child = new FakeCredentialChildProcess();
  const respond = (): void => {
    if (file === ICACLS_PATH) {
      setImmediate(() => child.emit('close', 0, null));
      return;
    }
    child.stdout.end(SAFE_ACL);
    child.stdout.once('end', () => setImmediate(() => child.emit('close', 0, null)));
    child.stdout.resume();
  };
  if (options.stdio[0] === 'pipe') {
    child.stdin.resume();
    child.stdin.on('end', respond);
  } else {
    setImmediate(respond);
  }
  return child as unknown as CredentialChildProcess;
};

const roots: string[] = [];
const links: string[] = [];
afterEach(() => {
  // junction と symlink は、先に unlink する（先をたどって消さない）。
  for (const link of links.splice(0).reverse()) {
    if (existsSync(link)) {
      unlinkSync(link);
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'beaksight-t26g2-'));
  roots.push(root);
  return root;
};

const storeAt = (root: string, protector: CredentialProtector): CredentialStore => createCredentialStoreWith(root, {
  protector,
  spawnProcess: createFakeCredentialSpawner(),
  now: () => new Date(Date.UTC(2026, 9, 11, 1, 2, 3)),
  platform: 'win32',
  renameFile: async (from, to) => {
    const { rename } = await import('node:fs/promises');
    await rename(from, to);
  },
  waitBeforeRetry: async () => undefined,
});

const makeLink = (target: string, path: string): void => {
  symlinkSync(target, path, LINK_TYPE);
  links.push(path);
};

/** 普通の構成の資格情報を、別の根に作る（リンクの先にする）。 */
const preparedElsewhere = async (protector: CredentialProtector) => {
  const root = temporaryRoot();
  const store = storeAt(root, protector);
  await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() });
  const path = credentialFilePathFor(store.directory, PROFILE_ID);
  return { root, directory: store.directory, path, bytes: readFileSync(path) };
};

const caughtCode = async (operation: () => Promise<unknown>): Promise<string> => {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialStoreError);
    return (error as CredentialStoreError).code;
  }
  return 'NO_ERROR';
};

/** 読み出しと書き込みのすべての操作。 */
const allOperations = (store: CredentialStore): readonly (readonly [string, () => Promise<unknown>])[] => [
  ['readMetadata', () => store.readMetadata(PROFILE_ID)],
  ['decrypt', () => store.decrypt(PROFILE_ID, ORIGIN)],
  ['register', () => store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() })],
  ['change', () => store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() })],
  ['replaceAll', () => store.replaceAll({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() })],
  ['remove', () => store.remove(PROFILE_ID)],
  ['removeTemporaryFiles', () => store.removeTemporaryFiles()],
];

describe('T26g-2 (M1): the credential store refuses reparse points and hard links', () => {
  it('refuses every read and write when local/ is a link to another folder, leaving the other folder unchanged', async () => {
    const { protector, unprotects } = createFakeCredentialProtector();
    const elsewhere = await preparedElsewhere(protector);
    const root = temporaryRoot();
    makeLink(join(elsewhere.root, CREDENTIAL_PARENT_DIRECTORY_NAME), join(root, CREDENTIAL_PARENT_DIRECTORY_NAME));
    const store = storeAt(root, protector);
    for (const [name, operation] of allOperations(store)) {
      expect(await caughtCode(operation), name).toBe('CREDENTIAL_STORAGE_UNSAFE');
    }
    expect(readFileSync(elsewhere.path).equals(elsewhere.bytes)).toBe(true);
    expect(readdirSync(elsewhere.directory)).toEqual([`${PROFILE_ID}${CREDENTIAL_FILE_SUFFIX}`]);
    expect(unprotects).toEqual([]);
  });

  it('refuses every read and write when local/secrets is a link to another folder', async () => {
    const { protector, unprotects } = createFakeCredentialProtector();
    const elsewhere = await preparedElsewhere(protector);
    const root = temporaryRoot();
    mkdirSync(join(root, CREDENTIAL_PARENT_DIRECTORY_NAME));
    makeLink(elsewhere.directory, resolveCredentialDirectory(root));
    const store = storeAt(root, protector);
    const leftover = temporaryPathFor(elsewhere.path);
    writeFileSync(leftover, 'partial');
    for (const [name, operation] of allOperations(store)) {
      expect(await caughtCode(operation), name).toBe('CREDENTIAL_STORAGE_UNSAFE');
    }
    expect(readFileSync(elsewhere.path).equals(elsewhere.bytes)).toBe(true);
    expect(existsSync(leftover)).toBe(true);
    expect(unprotects).toEqual([]);
  });

  it('refuses every read and write of a credential file that is a hard link (link count 2)', async () => {
    const { protector, unprotects } = createFakeCredentialProtector();
    const root = temporaryRoot();
    const store = storeAt(root, protector);
    // 普通の構成を作ってから、ファイルを外のファイルへのハードリンクに置き換える。
    await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() });
    const path = credentialFilePathFor(store.directory, PROFILE_ID);
    const outside = join(root, `outside${CREDENTIAL_FILE_SUFFIX}`);
    writeFileSync(outside, readFileSync(path));
    unlinkSync(path);
    linkSync(outside, path);
    const before = readFileSync(outside);
    for (const [name, operation] of allOperations(store).filter(([name]) => name !== 'removeTemporaryFiles')) {
      expect(await caughtCode(operation), name).toBe('CREDENTIAL_STORAGE_UNSAFE');
    }
    expect(readFileSync(outside).equals(before)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(unprotects).toEqual([]);
  });

  it('keeps reading and writing the normal layout', async () => {
    const { protector } = createFakeCredentialProtector();
    const root = temporaryRoot();
    const store = storeAt(root, protector);
    expect(await store.readMetadata(PROFILE_ID)).toBeNull();
    const username = marker();
    await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username, password: marker() });
    await store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() });
    expect((await store.decrypt(PROFILE_ID, ORIGIN)).username === username).toBe(true);
    expect((await store.readMetadata(PROFILE_ID))?.credentialRevision).toBe(2);
    expect(await store.removeTemporaryFiles()).toBe(0);
    expect(await store.remove(PROFILE_ID)).toBe(true);
    expect(readdirSync(resolveCredentialDirectory(root))).toEqual([]);
    expect(CREDENTIAL_DIRECTORY_NAME.length).toBeGreaterThan(0);
  });
});

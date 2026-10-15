// T26d-1（Task 26 の設計書 4.4、6 章）: 自動ログインの段のテストが使う、資格情報のファイルの部品（`createCredentialStoreWith`）を、偽の暗号化の
// 部品と偽の子プロセス（PowerShell の権限の読み取りと icacls の代わり）で、一時のフォルダに作る補助。本物の DPAPI と icacls は使わない
// （端から端の確かめは T26d-2）。Windows の資格情報マネージャーにも登録しない。
// - 暗号文は毎回ランダムで、復号は、暗号化したときの entropy と同じで、同じ偽の部品のときだけ戻す（別の偽の部品では戻せない。復号の失敗の場面）。
// - 権限の読み取りは、icacls の後に「今の利用者だけ」の応答を返す（`credential-store.ts` の確かめを通す）。
// - 値（資格情報の目印）は、記録も出力もしない。
// - T26d-2: 別の process（テストだけのワーカーの入口）でも復号できる偽の暗号化の部品（`createPortableTestCredentialProtector`。テストだけの鍵の
//   AES-256-GCM。entropy を追加の認証データにする）と、それを使う部品の作り方（`createTestCredentialStore` の `protector`）を足した。暗号文は
//   `base64(iv 12 バイト | tag 16 バイト | 本文)`。ワーカーの入口の写し（`PORTABLE_TEST_PROTECTOR_SOURCE`）と同じ形。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ICACLS_PATH, createCredentialStoreWith, type CredentialStore } from '../../src/control/credentials/credential-store.js';
import {
  CredentialProtectionError,
  type CredentialChildProcess,
  type CredentialProcessSpawner,
  type CredentialProtector,
} from '../../src/control/credentials/dpapi-protector.js';

const TEST_USER_SID = 'S-1-5-21-1000-2000-3000-1001';
const OTHER_TEST_SID = 'S-1-5-21-1000-2000-3000-1002';
/** `FileSystemRights.FullControl` の値。 */
const FULL_CONTROL = 2_032_127;
/** 子のフォルダとファイルへ受け継ぐ（ContainerInherit | ObjectInherit）。 */
const CONTAINER_AND_OBJECT_INHERIT = 3;
const CIPHER_BYTES = 48;
const SUCCESS_EXIT_CODE = 0;
/** 移せる偽の暗号化の部品の方式と、鍵・iv・tag の長さ（バイト）。 */
const PORTABLE_CIPHER = 'aes-256-gcm';
const PORTABLE_KEY_BYTES = 32;
const PORTABLE_IV_BYTES = 12;
const PORTABLE_TAG_BYTES = 16;

/** 一時のフォルダの名前の接頭辞。 */
const TEMPORARY_ROOT_PREFIX = 'beaksight-t26d-credential-';

/** 偽の暗号化の部品（復号できるのは、同じ部品で暗号化した、同じ entropy の暗号文だけ）。 */
export const createTestCredentialProtector = (): CredentialProtector => {
  const table = new Map<string, { readonly plain: string; readonly entropy: string }>();
  return {
    async protect(plain, entropy) {
      const cipher = randomBytes(CIPHER_BYTES).toString('base64');
      table.set(cipher, { plain, entropy });
      return cipher;
    },
    async unprotect(cipher, entropy) {
      const entry = table.get(cipher);
      if (entry === undefined || entry.entropy !== entropy) {
        throw new CredentialProtectionError('PROTECTION_FAILED');
      }
      return entry.plain;
    },
  };
};

/** 移せる偽の暗号化の部品の、テストだけの鍵（16 進。資格情報ではない）を作る。 */
export const createPortableTestKey = (): string => randomBytes(PORTABLE_KEY_BYTES).toString('hex');

/**
 * 移せる偽の暗号化の部品（T26d-2）: テストだけの鍵の AES-256-GCM。entropy を追加の認証データにするので、entropy が違えば戻せない。同じ鍵を
 * 渡したワーカーの入口（`PORTABLE_TEST_PROTECTOR_SOURCE`）も、同じ暗号文を戻せる。
 */
export const createPortableTestCredentialProtector = (keyHex: string): CredentialProtector => {
  const key = Buffer.from(keyHex, 'hex');
  return {
    async protect(plain, entropy) {
      const iv = randomBytes(PORTABLE_IV_BYTES);
      const cipher = createCipheriv(PORTABLE_CIPHER, key, iv);
      cipher.setAAD(Buffer.from(entropy, 'utf8'));
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    async unprotect(cipherText, entropy) {
      try {
        const bytes = Buffer.from(cipherText, 'base64');
        const decipher = createDecipheriv(PORTABLE_CIPHER, key, bytes.subarray(0, PORTABLE_IV_BYTES));
        decipher.setAAD(Buffer.from(entropy, 'utf8'));
        decipher.setAuthTag(bytes.subarray(PORTABLE_IV_BYTES, PORTABLE_IV_BYTES + PORTABLE_TAG_BYTES));
        return Buffer.concat([decipher.update(bytes.subarray(PORTABLE_IV_BYTES + PORTABLE_TAG_BYTES)), decipher.final()]).toString('utf8');
      } catch {
        throw new CredentialProtectionError('PROTECTION_FAILED');
      }
    },
  };
};

/**
 * ワーカーの入口（`.mjs`）に埋める、移せる偽の暗号化の部品（`createPortableTestCredentialProtector` と同じ形。`__KEY__` を鍵の 16 進の JSON に
 * 置き換える）。`createCipheriv`・`createDecipheriv` を `node:crypto` から import した入口で使う。
 */
export const PORTABLE_TEST_PROTECTOR_SOURCE = String.raw`
const PORTABLE_KEY = Buffer.from(__KEY__, 'hex');
const portableProtector = {
  async protect(plain, entropy) {
    const iv = randomBytes(${PORTABLE_IV_BYTES});
    const cipher = createCipheriv('${PORTABLE_CIPHER}', PORTABLE_KEY, iv);
    cipher.setAAD(Buffer.from(entropy, 'utf8'));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  },
  async unprotect(cipherText, entropy) {
    const bytes = Buffer.from(cipherText, 'base64');
    const decipher = createDecipheriv('${PORTABLE_CIPHER}', PORTABLE_KEY, bytes.subarray(0, ${PORTABLE_IV_BYTES}));
    decipher.setAAD(Buffer.from(entropy, 'utf8'));
    decipher.setAuthTag(bytes.subarray(${PORTABLE_IV_BYTES}, ${PORTABLE_IV_BYTES + PORTABLE_TAG_BYTES}));
    return Buffer.concat([decipher.update(bytes.subarray(${PORTABLE_IV_BYTES + PORTABLE_TAG_BYTES})), decipher.final()]).toString('utf8');
  },
};
`;

class TestCredentialChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  kill(): boolean {
    return true;
  }
}

/** 権限の読み取りの応答（icacls の前は継承あり、後は今の利用者だけ）。 */
const aclLines = (restricted: boolean): readonly string[] => (restricted
  ? [`USER ${TEST_USER_SID}`, `OWNER ${TEST_USER_SID}`, 'PROTECTED True', `RULE ${TEST_USER_SID} Allow ${FULL_CONTROL} ${CONTAINER_AND_OBJECT_INHERIT} 0 False`]
  : [
    `USER ${TEST_USER_SID}`,
    `OWNER ${TEST_USER_SID}`,
    'PROTECTED False',
    `RULE ${OTHER_TEST_SID} Allow ${FULL_CONTROL} ${CONTAINER_AND_OBJECT_INHERIT} 0 True`,
  ]);

/** 偽の子プロセス（icacls は成功し、権限の読み取りは、その後に今の利用者だけを返す）。stdin の中身は読まずに捨てる。 */
const createTestAclSpawner = (): CredentialProcessSpawner => {
  let restricted = false;
  return (file, _args, options) => {
    const child = new TestCredentialChildProcess();
    const respond = (): void => {
      if (file === ICACLS_PATH) {
        restricted = true;
        setImmediate(() => child.emit('close', SUCCESS_EXIT_CODE, null));
        return;
      }
      child.stdout.end(aclLines(restricted).join('\n'));
      child.stdout.once('end', () => setImmediate(() => child.emit('close', SUCCESS_EXIT_CODE, null)));
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
};

/** 一時のフォルダに作った資格情報のファイルの部品。 */
export interface TestCredentialStore {
  /** 一時のフォルダ（リポジトリの根の代わり）。 */
  readonly root: string;
  readonly store: CredentialStore;
  /** 同じフォルダを、別の偽の暗号化の部品で読む部品（復号に失敗する場面）。 */
  readonly storeWithOtherProtector: CredentialStore;
  /** 一時のフォルダを消す。 */
  remove(): Promise<void>;
}

/** 資格情報のファイルの部品を、一時のフォルダに作る（T26d-2: `protector` を渡すと、`store` はそれを使う）。 */
export async function createTestCredentialStore(options: { readonly protector?: CredentialProtector } = {}): Promise<TestCredentialStore> {
  const root = await mkdtemp(join(tmpdir(), TEMPORARY_ROOT_PREFIX));
  const storeFor = (protector: CredentialProtector): CredentialStore => createCredentialStoreWith(root, {
    protector,
    spawnProcess: createTestAclSpawner(),
    now: () => new Date(),
    platform: 'win32',
    renameFile: rename,
    waitBeforeRetry: async () => undefined,
  });
  return {
    root,
    store: storeFor(options.protector ?? createTestCredentialProtector()),
    storeWithOtherProtector: storeFor(createTestCredentialProtector()),
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

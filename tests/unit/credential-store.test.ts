/**
 * T26a（Task 26 の設計書 4.1、4.2 の変更の種類と選ばなかった方の暗号文を写すこと、4.7）: 資格情報のファイルの部品
 * （`src/control/credentials/credential-store.ts`）の単体の検査。
 * - 暗号化の部品と子プロセス（PowerShell の権限の読み取り、icacls）は偽物で、どの OS でも動く。ファイルは一時のフォルダだけに書く。
 * - 本物の DPAPI と icacls は `tests/integration/credential-store-dpapi.test.ts`（Windows だけ）。
 * - 目印の値は実行ごとに作るランダムな文字列で、失敗の文に値が出ないよう、`includes` の真偽だけで確かめる。
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { PROFILE_ID_PATTERN } from '../../src/control/contracts.js';
import {
  CREDENTIAL_CHANGE_KINDS,
  CREDENTIAL_DIRECTORY_NAME,
  CREDENTIAL_FILE_FORMAT,
  CREDENTIAL_FILE_SUFFIX,
  CREDENTIAL_PARENT_DIRECTORY_NAME,
  CREDENTIAL_PROTECTION_KIND,
  CREDENTIAL_PROTECTION_STATES,
  CREDENTIAL_STORE_ERROR_CODES,
  CredentialStoreError,
  ICACLS_PATH,
  MAX_CREDENTIAL_FILE_BYTES,
  MAX_CREDENTIAL_VALUE_LENGTH,
  createCredentialStore,
  createCredentialStoreWith,
  credentialEntropyFor,
  credentialFilePathFor,
  resolveCredentialDirectory,
  type CredentialStoreDependencies,
} from '../../src/control/credentials/credential-store.js';
import { RENAME_MAX_ATTEMPTS, RENAME_RETRY_DELAY_MS, RENAME_RETRY_ERROR_CODES } from '../../src/core/rename-retry.js';
import {
  CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE,
  CredentialProtectionError,
  MAX_PROTECTED_TEXT_LENGTH,
  WINDOWS_POWERSHELL_PATH,
  type CredentialChildProcess,
  type CredentialProcessSpawner,
  type CredentialProtector,
} from '../../src/control/credentials/dpapi-protector.js';
import { isTemporaryFileName, temporaryPathFor } from '../../src/core/temporary-file-name.js';
import { COMPACT_UTC_TIMESTAMP_LENGTH } from '../../src/core/utc-timestamp.js';

// ---------------------------------------------------------------------------------------------------------------
// 偽の暗号化の部品と子プロセス
// ---------------------------------------------------------------------------------------------------------------

const USER_SID = 'S-1-5-21-1000-2000-3000-1001';
const OTHER_SID = 'S-1-5-21-1000-2000-3000-1002';
const FULL_CONTROL = 2_032_127;

/** 偽の暗号化の部品。暗号文は毎回ランダム（暗号化し直せば必ず違う）。復号は、暗号化したときの entropy と同じときだけ戻す。 */
const createFakeCredentialProtector = (options: { readonly fail?: boolean } = {}) => {
  const table = new Map<string, { readonly plain: string; readonly entropy: string }>();
  const protects: string[] = [];
  const unprotects: string[] = [];
  const protector: CredentialProtector = {
    async protect(plain, entropy) {
      protects.push(entropy);
      if (options.fail === true) {
        throw new CredentialProtectionError('PROTECTION_UNAVAILABLE');
      }
      const cipher = randomBytes(48).toString('base64');
      table.set(cipher, { plain, entropy });
      return cipher;
    },
    async unprotect(cipher, entropy) {
      unprotects.push(entropy);
      const entry = table.get(cipher);
      if (options.fail === true || entry === undefined || entry.entropy !== entropy) {
        throw new CredentialProtectionError('PROTECTION_FAILED');
      }
      return entry.plain;
    },
  };
  return { protector, protects, unprotects };
};

class FakeCredentialChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  kill(): boolean {
    return true;
  }
}

interface AclState {
  restricted: boolean;
  /** 権限の読み取りの応答（`null` なら、icacls の前後で既定の応答）。 */
  inspectLines: readonly string[] | null;
  inspectExitCode: number;
  icaclsExitCode: number;
}

const SAFE_ACL_LINES: readonly string[] = [
  `USER ${USER_SID}`,
  `OWNER ${USER_SID}`,
  'PROTECTED True',
  `RULE ${USER_SID} Allow ${FULL_CONTROL} 3 0 False`,
];
const INHERITED_ACL_LINES: readonly string[] = [
  `USER ${USER_SID}`,
  `OWNER ${USER_SID}`,
  'PROTECTED False',
  `RULE ${OTHER_SID} Allow ${FULL_CONTROL} 3 0 True`,
  `RULE ${USER_SID} Allow ${FULL_CONTROL} 3 0 True`,
];

interface SpawnRecord {
  readonly file: string;
  readonly args: readonly string[];
  stdinText: string;
  readonly stdio: readonly string[];
}

const createFakeCredentialSpawner = (state: AclState) => {
  const records: SpawnRecord[] = [];
  const spawner: CredentialProcessSpawner = (file, args, options) => {
    const child = new FakeCredentialChildProcess();
    const record: SpawnRecord = { file, args: [...args], stdinText: '', stdio: [...options.stdio] };
    records.push(record);
    const respond = (): void => {
      if (file === ICACLS_PATH) {
        if (state.icaclsExitCode === 0) {
          state.restricted = true;
        }
        setImmediate(() => child.emit('close', state.icaclsExitCode, null));
        return;
      }
      const lines = state.inspectLines ?? (state.restricted ? SAFE_ACL_LINES : INHERITED_ACL_LINES);
      child.stdout.end(lines.join('\n'));
      child.stdout.once('end', () => setImmediate(() => child.emit('close', state.inspectExitCode, null)));
      child.stdout.resume();
    };
    if (options.stdio[0] === 'pipe') {
      child.stdin.setEncoding('utf8');
      child.stdin.on('data', (chunk: string) => {
        record.stdinText += chunk;
      });
      child.stdin.on('end', respond);
    } else {
      setImmediate(respond);
    }
    return child as unknown as CredentialChildProcess;
  };
  return { spawner, records };
};

// ---------------------------------------------------------------------------------------------------------------
// 準備
// ---------------------------------------------------------------------------------------------------------------

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const PROFILE_ID = 'test-profile';
const ORIGIN = 'https://login.example.test';
const OTHER_ORIGIN = 'https://other.example.test';
const marker = (): string => `目印-${randomBytes(12).toString('hex')}-記号!"'\`$<>&|;%`;

interface Harness {
  readonly root: string;
  readonly directory: string;
  readonly store: ReturnType<typeof createCredentialStoreWith>;
  readonly fakeProtector: ReturnType<typeof createFakeCredentialProtector>;
  readonly spawns: SpawnRecord[];
  readonly acl: AclState;
  readonly renames: string[];
  readonly waits: number[];
  setNow(date: Date): void;
}

const harness = (overrides: Partial<CredentialStoreDependencies> & { readonly protectorFails?: boolean } = {}): Harness => {
  const root = mkdtempSync(join(tmpdir(), 'beaksight-t26a-'));
  temporaryRoots.push(root);
  const acl: AclState = { restricted: false, inspectLines: null, inspectExitCode: 0, icaclsExitCode: 0 };
  const fakeSpawner = createFakeCredentialSpawner(acl);
  const fakeProtector = createFakeCredentialProtector({ fail: overrides.protectorFails === true });
  let now = new Date(Date.UTC(2026, 9, 10, 1, 2, 3));
  const renames: string[] = [];
  const waits: number[] = [];
  const { protectorFails: _ignored, ...dependencyOverrides } = overrides;
  const store = createCredentialStoreWith(root, {
    protector: fakeProtector.protector,
    spawnProcess: fakeSpawner.spawner,
    now: () => now,
    platform: 'win32',
    renameFile: async (from, to) => {
      renames.push(to);
      const { rename } = await import('node:fs/promises');
      await rename(from, to);
    },
    waitBeforeRetry: async (delayMs) => {
      waits.push(delayMs);
    },
    ...dependencyOverrides,
  });
  return {
    root,
    directory: resolveCredentialDirectory(root),
    store,
    fakeProtector,
    spawns: fakeSpawner.records,
    acl,
    renames,
    waits,
    setNow(date) {
      now = date;
    },
  };
};

const caughtStoreError = async (promise: Promise<unknown>): Promise<CredentialStoreError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialStoreError);
    return error as CredentialStoreError;
  }
  throw new Error('expected a rejection');
};

const readStored = (h: Harness, profileId = PROFILE_ID): Record<string, unknown> =>
  JSON.parse(readFileSync(credentialFilePathFor(h.directory, profileId), 'utf8')) as Record<string, unknown>;
const rawStored = (h: Harness, profileId = PROFILE_ID): Buffer => readFileSync(credentialFilePathFor(h.directory, profileId));

const register = (h: Harness, values: { username?: string; password?: string; profileId?: string; loginOrigin?: string } = {}) =>
  h.store.register({
    profileId: values.profileId ?? PROFILE_ID,
    loginOrigin: values.loginOrigin ?? ORIGIN,
    username: values.username ?? marker(),
    password: values.password ?? marker(),
  });

const expectNoValueIn = (error: Error, secrets: readonly string[]): void => {
  const surfaces = [error.message, String(error), error.stack ?? '', JSON.stringify(error), JSON.stringify(Object.entries(error))];
  for (const secret of secrets) {
    expect(surfaces.some((surface) => surface.includes(secret))).toBe(false);
  }
};

const powershellSpawns = (h: Harness): readonly SpawnRecord[] => h.spawns.filter((record) => record.file === WINDOWS_POWERSHELL_PATH);
const icaclsSpawns = (h: Harness): readonly SpawnRecord[] => h.spawns.filter((record) => record.file === ICACLS_PATH);

// ---------------------------------------------------------------------------------------------------------------
// 検査
// ---------------------------------------------------------------------------------------------------------------

describe('T26a: credential store constants, location and file shape', () => {
  it('fixes the named constants and the closed lists', () => {
    expect(CREDENTIAL_PARENT_DIRECTORY_NAME).toBe('local');
    expect(CREDENTIAL_DIRECTORY_NAME).toBe('secrets');
    expect(CREDENTIAL_FILE_SUFFIX).toBe('.credential.json');
    expect(CREDENTIAL_FILE_FORMAT).toBe('beaksight-credential/1');
    expect(CREDENTIAL_PROTECTION_KIND).toBe('DPAPI_CURRENT_USER');
    expect(CREDENTIAL_CHANGE_KINDS).toEqual(['CREATED', 'USERNAME_CHANGED', 'PASSWORD_CHANGED', 'BOTH_CHANGED']);
    expect(CREDENTIAL_PROTECTION_STATES).toEqual(['AVAILABLE', 'UNAVAILABLE']);
    expect(MAX_CREDENTIAL_VALUE_LENGTH).toBe(256);
    expect(RENAME_RETRY_ERROR_CODES).toEqual(['EPERM', 'EBUSY', 'EACCES']);
    expect(RENAME_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(RENAME_RETRY_DELAY_MS).toBeGreaterThan(0);
    expect(ICACLS_PATH).toBe('C:\\Windows\\System32\\icacls.exe');
    expect(CREDENTIAL_STORE_ERROR_CODES).toEqual([
      'CREDENTIAL_PROFILE_ID_INVALID',
      'CREDENTIAL_ORIGIN_INVALID',
      'CREDENTIAL_VALUE_EMPTY',
      'CREDENTIAL_VALUE_TOO_LONG',
      'CREDENTIAL_VALUE_MALFORMED',
      'CREDENTIAL_CHANGE_EMPTY',
      'CREDENTIAL_ALREADY_EXISTS',
      'CREDENTIAL_MISSING',
      'CREDENTIAL_STALE',
      'CREDENTIAL_FILE_INVALID',
      'CREDENTIAL_READ_FAILED',
      'CREDENTIAL_PLATFORM_UNSUPPORTED',
      'CREDENTIAL_STORAGE_UNSAFE',
      'CREDENTIAL_REPLACE_FAILED',
      'CREDENTIAL_DELETE_FAILED',
    ]);
    for (const list of [CREDENTIAL_CHANGE_KINDS, CREDENTIAL_PROTECTION_STATES, RENAME_RETRY_ERROR_CODES, CREDENTIAL_STORE_ERROR_CODES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('resolves <root>/local/secrets from an absolute root only', () => {
    const root = join(tmpdir(), 'beaksight-root');
    expect(resolveCredentialDirectory(root)).toBe(join(root, 'local', 'secrets'));
    expect(() => resolveCredentialDirectory('relative/root')).toThrow(RangeError);
    expect(() => resolveCredentialDirectory('')).toThrow(RangeError);
    expect(credentialFilePathFor(join(root, 'local', 'secrets'), 'a-b')).toBe(join(root, 'local', 'secrets', 'a-b.credential.json'));
  });

  it('the production entry takes the repository root only', () => {
    expect(createCredentialStore.length).toBe(1);
    expect(createCredentialStore(join(tmpdir(), 'beaksight-root')).directory).toBe(join(tmpdir(), 'beaksight-root', 'local', 'secrets'));
  });

  it('builds a separate entropy for each field from the format, the profile and the login origin', () => {
    expect(credentialEntropyFor('p-1', ORIGIN, 'username')).toBe(`beaksight-credential/1|p-1|${ORIGIN}|username`);
    expect(credentialEntropyFor('p-1', ORIGIN, 'password')).toBe(`beaksight-credential/1|p-1|${ORIGIN}|password`);
  });

  it('schemas/control/credential-file.schema.json matches the named constants', () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), 'schemas', 'control', 'credential-file.schema.json'), 'utf8')) as {
      $id: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.$id).toBe('urn:beaksight:schema:control:credential-file:1');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'format', 'profileId', 'loginOrigin', 'credentialRevision', 'createdAt', 'updatedAt', 'lastChangeKind', 'protection', 'username', 'password',
    ]);
    expect(Object.keys(schema.properties)).toEqual(schema.required);
    expect(schema.properties.format?.const).toBe(CREDENTIAL_FILE_FORMAT);
    expect(schema.properties.protection?.const).toBe(CREDENTIAL_PROTECTION_KIND);
    expect(schema.properties.profileId?.pattern).toBe(PROFILE_ID_PATTERN.source);
    expect(schema.properties.lastChangeKind?.enum).toEqual([...CREDENTIAL_CHANGE_KINDS]);
    expect(schema.properties.createdAt?.pattern).toBe(`^[0-9]{${COMPACT_UTC_TIMESTAMP_LENGTH}}$`);
    expect(schema.properties.updatedAt?.pattern).toBe(`^[0-9]{${COMPACT_UTC_TIMESTAMP_LENGTH}}$`);
    expect(schema.properties.username?.maxLength).toBe(MAX_PROTECTED_TEXT_LENGTH);
    expect(schema.properties.password?.maxLength).toBe(MAX_PROTECTED_TEXT_LENGTH);
  });
});

describe('T26a: register', () => {
  it('writes the beaksight-credential/1 file with the cipher texts only (revision 1, CREATED)', async () => {
    const h = harness();
    const username = marker();
    const password = marker();
    const metadata = await register(h, { username, password });
    const stored = readStored(h);
    expect(validateControlDocument('credential-file', stored)).toEqual({ ok: true });
    expect(Object.keys(stored)).toEqual([
      'format', 'profileId', 'loginOrigin', 'credentialRevision', 'createdAt', 'updatedAt', 'lastChangeKind', 'protection', 'username', 'password',
    ]);
    expect(stored).toMatchObject({
      format: CREDENTIAL_FILE_FORMAT,
      profileId: PROFILE_ID,
      loginOrigin: ORIGIN,
      credentialRevision: 1,
      createdAt: '20261010010203',
      updatedAt: '20261010010203',
      lastChangeKind: 'CREATED',
      protection: CREDENTIAL_PROTECTION_KIND,
    });
    expect(metadata).toEqual({
      profileId: PROFILE_ID,
      loginOrigin: ORIGIN,
      credentialRevision: 1,
      createdAt: '20261010010203',
      updatedAt: '20261010010203',
      lastChangeKind: 'CREATED',
      protection: CREDENTIAL_PROTECTION_KIND,
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(h.fakeProtector.protects).toEqual([
      credentialEntropyFor(PROFILE_ID, ORIGIN, 'username'),
      credentialEntropyFor(PROFILE_ID, ORIGIN, 'password'),
    ]);
    const raw = rawStored(h).toString('utf8');
    expect(raw.includes(username) || raw.includes(password)).toBe(false);
    expect(await h.store.decrypt(PROFILE_ID, ORIGIN)).toEqual({ credentialRevision: 1, username, password });
  });

  it('restricts a new folder with icacls (absolute path, inheritance removed, the current user only) before writing into it', async () => {
    const h = harness();
    await register(h);
    expect(icaclsSpawns(h).map((record) => record.args)).toEqual([
      [h.directory, '/inheritance:r', '/grant:r', `*${USER_SID}:(OI)(CI)F`],
    ]);
    const icaclsIndex = h.spawns.findIndex((record) => record.file === ICACLS_PATH);
    // 現在の利用者の SID を読む → icacls → 書く前の確かめ。
    expect(h.spawns.slice(0, icaclsIndex).every((record) => record.file === WINDOWS_POWERSHELL_PATH)).toBe(true);
    expect(h.spawns.slice(icaclsIndex + 1).some((record) => record.file === WINDOWS_POWERSHELL_PATH)).toBe(true);
    for (const record of powershellSpawns(h)) {
      expect(record.stdio).toEqual(['pipe', 'pipe', 'ignore']);
      expect(record.stdinText).toBe(`${Buffer.from(h.directory, 'utf8').toString('base64')}\n`);
      expect(JSON.stringify(record.args).includes(h.directory)).toBe(false);
    }
    expect(icaclsSpawns(h)[0]?.stdio).toEqual(['ignore', 'ignore', 'ignore']);
  });

  it('checks the folder before every write, and runs icacls only when it created the folder', async () => {
    const h = harness();
    await register(h);
    const before = powershellSpawns(h).length;
    await register(h, { profileId: 'second-profile' });
    expect(icaclsSpawns(h)).toHaveLength(1);
    expect(powershellSpawns(h).length).toBeGreaterThan(before);
  });

  it('refuses when the file already exists (CREDENTIAL_ALREADY_EXISTS), leaving it unchanged', async () => {
    const h = harness();
    await register(h);
    const before = rawStored(h);
    const error = await caughtStoreError(register(h));
    expect(error.code).toBe('CREDENTIAL_ALREADY_EXISTS');
    expect(rawStored(h).equals(before)).toBe(true);
  });

  it.each([
    ['inheritance not removed', ['USER S', 'OWNER S', 'PROTECTED False', `RULE S Allow ${FULL_CONTROL} 3 0 False`]],
    ['another account allowed', ['USER S', 'OWNER S', 'PROTECTED True', `RULE S Allow ${FULL_CONTROL} 3 0 False`, `RULE ${OTHER_SID} Allow 1179817 3 0 False`]],
    ['another owner', ['USER S', `OWNER ${OTHER_SID}`, 'PROTECTED True', `RULE S Allow ${FULL_CONTROL} 3 0 False`]],
    ['a deny rule', ['USER S', 'OWNER S', 'PROTECTED True', `RULE S Allow ${FULL_CONTROL} 3 0 False`, 'RULE S Deny 1 3 0 False']],
    ['no rule', ['USER S', 'OWNER S', 'PROTECTED True']],
    ['no full control', ['USER S', 'OWNER S', 'PROTECTED True', 'RULE S Allow 1179817 3 0 False']],
    ['no inheritance to the files', ['USER S', 'OWNER S', 'PROTECTED True', `RULE S Allow ${FULL_CONTROL} 0 0 False`]],
    ['a malformed answer', ['USER S', 'OWNER S', 'PROTECTED maybe', `RULE S Allow ${FULL_CONTROL} 3 0 False`]],
    ['a malformed SID', ['USER not-a-sid', 'OWNER not-a-sid', 'PROTECTED True', `RULE not-a-sid Allow ${FULL_CONTROL} 3 0 False`]],
  ] as const)('does not write when the folder permission is unsafe: %s (CREDENTIAL_STORAGE_UNSAFE)', async (_name, lines) => {
    const h = harness();
    mkdirSync(h.directory, { recursive: true });
    // `S` は今の利用者の SID の代わり（行の中の、前後が空白か行の端の 1 文字だけ）。
    h.acl.inspectLines = lines.map((line) => line.split(' ').map((token) => (token === 'S' ? USER_SID : token)).join(' '));
    const username = marker();
    const error = await caughtStoreError(register(h, { username }));
    expect(error.code).toBe('CREDENTIAL_STORAGE_UNSAFE');
    expect(readdirSync(h.directory)).toEqual([]);
    expect(icaclsSpawns(h)).toHaveLength(0);
    expectNoValueIn(error, [username]);
  });

  it('does not write when the permission check fails or icacls fails (CREDENTIAL_STORAGE_UNSAFE)', async () => {
    const failingInspect = harness();
    failingInspect.acl.inspectExitCode = CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE;
    expect((await caughtStoreError(register(failingInspect))).code).toBe('CREDENTIAL_STORAGE_UNSAFE');
    expect(readdirSync(failingInspect.directory)).toEqual([]);

    const failingIcacls = harness();
    failingIcacls.acl.icaclsExitCode = 5;
    expect((await caughtStoreError(register(failingIcacls))).code).toBe('CREDENTIAL_STORAGE_UNSAFE');
    expect(readdirSync(failingIcacls.directory)).toEqual([]);
  });

  it('refuses a folder that is a symbolic link or not a folder (CREDENTIAL_STORAGE_UNSAFE)', async () => {
    const h = harness();
    mkdirSync(join(h.root, CREDENTIAL_PARENT_DIRECTORY_NAME), { recursive: true });
    writeFileSync(h.directory, 'not a folder');
    expect((await caughtStoreError(register(h))).code).toBe('CREDENTIAL_STORAGE_UNSAFE');
  });

  it('refuses every save outside Windows, without starting a child process or creating the folder', async () => {
    const h = harness({ platform: 'linux' });
    const username = marker();
    for (const operation of [
      () => register(h, { username }),
      () => h.store.replaceAll({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username, password: marker() }),
      () => h.store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username }),
    ]) {
      const error = await caughtStoreError(operation());
      expect(error.code).toBe('CREDENTIAL_PLATFORM_UNSUPPORTED');
      expectNoValueIn(error, [username]);
    }
    expect(h.spawns).toHaveLength(0);
    expect(h.fakeProtector.protects).toHaveLength(0);
    expect(existsSync(join(h.root, CREDENTIAL_PARENT_DIRECTORY_NAME))).toBe(false);
  });
});

describe('T26a: value rules', () => {
  const longest = 'a'.repeat(MAX_CREDENTIAL_VALUE_LENGTH);
  it('accepts values up to the length limit (UTF-16), including Japanese text and symbols', async () => {
    const h = harness();
    await register(h, { username: longest, password: `パスワード${marker()}` });
    expect((await h.store.decrypt(PROFILE_ID, ORIGIN)).username).toBe(longest);
  });

  it.each([
    ['username', 'an empty value', '', 'CREDENTIAL_VALUE_EMPTY'],
    ['password', 'an empty value', '', 'CREDENTIAL_VALUE_EMPTY'],
    ['username', 'a value over the limit', `${'a'.repeat(MAX_CREDENTIAL_VALUE_LENGTH)}b`, 'CREDENTIAL_VALUE_TOO_LONG'],
    ['password', 'a value over the limit', `${'a'.repeat(MAX_CREDENTIAL_VALUE_LENGTH)}b`, 'CREDENTIAL_VALUE_TOO_LONG'],
    ['username', 'a lone high surrogate', 'ab\uD800', 'CREDENTIAL_VALUE_MALFORMED'],
    ['password', 'a lone low surrogate', '\uDC00ab', 'CREDENTIAL_VALUE_MALFORMED'],
    ['password', 'a value that is not a string', 42, 'CREDENTIAL_VALUE_MALFORMED'],
  ] as const)('rejects %s with %s (%s), naming the field only', async (field, _name, value, code) => {
    const h = harness();
    const other = marker();
    const values = field === 'username'
      ? { username: value as string, password: other }
      : { username: other, password: value as string };
    const error = await caughtStoreError(register(h, values));
    expect(error.code).toBe(code);
    expect(error.field).toBe(field);
    expectNoValueIn(error, [other, ...(typeof value === 'string' && value.length > 0 ? [value] : [])]);
    expect(h.fakeProtector.protects).toHaveLength(0);
    expect(h.spawns).toHaveLength(0);
  });

  it.each([
    ['a profile id outside the pattern', { profileId: '../escape' }, 'CREDENTIAL_PROFILE_ID_INVALID'],
    ['an upper-case profile id', { profileId: 'Upper' }, 'CREDENTIAL_PROFILE_ID_INVALID'],
    ['an origin with a path', { loginOrigin: `${ORIGIN}/` }, 'CREDENTIAL_ORIGIN_INVALID'],
    ['an origin with credentials', { loginOrigin: 'https://user:pass@login.example.test' }, 'CREDENTIAL_ORIGIN_INVALID'],
    ['an origin that is not HTTP(S)', { loginOrigin: 'ftp://login.example.test' }, 'CREDENTIAL_ORIGIN_INVALID'],
  ] as const)('rejects %s', async (_name, values, code) => {
    const h = harness();
    expect((await caughtStoreError(register(h, values))).code).toBe(code);
    expect(h.spawns).toHaveLength(0);
  });

  it('rejects an invalid profile id for the reads and the removal too', async () => {
    const h = harness();
    expect((await caughtStoreError(h.store.readMetadata('../x'))).code).toBe('CREDENTIAL_PROFILE_ID_INVALID');
    expect((await caughtStoreError(h.store.decrypt('../x', ORIGIN))).code).toBe('CREDENTIAL_PROFILE_ID_INVALID');
    expect((await caughtStoreError(h.store.remove('../x'))).code).toBe('CREDENTIAL_PROFILE_ID_INVALID');
  });
});

describe('T26a: replace all and partial changes', () => {
  const later = new Date(Date.UTC(2026, 9, 11, 4, 5, 6));

  it('replaceAll re-encrypts both values with the current origin (BOTH_CHANGED, revision + 1, createdAt kept)', async () => {
    const h = harness();
    await register(h);
    h.setNow(later);
    const username = marker();
    const password = marker();
    const metadata = await h.store.replaceAll({ profileId: PROFILE_ID, loginOrigin: OTHER_ORIGIN, username, password });
    expect(metadata).toMatchObject({
      loginOrigin: OTHER_ORIGIN,
      credentialRevision: 2,
      createdAt: '20261010010203',
      updatedAt: '20261011040506',
      lastChangeKind: 'BOTH_CHANGED',
    });
    expect(h.fakeProtector.protects.slice(2)).toEqual([
      credentialEntropyFor(PROFILE_ID, OTHER_ORIGIN, 'username'),
      credentialEntropyFor(PROFILE_ID, OTHER_ORIGIN, 'password'),
    ]);
    expect(h.fakeProtector.unprotects).toEqual([]);
    expect(await h.store.decrypt(PROFILE_ID, OTHER_ORIGIN)).toEqual({ credentialRevision: 2, username, password });
  });

  it('replaceAll refuses a missing file (CREDENTIAL_MISSING)', async () => {
    const h = harness();
    const error = await caughtStoreError(h.store.replaceAll({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() }));
    expect(error.code).toBe('CREDENTIAL_MISSING');
  });

  it.each([
    ['the username only', 'username', 'USERNAME_CHANGED'],
    ['the password only', 'password', 'PASSWORD_CHANGED'],
  ] as const)('changing %s copies the other cipher text byte for byte without decrypting it', async (_name, field, kind) => {
    const h = harness();
    await register(h);
    const before = readStored(h);
    h.setNow(later);
    const value = marker();
    const metadata = await h.store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, [field]: value });
    const after = readStored(h);
    const other = field === 'username' ? 'password' : 'username';
    expect(after[other]).toBe(before[other]);
    expect(after[field]).not.toBe(before[field]);
    expect(metadata).toMatchObject({ credentialRevision: 2, lastChangeKind: kind, createdAt: '20261010010203', updatedAt: '20261011040506' });
    expect(after.lastChangeKind).toBe(kind);
    expect(h.fakeProtector.unprotects).toEqual([]);
    expect(h.fakeProtector.protects.slice(2)).toEqual([credentialEntropyFor(PROFILE_ID, ORIGIN, field)]);
    const decrypted = await h.store.decrypt(PROFILE_ID, ORIGIN);
    expect(decrypted[field] === value).toBe(true);
  });

  it('changing both values is BOTH_CHANGED', async () => {
    const h = harness();
    await register(h);
    const username = marker();
    const password = marker();
    const metadata = await h.store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username, password });
    expect(metadata.lastChangeKind).toBe('BOTH_CHANGED');
    expect(h.fakeProtector.unprotects).toEqual([]);
    expect(await h.store.decrypt(PROFILE_ID, ORIGIN)).toEqual({ credentialRevision: 2, username, password });
  });

  it('refuses a change that selects nothing (CREDENTIAL_CHANGE_EMPTY) and an empty selected value', async () => {
    const h = harness();
    await register(h);
    expect((await caughtStoreError(h.store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN }))).code).toBe('CREDENTIAL_CHANGE_EMPTY');
    expect((await caughtStoreError(h.store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: '' }))).code).toBe('CREDENTIAL_VALUE_EMPTY');
    expect(readStored(h).credentialRevision).toBe(1);
  });

  it('refuses a partial change when the stored origin differs from the current one (CREDENTIAL_STALE), without encrypting', async () => {
    const h = harness();
    await register(h);
    const before = rawStored(h);
    const protects = h.fakeProtector.protects.length;
    const error = await caughtStoreError(h.store.change({ profileId: PROFILE_ID, loginOrigin: OTHER_ORIGIN, password: marker() }));
    expect(error.code).toBe('CREDENTIAL_STALE');
    expect(rawStored(h).equals(before)).toBe(true);
    expect(h.fakeProtector.protects).toHaveLength(protects);
    expect(h.fakeProtector.unprotects).toEqual([]);
  });

  it('refuses a partial change of a missing file (CREDENTIAL_MISSING)', async () => {
    const h = harness();
    expect((await caughtStoreError(h.store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() }))).code)
      .toBe('CREDENTIAL_MISSING');
  });

  it('serializes concurrent changes, and the revision rises once per successful replacement', async () => {
    const h = harness();
    await register(h);
    await Promise.all([
      h.store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() }),
      h.store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker() }),
    ]);
    expect(readStored(h).credentialRevision).toBe(3);
  });

  it('keeps the old file and its revision when the encryption fails', async () => {
    const h = harness();
    await register(h);
    const before = rawStored(h);
    const failing = createCredentialStoreWith(h.root, {
      protector: createFakeCredentialProtector({ fail: true }).protector,
      spawnProcess: createFakeCredentialSpawner({ restricted: true, inspectLines: null, inspectExitCode: 0, icaclsExitCode: 0 }).spawner,
      now: () => later,
      platform: 'win32',
      renameFile: async () => undefined,
      waitBeforeRetry: async () => undefined,
    });
    const error = await failing.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() }).catch((caughtError: unknown) => caughtError);
    expect(error).toBeInstanceOf(CredentialProtectionError);
    expect(rawStored(h).equals(before)).toBe(true);
    expect(readdirSync(h.directory)).toEqual([`${PROFILE_ID}${CREDENTIAL_FILE_SUFFIX}`]);
  });
});

describe('T26a: replacement through a temporary file and rename', () => {
  const failingRename = (code: string, failures: number) => {
    let attempts = 0;
    const renameFile = async (from: string, to: string): Promise<void> => {
      attempts += 1;
      if (attempts <= failures) {
        throw Object.assign(new Error(`rename failed ${code}`), { code });
      }
      const { rename } = await import('node:fs/promises');
      await rename(from, to);
    };
    return { renameFile, attempts: () => attempts };
  };

  it('retries EPERM / EBUSY / EACCES a fixed number of times, then keeps the old file (CREDENTIAL_REPLACE_FAILED)', async () => {
    for (const code of RENAME_RETRY_ERROR_CODES) {
      const h = harness();
      await register(h);
      const before = rawStored(h);
      const rename = failingRename(code, Number.POSITIVE_INFINITY);
      const waits: number[] = [];
      const store = createCredentialStoreWith(h.root, {
        protector: h.fakeProtector.protector,
        spawnProcess: createFakeCredentialSpawner({ restricted: true, inspectLines: null, inspectExitCode: 0, icaclsExitCode: 0 }).spawner,
        now: () => new Date(),
        platform: 'win32',
        renameFile: rename.renameFile,
        waitBeforeRetry: async (delayMs) => {
          waits.push(delayMs);
        },
      });
      const password = marker();
      const error = await caughtStoreError(store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password }));
      expect(error.code).toBe('CREDENTIAL_REPLACE_FAILED');
      expectNoValueIn(error, [password]);
      expect(rename.attempts()).toBe(RENAME_MAX_ATTEMPTS);
      expect(waits).toEqual(Array.from({ length: RENAME_MAX_ATTEMPTS - 1 }, () => RENAME_RETRY_DELAY_MS));
      expect(rawStored(h).equals(before)).toBe(true);
      expect(readdirSync(h.directory)).toEqual([`${PROFILE_ID}${CREDENTIAL_FILE_SUFFIX}`]);
      expect((await h.store.readMetadata(PROFILE_ID))?.credentialRevision).toBe(1);
    }
  });

  it('does not retry other rename failures', async () => {
    const h = harness();
    await register(h);
    const rename = failingRename('ENOENT', Number.POSITIVE_INFINITY);
    const store = createCredentialStoreWith(h.root, {
      protector: h.fakeProtector.protector,
      spawnProcess: createFakeCredentialSpawner({ restricted: true, inspectLines: null, inspectExitCode: 0, icaclsExitCode: 0 }).spawner,
      now: () => new Date(),
      platform: 'win32',
      renameFile: rename.renameFile,
      waitBeforeRetry: async () => undefined,
    });
    expect((await caughtStoreError(store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() }))).code)
      .toBe('CREDENTIAL_REPLACE_FAILED');
    expect(rename.attempts()).toBe(1);
    expect(readdirSync(h.directory)).toEqual([`${PROFILE_ID}${CREDENTIAL_FILE_SUFFIX}`]);
  });

  it('succeeds when a transient failure clears within the attempts', async () => {
    const h = harness();
    await register(h);
    const rename = failingRename('EBUSY', 2);
    const store = createCredentialStoreWith(h.root, {
      protector: h.fakeProtector.protector,
      spawnProcess: createFakeCredentialSpawner({ restricted: true, inspectLines: null, inspectExitCode: 0, icaclsExitCode: 0 }).spawner,
      now: () => new Date(),
      platform: 'win32',
      renameFile: rename.renameFile,
      waitBeforeRetry: async () => undefined,
    });
    await store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() });
    expect(rename.attempts()).toBe(3);
    expect(readStored(h).credentialRevision).toBe(2);
  });

  it('writes through a temporary file in the same folder and renames it onto the file', async () => {
    const h = harness();
    await register(h);
    expect(h.renames).toEqual([credentialFilePathFor(h.directory, PROFILE_ID)]);
  });
});

describe('T26a: reading, decrypting and removing', () => {
  it('readMetadata returns null for a missing file and only the non-secret fields otherwise', async () => {
    const h = harness();
    expect(await h.store.readMetadata(PROFILE_ID)).toBeNull();
    await register(h);
    const metadata = await h.store.readMetadata(PROFILE_ID);
    expect(Object.keys(metadata ?? {}).sort()).toEqual(
      ['createdAt', 'credentialRevision', 'lastChangeKind', 'loginOrigin', 'profileId', 'protection', 'updatedAt'],
    );
    expect(h.fakeProtector.unprotects).toEqual([]);
  });

  it.each([
    ['not JSON', (_h: Harness): string => '{'],
    ['another shape', (h: Harness): string => JSON.stringify({ ...readStored(h), extra: true })],
    ['another profile id', (h: Harness): string => JSON.stringify({ ...readStored(h), profileId: 'other-profile' })],
    ['a non-canonical origin', (h: Harness): string => JSON.stringify({ ...readStored(h), loginOrigin: `${ORIGIN}/` })],
    ['an oversized file', (h: Harness): string => `${JSON.stringify(readStored(h))}${' '.repeat(MAX_CREDENTIAL_FILE_BYTES)}`],
  ] as const)('readMetadata and decrypt refuse %s (CREDENTIAL_FILE_INVALID)', async (_name, content) => {
    const h = harness();
    await register(h);
    writeFileSync(credentialFilePathFor(h.directory, PROFILE_ID), content(h));
    expect((await caughtStoreError(h.store.readMetadata(PROFILE_ID))).code).toBe('CREDENTIAL_FILE_INVALID');
    expect((await caughtStoreError(h.store.decrypt(PROFILE_ID, ORIGIN))).code).toBe('CREDENTIAL_FILE_INVALID');
  });

  it('decrypt refuses a missing file (CREDENTIAL_MISSING) and another origin without trying to decrypt (CREDENTIAL_STALE)', async () => {
    const h = harness();
    expect((await caughtStoreError(h.store.decrypt(PROFILE_ID, ORIGIN))).code).toBe('CREDENTIAL_MISSING');
    await register(h);
    expect((await caughtStoreError(h.store.decrypt(PROFILE_ID, OTHER_ORIGIN))).code).toBe('CREDENTIAL_STALE');
    expect(h.fakeProtector.unprotects).toEqual([]);
  });

  it('decrypt cannot recover swapped cipher texts (the entropy names the field)', async () => {
    const h = harness();
    await register(h);
    const stored = readStored(h);
    writeFileSync(credentialFilePathFor(h.directory, PROFILE_ID), JSON.stringify({ ...stored, username: stored.password, password: stored.username }));
    const error = await h.store.decrypt(PROFILE_ID, ORIGIN).catch((caughtError: unknown) => caughtError);
    expect(error).toBeInstanceOf(CredentialProtectionError);
  });

  it('remove deletes the file and reports whether it existed', async () => {
    const h = harness();
    await register(h);
    expect(await h.store.remove(PROFILE_ID)).toBe(true);
    expect(existsSync(credentialFilePathFor(h.directory, PROFILE_ID))).toBe(false);
    expect(await h.store.remove(PROFILE_ID)).toBe(false);
    expect(await h.store.readMetadata(PROFILE_ID)).toBeNull();
  });
});

describe('T26a: clean-up and the protection self-check', () => {
  it('removes only the temporary files left in the folder', async () => {
    const h = harness();
    expect(await h.store.removeTemporaryFiles()).toBe(0);
    await register(h);
    const leftover = temporaryPathFor(credentialFilePathFor(h.directory, PROFILE_ID));
    writeFileSync(leftover, 'partial');
    writeFileSync(join(h.directory, 'keep.txt'), 'keep');
    expect(isTemporaryFileName(leftover.slice(h.directory.length + 1))).toBe(true);
    expect(await h.store.removeTemporaryFiles()).toBe(1);
    expect(readdirSync(h.directory).sort()).toEqual(['keep.txt', `${PROFILE_ID}${CREDENTIAL_FILE_SUFFIX}`].sort());
  });

  it('checkProtection round-trips a fixed sample and returns only AVAILABLE or UNAVAILABLE', async () => {
    const h = harness();
    expect(await h.store.checkProtection()).toBe('AVAILABLE');
    expect(h.fakeProtector.protects).toHaveLength(1);
    expect(h.fakeProtector.unprotects).toHaveLength(1);
    expect(await harness({ protectorFails: true }).store.checkProtection()).toBe('UNAVAILABLE');
    const outside = harness({ platform: 'linux' });
    expect(await outside.store.checkProtection()).toBe('UNAVAILABLE');
    expect(outside.fakeProtector.protects).toHaveLength(0);
  });

  it('the errors carry the closed code and the field name only', async () => {
    const h = harness();
    const username = marker();
    const error = await caughtStoreError(register(h, { username, password: '' }));
    expect(Object.keys(error).sort()).toEqual(['code', 'field', 'name']);
    expectNoValueIn(error, [username]);
  });
});

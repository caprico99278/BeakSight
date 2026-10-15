/**
 * T26a（Task 26 の設計書 4.1、4.7）: 本物の DPAPI と icacls で、資格情報の暗号化とファイルの部品を確かめる結合の検査（Windows だけ）。
 * - 一時のフォルダ（`os.tmpdir()` の下）だけを使い、終わったら消す。リポジトリの `local/` には書かない。資格情報マネージャーは使わない。
 * - 目印の値は実行ごとに作るランダムな文字列（日本語と記号を含む）。目印を PowerShell の cmdlet の引数や誤りの文に載せない（イベント
 *   ログに残るため）。値の有無は `includes` の真偽だけで確かめる（失敗の文に値が出ないため）。
 * - 権限の確かめは、部品とは別の固定の文（.NET の `GetAccessControl`。パスは環境変数で渡す。秘密ではない）で行う。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_FILE_SUFFIX,
  CredentialStoreError,
  createCredentialStore,
  credentialEntropyFor,
  credentialFilePathFor,
} from '../../src/control/credentials/credential-store.js';
import {
  CredentialProtectionError,
  WINDOWS_POWERSHELL_PATH,
  createDpapiCredentialProtector,
  createDpapiCredentialProtectorWith,
  spawnCredentialProcess,
  type CredentialProcessSpawner,
} from '../../src/control/credentials/dpapi-protector.js';

const IS_WINDOWS = process.platform === 'win32';
const TEST_TIMEOUT_MS = 60_000;
const FULL_CONTROL = 2_032_127;
const CONTAINER_AND_OBJECT_INHERIT = 3;
const NO_INHERITANCE_FLAGS = 0;
const PROFILE_ID = 'dpapi-profile';
const ORIGIN = 'https://login.example.test';
const OTHER_ORIGIN = 'https://other.example.test';
const ACL_PATH_VARIABLE = 'BEAKSIGHT_T26A_ACL_PATH';
const HOLD_PATH_VARIABLE = 'BEAKSIGHT_T26A_HOLD_PATH';
const HOLD_READY_TEXT = 'READY';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'beaksight-t26a-dpapi-'));
  roots.push(root);
  return root;
};

/** 実行ごとの目印（日本語と記号を含む。改行は含まない）。 */
const marker = (): string => `目印${randomBytes(9).toString('base64url')}「記号」!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;

/** `haystack` の中に、`value` の UTF-8 と UTF-16LE のどちらかのバイト列があるか。 */
const containsValueBytes = (haystack: Buffer, value: string): boolean =>
  haystack.includes(Buffer.from(value, 'utf8')) || haystack.includes(Buffer.from(value, 'utf16le'));

const encodedCommand = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

/** パス（環境変数で渡す）の所有者・継承・許可を SID で読む（部品とは別の、テストの固定の文）。 */
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$target = $env:${ACL_PATH_VARIABLE}`,
  '$sidType = [System.Security.Principal.SecurityIdentifier]',
  'if ([System.IO.Directory]::Exists($target)) { $security = [System.IO.Directory]::GetAccessControl($target) } '
    + 'else { $security = [System.IO.File]::GetAccessControl($target) }',
  // PowerShell では `,` が `+` より先に結びつくので、要素ごとに括弧で囲む。
  "$lines = @(('USER ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value), ('OWNER ' + $security.GetOwner($sidType).Value), "
    + "('PROTECTED ' + $security.AreAccessRulesProtected))",
  'foreach ($rule in $security.GetAccessRules($true, $true, $sidType)) {',
  "  $lines += ('RULE ' + $rule.IdentityReference.Value + ' ' + $rule.AccessControlType + ' ' + [int]$rule.FileSystemRights + ' ' + "
    + "[int]$rule.InheritanceFlags + ' ' + [int]$rule.PropagationFlags + ' ' + $rule.IsInherited)",
  '}',
  '[System.Console]::Out.Write([string]::Join([string][char]10, $lines))',
].join('\n');

interface AclRule {
  readonly sid: string;
  readonly type: string;
  readonly rights: number;
  readonly inheritance: number;
  readonly inherited: boolean;
}
interface Acl {
  readonly user: string;
  readonly owner: string;
  readonly protectedRules: boolean;
  readonly rules: readonly AclRule[];
}

const readAcl = (path: string): Acl => {
  const output = execFileSync(WINDOWS_POWERSHELL_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(ACL_SCRIPT)], {
    env: { ...process.env, [ACL_PATH_VARIABLE]: path },
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = output.split('\n');
  const valueOf = (prefix: string): string => (lines.find((line) => line.startsWith(`${prefix} `)) ?? '').slice(prefix.length + 1);
  return {
    user: valueOf('USER'),
    owner: valueOf('OWNER'),
    protectedRules: valueOf('PROTECTED') === 'True',
    rules: lines.filter((line) => line.startsWith('RULE ')).map((line) => {
      const [, sid = '', type = '', rights = '', inheritance = '', , inherited = ''] = line.split(' ');
      return { sid, type, rights: Number(rights), inheritance: Number(inheritance), inherited: inherited === 'True' };
    }),
  };
};

/** 別のプロセス（共有の削除を許さないハンドル）で、ファイルを開いたままにする。`release` で閉じて終わる。 */
const holdFileOpen = async (path: string): Promise<{ release(): Promise<void> }> => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$stream = [System.IO.File]::Open($env:${HOLD_PATH_VARIABLE}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)`,
    `[System.Console]::Out.WriteLine('${HOLD_READY_TEXT}')`,
    '[System.Console]::Out.Flush()',
    '[void][System.Console]::In.ReadLine()',
    '$stream.Dispose()',
  ].join('\n');
  const child = spawn(WINDOWS_POWERSHELL_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(script)], {
    env: { ...process.env, [HOLD_PATH_VARIABLE]: path },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes(HOLD_READY_TEXT)) {
        resolve();
      }
    });
    child.once('close', () => reject(new Error('the holder process ended before it opened the file')));
  });
  return {
    async release() {
      child.stdin.end('\n');
      await exited;
    },
  };
};

const caught = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe.skipIf(!IS_WINDOWS)('T26a: real DPAPI and icacls (Windows only; skipped elsewhere because DPAPI and icacls exist only on Windows)', () => {
  it('round-trips Japanese and symbols through the production entries, with no plain value in the file', async () => {
    const root = temporaryRoot();
    const store = createCredentialStore(root);
    const username = marker();
    const password = marker();
    const metadata = await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username, password });
    expect(metadata.credentialRevision).toBe(1);

    const decrypted = await store.decrypt(PROFILE_ID, ORIGIN);
    expect(decrypted.username === username && decrypted.password === password).toBe(true);
    expect(decrypted.credentialRevision).toBe(1);

    const raw = readFileSync(credentialFilePathFor(store.directory, PROFILE_ID));
    expect(containsValueBytes(raw, username) || containsValueBytes(raw, password)).toBe(false);
    const stored = JSON.parse(raw.toString('utf8')) as { username: string; password: string };
    for (const cipher of [stored.username, stored.password]) {
      const bytes = Buffer.from(cipher, 'base64');
      expect(containsValueBytes(bytes, username) || containsValueBytes(bytes, password)).toBe(false);
      expect(raw.includes(Buffer.from(Buffer.from(username, 'utf8').toString('base64')))).toBe(false);
    }
    expect(await store.checkProtection()).toBe('AVAILABLE');
  }, TEST_TIMEOUT_MS);

  it('restricts the folder and the files to the current user only (inheritance removed, owner checked)', async () => {
    const root = temporaryRoot();
    const store = createCredentialStore(root);
    await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() });

    const folder = readAcl(store.directory);
    expect(folder.user).toMatch(/^S-1-5-/u);
    expect(folder.owner).toBe(folder.user);
    expect(folder.protectedRules).toBe(true);
    expect(folder.rules).toEqual([{ sid: folder.user, type: 'Allow', rights: FULL_CONTROL, inheritance: CONTAINER_AND_OBJECT_INHERIT, inherited: false }]);

    const file = readAcl(credentialFilePathFor(store.directory, PROFILE_ID));
    expect(file.rules.length).toBeGreaterThan(0);
    expect(file.rules.every((rule) => rule.sid === folder.user && rule.type === 'Allow')).toBe(true);
    expect(file.rules).toContainEqual({ sid: folder.user, type: 'Allow', rights: FULL_CONTROL, inheritance: NO_INHERITANCE_FLAGS, inherited: true });
  }, TEST_TIMEOUT_MS);

  it('cannot decrypt with another entropy: another profile, swapped fields, another origin', async () => {
    const protector = createDpapiCredentialProtector();
    const value = marker();
    const cipher = await protector.protect(value, credentialEntropyFor(PROFILE_ID, ORIGIN, 'password'));
    expect((await protector.unprotect(cipher, credentialEntropyFor(PROFILE_ID, ORIGIN, 'password'))) === value).toBe(true);
    for (const entropy of [
      credentialEntropyFor('another-profile', ORIGIN, 'password'),
      credentialEntropyFor(PROFILE_ID, ORIGIN, 'username'),
      credentialEntropyFor(PROFILE_ID, OTHER_ORIGIN, 'password'),
    ]) {
      const error = await caught(protector.unprotect(cipher, entropy));
      expect(error).toBeInstanceOf(CredentialProtectionError);
      expect((error as CredentialProtectionError).code).toBe('PROTECTION_FAILED');
      expect(String(error).includes(value)).toBe(false);
    }

    // ファイルの付け替え: 別のプロファイルへ写す、ユーザー名とパスワードを入れ替える、Origin を書き換える。どれも戻せない。
    const root = temporaryRoot();
    const store = createCredentialStore(root);
    await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() });
    const original = JSON.parse(readFileSync(credentialFilePathFor(store.directory, PROFILE_ID), 'utf8')) as Record<string, unknown>;
    writeFileSync(credentialFilePathFor(store.directory, 'moved-profile'), JSON.stringify({ ...original, profileId: 'moved-profile' }));
    expect(await caught(store.decrypt('moved-profile', ORIGIN))).toBeInstanceOf(CredentialProtectionError);
    writeFileSync(credentialFilePathFor(store.directory, PROFILE_ID), JSON.stringify({ ...original, username: original.password, password: original.username }));
    expect(await caught(store.decrypt(PROFILE_ID, ORIGIN))).toBeInstanceOf(CredentialProtectionError);
    writeFileSync(credentialFilePathFor(store.directory, PROFILE_ID), JSON.stringify({ ...original, loginOrigin: OTHER_ORIGIN }));
    expect(await caught(store.decrypt(PROFILE_ID, OTHER_ORIGIN))).toBeInstanceOf(CredentialProtectionError);
  }, TEST_TIMEOUT_MS);

  it('a partial change copies the other cipher text as is and re-encrypts only the selected value', async () => {
    const root = temporaryRoot();
    const store = createCredentialStore(root);
    const username = marker();
    await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username, password: marker() });
    const before = JSON.parse(readFileSync(credentialFilePathFor(store.directory, PROFILE_ID), 'utf8')) as Record<string, unknown>;
    const password = marker();
    const metadata = await store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password });
    const after = JSON.parse(readFileSync(credentialFilePathFor(store.directory, PROFILE_ID), 'utf8')) as Record<string, unknown>;
    expect(after.username).toBe(before.username);
    expect(after.password).not.toBe(before.password);
    expect(metadata).toMatchObject({ credentialRevision: 2, lastChangeKind: 'PASSWORD_CHANGED' });
    const decrypted = await store.decrypt(PROFILE_ID, ORIGIN);
    expect(decrypted.username === username && decrypted.password === password).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('keeps the old file when another handle holds it open during the replacement', async () => {
    const root = temporaryRoot();
    const store = createCredentialStore(root);
    await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() });
    const path = credentialFilePathFor(store.directory, PROFILE_ID);
    const before = readFileSync(path);
    const holder = await holdFileOpen(path);
    let error: unknown;
    try {
      error = await caught(store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() }));
    } finally {
      await holder.release();
    }
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).code).toBe('CREDENTIAL_REPLACE_FAILED');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(store.directory)).toEqual([`${PROFILE_ID}${CREDENTIAL_FILE_SUFFIX}`]);
    expect((await store.readMetadata(PROFILE_ID))?.credentialRevision).toBe(1);
    // 閉じた後は置き換えられる。
    await store.change({ profileId: PROFILE_ID, loginOrigin: ORIGIN, password: marker() });
    expect((await store.readMetadata(PROFILE_ID))?.credentialRevision).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('puts no value into the command line of the PowerShell child process (read through Win32_Process)', async () => {
    const commandLines: string[] = [];
    const launches: string[] = [];
    const recordingSpawner: CredentialProcessSpawner = (file, args, options) => {
      launches.push(JSON.stringify({ file, args }));
      const child = spawnCredentialProcess(file, args, options);
      const { pid } = child as unknown as { readonly pid?: number };
      if (pid !== undefined) {
        // 子プロセスは stdin を待っている（値はまだ渡していない）。cmdlet の引数は ID だけ（値を載せない）。
        commandLines.push(execFileSync(WINDOWS_POWERSHELL_PATH, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${String(pid)}').CommandLine`,
        ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
      }
      return child;
    };
    const protector = createDpapiCredentialProtectorWith({ spawnProcess: recordingSpawner, platform: process.platform });
    const value = marker();
    const entropy = marker();
    const cipher = await protector.protect(value, entropy);
    expect((await protector.unprotect(cipher, entropy)) === value).toBe(true);

    expect(commandLines).toHaveLength(2);
    for (const text of [...commandLines, ...launches]) {
      expect(text.includes('-EncodedCommand')).toBe(true);
      for (const secret of [value, entropy, Buffer.from(value, 'utf8').toString('base64'), Buffer.from(entropy, 'utf8').toString('base64')]) {
        expect(text.includes(secret)).toBe(false);
      }
    }
  }, TEST_TIMEOUT_MS);

  it('removes the temporary files left in the folder', async () => {
    const root = temporaryRoot();
    const store = createCredentialStore(root);
    await store.register({ profileId: PROFILE_ID, loginOrigin: ORIGIN, username: marker(), password: marker() });
    writeFileSync(join(store.directory, `.${PROFILE_ID}${CREDENTIAL_FILE_SUFFIX}.0f8fad5b-d9cb-469f-a165-70867728950e.tmp`), 'partial');
    expect(await store.removeTemporaryFiles()).toBe(1);
    expect(readdirSync(store.directory)).toEqual([`${PROFILE_ID}${CREDENTIAL_FILE_SUFFIX}`]);
    expect(await store.remove(PROFILE_ID)).toBe(true);
    expect(readdirSync(store.directory)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

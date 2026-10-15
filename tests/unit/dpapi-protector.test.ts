/**
 * T26a（Task 26 の設計書 4.1、4.7）: 資格情報の暗号化の部品（`src/control/credentials/dpapi-protector.ts`）の単体の検査。
 * - 子プロセスは偽物（`createFakeCredentialSpawner`）で、どの OS でも動く。本物の DPAPI は `tests/integration/credential-store-dpapi.test.ts`。
 * - 目印の値は実行ごとに作るランダムな文字列で、失敗の文に値が出ないよう、`includes` の真偽だけで確かめる。
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_PROCESS_TIMEOUT_MS,
  CREDENTIAL_PROTECTION_ERROR_CODES,
  CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE,
  CredentialProtectionError,
  MAX_CREDENTIAL_PROCESS_OUTPUT_BYTES,
  MAX_PROTECTED_TEXT_LENGTH,
  MAX_PROTECTOR_INPUT_LENGTH,
  POWERSHELL_LAUNCH_ARGUMENTS,
  WINDOWS_POWERSHELL_PATH,
  createDpapiCredentialProtector,
  createDpapiCredentialProtectorWith,
  type CredentialChildProcess,
  type CredentialProcessSpawnOptions,
  type CredentialProcessSpawner,
} from '../../src/control/credentials/dpapi-protector.js';

// ---------------------------------------------------------------------------------------------------------------
// 偽の子プロセス
// ---------------------------------------------------------------------------------------------------------------

/** 偽の子プロセスの応答。`hang` は終わらない（時間の上限の検査）。`emit-error` は起動の失敗（`error` の event）。 */
type FakeResponse =
  | { readonly kind: 'exit'; readonly exitCode: number | null; readonly stdout: string | Buffer }
  | { readonly kind: 'hang' }
  | { readonly kind: 'emit-error' }
  | { readonly kind: 'throw' };

interface FakeSpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: CredentialProcessSpawnOptions;
  readonly child: FakeCredentialChildProcess;
}

class FakeCredentialChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  stdinText = '';
  killCount = 0;
  stderrAccessed = false;

  constructor() {
    super();
    Object.defineProperty(this, 'stderr', {
      enumerable: false,
      get: () => {
        this.stderrAccessed = true;
        return null;
      },
    });
  }

  kill(): boolean {
    this.killCount += 1;
    setImmediate(() => this.emit('close', null, 'SIGTERM'));
    return true;
  }
}

const createFakeCredentialSpawner = (respond: (stdinText: string, call: number) => FakeResponse) => {
  const calls: FakeSpawnCall[] = [];
  const spawner: CredentialProcessSpawner = (file, args, options) => {
    const index = calls.length;
    const child = new FakeCredentialChildProcess();
    calls.push({ file, args: [...args], options, child });
    const preview = respond('', index);
    if (preview.kind === 'throw') {
      throw new Error('spawn failed');
    }
    if (preview.kind === 'emit-error') {
      setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
      return child as unknown as CredentialChildProcess;
    }
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk: string) => {
      child.stdinText += chunk;
    });
    child.stdin.on('end', () => {
      const response = respond(child.stdinText, index);
      if (response.kind !== 'exit') {
        return;
      }
      child.stdout.end(response.stdout);
      child.stdout.once('end', () => setImmediate(() => child.emit('close', response.exitCode, null)));
      child.stdout.resume();
    });
    return child as unknown as CredentialChildProcess;
  };
  return { spawner, calls };
};

const marker = (): string => `目印-${randomBytes(12).toString('hex')}-記号!"'\`$<>&|;%`;
const base64Utf8 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const decodeEncodedCommand = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');
const FAKE_CIPHER = Buffer.from(randomBytes(64)).toString('base64');

const exitWith = (stdout: string | Buffer, exitCode: number | null = 0): FakeResponse => ({ kind: 'exit', exitCode, stdout });

const protectorWith = (respond: (stdinText: string, call: number) => FakeResponse, timeoutMs?: number) => {
  const fake = createFakeCredentialSpawner(respond);
  const protector = createDpapiCredentialProtectorWith({
    spawnProcess: fake.spawner,
    platform: 'win32',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { protector, calls: fake.calls };
};

const caught = async (promise: Promise<unknown>): Promise<CredentialProtectionError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialProtectionError);
    return error as CredentialProtectionError;
  }
  throw new Error('expected a rejection');
};

/** 誤りのどこにも、値（`secrets` のどれか）が出ないこと。 */
const expectNoValueIn = (error: CredentialProtectionError, secrets: readonly string[]): void => {
  const surfaces = [error.message, String(error), error.stack ?? '', JSON.stringify(error), JSON.stringify(Object.entries(error))];
  for (const secret of secrets) {
    expect(surfaces.some((surface) => surface.includes(secret))).toBe(false);
  }
  expect(Object.keys(error).sort()).toEqual(['code', 'name']);
};

// ---------------------------------------------------------------------------------------------------------------
// 検査
// ---------------------------------------------------------------------------------------------------------------

describe('T26a: the DPAPI credential protector (fake child process)', () => {
  it('fixes the named limits and the launch of Windows PowerShell by its absolute path', () => {
    expect(CREDENTIAL_PROCESS_TIMEOUT_MS).toBe(10_000);
    expect(WINDOWS_POWERSHELL_PATH).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(POWERSHELL_LAUNCH_ARGUMENTS).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Object.isFrozen(POWERSHELL_LAUNCH_ARGUMENTS)).toBe(true);
    expect(CREDENTIAL_PROTECTION_ERROR_CODES).toEqual([
      'PROTECTION_UNAVAILABLE',
      'PROTECTION_FAILED',
      'PROTECTION_TIMEOUT',
      'PROTECTION_INPUT_INVALID',
    ]);
    expect(Object.isFrozen(CREDENTIAL_PROTECTION_ERROR_CODES)).toBe(true);
    expect(MAX_PROTECTOR_INPUT_LENGTH).toBeGreaterThan(0);
    expect(MAX_PROTECTED_TEXT_LENGTH).toBeLessThan(MAX_CREDENTIAL_PROCESS_OUTPUT_BYTES);
  });

  it('the production entry takes no argument', () => {
    expect(createDpapiCredentialProtector.length).toBe(0);
  });

  it('protect: launches the fixed script only, and passes the value and the entropy through stdin as base64 UTF-8 lines', async () => {
    const plain = marker();
    const entropy = marker();
    const { protector, calls } = protectorWith(() => exitWith(`${FAKE_CIPHER}\r\n`));
    await expect(protector.protect(plain, entropy)).resolves.toBe(FAKE_CIPHER);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.file).toBe(WINDOWS_POWERSHELL_PATH);
    expect(call?.args.slice(0, -1)).toEqual([...POWERSHELL_LAUNCH_ARGUMENTS]);
    expect(call?.options).toEqual({ stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
    const script = decodeEncodedCommand(call?.args.at(-1) ?? '');
    expect(script).toContain('Add-Type -AssemblyName System.Security');
    expect(script).toContain('[System.Security.Cryptography.ProtectedData]::Protect(');
    expect(script).toContain('[System.Security.Cryptography.DataProtectionScope]::CurrentUser');
    expect(script).toContain('[System.Console]::In.ReadLine()');
    expect(script).toContain(`exit ${CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE}`);
    expect(script).not.toMatch(/ExecutionPolicy/iu);
    const launch = JSON.stringify({ file: call?.file, args: call?.args, options: call?.options });
    for (const value of [plain, entropy, base64Utf8(plain), base64Utf8(entropy)]) {
      expect(launch.includes(value)).toBe(false);
      expect(script.includes(value)).toBe(false);
    }
    expect(call?.child.stdinText === `${base64Utf8(plain)}\n${base64Utf8(entropy)}\n`).toBe(true);
  });

  it('protect and unprotect each use one fixed script whatever the values are', async () => {
    const { protector, calls } = protectorWith((stdin) =>
      exitWith(stdin.startsWith(FAKE_CIPHER) ? base64Utf8('x') : FAKE_CIPHER));
    await protector.protect(marker(), marker());
    await protector.protect(marker(), marker());
    await protector.unprotect(FAKE_CIPHER, marker());
    await protector.unprotect(FAKE_CIPHER, marker());
    const [protectA, protectB, unprotectA, unprotectB] = calls.map((call) => JSON.stringify(call.args));
    expect(protectA).toBe(protectB);
    expect(unprotectA).toBe(unprotectB);
    expect(protectA).not.toBe(unprotectA);
    const unprotectScript = decodeEncodedCommand(calls[2]?.args.at(-1) ?? '');
    expect(unprotectScript).toContain('[System.Security.Cryptography.ProtectedData]::Unprotect(');
    expect(unprotectScript).toContain('[System.Security.Cryptography.DataProtectionScope]::CurrentUser');
  });

  it('unprotect: passes the cipher text and the entropy through stdin, and decodes the base64 UTF-8 output', async () => {
    const plain = marker();
    const entropy = marker();
    const { protector, calls } = protectorWith(() => exitWith(base64Utf8(plain)));
    const result = await protector.unprotect(FAKE_CIPHER, entropy);
    expect(result === plain).toBe(true);
    expect(calls[0]?.child.stdinText === `${FAKE_CIPHER}\n${base64Utf8(entropy)}\n`).toBe(true);
    expect(JSON.stringify(calls[0]?.args).includes(entropy)).toBe(false);
  });

  it('never reads stderr of the child process', async () => {
    const { protector, calls } = protectorWith(() => exitWith(FAKE_CIPHER));
    await protector.protect(marker(), marker());
    const failing = protectorWith(() => exitWith('', CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE));
    await caught(failing.protector.unprotect(FAKE_CIPHER, marker()));
    expect(calls[0]?.child.stderrAccessed).toBe(false);
    expect(failing.calls[0]?.child.stderrAccessed).toBe(false);
    expect(calls[0]?.options.stdio[2]).toBe('ignore');
  });

  it('stops the child process at the time limit (PROTECTION_TIMEOUT)', async () => {
    const { protector, calls } = protectorWith(() => ({ kind: 'hang' }), 30);
    const error = await caught(protector.protect(marker(), marker()));
    expect(error.code).toBe('PROTECTION_TIMEOUT');
    expect(calls[0]?.child.killCount).toBe(1);
  });

  it('rejects an invalid injected time limit', () => {
    const fake = createFakeCredentialSpawner(() => exitWith(FAKE_CIPHER));
    expect(() => createDpapiCredentialProtectorWith({ spawnProcess: fake.spawner, platform: 'win32', timeoutMs: 0 })).toThrow(RangeError);
  });

  it.each([
    ['the script failure exit code', exitWith('', CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE)],
    ['another exit code', exitWith(FAKE_CIPHER, 1)],
    ['no exit code (killed by a signal)', exitWith(FAKE_CIPHER, null)],
    ['an empty output', exitWith('')],
    ['an output that is not base64', exitWith('not base64!')],
    ['an output with two lines', exitWith(`${FAKE_CIPHER}\n${FAKE_CIPHER}`)],
    ['a non-canonical base64 output', exitWith('QQ')],
    ['a cipher text over the length limit', exitWith('A'.repeat(MAX_PROTECTED_TEXT_LENGTH + 4))],
  ] as const)('protect fails with PROTECTION_FAILED on %s', async (_name, response) => {
    const { protector } = protectorWith(() => response);
    const error = await caught(protector.protect(marker(), marker()));
    expect(error.code).toBe('PROTECTION_FAILED');
  });

  it('stops the child process when stdout exceeds the size limit (PROTECTION_FAILED)', async () => {
    const { protector, calls } = protectorWith(() => exitWith(Buffer.alloc(MAX_CREDENTIAL_PROCESS_OUTPUT_BYTES + 1, 0x41)));
    const error = await caught(protector.protect(marker(), marker()));
    expect(error.code).toBe('PROTECTION_FAILED');
    expect(calls[0]?.child.killCount).toBe(1);
  });

  it('unprotect fails with PROTECTION_FAILED when the output is not valid UTF-8', async () => {
    const { protector } = protectorWith(() => exitWith(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')));
    const error = await caught(protector.unprotect(FAKE_CIPHER, marker()));
    expect(error.code).toBe('PROTECTION_FAILED');
  });

  it.each([
    ['a spawn that throws', { kind: 'throw' } as const],
    ['a spawn that emits an error', { kind: 'emit-error' } as const],
  ])('fails with PROTECTION_UNAVAILABLE on %s', async (_name, response) => {
    const { protector } = protectorWith(() => response);
    const error = await caught(protector.protect(marker(), marker()));
    expect(error.code).toBe('PROTECTION_UNAVAILABLE');
  });

  it('is unavailable outside Windows, without starting a child process', async () => {
    const fake = createFakeCredentialSpawner(() => exitWith(FAKE_CIPHER));
    const protector = createDpapiCredentialProtectorWith({ spawnProcess: fake.spawner, platform: 'linux' });
    expect((await caught(protector.protect(marker(), marker()))).code).toBe('PROTECTION_UNAVAILABLE');
    expect((await caught(protector.unprotect(FAKE_CIPHER, marker()))).code).toBe('PROTECTION_UNAVAILABLE');
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ['protect', 'an empty value', (p: ReturnType<typeof protectorWith>['protector']) => p.protect('', 'entropy')],
    ['protect', 'an empty entropy', (p: ReturnType<typeof protectorWith>['protector']) => p.protect('value', '')],
    ['protect', 'a lone surrogate', (p: ReturnType<typeof protectorWith>['protector']) => p.protect('a\uD800b', 'entropy')],
    ['protect', 'a value over the limit', (p: ReturnType<typeof protectorWith>['protector']) => p.protect('a'.repeat(MAX_PROTECTOR_INPUT_LENGTH + 1), 'e')],
    ['protect', 'a value that is not a string', (p: ReturnType<typeof protectorWith>['protector']) => p.protect(1 as unknown as string, 'e')],
    ['unprotect', 'a cipher text that is not base64', (p: ReturnType<typeof protectorWith>['protector']) => p.unprotect('a b', 'entropy')],
    ['unprotect', 'an empty cipher text', (p: ReturnType<typeof protectorWith>['protector']) => p.unprotect('', 'entropy')],
    ['unprotect', 'a cipher text over the limit', (p: ReturnType<typeof protectorWith>['protector']) => p.unprotect('A'.repeat(MAX_PROTECTED_TEXT_LENGTH + 4), 'e')],
    ['unprotect', 'an entropy with a lone surrogate', (p: ReturnType<typeof protectorWith>['protector']) => p.unprotect(FAKE_CIPHER, '\uDC00')],
  ] as const)('%s rejects %s with PROTECTION_INPUT_INVALID, without starting a child process', async (_operation, _name, run) => {
    const { protector, calls } = protectorWith(() => exitWith(FAKE_CIPHER));
    const error = await caught(run(protector));
    expect(error.code).toBe('PROTECTION_INPUT_INVALID');
    expect(calls).toHaveLength(0);
  });

  it('puts no value, cipher text, entropy or child output into the errors', async () => {
    const plain = marker();
    const entropy = marker();
    const output = marker();
    const responses: readonly FakeResponse[] = [
      exitWith(output, CREDENTIAL_SCRIPT_FAILURE_EXIT_CODE),
      exitWith(output, 0),
      exitWith(base64Utf8(output), 1),
    ];
    for (const response of responses) {
      const { protector } = protectorWith(() => response);
      expectNoValueIn(await caught(protector.protect(plain, entropy)), [plain, entropy, output, base64Utf8(plain), base64Utf8(output)]);
      expectNoValueIn(await caught(protector.unprotect(FAKE_CIPHER, entropy)), [FAKE_CIPHER, entropy, output, base64Utf8(output)]);
    }
    const invalid = protectorWith(() => exitWith(FAKE_CIPHER));
    expectNoValueIn(await caught(invalid.protector.protect(`${plain}\uD800`, entropy)), [plain, entropy]);
  });
});

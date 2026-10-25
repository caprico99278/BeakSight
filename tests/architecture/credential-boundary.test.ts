/**
 * T26a（Task 26 の設計書 4.1 の Gate）: 資格情報の暗号化とファイルの部品の境界の Architecture Gate。判定は `fs`、正規表現、文字列の
 * 走査だけ（`source-scan.ts` を共用する）。近似の検査である（実行時に組み立てた指定子・文字列は検出できない）。
 * - (r) `node:child_process` を参照する（import、`export … from`、動的 import、`require`・`getBuiltinModule` の文字列）のは、監査のジョブの
 *   管理（`src/control/job/audit-job-manager.ts`）と、資格情報の 2 つの部品（`dpapi-protector.ts`、`credential-store.ts`）だけ。
 * - (s) `powershell`、`icacls`、`ProtectedData`、`whoami` の文字列（大文字と小文字を問わない。識別子と文字列リテラルを数え、コメントは
 *   数えない。`control-store-boundary.test.ts` の (c) と同じ扱い）は、資格情報の 2 つの部品だけ。
 * - (t) 資格情報のフォルダの名前（`secrets` を区切りの間に持つ文字列リテラル。`local/secrets` などを含む）を書くのは `credential-store.ts`
 *   だけで、そこに `CREDENTIAL_DIRECTORY_NAME` の定義がちょうど 1 つある。
 * - (u) 本番の入口は、暗黙の本物を使う形（`createDpapiCredentialProtector()` は引数なし、`createCredentialStore(repoRoot)` はリポジトリの根
 *   だけ）。テストが偽物を渡す内部の作り（`createDpapiCredentialProtectorWith`、`createCredentialStoreWith`）と、子プロセスの起動の部品
 *   （`runCredentialProcess`、`spawnCredentialProcess`）は、資格情報の 2 つの部品の外のコードに現れない（`worker-login-hooks.test.ts` の (n)(p)
 *   と同じ形）。
 * - (v) テストの偽物の名前（`FakeCredentialChildProcess`、`createFakeCredentialSpawner`、`createFakeCredentialProtector`）は `src/` に現れず、
 *   `src/control/credentials/` には偽物を表す識別子（`fake`・`stub`・`mock` を含むもの）がない。
 * - (w) `src/control/credentials/` は、環境変数（`process.env`）を読まない（PowerShell と icacls は絶対パスの定数で起動し、PATH の検索や
 *   `SystemRoot` に頼らない）。
 * - T26g-2（T26R の M3）: (r)(s)(t)(w) を、画面のコード（`apps/local-ui/src` の `.ts`・`.tsx`）にも、例外なしで当てる。
 * - (x)（CCX-5。台帳の CC-065）: 資格情報を保存できるプラットフォームの値（`process.platform` の `'win32'`）を、文字列リテラルとして書くのは
 *   owner の `src/control/credentials/credential-platform.ts` だけ（`CREDENTIAL_PLATFORM` の定義がちょうど 1 つ）。`src/` と画面のコード
 *   （`apps/local-ui/src`）の両方に当てる。除外は、意味の違う 2 か所だけ（`PLATFORM_LITERAL_EXCEPTIONS` に理由を書く）。
 * - (y)（PRE42-CC 組 3。N4-8c）: 暗号化の往復の確かめの結果（`CredentialProtectionState`）の値の名前つきの定数は、`credential-platform.ts` の
 *   `CREDENTIAL_PROTECTION_AVAILABLE` だけ（定義がちょうど 1 つ）。owner の外（`src/` と画面）では、`'AVAILABLE' satisfies CredentialProtectionState`、
 *   `: CredentialProtectionState = 'AVAILABLE'` の形の定数を置かない（値の一覧そのものは `credential-store.ts` の `CREDENTIAL_PROTECTION_STATES`）。
 * - ファイル全体を 1 秒以内に終える。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PROTECTION_STATES } from '../../src/control/credentials/credential-store.js';
import { CHILD_PROCESS_MODULE, CHILD_PROCESS_RUNTIME_FILES } from './child-process-policy.js';
import {
  REPOSITORY_ROOT,
  findCallSites,
  findImportSpecifiers,
  loadLocalUiSourceFiles,
  loadSourceFiles,
  scanSource,
  splitTopLevelArguments,
  type ScannedSource,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/**
 * T26g-2（T26R の M3）: 画面のコード（`apps/local-ui/src` の `.ts`・`.tsx`）。(r)(s)(t)(w) を、ここにも当てる（画面のサーバが資格情報の
 * 部品を通らずに子プロセス・PowerShell・資格情報のフォルダ・環境変数に触れない）。読み込みと走査は、このファイルの読み込み時に 1 回だけ。
 */
const APP_SOURCE_FILES = loadLocalUiSourceFiles();

const CREDENTIAL_DIRECTORY = 'src/control/credentials/';
const PROTECTOR_PATH = 'src/control/credentials/dpapi-protector.ts';
const STORE_PATH = 'src/control/credentials/credential-store.ts';
const CREDENTIAL_OWNERS: ReadonlySet<string> = new Set([PROTECTOR_PATH, STORE_PATH]);
/**
 * (r) `node:child_process` を参照してよいファイル: 共通の一覧（`child-process-policy.ts` の `CHILD_PROCESS_RUNTIME_FILES`。ジョブの管理と
 * `dpapi-protector.ts`）に、この Gate の追加（資格情報のファイルの部品 `credential-store.ts`）を足したもの（PRE42-CC 組 G。新 Gate の 12）。
 */
const CHILD_PROCESS_USERS: ReadonlySet<string> = new Set([...CHILD_PROCESS_RUNTIME_FILES, STORE_PATH]);

/** 偽物を渡す内部の作りと、子プロセスの起動の部品の名前（資格情報の 2 つの部品の外に現れない）。 */
const INTERNAL_NAMES: readonly string[] = [
  'createDpapiCredentialProtectorWith',
  'createCredentialStoreWith',
  'runCredentialProcess',
  'spawnCredentialProcess',
];
/** テストの偽物の名前（`src/` に現れない。テストに実際にあることも確かめる）。 */
const FAKE_NAMES: readonly string[] = ['FakeCredentialChildProcess', 'createFakeCredentialSpawner', 'createFakeCredentialProtector'];
const FAKE_DEFINING_TESTS: readonly string[] = ['tests/unit/dpapi-protector.test.ts', 'tests/unit/credential-store.test.ts'];

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/**
 * (r) `child_process` の参照（import の指定子と、`require`・`getBuiltinModule`・動的 import の文字列）。モジュールの名前の形は
 * `child-process-policy.ts` の `CHILD_PROCESS_MODULE`（`source-scan.ts` の `modulePattern`。下位のパスと、文字列の中の `node:child_process` も当てる）。
 */
const findChildProcessReferences = (source: ScannedSource): readonly string[] => [
  ...findImportSpecifiers(source.code).filter((specifier) => CHILD_PROCESS_MODULE.test(specifier)),
  ...source.literals.filter((literal) => CHILD_PROCESS_MODULE.test(literal)).map((literal) => `literal ${literal}`),
];

/** (s) 子プロセスと DPAPI の道具の名前（コメントを除いた本文。識別子と文字列の両方）。 */
const WINDOWS_TOOL_PATTERN = /powershell|icacls|protecteddata|whoami/giu;
const findWindowsToolNames = (source: ScannedSource): readonly string[] => [...source.code.matchAll(WINDOWS_TOOL_PATTERN)].map((match) => match[0]);

/** (t) 資格情報のフォルダの名前を区切りの間に持つ文字列リテラル。 */
const SECRETS_DIRECTORY_LITERAL = /(?:^|[\\/])secrets(?:[\\/]|$)/iu;
const findSecretsDirectoryLiterals = (source: ScannedSource): readonly string[] =>
  source.literals.filter((literal) => SECRETS_DIRECTORY_LITERAL.test(literal));
const DIRECTORY_NAME_DEFINITION = /\bexport\s+const\s+CREDENTIAL_DIRECTORY_NAME\s*=/gu;

/** (u) 本番の入口の定義の引数の並び。 */
const PROTECTOR_ENTRY_DEFINITION = /\bexport\s+const\s+createDpapiCredentialProtector\s*=\s*\(([^)]*)\)/u;
const STORE_ENTRY_DEFINITION = /\bexport\s+const\s+createCredentialStore\s*=\s*\(([^)]*)\)/u;

/** `name` の呼び出しの引数の数（定義を除く）。 */
const argumentCountsOf = (source: ScannedSource, name: string): readonly number[] =>
  findCallSites(source.bare, name).map((site) => splitTopLevelArguments(site.argumentText).length);

const identifierPattern = (name: string): RegExp => new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'u');

/** (v) 偽物を表す識別子（`bare`。文字列とコメントを除く）。 */
const FAKE_IDENTIFIER_PATTERN = /(?<![\w$])[\w$]*(?:fake|stub|mock)[\w$]*/giu;

/** (w) 環境変数の読み取り。 */
const ENVIRONMENT_READ_PATTERN = /\bprocess\s*\.\s*env\b/gu;

/** (x) 資格情報を保存できるプラットフォームの値の owner と、その定義。 */
const PLATFORM_OWNER_PATH = 'src/control/credentials/credential-platform.ts';
const PLATFORM_DEFINITION = /\bexport\s+const\s+CREDENTIAL_PLATFORM\b/gu;
/** (x) 同じ値を、別の名前の定数として定義していないか（`const CREDENTIAL_PLATFORM`、`const DPAPI_PLATFORM` などの、owner の外の定義）。 */
const PLATFORM_CONSTANT_DEFINITION = /\bconst\s+(?:CREDENTIAL|DPAPI)_PLATFORM\b/gu;
/** (x) `'win32'` の文字列リテラル（大文字と小文字を問わない。識別子の `win32`（`node:path` の `win32`）とコメントは数えない）。 */
const WIN32_LITERAL = /^win32$/iu;
const findWin32Literals = (source: ScannedSource): readonly string[] => source.literals.filter((literal) => WIN32_LITERAL.test(literal));
/**
 * (x) の除外（資格情報の保存とは意味の違う `'win32'`。理由つき）。
 * - `artifact-writer.ts`: Windows ではディレクトリの `fsync` ができない（ファイルシステムの性質。資格情報の保存の可否とは無関係）。
 * - `screenshot-collector.ts`: Windows のパスは大文字と小文字を区別しない（パスの比べ方。資格情報の保存の可否とは無関係）。
 */
const PLATFORM_LITERAL_EXCEPTIONS: ReadonlySet<string> = new Set(['src/report/artifact-writer.ts', 'src/evidence/screenshot-collector.ts']);

/** (y) 暗号化の往復の確かめの結果の値の、名前つきの定数の定義（owner は `credential-platform.ts`）。 */
const PROTECTION_AVAILABLE_DEFINITION = /\bexport\s+const\s+CREDENTIAL_PROTECTION_AVAILABLE\s*=\s*'AVAILABLE'\s+satisfies\s+CredentialProtectionState\b/gu;
/** (y) 型で確かめた、暗号化の往復の確かめの結果の値の定数（owner の外に置かない）。 */
const PROTECTION_STATE_CONSTANTS: readonly RegExp[] = [
  new RegExp(`'(?:${CREDENTIAL_PROTECTION_STATES.join('|')})'\\s+satisfies\\s+CredentialProtectionState\\b`, 'gu'),
  new RegExp(`:\\s*CredentialProtectionState\\s*=\\s*'(?:${CREDENTIAL_PROTECTION_STATES.join('|')})'`, 'gu'),
];
const findProtectionStateConstants = (source: ScannedSource): readonly string[] =>
  PROTECTION_STATE_CONSTANTS.flatMap((pattern) => [...source.code.matchAll(pattern)].map((match) => match[0]));

const fileAt = (path: string) => SOURCE_FILES.find((file) => file.path === path);

// ---------------------------------------------------------------------------------------------------------------
// 検査
// ---------------------------------------------------------------------------------------------------------------

describe('Credential boundary (T26a)', () => {
  it('reads the two credential components and the job manager', () => {
    expect(SOURCE_FILES.map(({ path }) => path)).toEqual(expect.arrayContaining([...CHILD_PROCESS_USERS]));
  });

  it('(r) only the job manager and the two credential components refer to node:child_process', () => {
    const users = SOURCE_FILES.filter((file) => findChildProcessReferences(file).length > 0).map(({ path }) => path);
    expect(users.filter((path) => !CHILD_PROCESS_USERS.has(path))).toEqual([]);
    expect(users).toEqual(expect.arrayContaining(['src/control/job/audit-job-manager.ts', PROTECTOR_PATH]));
  });

  it('(s) the names of PowerShell, icacls, ProtectedData and whoami appear only in the two credential components', () => {
    const leaks = SOURCE_FILES
      .filter(({ path }) => !CREDENTIAL_OWNERS.has(path))
      .flatMap((file) => findWindowsToolNames(file).map((name) => `${file.path}: ${name}`));
    expect(leaks).toEqual([]);
    expect(findWindowsToolNames(fileAt(PROTECTOR_PATH) ?? scanSource('')).length).toBeGreaterThan(0);
    expect(findWindowsToolNames(fileAt(STORE_PATH) ?? scanSource('')).length).toBeGreaterThan(0);
  });

  it('(t) only credential-store.ts names the credential folder, and defines CREDENTIAL_DIRECTORY_NAME exactly once', () => {
    const leaks = SOURCE_FILES
      .filter(({ path }) => path !== STORE_PATH)
      .flatMap((file) => findSecretsDirectoryLiterals(file).map((literal) => `${file.path}: ${literal}`));
    expect(leaks).toEqual([]);
    const store = fileAt(STORE_PATH);
    expect(findSecretsDirectoryLiterals(store ?? scanSource(''))).toEqual(['secrets']);
    expect([...(store?.code ?? '').matchAll(DIRECTORY_NAME_DEFINITION)]).toHaveLength(1);
    const definitions = SOURCE_FILES.filter(({ path }) => path !== STORE_PATH)
      .filter((file) => [...file.code.matchAll(DIRECTORY_NAME_DEFINITION)].length > 0);
    expect(definitions.map(({ path }) => path)).toEqual([]);
  });

  it('(u) the production entries use the implicit real parts, and the injection points stay inside the two components', () => {
    expect(PROTECTOR_ENTRY_DEFINITION.exec(fileAt(PROTECTOR_PATH)?.bare ?? '')?.[1]?.trim()).toBe('');
    expect(STORE_ENTRY_DEFINITION.exec(fileAt(STORE_PATH)?.bare ?? '')?.[1]?.replaceAll(/\s/gu, '')).toBe('repoRoot:string');
    const entryCalls = SOURCE_FILES.flatMap((file) => [
      ...argumentCountsOf(file, 'createDpapiCredentialProtector').filter((count) => count !== 0)
        .map((count) => `${file.path}: createDpapiCredentialProtector with ${count} argument(s)`),
      ...argumentCountsOf(file, 'createCredentialStore').filter((count) => count !== 1)
        .map((count) => `${file.path}: createCredentialStore with ${count} argument(s)`),
    ]);
    expect(entryCalls).toEqual([]);
    const leaks = SOURCE_FILES
      .filter(({ path }) => !CREDENTIAL_OWNERS.has(path))
      .flatMap(({ path, bare }) => INTERNAL_NAMES.filter((name) => identifierPattern(name).test(bare)).map((name) => `${path}: ${name}`));
    expect(leaks).toEqual([]);
  });

  it('(v) the names of the test fakes never appear in src/, and src/control/credentials/ has no fake identifier', () => {
    for (const testPath of FAKE_DEFINING_TESTS) {
      const content = readFileSync(join(REPOSITORY_ROOT, testPath), 'utf8');
      expect(FAKE_NAMES.some((name) => content.includes(name)), testPath).toBe(true);
    }
    const leaks = SOURCE_FILES.flatMap(({ path, content }) =>
      FAKE_NAMES.filter((name) => identifierPattern(name).test(content)).map((name) => `${path}: ${name}`));
    expect(leaks).toEqual([]);
    const fakeIdentifiers = SOURCE_FILES
      .filter(({ path }) => path.startsWith(CREDENTIAL_DIRECTORY))
      .flatMap(({ path, bare }) => [...bare.matchAll(FAKE_IDENTIFIER_PATTERN)].map((match) => `${path}: ${match[0]}`));
    expect(fakeIdentifiers).toEqual([]);
  });

  it('(w) src/control/credentials/ does not read environment variables', () => {
    const reads = SOURCE_FILES
      .filter(({ path }) => path.startsWith(CREDENTIAL_DIRECTORY))
      .flatMap(({ path, bare }) => [...bare.matchAll(ENVIRONMENT_READ_PATTERN)].map((match) => `${path}: ${match[0]}`));
    expect(reads).toEqual([]);
  });

  // T26g-2（T26R の M3）: 画面のコードには、(r)(s)(t)(w) の例外がない（どのファイルも、子プロセス・道具の名前・資格情報のフォルダの名前・
  // 環境変数に触れない。資格情報は `src/control/credentials/` の部品を通す）。
  it('(r)(s)(t)(w) apply to apps/local-ui/src with no exception (T26g-2)', () => {
    expect(APP_SOURCE_FILES.map(({ path }) => path)).toEqual(expect.arrayContaining([
      'apps/local-ui/src/server/credential-service.ts',
      'apps/local-ui/src/server/profile-functions.ts',
    ]));
    expect(APP_SOURCE_FILES.some(({ path }) => path.endsWith('.tsx'))).toBe(true);
    const violations = APP_SOURCE_FILES.flatMap((file) => [
      ...findChildProcessReferences(file).map((reference) => `${file.path}: (r) ${reference}`),
      ...findWindowsToolNames(file).map((name) => `${file.path}: (s) ${name}`),
      ...findSecretsDirectoryLiterals(file).map((literal) => `${file.path}: (t) ${literal}`),
      ...[...file.code.matchAll(DIRECTORY_NAME_DEFINITION)].map(() => `${file.path}: (t) CREDENTIAL_DIRECTORY_NAME`),
      ...[...file.bare.matchAll(ENVIRONMENT_READ_PATTERN)].map((match) => `${file.path}: (w) ${match[0]}`),
    ]);
    expect(violations).toEqual([]);
  });

  // CCX-5（CC-065）: 資格情報を保存できるプラットフォームの値は、owner の 1 か所だけ。
  it('(x) only credential-platform.ts writes the credential platform value, and defines CREDENTIAL_PLATFORM exactly once (CCX-5)', () => {
    const owner = fileAt(PLATFORM_OWNER_PATH);
    expect(owner, PLATFORM_OWNER_PATH).toBeDefined();
    expect(findWin32Literals(owner ?? scanSource(''))).toHaveLength(1);
    expect([...(owner?.code ?? '').matchAll(PLATFORM_DEFINITION)]).toHaveLength(1);
    const violations = [...SOURCE_FILES, ...APP_SOURCE_FILES]
      .filter(({ path }) => path !== PLATFORM_OWNER_PATH)
      .flatMap((file) => [
        ...(PLATFORM_LITERAL_EXCEPTIONS.has(file.path) ? [] : findWin32Literals(file).map((literal) => `${file.path}: '${literal}'`)),
        ...[...file.code.matchAll(PLATFORM_CONSTANT_DEFINITION)].map((match) => `${file.path}: ${match[0]}`),
        ...[...file.code.matchAll(PLATFORM_DEFINITION)].map((match) => `${file.path}: ${match[0]}`),
      ]);
    expect(violations).toEqual([]);
  });

  // PRE42-CC 組 3（N4-8c）: 暗号化の往復の確かめの結果の値の名前つきの定数は、credential-platform.ts の 1 か所だけ。
  it('(y) only credential-platform.ts defines the named credential protection state constant (PRE42-CC, N4-8c)', () => {
    const violations = [...SOURCE_FILES, ...APP_SOURCE_FILES]
      .filter(({ path }) => path !== PLATFORM_OWNER_PATH)
      .flatMap((file) => [
        ...findProtectionStateConstants(file).map((found) => `${file.path}: ${found}`),
        ...[...file.code.matchAll(PROTECTION_AVAILABLE_DEFINITION)].map((match) => `${file.path}: ${match[0]}`),
      ]);
    expect(violations).toEqual([]);
    expect([...(fileAt(PLATFORM_OWNER_PATH)?.code ?? '').matchAll(PROTECTION_AVAILABLE_DEFINITION)]).toHaveLength(1);
  });

  // 各規則が、現実的な書き方の違反で RED になること（検出の関数の自己確認）。
  it('detects realistic violations (detector self-check)', () => {
    // (r)
    // import は、指定子と文字列の両方で数える（どちらか 1 つでも違反）。
    expect(findChildProcessReferences(scanSource("import { execFile } from 'node:child_process';")).length).toBeGreaterThan(0);
    expect(findChildProcessReferences(scanSource("import type { ChildProcess } from 'child_process';")).length).toBeGreaterThan(0);
    expect(findChildProcessReferences(scanSource("const cp = await import('node:child_process');")).length).toBeGreaterThan(0);
    expect(findChildProcessReferences(scanSource("const cp = process.getBuiltinModule('node:child_process');"))).toHaveLength(1);
    expect(findChildProcessReferences(scanSource("const cp = require('child_process');"))).toHaveLength(1);
    expect(findChildProcessReferences(scanSource('// node:child_process is not used here'))).toHaveLength(0);
    // PRE42-CC 組 G（新 Gate の 2。最も広い形）: 文字列の中の `node:child_process` も数える。似た名前は数えない。
    expect(findChildProcessReferences(scanSource("const name = `node:child_process`;"))).toHaveLength(1);
    expect(findChildProcessReferences(scanSource("const label = 'load node:child_process here';"))).toHaveLength(1);
    expect(findChildProcessReferences(scanSource("const label = 'child_processes';"))).toHaveLength(0);
    // (s)
    expect(findWindowsToolNames(scanSource("spawn('PowerShell.exe', ['-Command', script]);"))).toEqual(['PowerShell']);
    expect(findWindowsToolNames(scanSource("execFile('icacls', [dir]);"))).toEqual(['icacls']);
    expect(findWindowsToolNames(scanSource("const s = '[Security.Cryptography.ProtectedData]::Protect($d)';"))).toEqual(['ProtectedData']);
    expect(findWindowsToolNames(scanSource("execFile('C:/Windows/System32/whoami.exe', ['/user']);"))).toEqual(['whoami']);
    expect(findWindowsToolNames(scanSource('const WHOAMI_PATH = 1;'))).toEqual(['WHOAMI']);
    expect(findWindowsToolNames(scanSource('// Windows PowerShell 5.1 writes a BOM'))).toEqual([]);
    // (t)
    expect(findSecretsDirectoryLiterals(scanSource("const dir = join(root, 'local', 'secrets');"))).toEqual(['secrets']);
    expect(findSecretsDirectoryLiterals(scanSource("const dir = `${root}/local/secrets/${id}.json`;"))).toHaveLength(1);
    expect(findSecretsDirectoryLiterals(scanSource("const dir = 'local\\\\secrets';"))).toHaveLength(1);
    expect(findSecretsDirectoryLiterals(scanSource("const name = 'redactUrlSecrets';"))).toEqual([]);
    expect([...scanSource("export const CREDENTIAL_DIRECTORY_NAME = 'x';").code.matchAll(DIRECTORY_NAME_DEFINITION)]).toHaveLength(1);
    // (u)
    expect(PROTECTOR_ENTRY_DEFINITION.exec('export const createDpapiCredentialProtector = (spawner = spawn): P =>')?.[1]).toBe('spawner = spawn');
    expect(STORE_ENTRY_DEFINITION.exec('export const createCredentialStore = (repoRoot: string, deps?: D): S =>')?.[1])
      .toBe('repoRoot: string, deps?: D');
    expect(argumentCountsOf(scanSource('const p = createDpapiCredentialProtector(fakeSpawner);'), 'createDpapiCredentialProtector')).toEqual([1]);
    expect(argumentCountsOf(scanSource('const s = createCredentialStore(root, { protector });'), 'createCredentialStore')).toEqual([2]);
    expect(identifierPattern('createCredentialStoreWith').test(scanSource('const s = createCredentialStoreWith(root, deps);').bare)).toBe(true);
    expect(identifierPattern('runCredentialProcess').test(scanSource("import { runCredentialProcess } from './x.js';").bare)).toBe(true);
    // (v)
    expect([...scanSource('const fakeSpawner = createFakeCredentialSpawner();').bare.matchAll(FAKE_IDENTIFIER_PATTERN)]).toHaveLength(2);
    expect([...scanSource('class StubProtector {}').bare.matchAll(FAKE_IDENTIFIER_PATTERN)]).toHaveLength(1);
    expect(identifierPattern('FakeCredentialChildProcess').test('new FakeCredentialChildProcess()')).toBe(true);
    // (w)
    expect([...scanSource("const root = process.env['SystemRoot'];").bare.matchAll(ENVIRONMENT_READ_PATTERN)]).toHaveLength(1);
    // (x)
    expect(findWin32Literals(scanSource("export const isSupported = (): boolean => process.platform === 'win32';"))).toEqual(['win32']);
    expect(findWin32Literals(scanSource('if (platform !== "win32") { reject(); }'))).toEqual(['win32']);
    expect(findWin32Literals(scanSource('const supported = platform === `win32`;'))).toEqual(['win32']);
    expect(findWin32Literals(scanSource("import { win32 } from 'node:path';\nconst absolute = win32.isAbsolute(path);"))).toEqual([]);
    expect(findWin32Literals(scanSource('// win32 only: DPAPI'))).toEqual([]);
    expect([...scanSource("const CREDENTIAL_PLATFORM = 'x';").code.matchAll(PLATFORM_CONSTANT_DEFINITION)]).toHaveLength(1);
    expect([...scanSource("const DPAPI_PLATFORM = 'x';").code.matchAll(PLATFORM_CONSTANT_DEFINITION)]).toHaveLength(1);
    expect([...scanSource("export const CREDENTIAL_PLATFORM = 'x';").code.matchAll(PLATFORM_DEFINITION)]).toHaveLength(1);
    // (y)
    expect(findProtectionStateConstants(scanSource("const PROTECTION_AVAILABLE = 'AVAILABLE' satisfies CredentialProtectionState;"))).toHaveLength(1);
    expect(findProtectionStateConstants(scanSource("const UNAVAILABLE: CredentialProtectionState = 'UNAVAILABLE';"))).toHaveLength(1);
    expect(findProtectionStateConstants(scanSource("return plainText === TEXT ? 'AVAILABLE' : 'UNAVAILABLE';"))).toHaveLength(0);
    expect(findProtectionStateConstants(scanSource("// 'AVAILABLE' satisfies CredentialProtectionState"))).toHaveLength(0);
    expect(findProtectionStateConstants(scanSource('if (protection !== CREDENTIAL_PROTECTION_AVAILABLE) {}'))).toHaveLength(0);
    expect([...scanSource("export const CREDENTIAL_PROTECTION_AVAILABLE = 'AVAILABLE' satisfies CredentialProtectionState;").code
      .matchAll(PROTECTION_AVAILABLE_DEFINITION)]).toHaveLength(1);
  });

  // T26g-2（T26R の M3）: 画面のコードの書き方（Server Function のサーバのコードと TSX）でも、(r)(s)(t)(w) の違反を捕まえる。
  it('detects realistic violations in the screen code (detector self-check, T26g-2)', () => {
    const serverCode = scanSource([
      "import { execFileSync } from 'node:child_process';",
      "const secretsDirectory = join(localUiRepositoryRoot(), 'local', 'secrets');",
      "export const aclFn = createServerFn({ method: 'GET' }).handler(() => execFileSync('icacls.exe', [secretsDirectory]));",
      'const root = process.env.SystemRoot;',
    ].join('\n'));
    expect(findChildProcessReferences(serverCode).length).toBeGreaterThan(0);
    expect(findWindowsToolNames(serverCode)).toEqual(['icacls']);
    expect(findSecretsDirectoryLiterals(serverCode)).toEqual(['secrets']);
    expect([...serverCode.bare.matchAll(ENVIRONMENT_READ_PATTERN)]).toHaveLength(1);
    const component = scanSource([
      'export function CredentialHelp() {',
      '  return <p className="help">{`PowerShell: ${path}/local/secrets/`}</p>;',
      '}',
    ].join('\n'));
    expect(findWindowsToolNames(component)).toEqual(['PowerShell']);
    expect(findSecretsDirectoryLiterals(component)).toHaveLength(1);
  });
});

/**
 * ワーカーの fork のテストの補助の Gate（PRE42-CC の組 6a。台帳の CC-061 の後半、CC-091、CC-095 の戻り、CC-097）。判定は `fs`、正規表現、
 * 文字列の検索だけ（`source-scan.ts` の `readTypeScriptFilesUnder` を共用する）。近似の検査である。
 * - 見る所: 結合のテスト（`tests/integration/**`）、テストの補助（`tests/helpers/**`）、画面のテスト（`apps/local-ui/tests/**`）。
 * - (a) 形の写し: 次の形は、持ち主の補助だけに書く（テストのファイルに書き写さない）。
 *   - 標準入力の資格情報の準備（`STDIN_CREDENTIALS_PRELUDE`）と、状態を待つ（`waitForValue`）と、process とその子孫（`processTreeOf`）と、
 *     記録つきの fork（`createRecordingFork`。IPC の受けたものと送ったもの、標準出力と標準エラー、標準入力）: `tests/helpers/worker-fork-support.ts`。
 *   - ログインの画面を開いたときに資格情報の組を入れて送る口: `tests/helpers/test-login-worker-entry.ts`（`testLoginWorkerEntrySource`。
 *     ほかの口は `additionalHooks` で足す）。
 *   - 移せる偽の暗号化の部品で資格情報の部品を開く口: `tests/helpers/auto-login-worker-entry.ts`（`PORTABLE_CREDENTIAL_STORE_HOOK_SOURCE`）。
 *   - ジョブの管理に渡す、ワーカーを起動する関数の中の `fork(…, [...args], …)`: `worker-fork-support.ts` の `createRecordingFork` と、
 *     `tests/helpers/worker-fork.ts` の `createCountingFork`。
 * - (b) `worker-fork-support.ts` が公開する名前を、結合のテストで定義し直さない。
 * - (c) fork のテスト（`tests/integration/*-fork.test.ts`）と fork の補助は、読み取りの要求の method を書き写さない（`leak-places.ts` の
 *   `READ_METHODS`・`nonReadRequestsOf` を使う。CC-093 の fork のテストの分。ほかのファイルは組 7 の Gate `test-request-helper-reuse` が見る）。
 * - 除外は閉じた一覧（理由つき）。使われなくなった除外も誤りにする。
 * - 1 ファイル 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { MAX_GATE_MS, exportedNamesOf, readLfTypeScriptFilesUnder, readMethodCopiesIn, startCpuStopwatch, unusedExclusionsOf, type UnscannedFile } from './source-scan.js';

const WORKER_FORK_SUPPORT = 'tests/helpers/worker-fork-support.ts';
const WORKER_FORK = 'tests/helpers/worker-fork.ts';
const TEST_LOGIN_WORKER_ENTRY = 'tests/helpers/test-login-worker-entry.ts';
const AUTO_LOGIN_WORKER_ENTRY = 'tests/helpers/auto-login-worker-entry.ts';

const FILES: readonly UnscannedFile[] = readLfTypeScriptFilesUnder(['tests/integration', 'tests/helpers', 'apps/local-ui/tests']);

/** 写しの形（名前、形、持ち主のファイル）。 */
interface CopyShape {
  readonly name: string;
  readonly pattern: RegExp;
  readonly owners: readonly string[];
}

const COPY_SHAPES: readonly CopyShape[] = Object.freeze([
  {
    name: 'stdin credentials prelude',
    pattern: /process\.stdin\.on\('end',\s*\(\)\s*=>\s*resolve\(JSON\.parse\(text\)\)\)/u,
    owners: [WORKER_FORK_SUPPORT],
  },
  { name: 'wait for a value', pattern: /'the expected state was not reached'/u, owners: [WORKER_FORK_SUPPORT] },
  { name: 'process tree', pattern: /processes\.filter\(\(\w+\)\s*=>\s*\w+\.processId\s*===/u, owners: [WORKER_FORK_SUPPORT] },
  { name: 'recorded IPC send', pattern: /child\.send\s*=\s*\(/u, owners: [WORKER_FORK_SUPPORT] },
  {
    name: 'worker forker',
    pattern: /\bfork\(\s*[\w.]+(?:\s*\?\?\s*[\w.]+)?\s*,\s*\[\.\.\.args\]/u,
    owners: [WORKER_FORK_SUPPORT, WORKER_FORK],
  },
  {
    name: 'login page hook',
    pattern: /for\s*\(const\s*\[selector,\s*value\]\s*of\s*fields\)\s*\{\s*await\s+page\.fill\(selector,\s*value\)/u,
    owners: [TEST_LOGIN_WORKER_ENTRY],
  },
  {
    name: 'portable credential store hook',
    pattern: /openCredentialStore:\s*\(root\)\s*=>\s*createCredentialStoreWith\(root,/u,
    owners: [AUTO_LOGIN_WORKER_ENTRY],
  },
]);

/** (a) の除外（ファイル → 形の名前 → 理由）。今は空（組 6a-F で control の結合のテストの 2 か所も寄せた）。 */
const COPY_EXCEPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({});

/**
 * (c) 読み取りの要求の method を書き写した形（組 7 の Gate `test-request-helper-reuse.test.ts` の (a) と同じ強さ。fork のテストは、組 7 の Gate が
 * 見ないで、ここで見る）: 写しの `new Set(['GET', 'HEAD'])`・`['GET', 'HEAD'].includes(`、手で書いた判定（どちらの順でも。同じ文の中）。HEAD を
 * 読み取りに数えない判定（`method !== 'GET'` だけ）は、意味が違うので数えない。形は `source-scan.ts` の `READ_METHOD_COPY_SHAPES`・`readMethodCopiesIn`
 * （組 7 の Gate と共用。PRE42-CC 組 G）。ここでは、コメントを含む本文に当てる。
 */
const writesReadMethods = (content: string): boolean => readMethodCopiesIn(content).length > 0;
/** (c) を見るファイル。 */
const isForkTestFile = (path: string): boolean =>
  /^tests\/integration\/[^/]+-fork\.test\.ts$/u.test(path) || [WORKER_FORK_SUPPORT, WORKER_FORK, 'tests/helpers/write-job-harness.ts'].includes(path);
/** (c) の除外（ファイル → 理由）。今は空。 */
const READ_METHOD_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({});

// 補助のファイルが公開する名前（関数と値）は、`source-scan.ts` の `exportedNamesOf`（PRE42-CC 組 G）。

/** 名前の定義（どの深さでも）: `function NAME`、`const NAME`。 */
const definesName = (text: string, name: string): boolean =>
  new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:(?:async[ \\t]+)?function[ \\t]*\\*?[ \\t]*|const[ \\t]+)${name}\\b`, 'mu').test(text);

/** (a) の写しの形が現れた所（`<ファイル>: <形の名前>`）と、使った除外。 */
const copiesIn = (files: readonly UnscannedFile[]): { readonly found: readonly string[]; readonly used: ReadonlySet<string> } => {
  const found: string[] = [];
  const used = new Set<string>();
  for (const { path, content } of files) {
    for (const shape of COPY_SHAPES) {
      if (shape.owners.includes(path) || !shape.pattern.test(content)) {
        continue;
      }
      if (COPY_EXCEPTIONS[path]?.[shape.name] !== undefined) {
        used.add(`${path}:${shape.name}`);
        continue;
      }
      found.push(`${path}: ${shape.name}`);
    }
  }
  return { found, used };
};

describe('Gate: the worker fork tests use the shared fork helpers (PRE42-CC group 6a)', () => {
  it('reads the files and the names of the shared helpers', () => {
    expect(FILES.map(({ path }) => path)).toEqual(expect.arrayContaining([WORKER_FORK_SUPPORT, WORKER_FORK, TEST_LOGIN_WORKER_ENTRY, AUTO_LOGIN_WORKER_ENTRY]));
    const support = FILES.find(({ path }) => path === WORKER_FORK_SUPPORT)?.content ?? '';
    expect(exportedNamesOf(support)).toEqual(expect.arrayContaining([
      'STDIN_CREDENTIALS_PRELUDE', 'STDIN_CREDENTIALS_EXPRESSION', 'processTreeOf', 'waitForValue', 'createRecordingFork', 'createForkTestProfile', 'readRunArtifacts',
    ]));
    for (const shape of COPY_SHAPES) {
      const owners = FILES.filter(({ path }) => shape.owners.includes(path));
      expect(owners.some(({ content }) => shape.pattern.test(content)), `the owner of "${shape.name}" has the shape`).toBe(true);
    }
  });

  it('(a) writes the fork test shapes only in their owners', () => {
    const stopwatch = startCpuStopwatch();
    const { found, used } = copiesIn(FILES);
    expect(found).toEqual([]);
    const declared = Object.entries(COPY_EXCEPTIONS).flatMap(([path, entries]) => Object.keys(entries).map((name) => `${path}:${name}`));
    expect(unusedExclusionsOf(declared, used), 'exceptions that are no longer used').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * FILES.length);
  });

  it('(b) does not define again a name of the fork test helper in an integration test', () => {
    const support = FILES.find(({ path }) => path === WORKER_FORK_SUPPORT)?.content ?? '';
    const names = exportedNamesOf(support);
    const found = FILES.filter(({ path }) => path.startsWith('tests/integration/'))
      .flatMap(({ path, content }) => names.filter((name) => definesName(content, name)).map((name) => `${path}: ${name}`));
    expect(found).toEqual([]);
  });

  it('(c) does not judge the read request methods by hand in a fork test', () => {
    const used = new Set<string>();
    const found = FILES.filter(({ path }) => isForkTestFile(path)).flatMap(({ path, content }) => {
      if (!writesReadMethods(content)) {
        return [];
      }
      if (READ_METHOD_EXCEPTIONS[path] !== undefined) {
        used.add(path);
        return [];
      }
      return [path];
    });
    expect(found).toEqual([]);
    expect(unusedExclusionsOf(Object.keys(READ_METHOD_EXCEPTIONS), used), 'exceptions that are no longer used').toEqual([]);
  });

  it('finds the shapes that are placed on purpose (the control)', () => {
    const planted = (content: string): readonly string[] => copiesIn([{ path: 'tests/integration/planted-fork.test.ts', content }]).found;
    expect(planted("  process.stdin.on('end', () => resolve(JSON.parse(text)));")).toEqual(['tests/integration/planted-fork.test.ts: stdin credentials prelude']);
    expect(planted("      throw new Error('the expected state was not reached');")).toEqual(['tests/integration/planted-fork.test.ts: wait for a value']);
    expect(planted('  return [...processes.filter((identity) => identity.processId === processId)];')).toEqual(['tests/integration/planted-fork.test.ts: process tree']);
    expect(planted('  child.send = ((message: unknown): boolean => send(message)) as typeof child.send;')).toEqual(['tests/integration/planted-fork.test.ts: recorded IPC send']);
    expect(planted("    const child = fork(entry, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });")).toEqual(['tests/integration/planted-fork.test.ts: worker forker']);
    expect(planted('  const child = fork(modulePath, [...args], options);')).toEqual(['tests/integration/planted-fork.test.ts: worker forker']);
    expect(planted('      for (const [selector, value] of fields) {\n        await page.fill(selector, value);\n      }')).toEqual(['tests/integration/planted-fork.test.ts: login page hook']);
    expect(planted('  openCredentialStore: (root) => createCredentialStoreWith(root, {')).toEqual(['tests/integration/planted-fork.test.ts: portable credential store hook']);
    expect(planted("  const child = fork(entry, [], { cwd: workDirectory, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });")).toEqual([]);
    expect(definesName('async function processTreeOf(processId: number): Promise<readonly ProcessIdentity[]> {', 'processTreeOf')).toBe(true);
    expect(definesName('const STDIN_CREDENTIALS_PRELUDE = String.raw`', 'STDIN_CREDENTIALS_PRELUDE')).toBe(true);
    expect(definesName('const tree = await processTreeOf(child.pid ?? 0);', 'processTreeOf')).toBe(false);
    expect(writesReadMethods("site.requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD')")).toBe(true);
    expect(writesReadMethods(".filter((request) => request.method !== 'GET' && request.method !== 'HEAD')")).toBe(true);
    expect(writesReadMethods(".filter((request) => request.method !== 'HEAD' && request.method !== 'GET')")).toBe(true);
    expect(writesReadMethods("const isRead = request.method() === 'GET' || request.method() === 'HEAD';")).toBe(true);
    expect(writesReadMethods("const READ = new Set(['GET', 'HEAD']);")).toBe(true);
    expect(writesReadMethods("if (['HEAD', 'GET'].includes(method)) {")).toBe(true);
    expect(writesReadMethods("request.method !== 'GET'")).toBe(false);
    expect(writesReadMethods("!READ_METHODS.has(request.method)")).toBe(false);
  });
});

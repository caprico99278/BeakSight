// PRE42-CC の組 6a（台帳の CC-091、CC-097）: ワーカーの fork のテストの補助の、速く確かめられる所。本物の fork のテストは一時のビルドと Chromium が
// 要るので、ここでは補助の形だけを確かめる。
// - `testLoginWorkerEntrySource` の `additionalHooks`: `runAuditWorkerProcess` の口の組の、`loginStage` の後に入る。省略なら何も足さない。
//   どの組み合わせでも JavaScript として読める（import の行を除いた本体を関数として組み立てる）。
// - `createRecordingFork`: 小さな子 process（一時のフォルダの `.mjs`）を起動し、受けたもの・送ったもの・標準出力と標準エラー・標準入力を確かめる。
//   標準入力の本文を渡さなければ、標準入力を開かない。ジョブの管理が渡した起動の設定（`cwd` など）は保つ。
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PORTABLE_CREDENTIAL_STORE_HOOK_SOURCE } from '../helpers/auto-login-worker-entry.js';
import { testLoginWorkerEntrySource } from '../helpers/test-login-worker-entry.js';
import { STDIN_CREDENTIALS_EXPRESSION, STDIN_CREDENTIALS_PRELUDE, createRecordingFork } from '../helpers/worker-fork-support.js';

const LOGIN_TIMEOUT_MS = 60_000;
const CHILD_TIMEOUT_MS = 20_000;

/** import の行を除いた本体（ESM の import は関数の中に書けないので除く）。 */
const bodyOf = (source: string): string => source.split('\n').filter((line) => !line.startsWith('import ')).join('\n');

describe('testLoginWorkerEntrySource: additional hooks (CC-091)', () => {
  it.each([
    ['no additional hooks', undefined],
    ['the portable credential store', PORTABLE_CREDENTIAL_STORE_HOOK_SOURCE],
    ['the run Browser', '\n  ...(launchRunBrowser === undefined ? {} : { launchRunBrowser }),'],
  ])('is valid JavaScript with %s', (_name, additionalHooks) => {
    const source = testLoginWorkerEntrySource({
      distPrefix: './dist/',
      loginTimeoutMs: LOGIN_TIMEOUT_MS,
      prelude: `${STDIN_CREDENTIALS_PRELUDE}const launchRunBrowser = undefined;\nconst createCredentialStoreWith = () => null;\nconst portableProtector = null;\nconst rename = null;\n`,
      credentialsExpression: STDIN_CREDENTIALS_EXPRESSION,
      ...(additionalHooks === undefined ? {} : { additionalHooks }),
    });
    expect(() => new Function(bodyOf(source))).not.toThrow();
    const options = source.slice(source.indexOf('runAuditWorkerProcess(process, {'));
    if (additionalHooks === undefined) {
      expect(options).toMatch(/\n {2}\},\n\}\);\n$/u);
    } else {
      expect(options).toContain(`\n  },${additionalHooks}\n});`);
    }
  });
});

describe('createRecordingFork (CC-097)', () => {
  let directory: string;
  let entry: string;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-recording-fork-'));
    entry = join(directory, 'echo-child.mjs');
    // 親から受けたメッセージに、標準入力の本文（開いていなければ空）と作業のフォルダを付けて返し、標準出力と標準エラーに 1 行ずつ書いて終わる。
    await writeFile(entry, String.raw`
const stdinText = new Promise((resolve) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => resolve(text));
});
process.on('message', async (message) => {
  process.stdout.write('out-line\n');
  process.stderr.write('err-line\n');
  process.send({ echoed: message, stdin: await stdinText, cwd: process.cwd() }, () => process.disconnect());
});
process.send({ ready: true });
`, 'utf8');
  });

  afterAll(async () => {
    for (const child of children.filter((started) => started.exitCode === null && started.signalCode === null)) {
      child.kill();
    }
    await rm(directory, { recursive: true, force: true });
  });

  /** 子を起動し、最初のメッセージの後に `{ hello: 1 }` を送り、終わるまで待つ。 */
  const runChild = async (withStdin: boolean): Promise<{ readonly received: unknown[]; readonly sent: unknown[]; readonly output: string }> => {
    const received: unknown[] = [];
    const sent: unknown[] = [];
    let output = '';
    const forker = createRecordingFork({
      entry,
      ...(withStdin ? { stdinText: () => 'given-on-stdin' } : {}),
      onChild: (child) => children.push(child),
      onReceived: (message) => received.push(message),
      onOutput: (chunk) => { output += chunk; },
      onSent: (message) => sent.push(message),
    });
    const child = forker('not-used.js', [], { cwd: directory, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
    child.once('message', () => child.send({ hello: 1 }));
    // `close`: 終わりと、標準出力と標準エラーの読み終わりの両方。
    await new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
    return { received, sent, output };
  };

  it('records the messages both ways and the output, and writes the standard input', async () => {
    const { received, sent, output } = await runChild(true);
    expect(sent).toEqual([{ hello: 1 }]);
    expect(received).toEqual([{ ready: true }, { echoed: { hello: 1 }, stdin: 'given-on-stdin', cwd: directory }]);
    expect(output).toContain('out-line');
    expect(output).toContain('err-line');
    expect(children.at(-1)?.exitCode).toBe(0);
    expect(children.at(-1)?.stdin).not.toBeNull();
  }, CHILD_TIMEOUT_MS);

  it('does not open the standard input without a text', async () => {
    const { received } = await runChild(false);
    expect(children.at(-1)?.stdin).toBeNull();
    expect(received.at(-1)).toMatchObject({ stdin: '' });
  }, CHILD_TIMEOUT_MS);
});

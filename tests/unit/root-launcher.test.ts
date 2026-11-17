// LAUNCH-1: リポジトリ直下の起動ファイルの本体（`tools/launcher/start.mjs`。設計書 `doc/design/2026-11-08-beaksight-root-launcher-design.md` 3・6）。
// - 純粋な部分（版の比べ、依存を入れ直すかの判定、引数の組み立て、npm の動かし方、説明の文）を単体で確かめる。
// - `main` は、子のプロセスの起動を偽物に差し替えて確かめる（`npm ci` と画面のサーバを実際には動かさない）。
// - 本体を子のプロセスで動かし、Node の版の誤り（偽の版を渡す）と、依存の一覧（package-lock.json）がない場合（場所を差し替える）で、終了コード 1 と
//   説明が出ることを確かめる（どちらも npm を動かす前に止まる）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../architecture/source-scan.js';

/** 本体の場所。 */
const START_SCRIPT = join(REPOSITORY_ROOT, 'tools', 'launcher', 'start.mjs');

/** 子のプロセスを起動する関数の形（`node:child_process` の `spawn` の、本体が使う部分）。 */
type SpawnChild = (command: string, args: readonly string[], options: { readonly cwd?: string; readonly stdio?: unknown; readonly shell?: boolean; readonly env?: NodeJS.ProcessEnv }) => EventEmitter;

/** npm の動かし方。 */
interface NpmCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

/** 依存を入れたときの記録。 */
interface InstallRecord {
  readonly lockfileSha256: string;
  readonly nodeVersion: string;
}

/** `main` の差し替えの口。 */
interface MainOptions {
  readonly argv?: readonly string[];
  readonly nodeVersion?: string;
  readonly rootDirectory?: string;
  readonly platform?: string;
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
  readonly spawnChild?: SpawnChild;
  readonly chromiumInstalled?: (rootDirectory: string) => boolean;
  readonly print?: (line: string) => void;
  readonly printError?: (line: string) => void;
  readonly onSignal?: (signal: string, handler: () => void) => void;
}

/** 本体のモジュールの形（`.mjs` なので、型はここに書く）。 */
interface LauncherModule {
  readonly LAUNCHER_EXIT_FAILURE: number;
  readonly INSTALL_RECORD_PATH: string;
  readonly LAUNCHER_TEXT: {
    readonly versionMismatch: (required: string, current: string) => readonly string[];
    readonly versionRangeUnreadable: string;
    readonly installingDependencies: string;
    readonly dependenciesFailed: readonly string[];
    readonly installingChromium: string;
    readonly chromiumFailed: readonly string[];
    readonly startFailed: (detail: string) => readonly string[];
  };
  readonly checkNodeVersion: (range: string, current: string) => 'SATISFIED' | 'NOT_SATISFIED' | 'UNREADABLE';
  readonly dependencyInstallReason: (input: {
    readonly nodeModulesPresent: boolean;
    readonly record: InstallRecord | null;
    readonly lockfileSha256: string;
    readonly nodeVersion: string;
  }) => 'MISSING' | 'NO_RECORD' | 'LOCKFILE_CHANGED' | 'NODE_CHANGED' | null;
  readonly parseInstallRecord: (text: string) => InstallRecord | null;
  readonly buildUiArguments: (argv: readonly string[]) => readonly string[];
  readonly escapeCmdArgument: (value: string) => string;
  readonly resolveNpmCommand: (input: {
    readonly platform: string;
    readonly execPath: string;
    readonly exists: (path: string) => boolean;
    readonly npmArguments: readonly string[];
  }) => NpmCommand;
  readonly isChromiumInstalled: (rootDirectory: string) => boolean;
  readonly main: (options?: MainOptions) => Promise<number>;
}

const launcher = (await import(pathToFileURL(START_SCRIPT).href)) as LauncherModule;

/** 今の `package.json` の `engines.node`。 */
const ENGINES_NODE = '>=24.22.1 <25';
/** テストの lockfile の中身。 */
const LOCKFILE_TEXT = '{"lockfileVersion":3}\n';
const LOCKFILE_SHA256 = createHash('sha256').update(LOCKFILE_TEXT).digest('hex');

describe('checkNodeVersion（版の比べ）', () => {
  it('下限ちょうどと、範囲の中の版は満たす', () => {
    expect(launcher.checkNodeVersion(ENGINES_NODE, 'v24.22.1')).toBe('SATISFIED');
    expect(launcher.checkNodeVersion(ENGINES_NODE, 'v24.30.2')).toBe('SATISFIED');
    expect(launcher.checkNodeVersion(ENGINES_NODE, '24.99.99')).toBe('SATISFIED');
  });

  it('下回る版は満たさない', () => {
    expect(launcher.checkNodeVersion(ENGINES_NODE, 'v24.22.0')).toBe('NOT_SATISFIED');
    expect(launcher.checkNodeVersion(ENGINES_NODE, 'v24.9.9')).toBe('NOT_SATISFIED');
    expect(launcher.checkNodeVersion(ENGINES_NODE, 'v20.0.0')).toBe('NOT_SATISFIED');
  });

  it('上回る版は満たさない（上限の 25 は含まない）', () => {
    expect(launcher.checkNodeVersion(ENGINES_NODE, 'v25.0.0')).toBe('NOT_SATISFIED');
    expect(launcher.checkNodeVersion(ENGINES_NODE, 'v26.1.0')).toBe('NOT_SATISFIED');
  });

  it('ほかの比べの記号と、>= と < の省いた版の書き方も読む', () => {
    expect(launcher.checkNodeVersion('>24.22.1', 'v24.22.2')).toBe('SATISFIED');
    expect(launcher.checkNodeVersion('>24.22.1', 'v24.22.1')).toBe('NOT_SATISFIED');
    expect(launcher.checkNodeVersion('<=24.22.1', 'v24.22.1')).toBe('SATISFIED');
    expect(launcher.checkNodeVersion('=24.22.1', 'v24.22.2')).toBe('NOT_SATISFIED');
    expect(launcher.checkNodeVersion('24.22.1', 'v24.22.1')).toBe('SATISFIED');
    expect(launcher.checkNodeVersion('>=24', 'v24.0.0')).toBe('SATISFIED');
    expect(launcher.checkNodeVersion('>=24.1 <24.2', 'v24.1.9')).toBe('SATISFIED');
  });

  it('読めない書き方は UNREADABLE（確かめを飛ばす）', () => {
    // 省いた版は >= と < のときだけ読む（ほかの記号では、npm の決まりと 0 で埋めた比べが食い違うため）。
    for (const range of ['', '   ', '^24.22.1', '~24.22.1', '>=24 || >=26', '24.x', 'latest', '>= 24.22.1', '>=24.22.1-rc.1', '>24.22', '<=25', '24']) {
      expect(launcher.checkNodeVersion(range, 'v24.22.1'), range).toBe('UNREADABLE');
    }
  });

  it('今の版を読めないときも UNREADABLE', () => {
    expect(launcher.checkNodeVersion(ENGINES_NODE, 'unknown')).toBe('UNREADABLE');
    expect(launcher.checkNodeVersion(ENGINES_NODE, 'v24.22')).toBe('UNREADABLE');
  });
});

describe('dependencyInstallReason（依存を入れ直すかの判定）', () => {
  const record: InstallRecord = { lockfileSha256: LOCKFILE_SHA256, nodeVersion: 'v24.30.2' };

  it('node_modules がなければ MISSING', () => {
    expect(launcher.dependencyInstallReason({ nodeModulesPresent: false, record, lockfileSha256: LOCKFILE_SHA256, nodeVersion: 'v24.30.2' })).toBe('MISSING');
  });

  it('前に入れたときの記録がなければ NO_RECORD', () => {
    expect(launcher.dependencyInstallReason({ nodeModulesPresent: true, record: null, lockfileSha256: LOCKFILE_SHA256, nodeVersion: 'v24.30.2' })).toBe('NO_RECORD');
  });

  it('lockfile の SHA-256 が違えば LOCKFILE_CHANGED、Node の版が違えば NODE_CHANGED', () => {
    expect(launcher.dependencyInstallReason({ nodeModulesPresent: true, record, lockfileSha256: 'f'.repeat(64), nodeVersion: 'v24.30.2' })).toBe('LOCKFILE_CHANGED');
    expect(launcher.dependencyInstallReason({ nodeModulesPresent: true, record, lockfileSha256: LOCKFILE_SHA256, nodeVersion: 'v24.31.0' })).toBe('NODE_CHANGED');
  });

  it('同じなら入れ直さない（null）', () => {
    expect(launcher.dependencyInstallReason({ nodeModulesPresent: true, record, lockfileSha256: LOCKFILE_SHA256, nodeVersion: 'v24.30.2' })).toBeNull();
  });

  it('記録の読み取り: 形が違えば null', () => {
    expect(launcher.parseInstallRecord(JSON.stringify(record))).toEqual(record);
    for (const text of ['', 'not json', '[]', '{"lockfileSha256":1,"nodeVersion":"v24.30.2"}', '{"lockfileSha256":"a"}']) {
      expect(launcher.parseInstallRecord(text), text).toBeNull();
    }
  });
});

describe('isChromiumInstalled（Chromium の有無の確かめ）', () => {
  it('Playwright を読めない場所では false（例外にしない）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'beaksight-launcher-chromium-'));
    try {
      await writeFile(join(empty, 'package.json'), '{}', 'utf8');
      expect(launcher.isChromiumInstalled(empty)).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('buildUiArguments（引数の受け渡し）', () => {
  it('引数がなければ npm run ui だけ', () => {
    expect(launcher.buildUiArguments([])).toEqual(['run', 'ui']);
  });

  it('受けた引数を、-- の後にそのまま並べる（空白や記号を含む値も 1 つのまま）', () => {
    expect(launcher.buildUiArguments(['--port', '4400'])).toEqual(['run', 'ui', '--', '--port', '4400']);
    expect(launcher.buildUiArguments(['a b', 'x&y', '"q"', '%PATH%'])).toEqual(['run', 'ui', '--', 'a b', 'x&y', '"q"', '%PATH%']);
  });
});

describe('resolveNpmCommand（npm の動かし方）', () => {
  const npmArguments = ['run', 'ui', '--', '--port', '4400'];

  it('Windows: node の隣の npm-cli.js を、シェルを通さずに node で動かす', () => {
    const execPath = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCli = win32.join('C:\\Program Files\\nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const command = launcher.resolveNpmCommand({ platform: 'win32', execPath, exists: (path) => path === npmCli, npmArguments });
    expect(command).toEqual({ command: execPath, args: [npmCli, ...npmArguments], windowsVerbatimArguments: false });
  });

  it('macOS・Linux: lib/node_modules の npm-cli.js を、シェルを通さずに node で動かす', () => {
    const execPath = '/usr/local/bin/node';
    const npmCli = posix.join('/usr/local', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const command = launcher.resolveNpmCommand({ platform: 'linux', execPath, exists: (path) => path === npmCli, npmArguments });
    expect(command).toEqual({ command: execPath, args: [npmCli, ...npmArguments], windowsVerbatimArguments: false });
  });

  it('macOS・Linux で npm-cli.js が見つからなければ、npm をシェルを通さずに動かす', () => {
    const command = launcher.resolveNpmCommand({ platform: 'darwin', execPath: '/opt/node/bin/node', exists: () => false, npmArguments });
    expect(command).toEqual({ command: 'npm', args: npmArguments, windowsVerbatimArguments: false });
  });

  it('Windows で npm-cli.js が見つからなければ、cmd.exe で npm.cmd を動かし、引数を 1 つずつ逃がす', () => {
    const args = ['run', 'ui', '--', 'a b&c'];
    const command = launcher.resolveNpmCommand({ platform: 'win32', execPath: 'D:\\n\\node.exe', exists: () => false, npmArguments: args });
    expect(command.command).toBe('cmd.exe');
    expect(command.windowsVerbatimArguments).toBe(true);
    expect(command.args).toEqual(['/d', '/s', '/c', `"npm.cmd ${args.map(launcher.escapeCmdArgument).join(' ')}"`]);
  });
});

describe('escapeCmdArgument（cmd.exe の引数の逃がし方）', () => {
  it('引用符で囲み、cmd.exe の記号を ^ で 2 重に逃がす（npm.cmd の中でもう 1 度読まれるため）', () => {
    expect(launcher.escapeCmdArgument('4400')).toBe('^^^"4400^^^"');
    expect(launcher.escapeCmdArgument('a&b')).toBe('^^^"a^^^&b^^^"');
    expect(launcher.escapeCmdArgument('%PATH%')).toBe('^^^"^^^%PATH^^^%^^^"');
  });

  it('値の中の引用符は、バックスラッシュで逃がしてから囲む', () => {
    expect(launcher.escapeCmdArgument('say "hi"')).toBe('^^^"say^^^ \\^^^"hi\\^^^"^^^"');
    expect(launcher.escapeCmdArgument('end\\')).toBe('^^^"end\\\\^^^"');
  });
});

describe('LAUNCHER_TEXT（説明の文）', () => {
  it('版が合わないときは、必要な版と今の版を示す', () => {
    const lines = launcher.LAUNCHER_TEXT.versionMismatch(ENGINES_NODE, 'v20.0.0');
    expect(lines[0]).toBe('BeakSight を起動できません。Node.js の版が合いません。');
    expect(lines.join('\n')).toContain(ENGINES_NODE);
    expect(lines.join('\n')).toContain('v20.0.0');
  });

  it('依存を入れられなかったときは、手で入れるコマンドを示す', () => {
    expect(launcher.LAUNCHER_TEXT.dependenciesFailed.join('\n')).toContain('npm ci --ignore-scripts');
  });

  it('Chromium を入れられなかったときは、手で入れるコマンドを示す', () => {
    expect(launcher.LAUNCHER_TEXT.chromiumFailed.join('\n')).toContain('npx playwright install chromium');
  });

  it('1 行の文は改行を含まない', () => {
    expect(launcher.LAUNCHER_TEXT.versionRangeUnreadable).not.toContain('\n');
    expect(launcher.LAUNCHER_TEXT.installingDependencies).not.toContain('\n');
    expect(launcher.LAUNCHER_TEXT.installingChromium).not.toContain('\n');
  });

  it('npm を動かせなかったときは、詳細を添える', () => {
    expect(launcher.LAUNCHER_TEXT.startFailed('spawn npm ENOENT').join('\n')).toContain('spawn npm ENOENT');
  });
});

/** 偽の子のプロセス。 */
class FakeChild extends EventEmitter {
  readonly killed: string[] = [];

  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }
}

/** 子のプロセスの終わり方（呼ばれた順に使う）。 */
type ChildOutcome = { readonly exit: number | null; readonly signal?: string } | { readonly error: string } | 'manual';

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Parameters<SpawnChild>[2];
  readonly child: FakeChild;
}

/** 偽の起動の関数（呼ばれた順に `outcomes` のとおりに終わる。'manual' は終わらせない）。 */
const fakeSpawn = (outcomes: readonly ChildOutcome[]) => {
  const calls: SpawnCall[] = [];
  const spawnChild: SpawnChild = (command, args, options) => {
    const child = new FakeChild();
    const outcome = outcomes[calls.length] ?? { exit: 0 };
    calls.push({ command, args, options, child });
    if (outcome !== 'manual') {
      setImmediate(() => {
        if ('error' in outcome) child.emit('error', new Error(outcome.error));
        else child.emit('exit', outcome.exit, outcome.signal ?? null);
      });
    }
    return child;
  };
  return { calls, spawnChild };
};

describe('main（子のプロセスの起動を偽物にして）', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'beaksight-launcher-main-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: ENGINES_NODE } }), 'utf8');
    await writeFile(join(root, 'package-lock.json'), LOCKFILE_TEXT, 'utf8');
  });

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  /** 依存が入っていて、記録も今と同じ状態にする。 */
  const installed = async (nodeVersion = 'v24.30.2') => {
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, 'local', 'runtime'), { recursive: true });
    await writeFile(join(root, launcher.INSTALL_RECORD_PATH), JSON.stringify({ lockfileSha256: LOCKFILE_SHA256, nodeVersion }), 'utf8');
  };

  const baseOptions = (spawnChild: SpawnChild, errors: string[] = [], logs: string[] = []): MainOptions => ({
    nodeVersion: 'v24.30.2',
    rootDirectory: root,
    platform: 'linux',
    execPath: '/opt/beaksight-node/bin/node',
    env: { PATH: '/usr/bin' },
    exists: () => false,
    spawnChild,
    chromiumInstalled: () => true,
    print: (line) => logs.push(line),
    printError: (line) => errors.push(line),
    onSignal: () => undefined,
  });

  it('依存が今と同じなら、npm run ui -- <引数> だけを、root で、入出力を引き継いで動かし、子の終了コードを返す', async () => {
    await installed();
    const { calls, spawnChild } = fakeSpawn([{ exit: 7 }]);
    const errors: string[] = [];
    expect(await launcher.main({ ...baseOptions(spawnChild, errors), argv: ['--port', '4400'] })).toBe(7);
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([['npm', 'run', 'ui', '--', '--port', '4400']]);
    expect(calls[0]?.options).toMatchObject({ cwd: root, stdio: 'inherit', shell: false });
    // 子は、この Node のフォルダを PATH の先頭に置いて動かす（npm の中の node も同じ Node にする）。
    expect(calls[0]?.options.env?.PATH).toBe(['/opt/beaksight-node/bin', '/usr/bin'].join(posix.delimiter));
    expect(errors).toEqual([]);
  });

  it('node_modules がなければ、npm ci --ignore-scripts で入れてから記録を書き、画面を起動する', async () => {
    const { calls, spawnChild } = fakeSpawn([{ exit: 0 }, { exit: 0 }]);
    const logs: string[] = [];
    expect(await launcher.main(baseOptions(spawnChild, [], logs))).toBe(0);
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([['npm', 'ci', '--ignore-scripts'], ['npm', 'run', 'ui']]);
    expect(logs).toContain(launcher.LAUNCHER_TEXT.installingDependencies);
    const record = launcher.parseInstallRecord(await readFile(join(root, launcher.INSTALL_RECORD_PATH), 'utf8'));
    expect(record).toEqual({ lockfileSha256: LOCKFILE_SHA256, nodeVersion: 'v24.30.2' });
  });

  it('前に入れたときと Node の版が違えば、入れ直す', async () => {
    await installed('v24.22.1');
    const { calls, spawnChild } = fakeSpawn([{ exit: 0 }, { exit: 0 }]);
    expect(await launcher.main(baseOptions(spawnChild))).toBe(0);
    expect(calls.map(({ args }) => args[0])).toEqual(['ci', 'run']);
  });

  it('npm ci が失敗したら、説明を出して 1。記録は書かず、画面は起動しない', async () => {
    const { calls, spawnChild } = fakeSpawn([{ exit: 1 }]);
    const errors: string[] = [];
    expect(await launcher.main(baseOptions(spawnChild, errors))).toBe(launcher.LAUNCHER_EXIT_FAILURE);
    expect(calls).toHaveLength(1);
    expect(errors).toEqual([...launcher.LAUNCHER_TEXT.dependenciesFailed]);
    await expect(readFile(join(root, launcher.INSTALL_RECORD_PATH), 'utf8')).rejects.toThrow();
  });

  it('Chromium がなければ、node_modules の Playwright の CLI で install chromium を動かしてから画面を起動する（npx を使わない）', async () => {
    await installed();
    const { calls, spawnChild } = fakeSpawn([{ exit: 0 }, { exit: 0 }]);
    const logs: string[] = [];
    let checks = 0;
    // 1 回目の確かめはない、入れた後の確かめはある。
    const chromiumInstalled = (rootDirectory: string) => {
      expect(rootDirectory).toBe(root);
      checks += 1;
      return checks > 1;
    };
    expect(await launcher.main({ ...baseOptions(spawnChild, [], logs), chromiumInstalled })).toBe(0);
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ['/opt/beaksight-node/bin/node', join(root, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
      ['npm', 'run', 'ui'],
    ]);
    expect(calls[0]?.options).toMatchObject({ cwd: root, stdio: 'inherit', shell: false });
    expect(logs).toContain(launcher.LAUNCHER_TEXT.installingChromium);
    expect(checks).toBe(2);
  });

  it('npm ci の後（Playwright の版が変わりうる）にも Chromium を確かめる', async () => {
    const { calls, spawnChild } = fakeSpawn([{ exit: 0 }, { exit: 0 }, { exit: 0 }]);
    let checks = 0;
    const chromiumInstalled = () => {
      checks += 1;
      return checks > 1;
    };
    expect(await launcher.main({ ...baseOptions(spawnChild), chromiumInstalled })).toBe(0);
    expect(calls.map(({ args }) => args.slice(-2).join(' '))).toEqual(['ci --ignore-scripts', 'install chromium', 'run ui']);
  });

  it('Chromium を入れられない（失敗、入れた後もない）ときは、説明を出して 1。画面は起動しない。install-deps は動かさない', async () => {
    await installed();
    const failed = fakeSpawn([{ exit: 1 }]);
    const errors: string[] = [];
    expect(await launcher.main({ ...baseOptions(failed.spawnChild, errors), chromiumInstalled: () => false })).toBe(launcher.LAUNCHER_EXIT_FAILURE);
    expect(failed.calls).toHaveLength(1);
    expect(errors).toEqual([...launcher.LAUNCHER_TEXT.chromiumFailed]);

    const missing = fakeSpawn([{ exit: 0 }]);
    const missingErrors: string[] = [];
    expect(await launcher.main({ ...baseOptions(missing.spawnChild, missingErrors), chromiumInstalled: () => false })).toBe(launcher.LAUNCHER_EXIT_FAILURE);
    expect(missing.calls.map(({ args }) => args.slice(1))).toEqual([['install', 'chromium']]);
    expect(missingErrors).toEqual([...launcher.LAUNCHER_TEXT.chromiumFailed]);
  });

  it('子がシグナルで終わったら 1、起動できなければ説明を出して 1', async () => {
    await installed();
    const signaled = fakeSpawn([{ exit: null, signal: 'SIGTERM' }]);
    expect(await launcher.main(baseOptions(signaled.spawnChild))).toBe(launcher.LAUNCHER_EXIT_FAILURE);

    const failing = fakeSpawn([{ error: 'spawn npm ENOENT' }]);
    const errors: string[] = [];
    expect(await launcher.main(baseOptions(failing.spawnChild, errors))).toBe(launcher.LAUNCHER_EXIT_FAILURE);
    expect(errors.join('\n')).toContain('spawn npm ENOENT');
  });

  it('Ctrl+C は子に任せ（本体は止まらない）、本体だけに来た SIGTERM は子へ渡す', async () => {
    await installed();
    const { calls, spawnChild } = fakeSpawn(['manual']);
    const handlers = new Map<string, () => void>();
    const done = launcher.main({ ...baseOptions(spawnChild), onSignal: (signal, handler) => handlers.set(signal, handler) });
    await expect.poll(() => calls.length).toBe(1);
    const child = calls[0]?.child;
    expect([...handlers.keys()]).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM']));
    handlers.get('SIGINT')?.();
    expect(child?.killed).toEqual([]);
    handlers.get('SIGTERM')?.();
    expect(child?.killed).toEqual(['SIGTERM']);
    child?.emit('exit', 0, null);
    expect(await done).toBe(0);
  });

  it('engines を読めないときは、注意を 1 行出して起動を続ける', async () => {
    await installed();
    await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: '^24.22.1' } }), 'utf8');
    const { calls, spawnChild } = fakeSpawn([{ exit: 0 }]);
    const errors: string[] = [];
    expect(await launcher.main(baseOptions(spawnChild, errors))).toBe(0);
    expect(calls).toHaveLength(1);
    expect(errors).toEqual([launcher.LAUNCHER_TEXT.versionRangeUnreadable]);
  });
});

describe('本体を子のプロセスで動かす（npm も画面のサーバも動かさない）', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'beaksight-launcher-process-'));
    // 今の Node の版を満たす engines。package-lock.json は置かない（依存の確かめで止まる）。
    await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: ENGINES_NODE } }), 'utf8');
  });

  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  /** 本体を読み込み、`main` に `options`（JSON）を渡して動かす。 */
  const runMain = (options: Record<string, unknown>) =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { main } from ${JSON.stringify(pathToFileURL(START_SCRIPT).href)}; process.exitCode = await main(${JSON.stringify(options)});`,
      ],
      { cwd: tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );

  it('Node の版が合わなければ、必要な版と今の版を出して終了コード 1', () => {
    const result = runMain({ argv: ['--port', '4400'], nodeVersion: 'v20.0.0', rootDirectory: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node.js の版が合いません');
    expect(result.stderr).toContain(ENGINES_NODE);
    expect(result.stderr).toContain('v20.0.0');
  });

  it('依存の一覧（package-lock.json）がなければ、手で入れる方法を出して終了コード 1', () => {
    const result = runMain({ argv: [], rootDirectory: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm ci --ignore-scripts');
  });
});

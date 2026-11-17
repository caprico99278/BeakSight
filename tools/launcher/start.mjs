#!/usr/bin/env node
// BeakSight の起動の本体（設計書 `doc/design/2026-11-08-beaksight-root-launcher-design.md` 3）。リポジトリ直下の起動ファイル
// （`BeakSight.cmd`・`beaksight.sh`）が、条件を満たす Node.js を用意してから、これを呼ぶ。`node tools/launcher/start.mjs [引数]` でも動く。
// Node の標準だけを使う（依存を足さない）。
//
// 行うこと:
//   1. Node の版が `package.json` の `engines.node` を満たすかを確かめる。満たさなければ、必要な版と今の版を出して止まる（終了コード 1）。
//      読めない書き方なら、確かめを飛ばして注意を 1 行出す。
//   2. 依存の用意: `node_modules` がないか、前に入れたときと `package-lock.json` の SHA-256 か Node の版が違えば、`npm ci --ignore-scripts` で
//      入れ直し、記録（`local/runtime/dependencies.json`）を書く。失敗したら、手で入れる方法を出して止まる（終了コード 1）。
//   3. Chromium の用意: BeakSight が使う Chromium（`channel: 'chromium'`）の実行ファイルが、今の Playwright の版のものとして置いてなければ、
//      `node_modules` の Playwright の CLI で `install chromium` を動かす（`npx` を使わない。`install-deps` は動かさない）。失敗したら、手で入れる
//      方法を出して止まる（終了コード 1）。
//   4. `npm run ui -- <受けた引数>` を子のプロセスで動かし、入出力を引き継ぎ、子の終了コードを自分の終了コードにする。Ctrl+C は子へ届き、子の
//      止め方（`apps/local-ui/launcher/serve.ts`）に任せる（本体は Ctrl+C で止まらずに、子の終わりを待つ）。
//
// 子のプロセスは、この Node のフォルダを PATH の先頭に置いて動かす（npm と、npm の中の node を同じ Node にする）。npm は、この Node の隣の
// `npm-cli.js` を、シェルを通さずに動かす（引数の空白や記号でコマンドが壊れないため）。見つからなければ、macOS・Linux は `npm` を、Windows は
// cmd.exe で `npm.cmd` を、引数を 1 つずつ逃がして動かす。
//
// 利用者向けの文は、ここ（`LAUNCHER_TEXT`）に置く。Node がまだないときの文だけは、起動ファイルの側（`bootstrap.ps1`・`beaksight.sh`）にある。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** このファイルのあるリポジトリの root（`tools/launcher/` の 2 つ上）。 */
export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 止まったときの終了コード。 */
export const LAUNCHER_EXIT_FAILURE = 1;

/** 依存を入れたときの記録（root からのパス。`local/` は Git の外）。 */
export const INSTALL_RECORD_PATH = path.join('local', 'runtime', 'dependencies.json');

/** 依存を入れるコマンド（README の「必要なもの」と同じ。入れるときのスクリプトは動かさない）。 */
const INSTALL_ARGUMENTS = Object.freeze(['ci', '--ignore-scripts']);

/** 利用者向けの文（日本語で短く）。 */
export const LAUNCHER_TEXT = Object.freeze({
  versionMismatch: (required, current) => [
    'BeakSight を起動できません。Node.js の版が合いません。',
    `必要な版: ${required}`,
    `今の版: ${current}`,
    'BeakSight.cmd（macOS・Linux は beaksight.sh）から起動すると、合う版を自動で用意します。',
  ],
  versionRangeUnreadable: '注意: 必要な Node.js の版を読めなかったので、版の確かめを飛ばします。',
  installingDependencies: 'BeakSight に必要な部品を入れています。初めてのときは数分かかります。',
  dependenciesFailed: [
    'BeakSight を起動できません。必要な部品を入れられませんでした。',
    'インターネットにつながっているかを確かめて、もう一度起動してください。',
    '手で入れるときは、このフォルダで npm ci --ignore-scripts を実行してください。',
  ],
  installingChromium: '監査に使うブラウザ（Chromium）を入れています。初めてのときは数分かかります。',
  chromiumFailed: [
    'BeakSight を起動できません。監査に使うブラウザ（Chromium）を入れられませんでした。',
    'インターネットにつながっているかを確かめて、もう一度起動してください。',
    '手で入れるときは、このフォルダで npx playwright install chromium を実行してください。',
  ],
  startFailed: (detail) => ['BeakSight を起動できません。npm を動かせませんでした。', `詳細: ${detail}`],
});

// ---------------------------------------------------------------------------------------------------------------
// 版の比べ（`engines.node` の今の書き方に合わせた最小の比べ。`bootstrap.ps1`・`beaksight.sh` も同じ決まり）
// ---------------------------------------------------------------------------------------------------------------

/** 1 つの比べ（`>=24.22.1`・`<25` など）。省いた版は `>=` と `<` のときだけ読む（ほかでは 0 で埋めた比べが npm の決まりと食い違う）。 */
const COMPARATOR = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u;
/** 今の版（`v24.22.1`）。 */
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/u;

/** 版の数の 3 つ組の比べ（-1・0・1）。 */
const compareParts = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
};

/**
 * `current` が `range` を満たすか。空白で区切った比べの全部を満たせば `SATISFIED`。読めない書き方（`^`・`~`・`||`・`x`・前の版の印など）か、
 * 今の版を読めなければ `UNREADABLE`。
 */
export function checkNodeVersion(range, current) {
  const version = VERSION.exec(current);
  const tokens = range.trim() === '' ? [] : range.trim().split(/\s+/u);
  if (version === null || tokens.length === 0) return 'UNREADABLE';
  const parts = [Number(version[1]), Number(version[2]), Number(version[3])];
  let satisfied = true;
  for (const token of tokens) {
    const match = COMPARATOR.exec(token);
    if (match === null) return 'UNREADABLE';
    const operator = match[1] ?? '=';
    const partial = match[4] === undefined;
    if (partial && operator !== '>=' && operator !== '<') return 'UNREADABLE';
    const order = compareParts(parts, [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)]);
    const ok =
      operator === '>=' ? order >= 0 : operator === '>' ? order > 0 : operator === '<=' ? order <= 0 : operator === '<' ? order < 0 : order === 0;
    satisfied &&= ok;
  }
  return satisfied ? 'SATISFIED' : 'NOT_SATISFIED';
}

// ---------------------------------------------------------------------------------------------------------------
// 依存の用意
// ---------------------------------------------------------------------------------------------------------------

/** SHA-256 の 16 進。 */
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** 記録の読み取り。形が違えば `null`。 */
export function parseInstallRecord(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { lockfileSha256, nodeVersion } = value;
  if (typeof lockfileSha256 !== 'string' || typeof nodeVersion !== 'string') return null;
  return { lockfileSha256, nodeVersion };
}

/** 依存を入れ直すか（理由。入れ直さなければ `null`）。 */
export function dependencyInstallReason({ nodeModulesPresent, record, lockfileSha256, nodeVersion }) {
  if (!nodeModulesPresent) return 'MISSING';
  if (record === null) return 'NO_RECORD';
  if (record.lockfileSha256 !== lockfileSha256) return 'LOCKFILE_CHANGED';
  if (record.nodeVersion !== nodeVersion) return 'NODE_CHANGED';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// npm の動かし方
// ---------------------------------------------------------------------------------------------------------------

/** `npm run ui` の引数（受けた引数は `--` の後にそのまま並べる）。 */
export function buildUiArguments(argv) {
  return argv.length === 0 ? ['run', 'ui'] : ['run', 'ui', '--', ...argv];
}

/** cmd.exe が特別に読む記号。 */
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/gu;

/**
 * cmd.exe で `npm.cmd` に渡す 1 つの引数を逃がす（引用符で囲み、cmd.exe の記号を `^` で逃がす。`npm.cmd` の中でもう 1 度読まれるので 2 重にする）。
 * 値の中の引用符は、その前のバックスラッシュを 2 倍にしてから `\"` にする（C の実行時の引数の読み方）。
 */
export function escapeCmdArgument(value) {
  let quoted = value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, '$1$1');
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META_CHARACTERS, '^$1').replace(CMD_META_CHARACTERS, '^$1');
}

/** npm の動かし方（`command`・`args`・cmd.exe に引数をそのまま渡すか）。 */
export function resolveNpmCommand({ platform, execPath, exists, npmArguments }) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const nodeDirectory = pathApi.dirname(execPath);
  const npmCli =
    platform === 'win32'
      ? pathApi.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : pathApi.join(pathApi.dirname(nodeDirectory), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (exists(npmCli)) {
    return { command: execPath, args: [npmCli, ...npmArguments], windowsVerbatimArguments: false };
  }
  if (platform !== 'win32') {
    return { command: 'npm', args: [...npmArguments], windowsVerbatimArguments: false };
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `"npm.cmd ${npmArguments.map(escapeCmdArgument).join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Chromium の用意
// ---------------------------------------------------------------------------------------------------------------

/**
 * BeakSight が使う Chromium（CLI と画面の監査の `channel: 'chromium'`。`src/browser/chromium-launch.ts` の `CHROMIUM_CHANNEL`）が、今の
 * `node_modules` の Playwright の版のものとして置いてあるか。Playwright の API が返す実行ファイルの path があるかで確かめる。Playwright を
 * 読めなければ `false`。
 */
export function isChromiumInstalled(rootDirectory) {
  try {
    const { chromium } = createRequire(path.join(rootDirectory, 'package.json'))('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** Chromium を入れる引数（`node_modules` の Playwright の CLI。`npx` で別の版を取ってこない。OS の部品を入れる `install-deps` は動かさない）。 */
const chromiumInstallArguments = (rootDirectory) => [path.join(rootDirectory, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'];

// ---------------------------------------------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------------------------------------------

/** 子のプロセスの環境（この Node のフォルダを PATH の先頭に置く）。Windows の PATH の名前の大小は、元の名前のまま使う。 */
const childEnvironment = (env, execPath, platform) => {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];
  const nodeDirectory = pathApi.dirname(execPath);
  return { ...env, [key]: current === undefined || current === '' ? nodeDirectory : `${nodeDirectory}${pathApi.delimiter}${current}` };
};

/** フォルダがあるか。 */
const isDirectory = (target) => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};

/** `package.json` の `engines.node`（読めなければ `null`）。 */
const readEnginesNode = async (rootDirectory) => {
  try {
    const value = JSON.parse(await readFile(path.join(rootDirectory, 'package.json'), 'utf8'));
    const range = value?.engines?.node;
    return typeof range === 'string' ? range : null;
  } catch {
    return null;
  }
};

/** 前に入れたときの記録（なければ `null`）。 */
const readInstallRecord = async (rootDirectory) => {
  try {
    return parseInstallRecord(await readFile(path.join(rootDirectory, INSTALL_RECORD_PATH), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * 入口。終了コードを返す。差し替えの口（テスト用）: 引数、Node の版、root、環境、子のプロセスの起動、出力、シグナルの受け手。
 */
export async function main({
  argv = process.argv.slice(2),
  nodeVersion = process.version,
  rootDirectory = REPOSITORY_ROOT,
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  exists = existsSync,
  spawnChild = spawn,
  chromiumInstalled = isChromiumInstalled,
  print = (line) => console.log(line),
  printError = (line) => console.error(line),
  onSignal = (signal, handler) => process.on(signal, handler),
} = {}) {
  // 1. Node の版。
  const range = await readEnginesNode(rootDirectory);
  const status = range === null ? 'UNREADABLE' : checkNodeVersion(range, nodeVersion);
  if (status === 'NOT_SATISFIED') {
    for (const line of LAUNCHER_TEXT.versionMismatch(range, nodeVersion)) printError(line);
    return LAUNCHER_EXIT_FAILURE;
  }
  if (status === 'UNREADABLE') printError(LAUNCHER_TEXT.versionRangeUnreadable);

  // 子のプロセス。Ctrl+C（SIGINT）などは子に任せ、本体は子の終わりを待つ。本体だけに来た SIGTERM は子へ渡す。
  let current = null;
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGBREAK']) onSignal(signal, () => undefined);
  onSignal('SIGTERM', () => current?.kill('SIGTERM'));
  const childEnv = childEnvironment(env, execPath, platform);
  const runChild = ({ command, args, windowsVerbatimArguments }) =>
    new Promise((resolveRun) => {
      const child = spawnChild(command, args, {
        cwd: rootDirectory,
        env: childEnv,
        stdio: 'inherit',
        shell: false,
        windowsHide: false,
        windowsVerbatimArguments,
      });
      current = child;
      child.once('error', (error) => {
        current = null;
        resolveRun({ code: null, error: error instanceof Error ? error.message : String(error) });
      });
      child.once('exit', (code) => {
        current = null;
        resolveRun({ code, error: null });
      });
    });
  const runNpm = (npmArguments) => runChild(resolveNpmCommand({ platform, execPath, exists, npmArguments }));

  // 2. 依存。
  let lockfileSha256;
  try {
    lockfileSha256 = createHash('sha256').update(await readFile(path.join(rootDirectory, 'package-lock.json'))).digest('hex');
  } catch {
    for (const line of LAUNCHER_TEXT.dependenciesFailed) printError(line);
    return LAUNCHER_EXIT_FAILURE;
  }
  const reason = dependencyInstallReason({
    nodeModulesPresent: isDirectory(path.join(rootDirectory, 'node_modules')),
    record: await readInstallRecord(rootDirectory),
    lockfileSha256,
    nodeVersion,
  });
  if (reason !== null) {
    print(LAUNCHER_TEXT.installingDependencies);
    const installed = await runNpm([...INSTALL_ARGUMENTS]);
    if (installed.code !== 0) {
      for (const line of LAUNCHER_TEXT.dependenciesFailed) printError(line);
      return LAUNCHER_EXIT_FAILURE;
    }
    const recordPath = path.join(rootDirectory, INSTALL_RECORD_PATH);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({ lockfileSha256, nodeVersion }, null, 2)}\n`, 'utf8');
  }

  // 3. Chromium（依存を入れ直した後は、Playwright の版が変わりうるので、いつも確かめる）。
  if (!chromiumInstalled(rootDirectory)) {
    print(LAUNCHER_TEXT.installingChromium);
    const installed = await runChild({ command: execPath, args: chromiumInstallArguments(rootDirectory), windowsVerbatimArguments: false });
    if (installed.code !== 0 || !chromiumInstalled(rootDirectory)) {
      for (const line of LAUNCHER_TEXT.chromiumFailed) printError(line);
      return LAUNCHER_EXIT_FAILURE;
    }
  }

  // 4. 画面。
  const result = await runNpm(buildUiArguments(argv));
  if (result.error !== null) {
    for (const line of LAUNCHER_TEXT.startFailed(result.error)) printError(line);
    return LAUNCHER_EXIT_FAILURE;
  }
  return typeof result.code === 'number' ? result.code : LAUNCHER_EXIT_FAILURE;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}

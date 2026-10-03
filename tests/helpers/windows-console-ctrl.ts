/**
 * Windows で、一時的なビルドの CLI（`<一時ビルド>/dist/cli/index.js`）に、本物の Ctrl+C（コンソールの CTRL_C_EVENT）を送る補助
 * （R7a。中断した Run の再開の設計書 4.10。RR の Critical-1）。`tests/integration/cli-interrupt-windows.test.ts` が使う。
 *
 * 仕組み:
 * - この環境では、ほかのプロセスのコンソールに `AttachConsole` でつなぐことができない（エラー 1341。設計者が確かめた）。そのため、起動用の
 *   PowerShell のスクリプトが、自分のコンソールの中で CLI を子のプロセスとして起動し、合図のファイル（1回目、2回目）が置かれるたびに、
 *   自分のコンソールに `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` を送る。そのコンソールにつながったすべてのプロセス（CLI と、CLI が
 *   起動したコンソールのプログラム）が、その CTRL_C_EVENT を受ける。端末で Ctrl+C を押した場合と同じである。
 * - スクリプトは、CLI を起動した後に、`SetConsoleCtrlHandler(NULL, TRUE)` で、自分だけ Ctrl+C を無視する（起動の前に行うと、子にも無視が
 *   引き継がれる）。起動の前には、`SetConsoleCtrlHandler(NULL, FALSE)` で、親から引き継いだかもしれない無視を外しておく。
 * - PowerShell は、`windowsHide` と、引き継がない標準入出力（`ignore` と `pipe`）で起動する。Node.js は、このとき `CREATE_NO_WINDOW` を
 *   付けるので、PowerShell は、ウィンドウのない自分のコンソールを持つ。テストのプロセスのコンソールとは別なので、CTRL_C_EVENT は、テストの
 *   プロセスにも、利用者の端末にも届かない。`detached` は付けない。付けると、Node.js は `DETACHED_PROCESS` を付け、PowerShell がコンソールを
 *   持たずに起動して、スクリプトが動かない（R7a で確かめた。何も書かずに終了コード 0 で終わる）。
 * - CLI の標準出力と標準エラーは、ファイルに書かせる（`Start-Process` の `-RedirectStandardOutput`・`-RedirectStandardError`。CLI が書いた
 *   バイト列のまま）。CLI の終了コードも、ファイルに書く。テストは、実行中にも、これらのファイルを読み直せる。
 * - Windows PowerShell 5.1 は、BOM のない `.ps1` を、日本語の旧来の文字コードで読む。スクリプトに日本語（コメントを含む）を入れると、改行が
 *   失われ、次の行がコメントに飲み込まれる。そのため、スクリプトの中身は英数字（ASCII）だけにする（書く前に確かめる）。CLI の実行ファイルの
 *   パス、引数、作業のディレクトリは、引用符の扱いの誤りを避けるため、スクリプトに埋め込まず、UTF-8 のファイルから読む。
 * - 上限の時間（`CLI_PROCESS_LIMIT_MS`）を過ぎても終わらない場合と、後片付け（`stop`）では、PowerShell と CLI を、子孫のプロセス
 *   （Chromium）ごと止める（`taskkill /T /F`）。ただし、止めるのは、このテストが起動したものと確かめられたプロセスだけにする
 *   （`stopOwnProcessTree`。RR2 の指摘1。R8）。Windows はプロセスの ID を使い回すので、終わったプロセスの ID で止めると、関係のない
 *   プロセスを、その子孫ごと止める恐れがあるためである。
 *   - CLI: 終了コードのファイルがあれば（CLI はすでに終わっている）、プロセスの ID では何も止めない。なければ、そのプロセスのコマンド行
 *     （Win32_Process の CommandLine）に、一時ビルドの CLI のパスが入っているときだけ止める。
 *   - PowerShell: Node.js が終わりを受けていれば（`exit` の事象）、何も止めない。受けていなければ、コマンド行に、起動用のスクリプトの
 *     パス（テストの一時ディレクトリの中）が入っているときだけ止める。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRecord } from '../../src/core/guards.js';
import { isProcessRunning } from '../../src/orchestration/run-checkpoint.js';
import { CLI_PROCESS_LIMIT_MS, type CliProcessResult } from './cli-process.js';
import type { TemporaryBuild } from './temporary-build.js';

/**
 * スクリプトが合図のファイルを探す間隔と、テストが CLI の出力や送ったことの知らせを読み直す間隔（ms）。合図を置いてから Ctrl+C が届くまでの
 * 遅れを、ページの読み込みの間隔（テストの設定）より十分に短くするための値である。
 */
export const CONSOLE_CTRL_POLL_INTERVAL_MS = 50;

/** 起動の作業のディレクトリの中のファイルの名前（スクリプトとテストが共通に使う。どれも ASCII）。 */
const CONSOLE_CTRL_FILE_NAMES = Object.freeze({
  script: 'console-ctrl.ps1',
  executable: 'executable.txt',
  commandLine: 'command-line.txt',
  workingDirectory: 'working-directory.txt',
  stdout: 'stdout.txt',
  stderr: 'stderr.txt',
  exitCode: 'exit-code.txt',
  cliProcessId: 'cli-process-id.txt',
});

/**
 * n 回目の Ctrl+C の合図（テストが置く）と、送ったことの知らせ（スクリプトが置く）のファイルの名前の形（`ctrl-c-<n>.signal`、
 * `ctrl-c-<n>.sent`）。スクリプトも、この形で名前を組み立てる。
 */
const CTRL_C_FILE_NAME_PARTS = Object.freeze({ prefix: 'ctrl-c-', signal: '.signal', sent: '.sent' });

/** `ordinal` 回目の Ctrl+C の合図のファイルの名前。 */
const signalFileName = (ordinal: number): string => `${CTRL_C_FILE_NAME_PARTS.prefix}${String(ordinal)}${CTRL_C_FILE_NAME_PARTS.signal}`;
/** `ordinal` 回目の Ctrl+C を送ったことの知らせのファイルの名前。 */
const sentFileName = (ordinal: number): string => `${CTRL_C_FILE_NAME_PARTS.prefix}${String(ordinal)}${CTRL_C_FILE_NAME_PARTS.sent}`;

/** ASCII だけの文字列（Windows PowerShell 5.1 が、BOM のない `.ps1` を正しく読める中身）。 */
const ASCII_ONLY = /^[\u0000-\u007F]*$/u;

/**
 * 起動用の PowerShell のスクリプト（ASCII だけ）。`-WorkDirectory` の中の `CONSOLE_CTRL_FILE_NAMES` のファイルを読み書きする。
 * `GenerateConsoleCtrlEvent` の第1引数 0 は CTRL_C_EVENT、第2引数 0 は「このコンソールにつながったすべてのプロセス」である。
 */
const CONSOLE_CTRL_SCRIPT = `param([Parameter(Mandatory = $true)][string]$WorkDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace BeakSightTest -Name ConsoleCtrl -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
'@
$utf8 = New-Object System.Text.UTF8Encoding($false)
function PathOf([string]$name) { return (Join-Path -Path $WorkDirectory -ChildPath $name) }
function ReadText([string]$name) { return [System.IO.File]::ReadAllText((PathOf $name), $utf8) }
function WriteText([string]$name, [string]$text) { [System.IO.File]::WriteAllText((PathOf $name), $text, $utf8) }
function LastError() { return [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
$ctrlCEvent = 0
$allProcessesOfThisConsole = 0
# Let the CLI receive Ctrl+C even if this script inherited an ignored Ctrl+C.
if (-not [BeakSightTest.ConsoleCtrl]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $false)) { throw ('SetConsoleCtrlHandler(NULL, FALSE) failed: ' + (LastError)) }
$process = Start-Process -FilePath (ReadText '${CONSOLE_CTRL_FILE_NAMES.executable}') -ArgumentList (ReadText '${CONSOLE_CTRL_FILE_NAMES.commandLine}') -WorkingDirectory (ReadText '${CONSOLE_CTRL_FILE_NAMES.workingDirectory}') -NoNewWindow -PassThru -RedirectStandardOutput (PathOf '${CONSOLE_CTRL_FILE_NAMES.stdout}') -RedirectStandardError (PathOf '${CONSOLE_CTRL_FILE_NAMES.stderr}')
# Keep the process handle, so that the exit code is still available after the CLI exits.
$processHandle = $process.Handle
WriteText '${CONSOLE_CTRL_FILE_NAMES.cliProcessId}' ([string]$process.Id)
# Ignore Ctrl+C in this script only. The CLI has already started, so it does not inherit this.
if (-not [BeakSightTest.ConsoleCtrl]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true)) { throw ('SetConsoleCtrlHandler(NULL, TRUE) failed: ' + (LastError)) }
$ordinal = 1
while (-not $process.HasExited) {
  if (Test-Path -LiteralPath (PathOf ('${CTRL_C_FILE_NAME_PARTS.prefix}' + $ordinal + '${CTRL_C_FILE_NAME_PARTS.signal}'))) {
    if (-not [BeakSightTest.ConsoleCtrl]::GenerateConsoleCtrlEvent($ctrlCEvent, $allProcessesOfThisConsole)) { throw ('GenerateConsoleCtrlEvent failed: ' + (LastError)) }
    WriteText ('${CTRL_C_FILE_NAME_PARTS.prefix}' + $ordinal + '${CTRL_C_FILE_NAME_PARTS.sent}') ''
    $ordinal += 1
  }
  Start-Sleep -Milliseconds ${String(CONSOLE_CTRL_POLL_INTERVAL_MS)}
}
$process.WaitForExit()
WriteText '${CONSOLE_CTRL_FILE_NAMES.exitCode}' ([string]$process.ExitCode)
`;

/**
 * Windows のコマンド行の1つの引数を、`CommandLineToArgvW` と C の実行時ライブラリの規則で、元の文字列に戻る形に書く。空白も二重引用符も
 * なければ、そのまま。あれば二重引用符で囲み、二重引用符の前の円記号（`\`）を倍にして、二重引用符を `\"` にし、末尾の円記号を倍にする。
 */
function windowsCommandLineArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/u.test(argument)) {
    return argument;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    quoted += character === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/** CLI の結果（`CliProcessResult`。`status` は CLI の終了コード）に、スクリプトの出力と CLI のプロセスの ID を加えたもの。 */
export interface WindowsConsoleCliResult extends CliProcessResult {
  /** PowerShell の標準出力と標準エラー（スクリプトの失敗の確かめのため）。 */
  readonly scriptOutput: string;
  /** PowerShell の終了コード（スクリプトが最後まで動けば 0）。 */
  readonly scriptStatus: number | null;
  /** CLI のプロセスの ID（起動できなかった場合は `null`）。 */
  readonly cliProcessId: number | null;
}

/** 自分のコンソールで動かしている CLI。 */
export interface WindowsConsoleCliRun {
  /**
   * CLI がこれまでに標準出力（`stdout`）または標準エラー（`stderr`）に書いたものが、`isReady` を満たすまで待つ。満たす前にスクリプトが終わった場合（上限の時間で止めた場合を含む）は、
   * 出力を添えて reject する。
   */
  waitForOutput(stream: 'stdout' | 'stderr', isReady: (text: string) => boolean): Promise<void>;
  /** 次の回（1回目、2回目、…）の Ctrl+C の合図を置き、スクリプトが CTRL_C_EVENT を送り終えるまで待つ。 */
  sendCtrlC(): Promise<void>;
  /** スクリプトの終わりを待ち、CLI の結果を返す。 */
  readonly finished: Promise<WindowsConsoleCliResult>;
  /**
   * まだ動いていれば、PowerShell と CLI を、子孫のプロセスごと止め、終わりを待つ（後片付け）。止めるのは、このテストが起動したものと確かめられた
   * プロセスだけ（`stopOwnProcessTree`）。止めたものがあれば真を返す。
   */
  stop(): Promise<boolean>;
}

/** プロセスを、子孫のプロセスごと止める（`taskkill /T /F`）。プロセスがなければ、何もしない。 */
function killProcessTree(processId: number): void {
  spawnSync('taskkill', ['/PID', String(processId), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

/**
 * プロセスのコマンド行を読む PowerShell を待つ上限（ms）。PowerShell の起動と CIM の問い合わせは、ふつう数秒で終わる。上限を超えたら、
 * 読めなかったもの（止めない側）として扱う。
 */
const PROCESS_COMMAND_LINE_TIMEOUT_MS = 30_000;

/**
 * プロセスのコマンド行（Win32_Process の CommandLine）を、PowerShell の CIM で読む（Windows だけ）。プロセスがない場合、読めない場合
 * （権限がない、PowerShell が失敗した、上限の時間を超えた）は `null`。出力は UTF-8 にして読む（一時ディレクトリのパスが日本語を含む場合のため）。
 */
function processCommandLine(processId: number): string | null {
  const command = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$target = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${String(processId)}'`,
    'if ($null -ne $target -and $null -ne $target.CommandLine) { [Console]::Out.Write($target.CommandLine) }',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: PROCESS_COMMAND_LINE_TIMEOUT_MS,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout === '') {
    return null;
  }
  return result.stdout;
}

/** 後片付けで使う、プロセスの操作（RR2 の指摘1。R8）。テストは、偽のものに差し替えて、止めるかどうかの判断を確かめる。 */
export interface WindowsProcessControl {
  /** プロセスが動いているか。 */
  isRunning(processId: number): boolean;
  /** プロセスのコマンド行。プロセスがない場合と、読めない場合は `null`。 */
  commandLineOf(processId: number): string | null;
  /** プロセスを、子孫のプロセスごと止める。 */
  killTree(processId: number): void;
}

/** 本物のプロセスの操作（`isProcessRunning`、Win32_Process のコマンド行、`taskkill /T /F`）。 */
const WINDOWS_PROCESS_CONTROL: WindowsProcessControl = Object.freeze({
  isRunning: isProcessRunning,
  commandLineOf: processCommandLine,
  killTree: killProcessTree,
});

/** `stopOwnProcessTree` に渡す、そのプロセスについて分かっていること。 */
export interface OwnProcessFacts {
  /**
   * そのプロセスが終わったことが分かっているか（CLI は終了コードのファイルがある、PowerShell は Node.js が `exit` の事象を受けた）。
   * 終わったプロセスの ID は、ほかのプロセスに使い回されうるので、真なら何も止めない。
   */
  readonly exited: boolean;
  /** このテストが起動したプロセスのコマンド行に入る部分（一時ビルドの CLI のパス、起動用のスクリプトのパス。どれも一時ディレクトリの中）。 */
  readonly ownCommandLinePart: string;
}

/**
 * 後片付けで、プロセスの ID が `processId` のプロセスを、このテストが起動したものと確かめられたときだけ、子孫のプロセスごと止める
 * （RR2 の指摘1。R8）。止めたら真を返す。
 * - 終わったことが分かっている（`facts.exited`）なら、何も尋ねず、止めない。
 * - 動いていない、コマンド行を読めない、またはコマンド行に `facts.ownCommandLinePart` が入っていない（その ID を、関係のないプロセスが
 *   使っている）なら、止めない。
 */
export function stopOwnProcessTree(
  processId: number,
  facts: OwnProcessFacts,
  control: WindowsProcessControl = WINDOWS_PROCESS_CONTROL,
): boolean {
  if (facts.exited || !control.isRunning(processId)) {
    return false;
  }
  const commandLine = control.commandLineOf(processId);
  if (commandLine === null || !commandLine.includes(facts.ownCommandLinePart)) {
    return false;
  }
  control.killTree(processId);
  return true;
}

/** ファイルを UTF-8 で読む。まだなければ空の文字列。 */
async function readTextIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/**
 * 一時的なビルドの CLI を、自分のコンソールを持つ PowerShell の子のプロセスとして起動する（Windows だけ）。
 * - `directory`: スクリプト、CLI の出力、合図のファイルを置くディレクトリ（なければ作る。テストの一時ディレクトリの中にする）。
 * - `cwd`: CLI の作業のディレクトリ。`arguments`: CLI の引数（`run --config …` など）。
 * - `processControl`: 後片付けで使うプロセスの操作（省略すると本物。テストが、止めるかどうかの判断を確かめるときだけ、偽のものを渡す）。
 */
export async function startCliInWindowsConsole(
  build: TemporaryBuild,
  options: {
    readonly directory: string;
    readonly cwd: string;
    readonly arguments: readonly string[];
    readonly processControl?: WindowsProcessControl;
  },
): Promise<WindowsConsoleCliRun> {
  if (!ASCII_ONLY.test(CONSOLE_CTRL_SCRIPT)) {
    throw new Error('the console Ctrl+C script must be ASCII only for Windows PowerShell 5.1');
  }
  const { directory } = options;
  const processControl = options.processControl ?? WINDOWS_PROCESS_CONTROL;
  const pathOf = (name: string): string => join(directory, name);
  const scriptPath = pathOf(CONSOLE_CTRL_FILE_NAMES.script);
  const cliPath = join(build.distDirectory, 'cli', 'index.js');
  await mkdir(directory, { recursive: true });
  await writeFile(scriptPath, CONSOLE_CTRL_SCRIPT, 'utf8');
  await writeFile(pathOf(CONSOLE_CTRL_FILE_NAMES.executable), process.execPath, 'utf8');
  const commandLine = [cliPath, ...options.arguments].map(windowsCommandLineArgument).join(' ');
  await writeFile(pathOf(CONSOLE_CTRL_FILE_NAMES.commandLine), commandLine, 'utf8');
  await writeFile(pathOf(CONSOLE_CTRL_FILE_NAMES.workingDirectory), options.cwd, 'utf8');

  const startedAt = Date.now();
  const script = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-WorkDirectory', directory],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let scriptOutput = '';
  script.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    scriptOutput += chunk;
  });
  script.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    scriptOutput += chunk;
  });
  let ended = false;
  /** PowerShell のプロセスが終わったことを、Node.js が受けたか（`exit` の事象）。起動できなかった場合は、`script.pid` がないので止めない。 */
  let scriptExited = false;
  script.on('exit', () => {
    scriptExited = true;
  });
  let killedByLimit = false;

  const readCliProcessId = async (): Promise<number | null> => {
    const text = (await readTextIfPresent(pathOf(CONSOLE_CTRL_FILE_NAMES.cliProcessId))).trim();
    return /^\d+$/u.test(text) ? Number(text) : null;
  };
  /**
   * CLI のプロセスを、このテストが起動したものと確かめられたときだけ、子孫のプロセスごと止める（`stopOwnProcessTree`）。終了コードのファイルが
   * あれば（CLI はすでに終わっている）、プロセスの ID では何も止めない。止めたら真。
   */
  const stopCli = async (): Promise<boolean> => {
    const cliProcessId = await readCliProcessId();
    return cliProcessId !== null && stopOwnProcessTree(
      cliProcessId,
      { exited: existsSync(pathOf(CONSOLE_CTRL_FILE_NAMES.exitCode)), ownCommandLinePart: cliPath },
      processControl,
    );
  };
  /** PowerShell と CLI のうち、このテストが起動したものと確かめられた、動いているものを、子孫のプロセスごと止める。止めたものがあれば真。 */
  const killAll = async (): Promise<boolean> => {
    const scriptKilled = script.pid !== undefined
      && stopOwnProcessTree(script.pid, { exited: scriptExited, ownCommandLinePart: scriptPath }, processControl);
    const cliKilled = await stopCli();
    return scriptKilled || cliKilled;
  };

  const timer = setTimeout(() => {
    killedByLimit = true;
    void killAll().catch(() => undefined);
  }, CLI_PROCESS_LIMIT_MS);
  const closed = new Promise<{ readonly status: number | null; readonly signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
    script.on('error', (error) => {
      ended = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    script.on('close', (status, signal) => {
      ended = true;
      clearTimeout(timer);
      resolvePromise({ status, signal });
    });
  });

  const readOutput = async (stream: 'stdout' | 'stderr'): Promise<string> => await readTextIfPresent(pathOf(CONSOLE_CTRL_FILE_NAMES[stream]));

  const finished = (async (): Promise<WindowsConsoleCliResult> => {
    const { status: scriptStatus, signal } = await closed;
    const elapsedMs = Date.now() - startedAt;
    const cliProcessId = await readCliProcessId();
    // スクリプトが途中で失敗した場合は、CLI が残っていれば止める（終了コードは書かれないので、`status` は `null` になる）。終了コードの
    // ファイルがあれば、CLI は終わっているので、何も止めない（`stopCli`）。
    await stopCli();
    const exitCodeText = (await readTextIfPresent(pathOf(CONSOLE_CTRL_FILE_NAMES.exitCode))).trim();
    return {
      status: /^-?\d+$/u.test(exitCodeText) ? Number(exitCodeText) : null,
      signal,
      stdout: await readOutput('stdout'),
      stderr: await readOutput('stderr'),
      elapsedMs,
      killedByLimit,
      scriptOutput,
      scriptStatus,
      cliProcessId,
    };
  })();
  // 待つ側がいない間に reject しても、扱われない reject にしない（`finished` を待つ側は、そのまま reject を受け取る）。
  finished.catch(() => undefined);

  /** `isDone` が真になるまで読み直して待つ。スクリプトが先に終わった場合は、`description` と出力を添えて reject する。 */
  const waitUntil = async (isDone: () => Promise<boolean>, description: string): Promise<void> => {
    for (;;) {
      const wasEnded = ended;
      if (await isDone()) {
        return;
      }
      if (wasEnded) {
        throw new Error([
          `the console Ctrl+C script ended before ${description}`,
          `stdout: ${await readOutput('stdout')}`,
          `stderr: ${await readOutput('stderr')}`,
          `script: ${scriptOutput}`,
        ].join('\n'));
      }
      await sleep(CONSOLE_CTRL_POLL_INTERVAL_MS);
    }
  };

  let sentCtrlC = 0;
  return {
    waitForOutput: async (stream, isReady) => {
      await waitUntil(async () => isReady(await readOutput(stream)), `the expected ${stream} of the CLI`);
    },
    sendCtrlC: async () => {
      sentCtrlC += 1;
      const ordinal = sentCtrlC;
      await writeFile(pathOf(signalFileName(ordinal)), '', 'utf8');
      await waitUntil(async () => existsSync(pathOf(sentFileName(ordinal))), `sending the Ctrl+C ${String(ordinal)}`);
    },
    finished,
    stop: async () => {
      const killed = await killAll();
      await finished.catch(() => undefined);
      return killed;
    },
  };
}

/**
 * テストが起動したプロセスの子孫（Chromium など）を見つけ、終わったことを確かめる補助（T24d。`tests/integration/audit-worker.test.ts`）。
 * - プロセスの一覧は、Windows では `Get-CimInstance Win32_Process`（PowerShell）、ほかの OS では `ps` で、非同期に読む（fixture のサーバが
 *   同じプロセスで応答するので、同期の起動で止めない）。
 * - プロセスは、ID と起動の時刻の組で見分ける（Windows はプロセスの ID を使い回すので、ID だけでは別のプロセスを同じとみなす恐れがある）。
 * - 子孫は、親の PID だけでなく、起動の時刻（親より前に起動していない）と名前（監査で起動する node と Chromium）でも確かめる（DEF-059。
 *   使い回された PID の子として、無関係なプロセスを数えないため）。
 * - 何も止めない（読むだけ）。
 */
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** プロセスの見分け（ID と起動の時刻）。 */
export interface ProcessIdentity {
  readonly processId: number;
  readonly parentProcessId: number;
  readonly name: string;
  /** 起動の時刻（OS が返した文字列のまま。同じプロセスなら同じ値）。 */
  readonly startedAt: string;
}

/** 一覧を読み直す間隔（ms）。 */
const PROCESS_POLL_INTERVAL_MS = 250;
/** 一覧を読むコマンドの上限（ms）。 */
const PROCESS_LIST_LIMIT_MS = 30_000;

const WINDOWS_PROCESS_LIST_SCRIPT = [
  'Get-CimInstance Win32_Process',
  "| Select-Object ProcessId,ParentProcessId,Name,@{ Name = 'StartedAt'; Expression = { $_.CreationDate.ToString('o') } }",
  '| ConvertTo-Json -Compress',
].join(' ');

const run = (file: string, arguments_: readonly string[]): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(file, arguments_, { encoding: 'utf8', timeout: PROCESS_LIST_LIMIT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout);
    });
  });

/** 今のプロセスの一覧。 */
export async function listProcesses(): Promise<readonly ProcessIdentity[]> {
  if (process.platform === 'win32') {
    const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_LIST_SCRIPT]);
    const parsed = JSON.parse(output) as unknown;
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as readonly Record<string, unknown>[];
    return rows.map((row) => ({
      processId: Number(row.ProcessId),
      parentProcessId: Number(row.ParentProcessId),
      name: String(row.Name),
      startedAt: String(row.StartedAt),
    }));
  }
  const output = await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=']);
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/u.exec(line);
    return match === null
      ? []
      : [{ processId: Number(match[1]), parentProcessId: Number(match[2]), startedAt: match[3] ?? '', name: (match[4] ?? '').trim() }];
  });
}

/**
 * 監査で起動するプロセスの実行ファイルの名前（拡張子 `.exe` と、大文字・小文字を除いたもの）。ワーカーと CLI の `node`、Chromium の
 * `chrome`（`channel: 'chromium'`）、`chrome-headless-shell` と `headless_shell`（テストの既定の headless）、Chromium が起動する
 * `chrome_crashpad_handler`（DEF-059）。
 */
export const AUDIT_PROCESS_NAMES: readonly string[] = Object.freeze([
  'node',
  'chrome',
  'chrome-headless-shell',
  'headless_shell',
  'chrome_crashpad_handler',
]);

const AUDIT_PROCESS_NAME_SET: ReadonlySet<string> = new Set(AUDIT_PROCESS_NAMES);

/** 監査で起動するプロセスの名前か（パスと `.exe` を除き、大文字・小文字を区別しない）。 */
export const isAuditProcessName = (name: string): boolean =>
  AUDIT_PROCESS_NAME_SET.has((name.split(/[\\/]/u).at(-1) ?? '').toLowerCase().replace(/\.exe$/u, ''));

/** 起動の時刻（ms）。読めなければ `null`。 */
const startedAtMsOf = (identity: ProcessIdentity): number | null => {
  const milliseconds = Date.parse(identity.startedAt);
  return Number.isFinite(milliseconds) ? milliseconds : null;
};

/**
 * `child` が、`parent` より前に起動していないか（PID の使い回しを除く。DEF-059）。Windows の `ParentProcessId` は、親が終わった後も
 * 残るので、親の PID を後から使い回した無関係なプロセスが、前から動いていたプロセスの「親」に見えることがある。そのような子は、親より前に
 * 起動している。どちらかの時刻を読めないときは、検出を弱めないよう、前でないとみなす（名前の確かめは、そのまま掛かる）。
 */
const startedNoEarlierThan = (child: ProcessIdentity, parent: ProcessIdentity | undefined): boolean => {
  const childMs = startedAtMsOf(child);
  const parentMs = parent === undefined ? null : startedAtMsOf(parent);
  return childMs === null || parentMs === null || childMs >= parentMs;
};

/**
 * `processes` の中の、`rootProcessId` の子孫（子、孫、…。根は含まない）。DEF-059: 子孫と数えるのは、親の PID が一致し、親より前に起動して
 * おらず（PID の使い回しを除く）、名前が監査で起動するもの（`AUDIT_PROCESS_NAMES`）であるものだけ。たどるのも、数えたものの子だけ。
 * 根が `processes` にないときは、根と子の起動の時刻は比べない（名前の確かめは掛かる）。
 */
export function descendantsOf(rootProcessId: number, processes: readonly ProcessIdentity[]): readonly ProcessIdentity[] {
  const found: ProcessIdentity[] = [];
  const root = processes.find((candidate) => candidate.processId === rootProcessId);
  const queue: { readonly processId: number; readonly identity: ProcessIdentity | undefined }[] = [{ processId: rootProcessId, identity: root }];
  const seen = new Set<number>([rootProcessId]);
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) {
      break;
    }
    for (const candidate of processes) {
      if (candidate.parentProcessId === parent.processId
        && !seen.has(candidate.processId)
        && isAuditProcessName(candidate.name)
        && startedNoEarlierThan(candidate, parent.identity)) {
        seen.add(candidate.processId);
        found.push(candidate);
        queue.push({ processId: candidate.processId, identity: candidate });
      }
    }
  }
  return found;
}

const sameProcess = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
  left.processId === right.processId && left.startedAt === right.startedAt;

/** `identities` のうち、まだ動いているもの（ID と起動の時刻が同じプロセスがあるもの）。 */
export async function stillRunning(identities: readonly ProcessIdentity[]): Promise<readonly ProcessIdentity[]> {
  if (identities.length === 0) {
    return [];
  }
  const processes = await listProcesses();
  return identities.filter((identity) => processes.some((candidate) => sameProcess(candidate, identity)));
}

/** `identities` がすべて終わるまで、`limitMs` まで待つ。上限を過ぎても動いているものを返す（すべて終われば空）。 */
export async function waitUntilExited(identities: readonly ProcessIdentity[], limitMs: number): Promise<readonly ProcessIdentity[]> {
  const deadline = Date.now() + limitMs;
  let running = await stillRunning(identities);
  while (running.length > 0 && Date.now() < deadline) {
    await sleep(PROCESS_POLL_INTERVAL_MS);
    running = await stillRunning(running);
  }
  return running;
}

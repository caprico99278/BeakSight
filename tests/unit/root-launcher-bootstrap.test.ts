// LAUNCH-1: 起動ファイルの側の Node の用意（Windows は `tools/launcher/bootstrap.ps1`、macOS・Linux は `beaksight.sh`。設計書
// `doc/design/2026-11-08-beaksight-root-launcher-design.md` 3.3.1・6）の、純粋な部分を確かめる。
// - 版の比べ、`index.json` からの版の選び方、`SHASUMS256.txt` の読み方と SHA-256 の照合、BeakSight 専用の Node の置き場所からの選び方。
// - ネットワークに出ない（`index.json` と `SHASUMS256.txt` は `tests/fixtures/launcher/` の小さな fixture）。スクリプトは、関数を読み込むだけの形
//   （PowerShell は `-LoadOnly`、bash は `source`）で読み、ダウンロードと展開の本体は動かさない。
// - 1 つの言語につき、子のプロセスは 1 回だけ起動する（確かめをまとめて 1 本のスクリプトにする）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../architecture/source-scan.js';

const BOOTSTRAP_PS1 = join(REPOSITORY_ROOT, 'tools', 'launcher', 'bootstrap.ps1');
const BEAKSIGHT_SH = join(REPOSITORY_ROOT, 'beaksight.sh');
const INDEX_FIXTURE = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'launcher', 'index.json');
const SHASUMS_FIXTURE = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'launcher', 'SHASUMS256.txt');

/** 今の `package.json` の `engines.node`。 */
const ENGINES_NODE = '>=24.22.1 <25';

/** 版の比べの例（`start.mjs` の単体のテストと同じ決まり）。 */
const VERSION_CASES: readonly (readonly [range: string, version: string, expected: string])[] = [
  [ENGINES_NODE, 'v24.22.1', 'SATISFIED'],
  [ENGINES_NODE, 'v24.30.2', 'SATISFIED'],
  [ENGINES_NODE, 'v24.22.0', 'NOT_SATISFIED'],
  [ENGINES_NODE, 'v24.9.9', 'NOT_SATISFIED'],
  [ENGINES_NODE, 'v25.0.0', 'NOT_SATISFIED'],
  [ENGINES_NODE, 'v20.0.0', 'NOT_SATISFIED'],
  ['>24.22.1', 'v24.22.2', 'SATISFIED'],
  ['<=24.22.1', 'v24.22.1', 'SATISFIED'],
  ['=24.22.1', 'v24.22.2', 'NOT_SATISFIED'],
  ['>=24', 'v24.0.0', 'SATISFIED'],
  ['^24.22.1', 'v24.22.1', 'UNREADABLE'],
  ['>=24 || >=26', 'v24.22.1', 'UNREADABLE'],
  ['>24.22', 'v24.22.1', 'UNREADABLE'],
  ['', 'v24.22.1', 'UNREADABLE'],
  [ENGINES_NODE, 'unknown', 'UNREADABLE'],
];

/** 版の選び方の例（fixture の index.json。24.31.0 には Windows の zip がない）。 */
const RELEASE_CASES: readonly (readonly [fileKey: string, range: string, expected: string])[] = [
  ['win-x64-zip', ENGINES_NODE, '24.30.2'],
  ['linux-x64', ENGINES_NODE, '24.31.0'],
  ['osx-arm64-tar', ENGINES_NODE, '24.31.0'],
  ['win-x64-zip', '>=26', ''],
];

/** SHASUMS256.txt の読み方の例（名前の完全な一致だけ）。 */
const SHASUMS_CASES: readonly (readonly [fileName: string, expected: string])[] = [
  ['node-v24.30.2-win-x64.zip', '3'.repeat(64)],
  ['node-v24.30.2-linux-x64.tar.gz', '2'.repeat(64)],
  ['node-v24.30.2-win-x64', ''],
  ['node-v24.31.0-win-x64.zip', ''],
];

/** 照合に使う偽の配布物の中身。 */
const ARCHIVE_TEXT = 'fake archive\n';
const ARCHIVE_SHA256 = createHash('sha256').update(ARCHIVE_TEXT).digest('hex');

/** 期待する出力の行（言語によらず同じ）。 */
const expectedLines = (): readonly string[] => [
  ...VERSION_CASES.map(([, , expected]) => expected),
  ...RELEASE_CASES.map(([, , expected]) => expected),
  ...SHASUMS_CASES.map(([, expected]) => expected),
  'True',
  'False',
  'node-v24.30.2',
];

let work = '';
let archivePath = '';
let runtimeDirectory = '';

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'beaksight-launcher-bootstrap-'));
  archivePath = join(work, 'archive.bin');
  await writeFile(archivePath, ARCHIVE_TEXT, 'utf8');
  runtimeDirectory = join(work, 'runtime');
  // 置き場所の中: 範囲の中で node のあるもの（24.30.2。Windows と Unix の両方の形）、範囲の外（24.22.0）、node のないもの（24.31.0）。
  for (const name of ['node-v24.30.2', 'node-v24.22.0']) {
    for (const [suffix, file] of [['-win-x64', 'node.exe'], ['-linux-x64', join('bin', 'node')]] as const) {
      const directory = join(runtimeDirectory, `${name}${suffix}`);
      await mkdir(join(directory, 'bin'), { recursive: true });
      await writeFile(join(directory, file), '', 'utf8');
    }
  }
  await mkdir(join(runtimeDirectory, 'node-v24.31.0-win-x64'), { recursive: true });
  await mkdir(join(runtimeDirectory, 'node-v24.31.0-linux-x64', 'bin'), { recursive: true });
});

afterAll(async () => {
  if (work !== '') await rm(work, { recursive: true, force: true });
});

/** PowerShell の 1 つの引用符の文字列。 */
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
/** bash の 1 つの引用符の文字列。 */
const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
/** bash へ渡すパス（区切りを / にする。Git for Windows の bash も読める）。 */
const shPath = (path: string): string => shQuote(path.replaceAll('\\', '/'));

/** Windows の PowerShell（5.1）。 */
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : '';

/** bash（Windows では Git for Windows の bash。WSL の bash は使わない）。 */
const BASH = (() => {
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : '';
  const candidate = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  return existsSync(candidate) ? candidate : '';
})();

describe.runIf(POWERSHELL !== '')('bootstrap.ps1 の純粋な部分（Windows）', () => {
  it('版の比べ・版の選び方・SHASUMS256.txt の読み方・SHA-256 の照合・置き場所からの選び方', async () => {
    const lines = [
      `. ${psQuote(BOOTSTRAP_PS1)} -LoadOnly`,
      ...VERSION_CASES.map(([range, version]) => `Get-NodeVersionStatus -Range ${psQuote(range)} -Version ${psQuote(version)}`),
      `$index = [System.IO.File]::ReadAllText(${psQuote(INDEX_FIXTURE)})`,
      ...RELEASE_CASES.map(([fileKey, range]) => `Select-NodeRelease -IndexJson $index -FileKey ${psQuote(fileKey)} -Range ${psQuote(range)}`),
      `$sums = [System.IO.File]::ReadAllText(${psQuote(SHASUMS_FIXTURE)})`,
      ...SHASUMS_CASES.map(([fileName]) => `Get-ExpectedSha256 -ShasumsText $sums -FileName ${psQuote(fileName)}`),
      `Test-FileSha256 -Path ${psQuote(archivePath)} -Expected ${psQuote(ARCHIVE_SHA256.toUpperCase())}`,
      `Test-FileSha256 -Path ${psQuote(archivePath)} -Expected ${psQuote('0'.repeat(64))}`,
      `Split-Path -Leaf (Get-LocalNodeDirectory -RuntimeDirectory ${psQuote(runtimeDirectory)} -Range ${psQuote(ENGINES_NODE)})`,
    ];
    const script = join(work, 'check.ps1');
    // Windows PowerShell 5.1 は BOM のない .ps1 を ANSI として読むので、BOM を付ける。
    await writeFile(script, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
    const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    expect(result.stderr).toBe('');
    // 空の結果（''）も 1 行として出す（`Write-Output ''`）。末尾の改行だけを除く。
    const output = result.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
    expect(output.map((line) => line.replace(/-win-x64$/u, ''))).toEqual(expectedLines());
    expect(result.status).toBe(0);
  });
});

describe.runIf(BASH !== '')('beaksight.sh の純粋な部分（macOS・Linux。Windows では Git for Windows の bash）', () => {
  it('版の比べ・版の選び方・SHASUMS256.txt の読み方・SHA-256 の照合・置き場所からの選び方', async () => {
    const lines = [
      `source ${shPath(BEAKSIGHT_SH)}`,
      ...VERSION_CASES.map(([range, version]) => `node_version_status ${shQuote(range)} ${shQuote(version)}`),
      ...RELEASE_CASES.map(([fileKey, range]) => `echo "$(select_node_release ${shPath(INDEX_FIXTURE)} ${shQuote(fileKey)} ${shQuote(range)})"`),
      ...SHASUMS_CASES.map(([fileName]) => `echo "$(expected_sha256 ${shPath(SHASUMS_FIXTURE)} ${shQuote(fileName)})"`),
      `if file_sha256_matches ${shPath(archivePath)} ${shQuote(ARCHIVE_SHA256.toUpperCase())}; then echo True; else echo False; fi`,
      `if file_sha256_matches ${shPath(archivePath)} ${shQuote('0'.repeat(64))}; then echo True; else echo False; fi`,
      `basename "$(local_node_directory ${shPath(runtimeDirectory)} ${shQuote(ENGINES_NODE)} linux x64)"`,
    ];
    const script = join(work, 'check.sh');
    await writeFile(script, `${lines.join('\n')}\n`, 'utf8');
    const result = spawnSync(BASH, [script.replaceAll('\\', '/')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    expect(result.stderr).toBe('');
    const output = result.stdout.replace(/\n$/u, '').split('\n');
    expect(output.map((line) => line.replace(/-linux-x64$/u, ''))).toEqual(expectedLines());
    expect(result.status).toBe(0);
  });
});

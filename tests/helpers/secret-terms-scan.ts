// Git に載せない語の検査（`tools/secret-terms/scan.mjs`・`.claude/hooks/block-secret-terms.mjs`）のテストの共通の補助。
// 語は架空のものだけを使う（本物の一覧 `local/secret-terms.txt` は読まない）。
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** リポジトリの root。 */
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 共通の検査の部品。 */
export const SCAN_SCRIPT = join(REPOSITORY_ROOT, 'tools', 'secret-terms', 'scan.mjs');
/** Claude Code の書く前のフック。 */
export const CLAUDE_HOOK_SCRIPT = join(REPOSITORY_ROOT, '.claude', 'hooks', 'block-secret-terms.mjs');
/** 一覧の場所を変える環境変数の名前（`scan.mjs` の `SECRET_TERMS_FILE_ENV` と同じ）。 */
export const SECRET_TERMS_FILE_ENV = 'BEAKSIGHT_SECRET_TERMS_FILE';

/** 架空の語（一覧には大文字と小文字を混ぜて書く）。 */
export const FAKE_ASCII_TERM = 'ZzForbiddenZz';
export const FAKE_JAPANESE_TERM = '禁止の語の例';
/** 架空の語の、一覧の中の行の番号（BOM・注釈・空の行・前後の空白・CRLF を含む一覧）。 */
export const FAKE_ASCII_TERM_LINE = 3;
export const FAKE_JAPANESE_TERM_LINE = 5;

/** BOM・注釈の行・空の行・前後の空白・CRLF を含む、架空の一覧の中身。 */
export const FAKE_LIST_CONTENT = `﻿# 架空の一覧（テスト用）\r\n\r\n  ${FAKE_ASCII_TERM}  \r\n   \r\n${FAKE_JAPANESE_TERM}\r\n# ${'zz注釈の中の語zz'}\r\n`;
/** 注釈の行にだけある語（当たってはいけない）。 */
export const FAKE_COMMENT_ONLY_TERM = 'zz注釈の中の語zz';

/** 一時のフォルダ。 */
export async function createWorkDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `beaksight-secret-terms-${prefix}-`));
}

export async function removeWorkDirectory(directory: string): Promise<void> {
  if (directory !== '') await rm(directory, { recursive: true, force: true });
}

/** 架空の一覧を書いて、その path を返す。 */
export async function writeFakeList(directory: string): Promise<string> {
  const path = join(directory, 'fake-secret-terms.txt');
  await writeFile(path, FAKE_LIST_CONTENT, 'utf8');
  return path;
}

/** 利用者の Git の設定（global・system）を読まない環境。 */
export function isolatedEnvironment(listPath: string, emptyConfigPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [SECRET_TERMS_FILE_ENV]: listPath,
    GIT_CONFIG_GLOBAL: emptyConfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** node で部品やフックを流す。 */
export function runNode(
  script: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input ?? '',
    encoding: 'utf8',
    windowsHide: true,
  });
}

/** 一時のリポジトリで git を流す（失敗したら例外）。 */
export function runGit(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** 出力に架空の語そのもの（大文字と小文字を問わない）が出ていないこと。 */
export function containsFakeTerm(output: string): boolean {
  const lower = output.toLowerCase();
  return [FAKE_ASCII_TERM, FAKE_JAPANESE_TERM, FAKE_COMMENT_ONLY_TERM].some((term) => lower.includes(term.toLowerCase()));
}

/** `importCommits` の 1 つのコミット（中身が null のファイルは消す）。 */
export interface ImportedCommit {
  readonly message: string;
  readonly files: Readonly<Record<string, string | Buffer | null>>;
}

/**
 * 一時のリポジトリの `main` に、コミットを順に作る（`git fast-import` の 1 回。git を何回も起動しないため）。作ったコミットの sha を順に返す。
 * 作業ツリーと index は変えない。
 */
export function importCommits(cwd: string, env: NodeJS.ProcessEnv, marksPath: string, commits: readonly ImportedCommit[]): string[] {
  const parts: Buffer[] = [];
  const text = (value: string) => parts.push(Buffer.from(value, 'utf8'));
  const data = (value: string | Buffer) => {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    text(`data ${bytes.length}\n`);
    parts.push(bytes);
    text('\n');
  };
  commits.forEach((commit, index) => {
    text(`commit refs/heads/main\nmark :${index + 1}\ncommitter test <test@example.invalid> ${1_700_000_000 + index} +0000\n`);
    data(commit.message);
    for (const [path, content] of Object.entries(commit.files)) {
      if (content === null) {
        text(`D ${path}\n`);
      } else {
        text(`M 100644 inline ${path}\n`);
        data(content);
      }
    }
    text('\n');
  });
  const result = spawnSync('git', ['fast-import', '--quiet', `--export-marks=${marksPath}`], {
    cwd,
    env,
    input: Buffer.concat(parts),
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git fast-import failed: ${result.stderr.toString('utf8')}`);
  const marks = new Map(
    readFileSync(marksPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' ') as [string, string]),
  );
  return commits.map((_, index) => marks.get(`:${index + 1}`) ?? '');
}

/** Claude Code のフックの判定。 */
export interface ClaudeHookDecision {
  readonly denied: boolean;
  readonly reason: string;
  /** フックの標準出力と標準エラーの全部（語が出ていないことの確かめに使う）。 */
  readonly raw: string;
}

/** Claude Code の書く前のフックを、このリポジトリを作業の場所として流す（ファイルは書かない）。 */
export function runClaudeHook(env: NodeJS.ProcessEnv, toolName: string, toolInput: Record<string, unknown>): ClaudeHookDecision {
  const result = runNode(CLAUDE_HOOK_SCRIPT, [], {
    cwd: REPOSITORY_ROOT,
    env,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: REPOSITORY_ROOT, tool_name: toolName, tool_input: toolInput }),
  });
  if (result.status !== 0) throw new Error(`hook failed: ${result.stderr}`);
  const raw = result.stdout + result.stderr;
  if (result.stdout === '') return { denied: false, reason: '', raw };
  const output = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return {
    denied: output.hookSpecificOutput.permissionDecision === 'deny',
    reason: output.hookSpecificOutput.permissionDecisionReason,
    raw,
  };
}

/** Git に載る（無視されない）が、まだないファイルの path（フックは書かないので、作られない）。 */
export const HOOK_PROBE_TRACKED_PATH = join(REPOSITORY_ROOT, 'doc', 'spec', 'zz-secret-terms-hook-probe.md');

#!/usr/bin/env node
// Git に載せない語（伏せる語の一覧）の検査の共通の部品。3 つの検査（Git の pre-commit・pre-push と、Claude Code の書く前のフック）が使う。
// Node の標準だけを使う（依存を足さない）。
//
// 一覧: 既定は `<リポジトリ>/local/secret-terms.txt`（`local/` は Git の外）。環境変数 `BEAKSIGHT_SECRET_TERMS_FILE` で変えられる。
//   1 行に 1 語。`#` で始まる行と空の行は飛ばす。前後の空白は取る。大文字と小文字は区別しない、ただの部分一致（正規表現ではない）。
//   UTF-8（BOM があってもよい）、改行は CRLF か LF。
//   一覧がないときは、何も止めずに標準エラーに 1 行の注意を出して通す（クラウドやほかの PC の clone には一覧がないため）。
//
// 当たったときは、ファイルの path・行の番号・当たった語の番号（一覧の何行目か）だけを出す。語そのものは出さない（端末やログに残さないため）。
//
// 使い方（当たれば終了コード 1、当たらなければ 0。Git の失敗などで調べられなければ 2）:
//   node tools/secret-terms/scan.mjs --staged                 コミットする中身（index の、追加・変更されたファイル）を調べる
//   node tools/secret-terms/scan.mjs --push <local> <remote>  push で送るコミット（<remote>..<local>）で変わったファイルの中身を調べる
//   node tools/secret-terms/scan.mjs --text <path>            標準入力の文字列を調べる（<path> は表示だけに使う）

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 一覧の場所を変える環境変数の名前（テスト用）。 */
export const SECRET_TERMS_FILE_ENV = 'BEAKSIGHT_SECRET_TERMS_FILE';

/** このファイルのあるリポジトリの root（`tools/secret-terms/` の 2 つ上）。 */
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 出力の頭に付ける名前。 */
const LABEL = 'secret-terms';

/** バイナリとみなす目安（Git と同じく、先頭のこのバイト数の中に NUL があればバイナリ）。 */
const BINARY_SNIFF_BYTES = 8000;

/** Git の出力を受ける上限。 */
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;

/** 中身を調べない Git の mode（submodule）。 */
const GITLINK_MODE = '160000';

/** 一覧の path（環境変数があればそれ、なければ既定の場所）。 */
export function secretTermsFilePath(env = process.env) {
  const fromEnv = env[SECRET_TERMS_FILE_ENV];
  return typeof fromEnv === 'string' && fromEnv !== '' ? resolve(fromEnv) : resolve(REPOSITORY_ROOT, 'local', 'secret-terms.txt');
}

/**
 * 一覧を読む。ないときは null。
 * @returns {{ path: string, terms: { number: number, lower: string }[] } | null}
 */
export function loadSecretTerms(path = secretTermsFilePath()) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return null;
    }
    throw error;
  }
  const terms = [];
  stripBom(raw)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const term = line.trim();
      if (term === '' || term.startsWith('#')) return;
      terms.push({ number: index + 1, lower: term.toLowerCase() });
    });
  return { path, terms };
}

/** 一覧がないときの 1 行の注意。 */
export function missingListNotice(path) {
  return `${LABEL}: 伏せる語の一覧（${path}）がないため、調べずに通します。`;
}

/**
 * 文字列の中の当たりを探す。
 * @returns {{ line: number, termNumbers: number[] }[]} 行（1 から）ごとの、当たった語の番号（一覧の行の番号）
 */
export function findSecretTermHits(text, terms) {
  if (terms.length === 0) return [];
  const hits = [];
  stripBom(text)
    .split('\n')
    .forEach((line, index) => {
      const lower = line.toLowerCase();
      const termNumbers = terms.filter((term) => lower.includes(term.lower)).map((term) => term.number);
      if (termNumbers.length > 0) hits.push({ line: index + 1, termNumbers });
    });
  return hits;
}

/** 当たりの 1 件の表示（語そのものは出さない）。 */
export function formatHit(displayPath, hit) {
  const numbers = hit.termNumbers.map((number) => `${number} 行目`).join('・');
  return `${LABEL}: ${displayPath}:${hit.line}: 伏せる語の一覧の ${numbers}の語が含まれています`;
}

/** 当たったときの締めの案内。 */
export const FIX_GUIDANCE =
  'Git に載せない語です。一般の形（登録の画面、/rest/v1/<x> など）で書き直してください（語の中身は local/secret-terms.txt で確かめます）。';

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

class GitError extends Error {}

function git(args, input) {
  const result = spawnSync('git', args, {
    input,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error) throw new GitError(`git ${args[0]} を起動できませんでした: ${result.error.message}`);
  if (result.status !== 0) {
    throw new GitError(`git ${args[0]} が失敗しました（終了コード ${result.status}）: ${result.stderr.toString('utf8').trim()}`);
  }
  return result.stdout;
}

function gitSucceeds(args) {
  const result = spawnSync('git', args, { windowsHide: true, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/**
 * `--raw -z --no-abbrev` の出力から、追加・変更されたファイルの blob を取り出す。
 * 生の項目（`:` で始まる。頭の改行は除く）の次の区切りが path。それ以外の区切り（`git log --format=%H` の commit の id）は、続く項目の commit として扱う。
 * @returns {{ blob: string, path: string, commit: string | null }[]}
 */
function parseRawEntries(output) {
  const tokens = output.toString('utf8').split('\0');
  const entries = [];
  let commit = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = (tokens[index] ?? '').replace(/^\n+/, '');
    if (token === '') continue;
    if (token.startsWith(':')) {
      const path = tokens[index + 1] ?? '';
      index += 1;
      const [, newMode, , newBlob, status] = token.slice(1).split(' ');
      if (newMode === GITLINK_MODE || newBlob === undefined || /^0+$/.test(newBlob) || (status ?? '').startsWith('D')) continue;
      entries.push({ blob: newBlob, path, commit });
    } else {
      commit = token.trim();
    }
  }
  return entries;
}

/** blob の中身をまとめて読む（`git cat-file --batch` の 1 回）。 */
function readBlobs(blobs) {
  const unique = [...new Set(blobs)];
  const contents = new Map();
  if (unique.length === 0) return contents;
  const output = git(['cat-file', '--batch'], `${unique.join('\n')}\n`);
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) break;
    const header = output.subarray(offset, headerEnd).toString('utf8');
    offset = headerEnd + 1;
    const [sha, type, sizeText] = header.split(' ');
    if (type === 'missing' || sizeText === undefined || sha === undefined) continue;
    const size = Number(sizeText);
    contents.set(sha, output.subarray(offset, offset + size));
    offset += size + 1;
  }
  return contents;
}

/** blob の一覧を調べ、当たりの表示を返す。 */
function scanEntries(entries, terms, describe) {
  const contents = readBlobs(entries.map((entry) => entry.blob));
  const lines = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.blob}\0${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const content = contents.get(entry.blob);
    if (content === undefined || isBinary(content)) continue;
    for (const hit of findSecretTermHits(content.toString('utf8'), terms)) {
      lines.push(formatHit(describe(entry), hit));
    }
  }
  return lines;
}

/** a. コミットする中身を調べる。 */
function scanStaged(terms) {
  const output = git(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--diff-filter=ACMRT']);
  return scanEntries(parseRawEntries(output), terms, (entry) => entry.path);
}

/** b. push で送るコミットを調べる（`git log` の 1 回で、送るコミットごとに変わったファイルを得る）。 */
function scanPush(localSha, remoteSha, terms) {
  if (/^0+$/.test(localSha)) return [];
  const log = (range) =>
    git(['log', '--no-color', '--format=%H', '--raw', '-z', '--no-abbrev', '--root', '-m', '--no-renames', '--diff-filter=ACMRT', ...range]);
  let output;
  if (/^0+$/.test(remoteSha)) {
    // リモートの sha が全部 0（新しいブランチ）なら、そのコミットからたどれる全部を調べる。
    output = log([localSha]);
  } else {
    try {
      output = log([localSha, '--not', remoteSha]);
    } catch (error) {
      // リモートのコミットが手元にない（取り込んでいない）ときも、たどれる全部を調べる。
      if (!(error instanceof GitError) || gitSucceeds(['cat-file', '-e', `${remoteSha}^{commit}`])) throw error;
      output = log([localSha]);
    }
  }
  return scanEntries(parseRawEntries(output), terms, (entry) =>
    entry.commit === null ? entry.path : `${entry.path}（コミット ${entry.commit.slice(0, 12)}）`,
  );
}

/** c. 文字列を調べる（Claude Code のフックも import して使う）。 */
export function scanText(text, displayPath, terms) {
  return findSecretTermHits(text, terms).map((hit) => formatHit(displayPath, hit));
}

function usage() {
  return `${LABEL}: 使い方: --staged | --push <local> <remote> | --text <path>`;
}

/** 入口。終了コードを返す。 */
export function main(argv, { stdinText = () => readFileSync(0, 'utf8'), stderr = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const [mode, ...rest] = argv;
  if (mode !== '--staged' && mode !== '--push' && mode !== '--text') {
    stderr(usage());
    return 2;
  }
  if ((mode === '--push' && rest.length !== 2) || (mode === '--text' && rest.length !== 1)) {
    stderr(usage());
    return 2;
  }
  const list = loadSecretTerms();
  if (list === null) {
    stderr(missingListNotice(secretTermsFilePath()));
    return 0;
  }
  let lines;
  try {
    if (mode === '--staged') lines = scanStaged(list.terms);
    else if (mode === '--push') lines = scanPush(rest[0], rest[1], list.terms);
    else lines = scanText(stdinText(), rest[0], list.terms);
  } catch (error) {
    if (error instanceof GitError) {
      stderr(`${LABEL}: 調べられませんでした。${error.message}`);
      return 2;
    }
    throw error;
  }
  if (lines.length === 0) return 0;
  for (const line of lines) stderr(line);
  stderr(`${LABEL}: ${FIX_GUIDANCE}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

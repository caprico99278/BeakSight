/**
 * リポジトリ直下の起動ファイルの Gate（LAUNCH-1。設計書 `doc/design/2026-11-08-beaksight-root-launcher-design.md` 3・6）。
 * - `BeakSight.cmd`（Windows）: 自分の置き場所（`%~dp0`）へ移り、Node の用意（`tools/launcher/bootstrap.ps1`）を呼び、本体
 *   （`tools/launcher/start.mjs`）を 1 か所で呼んで引数（`%*`）を渡す。終わったらキーを押すまで待つ（`pause`）。改行は CRLF、文字は ASCII だけ
 *   （cmd.exe は ANSI の文字コードで読むため）。
 * - `tools/launcher/bootstrap.ps1`: 取ってくる先は nodejs.org（https）だけ。SHA-256 を `SHASUMS256.txt` と照合する。置き場所は `local/runtime/`。
 *   PC 全体の環境変数（PATH）を変えない。改行は CRLF、UTF-8 の BOM つき（Windows PowerShell 5.1 は BOM のない .ps1 を ANSI として読むため）。
 * - `beaksight.sh`（macOS・Linux）: 自分の置き場所へ移り、本体を 1 か所で呼んで引数（`"$@"`）を渡す。Node の用意は bootstrap.ps1 と同じ決まり。
 *   改行は LF。
 * - 判定は `fs` と文字列・正規表現の検索だけ（ブラウザや子のプロセスを起動しない）。1 ファイル 1 秒以内（CPU の時間）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_GATE_MS, REPOSITORY_ROOT, startCpuStopwatch } from './source-scan.js';

/** 見るファイル（リポジトリの根からのパス）。 */
const CMD_PATH = 'BeakSight.cmd';
const PS1_PATH = 'tools/launcher/bootstrap.ps1';
const SH_PATH = 'beaksight.sh';
const START_PATH = 'tools/launcher/start.mjs';

/** UTF-8 の BOM。 */
const UTF8_BOM = '﻿';

/** ファイルを、改行を変えずに読む。 */
const readRaw = (path: string): string => readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

/** CR を伴わない LF の数。 */
const bareLineFeeds = (text: string): number => [...text.matchAll(/(?<!\r)\n/gu)].length;
/** CR の数。 */
const carriageReturns = (text: string): number => [...text.matchAll(/\r/gu)].length;
/** 本文の中の URL（`http://`・`https://` で始まるもの）。 */
const urlsIn = (text: string): readonly string[] => [...text.matchAll(/https?:\/\/[^\s'"`)]+/gu)].map((match) => match[0]);
/** 注釈の行（cmd の `rem`・`::`、PowerShell と bash の `#`）を除いた本文。 */
const withoutCommentLines = (text: string, pattern: RegExp): string =>
  text.split(/\r?\n/u).filter((line) => !pattern.test(line.trim())).join('\n');
/** 正規表現に当たる数。 */
const countOf = (text: string, pattern: RegExp): number => [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].length;

const stopwatch = startCpuStopwatch();
const CMD = readRaw(CMD_PATH);
const PS1 = readRaw(PS1_PATH);
const SH = readRaw(SH_PATH);
const START = readRaw(START_PATH);
const CMD_BODY = withoutCommentLines(CMD, /^(?:rem\b|::)/iu);
const PS1_BODY = withoutCommentLines(PS1, /^#/u);
const SH_BODY = withoutCommentLines(SH, /^#/u);
const START_BODY = withoutCommentLines(START, /^(?:\/\/|\/\*|\*)/u);

describe('Gate: the root launcher files (LAUNCH-1)', () => {
  it('BeakSight.cmd: CRLF, ASCII only', () => {
    expect(bareLineFeeds(CMD)).toBe(0);
    expect(carriageReturns(CMD)).toBeGreaterThan(0);
    expect(/^[\t\r\n\x20-\x7e]*$/u.test(CMD)).toBe(true);
  });

  it('BeakSight.cmd: moves to its own folder, prepares Node, calls the launcher once with all arguments, then waits', () => {
    expect(CMD_BODY).toMatch(/^@echo off$/imu);
    expect(CMD_BODY).toMatch(/^pushd "%~dp0"/imu);
    // Node の用意は PowerShell のスクリプト（この process だけの実行の決まりで動かす）。
    expect(CMD_BODY).toMatch(/powershell(?:\.exe)? -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "tools\\launcher\\bootstrap\.ps1"/iu);
    // 本体を呼ぶ行は 1 つだけで、受けた引数をすべて渡す。
    expect(countOf(CMD_BODY, /tools\\launcher\\start\.mjs/iu)).toBe(1);
    expect(CMD_BODY).toMatch(/"tools\\launcher\\start\.mjs" %\*$/imu);
    // 終了コードが 0（管理画面のブラウザを閉じて止まったときなど）なら待たずに閉じ、0 でないときだけキーを押すまで待つ。
    expect(CMD_BODY).toMatch(/^if not "%BEAKSIGHT_EXIT%"=="0" pause$/imu);
    expect(CMD_BODY).not.toMatch(/^pause\b/imu);
    expect(CMD_BODY).toMatch(/^exit \/b %BEAKSIGHT_EXIT%$/imu);
    // PC 全体の PATH を変えない。
    expect(CMD_BODY).not.toMatch(/\bsetx\b/iu);
  });

  it('bootstrap.ps1: CRLF with a UTF-8 BOM, a load-only switch', () => {
    expect(PS1.startsWith(UTF8_BOM)).toBe(true);
    expect(bareLineFeeds(PS1)).toBe(0);
    expect(PS1_BODY).toMatch(/\[switch\]\$LoadOnly/u);
  });

  it('bootstrap.ps1: downloads only from nodejs.org over https, checks SHA-256, keeps Node under local/runtime, does not change PATH for the PC', () => {
    const urls = urlsIn(PS1_BODY);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => !url.startsWith('https://nodejs.org/'))).toEqual([]);
    expect(PS1_BODY).toContain('SHASUMS256.txt');
    expect(PS1_BODY).toMatch(/Get-FileHash -Algorithm SHA256/u);
    expect(PS1_BODY).toMatch(/'local'.*'runtime'|local\\runtime/u);
    expect(PS1_BODY).not.toMatch(/SetEnvironmentVariable|\bsetx\b|HKCU:|HKLM:/iu);
  });

  it('beaksight.sh: LF, bash, moves to its own folder, calls the launcher once with all arguments', () => {
    expect(carriageReturns(SH)).toBe(0);
    expect(SH.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(SH_BODY).toMatch(/cd -- "\$\(dirname -- "\$\{BASH_SOURCE\[0\]\}"\)"/u);
    expect(countOf(SH_BODY, /tools\/launcher\/start\.mjs/u)).toBe(1);
    expect(SH_BODY).toMatch(/exec "\$node_directory\/node" tools\/launcher\/start\.mjs "\$@"/u);
    // source で読んだときは、関数を読むだけ（起動しない）。
    expect(SH_BODY).toMatch(/if \[ "\$\{BASH_SOURCE\[0\]\}" = "\$0" \]; then/u);
  });

  it('beaksight.sh: downloads only from nodejs.org over https, checks SHA-256, keeps Node under local/runtime, does not change the shell settings', () => {
    const urls = urlsIn(SH_BODY);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => !url.startsWith('https://nodejs.org/'))).toEqual([]);
    expect(SH_BODY).toMatch(/curl [^\n]*--proto '=https'/u);
    expect(SH_BODY).toContain('SHASUMS256.txt');
    expect(SH_BODY).toMatch(/sha256sum/u);
    expect(SH_BODY).toMatch(/shasum -a 256/u);
    expect(SH_BODY).toContain('local/runtime');
    expect(SH_BODY).not.toMatch(/\.bashrc|\.zshrc|\.profile|\/etc\//u);
  });

  it('start.mjs: installs with npm ci --ignore-scripts and keeps the record under local/runtime', () => {
    expect(START).toMatch(/'ci', '--ignore-scripts'/u);
    expect(START).toMatch(/'local', 'runtime'/u);
    expect(urlsIn(START)).toEqual([]);
  });

  it('start.mjs: prepares Chromium with the Playwright of node_modules (not npx), never install-deps', () => {
    expect(START).toMatch(/'node_modules', 'playwright', 'cli\.js'/u);
    expect(START).toMatch(/'install', 'chromium'/u);
    expect(START).toMatch(/chromium\.executablePath\(\)/u);
    // 注釈の行は除く（「npx を使わない」「install-deps は動かさない」の説明がある）。手で入れる方法の文の npx だけを許す。
    expect(START_BODY).not.toMatch(/install-deps|\bnpx\b(?! playwright install chromium)/u);
  });

  it('runs within the time limit', () => {
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});

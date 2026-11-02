/**
 * DEF-146: 画面のサーバが終わったときの記録のファイル（`local-data/logs/ui-server.log`。Git の外）を書く部品（`src/control/ui-server-log.ts`）を確かめる。
 * - 1 行に 1 つの JSON（時刻、終わり方、例外の名前と文、スタックは 20 行まで、動いていたジョブの数。ワーカーの終わり方）。
 * - 値（画面のサーバの token・Cookie・URL の query の値・userinfo・秘密に見える名前の値）は書かない。URL は core の伏せ字の部品を通す。
 * - ファイルの大きさの上限を超えるときは、古い行を捨てる。書けなくても投げない。
 * - 終わりの記録（予期しない例外・止める決まり）がなければ、process の終わりを 1 行書く。
 * ファイルは一時のフォルダの中だけ（本物の `local-data/` は読まない・書かない）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTROL_DATA_DIRECTORY_NAME, resolveUiServerLogPath } from '../../src/control/store/database-path.js';
import {
  UI_SERVER_END_REASONS,
  UI_SERVER_LOG_MAX_BYTES,
  UI_SERVER_LOG_MAX_STACK_LINES,
  createUiServerLog,
  redactUiServerLogText,
  unexpectedErrorRecordOf,
  type UiServerLogFiles,
} from '../../src/control/ui-server-log.js';

/**
 * テストの読み書き（一時のフォルダの中だけ。本番の読み書きは画面のサーバの部品 `apps/local-ui/src/server/ui-server-log-file.ts` が渡し、
 * `apps/local-ui/tests/ui-close.test.ts` が端から端で確かめる）。
 */
const TEST_FILES: UiServerLogFiles = Object.freeze({
  sizeOf: (target: string): number => (existsSync(target) ? statSync(target).size : 0),
  read: (target: string): string => readFileSync(target, 'utf8'),
  append: (target: string, text: string): void => {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, text, 'utf8');
  },
  replace: (target: string, text: string): void => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
  },
});

const NOW = new Date(Date.UTC(2026, 9, 21, 1, 56, 11));
/** 値の目印（記録のファイルに出てはいけない）。 */
const MARKS = Object.freeze({
  sessionToken: 'MARKSESSIONTOKEN0000000000000001',
  queryToken: 'MARK_QUERY_TOKEN_2',
  queryValue: 'MARK_QUERY_VALUE_3',
  fragment: 'MARK_FRAGMENT_4',
  cookie: 'MARK_COOKIE_5',
  password: 'MARK_PASSWORD_6',
  userinfo: 'MARK_USERINFO_7',
  authorization: 'MARK_AUTHORIZATION_8',
});
const MARK_PATTERN = /MARK/u;

let directory = '';
let path = '';

const readLines = (): readonly Record<string, unknown>[] =>
  readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);

/** 値の目印を、いろいろな形で含む誤り（文とスタック）。 */
const markedError = (): Error => {
  const error = new TypeError([
    `fetch failed: http://127.0.0.1:4317/jobs?token=${MARKS.queryToken}&q=${MARKS.queryValue}#state=${MARKS.fragment}`,
    `Cookie: beaksight_session=${MARKS.cookie}`,
    `the session ${MARKS.sessionToken} and password=${MARKS.password}`,
    `proxy http://user:${MARKS.userinfo}@127.0.0.1:9/x`,
    `Authorization: Bearer ${MARKS.authorization}`,
  ].join('\n'));
  error.stack = [
    `TypeError: fetch failed http://127.0.0.1:4317/?token=${MARKS.queryToken}`,
    ...Array.from({ length: 40 }, (_, index) => `    at frame${index} (file:///x.js:${index}:1) ${MARKS.sessionToken}`),
  ].join('\n');
  return error;
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'beaksight-ui-server-log-'));
  path = resolveUiServerLogPath(directory);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('DEF-146: the record of the end of the screen server', () => {
  it('puts the file under local-data/logs', () => {
    expect(path).toBe(join(directory, CONTROL_DATA_DIRECTORY_NAME, 'logs', 'ui-server.log'));
    expect(UI_SERVER_LOG_MAX_BYTES).toBe(1024 * 1024);
    expect(UI_SERVER_LOG_MAX_STACK_LINES).toBe(20);
  });

  it('writes the unexpected error with the time, the origin, the name, the message, at most 20 lines of the stack, and the running jobs', () => {
    const log = createUiServerLog({ path, files: TEST_FILES, secrets: () => [MARKS.sessionToken], now: () => NOW });
    log.write(unexpectedErrorRecordOf('uncaughtException', markedError(), 1));
    const [line] = readLines();
    expect(line).toMatchObject({ at: NOW.toISOString(), kind: 'UNEXPECTED_ERROR', origin: 'uncaughtException', errorName: 'TypeError', runningJobs: 1 });
    expect(line?.['message']).toContain('fetch failed');
    expect(line?.['stack']).toHaveLength(UI_SERVER_LOG_MAX_STACK_LINES);
  });

  it('never writes the values (token, cookie, query values, fragment, userinfo, secret-like names, the session token)', () => {
    const log = createUiServerLog({ path, files: TEST_FILES, secrets: () => [MARKS.sessionToken], now: () => NOW });
    log.write(unexpectedErrorRecordOf('unhandledRejection', markedError(), 2));
    log.write(unexpectedErrorRecordOf('unhandledRejection', `rejected with ${MARKS.sessionToken} http://127.0.0.1:4317/?q=${MARKS.queryValue}`, 0));
    log.write(unexpectedErrorRecordOf('uncaughtException', { reason: MARKS.password }, 0));
    const text = readFileSync(path, 'utf8');
    expect(text).not.toMatch(MARK_PATTERN);
    // 名前と、URL の形（Origin と path）は残る。
    expect(text).toContain('http://127.0.0.1:4317/jobs?token=[REDACTED]&q=[REDACTED]');
    // 秘密に見える header の名前の後は、行の終わりまで伏せる（Cookie の名前も伏せる）。
    expect(text).toContain('Cookie: [REDACTED]');
    expect(text).toContain('password=[REDACTED]');
    for (const value of Object.values(MARKS)) {
      expect(redactUiServerLogText(`x ${value} y`, [MARKS.sessionToken]).includes(MARKS.sessionToken)).toBe(false);
    }
  });

  it('writes the planned end and the end of a worker that exited before its result', () => {
    const log = createUiServerLog({ path, files: TEST_FILES, now: () => NOW });
    log.write({ kind: 'SHUTDOWN', reason: 'UI_CLOSED', immediate: false, runningJobs: 0 });
    log.write({ kind: 'WORKER_EXITED', jobId: 'job-1', jobKind: 'DISCOVERY', exitCode: null, signal: 'SIGKILL' });
    expect(readLines()).toEqual([
      { at: NOW.toISOString(), kind: 'SHUTDOWN', reason: 'UI_CLOSED', immediate: false, runningJobs: 0 },
      { at: NOW.toISOString(), kind: 'WORKER_EXITED', jobId: 'job-1', jobKind: 'DISCOVERY', exitCode: null, signal: 'SIGKILL' },
    ]);
  });

  it('writes the end of the process only when no end was recorded', () => {
    const planned = createUiServerLog({ path, files: TEST_FILES, now: () => NOW });
    planned.write({ kind: 'SHUTDOWN', reason: 'CTRL_C', immediate: false, runningJobs: 1 });
    planned.recordExit(0, 0);
    expect(readLines().map((line) => line['kind'])).toEqual(['SHUTDOWN']);
    const other = createUiServerLog({ path, files: TEST_FILES, now: () => NOW });
    other.write({ kind: 'WORKER_EXITED', jobId: 'job-2', jobKind: 'AUDIT', exitCode: 3, signal: null });
    other.recordExit(7, 1);
    expect(readLines().at(-1)).toEqual({ at: NOW.toISOString(), kind: 'EXIT', exitCode: 7, runningJobs: 1 });
  });

  it('drops the old lines to stay within the size limit, and keeps the newest', () => {
    const maxBytes = 4_000;
    const log = createUiServerLog({ path, files: TEST_FILES, now: () => NOW, maxBytes });
    for (let index = 0; index < 200; index += 1) {
      log.write({ kind: 'WORKER_EXITED', jobId: `job-${index}`, jobKind: 'AUDIT', exitCode: index, signal: null });
      expect(statSync(path).size).toBeLessThanOrEqual(maxBytes);
    }
    const lines = readLines();
    expect(lines.at(-1)).toMatchObject({ jobId: 'job-199' });
    expect(lines.some((line) => line['jobId'] === 'job-0')).toBe(false);
  });

  // OP-P（P3）: 起動の行を書き、起動のときに、前の起動の終わりの記録がなければ、そのことを理由のコードだけで 1 行書く（強制の終わりなど、process が記録の前に
  // 消えた終わりも、次の起動で残る）。止める決まりを受けたことは、終わりの処理の前に 1 行書く（終わりの記録には数えない）。
  it('writes the start, and tells at the start that the previous run ended without an end record (OP-P)', () => {
    const later = new Date(NOW.getTime() + 60_000);
    const first = createUiServerLog({ path, files: TEST_FILES, now: () => NOW });
    first.recordStart();
    expect(readLines()).toEqual([{ at: NOW.toISOString(), kind: 'START' }]);
    // 前の起動は、終わりの記録のないまま消えた（ワーカーの終わりは、終わりの記録ではない）。
    first.write({ kind: 'WORKER_EXITED', jobId: 'job-1', jobKind: 'AUDIT', exitCode: 0, signal: null });
    const second = createUiServerLog({ path, files: TEST_FILES, now: () => later });
    second.recordStart();
    expect(readLines().slice(-2)).toEqual([
      { at: later.toISOString(), kind: 'PREVIOUS_END_UNRECORDED', previousStartedAt: NOW.toISOString() },
      { at: later.toISOString(), kind: 'START' },
    ]);
    // 止める決まりの受け付けと終わりの記録があれば、次の起動では書かない。
    second.write({ kind: 'STOP_REQUESTED', reason: 'UI_SILENT', runningJobs: 0 });
    second.write({ kind: 'SHUTDOWN', reason: 'UI_SILENT', immediate: false, runningJobs: 0 });
    const third = createUiServerLog({ path, files: TEST_FILES, now: () => later });
    third.recordStart();
    expect(readLines().slice(-3).map((line) => line['kind'])).toEqual(['STOP_REQUESTED', 'SHUTDOWN', 'START']);
    // 止める決まりの受け付けは、終わりの記録に数えない（終わりの記録がなければ、process の終わりを書く）。
    third.write({ kind: 'STOP_REQUESTED', reason: 'CONSOLE_CLOSED', runningJobs: 1 });
    third.recordExit(0, 0);
    expect(readLines().slice(-2).map((line) => line['kind'])).toEqual(['STOP_REQUESTED', 'EXIT']);
    // 終わりの理由の閉じた一覧（画面の心拍の途絶え、コンソールを閉じた、Ctrl+Break）。
    expect(UI_SERVER_END_REASONS).toEqual(['CTRL_C', 'SIGTERM', 'UI_CLOSED', 'UI_SILENT', 'CONSOLE_CLOSED', 'CTRL_BREAK', 'OTHER']);
  });

  it('writes the start even when the previous file cannot be read, and does not throw (OP-P)', () => {
    mkdirSync(path, { recursive: true });
    const log = createUiServerLog({ path, files: TEST_FILES, now: () => NOW });
    expect(() => log.recordStart()).not.toThrow();
  });

  it('does not throw when the file cannot be written', () => {
    mkdirSync(path, { recursive: true });
    const log = createUiServerLog({ path, files: TEST_FILES, now: () => NOW });
    expect(() => log.write({ kind: 'SHUTDOWN', reason: 'OTHER', immediate: true, runningJobs: 0 })).not.toThrow();
    expect(() => log.recordExit(1, 0)).not.toThrow();
  });
});

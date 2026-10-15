// テストの補助 `tests/helpers/process-tree.ts` の子孫の判定の単体テスト（DEF-059）。プロセスの一覧は、作った値だけを使う（OS を読まない）。
// - 使い回された PID の子（親より前に起動した）を数えない。名前が監査で起動するもの（node、Chromium）でないものを数えない。
// - 本物の子孫（3 段）は、今までどおり数える。
import { describe, expect, it } from 'vitest';
import { AUDIT_PROCESS_NAMES, descendantsOf, isAuditProcessName, type ProcessIdentity } from '../helpers/process-tree.js';

/** 起動の時刻（Windows の `CreationDate` の `ToString('o')` と同じ形）。 */
const at = (seconds: number): string => `2026-10-09T12:00:${String(seconds).padStart(2, '0')}.1234567+09:00`;

const processOf = (processId: number, parentProcessId: number, name: string, startedAt: string): ProcessIdentity =>
  Object.freeze({ processId, parentProcessId, name, startedAt });

const ROOT = processOf(100, 1, 'node.exe', at(10));
const WORKER = processOf(200, 100, 'node.exe', at(11));
const BROWSER = processOf(300, 200, 'chrome.exe', at(12));
const RENDERER = processOf(400, 300, 'chrome.exe', at(13));
const CRASHPAD = processOf(410, 300, 'chrome_crashpad_handler.exe', at(13));

const idsOf = (identities: readonly ProcessIdentity[]): readonly number[] => identities.map((identity) => identity.processId).sort();

describe('descendantsOf (DEF-059)', () => {
  it('counts the real descendants over three levels (the worker, Chromium and its children)', () => {
    const processes = [ROOT, WORKER, BROWSER, RENDERER, CRASHPAD, processOf(999, 1, 'explorer.exe', at(1))];
    expect(idsOf(descendantsOf(ROOT.processId, processes))).toEqual([200, 300, 400, 410]);
  });

  it('does not count a child of a reused PID (the child started before its parent)', () => {
    // 前から動いていたプロセスの親の PID（200）を、後から起動したワーカーが使い回した。
    const oldNode = processOf(500, 200, 'node.exe', at(5));
    const oneDrive = processOf(510, 200, 'OneDrive.Sync.Service.exe', at(5));
    const processes = [ROOT, WORKER, BROWSER, oldNode, oneDrive, processOf(520, 500, 'chrome.exe', at(6))];
    expect(idsOf(descendantsOf(ROOT.processId, processes))).toEqual([200, 300]);
  });

  it('does not count a process whose name is not one that the audit starts, nor follow its children', () => {
    const conhost = processOf(600, 200, 'conhost.exe', at(12));
    const other = processOf(610, 200, 'OneDrive.Sync.Service.exe', at(20));
    const underOther = processOf(620, 610, 'chrome.exe', at(21));
    const processes = [ROOT, WORKER, BROWSER, conhost, other, underOther];
    expect(idsOf(descendantsOf(ROOT.processId, processes))).toEqual([200, 300]);
  });

  it('accepts the same start time as the parent, and keeps counting when a start time cannot be read', () => {
    const sameTime = processOf(700, 200, 'chrome-headless-shell.exe', at(11));
    const unreadable = processOf(710, 200, 'node.exe', 'not a time');
    expect(idsOf(descendantsOf(ROOT.processId, [ROOT, WORKER, sameTime, unreadable]))).toEqual([200, 700, 710]);
  });

  it('checks the names case-insensitively, with or without .exe and a path', () => {
    for (const name of ['node.exe', 'NODE.EXE', 'node', 'chrome.exe', 'Chrome.exe', 'chrome-headless-shell.exe', 'headless_shell.exe',
      'chrome_crashpad_handler.exe', 'C:\\Program Files\\nodejs\\node.exe', '/usr/bin/chrome']) {
      expect(isAuditProcessName(name), name).toBe(true);
    }
    for (const name of ['OneDrive.Sync.Service.exe', 'conhost.exe', 'nodemon.exe', 'chrome.exe.bak', 'msedge.exe', '']) {
      expect(isAuditProcessName(name), name).toBe(false);
    }
    expect(Object.isFrozen(AUDIT_PROCESS_NAMES)).toBe(true);
  });
});

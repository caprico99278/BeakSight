// DBG-1（設計書 `2026-11-20-beaksight-discovery-skip-and-debug-timing-design.md` 2.2）: 測りのための記録の共通部品（`src/core/debug-timing.ts`）。
// - 切: ファイルを作らず、時計も呼ばず、記録の関数は何もしない（測る処理の値はそのまま返す）。
// - 入: Run のフォルダの 1 つのファイルに、まとめて書く（flush のたびに足す）。画面の印は ID の形だけを書き、URL の query の値などは書かない。
// - 入切は設定ファイル（`local/debug-settings.json`。テストでは場所を渡す）の 1 か所。ない・壊れた・`true` でないときは切。
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEBUG_TIMING_FILE_NAME, createDebugTimingLog, debugTimingSwitchOf } from '../../src/core/debug-timing.js';

describe('DBG-1: the debug timing log', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'beaksight-debug-timing-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('does nothing when off: no file, no clock, and the measured work keeps its value', async () => {
    const log = createDebugTimingLog({ enabled: false, directory, now: () => { throw new Error('the clock is read while off'); } });
    expect(await log.measure('PRESS', () => ({ stateId: 'sha256:aa' }), async () => 7)).toBe(7);
    log.record(() => ({ point: 'DISCOVERY_PAGE', stateId: 'sha256:aa' }));
    await log.flush();
    expect(await readdir(directory)).toEqual([]);
  });

  it('writes the lines to one file at each flush when on, without the value of a query', async () => {
    let nowMs = 0;
    const log = createDebugTimingLog({ enabled: true, directory, now: () => nowMs });
    await log.measure('PRESS', () => ({ stateId: 'sha256:aa' }), async () => { nowMs += 30; });
    log.record(() => ({ point: 'REREAD', stateId: '/list?token=secret-value', ms: 5 }));
    expect(await readdir(directory)).toEqual([]);
    await log.flush();
    log.record(() => ({ point: 'DISCOVERY_PAGE', pageId: 'PAGE-000001', counts: { loads: 2 } }));
    await log.flush();
    const text = await readFile(join(directory, DEBUG_TIMING_FILE_NAME), 'utf8');
    expect(text).not.toContain('secret-value');
    expect(text.trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
      { point: 'PRESS', stateId: 'sha256:aa', ms: 30 },
      { point: 'REREAD', ms: 5 },
      { point: 'DISCOVERY_PAGE', pageId: 'PAGE-000001', counts: { loads: 2 } },
    ]);
  });

  it('is on only when the settings file says debugTiming is true (no file, broken JSON and false are off)', async () => {
    const settings = join(directory, 'debug-settings.json');
    expect(await debugTimingSwitchOf(settings)).toBe(false);
    await writeFile(settings, JSON.stringify({ debugTiming: true }), 'utf8');
    expect(await debugTimingSwitchOf(settings)).toBe(true);
    await writeFile(settings, '{ "debugTiming": tru', 'utf8');
    expect(await debugTimingSwitchOf(settings)).toBe(false);
    await writeFile(settings, JSON.stringify({ debugTiming: false }), 'utf8');
    expect(await debugTimingSwitchOf(settings)).toBe(false);
  });
});

// SLIM（設計書 `doc/design/2026-11-25-beaksight-discovery-input-check-slim-design.md` 2.1・2.3・3）: 本物の発見の流れ（`executeDiscoveryRun`）で、form の外の
// 番号だけ違う欄の表の画面を 1 画面だけ読む。既定の Chromium と PASS_EXCEPT_DELETE。調査の場面を小さくした fixture（行の数は少なくしてよい）。
// - 表の形: 入力の確かめは行 1 つ分だけ（文字の欄も select も）。名前の違う欄は、まとめずに全部。代表に入れると読み取りが出る表は、全部を確かめる。
// - 測りの記録が入なら、押した後の反応・入力の確かめ・準備の確かめの行を書き、URL・値を書かない。切なら記録を書かない。安全: 読み取りでない要求はサーバに届かない。
import { describe, expect, it } from 'vitest';
import type { DebugTimingEntry } from '../../src/core/debug-timing.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { runDiscoveryOnPlainSite, type PlainSiteRun } from '../helpers/plain-discovery-site-run.js';

const PAGE_PATH = '/bulk';
const ROWS = 5;
const MANY = 6;

const save = '<button type="button" id="save">保存</button><script>document.getElementById("save").addEventListener("click", () => {'
  + "fetch('/api/rows', { method: 'POST', body: '{}' }).catch(() => {}); });</script>";
const rows = (cells: (row: number) => string): string => `<table>${Array.from({ length: ROWS }, (_, row) => `<tr>${cells(row)}</tr>`).join('')}</table>`;
const text = (name: string): string => `<td><input type="text" name="${name}"></td>`;

const SCENES = Object.freeze({
  rowsLone: rows((row) => text(`rows[${String(row)}].name`) + text(`rows[${String(row)}].qty`) + text(`rows[${String(row)}].note`)),
  rowsSelect: rows((row) => `${text(`rows[${String(row)}].name`)}<td><select name="rows[${String(row)}].kind">`
    + `${['', 'a', 'b', 'c', 'd'].map((value) => `<option value="${value}">${value || '選ぶ'}</option>`).join('')}</select></td>`),
  manyFields: Array.from({ length: MANY }, (_, at) => `<label>項目${'abcdef'.charAt(at)} <input type="text" name="f_${'abcdef'.charAt(at)}"></label>`).join(''),
  // 入れると、その値で読み取り（検索）が出る表。
  rowsSearch: `${rows((row) => text(`rows[${String(row)}].name`))}<script>document.addEventListener('input', (event) => {`
    + "fetch('/api/search?q=' + encodeURIComponent(event.target.value)).catch(() => {}); }, true);</script>",
} as const);
type Scene = keyof typeof SCENES;

const pageOf = (body: string): string => '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>一括</title><link rel="icon" href="data:,"></head>'
  + `<body><main><h1>一括登録</h1>${body}${save}</main></body></html>`;

const runOf = (scene: Scene, debugTiming = true): Promise<PlainSiteRun> => runDiscoveryOnPlainSite(() => launchHeadlessChromium(),
  (path) => (path === PAGE_PATH ? pageOf(SCENES[scene]) : null), PAGE_PATH, 1, `job-slim-${scene.toLowerCase()}`, { sendPolicy: 'PASS_EXCEPT_DELETE' },
  undefined, undefined, debugTiming);

const linesOf = (run: PlainSiteRun, point: DebugTimingEntry['point']): readonly DebugTimingEntry[] => (run.debugLines ?? []).filter((line) => line.point === point);
/** 入力の確かめの行（`part` ごとに足した数）。 */
const inputChecksOf = (run: PlainSiteRun, part: 'TYPE' | 'SURVEY'): Record<string, number> => {
  const sum: Record<string, number> = {};
  for (const line of linesOf(run, 'DISCOVERY_INPUT_CHECK').filter((entry) => entry.part === part)) {
    for (const [name, value] of Object.entries(line.counts ?? {})) sum[name] = (sum[name] ?? 0) + value;
  }
  return sum;
};
const nonReadsOf = (run: PlainSiteRun): readonly unknown[] => run.seen.filter(({ method }) => !READ_METHODS.has(method));

describe('SLIM: the input checks of same-shaped fields that differ only by a number (the default test Chromium, PASS_EXCEPT_DELETE)', () => {
  it('checks one row of a table outside a form, every field of differing names, and every row when the representative made a read', async () => {
    const lone = await runOf('rowsLone');
    expect(inputChecksOf(lone, 'TYPE')).toMatchObject({ fields: ROWS * 3, checked: 3, skippedSibling: (ROWS - 1) * 3 });
    expect(nonReadsOf(lone)).toEqual([]);

    const select = await runOf('rowsSelect');
    expect(inputChecksOf(select, 'TYPE')).toMatchObject({ checked: 1, skippedSibling: ROWS - 1 });
    expect(inputChecksOf(select, 'SURVEY')).toMatchObject({ fields: ROWS, checked: 1, skippedSibling: ROWS - 1 });
    expect(nonReadsOf(select)).toEqual([]);

    const many = await runOf('manyFields');
    expect(inputChecksOf(many, 'TYPE')).toMatchObject({ fields: MANY, checked: MANY, skippedSibling: 0 });

    const search = await runOf('rowsSearch');
    expect(inputChecksOf(search, 'TYPE')).toMatchObject({ fields: ROWS, checked: ROWS, skippedSibling: 0 });
    expect(search.seen.filter(({ path }) => path === '/api/search').length).toBeGreaterThanOrEqual(ROWS);
    expect(nonReadsOf(search)).toEqual([]);
  });

  it('writes the press reaction, input check and readiness lines without a URL or a value when the timing record is on, and nothing when it is off', async () => {
    const on = await runOf('rowsSelect');
    const reactions = linesOf(on, 'DISCOVERY_PRESS_REACTION');
    expect(reactions.length).toBeGreaterThan(0);
    for (const line of reactions) {
      expect(line.part).toMatch(/^(REQUEST|DOM|NAVIGATION|NONE):(PRESS|TYPE|REPLAY):(REPRESENTATIVE|SIBLING|SINGLE)$/u);
      expect(['firstMs', 'minimumMs', 'siblings', 'windowMs'].every((name) => typeof line.counts?.[name] === 'number')).toBe(true);
    }
    expect(reactions.some(({ part }) => part?.endsWith(':PRESS:SINGLE') === true)).toBe(true);
    expect(reactions.some(({ part }) => part?.endsWith(':TYPE:REPRESENTATIVE') === true)).toBe(true);
    expect(new Set(linesOf(on, 'DISCOVERY_INPUT_CHECK').map(({ part }) => part))).toEqual(new Set(['TYPE', 'SURVEY']));
    expect(linesOf(on, 'DISCOVERY_READINESS').length).toBeGreaterThan(0);
    expect(JSON.stringify(on.debugLines)).not.toMatch(/127\.0\.0\.1|bulk|rows|kind/u);
    expect((await runOf('manyFields', false)).debugLines).toBeNull();
  });
});

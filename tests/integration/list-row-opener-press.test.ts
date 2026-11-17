// LU-3（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 5.5 の 2・3、4.0 の D3・D4）: 作った行を一覧から探す読み取り
// （`src/discovery/read-executor.ts` の `findListRowsContainingValue`）と、行の中の開き手を押す部品（`src/browser/api-write-submitter.ts` の
// `pressListRowOpener`）を、本物の Chromium（テストの既定。LU-SFIX2-A・LU-SFIX3-A の漏れの場面だけ、CLI の起動の設定でも）と、仮の一覧の画面
// （`fixtures/list-row-press-site.ts`）で確かめる。
// - 読み取り: 値を含む行が 0・1・2 のとき、それぞれ数が合い、1 のときだけ行の参照が返る。表（`tbody tr`）と `ul li` の両方。`nav` の中と見出しの行は数えない。
//   LU-SFIX2-A（LU-SREV2 の Minor-3）: 行の中のセルの文字が値と同じか、値が語の区切りで現れる行だけを数える（`item-2@example.com` は `item-21@example.com`
//   の行に当たらない）。
// - 押下: 行の中の、識別の digest が同じで名前のある開き手がちょうど 1 つなら押す（文字・`aria-label`・`title`）。名前のないアイコンだけは `OPENER_UNNAMED`、
//   同じ識別が 2 つは `OPENER_NOT_FOUND`、削除の語は `OPENER_DELETE_LIKE`（押さない）。押した後に窓（`<dialog open>` か `role="dialog"`）が開く。
// - LU-SFIX2-A（LU-SREV2 の Critical-1・Important-2）: 行の「編集」を名前のないアイコン（押すと `POST` を送る）とタイマーで入れ替え続ける画面で、
//   `SWAP_PRESS_TRIALS` 回押しても、偽物の送信はサーバに 0 件（全部の回の後に名前つきの時間だけ待って数え直す）。押さなかった回（止める経路）が 1 回以上あり、
//   押した回はどれも本物を押した。サーバの記録で数える。
// - LU-SFIX3-A（LU-SREV3 の Critical-1・Minor-2）: 同じ要素のまま、中身（`content`）か `aria-label`（`attr`）を、名前のあるときと名前のないアイコンだけの
//   ときとでタイマーで書き換え続ける画面で、形ごとに `REWRITE_PRESS_TRIALS` 回押しても、名前のないときの送信はサーバに 0 件。押す時点の確かめで止めた回が
//   1 回以上あり、押した回はどれも名前のあるときを押した。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LIST_ROW_PRESS_BOUNDARY_VALUES,
  LIST_ROW_PRESS_OPENER_ROWS,
  LIST_ROW_PRESS_PATHS,
  LIST_ROW_PRESS_REWRITE_EVERY_FRAME,
  LIST_ROW_PRESS_STILL_QUERY,
  LIST_ROW_PRESS_VALUES,
  LIST_ROW_PRESS_WORDS,
  startListRowPressSite,
  type ListRowPressSite,
} from '../../fixtures/list-row-press-site.js';
import { LIST_ROW_OPENER_PRESS_RESULTS, pressListRowOpener } from '../../src/browser/api-write-submitter.js';
import { ensureElementPathEngine } from '../../src/browser/element-path-engine.js';
import { probedCandidateIdentityDigestOf } from '../../src/discovery/discover-page.js';
import { locationOfUrl, probePageCandidates, type ProbedCandidate } from '../../src/discovery/probe.js';
import { findListRowsContainingValue, readPageStructure, type ListRowReference } from '../../src/discovery/read-executor.js';
import { wait as sleep } from '../../src/core/deadline.js';
import { BOTH_CHROMIUM_LAUNCHERS, closeTestContexts, ONCE_CHROMIUM_LABEL } from '../helpers/chromium.js';

/**
 * TEST-SLIM D2（TEST-POLICY の 3）: 2 つの Chromium で流すのは、確かめと押す間に入れ替わった名前のないアイコンの送信がサーバに届かないことの場面
 * （LU-SFIX2-A・LU-SFIX3-A）だけ。ほかの場面（行の読み取りと押す結果）は、既定の Chromium だけで流す。
 */
const DEFAULT_LABEL = ONCE_CHROMIUM_LABEL;
const TEST_TIMEOUT_MS = 60_000;
const SWAP_TEST_TIMEOUT_MS = 180_000;
const READ_TIMEOUT_MS = 10_000;
/**
 * LU-SFIX2-A: 入れ替えの画面で押す回の数。SLIM BD-3（INV-BUDGET の 5-2）: 前は LU-SREV2 の再現と同じ 25 回。1 回の中で本物が見えるまで押し直す
 * （`SWAP_MAX_PRESSES_PER_TRIAL`）ので、どの回も入れ替えの窓（`LIST_ROW_PRESS_SWAP_MS` の本物と偽物の 2 つの長さ）の中で押しにかかる。回の数は、窓の
 * 構造を何度か通る数にした（押す時点の確かめの判定は単体）。
 */
const SWAP_PRESS_TRIALS = 10;
/** LU-SFIX2-A: 1 回の中で、probe が本物の開き手を読むまで押し直す上限（本物が見えるのは短い間だけ。`OPENER_NOT_FOUND` のときだけ押し直す）。 */
const SWAP_MAX_PRESSES_PER_TRIAL = 60;
/** LU-SFIX2-A: 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const SWAP_LATE_DELIVERY_SETTLE_MS = 1_000;
/** LU-SFIX3-A: 書き換えの画面の形ごとに押す回の数。SLIM BD-3（5-2）: 前は LU-SREV3 の再現と同じ 15 回。止めた回は 6 つの形の全部で数える。 */
const REWRITE_PRESS_TRIALS = 6;
/** LU-SFIX3-A: 書き換えの形と間隔（`ms`。LU-SREV3 の再現の content 10/30/100・rAF と attr 10・rAF）。 */
const REWRITE_SCENES: readonly (readonly ['content' | 'attr', string])[] = [
  ['content', '10'], ['content', '30'], ['content', '100'], ['content', LIST_ROW_PRESS_REWRITE_EVERY_FRAME],
  ['attr', '10'], ['attr', LIST_ROW_PRESS_REWRITE_EVERY_FRAME],
];
/** LU-SFIX3-A: 押せない結果のとき（probe が名前のないときを読んだ）に、1 回の中で押し直す上限。 */
const REWRITE_MAX_PRESSES_PER_TRIAL = 20;
/**
 * L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2）: 押す部品の 1 歩の長さ（`pressListRowOpener` の `timeoutMs`）。本番の既定は L0 の反応なしの
 * 長さ（`API_WRITE_STEP_TIMEOUT_MS` = 3 分）にしたので、書き換え続ける画面で押す操作が外れた要素を待つと、1 回で 3 分かかる。多くの回を押すこのテストは、
 * 前の長さ（10 秒）を注入する（`writeStageWatchOf` と同じ考え方。押す・止める決まりと回の数は変えない）。
 */
const PRESS_STEP_LIMIT_MS = 10_000;

let site: ListRowPressSite;

beforeAll(async () => {
  site = await startListRowPressSite();
  await ensureElementPathEngine();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await site?.close();
});

describe.each(BOTH_CHROMIUM_LAUNCHERS)('LU-3: finding the created row in a list and pressing the opener in the row (%s)', (label, launch) => {
  const itOnDefault = it.runIf(label === DEFAULT_LABEL);
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;

  beforeAll(async () => {
    browser = await launch();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (browser !== undefined) {
      await closeTestContexts(browser);
      await browser.close();
    }
  });

  beforeEach(async () => {
    await context?.close();
    context = await browser.newContext();
    page = await context.newPage();
  });

  const open = async (path: string): Promise<void> => {
    await page.goto(`${site.origin}${path}`, { waitUntil: 'load' });
  };

  const search = async (value: string): Promise<{ readonly count: number; readonly row: ListRowReference | null }> => {
    const found = await findListRowsContainingValue(page, value, Date.now() + READ_TIMEOUT_MS);
    if (found.status !== 'READ') {
      throw new Error('the rows were not read');
    }
    return { count: found.matchedRowCount, row: found.row };
  };

  const rowOf = async (value: string): Promise<ListRowReference> => {
    const { count, row } = await search(value);
    expect(count).toBe(1);
    if (row === null) {
      throw new Error('the row was not returned');
    }
    return row;
  };

  /** 行の中の候補（probe の候補のうち、送信の要素の位置が行の位置で始まるもの）。 */
  const candidatesInRow = async (row: ListRowReference): Promise<readonly ProbedCandidate[]> => {
    const probe = await probePageCandidates(page, Date.now() + READ_TIMEOUT_MS);
    if (probe.status !== 'READ') {
      throw new Error('the page was not probed');
    }
    return probe.candidates.filter((candidate) => {
      const path = candidate.submitter?.path;
      return path !== undefined && path.length > row.path.length && row.path.every((step, index) => path[index] === step);
    });
  };

  const digestOf = (candidate: ProbedCandidate | undefined): string => {
    if (candidate === undefined) {
      throw new Error('the candidate was not found');
    }
    return probedCandidateIdentityDigestOf(locationOfUrl(page.url()).location, candidate);
  };

  /** 行の中の、削除の語のない最初の候補の識別の digest（開き手の digest）。 */
  const openerDigestOf = async (row: ListRowReference): Promise<string> =>
    digestOf((await candidatesInRow(row)).find((candidate) => !candidate.submitterWords.includes(LIST_ROW_PRESS_WORDS.remove)));

  const openWindowCount = (): Promise<number> =>
    page.evaluate(() => document.querySelectorAll('dialog[open], [role="dialog"]:not([hidden])').length);
  const removedCount = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __listRowPressRemoved: number }).__listRowPressRemoved);

  describe('the read of the rows containing a value', () => {
    itOnDefault.each([
      ['a table (tbody tr)', LIST_ROW_PRESS_PATHS.table],
      ['a list (ul li)', LIST_ROW_PRESS_PATHS.list],
    ])('counts 0, 1 and 2 matching rows in %s, leaving the navigation and the heading row out, and returns the row only for 1', async (_name, path) => {
      await open(path);
      const one = await search(LIST_ROW_PRESS_VALUES.unique);
      expect(one.count).toBe(1);
      expect(one.row).not.toBeNull();
      const two = await search(LIST_ROW_PRESS_VALUES.twice);
      expect(two).toEqual({ count: 2, row: null });
      const none = await search(LIST_ROW_PRESS_VALUES.navOnly);
      expect(none).toEqual({ count: 0, row: null });
      // 前後の空白は整えて比べる（READ の答え合わせと同じ比べ方）。
      expect((await search(`  ${LIST_ROW_PRESS_VALUES.unique}\n`)).count).toBe(1);
    }, TEST_TIMEOUT_MS);

    itOnDefault('returns the row that contains the value (the row element is the one with the value)', async () => {
      await open(LIST_ROW_PRESS_PATHS.table);
      const row = await rowOf(LIST_ROW_PRESS_VALUES.unique);
      const text = await page.evaluate((steps) => {
        let element: Element | null = document.documentElement;
        for (const step of steps.slice(1)) {
          element = element?.children.item(step) ?? null;
        }
        return element === null ? null : { name: element.localName, text: (element as HTMLElement).innerText };
      }, [...row.path]);
      expect(text?.name).toBe('tr');
      expect(text?.text).toContain(LIST_ROW_PRESS_VALUES.unique);
    }, TEST_TIMEOUT_MS);

    itOnDefault.each([
      ['a cell equal to the value', LIST_ROW_PRESS_BOUNDARY_VALUES.mail],
      ['the value between word boundaries in a cell', LIST_ROW_PRESS_BOUNDARY_VALUES.code],
      ['a list item without child elements', LIST_ROW_PRESS_BOUNDARY_VALUES.item],
      ['a list item whose text node holds the value next to an opener button', LIST_ROW_PRESS_BOUNDARY_VALUES.inline],
      ['a zero width space in the cell (LU-SFIX3-A)', LIST_ROW_PRESS_BOUNDARY_VALUES.zeroWidth],
      ['the value in capitals in the cell (LU-SFIX3-A)', LIST_ROW_PRESS_BOUNDARY_VALUES.upper],
      ['the value in full width characters in the cell (LU-SFIX3-A)', LIST_ROW_PRESS_BOUNDARY_VALUES.wide],
      ['no-break spaces around the value in the cell (LU-SFIX3-A)', LIST_ROW_PRESS_BOUNDARY_VALUES.nbsp],
      ['the value in capitals searched (LU-SFIX3-A)', LIST_ROW_PRESS_BOUNDARY_VALUES.code.toUpperCase()],
    ])('counts only the row with %s, not rows that contain the value as a part of a longer word (LU-SFIX2-A)', async (_name, value) => {
      await open(LIST_ROW_PRESS_PATHS.boundary);
      const found = await search(value);
      expect(found.count).toBe(1);
      expect(found.row).not.toBeNull();
    }, TEST_TIMEOUT_MS);

    itOnDefault('does not count a row whose cell only contains the value as a part (item-2@example.com in item-21@example.com, LU-SFIX2-A)', async () => {
      await open(LIST_ROW_PRESS_PATHS.boundary);
      expect(await search('item-2')).toEqual({ count: 0, row: null });
      expect(await search('example.com')).toEqual({ count: 0, row: null });
      // 表の行と、文字の節で値を書いた `li` の行（fix round 1。`li` の全体も比べる）の 2 つ。どちらも `item-2` には当たらない（上）。
      expect((await search('item-21@example.com')).count).toBe(2);
    }, TEST_TIMEOUT_MS);

    itOnDefault.each([
      ['only in a cell that is not rendered', LIST_ROW_PRESS_BOUNDARY_VALUES.hidden],
      ['only followed by a combining mark', LIST_ROW_PRESS_BOUNDARY_VALUES.combining],
    ])('does not count a row with the value %s (LU-SFIX3-A)', async (_name, value) => {
      await open(LIST_ROW_PRESS_PATHS.boundary);
      expect(await search(value)).toEqual({ count: 0, row: null });
    }, TEST_TIMEOUT_MS);

    itOnDefault('does not search for an empty value', async () => {
      await open(LIST_ROW_PRESS_PATHS.table);
      expect(await findListRowsContainingValue(page, '   ', Date.now() + READ_TIMEOUT_MS)).toEqual({ status: 'FAILED' });
    }, TEST_TIMEOUT_MS);

    itOnDefault('keeps the counting read of the structure the same', async () => {
      await open(LIST_ROW_PRESS_PATHS.table);
      const read = await readPageStructure(page, Date.now() + READ_TIMEOUT_MS);
      expect(read.status).toBe('READ');
      expect(read.status === 'READ' ? read.structure.tableRowCounts : null).toEqual([3]);
      expect(read.status === 'READ' ? Object.keys(read.structure).sort() : null)
        .toEqual(['detailEntries', 'limitReached', 'listItemCounts', 'region', 'settled', 'tableRowCounts', 'text']);
    }, TEST_TIMEOUT_MS);
  });

  describe('the press of the opener in the row', () => {
    itOnDefault('defines the closed list of the results in one place', () => {
      expect(LIST_ROW_OPENER_PRESS_RESULTS).toEqual(expect.arrayContaining(['PRESSED', 'OPENER_NOT_FOUND', 'OPENER_UNNAMED', 'OPENER_DELETE_LIKE']));
    });

    itOnDefault.each([
      ['the text', LIST_ROW_PRESS_OPENER_ROWS.text],
      ['the aria-label', LIST_ROW_PRESS_OPENER_ROWS.ariaLabel],
      ['the title', LIST_ROW_PRESS_OPENER_ROWS.title],
    ])('presses the only named opener with the same identity in the row (named by %s) and the window opens', async (_name, value) => {
      await open(LIST_ROW_PRESS_PATHS.openers);
      const row = await rowOf(value);
      const digest = await openerDigestOf(row);
      expect(await openWindowCount()).toBe(0);
      expect(await pressListRowOpener(page, row, digest)).toBe('PRESSED');
      await expect.poll(openWindowCount).toBe(1);
      expect(await removedCount()).toBe(0);
    }, TEST_TIMEOUT_MS);

    itOnDefault('presses the opener in the chosen row only, even when every row has an opener with the same identity', async () => {
      await open(LIST_ROW_PRESS_PATHS.table);
      const row = await rowOf(LIST_ROW_PRESS_VALUES.unique);
      const digest = await openerDigestOf(row);
      expect(await pressListRowOpener(page, row, digest)).toBe('PRESSED');
      await expect.poll(openWindowCount).toBe(1);
      expect(await removedCount()).toBe(0);
    }, TEST_TIMEOUT_MS);

    itOnDefault('does not press an icon-only opener without a name (OPENER_UNNAMED)', async () => {
      await open(LIST_ROW_PRESS_PATHS.openers);
      const row = await rowOf(LIST_ROW_PRESS_OPENER_ROWS.iconOnly);
      const digest = await openerDigestOf(row);
      expect(await pressListRowOpener(page, row, digest)).toBe('OPENER_UNNAMED');
      expect(await openWindowCount()).toBe(0);
    }, TEST_TIMEOUT_MS);

    itOnDefault('does not press when the row has two openers with the same identity (OPENER_NOT_FOUND)', async () => {
      await open(LIST_ROW_PRESS_PATHS.openers);
      const row = await rowOf(LIST_ROW_PRESS_OPENER_ROWS.twin);
      const inRow = await candidatesInRow(row);
      const openers = inRow.filter((candidate) => candidate.submitterWords.includes(LIST_ROW_PRESS_WORDS.edit));
      expect(openers).toHaveLength(2);
      expect(digestOf(openers[0])).toBe(digestOf(openers[1]));
      expect(await pressListRowOpener(page, row, digestOf(openers[0]))).toBe('OPENER_NOT_FOUND');
      expect(await openWindowCount()).toBe(0);
    }, TEST_TIMEOUT_MS);

    itOnDefault('does not press when the row has no candidate with the identity (OPENER_NOT_FOUND)', async () => {
      await open(LIST_ROW_PRESS_PATHS.openers);
      const textRow = await rowOf(LIST_ROW_PRESS_OPENER_ROWS.text);
      const digest = await openerDigestOf(textRow);
      const removeOnlyRow = await rowOf(LIST_ROW_PRESS_OPENER_ROWS.removeOnly);
      expect(await pressListRowOpener(page, removeOnlyRow, digest)).toBe('OPENER_NOT_FOUND');
      expect(await openWindowCount()).toBe(0);
      expect(await removedCount()).toBe(0);
    }, TEST_TIMEOUT_MS);

    itOnDefault('does not press a candidate with a delete word (OPENER_DELETE_LIKE)', async () => {
      await open(LIST_ROW_PRESS_PATHS.openers);
      const row = await rowOf(LIST_ROW_PRESS_OPENER_ROWS.removeOnly);
      const remove = (await candidatesInRow(row)).find((candidate) => candidate.submitterWords.includes(LIST_ROW_PRESS_WORDS.remove));
      expect(await pressListRowOpener(page, row, digestOf(remove))).toBe('OPENER_DELETE_LIKE');
      expect(await removedCount()).toBe(0);
    }, TEST_TIMEOUT_MS);

    it(`never presses an unnamed icon swapped in for the opener between the check and the press (${String(SWAP_PRESS_TRIALS)} presses, LU-SFIX2-A)`, async () => {
      const purges = (): number => site.records.filter(({ method, path }) => method === 'POST' && path === LIST_ROW_PRESS_PATHS.purge).length;
      // 本物の開き手の識別の digest（入れ替えない同じ画面で読む）。
      await open(`${LIST_ROW_PRESS_PATHS.swapping}?${LIST_ROW_PRESS_STILL_QUERY}`);
      const digest = await openerDigestOf(await rowOf(LIST_ROW_PRESS_OPENER_ROWS.swapping));
      const purgesBefore = purges();
      await open(LIST_ROW_PRESS_PATHS.swapping);
      const results: string[] = [];
      for (let trial = 0; trial < SWAP_PRESS_TRIALS; trial += 1) {
        const row = await rowOf(LIST_ROW_PRESS_OPENER_ROWS.swapping);
        let result = await pressListRowOpener(page, row, digest, PRESS_STEP_LIMIT_MS);
        for (let attempt = 1; attempt < SWAP_MAX_PRESSES_PER_TRIAL && result === 'OPENER_NOT_FOUND'; attempt += 1) {
          result = await pressListRowOpener(page, row, digest, PRESS_STEP_LIMIT_MS);
        }
        results.push(result);
      }
      await sleep(SWAP_LATE_DELIVERY_SETTLE_MS);
      const opened = await page.evaluate(() => (window as unknown as { __listRowPressOpened: number }).__listRowPressOpened);
      const summary = { results, purges: purges() - purgesBefore, opened };
      // 偽物（名前のないアイコン）の送信は、サーバに 0 件。
      expect(summary.purges, JSON.stringify(summary)).toBe(0);
      // 止める経路が働いた（確かめた本物の要素が、押す直前に入れ替わっていて、押さなかった）回が 1 回以上。
      expect(results.filter((result) => result === 'PAGE_UNREADABLE').length, JSON.stringify(summary)).toBeGreaterThan(0);
      // 押した回は、どれも本物を押した。
      expect(opened, JSON.stringify(summary)).toBe(results.filter((result) => result === 'PRESSED').length);
      expect(results.every((result) => ['PRESSED', 'PAGE_UNREADABLE', 'OPENER_NOT_FOUND'].includes(result)), JSON.stringify(summary)).toBe(true);
    }, SWAP_TEST_TIMEOUT_MS);

    it(`never presses the same opener while its name is rewritten away (${String(REWRITE_PRESS_TRIALS)} presses per scene, LU-SFIX3-A)`, async () => {
      const purges = (): number => site.records.filter(({ method, path }) => method === 'POST' && path === LIST_ROW_PRESS_PATHS.purge).length;
      const purgesBefore = purges();
      const perScene: Record<string, readonly string[]> = {};
      let opened = 0;
      for (const [mode, ms] of REWRITE_SCENES) {
        // 名前のあるときの開き手の識別の digest（書き換えない同じ画面で読む）。
        await open(`${LIST_ROW_PRESS_PATHS.rewriting}?${LIST_ROW_PRESS_STILL_QUERY}&mode=${mode}`);
        const digest = await openerDigestOf(await rowOf(LIST_ROW_PRESS_OPENER_ROWS.rewriting));
        await open(`${LIST_ROW_PRESS_PATHS.rewriting}?mode=${mode}&ms=${ms}`);
        const results: string[] = [];
        for (let trial = 0; trial < REWRITE_PRESS_TRIALS; trial += 1) {
          const row = await rowOf(LIST_ROW_PRESS_OPENER_ROWS.rewriting);
          let result = await pressListRowOpener(page, row, digest, PRESS_STEP_LIMIT_MS);
          for (let attempt = 1; attempt < REWRITE_MAX_PRESSES_PER_TRIAL && ['OPENER_NOT_FOUND', 'OPENER_UNNAMED'].includes(result); attempt += 1) {
            result = await pressListRowOpener(page, row, digest, PRESS_STEP_LIMIT_MS);
          }
          results.push(result);
        }
        opened += await page.evaluate(() => (window as unknown as { __listRowPressOpened: number }).__listRowPressOpened);
        perScene[`${mode}:${ms}`] = results;
      }
      await sleep(SWAP_LATE_DELIVERY_SETTLE_MS);
      const all = Object.values(perScene).flat();
      const summary = { perScene, purges: purges() - purgesBefore, opened };
      // 名前のないときの送信は、サーバに 0 件。
      expect(summary.purges, JSON.stringify(summary)).toBe(0);
      // 押す時点の確かめ（か押す直前の確かめ）で止めた回が 1 回以上。
      expect(all.filter((result) => result === 'PAGE_UNREADABLE').length, JSON.stringify(summary)).toBeGreaterThan(0);
      // 押した回は、どれも名前のあるときを押した。
      expect(opened, JSON.stringify(summary)).toBe(all.filter((result) => result === 'PRESSED').length);
    }, SWAP_TEST_TIMEOUT_MS);
  });
});

// COV-2（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.2・3.3、上限の撤廃の設計書の L7）: 操作さがしの待ち行列を再帰の待ち行列
// （`CoverageQueue`）に寄せ、画面の上限をなくした。本物の発見の流れ（`executeDiscoveryRun`。Guard・凍結・押す部品）と、127.0.0.1 の仮のサイト
// （`tests/helpers/coverage-site.ts`。一般の文言）で確かめる。押して出させた書き込みの到着（サーバの記録）は、2 つの Chromium の両方で 0。
// - 番号だけ違う同じ作りの画面を全部読み、押すのは最初の 1 つだけ（ほかは `SAME_STATE_PRESSED`）。
// - 状態の語だけ違う画面（確定・取り消し済み）は、PSKIP から、data を除いた path が同じなので、前の画面で押した同じボタンを押し直さない（理由を残す）。
// - query の一覧の続きのページを、新しいリンクが出る間は読む。日付の「次へ」で空の日が続くと閉じる（読む数が増え続けない）。
// - 予約の画面で、拠点と時間の枠の両方を押す（文字のないボタンを段をまたいで同じ候補とみなさない）。段が移った後に、元の状態の残りを押す（読み込み直し）。
// - 押した数が 3 を超えても、読み込み直しが働く。
// RB-8: checkpoint からの再開の場面（読んだ画面を読み直さない・伏せた状態を祖先から作り直す）は、偽の巡回の口の単体（`tests/unit/discovery-crawl.test.ts`）へ移した。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import {
  COVERAGE_QUEUE_LATE_DELIVERY_SETTLE_MS as LATE_DELIVERY_SETTLE_MS,
  COVERAGE_QUEUE_TEST_TIMEOUT_MS as TEST_TIMEOUT_MS,
  coveragePathOf as pathOf,
  coveragePressed as pressed,
  coverageReadOf as readOf,
  coverageReadPages as readPages,
  discoverCoverageSite as discover,
} from '../helpers/coverage-queue-run.js';
import { coverageSiteHandler } from '../helpers/coverage-site.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import type { SeenRequest } from '../helpers/staged-probe-site.js';

// TEST-SLIM D2（TEST-POLICY の 3）: 振る舞いの場面なので、既定の Chromium だけで流す。
describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('COV-2: the discovery widens the coverage queue recursively (%s)', (_name, launch) => {
  it('reads every page, presses each state once, closes the endless chain, reloads for the rest, and delivers no write', async () => {
    const seen: SeenRequest[] = [];
    const server = await startLoopbackHttpServer(coverageSiteHandler(seen));
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-cov2-'));
    try {
      const { document, elapsedMs } = await discover(launch, server.origin, directory, { jobId: 'job-cov2-coverage' });
      await wait(LATE_DELIVERY_SETTLE_MS);
      const gets = seen.filter(({ method }) => method === 'GET');
      console.info(`[COV-2] ${_name}: ${String(Math.round(elapsedMs / 1000))} s, pages read ${String(readPages(document).length)}, `
        + `document GETs ${String(gets.length)}, all requests ${String(seen.length)}; `
        + document.pages.map((page) => `${pathOf(page.url)}${new URL(page.url).search}:${page.state === 'READ' ? 'R' : page.reason}`).join(' '));
      expect(document.endReason).toBe('COMPLETED');

      // 番号だけ違う同じ作りの画面を全部読み、押すのは最初の 1 つだけ。
      const items = ['/items/1', '/items/2', '/items/3', '/items/4'].map((path) => readOf(document, path));
      expect(items.map((pages) => pages.length)).toEqual([1, 1, 1, 1]);
      const itemProbes = items.flatMap((pages) => pages.flatMap((page) => page.record.candidates.filter((candidate) => candidate.kind === 'BUTTON')));
      expect(itemProbes).toHaveLength(4);
      expect(itemProbes.filter(pressed)).toHaveLength(1);
      expect(itemProbes.filter((candidate) => candidate.submissionProbe?.reason === 'SAME_STATE_PRESSED')).toHaveLength(3);

      // 状態の語だけ違う画面は、両方で押す。
      // PSKIP: data を除いた path が同じ画面（`/orders/1` と `/orders/2`）では、前の画面で押した同じボタンを押し直さない（`SAME_STATE_PRESSED`）。その画面に
      // だけあるボタンは押す（押していない候補は、押し直さない同じボタンだけ）。
      const [firstOrder] = readOf(document, '/orders/1');
      const [secondOrder] = readOf(document, '/orders/2');
      expect(firstOrder?.record.candidates.filter(pressed).length, '/orders/1').toBeGreaterThan(0);
      const secondButtons = secondOrder?.record.candidates.filter((candidate) => candidate.kind === 'BUTTON') ?? [];
      expect(secondButtons.length, '/orders/2').toBeGreaterThan(0);
      expect(secondButtons.filter((candidate) => !pressed(candidate)).map((candidate) => candidate.submissionProbe?.reason), '/orders/2')
        .toEqual(secondButtons.filter((candidate) => !pressed(candidate)).map(() => 'SAME_STATE_PRESSED'));

      // query の一覧の続きのページを全部読む。日付の「次へ」は、空の日が続くと閉じる。
      expect(readPages(document).filter((page) => pathOf(page.url) === '/list').map((page) => new URL(page.url).search).sort())
        .toEqual(['?page=1', '?page=2', '?page=3']);
      const calendar = readOf(document, '/cal');
      expect(calendar.length).toBeGreaterThanOrEqual(2);
      expect(calendar.length).toBeLessThanOrEqual(3);

      // 予約の画面: 拠点（2 つ）と時間の枠（3 つ）とお知らせの、文字のないボタンを、別の候補として押す。段が移った後に、元の状態の残り（もう 1 つの拠点）を
      // 読み込み直して押す。
      const [booking] = readOf(document, '/app/booking');
      expect(booking?.reloadedForProbe).toBe(true);
      const plainButtons = booking?.record.candidates.filter((candidate) => candidate.kind === 'BUTTON' && candidate.submitterWords.length === 0) ?? [];
      expect(plainButtons.filter(pressed).length).toBeGreaterThanOrEqual(6);
      expect(booking?.record.candidates.filter((candidate) => candidate.submissionProbe?.reason === 'PAGE_CHANGED')).toEqual([]);

      // 押した数が 3 を超えても、読み込み直しが働く（区画を入れ替えた後に消えた最後のボタンを、読み込み直して押す）。
      const [many] = readOf(document, '/many');
      expect(many?.reloadedForProbe).toBe(true);
      expect(many?.record.candidates.filter((candidate) => candidate.kind === 'BUTTON' && !pressed(candidate))).toEqual([]);

      // COV-2b: 段をまたいで入れ替わる、同じ深さ・同じ識別の文字のないボタンを、両方とも別の候補として押す（前の段の残りは読み込み直して押す）。
      const [swap] = readOf(document, '/swap');
      const swapButtons = swap?.record.candidates.filter((candidate) => candidate.kind === 'BUTTON' && candidate.submitterWords.length === 0) ?? [];
      expect(swapButtons.filter(pressed)).toHaveLength(5);
      expect(swap?.record.candidates.filter((candidate) => candidate.submissionProbe?.reason === 'PAGE_CHANGED')).toEqual([]);
      expect(swap?.reloadedForProbe).toBe(true);

      // COV-2b: 押して文書が替わった GET の移り先（結果の画面）を読む。記録の URL の目印の値は伏せてある（読んだ URL は目印のまま）。
      const [results] = readOf(document, '/results');
      expect(results).toBeDefined();
      expect(new URL(results?.url ?? 'http://x/').searchParams.get('q')).toContain('REDACTED');
      expect(JSON.stringify(document)).not.toMatch(/bsprobe/u);
      expect(seen.filter(({ method, path, search }) => method === 'GET' && path === '/results' && new URLSearchParams(search).get('q')?.startsWith('bsprobe') === true))
        .toHaveLength(1);

      // COV-2b: 同じ Origin の子の frame の文書を、frame の印つきの状態として読む。
      expect(readOf(document, '/frame-doc')).toHaveLength(1);

      // 押して出させた書き込みは届かない（サーバの記録。遅れて届く要求も待って数える）。
      expect(seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

// CALDAY（設計書 `doc/design/2026-11-25-beaksight-discovery-sibling-press-design.md` 2.1・3）: 本物の発見の流れ（`executeDiscoveryRun`。factory と Guard と
// 押す部品）で、窓の中の日の表（同じ形の日のボタン 35 個）の画面を 1 画面だけ読む。既定の Chromium と本番の既定の送信の扱い（PASS_EXCEPT_DELETE）。
// - PLAIN（dialog と form の POST）・JS（div の窓。確定は日を選ぶまで押せず、JS の fetch の POST）・SLOTS（JS に加え、日を選ぶと空き枠の欄が出る）: 日は
//   1〜2 回だけ押し、残りは押さない。読み込み直しはない。JS と SLOTS は、日を選んで押せるようになった確定を押して、登録の形を記録する。
// - SENDS（日を押すと送信が起きる）: 違いが出たので、日をすべて押す。
// - 安全: 押して出た送信はサーバに届かない。
import { describe, expect, it } from 'vitest';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { runDiscoveryOnPlainSite, type PlainSiteRun } from '../helpers/plain-discovery-site-run.js';

const PAGE_PATH = '/cal/p1';
const MONTH_DAYS = 35;
const SENDS_DAYS = 7;

type Variant = 'PLAIN' | 'JS' | 'SLOTS' | 'SENDS';

const dayButtons = (count: number): string => Array.from({ length: Math.ceil(count / 7) }, (_row, row) => `<tr>${Array.from({ length: 7 }, (_col, col) => {
  const day = row * 7 + col + 1;
  return day > count ? '<td></td>' : `<td><button type="button" class="cal-day" data-day="${String(day)}">${String(day)}</button></td>`;
}).join('')}</tr>`).join('');

const head = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>予約</title><link rel="icon" href="data:,"></head><body>';
const calendarHead = '<h2 id="dlg-title">日付の選び</h2><div class="cal-head"><button type="button" id="prev" aria-label="前の月">&lt;</button><span id="month">11月</span>'
  + '<button type="button" id="next" aria-label="次の月">&gt;</button></div>';
const pickScript = (afterPick: string): string => `document.getElementById('days').addEventListener('click', (event) => {
  const button = event.target.closest('button.cal-day'); if (button === null) return;
  for (const other of document.querySelectorAll('button.cal-day')) other.classList.remove('is-selected');
  button.classList.add('is-selected'); picked = button.dataset.day; ${afterPick}
});`;

const plainPage = (sends: boolean): string => `${head}<main><h1>予約</h1><button type="button" id="open">日付を選ぶ</button>
<dialog id="dlg" aria-labelledby="dlg-title"><form method="post" action="/cal/save">${calendarHead}
<table><tbody id="days">${dayButtons(sends ? SENDS_DAYS : MONTH_DAYS)}</tbody></table><input type="hidden" name="date" id="date" value="">
<button type="button" id="cancel">取り消し</button><button type="submit" id="ok">日付を確定</button></form></dialog></main>
<script>let picked = null; const dlg = document.getElementById('dlg');
document.getElementById('open').addEventListener('click', () => dlg.showModal());
document.getElementById('cancel').addEventListener('click', () => dlg.close());
${pickScript(`document.getElementById('date').value = picked; document.getElementById('ok').textContent = picked + '日で確定';${
  sends ? " fetch('/api/pick', { method: 'POST', body: picked }).catch(() => {});" : ''}`)}</script></body></html>`;

const jsPage = (slots: boolean): string => `${head}<main><h1>予約</h1><button type="button" id="open">日付を選ぶ</button>
<div id="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title" hidden style="position:fixed;inset:10% 20%;background:#fff;z-index:10;">${calendarHead}
<table><tbody id="days">${dayButtons(MONTH_DAYS)}</tbody></table>
${slots ? '<div id="slots" hidden><label>枠 <select name="slot"><option value="am">午前</option><option value="pm">午後</option></select></label></div>' : ''}
<button type="button" id="cancel">取り消し</button><button type="button" id="ok" disabled>日付を確定</button></div></main>
<script>let picked = null; const dlg = document.getElementById('dlg');
document.getElementById('open').addEventListener('click', () => { dlg.hidden = false; });
document.getElementById('cancel').addEventListener('click', () => { dlg.hidden = true; });
${pickScript("const ok = document.getElementById('ok'); ok.disabled = false; ok.textContent = picked + '日で確定'; const box = document.getElementById('slots'); if (box !== null) box.hidden = false;")}
document.getElementById('ok').addEventListener('click', () => {
  fetch('/api/reserve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: picked }) }).catch(() => {});
});</script></body></html>`;

const pageOf = (variant: Variant): string => (variant === 'JS' || variant === 'SLOTS' ? jsPage(variant === 'SLOTS') : plainPage(variant === 'SENDS'));

const runOf = (variant: Variant): Promise<PlainSiteRun> => runDiscoveryOnPlainSite(() => launchHeadlessChromium(), (path) => (path === PAGE_PATH ? pageOf(variant) : null),
  PAGE_PATH, 1, `job-calday-${variant.toLowerCase()}`, { sendPolicy: 'PASS_EXCEPT_DELETE' });

/** 読んだ画面の候補の、probe の結果と理由。 */
const probesOf = (run: PlainSiteRun): readonly { readonly result: string | undefined; readonly reason: string | null | undefined }[] => {
  const page = run.document.pages[0];
  if (page?.state !== 'READ') throw new Error('the calendar page was not read');
  return page.record.candidates.map(({ submissionProbe }) => ({ result: submissionProbe?.result, reason: submissionProbe?.reason }));
};

const pageLoadsOf = (run: PlainSiteRun): number => run.seen.filter(({ method, path }) => method === 'GET' && path === PAGE_PATH).length;
const nonReadsOf = (run: PlainSiteRun): readonly unknown[] => run.seen.filter(({ method }) => !READ_METHODS.has(method));

describe('CALDAY: the same-shaped day buttons of a calendar in a window (the default test Chromium, PASS_EXCEPT_DELETE)', () => {
  it('presses a day once or twice and not the rest, without a reload, and presses the confirm the day enabled', async () => {
    for (const variant of ['PLAIN', 'JS', 'SLOTS'] as const) {
      const run = await runOf(variant);
      const probes = probesOf(run);      const skipped = probes.filter(({ reason }) => reason === 'SAME_SHAPE_NO_CHANGE').length;
      // 押さなかった日は 33 以上（前の月・次の月のボタンも同じ形の兄弟）。押したのは、開くボタン・月のボタン・日・確定の数回だけ。
      expect(skipped, variant).toBeGreaterThanOrEqual(MONTH_DAYS - 2);
      expect(probes.filter(({ result }) => result === 'NO_REQUEST').length, variant).toBeLessThanOrEqual(5);
      expect(pageLoadsOf(run), variant).toBe(1);
      if (variant !== 'PLAIN') expect(probes.some(({ result }) => result === 'API_CREATE'), variant).toBe(true);
      expect(nonReadsOf(run), variant).toEqual([]);
    }
  });

  it('presses every day when the first day sent a request', async () => {
    const run = await runOf('SENDS');
    const probes = probesOf(run);    expect(probes.filter(({ reason }) => reason === 'SAME_SHAPE_NO_CHANGE')).toEqual([]);
    // 日の押下は本文の値の入った送信を出すので、登録として試せない形（`NOT_EXECUTABLE`）で記録する。
    expect(probes.filter(({ result }) => result === 'API_CREATE' || result === 'NOT_EXECUTABLE').length).toBeGreaterThanOrEqual(SENDS_DAYS);
    expect(nonReadsOf(run)).toEqual([]);
  });
});

// DEF-208-4（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.7 の A）: 本物の発見の流れ（`executeDiscoveryRun`。factory と Guard と押す部品）で、
// 127.0.0.1 の仮のサイトを巡回する。既定の Chromium と本番の既定の送信の扱い（PASS_EXCEPT_DELETE）だけ。
// - A（SLK-1。網羅の設計書 6 章の 2026-11-16）: 4 つの画面のどれにも、共通の枠（`<nav>`）に文字のあるボタンがある。本文（`<main>`）に「保存」（POST）と、
//   文字のあるボタン 2 つ。画面ごとに画面全体の構造の鍵は違う。p1〜p3 は枠の部分の作りが同じなので、枠のボタンは操作さがし全体で 1 つの画面でだけ押す。
//   p4 は枠の中に見出しがある（枠の部分の作りが違う）ので押す。本文のボタンは、どの画面でも押す。
// - 安全: 押して出た送信はサーバに届かない（サーバの記録で数え、名前つきの時間だけ待って数え直す）。
import { describe, expect, it } from 'vitest';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { runDiscoveryOnPlainSite, type PlainSiteRun } from '../helpers/plain-discovery-site-run.js';

const TEST_TIMEOUT_MS = 240_000;
const FRAME_BUTTONS = 4;
const SAME_FRAME_PAGES = ['/a/p1', '/a/p2', '/a/p3'] as const;
const OTHER_FRAME_PAGE = '/a/p4';
const A_PAGES = [...SAME_FRAME_PAGES, OTHER_FRAME_PAGE] as const;

const document = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>`
  + `<link rel="icon" href="data:,"></head><body>${body}</body></html>`;

/** A の画面（本文の「保存」は同じ Origin に POST を送る。p4 だけ、枠の中に見出しがある）。ほかの path は 404。 */
const pageOf = (path: string): string | null => (!(A_PAGES as readonly string[]).includes(path) ? null : document(path, `<nav id="side">${path === OTHER_FRAME_PAGE ? '<h2>menu</h2>' : ''}${A_PAGES.map((link) => `<a href="${link}">${link}</a>`).join('')}
${Array.from({ length: FRAME_BUTTONS }, (_value, index) => `<button type="button" class="menu">メニュー${String(index + 1)}</button>`).join('')}</nav>
<main><h1>${path}</h1><input id="title" name="title"><button type="button" id="save">保存</button>
<button type="button" class="body">本文の操作 1</button><button type="button" class="body">本文の操作 2</button></main>
<script>for (const button of document.querySelectorAll('.menu, .body')) button.addEventListener('click', () => { button.dataset.on = '1'; });
document.getElementById('save').addEventListener('click', () => { fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: document.getElementById('title').value }) }).catch(() => {}); });</script>`));

/** 読んだ画面の、候補ごとの probe の結果（`<語か文字なし> <結果> <理由>`）。 */
const probesOf = (run: PlainSiteRun, path: string): { readonly frame: string[]; readonly body: string[] } => {
  const page = run.document.pages.find((entry) => entry.state === 'READ' && new URL(entry.url).pathname === path);
  if (page?.state !== 'READ') throw new Error(`the page ${path} was not read`);
  const lines = page.record.candidates.map((candidate) => `${candidate.submitterWords.join('/') || '-'} ${String(candidate.submissionProbe?.result)} ${String(candidate.submissionProbe?.reason)}`);
  return { frame: lines.slice(0, FRAME_BUTTONS), body: lines.slice(FRAME_BUTTONS) };
};

/** CALDAY: 同じ形の兄弟（番号だけ違うボタン）は、最初の 1 つを押して何も起きなければ、残りを押さない。 */
const pressedAll = (frame: readonly string[]): boolean => frame[0]?.endsWith('NO_REQUEST null') === true
  && frame.slice(1).every((line) => line.endsWith('SAME_SHAPE_NO_CHANGE'));

describe('DEF-208-4 and SLK-1: the shared layout buttons (the default test Chromium, PASS_EXCEPT_DELETE)', () => {
  it('A: presses the shared layout buttons once over the run while the layout part is the same, again where it differs, and the body buttons on every page', async () => {
    const run = await runDiscoveryOnPlainSite(() => launchHeadlessChromium(), pageOf, A_PAGES[0], A_PAGES.length, 'job-def208-4-a', { sendPolicy: 'PASS_EXCEPT_DELETE' });
    for (const path of A_PAGES) {
      const { body } = probesOf(run, path);
      // 本文の「保存」は、どの画面でも押す（観察の対象。届けない）。
      expect(body[0]).toMatch(/^保存 (API_CREATE|NOT_EXECUTABLE) /u);
      expect(body.slice(1)).toEqual(['- NO_REQUEST null', '- NOT_OBSERVED SAME_SHAPE_NO_CHANGE']);
    }
    const sameFrames = SAME_FRAME_PAGES.map((path) => probesOf(run, path).frame);
    expect(sameFrames.filter(pressedAll)).toHaveLength(1);
    expect(sameFrames.filter((frame) => frame.every((line) => line.endsWith('SHARED_LAYOUT_PRESSED')))).toHaveLength(SAME_FRAME_PAGES.length - 1);
    expect(pressedAll(probesOf(run, OTHER_FRAME_PAGE).frame)).toBe(true);
    expect(run.seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// PREADY（設計書 `doc/design/2026-11-25-beaksight-discovery-press-readiness-design.md` 2・3）: 本物の発見の流れ（`executeDiscoveryRun`）で、押す前の準備の
// 確かめが窓の長さ（本番の値）まで待つ場面を、1 画面ずつ読む。押す対象は JS で結ぶボタン（押すと JS の fetch の POST）。既定の Chromium と PASS_EXCEPT_DELETE。
// - 待たずに分かる物（大きさ 0 の送信ボタン・radio、動き続ける radio）では、窓の長さまで待たない。form のない動く radio は触らずに、送信ボタンを押す。
// - 止まる・消える物（少し後にアニメーションが止まる・幕が消える）は、事実が変わった後に確かめ直して押す。
// - 測りの記録が入なら `DISCOVERY_READINESS` の行を書き、URL・値を書かない。切なら記録を書かない。安全: 読み取りでない要求はサーバに届かない。
import { describe, expect, it } from 'vitest';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { runDiscoveryOnPlainSite, type PlainSiteRun } from '../helpers/plain-discovery-site-run.js';

const PAGE_PATH = '/scene';
const ANIM = '<style>@keyframes mv{0%{transform:translateX(0)}50%{transform:translateX(40px)}100%{transform:translateX(0)}}.mv{animation:mv 0.8s linear infinite}'
  + '.stop{animation:mv 0.8s linear 2}</style>';
const ZERO = 'position:absolute;width:0;height:0;margin:0;padding:0;border:0;appearance:none;-webkit-appearance:none';
const F = (inner: string): string => `<div class="f">${inner}</div>`;
const saves = (restage: boolean): string => [1, 2, 3, 4].map((n) => F(`<input name="u${String(n)}"><button type="button"${restage
  ? ` onclick="const h=document.createElement('h2');h.textContent='done${String(n)}';const s=document.createElement('section');s.append(h);document.body.append(s)"`
  : ''}>保存${String(n)}</button>`)).join('');
const ZERO_SUBMITTER = F(`<input name="t"><button type="button" style="${ZERO}">登録</button>`);
const MOVING_RADIO = F('<input name="t"><label><input type="radio" name="k" value="1" class="mv">A</label><button type="button">登録</button>');

const SCENES = Object.freeze({
  b2: ZERO_SUBMITTER,
  b3: `<form>${F(`<input name="t"><label><input type="radio" name="k" value="1" style="${ZERO}">A</label>`
    + `<label><input type="radio" name="k" value="2" style="${ZERO}">B</label><button type="button">登録</button>`)}</form>`,
  c2: `${ANIM}<form>${MOVING_RADIO}</form>`,
  f3: ZERO_SUBMITTER + saves(false),
  f4: ZERO_SUBMITTER + saves(true),
  f5: `${ANIM}${MOVING_RADIO}${saves(true)}`,
  g1: `${ZERO_SUBMITTER}${F('<input name="v"><button type="button">更新</button>')}`
    + '<div style="position:fixed;left:0;right:0;bottom:0;height:200px;background:#eee;z-index:50">bar <a href="#x">x</a></div><div style="height:2400px"></div>',
  // 止まる物: form の radio が 2 回だけ動いて止まる（form の送信ボタンは押す前に radio を選ぶ）。消える物: 送信ボタンの幕が少し後に消える。
  stops: `${ANIM}<form method="post" action="/save"><input name="t"><label><input type="radio" name="k" value="1" class="stop">A</label>`
    + `<button type="submit">登録</button></form>${saves(false)}`,
  uncovers: `${F('<div style="position:relative;display:inline-block"><input name="t"><button type="button">登録</button>'
    + '<div id="veil" style="position:absolute;inset:0;z-index:5;background:rgba(0,0,0,.3)"></div></div>')}${saves(false)}`
    + '<script>setTimeout(()=>document.getElementById("veil").remove(),1200)</script>',
} as const);
type Scene = keyof typeof SCENES;

const pageOf = (body: string): string => '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>scene</title><link rel="icon" href="data:,"></head>'
  + `<body><main><h1>scene</h1>${body}</main><script>const bind=()=>{for(const b of document.querySelectorAll('button[type=button]'))if(!b.dataset.bound){`
  + "b.dataset.bound='1';b.addEventListener('click',()=>{fetch('/api/save',{method:'POST',body:'{}'}).catch(()=>{})})}};bind();setInterval(bind,100)</script></body></html>";

const runOf = (scene: Scene, debugTiming = true): Promise<PlainSiteRun> => runDiscoveryOnPlainSite(() => launchHeadlessChromium(),
  (path) => (path === PAGE_PATH ? pageOf(SCENES[scene]) : null), PAGE_PATH, 1, `job-pready-${scene}`, { sendPolicy: 'PASS_EXCEPT_DELETE' }, undefined, undefined,
  debugTiming);

const pageOfRun = (run: PlainSiteRun) => {
  const page = run.document.pages[0];
  if (page?.state !== 'READ' || page.timeBreakdown === undefined) throw new Error('the scene page was not read with the time breakdown');
  return { time: page.timeBreakdown, probes: page.record.candidates.map(({ submitterWords, submissionProbe }) => ({ words: submitterWords, result: submissionProbe?.result })) };
};
const nonReadsOf = (run: PlainSiteRun): readonly unknown[] => run.seen.filter(({ method }) => !READ_METHODS.has(method));
const pageLoadsOf = (run: PlainSiteRun): number => run.seen.filter(({ method, path }) => method === 'GET' && path === PAGE_PATH).length;

describe('PREADY: the readiness check before a press does not wait the window for what reads without waiting (the default test Chromium)', () => {
  it('waits the window for none of the zero-sized and moving targets, presses past a form-less moving radio, and reloads nothing for them', async () => {
    for (const scene of ['b2', 'b3', 'c2', 'f3', 'f4', 'f5', 'g1'] as const) {
      const run = await runOf(scene);
      const { time } = pageOfRun(run);
      if (scene === 'f5') {
        expect(time.pressReadinessTimeouts, scene).toBeLessThanOrEqual(1);
        // 前は押せなかった 5 つの送信ボタンを、すべて押す。
        expect(pageOfRun(run).probes.map(({ result }) => result).filter((result) => result !== 'NOT_OBSERVED'), scene).toHaveLength(5);
      } else {
        expect(time.pressReadinessTimeouts, scene).toBe(0);
      }
      if (scene === 'f3' || scene === 'g1') expect(pageLoadsOf(run), scene).toBe(1);
      expect(nonReadsOf(run), scene).toEqual([]);
    }
  });

  it('presses a target after its animation stops or its veil goes away', async () => {
    for (const scene of ['stops', 'uncovers'] as const) {
      const run = await runOf(scene);
      const register = pageOfRun(run).probes.find(({ words }) => words.includes('登録'));
      expect(register?.result, scene).not.toBe('NOT_OBSERVED');
      expect(nonReadsOf(run), scene).toEqual([]);
    }
  });

  it('writes a DISCOVERY_READINESS line per check without a URL or a value when the timing record is on, and nothing when it is off', async () => {
    const on = await runOf('f5');
    const lines = (on.debugLines ?? []).filter(({ point }) => point === 'DISCOVERY_READINESS');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.part).toMatch(/^(READY|COVERED_BY_OTHER|TARGET_NOT_VISIBLE|TARGET_NOT_STABLE|NO_FACT):(SUBMITTER|RADIO|OPTION):(PRESS|REPLAY|RELOAD|SURVEY):(REACHABLE|OFFSCREEN|NO_SIZE|UNKNOWN)$/u);
      expect(Object.keys(line.counts ?? {}).sort()).toEqual(['attempt', 'ms']);
    }
    expect(lines.some(({ part }) => part?.startsWith('TARGET_NOT_STABLE:RADIO:') === true)).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/127\.0\.0\.1|scene|u1/u);
    expect((await runOf('b2', false)).debugLines).toBeNull();
  });
});

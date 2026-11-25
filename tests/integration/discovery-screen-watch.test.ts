// L6/L3-1（設計書 `doc/design/2026-11-09-beaksight-remove-limits-design.md` 5 の 1、6 の L3・L6）: 操作さがしの読み取りと押す部品の期限を外し、1 画面の
// 発見と押す輪を 1 つの進みの見張り（L0 の `watchProgress`）で包む。本物の factory・Guard・凍結・probe と、127.0.0.1 の仮のサイト（一般の文言）で確かめる。
// - 読み取りに 15 秒かかる画面（前の読み取りの期限 10 秒を超える）: 打ち切らずに読む。
// - 押す呼び出しに 8 秒かかる画面（押した後の受け手がページを 8 秒ふさぐ。前の 1 手の期限 5 秒を超える）: 待って、送信の型を記録する。
// - 全く反応のない画面（押した後の受け手がページを長くふさぐ）: 見張りの長さ（テストで短く注入する）で「応答しなかった」として、その画面を終える。前に押した
//   候補の記録は残り、残りの候補と画面の記録に `STAGE_UNRESPONSIVE` が付く。発見は次へ進み、終わる。
// - DEF-289: 動き続けるボタン（案 2）、入れると作り直されるボタン（案 1）も見届ける（両方の Chromium）。
// - DEF-295: 押す 1 手が待ち続けた形（覆う・隠す・画面の外で動く・radio の上の飾り）に、見張りの長さでなく押す前の準備の確かめの理由を付け、読み込みを
//   増やさない（両方の Chromium）。
// - どの場面でも、サーバに届いた読み取りでない要求は 0（名前つきの時間だけ待ってから数える）。
// Chromium はテストの既定だけ（TEST-POLICY の 3）。監査の段の送信の扱いは PASS_EXCEPT_DELETE（本番の既定）と READ_ONLY。順に動かす（同時には動かさない）。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { wait } from '../../src/core/deadline.js';
import { observationWindowsOf, PRODUCTION_OBSERVATION_WINDOWS } from '../../src/core/observation-windows.js';
import { PROGRESS_WATCH_QUIET_LIMIT_MS } from '../../src/core/progress-watch.js';
import { OPEN_DATA_REQUEST_QUIET_MS } from '../../src/browser/page-settling.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { discoverPageCandidates, settleAndFreezePage } from '../../src/discovery/discover-page.js';
import { discoveryCandidatesOf, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { InFlightRequestCounter, type DiscoverySettlePolicy } from '../../src/discovery/settle.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { BOTH_CHROMIUM_LAUNCHERS, DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { probeQuietWindowsOf } from '../helpers/test-waits.js';

const TEST_TIMEOUT_MS = 240_000;
/** 押した後に静まるまで待つ時間（ms。テストの値）。 */
const SHORT_QUIET_WAIT_MS = 500;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 200;
/** 遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 2_000;
/** 前の読み取りの期限（`DISCOVERY_READ_TIMEOUT_MS`・`SUBMISSION_PROBE_READ_TIMEOUT_MS`）と、前の 1 手の期限（`SUBMISSION_PROBE_STEP_TIMEOUT_MS`）。 */
const FORMER_READ_LIMIT_MS = 10_000;
const FORMER_STEP_LIMIT_MS = 5_000;
/** 読み取りをふさぐ長さ（前の読み取りの期限を超える）と、押す呼び出しをふさぐ長さ（前の 1 手の期限を超える）。 */
const SLOW_READ_BLOCK_MS = 15_000;
const SLOW_PRESS_BLOCK_MS = 8_000;
/** テストで注入する、見張りの反応なしの長さ（前の期限と遅れより長い）。 */
const INJECTED_QUIET_LIMIT_MS = 25_000;
/** 全く反応のない画面の場面で注入する、見張りの反応なしの長さと、ページをふさぐ長さ（見張りの長さより十分に長い）。 */
const UNRESPONSIVE_QUIET_LIMIT_MS = 8_000;
const UNRESPONSIVE_BLOCK_MS = 40_000;
/** 落ち着きの待ち（テストの値。ふさいだ画面では読めないので短くして、読み取りの期限の場面に早く入る）。 */
const SHORT_SETTLE_POLICY: DiscoverySettlePolicy = Object.freeze({ timeoutMs: 500, networkQuietMs: 100, pollIntervalMs: 50, probeIntervalMs: 100 });
const IDENTITY_API_PATH = '/api/items';
/** DEF-290: サーバが答えない（接続を開いたままにする）要求の path。 */
const LONG_REQUEST_PATH = '/api/long';
/** REV-DQF の Important-B: 答えの遅い読み取りの path と、答えるまでの長さ（開いた要求の静まりの本番の長さより長い）。 */
const SLOW_ANSWER_PATH = '/api/slow';
const SLOW_ANSWER_MS = OPEN_DATA_REQUEST_QUIET_MS * 4;
/** REV-DQF: 押したときにページが出す読み取りの path（押した回数を数える）。 */
const PRESS_HIT_PATH = '/api/hit/save';

// TEST-POLICY の 3: 2 つの Chromium で流すのは安全の漏れの確かめだけなので、この振る舞いの場面は既定の Chromium だけで流す。
const CASES = DEFAULT_CHROMIUM_LAUNCHERS.flatMap(([label, launch]) =>
  (['PASS_EXCEPT_DELETE', 'READ_ONLY'] as const).map((sendPolicy) => [`${label}, ${sendPolicy}`, launch, sendPolicy] as const));

const htmlOf = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>`
  + `<link rel="icon" href="data:,"></head><body>${body}</body></html>`;
/** ページをふさぐ受け手（同期の繰り返しで main thread を使い続ける）。 */
const blockFor = (ms: number): string => `const end = Date.now() + ${String(ms)}; while (Date.now() < end) { /* ふさぐ */ }`;
const SAVE_FETCH = `fetch('${IDENTITY_API_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('name').value }) }).catch(() => {});`;
/** DEF-295: 欄の id のない画面の送信（中身は決まった値）。 */
const PLAIN_SAVE_FETCH = `fetch('${IDENTITY_API_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1 }) }).catch(() => {});`;
/** REV-DQWF: ページが送る削除（凍結が止める。止めなければサーバに届く）。 */
const DELETE_FETCH = `fetch('${IDENTITY_API_PATH}/1', { method: 'DELETE' }).catch(() => {});`;
/** DEF-295: 押す事象（pointerdown・mousedown・click）を受けたときにページが出す読み取りの path。 */
const PRESS_EVENT_PATH = '/api/hit/down';
/** DEF-295: テストで注入する、押す前の準備の確かめの窓（開いた要求の静まりの長さ `pageSettle.openDataRequestQuietMs`）。 */
const READY_CHECK_MS = 1_000;
/** QUIET-1: 外れた欄の要素が戻ったら、ページが出す読み取りの path（見放した入力が後から入ったら届く）。 */
const LATE_FILL_PATH = '/api/hit/late-fill';
/** QUIET-1: 外れた欄が戻るまでの長さ（見放す確かめの窓 `pageSettle.stableWindowMs` より十分に長い）。 */
const FIELD_RETURN_MS = PRODUCTION_OBSERVATION_WINDOWS.pageSettle.stableWindowMs * 3;
/** QUIET-3: 枠の手続きの呼び出しの path。 */
const FRAME_CALL_PATH = '/api/rpc/notice';
/** QUIET-3: 3 つの form（保存・登録・更新）。 */
const FRAME_FORMS = ['保存', '登録', '更新'].map((word, at) => `<form onsubmit="return false"><label>${word}の名前 <input name="n${String(at)}"></label>`
  + `<button type="button">${word}</button></form>`).join('');
const READY_CHECK_WINDOWS = observationWindowsOf({ afterPress: { probeQuietWaitMs: SHORT_QUIET_WAIT_MS }, pageSettle: { openDataRequestQuietMs: READY_CHECK_MS } });

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  // 読み取りの場面: テストが凍結の後にふさぐ（ページの作りは普通の登録の画面）。
  '/slow-read': htmlOf('read', `<main><h1>登録</h1><form method="post" action="/items"><label>名前 <input name="name"></label><button type="submit">登録</button></form></main>`),
  // 押す呼び出しに 8 秒かかる画面: 保存の受け手が 8 秒ふさいでから送る。
  '/slow-press': htmlOf('press', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></main>
<script>document.getElementById('save').addEventListener('click', () => { ${blockFor(SLOW_PRESS_BLOCK_MS)} ${SAVE_FETCH} });</script>`),
  // 全く反応のない画面: 保存は普通に送る。登録は押すとページを長くふさぐ（保存の後に押す。同じ段の中は文書の順）。
  '/stuck': htmlOf('stuck', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button>
<button type="button" id="create">登録</button></main>
<script>document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });
document.getElementById('create').addEventListener('click', () => { ${blockFor(UNRESPONSIVE_BLOCK_MS)} });</script>`),
  // 押す 1 手が返らない画面（ページは応答する）: 保存を押すと、画面全体を覆う枠が出て、次の登録の押下は的に届かない（Playwright の押す 1 手が待ち続ける）。
  '/covered': htmlOf('covered', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button>
<button type="button" id="create">登録</button></main>
<script>document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH}
  const cover = document.createElement('div'); cover.style.cssText = 'position:fixed;inset:0;z-index:99;background:transparent'; document.body.append(cover); });
document.getElementById('create').addEventListener('click', () => {});</script>`),
  // L6/L3-1 の続き（A1）: 一覧の「編集」でモーダルの窓が開き、窓の中の「保存」で送る画面。窓が開いた後の段で、窓の後ろの「編集」は覆われていて押せない。
  '/modal': htmlOf('modal', `<main><h1>一覧</h1><table><tr><td>行</td><td><button type="button" id="edit">編集</button></td></tr></table>
<dialog id="dlg"><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></dialog></main>
<script>document.getElementById('edit').addEventListener('click', () => { document.getElementById('dlg').showModal(); });
document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} document.getElementById('dlg').close(); });</script>`),
  // L6/L3-1 の続き（A1）: 保存のボタンの中心だけを、小さな印の表示が覆う画面（四隅は押せる）。
  '/partly-covered': htmlOf('partly', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label>
<div style="position:relative;display:inline-block"><button type="button" id="save" style="width:160px;height:48px">保存</button>
<span style="position:absolute;left:70px;top:14px;width:20px;height:20px;background:#c00;border-radius:10px"></span></div></main>
<script>document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  // DEF-289 の案 2: 動き続ける（大きさが変わり続ける）保存のボタン。
  '/moving': htmlOf('moving', `<style>@keyframes pulse { 50% { transform: scale(1.2); } } #save { animation: pulse 1s infinite; }</style>
<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></main>
<script>document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  // DEF-289 の案 1: 欄に入れると、ボタンの要素を作り直す画面。保存は最初の 1 回だけ、登録は入れるたびに作り直す。
  '/redrawn': htmlOf('redrawn', `<main><h1>登録</h1>
<label>名前 <input id="name" name="name"></label><span id="sa"><button type="button" class="save">保存</button></span>
<label>件名 <input id="title" name="title"></label><span id="sb"><button type="button">登録</button></span></main>
<script>let redrawn = false; const redraw = (id) => { const box = document.getElementById(id); box.innerHTML = box.innerHTML; };
document.getElementById('name').addEventListener('input', () => { if (!redrawn) { redrawn = true; redraw('sa'); } });
document.getElementById('title').addEventListener('input', () => redraw('sb'));
document.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('.save') !== null) { ${SAVE_FETCH} } });</script>`),
  // REV-DQF の Important-1: 入れると透明な覆いが出て（押す 1 手が待つ）、少し後に保存のボタンが一時だけ文書から外れて同じ要素で戻り、その後に覆いが消える。
  // 押した回数は、押したときの読み取り（`/api/hit/save`）で数える。
  '/blink-covered': htmlOf('blink', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label>
<div style="position:relative;display:inline-block"><button type="button" id="save" style="width:160px;height:48px">保存</button></div></main>
<script>let armed = false; const save = document.getElementById('save');
const blink = (element) => { const parent = element.parentNode; const next = element.nextSibling; element.remove(); setTimeout(() => parent.insertBefore(element, next), 160); };
document.getElementById('name').addEventListener('input', () => { if (armed) return; armed = true;
  const r = save.getBoundingClientRect(); const cover = document.createElement('div');
  cover.style.cssText = 'position:fixed;left:' + (r.left - 5) + 'px;top:' + (r.top - 5) + 'px;width:' + (r.width + 10) + 'px;height:' + (r.height + 10) + 'px;z-index:99;background:transparent';
  document.body.append(cover); setTimeout(() => blink(save), 600); setTimeout(() => cover.remove(), 1000); });
save.addEventListener('click', () => { fetch('${PRESS_HIT_PATH}').catch(() => {}); ${SAVE_FETCH} });</script>`),
  // REV-DQF の Important-A: mousedown で送り、同時に押せない状態にするボタン（click は出ない）と、window の capture で click を先に受けて止め、自分で送る画面。
  '/mousedown-send': htmlOf('mousedown', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></main>
<script>const save = document.getElementById('save');
save.addEventListener('mousedown', () => { ${SAVE_FETCH} save.disabled = true; setTimeout(() => { save.disabled = false; }, 3000); });</script>`),
  '/window-capture': htmlOf('capture', `<script>window.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.id === 'save') { ${SAVE_FETCH} event.stopImmediatePropagation(); } }, true);</script>
<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></main>`),
  // REV-DQF の Important-B: 読み込みの後の読み取りの答えが遅く（静まりの長さより長い）、答えで登録の form を描く画面。
  '/slow-answer': htmlOf('slow', `<main><h1>一覧</h1><div id="host"></div></main>
<script>fetch('${SLOW_ANSWER_PATH}').then((response) => response.json()).then(() => {
  document.getElementById('host').innerHTML = '<label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button>';
  document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} }); });</script>`),
  // REV-DQF fix round 3: 共通の枠の形。2 つの画面が、読み込みの時に同じ答えない送り先を出す（1 つ目の画面から 2 つ目へのリンク）。
  '/shared-first': htmlOf('first', `<main><h1>登録</h1><a href="/shared-second">次</a><label>名前 <input id="name" name="name"></label>
<button type="button" id="save">保存</button></main>
<script>fetch('${LONG_REQUEST_PATH}').catch(() => {}); document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  '/shared-second': htmlOf('second', `<main><h1>更新</h1><label>名前 <input id="name" name="name"></label>
<button type="button" id="save">更新</button></main>
<script>fetch('${LONG_REQUEST_PATH}').catch(() => {}); document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  // DEF-290: 読み込みの時に、サーバが答えない要求を 1 つ出す画面（長く開いたままの要求）。
  '/long-request': htmlOf('long', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></main>
<script>fetch('${LONG_REQUEST_PATH}').catch(() => {});
document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  // DEF-289 の案 3・DEF-295: 先に押す保存は、画面の外で動き続ける（押す 1 手が待ち続ける形）。後の登録は普通に送る。保存が押す事象を受けたら、読み取りで知らせる。
  '/stopped-step': htmlOf('stopped', `<style>@keyframes pulse { 50% { transform: scale(1.2); } } #far { position: absolute; top: 3000px; animation: pulse 1s infinite; }</style>
<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="far">保存</button><button type="button" id="create">登録</button></main>
<script>const far = document.getElementById('far'); far.addEventListener('click', () => { ${SAVE_FETCH} });
for (const type of ['pointerdown', 'mousedown', 'click']) far.addEventListener(type, () => { fetch('${PRESS_EVENT_PATH}').catch(() => {}); });
document.getElementById('create').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  // DEF-295: 3 つの form のすべてで、欄に入れると候補の一覧がボタンを覆う（押す 1 手が待ち続ける形）。
  '/multi-all-cover': htmlOf('multi', `<main><h1>登録</h1>${['保存', '登録', '更新'].map((word, at) => `<form class="f" onsubmit="return false"><label>${word}の名前 <input name="n${String(at)}"></label>`
    + `<div style="position:relative"><div class="list" style="display:none;position:absolute;left:0;top:0;width:400px;height:60px;background:#fff;z-index:9">候補</div>`
    + `<button type="button" style="width:160px;height:40px">${word}</button></div></form>`).join('')}</main>
<script>document.querySelectorAll('.f').forEach((f) => { f.querySelector('input').addEventListener('input', () => { f.querySelector('.list').style.display = 'block'; }); });
document.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('button')) { ${PLAIN_SAVE_FETCH} } });</script>`),
  // DEF-295: 選択肢の radio の上に透明な飾りが重なる（radio を押す 1 手が待ち続ける形）。ほかに 2 つのボタン。
  '/radio-overlay': htmlOf('radio', `<main><h1>登録</h1><form onsubmit="return false"><label>名前 <input name="name"></label>
<span style="position:relative;display:inline-block"><input type="radio" name="kind" value="a" checked><span style="position:absolute;inset:-4px;z-index:2"></span></span>A
<span style="position:relative;display:inline-block"><input type="radio" name="kind" value="b"><span style="position:absolute;inset:-4px;z-index:2"></span></span>B
<button type="button">保存</button></form><div><button type="button">登録</button></div><div><button type="button">更新</button></div></main>
<script>document.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('button')) { ${PLAIN_SAVE_FETCH} } });</script>`),
  // DEF-295: 欄に入れると、候補の一覧がボタンを覆う画面と、ボタンが見えなくなる画面。
  '/fill-cover': htmlOf('fillcover', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><div style="position:relative">
<div id="list" style="display:none;position:absolute;left:0;top:0;width:400px;height:200px;background:#fff;z-index:9">候補</div><button type="button" id="save" style="width:160px;height:48px">保存</button></div></main>
<script>document.getElementById('name').addEventListener('input', () => { document.getElementById('list').style.display = 'block'; });
document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  '/fill-hide': htmlOf('fillhide', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></main>
<script>document.getElementById('name').addEventListener('input', () => { document.getElementById('save').style.visibility = 'hidden'; });
document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  // DEF-295: 大きく横に動き続けるボタンと、普通のボタン（今どおり押せる）。
  '/moving-far': htmlOf('movingfar', `<style>@keyframes slide { 0% { transform: translateX(0) } 50% { transform: translateX(300px) } 100% { transform: translateX(0) } } #save { animation: slide 0.8s infinite linear; }</style>
<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></main>
<script>document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  // QUIET-1: 1 つ目の form は、名前の欄に入れるとメモの欄を作り直す（新しい要素）。2 つ目の form の件名の欄は、最初に focus を受けると文書から外れ、窓の長さより
  // 後に同じ要素で戻る（その欄に値が入ると、読み取りで知らせる）。時刻の表示で、画面は動き続ける。
  '/field-redrawn': htmlOf('fieldredrawn', `<main><h1>登録</h1><p id="clock"></p>
<form id="fa" onsubmit="return false"><label>名前 <input name="name"></label><label>メモ <input name="memo"></label><button type="button">保存</button></form>
<form id="fb" onsubmit="return false"><label>件名 <input name="title"></label><button type="button">登録</button></form></main>
<script>const fa = document.getElementById('fa');
fa.querySelector('input[name=name]').addEventListener('input', () => { const m = fa.querySelector('input[name=memo]'); m.replaceWith(m.cloneNode(true)); });
const title = document.querySelector('input[name=title]'); const holder = title.parentNode; let moved = false;
title.addEventListener('input', () => { fetch('${LATE_FILL_PATH}').catch(() => {}); });
title.addEventListener('focus', () => { if (moved) return; moved = true; title.remove(); setTimeout(() => holder.append(title), ${String(FIELD_RETURN_MS)}); });
document.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('button')) { ${PLAIN_SAVE_FETCH} } });
setInterval(() => { document.getElementById('clock').textContent = String(Date.now()); }, 1000);</script>`),
  // QUIET-1: 欄に入れると、送信ボタンが文書から外れて戻らない。時刻の表示で、画面は動き続ける。
  '/submitter-gone': htmlOf('submittergone', `<main><h1>登録</h1><p id="clock"></p><form onsubmit="return false"><label>名前 <input name="name"></label>
<button type="button" id="save">保存</button></form></main>
<script>document.querySelector('input[name=name]').addEventListener('input', () => { document.getElementById('save')?.remove(); });
document.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('button')) { ${PLAIN_SAVE_FETCH} } });
setInterval(() => { document.getElementById('clock').textContent = String(Date.now()); }, 1000);</script>`),
  // QUIET-3: どの画面にもある枠が、読み込みの時と押下のたびに、手続きの呼び出し（POST）を 1 回出す画面（凍結の中では止まる）。保存と登録は普通に送る。
  '/frame-call': htmlOf('framecall', `<main><h1>登録</h1>${FRAME_FORMS}</main>
<script>const call = () => fetch('${FRAME_CALL_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
call(); document.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('button')) { ${PLAIN_SAVE_FETCH} call(); } });</script>`),
  '/plain': htmlOf('plain', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button></main>
<script>document.getElementById('save').addEventListener('click', () => { ${SAVE_FETCH} });</script>`),
  // REV-DQWF の Important-1: 確かめの hover で、保存の語が「削除」に替わり、押すと削除を送る。
  '/hover-relabel-danger': htmlOf('relabel', `<main><h1>登録</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save" style="width:160px;height:48px">保存</button></main>
<script>const save = document.getElementById('save'); let armed = false; save.addEventListener('mouseover', () => { armed = true; save.textContent = '削除'; });
save.addEventListener('click', () => { if (armed) { ${DELETE_FETCH} } else { ${SAVE_FETCH} } });
for (const type of ['pointerdown', 'mousedown', 'click', 'pointerup', 'mouseup']) {
  save.addEventListener(type, () => { fetch('${PRESS_EVENT_PATH}?at=element').catch(() => {}); });
  window.addEventListener(type, () => { fetch('${PRESS_EVENT_PATH}?at=window').catch(() => {}); }, true);
}</script>`),
  // REV-DQWF の Minor-1: 保存に hover すると、画面全体のメニューが開いたまま残り、次の更新を覆う。
  '/hover-menu-cover': htmlOf('menucover', `<main><h1>登録</h1><form onsubmit="return false"><label>名前 <input name="a"></label><button type="button" id="b1" style="width:160px;height:40px">保存</button></form>
<form onsubmit="return false"><label>題名 <input name="b"></label><button type="button" id="b2" style="width:160px;height:40px">更新</button></form>
<div id="menu" style="display:none;position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:50;background:rgba(255,255,255,.01)"></div></main>
<script>document.getElementById('b1').addEventListener('mouseenter', () => { document.getElementById('menu').style.display = 'block'; });
for (const id of ['b1', 'b2']) document.getElementById(id).addEventListener('click', () => { ${PLAIN_SAVE_FETCH} });</script>`),
  // REV-DQWF の Minor-1: 保存に hover すると、保存が隠れ、次の form の状態を書き換える（その後の追加は削除を送る）。
  '/hover-mutate-next': htmlOf('mutatenext', `<main><h1>登録</h1><form onsubmit="return false"><label>名前 <input name="a"></label><button type="button" id="b1">保存</button></form>
<form onsubmit="return false"><label>題名 <input name="b"></label><button type="button" id="b2">追加</button></form></main>
<script>let dirty = false; document.getElementById('b1').addEventListener('mouseover', () => { document.getElementById('b1').style.visibility = 'hidden'; dirty = true; });
document.getElementById('b2').addEventListener('click', () => { if (dirty) { ${DELETE_FETCH} } else { ${PLAIN_SAVE_FETCH} } });
document.getElementById('b1').addEventListener('click', () => { ${PLAIN_SAVE_FETCH} });</script>`),
  // DEF-295（T-1）: 狭い画面用の複製（隠れた保存）と、見える保存。
  '/narrow-copy': htmlOf('narrow', `<main><h1>一覧</h1><div class="mobile" style="display:none"><button type="button">保存</button></div><div><button type="button">保存</button></div></main>
<script>document.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('button')) { ${PLAIN_SAVE_FETCH} } });</script>`),
});

/** 認証の指定（状態なし。ログインのない形）。 */
const authenticationOf = (origin: string): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: null,
  filterState: filterAuthenticatedState,
});

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('L6/L3-1: the discovery reads a slow page without the former read limit (%s)', (_label, launch) => {
  let browser: Browser;
  let server: LoopbackHttpServer;

  beforeAll(async () => {
    browser = await launch();
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const page = PAGES[new URL(request.url ?? '/', 'http://127.0.0.1').pathname];
      response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page ?? '');
    });
  });

  afterAll(async () => {
    await server?.close();
    await browser?.close();
  });

  it(`reads the candidates of a page whose read takes ${String(SLOW_READ_BLOCK_MS)} ms (more than the former ${String(FORMER_READ_LIMIT_MS)} ms)`, async () => {
    const config = createTestConfig(server.origin);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    try {
      const page = await factory.createPassivePage(context);
      const counter = new InFlightRequestCounter(page);
      await page.goto(`${server.origin}/slow-read`);
      expect((await settleAndFreezePage(page, { requestCounter: counter, settlePolicy: SHORT_SETTLE_POLICY })).status).toBe('FROZEN');
      // 凍結の後に、ページを 15 秒ふさぐ（次の読み取りは、ふさぎが終わるまで返らない）。
      await page.evaluate(`setTimeout(() => { ${blockFor(SLOW_READ_BLOCK_MS)} }, 0)`);
      const startedAt = Date.now();
      const record = await discoverPageCandidates(page, {
        classificationPolicy: { allowedOrigins: new Set([server.origin]) }, requestCounter: counter, settlePolicy: SHORT_SETTLE_POLICY, alreadyFrozen: true,
      });
      counter.dispose();
      // 読み取りは、前の期限を超えて待った。
      expect(Date.now() - startedAt).toBeGreaterThan(FORMER_READ_LIMIT_MS);
      expect(record.incompleteReasons).not.toContain('INCOMPLETE_READ_FAILED');
      expect(record.candidates.filter((candidate) => candidate.kind === 'FORM')).toHaveLength(1);
    } finally {
      await closePassiveResources({ factory, context });
      await factory.close();
    }
  }, TEST_TIMEOUT_MS);
});

/**
 * 操作さがしの Run を 1 画面ずつ流す場（127.0.0.1 のサーバ・出力のフォルダ・Run・記録の読み方・届いた読み取りでない要求）。describe の中で呼ぶ（beforeAll と
 * afterAll を付ける）。DEF-289 の場面と共用する。
 */
const useDiscoveryRunSite = (launch: (typeof DEFAULT_CHROMIUM_LAUNCHERS)[number][1], sendPolicy: 'PASS_EXCEPT_DELETE' | 'READ_ONLY') => {
  let server: LoopbackHttpServer;
  let directory = '';
  const seen: { readonly method: string; readonly path: string }[] = [];

  beforeAll(async () => {
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      seen.push({ method: request.method ?? '', path: url.pathname });
      request.resume();
      // DEF-290: 答えない（サーバを閉じるときに接続を切る）。
      if (url.pathname === LONG_REQUEST_PATH) return;
      if (url.pathname === SLOW_ANSWER_PATH) {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
        }, SLOW_ANSWER_MS);
        return;
      }
      const page = PAGES[url.pathname];
      response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page ?? '');
    });
    directory = await mkdtemp(join(tmpdir(), 'beaksight-screen-watch-'));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
    if (directory !== '') await rm(directory, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  let runNumber = 0;
  const run = async (startPath: string, quietLimitMs: number, maxPages = 1, observationWindows = probeQuietWindowsOf(SHORT_QUIET_WAIT_MS)): Promise<DiscoveryDocument> => {
    runNumber += 1;
    const config = createTestConfig(server.origin, startPath, {
      crawl: { maxPages, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
      audit: { screenshots: false, sendPolicy },
      output: { directory: join(directory, `run-${String(runNumber)}`) },
    });
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-screen-watch-${String(runNumber)}`, authentication: authenticationOf(server.origin),
      launchBrowser: launch, clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      observationWindows, progressQuietLimitMs: quietLimitMs,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    const validation = await validateArtifact('discovery', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    return document;
  };
  const probeOf = (document: DiscoveryDocument, word: string) =>
    mergeDiscoveryCandidates(discoveryCandidatesOf(document)).find((candidate) => candidate.submitterWords.includes(word))?.submissionProbe;
  const nonReadsSince = async (since: number): Promise<readonly string[]> => {
    await wait(LATE_REQUEST_WAIT_MS);
    // QUIET-3: 枠の手続きの呼び出しは、読み込みの時（凍結の前）にページ自身が送る（監査の段の既定 PASS_EXCEPT_DELETE で通す送信）。その場面が数を確かめる。
    return seen.slice(since).filter(({ method, path }) => !READ_METHODS.has(method) && path !== FRAME_CALL_PATH).map(({ method, path }) => `${method} ${path}`);
  };
  return { seen, run, probeOf, nonReadsSince };
};

describe.each(CASES)('L6/L3-1: one progress watch per page in the discovery run (%s)', (_label, launch, sendPolicy) => {
  const { seen, run, probeOf, nonReadsSince } = useDiscoveryRunSite(launch, sendPolicy);

  it(`waits for a press call that takes ${String(SLOW_PRESS_BLOCK_MS)} ms (more than the former ${String(FORMER_STEP_LIMIT_MS)} ms) and records the shape`, async () => {
    const since = seen.length;
    const document = await run('/slow-press', INJECTED_QUIET_LIMIT_MS);
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('ends a page that does not respond at all as STAGE_UNRESPONSIVE, keeps the earlier press, and finishes the run', async () => {
    const since = seen.length;
    const startedAt = Date.now();
    const document = await run('/stuck', UNRESPONSIVE_QUIET_LIMIT_MS);
    // 見張りの長さで終えた（ページのふさぎが終わるのを待たない）。
    expect(Date.now() - startedAt).toBeLessThan(UNRESPONSIVE_BLOCK_MS);
    expect(document.endReason).toBe('COMPLETED');
    const page = document.pages.find((entry) => entry.state === 'READ');
    expect(page?.state === 'READ' ? page.record.incompleteReasons : []).toContain('STAGE_UNRESPONSIVE');
    // 前に押した保存の記録は残る。押しにかかった登録は「応答しなかった」。
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(probeOf(document, '登録')).toMatchObject({ result: 'NOT_OBSERVED', reason: 'STAGE_UNRESPONSIVE' });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // L6/L3-1 の続き（設計者の判断 A の案 A1）: モーダルの窓の後ろの「編集」は、押す前の hit-test で覆われていると分かるので押さず（待ち続けない）、窓の中の
  // 「保存」を押して型を取る。見張りの長さは本番の既定のまま（前は、窓の後ろの「編集」の押す 1 手が返らず、見張りの長さで画面を終えていた）。
  it('does not press the button behind a modal dialog and presses the save in the dialog without waiting for the watch', async () => {
    const since = seen.length;
    const startedAt = Date.now();
    const document = await run('/modal', PROGRESS_WATCH_QUIET_LIMIT_MS);
    expect(Date.now() - startedAt).toBeLessThan(PROGRESS_WATCH_QUIET_LIMIT_MS);
    expect(document.endReason).toBe('COMPLETED');
    const page = document.pages.find((entry) => entry.state === 'READ');
    expect(page?.state === 'READ' ? page.record.incompleteReasons : ['NOT_READ']).not.toContain('STAGE_UNRESPONSIVE');
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // L6/L3-1 の続き（A1）: 中心だけが覆われたボタンは、届く四隅の点を押して型を取る（中心の 1 点だけで判定すると、押さなくなる）。
  it('presses a save button whose centre only is covered, at a corner that the press reaches', async () => {
    const since = seen.length;
    const document = await run('/partly-covered', PROGRESS_WATCH_QUIET_LIMIT_MS);
    expect(document.endReason).toBe('COMPLETED');
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // 押す的が覆われた画面（ページは応答する）を、待ち続けずに終える。L6/L3-1 では、見張りの長さで終えることを確かめた（見回りを進みに数えると、待ち続けた）。
  // 案 A1 の後は、押す前の hit-test が覆われた的を押さないので、見張りの長さを待たずに終える。
  it('does not wait forever on a page whose press target is covered while the page itself keeps answering', async () => {
    const since = seen.length;
    const startedAt = Date.now();
    const document = await run('/covered', UNRESPONSIVE_QUIET_LIMIT_MS);
    expect(Date.now() - startedAt).toBeLessThan(UNRESPONSIVE_BLOCK_MS);
    expect(document.endReason).toBe('COMPLETED');
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    // 設計者の判断 A の案 A1 の後: 覆われた「登録」は、押す前の hit-test で覆われていると分かるので、押さずに次へ進む（押す 1 手を待ち続けない）。見回りを
    // 進みに数えない直しそのものは、単体テスト（`tests/unit/discovery-screen-watch.test.ts`）で確かめる。
    expect(probeOf(document, '登録')).toMatchObject({ result: 'NOT_OBSERVED', reason: 'COVERED_BY_OTHER' });
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// DEF-289（DQ の案 1・2・3）: 押す 1 手が返らなくなる画面でも、押下を見届ける。サーバに届くのは読み取りだけ（安全の確かめなので、両方の Chromium）。
describe.each(BOTH_CHROMIUM_LAUNCHERS)('DEF-289: presses that used to stop the page (%s)', (_label, launch) => {
  const { seen, run, probeOf, nonReadsSince } = useDiscoveryRunSite(launch, 'PASS_EXCEPT_DELETE');
  const stageEndsOf = (document: DiscoveryDocument): readonly string[] => document.pages.flatMap((entry) => (entry.state === 'READ'
    ? entry.record.incompleteReasons.filter((reason) => reason === 'STAGE_UNRESPONSIVE' || reason === 'STAGE_NEVER_QUIET') : []));

  it('案 2: presses a moving save button at a point it reaches, and records the shape without ending the page', async () => {
    const since = seen.length;
    const document = await run('/moving', UNRESPONSIVE_QUIET_LIMIT_MS);
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(stageEndsOf(document)).toEqual([]);
    expect(await nonReadsSince(since)).toEqual([]);
  });

  it('案 1: presses again a button that the page redrew once, and gives up a button that the page redraws every time', async () => {
    const since = seen.length;
    const document = await run('/redrawn', UNRESPONSIVE_QUIET_LIMIT_MS);
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(probeOf(document, '登録')).toMatchObject({ result: 'NOT_OBSERVED', reason: 'TARGET_VANISHED' });
    expect(stageEndsOf(document)).toEqual([]);
    expect(await nonReadsSince(since)).toEqual([]);
  });

  it('REV-DQF: presses once a save button that leaves the document for a moment and comes back as the same element', async () => {
    const since = seen.length;
    const document = await run('/blink-covered', UNRESPONSIVE_QUIET_LIMIT_MS);
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    const nonReads = await nonReadsSince(since);
    expect(seen.slice(since).filter(({ path }) => path === PRESS_HIT_PATH)).toHaveLength(1);
    expect(nonReads).toEqual([]);
  });

  it('REV-DQF Important-A: records the shape of a save that sends on mousedown, and of one that the page sends from a window capture listener', async () => {
    const since = seen.length;
    for (const path of ['/mousedown-send', '/window-capture']) {
      expect(probeOf(await run(path, UNRESPONSIVE_QUIET_LIMIT_MS), '保存'), path).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    }
    expect(await nonReadsSince(since)).toEqual([]);
  });

  it('REV-DQF Important-B: reads again after a slow read answers, and presses the save that the answer drew', async () => {
    const since = seen.length;
    const document = await run('/slow-answer', INJECTED_QUIET_LIMIT_MS);
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
  });

  it('REV-DQF fix round 3: waits for an unanswered request only on the first page that sends it, and reads the next page without waiting', async () => {
    const since = seen.length;
    const document = await run('/shared-first', UNRESPONSIVE_QUIET_LIMIT_MS, 2);
    const reasonsOf = (path: string): readonly string[] | undefined => document.pages.flatMap((entry) =>
      (entry.state === 'READ' && entry.record.location?.path === path ? [entry.record.incompleteReasons] : []))[0];
    // 1 つ目の画面は、新しい送り先の答えを見張りの中で待ち、答えないので理由を付けて進む。2 つ目の画面は、同じ送り先を待たない（理由も付かない）。
    expect(reasonsOf('/shared-first')).toContain('INCOMPLETE_SETTLE_TIMEOUT');
    expect(reasonsOf('/shared-second')).toEqual([]);
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(probeOf(document, '更新')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
  });

  it('DEF-290: reads the candidates of a page whose load leaves a request unanswered, and records the shape of the save', async () => {
    const since = seen.length;
    const document = await run('/long-request', UNRESPONSIVE_QUIET_LIMIT_MS);
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(stageEndsOf(document)).toEqual([]);
    expect(await nonReadsSince(since)).toEqual([]);
  });

  // DEF-295 で、押す前の準備の確かめが、画面の外で動き続ける保存に、見張りの終わりでなく確かめの理由を付けるようになった（同じ文書のまま登録を押す）。
  // PREADY（設計書 `2026-11-25-beaksight-discovery-press-readiness-design.md` 2.1）: 中心が画面の外の保存も、1 回置き直してから判定するので、届く点の分かった
  // 動き続ける保存として押す（DEF-289 の案 2）。押している途中で見張りが終えたときに残りを読み込み直して押す形（案 3）は、単体で確かめる。
  it('DEF-295 and PREADY: presses a save that keeps moving off the screen after placing it once, and presses the rest in the same page', async () => {
    const since = seen.length;
    const document = await run('/stopped-step', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
    expect(document.endReason).toBe('COMPLETED');
    expect(stageEndsOf(document)).toEqual([]);
    expect(probeOf(document, '保存')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(probeOf(document, '登録')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(seen.slice(since).filter(({ method, path }) => method === 'GET' && path === '/stopped-step')).toHaveLength(1);
    expect(await nonReadsSince(since)).toEqual([]);
  });
});

// DEF-295（設計書 `doc/design/2026-11-19-beaksight-probe-wait-and-target-found-design.md` 2）: 押す前の準備の確かめ（押さずに確かめる呼び出しを、開いた要求の
// 静まりの長さで切る）と、覆いの確かめと置き直し。押す 1 手が待ち続けた画面でも、見張りの長さで止まらず、読み込みを増やさない。サーバに届くのは読み取りだけ
// （安全の確かめなので、両方の Chromium）。
describe.each(BOTH_CHROMIUM_LAUNCHERS)('DEF-295: presses that used to wait for the page watch (%s)', (_label, launch) => {
  const { seen, run, probeOf, nonReadsSince } = useDiscoveryRunSite(launch, 'PASS_EXCEPT_DELETE');
  const startedAt = seen.length;
  const pageOf = (document: DiscoveryDocument) => document.pages.find((entry) => entry.state === 'READ');
  const stageEndsOf = (document: DiscoveryDocument): readonly string[] => {
    const page = pageOf(document);
    return page?.state === 'READ' ? page.record.incompleteReasons.filter((reason) => reason === 'STAGE_UNRESPONSIVE' || reason === 'STAGE_NEVER_QUIET') : ['NOT_READ'];
  };
  const loadsOf = (since: number, path: string): number => seen.slice(since).filter(({ method, path: seenPath }) => method === 'GET' && seenPath === path).length;
  const probesOf = (document: DiscoveryDocument, word: string) => {
    const page = pageOf(document);
    return (page?.state === 'READ' ? page.record.candidates : []).filter((candidate) => candidate.submitterWords.includes(word)).map(({ submissionProbe }) => submissionProbe);
  };

  // PSKIP: 置き直しても覆われた対象は、確かめ（hover）を呼ばずに即決する。hover の名残がないので、読み込み直さない（読み込みは 1 回）。
  it('gives each covered target the reason of the ready check, without a reload, without waiting for the page watch', async () => {
    const since = seen.length;
    const document = await run('/multi-all-cover', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
    expect(stageEndsOf(document)).toEqual([]);
    expect(loadsOf(since, '/multi-all-cover')).toBe(1);
    for (const word of ['保存', '登録', '更新']) expect(probeOf(document, word), word).toMatchObject({ result: 'NOT_OBSERVED', reason: 'COVERED_BY_OTHER' });
    expect(await nonReadsSince(since)).toEqual([]);
  });

  // 止まるのは選択肢の確かめの radio の 1 手だけ（選ばずに終える）。押す対象には理由を付けず、全部を押す（前は残りの全部が見張りの理由になった）。
  it('stops only the choice of the covered radio, and presses every target', async () => {
    const since = seen.length;
    const document = await run('/radio-overlay', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
    expect(stageEndsOf(document)).toEqual([]);
    expect(loadsOf(since, '/radio-overlay')).toBe(1);
    for (const word of ['保存', '登録', '更新']) expect(probeOf(document, word), word).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
  });

  it('gives a button that a fill covers or hides the reason of the ready check, not the end of the page watch', async () => {
    const since = seen.length;
    for (const [path, reason] of [['/fill-cover', 'COVERED_BY_OTHER'], ['/fill-hide', 'TARGET_NOT_VISIBLE']] as const) {
      const document = await run(path, UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
      expect(stageEndsOf(document), path).toEqual([]);
      expect(probeOf(document, '保存'), path).toMatchObject({ result: 'NOT_OBSERVED', reason });
    }
    expect(await nonReadsSince(since)).toEqual([]);
  });

  it('presses a button that keeps moving far and a plain button as before', async () => {
    const since = seen.length;
    for (const path of ['/moving-far', '/plain']) {
      expect(probeOf(await run(path, UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS), '保存'), path).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    }
    expect(await nonReadsSince(since)).toEqual([]);
  });

  it('T-1: gives a hidden copy for a narrow screen a reason apart from TARGET_NOT_FOUND, and presses the shown one', async () => {
    const since = seen.length;
    const probes = probesOf(await run('/narrow-copy', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS), '保存');
    expect(probes.map((probe) => probe?.reason ?? probe?.shape?.method)).toEqual(['TARGET_NOT_VISIBLE', 'POST']);
    expect(await nonReadsSince(since)).toEqual([]);
  });

  it('REV-DQWF Important-1: judges a delete after the ready check, and does not press a save that the hover of the check relabelled to delete', async () => {
    const since = seen.length;
    const document = await run('/hover-relabel-danger', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
    expect(probeOf(document, '保存')).toMatchObject({ result: 'NOT_OBSERVED', reason: 'DESTRUCTIVE_ACTION_SKIPPED' });
    expect(await nonReadsSince(since)).toEqual([]);
    // DEF-299: 確かめは押す事象（pointerdown・mousedown・click・pointerup・mouseup）を、要素にも window の capture の受け手にも出さない（押していないので、
    // 届いた事象は確かめのもの）。
    expect(seen.slice(since).filter(({ path }) => path === PRESS_EVENT_PATH)).toEqual([]);
  });

  it('REV-DQWF Minor-1: presses in a reloaded page the target that the hover of a failed check left covered or changed', async () => {
    const since = seen.length;
    const covered = await run('/hover-menu-cover', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
    expect(probeOf(covered, '更新')).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    // 前の対象の hover が別の form を書き換える形は、既知の違い（追加の分類が変わりうる）。ページの削除は凍結が止め、サーバに届かない。
    const mutated = await run('/hover-mutate-next', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
    expect(mutated.endReason).toBe('COMPLETED');
    expect(probeOf(mutated, '追加')?.result).toBeDefined();
    expect(await nonReadsSince(since)).toEqual([]);
  });

  // QUIET-1（設計書 `doc/design/2026-11-24-beaksight-discovery-stuck-step-design.md` 2.1）: 欄やボタンが文書から消えた押下は、消えた要素を待たずに見放し、見張りで
  // 画面を終えない（読み込み直さない）。見放した入力は、同じ要素が戻っても後から入らない。
  it('QUIET-1: gives up a press whose field or button left the document, without the page watch, and never types into a field that came back later', async () => {
    const since = seen.length;
    const fields = await run('/field-redrawn', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
    expect(stageEndsOf(fields)).toEqual([]);
    expect(loadsOf(since, '/field-redrawn')).toBe(1);
    for (const word of ['保存', '登録']) expect(probeOf(fields, word), word).toMatchObject({ result: 'NOT_OBSERVED' });
    const buttonSince = seen.length;
    const button = await run('/submitter-gone', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
    expect(stageEndsOf(button)).toEqual([]);
    expect(loadsOf(buttonSince, '/submitter-gone')).toBe(1);
    expect(await nonReadsSince(since)).toEqual([]);
    expect(seen.slice(since).filter(({ path }) => path === LATE_FILL_PATH)).toEqual([]);
  });

  // QUIET-3（設計書 2.3 と設計変更履歴の 2 行目）: 枠が押下の窓の外（読み込みの時）でも出す手続きの呼び出しは、押下の送信の形にしない（保存の形を記録する）。
  it('QUIET-3: records the shape of the save, not the procedure call that the shared frame also sends outside the presses', async () => {
    const since = seen.length;
    const called = await run('/frame-call', UNRESPONSIVE_QUIET_LIMIT_MS, 1, READY_CHECK_WINDOWS);
    for (const word of ['保存', '登録', '更新']) expect(probeOf(called, word), word).toMatchObject({ shape: { method: 'POST', pathShape: IDENTITY_API_PATH } });
    expect(await nonReadsSince(since)).toEqual([]);
    // 届いた枠の呼び出しは、読み込みの時の分だけ（押下の後の呼び出しは凍結が止めた）。
    expect(seen.slice(since).filter(({ path }) => path === FRAME_CALL_PATH)).toHaveLength(loadsOf(since, '/frame-call'));
  });

  it('no non-read request reached the server across all the runs (checked again after the named wait)', async () => {
    expect(await nonReadsSince(startedAt)).toEqual([]);
  });
});

// 操作さがし（発見の probe の押下）の場面を、127.0.0.1 の仮のサイトで確かめる結合テスト（SLIM BD-1。前の discovery-probe-frozen-read・
// discovery-probe-press-order・discovery-probe-blocked-move・def-213-probe-local-scheme-move・def-226-array-key-probe・def-144-probe-page-change を 1 つに
// まとめた）。送信の扱いは本番の既定の PASS_EXCEPT_DELETE（発見の凍結の中は扱いによらず何も送らない。READ_ONLY の回は外した）。
// - 両方の Chromium に広げる 1 場面（`PROBE_SCENE_LAUNCHERS`。遅い組では CLI の起動の設定の 1 つ）: DEF-208-1 の「凍結の後は GET だけが届き、書き込み・削除・上書き・
//   危険なパス・読まないパス・認証情報を含む URL は届かない」。
// - ほかは 1 回だけ（組の先頭の回）:
//   - DEF-208-1 場面 B: 保存の前に GET の答えを待つ編集の画面。GET は通り、PATCH は届かず、形は API_UPDATE。
//   - DEF-208-2: 押せないボタンを押さない（場面 C）、DEF-214 必須の欄で押せるようになる保存、入れた後に押せなくなるボタン（Important-1・Minor-A）。押す順の
//     決めは単体（`submission-probe-contracts.test.ts` の DEF-142・DEF-208-2）。同じ語の組の 2 つ目を押さない場面 A は、RB-13 で偽の口の単体
//     （`submission-probe-loop.test.ts`）へ移した。
//   - DEF-208-3 G: 「編集」の押下で止めた移動の先を、移った先の画面の候補として受ける（移り方ごと）。移った先の文書は届かない。
//   - DEF-213: 押下で main frame を不正な blob・data: へ移す失敗は違反にしない（Passive の読み込みの後も）。届くのは画面の読み込みだけ。
//   - DEF-226: 配列の鍵の要素と目印を probe の形に記録し、何も送らない。
//   - DEF-144・DEF-145（発見の本物の流れ `executeDiscoveryRun`、READ の確かめ `executeReadCheckRun`）: 違反の中身が discovery.json・read-evidence.json と
//     FINISHED の要約に残り、目印と query の値が出ない。外部スキームのボタンを押さない。取り消された移動で発見を止めない。外部スキームの判定は単体
//     （`external-navigation-scheme.test.ts`・`special-scheme-links.test.ts`）。
// - サーバに届いた要求はサーバの記録で数え、名前つきの時間だけ待って数え直す。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { WORKER_PROTOCOL_VERSION, validateWorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { submissionProbeKeyFieldsOf } from '../../src/discovery/submission-probe-contracts.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger, type SafetyLedgerSnapshot } from '../../src/safety/safety-ledger.js';
import { toDiscoveryFinished, toReadCheckFinished } from '../../src/worker/audit-worker-session.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { BOTH_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { createGateFactory, withGuardedPassivePage } from '../helpers/gate-harness.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import {
  PROBE_SCENE_BROKEN_PATH,
  PROBE_SCENE_EXCLUDED_PATH,
  PROBE_SCENE_LAUNCHERS,
  PROBE_SCENE_QUIET_WAIT_MS,
  nonReadHitsOf,
  probeResultOfWord,
  probeSceneOf as probeSceneWithPolicyOf,
  settleProbeSceneSite,
  startProbeSceneSite,
  type ProbeSceneSite,
} from '../helpers/probe-scene-site.js';
import { createTestConfig } from '../helpers/test-config.js';
import { probeQuietWindowsOf } from '../helpers/test-waits.js';

const TEST_TIMEOUT_MS = 120_000;
const SEND_POLICY = 'PASS_EXCEPT_DELETE';

const probeSceneOf = (browser: Browser, site: ProbeSceneSite, path: string, onOpenerPageChanged?: (url: string) => void): ReturnType<typeof probeSceneWithPolicyOf> =>
  probeSceneWithPolicyOf(browser, site, path, { sendPolicy: SEND_POLICY, ...(onOpenerPageChanged === undefined ? {} : { onOpenerPageChanged }) });

const egressFrozenRejectionsOf = (ledger: SafetyLedgerSnapshot): string[] => ledger.blockedInteractionRequests
  .filter(({ reason }) => reason === 'INTERACTION_FROZEN_EGRESS')
  .map(({ method, url }) => `${method} ${url}`);

// ---------- DEF-208-1 の画面（`API` は fetch の宛先の Origin。ページの JS が置き換える） ----------

const FROZEN_READ_PAGES: Readonly<Record<string, string>> = Object.freeze({
  // 場面 B: 保存の前に読み取り（GET）の答えを待つ編集の画面。
  '/scene-b': `<main><h1>編集</h1><input id="title" name="title" value="old"><button type="button" id="save">保存</button><p id="msg"></p></main>
<script>document.getElementById('save').addEventListener('click', async () => {
  try { const r = await fetch(API + '/api/check?slug=' + encodeURIComponent(document.getElementById('title').value)); if (!r.ok) throw new Error('x');
    await fetch(API + '/api/items/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: document.getElementById('title').value }) });
  } catch { document.getElementById('msg').textContent = 'error'; } });</script>`,
  // 安全: 押すと、読み取りと、止めるべき送信をまとめて出す。最初の読み取りでない送信（POST）が観察の対象。
  '/scene-safety': `<main><h1>登録</h1><input id="title" name="title"><button type="button" id="save">保存</button><div id="slot"></div></main>
<script>document.getElementById('save').addEventListener('click', () => {
  const v = document.getElementById('title').value; const json = { 'content-type': 'application/json' };
  const go = (url, init) => fetch(url, init).catch(() => {});
  go(API + '/api/items', { method: 'POST', headers: json, body: JSON.stringify({ title: v }) });
  go(API + '/api/ok-read');
  go('/app-read');
  go(API + '/api/items/2', { method: 'PATCH', headers: json, body: '{}' });
  go(API + '/api/items/3', { method: 'PUT', headers: json, body: '{}' });
  go(API + '/api/items/4', { method: 'DELETE' });
  go(API + '/api/items/5', { method: 'POST', headers: { ...json, 'x-http-method-override': 'DELETE' }, body: '{}' });
  go(API + '/api/items/6?_method=DELETE', { method: 'POST', headers: json, body: '{}' });
  go(API + '/api/items/7', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_method=DELETE' });
  go(API + '/api/logout');
  go(API + '/api/delete-all');
  go(API + '${PROBE_SCENE_EXCLUDED_PATH}/rows');
  go(API + '${PROBE_SCENE_BROKEN_PATH}');
  go(OTHER + '/api/other-read');
  const withCredentials = API.replace('://', '://user:secret@');
  const img = document.createElement('img'); img.src = withCredentials + '/api/credential-image';
  const frame = document.createElement('iframe'); frame.src = withCredentials + '/api/credential-frame';
  document.getElementById('slot').append(img, frame);
});</script>`,
});

describe.each(PROBE_SCENE_LAUNCHERS)('DEF-208-1: after a probe press only the plain reads reach the server (%s)', (_name, launch) => {
  let browser: Browser;
  let site: ProbeSceneSite;

  beforeAll(async () => {
    site = await startProbeSceneSite(FROZEN_READ_PAGES, 'http');
    browser = await launch();
  });

  afterAll(async () => {
    await browser.close();
    await site.close();
  });

  it('safety: only the plain GETs reach the server; writes, deletes, overrides, dangerous and excluded paths and credentials do not', async () => {
    const outcome = await probeSceneOf(browser, site, '/scene-safety');
    await settleProbeSceneSite(site);
    expect(nonReadHitsOf(site.hits)).toEqual([]);
    const saveResult = probeResultOfWord(outcome.probed, '保存');
    const reached = site.hits.map((hit) => `${hit.method} ${hit.path}`);
    expect(reached.filter((line) => /logout|delete|private|credential|other:/u.test(line))).toEqual([]);
    expect(reached).toContain('GET /api/ok-read');
    expect(reached).toContain('GET app:/app-read');
    // 押して出た最初の読み取りでない送信の形は、今どおり記録される（届けない）。
    expect(saveResult.startsWith('NOT_OBSERVED')).toBe(false);
    expect(saveResult.startsWith('NO_REQUEST')).toBe(false);
    // 網の失敗で終わった、通した読み取りは違反にしない。
    expect(reached).toContain('GET /api/network-broken');
    expect(outcome.ledger.invariantViolations).toEqual([]);
    expect(egressFrozenRejectionsOf(outcome.ledger).filter((line) => line.includes('ok-read') || line.includes('app-read'))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// ---------- DEF-208-2 の画面 ----------

/** どの画面にもある枠（文字のあるボタン `count` 個と「ログアウト」、見えない「新規作成」「登録」）。 */
const frameOf = (count: number): string => `<nav id="side">${Array.from({ length: count }, (_value, index) => `<button type="button" class="menu">メニュー${index + 1}</button>`).join('')}
<button type="button" class="menu">ログアウト</button>
<div style="display:none"><button type="button" class="menu">新規作成</button><button type="button" class="menu">登録</button></div></nav>
<script>document.querySelectorAll('.menu').forEach((button) => button.addEventListener('click', () => { button.dataset.on = '1'; }));</script>`;

const PRESS_ORDER_PAGES: Readonly<Record<string, string>> = Object.freeze({
  // 場面 C: 本文が rich text で、本文が空の間は「保存」が押せない（disabled）。「登録」は `aria-disabled="true"`。
  '/scene-c': `${frameOf(3)}<main><h1>登録</h1><input id="q" name="q"><div id="editor" contenteditable="true" style="min-height:40px;border:1px solid"></div>
<button type="button" id="save" disabled>保存</button><button type="button" id="register" aria-disabled="true">登録</button></main>
<script>const editor = document.getElementById('editor'); const save = document.getElementById('save');
editor.addEventListener('input', () => { save.disabled = editor.textContent.trim() === ''; });
const send = () => fetch(API + '/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: document.getElementById('q').value, body: editor.innerHTML }) }).catch(() => {});
save.addEventListener('click', send);
document.getElementById('register').addEventListener('click', send);</script>`,
  // DEF-214: 必須の欄を入れると「保存」が押せるようになる登録の画面（入れる前は押せない）。
  '/scene-enabled-by-input': `<main><h1>登録</h1><input id="name" name="name" required><input id="note" name="note">
<button type="button" id="save" disabled>保存</button></main>
<script>const name = document.getElementById('name'); const save = document.getElementById('save');
name.addEventListener('input', () => { save.disabled = name.value.trim() === ''; });
save.addEventListener('click', () => { fetch(API + '/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.value, note: document.getElementById('note').value }) }).catch(() => {}); });</script>`,
  // SREV-1105-3 の Important-1: 押せないボタン 8 個と、押せるボタン 1 個。欄に入れるたびに、ページが GET と POST を送る。
  '/scene-disabled-many': `<main><h1>登録</h1><input id="title" name="title">
${['保存', '登録', '更新', '変更', 'save', 'update', 'register', 'change'].map((word, index) => `<button type="button" id="d${String(index)}" disabled>${word}</button>`).join('')}
<button type="button" id="ok">確定</button></main>
<script>let n = 0; document.getElementById('title').addEventListener('input', () => { n += 1;
  fetch(API + '/api/check?n=' + n).catch(() => {}); fetch(API + '/api/autosave-' + n, { method: 'POST', body: 'x' }).catch(() => {}); });
for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => { fetch(API + '/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: document.getElementById('title').value }) }).catch(() => {}); });</script>`,
  // SREV-1105-3 の Important-1 と再レビューの Minor-A: 入れる前は押せて、入れた後に押せなくなるボタン 5 つと、ずっと押せる「確定」。
  '/scene-inert-after': `<main><h1>登録</h1>
${['保存', '登録', '更新', '変更', 'save'].map((word, index) => `<form id="f${String(index)}"><input name="title${String(index)}"><button type="submit">${word}</button></form>`).join('')}
<form id="ok"><input name="title-ok"><button type="submit">確定</button></form></main>
<script>for (const form of document.querySelectorAll('form')) {
  form.querySelector('input').addEventListener('input', () => { if (form.id !== 'ok') form.querySelector('button').disabled = true; fetch(API + '/api/check?form=' + form.id).catch(() => {}); });
  form.addEventListener('submit', (event) => { event.preventDefault(); fetch(API + '/api/items', { method: 'POST', body: 'x' }).catch(() => {}); });
}</script>`,
});

// ---------- DEF-208-3 G・DEF-213・DEF-226 の画面 ----------

const EDIT_PATH = '/items/7';
const LIST_PATH = '/items';
const listWithEdit = (script: string): string =>
  `<main><h1>一覧</h1><table><tr><td>row</td><td><button type="button" id="edit">編集</button></td></tr></table></main>`
  + `<script>document.getElementById('edit').addEventListener('click', ${script});</script>`;

/** DEF-208-3 G: 「編集」の移り方ごとの一覧の画面。直す前に受けられなかったのは `window.open`。ほかは退行の確かめ。 */
const BLOCKED_MOVES = Object.freeze({
  href: listWithEdit(`() => { location.href = '${EDIT_PATH}'; }`),
  assign: listWithEdit(`() => { location.assign('${EDIT_PATH}'); }`),
  open: listWithEdit(`() => { window.open('${EDIT_PATH}', '_blank'); }`),
  delayed: listWithEdit(`() => { setTimeout(() => { location.href = '${EDIT_PATH}'; }, 300); }`),
  fetchThen: listWithEdit(`async () => { await fetch('/app-read'); location.href = '${EDIT_PATH}'; }`),
} as const);
type BlockedMoveKind = keyof typeof BLOCKED_MOVES;

/** 不正な blob（登録のない blob の URL）。画面の Origin の下。 */
const INVALID_BLOB = "'blob:' + location.origin + '/0b8c7d2e-0000-4000-8000-000000000000'";
/** DEF-213: 押し方ごとの一覧の画面と、押下の記録の期待（`<result> <reason>`）。 */
const LOCAL_SCHEME_MOVES = Object.freeze({
  invalidBlob: { page: listWithEdit(`() => { location.href = ${INVALID_BLOB}; }`), expected: 'NOT_OBSERVED PAGE_CHANGED' },
  data: { page: listWithEdit("() => { location.href = 'data:text/html,<p>x</p>'; }"), expected: 'NO_REQUEST null' },
  // SREV-1105-3 の場面: `data:` の窓を開いてから、不正な blob へ移る。
  dataPopupThenInvalidBlob: {
    page: listWithEdit(`() => { window.open('data:text/html,<p>x</p>'); setTimeout(() => { location.href = ${INVALID_BLOB}; }, 100); }`),
    expected: 'NOT_OBSERVED PAGE_CHANGED',
  },
} as const);
type LocalSchemeMoveKind = keyof typeof LOCAL_SCHEME_MOVES;

const NEW_RECORD_PATH = '/records/new';
const SAVE_WORD = '保存';
/** DEF-226: 新規登録の画面（直接の形）。保存で承認した API の Origin の `/api/records` へ XHR の POST（JSON）。 */
const ARRAY_KEY_PAGE = `<main><h1>記録の新規登録</h1><form id="f">
<label>題 <input name="title" id="title"></label>
<label>メモ <textarea name="notes" id="notes"></textarea></label>
<label>札 <input name="label" id="label"></label>
<label>根拠 <input name="basis" id="basis"></label>
<label>持ち主 <select name="holder" id="holder"><option value="">選ぶ</option><option value="u-1">一郎</option><option value="u-2">二郎</option></select></label>
<button type="submit">${SAVE_WORD}</button></form></main>
<script>
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault();
  const v = (id) => document.getElementById(id).value;
  const x = new XMLHttpRequest(); x.open('POST', API + '/api/records'); x.setRequestHeader('content-type', 'application/json');
  x.send(JSON.stringify({ notes: v('notes'), makers: [], holders: v('holder') ? [v('holder')] : [], basis: v('basis'), labels: v('label') ? [v('label')] : [], title: v('title') })); });
</script>`;

/** 1 回だけ流す場面の Chromium（組の先頭の回。`chromiumRunsOf` の決まり）。 */
const [ONCE_NAME, launchOnce] = PROBE_SCENE_LAUNCHERS[0] ?? ['', () => Promise.reject(new Error('no Chromium run'))];

describe(`the probe scenes of one press (${ONCE_NAME})`, () => {
  let browser: Browser;
  let site: ProbeSceneSite | undefined;

  beforeAll(async () => {
    browser = await launchOnce();
  });

  afterEach(async () => {
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await browser.close();
  });

  const openSite = async (pages: Readonly<Record<string, string>>): Promise<ProbeSceneSite> => {
    site = await startProbeSceneSite(pages, 'http');
    return site;
  };

  it('DEF-208-1 scene B: the save that waits for a GET is observed as an update and the PATCH never reaches the server', async () => {
    const opened = await openSite(FROZEN_READ_PAGES);
    const outcome = await probeSceneOf(browser, opened, '/scene-b');
    await settleProbeSceneSite(opened);
    expect(nonReadHitsOf(opened.hits)).toEqual([]);
    expect(probeResultOfWord(outcome.probed, '保存')).toBe('API_UPDATE null');
    expect(outcome.hitsAfterFreeze.filter((hit) => hit.method === 'GET' && hit.path.startsWith('/api/check'))).toHaveLength(1);
    // 中継の凍結の後の拒否が、通した読み取りでは起きない。
    expect(egressFrozenRejectionsOf(outcome.ledger).filter((line) => line.includes('/api/check'))).toEqual([]);
    expect(outcome.ledger.invariantViolations).toEqual([]);
    // 通した読み取りの数と、目印（欄に入れた値）を運んだ数（値と URL は持たない）。
    expect(outcome.pageLoad?.frozenReadRequests).toBe(1);
    expect(outcome.pageLoad?.frozenMarkerReadRequests).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('DEF-208-2 scene C: the disabled "save" and the aria-disabled "register" are not pressed', async () => {
    const opened = await openSite(PRESS_ORDER_PAGES);
    const { probed } = await probeSceneOf(browser, opened, '/scene-c');
    await settleProbeSceneSite(opened);
    expect(nonReadHitsOf(opened.hits)).toEqual([]);
    expect(probeResultOfWord(probed, '保存')).toBe('NOT_OBSERVED DISABLED_SUBMITTER');
    expect(probed.candidates.filter((candidate) => candidate.submitterWords.join('/') === '登録' && candidate.submissionProbe?.result !== undefined
      && candidate.submissionProbe.reason !== 'TARGET_NOT_FOUND').map(({ submissionProbe }) => submissionProbe?.reason)).toEqual(['DISABLED_SUBMITTER']);
    // 枠の文字のあるボタン 3 つを全部押す（どれも何も送らない。COV-1: 押す数の上限はない）。
    expect(probed.candidates.filter((candidate) => candidate.submitterWords.length === 0 && candidate.submissionProbe?.result === 'NO_REQUEST')).toHaveLength(3);
  }, TEST_TIMEOUT_MS);

  it('DEF-214: the save button that becomes enabled by the required input is filled and pressed', async () => {
    const opened = await openSite(PRESS_ORDER_PAGES);
    const { probed } = await probeSceneOf(browser, opened, '/scene-enabled-by-input');
    await settleProbeSceneSite(opened);
    expect(nonReadHitsOf(opened.hits)).toEqual([]);
    expect(probeResultOfWord(probed, '保存')).toBe('API_CREATE null');
  }, TEST_TIMEOUT_MS);

  it('Important-1 and DEF-214: every button disabled before any input is filled and read; the enabled button is filled and pressed', async () => {
    const opened = await openSite(PRESS_ORDER_PAGES);
    const { probed } = await probeSceneOf(browser, opened, '/scene-disabled-many');
    await settleProbeSceneSite(opened);
    expect(nonReadHitsOf(opened.hits)).toEqual([]);
    const disabled = probed.candidates.filter((candidate) => candidate.submissionProbe !== undefined && candidate.submitterWords.length > 0)
      .map(({ submissionProbe }) => submissionProbe);
    expect(disabled.map((probe) => probe?.reason)).toEqual(Array.from({ length: 8 }, () => 'DISABLED_SUBMITTER'));
    expect(disabled.map((probe) => probe?.filledFieldCount)).toEqual(Array.from({ length: 8 }, () => 1));
    // 押せなかったボタンは、ほかの押下（「確定」）の後に、もう一度欄に入れて読む（8 × 2 + 1）。
    const pressed = probed.candidates.filter(({ submissionProbe }) => submissionProbe !== undefined && submissionProbe.result !== 'NOT_OBSERVED').length;
    expect(pressed).toBe(1);
    expect(opened.hits.filter((hit) => hit.method === 'GET' && hit.path.startsWith('/api/check'))).toHaveLength(disabled.length * 2 + pressed);
    const confirm = probed.candidates.find((candidate) => candidate.submissionProbe !== undefined && candidate.submitterWords.length === 0);
    expect(confirm?.submissionProbe?.result).not.toBe('NOT_OBSERVED');
    expect(confirm?.submissionProbe?.filledFieldCount).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('Important-1 and Minor-A: the buttons that become disabled after the input are not pressed; the always enabled button is pressed', async () => {
    const opened = await openSite(PRESS_ORDER_PAGES);
    const { probed } = await probeSceneOf(browser, opened, '/scene-inert-after');
    await settleProbeSceneSite(opened);
    expect(nonReadHitsOf(opened.hits)).toEqual([]);
    const probes = probed.candidates.flatMap(({ submitterWords, submissionProbe }) => (submissionProbe === undefined ? [] : [{ submitterWords, ...submissionProbe }]));
    const disabled = probes.filter(({ submitterWords }) => submitterWords.length > 0);
    expect(disabled.map(({ reason }) => reason)).toEqual(Array.from({ length: 5 }, () => 'DISABLED_SUBMITTER'));
    const confirm = probes.find(({ submitterWords }) => submitterWords.length === 0);
    expect(confirm?.result).not.toBe('NOT_OBSERVED');
    expect(confirm?.filledFieldCount).toBe(1);
    expect(opened.hits.filter((hit) => hit.method === 'GET' && hit.path.startsWith('/api/check'))).toHaveLength(disabled.length * 2 + 1);
  }, TEST_TIMEOUT_MS);

  it.each(Object.keys(BLOCKED_MOVES) as BlockedMoveKind[])('DEF-208-3 G: hands over the destination of the blocked move by %s', async (kind) => {
    const opened = await openSite({ [LIST_PATH]: BLOCKED_MOVES[kind] });
    const moved: string[] = [];
    const { probed, ledger } = await probeSceneOf(browser, opened, LIST_PATH, (url) => moved.push(url));
    await settleProbeSceneSite(opened);
    expect(nonReadHitsOf(opened.hits)).toEqual([]);
    // 押した画面の Context では、移った先の文書を読まない。
    expect(opened.hits.filter((hit) => hit.path === `app:${EDIT_PATH}`)).toEqual([]);
    expect(ledger.invariantViolations).toEqual([]);
    expect(probeResultOfWord(probed, '編集')).not.toBe('undefined undefined');
    expect(moved.map((url) => new URL(url).pathname)).toEqual([EDIT_PATH]);
  }, TEST_TIMEOUT_MS);

  it.each(Object.keys(LOCAL_SCHEME_MOVES) as LocalSchemeMoveKind[])('DEF-213: records the press of %s without a safety violation', async (kind) => {
    const opened = await openSite({ [LIST_PATH]: LOCAL_SCHEME_MOVES[kind].page });
    const { probed, ledger } = await probeSceneOf(browser, opened, LIST_PATH);
    expect(ledger.invariantViolations).toEqual([]);
    expect(probeResultOfWord(probed, '編集')).toBe(LOCAL_SCHEME_MOVES[kind].expected);
    // 届いた要求は画面の読み込みだけ（待って数え直す）。
    const expectedHits = [{ method: 'GET', path: `app:${LIST_PATH}` }];
    expect(opened.hits).toEqual(expectedHits);
    await settleProbeSceneSite(opened);
    expect(opened.hits).toEqual(expectedHits);
  }, TEST_TIMEOUT_MS);

  it('DEF-213 Passive: a script move to an invalid blob after the load does not close the Context', async () => {
    const opened = await openSite({ [LIST_PATH]: '<main><h1>一覧</h1></main>' });
    const factory = createGateFactory(browser, opened.appOrigin);
    try {
      await withGuardedPassivePage(factory, { width: 800, height: 600 }, async (page, context, ledger) => {
        await page.goto(`${opened.appOrigin}${LIST_PATH}`, { waitUntil: 'load' });
        await page.evaluate(`location.href = ${INVALID_BLOB};`).catch(() => undefined);
        await wait(PROBE_SCENE_QUIET_WAIT_MS);
        expect(ledger.snapshot().invariantViolations).toEqual([]);
        expect(isPassiveRequestGuardClosed(context)).toBe(false);
      });
    } finally {
      await factory.close().catch(() => undefined);
    }
    const expectedHits = [{ method: 'GET', path: `app:${LIST_PATH}` }];
    expect(opened.hits).toEqual(expectedHits);
    await settleProbeSceneSite(opened);
    expect(opened.hits).toEqual(expectedHits);
  }, TEST_TIMEOUT_MS);

  it('DEF-226 (ARR-1): records the elements and the marker of an array key, maps the label field to the array key, and sends nothing', async () => {
    const opened = await openSite({ [NEW_RECORD_PATH]: ARRAY_KEY_PAGE });
    const { probed, hitsAfterFreeze } = await probeSceneOf(browser, opened, NEW_RECORD_PATH);
    const probe = probed.candidates.find((candidate) => candidate.submitterWords.includes(SAVE_WORD))?.submissionProbe;
    expect(probe?.result).toBe('API_CREATE');
    const body = probe?.shape?.body;
    expect(body?.keys.find(({ name }) => name === 'labels')).toEqual({
      name: 'labels', type: 'array', elements: { types: ['string'], count: 1, nested: false, textOverLimit: false },
    });
    expect(body?.keys.find(({ name }) => name === 'makers')).toEqual({
      name: 'makers', type: 'array', elements: { types: [], count: 0, nested: false, textOverLimit: false },
    });
    expect(body?.markerKeys.find(({ key }) => key === 'labels')).toMatchObject({ inArray: true });
    const keyFields = probe === undefined ? [] : submissionProbeKeyFieldsOf(probe);
    expect(keyFields.find(({ key }) => key === 'labels')).toMatchObject({ type: 'array', field: { name: 'label' } });
    expect(keyFields.find(({ key }) => key === 'title')).toMatchObject({ type: 'string', field: { name: 'title' } });
    expect(keyFields.find(({ key }) => key === 'makers')).toMatchObject({ type: 'array', field: null });
    expect(nonReadHitsOf(hitsAfterFreeze)).toEqual([]);
    await settleProbeSceneSite(opened);
    expect(nonReadHitsOf(opened.hits)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// ---------- DEF-144・DEF-145（発見のジョブと READ の確かめの本物の流れ） ----------

const LATE_REQUEST_WAIT_MS = 1_000;
const QUIET_WAIT_MS = 600;
/** fixture の Shared Worker のスクリプトの path。 */
const WORKER_SCRIPT_PATH = '/admin/worker.js';
/** probe の目印の頭（`submission-probe-contracts.ts` の目印は、この頭を持つ）。 */
const MARKER_PREFIX = 'bsprobe';
/** 画面の URL の query に入れる値の目印（どこにも出てはならない）。 */
const QUERY_MARKER = 'def144querymarker';
/** DEF-145: 遅い編集の画面の path（サーバは応答を遅らせる。取り消されるので、ふつうは応答しない）。 */
const SLOW_EDIT_PATH = '/admin/edit-slow';
const SLOW_EDIT_DELAY_MS = 3_000;
const AFTER_PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>after</title><link rel="icon" href="data:,"></head><body><h1>after</h1></body></html>';
const jobPage = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head>
<body><main><h1>${title}</h1>${body}<p><a href="/admin/after">次へ</a></p></main></body></html>`;

const JOB_PAGES = Object.freeze({
  // DEF-144: 「保存」の押下が Shared Worker を作る（Shared Worker を許した Chromium で、factory の自己検査 `SHARED_WORKER_OBSERVED` の違反）。
  sharedWorkerPress: jobPage('sharedWorkerPress', `<label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button>
<script>document.getElementById('save').addEventListener('click', () => { try { new SharedWorker('${WORKER_SCRIPT_PATH}'); } catch (error) {} });</script>`),
  // DEF-144 の後半: 外部スキームの `<a>` の中のボタンは押さない。
  mailtoLinkButton: jobPage('mailto', `<a href="mailto:staff@example.invalid"><button type="button" data-bound>保存</button></a>
<script>for (const button of document.querySelectorAll('button[data-bound]')) button.addEventListener('click', () => {});</script>`),
  // DEF-145: 「編集」は遅い編集の画面へ移り、ページの JS が同じ画面への次の移動で最初の読み込みを取り消す。その後ろに「追加」（何も送らない）。
  editMovesAway: jobPage('edit', `<div><button type="button" id="edit">編集</button><button type="button" id="save">追加</button></div>
<script>document.getElementById('edit').addEventListener('click', () => { location.href = '${SLOW_EDIT_PATH}?first=1'; location.href = '${SLOW_EDIT_PATH}?second=1'; });
document.getElementById('save').addEventListener('click', () => {});</script>`),
});
type JobVariant = keyof typeof JOB_PAGES;

interface SeenRequest { readonly method: string; readonly path: string }

/** 読み込みで Shared Worker を作る画面（READ の確かめの違反の段 `PAGE_LOAD` の fixture）。 */
const SHARED_WORKER_LOAD_PATH = '/admin/worker-on-load';
const SHARED_WORKER_LOAD_PAGE = jobPage('load', `<script>try { new SharedWorker('${WORKER_SCRIPT_PATH}'); } catch (error) {}</script>`);

/** 画面の path ごとに返すサーバ（届いた要求を `seen` に記録する）。 */
const startJobSite = (seen: SeenRequest[], pages: Readonly<Record<string, string>>): ReturnType<typeof startLoopbackHttpServer> =>
  startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push({ method: request.method ?? '', path: `${url.pathname}${url.search}` });
    request.resume();
    if (url.pathname === WORKER_SCRIPT_PATH) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end('onconnect = () => {};');
      return;
    }
    const send = (): void => {
      if (!response.destroyed) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(pages[url.pathname] ?? AFTER_PAGE);
      }
    };
    if (url.pathname === SLOW_EDIT_PATH) {
      setTimeout(send, SLOW_EDIT_DELAY_MS);
      return;
    }
    send();
  });

const authenticationOf = (origin: string): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
});

/** 押下の形の画面から、発見のジョブを 1 回動かす（出力先は一時のフォルダ。終わったら消す）。 */
const runJob = async (launch: () => Promise<Browser>, variant: JobVariant) => {
  const seen: SeenRequest[] = [];
  const pagePath = `/admin/v/${variant}`;
  const server = await startJobSite(seen, { [pagePath]: JOB_PAGES[variant] });
  const output = await mkdtemp(join(tmpdir(), 'beaksight-probe-scenes-'));
  const violations: string[] = [];
  const original = SafetyLedger.prototype.recordInvariantViolation;
  SafetyLedger.prototype.recordInvariantViolation = function record(this: SafetyLedger, event) {
    violations.push(`${event.code}: ${event.message.replace(/\s+/gu, ' ').slice(0, 160)}`);
    original.call(this, event);
  };
  try {
    const base = createTestConfig(server.origin, `${pagePath}?page=${QUERY_MARKER}`, {
      crawl: { maxPages: 2, minNavigationIntervalMs: 200 },
      audit: { screenshots: false },
      output: { directory: output },
    });
    const outcome = await executeDiscoveryRun({
      config: { ...base, audit: { ...base.audit, sendPolicy: SEND_POLICY } }, jobId: 'job-def144', authentication: authenticationOf(server.origin),
      launchBrowser: launch, clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, observationWindows: probeQuietWindowsOf(QUIET_WAIT_MS),
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    await wait(LATE_REQUEST_WAIT_MS);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    const text = readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8');
    const document = JSON.parse(text) as DiscoveryDocument;
    const validation = await validateArtifact('discovery', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    // サーバに読み取りでない要求は届かない。
    expect(seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    const page = document.pages.find((entry) => entry.url.includes('/admin/v/'));
    if (page?.state !== 'READ') {
      throw new Error('the page was not read');
    }
    const probeOf = (word: string): string => {
      const probe = page.record.candidates.find((entry) => entry.submitterWords.includes(word))?.submissionProbe;
      return `${String(probe?.result)} ${String(probe?.reason)}`;
    };
    const readAfter = document.pages.some((entry) => entry.state === 'READ' && entry.url.includes('/admin/after'));
    return { outcome, document, text, page, probeOf, readAfter, violations };
  } finally {
    SafetyLedger.prototype.recordInvariantViolation = original;
    await server.close();
    await rm(output, { recursive: true, force: true });
  }
};

const [JOB_ONCE_NAME, launchJobOnce] = BOTH_CHROMIUM_LAUNCHERS[0] ?? ['', () => Promise.reject(new Error('no Chromium run'))];

describe(`DEF-144 and DEF-145: the probe presses of the real discovery and READ check runs (${JOB_ONCE_NAME})`, () => {
  it('DEF-144: keeps the kind, the stage, the page and the pressed candidate in discovery.json and the FINISHED summary, without a value', async () => {
    const run = await runJob(() => launchJobOnce({ sharedWorkers: 'allow' }), 'sharedWorkerPress');
    const { document, outcome } = run;
    if (outcome.kind !== 'RAN') {
      throw new Error('the discovery did not run');
    }
    expect(document.endReason).toBe('SAFETY_VIOLATION');
    expect(document.runStatus).toBe('ABORTED_BY_SAFETY');
    const saveCandidate = run.page.record.candidates.find((candidate) => candidate.submitterWords.includes('保存'));
    expect(document.safetyViolation).toMatchObject({
      pagePath: '/admin/v/sharedWorkerPress',
      stage: 'SUBMISSION_PROBE',
      press: { submitterWords: ['保存'], identityDigest: saveCandidate?.identityDigest },
    });
    expect(document.safetyViolation?.invariantViolations.map(({ code }) => code)).toContain('SHARED_WORKER_OBSERVED');
    // IPC: `FINISHED` の要約に同じ中身が載り、契約の確かめに通る。
    expect(outcome.summary.safetyViolation).toEqual(document.safetyViolation);
    const finished = toDiscoveryFinished(outcome, join(outcome.runDirectory, '..'));
    expect(finished.discovery?.safetyViolation).toEqual(document.safetyViolation);
    const message = validateWorkerToParentMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', ...finished });
    expect(message.ok ? [] : message.errors).toEqual([]);
    // 値（probe の目印、画面の URL の query の値）は出ない。
    for (const text of [run.text, JSON.stringify(finished)]) {
      expect(text.includes(MARKER_PREFIX)).toBe(false);
    }
    expect(JSON.stringify(document.safetyViolation).includes(QUERY_MARKER)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('DEF-144: keeps the kind, the stage and the page of the READ check violation in read-evidence.json and the FINISHED summary', async () => {
    const seen: SeenRequest[] = [];
    const server = await startJobSite(seen, { [SHARED_WORKER_LOAD_PATH]: SHARED_WORKER_LOAD_PAGE });
    const output = await mkdtemp(join(tmpdir(), 'beaksight-probe-scenes-read-'));
    try {
      const base = createTestConfig(server.origin, SHARED_WORKER_LOAD_PATH, {
        crawl: { maxPages: 2, minNavigationIntervalMs: 200 }, audit: { screenshots: false }, output: { directory: output },
      });
      const outcome = await executeReadCheckRun({
        config: base, jobId: 'job-def144-read', authentication: authenticationOf(server.origin), launchBrowser: () => launchJobOnce({ sharedWorkers: 'allow' }),
        readChecks: [{
          readCheckId: 'read-def144', readCheckRevision: 1, targetPage: { origin: server.origin, path: SHARED_WORKER_LOAD_PATH },
          definition: { targetPagePath: SHARED_WORKER_LOAD_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'load' }] },
        }],
        clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
      if (outcome.kind !== 'RAN') {
        throw new Error(`the READ check did not run: ${outcome.kind}`);
      }
      await wait(LATE_REQUEST_WAIT_MS);
      const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument;
      const validation = await validateArtifact('read-evidence', document);
      expect(validation.ok ? [] : validation.errors).toEqual([]);
      expect(document.endReason).toBe('SAFETY_VIOLATION');
      expect(document.safetyViolation).toMatchObject({ pagePath: SHARED_WORKER_LOAD_PATH, press: null });
      expect(['CONTEXT_OPEN', 'PAGE_LOAD', 'CONTEXT_CLOSE']).toContain(document.safetyViolation?.stage);
      expect(document.safetyViolation?.invariantViolations.map(({ code }) => code)).toContain('SHARED_WORKER_OBSERVED');
      expect(outcome.summary.safetyViolation).toEqual(document.safetyViolation);
      const finished = toReadCheckFinished(outcome, output);
      expect(finished.readCheck?.safetyViolation).toEqual(document.safetyViolation);
      const message = validateWorkerToParentMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', ...finished });
      expect(message.ok ? [] : message.errors).toEqual([]);
      expect(seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
    } finally {
      await server.close();
      await rm(output, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('DEF-144: does not press a button inside an external scheme link, records EXTERNAL_SCHEME and reads the next page', async () => {
    const run = await runJob(() => launchJobOnce(), 'mailtoLinkButton');
    expect(run.violations).toEqual([]);
    expect(run.document.endReason).not.toBe('SAFETY_VIOLATION');
    expect(run.page.record.candidates.find((entry) => entry.submitterWords.includes('保存'))?.submissionProbe)
      .toMatchObject({ result: 'NOT_EXECUTABLE', reason: 'EXTERNAL_SCHEME', nonReadRequestCount: 0 });
    expect(run.document.externalSchemeProbes).toEqual({ notPressed: 1, reloadedPages: 0 });
    expect(run.readAfter).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('DEF-145: records the read navigation that the page cancels and presses the rest without stopping the discovery', async () => {
    const run = await runJob(() => launchJobOnce(), 'editMovesAway');
    expect(run.document.endReason).not.toBe('SAFETY_VIOLATION');
    expect(run.document.safetyViolation).toBeUndefined();
    expect(run.probeOf('編集')).toBe('NOT_OBSERVED PAGE_CHANGED');
    expect(run.probeOf('追加')).toBe('NO_REQUEST null');
    expect(run.readAfter).toBe(true);
  }, TEST_TIMEOUT_MS);
});

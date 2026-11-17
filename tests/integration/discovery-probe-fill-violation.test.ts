// SREV-1105-3 の Important-2（DEF-208-2 の fix）: 欄に入れる間に起きた安全の違反は、そのとき入れていた候補に結び付く（1 つ前に押した候補に結び付かない）。
// 本物の発見の流れ（`executeDiscoveryRun`）で、127.0.0.1 の仮のサイトを読む。Chromium はテストの既定だけ（TEST-POLICY の 3）。
// - 画面: 「更新」（何も送らない）、「保存」「登録」（POST）。欄に 2 回目に入れたとき、ページが外部スキーム（`mailto:`）へ移ろうとする。押す順は文書の順で、
//   2 回目に入れるのは「保存」（記録の候補の 2 つ目）。違反は「保存」に結び付き（`EXTERNAL_SCHEME`）、発見は止まらずに、その画面を読み込み直して残りを押す。
// - 安全: 押して出た送信はサーバに届かない（サーバの記録で数え、名前つきの時間だけ待って数え直す）。
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { runDiscoveryOnPlainSite } from '../helpers/plain-discovery-site-run.js';

const TEST_TIMEOUT_MS = 180_000;
/**
 * L6/L3-1: 1 画面の見張りの反応なしの長さ（テストで短く注入する）。外部スキームへ移ろうとした画面で、返らない 1 手があっても、見張りがテストの時間切れより
 * 前に画面を終える（見張りで終わったのか、返らない 1 手がほかにあるのかを見分ける）。
 */
const INJECTED_QUIET_LIMIT_MS = 20_000;

const FILL_NAV_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>fill</title><link rel="icon" href="data:,"></head>
<body><main><h1>登録</h1><input id="title" name="title"><button type="button" id="f1">更新</button><button type="button" id="f2">保存</button><button type="button" id="f3">登録</button></main>
<script>let n = 0; document.getElementById('title').addEventListener('input', () => { n += 1; if (n === 2) { location.href = 'mailto:a@example.invalid'; } });
document.getElementById('f1').addEventListener('click', () => {});
for (const id of ['f2', 'f3']) document.getElementById(id).addEventListener('click', () => { fetch('/api/items', { method: 'POST', body: 'x' }).catch(() => {}); });</script></body></html>`;

/** 1 つ目の候補（「保存」）の欄に入れると、ボタンが押せなくなり、ページが外部スキームへ移ろうとする（押せない候補で起きた違反）。 */
const FIRST_DISABLED_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>first</title><link rel="icon" href="data:,"></head>
<body><main><h1>登録</h1><input id="title" name="title"><button type="button" id="f1">保存</button><button type="button" id="f2">登録</button></main>
<script>let n = 0; document.getElementById('title').addEventListener('input', () => { n += 1;
  if (n === 1) { document.getElementById('f1').disabled = true; location.href = 'mailto:a@example.invalid'; } });
for (const id of ['f1', 'f2']) document.getElementById(id).addEventListener('click', () => { fetch('/api/items', { method: 'POST', body: 'x' }).catch(() => {}); });</script></body></html>`;

/**
 * SREV-1105-3 の再レビューの Minor-C: それぞれの form の欄に入れると、その form のボタンが押せなくなる（「保存」「登録」「更新」で上限まで使う）。「変更」の
 * form は、押すと外部スキームへ移る。最後の「save」も、欄に入れると押せなくなる。
 * 「変更」の違反で読み込み直した後も続ける（COV-1: 押せなかった回の上限を外したので、「save」も `DISABLED_SUBMITTER`）。
 */
const RELOAD_LIMIT_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>reload</title><link rel="icon" href="data:,"></head>
<body><main><h1>登録</h1>
${['保存', '登録', '更新', '変更', 'save'].map((word, index) => `<form id="f${String(index)}"><input name="title${String(index)}"><button type="submit">${word}</button></form>`).join('')}</main>
<script>for (const form of document.querySelectorAll('form')) {
  // 「変更」の form のほかは、欄に入れると、その form のボタンが押せなくなる。
  if (form.id !== 'f3') form.querySelector('input').addEventListener('input', () => { form.querySelector('button').disabled = true; });
  form.addEventListener('submit', (event) => { event.preventDefault();
    if (form.id === 'f3') { location.href = 'mailto:a@example.invalid'; return; }
    fetch('/api/items', { method: 'POST', body: 'x' }).catch(() => {}); });
}</script></body></html>`;

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('SREV-1105-3 Important-2: the violation while filling is tied to the candidate being filled (%s)', (_label, launch) => {
  it('ties the external scheme move of the second input to "save" and keeps discovering', async () => {
    const run = await runDiscoveryOnPlainSite(launch, (path) => (path === '/fill' ? FILL_NAV_PAGE : null), '/fill', 1, 'job-srev-1105-3-fill', {}, undefined, INJECTED_QUIET_LIMIT_MS);
    expect(run.document.endReason).not.toBe('SAFETY_VIOLATION');
    const page = run.document.pages.find((entry) => entry.state === 'READ');
    if (page?.state !== 'READ') throw new Error('the page was not read');
    const probes = page.record.candidates.map((candidate) => `${candidate.submitterWords.join('/')} ${String(candidate.submissionProbe?.result)} ${String(candidate.submissionProbe?.reason)}`);
    expect(probes[0]).toBe('更新 NO_REQUEST null');
    // SAFE-2 の 4: 外部スキームへの移動は違反でなく記録になった（候補の結果は記録で決める）。違反の中身の期待は外した。
    expect(probes[1]).toBe('保存 NOT_EXECUTABLE EXTERNAL_SCHEME');
    expect(run.seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('Minor-C (COV-1: no limit of the disabled fills): fills and reads "save" after the reload after an external scheme press', async () => {
    const run = await runDiscoveryOnPlainSite(launch, (path) => (path === '/reload' ? RELOAD_LIMIT_PAGE : null), '/reload', 1, 'job-srev-1105-3-reload', {}, undefined, INJECTED_QUIET_LIMIT_MS);
    expect(run.document.endReason).not.toBe('SAFETY_VIOLATION');
    const page = run.document.pages.find((entry) => entry.state === 'READ');
    if (page?.state !== 'READ') throw new Error('the page was not read');
    const probes = page.record.candidates.map((candidate) => `${candidate.submitterWords.join('/')} ${String(candidate.submissionProbe?.result)} ${String(candidate.submissionProbe?.reason)}`);
    expect(probes).toEqual([
      '保存 NOT_OBSERVED DISABLED_SUBMITTER',
      '登録 NOT_OBSERVED DISABLED_SUBMITTER',
      '更新 NOT_OBSERVED DISABLED_SUBMITTER',
      '変更 NOT_EXECUTABLE EXTERNAL_SCHEME',
      // COV-1（網羅の設計書 3.3）: 押せなかった回の上限を外したので、読み込み直した後の「save」も、入れて押せなくなった `DISABLED_SUBMITTER`
      // （前は、引き継いだ上限の後の `DISABLED_FILL_LIMIT_REACHED`）。
      'save NOT_OBSERVED DISABLED_SUBMITTER',
    ]);
    // SAFE-2 の 4: 外部スキームへの移動は違反でなく記録になり、Context が閉じなくなったので、読み込み直しの有無は期待に書かない（TEST-POLICY の 4）。
    expect(run.seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('ties a violation of the first candidate that ends up disabled to it, and keeps discovering with a reload', async () => {
    const run = await runDiscoveryOnPlainSite(launch, (path) => (path === '/first' ? FIRST_DISABLED_PAGE : null), '/first', 1, 'job-srev-1105-3-first', {}, undefined, INJECTED_QUIET_LIMIT_MS);
    expect(run.document.endReason).not.toBe('SAFETY_VIOLATION');
    const page = run.document.pages.find((entry) => entry.state === 'READ');
    if (page?.state !== 'READ') throw new Error('the page was not read');
    const probes = page.record.candidates.map((candidate) => `${candidate.submitterWords.join('/')} ${String(candidate.submissionProbe?.result)} ${String(candidate.submissionProbe?.reason)}`);
    expect(probes[0]).toBe('保存 NOT_EXECUTABLE EXTERNAL_SCHEME');
    expect(run.seen.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

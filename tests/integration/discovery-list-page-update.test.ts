// OP-R（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R2）: 一覧の画面の「編集」から開くモーダルの入力で更新する SPA の形で、操作さがしの
// 押して確かめる道（送らずに観察する probe）が、更新の候補（PATCH を `?id=eq.<番号>` で送る形）をどう扱うかを確かめる（OP-R の調べ。今の事実を固定する）。
// - 今の事実: probe は「編集」を押してモーダルを開き（`NO_REQUEST`）、続けてモーダルの「保存」を押して PATCH の型を観察する（サーバへは送らない）。ただし、
//   filter の値（`id`）が画面の path の値でないので、`NOT_EXECUTABLE`・`FILTER_NOT_PAGE_VALUE` に分類し、更新の候補（`API_UPDATE`）にしない。更新の候補として
//   扱うには、行の番号を filter の値と結ぶ分類と、書き込みの段で対象の行の「編集」を押してから入れる道が要る（OP-R の報告の Blocker。設計者の判断を待つ）。
// - fixture: 会員の一覧の画面（`startSpaAuthSite` の `memberListPage`）。各行に「編集」があり、押すとモーダルが開き、「保存」で PATCH を送る。データは 1 件以上。
// - 発見は本物の流れ（`executeDiscoveryRun`。認証つきの factory と Guard、probe）。入口は一覧の画面。サーバへは読み取りでない要求が届かない（probe は送らない）。
// - 読む先と押す道の確かめなので、テストの既定の Chromium だけで確かめる。サーバは 127.0.0.1 だけで待ち受ける。出力先は一時のフォルダだけ。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoveryCandidatesOf, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { spaApiWriteConfigOf, spaRunAuthenticationOf } from '../helpers/api-write-scenario.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { SPA_MEMBER_LIST_PATH, startSpaAuthSite, type SpaAuthSite } from '../helpers/spa-auth-site-fixture.js';

const TEST_TIMEOUT_MS = 180_000;
/** 押した後に静まるまで待つ時間（ms。テストの値。fixture はすぐに送る）。 */
const SHORT_QUIET_WAIT_MS = 500;
/** 読む画面の数の上限（一覧の画面だけを読む）。 */
const MAX_PAGES = 1;

describe('OP-R (R2): the update candidate of the edit dialog on the list page', () => {
  let site: SpaAuthSite;
  let directory = '';

  beforeAll(async () => {
    site = await startSpaAuthSite({ memberScreenLayout: 'formless', memberListPage: true });
    directory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-list-update-'));
    // データは 1 件以上（一覧の行に「編集」が出る）。
    site.addMember('OP-R 一覧の会員', { email: 'op-r-list@example.invalid' });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await site?.close();
    if (directory !== '') await rm(directory, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  it('observes the PATCH of the dialog opened by the edit button without sending it, but does not take it as an update candidate yet', async () => {
    expect(site.memberCount).toBeGreaterThan(0);
    // 監査の送信の扱いは既定の `PASS_EXCEPT_DELETE`（一覧の手続きの呼び出しが通り、行が描かれる）。
    const base = spaApiWriteConfigOf(site, join(directory, 'output'), { crawl: { maxPages: MAX_PAGES }, audit: { sendPolicy: 'PASS_EXCEPT_DELETE' } });
    const since = site.requests.length;
    const outcome = await executeDiscoveryRun({
      config: { ...base, site: { ...base.site, startUrl: `${site.appOrigin}${SPA_MEMBER_LIST_PATH}` } },
      jobId: 'job-discovery-list-update',
      authentication: spaRunAuthenticationOf(site),
      launchBrowser: () => launchHeadlessChromium(),
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, submissionProbeQuietWaitMs: SHORT_QUIET_WAIT_MS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    const onList = mergeDiscoveryCandidates(discoveryCandidatesOf(document)).filter((candidate) => candidate.page.path === SPA_MEMBER_LIST_PATH);
    const probes = onList.map((candidate) => ({ words: candidate.submitterWords, result: candidate.submissionProbe?.result ?? null }));
    // probe は送らない（サーバへ届いた読み取りでない要求は、一覧の手続きの呼び出し（読み取りの手続き。送信の扱いで通す）のほかにない）。
    const nonReads = site.requests.slice(since).filter((request) => request.preflight || !READ_METHODS.has(request.method));
    expect(nonReads.filter((request) => request.method === 'PATCH')).toEqual([]);
    // 「編集」はモーダルを開くだけ（何も送らない）。モーダルの「保存」で PATCH の型を観察した（filter は `id`。値は画面の path にない）。
    expect(probes).toEqual(expect.arrayContaining([{ words: ['編集'], result: 'NO_REQUEST' }, { words: ['保存'], result: 'NOT_EXECUTABLE' }]));
    const save = onList.find((candidate) => candidate.submitterWords.includes('保存'));
    expect(save?.submissionProbe).toMatchObject({
      reason: 'FILTER_NOT_PAGE_VALUE',
      shape: { method: 'PATCH', filters: [{ name: 'id', operator: 'eq', valueMatchesPagePath: false }] },
    });
    // 更新の候補にはしない（今の分類。OP-R の Blocker）。
    expect(probes.filter(({ result }) => result === 'API_UPDATE')).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

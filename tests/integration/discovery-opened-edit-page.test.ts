// DEF-190（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 5.8）: 一覧の画面の「編集」（リンクでないボタン）を押すと、ページのスクリプトが
// 一覧の 1 つ下の編集の画面（`/admin/members/<番号>`）へ移る作りで、操作さがしが、移った先の編集の画面を読み、その保存を更新の候補（`API_UPDATE`）にする。
// - fixture: 会員の一覧の画面（`startSpaAuthSite` の `memberListEditMovesAway`）。行ごとの「編集」は、押すとスクリプトで編集の画面へ移る（一覧に編集の画面への
//   リンクはない）。編集の画面の保存のボタンは、登録の画面の保存のボタンと同じ語・同じ作り。保存で `PATCH /rest/v1/members?id=eq.<番号>`。
// - 発見は本物の流れ（`executeDiscoveryRun`。認証つきの factory と Guard、probe）。入口は一覧の画面で、ページの上限は 1（編集の画面は上限の外で数える）。
// - 編集の画面は、同じ型（番号を `{id}` にした path）を 1 回だけ読む。登録の画面の候補（`API_CREATE`）と、編集の画面の候補（`API_UPDATE`）は混ざらない。
// - サーバへは読み取りでない要求が届かない（probe は送らない。fixture の記録で数え、待って数え直す）。一覧の読み取りの手続きと、その CORS の事前確認は除く。
// - Chromium はテストの既定だけ（TEST-POLICY の 3）。サーバは 127.0.0.1 だけで待ち受ける。出力先は一時のフォルダだけ。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { wait } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { discoveryCandidatesOf, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun, openedEditPageOf } from '../../src/worker/discovery-run.js';
import { spaApiWriteConfigOf, spaRunAuthenticationOf } from '../helpers/api-write-scenario.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { probeQuietWindowsOf } from '../helpers/test-waits.js';
import { SPA_APP_PATHS, SPA_MEMBER_LIST_PATH, startSpaAuthSite, type SpaAuthSite } from '../helpers/spa-auth-site-fixture.js';

const TEST_TIMEOUT_MS = 180_000;
/** 押した後に静まるまで待つ時間（ms。テストの値。fixture はすぐに送る）。 */
const SHORT_QUIET_WAIT_MS = 500;
/** 遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;

/**
 * 「編集」の移り方: 同じ page で移る（DEF-190）と、別の page で開く（DEF-208-3 の G。凍結の間は Guard が別の page を閉じ、一覧の URL は変わらない。止めた移動の
 * 行き先を受ける）。押した「編集」の結果は、どちらも `NO_REQUEST`（一覧の画面は移らない）。同じ page の移動は、DEF-242 で Guard が 204 で応えて文書が残る
 * （前は誤りの画面に替わって `PAGE_CHANGED`）。止める道が違うので、2 つの移り方を残す。
 */
const EDIT_MOVES = [
  ['the same page', true, { result: 'NO_REQUEST', reason: null }],
  ['a new page', 'NEW_TAB', { result: 'NO_REQUEST', reason: null }],
] as const;
const EDIT_MOVE_CASES = EDIT_MOVES.flatMap(([move, mode, opener]) => DEFAULT_CHROMIUM_LAUNCHERS.map(([label, launch]) => [`${move}, ${label}`, mode, opener, launch] as const));

describe.each(EDIT_MOVE_CASES)('DEF-190: the edit page that the edit button of the list moves to (%s)', (_label, mode, openerProbe, launch) => {
  let site: SpaAuthSite;
  let directory = '';

  beforeAll(async () => {
    site = await startSpaAuthSite({ memberListEditMovesAway: mode });
    directory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-opened-edit-'));
    site.addMember('DEF-190 の会員 1', { email: 'def-190-one@example.invalid' });
    site.addMember('DEF-190 の会員 2', { email: 'def-190-two@example.invalid' });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await site?.close();
    if (directory !== '') await rm(directory, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  const discover = async (startPath: string, maxPages: number, output: string): Promise<DiscoveryDocument> => {
    const base = spaApiWriteConfigOf(site, join(directory, output), { crawl: { maxPages }, audit: { sendPolicy: 'PASS_EXCEPT_DELETE' } });
    const outcome = await executeDiscoveryRun({
      config: { ...base, site: { ...base.site, startUrl: `${site.appOrigin}${startPath}` } },
      jobId: `job-${output}`,
      authentication: spaRunAuthenticationOf(site),
      launchBrowser: launch,
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, observationWindows: probeQuietWindowsOf(SHORT_QUIET_WAIT_MS),
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
    return JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
  };

  const nonReadsSince = async (since: number): Promise<readonly string[]> => {
    await wait(LATE_REQUEST_WAIT_MS);
    return site.requests.slice(since).filter((request) => request.preflight || !READ_METHODS.has(request.method))
      .map((request) => `${request.method} ${request.path}`)
      // 一覧の手続きの呼び出し（読み取りの手続き。送信の扱いで通す）のほか。SD-2・REV-RB14 の I-1: 一覧の画面の読み込み（凍結の前）でサイト自身が出す
      // その呼び出しの CORS の事前確認も、サーバへ送る（Guard が代わりに答えない）。
      .filter((line) => !line.startsWith('POST /rest/v1/rpc/list_members') && !line.startsWith('OPTIONS /rest/v1/rpc/list_members'));
  };

  it('reads the edit page that the edit button moved to, once per type, and takes its save as an update candidate', async () => {
    const since = site.requests.length;
    const document = await discover(SPA_MEMBER_LIST_PATH, 1, 'list');
    const readPaths = document.pages.flatMap((page) => (page.state === 'READ' ? [new URL(page.url).pathname] : []));
    // 一覧の画面（入口）と、移った先の編集の画面の 1 つ（同じ型は 1 回）。
    const editPaths = readPaths.filter((path) => /^\/admin\/members\/[0-9]+$/u.test(path));
    expect(readPaths[0]).toBe(SPA_MEMBER_LIST_PATH);
    expect(editPaths).toHaveLength(1);
    expect(readPaths).toHaveLength(2);
    const candidates = mergeDiscoveryCandidates(discoveryCandidatesOf(document));
    const onList = candidates.filter((candidate) => candidate.page.path === SPA_MEMBER_LIST_PATH);
    expect(onList.find((candidate) => candidate.submitterWords.includes('編集'))?.submissionProbe).toMatchObject(openerProbe);
    const editPath = editPaths[0] ?? '';
    const save = candidates.find((candidate) => candidate.page.path === editPath && candidate.submitterWords.includes('保存'));
    expect(save?.submissionProbe).toMatchObject({
      result: 'API_UPDATE',
      shape: { method: 'PATCH', pathShape: '/rest/v1/members', filters: [{ name: 'id', operator: 'eq', valueMatchesPagePath: true }] },
    });
    // 更新の候補は、編集の画面の保存だけ。
    expect(candidates.filter((candidate) => candidate.submissionProbe?.result === 'API_UPDATE').map((candidate) => candidate.page.path)).toEqual([editPath]);
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps the create candidate of the create page and the update candidate of the edit page apart (same save button)', async () => {
    const since = site.requests.length;
    // 一覧の画面（入口）と登録の画面（先に読む登録の画面らしいリンク）。編集の画面は上限の外。
    const document = await discover(SPA_MEMBER_LIST_PATH, 2, 'list-and-new');
    const candidates = mergeDiscoveryCandidates(discoveryCandidatesOf(document));
    const saves = candidates.filter((candidate) => candidate.kind === 'BUTTON' && candidate.submitterWords.includes('保存') && candidate.submissionProbe !== undefined
      && candidate.page.path !== SPA_MEMBER_LIST_PATH);
    const create = saves.filter((candidate) => candidate.page.path === SPA_APP_PATHS.memberNew);
    const update = saves.filter((candidate) => /^\/admin\/members\/[0-9]+$/u.test(candidate.page.path));
    expect(create.map((candidate) => candidate.submissionProbe?.result)).toEqual(['API_CREATE']);
    expect(update.map((candidate) => candidate.submissionProbe?.result)).toEqual(['API_UPDATE']);
    // 2 つの画面の保存は、別の候補（識別の digest が違うか、画面の path で分かれる）。
    expect(saves).toHaveLength(2);
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

/** 上限と条件の場面の、移り先の番号（ハッシュのような値）。 */
const HASH_ID = 'a1b2c3d4e5';
// RB-8: 移った先の編集の画面を数の上限なしに全部読み、ページの上限に数えない巡回の場面は、偽の巡回の口で確かめる（`tests/unit/discovery-crawl.test.ts`）。
// 移りの条件は、下の `openedEditPageOf` の場面が確かめる。

/** 上限と条件の場面の、認証の指定（状態なし。読まないパスと、セッションの切れの path）。 */
const plainAuthenticationOf = (origin: string): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
});

describe('DEF-190: the conditions of the edit page that the opener moved to (openedEditPageOf)', () => {
  const origin = 'http://127.0.0.1:8080';
  const options = { allowedQueryParameters: new Set<string>(), allowedOrigins: new Set([origin]), authentication: plainAuthenticationOf(origin) };
  it.each([
    ['one level below with a record id', `${origin}/items`, `${origin}/items/${HASH_ID}`, '/items/{id}'],
    ['the pressed path with a trailing slash', `${origin}/items/`, `${origin}/items/42`, '/items/{id}'],
    ['another origin', `${origin}/items`, `http://localhost:8080/items/${HASH_ID}`, null],
    ['two levels below', `${origin}/items`, `${origin}/items/${HASH_ID}/edit`, null],
    ['the same page', `${origin}/items`, `${origin}/items`, null],
    ['a sibling path', `${origin}/items`, `${origin}/other/${HASH_ID}`, null],
    ['not a record id', `${origin}/items`, `${origin}/items/item.html`, null],
    ['an encoded segment', `${origin}/items`, `${origin}/items/%E7%B7%A8`, null],
    ['a dangerous word', `${origin}/items`, `${origin}/items/delete1`, null],
    ['an excluded path', `${origin}/logout`, `${origin}/logout/${HASH_ID}`, null],
    ['the session-lost path', `${origin}/login`, `${origin}/login/${HASH_ID}`, null],
    ['not http', `${origin}/items`, 'chrome-error://chromewebdata/', null],
  ] as const)('%s', (_label, pressed, moved, template) => {
    expect(openedEditPageOf(pressed, moved, options)?.templatePath ?? null).toBe(template);
  });
});

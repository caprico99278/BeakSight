// DEF-221（設計書 `doc/design/2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.2、6 章）: SPA の一覧の画面の「変更」を押すと、同じ文書のまま
// main frame の URL が変わり（`pushState`・`replaceState`・ハッシュ）、編集のフォームが出る作りで、操作さがしが、変わった後の URL を見つけたページとして直に
// GET で読み、そこで「保存」（fetch の POST）を押して送信の型を取ることを、本物の流れ（`executeDiscoveryRun`。Guard・凍結・probe）で確かめる結合テスト。
// - fixture: 127.0.0.1 の自前のサーバ（一般の文言）。移った先の URL を直に開くと、同じ編集のフォームを返す（履歴の fallback あり）。fallback のない画面は 404。
// - 移った先の画面は、ページの上限（`crawl.maxPages`）の中で読む（上限を超えない）。読まないパス・危険な語の URL・ハッシュだけの変化は読まない。
// - 押下で、窓でない区画（section）に新しく現れた確定の語のボタンは、DEF-145 の読み直しで押す。
// - 続き（状態の保存）でも、覚えた画面を失わない（1 回目は移った先の画面でセッションが切れ、2 回目の続きで読む）。
// - サーバへは読み取りでない要求が届かない（操作さがしは届けない。サーバの記録で数え、名前つきの時間だけ待って数え直す）。
// - Chromium はテストの既定だけ（TEST-POLICY の 3。どの移り先を読むかは Chromium によらない判定）。出力先は一時のフォルダだけ。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { wait } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { discoveryCandidatesOf, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun, spaRoutePageOf, type DiscoveryCheckpointOptions, type DiscoveryRunOutcome } from '../../src/worker/discovery-run.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig } from '../helpers/test-config.js';
import { probeQuietWindowsOf } from '../helpers/test-waits.js';

const TEST_TIMEOUT_MS = 180_000;
/** 押した後に静まるまで待つ時間（ms。テストの値。fixture はすぐに送る）。 */
const SHORT_QUIET_WAIT_MS = 500;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 200;
/** 遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const IDENTITY = Object.freeze({ authenticationSha256: 'c'.repeat(64), targetConfigSha256: 'd'.repeat(64) });

/** 保存の送り先（同じ Origin の API）。 */
const SAVE_API_PATH = '/api/settings';
/** 読まないパス（認証の設定の除外）。 */
const EXCLUDED_PREFIX = '/app/private';
/** セッションの切れの path（続きの場面だけ）。 */
const LOGIN_PATH = '/login';

const SAVE_SCRIPT = `function bindSave() { document.getElementById('save').addEventListener('click', () => fetch('${SAVE_API_PATH}', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('name').value }) }).catch(() => {})); }`;
const FORM_HTML = '<h1>設定の変更</h1><label>名前 <input id="name" name="name"></label><button type="button" id="save">保存</button>';
const htmlOf = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>`
  + `<link rel="icon" href="data:,"></head><body>${body}</body></html>`;

/** 一覧の画面: 「変更」を押すと `move` で URL を変え（同じ文書のまま）、編集のフォームを出す。`wrap` は、フォームを入れる要素。 */
const listPageOf = (move: string, wrap = 'div'): string => htmlOf('list', `<main id="root"><h1>設定</h1><table><tbody><tr><td>行</td>
<td><button type="button" id="change">変更</button></td><td><button type="button" class="other">表示</button></td></tr></tbody></table></main>
<script>${SAVE_SCRIPT}
document.getElementById('change').addEventListener('click', () => {
  ${move}
  document.getElementById('root').innerHTML = '<${wrap}>${FORM_HTML}</${wrap}>';
  bindSave();
});
document.querySelectorAll('.other').forEach((b) => b.addEventListener('click', () => { b.dataset.on = '1'; }));
</script>`);

/** 移った先の URL を直に開いたときの画面（履歴の fallback。同じ編集のフォーム）。 */
const EDIT_PAGE = htmlOf('edit', `<main>${FORM_HTML}</main><script>${SAVE_SCRIPT} bindSave();</script>`);

/** 一覧の画面の path と、「変更」の URL の変え方。 */
const LISTS: Readonly<Record<string, string>> = Object.freeze({
  '/app/push': "history.pushState({}, '', '/app/push/edit');",
  '/app/replace': "history.replaceState({}, '', '/app/replace/edit');",
  '/app/hash': "location.hash = '#edit';",
  '/app/gone': "history.pushState({}, '', '/app/gone/edit');",
  '/app/out-excluded': `history.pushState({}, '', '${EXCLUDED_PREFIX}/edit');`,
  '/app/out-danger': "history.pushState({}, '', '/app/remove/edit');",
  '/app/inline': '',
  '/app/resume': "history.pushState({}, '', '/app/resume/edit');",
});
/** 直に開くと編集のフォームを返す画面（履歴の fallback）。`/app/gone/edit` は返さない（404）。 */
const EDIT_PATHS: ReadonlySet<string> = new Set(['/app/push/edit', '/app/replace/edit', `${EXCLUDED_PREFIX}/edit`, '/app/remove/edit', '/app/resume/edit']);
/** 読まない場面をまとめて読む入口（リンクだけ）。 */
const NEGATIVE_HUB = htmlOf('hub', '<main><h1>hub</h1><p><a href="/app/hash">1</a></p><p><a href="/app/out-excluded">2</a></p>'
  + '<p><a href="/app/out-danger">3</a></p></main>');

interface SeenRequest {
  readonly method: string;
  readonly path: string;
}

const pathOf = (url: string): string => new URL(url).pathname;
const readPathsOf = (document: DiscoveryDocument): readonly string[] =>
  document.pages.flatMap((page) => (page.state === 'READ' ? [pathOf(page.url)] : []));

/** 認証の指定（状態なし。ログインのない形。続きの場面だけセッションの切れの path を持つ）。 */
const authenticationOf = (origin: string, sessionLostPathPrefix: string | null): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: [EXCLUDED_PREFIX], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix,
  filterState: filterAuthenticatedState,
});

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('DEF-221: the pages that the SPA moved to within the same document (%s)', (_label, launch) => {
  let server: LoopbackHttpServer;
  let directory = '';
  const seen: SeenRequest[] = [];
  /** 続きの場面: 移った先の画面の最初の GET は、ログインの画面へ送る（セッションの切れ）。 */
  let resumeEditGets = 0;

  beforeAll(async () => {
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      seen.push({ method: request.method ?? '', path: url.pathname });
      request.resume();
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      if (url.pathname === '/app/resume/edit') {
        resumeEditGets += 1;
        if (resumeEditGets === 1) {
          response.writeHead(302, { location: LOGIN_PATH, 'cache-control': 'no-store' });
          response.end();
          return;
        }
      }
      const list = LISTS[url.pathname];
      if (list !== undefined) {
        response.writeHead(200, headers);
        response.end(listPageOf(list, url.pathname === '/app/inline' ? 'section' : 'div'));
      } else if (EDIT_PATHS.has(url.pathname)) {
        response.writeHead(200, headers);
        response.end(EDIT_PAGE);
      } else if (url.pathname === '/app/neg') {
        response.writeHead(200, headers);
        response.end(NEGATIVE_HUB);
      } else if (url.pathname === LOGIN_PATH) {
        response.writeHead(200, headers);
        response.end(htmlOf('login', '<main><h1>login</h1></main>'));
      } else {
        response.writeHead(404, headers);
        response.end(htmlOf('not found', '<main><h1>not found</h1></main>'));
      }
    });
    directory = await mkdtemp(join(tmpdir(), 'beaksight-def221-'));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
    if (directory !== '') await rm(directory, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  let runNumber = 0;
  const run = async (
    startPath: string,
    maxPages: number,
    options: { readonly sessionLostPathPrefix?: string; readonly checkpoint?: DiscoveryCheckpointOptions; readonly output?: string } = {},
  ): Promise<{ readonly outcome: DiscoveryRunOutcome; readonly document: DiscoveryDocument }> => {
    runNumber += 1;
    const output = options.output ?? join(directory, `run-${String(runNumber)}`);
    const config = createTestConfig(server.origin, startPath, {
      crawl: { maxPages, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS }, audit: { screenshots: false }, output: { directory: output },
    });
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-def221-${String(runNumber)}`, authentication: authenticationOf(server.origin, options.sessionLostPathPrefix ?? null),
      launchBrowser: launch, clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      observationWindows: probeQuietWindowsOf(SHORT_QUIET_WAIT_MS), ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    const validation = await validateArtifact('discovery', document);
    expect(validation.ok ? [] : validation.errors).toEqual([]);
    // 読んだ画面の数は、成果物の上限を超えない。
    expect(readPathsOf(document).length).toBeLessThanOrEqual(Number(document.maxPages));
    return { outcome, document };
  };

  /** `since` 番目の記録からの、読み取りでない要求（名前つきの時間だけ待ってから数える）。 */
  const nonReadsSince = async (since: number): Promise<readonly string[]> => {
    await wait(LATE_REQUEST_WAIT_MS);
    return seen.slice(since).filter(({ method }) => !READ_METHODS.has(method)).map(({ method, path }) => `${method} ${path}`);
  };
  const candidatesOn = (document: DiscoveryDocument, path: string) =>
    mergeDiscoveryCandidates(discoveryCandidatesOf(document)).filter((candidate) => candidate.page.path === path);
  const probeOf = (document: DiscoveryDocument, path: string, word: string) =>
    candidatesOn(document, path).find((candidate) => candidate.submitterWords.includes(word))?.submissionProbe;
  /** 保存の押下で取れた型（同じ Origin の API への登録。DEF-220 の承認したテストの Origin の区分）。 */
  const SAVE_SHAPE = { result: 'API_CREATE', shape: { method: 'POST', pathShape: SAVE_API_PATH } };

  it.each([
    ['pushState', '/app/push', '/app/push/edit'],
    ['replaceState', '/app/replace', '/app/replace/edit'],
  ] as const)('reads the page that %s moved to and takes the shape of its save there', async (_move, listPath, editPath) => {
    const since = seen.length;
    const { document } = await run(listPath, 2);
    expect(readPathsOf(document)).toEqual([listPath, editPath]);
    // COV-1（DEF-238 の設計書 3.1 の 3）: 一覧の画面の「変更」の押下は、観察した結果を残す（前は `PAGE_CHANGED`）。path が変わったので、移った先は別の画面として
    // 読む。COV-2（網羅の設計書 3.2 の 2）: 一覧の画面の残りの対象は、読み込み直して押す（前は `PAGE_CHANGED` のまま）。
    expect(probeOf(document, listPath, '変更')).toMatchObject({ result: 'NO_REQUEST', reason: null });
    expect(candidatesOn(document, listPath).map((candidate) => candidate.submissionProbe?.result)).toEqual(['NO_REQUEST', 'NO_REQUEST']);
    expect(document.pages.find((page) => page.state === 'READ' && pathOf(page.url) === listPath)).toMatchObject({ reloadedForProbe: true });
    // 移った先の画面で、保存を押して型が取れた。
    expect(probeOf(document, editPath, '保存')).toMatchObject(SAVE_SHAPE);
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('does not read beyond the page limit (the moved-to page counts as a found page)', async () => {
    const since = seen.length;
    const { document } = await run('/app/push', 1);
    expect(readPathsOf(document)).toEqual(['/app/push']);
    expect(document.pages.find((page) => pathOf(page.url) === '/app/push/edit')).toMatchObject({ state: 'NOT_READ', reason: 'MAX_PAGES_REACHED' });
    expect(seen.slice(since).filter(({ path }) => path === '/app/push/edit')).toEqual([]);
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('does not read the moves to an excluded path, to a dangerous word, or only of the hash', async () => {
    const since = seen.length;
    const { document } = await run('/app/neg', 10);
    expect([...readPathsOf(document)].sort()).toEqual(['/app/hash', '/app/neg', '/app/out-danger', '/app/out-excluded']);
    // COV-1（DEF-238 の設計書 3.1 の 3）: 移した押下は、観察した結果を残す（前は `PAGE_CHANGED`）。
    for (const list of ['/app/hash', '/app/out-danger', '/app/out-excluded']) {
      expect(probeOf(document, list, '変更')).toMatchObject({ result: 'NO_REQUEST', reason: null });
    }
    // 移った先は、読む画面にしない（成果物にも載らず、サーバにも GET が届かない）。
    const targets = [`${EXCLUDED_PREFIX}/edit`, '/app/remove/edit'];
    expect(document.pages.filter((page) => targets.includes(pathOf(page.url)))).toEqual([]);
    expect(seen.slice(since).filter(({ path }) => targets.includes(path))).toEqual([]);
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('records the moved-to page that the server cannot open directly as a page not read with the reason', async () => {
    const since = seen.length;
    const { document } = await run('/app/gone', 2);
    expect(readPathsOf(document)).toEqual(['/app/gone']);
    expect(document.pages.find((page) => pathOf(page.url) === '/app/gone/edit')).toMatchObject({ state: 'NOT_READ', reason: 'HTTP_ERROR_STATUS' });
    expect(seen.slice(since).filter(({ path }) => path === '/app/gone/edit').map(({ method }) => method)).toEqual(['GET']);
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('presses the confirm button that appeared in a section (not a dialog) in the re-read after the press', async () => {
    const since = seen.length;
    const { document } = await run('/app/inline', 1);
    expect(readPathsOf(document)).toEqual(['/app/inline']);
    expect(probeOf(document, '/app/inline', '変更')).toMatchObject({ result: 'NO_REQUEST' });
    expect(probeOf(document, '/app/inline', '保存')).toMatchObject(SAVE_SHAPE);
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps the moved-to page in the saved state and reads it in the continuation', async () => {
    const since = seen.length;
    const output = join(directory, 'resume');
    const first = await run('/app/resume', 3, { sessionLostPathPrefix: LOGIN_PATH, checkpoint: { identity: IDENTITY }, output });
    expect(first.document.endReason).toBe('AUTH_SESSION_LOST');
    expect(readPathsOf(first.document)).toEqual(['/app/resume']);
    const second = await run('/app/resume', 3, {
      sessionLostPathPrefix: LOGIN_PATH, output,
      checkpoint: { identity: IDENTITY, resume: { runDirectory: first.outcome.kind === 'RAN' ? first.outcome.runDirectory : '', previousJobId: `job-def221-${String(runNumber)}` } },
    });
    expect(second.outcome).toMatchObject({ kind: 'RAN', runId: first.outcome.kind === 'RAN' ? first.outcome.runId : '' });
    expect(readPathsOf(second.document)).toEqual(['/app/resume', '/app/resume/edit']);
    expect(probeOf(second.document, '/app/resume/edit', '保存')).toMatchObject(SAVE_SHAPE);
    // 一覧の画面は、続きで読み直さない（GET は、1 回目の読み込みと、残りの対象を押す読み込み直しの分だけ。COV-2）。
    const listReloads = first.document.pages.some((page) => page.state === 'READ' && pathOf(page.url) === '/app/resume' && page.reloadedForProbe === true) ? 1 : 0;
    // COV-2c（SREV-COV の C-1）: 押下で移った先（`/app/resume/edit`）は、元の一覧の画面を読み込んで凍結してから凍結の中で読むので、移った先を読もうとするたびに
    // 一覧の画面の読み込みが 1 回増える（1 回目のセッションの切れた読み込みと、続きの読み込みの 2 回）。
    const frozenParentLoads = 2;
    expect(seen.slice(since).filter(({ path }) => path === '/app/resume')).toHaveLength(1 + listReloads + frozenParentLoads);
    expect(await nonReadsSince(since)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

describe('DEF-221: the conditions of the page that the SPA moved to (spaRoutePageOf)', () => {
  const origin = 'http://127.0.0.1:8080';
  const pressed = `${origin}/app/list` as NormalizedHttpUrlEvidence;
  const options = {
    allowedQueryParameters: new Set<string>(), allowedOrigins: new Set([origin, 'http://127.0.0.1:9090']), authentication: authenticationOf(origin, LOGIN_PATH),
    approvedTestOrigins: new Set([origin]),
  };
  it.each([
    ['a deeper path', `${origin}/app/list/1/edit`, `${origin}/app/list/1/edit`],
    ['a sibling path', `${origin}/app/edit`, `${origin}/app/edit`],
    // L14（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L14、表 A の N7）: 残す名前を選んでいない設定（空の集合）は、query を残す（COV-2 の
    // 場所の鍵と同じ）。query の違う同じ path の画面は、別の画面として読む。秘密に見える名前と追跡用の名前は、今までどおり捨てる。
    ['a query (kept when no names are chosen)', `${origin}/app/settings?tab=edit`, `${origin}/app/settings?tab=edit`],
    ['only the hash', `${origin}/app/list#edit`, null],
    ['a query of the same page (another page when no names are chosen)', `${origin}/app/list?tab=edit`, `${origin}/app/list?tab=edit`],
    ['a secret-like query of the same page that is not kept', `${origin}/app/list?token=x`, null],
    ['a tracking query of the same page that is not kept', `${origin}/app/list?utm_source=mail`, null],
    ['another origin', 'http://localhost:8080/app/edit', null],
    ['an excluded path', `${origin}${EXCLUDED_PREFIX}/edit`, null],
    ['a dangerous word', `${origin}/app/delete/1`, null],
    ['the session-lost path', `${origin}${LOGIN_PATH}/x`, null],
    ['credentials', 'http://user:secret@127.0.0.1:8080/app/edit', null],
    ['not http', 'chrome-error://chromewebdata/', null],
  ] as const)('%s', (_label, moved, expected) => {
    expect(spaRoutePageOf(pressed, moved, options)).toBe(expected);
  });
  it('an allowed origin that is not an approved test origin', () => {
    const other = 'http://127.0.0.1:9090';
    expect(spaRoutePageOf(`${other}/app/list` as NormalizedHttpUrlEvidence, `${other}/app/edit`, options)).toBeNull();
  });
});

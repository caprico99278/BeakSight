// T44g（Task 44 の設計書 P4-1 と、設計の変更の履歴の「T44g の Blocker」の行。案 2）: 成果物に書く前に、記録した要求の URL（network の Evidence の要求・応答・
// 失敗、resource timing、Safety の止めた記録）の、query のすべての値・値に見える path の区切り・fragment の値・userinfo を伏せる部品（`src/safety/redact.ts`）。
// - 規則は承認したサービスの Origin の URL と同じ（`redactServiceOriginUrl`）に、userinfo の伏せ方（`redactUrlCredentials`）を加えたもの（1 か所）。
// - 値の木の中で、要求の URL の一覧の名前（`RECORDED_REQUEST_URL_LIST_NAMES`）の配列の項目の `url` だけを伏せる。ページの URL・リンクなど、ほかの文字列は変えない。
// - 入力は変えない。同じ値を 2 回通しても変わらない。
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/core/redaction.js';
import {
  RECORDED_REQUEST_URL_LIST_NAMES,
  redactRecordedRequestUrl,
  redactRecordedRequestUrlsInValue,
} from '../../src/safety/redact.js';
import { startCpuStopwatch } from '../architecture/source-scan.js';

const HEX_VALUE = '0123456789abcdef0123456789abcdef';
/** T44R2 の I-2: 時間を確かめる合成の値の大きさ（140 ページ × 要求 200 件 × 文字列 2,000 個）と、上限の時間（ms。ブラウザなし）。 */
const PERF_PAGES = 140;
const PERF_REQUESTS_PER_PAGE = 200;
const PERF_STRINGS_PER_PAGE = 2_000;
const REDACTION_TIME_LIMIT_MS = 10_000;
const REDACTION_TEST_TIMEOUT_MS = 120_000;
/** T44R5 の m-1: 同じ芯（`/p?id=1`）の、末尾だけ違う identity の数と、上限の時間（ms。ブラウザなし）。 */
const SAME_CORE_IDENTITIES = 8_000;
const SAME_CORE_TIME_LIMIT_MS = 100;
const RAW = `https://user:pass@example.com/api/items/${HEX_VALUE}/detail?marker=mark-a&token=mark-b&empty=#frag=mark-c`;
const REDACTED_URL = `https://${REDACTED}@example.com/api/items/${REDACTED}/detail?marker=${REDACTED}&token=${REDACTED}&empty=#frag=${REDACTED}`;

describe('T44g: the redaction of the recorded request URLs (P4-1)', () => {
  it('redacts every query value, the value-like path segments, the fragment values and the userinfo, and keeps the names', () => {
    expect(redactRecordedRequestUrl(RAW)).toBe(REDACTED_URL);
    expect(redactRecordedRequestUrl(REDACTED_URL)).toBe(REDACTED_URL);
    expect(redactRecordedRequestUrl('https://example.com/app.js')).toBe('https://example.com/app.js');
  });

  it('lists the names of the request URL lists (network, resource timing and the Safety blocked records)', () => {
    expect([...RECORDED_REQUEST_URL_LIST_NAMES]).toEqual(expect.arrayContaining([
      'requests', 'responses', 'failures', 'resources',
      'blockedRequests', 'blockedNavigations', 'blockedWebSockets', 'blockedExternalActions',
      'blockedInteractionRequests', 'blockedInteractionNavigations', 'blockedPopups', 'blockedDownloads', 'blockedInteractionWebSockets',
    ]));
  });

  it('redacts only the url of the items of the request URL lists in a value tree, and does not change the input', () => {
    const input = {
      pageUrl: 'https://example.com/list?marker=mark-a',
      evidence: [
        { type: 'network', payload: { requests: [{ url: RAW, method: 'GET' }], responses: [{ url: RAW }], failures: [{ url: RAW }] } },
        { type: 'performance', payload: { resources: [{ url: RAW, initiatorType: 'fetch' }] } },
        {
          type: 'safety',
          payload: {
            blockedRequests: [{ method: 'POST', url: RAW, reason: 'NON_READ_METHOD' }],
            blockedExternalActions: [{ candidateId: 'c', url: null, reason: 'EXTERNAL_ORIGIN' }],
            blockedAuditExclusions: { count: 1, events: [{ method: 'GET', url: RAW, mainFrameNavigation: false, reason: 'AUDIT_EXCLUDED_URL' }] },
            passedAuditSendRequests: { count: 1, requests: [{ method: 'POST', origin: 'https://example.com', path: '/api', count: 1 }] },
          },
        },
        { type: 'link', payload: { links: [{ url: 'https://example.com/next?marker=mark-a' }] } },
      ],
    };
    const before = structuredClone(input);
    const output = redactRecordedRequestUrlsInValue(input);
    expect(input).toEqual(before);
    expect(output.pageUrl).toBe(input.pageUrl);
    const [network, performance, safety, link] = output.evidence;
    expect(network?.payload).toEqual({ requests: [{ url: REDACTED_URL, method: 'GET' }], responses: [{ url: REDACTED_URL }], failures: [{ url: REDACTED_URL }] });
    expect(performance?.payload).toEqual({ resources: [{ url: REDACTED_URL, initiatorType: 'fetch' }] });
    expect(safety?.payload).toMatchObject({
      blockedRequests: [{ url: REDACTED_URL }],
      blockedExternalActions: [{ url: null }],
      blockedAuditExclusions: { events: [{ url: REDACTED_URL }] },
      passedAuditSendRequests: { requests: [{ path: '/api' }] },
    });
    expect(link).toEqual(input.evidence[3]);
    expect(redactRecordedRequestUrlsInValue(output)).toEqual(output);
  });
});

// T44R の C-1（Task 44 の設計書の履歴の「T44R …と設計者の判断」の行）: (a) 項目の名前で伏せる欄を足し、(b) 記録した要求の URL と同じ値をほかの文字列でも伏せる。
describe('T44R C-1: the named fields and the value matching of the recorded request URLs', () => {
  const SUB = 'https://example.com/api/data?mk=mark-a';
  const SUB_REDACTED = `https://example.com/api/data?mk=${REDACTED}`;
  const DOCUMENT = 'https://example.com/list?page=2';

  it('redacts serverTiming, telemetry, images, the console location, the page error stack and the URL headers by name', () => {
    const output = redactRecordedRequestUrlsInValue({
      serverTiming: [{ source: 'RESOURCE', url: SUB }],
      telemetryHeaders: [{ url: SUB, values: { location: '/x?mk=mark-b', 'Content-Location': '/y?mk=mark-c', refresh: '0; url=/z?mk=mark-d', 'x-request-id': 'abc' } }],
      telemetryCandidates: [{ url: SUB }],
      images: [{ src: '/hero.png?mk=mark-e', resolvedUrl: 'https://example.com/hero.png?mk=mark-e', alt: 'hero' }],
      consoleMessages: [{ type: 'error', text: 'x', location: { url: 'https://example.com/s.js?mk=mark-f', lineNumber: 1 } }],
      pageErrors: [{ name: 'Error', message: 'boom', stack: 'Error: boom\n at https://example.com/s.js?mk=mark-f:1:69' }],
    });
    expect(JSON.stringify(output)).not.toMatch(/mark-[a-f]/u);
    expect(output.telemetryHeaders[0]?.values['x-request-id']).toBe('abc');
    expect(output.images[0]).toEqual({ src: `/hero.png?mk=${REDACTED}`, resolvedUrl: `https://example.com/hero.png?mk=${REDACTED}`, alt: 'hero' });
  });

  it('redacts the same value and its path and query form in the other strings, but not the main frame document URL (the page identity)', () => {
    const output = redactRecordedRequestUrlsInValue({
      pageUrl: DOCUMENT,
      evidence: [{ payload: { requests: [
        { url: DOCUMENT, isNavigationRequest: true, isMainFrame: true },
        { url: SUB, isNavigationRequest: false, isMainFrame: true },
      ] } }],
      findings: [{ message: `例: GET ${SUB}`, identity: '/api/data?mk=mark-a' }],
    });
    expect(output.pageUrl).toBe(DOCUMENT);
    expect(output.findings[0]).toEqual({ message: `例: GET ${SUB_REDACTED}`, identity: `/api/data?mk=${REDACTED}` });
    expect(output.evidence[0]?.payload.requests[0]?.url).toBe(`https://example.com/list?page=${REDACTED}`);
  });

  it('does not match the values when matchValues is false (the checkpoint state keeps the crawl URLs)', () => {
    const input = { queue: [SUB], requests: [{ url: SUB }] };
    const output = redactRecordedRequestUrlsInValue(input, { matchValues: false });
    expect(output).toEqual({ queue: [SUB], requests: [{ url: SUB_REDACTED }] });
  });
});

// T44R2 の I-1・I-2・I-3（Task 44 の設計書の履歴の 2026-10-22 の行）: 値で照らす段は、URL の候補の区切りで分けた字句が、記録した要求の URL（か、その path と
// query の形、その HTML のエスケープの形）にまるごと等しいときだけ替える（部分一致にしない）。main frame の文書の URL に等しい字句には当てない。引くのは Map。
describe('T44R2: the value matching replaces only whole tokens', () => {
  const H = 'http://127.0.0.1:5000';
  /** ページの結果の形（ページの URL、Finding、network の Evidence）。 */
  const pageOf = (pageUrl: string, requests: readonly { readonly url: string; readonly nav?: boolean }[], extra: Record<string, unknown> = {}) => ({
    pageUrl,
    finalUrl: pageUrl,
    findings: [{ message: `see ${pageUrl}`, identity: `X|${pageUrl}` }],
    evidence: { network: { requests: requests.map(({ url, nav }) => ({ url, method: 'GET', isNavigationRequest: nav === true, isMainFrame: nav === true })) } },
    ...extra,
  });
  /** ページの URL と、Finding の本文と identity（main frame の文書の URL を含む）が、そのまま残るか。 */
  const expectPageIdentityKept = (output: ReturnType<typeof pageOf>, pageUrl: string): void => {
    expect(output.pageUrl).toBe(pageUrl);
    expect(output.finalUrl).toBe(pageUrl);
    expect(output.findings).toEqual([{ message: `see ${pageUrl}`, identity: `X|${pageUrl}` }]);
  };

  it('keeps the page URL when a recorded request URL is a prefix of it', () => {
    const pageUrl = `${H}/?q=SECRET1&p=2`;
    expectPageIdentityKept(redactRecordedRequestUrlsInValue(pageOf(pageUrl, [{ url: pageUrl, nav: true }, { url: `${H}/?q=SECRET1` }])), pageUrl);
  });

  it('keeps the page URL when a recorded request URL is its numeric prefix (/news?id=1 and /news?id=10)', () => {
    const pageUrl = `${H}/news?id=10`;
    expectPageIdentityKept(redactRecordedRequestUrlsInValue(pageOf(pageUrl, [{ url: pageUrl, nav: true }, { url: `${H}/news?id=1` }])), pageUrl);
  });

  it('keeps another page URL of the Run that starts with a recorded request URL of a page', () => {
    const second = `${H}/list?page=2&sort=a`;
    const output = redactRecordedRequestUrlsInValue({ pages: [
      pageOf(`${H}/list?page=1`, [{ url: `${H}/list?page=1`, nav: true }, { url: `${H}/list?page=2` }]),
      pageOf(second, [{ url: second, nav: true }]),
    ] });
    expectPageIdentityKept(output.pages[1] as ReturnType<typeof pageOf>, second);
  });

  it('keeps the start URL of the configuration that starts with a recorded request URL', () => {
    const startUrl = `${H}/list?page=2&x=1`;
    const output = redactRecordedRequestUrlsInValue({
      config: { site: { startUrl } },
      ...pageOf(`${H}/`, [{ url: `${H}/`, nav: true }, { url: `${H}/list?page=2` }]),
    });
    expect(output.config.site.startUrl).toBe(startUrl);
  });

  it('replaces the whole tokens of the recorded URL, its path and query form and its HTML-escaped form', () => {
    const output = redactRecordedRequestUrlsInValue({
      ...pageOf(`${H}/`, [{ url: `${H}/`, nav: true }, { url: `${H}/m.png?a=SECRET4&b=2` }]),
      texts: ['<img src="/m.png?a=SECRET4&amp;b=2" alt="x">', `例: GET ${H}/m.png?a=SECRET4&b=2 を止めました`, `"/m.png?a=SECRET4&b=2"`],
    });
    expect(JSON.stringify(output.texts)).not.toContain('SECRET4');
    expect(output.texts[0]).toBe(`<img src="/m.png?a=${REDACTED}&amp;b=${REDACTED}" alt="x">`);
  });

  // 記録した要求の URL は ASCII の形（非 ASCII は百分率の符号化）なので、字句の中の ASCII の連なりごとにも、まるごと等しいかを見る（Finding の文の
  // 「（例: POST <URL>）。」の形。ASCII の文字が続く prefix は替えない）。
  it('replaces the recorded URL followed or preceded by non-ASCII characters, but not its ASCII-continued prefix', () => {
    const output = redactRecordedRequestUrlsInValue({
      ...pageOf(`${H}/`, [{ url: `${H}/`, nav: true }, { url: `${H}/api/b?mk=SECRET5` }]),
      texts: [`遮断しました（例: POST ${H}/api/b?mk=SECRET5）。`, `例：${H}/api/b?mk=SECRET5、ほか`, `${H}/api/b?mk=SECRET50）`],
    });
    expect(output.texts).toEqual([
      `遮断しました（例: POST ${H}/api/b?mk=${REDACTED}）。`,
      `例：${H}/api/b?mk=${REDACTED}、ほか`,
      `${H}/api/b?mk=SECRET50）`,
    ]);
  });

  it(`redacts a Run of ${String(PERF_PAGES)} pages x ${String(PERF_REQUESTS_PER_PAGE)} requests x ${String(PERF_STRINGS_PER_PAGE)} strings within the named time limit`, () => {
    const run = {
      pages: Array.from({ length: PERF_PAGES }, (_unused, page) => ({
        pageUrl: `${H}/p/${String(page)}`,
        evidence: {
          network: {
            requests: [
              { url: `${H}/p/${String(page)}`, isNavigationRequest: true, isMainFrame: true },
              ...Array.from({ length: PERF_REQUESTS_PER_PAGE }, (_none, request) => ({
                url: `${H}/api/item/${String(request)}?page=${String(page)}&v=${String(request)}x`, isNavigationRequest: false, isMainFrame: false,
              })),
            ],
          },
          // T44R3 の M-1: 文の半分に、末尾と先頭を外して引く形（stack の行と列、括弧、`,`）の URL を入れる。
          dom: { texts: Array.from({ length: PERF_STRINGS_PER_PAGE }, (_none, text) => (text % 2 === 0
            ? `テキスト ${String(page)} ${String(text)} ふつうの文の例です。`
            : `at f (${H}/api/item/${String(text % PERF_REQUESTS_PER_PAGE)}?page=${String(page)}&v=${String(text % PERF_REQUESTS_PER_PAGE)}x:1:15), 次`)) },
        },
      })),
    };
    // 速さは CPU の時間で測る（並行の混雑で延びる壁時計で測らない。TS-d）。
    const stopwatch = startCpuStopwatch();
    const output = redactRecordedRequestUrlsInValue(run);
    expect(stopwatch.elapsedMs()).toBeLessThan(REDACTION_TIME_LIMIT_MS);
    expect(output.pages[0]?.evidence.network.requests[1]?.url).toBe(`${H}/api/item/0?page=${REDACTED}&v=${REDACTED}`);
    expect(output.pages[0]?.evidence.dom.texts[1]).toBe(`at f (${H}/api/item/1?page=${REDACTED}&v=${REDACTED}:1:15), 次`);
  }, REDACTION_TEST_TIMEOUT_MS);
});

// T44R3 の I-1（Task 44 の設計書の履歴の 2026-10-22 の T44R3 の行）: 照らさない値は、ページの identity に限る（`pageUrl`・`finalUrl`、許して読み込んだ
// main frame の文書の要求（応答のあるもの）とそのリダイレクトの連鎖、呼び出し側が渡す巡回の URL）。止めた main frame の POST（form の送信）の URL は照らす。
// 止めた記録（`blocked*`）の URL は、`pageUrl`・`finalUrl` に等しいものだけを除いて照らす。
describe('T44R3: the values kept from the value matching are only the page identity', () => {
  const H = 'http://127.0.0.1:5000';
  const PAGE = `${H}/form`;
  const SUBMIT = `${H}/submit?order=SECRET6`;
  const SUBMIT_REDACTED = `${H}/submit?order=${REDACTED}`;
  /** 止めた form の POST のページの結果の形（network の要求と失敗、Safety の止めた記録、Finding、navigation timing）。 */
  const blockedFormPage = () => ({
    pageUrl: PAGE,
    finalUrl: PAGE,
    evidence: [
      { payload: {
        requests: [
          { requestId: 'R1', url: PAGE, method: 'GET', isNavigationRequest: true, isMainFrame: true, redirectChainRequestIds: [] },
          { requestId: 'R2', url: SUBMIT, method: 'POST', isNavigationRequest: true, isMainFrame: true, redirectChainRequestIds: [] },
        ],
        responses: [{ requestId: 'R1', url: PAGE, status: 200, isNavigationRequest: true, isMainFrame: true }],
        failures: [{ requestId: 'R2', url: SUBMIT, method: 'POST', isNavigationRequest: true, isMainFrame: true }],
      } },
      { payload: { blockedRequests: [{ method: 'POST', url: SUBMIT, reason: 'NON_READ_METHOD' }] } },
      { payload: { navigationTiming: { url: SUBMIT, navigationType: 'navigate' } } },
    ],
    findings: [{ pageUrl: PAGE, message: `読み取り以外のメソッド（POST）のリクエストを 1 件遮断しました（例: POST ${SUBMIT}）。` }],
  });

  it('redacts the blocked main frame POST URL in the Finding text and the navigation timing', () => {
    const output = redactRecordedRequestUrlsInValue(blockedFormPage());
    expect(JSON.stringify(output)).not.toContain('SECRET6');
    expect(output.findings[0]?.message).toBe(`読み取り以外のメソッド（POST）のリクエストを 1 件遮断しました（例: POST ${SUBMIT_REDACTED}）。`);
    expect(output.evidence[2]?.payload.navigationTiming?.url).toBe(SUBMIT_REDACTED);
    expect(output.pageUrl).toBe(PAGE);
  });

  it('keeps the loaded main frame document and its redirect chain, and redacts a document request without a response', () => {
    const from = `${H}/old?id=SECRET7`;
    const to = `${H}/new?id=SECRET8`;
    const canceled = `${H}/next?id=SECRET9`;
    const output = redactRecordedRequestUrlsInValue({
      pageUrl: `${H}/start`,
      finalUrl: `${H}/start`,
      evidence: [{ payload: {
        requests: [
          { requestId: 'R1', url: from, isNavigationRequest: true, isMainFrame: true, redirectChainRequestIds: [] },
          { requestId: 'R2', url: to, isNavigationRequest: true, isMainFrame: true, redirectChainRequestIds: ['R1'] },
          { requestId: 'R3', url: canceled, isNavigationRequest: true, isMainFrame: true, redirectChainRequestIds: [] },
        ],
        responses: [{ requestId: 'R2', url: to, status: 200, isNavigationRequest: true, isMainFrame: true }],
      } }],
      texts: [`from ${from}`, `to ${to}`, `canceled ${canceled}`],
    });
    expect(output.texts).toEqual([`from ${from}`, `to ${to}`, `canceled ${H}/next?id=${REDACTED}`]);
  });

  it('keeps a blocked URL equal to the page URL', () => {
    const page = `${H}/p?id=SECRET10`;
    const output = redactRecordedRequestUrlsInValue({
      pageUrl: page,
      finalUrl: page,
      evidence: [{ payload: { blockedNavigations: [{ method: 'POST', url: page, reason: 'NON_READ_METHOD' }] } }],
      texts: [`例: POST ${page}`],
    });
    expect(output.texts).toEqual([`例: POST ${page}`]);
    expect(output.pageUrl).toBe(page);
  });

  // T44R3 の M-2: 保存のページを書くとき、巡回が知っている URL（呼び出し側が渡す）も照らさない（続けて終えた Run と同じ結果）。
  it('keeps the crawl URLs passed by the caller', () => {
    const later = `${H}/news?id=11`;
    const output = redactRecordedRequestUrlsInValue({
      pageUrl: `${H}/news?id=10`,
      evidence: [{ payload: { requests: [{ requestId: 'R2', url: later, isNavigationRequest: false, isMainFrame: true }] } }],
      links: [{ rawHref: '/news?id=11', url: later }],
    }, { keptUrls: [later] });
    expect(output.links).toEqual([{ rawHref: '/news?id=11', url: later }]);
    expect(output.evidence[0]?.payload.requests[0]?.url).toBe(`${H}/news?id=${REDACTED}`);
  });
});

// T44R3 の M-1: 字句の中の ASCII の連なりを引くとき、末尾の行と列（`:\d+(:\d+)?`）・閉じ括弧・`,`・`.` と、先頭の `(`・`url(` を外した形でも引く。
// CSS の `url(…)` は、連なりの中でも中身を引く。外すのはこれらの字だけ（ASCII の字が続く接頭辞は替えない）。
describe('T44R3: the value matching strips the stack positions, the brackets and the punctuation around the URL', () => {
  const H = 'http://127.0.0.1:5000';
  const redactTexts = (requests: readonly string[], texts: readonly string[]) => redactRecordedRequestUrlsInValue({
    pageUrl: `${H}/`,
    finalUrl: `${H}/`,
    evidence: [{ payload: { requests: requests.map((url) => ({ url, isNavigationRequest: false, isMainFrame: true })) } }],
    texts,
  }).texts;

  it('replaces the stack line, the parenthesized, the comma-followed and the CSS url forms', () => {
    expect(redactTexts([`${H}/s2.js?v=SECRET11`, `${H}/api/p?mk=SECRET12`, `${H}/api/c?mk=SECRET13`, `${H}/bg2.png?mk=SECRET14`], [
      `Error: stackprobe\n at ${H}/s2.js?v=SECRET11:1:15`,
      `at f (${H}/s2.js?v=SECRET11:3:9)`,
      `ref (${H}/api/p?mk=SECRET12)`,
      `list ${H}/api/c?mk=SECRET13, next ${H}/api/c?mk=SECRET13.`,
      'background-image:url(/bg2.png?mk=SECRET14);width:40px',
      'url(/bg2.png?mk=SECRET14)',
    ])).toEqual([
      `Error: stackprobe\n at ${H}/s2.js?v=${REDACTED}:1:15`,
      `at f (${H}/s2.js?v=${REDACTED}:3:9)`,
      `ref (${H}/api/p?mk=${REDACTED})`,
      `list ${H}/api/c?mk=${REDACTED}, next ${H}/api/c?mk=${REDACTED}.`,
      `background-image:url(/bg2.png?mk=${REDACTED});width:40px`,
      `url(/bg2.png?mk=${REDACTED})`,
    ]);
  });

  it('does not replace a prefix continued by other ASCII characters', () => {
    expect(redactTexts([`${H}/news?id=1`], [
      `${H}/news?id=10:1:2`,
      `(${H}/news?id=1.5)`,
      `${H}/news?id=1(2)`,
      `x${H}/news?id=1`,
    ])).toEqual([
      `${H}/news?id=10:1:2`,
      `(${H}/news?id=1.5)`,
      `${H}/news?id=1(2)`,
      `x${H}/news?id=1`,
    ]);
  });
});

// T44R4 の I-1（Task 44 の設計書の履歴の 2026-10-22 の T44R4 の行）: 末尾や先頭の字を外して引く形で、ページの identity の URL（`pageUrl`・`finalUrl`・
// `requestedUrl`・設定の `startUrl` と、それらの path と query の形）そのものを書き換えない。identity の欄に `startUrl`・`requestedUrl` も加える。
describe('T44R4: the stripped forms do not rewrite the page identity', () => {
  const H = 'http://127.0.0.1:5000';
  /** ページ `pageUrl` が、文書でない要求 `/news?id=1`（`pageUrl` から末尾の字を外した形）を出し、自分へのリンクを持つ Run の形。 */
  const runOf = (pageUrl: string) => ({
    config: { site: { startUrl: pageUrl } },
    pages: [{
      pageUrl,
      viewports: { desktop: { requestedUrl: pageUrl, finalUrl: pageUrl } },
      evidence: [
        { payload: { requests: [
          { requestId: 'R1', url: pageUrl, isNavigationRequest: true, isMainFrame: true, redirectChainRequestIds: [] },
          { requestId: 'R2', url: `${H}/news?id=1`, isNavigationRequest: false, isMainFrame: true, redirectChainRequestIds: [] },
        ], responses: [{ requestId: 'R1', url: pageUrl, status: 200 }] } },
        { payload: { links: [{ rawHref: pageUrl.slice(H.length), normalized: { ok: true, url: pageUrl } }] } },
      ],
      texts: [`(${pageUrl})`, `see ${H}/news?id=1 and ${H}/news?id=1:3:9`],
    }],
  });

  it.each([`${H}/news?id=1.`, `${H}/news?id=1:10`, `${H}/news?id=1)`, `${H}/news?id=1,`])('keeps the page identity %s, and redacts the request URL', (pageUrl) => {
    const input = runOf(pageUrl);
    const output = redactRecordedRequestUrlsInValue(input);
    const [page] = output.pages;
    expect(output.config.site.startUrl).toBe(pageUrl);
    expect(page?.pageUrl).toBe(pageUrl);
    expect(page?.viewports.desktop).toEqual({ requestedUrl: pageUrl, finalUrl: pageUrl });
    expect(page?.evidence[1]).toEqual(input.pages[0]?.evidence[1]);
    expect(page?.texts).toEqual([`(${pageUrl})`, `see ${H}/news?id=${REDACTED} and ${H}/news?id=${REDACTED}:3:9`]);
  });

  // T44R5 の m-2: 末尾は区切り（外す字の連なりの境目と `:` の位置）の単位で比べる（`:1` の identity は、`:10:3` の末尾の前の部分ではない）。
  it('compares the stripped tails by the boundaries, not by the characters', () => {
    const output = redactRecordedRequestUrlsInValue({
      config: { site: { startUrl: `${H}/s?id=1:1` } },
      requests: [{ url: `${H}/s?id=1` }],
      texts: [`at ${H}/s?id=1:10:3`, `at ${H}/s?id=1:1`, `at ${H}/s?id=1:1:15`, `(${H}/s?id=1:1)`],
    });
    expect(output.texts).toEqual([`at ${H}/s?id=${REDACTED}:10:3`, `at ${H}/s?id=1:1`, `at ${H}/s?id=1:1:15`, `(${H}/s?id=1:1)`]);
    expect(output.config.site.startUrl).toBe(`${H}/s?id=1:1`);
  });

  // T44R5 の m-1: 同じ芯の identity が多くても、時間は字句の長さに比例する（一覧をたどらない）。
  it(`keeps the time within the named limit with ${String(SAME_CORE_IDENTITIES)} identities of the same core`, () => {
    const value = {
      pages: Array.from({ length: SAME_CORE_IDENTITIES }, (_unused, index) => ({ pageUrl: `${H}/p?id=1:${String(index + 2)}` })),
      requests: [{ url: `${H}/p?id=1` }],
      big: `${H}/p?id=1:1, `.repeat(SAME_CORE_IDENTITIES),
    };
    // 速さは CPU の時間で測る（TS-d。DEF-153 と同じ型の揺らぎが、組 G・DF-1 の報告で出た）。
    const stopwatch = startCpuStopwatch();
    const output = redactRecordedRequestUrlsInValue(value);
    expect(stopwatch.elapsedMs()).toBeLessThan(SAME_CORE_TIME_LIMIT_MS);
    expect(output.big.startsWith(`${H}/p?id=${REDACTED}:1, `)).toBe(true);
    expect(output.pages[SAME_CORE_IDENTITIES - 1]?.pageUrl).toBe(`${H}/p?id=1:${String(SAME_CORE_IDENTITIES + 1)}`);
  }, REDACTION_TEST_TIMEOUT_MS);

  it('keeps the start URL and the requested URL without a page URL in the value tree', () => {
    const startUrl = `${H}/news?id=1.`;
    const output = redactRecordedRequestUrlsInValue({
      config: { site: { startUrl } },
      viewport: { requestedUrl: `${H}/news?id=1:10` },
      requests: [{ url: `${H}/news?id=1` }],
    });
    expect(output.config.site.startUrl).toBe(startUrl);
    expect(output.viewport.requestedUrl).toBe(`${H}/news?id=1:10`);
  });
});

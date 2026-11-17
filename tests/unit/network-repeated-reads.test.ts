// 設計者の判断 2026-11-11（要求を出し続ける画面で、監査の段のメモリが増え続ける件）: network の collector は、同じ口への成功した読み取りのくり返しを、1 件ずつの
// 記録にせず、数でまとめる（`repeatedReads`）。HTTP の誤り・失敗は、今までどおり 1 件ずつ残す。落ち着きの待ちのためだけの口（`DataActivityCollector`）は、
// 要求ごとの記録を持たない。偽のページ（要求の事象を流す）で確かめる。ブラウザを使わない。
import { EventEmitter } from 'node:events';
import { unzipSync } from 'fflate';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { NetworkRepeatedReadEvidence } from '../../src/core/evidence-types.js';
import { DataActivityCollector, NetworkCollector } from '../../src/evidence/network-collector.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, network as networkRecord, page } from '../helpers/audit-run-fixture.js';
import { fakePlaywrightRequest } from '../helpers/fake-playwright-request.js';

const ORIGIN = 'https://example.test';

interface FakeTiming {
  readonly startTime: number;
  readonly responseEnd: number;
}

const timingOf = ({ startTime, responseEnd }: FakeTiming) => ({
  startTime,
  domainLookupStart: -1,
  domainLookupEnd: -1,
  connectStart: -1,
  secureConnectionStart: -1,
  connectEnd: -1,
  requestStart: 0,
  responseStart: responseEnd,
  responseEnd,
});

/** 要求の事象を流せる偽のページ。 */
function fakePage() {
  const events = new EventEmitter();
  const mainFrame = { url: () => `${ORIGIN}/` };
  const page = {
    on: (name: string, listener: (...args: unknown[]) => void) => events.on(name, listener),
    off: (name: string, listener: (...args: unknown[]) => void) => events.off(name, listener),
    mainFrame: () => mainFrame,
  } as unknown as Page;
  /** ブラウザへの読み取りの数（要求のヘッダ・応答のヘッダ・転送量）。 */
  const reads = { requestHeaders: 0, responseHeaders: 0, sizes: 0 };
  /**
   * 要求を始め、応答を返し、終える（`failure` を渡すと、応答なしで失敗にする）。`inFlight` なら、応答を返した後に終えない（ページが本文を読まない fetch。
   * Chromium は終わりの事象を出さず、本文の読み取りも返らない）。`noResponse` なら、始めるだけ（応答もない）。
   */
  const send = (spec: {
    readonly path: string;
    readonly method?: string;
    readonly resourceType?: string;
    readonly status?: number;
    readonly timing: FakeTiming;
    readonly bodyBytes?: number;
    readonly failure?: string;
    readonly inFlight?: boolean;
    readonly noResponse?: boolean;
  }): void => {
    const request = fakePlaywrightRequest({
      url: `${ORIGIN}${spec.path}`,
      method: spec.method ?? 'GET',
      resourceType: spec.resourceType ?? 'fetch',
      navigation: false,
      frame: mainFrame,
      ...(spec.failure === undefined ? {} : { failureText: spec.failure }),
    }, {
      allHeaders: async () => {
        reads.requestHeaders += 1;
        return { accept: '*/*' };
      },
      timing: () => timingOf(spec.timing),
      redirectedFrom: () => null,
      sizes: async () => {
        reads.sizes += 1;
        return { responseHeadersSize: 10, responseBodySize: spec.bodyBytes ?? 2 };
      },
    });
    events.emit('request', request);
    if (spec.failure !== undefined) {
      events.emit('requestfailed', request);
      return;
    }
    if (spec.noResponse === true) {
      return;
    }
    const response = {
      request: () => request,
      url: () => `${ORIGIN}${spec.path}`,
      status: () => spec.status ?? 200,
      statusText: () => 'OK',
      allHeaders: async () => {
        reads.responseHeaders += 1;
        return { 'content-type': 'text/plain' };
      },
      headers: () => ({ 'content-type': 'text/plain' }),
      body: () => (spec.inFlight === true ? new Promise<Buffer>(() => undefined) : Promise.resolve(Buffer.from('not found'))),
    };
    events.emit('response', response);
    if (spec.inFlight !== true) {
      events.emit('requestfinished', request);
    }
  };
  return { page, send, reads, listenerCount: () => events.eventNames().reduce((sum, name) => sum + events.listenerCount(name), 0) };
}

describe('the repeated successful reads of the same endpoint are counted, not recorded one by one', () => {
  it('keeps the first read as a record and counts the rest with the first, the slowest, the times, the transfer and the distinct queries', async () => {
    const { page, send } = fakePage();
    const network = NetworkCollector.attach(page);
    send({ path: '/api/ping?t=a', timing: { startTime: 1_000, responseEnd: 5 }, bodyBytes: 2 });
    send({ path: '/api/ping?t=b', timing: { startTime: 1_020, responseEnd: 40 }, bodyBytes: 3 });
    send({ path: '/api/ping?t=a', timing: { startTime: 1_040, responseEnd: 7 }, bodyBytes: 4 });

    const evidence = await network.snapshot();
    network.detach();

    expect(evidence.requests.map(({ url }) => url)).toEqual([`${ORIGIN}/api/ping?t=a`]);
    expect(evidence.responses.map(({ url }) => url)).toEqual([`${ORIGIN}/api/ping?t=a`]);
    const [group] = evidence.repeatedReads ?? [];
    expect(evidence.repeatedReads).toHaveLength(1);
    expect(group).toMatchObject({
      method: 'GET',
      origin: ORIGIN,
      path: '/api/ping',
      resourceType: 'fetch',
      status: 200,
      isMainFrame: true,
      count: 3,
      firstRequestId: evidence.requests[0]?.requestId,
      first: { url: `${ORIGIN}/api/ping?t=a`, timing: { startTime: 1_000, responseEnd: 5 } },
      slowest: { url: `${ORIGIN}/api/ping?t=b`, timing: { startTime: 1_020, responseEnd: 40 } },
      firstStartTime: 1_000,
      lastStartTime: 1_040,
      transfer: { observedCount: 3, totalBytes: 10 + 2 + 10 + 3 + 10 + 4 },
      distinctQueryCount: 2,
    });
  });

  // DEF-245 の続き: ページが本文を読まない要求は終わらない（Chromium が終わりの事象を出さず、本文の読み取りも返らない）。写しは、終わりまで返らない読み取りを
  // 待たず、応答を受けた時点の事実を写す（本文の要旨は読めなかった、転送量は未観測）。
  it('does not wait for the body of a response whose request has not ended, and takes the facts at the response', async () => {
    const { page, send } = fakePage();
    const network = NetworkCollector.attach(page);
    send({ path: '/api/me', status: 401, timing: { startTime: 1_000, responseEnd: -1 }, inFlight: true });

    const evidence = await network.snapshot({ watch: { quietLimitMs: 60_000 } });
    network.detach();

    const [response] = evidence.responses;
    expect(response).toMatchObject({ status: 401, transferSize: { status: 'NOT_OBSERVED' }, errorContext: { bodySummary: { status: 'NONE', reason: 'UNREADABLE' } } });
  });

  // 設計者の判断 2026-11-11 の C（1 件を小さくする）: ヘッダの読み取りは、要求が終わった後に、1 件の記録として残す要求にだけ行う。まとめる要求は、転送量だけを
  // 読む（要求ごとのブラウザへの読み取りを、要求の速さで積み上げない）。終わっていない要求のヘッダは、写しのときに読む。
  it('reads the headers only of the records it keeps, after the request ends, and of the requests still in flight at the snapshot', async () => {
    const { page, send, reads } = fakePage();
    const network = NetworkCollector.attach(page);
    send({ path: '/api/ping?t=a', timing: { startTime: 1_000, responseEnd: 5 } });
    send({ path: '/api/ping?t=b', timing: { startTime: 1_010, responseEnd: 5 } });
    send({ path: '/api/ping?t=c', timing: { startTime: 1_020, responseEnd: 5 } });
    send({ path: '/api/missing', status: 404, timing: { startTime: 1_030, responseEnd: 5 } });
    // まとめた 2 件は、ヘッダを読まない（転送量だけ）。残す 2 件は、終わった後に読む。
    expect(reads).toEqual({ requestHeaders: 2, responseHeaders: 2, sizes: 4 });
    send({ path: '/api/slow', timing: { startTime: 1_040, responseEnd: 5 }, inFlight: true });
    expect(reads).toEqual({ requestHeaders: 2, responseHeaders: 2, sizes: 4 });

    const evidence = await network.snapshot();
    network.detach();

    expect(reads).toEqual({ requestHeaders: 3, responseHeaders: 3, sizes: 4 });
    expect(evidence.requests.map(({ headers }) => headers.status)).toEqual(['OBSERVED', 'OBSERVED', 'OBSERVED']);
    expect(evidence.responses.map(({ headers }) => headers.status)).toEqual(['OBSERVED', 'OBSERVED', 'OBSERVED']);
  });

  // 設計者の判断 2026-11-11 の続き: query の値の違いは、文字列でなく短い digest で数える（1 件あたりを小さくする）。数は、文字列で数えた場合と同じ。
  it('counts the distinct queries as many as the distinct query strings, with repeated, empty and long values', async () => {
    const { page, send } = fakePage();
    const network = NetworkCollector.attach(page);
    const queries = [
      ...Array.from({ length: 2_000 }, (_value, index) => `?t=${String(index * 7919 % 1_000)}.${'x'.repeat(index % 5)}`),
      // 長い値（前の URL の上限 2,048 文字より長い）も、切り詰めずにまとめる。
      '', '?', '?a=1&b=2', '?b=2&a=1', `?long=${'y'.repeat(4_000)}`, `?long=${'y'.repeat(4_000)}`, `?long=${'y'.repeat(3_999)}`,
    ];
    queries.forEach((query, index) => send({ path: `/api/ping${query}`, timing: { startTime: 1_000 + index, responseEnd: 1 } }));

    const evidence = await network.snapshot();
    network.detach();

    const [group] = evidence.repeatedReads ?? [];
    const distinct = new Set(queries.map((query) => new URL(`${ORIGIN}/api/ping${query}`).search));
    expect(group?.count).toBe(queries.length);
    expect(group?.distinctQueryCount).toBe(distinct.size);
  });

  // 設計者の判断 2026-11-11 の続き: URL は切り詰めない。長い URL の 1 件の記録も、まとめた記録の代表の URL も、全部残す。
  it('keeps the whole long URL in the first record and in the samples of the group', async () => {
    const { page, send } = fakePage();
    const network = NetworkCollector.attach(page);
    const longQuery = `?q=${'z'.repeat(5_000)}`;
    send({ path: `/api/search${longQuery}`, timing: { startTime: 1_000, responseEnd: 1 } });
    send({ path: `/api/search${longQuery}2`, timing: { startTime: 1_010, responseEnd: 9 } });
    send({ path: `/api/fail${longQuery}`, failure: 'net::ERR_FAILED', timing: { startTime: 1_020, responseEnd: -1 } });

    const evidence = await network.snapshot();
    network.detach();

    expect(evidence.requests.map(({ url }) => url)).toEqual([`${ORIGIN}/api/search${longQuery}`, `${ORIGIN}/api/fail${longQuery}`]);
    expect(evidence.requests.every(({ truncated }) => !truncated)).toBe(true);
    expect(evidence.responses[0]?.url).toBe(`${ORIGIN}/api/search${longQuery}`);
    expect(evidence.failures[0]).toMatchObject({ url: `${ORIGIN}/api/fail${longQuery}`, truncated: false });
    expect(evidence.repeatedReads?.[0]).toMatchObject({
      count: 2,
      first: { url: `${ORIGIN}/api/search${longQuery}` },
      slowest: { url: `${ORIGIN}/api/search${longQuery}2` },
      distinctQueryCount: 2,
    });
  });

  it('keeps every HTTP error and every failure one by one, and makes a group for each status and resource type', async () => {
    const { page, send } = fakePage();
    const network = NetworkCollector.attach(page);
    send({ path: '/api/item?i=1', status: 404, timing: { startTime: 1_000, responseEnd: 3 } });
    send({ path: '/api/item?i=2', status: 404, timing: { startTime: 1_010, responseEnd: 3 } });
    send({ path: '/api/item?i=3', failure: 'net::ERR_FAILED', timing: { startTime: 1_020, responseEnd: -1 } });
    send({ path: '/api/item?i=4', failure: 'net::ERR_FAILED', timing: { startTime: 1_030, responseEnd: -1 } });
    send({ path: '/api/item?i=5', status: 200, timing: { startTime: 1_040, responseEnd: 3 } });
    send({ path: '/api/item?i=6', status: 204, timing: { startTime: 1_050, responseEnd: 3 } });
    send({ path: '/api/item?i=7', resourceType: 'image', timing: { startTime: 1_060, responseEnd: 3 } });

    const evidence = await network.snapshot();
    network.detach();

    expect(evidence.responses.map(({ status }) => status)).toEqual([404, 404, 200, 204, 200]);
    expect(evidence.failures).toHaveLength(2);
    expect(evidence.requests).toHaveLength(7);
    // どの鍵も 1 件なので、まとめた記録はない。
    expect(evidence.repeatedReads).toBeUndefined();
  });

  it('does not count the repeated writes, nor keep the group of a single read', async () => {
    const { page, send } = fakePage();
    const network = NetworkCollector.attach(page);
    send({ path: '/api/save', method: 'POST', timing: { startTime: 1_000, responseEnd: 3 } });
    send({ path: '/api/save', method: 'POST', timing: { startTime: 1_010, responseEnd: 3 } });
    send({ path: '/api/once', timing: { startTime: 1_020, responseEnd: 3 } });

    const evidence = await network.snapshot();
    network.detach();

    expect(evidence.requests.map(({ method }) => method)).toEqual(['POST', 'POST', 'GET']);
    expect(evidence.repeatedReads).toBeUndefined();
  });
});

describe('the collector only for the page settling counts the endpoints without the records of each request', () => {
  it('gives the data request activity by endpoint, and removes its listeners when detached', () => {
    const { page, send, listenerCount } = fakePage();
    const activity = DataActivityCollector.attach(page);
    send({ path: '/api/ping?t=a', timing: { startTime: 1_000, responseEnd: 5 } });
    send({ path: '/api/ping?t=b', timing: { startTime: 1_010, responseEnd: 5 } });
    // DEF-245 の B・D の直し: 画像などの部品の読み込みも口ごとに数える（新しい口の画像が途中なら、落ち着きの判定が待つ。届いた口のくり返しは待たない）。
    send({ path: '/img.png', resourceType: 'image', timing: { startTime: 1_020, responseEnd: 5 } });
    // 応答（ヘッダ）を受けたら、終わりの事象を待たずに終わった口にする（本文を読まない fetch には、Chromium が終わりの事象を出さない）。応答のない要求は途中のまま。
    send({ path: '/hero.png', resourceType: 'image', timing: { startTime: 1_025, responseEnd: 5 }, inFlight: true });
    send({ path: '/slow.png', resourceType: 'image', timing: { startTime: 1_027, responseEnd: -1 }, noResponse: true });
    // DEF-245 の C: 失敗で終わった口も、終わった口として渡す（落ち着きの判定が、くり返しを数えない）。
    send({ path: '/api/broken', failure: 'net::ERR_FAILED', timing: { startTime: 1_030, responseEnd: -1 } });

    const endpoint = (path: string): string => JSON.stringify(['GET', ORIGIN, path]);
    expect(activity.dataRequestActivity()).toEqual({
      inFlight: 1,
      events: 11,
      endpoints: {
        inFlight: [endpoint('/slow.png')],
        completed: [endpoint('/api/ping'), endpoint('/img.png'), endpoint('/hero.png')],
        failed: [endpoint('/api/broken')],
      },
    });
    activity.detach();
    expect(listenerCount()).toBe(0);
  });
});

describe('the report view model counts the repeated reads', () => {
  const timing = timingOf({ startTime: 1_000, responseEnd: 5 });
  const repeated = (count: number, path: string): NetworkRepeatedReadEvidence => ({
    method: 'GET', origin: ORIGIN, path, resourceType: 'fetch', status: 200, isMainFrame: true, count,
    firstRequestId: 'REQ-000001', first: { url: `${ORIGIN}${path}`, timing }, slowest: { url: `${ORIGIN}${path}`, timing },
    firstStartTime: 1_000, lastStartTime: 2_000, transfer: { observedCount: count, totalBytes: count * 12 }, distinctQueryCount: count,
  });

  it('gives the number of the groups, the requests in them, and the requests not listed one by one', () => {
    const base = networkRecord(1, PAGE_1, 'desktop');
    const withRepeated = { ...base, payload: { ...base.payload, repeatedReads: [repeated(5, '/api/ping'), repeated(2, '/api/poll')] } };
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [withRepeated])] }));
    expect(model.summary.repeatedReads).toEqual({ groupCount: 2, requestCount: 7, unlistedRequestCount: 5 });
  });

  it('gives zeros for the records without the repeated reads', () => {
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [networkRecord(1, PAGE_1, 'desktop')])] }));
    expect(model.summary.repeatedReads).toEqual({ groupCount: 0, requestCount: 0, unlistedRequestCount: 0 });
  });
});

describe('the bundle tells the repeated reads', () => {
  it('puts the counts in summary.json and how to read them in README.md', async () => {
    const timing = timingOf({ startTime: 1_000, responseEnd: 5 });
    const base = networkRecord(1, PAGE_1, 'desktop');
    const withRepeated = {
      ...base,
      payload: {
        ...base.payload,
        repeatedReads: [{
          method: 'GET', origin: ORIGIN, path: '/api/ping', resourceType: 'fetch', status: 200, isMainFrame: true, count: 4,
          firstRequestId: 'REQ-000001', first: { url: `${ORIGIN}/api/ping?t=a`, timing }, slowest: { url: `${ORIGIN}/api/ping?t=b`, timing },
          firstStartTime: 1_000, lastStartTime: 2_000, transfer: { observedCount: 4, totalBytes: 48 }, distinctQueryCount: 4,
        }],
      },
    };
    const result = auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [withRepeated])] });
    const entries = unzipSync(await createChatGptBundle(buildReportViewModel(result), result, async () => null));
    const text = (path: string): string => new TextDecoder().decode(entries[path] ?? new Uint8Array());
    expect((JSON.parse(text('summary.json')) as { readonly repeatedReads: unknown }).repeatedReads)
      .toEqual({ groupCount: 1, requestCount: 4, unlistedRequestCount: 3 });
    expect(text('README.md')).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.repeatedReadsNote);
  });
});

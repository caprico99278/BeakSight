// AUD-7（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-7）: 4xx・5xx の応答の区分の表と、応答の文脈（回復・やり直し・資格・
// 画面の誤りの表示・承認したサービスか）の読み方。ブラウザを使わない。
// - 区分の閉じた一覧と決め方は `src/audit/http-error-classes.ts` の 1 か所。Rule（`HTTP_4XX`・`RESOURCE_4XX`・`RESOURCE_5XX`）は、`EXPECTED_BRANCH` を Finding にしない。
// - 画面の誤りの表示は、語（`ERROR_DISPLAY_WORDS`）が、role=alert・aria-live=assertive・見出し・aria-invalid の欄の近くの文字のどれかにあるときだけ。
import { describe, expect, it } from 'vitest';
import {
  HTTP_ERROR_CLASSES,
  classifiedHttpErrorsOf,
  errorDisplayStateOf,
  httpErrorClassOf,
  type HttpErrorClassInput,
} from '../../src/audit/http-error-classes.js';
import { ERROR_DISPLAY_WORDS, errorDisplayWordsIn } from '../../src/core/error-display-words.js';
import type {
  ErrorDisplayEvidence,
  NetworkEvidence,
  NetworkRequestEvidence,
  NetworkResponseEvidence,
  NetworkTimingEvidence,
} from '../../src/core/evidence-types.js';

const ORIGIN = 'http://127.0.0.1:4173';
const TIMING = Object.freeze({
  startTime: 0, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1,
  connectEnd: -1, requestStart: -1, responseStart: -1, responseEnd: -1,
});
const SUMMARY = Object.freeze({ status: 'OBSERVED', format: 'JSON', fields: [] } as const);

let sequence = 0;
const exchange = (
  method: string,
  path: string,
  status: number,
  options: { readonly resourceType?: string; readonly headers?: Record<string, string>; readonly approvedService?: boolean; readonly navigation?: boolean } = {},
): { readonly request: NetworkRequestEvidence; readonly response: NetworkResponseEvidence } => {
  sequence += 1;
  const requestId = `REQ-${String(sequence).padStart(6, '0')}`;
  const url = `${ORIGIN}${path}`;
  const navigation = options.navigation ?? false;
  return {
    request: {
      requestId, url, method, resourceType: options.resourceType ?? 'fetch',
      headers: { status: 'OBSERVED', values: options.headers ?? {} },
      timing: TIMING, redirectFromRequestId: null, redirectToRequestId: null, redirectChainRequestIds: [],
      isNavigationRequest: navigation, isMainFrame: true, truncated: false,
    },
    response: {
      requestId, url, status, statusText: '', headers: { status: 'OBSERVED', values: {} }, contentLengthHeader: null,
      timing: TIMING, transferSize: { status: 'NOT_OBSERVED' }, isNavigationRequest: navigation, isMainFrame: true, truncated: false,
      ...(status >= 400 ? { errorContext: { bodySummary: SUMMARY, approvedService: options.approvedService ?? false } } : {}),
    },
  };
};

const networkOf = (...exchanges: readonly { readonly request: NetworkRequestEvidence; readonly response: NetworkResponseEvidence }[]): NetworkEvidence => ({
  requests: exchanges.map(({ request }) => request),
  responses: exchanges.map(({ response }) => response),
  failures: [],
  omittedRequestCount: 0,
  omittedResponseCount: 0,
  omittedFailureCount: 0,
});

const shown: ErrorDisplayEvidence = { status: 'OBSERVED', matches: [{ source: 'ALERT', words: ['失敗'] }] };
const notShown: ErrorDisplayEvidence = { status: 'OBSERVED', matches: [] };

const input = (overrides: Partial<HttpErrorClassInput>): HttpErrorClassInput => ({
  status: 401, resourceType: 'fetch', mainFrameNavigation: false, recovered: false, errorDisplay: 'NOT_SHOWN', ...overrides,
});

describe('AUD-7: the class table of the 4xx and 5xx responses', () => {
  it('keeps the closed list in one place', () => {
    expect(HTTP_ERROR_CLASSES).toEqual(['SITE_FAILURE', 'COLLECTION_CAUSED', 'UNDETERMINED', 'EXPECTED_BRANCH']);
  });

  it.each([
    // 4xx のデータの要求
    [{ recovered: true, errorDisplay: 'NOT_SHOWN' }, 'EXPECTED_BRANCH'],
    [{ recovered: true, errorDisplay: 'SHOWN' }, 'UNDETERMINED'],
    [{ recovered: true, errorDisplay: 'UNKNOWN' }, 'UNDETERMINED'],
    [{ recovered: false, errorDisplay: 'SHOWN' }, 'SITE_FAILURE'],
    [{ recovered: false, errorDisplay: 'NOT_SHOWN' }, 'UNDETERMINED'],
    [{ recovered: false, errorDisplay: 'UNKNOWN' }, 'UNDETERMINED'],
    // 4xx の部品（画像など。画面の誤りの表示は手がかりにならない）
    [{ resourceType: 'image', recovered: false, errorDisplay: 'NOT_SHOWN' }, 'SITE_FAILURE'],
    [{ resourceType: 'image', recovered: true, errorDisplay: 'NOT_SHOWN' }, 'EXPECTED_BRANCH'],
    [{ resourceType: 'image', recovered: true, errorDisplay: 'SHOWN' }, 'UNDETERMINED'],
    // ページの移動の応答
    [{ resourceType: 'document', mainFrameNavigation: true, recovered: false, errorDisplay: 'NOT_SHOWN' }, 'SITE_FAILURE'],
    // 5xx は、回復しても EXPECTED_BRANCH にしない
    [{ status: 503, recovered: true, errorDisplay: 'NOT_SHOWN' }, 'UNDETERMINED'],
    [{ status: 500, recovered: false, errorDisplay: 'NOT_SHOWN' }, 'SITE_FAILURE'],
    [{ status: 500, resourceType: 'image', recovered: true, errorDisplay: 'NOT_SHOWN' }, 'UNDETERMINED'],
  ] as const)('%o is %s', (overrides, expected) => {
    expect(httpErrorClassOf(input(overrides))).toBe(expected);
  });
});

describe('AUD-7: the facts of one load', () => {
  it('gives the same 401 different classes when the facts differ', () => {
    const anonymous = exchange('GET', '/api/me?x=1', 401);
    const recovered = exchange('GET', '/api/me?x=2', 200, { headers: { cookie: '[REDACTED]' } });
    const [first] = classifiedHttpErrorsOf(networkOf(anonymous, recovered), notShown);
    expect(first).toMatchObject({
      ruleId: 'RESOURCE_4XX',
      errorClass: 'EXPECTED_BRANCH',
      facts: {
        method: 'GET', status: 401, resourceType: 'fetch', mainFrameNavigation: false,
        credentials: { cookie: false, authorization: false },
        recovered: true, retryStatuses: [200], errorDisplay: 'NOT_SHOWN', approvedService: false,
      },
    });

    const withToken = exchange('GET', '/api/me', 401, { headers: { authorization: '[REDACTED]' } });
    const [second] = classifiedHttpErrorsOf(networkOf(withToken, exchange('GET', '/api/me', 401)), shown);
    expect(second).toMatchObject({
      errorClass: 'SITE_FAILURE',
      facts: { credentials: { cookie: false, authorization: true }, recovered: false, retryStatuses: [401], errorDisplay: 'SHOWN' },
    });
  });

  it('keys the endpoint by method, origin and path, ignoring the query', () => {
    const failed = exchange('GET', '/api/list?page=1', 406);
    const otherMethod = exchange('POST', '/api/list', 200);
    const otherPath = exchange('GET', '/api/other', 200);
    const [entry] = classifiedHttpErrorsOf(networkOf(failed, otherMethod, otherPath), notShown);
    expect(entry?.facts).toMatchObject({ recovered: false, retryStatuses: [] });
  });

  // 設計者の判断 2026-11-11: 同じ口の成功した読み取りのくり返しは、まとめた記録（`repeatedReads`）にだけ数える。誤りの後に、まとめた要求があれば、やり直しに数える
  // （まとめた記録の status を 1 つ。最初の 1 件は、1 件の記録として残る）。
  it('reads the repeated reads counted after the error as a retry', () => {
    const earlier = { ...exchange('GET', '/api/me', 200) };
    const failed = exchange('GET', '/api/me?t=2', 401);
    const errorStart = 1_000;
    const atTime = <T extends { readonly timing: NetworkTimingEvidence }>(record: T, startTime: number): T => ({ ...record, timing: { ...TIMING, startTime } });
    const network: NetworkEvidence = {
      ...networkOf(
        { request: atTime(earlier.request, 900), response: atTime(earlier.response, 900) },
        { request: atTime(failed.request, errorStart), response: atTime(failed.response, errorStart) },
      ),
      repeatedReads: [{
        method: 'GET', origin: ORIGIN, path: '/api/me', resourceType: 'fetch', status: 200, isMainFrame: true, count: 5,
        firstRequestId: earlier.request.requestId,
        first: { url: earlier.request.url, timing: { ...TIMING, startTime: 900 } },
        slowest: { url: earlier.request.url, timing: { ...TIMING, startTime: 900 } },
        firstStartTime: 900, lastStartTime: 1_500, transfer: { observedCount: 5, totalBytes: 50 }, distinctQueryCount: 5,
      }],
    };
    const [entry] = classifiedHttpErrorsOf(network, notShown);
    expect(entry?.facts).toMatchObject({ recovered: true, retryStatuses: [200] });
    // まとめた要求が、どれも誤りより前なら、やり直しに数えない。
    const before = classifiedHttpErrorsOf({ ...network, repeatedReads: [{ ...network.repeatedReads![0]!, lastStartTime: 950 }] }, notShown);
    expect(before[0]?.facts).toMatchObject({ recovered: false, retryStatuses: [] });
  });

  it('reads only the later responses of the same load as the retries', () => {
    const earlier = exchange('GET', '/api/me', 200);
    const failed = exchange('GET', '/api/me', 401);
    const [entry] = classifiedHttpErrorsOf(networkOf(earlier, failed), notShown);
    expect(entry?.facts).toMatchObject({ recovered: false, retryStatuses: [] });
  });

  it('marks the main frame navigation as HTTP_4XX and leaves HTTP_5XX out of the classes', () => {
    const notFound = exchange('GET', '/missing', 404, { resourceType: 'document', navigation: true });
    const unavailable = exchange('GET', '/down', 503, { resourceType: 'document', navigation: true });
    const entries = classifiedHttpErrorsOf(networkOf(notFound, unavailable), notShown);
    expect(entries.map(({ ruleId, errorClass }) => [ruleId, errorClass])).toEqual([['HTTP_4XX', 'SITE_FAILURE']]);
  });

  it('copies the approved service mark and does not classify the responses of the earlier versions', () => {
    const approved = exchange('GET', '/api/service', 401, { approvedService: true });
    const old = exchange('GET', '/api/old', 404);
    const { errorContext: _ignored, ...withoutContext } = old.response;
    const entries = classifiedHttpErrorsOf(networkOf(approved, { request: old.request, response: withoutContext }), notShown);
    expect(entries.map(({ facts }) => [facts.url, facts.approvedService])).toEqual([[`${ORIGIN}/api/service`, true]]);
  });

  it('reads the error display state', () => {
    expect(errorDisplayStateOf(shown)).toBe('SHOWN');
    expect(errorDisplayStateOf(notShown)).toBe('NOT_SHOWN');
    expect(errorDisplayStateOf({ status: 'FAILED', errorText: 'x' })).toBe('UNKNOWN');
    expect(errorDisplayStateOf(undefined)).toBe('UNKNOWN');
  });
});

describe('AUD-7: the error display words', () => {
  it('holds only the general words', () => {
    expect(ERROR_DISPLAY_WORDS).toEqual([
      'エラー', '失敗', '見つかりません', '存在しません', '権限がありません', 'ログインしてください', '期限が切れ', 'できません', 'お試しください',
      'error', 'failed', 'not found', 'unauthorized', 'forbidden', 'expired', 'invalid', 'denied',
    ]);
  });

  it('finds the words without the case and the width differences', () => {
    expect(errorDisplayWordsIn('読み込みに失敗しました。もう一度お試しください。')).toEqual(['失敗', 'お試しください']);
    expect(errorDisplayWordsIn('ＥＲＲＯＲ: Not Found')).toEqual(['error', 'not found']);
    expect(errorDisplayWordsIn('保存できませんでした')).toEqual(['できません']);
    expect(errorDisplayWordsIn('データはありません')).toEqual([]);
  });
});

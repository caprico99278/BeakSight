// AUD-2b（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-2b）: 落ち着きの判定に「データが届いた」と「DOM の変化の静まり」を
// 足し、読み込みの段（`AFTER_DOM_CONTENT_LOADED`→`LOADING`→`AFTER_DATA`→`SETTLED`）を記録する。
// RB-9（再構築の設計書 3 章。案 2 章の 1）: 判定は輪（`waitForPageSettledWith`）にあり、口と時計を差し込める。偽の口（読み取りの値を順に返す）と
// 偽の時計で確かめる（ブラウザも本物の時間も使わない）。
import { describe, expect, it } from 'vitest';
import {
  waitForPageSettledWith,
  type DataActivity,
  type PageSettlingPolicy,
  type PageSettlingPort,
  type PageSettlingResult,
} from '../../src/browser/page-settling.js';
import { createFakeClock, type FakeClock } from '../helpers/fake-browser-port/fake-clock.js';

interface FakeState {
  readonly readyState: DocumentReadyState;
  readonly scrollHeight: number;
  readonly elementCount: number;
  readonly textLength: number;
  readonly data: DataActivity;
  /** 作りの印（`structureSignaturesInPage` の読み取りの値）。 */
  readonly structure: readonly string[];
  /** EV-3: 見えている読み込み中の表示（省略は、ない）。 */
  readonly loadingIndicators?: { readonly ariaBusyCount: number; readonly progressbarCount: number; readonly indeterminateProgressCount: number };
}

const FULFILLED = <T>(value: T) => ({ status: 'FULFILLED', value }) as const;

/** 文書の状態を読むたびに次の状態を返す偽の口（最後の状態は繰り返す）。作りの印の読み取りは今の状態の印を返す。 */
const fakePortOf = (states: readonly FakeState[], overrides: Partial<PageSettlingPort> = {}): { readonly port: PageSettlingPort; readonly current: () => FakeState } => {
  let index = -1;
  const current = (): FakeState => states[Math.max(0, Math.min(index, states.length - 1))] as FakeState;
  const port: PageSettlingPort = {
    isClosed: () => false,
    failureReason: () => 'EVALUATION_FAILED',
    waitForDomContentLoaded: async () => FULFILLED(undefined),
    readDocumentState: async () => {
      index += 1;
      const { readyState, scrollHeight, elementCount, textLength, loadingIndicators } = current();
      return FULFILLED({ readyState, scrollHeight, elementCount, textLength, ...(loadingIndicators === undefined ? {} : { loadingIndicators }) });
    },
    readStructureSignatures: async () => FULFILLED([...current().structure]),
    ...overrides,
  };
  return { port, current };
};

const POLICY = { pollIntervalMs: 5, stableWindowMs: 20 } as const;
/** 偽の時計で待ち終えるまで進める長さ（場面の締め切りより長い）。 */
const RUN_OUT_MS = 120_000;

/** 偽の時計の上で落ち着きを待つ（締め切りは時計の今から `deadlineInMs`）。 */
const settle = async (
  port: PageSettlingPort,
  policy: Omit<PageSettlingPolicy, 'deadlineAtMs' | 'pollIntervalMs' | 'stableWindowMs'> & Partial<PageSettlingPolicy> = {},
  deadlineInMs = 60_000,
  clock: FakeClock = createFakeClock(1_000),
): Promise<PageSettlingResult> => {
  const result = waitForPageSettledWith(port, { ...POLICY, deadlineAtMs: clock.now() + deadlineInMs, ...policy }, clock);
  await clock.advance(RUN_OUT_MS);
  return result;
};

/** 作りの印は、要素の数だけの別の作り（`kind-0`…）。同じ数なら同じ作り。 */
const state = (scrollHeight: number, elementCount: number, inFlight: number, events: number, textLength = elementCount * 10): FakeState => ({
  readyState: 'complete',
  scrollHeight,
  elementCount,
  textLength,
  data: { inFlight, events },
  structure: Array.from({ length: elementCount }, (_, index) => `kind-${String(index)}`),
});

describe('AUD-2b: the load phases of the settling', () => {
  it('records AFTER_DATA and then SETTLED when the data arrives late into a fixed-height skeleton', async () => {
    // 外枠の高さ（900）は初めから決まっている。データの要求が 1 つ途中の間は、高さも DOM も変わらない（前の判定では、ここで「落ち着いた」になった）。
    const skeleton = state(900, 10, 1, 1);
    const filled = state(900, 30, 0, 2);
    const { port, current } = fakePortOf([...Array.from({ length: 12 }, () => skeleton), filled]);

    const result = await settle(port, { dataActivity: () => current().data });

    expect(result.status).toBe('SETTLED');
    expect(result.loadPhases?.map(({ phase }) => phase)).toEqual(['AFTER_DOM_CONTENT_LOADED', 'LOADING', 'AFTER_DATA', 'SETTLED']);
    // データが届いた後の DOM（要素 30）で落ち着いた。
    expect(result.observations.at(-1)).toMatchObject({ elementCount: 30, dataInFlight: 0 });
  });

  // AUD-2b の直し: 同じ作りの部品の文字が入れ替わるだけ（回転する告知）なら、文字の長さが変わり続けても静まったとみなす。
  it('settles when only the text of the same structure keeps changing, like a rotating notice', async () => {
    const rotating = Array.from({ length: 40 }, (_, index) => state(900, 10, 0, 0, 100 + (index % 3) * 7));
    const { port, current } = fakePortOf(rotating);

    const result = await settle(port, { dataActivity: () => current().data });

    expect(result.status).toBe('SETTLED');
    // 窓（20ms）の分の観測だけで落ち着く（40 回の入れ替わりを待たない）。
    expect(result.observations.length).toBeLessThan(40);
  });

  it('does not settle while new structures keep appearing at the same height', async () => {
    const changing = Array.from({ length: 10 }, (_, index) => state(900, 10 + index, 0, 0));
    const { port, current } = fakePortOf([...changing, state(900, 19, 0, 0)]);

    const result = await settle(port, { dataActivity: () => current().data });

    expect(result.status).toBe('SETTLED');
    // DOM が変わる間は窓を始め直すので、最後の DOM（要素 19）まで待つ。
    expect(result.observations.at(-1)?.elementCount).toBe(19);
    expect(result.observations.length).toBeGreaterThan(10);
  });

  it('settles with a request that stays open only after nothing moves for the open-request quiet length', async () => {
    const { port, current } = fakePortOf([state(900, 10, 1, 1)]);

    const result = await settle(port, { openDataRequestQuietMs: 80, dataActivity: () => current().data });

    // 開いた要求の静まりの長さ（80ms）の間は、窓（20ms）を過ぎても落ち着きにしない（観測の時刻で確かめる）。
    const first = result.observations[0]?.observedAtMs ?? 0;
    expect((result.observations.at(-1)?.observedAtMs ?? 0) - first).toBeGreaterThanOrEqual(80);
    // 1 本の開いた要求が動かないまま静まった（今までどおり、届いたとみなす。REV-WSO の `DATA_STILL_LOADING` にしない）。
    expect(result).toMatchObject({ status: 'SETTLED', reason: 'DOM_AND_HEIGHT_STABLE' });
    expect(result.loadPhases?.map(({ phase }) => phase)).toEqual(['AFTER_DOM_CONTENT_LOADED', 'LOADING', 'AFTER_DATA', 'SETTLED']);
  });
});

// 設計者の判断（2026-11-10）: データの静まりは、要求の口（メソッドと Origin と path）ごとに見る。一度でも応答を返し終えた口へのくり返しの要求（ポーリング）は、
// 「データが届いた後のくり返し」として、落ち着きの判定を止めない。まだ一度も応答を返し終えていない口への要求がある間は、今どおり待つ。
describe('AUD-2b: the data quietness by endpoint', () => {
  const ENDPOINT_POLL = '["GET","http://127.0.0.1","/poll"]';
  const ENDPOINT_LIST = '["GET","http://127.0.0.1","/list"]';
  const withEndpoints = (base: FakeState, inFlight: readonly string[], completed: readonly string[]): FakeState => ({
    ...base,
    data: { ...base.data, endpoints: { inFlight, completed } },
  });

  it('settles while the page repeats the requests to an endpoint whose data has arrived once', async () => {
    // ポーリングのように、毎回の観測でデータの通信が動き、途中の数も 0 と 1 を行き来する。
    const polling = Array.from({ length: 200 }, (_, index) =>
      withEndpoints(state(900, 10, index % 2, index + 1), index % 2 === 1 ? [ENDPOINT_POLL] : [], [ENDPOINT_POLL]));
    const { port, current } = fakePortOf(polling);

    const result = await settle(port, { openDataRequestQuietMs: 60_000, dataActivity: () => current().data }, 5_000);

    expect(result.status).toBe('SETTLED');
    // 窓（20ms）の分の観測だけで落ち着く（くり返しを待たない）。
    expect(result.observations.length).toBeLessThan(50);
  });

  it('keeps waiting while a request to a new endpoint is in flight, even when the repeats keep moving', async () => {
    const waiting = Array.from({ length: 12 }, (_, index) =>
      withEndpoints(state(900, 10, 2, index + 1), [ENDPOINT_POLL, ENDPOINT_LIST], [ENDPOINT_POLL]));
    const arrived = withEndpoints(state(900, 30, 0, 20), [], [ENDPOINT_POLL, ENDPOINT_LIST]);
    const { port, current } = fakePortOf([...waiting, arrived]);

    const result = await settle(port, { openDataRequestQuietMs: 60_000, dataActivity: () => current().data });

    expect(result.status).toBe('SETTLED');
    // 新しい口のデータが届いた後の DOM（要素 30）で落ち着いた。
    expect(result.observations.at(-1)).toMatchObject({ elementCount: 30 });
  });
});

// DEF-245（設計者の判断 2026-11-11）: 周期的に変わる画面を、事実で「静まった」とみなす。
// - B: 窓を始め直すのは、新しい作りの印が出たときだけ。前に見た高さに戻るだけの行き来は、窓を続ける。
// - D: 新しい作りの印が出ないまま高さだけが伸び続ける画面も、静まったとみなす（同じ作りの行が足されるだけなら、新しく見るものはない）。
// - C: 一度でも終わった口（応答を返した、または失敗した）へのくり返しは、途中の数にも動きにも数えない。
describe('DEF-245: the periodic changes are quiet by the facts', () => {
  it.each([
    ['the height goes back and forth between the values seen before (B)', (index: number) => state(900 + (index % 2) * 300, 10, 0, 0)],
    ['only the height keeps growing with no new structure (D)', (index: number) => state(900 + index * 40, 10, 0, 0)],
  ])('settles when %s', async (_label, at) => {
    const { port, current } = fakePortOf(Array.from({ length: 200 }, (_, index) => at(index)));

    const result = await settle(port, { dataActivity: () => current().data }, 2_000);

    expect(result.status).toBe('SETTLED');
  });

  it('settles while the page keeps repeating the requests to an endpoint whose requests fail (C)', async () => {
    const failing = Array.from({ length: 200 }, (_, index): FakeState => {
      const base = state(900, 10, index % 2, index + 1);
      return { ...base, data: { ...base.data, endpoints: { inFlight: index % 2 === 1 ? ['["GET","http://127.0.0.1","/failing"]'] : [], completed: [], failed: ['["GET","http://127.0.0.1","/failing"]'] } } };
    });
    const { port, current } = fakePortOf(failing);

    const result = await settle(port, { openDataRequestQuietMs: 60_000, dataActivity: () => current().data }, 2_000);

    expect(result.status).toBe('SETTLED');
  });
});

// DEF-283（設計者の判断 2026-11-16）: 新しい path へ送り続ける画面（解析の送信など）でも、落ち着きの待ちが終わる。
// - B: 一度終わった口の数が増えるだけ（新しい口が観測の間に始まって終わる）は、データの動きにしない。
// - C: 中身の進み（新しい作り・readyState・新しい表示の数）が、開いた要求の静まりの長さ止まったら、新しい口の要求が続いていても終える（表示あり・なしの両方）。
describe('DEF-283: the pages that keep sending to new paths', () => {
  const withEndpoints = (base: FakeState, inFlight: readonly string[], completed: readonly string[]): FakeState => ({
    ...base,
    data: { ...base.data, endpoints: { inFlight, completed } },
  });
  const endpointOf = (index: number): string => `["GET","http://127.0.0.1","/beacon/${String(index)}"]`;
  const BUSY = { ariaBusyCount: 1, progressbarCount: 0, indeterminateProgressCount: 0 };

  it('settles when new endpoints only start and end between the observations (B)', async () => {
    const sending = Array.from({ length: 400 }, (_, index) =>
      withEndpoints(state(900, 10, 0, index * 2), [], Array.from({ length: index }, (__, done) => endpointOf(done))));
    const { port, current } = fakePortOf(sending);

    const result = await settle(port, { openDataRequestQuietMs: 60_000, dataActivity: () => current().data }, 1_000);

    expect(result).toMatchObject({ status: 'SETTLED', reason: 'DOM_AND_HEIGHT_STABLE' });
  });

  // REV-WSO・REV-WSO2: 中身が止まって終えるとき、まだ届いていない口への要求が、直近の窓の間に窓の長さ以上開いていたら（鎖の 1 歩）、データが届く前に
  // 終えた（`DATA_STILL_LOADING`）と残す。窓より短く開くだけの要求（速く返る送り続け）では残さない。`DATA_STILL_LOADING` の段は `AFTER_DATA` にしない。
  it.each([
    ['requests shorter than the window, without a loading indicator', undefined, 1, 'DOM_AND_HEIGHT_STABLE', ['AFTER_DATA', 'SETTLED']],
    ['requests shorter than the window, with a loading indicator that stays', BUSY, 1, 'LOADING_INDICATOR_REMAINED', ['LOADING']],
    ['a chain of requests longer than the window, without a loading indicator', undefined, 8, 'DATA_STILL_LOADING', ['LOADING', 'SETTLED']],
    ['a chain of requests longer than the window, with a loading indicator that stays', BUSY, 8, 'DATA_STILL_LOADING', ['LOADING']],
  ] as const)('ends after the content stops for the open-request quiet length while new endpoints stay in flight: %s (C)', async (_label, loadingIndicators, pollsPerRequest, reason, lastPhases) => {
    const sending = Array.from({ length: 400 }, (_, index): FakeState => {
      const request = Math.floor(index / pollsPerRequest);
      return {
        ...withEndpoints(state(900, 10, 1, request), [endpointOf(request)], Array.from({ length: request }, (__, done) => endpointOf(done))),
        ...(loadingIndicators === undefined ? {} : { loadingIndicators }),
      };
    });
    const { port, current } = fakePortOf(sending);

    const result = await settle(port, { openDataRequestQuietMs: 80, awaitLoadingIndicators: true, dataActivity: () => current().data }, 1_000);

    expect(result).toMatchObject({ status: 'SETTLED', reason });
    expect(result.loadPhases?.map(({ phase }) => phase).slice(-lastPhases.length)).toEqual(lastPhases);
    // 中身が止まってから、開いた要求の静まりの長さ（80ms）は待つ。
    const first = result.observations[0]?.observedAtMs ?? 0;
    expect((result.observations.at(-1)?.observedAtMs ?? 0) - first).toBeGreaterThanOrEqual(80);
  });
});

// EV-3（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.3）: 頼まれたら、見える読み込み中の表示が消えるまで落ち着きにしない。表示が残ったまま
// 何も動かなくなったら（進みが止まった）、準備が終わらないまま終える。回数で決めない。
describe('EV-3: the visible loading indicators', () => {
  const BUSY = { ariaBusyCount: 1, progressbarCount: 0, indeterminateProgressCount: 0 };

  it('settles only after the visible loading indicator is gone', async () => {
    const busy: FakeState = { ...state(900, 10, 0, 0), loadingIndicators: BUSY };
    const { port } = fakePortOf([...Array.from({ length: 12 }, () => busy), state(900, 10, 0, 0)]);

    const result = await settle(port, { awaitLoadingIndicators: true });

    expect(result.status).toBe('SETTLED');
    expect(result.observations.length).toBeGreaterThan(12);
  });

  it('ends as not ready only after nothing moves for the open-request quiet length while the loading indicator stays', async () => {
    const { port } = fakePortOf([{ ...state(900, 10, 0, 0), loadingIndicators: BUSY }]);

    const result = await settle(port, { awaitLoadingIndicators: true, openDataRequestQuietMs: 80 });

    expect(result).toMatchObject({ status: 'SETTLED', reason: 'LOADING_INDICATOR_REMAINED' });
    const first = result.observations[0]?.observedAtMs ?? 0;
    expect((result.observations.at(-1)?.observedAtMs ?? 0) - first).toBeGreaterThanOrEqual(80);
  });
});

// 落ち着かないときと、読めないときの終わり方（前は controlled-scroll の結合に、偽の page で置いていた場面）。
describe('the settling ends with PARTIAL and its reason', () => {
  it('ends at the deadline with the observations before it when the structure keeps changing', async () => {
    const { port } = fakePortOf(Array.from({ length: 500 }, (_, index) => state(900, 10 + index, 0, 0)));

    const result = await settle(port, {}, 200);

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    const deadlineAtMs = 1_000 + 200;
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations.every((observation) => observation.observedAtMs < deadlineAtMs)).toBe(true);
  });

  it.each([
    ['the page is closed before the settling', { isClosed: () => true }, 'PAGE_CLOSED'],
    ['the DOM readiness fails', { waitForDomContentLoaded: async () => ({ status: 'REJECTED', reason: new Error('x') }) as const }, 'DOM_READINESS_FAILED'],
    ['the DOM readiness passes the deadline', { waitForDomContentLoaded: async () => ({ status: 'DEADLINE_EXCEEDED' }) as const }, 'DEADLINE_EXCEEDED'],
    ['the reading of the document fails', { readDocumentState: async () => ({ status: 'REJECTED', reason: new Error('x') }) as const }, 'EVALUATION_FAILED'],
    ['the reading of the structure passes the deadline', { readStructureSignatures: async () => ({ status: 'DEADLINE_EXCEEDED' }) as const }, 'DEADLINE_EXCEEDED'],
  ] as const)('returns PARTIAL when %s', async (_label, overrides, reason) => {
    const { port } = fakePortOf([state(900, 10, 0, 0)], overrides);

    const result = await settle(port);

    expect(result).toMatchObject({ status: 'PARTIAL', reason });
  });

  it('returns the reason of the page when a reading fails after the page closed', async () => {
    const { port } = fakePortOf([state(900, 10, 0, 0)], {
      readDocumentState: async () => ({ status: 'REJECTED', reason: new Error('closed') }),
      failureReason: () => 'PAGE_CLOSED',
    });

    expect(await settle(port)).toMatchObject({ status: 'PARTIAL', reason: 'PAGE_CLOSED' });
  });

  it('stops waiting with PARTIAL when the caller watch ends the stage', async () => {
    const controller = new AbortController();
    const marks: string[] = [];
    const { port } = fakePortOf(Array.from({ length: 500 }, (_, index) => state(900, 10 + index, 0, 0)), {
      readDocumentState: async () => {
        if (marks.length >= 3) controller.abort();
        return FULFILLED({ readyState: 'complete', scrollHeight: 900 + marks.length, elementCount: 10 + marks.length, textLength: 0 });
      },
    });

    const result = await settle(port, { progress: { signal: controller.signal, mark: (kind) => marks.push(kind) } });

    expect(result).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    // 新しい値を読んだときだけ、中身の進みの印を付ける。
    expect(marks.every((kind) => kind === 'BROWSER_RESPONSE')).toBe(true);
  });
});

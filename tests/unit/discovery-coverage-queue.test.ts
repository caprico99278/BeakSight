// COV-0（設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.2）: 辺つきの待ち行列の単体テスト。ブラウザを使わない。
import { describe, expect, it } from 'vitest';
import { createSha256Fingerprint } from '../../src/core/ids.js';
import {
  COVERAGE_CHAIN_CLOSE_REASONS,
  COVERAGE_EDGE_KINDS,
  CoverageQueue,
  unfrozenLoadRefusalOf,
  type CoverageEdgeInput,
  type CoverageNavigationEdgeInput,
} from '../../src/discovery/coverage-queue.js';

const BASE = 'https://app.example.test';
const S1 = createSha256Fingerprint('structure-1');
const S2 = createSha256Fingerprint('structure-2');
const S3 = createSha256Fingerprint('structure-3');
const CANDIDATE = createSha256Fingerprint('shared-menu-button');

const link = (path: string, kind: CoverageNavigationEdgeInput['kind'] = 'LINK'): CoverageNavigationEdgeInput =>
  ({ kind, url: `${BASE}${path}`, frame: null, openedRegion: null });

/** 待ち行列を空になるまで回す。`page` が、読んだ状態の構造の鍵と出た辺を返す。 */
const drain = (queue: CoverageQueue, page: (url: string) => { structureKey: string; edges: CoverageEdgeInput[] }): string[] => {
  const read: string[] = [];
  for (let item = queue.next(); item !== undefined; item = queue.next()) {
    read.push(item.url);
    queue.completeRead(item.stateId, page(item.url));
  }
  return read;
};

describe('CoverageQueue', () => {
  it('辺の種類は閉じた一覧', () => {
    expect(COVERAGE_EDGE_KINDS).toEqual(['LINK', 'SPA_ROUTE', 'QUERY_CHANGE', 'PRESS_RESULT', 'OPENED_REGION', 'FRAME', 'OPTION_SELECT']);
    expect(COVERAGE_CHAIN_CLOSE_REASONS.length).toBeGreaterThan(0);
  });

  it('同じ場所を 2 回読まない（query の並びの違いも同じ場所）。空になったら終わる', () => {
    const queue = new CoverageQueue();
    expect(queue.enqueue(link('/')).status).toBe('QUEUED');
    const read = drain(queue, (url) => (url === `${BASE}/`
      ? { structureKey: S1, edges: [link('/a?x=1&y=2'), link('/a?y=2&x=1'), link('/b'), link('/')] }
      : { structureKey: S2, edges: [link('/'), link('/a?x=1&y=2')] }));
    expect(read).toEqual([`${BASE}/`, `${BASE}/a?x=1&y=2`, `${BASE}/b`]);
    expect(queue.next()).toBeUndefined();
    expect(queue.isFinished).toBe(true);
    expect(queue.enqueue(link('/b')).status).toBe('KNOWN');
  });

  it('取り出しは受け付けた順（幅優先）。先に読む印は印のない候補より前', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/1'));
    queue.enqueue(link('/2'));
    queue.enqueue(link('/p'), { preferred: true });
    queue.enqueue(link('/q'), { preferred: true });
    const order: string[] = [];
    for (let item = queue.next(); item !== undefined; item = queue.next()) {
      order.push(item.url);
    }
    expect(order).toEqual([`${BASE}/p`, `${BASE}/q`, `${BASE}/1`, `${BASE}/2`]);
  });

  it('押す辺の採否: (構造の鍵・候補の識別・順番) が未見のときだけ真', () => {
    const queue = new CoverageQueue();
    expect(queue.acceptPress({ structureKey: S1, candidateIdentityDigest: CANDIDATE, ordinal: 0 })).toBe(true);
    expect(queue.acceptPress({ structureKey: S1, candidateIdentityDigest: CANDIDATE, ordinal: 0 })).toBe(false);
    expect(queue.acceptPress({ structureKey: S1, candidateIdentityDigest: CANDIDATE, ordinal: 1 })).toBe(true);
    expect(queue.hasPressed({ structureKey: S1, candidateIdentityDigest: CANDIDATE, ordinal: 1 })).toBe(true);
  });

  it('共通の枠の候補は「前に押した」で飛ばさず、構造の違う状態で押す辺になる', () => {
    const queue = new CoverageQueue();
    expect(queue.acceptPress({ structureKey: S1, candidateIdentityDigest: CANDIDATE, ordinal: 0 })).toBe(true);
    expect(queue.acceptPress({ structureKey: S2, candidateIdentityDigest: CANDIDATE, ordinal: 0 })).toBe(true);
    expect(queue.acceptPress({ structureKey: S2, candidateIdentityDigest: CANDIDATE, ordinal: 0 })).toBe(false);
  });

  it('押す辺の入力の誤り（digest でない、負の順番）を拒む', () => {
    const queue = new CoverageQueue();
    expect(() => queue.acceptPress({ structureKey: 'x', candidateIdentityDigest: CANDIDATE, ordinal: 0 })).toThrow(RangeError);
    expect(() => queue.acceptPress({ structureKey: S1, candidateIdentityDigest: CANDIDATE, ordinal: -1 })).toThrow(RangeError);
  });

  it('終わりのない続き（日付の次へ）で新しいものが出なくなったら、その鎖を閉じ、理由を残す', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/'));
    let dayPagesRead = 0;
    const read = drain(queue, (url) => {
      if (url === `${BASE}/`) {
        return { structureKey: S1, edges: [link('/calendar?date=2026-11-01'), link('/help')] };
      }
      if (url === `${BASE}/help`) {
        return { structureKey: S2, edges: [link('/')] };
      }
      const date = new URL(url).searchParams.get('date') ?? '';
      dayPagesRead += 1;
      const next = `2026-11-${String(Number(date.slice(8)) + 1).padStart(2, '0')}`;
      // どの日も同じ構造で、同じ共通のリンクだけを持つ（新しいものが出ない）。
      return { structureKey: S3, edges: [link(`/calendar?date=${next}`), link('/'), link('/help')] };
    });
    // 1 日目は新しい構造の鍵（続ける）、2 日目は新しいものがない（閉じる）。
    expect(dayPagesRead).toBe(2);
    expect(read).toContain(`${BASE}/calendar?date=2026-11-02`);
    expect(read).not.toContain(`${BASE}/calendar?date=2026-11-03`);
    const closures = queue.snapshot().closedChains;
    expect(closures).toHaveLength(1);
    expect(closures[0]).toMatchObject({ kind: 'LINK', reason: 'NO_NEW_LOCATION_OR_STRUCTURE', droppedEdgeCount: 1 });
  });

  it('一覧の次のページで、新しい行のリンクが出る間は続く', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/list?page=1'));
    const LAST_PAGE = 5;
    const read = drain(queue, (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/items/')) {
        return { structureKey: S2, edges: [link('/list?page=1')] };
      }
      const page = Number(parsed.searchParams.get('page'));
      const rows = page <= LAST_PAGE ? [link(`/items/${page * 10 + 1}`), link(`/items/${page * 10 + 2}`)] : [];
      return { structureKey: S1, edges: [...rows, link(`/list?page=${page + 1}`)] };
    });
    for (let page = 1; page <= LAST_PAGE; page += 1) {
      expect(read).toContain(`${BASE}/list?page=${page}`);
      expect(read).toContain(`${BASE}/items/${page * 10 + 1}`);
    }
    // 行の出なくなった最初のページを読んだところで閉じる（その次へは進まない）。
    expect(read).toContain(`${BASE}/list?page=${LAST_PAGE + 1}`);
    expect(read).not.toContain(`${BASE}/list?page=${LAST_PAGE + 2}`);
    expect(queue.snapshot().closedChains).toHaveLength(1);
  });

  it('続きでない別の種類の辺（開いた枠）は鎖の閉じに巻き込まれない', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/c?d=1'));
    queue.completeRead(queue.next()!.stateId, { structureKey: S1, edges: [link('/c?d=2')] });
    const second = queue.next()!;
    const result = queue.completeRead(second.stateId, {
      structureKey: S1,
      edges: [link('/c?d=3'), { kind: 'OPENED_REGION', url: `${BASE}/c?d=2`, frame: null, openedRegion: 'dialog:filters', structureKey: S2, press: { candidateIdentityDigest: CANDIDATE, ordinal: 0 } }],
    });
    // 開いた枠は新しい場所の鍵なので、鎖は閉じない。
    expect(result.closedChain).toBeNull();
    expect(result.queuedStateIds).toHaveLength(2);
  });

  it('読んでいない状態や、2 回目の completeRead は呼び出し側の誤り', () => {
    const queue = new CoverageQueue();
    const { stateId } = queue.enqueue(link('/'));
    expect(() => queue.completeRead(stateId!, { structureKey: S1, edges: [] })).toThrow();
    queue.next();
    queue.completeRead(stateId!, { structureKey: S1, edges: [] });
    expect(() => queue.completeRead(stateId!, { structureKey: S1, edges: [] })).toThrow();
  });

  it('受け入れない URL の辺は REJECTED で、待ち行列に入らない', () => {
    const queue = new CoverageQueue();
    expect(queue.enqueue({ kind: 'LINK', url: 'javascript:void(0)', frame: null, openedRegion: null })).toMatchObject({
      status: 'REJECTED',
      reason: 'UNSUPPORTED_SCHEME',
    });
    expect(queue.next()).toBeUndefined();
  });

  it('書き出しと読み戻しで状態が同じになり、続きから同じ順で再開できる', () => {
    const build = (): CoverageQueue => {
      const queue = new CoverageQueue();
      queue.enqueue(link('/'));
      queue.enqueue(link('/later'));
      const root = queue.next()!;
      queue.completeRead(root.stateId, { structureKey: S1, edges: [link('/a'), link('/b', 'SPA_ROUTE')] });
      queue.enqueue(link('/first'), { preferred: true });
      queue.acceptPress({ structureKey: S1, candidateIdentityDigest: CANDIDATE, ordinal: 2 });
      // 取り出したが読み終えていない状態（再開では先頭に戻す）。
      queue.next();
      return queue;
    };
    const original = build();
    const snapshot = original.snapshot();
    const json = JSON.parse(JSON.stringify(snapshot)) as unknown;
    const restored = CoverageQueue.restore(json);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.hasPressed({ structureKey: S1, candidateIdentityDigest: CANDIDATE, ordinal: 2 })).toBe(true);
    expect(restored.enqueue(link('/a')).status).toBe('KNOWN');
    const order: string[] = [];
    for (let item = restored.next(); item !== undefined; item = restored.next()) {
      order.push(item.url);
    }
    expect(order).toEqual([`${BASE}/first`, `${BASE}/later`, `${BASE}/a`, `${BASE}/b`]);
  });

  it('壊れた書き出しは読み戻さない', () => {
    const snapshot = new CoverageQueue().snapshot();
    expect(() => CoverageQueue.restore({ ...snapshot, format: 'other/1' })).toThrow();
    expect(() => CoverageQueue.restore({ ...snapshot, pending: ['sha256:unknown'] })).toThrow();
    expect(() => CoverageQueue.restore(null)).toThrow();
  });
});

const TAB_A = createSha256Fingerprint('tab-a');
const TAB_B = createSha256Fingerprint('tab-b');

/** ページの中の辺（印 `openedRegion` を付け忘れた形）。 */
const pressed = (path: string, structureKey: string, candidate: string, ordinal = 0): CoverageEdgeInput => ({
  kind: 'PRESS_RESULT',
  url: `${BASE}${path}`,
  frame: null,
  openedRegion: null,
  structureKey,
  press: { candidateIdentityDigest: candidate, ordinal },
});

describe('CoverageQueue: URL が変わらずに構造だけ変わった状態', () => {
  it('同じ URL で構造の鍵が違う 2 つの状態は、どちらも読まれる。同じ組は 1 回だけ', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/settings'));
    const root = queue.next()!;
    const result = queue.completeRead(root.stateId, {
      structureKey: S1,
      edges: [
        pressed('/settings', S2, TAB_A),
        pressed('/settings', S3, TAB_B),
        // 同じ組（場所・構造）は 2 回入らない。
        pressed('/settings', S2, TAB_B, 1),
        // 押しても元と同じ構造（何も変わらない）は入らない。
        pressed('/settings', S1, TAB_A, 2),
        // 移動の辺は場所の鍵だけで見分ける。
        link('/settings'),
      ],
    });
    expect(result.queuedStateIds).toHaveLength(2);
    const items = [queue.next()!, queue.next()!];
    expect(queue.next()).toBeUndefined();
    expect(items.map((item) => item.observedStructureKey)).toEqual([S2, S3]);
    expect(items.every((item) => item.url === `${BASE}/settings`)).toBe(true);
    expect(new Set(items.map((item) => item.stateId)).size).toBe(2);
    // たどり方: もとの移動の状態と、押した候補の並び。
    expect(items[0]!.trail).toEqual({ baseStateId: root.stateId, baseUrl: `${BASE}/settings`, presses: [{ candidateIdentityDigest: TAB_A, ordinal: 0 }] });
  });

  it('ページの中の状態からさらに押した状態は、押した候補の並びを伸ばす', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/s'));
    const root = queue.next()!;
    queue.completeRead(root.stateId, { structureKey: S1, edges: [pressed('/s', S2, TAB_A)] });
    const first = queue.next()!;
    queue.completeRead(first.stateId, { structureKey: S2, edges: [pressed('/s', S3, TAB_B, 4)] });
    const second = queue.next()!;
    expect(second.trail?.baseStateId).toBe(root.stateId);
    expect(second.trail?.presses).toEqual([{ candidateIdentityDigest: TAB_A, ordinal: 0 }, { candidateIdentityDigest: TAB_B, ordinal: 4 }]);
    expect(second.parentStateId).toBe(first.stateId);
  });

  it('ページの中の辺は enqueue では入れない', () => {
    const queue = new CoverageQueue();
    expect(() => queue.enqueue(pressed('/s', S2, TAB_A) as unknown as CoverageNavigationEdgeInput)).toThrow(RangeError);
  });
});

describe('CoverageQueue: 書き出しに秘密を残さない', () => {
  it('token= を持つ待ちの状態は値を残さず、読み戻した後は親の読み直しで URL が戻る', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/'));
    queue.enqueue(link('/next'));
    const root = queue.next()!;
    const rootEdges = { structureKey: S1, edges: [link('/reset?token=secretvalue1&step=2')] };
    queue.completeRead(root.stateId, rootEdges);
    const text = JSON.stringify(queue.snapshot());
    expect(text).not.toContain('secretvalue1');
    expect(text).toContain('step=2');

    const restored = CoverageQueue.restore(JSON.parse(text) as unknown);
    expect(restored.snapshot()).toEqual(queue.snapshot());
    expect(restored.awaitingStateIds()).toHaveLength(1);
    // 親（伏せた値を持たない）を作り直しとして先に渡す。
    const rebuild = restored.next()!;
    expect(rebuild).toMatchObject({ stateId: root.stateId, rebuild: true, url: `${BASE}/` });
    const recovered = restored.completeRead(rebuild.stateId, rootEdges);
    expect(recovered.queuedStateIds).toHaveLength(1);
    expect(restored.awaitingStateIds()).toHaveLength(0);
    // 待ちの順の位置は保つ（`/next` の後）。
    expect(restored.next()!.url).toBe(`${BASE}/next`);
    expect(restored.next()!.url).toBe(`${BASE}/reset?step=2&token=secretvalue1`);
    expect(restored.isFinished).toBe(true);
  });

  it('親も伏せた値を持つときは、さらに上の祖先から作り直す', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/'));
    const root = queue.next()!;
    const rootEdges = { structureKey: S1, edges: [link('/p?token=parentsecret')] };
    queue.completeRead(root.stateId, rootEdges);
    const parent = queue.next()!;
    const parentEdges = { structureKey: S2, edges: [link('/q?token=childsecret')] };
    queue.completeRead(parent.stateId, parentEdges);
    const text = JSON.stringify(queue.snapshot());
    expect(text).not.toContain('parentsecret');
    expect(text).not.toContain('childsecret');

    const restored = CoverageQueue.restore(JSON.parse(text) as unknown);
    const first = restored.next()!;
    expect(first).toMatchObject({ stateId: root.stateId, rebuild: true });
    restored.completeRead(first.stateId, rootEdges);
    const second = restored.next()!;
    expect(second).toMatchObject({ stateId: parent.stateId, rebuild: true, url: `${BASE}/p?token=parentsecret` });
    restored.completeRead(second.stateId, parentEdges);
    expect(restored.next()!.url).toBe(`${BASE}/q?token=childsecret`);
  });

  it('祖先のない伏せた待ちの状態は、同じ URL を enqueue すると戻る', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/start?token=startsecret'));
    const restored = CoverageQueue.restore(JSON.parse(JSON.stringify(queue.snapshot())) as unknown);
    expect(restored.next()).toBeUndefined();
    expect(restored.awaitingStateIds()).toHaveLength(1);
    expect(restored.enqueue(link('/start?token=startsecret')).status).toBe('RECOVERED');
    expect(restored.next()!.url).toBe(`${BASE}/start?token=startsecret`);
  });
});

describe('COV-2c（SREV-COV の I-4）: 押下の移り先（目印の値を伏せた状態）の書き出しと再開', () => {
  const MATCH_KEY = JSON.stringify([createSha256Fingerprint('go-button'), '[2,null]']);
  const moved = (value: string): CoverageNavigationEdgeInput => ({
    kind: 'LINK', url: `${BASE}/results?q=${value}&page=1`, frame: null, openedRegion: null, redactedQueryNames: ['q'],
    pressTrail: [{ index: 0, matchKey: MATCH_KEY, ordinal: 0 }],
  });

  it('伏せる名前と押下のたどり方を書き出し、読み戻せる（目印の値は残さない）', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/find'));
    const find = queue.next()!;
    queue.completeRead(find.stateId, { structureKey: S1, edges: [moved('bsprobe0123456789ab')] });
    const text = JSON.stringify(queue.snapshot());
    expect(text).not.toContain('bsprobe0123456789ab');
    const stored = queue.snapshot().states.find((state) => state.parentStateId === find.stateId);
    expect(stored).toMatchObject({ redacted: true, redactedQueryNames: ['q'], pressTrail: [{ index: 0, matchKey: MATCH_KEY, ordinal: 0 }] });

    const restored = CoverageQueue.restore(JSON.parse(text) as unknown);
    // 親を作り直しとして渡し、押下のたどり方を知らせる。
    const rebuild = restored.next()!;
    expect(rebuild).toMatchObject({ stateId: find.stateId, rebuild: true });
    expect(restored.pressTrailsAwaitingFrom(find.stateId)).toEqual([
      { stateId: stored!.stateId, kind: 'LINK', redactedQueryNames: ['q'], pressTrail: [{ index: 0, matchKey: MATCH_KEY, ordinal: 0 }], status: 'QUEUED' },
    ]);
    // 押し直した移り先（新しい目印の値）で URL が埋まり、取り出せる。
    const result = restored.completeRead(rebuild.stateId, { structureKey: S1, edges: [moved('bsprobeffffeeeedddd')] });
    expect(result.queuedStateIds).toEqual([stored!.stateId]);
    expect(restored.pressTrailsAwaitingFrom(find.stateId)).toEqual([]);
    expect(restored.next()!.url).toBe(`${BASE}/results?page=1&q=bsprobeffffeeeedddd`);
  });

  it('押下のたどり方の形が違う書き出しは読み戻さない', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/find'));
    const find = queue.next()!;
    queue.completeRead(find.stateId, { structureKey: S1, edges: [moved('bsprobe0123456789ab')] });
    const snapshot = JSON.parse(JSON.stringify(queue.snapshot())) as { states: Record<string, unknown>[] };
    snapshot.states[1]!['pressTrail'] = [{ index: -1, matchKey: MATCH_KEY, ordinal: 0 }];
    expect(() => CoverageQueue.restore(snapshot)).toThrow(RangeError);
    // LZ-2: 鍵の長さの上限（前は 4,096）は置かない。長い鍵は読み戻す。
    snapshot.states[1]!['pressTrail'] = [{ index: 0, matchKey: 'k'.repeat(4_097), ordinal: 0 }];
    expect(() => CoverageQueue.restore(snapshot)).not.toThrow();
  });
});

describe('COV-2c fix round 4（SREV-COV 3 回目の C-1）: 凍結の中でだけ読む状態と、凍結の外で読み込む入口の守り', () => {
  const MATCH_KEY = JSON.stringify([createSha256Fingerprint('go-button'), '[2,null]']);
  const trail = [{ index: 0, matchKey: MATCH_KEY, ordinal: 0 }];

  it('入口の守りは、押下から生まれた状態と、伏せた query を持つ URL を拒む', () => {
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/find`, frozenRequired: false, redactedQueryNames: [] })).toBeNull();
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/r1?q=x`, frozenRequired: true, redactedQueryNames: [] })).toBe('PRESS_BORN_STATE');
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/r1?q=x`, frozenRequired: false, redactedQueryNames: ['q'] })).toBe('REDACTED_QUERY');
    // 伏せた名前が URL にないなら、拒まない。
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/r2?p=2`, frozenRequired: false, redactedQueryNames: ['q'] })).toBeNull();
  });

  it('2 段の押下の先は、押下を経ていない祖先から、凍結の中で順にたどる（凍結の外で読み込むのは祖先だけ）', () => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/find'));
    const find = queue.next()!;
    expect(find).toMatchObject({ frozenRequired: false, frozenPath: null, unfrozenLoad: { url: `${BASE}/find`, frozenRequired: false } });
    queue.completeRead(find.stateId, {
      structureKey: S1,
      edges: [{ kind: 'LINK', url: `${BASE}/r1?q=bsprobe0123456789ab`, frame: null, openedRegion: null, redactedQueryNames: ['q'], pressTrail: trail }],
    });
    const r1 = queue.next()!;
    expect(r1).toMatchObject({ frozenRequired: true, frozenPath: { rootUrl: `${BASE}/find`, hops: [] }, unfrozenLoad: { url: `${BASE}/find` } });
    // r1 から出た辺は、凍結の中でだけ読む印と、親の伏せた名前を受け継ぐ（呼び出し側が付ける）。
    queue.completeRead(r1.stateId, {
      structureKey: S2,
      edges: [{ kind: 'LINK', url: `${BASE}/r2?p=2`, frame: null, openedRegion: null, redactedQueryNames: ['q'], frozenRead: true }],
    });
    const r2 = queue.next()!;
    expect(r2).toMatchObject({
      frozenRequired: true, frozenPath: { rootUrl: `${BASE}/find`, hops: [`${BASE}/r1?q=bsprobe0123456789ab`] }, unfrozenLoad: { url: `${BASE}/find` },
    });
    expect(unfrozenLoadRefusalOf(r2.unfrozenLoad!)).toBeNull();
    // 書き出しに、凍結の中でだけ読む印が残り、目印の値は残らない。読み戻せる。
    const text = JSON.stringify(queue.snapshot());
    expect(text).not.toContain('bsprobe0123456789ab');
    expect(queue.snapshot().states.find((state) => state.stateId === r2.stateId)).toMatchObject({ frozenRead: true });
    expect(() => CoverageQueue.restore(JSON.parse(text) as unknown)).not.toThrow();
  });
});

describe('COV-2c fix round 5（SREV-COV 4 回目の M-2）: 入口の守りを名前の形と目印の値で照らす。印を消した書き出しを読み戻さない', () => {
  const MATCH_KEY = JSON.stringify([createSha256Fingerprint('go-button'), '[2,null]']);
  const trail = [{ index: 0, matchKey: MATCH_KEY, ordinal: 0 }];
  const MARKER = 'bsprobe0123456789ab';

  it('大文字の名前・符号化した名前・別の名前に載った目印の値を拒む', () => {
    // 名前の大文字・小文字をそろえて比べる。
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/r1?Q=x`, frozenRequired: false, redactedQueryNames: ['q'] })).toBe('REDACTED_QUERY');
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/r1?q=x`, frozenRequired: false, redactedQueryNames: ['Q'] })).toBe('REDACTED_QUERY');
    // 符号化した名前（`q%5B%5D` は `q[]`）も、符号化を戻してそろえて比べる。
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/r1?q%5B%5D=x`, frozenRequired: false, redactedQueryNames: ['q'] })).toBe('REDACTED_QUERY');
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/r1?q%5B%5D=x`, frozenRequired: false, redactedQueryNames: ['q[]'] })).toBe('REDACTED_QUERY');
    // 伏せた名前と違う名前に載った目印の値も拒む（そのままの値・符号化した値）。
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/detail?kw=${MARKER}`, frozenRequired: false, redactedQueryNames: ['q'] }, [MARKER])).toBe('MARKER_VALUE');
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/detail?kw=x%20${MARKER}`, frozenRequired: false, redactedQueryNames: [] }, [MARKER])).toBe('MARKER_VALUE');
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/detail?KW=${encodeURIComponent(`a ${MARKER}`)}`, frozenRequired: false, redactedQueryNames: [] }, [MARKER])).toBe('MARKER_VALUE');
    // 目印の値も伏せた名前もない URL は拒まない。
    expect(unfrozenLoadRefusalOf({ url: `${BASE}/detail?kw=plain`, frozenRequired: false, redactedQueryNames: ['q'] }, [MARKER])).toBeNull();
  });

  /** 2 段の押下の先（r1 は押下から生まれた状態、r2 はそこから出た辺の先）を持つ書き出し。 */
  const twoStages = (): { text: string; r1: string; r2: string } => {
    const queue = new CoverageQueue();
    queue.enqueue(link('/find'));
    const find = queue.next()!;
    queue.completeRead(find.stateId, {
      structureKey: S1,
      edges: [{ kind: 'LINK', url: `${BASE}/r1?q=${MARKER}`, frame: null, openedRegion: null, redactedQueryNames: ['q'], pressTrail: trail }],
    });
    const r1 = queue.next()!;
    queue.completeRead(r1.stateId, {
      structureKey: S2,
      edges: [{ kind: 'LINK', url: `${BASE}/r2?p=2`, frame: null, openedRegion: null, redactedQueryNames: ['q'], frozenRead: true }],
    });
    const r2 = queue.next()!;
    return { text: JSON.stringify(queue.snapshot()), r1: r1.stateId, r2: r2.stateId };
  };

  it('印のそろった書き出しは読み戻す', () => {
    const { text } = twoStages();
    expect(() => CoverageQueue.restore(JSON.parse(text) as unknown)).not.toThrow();
  });

  it('押下から生まれた状態の子から frozenRead を消した書き出しは読み戻さない', () => {
    const { text, r2 } = twoStages();
    const snapshot = JSON.parse(text) as { states: Record<string, unknown>[] };
    const state = snapshot.states.find((candidate) => candidate['stateId'] === r2)!;
    delete state['frozenRead'];
    expect(() => CoverageQueue.restore(snapshot)).toThrow();
  });

  it('伏せた名前を持つ押下の移り先から pressTrail を消した書き出しは読み戻さない', () => {
    const { text, r1 } = twoStages();
    const snapshot = JSON.parse(text) as { states: Record<string, unknown>[] };
    const state = snapshot.states.find((candidate) => candidate['stateId'] === r1)!;
    delete state['pressTrail'];
    expect(() => CoverageQueue.restore(snapshot)).toThrow();
  });
});

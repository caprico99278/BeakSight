// 中断した Run の再開（`2026-10-01-beaksight-resumable-run-design.md` 4.3.1、4.5）の R4a と R4a2a: 保存のセッション
// （`src/orchestration/run-checkpoint-session.ts`）。偽の保存の書き手で確かめる。SPEC-2: セッションはロックを持たない（監査中の印は、
// 出力先のロック。`tests/unit/output-start-lock.test.ts`）。
// 本物の `ArtifactWriter` を書き手にした確かめは、結合テスト（`tests/integration/run-checkpoint.test.ts`）で行う。
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { PageId } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  type RunCheckpoint,
  type RunCheckpointPage,
  type RunCheckpointStore,
} from '../../src/orchestration/run-checkpoint.js';
import {
  RUN_CHECKPOINT_SESSION_START_MODES,
  RunCheckpointSession,
  type RunCheckpointSessionOptions,
  type RunCheckpointSessionStartOptions,
} from '../../src/orchestration/run-checkpoint-session.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { PAGE_1, PAGE_2 } from '../helpers/audit-run-fixture.js';
import { sampleRunCheckpoint, sampleRunCheckpointPage } from '../helpers/run-checkpoint-samples.js';

const RUN_DIRECTORY = 'C:/work/output/RUN-20261001000000';

/** 書き手が呼ばれた順の記録の1件。 */
type StoreCall =
  | { readonly kind: 'writeCheckpointPage'; readonly runDirectory: string; readonly page: RunCheckpointPage }
  | { readonly kind: 'writeCheckpointState'; readonly runDirectory: string; readonly state: RunCheckpoint }
  | { readonly kind: 'cleanUpForResume'; readonly runDirectory: string; readonly completedPageIds: readonly PageId[] };

/** 偽の書き手。呼ばれた順に `calls` に記録する。振る舞いは、各操作の差し替え口で変える。 */
function fakeStore(overrides: Partial<RunCheckpointStore> = {}): { readonly store: RunCheckpointStore; readonly calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const store: RunCheckpointStore = {
    writeCheckpointPage: async (runDirectory, page) => {
      calls.push({ kind: 'writeCheckpointPage', runDirectory, page });
      return overrides.writeCheckpointPage === undefined ? `checkpoint/pages/${page.pageId}.json` : overrides.writeCheckpointPage(runDirectory, page);
    },
    writeCheckpointState: async (runDirectory, state) => {
      calls.push({ kind: 'writeCheckpointState', runDirectory, state });
      await overrides.writeCheckpointState?.(runDirectory, state);
    },
    cleanUpForResume: async (runDirectory, completedPageIds) => {
      calls.push({ kind: 'cleanUpForResume', runDirectory, completedPageIds });
      return overrides.cleanUpForResume === undefined ? [] : overrides.cleanUpForResume(runDirectory, completedPageIds);
    },
  };
  return { store, calls };
}

/** 偽の書き手で作ったセッション。 */
function createSession(overrides: Partial<RunCheckpointStore> = {}) {
  const { store, calls } = fakeStore(overrides);
  return { session: new RunCheckpointSession({ store }), calls };
}

const kindsOf = (calls: readonly StoreCall[]): string[] => calls.map(({ kind }) => kind);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R4a: the checkpoint samples of the tests (CC-037)', () => {
  it('match the checkpoint schemas and the R2 consistency checks', async () => {
    const state = sampleRunCheckpoint({ startPageFinished: true });
    const page = sampleRunCheckpointPage();
    await expect(validateArtifact('checkpoint', sampleRunCheckpoint())).resolves.toEqual({ ok: true });
    await expect(validateArtifact('checkpoint', state)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('checkpoint-page', page)).resolves.toEqual({ ok: true });
    expect(checkRunCheckpointConsistency(sampleRunCheckpoint())).toEqual({ ok: true });
    expect(checkRunCheckpointConsistency(state)).toEqual({ ok: true });
    expect(checkRunCheckpointPageConsistency(page, state)).toEqual({ ok: true });
  });
});

describe('R4a: the checkpoint store interface (design 4.3.1)', () => {
  it('is satisfied by ArtifactWriter, without orchestration importing report', () => {
    expectTypeOf<ArtifactWriter>().toExtend<RunCheckpointStore>();
    const store: RunCheckpointStore = new ArtifactWriter();
    expect(typeof store.writeCheckpointPage).toBe('function');
  });
});

describe('R4a: starting the checkpoint session of a new Run (design 4.3.1)', () => {
  it('starts without writing anything (SPEC-2: no lock in the run directory)', async () => {
    const { session, calls } = createSession();

    await expect(session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([]);
  });

  it('rejects a second start, a start mode outside the closed list, and an empty run directory', async () => {
    // R4a2a で `RESUME` を加えた（再開の始め方は、下の R4a2a のテストで確かめる）。
    expect(RUN_CHECKPOINT_SESSION_START_MODES).toEqual(['NEW_RUN', 'RESUME']);
    const { session } = createSession();
    await expect(session.start('', { mode: 'NEW_RUN' })).rejects.toThrow(TypeError);
    await expect(session.start(RUN_DIRECTORY, { mode: 'CONTINUE' } as unknown as { mode: 'NEW_RUN' })).rejects.toThrow(RangeError);

    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    await expect(session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' })).rejects.toThrow(/already/u);
  });

  it('rejects options without the store operations with TypeError', () => {
    const { store } = fakeStore();
    const invalid: unknown[] = [undefined, { store: undefined }, { store: { ...store, cleanUpForResume: undefined } }];
    for (const options of invalid) {
      expect(() => new RunCheckpointSession(options as RunCheckpointSessionOptions)).toThrow(TypeError);
    }
    expect(() => new RunCheckpointSession({ store })).not.toThrow();
  });
});

describe('R4a: saving pages and the run state (design 4.3)', () => {
  it('passes the page checkpoint and the state to the store with the run directory of the session', async () => {
    const { session, calls } = createSession();
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    const page = sampleRunCheckpointPage();
    const state = sampleRunCheckpoint({ startPageFinished: true });

    await expect(session.savePage(page)).resolves.toBeUndefined();
    await expect(session.saveState(state)).resolves.toBeUndefined();

    expect(calls).toEqual([
      { kind: 'writeCheckpointPage', runDirectory: RUN_DIRECTORY, page },
      { kind: 'writeCheckpointState', runDirectory: RUN_DIRECTORY, state },
    ]);
  });

  it('passes the failures of the store on to the caller', async () => {
    const pageFailure = new Error('page write failed');
    const stateFailure = new Error('state write failed');
    const { session } = createSession({
      writeCheckpointPage: async () => Promise.reject(pageFailure),
      writeCheckpointState: async () => Promise.reject(stateFailure),
    });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    await expect(session.savePage(sampleRunCheckpointPage())).rejects.toBe(pageFailure);
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toBe(stateFailure);
  });

  it('rejects saving before the session starts', async () => {
    const { session, calls } = createSession();

    await expect(session.savePage(sampleRunCheckpointPage())).rejects.toThrow(/not active/u);
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
    expect(calls).toEqual([]);
  });
});

describe('R4a: finishing and abandoning the session (design 4.3.1)', () => {
  it('finishes by writing the final state, and saves nothing after that', async () => {
    const { session, calls } = createSession();
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    const finalState = sampleRunCheckpoint({ startPageFinished: true, state: 'FINISHED' });

    await session.finish(finalState);

    expect(calls).toEqual([{ kind: 'writeCheckpointState', runDirectory: RUN_DIRECTORY, state: finalState }]);
    await expect(session.saveState(finalState)).rejects.toThrow(/not active/u);
    await expect(session.finish(finalState)).rejects.toThrow(/not active/u);
  });

  it('passes on the failure of writing the final state, and ends the session', async () => {
    const failure = new Error('final state write failed');
    const { session } = createSession({ writeCheckpointState: async () => Promise.reject(failure) });
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });

    await expect(session.finish(sampleRunCheckpoint({ state: 'FINISHED' }))).rejects.toBe(failure);
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
  });

  it('abandons without writing (the state stays IN_PROGRESS for a resume)', async () => {
    const { session, calls } = createSession();
    await session.start(RUN_DIRECTORY, { mode: 'NEW_RUN' });
    await session.saveState(sampleRunCheckpoint());

    await expect(session.abandon()).resolves.toBeUndefined();

    expect(kindsOf(calls)).toEqual(['writeCheckpointState']);
    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
    // 2回目のやめる操作は、何もしない。
    await expect(session.abandon()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R4a2a: 再開のときの始め方（設計書 4.4、4.5）
// ---------------------------------------------------------------------------------------------------------------

/** 再開する保存の、終わったページの ID。 */
const COMPLETED_PAGE_IDS: readonly PageId[] = Object.freeze([PAGE_1]);
/** 後始末で消したもの（偽の書き手が返す、Run のディレクトリからの相対パス）。 */
const REMOVED_PATHS: readonly string[] = Object.freeze([`pages/${PAGE_2}`, `checkpoint/pages/${PAGE_2}.json`]);

/** 再開の始め方の指定。 */
const resume = (completedPageIds: readonly PageId[] = COMPLETED_PAGE_IDS): RunCheckpointSessionStartOptions =>
  Object.freeze({ mode: 'RESUME', completedPageIds });

describe('R4a2a: starting the checkpoint session of a resumed Run (design 4.5)', () => {
  it('cleans up the run directory, and then saves', async () => {
    const { session, calls } = createSession({ cleanUpForResume: async () => REMOVED_PATHS });

    await expect(session.start(RUN_DIRECTORY, resume())).resolves.toEqual({ ok: true, removedPaths: REMOVED_PATHS });

    expect(calls).toEqual([{ kind: 'cleanUpForResume', runDirectory: RUN_DIRECTORY, completedPageIds: COMPLETED_PAGE_IDS }]);
    await expect(session.saveState(sampleRunCheckpoint({ startPageFinished: true }))).resolves.toBeUndefined();
  });

  it('passes on the failure of the cleanup, and does not start', async () => {
    const failure = new Error('cleanUpForResume failed');
    const { session } = createSession({ cleanUpForResume: async () => Promise.reject(failure) });

    await expect(session.start(RUN_DIRECTORY, resume())).rejects.toBe(failure);

    await expect(session.saveState(sampleRunCheckpoint())).rejects.toThrow(/not active/u);
  });

  it('rejects a resume without the list of completed page IDs, or with a malformed page ID, before touching the store', async () => {
    const { session, calls } = createSession();

    await expect(session.start(RUN_DIRECTORY, { mode: 'RESUME' } as unknown as RunCheckpointSessionStartOptions)).rejects.toThrow(TypeError);
    await expect(session.start(RUN_DIRECTORY, resume(['../x' as PageId]))).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);

    await expect(session.start(RUN_DIRECTORY, resume([]))).resolves.toEqual({ ok: true, removedPaths: [] });
    await expect(session.start(RUN_DIRECTORY, resume())).rejects.toThrow(/already/u);
  });
});

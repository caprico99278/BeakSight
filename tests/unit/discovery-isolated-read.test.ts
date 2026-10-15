// DEF-087（Task 27 の設計書 4.2、4.5）: isolated world の読み取り（`src/discovery/isolated-read.ts`）と、発見の CDP の session の開け閉め
// （`src/discovery/cdp-session.ts`）の単体テスト。偽の page と session で確かめる（本物の Chromium の確かめは `discovery-probe.test.ts`）。
// - 送る命令は、閉じた一覧（`ISOLATED_READ_CDP_COMMANDS`）の 3 つだけで、この順（main frame の id → isolated world → 関数の実行）。関数は
//   文字列にして、引数は値（JSON）で、結果は値（`returnByValue`）で渡す。
// - 読めなかった場合（例外の詳細、古い world の id、形の誤り、命令の失敗、期限切れ、session を開けない）は、すべて `FAILED`（fail-closed）。
// - session は、読み終わったら（失敗しても）切る。期限の後に開いた session も、開いた時点で切る。
import type { CDPSession, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { DISCOVERY_SESSION_DETACH_TIMEOUT_MS } from '../../src/discovery/cdp-session.js';
import { ISOLATED_READ_CDP_COMMANDS, ISOLATED_READ_WORLD_NAME, readInIsolatedWorld } from '../../src/discovery/isolated-read.js';

const FRAME_ID = 'main-frame';
const EXECUTION_CONTEXT_ID = 7;
/** 期限の確かめの、短い期限（ms）と、期限の後に session を開くまでの時間（ms）。 */
const SHORT_DEADLINE_MS = 50;
const LATE_OPEN_DELAY_MS = 100;
/** 期限の確かめの、結果が返るまでの許容（ms。期限と、session を切る待ちの上限の和に足す）。 */
const RETURN_ALLOWANCE_MS = 500;

/** ページの中で動く関数の代わり（文字列にして渡るだけで、ここでは動かない）。 */
function readInPageExample(input: { readonly limit: number }): { readonly doubled: number } {
  return { doubled: input.limit * 2 };
}
const INPUT = Object.freeze({ limit: 3 });

type Responder = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** 正常に答える responder（`overrides` の命令だけ差し替える）。 */
const responder = (overrides: Readonly<Record<string, Responder>> = {}): Responder => async (method, params) => {
  const override = overrides[method];
  if (override !== undefined) {
    return override(method, params);
  }
  switch (method) {
    case 'Page.getFrameTree':
      return { frameTree: { frame: { id: FRAME_ID }, childFrames: [] } };
    case 'Page.createIsolatedWorld':
      return { executionContextId: EXECUTION_CONTEXT_ID };
    case 'Runtime.callFunctionOn':
      return { result: { type: 'object', value: { doubled: 6 } } };
    default:
      throw new Error(`unexpected command: ${method}`);
  }
};

/** 偽の page と session（送った命令と、切った回数を記録する）。 */
const fakeSession = (respond: Responder, openSession: (session: CDPSession) => Promise<CDPSession> = async (session) => session) => {
  const sent: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
  const detach = vi.fn(async (): Promise<void> => undefined);
  const session = {
    send: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      sent.push({ method, params });
      return respond(method, params);
    },
    detach,
  } as unknown as CDPSession;
  const page = { context: () => ({ newCDPSession: () => openSession(session) }) } as unknown as Page;
  return { page, sent, detach };
};

describe('DEF-087: reading in an isolated world through CDP', () => {
  it('sends only the closed list of commands, in order, and returns the value of the function', async () => {
    const { page, sent, detach } = fakeSession(responder());
    const outcome = await readInIsolatedWorld(page, readInPageExample, INPUT, Date.now() + DISCOVERY_SESSION_DETACH_TIMEOUT_MS);
    expect(outcome).toEqual({ status: 'READ', value: { doubled: 6 } });
    expect(sent.map(({ method }) => method)).toEqual([...ISOLATED_READ_CDP_COMMANDS]);
    expect(sent[1]?.params).toEqual({ frameId: FRAME_ID, worldName: ISOLATED_READ_WORLD_NAME });
    expect(sent[2]?.params).toEqual({
      functionDeclaration: String(readInPageExample),
      executionContextId: EXECUTION_CONTEXT_ID,
      arguments: [{ value: INPUT }],
      returnByValue: true,
      silent: true,
    });
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an exception in the function', responder({
      'Runtime.callFunctionOn': async () => ({ result: { type: 'object' }, exceptionDetails: { text: 'Uncaught' } }),
    })],
    ['a stale world id after a reload', responder({
      'Runtime.callFunctionOn': async () => {
        throw new Error('Protocol error (Runtime.callFunctionOn): Cannot find context with specified id');
      },
    })],
    ['a failed isolated world', responder({
      'Page.createIsolatedWorld': async () => {
        throw new Error('Protocol error (Page.createIsolatedWorld): No frame for given id found');
      },
    })],
    ['a malformed frame tree', responder({ 'Page.getFrameTree': async () => ({ frameTree: { frame: {} } }) })],
    ['a malformed world id', responder({ 'Page.createIsolatedWorld': async () => ({ executionContextId: 'x' }) })],
    ['a malformed result', responder({ 'Runtime.callFunctionOn': async () => ({}) })],
  ])('fails (fail-closed) on %s, and detaches the session', async (_case, respond) => {
    const { page, detach } = fakeSession(respond);
    expect(await readInIsolatedWorld(page, readInPageExample, INPUT, Date.now() + DISCOVERY_SESSION_DETACH_TIMEOUT_MS)).toEqual({ status: 'FAILED' });
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('does not create a world when the frame tree is malformed', async () => {
    const { page, sent } = fakeSession(responder({ 'Page.getFrameTree': async () => ({}) }));
    expect(await readInIsolatedWorld(page, readInPageExample, INPUT, Date.now() + DISCOVERY_SESSION_DETACH_TIMEOUT_MS)).toEqual({ status: 'FAILED' });
    expect(sent.map(({ method }) => method)).toEqual(['Page.getFrameTree']);
  });

  it('fails by the deadline when the page does not answer, and detaches the session', async () => {
    const { page, detach } = fakeSession(responder({ 'Runtime.callFunctionOn': () => new Promise<never>(() => undefined) }));
    const startedAt = Date.now();
    expect(await readInIsolatedWorld(page, readInPageExample, INPUT, startedAt + SHORT_DEADLINE_MS)).toEqual({ status: 'FAILED' });
    expect(Date.now() - startedAt).toBeLessThan(SHORT_DEADLINE_MS + DISCOVERY_SESSION_DETACH_TIMEOUT_MS + RETURN_ALLOWANCE_MS);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('fails by the deadline when the session opens late, and detaches the session when it opens', async () => {
    const { page, sent, detach } = fakeSession(responder(), async (session) => {
      await wait(LATE_OPEN_DELAY_MS);
      return session;
    });
    expect(await readInIsolatedWorld(page, readInPageExample, INPUT, Date.now() + SHORT_DEADLINE_MS)).toEqual({ status: 'FAILED' });
    expect(detach).not.toHaveBeenCalled();
    await wait(LATE_OPEN_DELAY_MS);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it('fails when the session cannot be opened (a closed page)', async () => {
    const { page } = fakeSession(responder(), async () => {
      throw new Error('Target page, context or browser has been closed');
    });
    expect(await readInIsolatedWorld(page, readInPageExample, INPUT, Date.now() + DISCOVERY_SESSION_DETACH_TIMEOUT_MS)).toEqual({ status: 'FAILED' });
  });

  it('fails when the deadline has already passed, without sending anything', async () => {
    const { page, sent } = fakeSession(responder());
    expect(await readInIsolatedWorld(page, readInPageExample, INPUT, Date.now() - SHORT_DEADLINE_MS)).toEqual({ status: 'FAILED' });
    expect(sent).toEqual([]);
  });

  it('names the closed list of commands and the world', () => {
    expect(ISOLATED_READ_CDP_COMMANDS).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.callFunctionOn']);
    expect(Object.isFrozen(ISOLATED_READ_CDP_COMMANDS)).toBe(true);
    expect(ISOLATED_READ_WORLD_NAME).toMatch(/^beaksight-/u);
  });
});

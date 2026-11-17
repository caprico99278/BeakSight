// L6/L3-1 の続き（T18。設計者の判断 2026-11-10）: 押した後の待ちを、決まった時間（`SUBMISSION_PROBE_QUIET_WAIT_MS`）から、事実の待ち（`settleAfterAction`。
// `src/browser/page-settling.ts` の `waitForPageSettled` と、口ごとのデータの静まり `dataQuietnessOf`）に替えた。ブラウザを使わず、読み取りを真似た page で確かめる。
// - 押した後に通信がなく、画面も変わらなければ、静まりの窓（`PAGE_SETTLING_PACING.stableWindowMs`）だけ待って、決まった時間より早く進む。
// - まだ応答を返し終えていない口への要求が途中の間は待ち、返し終えたら進む。
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { DataActivity } from '../../src/browser/page-settling.js';
import { PAGE_SETTLING_PACING } from '../../src/core/limits.js';
import { SUBMISSION_PROBE_QUIET_WAIT_MS } from '../../src/discovery/submission-probe-contracts.js';
import { DocumentUnusableError, settleAfterAction, stepOnUsableDocument, waitAfterPress } from '../../src/interaction/submission-probe.js';

/** 文書の状態と作りの印を読む page（いつも同じ値。画面は変わらない）。CDP の session は開けない（画面の変化の見回りは読めないだけ）。 */
const stillPage = (): Page => Object.assign(new EventEmitter(), {
  // DEF-279: 押した後の待ちは、文書を使える間だけ待つ（文書の場所を読む）。
  mainFrame: () => ({ url: () => 'http://127.0.0.1/form' }),
  url: () => 'http://127.0.0.1/form',
  isClosed: () => false,
  waitForLoadState: () => Promise.resolve(),
  evaluate: (_reader: unknown, argument?: unknown) => Promise.resolve(argument === undefined
    ? { readyState: 'complete', scrollHeight: 800, elementCount: 20, textLength: 100 }
    : []),
  context: () => { throw new Error('no CDP in this test'); },
}) as unknown as Page;

const ENDPOINT = JSON.stringify(['GET', 'http://127.0.0.1', '/api/items']);

describe('L6/L3-1 (T18): the wait after a press is a wait for the facts', () => {
  it('moves on after the stable window when the press started no request (sooner than the former fixed wait)', async () => {
    const startedAt = Date.now();
    await settleAfterAction(stillPage(), () => ({ inFlight: 0, events: 0, endpoints: { inFlight: [], completed: [] } }));
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(PAGE_SETTLING_PACING.stableWindowMs);
    expect(elapsed).toBeLessThan(SUBMISSION_PROBE_QUIET_WAIT_MS);
  });

  it('waits while a request to an endpoint that has not answered is in flight, and moves on once it answered', async () => {
    const answerAfterMs = 1_500;
    const startedAt = Date.now();
    const activity = (): DataActivity => (Date.now() - startedAt < answerAfterMs
      ? { inFlight: 1, events: 1, endpoints: { inFlight: [ENDPOINT], completed: [] } }
      : { inFlight: 0, events: 2, endpoints: { inFlight: [], completed: [ENDPOINT] } });
    await settleAfterAction(stillPage(), activity);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(answerAfterMs + PAGE_SETTLING_PACING.stableWindowMs);
  });

  // 設計者の判断 C: 押した後は、最短の観察の長さ（前と同じ 2 秒。テストは短くする）が過ぎるまで待ち、そのうえで落ち着くまで待つ（遅れて送る作りを見落とさない）。
  it('waits for the minimum observation after a press, then for the page to settle (T18, decision C)', async () => {
    const minimumMs = 1_200;
    const startedAt = Date.now();
    await waitAfterPress(stillPage(), { minimumMs, dataActivity: () => ({ inFlight: 0, events: 0, endpoints: { inFlight: [], completed: [] } }) });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(minimumMs + PAGE_SETTLING_PACING.stableWindowMs);
  });

  // L10 の調べ（CLI の Chromium の `mailto:`）: 欄に入れたのをきっかけにページが外部スキームへ移ろうとし、文書が誤りの画面に替わると、期限のない次の 1 手は
  // 返らない。事実（文書の替わり・Safety の記録）で、その文書の 1 手を待つのをやめる（`stepOnUsableDocument`。期限は付けない）。
  it('stops waiting for a step on a document that turned into the error page, or once the Safety record says the document is not to be used', async () => {
    const mainFrame = { url: () => 'http://127.0.0.1/form' };
    const page = Object.assign(new EventEmitter(), { mainFrame: () => mainFrame, url: () => mainFrame.url(), isClosed: () => false }) as unknown as Page;
    const never = new Promise<never>(() => undefined);
    const toError = stepOnUsableDocument(page, never, () => false);
    mainFrame.url = () => 'chrome-error://chromewebdata/';
    (page as unknown as EventEmitter).emit('framenavigated', mainFrame);
    await expect(toError).rejects.toBeInstanceOf(DocumentUnusableError);
    let recorded = false;
    mainFrame.url = () => 'http://127.0.0.1/form';
    const byRecord = stepOnUsableDocument(page, never, () => recorded);
    recorded = true;
    await expect(byRecord).rejects.toBeInstanceOf(DocumentUnusableError);
    // ふつうの 1 手は、そのまま返る。
    await expect(stepOnUsableDocument(page, Promise.resolve('done'), () => false)).resolves.toBe('done');
  });

  // DEF-279（RB-13 の後の設計者の判断）: 押した後の落ち着きの待ちも、Safety の記録がこの文書を使うのをやめると言ったら終える（ページの中の読み取りが返らなくても、
  // 1 画面の見張りまで待たない）。
  it('DEF-279: stops the wait after a press once the Safety record says the document is not to be used, even if a read in the page never returns', async () => {
    const mainFrame = { url: () => 'http://127.0.0.1/form' };
    const hungPage = Object.assign(new EventEmitter(), {
      mainFrame: () => mainFrame,
      url: () => mainFrame.url(),
      isClosed: () => false,
      waitForLoadState: () => Promise.resolve(),
      evaluate: () => new Promise<never>(() => undefined),
      context: () => { throw new Error('no CDP in this test'); },
    }) as unknown as Page;
    let recorded = false;
    const pressed = waitAfterPress(hungPage, { minimumMs: 0, dataActivity: undefined, recordUnusable: () => recorded });
    setTimeout(() => { recorded = true; }, PAGE_SETTLING_PACING.pollIntervalMs);
    const observedForMs = PAGE_SETTLING_PACING.stableWindowMs * 4;
    const outcome = await Promise.race([
      pressed.then(() => 'ENDED'),
      new Promise<string>((resolve) => { setTimeout(() => resolve('STILL_WAITING'), observedForMs); }),
    ]);
    expect(outcome).toBe('ENDED');
  });

  it('does not wait for repeated requests to an endpoint that has already answered (polling)', async () => {
    let events = 0;
    const startedAt = Date.now();
    await settleAfterAction(stillPage(), () => {
      events += 1;
      return { inFlight: 1, events, endpoints: { inFlight: [ENDPOINT], completed: [ENDPOINT] } };
    });
    expect(Date.now() - startedAt).toBeLessThan(SUBMISSION_PROBE_QUIET_WAIT_MS);
  });
});

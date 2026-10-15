// 発見の CDP の session の開け閉め（DEF-087。Task 27 の設計書 4.2、4.5）。ブラウザの部品（`tests/architecture/discovery-boundary.test.ts` の
// `BROWSER_DISCOVERY_FILES`）。isolated world の読み取り（`isolated-read.ts`）と JS の結び付きの読み取り（`listeners.ts`）が共通に使う。
// - session は Playwright の `newCDPSession` で、page ごとに新しく開く（Guard の session とは別）。`src/discovery/` で session を開くのは、
//   ここだけ（Gate `discovery-boundary` の (c)）。
// - 期限（`deadlineAtMs`）までに開けなければ、読めなかったとする。期限の後に開いた session は、開いた時点で切る。
// - 読み終わったら（失敗しても）、手放す処理（呼ぶ側の命令。例: remote object の群を手放す）の後に session を切る。どちらも、
//   `DISCOVERY_SESSION_DETACH_TIMEOUT_MS` まで待つ（超えても切る処理は続く。失敗は投げない）。
// - 命令は、呼ぶ側が閉じた一覧（`*_CDP_COMMANDS`）の名前を型で絞って渡す。ここは期限の中で送り、結果が record でなければ失敗にする
//   （引数の形は CDP の定義に任せ、結果は呼ぶ側が形を見てから使う）。
import type { CDPSession, Page } from 'playwright';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { isRecord } from '../core/guards.js';

/** 読み終わった後（失敗の後を含む）に、手放す処理と session を切る処理を待つ上限（ms）。超えても、切る処理は続く。 */
export const DISCOVERY_SESSION_DETACH_TIMEOUT_MS = 1_000;

/** CDP の読み取りの失敗（命令の失敗、期限切れ、形の誤り）。呼ぶ側は、読めなかったとして扱う。 */
export class DiscoveryCdpReadFailure extends Error {}

/**
 * 命令を、期限までに送る。期限切れ・失敗・結果が record でないときは `DiscoveryCdpReadFailure` を投げる。`method` は、呼ぶ側の閉じた一覧の
 * 名前（呼ぶ側が型で絞る）。
 */
export async function sendDiscoveryCdpCommand(
  session: CDPSession,
  method: string,
  params: Record<string, unknown>,
  deadlineAtMs: number,
): Promise<Record<string, unknown>> {
  const outcome = await awaitBeforeDeadline(session.send(method as never, params as never), deadlineAtMs);
  if (outcome.status !== 'FULFILLED' || !isRecord(outcome.value)) {
    throw new DiscoveryCdpReadFailure();
  }
  return outcome.value;
}

/**
 * page の CDP の session を期限までに開き、`read` で読む（例外を投げない）。開けない・`read` が投げたときは `failed` を返す。session は、
 * 読み終わったら（失敗しても）、`release`（あれば）の後に切る。
 */
export async function readWithDiscoveryCdpSession<T>(
  page: Page,
  deadlineAtMs: number,
  failed: T,
  read: (session: CDPSession) => Promise<T>,
  release?: (session: CDPSession, releaseDeadlineAtMs: number) => Promise<unknown>,
): Promise<T> {
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= Date.now()) {
    // 期限を過ぎていれば、session を開かない。
    return failed;
  }
  let opening: Promise<CDPSession>;
  try {
    opening = page.context().newCDPSession(page);
  } catch {
    return failed;
  }
  const opened = await awaitBeforeDeadline(opening, deadlineAtMs);
  if (opened.status !== 'FULFILLED') {
    // 期限の後に開いた session は、開いた時点で切る。
    opening.then((session) => session.detach()).catch(() => undefined);
    return failed;
  }
  const session = opened.value;
  try {
    return await read(session);
  } catch {
    return failed;
  } finally {
    const releaseDeadlineAtMs = Date.now() + DISCOVERY_SESSION_DETACH_TIMEOUT_MS;
    if (release !== undefined) {
      await awaitBeforeDeadline(Promise.resolve().then(() => release(session, releaseDeadlineAtMs)), releaseDeadlineAtMs);
    }
    await awaitBeforeDeadline(session.detach(), releaseDeadlineAtMs);
  }
}

/**
 * AS-c fix round 1（C-1・C-2。設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 5 章の「AS-R … とユーザーの判断」の行）: 監査の段の送信の扱い
 * `PASS_EXCEPT_DELETE` の Passive の Context で、ブラウザが実際に開いた WebSocket の接続を、CDP の事象（`Network.webSocketCreated`）で知る（観察だけ。止めない）。
 *
 * Guard の route（Playwright の `routeWebSocket`）は、ページの `WebSocket` を模擬の物に置き換えて判定するが、ページのスクリプトは模擬を迂回して本物の接続を開ける
 * （AS-R の C-1）。Worker の中の接続は route を通らない（C-2）。どちらも、ブラウザの接続の事実はこの観察で分かるので、Safety Ledger の通した接続の記録と数は、
 * この事実から作る（Guard が route で通した接続と照らし、照らせないものに印を付ける）。
 *
 * - page の target の session（Guard の横取りの session とは別に、この観察のために開く）で `Network` を有効にし、page の文書（同じプロセスの iframe と
 *   about:blank の realm を含む）の接続を受ける。
 * - 同じ session で、子の target（別のプロセスの iframe と、専用の Worker）に自動で付き（`flatten: false`。Guard の OOPIF の session と同じ形）、子ごとに
 *   `Network` を有効にし、さらにその子にも自動で付く（入れ子の iframe と Worker）。付いた子は、命令を送った後に進める（`waitForDebuggerOnStart`。有効に
 *   する前に開いた接続を取りこぼさないため）。
 * - 付けない target（限界。`doc/spec/safety.md`）: Shared Worker と Service Worker（page の子の target でない。Service Worker の登録は Guard が塞ぐ）。
 * - 命令の失敗（target が消えた、命令を受けない種類の target）は無視する（観察の取りこぼしになるだけで、Guard の判定は変えない）。
 */
import type { CDPSession } from 'playwright';

/** 観察した接続（ブラウザが開いた WebSocket の URL）。 */
export interface ObservedWebSocket {
  readonly url: string;
}

/** 子の target の種類のうち、付くもの（別のプロセスの iframe と、専用の Worker）。 */
const OBSERVED_CHILD_TARGET_FILTER = Object.freeze([
  { type: 'iframe', exclude: false },
  { type: 'worker', exclude: false },
]);

/** 付けた子の target の session の道筋（page の session から順に、子の session の ID）。 */
type SessionPath = readonly string[];

/**
 * `session`（page の target の、観察のための CDP の session）で、ブラウザが開く WebSocket の接続の観察を始める。接続ごとに `onCreated` を呼ぶ（呼ぶ側の
 * 例外は、ここで封じ込める）。観察を付けられなければ（`Network.enable`・`Target.setAutoAttach` の失敗）、例外を投げる（呼ぶ側が、観察なしとして扱う）。
 * 返す関数は、listener を外す（session は呼ぶ側が閉じる）。
 */
export async function observeCreatedWebSockets(
  session: CDPSession,
  onCreated: (socket: ObservedWebSocket) => void,
): Promise<() => void> {
  /** 子の target に送る命令の番号（応答は待たない。番号は応答と区別するためだけ）。 */
  let commandId = 0;
  const notify = (params: unknown): void => {
    const url = (params as { readonly url?: unknown } | null)?.url;
    if (typeof url !== 'string') {
      return;
    }
    try {
      onCreated({ url });
    } catch {
      // 記録の側の失敗は、観察を止めない。
    }
  };
  /** `path` の子の target に、命令を送る（応答は待たない。失敗は無視する）。 */
  const sendToChild = (path: SessionPath, method: string, params: object = {}): void => {
    commandId += 1;
    let message = JSON.stringify({ id: commandId, method, params });
    for (let index = path.length - 1; index >= 1; index -= 1) {
      commandId += 1;
      message = JSON.stringify({ id: commandId, method: 'Target.sendMessageToTarget', params: { sessionId: path[index], message } });
    }
    const [first] = path;
    if (first === undefined) {
      return;
    }
    void session.send('Target.sendMessageToTarget', { sessionId: first, message }).catch(() => undefined);
  };
  /** `parent` の子の target に付いた。`Network` を有効にし、その子にも自動で付いてから、進める。 */
  const onAttached = (parent: SessionPath, params: unknown): void => {
    const sessionId = (params as { readonly sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== 'string') {
      return;
    }
    const path = [...parent, sessionId];
    sendToChild(path, 'Network.enable');
    sendToChild(path, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter: OBSERVED_CHILD_TARGET_FILTER });
    sendToChild(path, 'Runtime.runIfWaitingForDebugger');
  };
  /** `path` の子の target から届いた事象（応答は無視する。入れ子の子の事象は、さらに解く）。 */
  const onChildMessage = (path: SessionPath, message: unknown): void => {
    if (typeof message !== 'string') {
      return;
    }
    let parsed: { readonly method?: unknown; readonly params?: unknown };
    try {
      parsed = JSON.parse(message) as { readonly method?: unknown; readonly params?: unknown };
    } catch {
      return;
    }
    if (parsed.method === 'Network.webSocketCreated') {
      notify(parsed.params);
    } else if (parsed.method === 'Target.attachedToTarget') {
      onAttached(path, parsed.params);
    } else if (parsed.method === 'Target.receivedMessageFromTarget') {
      const nested = parsed.params as { readonly sessionId?: unknown; readonly message?: unknown } | null;
      if (typeof nested?.sessionId === 'string') {
        onChildMessage([...path, nested.sessionId], nested.message);
      }
    }
  };
  const onPageCreated = (params: unknown): void => notify(params);
  const onPageAttached = (params: unknown): void => onAttached([], params);
  const onPageMessage = (params: unknown): void => {
    const event = params as { readonly sessionId?: unknown; readonly message?: unknown } | null;
    if (typeof event?.sessionId === 'string') {
      onChildMessage([event.sessionId], event.message);
    }
  };
  session.on('Network.webSocketCreated', onPageCreated);
  session.on('Target.attachedToTarget', onPageAttached);
  session.on('Target.receivedMessageFromTarget', onPageMessage);
  const stop = (): void => {
    session.off('Network.webSocketCreated', onPageCreated);
    session.off('Target.attachedToTarget', onPageAttached);
    session.off('Target.receivedMessageFromTarget', onPageMessage);
  };
  try {
    await session.send('Network.enable');
    await session.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
      filter: [...OBSERVED_CHILD_TARGET_FILTER],
    });
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

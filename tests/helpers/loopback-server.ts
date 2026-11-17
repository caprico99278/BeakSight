import { createServer, type RequestListener, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { wait } from '../../src/core/deadline.js';

/**
 * テストの中のサーバ（127.0.0.1）の起動と、閉じたポートの Origin（CC-041、CC-043）。
 * 応答の内容（応答しない、ヘッダの後に本文を止める、503 など）と、要求の記録は、テストごとの `listener` が決める。
 * この補助は、ループバックでの待ち受けと、受けた接続の記録と、閉じるときにその接続を切ることだけを受け持つ。
 */

/** テストのサーバが待ち受けるループバックのアドレス。 */
export const LOOPBACK_HOST = '127.0.0.1';

/** `startLoopbackHttpServer` で起動した、テストの中の HTTP のサーバ。 */
export interface LoopbackHttpServer {
  /** `http://127.0.0.1:<port>`。 */
  readonly origin: string;
  readonly port: number;
  /** もとの `http.Server`（`upgrade` などの事象を足すテストのため）。 */
  readonly server: Server;
  /** 受けた接続（応答しない接続、本文を止めた接続を含む）を切ってから、サーバを閉じる。何度呼んでもよい（2 回目以降は 1 回目と同じ結果）。 */
  close(): Promise<void>;
  /**
   * TEST-TIME-B（案 9）: 受けている途中の要求（応答を終えていない要求）と、まだ要求の来ていない新しい接続が 0 になるまで待つ（`limitMs` まで。超えたら
   * 待つのをやめる。応答しない接続を残す場面のため）。遅れて届く要求の待ちは、これと短い余白（`settleLateDeliveries`）で行う。
   */
  whenIdle(limitMs?: number): Promise<void>;
}

/** TEST-TIME-B: 受けている途中の要求が 0 になるのを確かめる間隔（ms）。 */
const IDLE_POLL_INTERVAL_MS = 25;
/** TEST-TIME-B: `whenIdle` の既定の上限（ms。応答しない接続を残す場面でも、これで終える）。 */
const IDLE_LIMIT_MS = 5_000;
/** TEST-TIME-B: 受けている途中の要求が 0 になった後に足す、短い固定の余白（ms。送り手の側で送りかけの要求がサーバに届くまで）。 */
export const LATE_DELIVERY_MARGIN_MS = 200;

/**
 * TEST-TIME-B: サーバの受けている途中の要求が 0 になるまで待ち、短い余白を足す（遅れて届く要求を数え直す前の待ち）。`limitMs`（前の固定の待ち）を超えては
 * 待たない（応答を止めたままの要求がある場面でも、前より長くならない）。使うのは、ブラウザ（Context）を閉じた後の数え直しだけ（ページが開いたままなら、ページが
 * これから送る要求はサーバの側から見えないので、固定の待ちのまま）。
 */
export const settleLateDeliveries = async (
  limitMs: number,
  ...servers: readonly { readonly whenIdle: (limitMs?: number) => Promise<void> }[]
): Promise<void> => {
  const idleLimitMs = Math.max(0, limitMs - LATE_DELIVERY_MARGIN_MS);
  await Promise.all(servers.map((server) => server.whenIdle(idleLimitMs)));
  await wait(Math.min(limitMs, LATE_DELIVERY_MARGIN_MS));
};

/** `server` を 127.0.0.1 の空いたポートで待ち受けさせ、そのポートを返す。 */
async function listenOnLoopback(server: NetServer): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the loopback test server did not bind to a TCP port'));
        return;
      }
      resolvePort(address.port);
    });
  });
}

/** `startLoopbackHttpServer` の指定（DEF-099 fix: https の fixture。テストだけの自前の証明書と鍵の PEM）。 */
export interface LoopbackHttpServerOptions {
  readonly tls?: { readonly cert: string; readonly key: string } | undefined;
}

/**
 * `listener` で応答する HTTP のサーバを 127.0.0.1 の空いたポートで起動する。受けた接続を記録し、`close` で切る
 * （応答しない接続を残したままサーバを閉じると、閉じる処理が終わらないため）。`options.tls` があれば https で待つ（DEF-099 fix）。
 */
export async function startLoopbackHttpServer(listener: RequestListener, options: LoopbackHttpServerOptions = {}): Promise<LoopbackHttpServer> {
  const sockets = new Set<Socket>();
  /** TEST-TIME-B: まだ要求の来ていない新しい接続（https では TLS の握手の後に数える）。 */
  const awaitingFirstRequest = new Set<Socket>();
  let requestsInProgress = 0;
  const server = options.tls === undefined ? createServer(listener) : createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, listener);
  server.on(options.tls === undefined ? 'connection' : 'secureConnection', (socket: Socket) => {
    awaitingFirstRequest.add(socket);
    socket.once('close', () => awaitingFirstRequest.delete(socket));
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('request', (request, response) => {
    awaitingFirstRequest.delete(request.socket);
    requestsInProgress += 1;
    response.once('close', () => {
      requestsInProgress -= 1;
    });
  });
  // WebSocket などの upgrade は `request` を出さない（接続は要求を受けたものとして数えない）。
  server.on('upgrade', (request: { readonly socket: Socket }) => {
    awaitingFirstRequest.delete(request.socket);
  });
  const isIdle = (): boolean => requestsInProgress === 0 && awaitingFirstRequest.size === 0;
  const port = await listenOnLoopback(server);
  let closing: Promise<void> | undefined;
  return {
    origin: `${options.tls === undefined ? 'http' : 'https'}://${LOOPBACK_HOST}:${port}`,
    port,
    server,
    close: () => {
      closing ??= new Promise<void>((resolveClose, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      });
      return closing;
    },
    whenIdle: async (limitMs = IDLE_LIMIT_MS) => {
      const until = Date.now() + limitMs;
      while (!isIdle() && Date.now() < until) {
        await wait(IDLE_POLL_INTERVAL_MS);
      }
    },
  };
}

/** 127.0.0.1 の、いま使われていないポートの Origin（ポートを一度確保して、すぐに解放する。接続を拒否する）。 */
export async function closedLoopbackOrigin(): Promise<string> {
  const probe = createNetServer();
  const port = await listenOnLoopback(probe);
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return `http://${LOOPBACK_HOST}:${port}`;
}

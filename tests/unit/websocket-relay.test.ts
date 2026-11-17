// DEF-276-relay: 文書の WebSocket の中継の部品（`src/safety/websocket-relay.ts`）。偽の中継（CONNECT を受けてつなぐ）と偽のサーバ（`node:net`）で、握手の失敗、
// 分割と制御の frame、閉じを速く確かめる。ブラウザと出口の中継の本物の通り道は `tests/contract/pass-through-paths.test.ts`。
import { createHash } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketRelayError, openRelayedWebSocket, relayHandshakeHeadersOf, type RelayedWebSocket } from '../../src/safety/websocket-relay.js';

const HOST = '127.0.0.1';
/** 握手の上限（テストの値）。 */
const HANDSHAKE_MS = 1_000;
/** 応答しないサーバで時間切れを確かめる上限。 */
const SHORT_HANDSHAKE_MS = 100;

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});
const listen = async (server: Server): Promise<number> => {
  servers.push(server);
  server.on('connection', (socket: Socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
};

/** 偽の中継: CONNECT を受けて宛先へつなぐ（`refuse` なら 403）。 */
const startProxy = (refuse = false): Promise<number> => listen(createServer((client) => {
  client.on('error', () => undefined);
  client.once('data', (chunk: Buffer) => {
    const authority = /^CONNECT (\S+) /u.exec(chunk.toString('latin1'))?.[1] ?? '';
    if (refuse) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const [host = '', port = '0'] = authority.split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
  });
}));

const serverFrame = (opcode: number, payload: Buffer | string, fin = true): Buffer => {
  const body = Buffer.from(payload);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, body.length]), body]);
};
/** 届いた（mask した）frame を読む（小さい frame だけ）。 */
const clientFramesOf = (buffer: Buffer): { readonly opcode: number; readonly payload: Buffer }[] => {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let rest = buffer;
  while (rest.length >= 6) {
    const length = (rest[1] ?? 0) & 0x7f;
    const mask = rest.subarray(2, 6);
    frames.push({ opcode: (rest[0] ?? 0) & 0x0f, payload: Buffer.from(rest.subarray(6, 6 + length).map((byte, index) => byte ^ (mask[index % 4] ?? 0))) });
    rest = rest.subarray(6 + length);
  }
  return frames;
};

/** 偽のサーバ: 握手を受け（`reply` が null なら応答しない、文字列ならその応答）、`onOpen` に接続と届いた frame を渡す。 */
const startServer = (options: {
  readonly reply?: string | null;
  readonly onOpen?: (socket: Socket, received: () => { readonly opcode: number; readonly payload: Buffer }[]) => void;
} = {}): Promise<number> => listen(createServer((socket) => {
  socket.on('error', () => undefined);
  let head = '';
  let after = Buffer.alloc(0);
  let opened = false;
  socket.on('data', (chunk: Buffer) => {
    if (opened) {
      after = Buffer.concat([after, chunk]);
      return;
    }
    head += chunk.toString('latin1');
    if (!head.includes('\r\n\r\n')) return;
    opened = true;
    if (options.reply === null) return;
    if (options.reply !== undefined) {
      socket.write(options.reply);
      return;
    }
    const key = /Sec-WebSocket-Key: (\S+)/u.exec(head)?.[1] ?? '';
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    options.onOpen?.(socket, () => clientFramesOf(after));
  });
}));

/** 送りの列の上限（テストの値。上限を確かめる場面と、ほかの場面）。 */
const SMALL_SEND_QUEUE_BYTES = 1_024;
const LARGE_SEND_QUEUE_BYTES = 1_048_576;
const open = async (
  serverPort: number,
  proxyPort: number,
  handshakeTimeoutMs = HANDSHAKE_MS,
  extra: { readonly headers?: Readonly<Record<string, string>>; readonly maxSendQueueBytes?: number } = {},
): Promise<RelayedWebSocket> => openRelayedWebSocket({
  url: `ws://${HOST}:${serverPort}/socket`, proxy: { host: HOST, port: proxyPort }, headers: extra.headers ?? {}, protocols: [], handshakeTimeoutMs,
  maxSendQueueBytes: extra.maxSendQueueBytes ?? LARGE_SEND_QUEUE_BYTES,
});
const reasonOf = (promise: Promise<unknown>): Promise<string> => promise.then(() => 'OPENED', (error: unknown) => (error instanceof WebSocketRelayError ? error.reason : 'OTHER'));

describe('DEF-276-relay: the WebSocket relay over the egress proxy', () => {
  it('fails the handshake when the proxy refuses, the server does not upgrade, or the server does not answer in time', async () => {
    const server = await startServer();
    expect(await reasonOf(open(server, await startProxy(true)))).toBe('PROXY_REJECTED');
    const proxy = await startProxy();
    expect(await reasonOf(open(await startServer({ reply: 'HTTP/1.1 400 Bad Request\r\n\r\n' }), proxy))).toBe('HANDSHAKE_REJECTED');
    expect(await reasonOf(open(await startServer({ reply: null }), proxy, SHORT_HANDSHAKE_MS))).toBe('TIMED_OUT');
  });

  it('joins a fragmented text around a ping, answers the ping, and sends masked frames', async () => {
    let received: () => { readonly opcode: number; readonly payload: Buffer }[] = () => [];
    const server = await startServer({
      onOpen: (socket, frames) => {
        received = frames;
        socket.write(Buffer.concat([serverFrame(0x1, 'he', false), serverFrame(0x9, 'p'), serverFrame(0x0, 'llo')]));
      },
    });
    const relayed = await open(server, await startProxy());
    const message = await new Promise<string | Buffer>((resolve) => relayed.onMessage(resolve));
    relayed.send('x');
    await expect.poll(() => received().map(({ opcode, payload }) => `${opcode}:${payload.toString()}`)).toEqual(['10:p', '1:x']);
    expect(message).toBe('hello');
    relayed.destroy();
  });

  // REV-DEF276 の I-1: 握手の Origin と Cookie はブラウザに近づける。サブドメインの WebSocket にも、main frame の host に当たる Domain の Lax・Strict の Cookie を
  // 送る。別 Origin の iframe は数えず、宛先がその iframe とだけ同じ site のときに、その Origin にする（ブラウザの Chromium では DNS の名前を作れないので単体で確かめる）。
  it('builds the Origin and the Cookie of the handshake like the browser', () => {
    // `cookies` は、宛先の URL で読んだ組（`context.cookies(url)` の形）。
    const subdomain = relayHandshakeHeadersOf({
      url: 'wss://ws.app.test/socket', mainFrameOrigins: ['https://www.app.test'], frameOrigins: ['https://ads.other.test'], userAgent: 'UA',
      cookies: [
        { name: 'lax', value: 'L', domain: '.app.test', sameSite: 'Lax' },
        { name: 'strict', value: 'S', domain: '.app.test', sameSite: 'Strict' },
        { name: 'hostonly', value: 'H', domain: 'ws.app.test', sameSite: 'Lax' },
        { name: 'none', value: 'N', domain: 'ws.app.test', sameSite: 'None' },
      ],
    });
    // host だけの Cookie（ws.app.test）は main frame の host に当たらないので Lax は送らず、None は送る。
    expect(subdomain).toEqual({ Origin: 'https://www.app.test', Cookie: 'lax=L; strict=S; none=N', 'User-Agent': 'UA' });
    const framed = relayHandshakeHeadersOf({
      url: 'wss://chat.widget.test/socket', mainFrameOrigins: ['https://www.app.test'], frameOrigins: ['https://www.widget.test'], userAgent: 'UA',
      cookies: [{ name: 'wlax', value: 'L', domain: '.widget.test', sameSite: 'Lax' }, { name: 'wnone', value: 'N', domain: '.widget.test', sameSite: 'None' }],
    });
    expect(framed).toEqual({ Origin: 'https://www.widget.test', Cookie: 'wnone=N', 'User-Agent': 'UA' });
    const undecided = relayHandshakeHeadersOf({
      url: 'wss://chat.widget.test/socket', mainFrameOrigins: ['https://www.app.test'], frameOrigins: ['https://a.widget.test', 'https://b.widget.test'], cookies: [], userAgent: 'UA',
    });
    expect(undecided).toEqual({ Cookie: '', 'User-Agent': 'UA' });
  });

  // REV-DEF276 の M-1: CR・LF・NUL を含むヘッダは、送る前に拒む（握手の要求に差し込ませない）。
  it('refuses a header that carries CR, LF or NUL before connecting', async () => {
    const proxy = await startProxy();
    const server = await startServer();
    for (const headers of [{ 'User-Agent': 'a\r\nX-Injected: 1' }, { 'X-Bad\nName': 'v' }, { Cookie: 'a=b\0' }]) {
      expect(await reasonOf(open(server, proxy, HANDSHAKE_MS, { headers })), JSON.stringify(headers)).toBe('HEADER_INVALID');
    }
  });

  // REV-DEF276 の M-2: 送りの列が上限を超えたら、閉じて知らせる（code 1009、原因 `SEND_QUEUE_FULL`）。
  it('closes when the send queue would exceed its limit', async () => {
    const relayed = await open(await startServer(), await startProxy(), HANDSHAKE_MS, { maxSendQueueBytes: SMALL_SEND_QUEUE_BYTES });
    const closed = new Promise((resolve) => relayed.onClose((code, _reason, cause) => resolve(`${code} ${cause}`)));
    relayed.send('x'.repeat(SMALL_SEND_QUEUE_BYTES * 2));
    expect(await closed).toBe('1009 SEND_QUEUE_FULL');
  });

  it('closes with the code of the server, and sends the code of the page when the page closes', async () => {
    const fromServer = await startServer({ onOpen: (socket) => socket.write(serverFrame(0x8, Buffer.concat([Buffer.from([0x0f, 0xa1]), Buffer.from('bye')]))) });
    const proxy = await startProxy();
    const closedByServer = await open(fromServer, proxy);
    expect(await new Promise((resolve) => closedByServer.onClose((code, reason) => resolve(`${code} ${reason}`)))).toBe('4001 bye');

    let received: () => { readonly opcode: number; readonly payload: Buffer }[] = () => [];
    const quiet = await startServer({ onOpen: (_socket, frames) => { received = frames; } });
    const closedByPage = await open(quiet, proxy);
    const closed = new Promise((resolve) => closedByPage.onClose((code) => resolve(code)));
    closedByPage.close(3001, 'done');
    await expect.poll(() => received().map(({ opcode, payload }) => `${opcode}:${payload.readUInt16BE(0)}`)).toEqual(['8:3001']);
    closedByPage.destroy();
    expect(await closed).toBe(1006);
  });
});

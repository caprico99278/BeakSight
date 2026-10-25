import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { LOOPBACK_HOST } from './loopback-server.js';

/**
 * DEF-124: WebRTC の STUN・TURN・ICE の宛先にする、127.0.0.1 の UDP と TCP の受け口（テストの中だけ）。届いたものを数える。
 * TURN の Allocate（UDP・TCP）には、401 と REALM・NONCE で答える（次の Allocate が USERNAME を運ぶので、`username` がそのままの形で届くかを
 * 確かめられる）。STUN の Binding には答えない（届いたかだけを数える）。
 */
export interface WebRtcLeakListeners {
  readonly udpPort: number;
  readonly tcpPort: number;
  /** UDP の受け口に届いたパケットの数。 */
  udpPackets(): number;
  /** TCP の受け口が受けた接続の数。 */
  tcpConnections(): number;
  /** 届いたもの（UDP のパケットと TCP の受けたデータの塊）のうち、`value`（UTF-8）をそのまま含むものの数。 */
  carrying(value: string): number;
  close(): Promise<void>;
}

/** STUN の magic cookie（RFC 5389）。 */
const STUN_MAGIC_COOKIE = 0x2112a442;
/** TURN の Allocate の要求と、その誤りの応答の型（RFC 5766）。 */
const TURN_ALLOCATE_REQUEST = 0x0003;
const TURN_ALLOCATE_ERROR_RESPONSE = 0x0113;
/** STUN の属性の型（ERROR-CODE、REALM、NONCE）。 */
const STUN_ATTRIBUTE_ERROR_CODE = 0x0009;
const STUN_ATTRIBUTE_REALM = 0x0014;
const STUN_ATTRIBUTE_NONCE = 0x0015;
const STUN_HEADER_BYTES = 20;

const stunAttribute = (type: number, value: Buffer): Buffer => {
  const padding = (4 - (value.length % 4)) % 4;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc(padding)]);
};

/** TURN の Allocate なら、401 の誤りの応答（REALM・NONCE つき）を返す。ほかは `null`。 */
const turnUnauthorizedReply = (message: Buffer): Buffer | null => {
  if (message.length < STUN_HEADER_BYTES || message.readUInt16BE(0) !== TURN_ALLOCATE_REQUEST
    || message.readUInt32BE(4) !== STUN_MAGIC_COOKIE) {
    return null;
  }
  const attributes = Buffer.concat([
    stunAttribute(STUN_ATTRIBUTE_ERROR_CODE, Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from('Unauthorized')])),
    stunAttribute(STUN_ATTRIBUTE_REALM, Buffer.from('example.test')),
    stunAttribute(STUN_ATTRIBUTE_NONCE, Buffer.from('def124nonce')),
  ]);
  const header = Buffer.alloc(STUN_HEADER_BYTES);
  header.writeUInt16BE(TURN_ALLOCATE_ERROR_RESPONSE, 0);
  header.writeUInt16BE(attributes.length, 2);
  message.copy(header, 4, 4, STUN_HEADER_BYTES);
  return Buffer.concat([header, attributes]);
};

export async function startWebRtcLeakListeners(): Promise<WebRtcLeakListeners> {
  const received: Buffer[] = [];
  let udpPackets = 0;
  let tcpConnections = 0;
  const udp: UdpSocket = createSocket('udp4');
  udp.on('error', () => undefined);
  udp.on('message', (message, remote) => {
    udpPackets += 1;
    received.push(message);
    const reply = turnUnauthorizedReply(message);
    if (reply !== null) {
      udp.send(reply, remote.port, remote.address);
    }
  });
  await new Promise<void>((resolve) => udp.bind(0, LOOPBACK_HOST, () => resolve()));
  const sockets = new Set<Socket>();
  const tcp: NetServer = createNetServer((socket) => {
    tcpConnections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (data: Buffer) => {
      received.push(data);
      const reply = turnUnauthorizedReply(data);
      if (reply !== null) {
        socket.write(reply);
      }
    });
  });
  await new Promise<void>((resolve) => tcp.listen({ host: LOOPBACK_HOST, port: 0 }, () => resolve()));
  const tcpAddress = tcp.address();
  if (tcpAddress === null || typeof tcpAddress === 'string') {
    throw new Error('the WebRTC TCP listener did not bind to a TCP port');
  }
  let closing: Promise<void> | undefined;
  return {
    udpPort: udp.address().port,
    tcpPort: tcpAddress.port,
    udpPackets: () => udpPackets,
    tcpConnections: () => tcpConnections,
    carrying: (value) => received.filter((chunk) => chunk.includes(Buffer.from(value, 'utf8'))).length,
    close: () => {
      closing ??= (async () => {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => tcp.close(() => resolve()));
        await new Promise<void>((resolve) => udp.close(() => resolve()));
      })();
      return closing;
    },
  };
}

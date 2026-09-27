/**
 * @fileoverview Canary listeners for the gated browser suite: a TCP server and a UDP
 * socket, both bound to 127.0.0.1 only. Pages under test aim requests, WebSockets, and
 * WebRTC STUN/TURN at them; an isolated page reaches neither, so any hit is a leak.
 * `startCanaries()` proves both record traffic before it returns, so an empty `hits` is
 * a real "nothing arrived", not a listener that could not have heard it.
 * @module tests/browser/helpers/canaries
 */

import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { type AddressInfo, connect, createServer, type Server } from 'node:net';

const LOOPBACK = '127.0.0.1';

export interface Canaries {
  /** Stop both listeners. */
  close(): Promise<void>;
  /** What reached the canaries since they started, e.g. `tcp 127.0.0.1:53211`. */
  readonly hits: string[];
  readonly tcpPort: number;
  readonly udpPort: number;
}

/** Start both canaries on 127.0.0.1, check each records traffic, and clear the check's hits. */
export async function startCanaries(): Promise<Canaries> {
  const hits: string[] = [];
  const tcp: Server = createServer((socket) => {
    hits.push(`tcp ${socket.remoteAddress}:${socket.remotePort}`);
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    tcp.once('error', reject);
    tcp.listen(0, LOOPBACK, resolve);
  });
  const udp: UdpSocket = createSocket('udp4');
  udp.on('message', (message, from) => {
    hits.push(`udp ${from.address}:${from.port} ${message.byteLength} bytes`);
  });
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, LOOPBACK, resolve);
  });
  const canaries: Canaries = {
    hits,
    tcpPort: (tcp.address() as AddressInfo).port,
    udpPort: udp.address().port,
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => tcp.close(() => resolve())),
        new Promise<void>((resolve) => udp.close(resolve)),
      ]);
    },
  };
  await selfCheck(canaries);
  return canaries;
}

async function selfCheck(canaries: Canaries): Promise<void> {
  const client = createSocket('udp4');
  await new Promise<void>((resolve, reject) =>
    client.send('check', canaries.udpPort, LOOPBACK, (err) => (err ? reject(err) : resolve())),
  );
  client.close();
  await new Promise<void>((resolve, reject) => {
    const socket = connect(canaries.tcpPort, LOOPBACK, () => socket.end());
    socket.on('close', () => resolve());
    socket.on('error', reject);
  });
  const deadline = Date.now() + 2_000;
  while (canaries.hits.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const heard = canaries.hits.splice(0);
  if (!heard.some((h) => h.startsWith('tcp ')) || !heard.some((h) => h.startsWith('udp '))) {
    await canaries.close();
    throw new Error(
      `The canaries did not record their own check traffic: ${JSON.stringify(heard)}`,
    );
  }
}

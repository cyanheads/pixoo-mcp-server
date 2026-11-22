/**
 * @fileoverview A loopback port nothing listens on, for a test that must hand a real
 * `listen` a fixed port: a fixed number fails whenever anything else on the machine,
 * or another Vitest worker, already holds it.
 * @module tests/helpers/free-port
 */

import { type AddressInfo, createServer } from 'node:net';

/**
 * A port on 127.0.0.1 that was free when probed. The probe releases it before
 * returning, so another process can still take it before the caller binds it.
 */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

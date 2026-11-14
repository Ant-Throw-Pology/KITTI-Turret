import { test, expect } from 'bun:test';
import { createServer, createConnection } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { PacketDecoder, PacketType, FrameWindow, encodePacket } from '../src/ipc';

const socketTest = process.env.KITTI_TEST_SOCKET === '1' ? test : test.skip;
socketTest('Unix socket frame ACK flow stays bounded under burst load', async () => {
  const path = `${process.cwd()}/kitti-soak-${process.pid}-${Date.now()}.sock`;
  const count = 5000;
  const server = createServer(socket => {
    const decoder = new PacketDecoder();
    socket.on('data', bytes => {
      if (typeof bytes === 'string') throw new Error('binary socket emitted text');
      for (const packet of decoder.push(bytes)) {
        if (packet.type !== PacketType.Frame) throw new Error('unexpected packet');
        socket.write(encodePacket(PacketType.Ack, packet.payload.slice(0, 4)));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const client = createConnection(path);
  await new Promise<void>(resolve => client.once('connect', resolve));
  const decoder = new PacketDecoder();
  const window = new FrameWindow();
  let acked = 0;
  let maxInFlight = 0;
  let lastSeq = -1;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('soak timed out')), 10000);
    client.on('data', bytes => {
      if (typeof bytes === 'string') throw new Error('binary socket emitted text');
      for (const packet of decoder.push(bytes)) {
        if (packet.type !== PacketType.Ack) reject(new Error('unexpected ACK type'));
        const seq = new DataView(packet.payload.buffer, packet.payload.byteOffset).getUint32(0, true);
        lastSeq = seq;
        acked++;
        window.ack(seq);
        window.flush(data => client.write(data));
        maxInFlight = Math.max(maxInFlight, window.inFlight);
        if (seq === count - 1) { clearTimeout(timer); resolve(); }
      }
    });
    client.once('error', reject);
  });
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  for (let seq = 0; seq < count; seq++) {
    const payload = new Uint8Array(1024);
    new DataView(payload.buffer).setUint32(0, seq, true);
    window.offer(seq, encodePacket(PacketType.Frame, payload));
    window.flush(data => client.write(data));
    maxInFlight = Math.max(maxInFlight, window.inFlight);
  }
  await done;
  const elapsedMs = performance.now() - started;
  const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / 1024 / 1024;
  client.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (existsSync(path)) unlinkSync(path);
  expect(lastSeq).toBe(count - 1);
  expect(maxInFlight).toBeLessThanOrEqual(2);
  expect(window.inFlight).toBe(0);
  expect(window.dropped).toBeGreaterThan(0);
  console.log(JSON.stringify({ offered: count, acked, dropped: window.dropped, maxInFlight, elapsedMs: Math.round(elapsedMs), rssDeltaMb: Math.round(rssDeltaMb * 10) / 10 }));
}, 12000);

test('ACK window remains bounded for 100,000 offered frames', () => {
  const window = new FrameWindow();
  let maxInFlight = 0;
  let newest = -1;
  const started = performance.now();
  for (let i = 0; i < 100_000; i++) {
    window.offer(i, new Uint8Array([i & 255]));
    window.flush(() => {});
    maxInFlight = Math.max(maxInFlight, window.inFlight);
    if (i % 11 === 0 && i > 0) {
      window.ack(newest);
      newest = i;
      window.flush(() => {});
    }
  }
  expect(maxInFlight).toBeLessThanOrEqual(2);
  expect(window.dropped).toBeGreaterThan(90_000);
  console.log(JSON.stringify({offered:100_000,dropped:window.dropped,maxInFlight,elapsedMs:Math.round(performance.now()-started)}));
});

import { expect, test } from 'bun:test';
import { createConnection, createServer, type Socket } from 'node:net';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PacketDecoder, PacketType, encodePacket } from '../src/ipc';

const root = join(import.meta.dir, '..');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function until<T>(read: () => T | undefined | false, label: string, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

class FakeWorker {
  readonly controls: any[] = [];
  closed = false;
  private decoder = new PacketDecoder();
  private constructor(readonly socket: Socket) {
    socket.on('close', () => { this.closed = true; });
    socket.on('data', (bytes: Buffer | string) => {
      if (typeof bytes === 'string') throw new Error('binary worker socket emitted text');
      for (const packet of this.decoder.push(bytes)) {
        if (packet.type === PacketType.Control) this.controls.push(JSON.parse(new TextDecoder().decode(packet.payload)));
      }
    });
  }
  static async connect(path: string): Promise<FakeWorker> {
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new FakeWorker(socket);
  }
  classes(): number[] | undefined {
    for (let i = this.controls.length - 1; i >= 0; i--) {
      const control = this.controls[i]!;
      if (control.type === 'classes' && Array.isArray(control.ids)) return control.ids;
    }
    return undefined;
  }
  detection(payload: unknown): void {
    this.socket.write(encodePacket(PacketType.Detection, new TextEncoder().encode(JSON.stringify(payload))));
  }
  close(): void { this.socket.destroy(); }
}

function openSocket(url: string): Promise<{ socket: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const socket = new WebSocket(url);
    socket.onmessage = event => { try { messages.push(JSON.parse(String(event.data))); } catch { /* ignore */ } };
    socket.onopen = () => resolve({ socket, messages });
    socket.onerror = () => reject(new Error('websocket error'));
  });
}

test('fake worker reconnects with class config and tracking drives mock motors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitti-integration-'));
  const socketPath = join(dir, 'turret.sock');
  const port = await freePort();
  const env = {
    ...process.env,
    KITTI_MOCK: '1',
    KITTI_HOST: '127.0.0.1',
    KITTI_PORT: String(port),
    KITTI_SOCKET: socketPath,
    KITTI_YAW_NEGATIVE_SWITCH: 'GPIO1_B6',
    KITTI_EXTERNAL_WORKER: '1',
    KITTI_MODEL: '',
  };
  const server = Bun.spawn([process.execPath, join(root, 'src', 'index.ts')], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  let worker: FakeWorker | undefined;
  let secondWorker: FakeWorker | undefined;
  let ws: WebSocket | undefined;
  try {
    let url = '';
    const reader = server.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!url) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server exited before listening: ${output}`);
      output += decoder.decode(value, { stream: true });
      const match = /KITTI (http:\/\/\S+)/.exec(output);
      if (match) url = match[1]!;
    }
    reader.releaseLock();

    worker = await FakeWorker.connect(socketPath);
    expect(await until(() => worker!.classes(), 'initial class config')).toEqual([0, 15, 16]);

    const wsUrl = new URL('/ws', url);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const client = await openSocket(wsUrl.href);
    ws = client.socket;
    expect(await until(() => client.messages.find(m => m.type === 'classState'), 'classState')).toBeTruthy();
    expect(await until(() => client.messages.find(m => m.type === 'workerState' && m.connected), 'workerState')).toBeTruthy();

    ws.send(JSON.stringify({ type: 'enable', on: true }));
    ws.send(JSON.stringify({ type: 'tracking', on: true, label: 'cat' }));
    expect(await until(() => client.messages.find(m => m.type === 'motorState' && m.enabled), 'motors enabled')).toBeTruthy();
    expect(await until(() => client.messages.find(m => m.type === 'trackingState' && m.enabled), 'tracking enabled')).toBeTruthy();

    ws.send(JSON.stringify({ type: 'classes', ids: [3, 2, 3] }));
    expect(await until(() => worker!.classes()?.join(',') === '2,3' ? worker!.classes() : undefined, 'class update')).toEqual([2, 3]);

    worker.detection({
      sequence: 1,
      timestamp: Date.now(),
      width: 640,
      height: 480,
      boxes: [{ label: 'cat', confidence: 0.9, x: 400, y: 210, width: 80, height: 60 }],
    });
    const moving = await until(() => client.messages.find(m => m.type === 'trackingState' && m.active && m.yaw > 0), 'tracking motion');
    expect(moving.paused).toBeNull();
    expect(moving.speedPct).toBeGreaterThan(0);

    worker.close();
    worker = undefined;
    expect(await until(() => client.messages.find(m => m.type === 'workerState' && m.connected === false), 'worker disconnect')).toBeTruthy();

    secondWorker = await FakeWorker.connect(socketPath);
    expect(await until(() => secondWorker!.classes(), 'class config after reconnect')).toEqual([2, 3]);

    ws.send(JSON.stringify({ type: 'estop' }));
    expect(await until(() => client.messages.find(m => m.type === 'motorState' && m.error === 'E-stop'), 'estop acknowledgement')).toBeTruthy();
    expect(await until(() => secondWorker!.closed, 'estop worker teardown')).toBe(true);

    const contender = Bun.spawn([process.execPath, join(root, 'src', 'index.ts')], {
      cwd: root,
      env: { ...env, KITTI_PORT: String(await freePort()) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const code = await Promise.race([contender.exited, Bun.sleep(5_000).then(() => -1)]);
    if (code === -1) contender.kill('SIGKILL');
    expect(code).toBe(1);
    const stderr = await new Response(contender.stderr).text();
    expect(stderr).toContain('live IPC socket');
    expect(existsSync(socketPath)).toBe(true);
  } finally {
    try { ws?.close(); } catch { /* already closed */ }
    worker?.close();
    secondWorker?.close();
    server.kill('SIGTERM');
    const exited = await Promise.race([server.exited, Bun.sleep(4_000).then(() => -1)]);
    if (exited === -1) server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('an existing live Unix socket is never unlinked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitti-live-'));
  const socketPath = join(dir, 'live.sock');
  const owner = createServer(() => { /* live listener */ });
  await new Promise<void>(resolve => owner.listen(socketPath, resolve));
  const port = await freePort();
  const contender = Bun.spawn([process.execPath, join(root, 'src', 'index.ts')], {
    cwd: root,
    env: { ...process.env, KITTI_MOCK: '1', KITTI_HOST: '127.0.0.1', KITTI_PORT: String(port), KITTI_SOCKET: socketPath, KITTI_EXTERNAL_WORKER: '1', KITTI_MODEL: '' },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const code = await Promise.race([contender.exited, Bun.sleep(5_000).then(() => -1)]);
    if (code === -1) contender.kill('SIGKILL');
    expect(code).toBe(1);
    expect(await new Response(contender.stderr).text()).toContain('live IPC socket');
    expect(existsSync(socketPath)).toBe(true);
    expect(statSync(socketPath).isSocket()).toBe(true);
  } finally {
    await new Promise<void>(resolve => owner.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

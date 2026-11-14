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

test('HTML import serves frontend assets with no CDN/import map, and there is no MJPEG route', async () => {
  // Build first so Bun hashes/references are present
  const buildResult = Bun.spawnSync(['bun', 'run', 'build'], { cwd: root, stderr: 'pipe' });
  expect(buildResult.exitCode).toBe(0);

  const dir = mkdtempSync(join(tmpdir(), 'kitti-html-'));
  const socketPath = join(dir, 'turret.sock');
  const port = await freePort();
  const env = {
    ...process.env,
    KITTI_MOCK: '1',
    KITTI_HOST: '127.0.0.1',
    KITTI_PORT: String(port),
    KITTI_SOCKET: socketPath,
    KITTI_EXTERNAL_WORKER: '1',
    KITTI_MODEL: '',
  };
  const server = Bun.spawn([process.execPath, join(root, 'dist', 'index.js')], {
    cwd: join(root, 'dist'), env, stdout: 'pipe', stderr: 'pipe',
  });
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

    // GET /
    const indexRes = await fetch(url);
    expect(indexRes.status).toBe(200);
    const html = await indexRes.text();

    // Assert no import map or CDN references
    expect(html).not.toMatch(/importmap/i);
    expect(html).not.toMatch(/https?:\/\//);

    // Parse every local script/stylesheet URL from the returned HTML
    const srcPattern = /<script[^>]+src=["']([^"']+)["']/g;
    const linkPattern = /<link[^>]+href=["']([^"']+)["']/g;
    const urls: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = srcPattern.exec(html)) !== null) urls.push(new URL(m[1]!, url).href);
    while ((m = linkPattern.exec(html)) !== null) urls.push(new URL(m[1]!, url).href);
    for (const assetUrl of urls) {
      const res = await fetch(assetUrl);
      expect(res.status).toBe(200);
    }

    // WebSocket ping/pong on /ws
    const wsUrl = new URL('/ws', url);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const client = await openSocket(wsUrl.href);
    ws = client.socket;
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await until(() => client.messages.find(m => m.type === 'pong'), 'pong');
    expect(pong).toBeTruthy();
    ws.close();
    ws = undefined;

    // Assert /mjpeg returns 404
    const mjpegRes = await fetch(new URL('/mjpeg', url).href);
    expect(mjpegRes.status).toBe(404);
  } finally {
    ws?.close();
    server.kill('SIGTERM');
    const exited = await Promise.race([server.exited, Bun.sleep(4_000).then(() => -1)]);
    if (exited === -1) server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

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

test('viewer disconnect fail-safe stops motors and leaves observer + worker intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitti-failsafe-'));
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
  let controllerWs: WebSocket | undefined;
  let observerWs: WebSocket | undefined;
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
    await until(() => worker!.classes(), 'initial class config');

    const wsUrl = new URL('/ws', url);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const controller = await openSocket(wsUrl.href);
    controllerWs = controller.socket;
    await until(() => controller.messages.find(m => m.type === 'classState'), 'controller classState');
    await until(() => controller.messages.find(m => m.type === 'workerState' && m.connected), 'controller workerState');

    const observer = await openSocket(wsUrl.href);
    observerWs = observer.socket;
    await until(() => observer.messages.find(m => m.type === 'classState'), 'observer classState');

    // Controller enables motors
    controllerWs.send(JSON.stringify({ type: 'enable', on: true }));
    const motorEnabled = await until(() => controller.messages.find(m => m.type === 'motorState' && m.enabled), 'motors enabled');
    expect(motorEnabled.enabled).toBe(true);

    // Use an explicit Manual motor command instead of relying on tracking-driven STEP edges
    controllerWs.send(JSON.stringify({ type: 'motor', axis: 'pitch', dir: 1, on: true }));
    const motorMoving = await until(() => controller.messages.find(m => m.type === 'motorState' && m.moving), 'motor moving');
    expect(motorMoving.enabled).toBe(true);
    expect(motorMoving.moving).toBe(true);

    // Record observer message length immediately before closing controller
    const beforeClose = observer.messages.length;

    // ---- controller disconnects ----
    controllerWs.close();
    controllerWs = undefined;

    // Wait for the close handler + safeStop broadcasts to go through
    await Bun.sleep(200);

    // After close, require NEW observer messages after beforeClose:
    // motorState enabled:false/moving:false
    const motorDisabled = await until(() => {
      const msg = observer.messages.slice(beforeClose).find(m => m.type === 'motorState' && m.enabled === false && m.moving === false);
      return msg;
    }, 'observer motorState disabled after controller disconnect', 2_000);
    expect(motorDisabled).toBeTruthy();

    // trackingState enabled:false/active:false
    const trackingDisabled = await until(() => {
      const msg = observer.messages.slice(beforeClose).find(m => m.type === 'trackingState' && m.enabled === false && m.active === false);
      return msg;
    }, 'observer trackingState disabled after controller disconnect', 2_000);
    expect(trackingDisabled).toBeTruthy();

    // Observer is still connected and receives messages
    observerWs.send(JSON.stringify({ type: 'ping' }));
    const pong = await until(() => {
      const msg = observer.messages.slice(beforeClose).find(m => m.type === 'pong');
      return msg;
    }, 'observer pong after controller disconnect');
    expect(pong).toBeTruthy();

    // Worker (FakeWorker) is NOT destroyed by safeStop (only estop does that)
    expect(worker!.closed).toBe(false);

    // Observer can re-enable motors — match only messages after a new index
    const beforeReEnable = observer.messages.length;
    observerWs.send(JSON.stringify({ type: 'enable', on: true }));
    const motorReEnabled = await until(() => {
      const msg = observer.messages.slice(beforeReEnable).find(m => m.type === 'motorState' && m.enabled);
      return msg;
    }, 'observer re-enables motors');
    expect(motorReEnabled.enabled).toBe(true);

    // Worker still receives class updates
    observerWs.send(JSON.stringify({ type: 'classes', ids: [3, 2] }));
    expect(await until(() => worker!.classes()?.join(',') === '2,3' ? worker!.classes() : undefined, 'class update after controller disconnect')).toEqual([2, 3]);
  } finally {
    controllerWs?.close();
    observerWs?.close();
    worker?.close();
    server.kill('SIGTERM');
    const exited = await Promise.race([server.exited, Bun.sleep(4_000).then(() => -1)]);
    if (exited === -1) server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('control-link watchdog closes silent client after PING_TIMEOUT_MS and triggers safeStop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitti-watchdog-'));
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
    KITTI_PING_TIMEOUT_MS: '1000',
  };
  const server = Bun.spawn([process.execPath, join(root, 'src', 'index.ts')], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  let worker: FakeWorker | undefined;
  let clientSocket: WebSocket | undefined;
  let closedByServer = false;
  let closeCode = 0;
  let workerBefore: number | undefined;
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
    await until(() => worker!.classes(), 'initial class config');

    const wsUrl = new URL('/ws', url);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const client = await openSocket(wsUrl.href);
    clientSocket = client.socket;
    client.socket.onclose = (event: CloseEvent) => {
      closedByServer = true;
      closeCode = event.code;
    };
    await until(() => client.messages.find(m => m.type === 'classState'), 'initial classState');
    await until(() => client.messages.find(m => m.type === 'workerState' && m.connected), 'workerState');

    // Enable motors
    client.socket.send(JSON.stringify({ type: 'enable', on: true }));
    await until(() => client.messages.find(m => m.type === 'motorState' && m.enabled), 'motors enabled');

    // Record message count before silent period
    const beforeSilent = client.messages.length;
    workerBefore = client.messages.length;

    // Now go silent — stop sending messages
    // Watchdog interval = max(250, min(5000, 1000/2)) = 500 ms
    await until(() => closedByServer, 'watchdog closes silent client', 6_000);

    expect(closeCode).toBe(4001);

    // Check for motorState disabled/tracking-off in messages received before close
    // (safeStop broadcasts before close, so these should be observable)
    const msgs = client.messages.slice(beforeSilent);
    const motorOff = msgs.find(m => m.type === 'motorState' && m.enabled === false && m.moving === false);
    expect(motorOff).toBeTruthy();
    const trackOff = msgs.find(m => m.type === 'trackingState' && m.enabled === false);
    expect(trackOff).toBeTruthy();

    // Worker remains intact (safeStop does not destroy the worker)
    expect(worker!.closed).toBe(false);
  } finally {
    clientSocket?.close();
    worker?.close();
    server.kill('SIGTERM');
    const exited = await Promise.race([server.exited, Bun.sleep(4_000).then(() => -1)]);
    if (exited === -1) server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('Origin validation rejects cross-origin requests on /ws and /estop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitti-origin-'));
  const socketPath = join(dir, 'turret.sock');
  const port = await freePort();
  const env = {
    ...process.env,
    KITTI_MOCK: '1',
    KITTI_HOST: '127.0.0.1',
    KITTI_PORT: String(port),
    KITTI_SOCKET: socketPath,
    KITTI_EXTERNAL_WORKER: '1',
    KITTI_MODEL: '',
  };
  const server = Bun.spawn([process.execPath, join(root, 'dist', 'index.js')], {
    cwd: join(root, 'dist'), env, stdout: 'pipe', stderr: 'pipe',
  });
  try {
    let url = '';
    const reader = server.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!url) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server exited: ${output}`);
      output += decoder.decode(value, { stream: true });
      const match = /KITTI (http:\/\/\S+)/.exec(output);
      if (match) url = match[1]!;
    }
    reader.releaseLock();

    // /estop POST with no Origin header (non-browser client) — allowed
    let res = await fetch(new URL('/estop', url), { method: 'POST' });
    expect(res.status).toBe(200);

    // /estop POST with matching same-origin — allowed
    res = await fetch(new URL('/estop', url), { method: 'POST', headers: { Origin: url } });
    expect(res.status).toBe(200);

    // /estop POST with cross-origin — rejected 403
    res = await fetch(new URL('/estop', url), { method: 'POST', headers: { Origin: 'http://evil.com' } });
    expect(res.status).toBe(403);

    // /ws upgrade with cross-origin — rejected 403
    res = await fetch(new URL('/ws', url), { headers: { Origin: 'http://evil.com' } });
    expect(res.status).toBe(403);

    // /ws upgrade with no Origin header — upgrade proceeds (400 = no WebSocket key, not 403)
    res = await fetch(new URL('/ws', url));
    expect(res.status).toBe(400);
  } finally {
    server.kill('SIGTERM');
    const exited = await Promise.race([server.exited, Bun.sleep(4_000).then(() => -1)]);
    if (exited === -1) server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

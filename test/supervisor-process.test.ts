import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSupervisor } from '../src/supervisor';

async function until(read: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('watchdog kills the detached worker process group, including its child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitti-supervisor-'));
  const marker = join(dir, 'grandchild.pid');
  const script = join(dir, 'fake-worker.ts');
  await Bun.write(script, [
    `const child = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });`,
    `await Bun.write(${JSON.stringify(marker)}, String(child.pid));`,
    `setInterval(() => {}, 1_000);`,
  ].join('\n'));

  const supervisor = new WorkerSupervisor({
    startupMs: 5_000,
    watchdogMs: 200,
    checkMs: 20,
    restartMs: 60_000,
    spawn: () => Bun.spawn([process.execPath, script], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }),
  });
  try {
    supervisor.start();
    await until(() => existsSync(marker), 'spawned worker');
    const grandchild = Number(readFileSync(marker, 'utf8'));
    expect(() => process.kill(grandchild, 0)).not.toThrow();

    supervisor.noteFrame();
    await until(() => {
      try { process.kill(grandchild, 0); return false; }
      catch { return true; }
    }, 'process group termination', 4_000);
    expect(() => process.kill(grandchild, 0)).toThrow();
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

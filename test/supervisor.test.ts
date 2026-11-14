import { expect, test } from 'bun:test';
import { WorkerSupervisor, type ManagedProcess } from '../src/supervisor';

class FakeProcess implements ManagedProcess {
  private resolve!: (code: number) => void;
  readonly exited = new Promise<number>(resolve => { this.resolve = resolve; });
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  constructor(readonly pid: number) {}
  kill(signal?: NodeJS.Signals | number): void { this.signals.push(signal); }
  exit(code = 0): void { this.resolve(code); }
}

function harness(overrides: Partial<ConstructorParameters<typeof WorkerSupervisor>[0]> = {}) {
  let now = 0;
  const children: FakeProcess[] = [];
  const groupSignals: [number, NodeJS.Signals][] = [];
  const supervisor = new WorkerSupervisor({
    now: () => now,
    checkMs: 2,
    watchdogMs: 10,
    startupMs: 10,
    restartMs: 2,
    termMs: 20,
    stopMs: 50,
    spawn: () => { const child = new FakeProcess(100 + children.length); children.push(child); return child; },
    killGroup: (pid, signal) => { groupSignals.push([pid, signal]); },
    ...overrides,
  });
  return { supervisor, children, groupSignals, tick: (value: number) => { now = value; } };
}

test('watchdog sends one TERM then escalates to KILL before restarting', async () => {
  const { supervisor, children, groupSignals, tick } = harness();
  supervisor.start();
  expect(supervisor.pid).toBe(100);
  tick(11);
  await Bun.sleep(5);
  expect(groupSignals).toEqual([[100, 'SIGTERM']]);
  await Bun.sleep(10);
  expect(groupSignals).toEqual([[100, 'SIGTERM']]);
  await Bun.sleep(25);
  expect(groupSignals).toEqual([[100, 'SIGTERM'], [100, 'SIGKILL']]);
  children[0]!.exit(1);
  await Bun.sleep(8);
  expect(supervisor.pid).toBe(101);
  const stopping = supervisor.stop();
  children[1]!.exit(0);
  await stopping;
});

test('recent frames keep a worker alive', async () => {
  const { supervisor, children, groupSignals, tick } = harness({ spawn: () => children[0]! });
  const child = new FakeProcess(200);
  children.push(child);
  supervisor.start();
  tick(9); supervisor.noteFrame();
  tick(18);
  await Bun.sleep(4);
  expect(groupSignals).toEqual([]);
  const stopping = supervisor.stop(); child.exit(); await stopping;
});

test('stop prevents a late exit from scheduling a respawn', async () => {
  const { supervisor, children, groupSignals } = harness({ restartMs: 2 });
  supervisor.start();
  const stopping = supervisor.stop();
  expect(groupSignals).toEqual([[100, 'SIGTERM']]);
  children[0]!.exit(1);
  await stopping;
  await Bun.sleep(10);
  expect(children).toHaveLength(1);
  expect(supervisor.pid).toBeUndefined();
});

test('stop clears a pending restart timer instead of spawning later', async () => {
  const { supervisor, children } = harness({ restartMs: 20 });
  supervisor.start();
  children[0]!.exit(0);
  await Bun.sleep(4);
  expect(supervisor.pid).toBeUndefined();
  const stopping = supervisor.stop();
  await stopping;
  await Bun.sleep(30);
  expect(children).toHaveLength(1);
});

test('stop is idempotent and shares one TERM', async () => {
  const { supervisor, children, groupSignals } = harness();
  supervisor.start();
  const first = supervisor.stop();
  const second = supervisor.stop();
  expect(second).toBe(first);
  expect(groupSignals).toEqual([[100, 'SIGTERM']]);
  children[0]!.exit(0);
  await first;
});

test('timed-out stop latches ownership until the stuck child settles', async () => {
  const { supervisor, children, groupSignals } = harness({ termMs: 10, stopMs: 20 });
  supervisor.start();
  const stuck = children[0]!;
  await supervisor.stop();
  expect(groupSignals).toEqual([[100, 'SIGTERM'], [100, 'SIGKILL']]);
  expect(supervisor.pid).toBe(100);
  supervisor.start();
  expect(children).toHaveLength(1);
  expect(supervisor.pid).toBe(100);
  stuck.exit(1);
  await Bun.sleep(4);
  expect(supervisor.pid).toBeUndefined();
  supervisor.start();
  expect(children).toHaveLength(2);
  expect(supervisor.pid).toBe(101);
  const finalStop = supervisor.stop();
  children[1]!.exit(0);
  await finalStop;
});

test('start after stop spawns a fresh generation', async () => {
  const { supervisor, children } = harness();
  supervisor.start();
  const stopping = supervisor.stop();
  children[0]!.exit(0);
  await stopping;
  supervisor.start();
  expect(supervisor.pid).toBe(101);
  const finalStop = supervisor.stop();
  children[1]!.exit(0);
  await finalStop;
});

import { expect, test } from 'bun:test';
import { createWaterController, type WaterAction } from '../src/web/gesture';

/** Fake timer that advances time synchronously for deterministic tests. */
class FakeTimer {
  private time = 0;
  private idCounter = 0;
  private pending = new Map<number, { at: number; cb: () => void }>();
  private handles = new Map<number, object>();

  setTimeout(cb: () => void, ms: number): unknown {
    const id = ++this.idCounter;
    this.pending.set(id, { at: this.time + ms, cb });
    const handle = { id };
    this.handles.set(id, handle);
    return handle;
  }

  clearTimeout(id: unknown | undefined): void {
    if (id !== undefined && typeof id === 'object' && id !== null) {
      for (const [key, handle] of this.handles) {
        if (handle === id) { this.pending.delete(key); this.handles.delete(key); break; }
      }
    }
  }

  /** Advance time by `ms`, firing all due timers in order. */
  advance(ms: number): void {
    this.time += ms;
    for (const [id, entry] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at <= this.time) {
        this.pending.delete(id);
        entry.cb();
      }
    }
  }

  now(): number { return this.time; }
}

function mkController(thresholdMs = 250) {
  const emitted: WaterAction[] = [];
  const timer = new FakeTimer();
  const ctrl = createWaterController(
    (a) => { emitted.push(a); },
    thresholdMs,
    { setTimeout: timer.setTimeout.bind(timer), clearTimeout: timer.clearTimeout.bind(timer) },
  );
  return { ctrl, emitted, timer };
}

test('tap emits exactly one pulse action', () => {
  const { ctrl, emitted } = mkController();
  ctrl.start();
  ctrl.stop(500);
  expect(emitted).toEqual([{ type: 'pulse', durationMs: 500 }]);
});

test('hold emits hold-on then off', () => {
  const { ctrl, emitted, timer } = mkController(50);
  ctrl.start();
  timer.advance(100);
  expect(emitted).toEqual([{ type: 'hold-on' }]);
  ctrl.stop(500);
  expect(emitted).toEqual([{ type: 'hold-on' }, { type: 'off' }]);
});

test('cancel during hold emits off', () => {
  const { ctrl, emitted, timer } = mkController(50);
  ctrl.start();
  timer.advance(100);
  ctrl.cancel();
  expect(emitted).toEqual([{ type: 'hold-on' }, { type: 'off' }]);
});

test('cancel before hold emits nothing', () => {
  const { ctrl, emitted } = mkController(250);
  ctrl.start();
  ctrl.cancel();
  expect(emitted).toEqual([]);
});

test('no click pulse after hold', () => {
  const { ctrl, emitted, timer } = mkController(50);
  ctrl.start();
  timer.advance(100);
  ctrl.stop(500);
  // Must be hold-on + off, not pulse
  expect(emitted).not.toContainEqual({ type: 'pulse', durationMs: 500 });
});

test('start is idempotent while down (repeat/duplicate starts ignored)', () => {
  const { ctrl, emitted } = mkController(250);
  ctrl.start();
  ctrl.start();
  ctrl.start();
  ctrl.stop(500);
  expect(emitted).toEqual([{ type: 'pulse', durationMs: 500 }]);
});

test('stop and cancel are idempotent after release', () => {
  const { ctrl, emitted } = mkController(250);
  ctrl.start();
  ctrl.stop(500);
  ctrl.stop(500);
  ctrl.cancel();
  expect(emitted).toEqual([{ type: 'pulse', durationMs: 500 }]);
});

test('held stop is idempotent after off emitted', () => {
  const { ctrl, emitted, timer } = mkController(50);
  ctrl.start();
  timer.advance(100);
  ctrl.stop(500);
  ctrl.stop(500);
  ctrl.cancel();
  expect(emitted).toEqual([{ type: 'hold-on' }, { type: 'off' }]);
});

test('tap twice produces two pulses', () => {
  const { ctrl, emitted } = mkController(250);
  ctrl.start();
  ctrl.stop(200);
  ctrl.start();
  ctrl.stop(300);
  expect(emitted).toEqual([
    { type: 'pulse', durationMs: 200 },
    { type: 'pulse', durationMs: 300 },
  ]);
});

test('blur/pointer-cancel releases during continuous pump', () => {
  const { ctrl, emitted, timer } = mkController(50);
  ctrl.start();
  timer.advance(100);
  expect(emitted).toEqual([{ type: 'hold-on' }]);
  // Simulate blur/pointer-cancel
  ctrl.cancel();
  expect(emitted).toEqual([{ type: 'hold-on' }, { type: 'off' }]);
});
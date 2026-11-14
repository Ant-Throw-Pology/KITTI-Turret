import { test, expect } from 'bun:test';
import { MockGpio, parsePin, type DigitalIo, type Pin } from '../src/gpio';
import { GpioRelay, MockRelay, Pump } from '../src/pump';
import { Stepper, MOTOR_PINS, DEFAULT_MOTION } from '../src/stepper';
import { Manual } from '../src/manual';

class RecordingGpio implements DigitalIo {
  readonly events: string[] = [];
  private readonly inner = new MockGpio();
  output(pin: Pin, initial: boolean) { this.events.push(`output:${pin}:${initial}`); this.inner.output(pin, initial); }
  input(pin: Pin, pullUp: boolean) { this.events.push(`input:${pin}:${pullUp}`); this.inner.input(pin, pullUp); }
  write(pin: Pin, high: boolean) { this.events.push(`write:${pin}:${high}`); this.inner.write(pin, high); }
  read(pin: Pin) { return this.inner.read(pin); }
  close() { this.events.push('close'); this.inner.close(); }
}

test('pin offsets', () => { expect(parsePin('GPIO1_C6')).toEqual({ bank: 1, offset: 22, global: 54 }); });

test('relay boots off and times out', async () => {
  const io = new MockGpio();
  const relay = new GpioRelay(io, 'GPIO1_C6', false);
  expect(io.values.get('GPIO1_C6')).toBe(true);
  const pump = new Pump(relay, { minPulseMs: 5, maxPulseMs: 100, maxContinuousMs: 20 });
  pump.start();
  expect(pump.on).toBe(true);
  await Bun.sleep(35);
  expect(pump.on).toBe(false);
  expect(io.values.get('GPIO1_C6')).toBe(true);
  pump.close();
});

test('configured axes are force-disabled before any enable', () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  expect(io.modes.size).toBe(0);
  yaw.forceDisable();
  pitch.forceDisable();
  for (const pins of [MOTOR_PINS.yaw, MOTOR_PINS.pitch]) {
    expect(io.modes.get(pins.en)).toBe('output');
    expect(io.values.get(pins.en)).toBe(true);
    expect(io.modes.get(pins.step)).toBe('output');
    expect(io.modes.get(pins.dir)).toBe('output');
  }
  yaw.enable();
  expect(io.values.get(MOTOR_PINS.yaw.en)).toBe(false);
  yaw.disable();
  expect(io.values.get(MOTOR_PINS.yaw.en)).toBe(true);
});

test('pump runs without a yaw switch mapping or manual axes', () => {
  const relay = new MockRelay();
  const pump = new Pump(relay, { minPulseMs: 5, maxPulseMs: 100, maxContinuousMs: 100 });
  pump.start(5);
  expect(pump.on).toBe(true);
  expect(relay.on).toBe(true);
  pump.close();
  expect(relay.on).toBe(false);
});

test('final relay off is written before shared GPIO release', () => {
  const io = new RecordingGpio();
  const relay = new GpioRelay(io, 'GPIO1_C6', false);
  const pump = new Pump(relay, { minPulseMs: 5, maxPulseMs: 100, maxContinuousMs: 100 });
  pump.start(5);
  pump.close();
  io.close();
  const writes = io.events.map((event, index) => ({ event, index })).filter(({ event }) => event.startsWith('write:GPIO1_C6:'));
  const last = writes.at(-1)!;
  expect(last.event).toBe('write:GPIO1_C6:true');
  expect(last.index).toBeLessThan(io.events.indexOf('close'));
});

test('estop force-disables untouched drivers and pump', () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  const relay = new MockRelay();
  const pump = new Pump(relay);
  const manual = new Manual({ yaw, pitch }, pump, io);
  manual.enable(true);
  pump.start();
  manual.estop();
  expect(io.values.get(MOTOR_PINS.yaw.en)).toBe(true);
  expect(io.values.get(MOTOR_PINS.pitch.en)).toBe(true);
  expect(relay.on).toBe(false);
});

test('manual shutdown leaves shared GPIO open for pump final off', () => {
  const io = new MockGpio();
  const relay = new MockRelay();
  const pump = new Pump(relay);
  const axes = { yaw: new Stepper(io, MOTOR_PINS.yaw), pitch: new Stepper(io, MOTOR_PINS.pitch) };
  const manual = new Manual(axes, pump, io);
  manual.shutdown();
  pump.close();
  expect(io.modes.size).toBeGreaterThan(0);
  io.close();
  expect(io.modes.size).toBe(0);
});

test('step cap', async () => {
  const io = new MockGpio();
  const m = new Stepper(io, MOTOR_PINS.yaw, { maxRate: 1000, acceleration: 10000, pulseUs: 10, maxSteps: 2 });
  m.enable();
  expect(m.move(1, 3, 100)).rejects.toThrow();
});

test('queued start is cancelled by external stop during await (generation token race)', async () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const relay = new MockRelay();
  const pump = new Pump(relay);
  const manual = new Manual({ yaw, pitch: new Stepper(io, MOTOR_PINS.pitch) }, pump, io);
  manual.enable(true);
  // First start begins running
  manual.start('yaw', 1).catch(() => {});
  // Second start — it will cancel the first and yield on await inside.
  // Schedule an external stop that runs during that yield via microtask.
  const secondPromise = (async () => {
    const p = manual.start('yaw', 1);
    manual.stop('yaw'); // runs after start() yields on await
    return p;
  })();
  await expect(secondPromise).rejects.toThrow('Motor disabled');
  manual.enable(false);
});

test('estop force-disables drivers even when pump.estop throws', () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  // Start pump first with a working relay, then swap to throwing relay
  const workingRelay = new MockRelay();
  const pump = new Pump(workingRelay);
  const manual = new Manual({ yaw, pitch }, pump, io);
  manual.enable(true);
  pump.start();
  // Replace internal relay reference with a throwing one
  const throwingRelay = {
    set(on: boolean) { if (!on) throw new Error('relay-off failure'); },
    close() { this.set(false); },
  };
  (pump as any).relay = throwingRelay;
  manual.estop();
  // Drivers must still be force-disabled even though pump threw
  expect(io.values.get(MOTOR_PINS.yaw.en)).toBe(true);
  expect(io.values.get(MOTOR_PINS.pitch.en)).toBe(true);
  expect(manual.enabled).toBe(false);
  expect(manual.estopped).toBe(true);
});

test('estop cancels motor before touching pump relay', () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  const relay = new MockRelay();
  const pump = new Pump(relay);
  const manual = new Manual({ yaw, pitch }, pump, io);
  manual.enable(true);
  yaw.enable();
  pitch.enable();
  pump.start();
  // Verify en pin is low (enabled) before estop
  expect(io.values.get(MOTOR_PINS.yaw.en)).toBe(false);
  expect(io.values.get(MOTOR_PINS.pitch.en)).toBe(false);
  manual.estop();
  // EN must be high (disabled) — forceDisable runs before pump.estop
  expect(io.values.get(MOTOR_PINS.yaw.en)).toBe(true);
  expect(io.values.get(MOTOR_PINS.pitch.en)).toBe(true);
  expect(relay.on).toBe(false);
});

test('generation token prevents stale start after disable during await', async () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const relay = new MockRelay();
  const pump = new Pump(relay);
  const manual = new Manual({ yaw, pitch: new Stepper(io, MOTOR_PINS.pitch) }, pump, io);
  manual.enable(true);
  // First start begins running
  manual.start('yaw', 1).catch(() => {});
  // Second start yields during await; inject disable from microtask
  const second = (async () => {
    const p = manual.start('yaw', 1);
    manual.enable(false);
    return p;
  })();
  await expect(second).rejects.toThrow('Motor disabled');
});

test('estop during queued start prevents second Stepper.move', async () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const relay = new MockRelay();
  const pump = new Pump(relay);
  const manual = new Manual({ yaw, pitch: new Stepper(io, MOTOR_PINS.pitch) }, pump, io);
  manual.enable(true);
  // First start runs
  manual.start('yaw', 1).catch(() => {});
  // Second queued start — inject estop during the await inside start()
  const second = (async () => {
    const p = manual.start('yaw', 1);
    manual.estop();
    return p;
  })();
  await expect(second).rejects.toThrow('Motor disabled');
  expect(manual.estopped).toBe(true);
  expect(manual.enabled).toBe(false);
});

test('no Stepper.move begins after estop during queued start (deterministic invocation count)', async () => {
  const io = new MockGpio();
  const yawMoveCount: number[] = [0];
  // Fake stepper that records move invocations without real stepping
  const yaw: any = {
    cfg: { maxSteps: 57600 },
    cancel() {},
    enable() {},
    forceDisable() {},
    async move(dir: number, steps: number, _rate: number, _shouldStop?: () => boolean) {
      yawMoveCount[0] = yawMoveCount[0]! + 1;
      // Yield so the generation check can run between queued starts
      await Bun.sleep(0);
      return 0;
    },
  };
  const pump = new Pump(new MockRelay());
  const manual = new Manual({ yaw, pitch: new Stepper(io, MOTOR_PINS.pitch) }, pump, io);
  manual.enable(true);

  // First start invokes move once
  manual.start('yaw', 1).catch(() => {});
  const before = yawMoveCount[0]!;

  // Second queued start — inject estop during the await inside start()
  const second = (async () => {
    const p = manual.start('yaw', 1);
    manual.estop();
    return p;
  })();
  await expect(second).rejects.toThrow('Motor disabled');

  // Only the first move should have run; the second queued start must not call move()
  expect(yawMoveCount[0]!).toBe(before);
  expect(manual.estopped).toBe(true);
  expect(manual.enabled).toBe(false);
});

test('manual does not throw after close on pump stop failure', () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  // Use a working relay to construct, then swap in a throwing one
  const workingRelay = new MockRelay();
  const pump = new Pump(workingRelay);
  const manual = new Manual({ yaw, pitch }, pump, io);
  manual.enable(true);
  yaw.enable();
  pitch.enable();
  pump.start();
  const throwingRelay = {
    set(on: boolean) { if (!on) throw new Error('relay-off failure'); },
    close() { this.set(false); },
  };
  (pump as any).relay = throwingRelay;
  // shutdown must force-disable drivers despite pump errors
  manual.shutdown();
  expect(io.values.get(MOTOR_PINS.yaw.en)).toBe(true);
  expect(io.values.get(MOTOR_PINS.pitch.en)).toBe(true);
  expect(manual.enabled).toBe(false);
  expect(manual.estopped).toBe(true);
});

test('waitForIdle settles after active moves complete or reject', async () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  const pump = new Pump(new MockRelay());
  const manual = new Manual({ yaw, pitch }, pump, io);
  manual.enable(true);
  // Start two moves — they will hang until cancelled
  const yawP = manual.start('yaw', 1).catch(() => {});
  const pitchP = manual.start('pitch', -1).catch(() => {});
  await Bun.sleep(0);
  // Cancel moves while they are live
  manual.stop();
  // waitForIdle must settle immediately after the cancelled tasks resolve
  await manual.waitForIdle();
  // The running map should be empty after idle
  expect(manual['running'].size).toBe(0);
  manual.enable(false);
});

test('waitForIdle resolves immediately when no moves are pending', async () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  const pump = new Pump(new MockRelay());
  const manual = new Manual({ yaw, pitch }, pump, io);
  await manual.waitForIdle(); // must not throw
  expect(true).toBe(true);
});

function attempt(label: string, fn: () => void, errors: string[]): void {
  try { fn(); } catch (e) { errors.push(`${label}: ${e}`); }
}

test('coordinator shutdown isolates each step when things throw', async () => {
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  const pump = new Pump(new MockRelay());
  const manual = new Manual({ yaw, pitch }, pump, io);
  manual.enable(true);
  const { safeStop } = await import('../src/safety');
  const errors: string[] = [];
  // Simulate a pump.close that throws — should not prevent io.close
  attempt('pump.close', () => { throw new Error('pump-close-fail'); }, errors);
  attempt('io.close', () => { io.close(); }, errors);
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain('pump-close-fail');
  // io must still be closed
  expect(io.modes.size).toBe(0);
});

test('backoff skipped when destination limit already pressed at backoff time', async () => {
  const io = new MockGpio();
  const pump = new Pump(new MockRelay());
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  const dirs: number[] = [];
  const fakeYaw: any = {
    cfg: { maxSteps: 57600 },
    cancel() {},
    enable() {},
    forceDisable() {},
    async move(dir: number, _steps: number, _rate: number, _shouldStop?: () => boolean) {
      dirs.push(dir);
      // After first move chunk triggers positive, backoff would be
      // considered but negative is already pressed → skip backoff
      io.setInput(manual.limits.positive, true);
      io.setInput(manual.limits.negative, true);
      return 0;
    },
  };
  const manual = new Manual({ yaw: fakeYaw, pitch }, pump, io);
  manual.enable(true);
  io.setInput(manual.limits.negative, true);
  io.setInput(manual.limits.positive, false);
  await manual.start('yaw', 1);
  // Must only move positive — never negative backoff
  expect(dirs).toEqual([1]);
  expect(dirs).not.toContain(-1);
  manual.enable(false);
});

test('KITTI_MAX_STEPS reaches both Stepper cfg values', () => {
  const io = new MockGpio();
  const maxSteps = 99999;
  const yaw = new Stepper(io, MOTOR_PINS.yaw, { ...DEFAULT_MOTION, maxSteps });
  const pitch = new Stepper(io, MOTOR_PINS.pitch, { ...DEFAULT_MOTION, maxSteps });
  expect(yaw.cfg.maxSteps).toBe(99999);
  expect(pitch.cfg.maxSteps).toBe(99999);
});

test('yaw invert flips raw direction from logical dir', async () => {
  const io = new MockGpio();
  const yawRawDirs: number[] = [];
  const fakeStepper: any = {
    cfg: { maxSteps: 57600 },
    cancel() {},
    enable() {},
    forceDisable() {},
    async move(dir: number) { yawRawDirs.push(dir); return 0; },
  };
  const pump = new Pump(new MockRelay());
  // Without invert: raw dir == logical dir
  const normal = new Manual({ yaw: fakeStepper, pitch: new Stepper(io, MOTOR_PINS.pitch) }, pump, io, undefined, { yaw: false, pitch: false });
  normal.enable(true);
  await normal.start('yaw', 1).catch(() => {});
  expect(yawRawDirs).toEqual([1]);
  yawRawDirs.length = 0;
  normal.enable(false);

  // With invert: raw dir == -logical dir
  const inverted = new Manual({ yaw: fakeStepper, pitch: new Stepper(io, MOTOR_PINS.pitch) }, pump, io, undefined, { yaw: true, pitch: false });
  inverted.enable(true);
  await inverted.start('yaw', 1).catch(() => {});
  expect(yawRawDirs).toEqual([-1]);
  inverted.enable(false);
});

test('yaw invert also inverts backoff direction', async () => {
  const io = new MockGpio();
  const yawRawDirs: number[] = [];
  const fakeStepper: any = {
    cfg: { maxSteps: 57600 },
    cancel() {},
    enable() {},
    forceDisable() {},
    async move(dir: number, _steps: number, _rate: number, _shouldStop?: () => boolean) {
      yawRawDirs.push(dir);
      // After first chunk trigger the blocking limit so backoff runs.
      // With dir=1 (no inversion on limits), blocking = 'positive'.
      if (yawRawDirs.length === 1) io.setInput(manual.limits.positive, true);
      return 0;
    },
  };
  const pump = new Pump(new MockRelay());
  const manual = new Manual({ yaw: fakeStepper, pitch: new Stepper(io, MOTOR_PINS.pitch) }, pump, io, undefined, { yaw: true, pitch: false });
  manual.enable(true);
  // With invert=yaw: logical dir=1, effectiveDir=-1.
  // Blocking limit = 'positive' (from dir=1), backoff = -effectiveDir = 1, stopping when opposite ('negative') is pressed.
  io.setInput(manual.limits.negative, false);
  io.setInput(manual.limits.positive, false);
  await manual.start('yaw', 1).catch(() => {});
  // First move is effectiveDir=-1; backoff should be -effectiveDir=1
  expect(yawRawDirs).toEqual([-1, 1]);
  manual.enable(false);
});

test('pitch invert flips raw direction from logical dir', async () => {
  const io = new MockGpio();
  const pitchRawDirs: number[] = [];
  const fakeStepper: any = {
    cfg: { maxSteps: 57600 },
    cancel() {},
    enable() {},
    forceDisable() {},
    async move(dir: number) { pitchRawDirs.push(dir); return 0; },
  };
  const pump = new Pump(new MockRelay());
  const inverted = new Manual({ yaw: new Stepper(io, MOTOR_PINS.yaw), pitch: fakeStepper }, pump, io, undefined, { yaw: false, pitch: true });
  inverted.enable(true);
  await inverted.start('pitch', -1).catch(() => {});
  expect(pitchRawDirs).toEqual([1]);
  inverted.enable(false);
});

test('default invert is false for both axes', () => {
  const io = new MockGpio();
  const pump = new Pump(new MockRelay());
  const manual = new Manual({ yaw: new Stepper(io, MOTOR_PINS.yaw), pitch: new Stepper(io, MOTOR_PINS.pitch) }, pump, io);
  expect(manual['invert']).toEqual({ yaw: false, pitch: false });
});

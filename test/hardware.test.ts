import { test, expect } from 'bun:test';
import { MockGpio, parsePin, type DigitalIo, type Pin } from '../src/gpio';
import { GpioRelay, MockRelay, Pump } from '../src/pump';
import { Stepper, MOTOR_PINS } from '../src/stepper';
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

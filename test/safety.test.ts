import { expect, test } from 'bun:test';
import { safeStop, estop } from '../src/safety';
import type { SafetyServices } from '../src/safety';

test('safeStop attempts every action even when earlier ones throw', () => {
  const order: string[] = [];
  const services: SafetyServices = {
    track: { enable(on: boolean) { order.push(`track:${on}`); throw new Error('track fail'); } },
    manual: {
      stop() { order.push('manual.stop'); throw new Error('manual.stop fail'); },
      enable(on: boolean) { order.push(`manual.enable:${on}`); throw new Error('manual.enable fail'); },
      estop() { order.push('manual.estop'); },
    },
    axes: {
      yaw: { forceDisable() { order.push('yaw.fd'); throw new Error('yaw fd fail'); } },
      pitch: { forceDisable() { order.push('pitch.fd'); } },
    },
    pump: { stop() { order.push('pump.stop'); throw new Error('pump stop fail'); }, estop() { order.push('pump.estop'); } },
    worker: { destroy() { order.push('worker.destroy'); } },
  };
  const errors = safeStop(services);
  expect(errors.length).toBe(5);
  expect(errors[0]).toContain('track fail');
  expect(errors[1]).toContain('manual.stop fail');
  expect(errors[2]).toContain('yaw');
  expect(errors[3]).toContain('pump stop fail');
  expect(errors[4]).toContain('manual.enable fail');
  // All actions must have been attempted
  expect(order).toEqual([
    'track:false',
    'manual.stop',
    'yaw.fd',
    'pitch.fd',
    'pump.stop',
    'manual.enable:false',
  ]);
});

test('estop independently reaches axes, pump, worker, and supervisor even when manual throws', async () => {
  const order: string[] = [];
  let supervisorStopped = false;
  const services: SafetyServices = {
    track: { enable(on: boolean) { order.push(`track:${on}`); } },
    manual: {
      stop() { order.push('manual.stop'); },
      enable(on: boolean) { order.push(`manual.enable:${on}`); },
      estop() { order.push('manual.estop'); throw new Error('manual estop fail'); },
    },
    axes: {
      yaw: { forceDisable() { order.push('yaw.fd'); } },
      pitch: { forceDisable() { order.push('pitch.fd'); } },
    },
    pump: { stop() { order.push('pump.stop'); }, estop() { order.push('pump.estop'); } },
    worker: { destroy() { order.push('worker.destroy'); } },
    supervisor: { stop() { supervisorStopped = true; order.push('supervisor.stop'); return Promise.resolve(); } },
  };
  const errors = await estop(services);
  // manual.estop threw, but all other actions must still be attempted
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain('manual estop fail');
  // Even though manual.estop threw, axes and pump are still reached independently
  expect(order).toEqual([
    'track:false',
    'manual.stop',
    'manual.estop',
    'yaw.fd',
    'pitch.fd',
    'pump.estop',
    'pump.stop',
    'worker.destroy',
    'supervisor.stop',
  ]);
  expect(supervisorStopped).toBe(true);
});

test('estop catches supervisor rejection', async () => {
  const order: string[] = [];
  const services: SafetyServices = {
    track: { enable(on: boolean) { order.push(`track:${on}`); } },
    axes: {
      yaw: { forceDisable() { order.push('yaw.fd'); } },
      pitch: { forceDisable() { order.push('pitch.fd'); } },
    },
    pump: { stop() { order.push('pump.stop'); }, estop() { order.push('pump.estop'); } },
    worker: { destroy() { order.push('worker.destroy'); } },
    supervisor: { stop() { order.push('supervisor.stop'); return Promise.reject(new Error('supervisor fail')); } },
  };
  const errors = await estop(services);
  expect(errors.some(e => e.includes('supervisor.stop'))).toBe(true);
  expect(errors.some(e => e.includes('supervisor fail'))).toBe(true);
  expect(order).toContain('supervisor.stop');
});

test('estop falls back to direct axes forceDisable and pump estop when manual is absent', async () => {
  const order: string[] = [];
  const services: SafetyServices = {
    track: { enable(on: boolean) { order.push(`track:${on}`); } },
    axes: {
      yaw: { forceDisable() { order.push('yaw.fd'); } },
      pitch: { forceDisable() { order.push('pitch.fd'); } },
    },
    pump: { stop() { order.push('pump.stop'); }, estop() { order.push('pump.estop'); } },
    worker: { destroy() { order.push('worker.destroy'); } },
  };
  const errors = await estop(services);
  expect(errors).toEqual([]);
  expect(order).toEqual([
    'track:false',
    'yaw.fd',
    'pitch.fd',
    'pump.estop',
    'pump.stop',
    'worker.destroy',
  ]);
});

test('estop with absent manual and throwing pump still reaches worker teardown', async () => {
  const order: string[] = [];
  const services: SafetyServices = {
    track: { enable(on: boolean) { order.push(`track:${on}`); throw new Error('track fail'); } },
    axes: {
      yaw: { forceDisable() { order.push('yaw.fd'); } },
      pitch: { forceDisable() { order.push('pitch.fd'); throw new Error('pitch fd fail'); } },
    },
    pump: { stop() { order.push('pump.stop'); }, estop() { order.push('pump.estop'); throw new Error('pump estop fail'); } },
    worker: { destroy() { order.push('worker.destroy'); } },
  };
  const errors = await estop(services);
  expect(errors.length).toBe(3);
  expect(order).toContain('worker.destroy');
});

test('safeStop with no services does not throw', () => {
  const errors = safeStop({});
  expect(errors).toEqual([]);
});

test('estop with no services does not throw', async () => {
  const errors = await estop({});
  expect(errors).toEqual([]);
});

test('estop broadcast failures are captured', async () => {
  const errors = await estop({
    track: { enable() { } },
    broadcast() { throw new Error('broadcast fail'); },
  });
  expect(errors.some(e => e.includes('broadcast'))).toBe(true);
});

test('Manual.start rejects out-of-range overridePct', async () => {
  const { MockGpio } = await import('../src/gpio');
  const { MockRelay, Pump } = await import('../src/pump');
  const { Stepper, MOTOR_PINS } = await import('../src/stepper');
  const { Manual } = await import('../src/manual');
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw);
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  const pump = new Pump(new MockRelay());
  const manual = new Manual({ yaw, pitch }, pump, io);
  manual.enable(true);

  // NaN
  await expect(manual.start('yaw', 1, false, NaN)).rejects.toThrow('Speed out of range');
  // Infinity
  await expect(manual.start('yaw', 1, false, Infinity)).rejects.toThrow('Speed out of range');
  // -Infinity
  await expect(manual.start('yaw', 1, false, -Infinity)).rejects.toThrow('Speed out of range');
  // Below minimum
  await expect(manual.start('yaw', 1, false, 9)).rejects.toThrow('Speed out of range');
  // Above maximum
  await expect(manual.start('yaw', 1, false, 201)).rejects.toThrow('Speed out of range');
  manual.enable(false);
});

test('Manual.start accepts valid overridePct boundaries', async () => {
  const { MockGpio } = await import('../src/gpio');
  const { Stepper, MOTOR_PINS } = await import('../src/stepper');
  const { MockRelay, Pump } = await import('../src/pump');
  const { Manual } = await import('../src/manual');
  const io = new MockGpio();
  const yaw = new Stepper(io, MOTOR_PINS.yaw, { maxRate: 4000, acceleration: 16000, pulseUs: 10, maxSteps: 57600 });
  const pitch = new Stepper(io, MOTOR_PINS.pitch);
  const pump = new Pump(new MockRelay());
  const manual = new Manual({ yaw, pitch }, pump, io);
  manual.enable(true);
  // 10 is valid
  manual.start('yaw', 1, false, 10).catch(() => {});
  manual.stop('yaw');
  // 200 is valid
  manual.start('yaw', 1, false, 200).catch(() => {});
  manual.stop('yaw');
  // Omit overridePct (uses this.speedPct = 100)
  manual.start('yaw', 1, false).catch(() => {});
  manual.stop('yaw');
  manual.enable(false);
});
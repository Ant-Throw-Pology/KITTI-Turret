import { expect, test } from 'bun:test';
import { DEFAULT_CLASS_IDS, TRACK_LIMITS, TrackController, normalizeClassIds, type TrackMotion } from '../src/index';
import type { Axis } from '../src/manual';
import type { Box } from '../src/tracking';

class FakeMotion implements TrackMotion {
  enabled = true;
  estopped = false;
  speedPct = 0;
  readonly starts: { axis: Axis; dir: 1 | -1; slow?: boolean; overridePct?: number }[] = [];
  readonly stops: Axis[] = [];
  switchesValue = { negative: false, positive: false };
  private resolve = new Map<Axis, () => void>();

  speed(pct: number): void { this.speedPct = pct; }
  start(axis: Axis, dir: 1 | -1, slow?: boolean, overridePct?: number): Promise<void> {
    this.starts.push({ axis, dir, slow, overridePct });
    return new Promise<void>(resolve => this.resolve.set(axis, resolve));
  }
  stop(axis?: Axis): void {
    if (!axis) return;
    this.stops.push(axis);
    this.resolve.get(axis)?.();
    this.resolve.delete(axis);
  }
  switches(): { negative: boolean; positive: boolean } { return this.switchesValue; }
}

const cat = (x: number, y = 210): Box => ({ label: 'cat', confidence: 0.9, x, y, width: 80, height: 60 });
const sample = (boxes: Box[], timestamp: number) => ({ boxes, width: 640, height: 480, timestamp });

test('fresh off-centre target starts a bounded, ramp-limited yaw move', () => {
  const motion = new FakeMotion();
  const controller = new TrackController(motion);
  controller.tracker.label = 'cat';
  controller.enable(true);
  controller.sample(sample([cat(400)], 1_000), 1_000);
  expect(controller.tick(1_000).active).toBe(false);
  const first = controller.tick(1_050);
  expect(first.active).toBe(true);
  expect(first.paused).toBeNull();
  expect(first.yaw).toBeGreaterThan(0);
  expect(first.speedPct).toBe(TRACK_LIMITS.minPct);
  expect(motion.starts).toEqual([{ axis: 'yaw', dir: 1, slow: false, overridePct: 10 }]);
  const second = controller.tick(1_100);
  expect(second.speedPct).toBeGreaterThan(first.speedPct);
  expect(second.speedPct).toBeLessThanOrEqual(TRACK_LIMITS.maxPct);
  controller.enable(false);
});

test('centred target and target loss both stop with distinct reasons', () => {
  const motion = new FakeMotion();
  const controller = new TrackController(motion);
  controller.tracker.label = 'cat';
  controller.enable(true);
  controller.sample(sample([cat(280)], 1_000), 1_000);
  controller.tick(1_000);
  expect(controller.tick(1_050).active).toBe(false);

  controller.sample(sample([cat(400)], 1_100), 1_100);
  controller.tick(1_100);
  expect(controller.tick(1_150).active).toBe(true);
  controller.sample(sample([], 1_200), 1_200);
  const lost = controller.tick(1_200);
  expect(lost.paused).toBe('target-lost');
  expect(lost.active).toBe(false);
});

test('stale frames stop motion and prevent new starts', () => {
  const motion = new FakeMotion();
  const controller = new TrackController(motion);
  controller.tracker.label = 'cat';
  controller.enable(true);
  controller.sample(sample([cat(400)], 1_000), 1_000);
  controller.tick(1_000);
  expect(controller.tick(1_050).active).toBe(true);
  const stale = controller.tick(1_050 + TRACK_LIMITS.staleMs + 1);
  expect(stale.paused).toBe('stale-frame');
  expect(stale.active).toBe(false);
  expect(motion.stops).toContain('yaw');
  expect(motion.starts).toHaveLength(1);
});

test('a pressed yaw limit pauses yaw while keeping pitch available', () => {
  const motion = new FakeMotion();
  const controller = new TrackController(motion);
  controller.tracker.label = 'cat';
  controller.enable(true);
  motion.switchesValue = { negative: false, positive: true };
  controller.sample(sample([cat(400, 300)], 1_000), 1_000);
  controller.tick(1_000);
  const paused = controller.tick(1_050);
  expect(paused.paused).toBe('yaw-limit');
  expect(motion.starts.map(s => s.axis)).not.toContain('yaw');
  expect(motion.starts.map(s => s.axis)).toContain('pitch');
  expect(paused.yaw).toBe(0);
});

test('a newly pressed yaw limit stops an active yaw move immediately', () => {
  const motion = new FakeMotion();
  const controller = new TrackController(motion);
  controller.tracker.label = 'cat';
  controller.enable(true);
  controller.sample(sample([cat(400)], 1_000), 1_000);
  controller.tick(1_000);
  expect(controller.tick(1_050).active).toBe(true);
  motion.switchesValue = { negative: true, positive: false };
  const stopped = controller.tick(1_100);
  expect(stopped.paused).toBe('yaw-limit');
  expect(stopped.active).toBe(false);
  expect(motion.stops).toContain('yaw');
});

test('speed changes never exceed the configured acceleration window', () => {
  const motion = new FakeMotion();
  const controller = new TrackController(motion);
  controller.tracker.label = 'cat';
  controller.enable(true);
  controller.sample(sample([cat(600)], 1_000), 1_000);
  controller.tick(1_000);
  let previous = 0;
  const maxStep = TRACK_LIMITS.yawAccel / TRACK_LIMITS.yawBaseRate * 100 * 0.05 + 1;
  for (let step = 1; step <= 10; step++) {
    const snapshot = controller.tick(1_000 + step * 50);
    expect(snapshot.speedPct - previous).toBeLessThanOrEqual(maxStep);
    previous = snapshot.speedPct;
  }
  expect(previous).toBeLessThanOrEqual(TRACK_LIMITS.maxPct);
  controller.enable(false);
});

test('sub-minimum acceleration accumulates across ticks and starts only when threshold is crossed', () => {
  const motion = new FakeMotion();
  const controller = new TrackController(motion);
  controller.tracker.label = 'cat';
  controller.enable(true);
  // Place target just barely off-centre so velocity is small
  controller.sample(sample([cat(325)], 1_000), 1_000);
  controller.tick(1_000);
  // First tick: rate just starts accumulating below minPct
  const first = controller.tick(1_050);
  expect(first.active).toBe(false); // not started yet
  // Force a bigger offset to make the tracker request a higher velocity
  controller.sample(sample([cat(480)], 1_050), 1_050);
  let cumulative = 0;
  for (let step = 0; step < 20; step++) {
    const snap = controller.tick(1_050 + (step + 1) * 50);
    if (snap.active) { cumulative = snap.speedPct; break; }
  }
  // Must eventually cross minPct and start
  expect(cumulative).toBeGreaterThanOrEqual(TRACK_LIMITS.minPct);
  expect(motion.starts.length).toBeGreaterThanOrEqual(1);
  controller.enable(false);
});

test('tracking passes its own overridePct not shared speedPct', () => {
  const motion = new FakeMotion();
  const controller = new TrackController(motion);
  controller.tracker.label = 'cat';
  controller.enable(true);
  controller.sample(sample([cat(580)], 1_000), 1_000);
  controller.tick(1_000);
  const snap = controller.tick(1_050);
  expect(snap.active).toBe(true);
  // The overridePct should be passed to start, bounded by maxPct
  const start = motion.starts[0]!;
  expect(start.overridePct).toBeGreaterThanOrEqual(TRACK_LIMITS.minPct);
  expect(start.overridePct).toBeLessThanOrEqual(TRACK_LIMITS.maxPct);
  // The global speedPct on motion should still be 0 (tracking never calls motion.speed)
  expect(motion.speedPct).toBe(0);
  controller.enable(false);
});

test('zero target velocity stops and clears promptly', () => {
  const motion = new FakeMotion();
  const controller = new TrackController(motion);
  controller.tracker.label = 'cat';
  controller.enable(true);
  // Strong off-centre target
  controller.sample(sample([cat(580)], 1_000), 1_000);
  controller.tick(1_000);
  expect(controller.tick(1_050).active).toBe(true);
  // Centred target -> velocity falls to 0
  controller.sample(sample([cat(280)], 1_100), 1_100);
  const stopped = controller.tick(1_100);
  // Rate should decelerate toward 0 and eventually stop
  expect(stopped.yaw).toBe(0);
  expect(stopped.active).toBe(false);
  controller.enable(false);
});

test('class configuration defaults and validates YOLO ids', () => {
  expect(DEFAULT_CLASS_IDS).toEqual([0, 15, 16]);
  expect(normalizeClassIds([3, 1, 3, 0])).toEqual([0, 1, 3]);
  expect(normalizeClassIds([])).toEqual([]);
  expect(() => normalizeClassIds([80])).toThrow();
  expect(() => normalizeClassIds([1.5])).toThrow();
  expect(() => normalizeClassIds('0,1')).toThrow();
});

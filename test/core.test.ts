import { test, expect } from 'bun:test';
import { PacketDecoder, PacketType, encodePacket, FrameWindow } from '../src/ipc';
import { chooseTarget, Tracker } from '../src/tracking';
import { loadConfig } from '../src/config';

test('packet decoder handles split headers and payloads', () => {
  const bytes = encodePacket(PacketType.Detection, new TextEncoder().encode('ok'));
  const decoder = new PacketDecoder();
  expect(decoder.push(bytes.slice(0, 2))).toEqual([]);
  expect(decoder.push(bytes.slice(2, 6))).toEqual([]);
  expect(new TextDecoder().decode(decoder.push(bytes.slice(6))[0]!.payload)).toBe('ok');
});
test('frame window drops oldest queued and detects stale ack', () => {
  const window = new FrameWindow();
  for (let i = 0; i < 3; i++) window.offer(i, new Uint8Array([i]));
  expect(window.dropped).toBe(1);
  const sent: number[] = [];
  window.flush(data => sent.push(data[0]!), 0);
  expect(sent).toEqual([1, 2]);
  expect(window.inFlight).toBe(2);
  expect(window.stalled(30001)).toBe(true);
  window.ack(1); window.ack(2);
  expect(window.stalled(30001)).toBe(false);
});
test('tracking box contract uses width and height for the center and area', () => {
  const tracker = new Tracker(); tracker.enabled = true; tracker.label = 'cat';
  const box = { label: 'cat', confidence: 0.9, x: 400, y: 300, width: 80, height: 100 };
  expect(tracker.update([box], 640, 480, 10, false)).toEqual({ yaw: 300, pitch: 220 });
  const boxes = [
    { label: 'cat', confidence: 0.99, x: 0, y: 0, width: 10, height: 10 },
    { label: 'cat', confidence: 0.10, x: 0, y: 0, width: 100, height: 100 },
    { label: 'cat', confidence: 0.90, x: 0, y: 0, width: 0, height: 100 },
  ];
  expect(chooseTarget(boxes, 'cat', 'area')?.width).toBe(100);
  expect(chooseTarget([boxes[2]!], 'cat', 'confidence')).toBeNull();
});
test('tracking ignores stale boxes and limit prevents yaw', () => {
  const tracker = new Tracker(); tracker.enabled = true; tracker.label = 'cat';
  const box = { label: 'cat', confidence: 0.9, x: 400, y: 200, width: 80, height: 80 };
  expect(tracker.update([box], 640, 480, 301, false)).toEqual({ yaw: 0, pitch: 0 });
  expect(tracker.update([box], 640, 480, 10, true).yaw).toBe(0);
  expect(tracker.update([box], 640, 480, 10, false).yaw).toBeGreaterThan(0);
  expect(chooseTarget([box], 'dog', 'area')).toBeNull();
});
test('relay polarity is unconfigured by default', () => {
  expect(loadConfig().relayActiveHigh).toBeNull();
});

test('KITTI_YAW_INVERT and KITTI_PITCH_INVERT reject non-0/1 values', () => {
  process.env.KITTI_YAW_INVERT = '2';
  expect(() => loadConfig()).toThrow('KITTI_YAW_INVERT');
  process.env.KITTI_YAW_INVERT = 'yes';
  expect(() => loadConfig()).toThrow('KITTI_YAW_INVERT');
  delete process.env.KITTI_YAW_INVERT;

  process.env.KITTI_PITCH_INVERT = '0';
  expect(loadConfig().pitchInvert).toBe(false);
  process.env.KITTI_PITCH_INVERT = '1';
  expect(loadConfig().pitchInvert).toBe(true);
  process.env.KITTI_PITCH_INVERT = 'true';
  expect(() => loadConfig()).toThrow('KITTI_PITCH_INVERT');
  delete process.env.KITTI_PITCH_INVERT;
});

test('KITTI_PING_TIMEOUT_MS defaults to 15000 with safe range 1000..120000', () => {
  expect(loadConfig().pingTimeoutMs).toBe(15000);

  process.env.KITTI_PING_TIMEOUT_MS = '999';
  expect(() => loadConfig()).toThrow('KITTI_PING_TIMEOUT_MS');

  process.env.KITTI_PING_TIMEOUT_MS = '120001';
  expect(() => loadConfig()).toThrow('KITTI_PING_TIMEOUT_MS');

  process.env.KITTI_PING_TIMEOUT_MS = '5000';
  expect(loadConfig().pingTimeoutMs).toBe(5000);

  delete process.env.KITTI_PING_TIMEOUT_MS;
});

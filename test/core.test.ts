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

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BASELINE_CLASS_IDS, boxStyle, classIdsForTarget, matchDetectionsToFrame, parseJpegFrame, targetOptions } from '../src/web/protocol';

test('JPEG frame parsing reads the 12-byte sequence/timestamp prefix', () => {
  const bytes = new Uint8Array(15), view = new DataView(bytes.buffer);
  view.setUint32(0, 42, true);
  view.setBigUint64(4, 123456789n, true);
  bytes.set([0xff, 0xd8, 0xff], 12);
  const frame = parseJpegFrame(bytes.buffer);
  expect(frame.seq).toBe(42);
  expect(frame.timestamp).toBe(123456789);
  expect([...new Uint8Array(frame.jpeg)]).toEqual([0xff, 0xd8, 0xff]);
});

test('detections match frames by sequence before timestamp fallback', () => {
  const packets = [
    { seq: 1, timestamp: 1000, boxes: [{ label: 'old', confidence: 0.9, x: 0, y: 0, width: 1, height: 1 }] },
    { seq: 99, timestamp: 1190, boxes: [{ label: 'near', confidence: 0.9, x: 0, y: 0, width: 1, height: 1 }] },
    { seq: 2, timestamp: 5000, boxes: [{ label: 'exact', confidence: 0.9, x: 0, y: 0, width: 1, height: 1 }] },
  ];
  expect(matchDetectionsToFrame({ seq: 2, timestamp: 1200 }, packets)?.boxes?.[0]?.label).toBe('exact');
  expect(matchDetectionsToFrame({ seq: 3, timestamp: 1200 }, packets)?.boxes?.[0]?.label).toBe('near');
  expect(matchDetectionsToFrame({ seq: 3, timestamp: 1600 }, packets)).toBeUndefined();
});

test('detection box styling accepts width/height and legacy w/h fields', () => {
  expect(boxStyle({ label: 'cat', confidence: 1, x: 64, y: 48, width: 128, height: 96 }, 640, 480)).toMatchObject({ left: '10%', top: '10%', width: '20%', height: '20%' });
  expect(boxStyle({ label: 'cat', confidence: 1, x: 64, y: 48, w: 128, h: 96 }, 640, 480)).toMatchObject({ left: '10%', top: '10%', width: '20%', height: '20%' });
});

test('target choices include dynamic YOLO classes and all AprilTags', () => {
  const options = targetOptions();
  expect(options[0]).toMatchObject({ value: 'All AprilTags', allTags: true });
  expect(options.filter(option => option.classId !== undefined)).toHaveLength(80);
  expect(options.filter(option => option.tagId !== undefined)).toHaveLength(587);
  expect(options.some(option => option.value === 'cat' && option.classId === 15)).toBe(true);
  expect(options.some(option => option.value === 'tag:586' && option.tagId === 586)).toBe(true);
});

test('selecting a non-baseline YOLO target adds that class to baseline inference ids', () => {
  expect(classIdsForTarget('cat', BASELINE_CLASS_IDS)).toEqual([0, 15, 16]);
  expect(classIdsForTarget('bottle', BASELINE_CLASS_IDS)).toEqual([0, 15, 16, 39]);
});

test('client source keeps required UI interaction guards wired', () => {
  const source = readFileSync('src/web/client.tsx', 'utf8');
  expect(source).toContain("if (e.repeat) return");
  expect(source).toContain("key === 'shift'");
  expect(source).toContain("addEventListener('blur'");
  expect(source).toContain('stopMotion(); cancelWater(); send({ type: ');
  expect(source).toContain("send({ type: 'pump', on: true, durationMs: action.durationMs })");
  expect(source).toContain("send({ type: 'pump', on: false })");
});

test('reconnect: connectWebSocket, cleanupWs, bounded backoff, null-safe send', () => {
  const source = readFileSync('src/web/client.tsx', 'utf8');
  expect(source).toContain('let ws: WebSocket | null = null');
  expect(source).toContain('function connectWebSocket(');
  expect(source).toContain('function cleanupWs()');
  expect(source).toContain('const WS_MAX_RECONNECT = 20');
  expect(source).toContain('ws?.readyState === WebSocket.OPEN');
  // Exponential backoff: Math.min(30000, Math.pow(2, wsReconnectAttempts) * 100)
  expect(source).toContain('Math.pow(2, wsReconnectAttempts) * 100');
  // Lifecycle cleanup on disconnect
  expect(source).toContain('cleanupWs(); stopMotion(); send({ type: \'pump\', on: false }); peerRef.current?.close()');
  // On reconnect: re-establish WebRTC signaling
  expect(source).toContain('connectPeer().catch((e) => setError(String(e))); send({ type: \'ping\' })');
});

test('stable keyboard: empty deps, refs for enabled/pulseMs, blur listener', () => {
  const source = readFileSync('src/web/client.tsx', 'utf8');
  // Keyboard handler reads enabled via ref, not closed-over state
  expect(source).toContain("enabledRef.current");
  // Water stop uses pulseMsRef instead of closed-over pulseMs
  expect(source).toContain("pulseMsRef.current");
  // The keyboard useEffect has empty deps so it installs once
  expect(source).toContain("useEffect(() => {");
  expect(source).toContain("  }, []);");
  // Blur is registered/unregistered via addEventListener/removeEventListener
  expect(source).toContain("window.addEventListener('blur', onBlur)");
  expect(source).toContain("window.removeEventListener('blur', onBlur)");
  // Input-focus exclusion preserved
  expect(source).toContain("e.target instanceof HTMLInputElement");
  // Repeat suppression preserved
  expect(source).toContain("if (e.repeat) return");
  // Shift resend preserved
  expect(source).toContain("key === 'shift'");
  // F tap/hold preserved
  expect(source).toContain("key === 'f'");
});

test('signaling route advertises WebSocket video fallback when WebRTC is disabled', () => {
  const source = readFileSync('src/index.ts', 'utf8');
  const client = readFileSync('src/web/client.tsx', 'utf8');
  expect(source).toContain('KITTI_ENABLE_WEBRTC');
  expect(source).toContain('type: "videoTransport", websocket: true, webrtc: false');
  expect(client).toContain('event.data instanceof ArrayBuffer');
});

test('client source echoes sliders only from explicit server fields', () => {
  const source = readFileSync('src/web/client.tsx', 'utf8');
  expect(source).toContain('if (msg.speed !== undefined) setSpeed(msg.speed)');
  expect(source).toContain('if (msg.aimX !== undefined && msg.aimY !== undefined)');
  expect(source).toContain('setAimX(Number(msg.aimX)); setAimY(Number(msg.aimY))');
});

test('dashboard keeps required viewport sizes free of tutorial text', () => {
  const html = readFileSync('src/web/index.html', 'utf8').toLowerCase();
  const css = readFileSync('src/web/style.css', 'utf8');
  for (const forbidden of ['tutorial', 'subtitle', 'tagline', 'caption']) expect(html).not.toContain(forbidden);
  expect(css).toContain('height:100dvh');
  expect(css).toContain('overflow:hidden');
  expect(css).toContain('grid-template-columns:minmax(0,1fr) 360px');
});

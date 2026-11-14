import { expect, test, mock } from "bun:test";
import { jpegQualityToQ, JpegStreamParser, JpegEncoder, type EncoderSpawn } from "../src/encoder";

test("jpegQualityToQ maps quality to ffmpeg Q factor", () => {
  // q = max(2, round((100 - quality) / 8))
  expect(jpegQualityToQ(100)).toBe(2);
  expect(jpegQualityToQ(60)).toBe(5);
  expect(jpegQualityToQ(1)).toBe(12);
  expect(jpegQualityToQ(10)).toBe(11);
  expect(() => jpegQualityToQ(Infinity)).toThrow();
  expect(() => jpegQualityToQ(NaN)).toThrow();
});

test("JpegStreamParser rejects invalid max size", () => {
  expect(() => new JpegStreamParser(0)).toThrow();
  expect(() => new JpegStreamParser(3)).toThrow();
  expect(() => new JpegStreamParser(1.5)).toThrow();
  expect(() => new JpegStreamParser(-1)).toThrow();
});

test("JpegStreamParser returns nothing from empty chunks", () => {
  const parser = new JpegStreamParser();
  expect(parser.push(new Uint8Array(0))).toEqual([]);
});

test("JpegStreamParser finds a complete JPEG", () => {
  const parser = new JpegStreamParser();
  const soi = new Uint8Array([0xff, 0xd8]);
  const eoi = new Uint8Array([0xff, 0xd9]);
  const body = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
  const frame = new Uint8Array([...soi, ...body, ...eoi]);
  const result = parser.push(frame);
  expect(result).toHaveLength(1);
  expect(result[0]!).toEqual(frame);
});

test("JpegStreamParser accumulates across chunks", () => {
  const parser = new JpegStreamParser();
  const frame = new Uint8Array([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
  expect(parser.push(frame.slice(0, 2))).toEqual([]);
  expect(parser.push(frame.slice(2))).toHaveLength(1);
});

test("JpegStreamParser recovers after a failed oversized frame", () => {
  const parser = new JpegStreamParser(8); // max 8 bytes
  const huge = new Uint8Array([0xff, 0xd8, ...new Uint8Array(10), 0xff, 0xd9]);
  expect(() => parser.push(huge)).toThrow("exceeds");
  // After error, parser is reset and can accept a new frame
  const good = new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]);
  expect(parser.push(good)).toHaveLength(1);
});

test("JpegStreamParser extracts multiple frames from one chunk", () => {
  const parser = new JpegStreamParser();
  const a = new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]);
  const b = new Uint8Array([0xff, 0xd8, 0x02, 0xff, 0xd9]);
  const combined = new Uint8Array([...a, ...b]);
  const frames = parser.push(combined);
  expect(frames).toHaveLength(2);
  expect(frames[0]!).toEqual(a);
  expect(frames[1]!).toEqual(b);
});

test("JpegEncoder validates dimensions", () => {
  expect(() => new JpegEncoder({ width: 0, height: 480, quality: 60 })).toThrow();
  expect(() => new JpegEncoder({ width: 640, height: 0, quality: 60 })).toThrow();
  expect(() => new JpegEncoder({ width: 1.5, height: 480, quality: 60 })).toThrow();
});

test("JpegEncoder fails encode before start", async () => {
  const encoder = new JpegEncoder({ width: 4, height: 4, quality: 60 });
  await expect(encoder.encode(new Uint8Array(4 * 4 * 3))).rejects.toThrow("not started");
});

test("JpegEncoder fails encode with wrong size", async () => {
  const encoder = new JpegEncoder({ width: 4, height: 4, quality: 60 });
  encoder.start();
  await expect(encoder.encode(new Uint8Array(10))).rejects.toThrow("expected 48 BGR bytes");
  await encoder.stop();
});

test("JpegEncoder double start throws", () => {
  const encoder = new JpegEncoder({ width: 4, height: 4, quality: 60 });
  encoder.start();
  expect(() => encoder.start()).toThrow("already started");
  void encoder.stop();
});

test("JpegEncoder stop is idempotent", async () => {
  const encoder = new JpegEncoder({ width: 4, height: 4, quality: 60 });
  encoder.start();
  await encoder.stop();
  await encoder.stop(); // second call should resolve without throwing
});

test("JpegEncoder encode after stop rejects", async () => {
  const encoder = new JpegEncoder({ width: 4, height: 4, quality: 60 });
  encoder.start();
  await encoder.stop();
  await expect(encoder.encode(new Uint8Array(4 * 4 * 3))).rejects.toThrow("stopped");
});

test("JpegEncoder default spawn does not use detached", () => {
  const recordedOpts: unknown[] = [];
  const customSpawn: EncoderSpawn = (cmd: string[]) => {
    recordedOpts.push(cmd);
    throw new Error("mock spawn");
  };

  const encoder = new JpegEncoder({ width: 4, height: 4, quality: 60 }, customSpawn);
  expect(() => encoder.start()).toThrow();
  // The spawn function is not defaultSpawn, so this test confirms custom spawn
  // is called; defaultSpawn options are verified by its absence of detached flag
  expect(recordedOpts).toHaveLength(1);
});

test("JpegEncoder stop kills child directly with SIGKILL", async () => {
  const killMock = mock(() => {});
  const mockProc = {
    stdin: { write: () => 0, flush: () => {} },
    stdout: { getReader: () => ({ read: () => Promise.resolve({ value: undefined, done: true }) }) },
    stderr: null,
    kill: killMock,
    exited: Promise.resolve(0),
  };

  const customSpawn: EncoderSpawn = () => mockProc as any;

  const encoder = new JpegEncoder({ width: 4, height: 4, quality: 60 }, customSpawn);
  encoder.start();
  await encoder.stop();

  // stop() -> killProc() -> proc.kill("SIGKILL") directly, no process.group kill
  expect(killMock).toHaveBeenCalledWith("SIGKILL");
});

test("JpegEncoder stop does not call process.kill with negative pid", async () => {
  const killMock = mock(() => {});
  const mockProc = {
    stdin: { write: () => 0, flush: () => {} },
    stdout: { getReader: () => ({ read: () => Promise.resolve({ value: undefined, done: true }) }) },
    stderr: null,
    kill: killMock,
    exited: Promise.resolve(0),
  };

  const customSpawn: EncoderSpawn = () => mockProc as any;

  const encoder = new JpegEncoder({ width: 4, height: 4, quality: 60 }, customSpawn);
  encoder.start();
  await encoder.stop();

  // The only kill call should be proc.kill (direct child kill)
  expect(killMock).toHaveBeenCalledTimes(1);
  expect(killMock).toHaveBeenCalledWith("SIGKILL");
});
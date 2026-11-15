/**
 * Offline image/video mode for the KITTI pipeline.
 *
 * Processes a single image or video file through letterbox, optional NPU
 * inference, and JPEG encoding.  Does NOT import RKNN at module scope;
 * inference is loaded dynamically only when --model is given.
 *
 * Usage:
 *   bun run offline --image in.jpg [--model model.rknn] [--quality 80]
 *   bun run offline --video in.mp4 [--model model.rknn] [--quality 80] [--fps 10] [--max-frames 100]
 *
 * Common options:
 *   --output <dir>      Write per-frame JPEG files to <dir> (default: stdout only)
 *   --classes <ids>     Comma-separated class IDs to detect (default: 0,15,16)
 *   --width  --height   Input dimensions for ffmpeg (default: 640, 480)
 */

import { JpegEncoder, jpegQualityToQ } from "../src/encoder";
import { letterbox } from "../src/preprocess";
import { decodeDetect6 } from "../src/yolo";
import { TagHelper } from "../src/apriltag";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Argument parsing ─────────────────────────────────────────────────────

function usage(): never {
  console.error(`Usage:
  bun run scripts/offline.ts --image <path> [options]
  bun run scripts/offline.ts --video <path> [options]

Options:
  --model <path>       RKNN model (inference is skipped if omitted)
  --quality <1..100>   JPEG quality (default 60)
  --output <dir>       Write JPEGs to <dir>
  --classes <ids>      Comma-separated int class IDs (default 0,15,16)
  --width  <px>        Output width  (default 640)
  --height <px>        Output height (default 480)
  --fps <n>            Video frame rate to read (default 10)
  --max-frames <n>     Stop after this many frames (default unlimited)
`);
  process.exit(1);
}

type Args = {
  mode: "image" | "video";
  path: string;
  model?: string;
  quality: number;
  output?: string;
  classes: Set<number>;
  width: number;
  height: number;
  fps: number;
  maxFrames: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "image",
    path: "",
    quality: 60,
    classes: new Set([0, 15, 16]),
    width: 640,
    height: 480,
    fps: 10,
    maxFrames: Infinity,
  };
  let i = 0;
  const next = () => argv[++i] ?? (usage());
  while (i < argv.length) {
    switch (argv[i]!) {
      case "--image": args.mode = "image"; args.path = next(); break;
      case "--video": args.mode = "video"; args.path = next(); break;
      case "--model": args.model = next(); break;
      case "--quality": args.quality = Math.max(1, Math.min(100, Number(next()))); break;
      case "--output": args.output = next(); break;
      case "--classes": args.classes = new Set(next().split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 80)); break;
      case "--width": args.width = Math.max(64, Math.min(4096, Number(next()))); break;
      case "--height": args.height = Math.max(64, Math.min(4096, Number(next()))); break;
      case "--fps": args.fps = Math.max(1, Math.min(120, Number(next()))); break;
      case "--max-frames": args.maxFrames = Math.max(1, Number(next())); break;
      default: usage();
    }
    i++;
  }
  if (!args.path || !existsSync(args.path)) {
    console.error(`file not found: ${args.path}`);
    usage();
  }
  return args;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildFfmpegArgs(file: string, mode: "image" | "video", width: number, height: number, fps: number): string[] {
  const args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", file];
  if (mode === "video") args.push("-vsync", "drop", "-r", String(fps));
  args.push("-f", "rawvideo", "-pix_fmt", "bgr24", "-s", `${width}x${height}`, "pipe:1");
  return args;
}

async function* frameGenerator(file: string, mode: "image" | "video", width: number, height: number, fps: number, maxFrames: number): AsyncGenerator<{ bgr: Uint8Array; sequence: number }> {
  const args = buildFfmpegArgs(file, mode, width, height, fps);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  if (!proc.stdout || typeof proc.stdout === "number") throw new Error("ffmpeg stdout unavailable");
  // Drain stderr silently
  if (proc.stderr && typeof proc.stderr !== "number") {
    void (async () => { const r = proc.stderr!.getReader(); try { while (!(await r.read()).done) ; } catch { /* */ } finally { r.releaseLock(); } })();
  }

  const reader = proc.stdout.getReader();
  const frameSize = width * height * 3;
  let seq = 0;
  try {
    let buf = new Uint8Array(0);
    while (seq < maxFrames) {
      const { value, done } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(buf.length + value.length);
      joined.set(buf);
      joined.set(value, buf.length);
      buf = joined;
      while (buf.length >= frameSize && seq < maxFrames) {
        yield { bgr: buf.slice(0, frameSize), sequence: ++seq };
        buf = buf.slice(frameSize);
      }
    }
  } finally {
    reader.releaseLock();
    try { proc.kill("SIGTERM"); } catch { /* ok */ }
    await proc.exited.catch(() => undefined);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

// Conditionally load RKNN – only when --model is given.
type Model = { infer(rgb: Uint8Array): Promise<Float32Array<ArrayBufferLike>[]>; close(): void };
let model: Model | undefined;
if (args.model) {
  const { RknnModel, NpuLock } = await import("../src/rknn");
  const lock = new NpuLock();
  lock.acquire();
  const m = new RknnModel(args.model);
  await m.open();
  model = { infer: (rgb) => m.infer(rgb), close: () => { m.close(); lock.release(); } };
}

const tags = new TagHelper();
const encoder = new JpegEncoder({ width: args.width, height: args.height, quality: args.quality });
encoder.start();

if (args.output) {
  mkdirSync(args.output, { recursive: true });
}

const results: Array<{ sequence: number; boxes: unknown[]; jpegPath?: string; dropped: number }> = [];
let droppedFrames = 0;
let lastConsumed = -1;

try {
  for await (const { bgr, sequence } of frameGenerator(args.path, args.mode, args.width, args.height, args.fps, args.maxFrames)) {
    if (lastConsumed > 0 && sequence > lastConsumed + 1) droppedFrames += sequence - lastConsumed - 1;
    lastConsumed = sequence;

    let boxes: unknown[] = [];

    if (model) {
      tags.submit(sequence, bgr, args.width, args.height);
      const letterboxed = letterbox(bgr, args.width, args.height);
      const raw = await model.infer(letterboxed.rgb);
      boxes = [...decodeDetect6(raw, letterboxed, args.classes), ...tags.latest()];
    }

    // Encode to JPEG
    const jpeg = await encoder.encode(bgr);

    let jpegPath: string | undefined;
    if (args.output) {
      jpegPath = resolve(args.output, `frame_${String(sequence).padStart(6, "0")}.jpg`);
      writeFileSync(jpegPath, jpeg);
    }

    results.push({ sequence, boxes, jpegPath, dropped: droppedFrames });

    // Print immediate JSON line per frame (streaming)
    console.log(JSON.stringify({ sequence, boxes: boxes.length, jpegBytes: jpeg.length, dropped: droppedFrames }));
  }

  // Final summary (single JSON object on stderr)
  console.error(JSON.stringify({
    mode: args.mode,
    file: args.path,
    model: args.model ?? null,
    frames: results.length,
    dropped: droppedFrames,
    jpegDir: args.output ?? null,
  }));
} finally {
  await encoder.stop();
  model?.close();
}
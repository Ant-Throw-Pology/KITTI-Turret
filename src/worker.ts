import { createConnection, type Socket } from "node:net";
import { Camera } from "./camera";
import { loadConfig } from "./config";
import { PacketDecoder, PacketType, FrameWindow, encodePacket } from "./ipc";
import { letterbox } from "./preprocess";
import { RknnModel, NpuLock } from "./rknn";
import { decodeDetect6 } from "./yolo";
import { YOLO_LABELS } from "./web/protocol";
import { TagHelper } from "./apriltag";
import { JpegStreamParser, PerFrameJpegEncoder } from "./encoder";

const config = loadConfig();
const previewOnly = process.env.KITTI_CAMERA_PREVIEW === "1" || !config.model;
const camera = new Camera({ device: config.camera === "auto" ? undefined : config.camera, width: config.width, height: config.height, fps: config.fps });
const model = previewOnly ? undefined : new RknnModel(config.model);
const npuLock = previewOnly ? undefined : new NpuLock();
const tags = previewOnly ? undefined : new TagHelper();
const decoder = new PacketDecoder(), window = new FrameWindow();
const classes = new Set([0, 15, 16]);
let socket: Socket | undefined;
let running = true;

process.once("SIGINT", () => { running = false; shutdownNow(); });
process.once("SIGTERM", () => { running = false; shutdownNow(); });

let perFrame: PerFrameJpegEncoder | undefined;
let capture: ReturnType<typeof Bun.spawn> | undefined;

function shutdownNow(): void {
  try { capture?.kill("SIGKILL"); } catch { /* gone */ }
  camera.stop();
  try { socket?.destroy(); } catch { /* gone */ }
  process.exit(0);
}

/** Connect to the server's IPC socket with retry via node:net. */
function connectIpc(path: string): Promise<Socket> {
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = createConnection(path);
      sock.once("connect", () => resolve(sock));
      sock.once("error", () => { try { sock.destroy(); } catch { /* gone */ } setTimeout(attempt, 500); });
    };
    attempt();
  });
}

/** Preview path: capture MJPEG straight from the camera and stream the
 *  JPEGs as-is. No re-encode, so the browser gets the full camera rate. */
async function runPreview(): Promise<void> {
  const device = config.camera === "auto" ? "/dev/video0" : config.camera;
  const { width, height, fps } = config;
  capture = Bun.spawn([
    "ffmpeg", "-hide_banner", "-loglevel", "error",
    "-f", "v4l2", "-input_format", "mjpeg", "-i", device,
    "-vf", `scale=${width}:${height},fps=${fps}`,
    "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const stream = capture.stdout;
  if (!stream || typeof stream === "number") throw new Error("mjpeg capture unavailable");
  const reader = stream.getReader();
  const parser = new JpegStreamParser();
  let seq = 0;
  while (running) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const jpeg of parser.push(new Uint8Array(value))) {
      seq++;
      const capturedAt = Date.now();
      const detection = new TextEncoder().encode(JSON.stringify({ sequence: seq, timestamp: capturedAt, width, height, boxes: [], dropped: 0 }));
      socket!.write(encodePacket(PacketType.Detection, detection));
      const payload = new Uint8Array(12 + jpeg.length), view = new DataView(payload.buffer);
      view.setUint32(0, seq, true); view.setBigUint64(4, BigInt(capturedAt), true); payload.set(jpeg, 12);
      window.offer(seq, encodePacket(PacketType.Frame, payload));
      window.flush(data => socket!.write(data));
    }
  }
  try { reader.releaseLock(); } catch { /* released */ }
}

/** Inference path: BGR capture + model + per-frame JPEG encode for the
 *  browser stream. */
async function runInferenceLoop(): Promise<void> {
  npuLock?.acquire();
  await model?.open();
  await camera.start();
  tags?.start();
  perFrame = new PerFrameJpegEncoder({ width: config.width, height: config.height, quality: config.jpegQuality });

  let lastSeq = 0;
  while (running) {
    const frame = camera.takeLatest();
    if (!frame || frame.sequence === lastSeq) { await Bun.sleep(2); continue; }
    lastSeq = frame.sequence;
    tags?.submit(frame.sequence, frame.bgr, frame.width, frame.height);
    let detected: unknown[] = [];
    try {
      const result = letterbox(frame.bgr, frame.width, frame.height);
      detected = decodeDetect6(await model!.infer(result.rgb), result, classes, 0.4, 0.45, YOLO_LABELS);
    } catch (error) { if (frame.sequence % 30 === 1) console.error("inference failed:", error); }
    const detection = new TextEncoder().encode(JSON.stringify({ sequence: frame.sequence, timestamp: frame.capturedAt, width: frame.width, height: frame.height, boxes: detected, dropped: camera.dropped + window.dropped }));
    socket!.write(encodePacket(PacketType.Detection, detection));
    let image: Uint8Array;
    try { image = await perFrame.encode(frame.bgr); } catch { continue; }
    const payload = new Uint8Array(12 + image.length), view = new DataView(payload.buffer);
    view.setUint32(0, frame.sequence, true); view.setBigUint64(4, BigInt(frame.capturedAt), true); payload.set(image, 12);
    window.offer(frame.sequence, encodePacket(PacketType.Frame, payload));
    window.flush(data => socket!.write(data));
  }
}

async function main(): Promise<void> {
  // Connect IPC first so the server sees the worker alive before hardware starts
  socket = await connectIpc(config.socket);
  socket.on("data", (bytes) => {
    for (const packet of decoder.push(new Uint8Array(bytes as Buffer))) {
      if (packet.type === PacketType.Ack && packet.payload.length >= 4) {
        window.ack(new DataView(packet.payload.buffer, packet.payload.byteOffset).getUint32(0, true));
      }
      if (packet.type === PacketType.Control) {
        try {
          const command = JSON.parse(new TextDecoder().decode(packet.payload));
          if (command.type === "classes" && Array.isArray(command.ids)) {
            classes.clear();
            for (const id of command.ids) if (Number.isInteger(id) && id >= 0 && id < 80) classes.add(id);
          }
        } catch (error) { console.warn("invalid worker control", error); }
      }
    }
  });
  socket.on("close", () => { running = false; });
  socket.on("error", (error) => { console.error("IPC error", error); running = false; });

  if (previewOnly) await runPreview();
  else await runInferenceLoop();
}
try { await main(); } catch (e) { console.error("worker fatal:", e); } finally { shutdownNow(); }

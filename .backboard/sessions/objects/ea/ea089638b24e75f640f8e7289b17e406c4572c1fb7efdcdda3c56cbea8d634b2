import { connect } from "bun";
import { Camera } from "./camera";
import { loadConfig } from "./config";
import { PacketDecoder, PacketType, FrameWindow, encodePacket } from "./ipc";
import { letterbox } from "./preprocess";
import { RknnModel, NpuLock } from "./rknn";
import { decodeFp16 } from "./yolo";
import { TagHelper } from "./apriltag";

const config = loadConfig();
if (!config.model) throw new Error("KITTI_MODEL must identify an RKNN model");
const camera = new Camera({ device: config.camera === "auto" ? undefined : config.camera, width: config.width, height: config.height, fps: config.fps });
const model = new RknnModel(config.model);
const npuLock = new NpuLock();
const tags = new TagHelper();
const decoder = new PacketDecoder(), window = new FrameWindow();
const classes = new Set([0, 15, 16]);
let socket: Awaited<ReturnType<typeof connect>> | undefined, running = true;
process.once('SIGINT', () => { running = false; });
process.once('SIGTERM', () => { running = false; });

async function jpeg(bgr: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", `${config.width}x${config.height}`, "-i", "pipe:0", "-frames:v", "1", "-q:v", String(Math.max(2, Math.round((100 - config.jpegQuality) / 8))), "-f", "image2", "-vcodec", "mjpeg", "pipe:1"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  proc.stdin.write(bgr); proc.stdin.end();
  const bytes = await new Response(proc.stdout).arrayBuffer();
  if (await proc.exited !== 0) throw new Error("JPEG encoder failed");
  return new Uint8Array(bytes);
}

async function main(): Promise<void> {
  npuLock.acquire();
  await model.open(); await camera.start(); tags.start();
  socket = await connect({ unix: config.socket, socket: {
    data(_socket, bytes) {
      for (const packet of decoder.push(bytes)) {
        if (packet.type === PacketType.Ack && packet.payload.length >= 4) window.ack(new DataView(packet.payload.buffer, packet.payload.byteOffset).getUint32(0, true));
        if (packet.type === PacketType.Control) {
          try { const command = JSON.parse(new TextDecoder().decode(packet.payload)); if (command.type === "classes" && Array.isArray(command.ids)) { classes.clear(); for (const id of command.ids) if (Number.isInteger(id) && id >= 0 && id < 80) classes.add(id); } }
          catch (error) { console.warn("invalid worker control", error); }
        }
      }
    }, close() { running = false; }, error(_socket, error) { console.error("IPC error", error); running = false; }
  } });
  let lastSeq = 0;
  while (running) {
    const frame = camera.takeLatest();
    if (!frame || frame.sequence === lastSeq) { await Bun.sleep(2); continue; }
    lastSeq = frame.sequence;
    tags.submit(frame.sequence, frame.bgr, frame.width, frame.height);
    const result = letterbox(frame.bgr, frame.width, frame.height);
    const raw = await model.infer(result.rgb);
    const boxes = [...decodeFp16(raw, result, classes), ...tags.latest()];
    const detection = new TextEncoder().encode(JSON.stringify({ sequence: frame.sequence, timestamp: frame.capturedAt, width: frame.width, height: frame.height, boxes, dropped: camera.dropped + window.dropped }));
    socket.write(encodePacket(PacketType.Detection, detection));
    const image = await jpeg(frame.bgr);
    const payload = new Uint8Array(12 + image.length), view = new DataView(payload.buffer);
    view.setUint32(0, frame.sequence, true); view.setBigUint64(4, BigInt(frame.capturedAt), true); payload.set(image, 12);
    window.offer(frame.sequence, encodePacket(PacketType.Frame, payload));
    window.flush(data => socket!.write(data));
    if (window.stalled()) throw new Error("frame ack timeout");
  }
}
try { await main(); } finally { camera.stop(); tags.stop(); model.close(); socket?.end(); npuLock.release(); }

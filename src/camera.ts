export interface CameraFrame { sequence: number; capturedAt: number; width: number; height: number; bgr: Uint8Array; }
export interface CameraOptions { device?: string; width: number; height: number; fps: number; ffmpeg?: string; }

export class Camera {
  private proc?: ReturnType<typeof Bun.spawn>;
  private latest?: CameraFrame;
  private sequence = 0;
  private consumed = 0;
  private ended = false;
  dropped = 0;
  device?: string;
  private closed = false;
  constructor(private options: CameraOptions) {}
  async start(): Promise<void> {
    const devices = this.options.device ? [this.options.device] : Array.from({length: 6}, (_, i) => `/dev/video${i}`);
    for (const device of devices) {
      try {
        this.open(device);
        // Wait for the first frame; a dead device (missing node, driver
        // reject) exits fast, so bail as soon as the stream ends instead
        // of waiting out the whole deadline per device.
        const deadline = Date.now() + 3000;
        while (!this.latest && !this.ended && Date.now() < deadline) await Bun.sleep(10);
        if (this.latest) { this.device = device; return; }
      } catch { /* probe next */ }
      this.stop(); this.closed = false; this.latest = undefined; this.ended = false;
    }
    throw new Error(`no usable V4L2 capture node among ${devices.join(", ")}`);
  }
  private open(device: string): void {
    const { width, height, fps } = this.options;
    if (width < 1 || height < 1 || fps < 1) throw new Error("invalid camera dimensions or fps");
    const proc = Bun.spawn([
      this.options.ffmpeg ?? "ffmpeg",
      "-hide_banner", "-loglevel", "error",
      "-f", "v4l2",
      "-i", device,
      "-vf", `scale=${width}:${height},fps=${fps}`,
      "-pix_fmt", "bgr24",
      "-f", "rawvideo",
      "pipe:1",
    ], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    this.proc = proc;
    const stream = proc.stdout;
    if (!stream || typeof stream === "number") throw new Error("capture stdout unavailable");
    void this.readLoop(stream, width, height);
  }
  private async readLoop(stream: ReadableStream<Uint8Array>, width: number, height: number): Promise<void> {
    const reader = stream.getReader(), frameSize = width * height * 3;
    let acc = new Uint8Array(0);
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (acc.byteLength === 0) {
          acc = value.slice();
        } else {
          const merged = new Uint8Array(acc.byteLength + value.byteLength);
          merged.set(acc);
          merged.set(value, acc.byteLength);
          acc = merged;
        }
        while (acc.byteLength >= frameSize) {
          const bgr = acc.slice(0, frameSize);
          acc = acc.slice(frameSize);
          if (this.latest && this.latest.sequence !== this.consumed) this.dropped++;
          this.latest = { sequence: ++this.sequence, capturedAt: Date.now(), width, height, bgr };
        }
      }
    } catch (error) { if (!this.closed) console.error("camera read failed", error); }
    finally { this.ended = true; try { reader.releaseLock(); } catch { /* released */ } }
  }
  takeLatest(): CameraFrame | undefined { const frame = this.latest; if (frame) this.consumed = frame.sequence; return frame; }
  stop(): void {
    this.closed = true;
    if (this.proc) {
      try { this.proc.kill("SIGKILL"); } catch { /* already exited */ }
      this.proc = undefined;
    }
  }
}
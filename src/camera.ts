export interface CameraFrame { sequence: number; capturedAt: number; width: number; height: number; bgr: Uint8Array; }
export interface CameraOptions { device?: string; width: number; height: number; fps: number; ffmpeg?: string; }

export class Camera {
  private proc?: ReturnType<typeof Bun.spawn>;
  private latest?: CameraFrame;
  private sequence = 0;
  private consumed = 0;
  dropped = 0;
  device?: string;
  private closed = false;
  constructor(private options: CameraOptions) {}
  async start(): Promise<void> {
    const devices = this.options.device ? [this.options.device] : Array.from({length: 6}, (_, i) => `/dev/video${i}`);
    for (const device of devices) {
      try {
        await this.open(device);
        const deadline = Date.now() + 3000;
        while (!this.latest && Date.now() < deadline) await Bun.sleep(20);
        if (this.latest) { this.device = device; return; }
      } catch { /* Probe next capture node. */ }
      this.stop(); this.closed = false; this.latest = undefined;
    }
    throw new Error(`no usable V4L2 capture node among ${devices.join(", ")}`);
  }
  private async open(device: string): Promise<void> {
    const { width, height, fps } = this.options;
    if (width < 1 || height < 1 || fps < 1) throw new Error("invalid camera dimensions or fps");
    const proc = Bun.spawn([this.options.ffmpeg ?? "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "v4l2", "-i", device, "-vf", `crop='min(iw,ih*4/3)':'min(ih,iw*3/4)',scale=${width}:${height},fps=${fps}`, "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    this.proc = proc;
    const stream = proc.stdout;
    if (!stream || typeof stream === "number") throw new Error("capture stdout unavailable");
    void this.drainStderr(proc.stderr);
    void this.readLoop(stream, width, height);
  }
  private async drainStderr(stderr: ReadableStream<Uint8Array> | number | null): Promise<void> {
    if (!stderr || typeof stderr === "number") return;
    const reader = stderr.getReader();
    try { while (true) { const { done } = await reader.read(); if (done) break; } }
    catch { /* stderr closed */ }
    finally { try { reader.releaseLock(); } catch { /* already released */ } }
  }
  private async readLoop(stream: ReadableStream<Uint8Array>, width: number, height: number): Promise<void> {
    const reader = stream.getReader(), frameSize = width * height * 3;
    let frame = new Uint8Array(frameSize), used = 0;
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.length) {
          const n = Math.min(frameSize - used, value.length - offset);
          frame.set(value.subarray(offset, offset + n), used); used += n; offset += n;
          if (used === frameSize) {
            if (this.latest && this.latest.sequence !== this.consumed) this.dropped++;
            this.latest = { sequence: ++this.sequence, capturedAt: Date.now(), width, height, bgr: frame };
            frame = new Uint8Array(frameSize); used = 0;
          }
        }
      }
    } catch (error) { if (!this.closed) console.error("camera read failed", error); }
    finally { reader.releaseLock(); }
  }
  takeLatest(): CameraFrame | undefined { const frame = this.latest; if (frame) this.consumed = frame.sequence; return frame; }
  stop(): void {
    this.closed = true;
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* process already exited */ }
      this.proc = undefined;
    }
  }
}

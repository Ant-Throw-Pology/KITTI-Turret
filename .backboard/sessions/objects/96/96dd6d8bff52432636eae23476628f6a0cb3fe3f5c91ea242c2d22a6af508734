import { grayscale } from "./tag_worker";
import type { Detection } from "./yolo";

export class TagHelper {
  private child?: ReturnType<typeof Bun.spawn>;
  private busy = false;
  private pendingSequence = -1;
  private boxes: Detection[] = [];
  private line = "";
  constructor(private executable = "dist/tag-helper") {}
  start(): boolean {
    try {
      this.child = Bun.spawn([this.executable], { stdin: "pipe", stdout: "pipe", stderr: "inherit", detached: true });
      if (!this.child.stdout || typeof this.child.stdout === "number") throw new Error("tag stdout unavailable");
      void this.read(this.child.stdout);
      return true;
    } catch (error) { console.warn("tag detections disabled:", error); return false; }
  }
  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const bytes of stream) {
      this.line += new TextDecoder().decode(bytes);
      let end: number;
      while ((end = this.line.indexOf("\n")) >= 0) {
        const line = this.line.slice(0, end); this.line = this.line.slice(end + 1);
        try { const parsed = JSON.parse(line) as { sequence: number; boxes: Detection[] }; if (parsed.sequence === this.pendingSequence) this.boxes = parsed.boxes; }
        catch (error) { console.warn("tag result rejected", error); }
        this.busy = false;
      }
    }
    this.busy = false;
  }
  submit(sequence: number, bgr: Uint8Array, width: number, height: number): void {
    if (this.busy || !this.child?.stdin || typeof this.child.stdin === "number") return;
    const gray = grayscale(bgr, width, height), packet = new Uint8Array(12 + gray.length);
    const view = new DataView(packet.buffer);
    view.setUint32(0, sequence, true); view.setUint32(4, width, true); view.setUint32(8, height, true); packet.set(gray, 12);
    this.busy = true; this.pendingSequence = sequence;
    try { this.child.stdin.write(packet); this.child.stdin.flush(); }
    catch (error) { this.busy = false; console.warn("tag helper write failed", error); }
  }
  latest(): readonly Detection[] { return this.boxes; }
  stop(): void { if (this.child) { try { process.kill(-this.child.pid, "SIGTERM"); } catch { this.child.kill(); } this.child = undefined; } }
}

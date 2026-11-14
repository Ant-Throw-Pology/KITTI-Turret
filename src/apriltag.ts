import { buildTagFramePacket } from "./tag_worker";
import type { Detection } from "./yolo";

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

export function parseTagResultLine(line: string): { sequence: number; boxes: Detection[] } | undefined {
  const parsed = JSON.parse(line) as { sequence?: unknown; boxes?: unknown };
  if (!Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) < 0 || !Array.isArray(parsed.boxes)) return undefined;
  const boxes: Detection[] = [];
  for (const box of parsed.boxes) {
    if (!box || typeof box !== "object") return undefined;
    const candidate = box as Record<string, unknown>;
    if (typeof candidate.label !== "string" || !Number.isInteger(candidate.classId)) return undefined;
    if (![candidate.confidence, candidate.x, candidate.y, candidate.width, candidate.height].every(finite)) return undefined;
    if ((candidate.width as number) <= 0 || (candidate.height as number) <= 0) return undefined;
    boxes.push({
      label: candidate.label,
      classId: candidate.classId as number,
      confidence: candidate.confidence as number,
      x: candidate.x as number,
      y: candidate.y as number,
      width: candidate.width as number,
      height: candidate.height as number,
    });
  }
  return { sequence: parsed.sequence as number, boxes };
}

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
        try { const parsed = parseTagResultLine(line); if (parsed?.sequence === this.pendingSequence) this.boxes = parsed.boxes; }
        catch (error) { console.warn("tag result rejected", error); }
        this.busy = false;
      }
    }
    this.busy = false;
  }
  submit(sequence: number, bgr: Uint8Array, width: number, height: number): void {
    if (this.busy || !this.child?.stdin || typeof this.child.stdin === "number") return;
    const packet = buildTagFramePacket(sequence, bgr, width, height);
    this.busy = true; this.pendingSequence = sequence;
    try { this.child.stdin.write(packet); this.child.stdin.flush(); }
    catch (error) { this.busy = false; console.warn("tag helper write failed", error); }
  }
  latest(): readonly Detection[] { return this.boxes; }
  stop(): void { if (this.child) { try { process.kill(-this.child.pid, "SIGTERM"); } catch { this.child.kill(); } this.child = undefined; } }
}

import { dlopen, FFIType, ptr } from "bun:ffi";
import { openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from "node:fs";

export const RKNN_INPUT_SIZE = 32;
export const RKNN_OUTPUT_SIZE = 24;
export const RKNN_FP16_OUTPUT_BYTES = 84 * 8400 * 2;
export const RKNN_TENSOR_UINT8 = 3;
export const RKNN_TENSOR_NHWC = 1;

/* INT8 six-output layout: 3 strides × 2 tensors (box FP16 + score float32). */
export const RKNN_INT8_STRIDE_CELLS = [80 * 80, 40 * 40, 20 * 20] as const; // 6400, 1600, 400
/* Offset into the flat boxes array (64 channels × cumulative cells). */
export function rknnInt8BoxOffset(strideIndex: number): number {
  let offset = 0;
  for (let s = 0; s < strideIndex; s++) offset += 64 * RKNN_INT8_STRIDE_CELLS[s]!;
  return offset;
}
export const RKNN_INT8_TOTAL_BOX_WORDS = 64 * (80 * 80 + 40 * 40 + 20 * 20); // 64 × 8400

/** Detect output layout: FP16 (1 output of known size) or INT8 (6 outputs). */
export function detectRknnLayout(outputSizes: number[]): "fp16" | "int8" {
  if (outputSizes.length === 1 && outputSizes[0] === RKNN_FP16_OUTPUT_BYTES) return "fp16";
  if (outputSizes.length === 6) return "int8";
  throw new Error(`unrecognized RKNN output layout: ${outputSizes.length} outputs`);
}

export function packRknnInput(rgb: Uint8Array): Uint8Array {
  const input = new Uint8Array(RKNN_INPUT_SIZE), view = new DataView(input.buffer);
  view.setBigUint64(8, BigInt(ptr(rgb)), true);
  view.setUint32(16, rgb.length, true);
  view.setUint32(24, RKNN_TENSOR_UINT8, true);
  view.setUint32(28, RKNN_TENSOR_NHWC, true);
  return input;
}

export function readRknnOutput(output: Uint8Array): { native: bigint; size: number } {
  if (output.byteLength < RKNN_OUTPUT_SIZE) throw new Error("short RKNN output struct");
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  return { native: view.getBigUint64(8, true), size: view.getUint32(16, true) };
}

export class NpuLock {
  private held = false;
  constructor(private path = "/tmp/kitti-rknn.lock") {}
  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.path, "wx", 0o600);
        try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
        this.held = true; return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let pid = 0;
        try { pid = Number(readFileSync(this.path, "utf8").trim()); } catch { /* stale empty lock */ }
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); throw new Error(`NPU context owned by live PID ${pid}`); }
          catch (check) { if (!(check instanceof Error) || !('code' in check) || (check as NodeJS.ErrnoException).code !== "ESRCH") throw check; }
        }
        unlinkSync(this.path);
      }
    }
    throw new Error("could not acquire NPU lock");
  }
  release(): void {
    if (!this.held) return;
    try { if (Number(readFileSync(this.path, "utf8").trim()) === process.pid) unlinkSync(this.path); }
    finally { this.held = false; }
  }
}

/** RKNN runtime binding for the verified single-output FP16 layout. Native ABI must be checked on Pi. */
export class RknnModel {
  private lib: ReturnType<typeof dlopen>;
  private libc: ReturnType<typeof dlopen>;
  private context = new Uint8Array(8);
  private model?: Uint8Array;
  private runs = 0;
  private get native(): Record<string, (...args: any[]) => number> {
    // Bun's dlopen return type erases symbol signatures when retained in a class field.
    return this.lib.symbols as unknown as Record<string, (...args: any[]) => number>;
  }
  private get memory(): Record<string, (...args: any[]) => number> {
    return this.libc.symbols as unknown as Record<string, (...args: any[]) => number>;
  }
  constructor(private path: string, private recycleEvery = 1500) {
    this.lib = dlopen("/usr/lib/librknnrt.so", {
      rknn_init: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      rknn_inputs_set: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      rknn_run: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
      rknn_outputs_get: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      rknn_outputs_release: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      rknn_destroy: { args: [FFIType.u64], returns: FFIType.i32 },
    });
    this.libc = dlopen("libc.so.6", { memcpy: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr } });
  }
  private ctx(): bigint { return new DataView(this.context.buffer).getBigUint64(0, true); }
  async open(): Promise<void> {
    this.model = new Uint8Array(await Bun.file(this.path).arrayBuffer());
    if (this.model.length === 0) throw new Error("empty RKNN model");
    const rc = this.native.rknn_init!(ptr(this.context), ptr(this.model), this.model.length, 0, null);
    if (rc !== 0) throw new Error(`rknn_init failed: ${rc}`);
    this.runs = 0;
  }
  async infer(rgb: Uint8Array): Promise<Uint16Array> {
    if (rgb.length !== 640 * 640 * 3 || this.ctx() === 0n) throw new Error("invalid RKNN input or unopened model");
    const input = packRknnInput(rgb);
    let rc = this.native.rknn_inputs_set!(this.ctx(), 1, ptr(input));
    if (rc !== 0) throw new Error(`rknn_inputs_set failed: ${rc}`);
    rc = this.native.rknn_run!(this.ctx(), null);
    if (rc !== 0) throw new Error(`rknn_run failed: ${rc}`);
    const output = new Uint8Array(RKNN_OUTPUT_SIZE);
    rc = this.native.rknn_outputs_get!(this.ctx(), 1, ptr(output), null);
    if (rc !== 0) throw new Error(`rknn_outputs_get failed: ${rc}`);
    try {
      const { size, native } = readRknnOutput(output);
      if (size !== RKNN_FP16_OUTPUT_BYTES || native === 0n) throw new Error(`unsupported RKNN output size: ${size}`);
      const copy = new Uint8Array(size);
      this.memory.memcpy!(ptr(copy), native, size);
      return new Uint16Array(copy.buffer);
    } finally {
      this.native.rknn_outputs_release!(this.ctx(), 1, ptr(output));
      if (++this.runs >= this.recycleEvery) { this.close(); await this.open(); }
    }
  }
  close(): void { if (this.ctx() !== 0n) this.native.rknn_destroy!(this.ctx()); this.context.fill(0); }
}

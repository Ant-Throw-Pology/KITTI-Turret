import { dlopen, FFIType, ptr } from "bun:ffi";
import { openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from "node:fs";

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
    // rknn_input: uint32 index; void* buf; uint32 size; uint8 pass_through; enum type; enum fmt.
    const input = new Uint8Array(32), iv = new DataView(input.buffer);
    iv.setBigUint64(8, BigInt(ptr(rgb)), true); iv.setUint32(16, rgb.length, true);
    iv.setUint32(24, 3, true); // RKNN_TENSOR_UINT8
    iv.setUint32(28, 1, true); // RKNN_TENSOR_NHWC
    let rc = this.native.rknn_inputs_set!(this.ctx(), 1, ptr(input));
    if (rc !== 0) throw new Error(`rknn_inputs_set failed: ${rc}`);
    rc = this.native.rknn_run!(this.ctx(), null);
    if (rc !== 0) throw new Error(`rknn_run failed: ${rc}`);
    const output = new Uint8Array(24), ov = new DataView(output.buffer);
    rc = this.native.rknn_outputs_get!(this.ctx(), 1, ptr(output), null);
    if (rc !== 0) throw new Error(`rknn_outputs_get failed: ${rc}`);
    try {
      const size = ov.getUint32(16, true), native = ov.getBigUint64(8, true);
      if (size !== 84 * 8400 * 2 || native === 0n) throw new Error(`unsupported RKNN output size: ${size}`);
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

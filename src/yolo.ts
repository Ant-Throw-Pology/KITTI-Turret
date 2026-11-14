import type { LetterboxResult } from "./preprocess";

export interface Detection { label: string; classId: number; confidence: number; x: number; y: number; width: number; height: number; }
const half = new Float32Array(65536);
for (let i = 0; i < 65536; i++) {
  const s = (i & 0x8000) ? -1 : 1, e = (i >>> 10) & 31, m = i & 1023;
  half[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}
export function fp16Table(): Float32Array { return half; }
export function iou(a: Detection, b: Detection): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
}
export function nms(boxes: Detection[], threshold: number): Detection[] {
  const sorted = boxes.sort((a, b) => b.confidence - a.confidence), keep: Detection[] = [];
  for (const box of sorted) if (!keep.some(k => k.classId === box.classId && iou(k, box) > threshold)) keep.push(box);
  return keep;
}

/** A single stride input for INT8 six-output decode. Box and score tensors are already dequantized to float32. */
export interface Int8StrideInput {
  /** Number of grid cells (H × W) at this stride. */
  cells: number;
  /** Box regression (4 × cells): cx, cy, w, h in 640×640 pixel space, row-major. */
  box: Float32Array;
  /** Class scores (80 × cells): per-class logits, row-major. */
  score: Float32Array;
}

/**
 * Decodes INT8 YOLO six-output layout: three strides (e.g. 32, 16, 8), each
 * with a box tensor (cx, cy, w, h in 640-pixel space) and a class-score tensor
 * (80 logits per cell). The RKNN runtime or model export is assumed to have
 * baked DFL into the box coordinates and to deliver both tensors as float32.
 *
 * The three stride inputs cover 20×20 + 40×40 + 80×80 = 8400 cells, matching
 * the single-output FP16 layout.
 */
export function decodeInt8(
  inputs: [Int8StrideInput, Int8StrideInput, Int8StrideInput],
  meta: LetterboxResult,
  classIds: ReadonlySet<number>,
  confidence = 0.4,
  nmsIou = 0.45,
  labels?: readonly string[],
): Detection[] {
  const all: Detection[] = [];
  for (const { cells, box, score } of inputs) {
    if (box.length < 4 * cells || score.length < 80 * cells) continue;
    for (let idx = 0; idx < cells; idx++) {
      let best = -1, bestScore = confidence;
      for (const id of classIds) {
        if (!Number.isInteger(id) || id < 0 || id >= 80) continue;
        const p = 1 / (1 + Math.exp(-score[id * cells + idx]!));
        if (p > bestScore) { bestScore = p; best = id; }
      }
      if (best < 0) continue;
      const cx = box[idx]!, cy = box[cells + idx]!, w = box[2 * cells + idx]!, h = box[3 * cells + idx]!;
      if (![cx, cy, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      const x0 = Math.max(0, Math.min(meta.sourceWidth, (cx - w / 2 - meta.padX) / meta.scale));
      const y0 = Math.max(0, Math.min(meta.sourceHeight, (cy - h / 2 - meta.padY) / meta.scale));
      const x1 = Math.max(0, Math.min(meta.sourceWidth, (cx + w / 2 - meta.padX) / meta.scale));
      const y1 = Math.max(0, Math.min(meta.sourceHeight, (cy + h / 2 - meta.padY) / meta.scale));
      if (x1 > x0 && y1 > y0) all.push({ label: labels?.[best] ?? String(best), classId: best, confidence: bestScore, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
  }
  return nms(all, nmsIou);
}

/** Decodes row-major (1,84,8400) FP16 output; in-graph scores are already sigmoid. */
export function decodeFp16(output: Uint16Array, meta: LetterboxResult, classIds: ReadonlySet<number>, confidence = 0.4, nmsIou = 0.45, labels?: readonly string[]): Detection[] {
  const count = 8400, rows = 84;
  if (output.length !== rows * count) throw new Error(`expected ${rows * count} FP16 elements, got ${output.length}`);
  const boxes: Detection[] = [];
  for (let i = 0; i < count; i++) {
    let best = -1, score = confidence;
    for (const id of classIds) {
      if (!Number.isInteger(id) || id < 0 || id >= 80) continue;
      const p = half[output[(id + 4) * count + i]!]!;
      if (p > score) { score = p; best = id; }
    }
    if (best < 0) continue;
    const cx = half[output[i]!]!, cy = half[output[count + i]!]!, w = half[output[2 * count + i]!]!, h = half[output[3 * count + i]!]!;
    if (![cx, cy, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const x0 = Math.max(0, Math.min(meta.sourceWidth, (cx - w / 2 - meta.padX) / meta.scale));
    const y0 = Math.max(0, Math.min(meta.sourceHeight, (cy - h / 2 - meta.padY) / meta.scale));
    const x1 = Math.max(0, Math.min(meta.sourceWidth, (cx + w / 2 - meta.padX) / meta.scale));
    const y1 = Math.max(0, Math.min(meta.sourceHeight, (cy + h / 2 - meta.padY) / meta.scale));
    if (x1 > x0 && y1 > y0) boxes.push({ label: labels?.[best] ?? String(best), classId: best, confidence: score, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return nms(boxes, nmsIou);
}
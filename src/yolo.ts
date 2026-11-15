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

/** Decodes the 6-output YOLO26 RKNN export: for each stride (8,16,32) a box
 *  tensor [1,4,H,W] of left/top/right/bottom distances and a class tensor
 *  [1,80,H,W] of RAW class logits (the exported head has no in-graph sigmoid,
 *  so scores must be sigmoid-activated before thresholding). Outputs are
 *  float32 (the runtime dequantizes when want_float=1). */
export function decodeDetect6(outputs: Float32Array[], meta: LetterboxResult, classIds: ReadonlySet<number>, confidence = 0.4, nmsIou = 0.45, labels?: readonly string[]): Detection[] {
  if (outputs.length !== 6) throw new Error(`expected 6 outputs, got ${outputs.length}`);
  const scales: Array<[number, number, number, number]> = [
    [8, 80, 80, 0], [16, 40, 40, 2], [32, 20, 20, 4],
  ];
  const boxes: Detection[] = [];
  for (const [stride, w, h, base] of scales) {
    const box = outputs[base]!, cls = outputs[base + 1]!;
    const area = w * h;
    if (box.length < 4 * area || cls.length < 80 * area) continue;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = y * w + x;
        let best = -1, score = confidence;
        for (const id of classIds) {
          if (!Number.isInteger(id) || id < 0 || id >= 80) continue;
          const p = 1 / (1 + Math.exp(-cls[id * area + cell]!));
          if (p > score) { score = p; best = id; }
        }
        if (best < 0) continue;
        const l = box[0 * area + cell]!, t = box[1 * area + cell]!, r = box[2 * area + cell]!, b = box[3 * area + cell]!;
        const cx = (x + 0.5) * stride, cy = (y + 0.5) * stride;
        const x0 = Math.max(0, Math.min(meta.sourceWidth, (cx - l * stride - meta.padX) / meta.scale));
        const y0 = Math.max(0, Math.min(meta.sourceHeight, (cy - t * stride - meta.padY) / meta.scale));
        const x1 = Math.max(0, Math.min(meta.sourceWidth, (cx + r * stride - meta.padX) / meta.scale));
        const y1 = Math.max(0, Math.min(meta.sourceHeight, (cy + b * stride - meta.padY) / meta.scale));
        if (x1 > x0 && y1 > y0) boxes.push({ label: labels?.[best] ?? String(best), classId: best, confidence: score, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      }
    }
  }
  return nms(boxes, nmsIou);
}

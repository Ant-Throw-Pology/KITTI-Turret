import type { Detection } from "./yolo";

/** Optional saved-image annotation; normal streaming never calls this. */
export function rectangleOverlay(rgb: Uint8Array, width: number, height: number, boxes: readonly Detection[]): Uint8Array {
  const out = rgb.slice();
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(width - 1, Math.ceil(b.x + b.width)), y1 = Math.min(height - 1, Math.ceil(b.y + b.height));
    for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) { const p = (y * width + x) * 3; out[p] = 255; out[p + 1] = 0; out[p + 2] = 0; }
    for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) { const p = (y * width + x) * 3; out[p] = 255; out[p + 1] = 0; out[p + 2] = 0; }
  }
  return out;
}

export interface LetterboxResult {
  rgb: Uint8Array;
  scale: number;
  padX: number;
  padY: number;
  sourceWidth: number;
  sourceHeight: number;
}

/** Nearest-neighbor BGR24 to RGB NHWC letterbox. A fixed 640 square matches the model. */
export function letterbox(bgr: Uint8Array, width: number, height: number, size = 640): LetterboxResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || bgr.length !== width * height * 3) throw new Error("invalid BGR frame");
  const scale = Math.min(size / width, size / height);
  const outW = Math.round(width * scale), outH = Math.round(height * scale);
  const padX = Math.floor((size - outW) / 2), padY = Math.floor((size - outH) / 2);
  const rgb = new Uint8Array(size * size * 3);
  rgb.fill(114);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const src = (sy * width + sx) * 3, dst = ((y + padY) * size + x + padX) * 3;
      rgb[dst] = bgr[src + 2]!; rgb[dst + 1] = bgr[src + 1]!; rgb[dst + 2] = bgr[src]!;
    }
  }
  return { rgb, scale, padX, padY, sourceWidth: width, sourceHeight: height };
}

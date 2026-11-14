/** Compile on the target with: cc -O2 src/apriltag_ffi.c -lapriltag -o dist/tag-helper */
export function grayscale(bgr: Uint8Array, width: number, height: number): Uint8Array {
  if (bgr.length !== width * height * 3) throw new Error("invalid BGR frame");
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < gray.length; i += 3, j++) gray[j] = Math.round((29 * bgr[i]! + 150 * bgr[i + 1]! + 77 * bgr[i + 2]!) / 256);
  return gray;
}

export function buildTagFramePacket(sequence: number, bgr: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error("invalid tag frame sequence");
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 0xffffffff || height > 0xffffffff) throw new Error("invalid tag frame dimensions");
  const gray = grayscale(bgr, width, height), packet = new Uint8Array(12 + gray.length);
  const view = new DataView(packet.buffer);
  view.setUint32(0, sequence, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  packet.set(gray, 12);
  return packet;
}

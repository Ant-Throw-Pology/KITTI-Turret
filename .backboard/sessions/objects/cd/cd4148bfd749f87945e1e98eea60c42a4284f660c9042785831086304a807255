/** Compile on the target with: cc -O2 src/apriltag_ffi.c -lapriltag -o dist/tag-helper */
export function grayscale(bgr: Uint8Array, width: number, height: number): Uint8Array {
  if (bgr.length !== width * height * 3) throw new Error("invalid BGR frame");
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < gray.length; i += 3, j++) gray[j] = Math.round((29 * bgr[i]! + 150 * bgr[i + 1]! + 77 * bgr[i + 2]!) / 256);
  return gray;
}

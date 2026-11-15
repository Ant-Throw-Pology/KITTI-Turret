import { expect, test } from "bun:test";
import { letterbox } from "../src/preprocess";
import { decodeFp16, decodeDetect6, fp16Table, nms } from "../src/yolo";
import { grayscale } from "../src/tag_worker";
import { NpuLock } from "../src/rknn";
import { existsSync } from "node:fs";

test("letterbox swaps BGR and centers aspect ratio", () => {
  const image = letterbox(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1, 4);
  expect([image.scale, image.padY]).toEqual([2, 1]);
  expect(Array.from(image.rgb.slice(12, 18))).toEqual([3, 2, 1, 3, 2, 1]);
});
test("FP16 lookup covers normal values", () => {
  expect(fp16Table()[0x3c00]).toBe(1);
  expect(fp16Table()[0xc000]).toBe(-2);
});
test("NMS is class scoped", () => {
  const a = {label:"a", classId:1, confidence:0.9, x:0,y:0,width:10,height:10};
  expect(nms([a, {...a, confidence:0.8}, {...a, classId:2}], 0.5)).toHaveLength(2);
});
test("decoder rejects invalid output", () => {
  const meta = letterbox(new Uint8Array(3), 1, 1);
  expect(() => decodeFp16(new Uint16Array(0), meta, new Set([0]))).toThrow();
});
test("grayscale length", () => expect(grayscale(new Uint8Array([0,0,0]),1,1)).toEqual(new Uint8Array([0])));
test("NPU lock rejects a second owner and releases", () => {
  const path = `/tmp/kitti-npu-test-${process.pid}-${Math.random()}.lock`;
  const first = new NpuLock(path), second = new NpuLock(path);
  try { first.acquire(); expect(() => second.acquire()).toThrow(/live PID/); }
  finally { first.release(); }
  expect(existsSync(path)).toBe(false);
});

test("decodeDetect6 sigmoid-activates logits and emits class-name labels", () => {
  // One stride-32 cell (grid 0,0) with a positive person logit; all others negative.
  const mk = (n: number) => new Float32Array(n).fill(-20);
  const box8 = mk(4 * 80 * 80), cls8 = mk(80 * 80 * 80);
  const box16 = mk(4 * 40 * 40), cls16 = mk(80 * 40 * 40);
  const box32 = mk(4 * 20 * 20), cls32 = mk(80 * 20 * 20);
  cls32[0] = 1.5; // class 0, cell 0 -> sigmoid(1.5) = 0.82
  // box tensor is channel-major [4,20,20]: channel c lives at c*area + cell
  box32[0] = 1; box32[400] = 1; box32[800] = 1; box32[1200] = 1;
  const meta = { rgb: new Uint8Array(0), scale: 1, padX: 0, padY: 0, sourceWidth: 640, sourceHeight: 640 };
  const labels = ["person", "bicycle", "car"];
  const dets = decodeDetect6([box8, cls8, box16, cls16, box32, cls32], meta, new Set([0, 15, 16]), 0.4, 0.45, labels);
  expect(dets.length).toBe(1);
  expect(dets[0]!.label).toBe("person");
  expect(dets[0]!.confidence).toBeGreaterThan(0.8);
  expect(dets[0]!.confidence).toBeLessThan(0.9);
});

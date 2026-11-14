import { expect, test } from "bun:test";
import { letterbox } from "../src/preprocess";
import { decodeFp16, fp16Table, nms } from "../src/yolo";
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

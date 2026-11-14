import { expect, test } from "bun:test";
import { letterbox } from "../src/preprocess";
import { decodeFp16, decodeInt8, fp16Table, nms } from "../src/yolo";
import type { Int8StrideInput } from "../src/yolo";
import { buildTagFramePacket, grayscale } from "../src/tag_worker";
import { NpuLock, packRknnInput, readRknnOutput, RKNN_FP16_OUTPUT_BYTES, RKNN_INPUT_SIZE, RKNN_OUTPUT_SIZE, RKNN_TENSOR_NHWC, RKNN_TENSOR_UINT8 } from "../src/rknn";
import { APRILTAG_CLASS_ID_OFFSET, apriltagClassId, parseTagResultLine } from "../src/apriltag";
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
test("RKNN input and output struct packing matches the audited offsets", () => {
  const rgb = new Uint8Array([1, 2, 3]), input = packRknnInput(rgb), view = new DataView(input.buffer);
  expect(input).toHaveLength(RKNN_INPUT_SIZE);
  expect(view.getUint32(0, true)).toBe(0);
  expect(view.getBigUint64(8, true)).toBeGreaterThan(0n);
  expect(view.getUint32(16, true)).toBe(rgb.length);
  expect(view.getUint32(24, true)).toBe(RKNN_TENSOR_UINT8);
  expect(view.getUint32(28, true)).toBe(RKNN_TENSOR_NHWC);
  const output = new Uint8Array(RKNN_OUTPUT_SIZE), ov = new DataView(output.buffer);
  ov.setBigUint64(8, 0x1234n, true); ov.setUint32(16, RKNN_FP16_OUTPUT_BYTES, true);
  expect(readRknnOutput(output)).toEqual({ native: 0x1234n, size: RKNN_FP16_OUTPUT_BYTES });
  expect(() => readRknnOutput(new Uint8Array(RKNN_OUTPUT_SIZE - 1))).toThrow(/short/);
});
test("AprilTag frame packet uses a 12-byte little-endian header plus grayscale payload", () => {
  const packet = buildTagFramePacket(7, new Uint8Array([0, 255, 0, 255, 0, 0]), 2, 1);
  const view = new DataView(packet.buffer);
  expect(packet).toHaveLength(14);
  expect(view.getUint32(0, true)).toBe(7);
  expect(view.getUint32(4, true)).toBe(2);
  expect(view.getUint32(8, true)).toBe(1);
  expect([...packet.slice(12)]).toEqual([149, 29]);
  expect(() => buildTagFramePacket(-1, new Uint8Array(3), 1, 1)).toThrow(/sequence/);
  expect(() => buildTagFramePacket(1, new Uint8Array(3), 0, 1)).toThrow(/dimensions/);
  expect(() => buildTagFramePacket(1, new Uint8Array(2), 1, 1)).toThrow(/BGR/);
});
test("AprilTag result parser accepts only the detection contract", () => {
  expect(APRILTAG_CLASS_ID_OFFSET).toBe(1000);
  expect(apriltagClassId(1)).toBe(1001);
  expect(() => apriltagClassId(-1)).toThrow(/AprilTag/);
  const valid = parseTagResultLine(JSON.stringify({ sequence: 9, boxes: [{ label: "tag:1", classId: apriltagClassId(1), confidence: 1, x: 2, y: 3, width: 4, height: 5 }] }));
  expect(valid?.sequence).toBe(9);
  expect(valid?.boxes[0]).toMatchObject({ label: "tag:1", classId: 1001, width: 4 });
  expect(parseTagResultLine(JSON.stringify({ sequence: -1, boxes: [] }))).toBeUndefined();
  expect(parseTagResultLine(JSON.stringify({ sequence: 1, boxes: [{ label: "tag", classId: -1, confidence: 1, x: 0, y: 0, width: 1, height: 1 }] }))).toBeUndefined();
  expect(parseTagResultLine(JSON.stringify({ sequence: 1, boxes: [{ label: "tag", classId: 1, confidence: 1, x: 0, y: 0, width: 0, height: 1 }] }))).toBeUndefined();
  expect(() => parseTagResultLine("not json")).toThrow();
});
test("NPU lock rejects a second owner and releases", () => {
  const path = `/tmp/kitti-npu-test-${process.pid}-${Math.random()}.lock`;
  const first = new NpuLock(path), second = new NpuLock(path);
  try { first.acquire(); expect(() => second.acquire()).toThrow(/live PID/); }
  finally { first.release(); }
  expect(existsSync(path)).toBe(false);
});
test("INT8 six-output decoder returns nothing for all background", () => {
  const cells = 20 * 20;
  const box = new Float32Array(64 * cells);
  const score = new Float32Array(80 * cells);
  score.fill(-10); box.fill(0);
  const meta = letterbox(new Uint8Array(640 * 480 * 3), 640, 480);
  const result = decodeInt8([{ cells, box, score }, { cells: 40 * 40, box: new Float32Array(64 * 40 * 40), score: new Float32Array(80 * 40 * 40) }, { cells: 80 * 80, box: new Float32Array(64 * 80 * 80), score: new Float32Array(80 * 80 * 80) }], meta, new Set([0]));
  expect(result).toHaveLength(0);
});
test("INT8 six-output decoder finds a detection from a single stride", () => {
  const gw = 640 / 32, gh = 640 / 32, cells = gh * gw;
  const box = new Float32Array(64 * cells);
  const score = new Float32Array(80 * cells);
  score.fill(-10); box.fill(0);
  const cellIdx = 10 * gw + 10;
  // Set box channels 0-3 at the chosen cell
  box[cellIdx] = 100;          // cx
  box[cells + cellIdx] = 110;  // cy
  box[2 * cells + cellIdx] = 20;  // w
  box[3 * cells + cellIdx] = 30;  // h
  score[0 * cells + cellIdx] = 0.95;  // class 0 score
  const meta = letterbox(new Uint8Array(640 * 480 * 3), 640, 480);
  const result = decodeInt8([{ cells, box, score }, { cells: 0, box: new Float32Array(0), score: new Float32Array(0) }, { cells: 0, box: new Float32Array(0), score: new Float32Array(0) }], meta, new Set([0, 1]));
  expect(result.length).toBeGreaterThanOrEqual(1);
  expect(result[0]!.classId).toBe(0);
  expect(result[0]!.confidence).toBe(0.95);
});

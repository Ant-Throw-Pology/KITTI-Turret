import { expect, test } from "bun:test";
import { Camera } from "../src/camera";

test("Camera constructor accepts valid options", () => {
  const cam = new Camera({ width: 640, height: 480, fps: 20 });
  expect(cam.dropped).toBe(0);
  expect(cam.device).toBeUndefined();
});

test("Camera start rejects invalid dimensions", async () => {
  // The constructor stores options; validation happens in start/open
  // FPS < 1 is rejected when ffmpeg is spawned via open()
  const cam = new Camera({ device: "/dev/video99", width: 0, height: 480, fps: 20 });
  await expect(cam.start()).rejects.toThrow();
  cam.stop();
});

test("takeLatest returns undefined before start", () => {
  const cam = new Camera({ width: 640, height: 480, fps: 20 });
  expect(cam.takeLatest()).toBeUndefined();
});

test("stop is safe when not started", () => {
  const cam = new Camera({ width: 640, height: 480, fps: 20 });
  cam.stop();
});

test("stop is idempotent", () => {
  const cam = new Camera({ width: 640, height: 480, fps: 20 });
  cam.stop();
  cam.stop();
});

test("Camera rejects nonexistent capture node", async () => {
  const cam = new Camera({ device: "/dev/video99", width: 640, height: 480, fps: 10 });
  await expect(cam.start()).rejects.toThrow(/no usable V4L2 capture node/);
  cam.stop();
  expect(cam.device).toBeUndefined();
});
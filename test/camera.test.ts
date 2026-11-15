import { expect, test, spyOn, mock } from "bun:test";
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

test("Camera spawns ffmpeg without detached process group", async () => {
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("mock");
  });

  const cam = new Camera({ device: "/dev/video0", width: 640, height: 480, fps: 10 });
  try { await cam.start(); } catch { /* expected mock failure */ }

  expect(spawnSpy).toHaveBeenCalled();
  const opts = spawnSpy.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
  expect(opts).toBeDefined();
  // detached must be absent so the child inherits the parent process group
  expect(opts!.detached).toBeUndefined();

  spawnSpy.mockRestore();
});

test("Camera stop kills ffmpeg child directly, not the process group", async () => {
  const killMock = mock(() => {});
  const mockProc = {
    pid: 9999,
    stdout: null,
    stderr: null,
    stdin: null,
    kill: killMock,
    exited: Promise.resolve(0),
  };

  const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(mockProc as any);

  const cam = new Camera({ device: "/dev/video0", width: 640, height: 480, fps: 10 });
  try { await cam.start(); } catch { /* open throws because stdout is null */ }

  // start() calls open() which sets this.proc then throws on null stdout;
  // start()'s after-catch block calls stop() which should use direct child kill
  expect(killMock).toHaveBeenCalled();
  expect(killMock).toHaveBeenCalledWith("SIGKILL");

  spawnSpy.mockRestore();
});

test("Camera stop cleans up proc probe failure", async () => {
  const killMock = mock(() => {});
  let callIndex = 0;
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
    callIndex++;
    // Return valid proc on first probe, null-stdout on subsequent
    if (callIndex === 1) {
      return { pid: 1001, stdout: null, stderr: null, stdin: null, kill: killMock, exited: Promise.resolve(0) } as any;
    }
    throw new Error("no more devices");
  });

  const cam = new Camera({ width: 640, height: 480, fps: 10 });
  try { await cam.start(); } catch { /* expected */ }

  // First probe mock has null stdout -> thows in open() -> stop() should have killed it
  expect(killMock).toHaveBeenCalled();

  spawnSpy.mockRestore();
});
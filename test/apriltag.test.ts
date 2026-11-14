import { expect, test, spyOn, mock } from "bun:test";
import { TagHelper } from "../src/apriltag";

test("TagHelper constructor takes default executable path", () => {
  const helper = new TagHelper();
  // verify it doesn't crash
  helper.stop();
});

test("TagHelper start spawns without detached process group", () => {
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("mock");
  });

  const helper = new TagHelper("test-helper");
  const result = helper.start();

  expect(result).toBe(false); // caught error -> returns false
  expect(spawnSpy).toHaveBeenCalled();
  const opts = spawnSpy.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
  expect(opts).toBeDefined();
  // detached must be absent so the child inherits the parent process group
  expect(opts!.detached).toBeUndefined();

  spawnSpy.mockRestore();
});

test("TagHelper start kills orphaned child when stdout check fails", () => {
  const killMock = mock(() => {});
  const mockProc = {
    pid: 1234,
    stdout: null,
    stderr: null,
    stdin: null,
    kill: killMock,
    exited: Promise.resolve(0),
  };

  const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(mockProc as any);

  const helper = new TagHelper("test-helper");
  const result = helper.start();

  // stdout is null -> start should kill the child and return false
  expect(result).toBe(false);
  expect(killMock).toHaveBeenCalled();

  spawnSpy.mockRestore();
});

test("TagHelper stop kills child directly with SIGTERM", () => {
  const killMock = mock(() => {});
  // Use a real ReadableStream so for-await iteration works
  const mockStdout = new ReadableStream({ start(c) { c.close(); } });
  const mockStderr = new ReadableStream({ start(c) { c.close(); } });
  const mockStdin = { write: () => 0, flush: () => {} };

  const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
    pid: 1236,
    stdout: mockStdout,
    stderr: mockStderr,
    stdin: mockStdin,
    kill: killMock,
    exited: Promise.resolve(0),
  } as any);

  const helper = new TagHelper("test-helper");
  expect(helper.start()).toBe(true);

  helper.stop();
  // Must call child.kill("SIGTERM") — not process.kill(-pid)
  expect(killMock).toHaveBeenCalledWith("SIGTERM");

  spawnSpy.mockRestore();
});

test("TagHelper stop is safe when not started", () => {
  const helper = new TagHelper();
  helper.stop();
  helper.stop(); // idempotent
});
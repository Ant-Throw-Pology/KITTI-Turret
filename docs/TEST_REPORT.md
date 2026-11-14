# Local test report — 2026-11-14

Environment: x86_64 development sandbox, Bun 1.4.4. No Orange Pi, camera, NPU, GPIO, relay, motors, or browser attached.

| Command | Observed result |
| --- | --- |
| `bun test` | 14 passed, 1 skipped, 0 failed; 31 assertions, 96 ms total at first run. |
| `bun run build` | Passed after dependencies became available: three Bun entrypoints and the browser client bundled. |
| `bun run typecheck` | `bun check` runs but reports 33 source errors in `src/gpio.ts`, `src/rknn.ts`, and `src/index.ts`; the two errors in this test file were fixed. |
| `KITTI_TEST_SOCKET=1 bun test test/soak.test.ts` | One pass, one fail: Unix listener creation returns `EPERM`. Python `socket.AF_UNIX.bind` independently returns `PermissionError: [Errno 1] Operation not permitted`. |
| `KITTI_MOCK=1 KITTI_RELAY_ACTIVE_HIGH=1 KITTI_YAW_NEGATIVE_SWITCH=GPIO1_B6 bun dist/index.js` | Exits with `EPERM` for both the Unix IPC listener and `Bun.serve` TCP listen. HTTP/WebSocket runtime smoke is blocked by this environment. |

The in-memory ACK-window stress test offered 100,000 one-byte frames in 21 ms, dropped 99,996 queued frames, and observed at most two in flight. This verifies the bounded data structure only; it is not a network, process, or hour-long soak. The Unix socket test is marked skipped by default and can be run on a host allowing socket creation with `KITTI_TEST_SOCKET=1 bun test test/soak.test.ts`.

Pump timing: the fake relay timeout unit test completed, but no timing error distribution was measured. Hardware pump timing, relay polarity, e-stop response time, process cleanup, WebRTC, image alignment, FPS, latency, memory stability, and NPU stalls remain unverified.

Blockers: socket binding is denied by the runtime sandbox, the existing `.git` directory is read-only, GitHub API access is unavailable, and no Pi is connected. No hardware result should be inferred from the local tests.
# Pi access attempt, 2026-11-14

`ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=5 antthrowpology@10.67.0.1 ...` failed before connecting: `socket: Operation not permitted`. The sandbox disallows outbound sockets, so no Pi observation was made. The initial SSH attempt without `-F /dev/null` was also blocked by permissions on the host SSH config. Hardware gates remain unverified.

The project typecheck command is now `bun check`. It still reports missing Bun types because dependency installation is blocked in this sandbox.


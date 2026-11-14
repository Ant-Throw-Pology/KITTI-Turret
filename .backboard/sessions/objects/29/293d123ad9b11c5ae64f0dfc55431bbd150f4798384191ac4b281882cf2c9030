# Verification report — 2026-11-14

Development machine: x86_64, Bun 1.4.4. Target: Orange Pi 5, aarch64, Bun 1.4.4, reached through `ssh -F /dev/null antthrowpology@10.67.0.1`.

| Command | Observed result |
| --- | --- |
| `bun install` | Completed; `bun.lock` committed. |
| `bun check` | No type errors in 27 files. |
| `bun run build` | Bundled server, worker, tag helper, and browser client. |
| `bun test` | 14 pass, 1 skipped by default. |
| `KITTI_TEST_SOCKET=1 bun test test/soak.test.ts` | 2 pass. 5,000 frames offered through a Unix socket; 4 ACKed, 4,996 dropped as designed, maximum 2 in flight, approximately 12 ms, 16 MB RSS change during the short test. |
| Built server smoke | `/` and `/dist/client.js`: HTTP 200. WebSocket ping received pong. After correcting `VideoPeer.close()`, the WebSocket round trip and Ctrl+C shutdown both completed without an error. |

The in-memory ACK window test offered 100,000 frames in about 14 ms, dropped 99,996, and kept at most two in flight. This is a short queue test, not a one-hour soak.

## Read-only Orange Pi observations

- `uname -m`: `aarch64`; `bun --version`: `1.4.4`.
- `/usr/lib/librknnrt.so` exists (7,259,064 bytes). `/lib/aarch64-linux-gnu/libgpiod.so.3` exists and resolves to `libgpiod.so.3.1.1`. `libgpiod-dev` headers are not installed. `libapriltag-dev` 3.4.2-1+b2 and the shared library are installed.
- The login user belongs to `gpio` and `video` groups. `/dev/gpiochip0` through `5` exist.
- `/dev/video0` produced one 640×480 BGR frame (921,600 bytes) with ffmpeg. `/dev/video1` produced no frame and failed `VIDIOC_G_INPUT`.
- These observations did not run the application worker, NPU, WebRTC, GPIO outputs, or pump.

Pump pulse timing, relay polarity, switch mapping, e-stop response time, motor pulse count, browser video/overlay alignment, FPS, latency, memory stability, NPU stalls, and a one-hour soak remain unverified. No actuation was attempted.

# Verification report — 2026-11-14

Development machine: x86_64, Bun 1.4.4. Target: Orange Pi 5, aarch64, Bun 1.4.4, reached through `ssh -F /dev/null antthrowpology@10.67.0.1`.

## Local worktree results

| Command | Observed result |
| --- | --- |
| `bun check` | No type errors in 33 files. |
| `bun test` | 27 pass, 1 skipped by default, 0 fail (28 tests across 5 files). |
| `KITTI_TEST_SOCKET=1 bun test test/soak.test.ts` | 2 pass. 5,000 frames offered through a Unix socket: 4 ACKed, 4,996 dropped as designed, maximum 2 in flight, approximately 16 ms, 16.1 MB RSS change during the short test. |
| `bun run build` | Bundled `dist/index.js`, `worker.js`, `tag_worker.js`, `npu_smoke.js`, `gpio_read.js`, `client.js`; copied `index.html`, `style.css`, and `apriltag_ffi.c`. |
| In-memory ACK window test | 100,000 frames offered in about 16 ms, 99,996 dropped, maximum 2 in flight. This is a short queue test, not a sustained soak. |

The build removes stale `dist/` contents before bundling, so the six JavaScript entry points and three copied assets above are the complete build output.

## Supplied Orange Pi observations

These results were supplied by the orchestrator and are reported without extrapolation.

| Check | Observed result |
| --- | --- |
| Single FP16 inference | 705,600 output elements / 1,411,200 bytes. |
| 100 inference runs | Average 55.6 ms; minimum 45.0 ms; maximum 210.2 ms. |
| GPIO input read | `GPIO1_B6` and `GPIO1_B7` both returned false. This exercised the target libgpiod input binding and chip mapping for those two lines. Output writes, relay polarity, and other pins remain unverified. |
| AprilTag shim | Compiled against Debian 3.4.2; blank frame sequence 7 returned no boxes. |
| 11,000-run NPU soak | Completed successfully. Average 56.9 ms, minimum 43.1 ms, maximum 254.3 ms; approximate inference duration 625.9 seconds (10 minutes 26 seconds). Output remained 705,600 elements / 1,411,200 bytes. The run crossed seven 1,500-run recycle boundaries. The command exited zero and the PID lock was absent afterward. Final `thermal_zone0` reading was 36,076 millidegrees C. Mid-run at about 2:05 elapsed, RSS was 101,344 KiB and temperature was 34,230 millidegrees C. |

The 11,000-run result is an **NPU inference soak only**. It is not the required one-hour full-stack soak.

## Earlier read-only Orange Pi observations

- `uname -m`: `aarch64`; `bun --version`: `1.4.4`.
- `/usr/lib/librknnrt.so` exists (7,259,064 bytes). `/lib/aarch64-linux-gnu/libgpiod.so.3` exists and resolves to `libgpiod.so.3.1.1`. `libgpiod-dev` headers are not installed. `libapriltag-dev` 3.4.2-1+b2 and the shared library are installed.
- The login user belongs to `gpio` and `video` groups. `/dev/gpiochip0` through `5` exist.
- `/dev/video0` produced one 640×480 BGR frame (921,600 bytes) with ffmpeg. `/dev/video1` produced no frame and failed `VIDIOC_G_INPUT`.
- These observations did not run the application worker, WebRTC, GPIO outputs, or pump.

Pump pulse timing, relay polarity, switch mapping, e-stop response time, motor pulse count, browser video/overlay alignment, FPS, latency, memory stability, NPU stalls, and a one-hour full-stack soak remain unverified. No actuation was attempted.

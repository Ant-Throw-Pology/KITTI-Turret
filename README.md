# KITTI Turret

Status: **development, not safe for physical deployment**. The local build and mock tests pass; GPIO outputs, WebRTC in a browser, and sustained runtime remain unverified. See `docs/REVIEW.md` and `docs/TEST_REPORT.md` for open failures. Physical directions, relay polarity, switch mapping, GPIO actuation, real browser WebRTC, and long soak remain hardware-unverified.

## Architecture

`src/index.ts` is the HTTP/WebSocket and IPC server. `src/worker.ts` owns camera capture, RKNN inference, YOLO decode, JPEG encoding, and the AprilTag helper. `src/tag_worker.ts` is the separate tag process. `src/gpio.ts`, `stepper.ts`, `manual.ts`, and `pump.ts` implement GPIO and control. `src/web/` contains the operator UI. IPC is length-prefixed on a Unix socket; frame acknowledgements limit in-flight frames. The browser video path is a WebRTC DataChannel; boxes are HTML overlays.

## Hardware wiring

| Function | GPIO |
|---|---|
| Yaw STEP / DIR / EN | GPIO4_A3 / GPIO4_A4 / GPIO0_D4 |
| Pitch STEP / DIR / EN | GPIO4_B2 / GPIO4_B3 / GPIO1_D3 |
| Yaw limits | GPIO1_B6, GPIO1_B7 |
| Pump relay input | GPIO1_C6 |

EN is active low; fit a 10 kΩ pull-up from each EN to 3.3 V. TMC2209 stepsticks must be strapped to 1/64 microstepping. The 17HE15-1504S motors have 200 full steps per revolution. Verified coil pairs from the supplied contract are black/blue and green/red; check continuity on the installed motors. Do not move coils under power.

Limit switches are normally closed to ground with internal pull-ups. The mapping of B6/B7 to negative/positive yaw is **unknown**. Set `KITTI_YAW_NEGATIVE_SWITCH=GPIO1_B6` or `GPIO1_B7` only after measuring it. Pump relay active polarity is **unknown**; measure the physical module, then set `KITTI_RELAY_ACTIVE_HIGH=1` or `0`. The pump needs a separate fused supply, common ground, and flyback diode if the relay board does not include one. Never power it from the Pi 5 V rail.

## Local commands

```sh
TMPDIR="$PWD" BUN_TMPDIR="$PWD" bun install
bun run typecheck
bun test
bun run build
```

`bun.lock` is committed. `bun install`, `bun check`, `bun test`, and `bun run build` pass on the development machine. `KITTI_TEST_SOCKET=1 bun test test/soak.test.ts` runs the Unix socket test. The built server serves `/` (Bun HTML-import build rewrites the HTML and hashes JS/CSS). Pi runtime and browser WebRTC remain unverified.

To run after installing dependencies, set `KITTI_MODEL` to a supplied RKNN model path and start the server and worker separately:

```sh
bun dist/index.js
bun dist/worker.js
```

The server supervises a worker when `KITTI_MODEL` is set. Do not rely on this run mode for a physical turret until hardware verification is complete.

## Configuration

`KITTI_HOST` (default `127.0.0.1` on bare run; `bun run dev:deploy` overrides to `0.0.0.0` when unset), `KITTI_PORT` (8080), `KITTI_SOCKET` (`/tmp/kitti-turret.sock`), `KITTI_MODEL` (required for worker), `KITTI_CAMERA` (`auto`), `KITTI_WIDTH` (640), `KITTI_HEIGHT` (480), `KITTI_FPS` (20), `KITTI_JPEG_QUALITY` (60), `KITTI_RELAY_ACTIVE_HIGH` (unset until measured), `KITTI_YAW_NEGATIVE_SWITCH` (unset until measured), `KITTI_MAX_PUMP_MS` (10000), `KITTI_PULSE_MS` (500), `KITTI_MAX_STEPS` (57600), `KITTI_STUN` (optional), `KITTI_MOCK=1` (tests only), `KITTI_PING_TIMEOUT_MS` (15000).

**Motor direction inversion** — `KITTI_YAW_INVERT` and `KITTI_PITCH_INVERT` (each `0` or `1`, default `0`). The physical motor direction relative to the wiring label (STEP positive → DIR high → direction) is an unknown that must be measured on the installed motors. Set `KITTI_YAW_INVERT=1` when the turret rotates in the opposite logical direction from the joystick/UI command. The invert flips the raw DIR pulse sent to the stepper driver while keeping UI directions, logical yaw-limit semantics and backoff direction consistent. These knobs are purely at the Manual hardware boundary; the UI, tracking controller, and limit-switch logic all operate on logical directions.

Pump availability does not depend on the yaw switch mapping. E-stop uses `POST /estop` and the WebSocket `estop` command. This path still needs timing verification on the Pi.

## Deploy

`deploy/build.sh` runs install, typecheck, tests, and build, then copies the tag C shim (no web asset copy — Bun's HTML-import build handles frontend artifacts). `deploy/deploy.sh user@host [--run]` syncs `dist/` over SSH; `--run` uses `ssh -tt`.

`bun run dev:deploy antthrowpology@orangepi` does a fast local build, rsyncs `dist/` and production manifest, installs target-native dependencies (`node-datachannel` via `bun install --production`), optionally compiles the AprilTag helper, then starts the server via `ssh -tt`. On the target, `~/kitti-turret/turret.env` is sourced if present (variables exported) and `KITTI_HOST` defaults to `0.0.0.0` only when unset, making the server remotely reachable. The target hostname is currently externally unverified. The server refuses motor commands without a configured switch mapping and refuses pump commands without relay polarity.

`deploy/turret.service` specifies `Restart=on-failure`, `KillMode=control-group`, and reads `EnvironmentFile=-%h/kitti-turret/turret.env`.

## Pi hardware checklist

- [ ] Inspect installed `gpiod.h` and `librknnrt.so` ABI against FFI bindings.
- [ ] Confirm `/dev/gpiochip*` bank mapping and gpio-group permissions.
- [ ] Measure relay polarity and prove off at boot, shutdown, e-stop, and viewer loss.
- [ ] Identify each yaw limit end and test pressed-at-start and new-hit behavior.
- [ ] Verify camera node discovery and stream format.
- [ ] Confirm model output layout and run ten minutes without stalls.
- [ ] Compile and test `tag36h11` helper with known ID.
- [ ] Verify WebRTC in a real browser, frame/box alignment, and loss recovery.
- [ ] Measure step count, direction, cancellation, and e-stop latency.
- [ ] Soak one hour; record RSS, FPS, pump timing, orphans, and NPU latency.

`voicelines/` contains only `.gitkeep`; no audio or playback code exists.

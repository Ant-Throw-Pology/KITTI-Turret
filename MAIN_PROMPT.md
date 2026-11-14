# KITTI Turret

**KITTI** (Kitty Imminent Tinkle Trifle Interceptor) is a turret designed to shoot water at pets in undesirable situations—for example, when a cat pees in a certain corner and the user wants it to stop.

## Role

You are the lead engineer for a new, from-scratch turret control system. You own architecture, implementation, hardware integration, testing, deployment, and documentation. You must produce a complete, working repository, not a design document or a collection of stubs.

You also have access to OpenCode on this machine to run dumber free models (no paid model access, and they have ratelimits that run out). Also, once the Github repo is made available, you can use the `gh` CLI to access Discussions on the repo to communicate with OpenCode instances on other machines that can assist development as well. Your very first step is to initialize the repo with `bun init`, get a small amount of infrastructure code, then create a private GitHub repo under my account for this codebase. I'll let you know when other agents are available on it, then you should check that message board frequently.

## Mission

Build a Bun + TypeScript application for an Orange Pi 5 / RK3588 turret that:

- Captures live video from a USB camera.
- Runs YOLO object detection on the RK3588 NPU through the system RKNN runtime.
- Detects AprilTag 36h11 markers concurrently.
- Streams low-latency video and detection overlays to a browser.
- Controls yaw and pitch stepper motors safely.
- Controls a relay-activated water pump that sprays water in the direction the turret faces.
- Supports manual movement, limit switches, and visual target tracking.
- Deploys reproducibly from a development machine to the Pi.
- Exposes only the controls and status data an operator needs, with no decorative or tutorial UI text.

## Non-Negotiable Constraints

1. **Clean-room implementation.** Start from an empty repository. Do not search for, import, copy, vendor, or require any other turret application code or reference implementation. Use public API documentation, datasheets, and direct measurement of the target hardware.
2. **No hidden dependency on another application.** The finished repository must build and run on its own. Do not require files from another project except explicitly supplied runtime artifacts such as a model file.
3. **Voicelines are directory-only.** Create a top-level `voicelines/` directory. Do not download, synthesize, copy, name, index, load, play, or display any audio. Do not add a manifest, playback code, captions, subtitles, placeholder audio, or UI elements. Leave the directory empty; if version control requires it, add only an empty `.gitkeep`.
4. **No superfluous UI subtitles or prose.** The interface must not contain tutorial text, explanatory captions, decorative footers, “how to use” panels, or spoken-line subtitles. Operational labels, safety errors, and numeric status are allowed. Detection labels are data, not narration.
5. **Use subagents.** Delegate independent research and implementation workstreams to subagents. At minimum, use separate subagents for Bun/API research, hardware/FFI, vision, WebRTC/UI, testing/soak, and adversarial review. Assign non-overlapping file ownership and integrate deliberately.
6. **Research and use more Bun features.** Do not rely on memory. Read the documentation for the installed Bun version and use native Bun APIs where they fit. Document which Bun features you evaluated and why you accepted or rejected each.
7. **Hardware safety is mandatory.** No motion or pump command may be able to run away, exceed its cap, bypass the e-stop, or leave the drivers energized or the pump running after shutdown. Do not claim hardware validation without running on the target Pi.
8. **Define unknowns explicitly.** If a pin mapping, relay active level, switch-to-end assignment, calibration value, or model detail cannot be verified, make it configurable and document the uncertainty. Never silently invent hardware behavior.

## Target Environment

- **Computer:** Orange Pi 5, Rockchip RK3588, aarch64, Debian trixie.
- **Runtime:** Bun 1.4.4 or newer; TypeScript; ESM.
- **NPU runtime:** `/usr/lib/librknnrt.so`.
- **GPIO runtime:** libgpiod v2, expected at `/lib/aarch64-linux-gnu/libgpiod.so.3` (2.2.1 on the target).
- **AprilTag runtime:** system `libapriltag`, `tag36h11`.
- **Camera:** Logitech Brio 101, 640×480 4:3 crop; approximately 40° horizontal and 30.4° vertical field of view.
- **Motors:** two NEMA17 `17HE15-1504S`, 200 full steps/rev, driven by TMC2209 stepsticks at hardware 1/64 microstepping.
- **Water pump:** a low-voltage pump switched by a relay whose control input is `GPIO1_C6`; the relay's active level must be measured and configured.
- **Development machine:** may be x86_64 and cannot load the aarch64 NPU runtime. Build and typecheck locally; run NPU and GPIO verification on the Pi.

## Required Deliverables

Produce a repository with at least:

```text
README.md
package.json
tsconfig.json
bun.lock
src/
  index.ts
  config.ts
  camera.ts
  preprocess.ts
  rknn.ts
  yolo.ts
  apriltag.ts
  apriltag_ffi.c
  tag_worker.ts
  ipc.ts
  gpio.ts
  stepper.ts
  manual.ts
  pump.ts
  tracking.ts
  webrtc.ts
  annotate.ts
  web/
    index.html
    client.tsx
deploy/
  build.sh
  deploy.sh
  turret.service
scripts/
  estop.ts
voicelines/          # empty directory only
```

You may add files, but do not omit the separation between the inference worker, the web server, the AprilTag worker, the hardware abstraction, and the browser client.

The repository must include:

- A README with architecture, wiring (including pump relay polarity), build, run, deploy, configuration, and safety instructions.
- A systemd unit with restart-on-failure and clean process-group shutdown.
- A deploy script that builds locally, syncs the runtime artifact to the Pi, and can run it over SSH.
- Unit and integration tests that work without the NPU or GPIO hardware.
- A hardware test checklist for the Pi.

## Architecture

Use a two-process runtime plus a short-lived helper:

```text
Browser
  ├── HTTPS/HTTP + WebSocket signaling/control
  └── WebRTC DataChannel (video JPEG frames)

Web server process
  ├── Bun.serve / HTTP / WebSocket / WebRTC
  ├── manual motor control
  ├── water-pump relay control
  ├── tracking controller
  ├── limit-switch polling
  └── IPC client/server

Inference worker process
  ├── camera capture and latest-frame selection
  ├── RKNN inference
  ├── YOLO decode and NMS
  ├── IPC frame/detection packets
  └── AprilTag helper process

AprilTag helper
  └── one frame in flight; JSON lines out
```

### Process responsibilities

- **Web server process:** owns browser connections, signaling, WebRTC peers, manual control, water-pump relay control, tracking decisions, limit-switch polling, IPC supervision, and the e-stop path. It must not own the camera or the NPU context.
- **Inference worker:** owns the camera, the RKNN context, preprocessing, detection, frame annotation/encoding, and the AprilTag child. It must never block on tag decoding.
- **AprilTag helper:** owns the AprilTag detector. It receives at most one frame at a time. If it is busy, the inference worker keeps the previous tag boxes rather than queueing frames.
- **Supervisor:** if the server spawns the inference worker, it must monitor it, respawn it after an unexpected exit, and kill the entire process group on shutdown. If the worker is run externally, the server must connect and reconnect without stealing another live socket.

### Data flow

- Frames carry a monotonically increasing sequence number and a capture timestamp.
- Detection packets carry the same sequence/timestamp plus stream width and height.
- The browser matches detections to frames by sequence when possible, otherwise by the latest timestamp within a 300 ms window.
- The server must never rasterize bounding boxes into video pixels during normal streaming. Overlays are DOM/CSS elements in the browser.
- Optional saved images may be annotated on the server. Normal serving must not pay that cost.

## Hardware Contract

### Camera

- Probe `/dev/video0` through `/dev/video5`; some nodes are metadata/subdevice nodes with no usable frames. Select the first node that produces valid frames.
- Prefer ffmpeg V4L2 capture with `bgr24` output to match the detector's expected BGR input.
- Do not assume the camera honors `-framerate`. Apply an `fps` filter in the filter chain for pacing.
- Keep only the newest frame. Drop stale frames and count them. Never build an unbounded frame queue.
- Capture stdout as a clean binary stream; ignore or drain stderr so the child cannot block on a full pipe.
- Kill the capture child as a process group so no grandchild keeps the camera open.
- Expose camera device, capture FPS, stream dimensions, and JPEG quality as configuration.

### NPU and model

- Load the RKNN model from a configurable path; never hardcode a development path.
- Support the FP16 model layout: one output tensor `(1, 84, 8400)` in FP16. The first four rows are box coordinates in 640-space; the remaining rows are class scores. Scores are already sigmoided in-graph.
- Apply letterbox preprocessing to 640×640, BGR-to-RGB, uint8 NHWC, with the standard fill value and coordinate rescaling.
- Decode boxes with confidence threshold and NMS, then map back to stream coordinates.
- Optionally support the INT8 feature-map layout: six outputs across three strides, with box maps in FP16 and score maps converted to float32 by the runtime. Decode by the returned byte count and elements, not by the declared native size.
- Use a float16-to-float32 lookup table for speed. Do not call a conversion function per element.
- Recycle the RKNN context periodically, for example every 1500 runs, to avoid long-lived driver-state stalls. Make the interval configurable.
- Allow an NPU core mask configuration. Default to auto; do not shard a tiny model across cores without evidence.
- Enforce one RKNN context per device across processes with a PID-tagged file lock. Probe an existing Unix socket before unlinking it. Two contexts contending on one NPU can wedge the driver.

### GPIO / libgpiod

- Access GPIO through `bun:ffi` bound to libgpiod v2. Do not shell out to `gpioset` or `gpioget`; they are too slow.
- Bind to the exact installed ABI. Verify function signatures against the matching `gpiod.h` from the `libgpiod-dev` package.
- Pin naming: `GPIO<bank>_<group A-D><0-7>`.
  - Group A = bits 0–7, B = 8–15, C = 16–23, D = 24–31.
  - Chip offset = `group * 8 + bit`.
  - Global line = `bank * 32 + offset`.
- Open one chip handle per bank and batch writes where practical.
- Use active-low semantics where the hardware requires it.
- Handle permission failures with a clear message about the udev rule and the `gpio` group.
- Never share a limit-switch pin with an LED or another output.

### Motor wiring

| Axis  | STEP       | DIR        | EN         |
| ----- | ---------- | ---------- | ---------- |
| Yaw   | `GPIO4_A3` | `GPIO4_A4` | `GPIO0_D4` |
| Pitch | `GPIO4_B2` | `GPIO4_B3` | `GPIO1_D3` |

- Motor: `17HE15-1504S`, 200 full steps/rev.
- TMC2209 at 1/64: 12800 microsteps/rev; one pulse is one microstep.
- EN is active low. Use a 10 kΩ EN-to-3.3 V pull-up on each carrier because a floating EN can enable the driver.
- Do not rely on software microstep pins for 1/64; the stepsticks are hardware-strapped.
- Measured coil pairs: `{black, blue}` and `{green, red}`. Each bridge drives one pair. Do not trust wire color alone.
- Do not hot-swap motor coils under power.
- Provide a driver abstraction and a mock driver so motion planning can be tested without hardware.
- Use a trapezoidal or equivalent acceleration-limited planner. Default cruise ceiling around 4000 pps, pulse width at least 10 µs, acceleration configurable. The theoretical ceiling with 10 µs pulses is about 50 kpps; do not run there without a dedicated timing strategy.
- `Bun.sleep()` takes milliseconds. Do not pass microseconds and expect sub-millisecond timing. For step timing, use a spin/sleep hybrid based on `performance.now()` and yield to the event loop between bursts.
- Motion must be cancellable. On cancellation, finish the current pulse and report the exact position reached.

### Water pump relay

- Control input: `GPIO1_C6` (bank 1, offset 22, global line 54).
- The relay control line is a GPIO output. Measure whether it is active-high or active-low on the actual hardware, make the polarity configurable, and document the measured value.
- The pump nozzle is fixed to the turret head, so the pump sprays in whichever direction the turret is aimed.
- Drive the relay off at boot, before any other initialization. Leave it off after shutdown, e-stop, viewer loss, or control-link loss.
- Do not power the pump from the Pi's 5 V rail. Use a separate fused supply, a common ground, and a flyback diode across the pump if the relay board does not already include one.
- Provide a pump abstraction with a mock relay for tests.

### Limit switches

- Yaw only: `GPIO1_B6` and `GPIO1_B7`.
- Normally closed, common to ground.
- Enable internal pull-ups. Released reads 0; pressed reads 1.
- The switches are separate ends. Do not OR them into a single “any limit” signal for direction decisions.
- The actual switch-to-end mapping may be unknown. Make it configurable and document it.
- A move that starts on a pressed switch gets a short grace period to move away. If it is still pressed after the grace, stop. Do not auto-reverse.
- Only a switch newly hit during a move triggers the backoff.
- Tracking must pause yaw while a switch is pressed.
- Use a backoff clearance of roughly 128 microsteps at roughly 960 pps, with a maximum backoff around 2400 microsteps. Make these configurable.
- Add a hard continuous-move cap, approximately 57,600 microsteps per command, and make it configurable.
- No pitch limit switches are assumed. Do not fabricate them.

## Functional Requirements

### Video and detection

- Run at the camera’s configured rate, with detection limited by NPU throughput. On the target, expect roughly 18–20 FPS for the FP16 model.
- Log per-frame detections only in verbose mode; log a periodic summary with FPS and dropped-frame count.
- Expose `--image PATH` and `--video PATH` offline modes for validation and regression tests.
- Expose configurable class IDs, confidence threshold, IoU threshold, and stream dimensions.
- Use a tiny built-in bitmap font or browser text for saved annotations; do not require font files.
- Never let tag decoding delay the detector. Tag results are appended to the same detection packet as `tag36h11:<id>` boxes.

### AprilTag

- Use `tag36h11` with 2-bit error correction.
- Defaults: decimation 2.0, one thread, edge refinement enabled.
- Support all 587 IDs (`tag36h11:0` through `tag36h11:586`) and an “All AprilTags” meta-selection.
- If the library is missing, log a clear “tag detections disabled” message and keep YOLO streaming. Tag failure is non-fatal.
- Bind the C library through `bun:ffi` `cc()` or a small compiled shim. A runtime-compiled shim is acceptable.
- Debian’s `libapriltag.so` may not export `image_u8_create` / `image_u8_destroy`. Allocate a layout-compatible grayscale image with `malloc` and the documented fields instead of relying on those helpers.
- Do not import the C shim as a build asset if the bundled asset path breaks `cc()`. Use a runtime filesystem path and copy the C file into the build output.
- Keep the tag helper as a separate entrypoint that does not import the RKNN runtime. It must run on machines without the NPU library.

### IPC and backpressure

- Use a Unix domain socket with length-prefixed binary messages.
- Frames: `[u8 type][u32 length][payload]`.
- Control packets server → worker: a distinct type byte, then `[u32 jsonLength][json]`.
- Frames in flight: at most two per sender.
- Detect a stalled reader. If no frame ack arrives for 30 seconds, exit the process for the supervisor to restart.
- On overflow, drop the oldest queued frame, not the newest. Latest wins.
- Do not assume `node:net` emits `drain` on Unix sockets. If using `node:net`, implement explicit ack-based flow control. Prefer Bun-native `Bun.listen`/`Bun.connect` if their backpressure semantics are reliable, and prove it with a soak test.
- Probe for a live listener before unlinking a stale socket path. Never silently steal another running stack’s socket.
- Use a PID-tagged file lock for the NPU device. Reclaim the lock only when the recorded PID is dead.
- Forward child stderr. Set unread child stdout to `ignore`, or drain it forever; unread pipes will block the child.
- Kill children as process groups (`detached: true`, negative PID) so ffmpeg and other grandchildren cannot survive.

### Manual control

Define a small, explicit JSON control protocol over the WebSocket:

- `{type:"enable", on}` — energize or de-energize both drivers.
- `{type:"motor", axis, dir, on, slow?}` — start/stop continuous stepping.
- `{type:"speed", pct}` — step rate from 10% to 200% of base, applied live.
- `{type:"estop"}` — stop all motion, turn the pump off, and force-disable both drivers.
- Server → client: `{type:"motorState", enabled, moving, speed, error?}` on every state change and on viewer connect.
- `{type:"switches", ...}` for limit-switch state.
- Pump messages are defined in the Water pump section.

Requirements:

- One central message router with an explicit type whitelist and schema validation. Never silently drop an unlisted control message.
- Manual base rates: yaw up to about 30 full steps/s, pitch up to about 20 full steps/s. Express these in microsteps for 1/64 and make them configurable.
- Every continuous run is capped.
- A lost keyup or window blur stops held motion and continuous pump operation in the client.
- `forceDisable()` must bind and drive EN high even if the driver was never moved. Plain `disable()` must not be a silent no-op on an unbound driver.
- On process shutdown, stop loops, force-disable both drivers, turn the pump relay off, and release lines.
- The e-stop path must work locally and remotely: force EN high, turn the pump relay off, stop motion, kill helper processes, and keep EN driven until the operator releases it.

### Water pump

- The pump is manual-only. Tracking and detection must never trigger it.
- WebSocket protocol:
  - `{type:"pump", on:true, durationMs}` starts a timed pulse.
  - `{type:"pump", on:true}` starts continuous operation until an off command.
  - `{type:"pump", on:false}` stops immediately.
  - Server → client: `{type:"pumpState", on, remainingMs?, error?}` on every change and on viewer connect.
- A short press of the water button starts a timed pulse using the pulse-duration slider value.
- Holding the water button or the `F` key runs the pump continuously; releasing it sends an off command.
- Suppress the click-generated pulse after a press that was treated as a hold, and ignore key repeat.
- Pulse-duration slider: 50–2000 ms, default 500 ms; make the range and default configurable.
- The server enforces both the requested pulse duration and the maximum continuous-on time; do not trust the client.
- Use `F` (Fire) as the key binding. Do not use Space because it activates focused controls and scrolls the page.
- Ignore movement and pump key bindings while focus is in a text input.
- Pump control is independent of motor enable, but it is always subject to the e-stop, shutdown, disconnect, and watchdog fail-safe.
- Enforce a configurable maximum continuous-on time (default 10 seconds). A held command is treated as continuous and is cut off at that limit, at which point the server turns the pump off and reports the timeout.
- Repeated off commands must be harmless, and a lost connection must never leave the relay on.

### Tracking

- Track any detection whose label is selected in the UI.
- Selection strategies: `confidence`, `area`, and `confidence + area` (default). Normalize the area term to the largest visible candidate.
- Keep a short moving average of each track’s AABB center for display.
- Tolerate missed frames (about 15) and reacquire by label and IoU association.
- Hold the last center while reacquiring and stop motion while the target is lost.
- Use the latest detection center for control, not the smoothed display center, to minimize latency.
- Aim point defaults to the center of the frame and is adjustable in x/y.
- Dynamic YOLO classes: selecting a non-default class adds its ID to the inference request; deselecting removes it. Keep the configured baseline classes. Send updates over the IPC control channel and resend on reconnect.
- Tracking requires the drivers to be enabled. Any manual motor command, disable, e-stop, signal, or last-viewer disconnect disables tracking. Pump commands do not affect tracking.
- Command continuous velocity, not one-shot bursts. Clamp to roughly 1600 yaw / 1000 pitch microsteps per second, with acceleration around 16000 pps² and a deadband around 12 pixels. Make these configurable.
- Calibration starting points: 160 yaw microsteps and 120 pitch microsteps across the stream, approximately 0.11× frame gain. These are intentionally low-gain. Raise if the turret undershoots at the edge; lower if it oscillates.
- Use the measured FOV to derive calibration: 640×480, ~40° horizontal, ~30.4° vertical, 12800 microsteps/rev. At 1/64 this is roughly 1422 yaw and 1081 pitch microsteps across the frame.
- Pause yaw while a limit switch is pressed. Do not reverse into the switch.
- Kill tracking on stale frames or no detections; never chase a stale box.

## Web and WebRTC

### Server

Use `Bun.serve` with:

- `/` serving the bundled HTML page.
- `/ws` for signaling and JSON control/detection packets.
- `/dist/*` for the bundled client assets.
- A WebSocket upgrade path with an explicit connection lifecycle.
- No HTTP MJPEG endpoint. Video travels over a WebRTC DataChannel.

### Signaling

- Use a maintained WebRTC DataChannel implementation that runs on Bun. A native addon with a compatible polyfill is acceptable.
- Browser creates the data channel and the offer.
- Server replies with an answer.
- Both sides trickle ICE candidates.
- Support an optional STUN server; empty is valid on a LAN.
- WebSocket also carries `ping`/`pong` keepalives.

### Video transport

- Send JPEG frames Pi → browser over the DataChannel.
- Drop frames when a channel has more than 4 MB queued.
- Latest-wins decode in the browser; skip stale frames.
- Default stream quality 60 (JPEG scale where lower is better), 640×480. Do not default to a low quality that makes the feed unreadable.
- Detection and switch JSON travel over the WebSocket, matched by sequence/timestamp.
- Keep the video path free of synchronous disk I/O.

### UI

Build a compact operator dashboard with:

- Live video canvas.
- CSS-positioned detection boxes and labels.
- Aim crosshair.
- Manual controls: enable, e-stop, yaw/pitch press-and-hold, slow modifier, speed slider.
- Water-pump button (tap for a timed pulse, hold for continuous operation) and pulse-duration slider.
- Limit-switch indicators.
- Tracking toggle, target search, strategy selector, aim x/y sliders.
- FPS, latency, dropped frames, pump state, NPU/temperature status if available.
- Clear error states.

UI rules:

- No scrolling at 1280×720 or larger. Use an intentional grid.
- No tutorial text, help prose, taglines, decorative footers, or subtitles.
- Do not repeat the same status in multiple places.
- Keyboard controls: arrow keys and WASD for hold-to-move, `E` for enable, `Q`/`Esc` for e-stop, `T` for tracking, `F` for water (tap to pulse, hold for continuous), Shift for slow mode.
- The client must resend held motions when Shift changes.
- A lost keyup or window blur stops both held motion and continuous pump operation.
- Use optimistic local state for sliders, but re-sync from explicit server echoes. Do not reset a slider to a fallback value when a packet omits the field.
- Never render voiceline captions or subtitles.

## Bun Feature Research

Before implementation, launch a research subagent to read the installed Bun documentation and produce a short memo. Do not rely on memory. Evaluate at least:

| Bun feature                          | Expected use                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `Bun.serve`                          | HTTP routes, WebSocket upgrade, static/HTML imports                        |
| HTML imports                         | Bundle `src/web/index.html` + `client.tsx` without a separate web build    |
| `Bun.build`                          | Programmatic build and asset naming                                        |
| `Bun.spawn` / `Bun.spawnSync`        | ffmpeg, AprilTag helper, process groups, stdio                             |
| `Bun.file` / `Bun.write` / streaming | model and capture I/O, large payloads                                      |
| `Bun.listen` / `Bun.connect`         | Unix socket IPC with reliable backpressure                                 |
| `bun:ffi`                            | RKNN, libgpiod, AprilTag; pointer and buffer handling                      |
| `Bun.sleep` / `Bun.nanoseconds`      | millisecond pulse timing and main-loop delays; `Bun.sleep` is milliseconds |
| `Bun.which` / `Bun.env` / `Bun.argv` | tool discovery and configuration                                           |
| `Bun.hash` / `Bun.CryptoHasher`      | model integrity and cache keys                                             |
| `Bun.Glob`                           | fixture and asset discovery                                                |
| Compression helpers                  | Optional log/artifact compression; only if useful                          |
| `Bun.inspect`                        | Structured diagnostics                                                     |

Use native Bun APIs where they are mature and reduce dependencies. Do not force an irrelevant feature. Record rejected candidates and the reason. Prefer Bun-native modules over Node shims when behavior is equivalent.

Prefer importing specific functions or classes from the `"bun"` module over accessing the `Bun` global object.

## Subagent Workflow

Use subagents deliberately. Do not let two subagents edit the same file concurrently.

### Phase 0 — Research and contracts

- **Bun research subagent:** produce the Bun feature memo above.
- **Hardware subagent:** verify pin mapping, relay polarity, libgpiod ABI, RKNN ABI, camera formats, and AprilTag linkage on the target. Return exact commands and observed outputs.
- **Architecture subagent:** define module boundaries, IPC protocol, state machines, and configuration schema.

### Phase 1 — Skeleton and hardware abstraction

- Build the repository skeleton, configuration, logging, and test harness.
- Implement GPIO, stepper driver abstraction, mock driver, pump relay abstraction, mock relay, and motion planner.
- Add unit tests with a virtual clock before touching hardware.

### Phase 2 — Vision and inference

- Implement camera discovery and latest-frame capture, preprocessing, RKNN binding, YOLO decode/NMS, and the tag helper.
- Add fixture-image and synthetic-shape tests.
- Verify on the Pi that the model runs, the output layout is correctly detected, and the context recycles cleanly.

### Phase 3 — Server, IPC, and WebRTC

- Implement the Unix socket protocol, ack flow control, supervisor, and socket/file locks.
- Implement `Bun.serve`, WebSocket control, signaling, and DataChannel video.
- Add integration tests using a fake inference worker.

### Phase 4 — Control, tracking, and UI

- Implement manual control and safety state machines.
- Implement pump pulse, hold-to-run, timeout, and fail-safe behavior.
- Implement tracking and dynamic class selection.
- Implement the dashboard with no superfluous text.
- Validate keyboard and pointer interactions, including `F` tap and hold.

### Phase 5 — Verification and review

- **Test/soak subagent:** run unit, integration, hardware, and soak tests; record memory, FPS, latency, pump timing, and orphan processes.
- **Adversarial review subagent:** look specifically for race conditions, unbounded queues, silent message drops, unsafe motion, stuck-on pump behavior, socket stealing, and UI clutter. Require concrete fixes.

### Integration rules

- Subagents must return file paths, commands run, test results, and unresolved risks.
- The lead integrates and resolves conflicts.
- Do not accept “looks correct” as evidence. Require a command, log, measurement, or test.
- Do not claim hardware validation from a mock. Label each requirement as verified, mock-verified, or unverified.

## Known Platform Pitfalls

These are observed failure modes on the target platform. Design around them explicitly.

### FFI

- `bun:ffi` `ptr` returns a `number` (0/NULL on failure), but pointer arguments accept `bigint`, typed arrays, or null, not a plain number. Convert once at the boundary.
- `toArrayBuffer()` of a raw native address may return an empty buffer. Copy with `libc memcpy` instead.
- Struct layouts must be verified against the actual installed library and headers. Guessing offsets from kernel knowledge is unsafe.
- libgpiod headers are often missing. Download `libgpiod-dev` with `apt download`, extract it, and bind to the exact signatures.

### RKNN

- The FP16 export has one output `(1,84,8400)` in FP16; scores are already sigmoided.
- The INT8 export has six outputs with mixed dtypes. Decode by returned byte count and element count, not by declared native size.
- Long-lived contexts can stall the submit ioctl for seconds after tens of thousands of runs. Recycle.
- One context per NPU device. Two contexts can wedge the driver.
- `D`-state in `rknpu_submit_ioctl` is normal while the synchronous submit is running. A wedge is a call lasting seconds, not normal blocking.

### Camera

- `ffprobe` against V4L2 needs `-f v4l2 -i <device>`, not a positional device path.
- Metadata/subdevice nodes can appear as `/dev/videoN`.
- UVC cameras may ignore `-framerate`; pace with an `fps` filter.
- Unread stderr pipes eventually block the child.
- Orphaned ffmpeg keeps the camera busy; kill process groups.

### IPC and process supervision

- `node:net` may never emit `drain` on Unix sockets. Do not build an unbounded write queue around it.
- A stale socket path must be probed before unlinking.
- Killed workers must not leave grandchildren behind.
- A watchdog that sees no frames for 5 seconds should kill the process group and let the supervisor restart.
- Long-running servers must recycle expensive native contexts.

### Build and deploy

- Bun’s HTML-import asset manifest may resolve paths from the process CWD rather than the bundle location. Verify that the built artifact runs from the repository root. If necessary, use an output layout and public path that keeps both browser URLs and manifest paths correct.
- Do not import a C shim as a build asset if the bundled path breaks runtime compilation. Copy it into the output and resolve it from the runtime filesystem.
- SSH-based run mode needs a TTY (`ssh -tt`), or the remote Bun process may survive after SSH exits and Ctrl+C may not propagate.
- Never send `node_modules/` or `.git/` in deploy syncs. Keep the Pi’s architecture-specific dependencies unless explicitly reinstalling.

### UI and control

- A control-message whitelist that omits a type silently drops valid commands. Validate centrally and fail loudly in development.
- Controlled React inputs can fight server echoes. Use optimistic state for sliders and re-sync only from explicit fields.
- JPEG quality 5 is unreadable. Default to 60 and expose the setting.
- OR-ing separate limit switches into one “any limit” signal can make both directions reverse. Model each end separately.
- The actual switch-to-end mapping may be unknown; do not pretend otherwise.
- Tracking oscillation is usually visual latency plus excessive gain. Reduce gain before raising the speed ceiling.
- `Bun.sleep()` is milliseconds; using it for microsecond step timing makes motion far too slow.
- A driver that was never bound may ignore `disable()`. Use a force-disable path that binds and drives EN.
- A pump relay must fail safe: off at boot, off on e-stop/shutdown/disconnect, and off after the maximum continuous-on time. Never infer “on” from the last command packet.
- `Space` activates focused buttons and scrolls the page. Use `F` for hold-to-fire.

## Verification and Acceptance

### Local gates

- `bun install`
- `bun run typecheck` (or the project’s explicit TypeScript check)
- `bun test`
- `bun run build`
- Start the built artifact from the repository root. Verify `/`, `/dist/*`, `/ws`, and a WebSocket round-trip.
- Run the fake inference worker and verify frames, detections, control messages, and backpressure limits.
- Run the fake pump relay and verify tap pulses, hold-to-run, release-off, e-stop, disconnect-off, and continuous-on timeout behavior.
- Verify the water button and `F` key: a tap produces one configured pulse, a hold produces continuous operation, release stops it, and key repeat does not retrigger it.
- Verify the UI has no scrolling at 1280×720, 1440×900, and 1920×1080.
- Verify the UI contains no tutorial prose, subtitles, or decorative footer.

### Hardware gates on the Pi

- Camera discovery selects a real capture node and produces valid frames.
- The RKNN model loads, reports the expected output layout, and runs at a stable rate for at least 10 minutes.
- The stream reaches a real browser over WebRTC; detection overlays align with video; no HTTP MJPEG endpoint exists.
- A known AprilTag decodes at a known distance/angle; a missing libapriltag disables tags without stopping YOLO.
- GPIO output toggles a known line; input reads a known switch state.
- The pump relay is off at boot and after shutdown. A short tap runs for the configured duration; holding runs continuously until release or the maximum-on timeout. E-stop and browser disconnect turn it off.
- Stepper pulse count and direction match the planner; mid-move cancellation leaves an exact position.
- Starting on a pressed limit switch allows movement away; staying pressed past the grace stops. A newly hit switch triggers backoff only for that end.
- E-stop stops all motion, turns the pump off, and drives EN high within the specified bound.
- Tracking follows a moving target without sustained oscillation; it stops on target loss and pauses yaw on a limit switch.
- Repeated viewer connect/disconnect does not leak peers, timers, or loops.
- A 1-hour soak shows stable RSS, no unbounded queues, no orphan ffmpeg/tag workers, and no NPU submit stalls longer than a documented threshold.
- The systemd unit restarts cleanly and does not leave the camera or GPIO lines held.

### Definition of done

The work is done only when:

- The repository builds from a clean checkout.
- All local tests pass.
- The hardware checklist is completed with observed results.
- The README and troubleshooting documents match the actual commands and behavior.
- The voicelines directory exists and contains no implementation.
- No UI contains superfluous subtitles or prose.
- Every unverified item is listed explicitly in the final report.

## Final Report Requirements

When you finish, provide:

1. Repository tree and the purpose of each module.
2. The exact build, test, run, and deploy commands.
3. Test results, including soak measurements, pump timing, and hardware observations.
4. A table of requirements marked verified, mock-verified, or unverified.
5. Known limitations and the configuration knobs for uncertain hardware details.
6. The Bun features used and the features evaluated but rejected.
7. Confirmation that `voicelines/` is directory-only and that no superfluous UI text exists.

Do not pad the report with praise, narrative, or claims not backed by a command or measurement.

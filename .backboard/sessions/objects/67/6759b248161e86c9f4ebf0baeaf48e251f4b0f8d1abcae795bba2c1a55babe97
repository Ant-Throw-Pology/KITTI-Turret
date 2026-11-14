# Adversarial review (2026-11-14)

This is a source review. No Pi hardware, browser session, or WebRTC peer was available. Findings below are unresolved unless a later integration commit explicitly closes them.

## Stop-ship findings

1. **The actual pump and motor control path is not verified.** `src/index.ts:13-21` constructs `Gpiod` only when relay polarity is configured, and constructs `Manual` only when a yaw switch mapping is configured. Hardware initialization, libgpiod ABI, relay polarity, and limit assignment have not been measured on the Pi. There is no physical emergency-stop input. The local tests use mocks.
2. **Camera/worker are not supervised.** `src/index.ts:46-54` listens for a worker but does not spawn, respawn, or watchdog it. `src/worker.ts` has no reconnect after socket close. `src/index.ts:59-60` destroys the worker socket but cannot kill its process group or ffmpeg/tag grandchildren. A dead worker leaves a stale video frame and stale detection state.
3. **Video payloads disagree.** `src/worker.ts` sends a 12-byte sequence/timestamp header followed by JPEG. `src/index.ts:49` strips the header before `VideoPeer.sendFrame`. `src/web/client.tsx` parses the first 12 bytes of each DataChannel message as that header. Browser decode will fail or compare meaningless sequence values.
4. **The manual and tracking safety contracts are incomplete.** `src/index.ts:38` toggles tracker state, but nothing calls `tracker.update` or commands motor velocity. It never pauses tracking for a pressed switch, stale frame, or lost target. `src/index.ts:36` accepts a manual `motor` command from any viewer; there is no owner lease or control-link watchdog. A viewer that stays connected but stops sending commands can leave motion running until the 57,600-step cap. `src/index.ts:57` stops on the last viewer only.
5. **Client protocol and server whitelist disagree.** `src/web/client.tsx` sends `aim`, `target`, and `strategy` packets. `src/index.ts:28-40` rejects those message types. The client error handler reads `message.message`, while the server sends `error` (`src/index.ts:57`), leaving most errors invisible.
6. **Detected classes are not dynamically synchronized.** `src/worker.ts` has baseline IDs `{0,15,16}` and accepts a `classes` control packet that clears them. `src/index.ts` never sends class updates. The target input is free text and no class ID selection contract is implemented. AprilTag ID selection is also absent.
7. **Build/deploy is incomplete.** `deploy/` and `bun.lock` are absent. Dependency resolution is blocked in this environment. `src/index.ts:56` resolves `web/index.html` relative to bundled `dist/index.js`, where it will not exist, and resolves client JS as `../dist/client.js`. The build script does not copy HTML, CSS, or C shim. A built artifact cannot serve `/` as written.

## Other concrete defects

- `src/worker.ts` calls `window.flush` only after producing another frame. An ACK that arrives after the last frame does not trigger queued-frame flush. Detection packets are written without a queue cap or ACK flow control. A slow IPC reader can therefore accumulate writes outside the two-frame window.
- `src/index.ts:49` broadcasts a separate `frame` packet for every frame but does not match or hold detections by sequence. The browser renders latest detections over whichever decoded frame happens to be current; the required 300 ms matching window is missing.
- `src/index.ts:56` uses `readFileSync` on each HTTP request. This is synchronous disk I/O on the serving process. It also exposes `/estop` without authentication or origin checks; any local webpage may cause an e-stop, and the same WebSocket has no control access policy.
- `src/index.ts:42-44` probes and unlinks the IPC socket, but the probe has no timeout and can hang on a connecting socket. The cleanup path unlinks without confirming the socket inode still belongs to this process.
- `src/manual.ts:33-37` immediately blocks a move toward an already pressed switch, as desired, but the grace check for moving away uses `moved` outside the inner 32-step callback. The callback therefore allows up to one 32-step batch beyond the configured grace. This needs a Pi test and clearer bound.
- `src/stepper.ts:32-36` increments the logical position after a pulse even if an e-stop drove EN high during the awaited pulse width. The exact physical position after a mid-pulse e-stop cannot be claimed. The 10 µs busy wait uses JavaScript scheduling and needs pulse-width measurement on target.
- `src/gpio.ts` binds opaque libgpiod v2 signatures, but target headers and installed shared library were unavailable here. `Gpiod` opens one chip handle per bank but requests each line separately, so writes are not batched. The assumed `/dev/gpiochipN` mapping needs target verification.
- `src/web/client.tsx` paints every received detection immediately with no 300 ms age limit. It does not clear stale boxes on worker loss. `window.onblur` sends pump off, but a lost network connection before the server sees the packet relies on the last-viewer close callback, with no control watchdog.
- The JPEG encoder in `src/worker.ts` spawns one ffmpeg process per frame. At 18–20 FPS this may be expensive and can create subprocess pressure. Its process group is not detached or supervised, and output buffering/performance have not been measured.
- Pump timeout is unit tested, but tap, hold, key repeat, and pointer capture have not been exercised in a browser. No pump timing measurements exist on the Pi.

## Evidence

- `bun test`: 13 passing local tests at review time (mock and pure logic only).
- Source locations above were read directly. No target or browser observations are claimed.

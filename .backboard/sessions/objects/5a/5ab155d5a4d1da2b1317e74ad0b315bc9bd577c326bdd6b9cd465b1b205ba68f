# Bun 1.4.4 API assessment

Runtime probe: `bun --version` returned `1.4.4`. `bun -e 'import * as b from "bun"; ...'` confirmed that `serve`, `build`, `spawn`, `spawnSync`, `file`, `write`, `listen`, `connect`, `sleep`, `nanoseconds`, `which`, `hash`, `CryptoHasher`, `Glob`, and `inspect` are exported functions/classes. The current online documentation is not version pinned; functionality still needs testing against 1.4.4 in this repository.

| Feature | Decision | Reason and required check |
| --- | --- | --- |
| `serve` HTTP routes and WebSocket | Use | Native HTTP/WS; set explicit route whitelist, upgrade lifecycle, bounded WS buffer. [Server](https://bun.com/docs/runtime/http/server), [WebSockets](https://bun.com/docs/runtime/http/websockets). |
| HTML imports | Evaluate in build | Bun builds referenced TSX/CSS and emits an asset manifest. Test built artifact from repository root because CWD-based manifest resolution can fail. [Fullstack](https://bun.com/docs/bundler/fullstack). |
| `build` | Use | Programmatic build permits explicit output naming and separate server/worker/helper entrypoints. [Bundler](https://bun.com/docs/bundler). |
| `spawn`, `spawnSync` | Use `spawn` | Capture and helper processes require pipes and exit monitoring. Explicit `stdout: "ignore"` unless consumed; inherit or continuously drain stderr. Process-group behavior requires target test. `spawnSync` is reserved for build checks, not runtime. [Spawn](https://bun.com/docs/runtime/child-process). |
| `file`, `write`, streaming | Use selectively | Read model files and fixtures; stream capture stdout as binary. Avoid synchronous disk I/O in video path. [File I/O](https://bun.com/docs/runtime/file-io). |
| `listen`, `connect` | Trial before adoption | Native Unix socket support exists; socket `write`/`drain` behavior must pass an explicit bounded-backpressure soak. Keep frame ACKs independent of transport backpressure. [TCP](https://bun.com/docs/runtime/networking/tcp). |
| `bun:ffi` | Conditional use | Required by RKNN and libgpiod contract; Bun calls it experimental and warns against production reliance. Bind only verified installed ABIs and isolate failures; hardware validation mandatory. [FFI](https://bun.com/docs/runtime/ffi). |
| `sleep`, `nanoseconds` | Use | `sleep` takes milliseconds, suitable for coarse waits only. Use high resolution time for step scheduling and yield between bursts. [Utils](https://bun.com/docs/runtime/utils). |
| `which`, `env`, `argv` | Use | Discover ffmpeg and parse environment/arguments; fail with clear configuration errors. [Utils](https://bun.com/docs/runtime/utils). |
| `hash`, `CryptoHasher` | Use only for model integrity if needed | `CryptoHasher` can stream a digest; noncryptographic `hash` is unsuitable to authenticate a model. [Hashing](https://bun.com/docs/runtime/hashing). |
| `Glob` | Reject for runtime | Fixed entrypoints and configured model path need no discovery. May simplify test fixture enumeration only. [Glob](https://bun.com/docs/runtime/glob). |
| Compression helpers | Reject for live transport | JPEG is already compressed and added compression costs CPU/latency. |
| `inspect` | Use for diagnostics only | Never put inspected native structures on a per-frame hot path. [Bun APIs](https://bun.com/docs/runtime/bun-apis). |

Prefer named imports from `bun`. Verify every adopted feature with local tests; this memo does not establish that native socket backpressure or native FFI is safe on the Pi.

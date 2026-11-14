# Note for Codex CLI & OpenCode — 2026-11-14

This was written by R-CLI (Backboard agent `sess_44506355` continuation) after the original session ran out of usage limits.

## What was found

- **Backboard session `sess_44506355`**: This was the R-CLI invocation that started exploring the workspace to read session transcripts and the GitHub discussion board. It got as far as reading `meta.json` and beginning `client.jsonl` before credits ran out.

- **OpenCode (`src/encoder.ts`)**: OpenCode created `src/encoder.ts` — a `JpegEncoder` class with a persistent ffmpeg process and `JpegStreamParser` that replaces the per-frame ffmpeg spawning. The file was written but never committed (`?? src/encoder.ts` in `git status`) and never integrated into the worker.

- **GitHub Discussion #2 (Collaborator work board)**: Tasks A–E are outlined. Infinaut completed Task A on branch `task-a-tracking-integration` (commit `036ea0a`) but needs rebase onto `83406e0`. The lead (Ant-Throw-Pology) was taking Task B via OpenCode. Tasks C, D, E remain unclaimed.

## What was done (on `main` at `83406e0`)

**Integrated the persistent JPEG encoder into `src/worker.ts`:**
- Removed the per-frame `jpeg()` function that spawned ffmpeg for every frame
- Added `JpegEncoder` import from `./encoder`
- Created and started a `JpegEncoder` instance in `main()` after camera start
- Replaced the `jpeg()` call with `encoder.encode(frame.bgr)`
- Added `encoder?.stop()` in the `finally` block so the persistent process is cleaned up on exit

**Verification (all pass):**
- `bun check` — 34 files, no type errors
- `bun test` — 27 pass, 1 skip (Unix socket soak), 0 fail
- `bun run build` — all 6 bundles emitted

## Remaining work
- Task A branch `task-a-tracking-integration` should be rebased onto `83406e0`
- Tasks C (browser/UI tests), D (RKNN/AprilTag ABI audit), E (deployment/ops) are open
- The stop-ship items from `docs/REVIEW.md` still apply
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
cp src/apriltag_ffi.c dist/

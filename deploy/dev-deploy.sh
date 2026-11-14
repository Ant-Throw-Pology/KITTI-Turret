#!/usr/bin/env bash
# dev:deploy — fast local build → remote deploy → run on target
# Usage: bun run dev:deploy user@host
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Argument validation ──────────────────────────────────────────────────────────
if [ "$#" -ne 1 ]; then
  echo "usage: bun run dev:deploy user@host" >&2
  exit 2
fi
host="$1"
if [[ "$host" != *@* ]]; then
  echo "error: argument must be user@host (got '$host')" >&2
  exit 2
fi

# ── Local build gates ────────────────────────────────────────────────────────────
echo "◆ bun check (typecheck)"
bun check

echo "◆ bun run build"
bun run build

# ── Additional runtime artifacts ─────────────────────────────────────────────────
echo "◆ copy runtime artifacts"
# apriltag_ffi.c — compiled on target to produce tag-helper binary
cp src/apriltag_ffi.c dist/apriltag_ffi.c

# ── Rsync: self-contained clean deployment ───────────────────────────────────────
echo "◆ rsync to ${host}"
# dist/ — server bundle, frontend assets, worker entry, C source
rsync -az --delete --exclude='node_modules' dist/ "${host}":~/kitti-turret/dist/
# package manifest — used for target-native dependency install
rsync -az package.json bun.lock "${host}":~/kitti-turret/

# ── Target-native dependency installation ────────────────────────────────────────
echo "◆ install production dependencies on target"
ssh "${host}" 'cd ~/kitti-turret && bun install --frozen-lockfile --production 2>&1'

# ── AprilTag compilation (optional, nonfatal) ────────────────────────────────────
echo "◆ compile apriltag tag-helper (optional)"
ssh "${host}" 'cd ~/kitti-turret/dist && cc -O2 apriltag_ffi.c -lapriltag -o tag-helper 2>/dev/null && echo "  tag-helper built" || echo "  tag-helper skipped (apriltag library not available on target)"'

# ── Run server via SSH with forced TTY ────────────────────────────────────────────
# Ctrl+C propagates through ssh -tt; the exec chain replaces the shell so SIGINT
# reaches bun directly.  turret.env is never synced; it is read from the target.
echo "◆ starting server on ${host} (Ctrl+C to stop)"
exec ssh -tt "${host}" 'cd ~/kitti-turret && if [ -f ./turret.env ]; then set -a; . ./turret.env; set +a; fi; : "${KITTI_HOST:=0.0.0.0}"; export KITTI_HOST; exec bun dist/index.js'
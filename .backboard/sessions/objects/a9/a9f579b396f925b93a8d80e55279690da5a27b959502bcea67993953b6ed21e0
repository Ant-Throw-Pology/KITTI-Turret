#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -lt 1 ]; then echo 'usage: deploy/deploy.sh user@host [--run]' >&2; exit 2; fi
host="$1"
./deploy/build.sh
rsync -az --delete --exclude='node_modules' --exclude='.git' dist/ "$host":~/kitti-turret/dist/
rsync -az package.json bun.lock deploy/turret.service "$host":~/kitti-turret/
if [ "${2:-}" = '--run' ]; then ssh -tt "$host" 'cd ~/kitti-turret && bun dist/index.js'; fi

#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then echo 'usage: deploy/deploy.sh user@host [--run]' >&2; exit 2; fi
host="$1"
remote_dir='~/kitti-turret'

./deploy/build.sh
ssh "$host" "mkdir -p $remote_dir/dist"
rsync -az --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='coverage/' \
  --exclude='*.tsbuildinfo' \
  dist/ "$host:$remote_dir/dist/"
rsync -az \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='coverage/' \
  --exclude='*.tsbuildinfo' \
  package.json bun.lock deploy/turret.service deploy/OPERATIONS.md "$host:$remote_dir/"
if [ "${2:-}" = '--run' ]; then ssh -tt "$host" "cd $remote_dir && bun dist/index.js"; fi

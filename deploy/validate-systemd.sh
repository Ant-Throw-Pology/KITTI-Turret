#!/usr/bin/env bash
set -euo pipefail

service_file="$(cd "$(dirname "$0")" && pwd)/turret.service"

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$service_file"
fi

grep -qx 'KillMode=control-group' "$service_file"
grep -Eq '^TimeoutStopSec=[1-9][0-9]*$' "$service_file"
grep -qx 'Restart=on-failure' "$service_file"

if [ "${1:-}" != '' ]; then
  ssh "$1" 'systemctl --user cat kitti-turret.service >/dev/null && systemctl --user show kitti-turret.service -p KillMode -p TimeoutStopUSec -p Restart --no-pager'
fi

echo 'systemd service validation completed without starting the turret service'

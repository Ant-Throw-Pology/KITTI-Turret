# KITTI turret deployment operations

## Clean build artifact layout

Run the deployment build from a clean checkout:

```sh
deploy/build.sh
```

The script runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, and `bun run build`. It then verifies that `dist/` contains only the expected deploy files and writes `dist/MANIFEST.sha256` for transfer verification.

## Sync and preserved target modules

Deploy to the Pi with:

```sh
deploy/deploy.sh antthrowpology@10.67.0.1
```

The sync excludes `.git/`, `node_modules/`, coverage, and TypeScript build caches. This keeps any Pi-installed architecture-specific `node_modules` in place instead of replacing them with development-host modules.

If the service should be installed or refreshed, copy `deploy/turret.service` to `~/.config/systemd/user/kitti-turret.service`, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable kitti-turret.service
```

Validate the unit without starting GPIO control:

```sh
deploy/validate-systemd.sh antthrowpology@10.67.0.1
```

`turret.service` uses `KillMode=control-group` and `TimeoutStopSec=5` so systemd stops the Bun process and its child process group on restart or shutdown.

## Udev and group setup

The runtime user must be able to read the camera and GPIO devices:

```sh
sudo usermod -aG video,gpio "$USER"
```

Log out and back in after changing groups. Verify membership and device access before enabling the service:

```sh
id
ls -l /dev/video* /dev/gpiochip*
```

## Pi hardware checklist and result template

Record exact results before any GPIO output or pump/motor actuation:

| Check | Command or observation | Result |
| --- | --- | --- |
| Host architecture | `uname -m` |  |
| Bun version | `bun --version` |  |
| User groups | `id` includes `video` and `gpio` |  |
| Camera nodes | `ls -l /dev/video0 /dev/video1 /dev/video2 /dev/video3 /dev/video4 /dev/video5` |  |
| GPIO chips | `ls -l /dev/gpiochip*` |  |
| RKNN runtime | `ls -l /usr/lib/librknnrt.so` |  |
| libgpiod runtime | `ldconfig -p | grep libgpiod` |  |
| AprilTag library | `ldconfig -p | grep apriltag` |  |
| Service file | `systemctl --user cat kitti-turret.service` |  |
| Service shutdown settings | `deploy/validate-systemd.sh` |  |
| Build manifest on Pi | `cd ~/kitti-turret/dist && sha256sum -c MANIFEST.sha256` |  |
| Camera frame probe | `ffmpeg` single-frame read from selected `/dev/videoN` |  |
| GPIO output safety | physical e-stop and no pump/motor actuation confirmed |  |

After the read-only checklist is complete, record separately any authorized pump relay polarity, motor direction, limit switch, e-stop latency, and one-hour full-stack soak results.

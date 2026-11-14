import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const build = readFileSync('deploy/build.sh', 'utf8');
const deploy = readFileSync('deploy/deploy.sh', 'utf8');
const service = readFileSync('deploy/turret.service', 'utf8');
const validate = readFileSync('deploy/validate-systemd.sh', 'utf8');
const operations = readFileSync('deploy/OPERATIONS.md', 'utf8');

test('deployment build locks the expected artifact layout', () => {
  for (const file of ['index.js', 'worker.js', 'tag_worker.js', 'npu_smoke.js', 'gpio_read.js', 'client.js', 'index.html', 'style.css', 'apriltag_ffi.c']) {
    expect(build).toContain(file);
  }
  expect(build).toContain('MANIFEST.sha256');
  expect(build).toContain('dist artifact layout changed');
});

test('deployment sync preserves target-only dependencies and excludes development files', () => {
  expect(deploy).toContain("--exclude='.git/'");
  expect(deploy).toContain("--exclude='node_modules/'");
  expect(deploy).toContain("--exclude='coverage/'");
  expect(deploy).toContain('deploy/OPERATIONS.md');
});

test('systemd validation covers restart and shutdown settings without starting GPIO control', () => {
  expect(service).toContain('Restart=on-failure');
  expect(service).toContain('KillMode=control-group');
  expect(service).toContain('TimeoutStopSec=5');
  expect(validate).toContain('systemd-analyze verify');
  expect(validate).toContain('KillMode=control-group');
  expect(validate).not.toContain('systemctl --user start');
});

test('operations doc includes target setup and hardware result template', () => {
  expect(operations).toContain('usermod -aG video,gpio');
  expect(operations).toContain('sha256sum -c MANIFEST.sha256');
  expect(operations).toContain('Pi hardware checklist and result template');
  expect(operations).toContain('physical e-stop and no pump/motor actuation confirmed');
});

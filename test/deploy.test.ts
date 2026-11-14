import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const devDeploy = join(root, 'deploy/dev-deploy.sh');
const buildSh = join(root, 'deploy/build.sh');

test('dev-deploy.sh exists and is executable', () => {
  expect(existsSync(devDeploy)).toBe(true);
  const mode = Bun.spawnSync(['stat', '-c', '%A', devDeploy]);
  expect(mode.stdout.toString()).toMatch(/x/);
});

test('dev-deploy.sh exits 2 with no arguments', () => {
  const result = Bun.spawnSync(['bash', devDeploy]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toMatch(/usage|error/i);
});

test('dev-deploy.sh exits 2 with two arguments', () => {
  const result = Bun.spawnSync(['bash', devDeploy, 'user@host', 'extra']);
  expect(result.exitCode).toBe(2);
});

test('dev-deploy.sh exits 2 with argument missing @', () => {
  const result = Bun.spawnSync(['bash', devDeploy, 'nousername']);
  expect(result.exitCode).toBe(2);
});

// ── Source-contract checks for deploy scripts ─────────────────────────────

test('build.sh does not copy raw web HTML/CSS alongside Bun-imported assets', async () => {
  // The Bun HTML-import build already rewrites index.html and emits hashed
  // CSS/JS bundles.  build.sh must not overwrite those with raw source copies.
  const content = await Bun.file(buildSh).text();
  expect(content).not.toMatch(/src\/web\/index\.html/);
  expect(content).not.toMatch(/src\/web\/style\.css/);
});

test('build.sh still copies apriltag_ffi.c', async () => {
  const content = await Bun.file(buildSh).text();
  expect(content).toMatch(/apriltag_ffi\.c dist\//);
});

test('dev-deploy.sh passes bash -n syntax check', () => {
  const result = Bun.spawnSync(['bash', '-n', devDeploy]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
});

test('dev-deploy.sh uses if-block for optional env sourcing', async () => {
  // The old pattern `{ [ -f turret.env ] && …; } && next` made the whole chain
  // fail when turret.env was absent.  The fix uses `if [ -f ./turret.env ]; then …; fi;`
  // so execution always continues past the block.
  const content = await Bun.file(devDeploy).text();
  expect(content).toMatch(/if \[ -f \.\/turret\.env \]; then/);
  expect(content).toMatch(/\.\/turret\.env/);
  // Verify the old broken &&-chain pattern is gone
  expect(content).not.toMatch(/\{\s*\[ -f turret\.env \] &&/);
});

test('dev-deploy.sh defaults and exports KITTI_HOST on target', async () => {
  const content = await Bun.file(devDeploy).text();
  // Default value must be present
  expect(content).toMatch(/KITTI_HOST:=0\.0\.0\.0/);
  // export must appear in the remote command
  expect(content).toMatch(/export KITTI_HOST/);
  // Extract the remote command string from the exec ssh line to verify ordering
  const sshLine = content.split('\n').find(l => l.includes('exec ssh'));
  expect(sshLine).not.toBe(undefined);
  const quoteMatch = sshLine!.match(/'([^']+)'/);
  expect(quoteMatch).not.toBeNull();
  const remoteCmd = quoteMatch![1]!;
  const defaultPos = remoteCmd.indexOf('KITTI_HOST:=');
  const exportPos = remoteCmd.indexOf('export KITTI_HOST');
  const execPos = remoteCmd.indexOf('exec bun');
  expect(defaultPos).toBeGreaterThan(0);
  expect(exportPos).toBeGreaterThan(0);
  expect(defaultPos).toBeLessThan(exportPos);
  expect(execPos).toBeGreaterThan(exportPos);
});

test('dev-deploy.sh does not sync turret.env', async () => {
  // turret.env lives on the target and must not be overwritten by rsync.
  // The rsync calls should only touch dist/ and package manifest files.
  const content = await Bun.file(devDeploy).text();
  // rsync lines should not mention turret.env
  const rsyncLines = content.split('\n').filter(l => l.startsWith('rsync'));
  for (const line of rsyncLines) {
    expect(line).not.toMatch(/turret\.env/);
  }
});

test('build produces expected artifact layout', async () => {
  // Run the package.json build script (same build used by dev-deploy.sh),
  // then verify all required artifacts land in dist/.
  const buildResult = Bun.spawnSync(['bun', 'run', 'build'], { cwd: root, stderr: 'pipe' });
  expect(buildResult.exitCode).toBe(0);

  // Verify the files the server expects at runtime
  expect(existsSync(join(root, 'dist/index.js'))).toBe(true);
  expect(existsSync(join(root, 'dist/worker.js'))).toBe(true);
  expect(existsSync(join(root, 'dist/apriltag_ffi.c'))).toBe(false); // not produced by build; copied in deploy

  // Verify built index HTML has no CDN or import map references
  const indexHtml = await Bun.file(join(root, 'dist/web/index.html')).text();
  expect(indexHtml).not.toMatch(/importmap/);
  expect(indexHtml).not.toMatch(/https?:\/\//);

  // Verify worker artifact is bundled (no unresolved relative imports)
  const workerContent = await Bun.file(join(root, 'dist/worker.js')).text();
  expect(workerContent).not.toMatch(/from\s+["']\.\//);

  // Verify frontend assets exist alongside the manifest (CSS and hashed JS bundle)
  const distFiles = Bun.spawnSync(['ls', join(root, 'dist')]).stdout.toString();
  expect(distFiles).toMatch(/\.css/);
  expect(distFiles).toMatch(/^index-[a-z0-9]+\.js/m);
});

test('remote command logic reaches exec and exports KITTI_HOST in both env scenarios', () => {
  // Create a temporary sandbox
  const tmpDir = Bun.spawnSync(['mktemp', '-d', '--tmpdir=/tmp', 'deploy-test-XXXXX'])
    .stdout.toString().trim();
  // Probe script mirrors the remote command logic (cd, if-block, default, export)
  // and replaces `exec bun dist/index.js` with a child-process env read + marker.
  // Using string concatenation so $ and " are literal in the shell script.
  const ps1 = "cd '" + tmpDir + "'; if [ -f ./turret.env ]; then set -a; . ./turret.env; set +a; fi;";
  const ps2 = ': "${KITTI_HOST:=0.0.0.0}"; export KITTI_HOST;';
  const ps3 = ' bash -c \'echo "KITTI_HOST=$KITTI_HOST"\';';
  const ps4 = " echo 'EXEC_REACHED'";
  const probeScript = ps1 + ps2 + ps3 + ps4;

  try {
    // 1. No turret.env -> default 0.0.0.0 used and exported to child
    const r1 = Bun.spawnSync(['bash', '-c', probeScript]);
    expect(r1.exitCode).toBe(0);
    const out1 = r1.stdout.toString().trim();
    expect(out1).toMatch(/KITTI_HOST=0\.0\.0\.0/);
    expect(out1).toMatch(/EXEC_REACHED/);

    // 2. turret.env with KITTI_HOST=customhost -> custom value preserved and exported
    Bun.spawnSync(['bash', '-c', 'echo KITTI_HOST=customhost > "' + tmpDir + '/turret.env"']);
    const r2 = Bun.spawnSync(['bash', '-c', probeScript]);
    expect(r2.exitCode).toBe(0);
    const out2 = r2.stdout.toString().trim();
    expect(out2).toMatch(/KITTI_HOST=customhost/);
    expect(out2).toMatch(/EXEC_REACHED/);

    // 3. turret.env present but does not set KITTI_HOST -> default 0.0.0.0 used
    Bun.spawnSync(['bash', '-c', 'echo OTHER_VAR=hello > "' + tmpDir + '/turret.env"']);
    const r3 = Bun.spawnSync(['bash', '-c', probeScript]);
    expect(r3.exitCode).toBe(0);
    const out3 = r3.stdout.toString().trim();
    expect(out3).toMatch(/KITTI_HOST=0\.0\.0\.0/);
    expect(out3).toMatch(/EXEC_REACHED/);
  } finally {
    Bun.spawnSync(['rm', '-rf', tmpDir]);
  }
});
export type Config = {
  host: string; port: number; socket: string; model: string; camera: string;
  width: number; height: number; fps: number; jpegQuality: number;
  relayActiveHigh: boolean | null; yawNegativeSwitch: string | null;
  maxPumpMs: number; pulseMs: number; maxSteps: number;
  trustedOrigin: string;
};

const number = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
  return value;
};

export function loadConfig(): Config {
  const polarity = process.env.KITTI_RELAY_ACTIVE_HIGH;
  if (polarity !== undefined && polarity !== '0' && polarity !== '1') throw new Error('KITTI_RELAY_ACTIVE_HIGH must be 0 or 1');
  return {
    host: process.env.KITTI_HOST ?? '127.0.0.1',
    port: number('KITTI_PORT', 8080, 1, 65535),
    socket: process.env.KITTI_SOCKET ?? '/tmp/kitti-turret.sock',
    model: process.env.KITTI_MODEL ?? '', camera: process.env.KITTI_CAMERA ?? 'auto',
    width: number('KITTI_WIDTH', 640, 64, 4096), height: number('KITTI_HEIGHT', 480, 64, 4096),
    fps: number('KITTI_FPS', 20, 1, 120), jpegQuality: number('KITTI_JPEG_QUALITY', 60, 1, 100),
    relayActiveHigh: polarity === undefined ? null : polarity === '1',
    yawNegativeSwitch: process.env.KITTI_YAW_NEGATIVE_SWITCH ?? null,
    maxPumpMs: number('KITTI_MAX_PUMP_MS', 10000, 50, 60000),
    pulseMs: number('KITTI_PULSE_MS', 500, 50, 2000),
    maxSteps: number('KITTI_MAX_STEPS', 57600, 1, 1000000),
    trustedOrigin: process.env.KITTI_TRUSTED_ORIGIN ?? ''
  };
}

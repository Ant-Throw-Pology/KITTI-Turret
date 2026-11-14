export interface SafetyServices {
  track?: { enable(on: boolean): void };
  manual?: { stop(): void; enable(on: boolean): void; estop(): void };
  axes?: Record<'yaw' | 'pitch', { forceDisable(): void }>;
  pump?: { stop(): void; estop(): void };
  worker?: { destroy(): void };
  supervisor?: { stop(): Promise<void> };
  broadcast?: (msg: unknown) => void;
}

function attempt(label: string, fn: () => void, errors: string[]): void {
  try { fn(); } catch (e) { errors.push(`${label}: ${e}`); }
}

/** Collect errors without throwing — every action is attempted independently. */
async function attemptAsync(label: string, fn: () => Promise<void>, errors: string[]): Promise<void> {
  try { await fn(); } catch (e) { errors.push(`${label}: ${e}`); }
}

/**
 * Ordered safe stop that isolates each domain so one failure cannot skip others.
 * Local control stop — does NOT destroy the inference worker or supervisor.
 * Use estop() or explicit teardown when the worker must also stop.
 */
export function safeStop(services: SafetyServices): string[] {
  const errors: string[] = [];
  attempt('track.enable(false)', () => services.track?.enable(false), errors);
  attempt('manual.stop', () => services.manual?.stop(), errors);
  attempt('axes yaw.forceDisable', () => services.axes?.yaw?.forceDisable(), errors);
  attempt('axes pitch.forceDisable', () => services.axes?.pitch?.forceDisable(), errors);
  attempt('pump.stop', () => services.pump?.stop(), errors);
  attempt('manual.enable(false)', () => services.manual?.enable(false), errors);
  return errors;
}

/**
 * Ordered e-stop that isolates each domain so one failure cannot skip others.
 * Safety redundancy is preferable — actions like EN-high and pump-off are harmless
 * when repeated, so every domain is always attempted independently.
 */
export async function estop(services: SafetyServices): Promise<string[]> {
  const errors: string[] = [];
  attempt('track.enable(false)', () => services.track?.enable(false), errors);
  attempt('manual.stop', () => services.manual?.stop(), errors);
  attempt('manual.estop', () => services.manual?.estop(), errors);
  attempt('axes yaw.forceDisable', () => services.axes?.yaw?.forceDisable(), errors);
  attempt('axes pitch.forceDisable', () => services.axes?.pitch?.forceDisable(), errors);
  attempt('pump.estop', () => services.pump?.estop(), errors);
  attempt('pump.stop', () => services.pump?.stop(), errors);

  try {
    services.broadcast?.({
      type: 'motorState',
      enabled: false,
      moving: false,
      speed: 100,
      error: 'E-stop',
    });
  } catch (e) { errors.push(`broadcast: ${e}`); }

  attempt('worker.destroy', () => services.worker?.destroy(), errors);
  await attemptAsync('supervisor.stop', async () => { await services.supervisor?.stop(); }, errors);
  return errors;
}
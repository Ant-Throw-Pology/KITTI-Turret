/**
 * Water hold-release pump controller shared by the production component and tests.
 */
export type WaterAction =
  | { type: 'pulse'; durationMs: number }
  | { type: 'hold-on' }
  | { type: 'off' };

export interface WaterController {
  start(): void;
  stop(pulseMs: number): void;
  cancel(): void;
}

export function createWaterController(
  emit: (action: WaterAction) => void,
  pulseThresholdMs = 250,
  timer?: { setTimeout: (cb: () => void, ms: number) => unknown; clearTimeout: (id?: unknown) => void },
): WaterController {
  const st = timer?.setTimeout ?? setTimeout;
  const ct = timer?.clearTimeout ?? clearTimeout as (id?: unknown) => void;

  let down = false;
  let held = false;
  let timerId: unknown;

  function start(): void {
    if (down) return;
    down = true;
    held = false;
    timerId = st(() => {
      if (!down) return;
      held = true;
      emit({ type: 'hold-on' });
    }, pulseThresholdMs);
  }

  function stop(pulseMs: number): void {
    if (!down) return;
    down = false;
    ct(timerId);
    timerId = undefined;
    if (held) {
      emit({ type: 'off' });
      held = false;
    } else {
      emit({ type: 'pulse', durationMs: pulseMs });
    }
  }

  function cancel(): void {
    if (!down) return;
    down = false;
    ct(timerId);
    timerId = undefined;
    if (held) {
      emit({ type: 'off' });
      held = false;
    }
  }

  return { start, stop, cancel };
}
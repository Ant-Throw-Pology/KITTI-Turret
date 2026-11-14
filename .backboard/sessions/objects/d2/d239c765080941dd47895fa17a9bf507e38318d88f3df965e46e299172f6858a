export interface ManagedProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface WorkerSupervisorOptions {
  spawn: () => ManagedProcess;
  now?: () => number;
  watchdogMs?: number;
  startupMs?: number;
  restartMs?: number;
  checkMs?: number;
  termMs?: number;
  stopMs?: number;
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  onEvent?: (event: string, detail?: unknown) => void;
}

/** Supervises one inference worker. It never owns the IPC socket. */
export class WorkerSupervisor {
  private process?: ManagedProcess;
  private terminating?: ManagedProcess;
  private timer?: ReturnType<typeof setInterval>;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private stopping = false;
  private latched = false;
  private stopPromise?: Promise<void>;
  private startedAt = 0;
  private lastFrameAt = 0;
  private readonly now: () => number;
  private readonly watchdogMs: number;
  private readonly startupMs: number;
  private readonly restartMs: number;
  private readonly checkMs: number;
  private readonly termMs: number;
  private readonly stopMs: number;
  private readonly killGroup: (pid: number, signal: NodeJS.Signals) => void;

  constructor(private readonly options: WorkerSupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.watchdogMs = options.watchdogMs ?? 5_000;
    this.startupMs = options.startupMs ?? 15_000;
    this.restartMs = options.restartMs ?? 1_000;
    this.checkMs = options.checkMs ?? 1_000;
    this.termMs = options.termMs ?? 2_000;
    this.stopMs = options.stopMs ?? 2_500;
    this.killGroup = options.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
  }

  start(): void {
    if (this.stopPromise || this.latched) return;
    if (this.process || this.terminating || this.restartTimer) return;
    this.stopping = false;
    this.spawn();
    this.timer ??= setInterval(() => this.check(), this.checkMs);
  }

  noteFrame(at = this.now()): void { this.lastFrameAt = at; }

  private spawn(): void {
    if (this.stopping) return;
    const generation = ++this.generation;
    const child = this.options.spawn();
    this.process = child;
    this.startedAt = this.now();
    this.lastFrameAt = 0;
    this.options.onEvent?.('spawn', { pid: child.pid });
    const settle = (event: string, detail: unknown) => {
      if (this.process === child) this.process = undefined;
      if (this.terminating === child) this.terminating = undefined;
      this.latched = false;
      this.options.onEvent?.(event, detail);
      if (!this.stopping && generation === this.generation) this.scheduleRestart();
    };
    void child.exited.then(
      code => settle('exit', { pid: child.pid, code }),
      error => settle('error', error),
    );
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawn();
    }, this.restartMs);
  }

  private check(): void {
    const child = this.process;
    if (!child || this.stopping || this.terminating === child) return;
    const age = this.now() - (this.lastFrameAt || this.startedAt);
    const limit = this.lastFrameAt ? this.watchdogMs : this.startupMs;
    if (age <= limit) return;
    this.options.onEvent?.('watchdog', { pid: child.pid, age });
    this.terminate(child);
  }

  private signal(child: ManagedProcess, signal: NodeJS.Signals): void {
    try { this.killGroup(child.pid, signal); }
    catch { try { child.kill(signal); } catch { /* already exited or group gone */ } }
  }

  private terminate(child: ManagedProcess): void {
    if (this.terminating === child) return;
    this.terminating = child;
    this.signal(child, 'SIGTERM');
    let exited = false;
    const escalation = setTimeout(() => {
      if (exited || this.terminating !== child) return;
      this.signal(child, 'SIGKILL');
    }, this.termMs);
    const clear = () => { exited = true; clearTimeout(escalation); };
    void child.exited.then(clear, clear);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.timer = undefined;
    this.restartTimer = undefined;

    const child = this.process ?? this.terminating;
    if (!child) {
      this.stopPromise = Promise.resolve().then(() => { this.stopPromise = undefined; });
      return this.stopPromise;
    }

    this.terminate(child);
    let settled = false;
    const onExit = () => { settled = true; };
    void child.exited.then(onExit, onExit);
    const waitMs = Math.max(this.stopMs, this.termMs + 100);
    this.stopPromise = Promise.race([
      child.exited.then(() => undefined, () => undefined),
      Bun.sleep(waitMs),
    ]).then(() => {
      if (settled) {
        if (this.process === child) this.process = undefined;
        if (this.terminating === child) this.terminating = undefined;
        this.latched = false;
      } else {
        this.latched = true;
      }
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  get pid(): number | undefined { return this.process?.pid; }
}

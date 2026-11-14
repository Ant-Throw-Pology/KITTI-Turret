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
  private startedAt = 0;
  private lastFrameAt = 0;
  private readonly now: () => number;
  private readonly watchdogMs: number;
  private readonly startupMs: number;
  private readonly restartMs: number;
  private readonly checkMs: number;
  private readonly killGroup: (pid: number, signal: NodeJS.Signals) => void;

  constructor(private readonly options: WorkerSupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.watchdogMs = options.watchdogMs ?? 5_000;
    this.startupMs = options.startupMs ?? 15_000;
    this.restartMs = options.restartMs ?? 1_000;
    this.checkMs = options.checkMs ?? 1_000;
    this.killGroup = options.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
  }

  start(): void {
    if (this.process || this.restartTimer) return;
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
    void child.exited.then(code => {
      if (this.process === child) this.process = undefined;
      if (this.terminating === child) this.terminating = undefined;
      this.options.onEvent?.('exit', { pid: child.pid, code });
      if (!this.stopping && generation === this.generation) this.scheduleRestart();
    }, error => {
      if (this.process === child) this.process = undefined;
      if (this.terminating === child) this.terminating = undefined;
      this.options.onEvent?.('error', error);
      if (!this.stopping && generation === this.generation) this.scheduleRestart();
    });
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

  private terminate(child: ManagedProcess): void {
    if (this.terminating === child) return;
    this.terminating = child;
    try { this.killGroup(child.pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch { /* already exited */ } }
    const generation = this.generation;
    const escalation = setTimeout(() => {
      if (this.process !== child || this.generation !== generation) return;
      try { this.killGroup(child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
    }, 2_000);
    void child.exited.finally(() => clearTimeout(escalation));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.timer = undefined;
    this.restartTimer = undefined;
    const child = this.process;
    if (!child) return;
    this.terminate(child);
    await Promise.race([child.exited.catch(() => -1), Bun.sleep(2_500)]);
    if (this.process === child) this.process = undefined;
    if (this.terminating === child) this.terminating = undefined;
  }

  get pid(): number | undefined { return this.process?.pid; }
}

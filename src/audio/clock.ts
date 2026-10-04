// Scheduler clock. Ticks come from a tiny inline Web Worker because worker timers keep running at full rate
// in background tabs (main-thread timers get throttled to 1 Hz or worse). Falls back to setInterval.

const WORKER_SRC = `let iv = null;
onmessage = (e) => {
  const d = e.data || {};
  if (d.cmd === 'start') { clearInterval(iv); iv = setInterval(() => postMessage(0), d.ms || 25); }
  else if (d.cmd === 'stop') { clearInterval(iv); iv = null; }
};`;

export class WorkerClock {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private onTick: () => void,
    private intervalMs = 25,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.worker) {
        const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
        this.worker = new Worker(url);
        this.worker.onmessage = () => this.onTick();
        // keep the URL alive until the worker has started, then release it
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      this.worker.postMessage({ cmd: 'start', ms: this.intervalMs });
    } catch {
      this.worker = null;
      this.timer = setInterval(() => this.onTick(), this.intervalMs);
    }
    this.onTick();
  }

  stop() {
    this.running = false;
    this.worker?.postMessage({ cmd: 'stop' });
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }
}

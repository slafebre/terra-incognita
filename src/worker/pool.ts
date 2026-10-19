import type { TaskRequest, TaskResult, WorkerRequest, WorkerResponse } from './protocol';

interface Slot {
  worker: Worker;
  busy: boolean;
}

/** Fixed-size pool; one task per worker at a time. The caller decides what to run next. */
export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, { resolve: (r: TaskResult) => void; reject: (e: Error) => void; slot: Slot }>();
  private nextId = 1;

  constructor(size: number, private readonly onIdle: () => void) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, busy: false };
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.receive(e.data);
      worker.onerror = (e) => console.error('worker error', e.message);
      this.slots.push(slot);
    }
  }

  get size(): number {
    return this.slots.length;
  }

  get idle(): number {
    return this.slots.filter((s) => !s.busy).length;
  }

  run(task: TaskRequest, transfer: Transferable[] = []): Promise<TaskResult> {
    const slot = this.slots.find((s) => !s.busy);
    if (!slot) return Promise.reject(new Error('no idle worker'));
    slot.busy = true;
    const id = this.nextId++;
    const msg: WorkerRequest = { id, task };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, slot });
      slot.worker.postMessage(msg, transfer);
    });
  }

  private receive(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    p.slot.busy = false;
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
    // After the task's own continuation has run, so its result is stored first.
    queueMicrotask(this.onIdle);
  }
}

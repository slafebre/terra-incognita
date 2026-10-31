import type { TaskRequest, TaskResult, WorkerConfig, WorkerRequest, WorkerResponse, WorkerTiles } from './protocol';

interface Slot {
  worker: Worker;
  busy: boolean;
}

/** What the chunk manager needs from a pool (a fake implements it in tests). */
export interface TaskRunner {
  readonly size: number;
  readonly idle: number;
  run(task: TaskRequest, transfer?: Transferable[]): Promise<TaskResult>;
  /** Hands coarse tiles to every worker (pools running tasks in-process share one cache and need not). */
  shareTiles?(msg: WorkerTiles): void;
}

/**
 * Replacements after an error, per worker of the pool: the pool replaces this many times its
 * size in all, whichever workers fail, and never more (one that can't even start would be
 * replaced for ever). After that, each worker that fails takes its slot out of use.
 */
const RESTARTS = 4;

/** Fixed-size pool; one task per worker at a time. The caller decides what to run next. */
export class WorkerPool implements TaskRunner {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, { resolve: (r: TaskResult) => void; reject: (e: Error) => void; slot: Slot }>();
  private nextId = 1;
  private restarts = 0;

  constructor(
    size: number,
    private readonly onIdle: () => void,
    private readonly config: WorkerConfig['config'] = { regionOverride: NaN },
    /** Starts a worker (tests pass a fake). */
    private readonly spawn: () => Worker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  ) {
    for (let i = 0; i < size; i++) {
      const slot = { busy: false } as Slot;
      this.start(slot);
      this.slots.push(slot);
    }
  }

  get size(): number {
    return this.slots.length;
  }

  shareTiles(msg: WorkerTiles): void {
    // (The worker that made them has them already; it ignores the copy.)
    for (const s of this.slots) s.worker.postMessage(msg);
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
      try {
        slot.worker.postMessage(msg, transfer);
      } catch (err) {
        // Not sent (something that can't be cloned or transferred): the worker is still free.
        this.pending.delete(id);
        slot.busy = false;
        reject(err instanceof Error ? err : new Error(String(err)));
        queueMicrotask(this.onIdle);
      }
    });
  }

  /** Starts a worker in `slot` (again, after its last one failed). */
  private start(slot: Slot): void {
    const worker = this.spawn();
    slot.worker = worker;
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.receive(e.data);
    // An error outside a task's own try (a module that won't load, a result that can't be
    // sent, memory run out) or a reply that can't be read: no reply will come.
    worker.onerror = (e) => slot.worker === worker && this.lost(slot, `worker error: ${e.message}`);
    worker.onmessageerror = () => slot.worker === worker && this.lost(slot, 'worker reply could not be read');
    worker.postMessage({ config: this.config } satisfies WorkerConfig);
  }

  /**
   * The worker in `slot` won't answer: fail its task, so whatever waits on it can try
   * again, and replace the worker, whose state can't be trusted (it makes the coarse tiles
   * it misses itself). Once the pool has used its replacements (RESTARTS × its size, shared
   * by every slot), the slot stays busy: out of use.
   */
  private lost(slot: Slot, why: string): void {
    console.error(why);
    slot.worker.terminate();
    for (const [id, p] of this.pending)
      if (p.slot === slot) {
        this.pending.delete(id);
        p.reject(new Error(why));
      }
    if (this.restarts < RESTARTS * this.slots.length) {
      this.restarts++;
      this.start(slot);
      slot.busy = false;
    } else slot.busy = true;
    queueMicrotask(this.onIdle);
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

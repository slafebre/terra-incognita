import { describe, expect, it } from 'vitest';
import { WorkerPool } from '../src/worker/pool';
import type { TaskRequest, TaskResult, WorkerResponse } from '../src/worker/protocol';

/** Stands in for a Web Worker: records what it is sent, and errors or replies on demand. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  readonly got: unknown[] = [];
  terminated = false;
  /** Throw when sent a task, as postMessage does with something it can't clone or transfer. */
  refuse = false;
  postMessage(msg: unknown): void {
    if (this.refuse && typeof msg === 'object' && msg !== null && 'task' in msg) throw new Error('DataCloneError');
    this.got.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Answers the last task it was sent. */
  reply(result: TaskResult): void {
    const { id } = this.got.at(-1) as { id: number };
    this.onmessage?.({ data: { id, ok: true, result } satisfies WorkerResponse } as MessageEvent);
  }
}

const TASK = { kind: 'roads', cx: 0, cy: 0 } as unknown as TaskRequest;
const RESULT: TaskResult = { kind: 'roads', result: [], ms: 1 };

function pool(size = 1) {
  const workers: FakeWorker[] = [];
  let idles = 0;
  const p = new WorkerPool(size, () => idles++, { regionOverride: NaN }, () => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as Worker;
  });
  return { p, workers, idles: () => idles };
}

/** Whether `p` has settled, and how, after pending callbacks have run. */
async function settled(p: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  let state: 'resolved' | 'rejected' | 'pending' = 'pending';
  p.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  await new Promise((r) => setTimeout(r, 0));
  return state;
}

describe('worker pool', () => {
  it('runs a task on a worker and frees it', async () => {
    const { p, workers } = pool();
    const run = p.run(TASK);
    expect(p.idle).toBe(0);
    workers[0].reply(RESULT);
    expect(await run).toEqual(RESULT);
    expect(p.idle).toBe(1);
  });

  // An error outside the task's own try (a module that won't load, a result that can't be
  // sent, memory run out): no reply comes. The task waited for ever and its worker stayed
  // busy, so each such error cost a worker for good.
  it('fails the task of a worker that errors, and replaces the worker', async () => {
    const { p, workers, idles } = pool();
    const run = p.run(TASK);
    workers[0].onerror?.({ message: 'boom' } as ErrorEvent);
    expect(await settled(run)).toBe('rejected');
    await expect(run).rejects.toThrow(/boom/);
    expect(p.idle).toBe(1);
    expect(idles()).toBeGreaterThan(0);
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].got[0]).toEqual({ config: { regionOverride: NaN } });
    // The new worker takes the next task.
    const next = p.run(TASK);
    workers[1].reply(RESULT);
    expect(await next).toEqual(RESULT);
  });

  it('fails the task of a worker whose reply cannot be read', async () => {
    const { p, workers } = pool();
    const run = p.run(TASK);
    workers[0].onmessageerror?.({} as MessageEvent);
    expect(await settled(run)).toBe('rejected');
    expect(p.idle).toBe(1);
    expect(workers).toHaveLength(2);
  });

  it('frees the worker when a task cannot be sent', async () => {
    const { p, workers } = pool();
    workers[0].refuse = true;
    const run = p.run(TASK);
    expect(await settled(run)).toBe('rejected');
    expect(p.idle).toBe(1);
  });

  it('stops replacing workers that keep failing', async () => {
    const { p, workers } = pool(2);
    for (let i = 0; i < 50; i++) workers.at(-1)!.onerror?.({ message: 'cannot load' } as ErrorEvent);
    expect(workers.length).toBeLessThan(20);
    expect(p.idle).toBeLessThan(2);
  });
});

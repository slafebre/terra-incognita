import { describe, expect, it, vi } from 'vitest';
import type { WorkerResponse } from '../src/worker/protocol';

// The task itself succeeds; only sending its result back fails.
vi.mock('../src/worker/tasks', () => ({
  runTask: () => ({ result: { kind: 'roads', result: [], ms: 1 }, transfer: [new ArrayBuffer(8)] }),
}));

describe('worker', () => {
  // postMessage throws for a result it can't clone or transfer. Outside the task's try,
  // that went unanswered: the task waited for ever, its worker busy for good.
  it('answers with an error when a result cannot be sent', async () => {
    const sent: WorkerResponse[] = [];
    const self = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage(msg: WorkerResponse, transfer?: Transferable[]) {
        if (msg.ok) throw new Error(`DataCloneError (${transfer?.length} transferred)`);
        sent.push(msg);
      },
    };
    (globalThis as { self?: unknown }).self = self;
    await import('../src/worker/worker');
    expect(() => self.onmessage?.({ data: { id: 7, task: { kind: 'roads' } } } as MessageEvent)).not.toThrow();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 7, ok: false });
    expect(sent[0].ok || sent[0].error).toMatch(/could not be sent.*DataCloneError/s);
  });
});

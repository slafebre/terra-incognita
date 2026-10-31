import { describe, expect, it, vi } from 'vitest';
import { ChunkManager } from '../src/chunks/manager';
import { NODES } from '../src/gen/hydro';
import type { Rect } from '../src/gen/seeds';
import { M_PER_CSS_PX } from '../src/lib/constants';
import type { TaskRunner } from '../src/worker/pool';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';

/**
 * Makes pre data at once (blank surfaces: only the scheduling is under test) and holds
 * every other task for good, counting what it was sent.
 */
class HoldingPool implements TaskRunner {
  busy = 0;
  readonly sent: Record<string, number> = {};
  preChunks = 0;
  onIdle = () => {};
  constructor(readonly size: number) {}
  get idle() {
    return this.size - this.busy;
  }
  run(task: TaskRequest): Promise<TaskResult> {
    this.busy++;
    this.sent[task.kind] = (this.sent[task.kind] ?? 0) + 1;
    if (task.kind !== 'pre') return new Promise(() => {});
    this.preChunks += task.chunks.length;
    const n = NODES * NODES;
    const results = task.chunks.map(() => ({ zPre: new Float32Array(n), R: new Float32Array(n), off: new Float32Array(n) }));
    return new Promise((resolve) =>
      setTimeout(() => {
        this.busy--;
        resolve({ kind: 'pre', results, ms: 1 });
        queueMicrotask(this.onIdle);
      }, 0),
    );
  }
}

/** A desktop window (1920 × 1080 CSS px) at `zoom`, centred on (x, y). */
const screen = (x: number, y: number, zoom: number): Rect => {
  const m = M_PER_CSS_PX / zoom;
  return { x0: x - 960 * m, y0: y - 540 * m, x1: x + 960 * m, y1: y + 540 * m };
};

/** Frames of a view held at `actual` while the desired one waits `lead` m east (main.ts lets it lead by a screen). */
async function hold(zoom: number, lead: number, frames = 120) {
  const pool = new HoldingPool(4);
  const m = new ChunkManager(pool, () => {}, 7);
  pool.onIdle = () => m.schedule();
  const actual = screen(100_000, 50_000, zoom);
  const desired = screen(100_000 + lead, 50_000, zoom);
  for (let f = 0; f < frames; f++) {
    m.update(actual, desired, [100_000 + lead, 50_000]);
    await new Promise((r) => setTimeout(r, 0));
  }
  // (A busy chunk without pre data has its pre task under way.)
  const kept = [...m.chunks.values()].filter((c) => c.pre || c.busy).length;
  return { sent: pool.sent, wasted: pool.preChunks - kept };
}

describe('generation and retention', () => {
  // The view holds still at the edge of the land while the desired one runs on (a held
  // arrow key, a fling). Land made beyond what the manager keeps was dropped the next
  // frame and made again, every frame; pre tasks go first, so nothing else ever ran.
  it.each([
    ['at rest', 0.5, 0],
    ['zoom 1, a screen ahead', 1, 5_000],
    ['zoom 0.5, a screen ahead', 0.5, 10_000],
  ])('%s: keeps all it makes and gets past pre data', async (_, zoom, lead) => {
    const { sent, wasted } = await hold(zoom, lead);
    expect(wasted).toBe(0);
    expect(Object.keys(sent).filter((k) => k !== 'pre').length).toBeGreaterThan(0);
  });

  // GEN_LEAD comes from FORGET less what generation reaches beyond its rectangle. Were it
  // to vanish (FORGET lowered, a town's plan reaching further), generation couldn't run
  // ahead of the view, and past -GEN_MARGIN wouldn't even cover it: the view would wait
  // for good. The manager won't load rather than do that.
  it('refuses constants that leave generation no lead', async () => {
    vi.resetModules();
    vi.doMock('../src/lib/constants', async (original) => ({ ...(await original<object>()), FORGET: 3000 }));
    try {
      await expect(import('../src/chunks/manager')).rejects.toThrow(/GEN_LEAD/);
    } finally {
      vi.doUnmock('../src/lib/constants');
      vi.resetModules();
    }
  });
});

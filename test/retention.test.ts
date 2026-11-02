import { describe, expect, it, vi } from 'vitest';
import { ChunkManager } from '../src/chunks/manager';
import { NODES } from '../src/gen/hydro';
import { NET_CELL, ROAD_C, type NetCell, type RoadEdge } from '../src/gen/roads';
import type { Rect } from '../src/gen/seeds';
import { FARM, type Site } from '../src/gen/settle';
import { CHUNK, M_PER_CSS_PX } from '../src/lib/constants';
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

/** A main road crossing a motorway at an interchange, from (x, y) to a vertex 200 m east. */
const crossing = (i: number, x: number, y: number): RoadEdge => {
  const site = (sx: number, sy: number): Site => ({ id: `s:${sx},${sy}`, rank: FARM, x: sx, y: sy, z: 0, R: 0 });
  return { id: `e:${i}`, cls: ROAD_C, a: site(x, y), b: site(x + 200, y), route: [x, y, x + 200, y], interchange: true };
};

/**
 * Puts `edges` in the net cells round (x, y), as though those cells had been made. Reaching
 * into the manager for it because a net cell waits on its coarse tiles, which the pool above
 * holds for good, so nothing here can make one the ordinary way.
 */
function seedNets(m: ChunkManager, x: number, y: number, edges: RoadEdge[]): void {
  const nets = (m as unknown as { nets: Map<string, { busy: boolean; data: NetCell }> }).nets;
  for (let gy = Math.floor(y / NET_CELL) - 1; gy <= Math.floor(y / NET_CELL) + 1; gy++)
    for (let gx = Math.floor(x / NET_CELL) - 1; gx <= Math.floor(x / NET_CELL) + 1; gx++)
      nets.set(`${gx},${gy}`, { busy: false, data: { sites: [], edges } });
}

/** A desktop window (1920 × 1080 CSS px) at `zoom`, centred on (x, y). */
const screen = (x: number, y: number, zoom: number): Rect => {
  const m = M_PER_CSS_PX / zoom;
  return { x0: x - 960 * m, y0: y - 540 * m, x1: x + 960 * m, y1: y + 540 * m };
};

/** Frames of a view held at `actual` while the desired one waits `lead` m east (main.ts lets it lead by a screen). */
async function hold(zoom: number, lead: number, frames = 120, prepare?: (m: ChunkManager) => void, workers = 4) {
  const pool = new HoldingPool(workers);
  const m = new ChunkManager(pool, () => {}, 7);
  prepare?.(m);
  pool.onIdle = () => m.schedule();
  const actual = screen(100_000, 50_000, zoom);
  const desired = screen(100_000 + lead, 50_000, zoom);
  for (let f = 0; f < frames; f++) {
    m.update(actual, desired, [100_000 + lead, 50_000]);
    await new Promise((r) => setTimeout(r, 0));
  }
  // (A busy chunk without pre data has its pre task under way.)
  const held = [...m.chunks.values()].filter((c) => c.pre || c.busy);
  return { sent: pool.sent, wasted: pool.preChunks - held.length, east: Math.max(...held.map((c) => c.cx)) };
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

  // A roads task building an interchange waits on the solves its ramps merge on, four rings
  // out (IC_GROUND) — further than GEN_LEAD covers, so forget() holds those itself and
  // pick() asks for them off the same reckoning. Both have to be there: ground nothing asks
  // for is never made, and ground nothing keeps is made and dropped again every frame.
  //
  // Four workers are not enough to see it: the tasks this pool holds take every one of them
  // long before the pre data reaches that far, so this case is given as many as it wants.
  it('makes and keeps the solves an interchange asks for', async () => {
    const [x, y] = [100_000, 50_000];
    // Crossing edges running east a chunk apart, so the easternmost chunk to own one lies at
    // the edge of the roads rectangle, where the ground its ramps read reaches furthest out.
    const edges = Array.from({ length: 10 }, (_, i) => crossing(i, x + i * CHUNK, y));
    const plain = await hold(1, 0, 250, undefined, 400);
    const ramps = await hold(1, 0, 250, (m) => seedNets(m, x, y, edges), 400);
    // Pre data runs further east, out to the windows behind the ramps' own ground: four
    // rings of solves and two of windows past the chunk that builds them.
    expect(plain.east).toBeGreaterThan(0); // (nothing held at all would make both -Infinity)
    expect(ramps.east - plain.east).toBeGreaterThanOrEqual(3);
    // …and nothing was made that nothing holds. This says nothing about forget()'s own hold
    // on that ground: today's numbers leave the furthest of it 56 m inside tileKeep, so the
    // hold is dormant and only pick()'s side of the demand is under test here.
    expect(ramps.wasted).toBe(0);
  }, 30000);

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

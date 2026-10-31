import { describe, expect, it, vi } from 'vitest';
import { ChunkManager, forChunksIn } from '../src/chunks/manager';
import { CORE, NODES } from '../src/gen/hydro';
import { CHUNK, DEM_W } from '../src/lib/constants';
import type { TaskRunner } from '../src/worker/pool';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';

/** Set to make building a roads task throw on the main thread (in the manager, not a worker). */
let segmentsThrow = false;
vi.mock('../src/gen/lattice', async (original) => {
  const m = await original<typeof import('../src/gen/lattice')>();
  return {
    ...m,
    latticeSegments: (...a: Parameters<typeof m.latticeSegments>) => {
      if (segmentsThrow) throw new Error('latticeSegments threw');
      return m.latticeSegments(...a);
    },
  };
});

/** Results of the right shapes and nothing in them: only the scheduling is under test. */
function stub(t: TaskRequest): TaskResult {
  const f = (n: number) => new Float32Array(n);
  switch (t.kind) {
    case 'pre':
      return { kind: 'pre', results: t.chunks.map(() => ({ zPre: f(NODES * NODES), R: f(NODES * NODES), off: f(NODES * NODES) })), ms: 1 };
    case 'tile':
      return { kind: 'tile', key: `${t.tx},${t.ty}`, tile: {}, ms: 1 } as unknown as TaskResult;
    case 'net':
      return { kind: 'net', result: { sites: [], edges: [] }, ms: 1 };
    case 'mw':
      return { kind: 'mw', result: [], ms: 1 };
    case 'hydro': {
      const n = CORE * CORE;
      const core = { zE: f(n), A: f(n), rec: new Int8Array(n), lake: f(n).fill(NaN) };
      return { kind: 'hydro', result: { core, stats: { lakes: 0, drained: 0, inflows: 0, cyclesBroken: 0, fills: 0 } }, ms: 1 };
    }
    case 'roads':
      return { kind: 'roads', result: [], ms: 1 };
    case 'dem': {
      const n = DEM_W * DEM_W;
      return { kind: 'dem', result: { dem: f(n), water: f(n), cover: new Int8Array(n), streams: f(0), region: 0 }, ms: 1 };
    }
    case 'render':
      return { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 1 };
    case 'plan':
      throw new Error('no sites, so no plans');
  }
}

/** Answers every task with a stub, except those `fails` picks (given the task and how many of its kind came before, from 1). */
class StubPool implements TaskRunner {
  busy = 0;
  onIdle = () => {};
  readonly sent: Record<string, number> = {};
  constructor(
    readonly size: number,
    private readonly fails: (t: TaskRequest, n: number) => boolean,
  ) {}
  get idle() {
    return this.size - this.busy;
  }
  run(task: TaskRequest): Promise<TaskResult> {
    this.busy++;
    const n = (this.sent[task.kind] = (this.sent[task.kind] ?? 0) + 1);
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        this.busy--;
        if (this.fails(task, n)) reject(new Error(`${task.kind} failed`));
        else resolve(stub(task));
        queueMicrotask(this.onIdle);
      }, 0),
    );
  }
}

const VIEW = { x0: 100_000, y0: 50_000, x1: 101_000, y1: 51_000 };
/** The chunk in the middle of the view. */
const MID = [Math.floor(100_500 / CHUNK), Math.floor(50_500 / CHUNK)];

async function run(fails: (t: TaskRequest, n: number) => boolean) {
  const pool = new StubPool(4, fails);
  // (No waiting between tries: the delays are the manager's business, not this test's.)
  const m = new ChunkManager(pool, () => {}, 7, [0, 0, 0]);
  pool.onIdle = () => m.schedule();
  for (let i = 0; i < 3000 && !m.covered(VIEW); i++) {
    m.update(VIEW, VIEW, [100_500, 50_500]);
    await new Promise((r) => setTimeout(r, 0));
  }
  let drawn = 0;
  let all = 0;
  forChunksIn(VIEW, (cx, cy) => {
    all++;
    if (m.drawable(cx, cy)) drawn++;
  });
  return { m, covered: m.covered(VIEW), drawn, all };
}

describe('failed tasks', { timeout: 60_000 }, () => {
  // A failed task was given up on at once, and with it the land waiting on it: the view
  // held still there for good, "Loading…", and the land could never be forgotten.
  it('are tried again', async () => {
    const { m, covered, drawn, all } = await run((t, n) => t.kind === 'hydro' && n <= 2);
    expect(covered).toBe(true);
    expect(drawn).toBe(all);
    expect(m.stats.errors).toBe(2);
  });

  it('give up on a chunk that keeps failing without holding the view', async () => {
    const { m, covered, drawn, all } = await run((t) => t.kind === 'roads' && t.cx === MID[0] && t.cy === MID[1]);
    expect(covered).toBe(true);
    expect(m.get(MID[0], MID[1])?.failed).toBe(true);
    expect(m.stats.errors).toBe(4);
    expect(drawn).toBeLessThan(all);
  });

  // A chunk's failures added up over its stages and its life, success or not: four
  // passing failures, one per stage, gave it up and passed over the land round it.
  it('count only the failures since the last success', async () => {
    const failed = new Set<string>();
    const { m, covered, drawn, all } = await run(
      (t) => t.kind !== 'pre' && 'cx' in t && t.cx === MID[0] && t.cy === MID[1] && !failed.has(t.kind) && !!failed.add(t.kind),
    );
    expect([...failed].sort()).toEqual(['dem', 'hydro', 'render', 'roads']);
    expect(covered).toBe(true);
    expect(m.get(MID[0], MID[1])?.failed).toBeUndefined();
    expect(drawn).toBe(all);
  });

  it('give up on a net cell that keeps failing without holding the view', async () => {
    const { covered, drawn, all } = await run((t) => t.kind === 'net');
    expect(covered).toBe(true);
    // (Drawn without the cell's roads and settlements.)
    expect(drawn).toBe(all);
  });

  it('include one that throws while it is built, without stopping the frame loop', async () => {
    segmentsThrow = true;
    try {
      const { m, covered } = await run(() => false);
      expect(covered).toBe(true);
      expect(m.stats.errors).toBeGreaterThan(0);
    } finally {
      segmentsThrow = false;
    }
  });
});

import { describe, expect, it } from 'vitest';
import { ChunkManager } from '../src/chunks/manager';
import { APRON, CELLS, DEM_W } from '../src/lib/constants';
import { CORE, CORE_PAD, DX, DY, NODES } from '../src/gen/hydro';
import { streamThreshold } from '../src/gen/dem';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import type { TaskRunner } from '../src/worker/pool';
import { runTask } from '../src/worker/tasks';
import type { Rect } from '../src/gen/seeds';

/** Runs tasks in-process, `size` at a time, asynchronously (like real workers). */
class FakePool implements TaskRunner {
  busy = 0;
  cycles = 0;
  lakes = 0;
  fills = 0;
  onIdle = () => {};
  readonly ms: Record<string, number[]> = {};
  constructor(readonly size: number) {}
  get idle() {
    return this.size - this.busy;
  }
  run(task: TaskRequest): Promise<TaskResult> {
    this.busy++;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.busy--;
        try {
          const r: TaskResult =
            task.kind === 'render'
              ? { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 }
              : runTask(task).result;
          (this.ms[task.kind] ??= []).push(r.ms);
          if (r.kind === 'hydro') {
            this.cycles += r.result.stats.cyclesBroken;
            this.lakes += r.result.stats.lakes;
            this.fills += r.result.stats.fills;
          }
          resolve(r);
        } catch (e) {
          reject(e);
        }
        queueMicrotask(this.onIdle);
      }, 0);
    });
  }
}

async function generate(view: Rect, workers = 3) {
  const pool = new FakePool(workers);
  const m = new ChunkManager(pool, () => {});
  pool.onIdle = () => m.schedule();
  const focus: [number, number] = [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2];
  for (let i = 0; i < 20000 && !m.covered(view); i++) {
    m.update(view, view, focus);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { m, pool };
}

describe('hydrology pipeline', () => {
  it('generates a seamless, draining surface', async () => {
    const view = { x0: 100_000, y0: 50_000, x1: 101_500, y1: 51_200 };
    const { m, pool } = await generate(view);
    expect(m.covered(view)).toBe(true);
    expect(m.stats.errors).toBe(0);
    console.log(`cycles broken: ${pool.cycles}, lakes: ${pool.lakes}, fills >0.5 m: ${pool.fills}`);
    for (const [k, v] of Object.entries(pool.ms))
      console.log(`${k}: ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)} ms × ${v.length}`);

    // DEM edges (and aprons) agree exactly between neighbours.
    let pairs = 0;
    for (const c of m.chunks.values()) {
      if (!c.dem) continue;
      const e = m.get(c.cx + 1, c.cy);
      if (e?.dem) {
        pairs++;
        for (let j = 0; j < DEM_W; j++)
          for (let s = -APRON; s <= APRON; s++)
            expect(c.dem[j * DEM_W + APRON + CELLS + s]).toBe(e.dem[j * DEM_W + APRON + s]);
      }
      const s2 = m.get(c.cx, c.cy + 1);
      if (s2?.dem) {
        pairs++;
        for (let i = 0; i < DEM_W; i++)
          for (let s = -APRON; s <= APRON; s++)
            expect(c.dem[(APRON + CELLS + s) * DEM_W + i]).toBe(s2.dem[(APRON + s) * DEM_W + i]);
      }
    }
    expect(pairs).toBeGreaterThan(8);

    // Seams: mean |second difference| of the DEM across chunk borders and through
    // chunk middles, relative to everywhere else. 1.0 = invisible.
    {
      const sum = { border: 0, middle: 0, other: 0 };
      const cnt = { border: 0, middle: 0, other: 0 };
      for (const c of m.chunks.values()) {
        if (!c.dem) continue;
        for (let j = APRON; j <= APRON + CELLS; j++)
          for (let i = APRON; i <= APRON + CELLS; i++) {
            const o = j * DEM_W + i;
            const kindOf = (v: number) =>
              v === APRON || v === APRON + CELLS ? 'border' : Math.abs(v - (APRON + CELLS / 2)) <= 1 ? 'middle' : 'other';
            // Curvature across x (seams along columns) and across y (seams along rows).
            const kx = kindOf(i);
            sum[kx] += Math.abs(c.dem[o - 1] - 2 * c.dem[o] + c.dem[o + 1]);
            cnt[kx]++;
            const ky = kindOf(j);
            sum[ky] += Math.abs(c.dem[o - DEM_W] - 2 * c.dem[o] + c.dem[o + DEM_W]);
            cnt[ky]++;
          }
      }
      const base = sum.other / cnt.other;
      const border = sum.border / cnt.border / base;
      const middle = sum.middle / cnt.middle / base;
      console.log(`seams: border ${border.toFixed(2)}×, middle ${middle.toFixed(2)}×`);
      expect(border).toBeLessThan(1.3);
      expect(middle).toBeLessThan(1.3);
    }

    // Dead ends: stream nodes whose water goes nowhere visible — including where a
    // stream crosses into a neighbouring chunk, whose rivers come from another solve.
    const coreAt = (gx: number, gy: number) => {
      const c = m.get(Math.floor(gx / NODES), Math.floor(gy / NODES));
      if (!c?.hydro || !c.pre) return undefined;
      const k = (gy - (c.cy * NODES - CORE_PAD)) * CORE + (gx - (c.cx * NODES - CORE_PAD));
      const pk = (gy - c.cy * NODES) * NODES + (gx - c.cx * NODES);
      return { h: c.hydro, k, R: c.pre.R[pk] };
    };
    let streams = 0;
    let deadEnds = 0;
    let handovers = 0;
    for (const c of m.chunks.values()) {
      if (!c.dem) continue;
      for (let j = 0; j < NODES; j++)
        for (let i = 0; i < NODES; i++) {
          const gx = c.cx * NODES + i;
          const gy = c.cy * NODES + j;
          const n = coreAt(gx, gy)!;
          if (n.h.A[n.k] < streamThreshold(n.R) || !Number.isNaN(n.h.lake[n.k])) continue;
          streams++;
          const r = n.h.rec[n.k];
          if (r < 0) {
            deadEnds++;
            continue;
          }
          // Where the neighbouring solve has less water here, rendering carries the
          // stream on downstream anyway (streams propagate); count it for information.
          const q = coreAt(gx + DX[r], gy + DY[r]);
          if (q && Number.isNaN(q.h.lake[q.k]) && q.h.A[q.k] < streamThreshold(q.R)) handovers++;
        }
    }
    console.log(`dead ends: ${deadEnds} of ${streams} stream nodes (${handovers} handovers carried on)`);
    expect(deadEnds).toBe(0);
  }, 180_000);
});

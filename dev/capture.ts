// Runs the pipeline in-process around a few places, seeded as the app's ?seed=n (so
// results don't depend on task order), and hands every task's output on by what it was
// for (chunk, net cell, plan). Shared by dev/golden.ts (field-by-field comparisons) and
// test/golden.test.ts (digests checked on every test run).
import { ChunkManager } from '../src/chunks/manager';
import { setRegionOverride } from '../src/gen/terrain';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

/**
 * A place standing on a diamond interchange, where an N road crosses a motorway and all
 * four ramps are drawn. The other places hold none — interchanges are IC_GAP (5 km) apart
 * at the closest — so without this one nothing pins the ramps at all, and the whole path
 * from `ChunkManager.rampGround` to `mergeable` to `diamondRamps` is unwatched. Here the
 * merge slides 76-106 m to reach ground at grade, so a digest moves if any of it breaks.
 */
export const IC_PLACE: [number, number, number] = [52_417, 30_186, NaN];
/** Places: centre (world m) and forced region (NaN: the region field). */
export const PLACES: [number, number, number][] = [
  [100_750, 50_600, NaN],
  [-41_300, 12_900, 0.1],
  [23_400, -77_100, 0.42],
  [61_800, 88_300, 0.65],
  [-90_200, -30_700, 0.9],
  // Last, so the places before it keep the indices their comparison files were written with.
  IC_PLACE,
];
/** Half the side of the view made at each place (m). */
const HALF = 700;

export type Output = Record<string, unknown>;

const keyOf = (t: TaskRequest, p: number): string[] => {
  switch (t.kind) {
    case 'pre':
      return t.chunks.map(([cx, cy]) => `${p}:pre:${cx},${cy}`);
    case 'net':
      // (Net cells carried their motorway pieces before the motorway stage: kept apart, to compare.)
      return [`${p}:net:${t.gx},${t.gy}`, `${p}:mw:${t.gx},${t.gy}`];
    case 'mw':
      return [`${p}:mw:${t.gx},${t.gy}`];
    case 'plan':
      return [`${p}:plan:${t.input.site.id}`];
    case 'render':
    case 'tile':
      return [];
    default:
      return [`${p}:${t.kind}:${t.cx},${t.cy}`];
  }
};
/** What a result holds, as plain data (render bitmaps can't be made in node). */
const payload = (r: TaskResult): Output[] => {
  switch (r.kind) {
    case 'pre':
      return r.results.map((x) => ({ ...x }));
    case 'hydro':
      return [{ ...r.result.core, stats: r.result.stats }];
    case 'dem':
      return [{ ...r.result }];
    case 'net': {
      const old = (r.result as { motorways?: unknown }).motorways;
      return [{ sites: r.result.sites, edges: r.result.edges }, ...(old ? [{ pieces: old }] : [])];
    }
    case 'mw':
      return [{ pieces: r.result }];
    case 'roads':
      return [{ roads: r.result }];
    case 'plan':
      return [{ ...r.result }];
    default:
      return [];
  }
};

/**
 * Makes the land round each of `places` with world seed `seed`, one task at a time, and
 * calls `out` with each output as it arrives (the manager may keep and change what it
 * gets, so take what you need at once). `ms` collects per-stage timings.
 */
export async function capture(
  seed: number,
  places: [number, number, number][],
  out: (key: string, o: Output) => void,
  ms: Record<string, { ms: number; n: number }> = {},
): Promise<void> {
  let place = 0;
  let mgr: ChunkManager | undefined;
  const pool = {
    size: 1,
    busy: 0,
    get idle() {
      return this.size - this.busy;
    },
    run(task: TaskRequest): Promise<TaskResult> {
      this.busy++;
      return new Promise((resolve) =>
        setTimeout(() => {
          let r: TaskResult;
          if (task.kind === 'render') r = { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 };
          else {
            r = runTask(task).result;
            const s = (ms[task.kind] ??= { ms: 0, n: 0 });
            s.ms += r.ms;
            s.n++;
            const keys = keyOf(task, place);
            payload(r).forEach((o, i) => out(keys[i], o));
          }
          this.busy--;
          resolve(r);
          queueMicrotask(() => mgr?.schedule());
        }, 0),
      );
    },
  };
  for (const [x, y, R] of places) {
    setRegionOverride(R);
    mgr = new ChunkManager(pool, () => {}, seed);
    const view = { x0: x - HALF, y0: y - HALF, x1: x + HALF, y1: y + HALF };
    for (let i = 0; i < 40000 && !mgr.covered(view); i++) {
      mgr.update(view, view, [x, y]);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!mgr.covered(view)) throw new Error(`place ${place} not covered`);
    place++;
  }
  setRegionOverride(NaN);
}

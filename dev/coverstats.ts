// Dev tool: land cover statistics per region, over several random areas.
//   npx vite-node dev/coverstats.ts [areas per region] [R,R,...]
// Runs the real pipeline in-process (no workers, no rendering).
import { ChunkManager } from '../src/chunks/manager';
import { COVER } from '../src/gen/landcover';
import { setRegionOverride } from '../src/gen/terrain';
import { APRON, CELLS, DEM_W } from '../src/lib/constants';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

declare const process: { argv: string[] };

const AREAS = Number(process.argv[2] ?? 3);
const REGIONS = (process.argv[3] ?? '0.08,0.3,0.45,0.6,0.75,0.92').split(',').map(Number);
const NAMES = ['glacier', 'rock', 'scree', 'forest', 'vineyard', 'wetland', 'heath', 'open'];

async function area(R: number): Promise<{ frac: number[]; z: number; slope: number }> {
  setRegionOverride(R);
  const pool = {
    size: 4,
    busy: 0,
    get idle() {
      return this.size - this.busy;
    },
    run(task: TaskRequest): Promise<TaskResult> {
      this.busy++;
      return new Promise((resolve) =>
        setTimeout(() => {
          const r: TaskResult =
            task.kind === 'render'
              ? { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 }
              : runTask(task).result;
          this.busy--;
          resolve(r);
          queueMicrotask(() => m.schedule());
        }, 0),
      );
    },
  };
  const m = new ChunkManager(pool, () => {});
  const x = Math.round((Math.random() - 0.5) * 2e6);
  const y = Math.round((Math.random() - 0.5) * 2e6);
  const view = { x0: x, y0: y, x1: x + 1500, y1: y + 1500 };
  for (let i = 0; i < 20000 && !m.covered(view); i++) {
    m.update(view, view, [x + 750, y + 750]);
    await new Promise((r) => setTimeout(r, 0));
  }
  const counts = new Array(8).fill(0);
  let n = 0;
  let zs = 0;
  let ss = 0;
  const N = DEM_W * DEM_W;
  for (const c of m.chunks.values()) {
    if (!c.dem || !c.cover) continue;
    for (let j = APRON + 1; j < APRON + CELLS; j += 3)
      for (let i = APRON + 1; i < APRON + CELLS; i += 3) {
        const k = j * DEM_W + i;
        if (c.water![k] > 0) continue;
        n++;
        zs += c.dem[k];
        ss += Math.hypot(c.dem[k + 1] - c.dem[k - 1], c.dem[k + DEM_W] - c.dem[k - DEM_W]) / 8;
        let won = 7;
        for (const f of [COVER.glacier, COVER.rock, COVER.scree, COVER.forest, COVER.vineyard, COVER.wetland, COVER.heath])
          if (c.cover[f * N + k] > 0) {
            won = f;
            break;
          }
        counts[won]++;
      }
  }
  return { frac: counts.map((v) => v / n), z: zs / n, slope: ss / n };
}

for (const R of REGIONS) {
  const runs: Awaited<ReturnType<typeof area>>[] = [];
  for (let a = 0; a < AREAS; a++) runs.push(await area(R));
  const mean = (f: (r: (typeof runs)[0]) => number) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
  const parts = NAMES.map((name, i) => `${name} ${(100 * mean((r) => r.frac[i])).toFixed(1)}`);
  const spread = runs.map((r) => (100 * r.frac[COVER.forest]).toFixed(0)).join('/');
  console.log(`R=${R}  z ${mean((r) => r.z).toFixed(0)} m  slope ${mean((r) => r.slope).toFixed(2)}  |  ${parts.join('  ')}  (forest per area ${spread})`);
}

// Dev tool: points of interest per km², by region.
//   npx vite-node dev/pois.ts [km] [R,R,...]
// Runs the whole pipeline in-process over a km × km area per region (world seed SEED=n,
// as the app's ?seed=n) and counts the symbols each chunk's render would draw: its own
// (hilltop chapels and crosses, triangulation points, wayside crosses, springs) and its
// plans' (water towers, reservoirs). LOG=1 lists them as ?at= positions.
import { ChunkManager } from '../src/chunks/manager';
import { CHAPEL, CROSS, placePois, RESERVOIR, SPRING, TOWER, TRIG, type Poi } from '../src/gen/poi';
import { setRegionOverride } from '../src/gen/terrain';
import { CHUNK } from '../src/lib/constants';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

declare const process: { argv: string[]; env: Record<string, string | undefined> };

const KM = Number(process.argv[2] ?? 2);
const REGIONS = (process.argv[3] ?? '0.15,0.4,0.7').split(',').map(Number);
const SEED = Number(process.env.SEED ?? 1);
const NAMES = ['chapel', 'cross', 'trig', 'spring', 'tower', 'reservoir'];

for (const R of REGIONS) {
  setRegionOverride(R);
  const x0 = Math.round(R * 1e6) - ((Math.round(R * 1e6) % CHUNK) + CHUNK) % CHUNK;
  const y0 = -x0;
  const n = Math.round((KM * 1000) / CHUNK);
  const view = { x0, y0, x1: x0 + n * CHUNK, y1: y0 + n * CHUNK };
  /** Symbols by chunk, from the chunks rendered inside the view. */
  const byChunk = new Map<string, Poi[]>();
  let m: ChunkManager;
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
          let r: TaskResult;
          if (task.kind === 'render') {
            const redrawn = new Set(task.plans.flatMap((p) => p.replaced));
            const drawn = [...task.roads.filter((q) => !redrawn.has(q.key)), ...task.plans.flatMap((p) => p.roads)];
            const own = task.poi ? placePois({ cx: task.cx, cy: task.cy, patch: task.poi, roads: drawn, plans: task.plans }) : [];
            // Count each symbol once: by the chunk it lies in.
            const inChunk = (q: Poi) => Math.floor(q.x / CHUNK) === task.cx && Math.floor(q.y / CHUNK) === task.cy;
            byChunk.set(`${task.cx},${task.cy}`, [...own, ...task.plans.flatMap((p) => p.pois)].filter(inChunk));
            r = { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 };
          } else r = runTask(task).result;
          this.busy--;
          resolve(r);
          queueMicrotask(() => m.schedule());
        }, 0),
      );
    },
  };
  m = new ChunkManager(pool, () => {}, SEED);
  const t0 = performance.now();
  const want = n * n;
  for (let i = 0; i < 200000 && byChunk.size < want; i++) {
    m.update(view, view, [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2]);
    await new Promise((r) => setTimeout(r, 0));
  }
  const pois = [...byChunk.entries()].filter(([k]) => {
    const [cx, cy] = k.split(',').map(Number);
    return cx * CHUNK >= view.x0 && cx * CHUNK < view.x1 && cy * CHUNK >= view.y0 && cy * CHUNK < view.y1;
  }).flatMap(([, v]) => v);
  // Plans' symbols may be counted by several chunks' plan lists: once per position.
  const unique = [...new Map(pois.map((q) => [`${q.kind}:${q.x},${q.y}`, q])).values()];
  const km2 = (n * CHUNK) ** 2 / 1e6;
  const count = (k: number) => unique.filter((q) => q.kind === k).length;
  console.log(
    `R=${R}: ${km2.toFixed(1)} km² (${byChunk.size} chunks, ${((performance.now() - t0) / 1000).toFixed(0)} s): ` +
      [CHAPEL, CROSS, TRIG, SPRING, TOWER, RESERVOIR].map((k) => `${NAMES[k]} ${count(k)} (${(count(k) / km2).toFixed(2)}/km²)`).join(', '),
  );
  if (process.env.LOG) for (const q of unique) console.log(`  ${NAMES[q.kind]} ?at=${Math.round(q.x)},${Math.round(q.y)}`);
}

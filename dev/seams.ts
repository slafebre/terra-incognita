// Dev: reproducible version of the seam check in test/pipeline.test.ts. Seeds
// Math.random (and so `freshSeed`) per run and reports mean |second difference| of
// the DEM at chunk borders / middles relative to elsewhere, plus the worst border
// lines of runs above 1.3×.
//   npx vite-node dev/seams.ts [firstSeed] [runs] [R]   (R: force the region field)
import { ChunkManager, type Chunk } from '../src/chunks/manager';
import { APRON, CELLS, DEM_W } from '../src/lib/constants';
import { setRegionOverride } from '../src/gen/terrain';
import { rng } from '../src/lib/hash';
import type { TaskRequest, TaskResult } from '../src/worker/protocol';
import { runTask } from '../src/worker/tasks';

declare const process: { argv: string[] };

const first = Number(process.argv[2] ?? 1);
const runs = Number(process.argv[3] ?? 10);
if (process.argv[4]) setRegionOverride(Number(process.argv[4]));
const view = { x0: 100_000, y0: 50_000, x1: 101_500, y1: 51_200 };

async function generate(): Promise<ChunkManager> {
  let busy = 0;
  const pool = {
    size: 3,
    get idle() {
      return this.size - busy;
    },
    run(task: TaskRequest): Promise<TaskResult> {
      busy++;
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          busy--;
          try {
            resolve(
              task.kind === 'render'
                ? { kind: 'render', bitmap: { close() {} } as unknown as ImageBitmap, ms: 0 }
                : runTask(task).result,
            );
          } catch (e) {
            reject(e);
          }
          queueMicrotask(() => m.schedule());
        }, 0),
      );
    },
  };
  const m = new ChunkManager(pool, () => {});
  for (let i = 0; i < 20000 && !m.covered(view); i++) {
    m.update(view, view, [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2]);
    await new Promise((r) => setTimeout(r, 0));
  }
  return m;
}

type Kind = 'border' | 'middle' | 'other';
const kindOf = (v: number): Kind =>
  v === APRON || v === APRON + CELLS ? 'border' : Math.abs(v - (APRON + CELLS / 2)) <= 1 ? 'middle' : 'other';

function measure(m: ChunkManager) {
  const sum = { border: 0, middle: 0, other: 0 };
  const cnt = { border: 0, middle: 0, other: 0 };
  // Per border line ("cx,cy x1" = the chunk's east edge, etc.): summed curvature.
  const lines = new Map<string, { c: Chunk; s: number; n: number }>();
  let wet = 0;
  let all = 0;
  for (const c of m.chunks.values()) {
    if (!c.dem) continue;
    const dem = c.dem;
    for (let j = APRON; j <= APRON + CELLS; j++)
      for (let i = APRON; i <= APRON + CELLS; i++) {
        const o = j * DEM_W + i;
        all++;
        if (c.water && c.water[o] > 0) wet++;
        for (const [v, d, ax] of [
          [i, 1, 'x'],
          [j, DEM_W, 'y'],
        ] as const) {
          const k = Math.abs(dem[o - d] - 2 * dem[o] + dem[o + d]);
          const kind = kindOf(v);
          sum[kind] += k;
          cnt[kind]++;
          if (kind === 'border') {
            const key = `${c.cx},${c.cy} ${ax}${v === APRON ? '0' : '1'}`;
            const l = lines.get(key) ?? { c, s: 0, n: 0 };
            l.s += k;
            l.n++;
            lines.set(key, l);
          }
        }
      }
  }
  const base = sum.other / cnt.other;
  return {
    border: sum.border / cnt.border / base,
    middle: sum.middle / cnt.middle / base,
    water: wet / all,
    worst: [...lines.entries()]
      .map(([k, l]) => ({ k, r: l.s / l.n / base, R: l.c.region ?? NaN }))
      .sort((a, b) => b.r - a.r)
      .slice(0, 4),
  };
}

for (let s = first; s < first + runs; s++) {
  Math.random = rng(s * 7919 + 13);
  const t0 = Date.now();
  const m = await generate();
  const r = measure(m);
  const f = (x: number) => x.toFixed(2);
  console.log(
    `seed ${s}: border ${f(r.border)}× middle ${f(r.middle)}×, water ${(r.water * 100).toFixed(1)}%` +
      `${m.stats.errors ? ` (${m.stats.errors} task errors)` : ''} ${Date.now() - t0} ms`,
  );
  if (r.border > 1.3 || r.middle > 1.3)
    for (const w of r.worst) console.log(`    ${w.k}: ${f(w.r)}× (chunk region R ${f(w.R)})`);
}

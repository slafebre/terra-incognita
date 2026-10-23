// Dev tool: net cell timings as a worker sees them — a block of neighbouring cells
// built in turn, sharing the worker's caches.
//   npx vite-node dev/netbench.ts [block size] [R]
import { CoarseField } from '../src/gen/hydro';
import { latticeCell } from '../src/gen/lattice';
import { NET_CELL, NET_REACH } from '../src/gen/roads';
import { SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { setRegionOverride, Terrain } from '../src/gen/terrain';
import { rng } from '../src/lib/hash';

declare const process: { argv: string[] };

const B = Number(process.argv[2] ?? 3);
setRegionOverride(Number(process.argv[3] ?? 0.45));
Math.random = rng(12345);
const store = new SeedStore();
const all = { x0: -NET_REACH, y0: -NET_REACH, x1: B * NET_CELL + NET_REACH, y1: B * NET_CELL + NET_REACH };
const times: number[] = [];
for (let gy = 0; gy < B; gy++)
  for (let gx = 0; gx < B; gx++) {
    // Each task gets its own view and field, as in a worker.
    const r = { x0: gx * NET_CELL, y0: gy * NET_CELL, x1: (gx + 1) * NET_CELL, y1: (gy + 1) * NET_CELL };
    const view = new SeedView(store.payloadFor(r, all));
    const t = new Terrain(view);
    const field = new CoarseField(t, view);
    const t0 = performance.now();
    latticeCell(gx, gy, field, new Settlements(field, t, view), t);
    times.push(performance.now() - t0);
  }
const warm = times.slice(1);
console.log(`cells ${times.map((t) => t.toFixed(0)).join(' ')} ms; first ${times[0].toFixed(0)}, then mean ${(warm.reduce((a, b) => a + b, 0) / warm.length).toFixed(0)} ms`);

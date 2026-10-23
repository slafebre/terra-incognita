// Dev tool: road network statistics per net cell (no fine routing).
//   npx vite-node dev/netstats.ts [cells per region] [R,R,...]
import { CoarseField } from '../src/gen/hydro';
import { latticeCell } from '../src/gen/lattice';
import { NET_CELL, NET_REACH, ROAD_C, ROAD_D, ROAD_N } from '../src/gen/roads';
import { SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { setRegionOverride, Terrain } from '../src/gen/terrain';

declare const process: { argv: string[] };

const CELLS = Number(process.argv[2] ?? 3);
const REGIONS = (process.argv[3] ?? '0.2,0.35,0.5').split(',').map(Number);

for (const R of REGIONS) {
  setRegionOverride(R);
  let ms = 0, sites = 0;
  const km = [0, 0, 0, 0, 0];
  for (let n = 0; n < CELLS; n++) {
    const gx = Math.round((Math.random() - 0.5) * 200);
    const gy = Math.round((Math.random() - 0.5) * 200);
    const x0 = gx * NET_CELL, y0 = gy * NET_CELL;
    const store = new SeedStore();
    const c = { x0: x0 - NET_REACH, y0: y0 - NET_REACH, x1: x0 + NET_CELL + NET_REACH, y1: y0 + NET_CELL + NET_REACH };
    const view = new SeedView(store.payloadFor({ x0, y0, x1: x0 + 16, y1: y0 + 16 }, c));
    const t = new Terrain(view);
    const field = new CoarseField(t, view);
    const set = new Settlements(field, t, view);
    const t0 = performance.now();
    const cell = latticeCell(gx, gy, field, set, t);
    ms += performance.now() - t0;
    sites += cell.sites.length;
    for (const e of cell.edges) {
      let L = 0;
      for (let i = 2; i < e.route.length; i += 2) L += Math.hypot(e.route[i] - e.route[i - 2], e.route[i + 1] - e.route[i - 1]);
      km[e.cls] += L / 1000;
    }
  }
  const area = CELLS * (NET_CELL / 1000) ** 2;
  console.log(
    `R=${R}  ${(ms / CELLS).toFixed(0)} ms/cell  sites ${(sites / area).toFixed(2)}/km²  ` +
      `road km/km²: N ${(km[ROAD_N] / area).toFixed(2)} D ${(km[ROAD_D] / area).toFixed(2)} C ${(km[ROAD_C] / area).toFixed(2)} track ${(km[3] / area).toFixed(2)} path ${(km[4] / area).toFixed(2)}`,
  );
}

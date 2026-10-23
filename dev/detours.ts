// Dev tool: main-road detours. For each main path, finds places where the road comes
// back within reach of an earlier point after a long way round, and reports the
// direct lattice edge (if the two points are neighbours): its coarse gradient and cost
// against the detour's.
import { CoarseField } from '../src/gen/hydro';
import { DEBUG_PATHS, debugPaths, edgeCost, edgeGrade, latticeCell, neighbours, vertexPos } from '../src/gen/lattice';
import { NET_CELL, NET_REACH } from '../src/gen/roads';
import { SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { setRegionOverride, Terrain } from '../src/gen/terrain';
import { rng } from '../src/lib/hash';

declare const process: { argv: string[] };
const R = Number(process.argv[2] ?? 0.4);
const N = Number(process.argv[3] ?? 4);
let found = 0;
for (let n = 0; n < N; n++) {
  Math.random = rng(1000 + n);
  setRegionOverride(R);
  const gx = Math.round((Math.random() - 0.5) * 100);
  const gy = Math.round((Math.random() - 0.5) * 100);
  const store = new SeedStore();
  const x0 = gx * NET_CELL, y0 = gy * NET_CELL;
  const c = { x0: x0 - NET_REACH, y0: y0 - NET_REACH, x1: x0 + NET_CELL + NET_REACH, y1: y0 + NET_CELL + NET_REACH };
  const view = new SeedView(store.payloadFor({ x0: x0 / 512, y0: y0 / 512, x1: x0 / 512 + 16, y1: y0 / 512 + 16 }, c));
  const t = new Terrain(view);
  const field = new CoarseField(t, view);
  debugPaths(true);
  latticeCell(gx, gy, field, new Settlements(field, t, view));
  for (const p of DEBUG_PATHS!) {
    // Vertex sequence of the path (edges are listed goal → start).
    const vs = [p.edges[p.edges.length - 1][0], ...p.edges.slice().reverse().map((e) => e[1])];
    const P = vs.map((v) => vertexPos(v));
    const along: number[] = [0];
    for (let i = 1; i < vs.length; i++) along.push(along[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    for (let i = 0; i < vs.length; i++)
      for (let j = i + 4; j < vs.length; j++) {
        const direct = Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]);
        if (direct > 250 || along[j] - along[i] < 4 * direct + 400) continue;
        const nb = neighbours(vs[i]).includes(vs[j]);
        let detourCost = 0;
        for (let k = i; k < j; k++) detourCost += edgeCost(field, vs[k], vs[k + 1], p.k);
        console.log(
          `cls ${p.k}: back within ${direct.toFixed(0)} m after ${(along[j] - along[i]).toFixed(0)} m; ` +
            (nb
              ? `direct edge exists, coarse grade ${(100 * edgeGrade(field, vs[i], vs[j])).toFixed(1)}%, cost ${edgeCost(field, vs[i], vs[j], p.k).toFixed(0)} vs detour ${detourCost.toFixed(0)}`
              : `not lattice neighbours`),
        );
        found++;
        i = j; // one report per detour
        break;
      }
  }
}
console.log(`${found} detours`);

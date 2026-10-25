// Dev tool: motorway statistics over seeded areas (no fine terrain).
//   SEED=n npx vite-node dev/mwstats.ts [areas] [km] [R]
// Per area: length per 100 km², ends per 100 km, curves tighter than MW_RMIN, and time.
// Grades: the motorway's profile is taken as the coarse surface averaged over 1 km along it
// (cuttings and embankments even out shorter bumps); reported are the share of it steeper
// than 1.5× MW_GRADE (over 200 m), and the share where the ground lies more than 15 m
// above or below it (deep cuttings, high embankments: tunnels and viaducts).
import { CoarseField } from '../src/gen/hydro';
import { MW_GRADE, MW_RMIN, Motorways, tightestRadius } from '../src/gen/motorway';
import { NET_REACH } from '../src/gen/roads';
import { expand, SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { setRegionOverride, Terrain } from '../src/gen/terrain';
import { rng } from '../src/lib/hash';

declare const process: { argv: string[]; env: Record<string, string | undefined> };

const AREAS = Number(process.argv[2] ?? 4);
const SIZE = Number(process.argv[3] ?? 96) * 1000;
if (process.argv[4] !== undefined) setRegionOverride(Number(process.argv[4]));
const SEED = Number(process.env.SEED ?? 1);
const pick = rng(SEED * 7919);

const polyLen = (xy: ArrayLike<number>) => {
  let L = 0;
  for (let k = 2; k < xy.length; k += 2) L += Math.hypot(xy[k] - xy[k - 2], xy[k + 1] - xy[k - 1]);
  return L;
};

let sumKm = 0, sumEnds = 0, sumTight = 0, sumPieces = 0, sumOver = 0, sumSteps = 0, sumDeep = 0, sumSamples = 0;
for (let a = 0; a < AREAS; a++) {
  const ox = Math.round((pick() - 0.5) * 2e6);
  const oy = Math.round((pick() - 0.5) * 2e6);
  const rect = { x0: ox, y0: oy, x1: ox + SIZE, y1: oy + SIZE };
  const store = new SeedStore(SEED);
  const view = new SeedView(store.payloadFor(rect, expand(rect, NET_REACH)));
  const t = new Terrain(view);
  const field = new CoarseField(t, view);
  const set = new Settlements(field, t, view);
  const mw = new Motorways(field, t, set, view);
  const t0 = performance.now();
  const pieces = mw.piecesIn(rect.x0, rect.y0, rect.x1, rect.y1);
  const ms = performance.now() - t0;
  let km = 0, ends = 0, tight = 0, n = 0, over = 0, steps = 0, deep = 0, samples = 0, rmin = Infinity;
  for (const p of pieces) {
    const mi = 2 * Math.floor(p.xy.length / 4);
    const mx = p.xy[mi], my = p.xy[mi + 1];
    if (mx < rect.x0 || mx >= rect.x1 || my < rect.y0 || my >= rect.y1) continue;
    n++;
    km += polyLen(p.xy) / 1000;
    ends += (p.endA ? 1 : 0) + (p.endB ? 1 : 0);
    const r = tightestRadius(p.xy, 200);
    rmin = Math.min(rmin, r);
    if (r < MW_RMIN) tight++;
    // Points every 25 m: ground, and the profile (ground averaged over ±500 m, as far as the piece goes).
    const m = p.xy.length / 2;
    const z = Array.from({ length: m }, (_, i) => field.z(p.xy[2 * i], p.xy[2 * i + 1]));
    const prof = z.map((_, i) => {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - 20); j <= Math.min(m - 1, i + 20); j++) (s += z[j]), c++;
      return s / c;
    });
    for (let i = 0; i < m; i++) {
      samples++;
      if (Math.abs(z[i] - prof[i]) > 15) deep++;
      if (i >= 8) {
        steps++;
        if (Math.abs(prof[i] - prof[i - 8]) / 200 > 1.5 * MW_GRADE) over++;
      }
    }
  }
  const area = (SIZE / 1000) ** 2;
  console.log(
    `area ${a} at ${ox},${oy}: ${((100 * km) / area).toFixed(2)} km/100 km², ${km.toFixed(0)} km, ` +
      `${((100 * ends) / Math.max(1, km)).toFixed(1)} ends/100 km, ${tight}/${n} pieces tighter than ${MW_RMIN} m (min ${rmin.toFixed(0)}), ` +
      `profile steep ${((100 * over) / Math.max(1, steps)).toFixed(0)} %, deep ${((100 * deep) / Math.max(1, samples)).toFixed(0)} %, ` +
      `${mw.unrouted} unrouted, ${(ms / 1000).toFixed(1)} s`,
  );
  sumKm += km; sumEnds += ends; sumTight += tight; sumPieces += n; sumOver += over; sumSteps += steps; sumDeep += deep; sumSamples += samples;
}
const area = AREAS * (SIZE / 1000) ** 2;
console.log(
  `ALL: ${((100 * sumKm) / area).toFixed(2)} km/100 km², ${((100 * sumEnds) / Math.max(1, sumKm)).toFixed(1)} ends/100 km, ` +
    `${sumTight}/${sumPieces} pieces tight, profile steep ${((100 * sumOver) / Math.max(1, sumSteps)).toFixed(0)} %, deep ${((100 * sumDeep) / Math.max(1, sumSamples)).toFixed(0)} %`,
);

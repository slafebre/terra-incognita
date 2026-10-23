// Dev tool: how much the overlapping coarse tiles disagree (m), by region.
//   npx vite-node dev/tilespread.ts [R,R,...]
import { CoarseField, COARSE, TILE_STRIDE, tileZForDebug } from '../src/gen/hydro';
import { expand, SeedStore, SeedView } from '../src/gen/seeds';
import { setRegionOverride, Terrain } from '../src/gen/terrain';
import { rng } from '../src/lib/hash';

declare const process: { argv: string[] };
for (const R of (process.argv[2] ?? '0.2,0.45,0.65').split(',').map(Number)) {
  setRegionOverride(R);
  const st = new SeedStore(3);
  const X = Math.round(R * 1e6);
  const r = { x0: X, y0: 0, x1: X + 30000, y1: 30000 };
  const sv = new SeedView(st.payloadFor(r, expand(r, 70000)));
  const field = new CoarseField(new Terrain(sv), sv);
  const rand = rng(5);
  const s = TILE_STRIDE * COARSE;
  const bins = [[0, 0.3], [0.3, 3], [3, 30], [30, Infinity]].map(([lo, hi]) => ({ lo, hi, sum: 0, n: 0 }));
  let sum = 0, n = 0, big = 0;
  for (let i = 0; i < 4000; i++) {
    const x = X + rand() * 30000, y = rand() * 30000;
    const a = Math.floor(x / s), b = Math.floor(y / s);
    const zs = [field.tile(a - 1, b - 1), field.tile(a, b - 1), field.tile(a - 1, b), field.tile(a, b)].map((t) => tileZForDebug(t, x, y));
    const spread = Math.max(...zs) - Math.min(...zs);
    sum += spread; n++;
    if (spread > 50) big++;
    const A = field.area(x, y);
    for (const bin of bins) if (A >= bin.lo && A < bin.hi) { bin.sum += spread; bin.n++; }
  }
  console.log(`R=${R} grid ${COARSE} m: mean spread between tiles ${(sum / n).toFixed(0)} m, >50 m at ${((100 * big) / n).toFixed(0)}% of points; by area ` + bins.map((b) => `${b.lo}–${b.hi} km² ${(b.sum / (b.n || 1)).toFixed(0)} m (${b.n})`).join(', '));
}

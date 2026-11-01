import { describe, expect, it } from 'vitest';
import { segPointDist } from '../src/gen/buildings';
import { DX, DY, NODE, NODES } from '../src/gen/hydro';
import { CHAPEL, CROSS, placePois, POI_MARGIN, POI_PAD, SPRING, TRIG, type Poi, type PoiPatch } from '../src/gen/poi';
import { MW_PLAN_CLEAR } from '../src/gen/motorway';
import { ROAD_C, ROAD_D, ROAD_T, type SegmentPath } from '../src/gen/roads';
import { streamThreshold } from '../src/gen/dem';
import { CHUNK } from '../src/lib/constants';

/**
 * Points of interest on synthetic land: rolling hills over 6 × 6 chunks (hill
 * country, R = 0.4), drained by steepest descent, with a grid of roads crossing it.
 * Each chunk gets its own patch cut from the same world, as the app's chunks do.
 */
const C0 = -1;
const C1 = 5; // chunks C0 … C1 - 1 each way
const G0 = C0 * NODES - POI_PAD;
const GW = (C1 - C0) * NODES + 2 * POI_PAD;
const ground = (x: number, y: number) =>
  200 + 30 * Math.sin(x / 310) * Math.cos(y / 270) + 18 * Math.sin(x / 130 + 1.3) * Math.sin(y / 170 + 0.4) + 0.01 * x;
const world = (() => {
  const N = GW * GW;
  const zE = new Float32Array(N);
  for (let j = 0; j < GW; j++) for (let i = 0; i < GW; i++) zE[j * GW + i] = ground((G0 + i) * NODE, (G0 + j) * NODE);
  // Steepest descent, then drainage area (km²) accumulated from the top down.
  const rec = new Int8Array(N).fill(-1);
  for (let j = 1; j < GW - 1; j++)
    for (let i = 1; i < GW - 1; i++) {
      const k = j * GW + i;
      let best = 0;
      for (let d = 0; d < 8; d++) {
        const q = (j + DY[d]) * GW + i + DX[d];
        const s = (zE[k] - zE[q]) / Math.hypot(DX[d], DY[d]);
        if (s > best) {
          best = s;
          rec[k] = d;
        }
      }
    }
  const A = new Float32Array(N).fill((NODE * NODE) / 1e6);
  const order = [...Array(N).keys()].sort((a, b) => zE[b] - zE[a]);
  for (const k of order) {
    const r = rec[k];
    if (r < 0) continue;
    A[(Math.floor(k / GW) + DY[r]) * GW + (k % GW) + DX[r]] += A[k];
  }
  return { zE, A, rec };
})();
const patchFor = (cx: number, cy: number): PoiPatch => {
  const w = NODES + 2 * POI_PAD;
  const gx = cx * NODES - POI_PAD;
  const gy = cy * NODES - POI_PAD;
  const p: PoiPatch = { gx, gy, w, h: w, zE: new Float32Array(w * w), A: new Float32Array(w * w), lake: new Float32Array(w * w).fill(NaN), rec: new Int8Array(w * w), R: new Float32Array(w * w).fill(0.4) };
  for (let j = 0; j < w; j++)
    for (let i = 0; i < w; i++) {
      const o = (gy + j - G0) * GW + (gx + i - G0);
      p.zE[j * w + i] = world.zE[o];
      p.A[j * w + i] = world.A[o];
      p.rec[j * w + i] = world.rec[o];
    }
  return p;
};
// Roads: a grid every 300 m, cut into pieces between the crossings (so they meet end to end), a track among them.
const roads: SegmentPath[] = [];
for (let a = -400; a <= 2500; a += 300)
  for (let b = -400; b < 2500; b += 300)
    for (const vert of [false, true]) {
      const xy: number[] = [];
      for (let t = 0; t <= 300; t += 10) xy.push(...(vert ? [a, b + t] : [b + t, a]));
      roads.push({ key: `${vert ? 'v' : 'h'}${a},${b}`, cls: (a / 300) % 3 === 0 ? ROAD_T : (b / 300) % 2 ? ROAD_D : ROAD_C, xy: Float32Array.from(xy) });
    }
const near = (r: SegmentPath[], cx: number, cy: number) =>
  r.filter((q) => {
    const m = 2 * Math.floor(q.xy.length / 4);
    const mx = q.xy[m];
    const my = q.xy[m + 1];
    return Math.floor(mx / CHUNK) >= cx - 1 && Math.floor(mx / CHUNK) <= cx + 1 && Math.floor(my / CHUNK) >= cy - 1 && Math.floor(my / CHUNK) <= cy + 1;
  });

const chunks: { cx: number; cy: number; pois: Poi[] }[] = [];
for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) chunks.push({ cx, cy, pois: placePois({ cx, cy, patch: patchFor(cx, cy), roads: near(roads, cx, cy), plans: [] }) });
const all = chunks.flatMap((c) => c.pois);
const key = (q: Poi) => `${q.kind}:${q.x.toFixed(3)},${q.y.toFixed(3)}`;

describe('points of interest', () => {
  it('occur, of every kind the land offers', () => {
    const kinds = new Map<number, number>();
    for (const q of all) kinds.set(q.kind, (kinds.get(q.kind) ?? 0) + 1);
    console.log(`kinds: ${[...kinds].map(([k, n]) => `${['chapel', 'cross', 'trig', 'spring'][k]} ${n}`).join(', ')}`);
    expect(kinds.get(CROSS) ?? 0).toBeGreaterThan(0);
    expect(kinds.get(SPRING) ?? 0).toBeGreaterThan(0);
    expect((kinds.get(CHAPEL) ?? 0) + (kinds.get(TRIG) ?? 0)).toBeGreaterThan(0);
  });

  it('agree across chunk borders', () => {
    // Every point a chunk decides within the margin of its neighbour, the neighbour decides too.
    for (const a of chunks)
      for (const b of chunks) {
        if (a === b) continue;
        const inB = (q: Poi) =>
          q.x >= b.cx * CHUNK - POI_MARGIN && q.x < (b.cx + 1) * CHUNK + POI_MARGIN && q.y >= b.cy * CHUNK - POI_MARGIN && q.y < (b.cy + 1) * CHUNK + POI_MARGIN;
        const theirs = new Set(b.pois.map(key));
        for (const q of a.pois.filter(inB)) expect(theirs.has(key(q)), `${key(q)} in chunks ${a.cx},${a.cy} and ${b.cx},${b.cy}`).toBe(true);
      }
  });

  it('put hilltop symbols on hilltops and springs on stream heads', () => {
    const z = (x: number, y: number) => world.zE[(Math.round(y / NODE) - G0) * GW + Math.round(x / NODE) - G0];
    const k = (x: number, y: number) => (Math.round(y / NODE) - G0) * GW + Math.round(x / NODE) - G0;
    for (const q of all) {
      if (q.kind === CHAPEL || q.kind === TRIG) {
        // The highest ground within 240 m.
        for (let a = 0; a < 16; a++) for (const r of [40, 120, 230]) expect(z(q.x + r * Math.cos(a), q.y + r * Math.sin(a))).toBeLessThanOrEqual(z(q.x, q.y));
      }
      if (q.kind === SPRING) {
        const i = k(q.x, q.y);
        expect(world.A[i]).toBeGreaterThanOrEqual(streamThreshold(0.4));
        // Nothing upstream is a stream.
        for (let d = 0; d < 8; d++) {
          const n = i + DY[d] * GW + DX[d];
          const r = world.rec[n];
          if (r >= 0 && n + DY[r] * GW + DX[r] === i) expect(world.A[n]).toBeLessThan(streamThreshold(0.4));
        }
      }
    }
  });

  it('keep off a motorway, and leave the rest where they were', () => {
    // A motorway straight across the same land. Nothing may stand on it: the network has
    // no junction on one, so the rules that place symbols cannot see it by themselves.
    // Laid through a wayside cross, as the one on the map ran through a junction's.
    const hit = all.find((q) => q.kind === CROSS && !z0(q)) ?? all[0];
    const line: number[] = [];
    for (let t = -700; t <= 700; t += 25) line.push(hit.x + t * 0.92, hit.y + t * 0.39);
    const mw = Float64Array.from(line);
    const off = (q: Poi) => {
      let best = Infinity;
      for (let i = 2; i < mw.length; i += 2) best = Math.min(best, segPointDist(mw[i - 2], mw[i - 1], mw[i], mw[i + 1], q.x, q.y));
      return best;
    };
    const kept = chunks.flatMap((c) => placePois({ cx: c.cx, cy: c.cy, patch: patchFor(c.cx, c.cy), roads: near(roads, c.cx, c.cy), plans: [], motorways: [mw] }));
    // The motorway crosses enough of the land to have caught some.
    expect(all.filter((q) => off(q) < MW_PLAN_CLEAR).length).toBeGreaterThan(0);
    for (const q of kept) expect(off(q)).toBeGreaterThanOrEqual(MW_PLAN_CLEAR);
    // Everything clear of it is untouched.
    expect(new Set(kept.map(key))).toEqual(new Set(all.filter((q) => off(q) >= MW_PLAN_CLEAR).map(key)));
  });

  it('set wayside crosses clear of the ways, at junctions with a road', () => {
    let crosses = 0;
    for (const q of all) {
      if (q.kind !== CROSS || z0(q)) continue;
      crosses++;
      for (const r of roads)
        for (let i = 2; i < r.xy.length; i += 2) expect(segPointDist(r.xy[i - 2], r.xy[i - 1], r.xy[i], r.xy[i + 1], q.x, q.y)).toBeGreaterThan([6, 5, 4, 2.5, 1.5][r.cls]);
    }
    expect(crosses).toBeGreaterThan(0);
  });
});

/**
 * A junction's wayside cross is set out along the straight bisector of the widest gap
 * between the ways' directions at the junction. The grid above runs dead straight, so
 * nothing there can land inside a way and the clearance test above passes whatever
 * placePois does about it. These junctions can: three short arms 120° apart, and at
 * half of them a fourth way running through the very spot the cross is set out at,
 * passing the junction without meeting it. That is the shape the map produced — a cross
 * 0.7 m into a track, another 3.3 m into a C road (`dev/check.ts`, seeds 3 and 4).
 */
describe('wayside crosses against the ways as drawn', () => {
  const CLEAR = [6, 5, 4, 2.5, 1.5];
  const arms: SegmentPath[] = [];
  const spots: { x: number; y: number; blocked: boolean }[] = [];
  let n = 0;
  for (let jy = 350; jy <= 1850; jy += 150)
    for (let jx = 350; jx <= 1850; jx += 150) {
      const blocked = n++ % 2 === 1;
      for (const [i, deg] of [0, 120, 240].entries()) {
        const a2 = (deg * Math.PI) / 180;
        const xy: number[] = [];
        for (let t = 0; t <= 40; t += 10) xy.push(jx + t * Math.cos(a2), jy + t * Math.sin(a2));
        arms.push({ key: `j${jx},${jy},${i}`, cls: ROAD_C, xy: Float32Array.from(xy) });
      }
      // Where placePois will set the cross. The three gaps are equal, and the widest is
      // taken as the first of them in sorted order: atan2 gives the 240° arm as -120°, so
      // the directions sort to -120°, 0°, 120° and the gap chosen is the one between the
      // first two, bisector -60°. The offset is the clearance over sin 60° plus 5 m.
      const MID = -Math.PI / 3;
      const off = CLEAR[ROAD_C] / Math.sin(Math.PI / 3) + 5;
      const sx = jx + off * Math.cos(MID);
      const sy = jy + off * Math.sin(MID);
      spots.push({ x: sx, y: sy, blocked });
      if (!blocked) continue;
      // A way through that spot, square to the bisector: it passes the junction 9.6 m off
      // and never meets it, so the gap the cross is set out in cannot see it.
      const bx = Math.cos(MID + Math.PI / 2);
      const by = Math.sin(MID + Math.PI / 2);
      const xy: number[] = [];
      for (let t = -40; t <= 40; t += 10) xy.push(sx + t * bx, sy + t * by);
      arms.push({ key: `b${jx},${jy}`, cls: ROAD_C, xy: Float32Array.from(xy) });
    }
  const pois = [];
  for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) pois.push(...placePois({ cx, cy, patch: patchFor(cx, cy), roads: arms, plans: [] }));
  const crosses = pois.filter((q) => q.kind === CROSS && !z0(q));

  it('still sets some', () => {
    expect(crosses.length).toBeGreaterThan(0);
  });

  it('never inside a way, counting the ways that do not meet the junction', () => {
    for (const q of crosses)
      for (const r of arms)
        for (let i = 2; i < r.xy.length; i += 2)
          expect(segPointDist(r.xy[i - 2], r.xy[i - 1], r.xy[i], r.xy[i + 1], q.x, q.y)).toBeGreaterThanOrEqual(CLEAR[r.cls]);
  });

  it('drops the cross where a way runs through its spot, and keeps the others', () => {
    // The 20% chance at each junction is what makes this worth counting out loud: with
    // too few junctions no blocked one is picked, and the test passes while proving
    // nothing. It caught exactly that at 32 blocked junctions, where 1 was picked.
    const at = (s: { x: number; y: number }) => crosses.some((q) => Math.hypot(q.x - s.x, q.y - s.y) < 0.5);
    console.log(`junctions ${spots.length} (${spots.filter((s) => s.blocked).length} blocked); crosses at spots: blocked ${spots.filter((s) => s.blocked && at(s)).length}, clear ${spots.filter((s) => !s.blocked && at(s)).length}; crosses in all ${crosses.length}`);
    expect(spots.filter((s) => s.blocked).some(at)).toBe(false);
    expect(spots.filter((s) => !s.blocked).some(at)).toBe(true);
  });
});

/** Is a cross a hilltop's (on a node) rather than a junction's? */
function z0(q: Poi): boolean {
  return Math.abs(q.x / NODE - Math.round(q.x / NODE)) < 1e-6 && Math.abs(q.y / NODE - Math.round(q.y / NODE)) < 1e-6;
}


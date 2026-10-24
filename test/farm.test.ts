import { describe, expect, it } from 'vitest';
import { quadsOverlap, segQuadDist } from '../src/gen/buildings';
import { planFarm } from '../src/gen/farm';
import { NODE } from '../src/gen/hydro';
import { nearestVertex, vertexPos } from '../src/gen/lattice';
import { ROAD_C, ROAD_D, ROAD_T, type RoadPatch, type SegmentPath } from '../src/gen/roads';
import { FARM, type Site } from '../src/gen/settle';
import { PLAN_EXTENT, PLAN_MARGIN, ROAD_CLEAR, type PlanInput } from '../src/gen/town';
import { rng } from '../src/lib/hash';

/**
 * Farmsteads on synthetic land: ground tilted by `tilt` (m/m) with gentle bumps, a
 * C road from the west ending at the farm's lattice vertex, a D road passing 130 m
 * north, and (optionally) a lake — under the farm, or beside it.
 */
function input(i: number, tilt: number, R: number, lake: 'none' | 'beside' | 'under' = 'none'): PlanInput {
  const [vx, vy] = vertexPos(nearestVertex(3000 + 1500 * i, -2000 + 700 * i));
  const site: Site = { id: `${FARM}:${i},${Math.round(tilt * 100)},${lake}`, rank: FARM, x: vx + 12, y: vy - 8, z: 100, R };
  const r = PLAN_EXTENT[FARM] + PLAN_MARGIN;
  const gx = Math.floor((site.x - r) / NODE) - 1;
  const gy = Math.floor((site.y - r) / NODE) - 1;
  const w = Math.ceil((2 * r) / NODE) + 3;
  const patch: RoadPatch = { gx, gy, w, h: w, zE: new Float32Array(w * w), A: new Float32Array(w * w), lake: new Float32Array(w * w) };
  const a = 0.7 * i;
  for (let j = 0; j < w; j++)
    for (let k = 0; k < w; k++) {
      const x = (gx + k) * NODE - vx;
      const y = (gy + j) * NODE - vy;
      const o = j * w + k;
      patch.zE[o] = 100 + tilt * (x * Math.cos(a) + y * Math.sin(a)) + 1.5 * Math.sin(x / 70) * Math.cos(y / 90);
      patch.A[o] = 0.01;
      const lx = lake === 'under' ? 0 : 70;
      const ly = lake === 'under' ? 0 : 40;
      patch.lake[o] = lake !== 'none' && Math.hypot(x - lx, y - ly) < 45 ? 95 : NaN;
    }
  const roads: SegmentPath[] = [];
  // The farm road: in from the west, in edges of 150 m sharing their end points.
  const pts: number[] = [];
  for (let s = 600; s >= 0; s -= 10) pts.push(vx - s, vy + 0.00004 * s * s);
  for (let e = 0; e * 15 * 2 < pts.length - 2; e++) roads.push({ key: `farm_${e}`, cls: ROAD_C, xy: Float32Array.from(pts.slice(e * 30, Math.min(pts.length, e * 30 + 32))) });
  // A D road passing to the north.
  const d: number[] = [];
  for (let s = -500; s <= 500; s += 10) d.push(vx + s, vy - 130);
  roads.push({ key: 'D', cls: ROAD_D, xy: Float32Array.from(d) });
  return { site, roads, patch };
}

const flat = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ name: `flat ${i}`, inp: input(i, 0.01 + 0.005 * i, 0.1) }));
const hills = [0, 1, 2, 3, 4, 5].map((i) => ({ name: `hill ${i}`, inp: input(i, 0.09 + 0.01 * i, 0.45) }));
const steep = [0, 1, 2, 3, 4, 5].map((i) => ({ name: `steep ${i}`, inp: input(i, 0.25 + 0.02 * i, 0.75) }));
const beside = [0, 1, 2, 3].map((i) => ({ name: `beside a lake ${i}`, inp: input(i, 0.02, 0.1, 'beside') }));
const cases = [...flat, ...hills, ...steep, ...beside].map((c) => ({ ...c, plan: planFarm(c.inp) }));

const quadsOf = (b: Float32Array) => {
  const out: number[][] = [];
  for (let i = 0; i < b.length; i += 8) out.push(Array.from(b.subarray(i, i + 8)));
  return out;
};
const lakeAt = (p: RoadPatch, x: number, y: number) => {
  const k = (Math.round(y / NODE) - p.gy) * p.w + Math.round(x / NODE) - p.gx;
  return !Number.isNaN(p.lake[k]);
};

describe('farmsteads', () => {
  it('follow the ground: small on steep slopes, farmyards on the flat', () => {
    const counts = (cs: typeof cases) => cs.map((c) => c.plan.buildings.length / 8);
    console.log(`buildings: flat ${counts(cases.slice(0, 10))}, hills ${counts(cases.slice(10, 16))}, steep ${counts(cases.slice(16, 22))}`);
    for (const { name, plan } of cases.filter((c) => c.name.startsWith('steep'))) {
      expect(plan.buildings.length / 8, name).toBeGreaterThanOrEqual(1);
      expect(plan.buildings.length / 8, name).toBeLessThanOrEqual(2);
      for (const q of quadsOf(plan.buildings)) expect(Math.hypot(q[2] - q[0], q[3] - q[1]) * Math.hypot(q[6] - q[0], q[7] - q[1]), name).toBeLessThan(11 * 8 + 1);
      expect(plan.roads.length, name).toBe(0);
    }
    const flatPlans = cases.filter((c) => c.name.startsWith('flat'));
    for (const { name, plan } of flatPlans) expect(plan.buildings.length / 8, name).toBeGreaterThanOrEqual(1);
    // Many lowland farms on the flat spread round a yard.
    expect(flatPlans.filter((c) => c.plan.buildings.length / 8 >= 4).length).toBeGreaterThanOrEqual(4);
    // …and some have a track into the fields.
    expect(flatPlans.filter((c) => c.plan.roads.length).length).toBeGreaterThan(0);
  });

  it('are a function of their inputs, not of their order', () => {
    for (const { inp, plan } of cases) {
      const shuffled = [...inp.roads];
      const r = rng(11);
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(planFarm({ ...inp, roads: shuffled })).toEqual(plan);
    }
  });

  it('are left out where they would stand in a lake', () => {
    for (let i = 0; i < 4; i++) {
      const plan = planFarm(input(i, 0.02, 0.1, 'under'));
      expect(plan.buildings.length).toBe(0);
      expect(plan.roads.length).toBe(0);
    }
  });

  it('place buildings clear of ways, water and each other, within their extent', () => {
    for (const { name, inp, plan } of cases) {
      const qs = quadsOf(plan.buildings);
      for (const [n, q] of qs.entries()) {
        for (let c = 0; c < 8; c += 2) {
          expect(lakeAt(inp.patch, q[c], q[c + 1]), `${name} building ${n} in a lake`).toBe(false);
          expect(Math.hypot(q[c] - inp.site.x, q[c + 1] - inp.site.y), name).toBeLessThanOrEqual(PLAN_EXTENT[FARM]);
        }
        for (const r of inp.roads)
          for (let k = 2; k < r.xy.length; k += 2)
            expect(segQuadDist(r.xy[k - 2], r.xy[k - 1], r.xy[k], r.xy[k + 1], q), `${name} building ${n} on ${r.key}`).toBeGreaterThanOrEqual(ROAD_CLEAR[r.cls] - 0.01);
        for (let m = 0; m < n; m++) expect(quadsOverlap(q, qs[m], 0.31), `${name} buildings ${m}, ${n} overlap`).toBe(false);
      }
    }
  });

  it('run tracks from the road end into the fields, off water and clear of the buildings', () => {
    for (const { name, inp, plan } of cases) {
      for (const t of plan.roads) {
        expect(t.cls, name).toBe(ROAD_T);
        // It starts where the farm road ends, at the farm's vertex.
        const [vx, vy] = vertexPos(nearestVertex(inp.site.x, inp.site.y));
        expect([t.xy[0], t.xy[1]], name).toEqual([Math.fround(vx), Math.fround(vy)]);
        let len = 0;
        for (let i = 2; i < t.xy.length; i += 2) {
          const l = Math.hypot(t.xy[i] - t.xy[i - 2], t.xy[i + 1] - t.xy[i - 1]);
          len += l;
          expect(lakeAt(inp.patch, t.xy[i], t.xy[i + 1]), `${name} track in a lake`).toBe(false);
          for (const q of quadsOf(plan.buildings)) expect(segQuadDist(t.xy[i - 2], t.xy[i - 1], t.xy[i], t.xy[i + 1], q), `${name} track through a building`).toBeGreaterThan(3);
        }
        expect(len, name).toBeGreaterThanOrEqual(50);
        expect(len, name).toBeLessThanOrEqual(310);
      }
    }
  });
});

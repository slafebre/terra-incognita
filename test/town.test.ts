import { describe, expect, it } from 'vitest';
import { NODE } from '../src/gen/hydro';
import { nearestVertex, vertexPos } from '../src/gen/lattice';
import { ROAD_C, ROAD_D, ROAD_T, type RoadClass, type RoadPatch, type SegmentPath } from '../src/gen/roads';
import { HAMLET, TOWN, VILLAGE, type Rank, type Site } from '../src/gen/settle';
import { PLAN_EXTENT, PLAN_MARGIN, planTown, type PlanInput, type TownPlan } from '../src/gen/town';
import { rng } from '../src/lib/hash';
import { APRON, CELL, CHUNK, DEM_W } from '../src/lib/constants';
import { COVER, COVER_FIELDS, COVER_SCALE } from '../src/gen/landcover';
import { clearUnderBuiltUp } from '../src/render/roads';

/**
 * Street plans on synthetic land: gently tilted, bumpy ground with a stream and a
 * small lake, and four roads meeting at the settlement's lattice vertex — a through
 * D road, a C road and a track.
 */
function input(rank: Rank, i: number): PlanInput {
  const [vx, vy] = vertexPos(nearestVertex(4000 + 2000 * i, 3000));
  const site: Site = { id: `${rank}:${i},0`, rank, x: vx + 20, y: vy - 12, z: 100, R: 0.2 + 0.05 * i };
  const r = PLAN_EXTENT[rank] + PLAN_MARGIN;
  const gx = Math.floor((site.x - r) / NODE) - 1;
  const gy = Math.floor((site.y - r) / NODE) - 1;
  const w = Math.ceil((2 * r) / NODE) + 3;
  const patch: RoadPatch = { gx, gy, w, h: w, zE: new Float32Array(w * w), A: new Float32Array(w * w), lake: new Float32Array(w * w) };
  for (let j = 0; j < w; j++)
    for (let k = 0; k < w; k++) {
      const x = (gx + k) * NODE - vx;
      const y = (gy + j) * NODE - vy;
      const o = j * w + k;
      patch.zE[o] = 100 + 0.03 * x + 0.015 * y + 3 * Math.sin(x / 90) * Math.cos(y / 120);
      // A stream crossing east of the centre, a lake to the south-west.
      patch.A[o] = Math.abs(x - 140 - 0.3 * y) < 10 ? 0.8 : 0.01;
      patch.lake[o] = Math.hypot(x + 160, y - 150) < 50 ? 95 : NaN;
    }
  const roads: SegmentPath[] = [];
  const L = PLAN_EXTENT[rank] + 300;
  const arms: [number, RoadClass][] = [
    [0.15, ROAD_D],
    [1.75, ROAD_C],
    [0.15 + Math.PI, ROAD_D],
    [4.4, ROAD_T],
  ];
  arms.forEach(([a, cls], n) => {
    // A gently curving road out from the centre, sampled every 10 m, in edges of 150 m
    // sharing their end points exactly.
    const pts: [number, number][] = [];
    for (let s = 0; s <= L; s += 10) {
      const b = a + 0.0006 * s;
      pts.push([vx + s * Math.cos(b), vy + s * Math.sin(b)]);
    }
    for (let e = 0; e * 15 < pts.length - 1; e++) {
      const piece = pts.slice(e * 15, Math.min(pts.length, e * 15 + 16));
      roads.push({ key: `arm${n}_${e}`, cls, xy: Float32Array.from(piece.flat()) });
    }
  });
  return { site, roads, patch };
}

const polylines = (p: TownPlan, inp: PlanInput) => {
  const replaced = new Set(p.replaced);
  return {
    streets: p.streets.map((s) => s.xy),
    roads: [...inp.roads.filter((r) => !replaced.has(r.key)), ...p.roads].map((r) => r.xy),
  };
};

/** Distance from (x, y) to polyline xy. */
function distTo(xy: Float32Array, x: number, y: number): number {
  let best = Infinity;
  for (let i = 2; i < xy.length; i += 2) {
    const ax = xy[i - 2];
    const ay = xy[i - 1];
    const dx = xy[i] - ax;
    const dy = xy[i + 1] - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return best;
}

const cases = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `village ${i}`, inp: input(VILLAGE, i) })),
  ...[0, 1, 2].map((i) => ({ name: `town ${i}`, inp: input(TOWN, i) })),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `hamlet ${i}`, inp: input(HAMLET, i) })),
];
const plans = cases.map((c) => ({ ...c, plan: planTown(c.inp) }));

describe('street plans', () => {
  it('grow streets', () => {
    for (const { name, plan } of plans) {
      let km = 0;
      for (const s of plan.streets) for (let i = 2; i < s.xy.length; i += 2) km += Math.hypot(s.xy[i] - s.xy[i - 2], s.xy[i + 1] - s.xy[i - 1]) / 1000;
      console.log(`${name}: ${plan.streets.length} streets, ${km.toFixed(2)} km, road pieces ${plan.roads.map((r) => r.key).join(' ')}`);
      if (name.startsWith('hamlet')) expect(plan.streets.length).toBeLessThanOrEqual(2);
      else expect(plan.streets.length).toBeGreaterThan(name.startsWith('town') ? 20 : 3);
      expect(plan.frontage.length, name).toBeGreaterThan(0);
    }
  });

  it('are a function of their inputs, not of their order', () => {
    for (const { inp, plan } of plans) {
      const shuffled = [...inp.roads];
      const r = rng(7);
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(planTown({ ...inp, roads: shuffled })).toEqual(plan);
    }
  });

  it('stay within their extent and off water', () => {
    for (const { inp, plan } of plans) {
      const { patch: p, site } = inp;
      const all = [...plan.streets.map((s) => s.xy), ...plan.roads.map((r) => r.xy), ...plan.frontage.map((f) => f.xy)];
      for (const xy of all)
        for (let i = 0; i < xy.length; i += 2) expect(Math.hypot(xy[i] - site.x, xy[i + 1] - site.y)).toBeLessThanOrEqual(PLAN_EXTENT[site.rank]);
      for (const s of plan.streets)
        for (let i = 0; i < s.xy.length; i += 2) {
          const k = (Math.round(s.xy[i + 1] / NODE) - p.gy) * p.w + Math.round(s.xy[i] / NODE) - p.gx;
          expect(Number.isNaN(p.lake[k])).toBe(true);
        }
    }
  });

  it('meet the network only at junctions', () => {
    for (const { name, inp, plan } of plans) {
      const { streets, roads } = polylines(plan, inp);
      const lines = [...streets, ...roads];
      const ends = lines.flatMap((xy) => [
        [xy[0], xy[1]],
        [xy[xy.length - 2], xy[xy.length - 1]],
      ]);
      const nearEnd = (x: number, y: number) => ends.some(([ex, ey]) => Math.hypot(ex - x, ey - y) < 1);
      let bad = 0;
      for (let a = 0; a < streets.length; a++)
        for (let b = 0; b < lines.length; b++) {
          if (a === b) continue;
          const P = lines[a];
          const Q = lines[b];
          for (let i = 2; i < P.length; i += 2)
            for (let j = 2; j < Q.length; j += 2) {
              const [ax, ay, bx, by] = [P[i - 2], P[i - 1], P[i], P[i + 1]];
              const [cx, cy, dx, dy] = [Q[j - 2], Q[j - 1], Q[j], Q[j + 1]];
              const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
              if (Math.abs(den) < 1e-9) continue;
              const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
              const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
              if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
              if (!nearEnd(ax + t * (bx - ax), ay + t * (by - ay))) bad++;
            }
        }
      expect(bad, `${name}: crossings away from junctions`).toBe(0);
    }
  });

  it('connect every street to the roads', () => {
    for (const { name, inp, plan } of plans) {
      const { streets, roads } = polylines(plan, inp);
      // A street is reached if one of its ends lies on a reached line.
      const reached = new Set<number>();
      const lines = [...roads, ...streets];
      for (let i = 0; i < roads.length; i++) reached.add(i);
      for (let grew = true; grew; ) {
        grew = false;
        for (let s = roads.length; s < lines.length; s++) {
          if (reached.has(s)) continue;
          const xy = lines[s];
          const touches = (x: number, y: number) => [...reached].some((r) => distTo(lines[r], x, y) < 0.5);
          // …or another street ends on it (a street can carry its own branches).
          const carries = lines.some((o, k) => reached.has(k) && (distTo(xy, o[0], o[1]) < 0.5 || distTo(xy, o[o.length - 2], o[o.length - 1]) < 0.5));
          if (touches(xy[0], xy[1]) || touches(xy[xy.length - 2], xy[xy.length - 1]) || carries) {
            reached.add(s);
            grew = true;
          }
        }
      }
      expect(lines.length - reached.size, `${name}: unconnected streets`).toBe(0);
    }
  });

  it('redraw roads with their far ends in place', () => {
    for (const { inp, plan } of plans) {
      const byKey = new Map(inp.roads.map((r) => [r.key, r]));
      for (const key of plan.replaced) {
        const orig = byKey.get(key)!;
        const ends = [
          [orig.xy[0], orig.xy[1]],
          [orig.xy[orig.xy.length - 2], orig.xy[orig.xy.length - 1]],
        ];
        // Each original end away from the centre is still an end of one of its pieces.
        for (const [x, y] of ends) {
          if (Math.hypot(x - plan.x, y - plan.y) < 1) continue;
          const pieces = plan.roads.filter((r) => r.key === key);
          const streetEnd = plan.streets.some((s) => Math.hypot(s.xy[0] - x, s.xy[1] - y) < 0.01 || Math.hypot(s.xy[s.xy.length - 2] - x, s.xy[s.xy.length - 1] - y) < 0.01);
          const roadEnd = pieces.some((r) => Math.hypot(r.xy[0] - x, r.xy[1] - y) < 0.01 || Math.hypot(r.xy[r.xy.length - 2] - x, r.xy[r.xy.length - 1] - y) < 0.01);
          expect(roadEnd || streetEnd).toBe(true);
        }
      }
    }
  });

  it('make tracks through built-up land streets', () => {
    for (const { name, inp, plan } of plans) {
      if (name.startsWith('hamlet')) continue; // built up along their main road only
      // The track's first edge starts at the centre: built up, so redrawn.
      expect(plan.replaced, name).toContain('arm3_0');
      for (const r of plan.roads.filter((q) => q.cls === ROAD_T))
        for (let i = 0; i < r.xy.length; i += 2) expect(Math.hypot(r.xy[i] - plan.x, r.xy[i + 1] - plan.y)).toBeGreaterThan(40);
      expect(inp.roads.some((r) => r.key === 'arm3_0')).toBe(true);
    }
  });

  it('clear woods under their built-up land', () => {
    for (const { name, plan } of plans) {
      const cx = Math.floor(plan.x / CHUNK);
      const cy = Math.floor(plan.y / CHUNK);
      const N = DEM_W * DEM_W;
      const cover = new Int8Array(COVER_FIELDS * N).fill(COVER_SCALE);
      clearUnderBuiltUp(cover, [plan], cx, cy);
      const forestAt = (x: number, y: number) => {
        const i = Math.round((x - cx * CHUNK) / CELL) + APRON;
        const j = Math.round((y - cy * CHUNK) / CELL) + APRON;
        return i < 0 || j < 0 || i >= DEM_W || j >= DEM_W ? undefined : cover[COVER.forest * N + j * DEM_W + i];
      };
      // Along the middle of every built-up strip in the chunk: no forest. Rock is left alone.
      let on = 0;
      for (const s of plan.frontage)
        for (let i = 0; i < s.xy.length; i += 2) {
          const f = forestAt(s.xy[i], s.xy[i + 1]);
          if (f === undefined) continue;
          on++;
          expect(f, name).toBeLessThanOrEqual(0);
        }
      expect(on, name).toBeGreaterThan(0);
      expect(cover[COVER.rock * N]).toBe(COVER_SCALE);
      // Some of the chunk keeps its woods (away from the strips).
      expect(cover.subarray(COVER.forest * N, (COVER.forest + 1) * N).some((v) => v === COVER_SCALE), name).toBe(true);
    }
  });

  it('build hamlets up along their main road and streets only', () => {
    let lanes = 0;
    let bare = 0;
    for (const { name, inp, plan } of plans) {
      if (!name.startsWith('hamlet')) continue;
      if (plan.streets.length) lanes++;
      else bare++;
      for (const st of plan.streets) {
        let len = 0;
        for (let i = 2; i < st.xy.length; i += 2) len += Math.hypot(st.xy[i] - st.xy[i - 2], st.xy[i + 1] - st.xy[i - 1]);
        expect(len, name).toBeLessThan(140);
      }
      const main = inp.roads.filter((r) => r.cls <= ROAD_C).map((r) => r.xy);
      const own = plan.streets.map((st) => st.xy);
      for (const f of plan.frontage)
        for (let i = 0; i < f.xy.length; i += 2) {
          const d = Math.min(...[...main, ...own].map((xy) => distTo(xy, f.xy[i], f.xy[i + 1])));
          expect(d, name).toBeLessThan(1);
        }
    }
    // Both kinds occur.
    expect(lanes).toBeGreaterThan(0);
    expect(bare).toBeGreaterThan(0);
  });
});

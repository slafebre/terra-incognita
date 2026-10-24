import { describe, expect, it } from 'vitest';
import { segPointDist } from '../src/gen/buildings';
import { FIELD_PAD, FIELD_REACH, fieldStats, layFields, type Fields } from '../src/gen/fields';
import { NODE, NODES } from '../src/gen/hydro';
import { neighbours, vertexPos, verticesIn } from '../src/gen/lattice';
import type { PoiPatch } from '../src/gen/poi';
import { ROAD_C, ROAD_T, type SegmentPath } from '../src/gen/roads';
import { hash3 } from '../src/lib/hash';
import { CHUNK } from '../src/lib/constants';

/**
 * Field parcels on synthetic lowland (R = 0.15, gently tilted): a random network of
 * ways on the road lattice (a quarter of its edges, a few of them C roads, the rest
 * tracks), drawn as straight lines along their edges, and a wood. Each chunk gets its
 * own inputs, as the app's chunks do.
 */
const AREA = { x0: -3000, y0: -3000, x1: 4000, y1: 4000 };
const edges: number[][] = [];
const roads: SegmentPath[] = [];
{
  const seen = new Set<string>();
  for (const v of verticesIn(AREA))
    for (const w of neighbours(v)) {
      const key = v < w ? `${v}_${w}` : `${w}_${v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const h = hash3(0xed9e, Number(key.split('_')[0]) % 1e9, Number(key.split('_')[1]) % 1e9) / 4294967296;
      if (h > 0.25) continue;
      const [ax, ay] = vertexPos(v);
      const [bx, by] = vertexPos(w);
      edges.push([ax, ay, bx, by]);
      const xy: number[] = [];
      for (let t = 0; t <= 10; t++) xy.push(ax + ((bx - ax) * t) / 10, ay + ((by - ay) * t) / 10);
      roads.push({ key, cls: h < 0.04 ? ROAD_C : ROAD_T, xy: Float32Array.from(xy) });
    }
}
const WOOD = { x: 700, y: 300, r: 150 };
const patchFor = (cx: number, cy: number): PoiPatch => {
  const w = NODES + 2 * FIELD_PAD;
  const gx = cx * NODES - FIELD_PAD;
  const gy = cy * NODES - FIELD_PAD;
  const p: PoiPatch = { gx, gy, w, h: w, zE: new Float32Array(w * w), A: new Float32Array(w * w), lake: new Float32Array(w * w).fill(NaN), rec: new Int8Array(w * w), R: new Float32Array(w * w).fill(0.15) };
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) p.zE[j * w + i] = 100 + 0.01 * (gx + i) * NODE + 0.004 * (gy + j) * NODE;
  return p;
};
const lay = (cx: number, cy: number): Fields => {
  const r = { x0: cx * CHUNK - FIELD_REACH, y0: cy * CHUNK - FIELD_REACH, x1: (cx + 1) * CHUNK + FIELD_REACH, y1: (cy + 1) * CHUNK + FIELD_REACH };
  const inR = (x: number, y: number) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
  // The ways drawn in the 3 × 3 chunks round it (by their middles), the lattice edges within reach.
  const near = roads.filter((q) => {
    const m = 2 * Math.floor(q.xy.length / 4);
    return Math.abs(Math.floor(q.xy[m] / CHUNK) - cx) <= 1 && Math.abs(Math.floor(q.xy[m + 1] / CHUNK) - cy) <= 1;
  });
  return layFields({
    cx,
    cy,
    edges: edges.filter((e) => inR(e[0], e[1]) || inR(e[2], e[3])),
    patch: patchFor(cx, cy),
    roads: near,
    plans: [],
    open: (x, y) => Math.hypot(x - WOOD.x, y - WOOD.y) > WOOD.r,
    slope: () => 0.01,
  });
};
for (const k in fieldStats) delete fieldStats[k];
const chunks = [0, 1].flatMap((cy) => [0, 1].map((cx) => ({ cx, cy, f: lay(cx, cy) })));

/** Points every 2 m along the pieces [x0, y0, x1, y1]* that satisfy `keep`. */
function samples(segs: number[], keep: (x: number, y: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < segs.length; i += 4) {
    const l = Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]);
    for (let t = 0; t <= l; t += 2) {
      const x = segs[i] + ((segs[i + 2] - segs[i]) * t) / l;
      const y = segs[i + 1] + ((segs[i + 3] - segs[i + 1]) * t) / l;
      if (keep(x, y)) out.push([x, y]);
    }
  }
  return out;
}
const onAny = (segs: number[], x: number, y: number, tol: number) => {
  for (let i = 0; i < segs.length; i += 4) if (segPointDist(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], x, y) < tol) return true;
  return false;
};

describe('field parcels', () => {
  it('cut blocks and furlongs into fields, some hedged', () => {
    const km = (s: number[]) => {
      let l = 0;
      for (let i = 0; i < s.length; i += 4) l += Math.hypot(s[i + 2] - s[i], s[i + 3] - s[i + 1]);
      return l / 1000;
    };
    const e = chunks.reduce((a, c) => a + km(c.f.edges), 0);
    const h = chunks.reduce((a, c) => a + km(c.f.hedges), 0);
    console.log(`field edges ${e.toFixed(1)} km, hedges ${h.toFixed(1)} km over 1 km²; ${Object.entries(fieldStats).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    expect(e + h).toBeGreaterThan(2);
    expect(fieldStats.blocks ?? 0).toBeGreaterThan(0);
  });

  it('agree across chunk borders', () => {
    // Within 4 m of their common border (each draws 8 m beyond its edges, starting at its first sample there: within 3 m), they draw the same lines.
    for (const a of chunks)
      for (const b of chunks) {
        if (a === b) continue;
        const both = (x: number, y: number) =>
          [a, b].every((c) => x >= c.cx * CHUNK - 4 && x <= (c.cx + 1) * CHUNK + 4 && y >= c.cy * CHUNK - 4 && y <= (c.cy + 1) * CHUNK + 4);
        for (const kind of ['edges', 'hedges'] as const)
          for (const [x, y] of samples(a.f[kind], both))
            expect(onAny(b.f[kind], x, y, 0.05), `${kind} at ${x.toFixed(1)},${y.toFixed(1)}: chunk ${a.cx},${a.cy} draws it, ${b.cx},${b.cy} doesn't`).toBe(true);
      }
  });

  it('keep off the ways and out of the woods', () => {
    for (const { f } of chunks)
      for (const kind of ['edges', 'hedges'] as const) {
        for (const [x, y] of samples(f[kind], () => true)) {
          expect(Math.hypot(x - WOOD.x, y - WOOD.y)).toBeGreaterThan(WOOD.r - 4);
          for (const r of roads)
            for (let k = 2; k < r.xy.length; k += 2) {
              if (Math.abs(r.xy[k] - x) > 40 || Math.abs(r.xy[k + 1] - y) > 40) continue;
              // (Way-side hedges stand just beyond the clearance.)
              expect(segPointDist(r.xy[k - 2], r.xy[k - 1], r.xy[k], r.xy[k + 1], x, y), `${kind} at ${x.toFixed(1)},${y.toFixed(1)}`).toBeGreaterThan([6, 5, 4, 2.5, 1.5][r.cls] - 0.6);
            }
        }
      }
  });
});

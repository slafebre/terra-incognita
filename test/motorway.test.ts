import { describe, expect, it } from 'vitest';
import { CoarseField } from '../src/gen/hydro';
import { MW_CELL, MW_RMIN, MW_SPILL, Motorways, tightestRadius } from '../src/gen/motorway';
import { NET_REACH } from '../src/gen/roads';
import { expand, SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { setRegionOverride, Terrain } from '../src/gen/terrain';
import { classifyMotorways, MW_LEVEL, MW_TUNNEL, MW_VIADUCT, surfaceLines } from '../src/render/motorway';

/** Motorways over a rectangle, from seeds paid out for that rectangle only (as a worker would). */
function motorways(store: SeedStore, r: { x0: number; y0: number; x1: number; y1: number }): Motorways {
  const view = new SeedView(store.payloadFor(r, expand(r, NET_REACH)));
  const t = new Terrain(view);
  const field = new CoarseField(t, view);
  return new Motorways(field, t, new Settlements(field, t, view), view);
}

describe('motorways', () => {
  setRegionOverride(0.15);
  const store = new SeedStore(5);
  const area = { x0: 0, y0: 0, x1: 64000, y1: 64000 };
  const all = motorways(store, area).piecesIn(area.x0, area.y0, area.x1 - 1, area.y1 - 1);

  it('runs through lowland', () => {
    let km = 0;
    for (const p of all) for (let k = 2; k < p.xy.length; k += 2) km += Math.hypot(p.xy[k] - p.xy[k - 2], p.xy[k + 1] - p.xy[k - 1]) / 1000;
    console.log(`${all.length} pieces, ${km.toFixed(0)} km in ${((area.x1 - area.x0) / 1000) ** 2} km²`);
    expect(km).toBeGreaterThan(40);
  });

  it('is a pure function of the seeds: a cell agrees whatever area it was asked with', () => {
    // The cell of a piece in the middle of the area.
    const mid = all.reduce((a, p) => (Math.hypot(p.a.x - 32000, p.a.y - 32000) < Math.hypot(a.a.x - 32000, a.a.y - 32000) ? p : a));
    const m = 2 * Math.floor(mid.xy.length / 4);
    const ci = Math.floor(mid.xy[m] / MW_CELL);
    const cj = Math.floor(mid.xy[m + 1] / MW_CELL);
    const c = { x0: ci * MW_CELL, y0: cj * MW_CELL, x1: (ci + 1) * MW_CELL, y1: (cj + 1) * MW_CELL };
    const alone = motorways(store, c).piecesIn(c.x0, c.y0, c.x1 - 1, c.y1 - 1);
    const inAll = all.filter((p) => alone.some((q) => q.key === p.key));
    expect(alone.length).toBeGreaterThan(0);
    expect(inAll.length).toBe(alone.length);
    for (const p of alone) {
      const q = inAll.find((x) => x.key === p.key)!;
      expect(Array.from(q.xy)).toEqual(Array.from(p.xy));
      expect([q.endA, q.endB]).toEqual([p.endA, p.endB]);
    }
  });

  it('joins smoothly: each piece continues where it does not end, at the same point and heading', () => {
    // Pieces whose far anchor lies inside the area (the next cell's piece is in `all` too).
    const byA = new Map(all.map((p) => [p.a.id, p]));
    let joins = 0;
    for (const p of all) {
      const inside = p.b.x > area.x0 + MW_CELL && p.b.x < area.x1 - MW_CELL && p.b.y > area.y0 + MW_CELL && p.b.y < area.y1 - MW_CELL;
      if (!inside) continue;
      const q = byA.get(p.b.id);
      expect(!!q).toBe(!p.endB);
      if (!q) continue;
      joins++;
      const n = p.xy.length;
      expect(Math.hypot(p.xy[n - 2] - q.xy[0], p.xy[n - 1] - q.xy[1])).toBeLessThan(1e-6);
      // Headings of the last and first 25 m.
      const hp = Math.atan2(p.xy[n - 1] - p.xy[n - 3], p.xy[n - 2] - p.xy[n - 4]);
      const hq = Math.atan2(q.xy[3] - q.xy[1], q.xy[2] - q.xy[0]);
      expect(Math.abs(Math.atan2(Math.sin(hp - hq), Math.cos(hp - hq)))).toBeLessThan(0.05);
      // …and at the same height (the profile is pinned at the anchors).
      expect(Math.abs(p.z[p.z.length - 1] - q.z[0])).toBeLessThan(1e-3);
    }
    expect(joins).toBeGreaterThan(3);
  });

  it('stays within MW_SPILL of its own cell (chunks wait for the net cells that near)', () => {
    let worst = 0;
    for (const p of all) {
      // The raw line lies inside the cell: the midpoint of its ends does too.
      const b = p.base!;
      const ci = Math.floor((b[0] + b[b.length - 2]) / 2 / MW_CELL);
      const cj = Math.floor((b[1] + b[b.length - 1]) / 2 / MW_CELL);
      for (let k = 0; k < p.xy.length; k += 2) {
        const dx = Math.max(ci * MW_CELL - p.xy[k], 0, p.xy[k] - (ci + 1) * MW_CELL);
        const dy = Math.max(cj * MW_CELL - p.xy[k + 1], 0, p.xy[k + 1] - (cj + 1) * MW_CELL);
        worst = Math.max(worst, Math.max(dx, dy));
      }
    }
    console.log(`furthest outside its cell: ${worst.toFixed(0)} m`);
    expect(worst).toBeLessThan(MW_SPILL);
  });

  it('classes the drawing by the ground: viaducts, tunnels, the surface between', () => {
    // A straight line at height 100 over ground falling to 50 (a valley) and rising to 150 (a hill).
    const n = 40;
    const xy = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) xy[2 * i] = 16 * 10 + i * 25;
    const patch = { gx: 0, gy: -4, w: 80, h: 9, zE: new Float32Array(80 * 9), A: new Float32Array(80 * 9), lake: new Float32Array(80 * 9).fill(NaN) };
    for (let j = 0; j < 9; j++)
      for (let i = 0; i < 80; i++) {
        const x = i * 16;
        patch.zE[j * 80 + i] = x < 400 ? 50 : x < 600 ? 100 : x < 900 ? 150 : 100;
      }
    const [m] = classifyMotorways([xy], [new Float32Array(n).fill(100)], patch);
    const at = (x: number) => m.cls[Math.round((x - 160) / 25)];
    expect(at(260)).toBe(MW_VIADUCT);
    expect(at(500)).toBe(MW_LEVEL);
    expect(at(760)).toBe(MW_TUNNEL);
    expect(at(1080)).toBe(MW_LEVEL);
    expect(surfaceLines([m]).length).toBe(2);
  });

  it('keeps to wide curves', () => {
    // (The curve through the routed points may bend a little tighter than the routing aims.)
    for (const p of all) expect(tightestRadius(p.xy, 200)).toBeGreaterThan(0.6 * MW_RMIN);
  });
});

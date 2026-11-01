import { describe, expect, it } from 'vitest';
import { CoarseField } from '../src/gen/hydro';
import { classifyMotorways, MW_ANGLE, MW_BRIDGE_FREE, MW_CELL, MW_EDGE, MW_END_TAIL, MW_LEVEL, MW_RMIN, MW_SPILL, MW_TUNNEL, MW_VIADUCT, Motorways, MotorwayLookup, motorwayEnd, surfaceLines, tightestRadius, type MotorwayPiece } from '../src/gen/motorway';
import { NET_REACH } from '../src/gen/roads';
import { expand, SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { setRegionOverride, Terrain } from '../src/gen/terrain';

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
    // A straight line over level ground (100 m) crossing a narrow valley (70 m) and a narrow
    // hill (140 m), in two pieces meeting end to start: the road keeps near the average.
    const n = 60;
    const xy = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) xy[2 * i] = 160 + i * 25;
    const w = 110;
    const patch = { gx: 0, gy: -4, w, h: 9, zE: new Float32Array(w * 9), A: new Float32Array(w * 9), lake: new Float32Array(w * 9).fill(NaN) };
    for (let j = 0; j < 9; j++)
      for (let i = 0; i < w; i++) {
        const x = i * 16;
        patch.zE[j * w + i] = x > 560 && x < 700 ? 70 : x > 1000 && x < 1140 ? 140 : 100;
      }
    const a = xy.slice(0, 2 * 31);
    const b = xy.slice(2 * 30);
    const ms = classifyMotorways([b, a], patch);
    const cls = (x: number) => {
      const i = Math.round((x - 160) / 25);
      return i <= 30 ? ms[1].cls[i] : ms[0].cls[i - 30];
    };
    expect(cls(635)).toBe(MW_VIADUCT);
    expect(cls(360)).toBe(MW_LEVEL);
    expect(cls(1060)).toBe(MW_TUNNEL);
    expect(cls(1500)).toBe(MW_LEVEL);
    // The joint (shared by both pieces) is classed alike in each.
    expect(ms[1].cls[30]).toBe(ms[0].cls[0]);
    expect(surfaceLines(ms).length).toBeGreaterThan(1);
  });

  it('ends on land it can reach, not inside a hill', () => {
    // A motorway along +x ending at the origin, with two main roads starting ahead of it:
    // the nearer one (150, 0) under a 40 m hill, the farther one (250, 150) on the flat
    // and clear of it. Their other ends are out of reach, so they are the only candidates.
    const n = 41;
    const xy = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) xy[2 * i] = (i - n + 1) * 25;
    const piece = { key: 'test', xy, endA: false, endB: true } as unknown as MotorwayPiece;
    const roads = [
      { xy: [150, 0, 150, 400], cls: 0 },
      { xy: [250, 150, 250, 600], cls: 0 },
    ];
    const last = (r: { xy: Float64Array }) => [r.xy[r.xy.length - 2], r.xy[r.xy.length - 1]];
    // A hill only over the nearer terminus: the line to the farther one passes 77 m off it.
    const hill = (x: number, y: number) => (Math.hypot(x - 150, y) < 60 ? 40 : 0);

    // Blind to the ground, it runs on to the nearest road end ahead — into the hill.
    expect(last(motorwayEnd(piece, roads))).toEqual([150, 0]);
    // Given the ground, that terminus is 40 m under it (over MW_END_RISE), so the
    // farther one wins, though it is 141 m further on.
    expect(last(motorwayEnd(piece, roads, hill))).toEqual([250, 150]);
    // With nowhere it can reach, it stops where the piece does rather than tunnel to one.
    expect(last(motorwayEnd(piece, roads, (x) => (x > 60 ? 40 : 0)))).toEqual([0, 0]);
    // Ground raised as a whole is flat land, not a hill: the road lies on it and runs on.
    expect(last(motorwayEnd(piece, roads, () => 40))).toEqual([150, 0]);
    // Ground it cannot see leaves the end as it was.
    expect(last(motorwayEnd(piece, roads, () => NaN))).toEqual([150, 0]);
  });

  it('ends at a portal, not inside a tunnel', () => {
    // A straight line over level ground (100 m) running into a hill (160 m) for its last
    // 185 m: too narrow to lift the road's profile with it, so the end is in a tunnel.
    const n = 60;
    const xy = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) xy[2 * i] = 160 + i * 25;
    const w = 130;
    const patch = { gx: 0, gy: -4, w, h: 9, zE: new Float32Array(w * 9), A: new Float32Array(w * 9), lake: new Float32Array(w * 9).fill(NaN) };
    for (let j = 0; j < 9; j++) for (let i = 0; i < w; i++) patch.zE[j * w + i] = i * 16 > 1450 ? 160 : 100;

    // Left to itself the drawing ends underground.
    const [whole] = classifyMotorways([xy], patch);
    expect(whole.cls[n - 1]).toBe(MW_TUNNEL);
    expect(whole.xy.length).toBe(2 * n);

    // Told that this end is a motorway's, it stops where the road leaves the hill.
    const [cut] = classifyMotorways([xy], patch, [MW_END_TAIL]);
    const k = cut.xy.length / 2;
    expect(k).toBeLessThan(n);
    expect(cut.cls[k - 1]).not.toBe(MW_TUNNEL);
    expect(cut.cls.length).toBe(k);
    // What is left is the line's own start, unchanged: the classes come from the whole of
    // it, so cutting the end moves no structure along the rest.
    expect([...cut.xy.slice(0, 2 * k)]).toEqual([...xy.slice(0, 2 * k)]);
    expect([...cut.cls]).toEqual([...whole.cls.slice(0, k)]);
  });

  it('leaves the terminus to the geometry where the end itself is buried', () => {
    // The same motorway as above, ending at the origin, but the last 100 m of it and
    // everything ahead stand 60 m up: the end is inside the hill, so the approach says
    // nothing about what the carriageway can reach and the nearest terminus is taken.
    // (The renderer cuts the drawing back to the portal instead.)
    const n = 41;
    const xy = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) xy[2 * i] = (i - n + 1) * 25;
    const piece = { key: 'test', xy, endA: false, endB: true } as unknown as MotorwayPiece;
    const roads = [{ xy: [150, 0, 150, 400], cls: 0 }];
    const last = (r: { xy: Float64Array }) => [r.xy[r.xy.length - 2], r.xy[r.xy.length - 1]];
    const buried = (x: number) => (x > -100 ? 60 : 0);
    expect(last(motorwayEnd(piece, roads, buried))).toEqual([150, 0]);
    // With the end at grade, the same hill ahead does refuse that terminus.
    expect(last(motorwayEnd(piece, roads, (x) => (x > 60 ? 60 : 0)))).toEqual([0, 0]);
  });

  /**
   * What a crossing buys an edge (SPEC §3.5.1): its bridge, MW_BRIDGE_FREE either side of
   * where the chord crosses, and not its whole length. `crossing()` measures the distance
   * over what is left, and edgeCostRaw holds that to MW_EDGE.
   */
  describe('the bridge a crossing buys', () => {
    const lookup = new MotorwayLookup(motorways(store, area));
    /** A point on a chain and the way it runs there, `want` m further along. */
    const along = (p: MotorwayPiece, from: number, want: number) => {
      let s = 0;
      for (let k = from + 2; k < p.xy.length; k += 2) {
        s += Math.hypot(p.xy[k] - p.xy[k - 2], p.xy[k + 1] - p.xy[k - 1]);
        if (s >= want) {
          const [ax, ay, bx, by] = [p.xy[from], p.xy[from + 1], p.xy[k], p.xy[k + 1]];
          const L = Math.hypot(bx - ax, by - ay) || 1;
          return { ax, ay, bx, by, nx: -(by - ay) / L, ny: (bx - ax) / L };
        }
      }
      return undefined;
    };
    const run = all.reduce((a, p) => (p.xy.length > a.xy.length ? p : a));
    const far = along(run, 2 * Math.floor(run.xy.length / 8), 400);

    it('measures the distance beyond the bridge, not nothing at all', () => {
      expect(far).toBeDefined();
      // Crosses a sixth of the way along and runs 25 m out at the far end, ~330 m past the
      // crossing: inside MW_EDGE, and outside the bridge, so the rule still holds there.
      const m = lookup.crossing(far!.ax - 5 * far!.nx, far!.ay - 5 * far!.ny, far!.bx + 25 * far!.nx, far!.by + 25 * far!.ny);
      expect(m.n).toBeGreaterThan(0);
      expect(m.dist).toBeLessThan(MW_EDGE);
    });

    it('is the whole of an edge too short to reach past it', () => {
      const near = along(run, 2 * Math.floor(run.xy.length / 8), 60);
      expect(near).toBeDefined();
      const m = lookup.crossing(near!.ax - 5 * near!.nx, near!.ay - 5 * near!.ny, near!.bx + 25 * near!.nx, near!.by + 25 * near!.ny);
      expect(m.n).toBeGreaterThan(0);
      expect(m.dist).toBe(Infinity);
    });

    it('is why a straight crossing could never break the rule: 80 m × sin 35° is 46 m', () => {
      // MW_ANGLE and MW_BRIDGE_FREE already imply MW_EDGE along a straight crossing — a
      // chord's offset grows by sin(angle), so every point of it within MW_EDGE of a
      // straight centre line lies within MW_EDGE / sin(MW_ANGLE) of the crossing, which is
      // 52 m, well inside the bridge. The bound bites only where the motorway curves back
      // towards the chord or a second chain comes within reach. Lower MW_ANGLE and this
      // stops holding, which is the case the bound is there for.
      expect(MW_BRIDGE_FREE * Math.sin(MW_ANGLE)).toBeGreaterThan(MW_EDGE);
      expect(MW_EDGE / Math.sin(MW_ANGLE)).toBeLessThan(MW_BRIDGE_FREE);
    });
  });

  it('keeps to wide curves', () => {
    // (The curve through the routed points may bend a little tighter than the routing aims.)
    for (const p of all) expect(tightestRadius(p.xy, 200)).toBeGreaterThan(0.6 * MW_RMIN);
  });
});

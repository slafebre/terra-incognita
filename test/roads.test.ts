import { describe, expect, it } from 'vitest';
import { CoarseField, NODE } from '../src/gen/hydro';
import { LATTICE, latticeCell, MAX_EDGE, nearestVertex, neighbours, routeCurves, vertexPos, verticesIn } from '../src/gen/lattice';
import { NET_CELL, NET_REACH, ROAD_C, zOnNodes, zOnPatch } from '../src/gen/roads';
import { SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { Terrain } from '../src/gen/terrain';
import { testSeed } from './seed';

describe('lattice', () => {
  it('is a triangulation: neighbours agree, edges never cross, every vertex is surrounded', () => {
    const area = { x0: -3000, y0: 7000, x1: 3000, y1: 13000 };
    const vs = verticesIn(area);
    const edges: [number, number, number, number][] = [];
    let maxDeg = 0;
    for (const v of vs) {
      const [x, y] = vertexPos(v);
      const nb = neighbours(v);
      maxDeg = Math.max(maxDeg, nb.length);
      expect(nb.length).toBeGreaterThanOrEqual(3);
      // Around the vertex, no gap of half a turn or more between neighbours.
      const angles = nb.map((w) => Math.atan2(vertexPos(w)[1] - y, vertexPos(w)[0] - x)).sort((a, b) => a - b);
      for (let k = 0; k < angles.length; k++) {
        const gap = (k + 1 < angles.length ? angles[k + 1] : angles[0] + 2 * Math.PI) - angles[k];
        expect(gap).toBeLessThan(Math.PI);
      }
      for (const w of nb) {
        expect(neighbours(w)).toContain(v);
        const [wx, wy] = vertexPos(w);
        expect(Math.hypot(wx - x, wy - y)).toBeLessThanOrEqual(MAX_EDGE);
        if (v < w) edges.push([x, y, wx, wy]);
      }
    }
    // Crossings, through a grid of edge midpoints.
    const cross = (a: number[], b: number[]) => {
      const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
      return (
        o(a[0], a[1], a[2], a[3], b[0], b[1]) * o(a[0], a[1], a[2], a[3], b[2], b[3]) < 0 &&
        o(b[0], b[1], b[2], b[3], a[0], a[1]) * o(b[0], b[1], b[2], b[3], a[2], a[3]) < 0
      );
    };
    const grid = new Map<string, number[][]>();
    const key = (x: number, y: number) => `${Math.floor(x / MAX_EDGE)},${Math.floor(y / MAX_EDGE)}`;
    for (const e of edges) {
      const k = key((e[0] + e[2]) / 2, (e[1] + e[3]) / 2);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(e);
    }
    let crossings = 0;
    for (const e of edges) {
      const mx = Math.floor((e[0] + e[2]) / 2 / MAX_EDGE);
      const my = Math.floor((e[1] + e[3]) / 2 / MAX_EDGE);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) for (const f of grid.get(`${mx + dx},${my + dy}`) ?? []) if (cross(e, f)) crossings++;
    }
    expect(crossings).toBe(0);
    // A triangulation of n points has about 3n edges.
    console.log(`${vs.length} vertices, ${edges.length} edges, max degree ${maxDeg}, spacing ${LATTICE} m`);
    expect(edges.length / vs.length).toBeGreaterThan(2.8);
  });
});

describe('settlements and road network', () => {
  it('places sites and connects them', () => {
    const store = new SeedStore(testSeed('roads'));
    const c = { x0: -NET_REACH, y0: -NET_REACH, x1: 2 * NET_CELL + NET_REACH, y1: NET_CELL + NET_REACH };
    const view = new SeedView(store.payloadFor({ x0: 0, y0: 0, x1: 16, y1: 16 }, c));
    const t = new Terrain(view);
    const field = new CoarseField(t, view);
    const set = new Settlements(field, t, view);
    const t0 = performance.now();
    const cell = latticeCell(0, 0, field, set, t);
    const ms = performance.now() - t0;
    const byRank = [0, 0, 0, 0];
    for (const s of cell.sites) byRank[s.rank]++;
    const km = [0, 0, 0, 0, 0];
    for (const e of cell.edges) km[e.cls] += Math.hypot(e.route[2] - e.route[0], e.route[3] - e.route[1]) / 1000;
    console.log(
      `sites town/village/hamlet/farm ${byRank.join('/')}, km N/D/C/track/path ${km.map((k) => k.toFixed(1)).join('/')}, ${ms.toFixed(0)} ms`,
    );
    // A second cell reuses cached tiles and paths.
    const t1 = performance.now();
    latticeCell(1, 0, field, set, t);
    console.log(`neighbour cell ${(performance.now() - t1).toFixed(0)} ms`);

    // Every edge is a lattice edge, listed once.
    const keys = new Set<string>();
    for (const e of cell.edges) {
      expect(keys.has(e.id)).toBe(false);
      keys.add(e.id);
      expect(Math.hypot(e.route[2] - e.route[0], e.route[3] - e.route[1])).toBeLessThan(MAX_EDGE);
    }
    // Every site well inside the cell is on the network (its nearest vertex is used).
    const used = new Set<string>();
    for (const e of cell.edges) used.add(`${e.route[0]},${e.route[1]}`).add(`${e.route[2]},${e.route[3]}`);
    const inner = cell.sites.filter((s) => s.x > 400 && s.y > 400 && s.x < NET_CELL - 400 && s.y < NET_CELL - 400);
    const unreached = inner.filter((s) => !used.has(vertexPos(nearestVertex(s.x, s.y)).join(',')));
    expect(unreached.length).toBe(0);
    const hist = new Array(10).fill(0);
    let Rsum = 0;
    for (let j = 0; j < 40; j++)
      for (let i = 0; i < 40; i++) {
        const x = (i + 0.5) * (NET_CELL / 40);
        const y = (j + 0.5) * (NET_CELL / 40);
        const r = set.suitability(x, y, 1);
        hist[Math.min(9, Math.floor(r.suit * 10))]++;
        Rsum += r.R;
      }
    console.log(`village suitability deciles: ${hist.join(' ')}  meanR ${(Rsum / 1600).toFixed(2)}`);
    expect(cell.sites.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('vertex snapping', () => {
  // A patch 40 × 40 nodes from the origin. Flat south of a motorway along y = 300, rising
  // north of it, so the gentlest ground near a vertex lies on or beyond the carriageway.
  const W = 40;
  const patch = {
    gx: 0,
    gy: 0,
    w: W,
    h: W,
    zE: new Float32Array(W * W),
    A: new Float32Array(W * W),
    lake: new Float32Array(W * W).fill(NaN),
  };
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) patch.zE[j * W + i] = j > 20 ? 2 * (j - 20) : 0;
  const mw = Float64Array.from([-200, 300, 900, 300]);
  /** The ends of the drawn way, which are its snapped vertices. */
  const ends = (motorways: Float64Array[]) => {
    const [seg] = routeCurves(
      [{ key: 'e', cls: ROAD_C, ax: 192, ay: 352, bx: 400, by: 352, obstacles: [], wedges: [], rivals: [] }],
      patch,
      motorways,
    );
    const n = seg.xy.length;
    return [
      [seg.xy[0], seg.xy[1]],
      [seg.xy[n - 2], seg.xy[n - 1]],
    ];
  };

  it('does not snap a vertex onto a motorway', () => {
    // Blind to it, the snap takes the flat ground 20 m from the centre line.
    const blind = ends([]);
    expect(Math.min(...blind.map(([, y]) => Math.abs(y - 300)))).toBeLessThan(28);
    // Given the motorway, every end keeps clear of it: MW_VERTEX holds the unsnapped
    // position 50 m away, and the snap may no longer cross that.
    for (const [, y] of ends([mw])) expect(Math.abs(y - 300)).toBeGreaterThanOrEqual(28);
  });
});

describe('the fine surface', () => {
  // zOnNodes is what ground too far for a patch is read through (an interchange's ramps,
  // ChunkManager.rampGround): the same bilinear surface, from nodes fetched one at a time.
  it('reads the same height from nodes as from a patch', () => {
    const w = 7;
    const h = 5;
    const p = { gx: -3, gy: 2, w, h, zE: new Float32Array(w * h), A: new Float32Array(w * h), lake: new Float32Array(w * h).fill(NaN) };
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) p.zE[j * w + i] = 10 * i - 3 * j + (i * j) / 7;
    const at = (gx: number, gy: number) => {
      const i = gx - p.gx;
      const j = gy - p.gy;
      return i < 0 || j < 0 || i >= w || j >= h ? NaN : p.zE[j * w + i];
    };
    let checked = 0;
    for (let y = 2 * NODE; y < 5.9 * NODE; y += 3.7)
      for (let x = -3 * NODE; x < 2.9 * NODE; x += 2.3) {
        expect(zOnNodes(at, x, y)).toBeCloseTo(zOnPatch(p, x, y), 6);
        checked++;
      }
    expect(checked).toBeGreaterThan(100);
    // Beyond the nodes it is given: nothing, rather than the value at the edge.
    expect(zOnNodes(at, -10 * NODE, 3 * NODE)).toBeNaN();
    expect(zOnNodes(at, 0, 20 * NODE)).toBeNaN();
  });
});

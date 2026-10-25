import { describe, expect, it } from 'vitest';
import { CoarseField } from '../src/gen/hydro';
import { LATTICE, latticeCell, MAX_EDGE, nearestVertex, neighbours, vertexPos, verticesIn } from '../src/gen/lattice';
import { NET_CELL, NET_REACH } from '../src/gen/roads';
import { SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { Terrain } from '../src/gen/terrain';

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
    const store = new SeedStore();
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

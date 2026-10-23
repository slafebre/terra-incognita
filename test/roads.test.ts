import { describe, expect, it } from 'vitest';
import { CoarseField } from '../src/gen/hydro';
import { LATTICE, latticeCell, nearestVertex, vertexPos } from '../src/gen/lattice';
import { NET_CELL, NET_REACH } from '../src/gen/roads';
import { SeedStore, SeedView } from '../src/gen/seeds';
import { Settlements } from '../src/gen/settle';
import { Terrain } from '../src/gen/terrain';

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
      expect(Math.hypot(e.route[2] - e.route[0], e.route[3] - e.route[1])).toBeLessThan(1.7 * LATTICE);
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

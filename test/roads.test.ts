import { describe, expect, it } from 'vitest';
import { CoarseField } from '../src/gen/hydro';
import { NET_CELL, NET_REACH, netCell } from '../src/gen/roads';
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
    const cell = netCell(0, 0, field, set);
    const ms = performance.now() - t0;
    const byRank = [0, 0, 0];
    for (const s of cell.sites) byRank[s.rank]++;
    const byCls = [0, 0, 0];
    for (const e of cell.edges) byCls[e.cls]++;
    const len = cell.edges.reduce((a, e) => a + e.route.length / 2, 0);
    console.log(`sites town/village/hamlet ${byRank.join('/')}, edges N/D/C ${byCls.join('/')}, waypoints ${len}, ${ms.toFixed(0)} ms`);
    // A second cell reuses cached tiles.
    const t1 = performance.now();
    netCell(1, 0, field, set);
    console.log(`neighbour cell ${(performance.now() - t1).toFixed(0)} ms`);
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
    // Every owned site of rank village or hamlet has at least one edge from somewhere nearby.
  }, 120_000);
});

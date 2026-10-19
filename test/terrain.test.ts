import { describe, expect, it } from 'vitest';
import { APRON, CHUNK, CELLS, DEM_W } from '../src/lib/constants';
import { SeedStore, SeedView, type Rect } from '../src/gen/seeds';
import { terrainGrid, regionKind } from '../src/gen/terrain';

const chunkRect = (cx: number, cy: number, pad = 16): Rect => ({
  x0: cx * CHUNK - pad,
  y0: cy * CHUNK - pad,
  x1: (cx + 1) * CHUNK + pad,
  y1: (cy + 1) * CHUNK + pad,
});

const dem = (store: SeedStore, cx: number, cy: number) =>
  terrainGrid(cx, cy, new SeedView(store.payloadFor(chunkRect(cx, cy)))).dem;

describe('terrain', () => {
  it('neighbouring chunks agree exactly on their shared edge and apron', () => {
    const store = new SeedStore();
    const a = dem(store, 3, -2);
    const b = dem(store, 4, -2); // east neighbour
    const c = dem(store, 3, -1); // south neighbour
    for (let j = 0; j < DEM_W; j++)
      for (let k = -APRON; k <= APRON; k++)
        expect(a[j * DEM_W + APRON + CELLS + k]).toBe(b[j * DEM_W + APRON + k]);
    for (let i = 0; i < DEM_W; i++)
      for (let k = -APRON; k <= APRON; k++)
        expect(a[(APRON + CELLS + k) * DEM_W + i]).toBe(c[(APRON + k) * DEM_W + i]);
  });

  it('forgetting all seeds regenerates different land', () => {
    const s1 = new SeedStore();
    const s2 = new SeedStore();
    expect(dem(s1, 0, 0)[500]).not.toBe(dem(s2, 0, 0)[500]);
  });

  it('pruning keeps every seed a retained chunk depends on', () => {
    const store = new SeedStore();
    const before = dem(store, 0, 0);
    // A retention rectangle that barely touches chunk (0,0).
    store.prune({ x0: CHUNK - 1, y0: CHUNK - 1, x1: CHUNK + 4000, y1: CHUNK + 4000 });
    // payloadFor would create missing seeds silently; check nothing was lost.
    const n = store.chunk.size + store.coarse.size;
    const after = dem(store, 0, 0);
    expect(store.chunk.size + store.coarse.size).toBe(n);
    expect(after).toEqual(before);
  });

  it('is fast enough', () => {
    const store = new SeedStore();
    const t0 = performance.now();
    for (let i = 0; i < 8; i++) dem(store, i, 0);
    const ms = (performance.now() - t0) / 8;
    console.log(`terrain: ${ms.toFixed(1)} ms/chunk`);
    expect(ms).toBeLessThan(150);
  });

  it('produces a sensible region and elevation distribution', () => {
    const counts = { lowland: 0, hills: 0, lowmountain: 0, alpine: 0 };
    let lo = Infinity;
    let hi = -Infinity;
    for (let n = 0; n < 300; n++) {
      const store = new SeedStore();
      const cx = Math.floor(Math.random() * 64) - 32;
      const cy = Math.floor(Math.random() * 64) - 32;
      const r = terrainGrid(cx, cy, new SeedView(store.payloadFor(chunkRect(cx, cy))));
      counts[regionKind(r.region)]++;
      lo = Math.min(lo, r.min);
      hi = Math.max(hi, r.max);
    }
    console.log('regions', counts, 'elev', lo.toFixed(0), hi.toFixed(0));
    expect(counts.alpine).toBeGreaterThan(15);
    expect(counts.lowland).toBeGreaterThan(15);
  });
});

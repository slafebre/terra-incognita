import { describe, expect, it, vi } from 'vitest';

/**
 * Coarse tiles are made once and handed to every worker (`tile` tasks, the manager's
 * TILE_REACH). A worker that adopts them must build exactly what it would have built
 * making them itself.
 */
describe('shared coarse tiles', () => {
  /** Fresh modules: a worker of its own, with cold caches. */
  const load = async () => {
    vi.resetModules();
    const [hydro, { latticeCell }, { NET_CELL, NET_REACH }, { SeedStore, SeedView }, { Settlements }, { Terrain }] = await Promise.all([
      import('../src/gen/hydro'),
      import('../src/gen/lattice'),
      import('../src/gen/roads'),
      import('../src/gen/seeds'),
      import('../src/gen/settle'),
      import('../src/gen/terrain'),
    ]);
    const store = new SeedStore(5);
    const c = { x0: -NET_REACH, y0: -NET_REACH, x1: NET_CELL + NET_REACH, y1: NET_CELL + NET_REACH };
    const view = () => new SeedView(store.payloadFor({ x0: 0, y0: 0, x1: NET_CELL, y1: NET_CELL }, c));
    const S = hydro.TILE_STRIDE * hydro.COARSE;
    return {
      hydro,
      /** The tiles within 62 km of the cell (as the manager's tile tasks make them). */
      tiles: () => {
        const v = view();
        const out: { key: string; tile: unknown }[] = [];
        for (let ty = -8; ty <= 8; ty++)
          for (let tx = -8; tx <= 8; tx++)
            if (Math.hypot((tx + 1) * S - NET_CELL / 2, (ty + 1) * S - NET_CELL / 2) <= 62000) out.push(hydro.shareCoarseTile(v, tx, ty));
        return out;
      },
      /** The tile the worker's field uses at (tx, ty). */
      tileAt: (tx: number, ty: number) => {
        const v = view();
        return new hydro.CoarseField(new Terrain(v), v).tile(tx, ty);
      },
      cell: () => {
        const v = view();
        const t = new Terrain(v);
        const field = new hydro.CoarseField(t, v);
        return JSON.stringify(latticeCell(0, 0, field, new Settlements(field, t, v), t));
      },
    };
  };

  it('build the same net cell as tiles made in place', async () => {
    const cold = (await load()).cell();
    // One worker makes the tiles; another adopts copies (as postMessage delivers them).
    const tiles = structuredClone((await load()).tiles());
    expect(tiles.length).toBeGreaterThan(100);
    const other = await load();
    for (const { key, tile } of tiles) other.hydro.adoptCoarseTile(key, tile as Parameters<typeof other.hydro.adoptCoarseTile>[1]);
    // It uses the adopted tiles (not ones of its own)…
    const at00 = tiles.find(({ key }) => key.startsWith('0,0:'))!.tile;
    expect(other.tileAt(0, 0)).toBe(at00);
    // …and builds the same cell.
    expect(other.cell()).toBe(cold);
  }, 300_000);
});

import { describe, expect, it, vi } from 'vitest';

/**
 * Net caches are shared by every cell a worker builds (lattice.ts). Where land was
 * forgotten and made anew with other seeds, nothing cached from the old land may leak
 * into the new: a cell built after one on other seeds must equal it built cold.
 */
describe('shared net caches', () => {
  /** Fresh modules: cold caches. */
  const load = async () => {
    vi.resetModules();
    const [{ CoarseField }, { latticeCell }, { NET_CELL, NET_REACH }, { SeedStore, SeedView }, { Settlements }, { Terrain }] = await Promise.all([
      import('../src/gen/hydro'),
      import('../src/gen/lattice'),
      import('../src/gen/roads'),
      import('../src/gen/seeds'),
      import('../src/gen/settle'),
      import('../src/gen/terrain'),
    ]);
    return (seed: number) => {
      const store = new SeedStore(seed);
      const c = { x0: -NET_REACH, y0: -NET_REACH, x1: NET_CELL + NET_REACH, y1: NET_CELL + NET_REACH };
      const view = new SeedView(store.payloadFor({ x0: 0, y0: 0, x1: NET_CELL, y1: NET_CELL }, c));
      const t = new Terrain(view);
      const field = new CoarseField(t, view);
      return JSON.stringify(latticeCell(0, 0, field, new Settlements(field, t, view), t));
    };
  };

  it('follow new seeds', async () => {
    const cold = (await load())(8);
    const build = await load();
    const other = build(7);
    const after = build(8);
    expect(other).not.toBe(cold);
    expect(after).toBe(cold);
    // And back: the first seeds again, after the second.
    expect(build(7)).toBe(other);
  }, 300_000);
});

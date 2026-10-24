import { describe, expect, it } from 'vitest';
import { SeedStore } from '../src/gen/seeds';
import { parseSnapshot, takeSnapshot } from '../src/snapshot';

describe('snapshots', () => {
  it('round-trip every seed through JSON', () => {
    const a = new SeedStore();
    a.payloadFor({ x0: -3000, y0: 1000, x1: 2000, y1: 4000 }, { x0: -40000, y0: -30000, x1: 50000, y1: 20000 });
    a.payloadFor({ x0: 9000, y0: 9000, x1: 9500, y1: 9500 }); // a separate patch: holes in the grid
    a.chunk.set('3,3', 0); // a zero seed is still a seed
    const snap = parseSnapshot(JSON.parse(JSON.stringify(takeSnapshot(a, { x: 1.4, y: -2.6, zoom: 1 }, 0.5, null, 'abc'))));
    const b = new SeedStore();
    b.load(snap);
    expect(snap.at).toEqual([1, -3]);
    expect(new Map([...b.chunk].sort())).toEqual(new Map([...a.chunk].sort()));
    expect(new Map([...b.coarse].sort())).toEqual(new Map([...a.coarse].sort()));
  });

  it('loaded seeds win over hashed ones', () => {
    const a = new SeedStore();
    const s = a.chunkSeed(5, -7);
    const b = new SeedStore(42);
    b.load(a.dump());
    expect(b.chunkSeed(5, -7)).toBe(s);
  });
});

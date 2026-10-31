import { describe, expect, it } from 'vitest';
import { capture, PLACES } from '../dev/capture';

/**
 * The land itself, pinned: a digest of every task's output (pre, hydro, net, motorway,
 * roads, plan, dem) round the first golden place, world seed 7, against
 * test/golden/seed7-place0.json. Always seed 7, whatever SEED says: the file is that land.
 *
 * A change meant to leave the land as it is must leave every digest as it was. A change
 * meant to alter it rewrites the file (`npm run golden`) and says in its commit which
 * outputs changed and why; `dev/golden.ts` shows by how much, field by field. Render
 * output (bitmaps, field parcels, points of interest) is not covered: it needs a canvas.
 */
describe('golden land', () => {
  it('is the land the digests in test/golden/ hold', async () => {
    const digests: Record<string, string> = {};
    await capture(7, PLACES.slice(0, 1), (key, o) => (digests[key] = digest(o)));
    const sorted = Object.fromEntries(Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    console.log(`golden: ${Object.keys(sorted).length} outputs`);
    await expect(`${JSON.stringify(sorted, null, 1)}\n`).toMatchFileSnapshot('golden/seed7-place0.json');
  }, 300_000);

  it('digests tell apart what differs, and only that', () => {
    const a = { z: new Float32Array([1, 2, 3]), n: [1, 'x', { k: -0 }] };
    expect(digest(a)).toBe(digest({ n: [1, 'x', { k: -0 }], z: new Float32Array([1, 2, 3]) }));
    expect(digest(a)).not.toBe(digest({ z: new Float32Array([1, 2, 3.0000002]), n: [1, 'x', { k: -0 }] }));
    expect(digest(a)).not.toBe(digest({ z: new Float64Array([1, 2, 3]), n: [1, 'x', { k: -0 }] }));
    expect(digest(a)).not.toBe(digest({ z: new Float32Array([1, 2, 3]), n: [1, 'x', { k: 0 }] }));
    expect(digest([NaN])).toBe(digest([NaN]));
  });
});

/**
 * A 64-bit digest (two 32-bit lanes) of a value's exact content: numbers by their eight
 * bytes (so -0, NaN and the last bit count), typed arrays by their type and bytes, object
 * keys in sorted order (so the order fields were set in doesn't count).
 */
function digest(v: unknown): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x2545f491;
  const byte = (b: number) => {
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  };
  const f64 = new Float64Array(1);
  const f64b = new Uint8Array(f64.buffer);
  const num = (x: number) => {
    f64[0] = x;
    for (let i = 0; i < 8; i++) byte(f64b[i]);
  };
  const str = (s: string) => {
    num(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      byte(c & 0xff);
      byte(c >>> 8);
    }
  };
  const walk = (x: unknown): void => {
    if (x === null) return byte(1);
    switch (typeof x) {
      case 'undefined':
        return byte(2);
      case 'boolean':
        return byte(x ? 3 : 4);
      case 'number':
        byte(5);
        return num(x);
      case 'string':
        byte(6);
        return str(x);
      case 'object':
        break;
      default:
        throw new Error(`can't digest a ${typeof x}`);
    }
    if (ArrayBuffer.isView(x)) {
      byte(7);
      str(x.constructor.name);
      const b = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      num(b.length);
      for (let i = 0; i < b.length; i++) byte(b[i]);
    } else if (Array.isArray(x)) {
      byte(8);
      num(x.length);
      for (const y of x) walk(y);
    } else if (x instanceof Map) {
      byte(9);
      num(x.size);
      for (const [k, y] of x) {
        walk(k);
        walk(y);
      }
    } else if (x instanceof Set) {
      byte(10);
      num(x.size);
      for (const y of x) walk(y);
    } else {
      byte(11);
      const o = x as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      num(keys.length);
      for (const k of keys) {
        str(k);
        walk(o[k]);
      }
    }
  };
  walk(v);
  const hex = (h: number) => (h >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2);
}

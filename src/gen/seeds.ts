import { CHUNK } from '../lib/constants';
import { freshSeed, hash3 } from '../lib/hash';

/**
 * Emergent randomness.
 *
 * All terrain noise is lattice noise whose random values come from seeds that
 * are created lazily when land is first needed and dropped when it is forgotten.
 * Fine lattices (spacing <= CHUNK) take their randomness from one seed per chunk;
 * coarse lattices store one seed per lattice point.
 *
 * Invariant: a seed is retained for as long as any retained chunk could depend on
 * it, so retained land is always mutually consistent. Once everything that used
 * a seed is forgotten, the seed goes too, and the land regenerates differently.
 */

/** Lattice spacings (m) above CHUNK that store their own per-point seeds. */
export const COARSE_SPACINGS = [16384, 8192, 4096, 2048, 1024] as const;
/** Upper bound on domain-warp displacement applied to coarse lookups (m). */
export const MAX_WARP = 600;
/**
 * Coarse seeds are kept this far beyond the retention rectangle (m), because the
 * hydrology solve estimates base levels from coarse tiles reaching ~21 km away.
 */
export const COARSE_KEEP_EXTRA = 24000;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function expand(r: Rect, d: number): Rect {
  return { x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

export interface CoarseBlock {
  S: number;
  ix0: number;
  iy0: number;
  w: number;
  h: number;
  seeds: Uint32Array;
}

/** Seeds needed to evaluate terrain anywhere inside a world rectangle. */
export interface SeedPayload {
  cx0: number;
  cy0: number;
  cw: number;
  ch: number;
  chunks: Uint32Array;
  coarse: CoarseBlock[];
}

const fineRange = (a: number, b: number): [number, number] => [
  Math.floor((a - CHUNK) / CHUNK),
  Math.floor((b + CHUNK) / CHUNK),
];

/** Main-thread owner of all seeds. */
export class SeedStore {
  readonly chunk = new Map<string, number>();
  readonly coarse = new Map<string, number>();

  chunkSeed(cx: number, cy: number): number {
    const k = `${cx},${cy}`;
    let s = this.chunk.get(k);
    if (s === undefined) this.chunk.set(k, (s = freshSeed()));
    return s;
  }

  coarseSeed(S: number, ix: number, iy: number): number {
    const k = `${S}:${ix},${iy}`;
    let s = this.coarse.get(k);
    if (s === undefined) this.coarse.set(k, (s = freshSeed()));
    return s;
  }

  /** Seeds for fine terrain inside `r` and coarse terrain inside `coarse` (default: `r`). */
  payloadFor(r: Rect, coarseRect: Rect = r): SeedPayload {
    const [cx0, cx1] = fineRange(r.x0, r.x1);
    const [cy0, cy1] = fineRange(r.y0, r.y1);
    const cw = cx1 - cx0 + 1;
    const ch = cy1 - cy0 + 1;
    const chunks = new Uint32Array(cw * ch);
    for (let j = 0; j < ch; j++)
      for (let i = 0; i < cw; i++) chunks[j * cw + i] = this.chunkSeed(cx0 + i, cy0 + j);

    const cr = {
      x0: Math.min(r.x0, coarseRect.x0),
      y0: Math.min(r.y0, coarseRect.y0),
      x1: Math.max(r.x1, coarseRect.x1),
      y1: Math.max(r.y1, coarseRect.y1),
    };
    const coarse: CoarseBlock[] = COARSE_SPACINGS.map((S) => {
      const ix0 = Math.floor((cr.x0 - MAX_WARP) / S);
      const iy0 = Math.floor((cr.y0 - MAX_WARP) / S);
      const w = Math.floor((cr.x1 + MAX_WARP) / S) + 2 - ix0;
      const h = Math.floor((cr.y1 + MAX_WARP) / S) + 2 - iy0;
      const seeds = new Uint32Array(w * h);
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) seeds[j * w + i] = this.coarseSeed(S, ix0 + i, iy0 + j);
      return { S, ix0, iy0, w, h, seeds };
    });
    return { cx0, cy0, cw, ch, chunks, coarse };
  }

  /** Drop seeds no retained chunk can depend on. `keep` is the retention rectangle. */
  prune(keep: Rect): void {
    const kc = expand(keep, 2 * CHUNK + 64);
    for (const k of this.chunk.keys()) {
      const [cx, cy] = k.split(',').map(Number);
      const b = { x0: cx * CHUNK, y0: cy * CHUNK, x1: (cx + 1) * CHUNK, y1: (cy + 1) * CHUNK };
      if (!intersects(b, kc)) this.chunk.delete(k);
    }
    for (const k of this.coarse.keys()) {
      const [sPart, rest] = k.split(':');
      const S = Number(sPart);
      const [ix, iy] = rest.split(',').map(Number);
      const m = S + MAX_WARP + CHUNK * 1.5 + COARSE_KEEP_EXTRA;
      const x = ix * S;
      const y = iy * S;
      if (x < keep.x0 - m || x > keep.x1 + m || y < keep.y0 - m || y > keep.y1 + m) this.coarse.delete(k);
    }
  }
}

/** A lattice whose per-point random value is `seed(ix, iy)`. */
export interface Lattice {
  readonly S: number;
  seed(ix: number, iy: number): number;
  /** Scratch cache owned by `gnoise`: [ix, iy, salt, g00, g10, g01, g11] of the last cell. */
  readonly cell: number[];
}

const newCellCache = () => [NaN, NaN, 0, 0, 0, 0, 0];

class FineLattice implements Lattice {
  readonly cell = newCellCache();
  private readonly ratio: number;
  private readonly salt: number;
  constructor(
    readonly S: number,
    private readonly p: SeedPayload,
  ) {
    this.ratio = CHUNK / S;
    this.salt = Math.imul(S, 0x9e3779b1);
  }
  seed(ix: number, iy: number): number {
    const p = this.p;
    const ci = Math.floor(ix / this.ratio) - p.cx0;
    const cj = Math.floor(iy / this.ratio) - p.cy0;
    if (ci < 0 || cj < 0 || ci >= p.cw || cj >= p.ch) throw new Error(`fine seed out of payload (S=${this.S})`);
    return hash3(p.chunks[cj * p.cw + ci] ^ this.salt, ix, iy);
  }
}

class CoarseLattice implements Lattice {
  readonly cell = newCellCache();
  readonly S: number;
  constructor(private readonly b: CoarseBlock) {
    this.S = b.S;
  }
  seed(ix: number, iy: number): number {
    const b = this.b;
    const i = ix - b.ix0;
    const j = iy - b.iy0;
    if (i < 0 || j < 0 || i >= b.w || j >= b.h) throw new Error(`coarse seed out of payload (S=${this.S})`);
    return b.seeds[j * b.w + i];
  }
}

/** Worker-side read-only view on a payload. */
export class SeedView {
  private readonly lattices = new Map<number, Lattice>();
  constructor(p: SeedPayload) {
    for (const b of p.coarse) this.lattices.set(b.S, new CoarseLattice(b));
    for (let S = CHUNK; S >= 1; S /= 2) this.lattices.set(S, new FineLattice(S, p));
  }
  lattice(S: number): Lattice {
    const l = this.lattices.get(S);
    if (!l) throw new Error(`no lattice with spacing ${S}`);
    return l;
  }
}
